import { predictMotion } from './motionModel';
import type { MotionFit } from './motionModel';
import type { ChallengeParams, Vec3 } from './types';

/** Modelled clearance of a straight leg flown at constant speed against obstacles with estimated motion.
 *
 *   distance(Baymax(t), obstacle_estimate(t))  >=  baymaxRadius + obstacleBound + margin + uncertainty(t - t_issue)
 *
 * The leg is split into sub-intervals of at most `step` seconds. In each, the obstacle is linearised about the interval start (a quadratic
 * model's remaining curvature, at most 1/2 |a| h^2, is subtracted as a bound) so the relative motion is a straight line and its closest
 * approach is exact. The required clearance uses the uncertainty at the END of the interval (it only grows), so the test never misses a
 * conflict BETWEEN sample times; it is conservative by at most the growth of the uncertainty over one sub-interval.
 *
 * This is a statement about the model and its stated approximations (spherical bound, uncertainty law). It is not a proof of physical safety. */

export interface Obstacle { readonly id: string; readonly fit: MotionFit; readonly bound: number }
export interface Leg { readonly from: Vec3; readonly to: Vec3; readonly t0: number; readonly speed: number }
export interface ObstacleClearance {
  readonly id: string;
  /** Smallest (lower-bound distance - required clearance) over the part of the leg inside the model's trust horizon. Negative means a modelled conflict. */
  readonly minMargin: number;
  /** The same quantity over the part BEYOND the trust horizon, against the widening envelope. Informational: it is never a hard constraint. */
  readonly unsupportedMargin: number;
  /** Lower bound of the centre distance at that moment. */
  readonly clearanceAtMin: number;
  readonly requiredAtMin: number;
  readonly timeAtMin: number;
  /** Predicted obstacle position at that moment (for display). */
  readonly obstacleAtMin: Vec3;
  readonly baymaxAtMin: Vec3;
}
export interface ClearanceReport {
  /** True when no sub-interval inside a trust horizon violates the constraint. */
  readonly feasible: boolean;
  /** True when the widening envelope beyond a horizon is also respected (a soft preference, not a requirement). */
  readonly envelopeClear: boolean;
  readonly minMargin: number;
  readonly worst: ObstacleClearance | null;
  readonly perObstacle: readonly ObstacleClearance[];
  /** Seconds of the leg whose obstacle predictions lie within each model's trusted horizon / beyond it. */
  readonly supportedSeconds: number;
  readonly unsupportedSeconds: number;
  readonly duration: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const legLength = (leg: Pick<Leg, 'from' | 'to'>): number => len(sub(leg.to, leg.from));
export const legDuration = (leg: Leg): number => legLength(leg) / leg.speed;
export const baymaxAt = (leg: Leg, t: number): Vec3 => { const d = legDuration(leg); return d === 0 ? leg.from : lerp(leg.from, leg.to, Math.min(1, Math.max(0, (t - leg.t0) / d))); };

/** Magnitude of the (constant) acceleration of a quadratic model, 0 otherwise. */
function accelerationOf(fit: MotionFit): number {
  if (fit.degree < 2) return 0;
  return Math.hypot(...[0, 1, 2].map(a => (2 * fit.coeffs[a]![2]!) / (fit.scale * fit.scale)) as [number, number, number]);
}

export function evaluateLeg(leg: Leg, obstacles: readonly Obstacle[], params: ChallengeParams, step = 0.5): ClearanceReport {
  const duration = legDuration(leg);
  const length = legLength(leg);
  const dir: Vec3 = length === 0 ? [0, 0, 0] : [(leg.to[0] - leg.from[0]) / length, (leg.to[1] - leg.from[1]) / length, (leg.to[2] - leg.from[2]) / length];
  const w: Vec3 = [dir[0] * leg.speed, dir[1] * leg.speed, dir[2] * leg.speed];
  const n = Math.max(1, Math.ceil(duration / step));
  const h = duration / n;
  const base = params.baymaxRadius + params.margin;
  const per: ObstacleClearance[] = [];
  let supported = duration, unsupported = 0;
  for (const o of obstacles) {
    const a = accelerationOf(o.fit);
    let best: ObstacleClearance | null = null;
    let soft = Infinity;
    let outside = 0;
    for (let i = 0; i < n; i += 1) {
      const ta = leg.t0 + i * h, tb = ta + h;
      const pa = predictMotion(o.fit, ta);
      const r0 = sub(baymaxAt(leg, ta), pa.position);
      const rho = sub(w, pa.velocity);
      const rr = rho[0] * rho[0] + rho[1] * rho[1] + rho[2] * rho[2];
      const s = rr < 1e-12 ? 0 : Math.min(h, Math.max(0, -(r0[0] * rho[0] + r0[1] * rho[1] + r0[2] * rho[2]) / rr));
      const closest = len([r0[0] + rho[0] * s, r0[1] + rho[1] * s, r0[2] + rho[2] * s]) - 0.5 * a * h * h;
      const required = base + o.bound + predictMotion(o.fit, tb).uncertainty;
      const margin = closest - required;
      if (ta - o.fit.issuedAt >= o.fit.horizon - 1e-9) { outside += h; soft = Math.min(soft, margin); continue; }
      if (best === null || margin < best.minMargin) {
        const t = ta + s;
        best = { id: o.id, minMargin: margin, unsupportedMargin: Infinity, clearanceAtMin: closest, requiredAtMin: required, timeAtMin: t, obstacleAtMin: predictMotion(o.fit, t).position, baymaxAtMin: baymaxAt(leg, t) };
      }
    }
    if (!best) {
      // The whole leg lies beyond this obstacle's horizon: nothing is claimed about it.
      best = { id: o.id, minMargin: Infinity, unsupportedMargin: soft, clearanceAtMin: Infinity, requiredAtMin: 0, timeAtMin: leg.t0, obstacleAtMin: predictMotion(o.fit, leg.t0).position, baymaxAtMin: leg.from };
    } else best = { ...best, unsupportedMargin: soft };
    per.push(best);
    unsupported = Math.max(unsupported, outside);
  }
  supported = Math.max(0, duration - unsupported);
  const worst = per.reduce<ObstacleClearance | null>((m, c) => (m === null || c.minMargin < m.minMargin ? c : m), null);
  const minMargin = worst ? worst.minMargin : Infinity;
  const envelope = per.reduce((m, c) => Math.min(m, c.unsupportedMargin), Infinity);
  return Object.freeze({ feasible: minMargin >= 0, envelopeClear: envelope >= 0, minMargin, worst, perObstacle: Object.freeze(per), supportedSeconds: supported, unsupportedSeconds: unsupported, duration });
}
