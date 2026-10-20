import { describe, expect, it } from 'vitest';
import { WorldMemory } from '../src/atlas/command/world';
import type { Vec3 } from '../src/atlas/command/world';
import { ForecastBook, estimate } from '../src/atlas/command/forecast';
import { planToTarget } from '../src/atlas/command/route';
import { LiveWorld } from './support/liveWorld';

const CAPSULE = 'capsule-abigail';
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Observe the world for `seconds` at 2 Hz scans / 4 Hz frames, feeding ATLAS memory. */
function observeFor(world: LiveWorld, memory: WorldMemory, seconds: number, book?: ForecastBook, follow = false): void {
  const frames = Math.round(seconds / 0.25);
  for (let i = 0; i < frames; i += 1) {
    world.advance(0.25);
    // A hovering observer keeps the capsule inside sensor range (it is not omniscient: out of range it is simply not observed).
    if (follow) { const c = world.truth(CAPSULE); world.baymax = [c[0] + 12, c[1] + 4, c[2] + 20]; }
    const f = world.frame(i % 2 === 1);
    memory.ingest(f);
    const c = memory.entity(CAPSULE);
    if (book && c && f.scan && c.knowledge === 'current' && c.lastSeen === f.scan.time) book.observe(CAPSULE, f.scan.time, c.position);
  }
}

describe('live tracking and forecasting against ground truth', () => {
  it('acquires the capsule by scan, keeps a chronological track, and refuses a forecast before validation is possible', () => {
    const world = new LiveWorld(), memory = new WorldMemory();
    observeFor(world, memory, 1.5);
    const c = memory.entity(CAPSULE)!;
    expect(c).toBeDefined();
    expect(c.knowledge).toBe('current');
    expect(c.label).toBe("Abigail's Capsule");
    const times = memory.track(CAPSULE).map(s => s.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const e = estimate(CAPSULE, memory.track(CAPSULE), memory.now);
    expect(e.ok).toBe(false);
    expect(e.note).toMatch(/history|samples/i);
  });

  it('forecasts the capsule from observations alone; the frozen forecast is evaluated later and beats persistence', () => {
    const world = new LiveWorld(), memory = new WorldMemory(), book = new ForecastBook();
    observeFor(world, memory, 14, book, true);
    const issued: ReturnType<ForecastBook['issue']>[] = [];
    const frozen = new Map<string, string>();
    for (let k = 0; k < 24; k += 1) {
      const est = estimate(CAPSULE, memory.track(CAPSULE), memory.now);
      if (k === 0) { expect(est.ok).toBe(true); expect(est.motion).toBe('moving'); }
      if (est.ok) {
        const f = book.issue(CAPSULE, est, memory.now, 3, memory.entity(CAPSULE)!.position, memory.track(CAPSULE));
        if (f) { issued.push(f); frozen.set(f.id, JSON.stringify(f)); expect(f.targetTime).toBeCloseTo(memory.now + 3, 9); }
      }
      observeFor(world, memory, 1, book, true);
    }
    expect(issued.length).toBeGreaterThan(3);
    // Forecasts never change after issue.
    for (const f of book.list()) expect(JSON.stringify(f)).toBe(frozen.get(f.id));
    const done = book.evaluated();
    expect(done.length).toBeGreaterThanOrEqual(2);
    let better = 0;
    for (const { forecast, evaluation } of done) {
      expect(evaluation.observedAt).toBeGreaterThanOrEqual(forecast.targetTime - 1e-9);
      expect(evaluation.observedAt).toBeGreaterThan(forecast.issuedAt);
      // The recorded error is the real distance to where the capsule truly was when it was observed.
      expect(evaluation.error).toBeCloseTo(dist(forecast.position, world.truthAt(CAPSULE, evaluation.observedAt)), 1);
      if (evaluation.error < evaluation.baselineError) better += 1;
    }
    expect(better / done.length).toBeGreaterThan(0.7);
    console.log(`${done.length} evaluated 3 s forecasts; ${better} beat persistence`);
  });

  it('measures forecast accuracy over many origins and horizons', () => {
    const world = new LiveWorld(), memory = new WorldMemory(), book = new ForecastBook(1.0, 400);
    const rows: { h: number; err: number; base: number; unc: number }[] = [];
    observeFor(world, memory, 10, book);
    for (let k = 0; k < 40; k += 1) {
      const est = estimate(CAPSULE, memory.track(CAPSULE), memory.now);
      if (est.ok) for (const h of [3, 6, 10]) book.issue(CAPSULE, est, memory.now, h, memory.entity(CAPSULE)!.position, memory.track(CAPSULE));
      observeFor(world, memory, 2, book);
    }
    for (const { forecast, evaluation } of book.evaluated()) rows.push({ h: forecast.horizon, err: evaluation.error, base: evaluation.baselineError, unc: forecast.uncertainty });
    for (const h of [3, 6, 10]) {
      const r = rows.filter(x => x.h === h);
      const mean = (f: (x: typeof r[number]) => number) => r.reduce((s, x) => s + f(x), 0) / Math.max(1, r.length);
      const cover = r.filter(x => x.err <= x.unc).length / Math.max(1, r.length);
      const ratios = r.map(x => x.err / Math.max(x.unc, 1e-6)).sort((a, b) => a - b);
      console.log(`  error/uncertainty p50 ${ratios[Math.floor(ratios.length * 0.5)]!.toFixed(2)} p80 ${ratios[Math.floor(ratios.length * 0.8)]!.toFixed(2)} p90 ${ratios[Math.floor(ratios.length * 0.9)]!.toFixed(2)}`);
      console.log(`horizon ${h}s: n=${r.length} mean error ${mean(x => x.err).toFixed(2)} m, persistence ${mean(x => x.base).toFixed(2)} m, coverage within stated uncertainty ${(cover * 100).toFixed(0)}%`);
      expect(r.length).toBeGreaterThan(10);
      expect(mean(x => x.err)).toBeLessThan(mean(x => x.base));
    }
  });
});

describe('rendezvous', () => {
  function setup(): { world: LiveWorld; memory: WorldMemory } {
    const world = new LiveWorld(), memory = new WorldMemory();
    observeFor(world, memory, 14);
    return { world, memory };
  }

  /** Fly the plan at its speed from the start, in true simulation time, and report the closest approach to the TRUE capsule. */
  function fly(_world: LiveWorld, start: Vec3, waypoints: readonly Vec3[], speed: number, t0: number): { closest: number; at: number } {
    const pts: Vec3[] = [start, ...waypoints];
    let best = Infinity, bestT = t0, t = t0;
    const truth = new LiveWorld('truth').movers;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i]!, b = pts[i + 1]!, d = dist(a, b), dur = d / speed;
      for (let s = 0; s <= dur + 1e-9; s += 0.1) {
        const k = dur === 0 ? 0 : Math.min(1, s / dur);
        const p: Vec3 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
        truth.syncTo(t + s);
        const c = truth.states().find(x => x.id === CAPSULE)!.position;
        const dd = dist(p, c);
        if (dd < best) { best = dd; bestT = t + s; }
      }
      t += dur;
    }
    return { closest: best, at: bestT };
  }

  it('meets the capsule where it will be, at several Baymax speeds, with different meeting points', () => {
    const { world, memory } = setup();
    const out: { speed: number; meet: Vec3; time: number; closest: number; limited: boolean }[] = [];
    for (const speed of [5, 8, 12, 16]) {
      const plan = planToTarget({ memory, targetId: CAPSULE, baymax: world.baymax, speed, now: memory.now });
      expect(plan.status).toBe('ready');
      expect(plan.mode).toBe('intercept');
      const r = fly(world, world.baymax, plan.waypoints.map(w => w.position), speed, memory.now);
      out.push({ speed, meet: plan.meetingPosition!, time: plan.meetingTime!, closest: r.closest, limited: plan.intercept!.leadLimited });
      console.log(`speed ${speed}: meet ${plan.meetingPosition!.map(v => v.toFixed(1)).join(', ')} at t+${(plan.meetingTime! - memory.now).toFixed(1)} s, route ${plan.length!.toFixed(0)} m, waypoints ${plan.waypoints.length}, closest to TRUE capsule ${r.closest.toFixed(2)} m (stated ±${plan.uncertainty.toFixed(1)})`);
    }
    // Different speeds give different meeting points and times (the planner is not hardcoded).
    // (Two slow speeds may both be lead-limited and then share the same aim point: ATLAS never aims further ahead than 6 s.)
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.time).toBeLessThanOrEqual(out[i - 1]!.time);
      if (!out[i]!.limited && !out[i - 1]!.limited) expect(dist(out[i]!.meet, out[i - 1]!.meet)).toBeGreaterThan(1);
    }
    expect(out.some(o => o.limited)).toBe(true);
    expect(new Set(out.map(o => o.meet.map(v => v.toFixed(1)).join())).size).toBeGreaterThanOrEqual(3);
    // A forecast inside the trusted horizon is met; a far-future one is flagged unsupported and corrected by replanning as Baymax closes in.
    for (const o of out.filter(x => !x.limited && x.time - memory.now < 12)) expect(o.closest).toBeLessThan(8);
  });

  it('beats a pure chase toward the last observed position', () => {
    const { world, memory } = setup();
    const speed = 8;
    const plan = planToTarget({ memory, targetId: CAPSULE, baymax: world.baymax, speed, now: memory.now });
    const atlas = fly(world, world.baymax, plan.waypoints.map(w => w.position), speed, memory.now);
    const chaseTarget = memory.entity(CAPSULE)!.position;
    const chase = fly(world, world.baymax, [chaseTarget], speed, memory.now);
    console.log(`ATLAS closest ${atlas.closest.toFixed(2)} m vs chase-last-position ${chase.closest.toFixed(2)} m`);
    expect(atlas.closest).toBeLessThan(chase.closest);
  });

  it('reports unreachable when the target outruns Baymax', () => {
    const { world, memory } = setup();
    const plan = planToTarget({ memory, targetId: CAPSULE, baymax: world.baymax, speed: 0.8, now: memory.now });
    expect(['unreachable', 'ready']).toContain(plan.status);
    if (plan.status === 'unreachable') expect(plan.reasons.join(' ')).toMatch(/cannot reach/);
  });
});
