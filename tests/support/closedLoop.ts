import { CommandSession } from '../../src/atlas/command/session';
import { LINK_CHANNEL, LINK_VERSION } from '../../src/atlas/live/protocol';
import type { Vec3 } from '../../src/atlas/command/world';
import { RouteManager } from './dimensionNav';
import { MOVER_DEFS } from './dimensionMovers';
import { LiveWorld } from './liveWorld';

/** Closed-loop mission simulator used by the strategy comparison (scripts/atlas-intercept-report.ts) and tests.
 * The real simulation and mover dynamics produce frames; the real ATLAS CommandSession consumes them; a Dimension-side route manager accepts
 * routes and decides arrival against TRUE positions; "Baymax" is flown by a fixed-speed controller. Two strategies are compared on identical
 * initial conditions: ATLAS (predicted rendezvous with replanning) and CHASE (always fly at where the target was last observed). */
const ORIGIN = 'http://127.0.0.1:4173';
const CAPSULE = 'capsule-abigail';
const CAPTURE = MOVER_DEFS[0]!.radius + 4;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export interface Outcome { readonly strategy: 'atlas' | 'chase'; readonly success: boolean; readonly seconds: number; readonly pathLength: number; readonly closest: number; readonly corrections: number }
export interface Scenario { readonly start: Vec3; readonly speed: number; readonly warmup: number; readonly variant?: 'cruise' | 'fast'; /** An authored world (e.g. a crossing target) instead of the Dimension's own movers. */ readonly makeWorld?: () => LiveWorld }

export function runStrategy(strategy: 'atlas' | 'chase', sc: Scenario, limit = 90): Outcome | null {
  let wall = 0;
  const world = sc.makeWorld ? sc.makeWorld() : new LiveWorld('closed-loop', sc.variant ?? 'cruise');
  const session = new CommandSession({ dimensionUrl: ORIGIN, now: () => wall });
  const dimension = new RouteManager();
  let seq = 0;
  const post = (type: string, body: Record<string, unknown>) => { seq += 1; session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type, session: 'closed-loop', seq, ...body }); };
  const resolver = (id: string) => (id === CAPSULE ? { position: world.truth(CAPSULE), captureRadius: CAPTURE } : null);
  let corrections = 0;
  session.attachTransport(message => {
    if (message.type === 'route') {
      corrections += 1;
      if (process.env.TRACE) { const r = message.route as { revision: number; waypoints: { position: number[]; kind: string }[]; reason: string; interception: { position: number[] } | null }; console.log(`  t=${world.time.toFixed(1)} route r${r.revision} wps=${r.waypoints.map(w => w.position.map(v => v.toFixed(0)).join(',')).join(' > ')} | baymax=${world.baymax.map(v => v.toFixed(0))} capsule=${world.truth(CAPSULE).map(v => v.toFixed(0))} | ${r.reason.slice(0, 90)}`); }
      const offer = dimension.offer(message.route, world.time);
      post('route-ack', offer.ack);
    }
  });
  // The loop owns the frame sequence numbers, so frames are re-stamped.
  session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 'closed-loop', seq: 0, startedAtWallMs: 0, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 1, modelVersion: 'fractured-2.0', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null });
  const frame = (scan: boolean) => { const f = world.frame(scan); seq += 1; const nav = strategy === 'atlas' ? dimension.report(world.baymax, world.time, resolver) : null; session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...f, seq, ...(nav ? { nav } : {}) }); };

  world.baymax = [...sc.start] as unknown as Vec3;
  // Warm-up: Baymax hovers and observes; the capsule is kept in range by choosing the hover point near its true position (a sensor, not a leak:
  // it only decides where the observer stands, exactly as a player who has seen the capsule would).
  for (let i = 0; i < sc.warmup / 0.25; i += 1) {
    world.advance(0.25); wall += 250;
    frame(i % 2 === 1);
  }
  const e = session.memory.entity(CAPSULE);
  if (!e || e.knowledge !== 'current') return null;
  session.setSpeed(sc.speed);
  if (strategy === 'atlas') { session.select(CAPSULE); if (!session.sendRoute()) return null; }
  let path = 0, closest = Infinity;
  const t0 = world.time;
  for (let i = 0; i < limit / 0.25; i += 1) {
    world.advance(0.25); wall += 250;
    let goal: Vec3 | null;
    if (strategy === 'atlas') {
      const route = dimension.current();
      goal = route && route.phase === 'active' ? route.route.waypoints[route.activeIndex]!.position as Vec3 : null;
    } else goal = (session.memory.entity(CAPSULE)?.position ?? null) as Vec3 | null;
    if (goal) {
      const d = dist(world.baymax, goal), k = Math.min(1, (sc.speed * 0.25) / Math.max(d, 1e-6));
      const next = [0, 1, 2].map(j => world.baymax[j]! + (goal![j]! - world.baymax[j]!) * k) as unknown as Vec3;
      path += dist(world.baymax, next); world.baymax = next;
    }
    if (strategy === 'atlas') dimension.update(world.baymax, world.time, resolver);
    closest = Math.min(closest, dist(world.baymax, world.truth(CAPSULE)));
    frame(i % 2 === 1);
    const arrived = strategy === 'atlas' ? dimension.current()?.phase === 'arrived' : dist(world.baymax, world.truth(CAPSULE)) <= CAPTURE;
    if (arrived) return { strategy, success: true, seconds: world.time - t0, pathLength: path, closest, corrections };
  }
  return { strategy, success: false, seconds: limit, pathLength: path, closest, corrections };
}
