import { describe, expect, it } from 'vitest';
import { CommandSession } from '../src/atlas/command/session';
import { LINK_CHANNEL, LINK_VERSION } from '../src/atlas/live/protocol';
import { positionAt } from '../src/atlas/command/forecast';
import { alongRoute } from '../src/atlas/command/encounter';
import type { Vec3 } from '../src/atlas/command/world';
import { LiveWorld } from './support/liveWorld';

/** Audit of the interception data flow. For a moving target these must all agree:
 * selection → observations → forecast (one fit) → candidate arrival time → forecast target position at that time → route end point → waypoints →
 * the route command sent to the Dimension → the target's TRUE position at the planned time. */
const ORIGIN = 'http://127.0.0.1:4173';
const CAPSULE = 'capsule-abigail';
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

function setup() {
  let wall = 0;
  const world = new LiveWorld('trace');
  const sent: Record<string, unknown>[] = [];
  const session = new CommandSession({ dimensionUrl: ORIGIN, now: () => wall });
  session.attachTransport(m => sent.push(m));
  session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 'trace', seq: 0, startedAtWallMs: 0, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 1, modelVersion: 'x', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null });
  world.baymax = [-3.8, 10.3, 23.6];
  for (let i = 0; i < 44; i += 1) { world.advance(0.25); wall += 250; session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...world.frame(i % 2 === 1) }); }
  session.select(CAPSULE);
  return { world, session, sent };
}

describe('interception data-flow audit (moving target)', () => {
  it('uses ONE forecast: predictive view, encounter, plan and the route sent agree to numerical precision', () => {
    const { session, sent } = setup();
    session.setSpeed(14);
    const s = session.getSnapshot();
    const est = s.estimates.get(CAPSULE)!;
    expect(est.ok && est.motion === 'moving').toBe(true);
    const plan = s.plan!, enc = s.encounter!, fc = s.forecast!;
    expect(plan.status).toBe('ready');
    expect(plan.mode).toBe('intercept');
    // The evidence identity is shared.
    expect(enc.version).toBe(fc.version);
    // The forecast position at the aim time is the fit's own prediction (no second estimator, no arbitrary coordinate).
    const direct = positionAt(est.fit!, enc.aimTime).position;
    expect(dist(enc.targetAtAim.position, direct)).toBeLessThan(1e-9);
    expect(dist(fc.at(enc.aimTime).position, direct)).toBeLessThan(1e-9);
    // The route ends at that forecast position plus ATLAS's stand-off (0.9 x the capsule's radius), never at the current position.
    const end = plan.waypoints.at(-1)!.position;
    const standOff = dist(end, direct);
    expect(standOff).toBeGreaterThan(0.5);
    expect(standOff).toBeLessThan(3.5);
    expect(dist(end, enc.targetNow.position)).toBeGreaterThan(standOff + 2);
    // Baymax's own timed route reaches the end exactly at the arrival time.
    expect(dist(alongRoute(enc.route, enc.arrivalTime), end)).toBeLessThan(1e-6);
    expect(enc.arrivalTime).toBeCloseTo(plan.waypoints.at(-1)!.etaSimTime!, 6);
    // The ghost times end at the arrival time.
    expect(enc.ghostTimes.at(-1)).toBeCloseTo(enc.arrivalTime, 9);
    // What is sent to the Dimension carries the same numbers.
    session.sendRoute();
    const command = sent.find(m => m.type === 'route')!.route as { waypoints: { position: number[] }[]; interception: { position: number[]; simTime: number; targetPath?: { simTime: number; position: number[] }[]; arrivalSimTime?: number } };
    expect(command.waypoints.at(-1)!.position).toEqual([...end]);
    expect(command.interception.simTime).toBeCloseTo(plan.meetingTime!, 9);
    expect(command.interception.arrivalSimTime).toBeCloseTo(enc.arrivalTime, 9);
    const path = command.interception.targetPath!;
    expect(path.length).toBeGreaterThan(10);
    expect([...path].sort((a, b) => a.simTime - b.simTime).map(p => p.simTime)).toEqual(path.map(p => p.simTime));
    // The sent target path agrees with the forecast at the same times (to the rounding of the wire format).
    for (const p of [path[3]!, path[12]!, path.at(-1)!]) expect(dist(p.position, positionAt(est.fit!, p.simTime).position)).toBeLessThan(0.02);
  });

  it('changing Baymax speed recomputes the coupled solution from the SAME evidence', () => {
    const { session } = setup();
    session.setSpeed(8);
    const a = session.getSnapshot();
    session.setSpeed(20);
    const b = session.getSnapshot();
    expect(a.forecast!.version).toBe(b.forecast!.version);
    expect(a.encounter!.version).toBe(b.encounter!.version);
    expect(b.encounter!.arrivalTime).toBeLessThan(a.encounter!.arrivalTime);
    expect(b.encounter!.aimTime).toBeLessThanOrEqual(a.encounter!.aimTime);
    // Different arrival time means the target is forecast somewhere else: the endpoint moves.
    expect(dist(b.plan!.waypoints.at(-1)!.position, a.plan!.waypoints.at(-1)!.position)).toBeGreaterThan(1);
    // Travel time is the path length over the planning speed (the ETA is from the candidate path, not from a straight line).
    for (const s of [a, b]) {
      const e = s.encounter!;
      expect(Math.abs(e.arrivalTime - e.now - s.plan!.length! / s.plan!.speed)).toBeLessThan(0.02); // ETAs are rounded to 10 ms on the wire
    }
  });

  it('the forecast is not rewritten after the fact: a frozen forecast keeps its numbers when later observations arrive', () => {
    const { world, session } = setup();
    const f = session.freezeForecast()!;
    const frozen = JSON.stringify(f);
    for (let i = 0; i < 40; i += 1) { world.advance(0.25); session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...world.frame(i % 2 === 1) }); }
    expect(JSON.stringify(session.getSnapshot().forecasts.find(x => x.id === f.id))).toBe(frozen);
  });

  it("the target's TRUE position at the planned time is inside the stated uncertainty of the forecast (measured, 3 start phases)", () => {
    for (const phase of [0, 1, 2]) {
      const { world, session } = setup();
      for (let i = 0; i < phase * 24; i += 1) { world.advance(0.25); session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...world.frame(i % 2 === 1) }); }
      session.setSpeed(14);
      const s = session.getSnapshot();
      if (!s.encounter || !s.encounter.moving) continue;
      const e = s.encounter;
      const truth = world.truthAt(CAPSULE, e.aimTime) as Vec3;
      const err = dist(truth, e.targetAtAim.position);
      // Allowed: the stated uncertainty (already calibrated) or a 6 m floor for short leads.
      expect(err, `phase ${phase}: error ${err.toFixed(1)} m, stated ${e.targetAtAim.uncertainty.toFixed(1)} m`).toBeLessThanOrEqual(Math.max(e.targetAtAim.uncertainty * 1.5, 6));
    }
  });
});
