import { describe, expect, it } from 'vitest';
import { parseRouteCommand, parseNavReport, MAX_WAYPOINTS } from '../src/shared/liveLink';
import { RouteManager } from './support/dimensionNav';
import { LinkCore } from '../src/atlas/live/linkCore';
import { LINK_CHANNEL, LINK_VERSION, parseDimensionMessage } from '../src/atlas/live/protocol';
import { LiveWorld } from './support/liveWorld';
import { MOVER_DEFS } from './support/dimensionMovers';

/** Specialist 5 QA: information boundary and adversarial route intake. Truth-side helpers come from tests/support (byte copies of Dimension code). */
const wp = (i: number) => ({ id: `w${i}`, position: [i, 0, 0], kind: 'path', arrivalRadius: 3, etaSimTime: null });
const good = (over: Record<string, unknown> = {}) => ({
  routeId: 'r1', revision: 1, atlasSession: 'a1', goal: { id: 'capsule-abigail', label: 'Capsule', category: 'landmark', motion: 'moving' },
  mode: 'intercept', issuedSimTime: 1, speed: 10, waypoints: [wp(1), wp(2)], interception: null, reason: 'x', assumptions: [], supersedes: null, ...over,
});

describe('information boundary (observation / scan)', () => {
  it('a non-beacon mover beyond sensor range is absent from the frame; the capsule only within its 100 m beacon; islands/connections within 60 m', () => {
    const w = new LiveWorld('qa-boundary');
    w.advance(5);
    const cap = w.truth('capsule-abigail');
    const beacon = MOVER_DEFS.find(m => m.id === 'capsule-abigail')!.beaconRange!;
    for (const standoff of [30, 59, 61, 99, 101, 150]) {
      w.baymax = [cap[0] + standoff, cap[1], cap[2]];
      const f = w.frame(true);
      const ids = (f.scan?.objects ?? []).map(o => o.id);
      expect(ids.includes('capsule-abigail'), `capsule at ${standoff} m`).toBe(standoff <= beacon);
      for (const o of f.scan!.objects) {
        const def = MOVER_DEFS.find(m => m.id === o.id);
        expect(o.range).toBeLessThanOrEqual(def?.beaconRange ?? 60);
      }
      for (const i of f.observation.islands) expect(i.range).toBeLessThanOrEqual(60);
      for (const c of f.observation.connections) expect(c.range).toBeLessThanOrEqual(60);
    }
    for (const mdef of MOVER_DEFS.filter(m => m.id !== 'capsule-abigail' && !m.beaconRange)) {
      const t = w.truth(mdef.id);
      w.baymax = [t[0] + 75, t[1], t[2]];
      expect(w.frame(true).scan!.objects.some(o => o.id === mdef.id), mdef.id).toBe(false);
    }
  });
  it('frames carry no velocity or future state for scanned objects', () => {
    const w = new LiveWorld('qa-boundary2'); w.advance(3);
    const f = w.frame(true);
    for (const o of f.scan!.objects) expect(Object.keys(o).sort()).toEqual(expect.not.arrayContaining(['velocity', 'path', 'futurePosition']));
    expect(JSON.stringify(f)).not.toMatch(/velocity.*capsule|referencePosition|hessian|fieldValue/i);
  });
});

describe('route intake: adversarial inputs', () => {
  it('rejects NaN / Infinity / out-of-range numerics', () => {
    expect(parseRouteCommand(good())).not.toBeNull();
    for (const bad of [NaN, Infinity, -Infinity, 1e9]) {
      expect(parseRouteCommand(good({ speed: bad })), `speed ${bad}`).toBeNull();
      if (bad !== 1e9) expect(parseRouteCommand(good({ issuedSimTime: bad })), `time ${bad}`).toBeNull();
      expect(parseRouteCommand(good({ waypoints: [{ ...wp(1), position: [bad, 0, 0] }] })), `wp ${bad}`).toBeNull();
    }
    expect(parseRouteCommand(good({ speed: 0 }))).toBeNull();
    expect(parseRouteCommand(good({ speed: -3 }))).toBeNull();
    expect(parseRouteCommand(good({ revision: -1 }))).toBeNull();
    expect(parseRouteCommand(good({ revision: 1.5 }))).toBeNull();
    expect(parseRouteCommand(good({ revision: NaN }))).toBeNull();
  });
  it('an absurd issuedSimTime (1e9) is refused (bounded to 1e7 s)', () => {
    expect(parseRouteCommand(good({ issuedSimTime: 1e9 }))).toBeNull();
    expect(parseRouteCommand(good({ issuedSimTime: 600 }))).not.toBeNull();
  });
  it('rejects oversized arrays and strings', () => {
    expect(parseRouteCommand(good({ waypoints: Array.from({ length: MAX_WAYPOINTS + 1 }, (_, i) => wp(i)) }))).toBeNull();
    expect(parseRouteCommand(good({ waypoints: Array.from({ length: MAX_WAYPOINTS }, (_, i) => wp(i)) }))).not.toBeNull();
    expect(parseRouteCommand(good({ waypoints: Array.from({ length: 1e6 }, (_, i) => wp(i)) }))).toBeNull();
    expect(parseRouteCommand(good({ routeId: 'x'.repeat(81) }))).toBeNull();
    expect(parseRouteCommand(good({ assumptions: Array.from({ length: 9 }, () => 'a') }))).toBeNull();
    expect(parseRouteCommand(good({ interception: { position: [0, 0, 0], simTime: 1, targetNow: [0, 0, 0], targetObservedAt: 0, uncertainty: 1, targetPath: Array.from({ length: 41 }, (_, i) => ({ simTime: i, position: [0, 0, 0] })) } }))).toBeNull();
    const huge = parseRouteCommand(good({ reason: 'r'.repeat(5_000_000) }));
    expect(huge?.reason.length).toBe(280);
  });
  it('rejects non-objects, arrays, prototype pollution shapes and wrong types', () => {
    for (const raw of [null, undefined, 1, 'x', [], [good()], () => 1]) expect(parseRouteCommand(raw)).toBeNull();
    expect(parseRouteCommand(JSON.parse('{"__proto__":{"x":1},"routeId":"r","revision":1}'))).toBeNull();
    expect(parseRouteCommand(good({ goal: { id: 'g', label: 'l', category: 'c', motion: 'teleport' } }))).toBeNull();
    expect(parseRouteCommand(good({ mode: 'warp' }))).toBeNull();
    const ok = parseRouteCommand(JSON.parse(JSON.stringify(good())));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(ok).not.toBeNull();
  });
  it('stale / replayed revisions are rejected per ATLAS session; a reload (new session) restarts', () => {
    const m = new RouteManager();
    expect(m.offer(good({ revision: 5 }), 0).accepted).toBe(true);
    for (const rev of [5, 4, 0]) { const o = m.offer(good({ revision: rev }), 1); expect(o.accepted).toBe(false); expect(o.ack.code).toBe('stale-revision'); }
    expect(m.current()!.route.revision).toBe(5);
    expect(m.offer(good({ revision: 6 }), 2).accepted).toBe(true);
    expect(m.offer(good({ revision: 1, atlasSession: 'a2' }), 3).accepted).toBe(true);
    const bad = m.offer(good({ speed: NaN }), 4);
    expect(bad.accepted).toBe(false); expect(bad.ack.code).toBe('invalid');
    expect(m.current()!.route.atlasSession).toBe('a2');
  });
  it('a huge revision cannot lock out an ATLAS session (revision is bounded to 1e6)', () => {
    const m = new RouteManager();
    const o = m.offer(good({ revision: Number.MAX_SAFE_INTEGER * 1e6 }), 0);
    const next = m.offer(good({ revision: 2 }), 1);
    expect({ first: o.accepted, later: next.accepted }).toEqual({ first: false, later: true });
  });
  it('FINDING: route-cancel or ack for an unknown id / older revision is refused', () => {
    const m = new RouteManager();
    m.offer(good({ revision: 3 }), 0);
    expect(m.cancel('nope', 3, 1).ack.code).toBe('unknown-route');
    expect(m.cancel('r1', 2, 1).ack.code).toBe('stale-revision');
    expect(m.current()!.phase).toBe('active');
  });
});

describe('link receive side (ATLAS): origin, session, replay, malformed', () => {
  const welcome = (over: Record<string, unknown> = {}) => ({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session: 's1', seq: 0, startedAtWallMs: 0, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: 'http://127.0.0.1:4183', seed: 1, modelVersion: 'm', clock: { time: 0, running: true, timeScale: 1, visible: true }, pose: null, ...over });
  it('wrong origin, spoofed welcome origin, remote origin, replayed seq, foreign session and malformed all refused', () => {
    const l = new LinkCore({ expectedOrigin: 'http://127.0.0.1:4183' }); l.beginConnecting(0);
    expect(l.handle('http://evil.example', welcome(), 1)).toMatchObject({ kind: 'ignored', reason: 'bad-origin' });
    expect(l.handle('http://127.0.0.1:9999', welcome(), 1)).toMatchObject({ kind: 'ignored', reason: 'bad-origin' });
    expect(l.handle('http://127.0.0.1:4183', welcome({ origin: 'http://127.0.0.1:1' }), 1)).toMatchObject({ reason: 'bad-origin' });
    expect(l.handle('http://127.0.0.1:4183', welcome(), 1).kind).toBe('welcome');
    const frame = (seq: number, session = 's1') => ({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'frame', session, seq, wallMs: 0, scanMode: 'continuous', observation: { contractVersion: 1, time: 1, observerWorldPosition: [0, 0, 0], sensorRange: 60, local: { gravity: [0, 0, 0], hazard: 0 }, islands: [], connections: [] }, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] }, clock: { time: 1, running: true, timeScale: 1, visible: true } });
    expect(l.handle('http://127.0.0.1:4183', frame(1), 2).kind).toBe('frame');
    expect(l.handle('http://127.0.0.1:4183', frame(1), 2)).toMatchObject({ reason: 'duplicate' });
    expect(l.handle('http://127.0.0.1:4183', frame(0), 2)).toMatchObject({ reason: 'duplicate' });
    expect(l.handle('http://127.0.0.1:4183', frame(5, 'other'), 2)).toMatchObject({ reason: 'foreign-session' });
    for (const bad of [null, 1, 'x', { type: 'frame' }, { ...frame(9), v: 99 }, { ...frame(9), clock: { time: NaN, running: true, timeScale: 1, visible: true } }, { ...frame(9), pose: { position: [1e9, 0, 0], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] } }]) expect(l.handle('http://127.0.0.1:4183', bad, 3)).toMatchObject({ reason: 'malformed' });
    expect(l.state().counters.malformed).toBe(7);
  });
  it('nav report with NaN / missing outcome fields is refused', () => {
    const nav = { routeId: 'r', revision: 1, status: 'active', activeIndex: 0, waypointCount: 2, distanceToWaypoint: 5, distanceToGoal: 9, arrivedAtSimTime: null };
    expect(parseNavReport(nav)).not.toBeNull();
    expect(parseNavReport({ ...nav, distanceToGoal: NaN })).toBeNull();
    expect(parseNavReport({ ...nav, status: 'won' })).toBeNull();
    expect(parseNavReport({ ...nav, outcome: { success: true } })).toBeNull();
    expect(parseDimensionMessage({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'route-ack', session: 's', seq: 1, routeId: 'r', revision: 1, status: 'accepted', code: 'ok', detail: 'd'.repeat(10000), simTime: 1 })).toMatchObject({ detail: 'd'.repeat(200) });
  });
});

describe('determinism / reset and outcome honesty (truth side)', () => {
  it('engine.reset then replay reproduces identical mover states (all 11) at several times', () => {
    const w = new LiveWorld('qa-reset');
    const snap = (t: number) => { w.movers.syncTo(t); return JSON.stringify(w.movers.states()); };
    const first = [5, 20, 61.25, 120].map(snap);
    w.movers.syncTo(300);
    w.engine.reset();
    expect([5, 20, 61.25, 120].map(snap)).toEqual(first);
    const other = new LiveWorld('qa-reset-2');
    other.movers.syncTo(61.25);
    expect(JSON.stringify(other.movers.states())).toBe(first[2]);
    expect(w.movers.states().length).toBe(11);
  });
  it('a route aimed at a deliberately biased meeting point (40 m off) is scored MISSED from true positions, never arrived', async () => {
    const { RouteManager } = await import('./support/dimensionNav');
    const w = new LiveWorld('qa-miss'); w.advance(20);
    const cap = () => w.truth('capsule-abigail'), R = MOVER_DEFS[0]!.radius + 4;
    const resolve = (id: string) => (id === 'capsule-abigail' ? { position: cap(), captureRadius: R } : null);
    const m = new RouteManager();
    const c0 = cap();
    const biased: [number, number, number] = [c0[0] + 40, c0[1], c0[2]];
    w.baymax = [c0[0] + 40, c0[1] + 30, c0[2]] as unknown as typeof w.baymax;
    const raw = good({ revision: 1, interception: { position: biased, simTime: w.time + 5, targetNow: c0, targetObservedAt: w.time, uncertainty: 1 }, waypoints: [{ id: 'i', position: biased, kind: 'intercept', arrivalRadius: 4, etaSimTime: w.time + 5 }] });
    expect(m.offer(raw, w.time).accepted).toBe(true);
    let result = m.current()!;
    for (let i = 0; i < 400 && result.phase === 'active'; i += 1) {
      w.advance(0.25);
      const d = Math.hypot(biased[0] - w.baymax[0], biased[1] - w.baymax[1], biased[2] - w.baymax[2]), k = Math.min(1, 2.5 / Math.max(d, 1e-6));
      w.baymax = [0, 1, 2].map(j => w.baymax[j]! + (biased[j]! - w.baymax[j]!) * k) as unknown as typeof w.baymax;
      m.update(w.baymax, w.time, resolve); result = m.current()!;
    }
    expect(result.phase).toBe('missed');
    expect(result.outcome!.success).toBe(false);
    expect(result.outcome!.closestApproach).toBeGreaterThan(R);
    expect(result.outcome!.plannedError).toBeGreaterThan(R);
  });
  it('arrival is reported only when the TRUE distance is within the capture radius (sweep of Baymax standoffs)', async () => {
    const { RouteManager } = await import('./support/dimensionNav');
    const R = MOVER_DEFS[0]!.radius + 4;
    for (const off of [0.5, R - 0.1, R + 0.1, R + 5, 30]) {
      const w = new LiveWorld('qa-sweep'); w.advance(10);
      const c = w.truth('capsule-abigail');
      const m = new RouteManager();
      m.offer(good({ goal: { id: 'capsule-abigail', label: 'C', category: 'landmark', motion: 'moving' }, interception: { position: c, simTime: w.time + 100, targetNow: c, targetObservedAt: w.time, uncertainty: 1 }, waypoints: [{ id: 'i', position: c, kind: 'intercept', arrivalRadius: 4, etaSimTime: null }] }), w.time);
      w.baymax = [c[0] + off, c[1], c[2]] as unknown as typeof w.baymax;
      m.update(w.baymax, w.time, id => (id === 'capsule-abigail' ? { position: w.truth('capsule-abigail'), captureRadius: R } : null));
      expect(m.current()!.phase === 'arrived', `offset ${off}`).toBe(off <= R);
    }
  });
});
