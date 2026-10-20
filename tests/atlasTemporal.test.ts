import { describe, expect, it } from 'vitest';
import type { AtlasObservation, WorldVec3 } from '../src/shared/atlasContract';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { contiguousSuffixFrom, fitLinear, fitVector, predictLinear } from '../src/atlas/analysis/models';
import { TemporalIntelligence } from '../src/atlas/analysis/temporalIntelligence';

function sample(time: number, changes: Partial<AtlasObservation> = {}): AtlasObservation {
  const entry: WorldVec3 = [10 + time * 0.2, 3 + time * 0.1, 8];
  const observation: AtlasObservation = { contractVersion: 1, time, observerWorldPosition: [0, 0, 0], sensorRange: 60,
    local: { gravity: [0, -1 - time * 0.01, 0], hazard: 0.2 + time * 0.002 },
    islands: [{ id: 'island-A', worldPosition: [12 + time * 0.1, 4, 6], range: 15 }],
    connections: [{ id: 'fold-A', state: 'open', entryWorldPosition: entry, exitWorldPosition: [80 + time * 0.3, 18, 20], range: 15 }], ...changes };
  const observer = observation.observerWorldPosition;
  return {
    ...observation,
    islands: observation.islands.map((island) => ({ ...island, range: Math.hypot(island.worldPosition[0] - observer[0], island.worldPosition[1] - observer[1], island.worldPosition[2] - observer[2]) })),
    connections: observation.connections.map((connection) => ({
      ...connection,
      range: Math.min(
        Math.hypot(connection.entryWorldPosition[0] - observer[0], connection.entryWorldPosition[1] - observer[1], connection.entryWorldPosition[2] - observer[2]),
        Math.hypot(connection.exitWorldPosition[0] - observer[0], connection.exitWorldPosition[1] - observer[1], connection.exitWorldPosition[2] - observer[2]),
      ),
    })),
  };
}
function run(count = 32, factory = sample, options: ConstructorParameters<typeof AtlasRuntime>[0] = {}) {
  const runtime = new AtlasRuntime(options);
  let view = runtime.getView(0);
  for (let i = 0; i < count; i += 1) view = runtime.receive(factory(i * 0.25), i * 250);
  return { runtime, view };
}

describe('temporal arithmetic', () => {
  it('fits irregular model timestamps and centers large timestamps', () => {
    const base = 1e9;
    const fit = fitLinear([0, 0.2, 0.9, 2].map((t) => ({ time: base + t, value: 2 + t * 3 })))!;
    expect(fit.slope).toBeCloseTo(3, 5);
    expect(predictLinear(fit, base + 3)).toBeCloseTo(11, 5);
  });
  it('fits small changes around a large measurement offset without losing the slope', () => {
    const base = 1e15;
    const fit = fitLinear([0, 1, 2, 3].map((time) => ({ time, value: base + time * 0.25 })));
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(0.25, 7);
    expect(fit!.atLastTime).toBeCloseTo(base + 0.75, 1);
  });
  it('rejects duplicate, out-of-order and nonfinite fitting inputs', () => {
    for (const times of [[1, 1], [2, 1], [1, NaN]]) expect(fitLinear(times.map((time) => ({ time, value: 1 })))).toBeNull();
    expect(fitLinear([{ time: 0, value: Infinity }, { time: 1, value: 0 }])).toBeNull();
  });
  it('fits vector components without changing per-axis least-squares results', () => {
    const samples = [0, 0.2, 0.9, 2].map((t) => ({ time: t, value: [2 + 3 * t, -1 + 0.5 * t, 9 - 2 * t] }));
    const vectorFits = fitVector(samples, 3);
    [3, 0.5, -2].forEach((expected, axis) => expect(vectorFits[axis]?.slope).toBeCloseTo(expected));
    [8, 0, 5].forEach((expected, axis) => expect(vectorFits[axis]?.atLastTime).toBeCloseTo(expected));
    expect(fitVector([{ time: 0, value: [1] }, { time: 1, value: [2, 3] }], 1)).toEqual([null]);
  });
  it('preserves motion rates under world translation and an orthonormal axis rotation', () => {
    const samples = [0, 0.3, 1.1, 2.4].map((time) => ({ time, value: [2 + 1.5 * time, -3 + 0.25 * time, 8 - 2 * time] }));
    const original = fitVector(samples, 3);
    const translated = fitVector(samples.map((sample) => ({ ...sample, value: sample.value.map((value, axis) => value + [1e6, -500, 42][axis]!) })), 3);
    const rotated = fitVector(samples.map((sample) => ({ ...sample, value: [-sample.value[2]!, sample.value[1]!, sample.value[0]!] })), 3);
    for (let axis = 0; axis < 3; axis += 1) expect(translated[axis]?.slope).toBeCloseTo(original[axis]!.slope, 8);
    expect(rotated.map((fit) => fit?.slope)).toEqual([-original[2]!.slope, original[1]!.slope, original[0]!.slope]);
    const originalResidualNorm = Math.hypot(...original.map((fit) => fit!.residualRms));
    const rotatedResidualNorm = Math.hypot(...rotated.map((fit) => fit!.residualRms));
    expect(rotatedResidualNorm).toBeCloseTo(originalResidualNorm, 10);
  });
  it('finds a bounded chronological suffix without bridging time gaps or session cutoffs', () => {
    const samples = [0, 0.25, 0.5, 2, 2.25, 2.5].map((time) => ({ time }));
    expect(contiguousSuffixFrom(samples, 0.5, 4, 0).map((s) => s.time)).toEqual([2, 2.25, 2.5]);
    expect(contiguousSuffixFrom(samples, 0.5, 4, 2.25).map((s) => s.time)).toEqual([2.25, 2.5]);
    expect(contiguousSuffixFrom(samples, 0.5, 4, 3)).toEqual([]);
  });
  it('validates all policy bounds', () => {
    for (const policy of [{ horizonSeconds: 3 }, { windowSamples: 2 }, { minSamples: 1 }, { stationaryRadius: NaN }, { maxModels: 1.5 }, { highHazard: 2 }]) expect(() => new TemporalIntelligence(policy)).toThrow(RangeError);
  });
});

describe('observation-derived forecasting', () => {
  it('starts empty and abstains with sparse evidence', () => {
    const { view } = run(3);
    expect(new AtlasRuntime().getView(0).temporal.hazard).toBeNull();
    expect(view.temporal.hazard?.forecast).toBeNull();
    expect(view.temporal.hazard?.quality).toBe('insufficient');
  });
  it('keeps a currently observed fold inside the temporal model budget behind older records', () => {
    const runtime = new AtlasRuntime();
    const historicalPopulation = Array.from({ length: 256 }, (_, index) => ({
      id: `fold-old-${index}`,
      state: 'open' as const,
      entryWorldPosition: [1, 0, 0] as WorldVec3,
      exitWorldPosition: [2, 0, 0] as WorldVec3,
      range: 1,
    }));
    runtime.receive(sample(0, { islands: [], connections: historicalPopulation }), 0);
    const current = { id: 'fold-current', state: 'forming' as const, entryWorldPosition: [3, 0, 0] as WorldVec3, exitWorldPosition: [4, 0, 0] as WorldVec3, range: 3 };
    const view = runtime.receive(sample(0.25, { islands: [], connections: [current] }), 250);
    expect(view.temporal.folds.find((fold) => fold.id === 'fold-current')?.currentlyObserved).toBe(true);
    expect(view.temporal.concerns.some((concern) => concern.id === 'analysis-limit')).toBe(true);
  });
  it('learns linear scalar and 3D endpoint motion from past samples only', () => {
    const { view } = run();
    const a = view.temporal;
    expect(a.hazard?.fits[0]?.slope).toBeCloseTo(0.002);
    expect(a.hazard?.forecast?.estimate[0]).toBeCloseTo(0.2 + (7.75 + 1) * 0.002);
    expect(a.folds[0]?.entry.forecast?.estimate).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(a.folds[0]?.entry.fits[1]?.slope).toBeCloseTo(0.1);
    expect(a.islands[0]?.motion.fits[0]?.slope).toBeCloseTo(0.1);
  });
  it('scores earlier issued forecasts against later finalized observations and persistence', () => {
    const { view } = run();
    expect(view.temporal.hazard!.score.evaluated).toBeGreaterThan(6);
    expect(view.temporal.hazard!.score.meanAbsoluteError).toBeLessThan(1e-10);
    expect(view.temporal.hazard!.score.persistenceMeanAbsoluteError).toBeCloseTo(0.002);
    expect(view.temporal.hazard!.score.publishedEvaluated).toBeGreaterThan(6);
    for (const score of view.temporal.evaluations) {
      expect(score.issuedAt).toBeLessThan(score.observedAt);
      expect(score.observedAt).toBeLessThan(score.evaluatedAt);
      expect(score.observedAt - score.targetTime).toBeLessThanOrEqual(0.15);
    }
  });
  it('reports per-signal walk-forward errors against persistence for the deterministic linear fixture', () => {
    const { view } = run(80);
    const analyses = [view.temporal.hazard!, view.temporal.gravity!, view.temporal.folds[0]!.entry, view.temporal.folds[0]!.exit,
      view.temporal.folds[0]!.endpointSeparation, view.temporal.islands[0]!.motion];
    for (const analysis of analyses) {
      expect(analysis.forecast?.model).toBe('local-linear');
      expect(analysis.forecast!.targetTime - analysis.forecast!.issuedAt).toBe(1);
      expect(analysis.score.evaluated).toBe(64);
      expect(analysis.score.publishedEvaluated).toBe(64);
      expect(analysis.score.meanAbsoluteError).toBeLessThan(analysis.score.persistenceMeanAbsoluteError! * 0.02);
    }
  });
  it('has identical time-t output when all later fixture outcomes are changed', () => {
    const throughT = (future: boolean) => {
      const runtime = new AtlasRuntime();
      let view = runtime.getView(0);
      for (let i = 0; i <= 8; i += 1) {
        const time = i * 0.25;
        const baseline = sample(time);
        const observation = future && time > 2
          ? sample(time, { local: { hazard: Math.min(0.99, 0.9 + (time - 2) * 0.01), gravity: [30, 0, 0] }, islands: [], connections: [] })
          : baseline;
        view = runtime.receive(observation, i * 250);
      }
      return { runtime, view };
    };
    const a = throughT(false);
    const b = throughT(true);
    expect(a.view.observation!.time).toBe(2);
    expect(JSON.stringify(a.view.temporal)).toBe(JSON.stringify(b.view.temporal));
    expect(a.view.temporal.hazard!.forecast!.issuedAt).toBeLessThan(a.view.temporal.hazard!.forecast!.targetTime);
    expect(a.view.temporal.evaluations.every((e) => e.observedAt < e.evaluatedAt)).toBe(true);
    const laterA = a.runtime.receive(sample(2.25), 2250);
    const laterB = b.runtime.receive(sample(2.25, { local: { hazard: 0.99, gravity: [30, 0, 0] } }), 2250);
    expect(JSON.stringify(laterA.temporal)).not.toBe(JSON.stringify(laterB.temporal));
  });
  it('same-time corrections finalize truth once and do not manufacture progression', () => {
    const { runtime, view } = run(12);
    const count = view.temporal.evaluations.length;
    for (let i = 0; i < 25; i += 1) runtime.receive(sample(2.75), 3000 + i);
    const paused = runtime.getView(3030).temporal;
    expect(paused.evaluations.length).toBe(count);
    expect(paused.hazard?.sampleCount).toBe(view.temporal.hazard?.sampleCount);
    expect(paused.pendingForecasts).toBe(view.temporal.pendingForecasts);
  });
  it('uses corrected target truth rather than the first same-time delivery', () => {
    const { runtime } = run(10);
    const target = runtime.getView(2250).temporal.hazard!.forecast!.targetTime;
    runtime.receive(sample(target), 3250);
    runtime.receive(sample(target, { local: { hazard: 0.8, gravity: [0, -1, 0] } }), 3260);
    const next = runtime.receive(sample(target + 0.25), 3500);
    const score = next.temporal.evaluations.find((e) => e.key === 'hazard' && e.targetTime === target)!;
    expect(score.error).toBeCloseTo(Math.abs(0.8 - (0.2 + target * 0.002)));
  });
  it('stores actual evaluation timestamp for jitter and skips targets outside tolerance', () => {
    const { runtime, view } = run(8);
    const target = view.temporal.hazard!.forecast!.targetTime;
    runtime.receive(sample(target + 0.08), 3000);
    const scored = runtime.receive(sample(target + 0.33), 3250).temporal;
    expect(scored.evaluations.find((e) => e.key === 'hazard' && e.targetTime === target)?.observedAt).toBeCloseTo(target + 0.08);
    expect(scored.hazard!.score.skipped).toBeGreaterThan(0);
  });
  it('does not turn moving observer measurements into a temporal environmental forecast', () => {
    const { view } = run(20, (t) => sample(t, { observerWorldPosition: [t * 4, 0, 0] }));
    expect(view.temporal.hazard!.forecast).toBeNull();
    expect(view.temporal.hazard!.reasons.join(' ')).toContain('locality');
    expect(view.temporal.folds[0]!.entry.forecast).not.toBeNull();
  });
  it('never clamps a linear hazard projection into the valid sensor domain', () => {
    const { view } = run(8, (t) => sample(t, { local: { hazard: 0.6 + t * 0.2, gravity: [0, -1, 0] } }));
    expect(view.temporal.hazard!.forecast).toBeNull();
    expect(view.temporal.hazard!.reasons.join(' ')).toContain('domain');
  });
  it('learns a wider descriptive error allowance for irregular values', () => {
    const { view } = run(8, (t) => sample(t, { local: { hazard: 0.4 + 0.03 * Math.sin(t * 11), gravity: [0, -1, 0] } }));
    expect(view.temporal.hazard!.forecast!.errorAllowance).toBeGreaterThan(0.01);
    expect(view.temporal.hazard!.quality).toBe('provisional');
  });
  it('accepts a separately configured shorter horizon and scores only its matching later timestamp', () => {
    const { view } = run(20, sample, { temporal: { horizonSeconds: 0.5 } });
    expect(view.temporal.hazard!.forecast!.targetTime - view.temporal.hazard!.forecast!.issuedAt).toBe(0.5);
    expect(view.temporal.hazard!.score.evaluated).toBeGreaterThan(0);
  });
  it('withholds a model when observed held-out error is worse than persistence', () => {
    const { view } = run(64, (t) => sample(t, { local: { hazard: 0.4 + 0.1 * Math.sin(t * 1.2), gravity: [0, -1, 0] } }));
    expect(view.temporal.hazard!.score.evaluated).toBeGreaterThanOrEqual(6);
    expect(view.temporal.hazard!.score.meanAbsoluteError!).toBeGreaterThan(view.temporal.hazard!.score.persistenceMeanAbsoluteError! * 1.25);
    expect(view.temporal.hazard!.forecast).toBeNull();
    expect(view.temporal.evaluations.some((e) => !e.published)).toBe(true);
  });
});

describe('uncertainty, sessions and fold evidence', () => {
  it('withholds on invalid, unavailable and stale delivery, then rebuilds support', () => {
    for (const degraded of ['invalid', 'unavailable', 'stale']) {
      const { runtime } = run();
      const held = degraded === 'invalid' ? runtime.receive({ time: 8 }, 8000) : degraded === 'unavailable' ? runtime.markUnavailable('disconnected', 8000) : runtime.getView(12000);
      expect(held.temporal.available).toBe(false);
      expect(held.temporal.hazard!.forecast).toBeNull();
      expect(held.temporal.concerns.every((c) => c.source === 'data-quality')).toBe(true);
      const recovered = runtime.receive(sample(8), 13000);
      expect(recovered.temporal.hazard!.sampleCount).toBe(1);
    }
  });
  it('does not age world knowledge on wall-clock pause', () => {
    const { runtime, view } = run();
    runtime.receive(sample(7.75), 900000);
    // A delivery gap deliberately restarts model support; repeated pause deliveries do not age simulation time.
    const paused = runtime.receive(sample(7.75), 900010);
    expect(paused.temporal.time).toBe(view.temporal.time);
    expect(paused.mapping.latestSimulationTime).toBe(view.mapping.latestSimulationTime);
  });
  it('time reset starts a clean analytical session and does not leak old scores', () => {
    const { runtime } = run();
    const reset = runtime.receive(sample(0), 8000);
    expect(reset.temporal.session).toBe(2);
    expect(reset.temporal.evaluations).toHaveLength(0);
    expect(reset.temporal.hazard!.sampleCount).toBe(1);
  });
  it('large time gaps break support without interpolated evidence', () => {
    const { runtime } = run();
    const view = runtime.receive(sample(20), 8100);
    expect(view.temporal.hazard!.sampleCount).toBe(1);
    expect(view.temporal.concerns.some((c) => c.id === 'time-gap')).toBe(true);
  });
  it('missing folds stay historical and reappearance restarts contiguous support', () => {
    const { runtime } = run();
    const missing = runtime.receive(sample(8, { connections: [] }), 8000);
    expect(missing.temporal.folds[0]!.currentState).toBeNull();
    expect(missing.temporal.folds[0]!.entry.forecast).toBeNull();
    const returned = runtime.receive(sample(8.25), 8250);
    expect(returned.temporal.folds[0]!.entry.sampleCount).toBe(1);
  });
  it('counts censored or interrupted forecast targets as unscorable instead of dropping them', () => {
    const { runtime } = run(20);
    const missingFold = runtime.receive(sample(5, { connections: [] }), 5000);
    expect(missingFold.temporal.folds[0]!.entry.score.skipped).toBeGreaterThan(0);
    runtime.markUnavailable('sensor delivery interrupted', 5100);
    const recovered = runtime.receive(sample(5.25, { connections: [] }), 5250);
    expect(recovered.temporal.hazard!.score.skipped).toBeGreaterThan(0);
  });
  it('a large observed endpoint jump breaks a motion model without declaring a traversal', () => {
    const { runtime } = run();
    const o = sample(8);
    const jump = runtime.receive(sample(8, { sensorRange: 600, connections: [{ ...o.connections[0]!, entryWorldPosition: [500, 0, 0] }] }), 8000);
    expect(jump.temporal.folds[0]!.entry.sampleCount).toBe(1);
    expect(jump.temporal.folds[0]!.entry.forecast).toBeNull();
  });
  it('keeps constant visible state as insufficient for a learned next-label estimate', () => {
    const { view } = run();
    expect(view.temporal.folds[0]!.observedTransitions).toBe(0);
    expect(view.temporal.folds[0]!.nextLabelEstimate).toBeNull();
    expect(view.temporal.folds[0]!.sampledStateSupportSeconds).toBeCloseTo(3.75);
  });
  it('retains descriptive fold-state transition counts without forecasting lookahead-contaminated labels', () => {
    const { view } = run(32, (t) => {
      const o = sample(t);
      return { ...o, connections: [{ ...o.connections[0]!, state: (Math.round(t * 4) % 6 === 0 ? 'unstable' : 'open') as 'unstable' | 'open' }] };
    });
    const f = view.temporal.folds[0]!;
    expect(f.observedTransitions).toBeGreaterThan(2);
    expect(f.nextLabelCounts.reduce((s, n) => s + n.count, 0)).toBe(f.stateComparisons);
    expect(f.nextLabelEstimate).toBeNull();
    expect(f.nextLabelTargetTime).toBeNull();
    expect(f.labelScore.evaluated).toBe(0);
    expect(f.nextLabelReason).toContain('lookahead');
    expect(f.recentTransitions.every((transition) => transition.earliestAfter < transition.latestAt)).toBe(true);
  });
  it('threshold concerns are traceable current measurements and suppress duplicate events', () => {
    const runtime = new AtlasRuntime();
    const high = sample(0, { local: { hazard: 0.9, gravity: [0, -1, 0] } });
    const first = runtime.receive(high, 0);
    expect(first.temporal.concerns.find((c) => c.id === 'hazard-level')?.source).toBe('current-measurement');
    const n = first.events.filter((e) => e.kind === 'analytical-concern').length;
    const repeated = runtime.receive(high, 10);
    expect(repeated.events.filter((e) => e.kind === 'analytical-concern')).toHaveLength(n);
  });
  it('reports a measured endpoint movement concern separately from physical danger', () => {
    const { view } = run(32, (t) => {
      const o = sample(t);
      return sample(t, { sensorRange: 100, connections: [{ ...o.connections[0]!, entryWorldPosition: [10 + t * 8, 3, 8] }] });
    });
    const concern = view.temporal.concerns.find((c) => c.id === 'fold-motion:fold-A');
    expect(concern?.source).toBe('observed-change');
    expect(concern?.explanation).toContain('does not establish traversal danger');
  });
  it('is deterministic, immutable and survives short Phase 1 ring rollover', () => {
    const a = run(80, sample, { historyLimit: 4 });
    const b = run(80, sample, { historyLimit: 4 });
    expect(a.view.temporal).toEqual(b.view.temporal);
    expect(a.view.sampleCount).toBe(4);
    expect(a.view.temporal.hazard!.score.evaluated).toBeGreaterThan(10);
    expect(Object.isFrozen(a.view.temporal.hazard!.forecast!.estimate)).toBe(true);
    const input = sample(20);
    const before = JSON.stringify(input);
    a.runtime.receive(input, 20000);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('bounds windows, forecasts and evaluation storage', () => {
    const { view } = run(300, sample, { temporal: { evaluationLimit: 25, maxModels: 2 } });
    expect(view.temporal.evaluations.length).toBeLessThanOrEqual(25);
    expect(view.temporal.pendingForecasts).toBeLessThanOrEqual(8);
    expect(view.temporal.hazard!.sampleCount).toBeLessThanOrEqual(16);
    expect(view.temporal.folds.length + view.temporal.islands.length).toBeLessThanOrEqual(2);
  });
});
