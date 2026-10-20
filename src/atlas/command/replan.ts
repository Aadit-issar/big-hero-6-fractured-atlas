import type { PlanOutcome } from './route';
import type { Vec3 } from './world';

/** When is a better route worth replacing the active one?
 *
 * ATLAS recomputes the plan on every new frame cheaply, but it only RE-ISSUES a route to the Dimension when there is a material reason.
 * Hysteresis: tiny numerical changes in the meeting point never replace a route that is still adequately supported, and a replacement is
 * never issued more often than `minIntervalSim`. Every decision carries a reason derived from the measured difference, which becomes the
 * explanation shown to the user and sent with the route. */

export interface ActivePlan {
  readonly routeId: string;
  readonly revision: number;
  readonly targetId: string;
  readonly issuedAt: number;
  readonly speed: number;
  readonly meetingPosition: Vec3 | null;
  readonly meetingTime: number | null;
  readonly goalPosition: Vec3;
  readonly waypoints: readonly Vec3[];
  readonly mode: PlanOutcome['mode'];
}

export interface ReplanPolicy {
  readonly minIntervalSim: number;
  /** The meeting point must move by at least this much (m)... */
  readonly meetingShift: number;
  /** ...or this fraction of the remaining distance, whichever is larger. */
  readonly meetingShiftFraction: number;
  readonly speedChange: number;
  /** Baymax farther than this from the active route's polyline (m): the route no longer describes where Baymax is. */
  readonly deviation: number;
  /** A moving-target route older than this (s) is refreshed even if nothing else changed. */
  readonly maxAge: number;
}
export const DEFAULT_REPLAN_POLICY: Readonly<ReplanPolicy> = Object.freeze({ minIntervalSim: 1.5, meetingShift: 3.5, meetingShiftFraction: 0.12, speedChange: 0.5, deviation: 12, maxAge: 25 });

export type ReplanTrigger = 'new-target' | 'mode-changed' | 'speed-changed' | 'meeting-shifted' | 'off-route' | 'stale-route' | 'unsupported' | 'none';
export interface ReplanDecision { readonly replan: boolean; readonly trigger: ReplanTrigger; readonly reason: string }

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function distanceToPolyline(p: Vec3, points: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!, b = points[i + 1]!;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
    best = Math.min(best, dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  }
  return points.length === 1 ? dist(p, points[0]!) : best;
}

export function decideReplan(active: ActivePlan | null, fresh: PlanOutcome, baymax: Vec3, now: number, targetLabel: string, policy: Readonly<ReplanPolicy> = DEFAULT_REPLAN_POLICY): ReplanDecision {
  if (fresh.status !== 'ready') return { replan: false, trigger: 'none', reason: '' };
  if (!active || active.targetId !== fresh.targetId) return { replan: true, trigger: 'new-target', reason: `New destination: ${targetLabel}.` };
  if (now - active.issuedAt < policy.minIntervalSim) return { replan: false, trigger: 'none', reason: '' };
  if (active.mode !== fresh.mode) return { replan: true, trigger: 'mode-changed', reason: active.mode === 'intercept' ? `${targetLabel} can no longer be forecast from its observations, so the route now heads for where it was last seen.` : `ATLAS now has enough observations of ${targetLabel} to forecast it, so the route changed from ${active.mode} to ${fresh.mode}.` };
  if (Math.abs(active.speed - fresh.speed) >= policy.speedChange) return { replan: true, trigger: 'speed-changed', reason: `Baymax's planning speed changed from ${active.speed.toFixed(0)} to ${fresh.speed.toFixed(0)} m/s, so the travel time and the meeting point changed.` };
  if (fresh.mode === 'intercept' && active.meetingPosition && fresh.meetingPosition) {
    const shift = dist(active.meetingPosition, fresh.meetingPosition);
    const remaining = dist(baymax, active.meetingPosition);
    const threshold = Math.max(policy.meetingShift, policy.meetingShiftFraction * remaining);
    if (shift >= threshold) return { replan: true, trigger: 'meeting-shifted', reason: `New ${targetLabel} observations moved the predicted meeting point ${shift.toFixed(1)} m. Interception recalculated.` };
  } else if (fresh.mode !== 'intercept' && fresh.meetingPosition) {
    const shift = dist(active.goalPosition, fresh.meetingPosition);
    // A static or slowly drifting goal (island, fold, wreckage) is re-aimed only for a clearly larger shift, so a drifting island does not re-issue every few seconds.
    if (shift >= Math.max(policy.meetingShift * 2.2, policy.meetingShiftFraction * 1.6 * dist(baymax, active.goalPosition))) return { replan: true, trigger: 'meeting-shifted', reason: `${targetLabel} was observed ${shift.toFixed(1)} m from where the route ended. Route updated.` };
  }
  const lateral = distanceToPolyline(baymax, active.waypoints.length > 1 ? active.waypoints : [active.goalPosition, active.goalPosition]);
  if (active.waypoints.length > 1 && lateral > policy.deviation) return { replan: true, trigger: 'off-route', reason: `Baymax is ${lateral.toFixed(0)} m from the planned route, so a new route was calculated from the current position.` };
  if (fresh.mode === 'intercept' && now - active.issuedAt > policy.maxAge) return { replan: true, trigger: 'stale-route', reason: `The route was ${(now - active.issuedAt).toFixed(0)} s old; it was refreshed with the latest observations.` };
  return { replan: false, trigger: 'none', reason: '' };
}
