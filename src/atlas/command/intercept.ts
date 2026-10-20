import { predictMotion } from '../challenge/motionModel';
import { planRoute } from '../challenge/timePlanner';
import type { RoutePlan } from '../challenge/timePlanner';
import type { Obstacle } from '../challenge/clearance';
import type { ChallengeParams } from '../challenge/types';
import type { Vec3 } from './world';

/** Rendezvous: find a time T and place P so that Baymax, flying at `speed`, reaches the target where the target WILL be at T.
 *
 *     |P(T) − B₀| / v  =  T − t₀          (P(T) = where the target is estimated to be at T, plus a fixed approach offset)
 *
 * Step 1 solves this exactly for the unobstructed straight flight (first sign change of f(T) = |P(T) − B₀|/v − (T − t₀), bisected).
 * Step 2 hands the meeting point to the time-aware route planner (which avoids islands) and repeats with the planner's own flight time
 * until the meeting time stops moving. All loops are bounded; every failure has a stated reason. Nothing here sees the world's law: the
 * target is only an estimate (`TargetPath`) built from past observations. */

export interface TargetSample { readonly position: Vec3; readonly uncertainty: number; readonly supported: boolean }
export interface TargetPath {
  readonly kind: 'static' | 'moving';
  /** Estimated speed of a moving target (m/s), used only to tell a hopeless chase from a hard one. */
  readonly speedHint?: number;
  /** Estimated position at simulation time t (static targets ignore t). */
  at(t: number): TargetSample;
}

export type InterceptStatus = 'ok' | 'unreachable' | 'no-route';
export interface InterceptInput {
  readonly now: number;
  readonly start: Vec3;
  readonly speed: number;
  readonly target: TargetPath;
  /** Constant world offset added to the target's position (a hover point above an island, a stand-off from an object). */
  readonly offset?: Vec3;
  readonly obstacles: readonly Obstacle[];
  readonly params: ChallengeParams;
  /** Longest flight considered (s). */
  readonly maxLead?: number;
  /** ATLAS never aims further ahead than this (s): a forecast many seconds out is worse than the estimate it replaces. Default 6 s. */
  readonly leadCap?: number;
  readonly maxIterations?: number;
}

export interface InterceptResult {
  readonly status: InterceptStatus;
  readonly meetingTime: number;
  readonly meetingPosition: Vec3;
  readonly travelTime: number;
  readonly uncertainty: number;
  /** True when the meeting time lies inside the target model's trust horizon (always true for static targets). */
  readonly supported: boolean;
  readonly iterations: number;
  /** True when the exact rendezvous lies further ahead than `leadCap`, so ATLAS aims at the target's position `leadCap` seconds from now instead and refines as Baymax closes in. */
  readonly leadLimited: boolean;
  /** The straight-line solution, before obstacle avoidance. */
  readonly straight: { readonly time: number; readonly position: Vec3; readonly travelTime: number } | null;
  readonly plan: RoutePlan | null;
  /** Difference between the planner's arrival time and the target's meeting time at convergence. */
  readonly timingResidual: number;
  readonly notes: readonly string[];
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const ZERO: Vec3 = [0, 0, 0];

/** Exact straight-flight rendezvous, or null if the target outruns Baymax within `maxLead`. */
export function solveStraight(now: number, start: Vec3, speed: number, point: (t: number) => Vec3, maxLead: number): { time: number; position: Vec3; travelTime: number } | null {
  const f = (t: number) => dist(point(t), start) / speed - (t - now);
  if (f(now) <= 0) return { time: now, position: point(now), travelTime: 0 };
  const step = 0.25;
  let lo = now, hi = now;
  for (let t = now + step; t <= now + maxLead + 1e-9; t += step) {
    if (f(t) <= 0) { hi = t; break; }
    lo = t;
  }
  if (hi === now) return null;
  for (let i = 0; i < 48; i += 1) { const mid = 0.5 * (lo + hi); if (f(mid) > 0) lo = mid; else hi = mid; }
  const time = hi;
  return { time, position: point(time), travelTime: time - now };
}

export function solveIntercept(input: InterceptInput): InterceptResult {
  const { now, start, speed, target, obstacles, params } = input;
  const offset = input.offset ?? ZERO;
  const maxLead = input.maxLead ?? 60;
  const maxIter = input.maxIterations ?? 8;
  const leadCap = input.leadCap ?? 6;
  const notes: string[] = [];
  const point = (t: number) => plus(target.at(t).position, offset);
  const params2: ChallengeParams = { ...params, speed };

  const straight = target.kind === 'static'
    ? { time: now + dist(point(now), start) / speed, position: point(now), travelTime: dist(point(now), start) / speed }
    : solveStraight(now, start, speed, point, maxLead);
  // The exact rendezvous does not exist when the (extrapolated, straight) target outruns Baymax. A curving target can still be caught by pursuit,
  // so unless Baymax is clearly too slow (under 80 % of the target's speed) ATLAS pursues the target's position `leadCap` seconds ahead.
  const pursuit = !straight && target.kind === 'moving' && speed >= 0.8 * (target.speedHint ?? 0);
  if (!straight && !pursuit) {
    const here = target.at(now).position;
    return {
      status: 'unreachable', meetingTime: now, meetingPosition: here, travelTime: 0, uncertainty: target.at(now).uncertainty, supported: target.at(now).supported, iterations: 0, leadLimited: false, straight: null, plan: null, timingResidual: 0,
      notes: [`At ${speed.toFixed(1)} m/s Baymax cannot reach the estimated target within ${maxLead} s; it moves away faster than that.`],
    };
  }

  // Predictive pursuit with a bounded lead: beyond `leadCap` seconds the exact rendezvous is not trusted, so aim at where the target will be
  // `leadCap` seconds from now. As Baymax closes in the exact rendezvous falls inside the cap and the plan becomes a true interception.
  const exactTime = straight ? straight.time : now + maxLead;
  const leadLimited = target.kind === 'moving' && exactTime - now > leadCap;
  let T = leadLimited ? now + leadCap : exactTime;
  let planT = T;
  let plan: RoutePlan | null = null;
  let iterations = 0;
  let residual = 0;
  for (; iterations < maxIter; iterations += 1) {
    planT = T;
    const goal = point(T);
    // An obstacle whose clearance bubble would contain the meeting point (the target passes close to an island) is shrunk just enough for the
    // meeting point to lie outside it; every other bubble keeps its full size.
    const shrunk: string[] = [];
    const local = obstacles.map(o => {
      const at = predictMotion(o.fit, T).position;
      const room = Math.hypot(goal[0] - at[0], goal[1] - at[1], goal[2] - at[2]) - (params.baymaxRadius + params.margin) - 1.0;
      const bound = Math.max(1, Math.min(o.bound, room));
      if (bound < o.bound - 1e-6) shrunk.push(`${o.id} (${bound.toFixed(1)} of ${o.bound.toFixed(1)} m)`);
      return bound < o.bound ? { ...o, bound } : o;
    });
    if (shrunk.length) notes.push(`Clearance was reduced at the meeting point for ${shrunk.join(', ')}: the target itself passes close to it.`);
    const result = planRoute({ now, start, goal, obstacles: local, params: params2, fastDirect: true, budgetMs: 150, maxLegs: 2 });
    plan = result.chosen;
    if (!plan) { notes.push(...result.notes); return { status: 'no-route', meetingTime: T, meetingPosition: goal, travelTime: T - now, uncertainty: target.at(T).uncertainty, supported: target.at(T).supported, iterations: iterations + 1, leadLimited, straight, plan: null, timingResidual: 0, notes }; }
    const arrival = now + plan.duration;
    residual = arrival - T;
    if (target.kind === 'static' || leadLimited || Math.abs(residual) < 0.3) { iterations += 1; break; }
    // Relax towards the planner's arrival time (a detour makes the flight longer, so the target is met later and further along its path).
    T = T + 0.8 * residual;
  }
  if (leadLimited && straight) notes.push(`The exact meeting is ${(straight.time - now).toFixed(0)} s ahead, beyond the ${leadCap.toFixed(0)} s ATLAS trusts; it aims at the target's position ${leadCap.toFixed(0)} s ahead and refines as Baymax closes in.`);
  if (leadLimited && !straight) notes.push(`At ${speed.toFixed(0)} m/s Baymax cannot be sure of catching a target moving at about ${(target.speedHint ?? 0).toFixed(1)} m/s; it pursues the position the target is expected to reach ${leadCap.toFixed(0)} s ahead.`);
  if (plan && !leadLimited && Math.abs(residual) >= 0.3 && target.kind === 'moving') notes.push(`The meeting time had not settled after ${iterations} iterations (residual ${residual.toFixed(2)} s); treat the meeting point as approximate.`);
  // The reported meeting is the one the returned plan was built for.
  T = target.kind === 'static' && plan ? now + plan.duration : planT;
  const meeting = target.at(T);
  const final = point(T);
  if (!meeting.supported) notes.push('The meeting lies beyond the target model\'s trusted horizon, so its position is a widening estimate, not a validated forecast.');
  return {
    status: 'ok', meetingTime: T, meetingPosition: final, travelTime: plan ? plan.duration : T - now, uncertainty: meeting.uncertainty, supported: meeting.supported, iterations, leadLimited, straight, plan, timingResidual: residual, notes: [...new Set(notes)],
  };
}
