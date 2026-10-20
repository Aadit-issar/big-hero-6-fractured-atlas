import { DEFAULT_MOTION_POLICY, fitTrack, predictMotion, staticEstimate } from '../challenge/motionModel';
import type { MotionFit, MotionKind, MotionPolicy } from '../challenge/motionModel';
import type { TrackSample } from '../challenge/types';
import type { Vec3 } from './world';

/** Motion intelligence for live tracking.
 *
 * The estimator is the challenge's validated local model (rolling-origin validation against persistence, explicit uncertainty), run with a
 * policy matched to the live cadence: scans arrive at 2 Hz, so a track needs fewer samples than the 4 Hz challenge fixture and tolerates the
 * 0.5 s spacing. Nothing about the world's governing law is used: only timestamped observed positions.
 *
 * A FORECAST is frozen when it is issued. A later observation is compared with it; the forecast itself is never edited, re-fitted or
 * replaced, and the comparison is reported next to the persistence baseline ("it has not moved"). */

export const LIVE_MOTION_POLICY: Readonly<MotionPolicy> = Object.freeze({
  ...DEFAULT_MOTION_POLICY, windowSamples: 64, minSamples: 8, minSpanSeconds: 2.5, maxGapSeconds: 1.3, maxAgeSeconds: 1.6, validationLeadSeconds: 2.5, minValidationOrigins: 3, validationStepSamples: 1,
  linearSpans: [3, 5], quadraticSpan: 5, horizonSeconds: 30, maxStatedUncertainty: 8,
});

export type MotionClass = 'moving' | 'static' | 'unknown';
export interface Estimate {
  readonly id: string;
  readonly ok: boolean;
  readonly fit: MotionFit | null;
  readonly motion: MotionClass;
  /** Why no forecast is available (when !ok), or a one-line statement of the model otherwise. */
  readonly note: string;
  readonly speed: number | null;
}

/** Speed below which an entity with a validated model is called static. */
export const STATIC_SPEED = 0.35;
const MIN_STATIC_SPAN = 6;

/** Fit the best-supported model for one track at simulation time `now`; classify it as moving / static / unknown. */
export function estimate(id: string, track: readonly TrackSample[], now: number, policy: Readonly<MotionPolicy> = LIVE_MOTION_POLICY): Estimate {
  const result = fitTrack(id, track, now, policy);
  if (result.ok) {
    const { fit } = result;
    const motion: MotionClass = fit.kind === 'persistence' || fit.speed < STATIC_SPEED ? 'static' : 'moving';
    return { id, ok: true, fit, motion, speed: fit.speed, note: fit.validation?.reason ?? 'fitted' };
  }
  // A long, motionless record is static even though no moving model can be validated on it.
  const last = track.at(-1);
  const first = track[0];
  if (last && first && last.time - first.time >= MIN_STATIC_SPAN && now - last.time <= policy.maxAgeSeconds) {
    const drift = Math.hypot(last.position[0] - first.position[0], last.position[1] - first.position[1], last.position[2] - first.position[2]);
    if (drift < 0.5) {
      const fit = staticEstimate(id, track);
      if (fit) return { id, ok: true, fit, motion: 'static', speed: 0, note: `Not moved in ${(last.time - first.time).toFixed(0)} s of observation.` };
    }
  }
  return { id, ok: false, fit: null, motion: 'unknown', speed: null, note: result.reasons[0] ?? 'No forecast available.' };
}

/** Where an estimate says the entity will be at time `t`, with the uncertainty radius and whether `t` is inside the model's trust horizon. */
export function positionAt(fit: MotionFit, t: number): { position: Vec3; uncertainty: number; supported: boolean } {
  const p = predictMotion(fit, t);
  return { position: p.position, uncertainty: p.uncertainty * calibration(t - fit.issuedAt), supported: p.supported };
}

/** Empirical inflation of the stated uncertainty with lead time. Measured against the Dimension's capsule (tests/commandCore.test.ts):
 * the model's own bound covers about 88 % of 3 s forecasts but only about half of 6 s ones, because the capsule's path has sudden bends the
 * local polynomial cannot see coming. The factor widens the stated radius from 1 (lead <= 3 s) to 1.75 (lead >= 6 s). */
export function calibration(lead: number): number { return 1 + 0.25 * Math.max(0, Math.min(3, lead - 3)); }

/** How far ahead (s) ATLAS will aim at this model's forecast: where its calibrated stated uncertainty stays within 10 m, between 6 and 12 s. */
export function trustedLead(fit: MotionFit): number {
  let lead = 0;
  for (let l = 0.5; l <= 12; l += 0.5) {
    const p = positionAt(fit, fit.issuedAt + l);
    if (!p.supported || p.uncertainty > 10) break;
    lead = l;
  }
  return Math.max(6, Math.min(12, lead));
}

export interface FrozenForecast {
  readonly id: string;
  readonly entityId: string;
  readonly issuedAt: number;
  readonly targetTime: number;
  readonly horizon: number;
  readonly position: Vec3;
  readonly uncertainty: number;
  readonly model: MotionKind;
  readonly supported: boolean;
  /** The evidence the forecast was made from: how many samples, which interval, how old the newest was at issue time. */
  readonly evidence: { readonly samples: number; readonly from: number; readonly to: number; readonly ageAtIssue: number };
  /** The persistence baseline: where the entity was last seen. */
  readonly lastObserved: Vec3;
}

export interface ForecastEvaluation {
  readonly forecastId: string;
  readonly observedAt: number;
  readonly observed: Vec3;
  readonly error: number;
  readonly baselineError: number;
  readonly insideUncertainty: boolean;
  /** Seconds between the forecast's issue and the observation that evaluated it. */
  readonly lead: number;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Issued forecasts and their later evaluations. A forecast is evaluated against the first observation at or after its target time (within `tolerance`). */
export class ForecastBook {
  private issued: FrozenForecast[] = [];
  private evaluations = new Map<string, ForecastEvaluation>();
  private counter = 0;
  constructor(private readonly tolerance = 1.0, private readonly capacity = 60) {}

  reset(): void { this.issued = []; this.evaluations.clear(); this.counter = 0; }

  issue(entityId: string, est: Estimate, now: number, horizon: number, lastObserved: Vec3, track: readonly TrackSample[]): FrozenForecast | null {
    if (!est.ok || !est.fit || horizon <= 0) return null;
    const targetTime = now + horizon;
    const at = positionAt(est.fit, targetTime);
    const last = track.at(-1);
    this.counter += 1;
    const forecast: FrozenForecast = Object.freeze({
      id: `fc-${this.counter}`, entityId, issuedAt: now, targetTime, horizon, position: Object.freeze([...at.position]) as unknown as Vec3, uncertainty: at.uncertainty, model: est.fit.kind, supported: at.supported,
      evidence: Object.freeze({ samples: est.fit.support.count, from: est.fit.support.start, to: est.fit.support.end, ageAtIssue: last ? now - last.time : 0 }),
      lastObserved: Object.freeze([...lastObserved]) as unknown as Vec3,
    });
    this.issued.push(forecast);
    if (this.issued.length > this.capacity) { const dropped = this.issued.shift()!; this.evaluations.delete(dropped.id); }
    return forecast;
  }

  /** Feed an observation; evaluates every pending forecast for that entity whose target time has now been reached. */
  observe(entityId: string, time: number, position: Vec3): ForecastEvaluation[] {
    const done: ForecastEvaluation[] = [];
    for (const f of this.issued) {
      if (f.entityId !== entityId || this.evaluations.has(f.id) || time < f.targetTime - 1e-9) continue;
      if (time > f.targetTime + this.tolerance) { continue; }
      const e: ForecastEvaluation = Object.freeze({ forecastId: f.id, observedAt: time, observed: Object.freeze([...position]) as unknown as Vec3, error: dist(f.position, position), baselineError: dist(f.lastObserved, position), insideUncertainty: dist(f.position, position) <= f.uncertainty, lead: time - f.issuedAt });
      this.evaluations.set(f.id, e);
      done.push(e);
    }
    return done;
  }

  list(entityId?: string): FrozenForecast[] { return this.issued.filter(f => !entityId || f.entityId === entityId); }
  evaluation(id: string): ForecastEvaluation | undefined { return this.evaluations.get(id); }
  evaluated(entityId?: string): { forecast: FrozenForecast; evaluation: ForecastEvaluation }[] {
    return this.issued.filter(f => (!entityId || f.entityId === entityId) && this.evaluations.has(f.id)).map(f => ({ forecast: f, evaluation: this.evaluations.get(f.id)! }));
  }
  /** Forecasts whose target time has passed with no observation inside the tolerance (the entity was not observed then). */
  unresolved(now: number): FrozenForecast[] { return this.issued.filter(f => !this.evaluations.has(f.id) && now > f.targetTime + this.tolerance); }
  pending(now: number): FrozenForecast[] { return this.issued.filter(f => !this.evaluations.has(f.id) && now <= f.targetTime + this.tolerance); }
}
