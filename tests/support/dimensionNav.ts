import type { AckCode, NavOutcome, NavReport, RouteAck, RouteCommand, RouteInterception, Vec3Tuple } from '../../src/shared/liveLink';
import { parseRouteCommand } from '../../src/shared/liveLink';

/** Route intake and progress tracking inside the Dimension. Pure: the caller supplies positions and times.
 *
 * ATLAS proposes; the Dimension decides. A route is accepted only if it is well formed, and its revision is newer than every revision
 * already accepted from the same ATLAS page. Progress (which waypoint is next, whether the goal has been reached or missed) is computed
 * here from Baymax's true position and, where the goal is a real object, from that object's TRUE position, never from ATLAS's forecast.
 * The goal is never moved or adjusted to agree with a prediction: the prediction is scored against it. */

export interface GoalTruth { readonly position: Vec3Tuple; readonly captureRadius: number }
/** Resolves a goal id to its true position in the Dimension (islands, folds, movers, scene objects), or null if unknown. */
export type GoalResolver = (goalId: string, simTime: number) => GoalTruth | null;

export type NavPhase = 'idle' | 'active' | 'arrived' | 'missed' | 'cancelled';

/** Outcome rules for a route to a MOVING goal (decided here from true positions; a timer alone never produces success).
 *  - success: at any moment of the route Baymax is within the goal's capture radius of its TRUE position. truth.ts gives
 *    `mover.radius + 4` m: the object's own bounding radius plus a 4 m docking envelope, a few body lengths of the explorer, which is
 *    the scale at which a hand-off could physically happen in a world measured in metres.
 *  - miss by time: the planned meeting time passed more than MISS_GRACE_SECONDS ago without success. The grace covers the planner's
 *    stated uncertainty (a few seconds of lead) and Baymax's acceleration limits, so a slightly late arrival can still succeed.
 *  - miss by distance: at/after the planned time the closest approach is still outside the capture radius and the range has risen by
 *    more than MISS_DIVERGENCE_METRES above that closest approach, i.e. Baymax has passed the object and is now opening the range. */
export const MISS_GRACE_SECONDS = 6;
export const MISS_DIVERGENCE_METRES = 3;

export interface Closest { readonly distance: number; readonly simTime: number }

export interface ActiveRoute {
  readonly route: RouteCommand;
  readonly receivedSimTime: number;
  readonly phase: NavPhase;
  readonly activeIndex: number;
  readonly arrivedAtSimTime: number | null;
  /** Waypoints that were reached, with the simulation time of each. */
  readonly reached: readonly { readonly index: number; readonly simTime: number }[];
  /** The revision this route replaced (to show a "route updated" cue), if an earlier route was still active. */
  readonly replacedRevision: number | null;
  readonly replacedAtSimTime: number | null;
  /** Smallest distance so far to the goal's TRUE position (to the final waypoint for a goal with no truth, such as an island). Reset by every new revision. */
  readonly closest: Closest | null;
  /** Set once the route ended with arrival or a miss. */
  readonly outcome: NavOutcome | null;
}

export interface Offer { readonly ack: Omit<RouteAck, 'type' | 'session' | 'seq'>; readonly accepted: boolean }

const ack = (route: { routeId: string; revision: number }, status: RouteAck['status'], code: AckCode, detail: string, simTime: number): Offer['ack'] => ({ routeId: route.routeId, revision: route.revision, status, code, detail, simTime });
const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The forecast position of the goal at `simTime`: linear interpolation along `targetPath`, clamped at its ends; the planned meeting position without a path. */
export function plannedTargetAt(i: RouteInterception, simTime: number): Vec3Tuple {
  const path = i.targetPath;
  if (!path || path.length === 0) return i.position;
  if (simTime <= path[0]!.simTime) return path[0]!.position;
  const last = path[path.length - 1]!;
  if (simTime >= last.simTime) return last.position;
  for (let k = 1; k < path.length; k += 1) {
    const b = path[k]!;
    if (simTime <= b.simTime) {
      const a = path[k - 1]!, span = b.simTime - a.simTime, f = span > 1e-9 ? (simTime - a.simTime) / span : 1;
      return [a.position[0] + (b.position[0] - a.position[0]) * f, a.position[1] + (b.position[1] - a.position[1]) * f, a.position[2] + (b.position[2] - a.position[2]) * f];
    }
  }
  return last.position;
}

export class RouteManager {
  private active: ActiveRoute | null = null;
  /** Highest accepted revision per ATLAS page session: a reload of ATLAS is a new session and starts again. */
  private revisions = new Map<string, number>();

  current(): ActiveRoute | null { return this.active; }

  /** Drop everything (a different Dimension session, or a reset). */
  clear(): void { this.active = null; this.revisions.clear(); }

  offer(raw: unknown, simTime: number): Offer {
    const route = parseRouteCommand(raw);
    if (!route) {
      const r = raw as { routeId?: unknown; revision?: unknown } | null;
      return { accepted: false, ack: ack({ routeId: typeof r?.routeId === 'string' ? r.routeId.slice(0, 80) : 'unknown', revision: Number.isInteger(r?.revision) ? (r!.revision as number) : -1 }, 'rejected', 'invalid', 'The route was malformed and was ignored.', simTime) };
    }
    const known = this.revisions.get(route.atlasSession) ?? -1;
    if (route.revision <= known) return { accepted: false, ack: ack(route, 'rejected', 'stale-revision', `Revision ${route.revision} is not newer than the accepted revision ${known}.`, simTime) };
    this.revisions.set(route.atlasSession, route.revision);
    const previous = this.active;
    const supersedes = previous && previous.phase === 'active' ? previous : null;
    this.active = {
      route, receivedSimTime: simTime, phase: 'active', activeIndex: 0, arrivedAtSimTime: null, reached: [],
      replacedRevision: supersedes ? supersedes.route.revision : null,
      replacedAtSimTime: supersedes ? simTime : null,
      closest: null, outcome: null,
    };
    return { accepted: true, ack: ack(route, 'accepted', 'ok', 'Route accepted; guidance is active.', simTime) };
  }

  cancel(routeId: string, revision: number, simTime: number): Offer {
    const a = this.active;
    if (!a || a.route.routeId !== routeId) return { accepted: false, ack: ack({ routeId, revision }, 'rejected', 'unknown-route', 'No such active route.', simTime) };
    if (revision < a.route.revision) return { accepted: false, ack: ack({ routeId, revision }, 'rejected', 'stale-revision', 'Cancellation refers to an older revision.', simTime) };
    this.active = { ...a, phase: 'cancelled' };
    return { accepted: true, ack: ack(a.route, 'cancelled', 'cancelled', 'Route cancelled by ATLAS.', simTime) };
  }

  /** Cancelled locally (the player dismissed guidance). */
  dismiss(): void { if (this.active) this.active = { ...this.active, phase: 'cancelled' }; }

  private finish(a: ActiveRoute, phase: 'arrived' | 'missed', index: number, reached: ActiveRoute['reached'], simTime: number, closest: Closest, truth: GoalTruth | null): void {
    const wps = a.route.waypoints, last = wps[wps.length - 1]!;
    const goalPosition = truth?.position ?? last.position;
    const i = a.route.interception;
    const plannedNow = i ? plannedTargetAt(i, simTime) : null;
    const outcome: NavOutcome = {
      success: phase === 'arrived', simTime, closestApproach: closest.distance, captureRadius: truth?.captureRadius ?? last.arrivalRadius,
      plannedSimTime: i ? i.simTime : null, plannedPosition: i ? i.position : null, goalPosition,
      plannedError: plannedNow ? dist(goalPosition, plannedNow) : null,
    };
    this.active = { ...a, activeIndex: Math.min(index, wps.length - 1), phase, arrivedAtSimTime: phase === 'arrived' ? simTime : null, reached, closest, outcome };
  }

  /** Advance progress from Baymax's position. Returns true when anything changed. */
  update(position: Vec3Tuple, simTime: number, resolve?: GoalResolver): boolean {
    const a = this.active;
    if (!a || a.phase !== 'active') return false;
    const wps = a.route.waypoints;
    const truth = resolve?.(a.route.goal.id, simTime) ?? null;
    const d = dist(position, truth?.position ?? wps[wps.length - 1]!.position);
    const prev = a.closest;
    const closest: Closest = prev && prev.distance <= d ? prev : { distance: d, simTime };
    const moving = a.route.goal.motion === 'moving' && truth !== null;
    let index = a.activeIndex;
    const reached = [...a.reached];
    // A real moving object is met wherever it is: the encounter counts at any moment, whatever waypoint Baymax is on.
    if (moving && d <= truth.captureRadius) {
      for (let k = index; k < wps.length; k += 1) reached.push({ index: k, simTime });
      this.finish(a, 'arrived', wps.length - 1, reached, simTime, closest, truth);
      return true;
    }
    let advanced = false;
    // Several waypoints can be passed in one step (fast flight); only the final one decides the goal.
    while (index < wps.length) {
      const wp = wps[index]!;
      const last = index === wps.length - 1;
      let within = dist(position, wp.position) <= wp.arrivalRadius;
      // For a real object the true position decides: the planned meeting point is only an estimate of where it will be.
      if (last && truth) within = d <= truth.captureRadius;
      if (!within) break;
      reached.push({ index, simTime });
      index += 1;
      advanced = true;
    }
    if (index >= wps.length) { this.finish(a, 'arrived', wps.length - 1, reached, simTime, closest, truth); return true; }
    const planned = a.route.interception;
    if (moving && planned && simTime >= planned.simTime) {
      const late = simTime > planned.simTime + MISS_GRACE_SECONDS;
      const opening = closest.distance > truth.captureRadius && d > closest.distance + MISS_DIVERGENCE_METRES;
      if (late || opening) { this.finish(a, 'missed', index, reached, simTime, closest, truth); return true; }
    }
    if (advanced || closest !== prev) this.active = { ...a, activeIndex: index, reached, closest };
    return advanced;
  }

  report(position: Vec3Tuple, simTime: number, resolve?: GoalResolver): NavReport | null {
    const a = this.active;
    if (!a) return null;
    const wp = a.route.waypoints[Math.min(a.activeIndex, a.route.waypoints.length - 1)]!;
    const truth = resolve?.(a.route.goal.id, simTime) ?? null;
    const goalPos = truth?.position ?? a.route.waypoints.at(-1)!.position;
    return {
      routeId: a.route.routeId, revision: a.route.revision, status: a.phase === 'idle' ? 'active' : a.phase,
      activeIndex: a.activeIndex, waypointCount: a.route.waypoints.length, distanceToWaypoint: dist(position, wp.position), distanceToGoal: dist(position, goalPos), arrivedAtSimTime: a.arrivedAtSimTime,
      ...(a.closest && truth ? { closestApproach: a.closest.distance } : {}), ...(a.outcome ? { outcome: a.outcome } : {}),
    };
  }
}
