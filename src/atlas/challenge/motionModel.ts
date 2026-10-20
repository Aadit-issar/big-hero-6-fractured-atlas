import { contiguousSuffixFrom } from '../analysis/models';
import type { TrackSample, Vec3 } from './types';

/** Observation-driven local motion model for ONE tracked entity.
 *
 * ATLAS never sees the world's governing law. From a bounded window of timestamped positions it fits polynomial-in-time models
 * (linear, quadratic), chooses between them and a persistence baseline by ROLLING-ORIGIN validation inside the observed history
 * (fit on the past, score on later samples that were not used in that fit), and attaches an explicit, growing uncertainty.
 * Nothing here is an exact world law: it is a local extrapolator with a stated horizon, and it refuses (with reasons) when the
 * evidence does not support one. */

export interface MotionPolicy {
  /** Most recent samples considered (bounded history). */
  readonly windowSamples: number;
  readonly minSamples: number;
  readonly minSpanSeconds: number;
  /** A larger gap ends the contiguous support (missing time is never interpolated). */
  readonly maxGapSeconds: number;
  /** The newest sample must be this fresh. */
  readonly maxAgeSeconds: number;
  /** Hard cap on the extrapolation a model is ever trusted for; beyond a model's own horizon only a widening envelope applies. */
  readonly horizonSeconds: number;
  /** A model's trust horizon ends where its stated uncertainty reaches this size (an obstacle-sized region says nothing useful). */
  readonly maxStatedUncertainty: number;
  /** Lead time used to validate (fit on the past, predict this far ahead inside the history). */
  readonly validationLeadSeconds: number;
  readonly validationStepSamples: number;
  readonly minValidationOrigins: number;
  /** Candidate training spans (seconds) for the local-linear model: a short span follows curvature, a long one averages noise. */
  readonly linearSpans: readonly number[];
  /** Training span (seconds) of the local-quadratic candidate. */
  readonly quadraticSpan: number;
  /** A more complex candidate is chosen only if its validation RMSE is below this fraction of the simplest candidate within reach (parsimony). */
  readonly quadraticGain: number;
  /** A fitted model must beat persistence by this factor in validation, else persistence is used. */
  readonly persistenceGain: number;
  /** Lead time at which candidate models are compared by their stated uncertainty. */
  readonly planningLeadSeconds: number;
  /** Models whose held-out RMSE is within this factor of the best model's are 'not contradicted' by validation. */
  readonly survivorTolerance: number;
  /** Coverage multiplier of the prediction-noise term. */
  readonly z: number;
  /** Smallest uncertainty ever reported (sensor-noise floor). */
  readonly uncertaintyFloor: number;
}

export const DEFAULT_MOTION_POLICY: Readonly<MotionPolicy> = Object.freeze({
  windowSamples: 48, minSamples: 12, minSpanSeconds: 3, maxGapSeconds: 0.75, maxAgeSeconds: 0.6, horizonSeconds: 20, maxStatedUncertainty: 6,
  validationLeadSeconds: 3, validationStepSamples: 2, minValidationOrigins: 4, linearSpans: [4.5, 9], quadraticSpan: 9, quadraticGain: 0.85, planningLeadSeconds: 8, survivorTolerance: 1.25, persistenceGain: 0.9, z: 2, uncertaintyFloor: 0.25,
});

export type MotionKind = 'static' | 'persistence' | 'linear' | 'quadratic';

export interface ValidationSummary {
  readonly leadSeconds: number;
  readonly origins: number;
  /** Root-mean-square position error at the validation lead, per candidate (null when it could not be fitted). */
  readonly rmse: { readonly persistence: number; readonly linear: number | null; readonly quadratic: number | null };
  /** Every candidate that was scored on the same origins, simplest first. */
  readonly candidates: readonly { readonly name: string; readonly kind: MotionKind; readonly spanSeconds: number; readonly rmse: number }[];
  /** Training span of the selected model. */
  readonly spanSeconds: number;
  /** Error beyond what sensor noise alone explains at this lead; this is the truncation bias that is extrapolated. */
  readonly excess: number;
  readonly selected: MotionKind;
  readonly reason: string;
}

/** Plain, serialisable model: coefficients are per axis, in powers of u = (t - tRef) / scale. */
export interface MotionFit {
  readonly id: string;
  readonly kind: MotionKind;
  readonly degree: number;
  readonly tRef: number;
  readonly scale: number;
  readonly coeffs: readonly (readonly number[])[];
  /** Time of the newest sample used. Forecast lead times are measured from here. */
  readonly issuedAt: number;
  readonly horizon: number;
  readonly support: { readonly start: number; readonly end: number; readonly count: number; readonly span: number };
  /** Residual norm (3 axes) of the fit, degrees-of-freedom corrected. */
  readonly sigma: number;
  /** Inverse normal matrix, row-major, for the prediction-variance leverage. */
  readonly invNormal: readonly number[];
  readonly validationLead: number;
  readonly validation: ValidationSummary | null;
  /** Taylor-remainder bound of what the model leaves out: (|next-order coefficient| + z SE), in units / s^(degree+1). Error bound = trunc * lead^(degree+1). */
  readonly trunc: number;
  /** Half the training span (0 for persistence): a least-squares fit is centred on its window, so its extrapolation error grows with (lead + lag), not lead alone. */
  readonly lag: number;
  /** Held-out RMSE at the validation lead; the stated uncertainty never falls below this scaled by lead / validationLead (up to 1). */
  readonly heldOutRmse: number;
  readonly z: number;
  readonly floor: number;
  readonly speed: number;
}

export interface Prediction {
  readonly time: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Radius around `position` the entity is expected to stay within (noise term plus truncation bias, growing with lead). */
  readonly uncertainty: number;
  /** True while the lead time is within the model's trusted horizon. */
  readonly supported: boolean;
}

export type FitResult = { readonly ok: true; readonly fit: MotionFit } | { readonly ok: false; readonly id: string; readonly reasons: readonly string[] };

type Basis = (u: number) => number[];
const basis = (degree: number): Basis => (u) => Array.from({ length: degree + 1 }, (_, k) => u ** k);

function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r;
    if (Math.abs(a[pivot]![c]!) < 1e-12) return null;
    [a[c], a[pivot]] = [a[pivot]!, a[c]!];
    const d = a[c]![c]!;
    for (let j = 0; j < 2 * n; j += 1) a[c]![j]! /= d;
    for (let r = 0; r < n; r += 1) if (r !== c) { const f = a[r]![c]!; if (f !== 0) for (let j = 0; j < 2 * n; j += 1) a[r]![j]! -= f * a[c]![j]!; }
  }
  return a.map(row => row.slice(n));
}

interface PolyFit { readonly coeffs: number[][]; readonly inv: number[][]; readonly sigma: number; readonly degree: number }

/** Least-squares polynomial of `degree` per axis on u = (t - tRef) / scale (well conditioned). */
function polyFit(samples: readonly TrackSample[], degree: number, tRef: number, scale: number): PolyFit | null {
  const p = degree + 1;
  if (samples.length < p + 1) return null;
  const phi = basis(degree);
  const normal = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const rhs = [0, 1, 2].map(() => new Array<number>(p).fill(0));
  for (const s of samples) {
    const f = phi((s.time - tRef) / scale);
    for (let i = 0; i < p; i += 1) {
      for (let j = 0; j < p; j += 1) normal[i]![j]! += f[i]! * f[j]!;
      for (let axis = 0; axis < 3; axis += 1) rhs[axis]![i]! += f[i]! * s.position[axis]!;
    }
  }
  const inv = invert(normal);
  if (!inv) return null;
  const coeffs = rhs.map(r => inv.map(row => row.reduce((sum, v, j) => sum + v * r[j]!, 0)));
  let ssr = 0;
  for (const s of samples) {
    const f = phi((s.time - tRef) / scale);
    for (let axis = 0; axis < 3; axis += 1) ssr += (s.position[axis]! - f.reduce((sum, v, k) => sum + v * coeffs[axis]![k]!, 0)) ** 2;
  }
  const sigma = Math.sqrt(ssr / Math.max(1, samples.length - p));
  if (![...coeffs.flat(), sigma].every(Number.isFinite)) return null;
  return { coeffs, inv, sigma, degree };
}

const evalAt = (coeffs: readonly (readonly number[])[], u: number): Vec3 => [0, 1, 2].map(a => coeffs[a]!.reduce((s, c, k) => s + c * u ** k, 0)) as unknown as Vec3;
const evalVel = (coeffs: readonly (readonly number[])[], u: number, scale: number): Vec3 => [0, 1, 2].map(a => coeffs[a]!.reduce((s, c, k) => (k === 0 ? s : s + k * c * u ** (k - 1)), 0) / scale) as unknown as Vec3;
const leverage = (inv: readonly (readonly number[])[], u: number, degree: number): number => {
  const f = basis(degree)(u);
  let h = 0;
  for (let i = 0; i < f.length; i += 1) for (let j = 0; j < f.length; j += 1) h += f[i]! * inv[i]![j]! * f[j]!;
  return Math.max(0, h);
};
const norm = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Position, velocity and uncertainty at absolute time `t`. Past times are allowed (lead 0). */
export function predictMotion(fit: MotionFit, t: number): Prediction {
  const lead = Math.max(0, t - fit.issuedAt);
  const u = (t - fit.tRef) / fit.scale;
  const supported = lead <= fit.horizon + 1e-9;
  const position = evalAt(fit.coeffs, u);
  const velocity = evalVel(fit.coeffs, u, fit.scale);
  const at = (l: number): number => {
    const lu = (fit.issuedAt + l - fit.tRef) / fit.scale;
    const noise = fit.z * fit.sigma * Math.sqrt(leverage(chunk(fit.invNormal, fit.degree + 1), lu, fit.degree));
    const truncation = fit.trunc * (l + fit.lag) ** (fit.degree + 1);
    return Math.max(fit.floor, noise + truncation, fit.heldOutRmse * Math.min(1, l / fit.validationLead));
  };
  let uncertainty: number;
  if (fit.kind === 'static') uncertainty = 0;
  else if (supported) uncertainty = at(lead);
  else uncertainty = at(fit.horizon) + (fit.speed + fit.sigma) * (lead - fit.horizon);
  return { time: t, position, velocity, uncertainty, supported };
}

function chunk(flat: readonly number[], n: number): number[][] {
  return Array.from({ length: n }, (_, i) => flat.slice(i * n, (i + 1) * n));
}

function asFit(id: string, kind: MotionKind, pf: PolyFit, window: readonly TrackSample[], tRef: number, scale: number, policy: MotionPolicy, validation: ValidationSummary | null, trunc: number, heldOutRmse: number): MotionFit {
  const last = window.at(-1)!;
  const draft = Object.freeze({
    id, kind, degree: pf.degree, tRef, scale, coeffs: pf.coeffs.map(c => Object.freeze([...c])), issuedAt: last.time, horizon: policy.horizonSeconds,
    support: Object.freeze({ start: window[0]!.time, end: last.time, count: window.length, span: last.time - window[0]!.time }),
    sigma: pf.sigma, invNormal: Object.freeze(pf.inv.flat()), validationLead: policy.validationLeadSeconds, validation, trunc, lag: pf.degree >= 1 ? (window.at(-1)!.time - window[0]!.time) / 2 : 0, heldOutRmse, z: policy.z, floor: policy.uncertaintyFloor,
    speed: norm(evalVel(pf.coeffs, (last.time - tRef) / scale, scale)),
  });
  // Trust horizon: where the model's own stated uncertainty reaches the largest useful size.
  let horizon = 0;
  for (let l = 0.25; l <= policy.horizonSeconds + 1e-9; l += 0.25) { if (predictMotion(draft, draft.issuedAt + l).uncertainty > policy.maxStatedUncertainty) break; horizon = l; }
  return Object.freeze({ ...draft, horizon });
}

/** A baseline that assumes nothing moves: the last observed position, no uncertainty. This is the "static plan" view. */
export function staticEstimate(id: string, samples: readonly TrackSample[]): MotionFit | null {
  const last = samples.at(-1);
  if (!last) return null;
  return Object.freeze({
    id, kind: 'static' as const, degree: 0, tRef: last.time, scale: 1, coeffs: last.position.map(v => Object.freeze([v])), issuedAt: last.time, horizon: Infinity,
    support: Object.freeze({ start: last.time, end: last.time, count: 1, span: 0 }), sigma: 0, invNormal: Object.freeze([1]), validationLead: 1, validation: null, trunc: 0, lag: 0, heldOutRmse: 0, z: 0, floor: 0, speed: 0,
  });
}

/** Fit the best-supported model for one entity, or refuse with reasons. Uses only the samples passed in (all with time <= now). */
export function fitTrack(id: string, track: readonly TrackSample[], now: number, policy: Readonly<MotionPolicy> = DEFAULT_MOTION_POLICY): FitResult {
  const reasons: string[] = [];
  const clean: TrackSample[] = [];
  for (const s of track) {
    if (!Number.isFinite(s.time) || !s.position.every(Number.isFinite)) { reasons.push('Track contains a non-finite sample.'); break; }
    if (s.time > now + 1e-9) { reasons.push('Track contains a sample from the future.'); break; }
    const prev = clean.at(-1);
    if (prev && s.time <= prev.time + 1e-9) continue; // duplicate or out-of-order timestamps are dropped, never averaged
    clean.push(s);
  }
  if (reasons.length) return { ok: false, id, reasons };
  const window = contiguousSuffixFrom(clean, policy.maxGapSeconds, policy.windowSamples, Number.NEGATIVE_INFINITY, s => s.breakBefore === true);
  const last = window.at(-1);
  if (!last) return { ok: false, id, reasons: ['No observations.'] };
  if (now - last.time > policy.maxAgeSeconds) reasons.push(`Newest observation is ${(now - last.time).toFixed(2)} s old (limit ${policy.maxAgeSeconds} s); the entity is not currently observed.`);
  const span = last.time - window[0]!.time;
  if (window.length < policy.minSamples || span < policy.minSpanSeconds) reasons.push(`Need ${policy.minSamples} contiguous samples over ${policy.minSpanSeconds} s (have ${window.length} over ${span.toFixed(2)} s).`);
  const validationNeeds = policy.minSpanSeconds + policy.validationLeadSeconds;
  if (span < validationNeeds) reasons.push(`Need ${validationNeeds} s of history to validate a forecast before publishing one (have ${span.toFixed(2)} s).`);
  if (reasons.length) return { ok: false, id, reasons };

  const tRef = last.time;
  // Rolling-origin validation. For each origin, every candidate is fitted on the samples up to that origin (limited to its own training
  // span), asked for the position `lead` seconds later, and scored against the observed sample there. Candidates share the same origins.
  const lead = policy.validationLeadSeconds;
  interface Candidate { readonly name: string; readonly kind: MotionKind; readonly degree: number; readonly span: number }
  const candidates: Candidate[] = [
    { name: 'persistence', kind: 'persistence', degree: 0, span: 0 },
    ...[...new Set(policy.linearSpans.map(sp => Math.min(sp, span)))].sort((a, b) => b - a).map((sp): Candidate => ({ name: `linear ${sp.toFixed(1)} s`, kind: 'linear', degree: 1, span: sp })),
    { name: `quadratic ${Math.min(policy.quadraticSpan, span).toFixed(1)} s`, kind: 'quadratic', degree: 2, span: Math.min(policy.quadraticSpan, span) },
  ];
  const sq = candidates.map(() => 0), expectedSq = candidates.map(() => 0);
  let origins = 0;
  for (let i = 0; i < window.length; i += policy.validationStepSamples) {
    const origin = window[i]!;
    const past = window.slice(0, i + 1);
    if (past.length < policy.minSamples || origin.time - past[0]!.time < policy.minSpanSeconds) continue;
    const target = window.find(s => Math.abs(s.time - (origin.time + lead)) <= 0.13);
    if (!target) continue;
    const row: { e: number; expected: number }[] = [];
    let complete = true;
    for (const c of candidates) {
      if (c.degree === 0) { row.push({ e: dist(origin.position, target.position), expected: 0 }); continue; }
      const train = past.filter(s => s.time >= origin.time - c.span - 1e-9);
      const sc = Math.max(origin.time - train[0]!.time, 1);
      const pf = train.length >= c.degree + 2 ? polyFit(train, c.degree, origin.time, sc) : null;
      if (!pf) { complete = false; break; }
      const u = (target.time - origin.time) / sc;
      row.push({ e: dist(evalAt(pf.coeffs, u), target.position), expected: pf.sigma ** 2 * (1 + leverage(pf.inv, u, c.degree)) });
    }
    if (!complete) continue;
    origins += 1;
    row.forEach((r, k) => { sq[k]! += r.e * r.e; expectedSq[k]! += r.expected; });
  }
  if (origins < policy.minValidationOrigins) return { ok: false, id, reasons: [`Only ${origins} validation origins are available (need ${policy.minValidationOrigins}); a forecast cannot be validated yet.`] };
  const rmseOf = candidates.map((_, k) => Math.sqrt(sq[k]! / origins));
  const persistenceRmse = rmseOf[0]!;
  // Selection: a fitted model must beat persistence; among models, the simplest one within reach of the best wins (parsimony).
  let pick = 0;
  let reason = `No fitted model beats persistence in validation (best ${Math.min(...rmseOf.slice(1)).toFixed(3)} vs persistence ${persistenceRmse.toFixed(3)} at ${lead} s); motion is not learnable from this window.`;
  const bestModel = Math.min(...rmseOf.slice(1));
  if (bestModel <= persistenceRmse * policy.persistenceGain) {
    pick = 1 + rmseOf.slice(1).findIndex(r => r <= bestModel / policy.quadraticGain);
    reason = `${candidates[pick]!.name} is the simplest candidate within ${Math.round((1 / policy.quadraticGain - 1) * 100)}% of the best in validation (RMSE ${rmseOf[pick]!.toFixed(3)} vs persistence ${persistenceRmse.toFixed(3)} at ${lead} s).`;
  }
  // Final fits on each surviving candidate's full training window, with the Taylor-remainder bound of what that model leaves out.
  interface Final { readonly index: number; readonly pf: PolyFit; readonly trained: readonly TrackSample[]; readonly scale: number; readonly trunc: number; readonly stated: number }
  const finals = new Map<number, Final>();
  const finalFor = (index: number): Final | null => {
    const known = finals.get(index);
    if (known) return known;
    const c = candidates[index]!;
    const trained = c.degree === 0 ? window.slice(-1) : window.filter(s => s.time >= tRef - c.span - 1e-9);
    const scale = Math.max(tRef - (c.degree === 0 ? window[0]!.time : trained[0]!.time), 1);
    const pf = c.degree === 0 ? lastObservation(window) : polyFit(trained, c.degree, tRef, scale);
    if (!pf) return null;
    const higherSamples = c.degree === 0 ? window : trained;
    const trunc = nextOrder(higherSamples, c.degree, tRef, scale, policy.z);
    const lstar = policy.planningLeadSeconds;
    const noise = policy.z * pf.sigma * Math.sqrt(leverage(pf.inv, (tRef + lstar - tRef) / scale, c.degree));
    const f: Final = { index, pf, trained: c.degree === 0 ? window : trained, scale, trunc, stated: noise + trunc * (lstar + (c.degree >= 1 ? (trained.at(-1)!.time - trained[0]!.time) / 2 : 0)) ** (c.degree + 1) };
    finals.set(index, f);
    return f;
  };
  if (pick > 0) {
    // Among models that held-out validation does not contradict, prefer the one whose stated uncertainty at the planning lead is smallest.
    // A short validation lead cannot see curvature that matters at a long lead; the remainder bound can.
    const survivors = candidates.map((_, k) => k).filter(k => k > 0 && rmseOf[k]! <= bestModel * policy.survivorTolerance);
    let bestStated = Infinity;
    for (const k of survivors) { const f = finalFor(k); if (f && f.stated < bestStated - 1e-9) { bestStated = f.stated; pick = k; } }
    reason = `${candidates[pick]!.name} chosen: held-out RMSE ${rmseOf[pick]!.toFixed(3)} (persistence ${persistenceRmse.toFixed(3)}) at ${lead} s, and the smallest stated uncertainty (${bestStated.toFixed(2)} u) at the ${policy.planningLeadSeconds} s planning lead among ${survivors.length} model${survivors.length === 1 ? '' : 's'} not contradicted by validation.`;
  }
  const chosen = candidates[pick]!;
  const excess = pick === 0 ? persistenceRmse : Math.sqrt(Math.max(0, rmseOf[pick]! ** 2 - expectedSq[pick]! / origins));
  const rmse = { persistence: persistenceRmse, linear: Math.min(...rmseOf.filter((_, k) => candidates[k]!.kind === 'linear')), quadratic: rmseOf[candidates.length - 1]! };
  const validation: ValidationSummary = Object.freeze({
    leadSeconds: lead, origins, rmse: Object.freeze(rmse), excess, selected: chosen.kind, reason, spanSeconds: chosen.span,
    candidates: Object.freeze(candidates.map((c, k) => Object.freeze({ name: c.name, kind: c.kind, spanSeconds: c.span, rmse: rmseOf[k]! }))),
  });
  const fin = finalFor(pick);
  if (!fin) return { ok: false, id, reasons: ['The regression was numerically singular.'] };
  return { ok: true, fit: asFit(id, chosen.kind, fin.pf, fin.trained, tRef, fin.scale, policy, validation, fin.trunc, rmseOf[pick]!) };
}

/** Taylor-remainder coefficient of a degree-k model: the (k+1)-th monomial coefficient of a degree-(k+1) fit of the same window, plus z standard errors,
 * per axis, combined as a norm and converted to units / s^(k+1). It bounds what the model ignores, from the data itself. */
function nextOrder(samples: readonly TrackSample[], degree: number, tRef: number, scale: number, z: number): number {
  const pf = polyFit(samples, degree + 1, tRef, scale);
  if (!pf) return Infinity;
  const k = degree + 1;
  const sePerAxis = (pf.sigma / Math.sqrt(3)) * Math.sqrt(Math.max(0, pf.inv[k]![k]!));
  const norm = Math.hypot(...[0, 1, 2].map(a => Math.abs(pf.coeffs[a]![k]!) + z * sePerAxis));
  return norm / scale ** k;
}

/** Persistence as a fitted model: the last observation, noise scale from recent scatter about their mean. */
function lastObservation(window: readonly TrackSample[]): PolyFit {
  const tail = window.slice(-4);
  const mean = [0, 1, 2].map(a => tail.reduce((s, x) => s + x.position[a]!, 0) / tail.length);
  const sigma = Math.sqrt(tail.reduce((s, x) => s + dist(x.position, mean) ** 2, 0) / Math.max(1, tail.length - 1));
  return { coeffs: window.at(-1)!.position.map(v => [v]), inv: [[1]], sigma, degree: 0 };
}
