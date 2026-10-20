import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitVectorBy } from '../src/atlas/analysis/models';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { evaluateLeg } from '../src/atlas/challenge/clearance';
import type { Obstacle } from '../src/atlas/challenge/clearance';
import { DEFAULT_MOTION_POLICY, fitTrack, predictMotion, staticEstimate } from '../src/atlas/challenge/motionModel';
import type { MotionFit } from '../src/atlas/challenge/motionModel';
import { planRoute } from '../src/atlas/challenge/timePlanner';
import { CHALLENGE_PARAMS, staticClearance } from '../src/atlas/challenge/types';
import type { TrackSample, Vec3 } from '../src/atlas/challenge/types';
import { gaussian, interpolate } from '../src/atlas/challenge/world';
import { REAL_TRAJECTORIES } from '../src/atlas/challenge/fixtures';

const challengeDir = join(process.cwd(), 'src', 'atlas', 'challenge');
const WORLD_SIDE = new Set(['world.ts', 'fixtures.ts', 'evaluate.ts', 'placements.ts', 'showcase.ts', 'run.ts']);
/** Every .ts/.tsx file below `dir`, relative to the challenge directory. */
const walk = (dir: string, base = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'fixtures' || e.name === 'app' ? [] : walk(join(dir, e.name), `${base}${e.name}/`)) : /\.tsx?$/.test(e.name) ? [`${base}${e.name}`] : []));

const track = (n: number, f: (t: number) => Vec3, sigma = 0, seed = 1, dt = 0.25): TrackSample[] =>
  Array.from({ length: n }, (_, i) => { const t = i * dt, p = f(t); return { time: t, position: [0, 1, 2].map(a => p[a]! + sigma * gaussian(seed, 'x', i, a)) as unknown as Vec3 }; });
const linear = (t: number): Vec3 => [10 + 0.8 * t, -3 - 0.3 * t, 4 + 0.1 * t];
const must = (r: ReturnType<typeof fitTrack>): MotionFit => { if (!r.ok) throw new Error(r.reasons.join(' ')); return r.fit; };
/** An obstacle that is at `position` at the newest sample (t = 10 s) and moves at `velocity`. */
const obstacleAt = (position: Vec3, velocity: Vec3): Obstacle => {
  const samples = track(Math.round(10 / 0.25) + 1, t => [position[0] + velocity[0] * (t - 10), position[1] + velocity[1] * (t - 10), position[2] + velocity[2] * (t - 10)]);
  return { id: 'o', fit: must(fitTrack('o', samples, samples.at(-1)!.time)), bound: CHALLENGE_PARAMS.obstacleBound };
};

describe('challenge: information boundary', () => {
  it('keeps truth, fixtures and the simulation out of every ATLAS-side module', () => {
    const files = walk(challengeDir).filter(f => !WORLD_SIDE.has(f));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const src = readFileSync(join(challengeDir, f), 'utf8');
      // publicRun.ts is a types-only module that names the run type in order to remove the world from it.
      if (f !== 'publicRun.ts') expect(src, f).not.toMatch(/from\s+['"][^'"]*(?:simulation|atlasSensor|\/world|\/fixtures|\/evaluate|\/placements|\/showcase|\/run)['"]/);
      if (f !== 'publicRun.ts') expect(src, f).not.toMatch(/ChallengeRun|ChallengeWorld/);
      expect(src, f).not.toMatch(/\btruthAt\b|\brealTrajectory\b|\bREAL_TRAJECTORIES\b/);
    }
  });
  it('only the pinned-fixture script reads the simulation, offline', () => {
    for (const f of readdirSync(challengeDir)) if (f.endsWith('.ts')) expect(readFileSync(join(challengeDir, f), 'utf8'), f).not.toMatch(/from\s+['"][^'"]*simulation[^'"]*['"]/);
  });
});

describe('challenge: motion model', () => {
  it('recovers a constant velocity and predicts ahead (reuses the established regression)', () => {
    const samples = track(41, linear);
    const fit = must(fitTrack('a', samples, 10));
    const v = predictMotion(fit, 10).velocity;
    const reference = fitVectorBy(samples, 3, (s, axis) => s.position[axis]!);
    for (let a = 0; a < 3; a += 1) { expect(v[a]!).toBeCloseTo(reference[a]!.slope, 6); expect(v[a]!).toBeCloseTo([0.8, -0.3, 0.1][a]!, 6); }
    const p = predictMotion(fit, 14).position, truth = linear(14);
    expect(Math.hypot(p[0] - truth[0], p[1] - truth[1], p[2] - truth[2])).toBeLessThan(1e-6);
  });
  it('beats persistence on a noisy moving track and states an uncertainty that covers the later truth', () => {
    const samples = track(41, linear, 0.1, 3);
    const fit = must(fitTrack('a', samples, 10));
    const at = predictMotion(fit, 14);
    const truth = linear(14);
    const err = Math.hypot(at.position[0] - truth[0], at.position[1] - truth[1], at.position[2] - truth[2]);
    const persistence = Math.hypot(samples.at(-1)!.position[0] - truth[0], samples.at(-1)!.position[1] - truth[1], samples.at(-1)!.position[2] - truth[2]);
    expect(err).toBeLessThan(persistence / 3);
    expect(err).toBeLessThanOrEqual(at.uncertainty);
    expect(fit.validation!.selected).not.toBe('persistence');
  });
  it('selects a curvature-aware model when the motion accelerates', () => {
    const curved = (t: number): Vec3 => [10 + 0.5 * t + 0.12 * t * t, 0, 0];
    const fit = must(fitTrack('c', track(49, curved, 0.05, 2), 12));
    expect(fit.kind).toBe('quadratic');
    const p = predictMotion(fit, 16).position;
    expect(Math.abs(p[0] - curved(16)[0])).toBeLessThan(0.5);
  });
  it('withholds with reasons: too little history, stale data, gaps, future samples, non-finite values', () => {
    expect(fitTrack('a', track(6, linear), 1.25).ok).toBe(false);
    const stale = fitTrack('a', track(41, linear), 12);
    expect(stale.ok === false && stale.reasons.join(' ')).toMatch(/not currently observed/);
    const gappy = track(41, linear).filter((_, i) => i < 10 || i > 24); // 3.75 s hole ends the contiguous support
    const g = fitTrack('a', gappy, 10);
    expect(g.ok).toBe(false);
    const future = fitTrack('a', track(41, linear), 5);
    expect(future.ok === false && future.reasons.join(' ')).toMatch(/future/);
    const bad = track(41, linear); (bad[3] as { position: Vec3 }).position = [NaN, 0, 0];
    expect(fitTrack('a', bad, 10).ok).toBe(false);
  });
  it('drops duplicate and out-of-order timestamps instead of averaging them', () => {
    const base = track(41, linear);
    const messy = [...base.slice(0, 20), { ...base[19]!, position: [999, 999, 999] as Vec3 }, ...base.slice(20)];
    const a = must(fitTrack('a', base, 10)), b = must(fitTrack('a', messy, 10));
    expect(predictMotion(b, 12).position).toEqual(predictMotion(a, 12).position);
  });
  it('is bounded: only the newest window is used', () => {
    const long = track(400, linear, 0.05, 4);
    const fit = must(fitTrack('a', long, 99.75));
    expect(fit.support.count).toBeLessThanOrEqual(DEFAULT_MOTION_POLICY.windowSamples);
  });
  it('reports growing uncertainty and a finite trust horizon', () => {
    const fit = must(fitTrack('a', track(41, linear, 0.1, 5), 10));
    const u = [0, 2, 6, 12].map(l => predictMotion(fit, 10 + l).uncertainty);
    expect(u[1]!).toBeGreaterThanOrEqual(u[0]!); expect(u[2]!).toBeGreaterThan(u[1]!); expect(u[3]!).toBeGreaterThan(u[2]!);
    expect(fit.horizon).toBeGreaterThan(2); expect(fit.horizon).toBeLessThanOrEqual(DEFAULT_MOTION_POLICY.horizonSeconds);
  });
  it('real-law trajectories are learnable with a held-out advantage when they move', () => {
    const tr = REAL_TRAJECTORIES.islands.find(i => i.id === 'island-01')!;
    const pos = (t: number) => interpolate(tr.samples, (12 + t) / 0.25);
    const samples = track(41, pos, 0.1, 9);
    const fit = must(fitTrack('island-01', samples, 10));
    const p = predictMotion(fit, 14).position, truth = pos(14), last = samples.at(-1)!.position;
    const d = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(d(p, truth)).toBeLessThan(d(last, truth) / 2);
  });
});

describe('challenge: modelled clearance', () => {
  const params = CHALLENGE_PARAMS;
  it('matches dense brute force for a linearly moving obstacle', () => {
    const o = obstacleAt([0, 0, 20], [0.5, 0, -0.4]);
    const issued = o.fit.issuedAt;
    for (const [from, to] of [[[-30, 0, 0], [30, 0, 0]], [[0, 8, -10], [0, 8, 30]], [[-5, -3, 5], [15, 4, 35]]] as const) {
      const rep = evaluateLeg({ from, to, t0: issued, speed: params.speed }, [o], params, 0.25);
      let best = Infinity;
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      for (let t = 0; t <= len / params.speed; t += 0.005) {
        const f = (t * params.speed) / len;
        const b = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
        const p = predictMotion(o.fit, issued + t);
        const required = params.baymaxRadius + params.margin + o.bound + p.uncertainty;
        if (t + issued - o.fit.issuedAt < o.fit.horizon) best = Math.min(best, Math.hypot(b[0]! - p.position[0], b[1]! - p.position[1], b[2]! - p.position[2]) - required);
      }
      // Exact between samples; conservative only by the uncertainty growth inside a 0.25 s sub-interval.
      expect(rep.minMargin).toBeLessThanOrEqual(best + 1e-6);
      expect(best - rep.minMargin).toBeLessThan(0.35);
    }
  });
  it('does not miss a conflict that happens between waypoint times', () => {
    // An obstacle sitting exactly on the middle of a long leg: endpoint-only checks would pass.
    const o = obstacleAt([0, 0, 0], [0, 0, 0]);
    const rep = evaluateLeg({ from: [-40, 0, 0], to: [40, 0, 0], t0: o.fit.issuedAt, speed: params.speed }, [o], params);
    expect(rep.feasible).toBe(false);
    expect(rep.worst!.timeAtMin - o.fit.issuedAt).toBeGreaterThan(10);
  });
  it('is time-aware: the same leg is blocked when flown early and free when flown after the obstacle has passed', () => {
    const o = obstacleAt([0, 0, 0], [0, 0, 1]);
    const leg = (t0: number) => evaluateLeg({ from: [-30, 0, 15], to: [30, 0, 15], t0, speed: params.speed }, [o], params);
    expect(leg(o.fit.issuedAt + 3).feasible).toBe(false);
    expect(leg(o.fit.issuedAt + 3).worst!.timeAtMin).toBeGreaterThan(o.fit.issuedAt);
    const later = leg(o.fit.issuedAt + 40);
    expect(later.perObstacle[0]!.minMargin).toBeGreaterThan(leg(o.fit.issuedAt + 3).minMargin);
  });
});

describe('challenge: time-aware planner', () => {
  const params = CHALLENGE_PARAMS;
  const input = (obstacles: Obstacle[], goal: Vec3 = [0, 0, 50]) => ({ now: obstacles[0]?.fit.issuedAt ?? 0, start: [0, 0, 0] as Vec3, goal, obstacles, params });
  it('returns the direct route when nothing is in the way', () => {
    const o = obstacleAt([60, 0, 25], [0, 0, 0]);
    const plan = planRoute(input([o]));
    expect(plan.chosen!.waypoints).toHaveLength(2);
    expect(plan.chosen!.length).toBeCloseTo(50, 6);
  });
  it('rejects a direct route that predicted motion will block, and the replacement meets the constraint on every leg', () => {
    // A static plan sees the obstacle 12 units off the line; it is drifting onto it.
    const o = obstacleAt([14, 0, 28], [-0.7, 0, 0]);
    const staticView = planRoute(input([{ ...o, fit: staticEstimate('o', [{ time: o.fit.issuedAt, position: o.fit.coeffs.map(c => c[0]!) as unknown as Vec3 }])! }]));
    expect(staticView.direct.feasible).toBe(true);
    const plan = planRoute(input([o]));
    expect(plan.direct.feasible).toBe(false);
    expect(plan.chosen).not.toBeNull();
    expect(plan.chosen!.waypoints.length).toBeGreaterThan(2);
    for (const leg of plan.chosen!.legs) expect(leg.clearance.minMargin).toBeGreaterThanOrEqual(0);
    // Independent check of the chosen route by dense sampling against the same model.
    let t = plan.now; let worst = Infinity;
    for (const leg of plan.chosen!.legs) {
      const len = leg.length;
      for (let s = 0; s <= len / params.speed; s += 0.01) {
        const f = (s * params.speed) / len, a = leg.from.position, b = leg.to.position;
        const p = predictMotion(o.fit, t + s);
        if (t + s - o.fit.issuedAt < o.fit.horizon) worst = Math.min(worst, Math.hypot(a[0] + (b[0] - a[0]) * f - p.position[0], a[1] + (b[1] - a[1]) * f - p.position[1], a[2] + (b[2] - a[2]) * f - p.position[2]) - (params.baymaxRadius + params.margin + o.bound + p.uncertainty));
      }
      t += len / params.speed;
    }
    expect(worst).toBeGreaterThan(-0.05);
  });
  it('is deterministic', () => {
    const o = obstacleAt([14, 0, 28], [-0.7, 0, 0]);
    const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'computeMs' ? undefined : v));
    expect(strip(planRoute(input([o])))).toBe(strip(planRoute(input([o]))));
  });
  it('reports no route rather than inventing one when the constraint cannot be met', () => {
    // The destination itself lies inside an obstacle's required envelope while the obstacle is trusted.
    const o = obstacleAt([0, 0, 50], [0, 0, 0]);
    const plan = planRoute(input([o]));
    expect(plan.chosen).toBeNull();
  });
  it('uses straight legs between actual waypoints (no smoothing)', () => {
    const o = obstacleAt([14, 0, 28], [-0.7, 0, 0]);
    const plan = planRoute(input([o]));
    for (const leg of plan.chosen!.legs) expect(leg.length).toBeCloseTo(Math.hypot(...[0, 1, 2].map(a => leg.to.position[a]! - leg.from.position[a]!)), 9);
    expect(staticClearance(params)).toBeCloseTo(params.baymaxRadius + params.obstacleBound + params.margin, 9);
  });
});

describe('challenge: sessions', () => {
  it('a new runtime knows nothing of an earlier one; time moving backwards starts a new session', () => {
    const obs = (time: number) => ({ contractVersion: 1 as const, time, observerWorldPosition: [0, 0, 0] as Vec3, sensorRange: 60, local: { gravity: [0, 0, 0] as Vec3, hazard: 0.1 }, islands: [{ id: 'i', worldPosition: [5 + time, 0, 0] as Vec3, range: 5 + time }], connections: [] });
    const a = new AtlasRuntime();
    for (let k = 0; k <= 20; k += 1) a.receive(obs(k / 4), k * 250);
    expect(a.getView(5000).sampleCount).toBe(21);
    expect(new AtlasRuntime().getView(0).mapping.islands).toHaveLength(0);
    const v = a.receive(obs(0), 5250);
    expect(v.sampleCount).toBe(1);
    expect(v.session).toBeGreaterThan(a.getView(5000).session - 1);
  });
});
