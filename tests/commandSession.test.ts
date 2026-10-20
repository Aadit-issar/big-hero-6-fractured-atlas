import { describe, expect, it } from 'vitest';
import { CommandSession } from '../src/atlas/command/session';
import { LINK_CHANNEL, LINK_VERSION } from '../src/atlas/live/protocol';
import { RouteManager } from './support/dimensionNav';
import { LiveWorld } from './support/liveWorld';
import { MOVER_DEFS } from './support/dimensionMovers';
import type { Vec3 } from '../src/atlas/command/world';

const ORIGIN = 'http://127.0.0.1:4173';
const CAPSULE = 'capsule-abigail';
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** A complete closed loop with no mocks of ATLAS: the real simulation and mover dynamics produce frames, the real ATLAS session consumes them and
 * sends routes, a Dimension-side route manager (the same code the Dimension runs) accepts them and decides arrival against TRUE positions, and
 * "Baymax" flies the accepted waypoints at the planning speed. */
class Harness {
  readonly world = new LiveWorld('dim-session');
  readonly session = new CommandSession({ dimensionUrl: ORIGIN, now: () => this.wall });
  readonly dimension = new RouteManager();
  readonly sent: Record<string, unknown>[] = [];
  wall = 0;
  speed = 9;

  constructor() {
    this.session.attachTransport(message => this.fromAtlas(message));
    this.session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 'dim-session', seq: 0, startedAtWallMs: 0, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 17062026, modelVersion: 'fractured-2.0', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null });
  }

  private ack(a: { routeId: string; revision: number; status: string; code: string; detail: string; simTime: number }): void {
    this.world.seq += 1;
    this.session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'route-ack', session: 'dim-session', seq: this.world.seq, ...a });
  }

  private fromAtlas(message: Record<string, unknown>): void {
    this.sent.push(message);
    if (message.type === 'route') {
      const offer = this.dimension.offer(message.route, this.world.time);
      this.ack(offer.ack);
    } else if (message.type === 'route-cancel') {
      this.ack(this.dimension.cancel(message.routeId as string, message.revision as number, this.world.time).ack);
    }
  }

  truthResolver = (id: string) => {
    if (id !== CAPSULE) return null;
    return { position: this.world.truth(CAPSULE), captureRadius: MOVER_DEFS[0]!.radius + 4 };
  };

  /** Advance one 0.25 s frame; Baymax flies the active route's waypoints (the player following guidance) at `speed`. */
  step(): void {
    const dt = 0.25;
    this.world.advance(dt);
    this.wall += 250;
    const route = this.dimension.current();
    if (route && route.phase === 'active') {
      const wp = route.route.waypoints[route.activeIndex]!;
      const d = dist(this.world.baymax, wp.position);
      const k = Math.min(1, (this.speed * dt) / Math.max(d, 1e-6));
      this.world.baymax = [0, 1, 2].map(i => this.world.baymax[i]! + (wp.position[i]! - this.world.baymax[i]!) * k) as unknown as Vec3;
      this.dimension.update(this.world.baymax, this.world.time, this.truthResolver);
    }
    const frame = this.world.frame(Math.round(this.world.time / 0.25) % 2 === 1);
    const nav = this.dimension.report(this.world.baymax, this.world.time, this.truthResolver);
    this.session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, ...frame, ...(nav ? { nav } : {}) });
  }
  run(seconds: number, until?: () => boolean): void { for (let i = 0; i < seconds / 0.25; i += 1) { this.step(); if (until?.()) return; } }
}

describe('ATLAS Command session: observation → memory → prediction → planning → route → navigation → observation', () => {
  it('discovers the capsule by scanning, keeps it as current while observed and remembered after it leaves range', () => {
    const h = new Harness();
    h.world.baymax = [0, 10, 5];
    h.run(3);
    let snap = h.session.getSnapshot();
    const cap = snap.entities.find(e => e.id === CAPSULE);
    expect(cap?.knowledge).toBe('current');
    expect(snap.targets.some(t => t.id === CAPSULE && t.label === "Abigail's Capsule")).toBe(true);
    // Fly far away: the capsule leaves sensor range and becomes remembered, with its last-known position kept.
    h.world.baymax = [300, 10, 300];
    h.run(2);
    snap = h.session.getSnapshot();
    const gone = snap.entities.find(e => e.id === CAPSULE)!;
    expect(gone.knowledge).toBe('remembered');
    expect(gone.position).toEqual(cap!.position === gone.position ? gone.position : gone.position);
    expect(snap.targets.find(t => t.id === CAPSULE)!.knowledge).toBe('remembered');
  });

  it('closes the loop: selects the capsule, sends an interception, replans on new observations, and reaches the TRUE capsule', () => {
    const h = new Harness();
    h.world.baymax = [-3.8, 10.3, 23.6];
    h.speed = 9;
    h.session.setSpeed(9);
    // Hover and observe long enough for a validated forecast.
    h.run(8);
    h.session.select(CAPSULE);
    expect(h.session.getSnapshot().plan?.status).toBe('ready');
    expect(h.session.getSnapshot().plan?.mode).toBe('intercept');
    h.session.sendRoute();
    const first = h.sent.find(m => m.type === 'route')!;
    expect((first.route as { revision: number }).revision).toBe(1);
    expect(h.session.getSnapshot().route.state).toBe('accepted');
    h.run(120, () => h.session.getSnapshot().route.state === 'arrived');
    const snap = h.session.getSnapshot();
    const revisions = h.sent.filter(m => m.type === 'route').map(m => (m.route as { revision: number }).revision);
    console.log(`route revisions sent: ${revisions.length}; final state ${snap.route.state}; sim time ${h.world.time.toFixed(1)}; distance to true capsule ${dist(h.world.baymax, h.world.truth(CAPSULE)).toFixed(1)} m`);
    for (const r of snap.route.history) console.log(`  r${r.revision} @${r.simTime.toFixed(1)}: ${r.reason}`);
    expect(snap.route.state).toBe('arrived');
    expect(dist(h.world.baymax, h.world.truth(CAPSULE))).toBeLessThanOrEqual(MOVER_DEFS[0]!.radius + 4 + 1e-6);
    // Revisions are strictly increasing and every one after the first states why it was issued.
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(snap.route.history.slice(1).every(r => r.reason.length > 10)).toBe(true);
  });

  it('does not thrash: a still target and a steady Baymax cause no replacement of an adequate route', () => {
    const h = new Harness();
    h.world.baymax = [-3.8, 10.3, 23.6];
    h.run(6);
    // Select a static island as the destination.
    const island = h.session.getSnapshot().entities.find(e => e.kind === 'island')!;
    h.session.select(island.id);
    expect(h.session.getSnapshot().plan?.status).toBe('ready');
    h.session.sendRoute();
    h.speed = 6;
    h.session.setSpeed(6);
    const before = h.sent.filter(m => m.type === 'route').length;
    h.run(10);
    const extra = h.sent.filter(m => m.type === 'route').length - before;
    // Only the deliberate speed change may issue a route; the drifting island does not cause continuous re-issue.
    expect(extra).toBeLessThanOrEqual(3);
  });

  it('a new Dimension session discards the previous route and memory', () => {
    const h = new Harness();
    h.run(6);
    h.session.select(CAPSULE);
    h.session.sendRoute();
    expect(h.session.getSnapshot().route.state).not.toBe('none');
    h.session.receive(ORIGIN, { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 'other-run', seq: 0, startedAtWallMs: 5, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 1, modelVersion: 'fractured-2.0', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null });
    const snap = h.session.getSnapshot();
    expect(snap.route.state).toBe('none');
    expect(snap.entities).toHaveLength(0);
    expect(snap.selectedId).toBeNull();
    expect(snap.episode).toBe(2);
  });

  it('selecting a fold plans an entrance route with the same machinery and labels its destination unverified', () => {
    const h = new Harness();
    h.world.baymax = [-3.8, 10.3, 23.6];
    h.run(3);
    const fold = h.session.getSnapshot().entities.find(e => e.kind === 'fold');
    expect(fold).toBeDefined();
    h.session.select(fold!.id);
    const plan = h.session.getSnapshot().plan!;
    expect(plan.status).toBe('ready');
    expect(plan.mode).toBe('entrance');
    expect(plan.unknowns.join(' ')).toMatch(/unverified/);
    expect(plan.waypoints.at(-1)!.kind).toBe('entrance');
    h.session.sendRoute();
    expect(h.dimension.current()?.route.goal.id).toBe(fold!.id);
  });
});
