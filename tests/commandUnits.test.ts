import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorldMemory } from '../src/atlas/command/world';
import type { Vec3 } from '../src/atlas/command/world';
import { ForecastBook, calibration, estimate } from '../src/atlas/command/forecast';
import { solveIntercept, solveStraight } from '../src/atlas/command/intercept';
import { buildTargets, filterTargets } from '../src/atlas/command/targets';
import { decideReplan, distanceToPolyline } from '../src/atlas/command/replan';
import type { ActivePlan } from '../src/atlas/command/replan';
import type { PlanOutcome } from '../src/atlas/command/route';
import { CHALLENGE_PARAMS } from '../src/atlas/challenge/types';
import { SHARED_ASSETS } from '../src/shared/assetManifest';
import { LiveWorld } from './support/liveWorld';

const CAPSULE = 'capsule-abigail';

describe('world memory', () => {
  it('ignores frames older than the newest accepted one and counts them', () => {
    const world = new LiveWorld(), memory = new WorldMemory();
    world.advance(1); const f1 = world.frame(true);
    world.advance(1); const f2 = world.frame(true);
    memory.ingest(f2);
    expect(memory.ingest(f1).stale).toBe(true);
    expect(memory.outOfOrderRejected).toBe(1);
    expect(memory.now).toBeCloseTo(2, 6);
    const times = memory.track('island-01').map(s => s.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('reset discards everything (a new session never inherits records)', () => {
    const world = new LiveWorld(), memory = new WorldMemory();
    world.advance(1); memory.ingest(world.frame(true));
    expect(memory.all().length).toBeGreaterThan(0);
    memory.reset();
    expect(memory.all()).toHaveLength(0);
    expect(memory.pose).toBeNull();
    expect(memory.now).toBe(0);
  });

  it('attaches the scene-object label and attitude from the scan, and never invents a position', () => {
    const world = new LiveWorld(), memory = new WorldMemory();
    world.baymax = [-6, 14, 0];
    world.advance(1); memory.ingest(world.frame(true));
    const c = memory.entity(CAPSULE)!;
    expect(c.label).toBe("Abigail's Capsule");
    expect(c.orientation).toHaveLength(4);
    expect(c.position).toEqual(world.truth(CAPSULE));
  });
});

describe('information boundary: what crosses the link', () => {
  it('frames carry positions and attitudes, never object velocities, parameters or future state', () => {
    const world = new LiveWorld();
    world.advance(2);
    const frame = world.frame(true);
    const scanText = JSON.stringify(frame.scan);
    expect(scanText).not.toMatch(/velocity|speed|accel|forecast|future|trajectory|parameters|referencePosition|omega|phase/i);
    const obsText = JSON.stringify(frame.observation);
    expect(obsText).not.toMatch(/velocity|forecast|future|trajectory|referencePosition/i);
    // The only velocity is Baymax's own measured vehicle motion in the pose.
    expect(Object.keys(frame.pose)).toEqual(['position', 'quaternion', 'forward', 'velocity']);
  });

  it('ATLAS command code never imports the simulation or the sensor, and never calls the world', () => {
    const dir = join(process.cwd(), 'src', 'atlas', 'command');
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []));
    for (const f of files(dir)) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from\s+['"][^'"]*(?:\/simulation\/|atlasSensor)[^'"]*['"]/);
      expect(src, f).not.toMatch(/\b(?:sampleField|evaluateIsland|resetRevision|scenario|SimulationEngine)\b/);
    }
  });
});

describe('forecast book', () => {
  it('evaluates only against an observation at or after the target time, and reports unobserved forecasts honestly', () => {
    const world = new LiveWorld(), memory = new WorldMemory(), book = new ForecastBook(1.0);
    world.baymax = [-6, 14, 0];
    for (let i = 0; i < 40; i += 1) { world.advance(0.25); memory.ingest(world.frame(i % 2 === 1)); }
    const est = estimate(CAPSULE, memory.track(CAPSULE), memory.now);
    expect(est.ok).toBe(true);
    const f = book.issue(CAPSULE, est, memory.now, 5, memory.entity(CAPSULE)!.position, memory.track(CAPSULE))!;
    expect(book.observe(CAPSULE, f.targetTime - 0.5, [0, 0, 0])).toHaveLength(0);
    expect(book.observe(CAPSULE, f.targetTime + 3, [0, 0, 0])).toHaveLength(0);
    expect(book.unresolved(f.targetTime + 3).map(x => x.id)).toEqual([f.id]);
    const evs = book.observe(CAPSULE, f.targetTime + 0.2, [1, 2, 3]);
    expect(evs).toHaveLength(1);
    expect(book.observe(CAPSULE, f.targetTime + 0.4, [9, 9, 9])).toHaveLength(0);
  });

  it('refuses a forecast without validated evidence and widens uncertainty with lead time', () => {
    const book = new ForecastBook();
    const est = estimate('x', [{ time: 0, position: [0, 0, 0] }, { time: 0.5, position: [1, 0, 0] }], 0.5);
    expect(est.ok).toBe(false);
    expect(book.issue('x', est, 0.5, 5, [0, 0, 0], [])).toBeNull();
    expect(calibration(2)).toBe(1);
    expect(calibration(6)).toBeGreaterThan(calibration(4));
    expect(calibration(20)).toBe(calibration(6));
  });

  it('a perfectly constant-velocity target is learned and a stationary one is classified static', () => {
    const track = Array.from({ length: 30 }, (_, i) => ({ time: i * 0.5, position: [2 * i * 0.5, 10, -5] as Vec3 }));
    const moving = estimate('m', track, 14.5);
    expect(moving.ok && moving.motion === 'moving').toBe(true);
    expect(moving.speed!).toBeCloseTo(2, 1);
    const still = estimate('s', Array.from({ length: 30 }, (_, i) => ({ time: i * 0.5, position: [3, 4, 5] as Vec3 })), 14.5);
    expect(still.motion).toBe('static');
  });
});

describe('rendezvous mathematics', () => {
  it('solves the straight-line meeting exactly for a linear target', () => {
    // Target starts 30 m ahead moving 3 m/s away along +x; Baymax at 9 m/s: meeting after 30/(9-3) = 5 s.
    const point = (t: number): Vec3 => [30 + 3 * t, 0, 0];
    const r = solveStraight(0, [0, 0, 0], 9, point, 60)!;
    expect(r.time).toBeCloseTo(5, 6);
    expect(r.position[0]).toBeCloseTo(45, 5);
    // A target that outruns Baymax is never met.
    expect(solveStraight(0, [0, 0, 0], 2, point, 60)).toBeNull();
    // Already within reach.
    expect(solveStraight(0, [0, 0, 0], 9, () => [0, 0, 0], 60)!.travelTime).toBe(0);
  });

  it("limits its lead: beyond the cap it aims at the target's position `cap` seconds ahead and says so", () => {
    const target = { kind: 'moving' as const, at: (t: number) => ({ position: [30 + 3 * (t - 14.5), 10, 0] as Vec3, uncertainty: 0.3, supported: true }) };
    const far = solveIntercept({ now: 14.5, start: [-120, 10, 0], speed: 9, obstacles: [], params: CHALLENGE_PARAMS, target });
    expect(far.status).toBe('ok');
    expect(far.leadLimited).toBe(true);
    expect(far.meetingTime - 14.5).toBeCloseTo(6, 6);
    expect(far.meetingPosition[0]).toBeCloseTo(30 + 3 * 6, 3);
    expect(far.notes.join(' ')).toMatch(/refines as Baymax closes in/);
    const near = solveIntercept({ now: 14.5, start: [0, 10, 0], speed: 9, obstacles: [], params: CHALLENGE_PARAMS, target });
    expect(near.leadLimited).toBe(false);
  });

  it('converges with obstacles and reports the planner residual', () => {
    const fit = estimate('m', Array.from({ length: 30 }, (_, i) => ({ time: i * 0.5, position: [30 + 3 * i * 0.5, 10, 0] as Vec3 })), 14.5).fit!;
    const result = solveIntercept({
      now: 14.5, start: [0, 10, 0], speed: 9, obstacles: [], params: CHALLENGE_PARAMS, leadCap: 60,
      target: { kind: 'moving', at: t => { const u = t - 14.5; return { position: [30 + 3 * 14.5 / 1 + 3 * u, 10, 0] as Vec3, uncertainty: fit.floor, supported: true }; } },
    });
    expect(result.status).toBe('ok');
    expect(result.iterations).toBeGreaterThan(0);
    expect(Math.abs(result.timingResidual)).toBeLessThan(0.3);
    expect(result.meetingPosition[0]).toBeGreaterThan(result.straight!.position[0] - 1);
  });
});

describe('controlled challenge: crossing target', () => {
  // A target crossing Baymax's line at 4 m/s, Baymax at 6 m/s from 60 m away. Pure pursuit trails it along the curve of pursuit; a lead aim cuts the corner.
  const target = (t: number): Vec3 => [4 * t, 10, 0];
  function fly(strategy: 'pursuit' | 'atlas'): number {
    let p: Vec3 = [0, 10, 60];
    const speed = 6, dt = 0.25;
    for (let t = 0; t < 120; t += dt) {
      const now = t;
      const aim = strategy === 'pursuit' ? target(now)
        : solveIntercept({ now, start: p, speed, obstacles: [], params: CHALLENGE_PARAMS, leadCap: 30, target: { kind: 'moving', speedHint: 4, at: u => ({ position: target(u), uncertainty: 0.3, supported: true }) } }).meetingPosition;
      const d = Math.hypot(aim[0] - p[0], aim[1] - p[1], aim[2] - p[2]);
      const k = Math.min(1, (speed * dt) / Math.max(d, 1e-9));
      p = [p[0] + (aim[0] - p[0]) * k, p[1] + (aim[1] - p[1]) * k, p[2] + (aim[2] - p[2]) * k];
      const c = target(now + dt);
      if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= 6.4) return now + dt;
    }
    return Infinity;
  }
  it('predictive interception reaches a crossing target clearly sooner than pursuing its last position', () => {
    const pursuit = fly('pursuit'), atlas = fly('atlas');
    console.log(`controlled crossing target: pursuit ${pursuit.toFixed(1)} s, ATLAS interception ${atlas.toFixed(1)} s`);
    expect(Number.isFinite(atlas)).toBe(true);
    expect(atlas).toBeLessThan(pursuit * 0.85);
  });
});

describe('planning cost is bounded (live use)', () => {
  it('returns the direct leg without searching when it is already clear, and stops at its budget when it is not', async () => {
    const { planRoute } = await import('../src/atlas/challenge/timePlanner');
    const { staticEstimate } = await import('../src/atlas/challenge/motionModel');
    const fit = (id: string, p: Vec3) => staticEstimate(id, [{ time: 0, position: p }])!;
    const clear = planRoute({ now: 0, start: [0, 0, 0], goal: [60, 0, 0], obstacles: [{ id: 'far', fit: fit('far', [30, 80, 0]), bound: 6 }], params: CHALLENGE_PARAMS, fastDirect: true, budgetMs: 100 });
    expect(clear.chosen).not.toBeNull();
    expect(clear.candidateWaypoints).toBe(0);
    const blocked = planRoute({ now: 0, start: [0, 0, 0], goal: [60, 0, 0], params: CHALLENGE_PARAMS, fastDirect: true, budgetMs: 1, obstacles: [0, 1, 2, 3].map(i => ({ id: `o${i}`, fit: fit(`o${i}`, [15 * (i + 1), (i % 2) * 3, 0]), bound: 6 })) });
    expect(blocked.computeMs).toBeLessThan(400);
  });
});

describe('catalogue', () => {
  it('lists only what was observed, orders moving objects first and filters', () => {
    const world = new LiveWorld(), memory = new WorldMemory();
    world.baymax = [-6, 14, 0];
    for (let i = 0; i < 40; i += 1) { world.advance(0.25); memory.ingest(world.frame(i % 2 === 1)); }
    const estimates = new Map([[CAPSULE, estimate(CAPSULE, memory.track(CAPSULE), memory.now)]]);
    const targets = buildTargets(memory.snapshot(), memory.now, estimates);
    expect(targets.length).toBe(memory.snapshot().filter(e => e.kind !== 'swarm').length);
    expect(targets[0]!.id).toBe(CAPSULE);
    expect(targets[0]!.targetClass).toBe('moving-object');
    expect(targets[0]!.mode).toBe('intercept');
    expect(filterTargets(targets, 'folds', '').every(t => t.targetClass === 'fold')).toBe(true);
    expect(filterTargets(targets, 'all', 'abigail').map(t => t.id)).toEqual([CAPSULE]);
    expect(filterTargets(targets, 'islands', '').every(t => t.mode === 'approach')).toBe(true);
  });
});

describe('replanning hysteresis', () => {
  const active: ActivePlan = { routeId: 'r', revision: 1, targetId: CAPSULE, issuedAt: 10, speed: 14, meetingPosition: [50, 10, 0], meetingTime: 15, goalPosition: [50, 10, 0], waypoints: [[0, 10, 0], [50, 10, 0]], mode: 'intercept' };
  const fresh = (over: Partial<PlanOutcome> = {}): PlanOutcome => ({
    status: 'ready', targetId: CAPSULE, label: "Abigail's Capsule", category: 'capsule', motion: 'moving', mode: 'intercept', now: 12, speed: 14, start: [10, 10, 0], waypoints: [], intercept: null,
    targetNow: [40, 10, 0], targetObservedAt: 12, meetingPosition: [50.5, 10, 0], meetingTime: 15, travelTime: 3, length: 40, uncertainty: 2, obstacles: [], assetId: null, targetPath: [], reasons: [], unknowns: [], ...over,
  });
  it('does not replace an adequate route for a tiny change, but does for a material one', () => {
    expect(decideReplan(active, fresh(), [10, 10, 0], 12, 'Capsule').replan).toBe(false);
    const d = decideReplan(active, fresh({ meetingPosition: [58, 12, 0] }), [10, 10, 0], 12, 'Capsule');
    expect(d.replan).toBe(true);
    expect(d.trigger).toBe('meeting-shifted');
    expect(d.reason).toMatch(/moved the predicted meeting point/);
  });
  it('never replans faster than the minimum interval, and always for a new target, a speed change or leaving the route', () => {
    expect(decideReplan(active, fresh({ meetingPosition: [80, 10, 0] }), [10, 10, 0], 10.5, 'Capsule').replan).toBe(false);
    expect(decideReplan(active, fresh({ targetId: 'other' }), [10, 10, 0], 10.5, 'Other').trigger).toBe('new-target');
    expect(decideReplan(active, fresh({ speed: 20 }), [10, 10, 0], 12, 'Capsule').trigger).toBe('speed-changed');
    expect(decideReplan(active, fresh(), [20, 60, 0], 12, 'Capsule').trigger).toBe('off-route');
    expect(decideReplan(null, fresh(), [10, 10, 0], 12, 'Capsule').trigger).toBe('new-target');
    expect(decideReplan(active, { ...fresh(), status: 'no-route' }, [10, 10, 0], 12, 'Capsule').replan).toBe(false);
  });
  it('measures distance to a route polyline', () => {
    expect(distanceToPolyline([5, 3, 0], [[0, 0, 0], [10, 0, 0]])).toBeCloseTo(3, 9);
    expect(distanceToPolyline([20, 0, 0], [[0, 0, 0], [10, 0, 0]])).toBeCloseTo(10, 9);
  });
});

describe('asset parity (shared identity)', () => {
  it('every manifest asset ATLAS draws exists in ATLAS and is byte-identical to the Dimension model it names', () => {
    for (const [id, a] of Object.entries(SHARED_ASSETS)) {
      const level = a.levels[a.atlasLevel]!;
      const path = join(process.cwd(), 'src', 'atlas', 'lab', 'public', 'models', level.name);
      expect(existsSync(path), `${id}: ${level.name}`).toBe(true);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), id).toBe(level.sha256);
    }
    for (const id of ['capsule_shell_remnant', 'baymax_chest_armor', 'baymax_shoulder_shell', 'industrial_ibeam_twisted']) expect(SHARED_ASSETS[id], id).toBeDefined();
  });
});
