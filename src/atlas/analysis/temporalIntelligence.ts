import type { AtlasObservation, ObservedConnectionState } from '../../shared/atlasContract';
import type { ExplorationMapSnapshot } from '../mapping/explorationMemory';
import { contiguousSuffixFrom, distance3, fitVectorBy, percentile, predictLinear } from './models';
import type { AnalyticalConcern, ForecastEvaluation, ForecastScore, FoldDynamics, NumericAnalysis, NumericForecast, TemporalEvent, TemporalPolicy, TemporalSnapshot } from './types';

export const DEFAULT_TEMPORAL_POLICY: Readonly<TemporalPolicy> = Object.freeze({
  windowSamples: 16, minSamples: 6, minSpanSeconds: 1, maxGapSeconds: 1.5,
  horizonSeconds: 1, maxScoreDelaySeconds: 0.15, stationaryRadius: 0.5, discontinuityDistance: 75,
  elevatedHazard: 0.65, highHazard: 0.85, endpointSpeedAttention: 5, maxModels: 256, evaluationLimit: 512,
});

interface Pending {
  key: string;
  published: boolean;
  issuedAt: number;
  targetTime: number;
  estimate: readonly number[];
  baseline: readonly number[];
  allowance: number;
}
interface Truth { time: number; values: ReadonlyMap<string, readonly number[]> }
const states: readonly ObservedConnectionState[] = ['inactive', 'forming', 'open', 'unstable', 'closing', 'closed'];
const freeze = <T>(values: T[]): readonly T[] => Object.freeze(values);
const copy = (values: readonly number[]): readonly number[] => freeze([...values]);
const fitSlopeNorm = (fits: readonly { readonly slope: number }[]): number => {
  let squared = 0;
  for (const fit of fits) squared += fit.slope * fit.slope;
  return Math.sqrt(squared);
};
const errorBetween = (a: readonly number[], b: readonly number[]): number => {
  let squared = 0;
  for (let index = 0; index < a.length; index += 1) squared += (a[index]! - b[index]!) ** 2;
  return Math.sqrt(squared);
};

/** Consumes only accepted runtime observations and their Phase 2 derived histories.
 * Forecasts are scored after their target sample is finalized by the next distinct delivery.
 * A prediction is never fitted using its eventual target measurement. */
export class TemporalIntelligence {
  readonly policy: Readonly<TemporalPolicy>;
  private session = 1;
  private time: number | null = null;
  private interrupted = false;
  private cutoffs = new Map<string, number>();
  private previousMembership = new Set<string>();
  private pending: Pending[] = [];
  private pendingHead = 0;
  private evaluations: ForecastEvaluation[] = [];
  private scores = new Map<string, ForecastEvaluation[]>();
  private scoreCache = new Map<string, ForecastScore>();
  private skipped = new Map<string, number>();
  private truth: Truth | null = null;
  private activeConcerns = new Set<string>();
  private snapshot: TemporalSnapshot;

  constructor(options: Partial<TemporalPolicy> = {}) {
    const policy = { ...DEFAULT_TEMPORAL_POLICY, ...options };
    for (const [key, value] of Object.entries(policy)) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${key} must be positive and finite.`);
    }
    for (const key of ['windowSamples', 'minSamples', 'maxModels', 'evaluationLimit'] as const) {
      if (!Number.isInteger(policy[key])) throw new RangeError(`${key} must be an integer.`);
    }
    if (policy.minSamples < 3 || policy.windowSamples < policy.minSamples || policy.highHazard > 1 || policy.elevatedHazard >= policy.highHazard || policy.horizonSeconds > 2) {
      throw new RangeError('Inconsistent analytical policy. Horizons are limited to two model seconds.');
    }
    this.policy = Object.freeze(policy);
    this.snapshot = this.empty();
  }

  reset(session: number): void {
    this.session = session;
    this.time = null;
    this.interrupted = false;
    this.cutoffs.clear();
    this.previousMembership.clear();
    this.pending = [];
    this.pendingHead = 0;
    this.evaluations = [];
    this.scores.clear();
    this.scoreCache.clear();
    this.skipped.clear();
    this.truth = null;
    this.activeConcerns.clear();
    this.snapshot = this.empty();
  }

  interrupt(): void {
    this.interrupted = true;
    this.discardPending(this.pending.slice(this.pendingHead));
    this.pending = [];
    this.pendingHead = 0;
  }

  update(observation: AtlasObservation, map: ExplorationMapSnapshot): readonly TemporalEvent[] {
    if (map.session !== this.session || (this.time !== null && observation.time < this.time)) this.reset(map.session);
    const advancing = this.time === null || observation.time > this.time;
    const gap = this.time !== null && observation.time - this.time > this.policy.maxGapSeconds;
    if (advancing && this.truth && !this.interrupted && !gap) this.evaluate(this.truth, observation.time);
    if (!advancing) this.removePendingAt(observation.time);
    if (gap) this.interrupt();
    if (this.interrupted) { this.cutoffs.clear(); this.previousMembership.clear(); }

    const membership = new Set<string>(['environment']);
    const values = new Map<string, readonly number[]>();
    const use = (id: string): number => {
      membership.add(id);
      if (!this.previousMembership.has(id) || this.interrupted) this.cutoffs.set(id, observation.time);
      return this.cutoffs.get(id) ?? observation.time;
    };
    const cutoff = use('environment');
    let environment = contiguousSuffixFrom(map.environment, this.policy.maxGapSeconds, this.policy.windowSamples, cutoff, (s) => s.breakBefore);
    // A local temporal model must not silently become a model of the observer's route.
    let locationStart = environment.length - 1;
    while (locationStart > 0 && distance3(environment[locationStart - 1]!.observerWorldPosition, observation.observerWorldPosition) <= this.policy.stationaryRadius) locationStart -= 1;
    const moved = environment.length > 1 && locationStart > 0;
    if (moved) this.cancelPending((p) => p.key === 'hazard' || p.key === 'gravity');
    environment = environment.slice(Math.max(0, locationStart));
    const environmentReason = moved ? 'Observer changed locality; spatial and temporal changes cannot be separated.' : null;
    values.set('hazard', [observation.local.hazard]);
    values.set('gravity', [Math.hypot(...observation.local.gravity)]);
    const hazard = this.numeric('hazard', 'Local instability', 'sensor scale 0–1', environment, (sample) => sample.hazard, [observation.local.hazard], true, environmentReason, [0, 1]);
    const gravity = this.numeric('gravity', 'Gravity magnitude', 'world units / s²', environment, (sample) => sample.gravityMagnitude, [Math.hypot(...observation.local.gravity)], true, environmentReason, [0, Infinity]);

    const absentKeys = new Set<string>();
    for (const fold of map.folds) if (!fold.currentlyObserved && this.previousMembership.has(`fold:${fold.id}`)) {
      absentKeys.add(`fold:${fold.id}:entry`);
      absentKeys.add(`fold:${fold.id}:exit`);
      absentKeys.add(`fold:${fold.id}:separation`);
    }
    for (const island of map.islands) if (!island.currentlyObserved && this.previousMembership.has(`island:${island.id}`)) absentKeys.add(`island:${island.id}`);
    this.cancelPending((p) => absentKeys.has(p.key));

    const folds: FoldDynamics[] = [];
    let entities = 0;
    // Spend the bounded model budget on current sensor evidence before older records.
    for (let pass = 0; pass < 2; pass += 1) for (const fold of map.folds) {
      if (entities >= this.policy.maxModels) break;
      if (fold.currentlyObserved !== (pass === 0)) continue;
      entities += 1;
      const id = `fold:${fold.id}`;
      const start = fold.currentlyObserved ? use(id) : this.cutoffs.get(id) ?? Infinity;
      const samples = contiguousSuffixFrom(fold.track, this.policy.maxGapSeconds, this.policy.windowSamples, start,
        (s, index, track) => { const before = track[index - 1]; return before !== undefined && (distance3(before.entryPosition, s.entryPosition) > this.policy.discontinuityDistance || distance3(before.exitPosition, s.exitPosition) > this.policy.discontinuityDistance); });
      const entryKey = `${id}:entry`;
      const exitKey = `${id}:exit`;
      const separationKey = `${id}:separation`;
      if (fold.currentlyObserved) {
        values.set(entryKey, fold.lastKnownEntryPosition);
        values.set(exitKey, fold.lastKnownExitPosition);
        values.set(separationKey, [distance3(fold.lastKnownEntryPosition, fold.lastKnownExitPosition)]);
      }
      const entry = this.numeric(entryKey, `${fold.id} entry`, 'world units', samples, (sample, axis) => sample.entryPosition[axis]!, fold.lastKnownEntryPosition, fold.currentlyObserved, null);
      const exit = this.numeric(exitKey, `${fold.id} reported exit`, 'world units', samples, (sample, axis) => sample.exitPosition[axis]!, fold.lastKnownExitPosition, fold.currentlyObserved, null);
      const endpointSeparation = this.numeric(separationKey, `${fold.id} endpoint separation`, 'Euclidean world units · not a route cost', samples, (sample) => distance3(sample.entryPosition, sample.exitPosition), [distance3(fold.lastKnownEntryPosition, fold.lastKnownExitPosition)], fold.currentlyObserved, null);
      let transitions = 0;
      const recentTransitions: { from: ObservedConnectionState; to: ObservedConnectionState; earliestAfter: number; latestAt: number }[] = [];
      const counts = new Map<ObservedConnectionState, number>();
      let stateStart = samples[0]?.time ?? fold.lastSeenAt;
      for (let i = 1; i < samples.length; i += 1) {
        const before = samples[i - 1]!;
        const after = samples[i]!;
        if (before.state !== after.state) { transitions += 1; stateStart = after.time; recentTransitions.push(Object.freeze({ from: before.state, to: after.state, earliestAfter: before.time, latestAt: after.time })); }
        if (before.state === fold.currentState) counts.set(after.state, (counts.get(after.state) ?? 0) + 1);
      }
      const comparisons = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const ranked = states.map((state) => Object.freeze({ state, count: counts.get(state) ?? 0 })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count || states.indexOf(a.state) - states.indexOf(b.state));
      folds.push(Object.freeze({
        id: fold.id, firstSeenAt: fold.firstSeenAt, currentlyObserved: fold.currentlyObserved, lastSeenAt: fold.lastSeenAt,
        currentState: fold.currentState, lastObservedState: fold.lastObservedState, sampleCount: samples.length,
        observedTransitions: transitions, stateComparisons: comparisons,
        sampledStateSupportSeconds: Math.max(0, (samples.at(-1)?.time ?? stateStart) - stateStart),
        recentTransitions: freeze(recentTransitions.slice(-16)),
        nextLabelCounts: freeze(ranked), nextLabelEstimate: null, nextLabelTargetTime: null,
        nextLabelReason: 'Fold-state forecasts are disabled: the sensor label may already include approximately one second of lookahead, so clean independent target labels are unavailable.',
        labelScore: Object.freeze({ evaluated: 0 as const, correct: 0 as const, persistenceCorrect: 0 as const }), entry, exit, endpointSeparation,
      }));
    }
    const islands: { readonly id: string; readonly motion: NumericAnalysis }[] = [];
    for (let pass = 0; pass < 2; pass += 1) for (const island of map.islands) {
      if (entities >= this.policy.maxModels) break;
      if (island.currentlyObserved !== (pass === 0)) continue;
      entities += 1;
      const key = `island:${island.id}`;
      const start = island.currentlyObserved ? use(key) : this.cutoffs.get(key) ?? Infinity;
      const samples = contiguousSuffixFrom(island.track, this.policy.maxGapSeconds, this.policy.windowSamples, start, (s) => s.breakBefore);
      if (island.currentlyObserved) values.set(key, island.lastKnownPosition);
      islands.push(Object.freeze({ id: island.id, motion: this.numeric(key, `${island.id} position`, 'world units', samples, (sample, axis) => sample.position[axis]!, island.lastKnownPosition, island.currentlyObserved, null) }));
    }

    this.time = observation.time;
    this.truth = { time: observation.time, values };
    this.cancelPending((p) => !values.has(p.key));
    if (this.pendingHead > 0) {
      this.pending.splice(0, this.pendingHead);
      this.pendingHead = 0;
    }
    const pendingLimit = this.policy.maxModels * 4;
    if (this.pending.length > pendingLimit) {
      this.discardPending(this.pending.slice(0, this.pending.length - pendingLimit));
      this.pending = this.pending.slice(-pendingLimit);
    }
    this.previousMembership = membership;
    this.interrupted = false;
    for (const key of this.cutoffs.keys()) if (!membership.has(key)) this.cutoffs.delete(key);
    this.prune(this.scores, this.policy.maxModels * 3 + 2);
    this.prune(this.skipped, this.policy.maxModels * 3 + 2);
    this.prune(this.scoreCache, this.policy.maxModels * 3 + 2);
    const concerns = this.concerns(observation, hazard, gravity, folds, gap, map.islands.length + map.folds.length > entities);
    const events = advancing ? concerns.filter((c) => !this.activeConcerns.has(c.id)).map((c) => Object.freeze({ kind: 'analytical-concern' as const, simulationTime: observation.time, message: `${c.title}: ${c.explanation}` })) : [];
    this.activeConcerns = new Set(concerns.map((c) => c.id));
    this.snapshot = Object.freeze({
      session: this.session, time: observation.time, available: true, statusReason: 'Derived from accepted sensor observations.',
      hazard, gravity, folds: freeze(folds), islands: freeze(islands), concerns: freeze(concerns),
      evaluations: freeze([...this.evaluations]), evaluatedForecasts: this.evaluations.length,
      pendingForecasts: this.pending.length - this.pendingHead, policy: this.policy,
    });
    return freeze(events);
  }

  read(deliveryStatus: string): TemporalSnapshot {
    if (deliveryStatus === 'receiving' || deliveryStatus === 'unchanged' || this.time === null) return this.snapshot;
    const held = (a: NumericAnalysis): NumericAnalysis => Object.freeze({ ...a, forecast: null, quality: 'withheld', reasons: freeze([`Sensor ${deliveryStatus}; historical fit is held, current forecast unavailable.`]) });
    return Object.freeze({ ...this.snapshot, available: false, statusReason: `Sensor ${deliveryStatus}; analytical values are historical. Estimates withheld.`,
      hazard: this.snapshot.hazard ? held(this.snapshot.hazard) : null,
      gravity: this.snapshot.gravity ? held(this.snapshot.gravity) : null,
      folds: freeze(this.snapshot.folds.map((f) => Object.freeze({ ...f, entry: held(f.entry), exit: held(f.exit), endpointSeparation: held(f.endpointSeparation) }))),
      islands: freeze(this.snapshot.islands.map((i) => Object.freeze({ id: i.id, motion: held(i.motion) }))), pendingForecasts: 0,
      concerns: freeze([{ id: 'delivery-degraded', severity: 'attention' as const, title: 'Current analytical evidence unavailable', explanation: `Sensor ${deliveryStatus}; held measurements cannot establish current environmental conditions.`, source: 'data-quality' as const, time: this.time }]),
    });
  }

  private numeric<T extends { readonly time: number }>(key: string, label: string, units: string, samples: readonly T[], valueAt: (sample: T, axis: number) => number, observed: readonly number[], current: boolean, reason: string | null, domain?: readonly [number, number]): NumericAnalysis {
    const fits = fitVectorBy(samples, observed.length, valueAt);
    const validFits = fits.filter((f) => f !== null);
    const score = this.score(key);
    const span = samples.length > 0 ? samples.at(-1)!.time - samples[0]!.time : 0;
    const reasons: string[] = [];
    if (!current) reasons.push('Not in the current sensor observation; current motion is unknown.');
    if (samples.length < this.policy.minSamples || span < this.policy.minSpanSeconds || validFits.length !== observed.length) reasons.push(reason ?? `Need ${this.policy.minSamples} contiguous samples over ${this.policy.minSpanSeconds} model second(s).`);
    const underperforming = score.evaluated >= 6 && score.meanAbsoluteError! > score.persistenceMeanAbsoluteError! * 1.25 + 1e-9;
    let forecast: NumericForecast | null = null;
    if (reasons.length === 0) {
      const issuedAt = samples.at(-1)!.time;
      const targetTime = issuedAt + this.policy.horizonSeconds;
      const estimate = validFits.map((f) => predictLinear(f, targetTime));
      if (estimate.some((v) => !Number.isFinite(v) || (domain && (v < domain[0] || v > domain[1])))) reasons.push('Linear extrapolation left the measurement domain; no clamped forecast is displayed.');
      else {
        let residualSquared = 0;
        for (const fit of validFits) residualSquared += fit.residualRms * fit.residualRms;
        const residualAllowance = 2 * Math.sqrt(residualSquared) * (1 + this.policy.horizonSeconds / span);
        const allowance = Math.max(residualAllowance, score.errorP95 ?? 0);
        const candidate: NumericForecast = Object.freeze({ issuedAt, targetTime, estimate: copy(estimate), errorAllowance: allowance, model: 'local-linear' });
        if (!underperforming) forecast = candidate;
        this.pending.push({ key, issuedAt, targetTime, estimate: candidate.estimate, baseline: copy(observed), allowance, published: !underperforming });
      }
    }
    if (underperforming) reasons.push('Recent held-out error exceeds the persistence baseline; forecast withheld. Shadow candidates are checked for recovery.');
    return Object.freeze({ key, label, units, observed: copy(observed), fits: freeze(validFits), sampleCount: samples.length,
      supportStart: samples[0]?.time ?? null, supportEnd: samples.at(-1)?.time ?? null,
      quality: reasons.length > 0 ? (current && samples.length < this.policy.minSamples ? 'insufficient' : 'withheld') : score.evaluated >= 6 ? 'evaluated' : 'provisional',
      reasons: freeze(reasons), forecast, score,
    });
  }

  private evaluate(truth: Truth, evaluatedAt: number): void {
    // Forecasts are appended chronologically with a fixed horizon, so eligible records
    // form a prefix. Leave future candidates in-place and do no per-frame full-array scan.
    while (this.pendingHead < this.pending.length && this.pending[this.pendingHead]!.targetTime <= truth.time + 1e-7) {
      const p = this.pending[this.pendingHead++]!;
      const actual = truth.values.get(p.key);
      // Score the original estimate against the first later target sample within the declared
      // delay tolerance. Store its actual time; never interpolate or refit the forecast.
      if (truth.time - p.targetTime > this.policy.maxScoreDelaySeconds || !actual || truth.time <= p.issuedAt) {
        this.addSkipped(p.key);
        continue;
      }
      const error = errorBetween(p.estimate, actual);
      const evaluation: ForecastEvaluation = Object.freeze({ key: p.key, published: p.published, issuedAt: p.issuedAt, targetTime: p.targetTime, observedAt: truth.time, evaluatedAt, error, persistenceError: errorBetween(p.baseline, actual), errorAllowance: p.allowance, covered: error <= p.allowance + 1e-9 });
      this.evaluations.push(evaluation);
      const records = this.scores.get(p.key) ?? [];
      records.push(evaluation);
      this.scores.delete(p.key);
      this.scores.set(p.key, records.slice(-64));
      this.scoreCache.delete(p.key);
    }
    if (this.pendingHead === this.pending.length) {
      this.pending = [];
      this.pendingHead = 0;
    } else if (this.pendingHead >= 256 && this.pendingHead * 2 >= this.pending.length) {
      this.pending.splice(0, this.pendingHead);
      this.pendingHead = 0;
    }
    this.evaluations = this.evaluations.slice(-this.policy.evaluationLimit);
  }

  private score(key: string): ForecastScore {
    const cached = this.scoreCache.get(key);
    if (cached) {
      this.scoreCache.delete(key);
      this.scoreCache.set(key, cached);
      return cached;
    }
    const scores = this.scores.get(key) ?? [];
    const published = scores.filter((s) => s.published);
    const result = Object.freeze({ evaluated: scores.length, publishedEvaluated: published.length, meanAbsoluteError: scores.length ? scores.reduce((sum, s) => sum + s.error, 0) / scores.length : null,
      persistenceMeanAbsoluteError: scores.length ? scores.reduce((sum, s) => sum + s.persistenceError, 0) / scores.length : null,
      publishedMeanAbsoluteError: published.length ? published.reduce((sum, s) => sum + s.error, 0) / published.length : null,
      envelopeHits: scores.filter((s) => s.covered).length, errorP95: percentile(scores.map((s) => s.error), 0.95), skipped: this.skipped.get(key) ?? 0,
    });
    this.scoreCache.set(key, result);
    return result;
  }

  private discardPending(pending: readonly Pending[]): void {
    for (const forecast of pending) this.addSkipped(forecast.key);
  }

  private cancelPending(predicate: (forecast: Pending) => boolean): void {
    if (this.pendingHead >= this.pending.length) return;
    const retained: Pending[] = [];
    for (let index = this.pendingHead; index < this.pending.length; index += 1) {
      const forecast = this.pending[index]!;
      if (predicate(forecast)) this.addSkipped(forecast.key);
      else retained.push(forecast);
    }
    this.pending = retained;
    this.pendingHead = 0;
  }

  private removePendingAt(issuedAt: number): void {
    if (this.pendingHead >= this.pending.length) return;
    const retained: Pending[] = [];
    for (let index = this.pendingHead; index < this.pending.length; index += 1) {
      const forecast = this.pending[index]!;
      if (forecast.issuedAt !== issuedAt) retained.push(forecast);
    }
    this.pending = retained;
    this.pendingHead = 0;
  }

  private concerns(observation: AtlasObservation, hazard: NumericAnalysis, gravity: NumericAnalysis, folds: readonly FoldDynamics[], gap: boolean, limited: boolean): AnalyticalConcern[] {
    const concerns: AnalyticalConcern[] = [];
    const add = (id: string, severity: AnalyticalConcern['severity'], title: string, explanation: string, source: AnalyticalConcern['source']) => concerns.push(Object.freeze({ id, severity, title, explanation, source, time: observation.time }));
    if (observation.local.hazard >= this.policy.elevatedHazard) add('hazard-level', observation.local.hazard >= this.policy.highHazard ? 'elevated' : 'attention', 'Elevated measured instability', `Local reading ${observation.local.hazard.toFixed(3)} meets the ${this.policy.elevatedHazard} attention policy; this is not a harm probability.`, 'current-measurement');
    if (hazard.forecast && hazard.fits[0]!.slope > 0.02) add('hazard-rising', 'attention', 'Instability rising in the sampled locality', `Observed linear slope ${hazard.fits[0]!.slope.toFixed(3)} sensor units/s. A short extrapolation assumes this locality and trend persist.`, 'observed-change');
    if (gravity.fits[0] && gravity.sampleCount >= this.policy.minSamples && Math.abs(gravity.fits[0].slope) > 0.25) add('gravity-change', 'attention', 'Gravity magnitude changing', 'Measured magnitude slope exceeds the 0.25 world units/s³ display policy; no physical safety limit is known.', 'observed-change');
    for (const f of folds.filter((f) => f.currentlyObserved && (f.currentState === 'unstable' || f.currentState === 'closing')).slice(0, 8)) add(`fold-label:${f.id}`, 'attention', `${f.id}: visible ${f.currentState}`, 'Sensor-provided visible status only. It supplies no exact closure time or traversal assurance.', 'current-measurement');
    let motionAlerts = 0;
    for (const f of folds) {
      if (!f.currentlyObserved || f.entry.fits.length !== 3 || f.entry.sampleCount < this.policy.minSamples) continue;
      if (motionAlerts >= 8) break;
      const speed = fitSlopeNorm(f.entry.fits);
      if (speed >= this.policy.endpointSpeedAttention) add(`fold-motion:${f.id}`, 'attention', `${f.id}: endpoint movement elevated`, `Observed entry-position rate ${speed.toFixed(2)} world units/s meets the configured ${this.policy.endpointSpeedAttention} units/s advisory threshold. Movement alone does not establish traversal danger.`, 'observed-change');
      motionAlerts += 1;
    }
    const latestEvaluation = new Map<string, ForecastEvaluation>();
    for (const evaluation of this.evaluations) latestEvaluation.set(evaluation.key, evaluation);
    for (const evaluation of latestEvaluation.values()) {
      if (!evaluation.covered && observation.time - evaluation.evaluatedAt <= 3) add(`forecast-miss:${evaluation.key}`, 'attention', `${evaluation.key}: estimate outside recent error allowance`, `A later observation differed by ${evaluation.error.toFixed(3)}; the local model is being re-evaluated against persistence.`, 'forecast-validation');
    }
    if (gap) add('time-gap', 'information', 'Observation gap breaks model support', 'New estimates require a new contiguous window. Missing time was not filled in.', 'data-quality');
    if (limited) add('analysis-limit', 'information', 'Analytical entity limit reached', `Only ${this.policy.maxModels} remembered entities are analyzed; the exploration map remains separate.`, 'data-quality');
    return concerns;
  }

  private prune<T>(map: Map<string, T>, limit: number): void {
    while (map.size > limit) map.delete(map.keys().next().value!);
  }

  private addSkipped(key: string): void {
    this.skipped.set(key, (this.skipped.get(key) ?? 0) + 1);
    this.scoreCache.delete(key);
  }

  private empty(): TemporalSnapshot {
    return Object.freeze({ session: this.session, time: null, available: false, statusReason: 'Awaiting accepted observations.', hazard: null, gravity: null, folds: freeze([]), islands: freeze([]), concerns: freeze([]), evaluations: freeze([]), evaluatedForecasts: 0, pendingForecasts: 0, policy: this.policy });
  }
}
