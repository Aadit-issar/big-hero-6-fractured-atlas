import type { RouteMode } from '../../shared/liveLink';
import type { TrackSample } from '../challenge/types';
import { positionAt } from './forecast';
import type { Estimate } from './forecast';
import type { PlanOutcome } from './route';
import type { Entity, Vec3 } from './world';

/** The single description of "where things will be", shared by Predictive Analysis, Route Planning, the 3D scene and the route sent to the Dimension.
 *
 * A ForecastView and an Encounter are both derived from the SAME estimate (the fitted motion model in `estimates`), never from separate estimators, and
 * both carry a `version` that names the evidence they were built from (entity, newest observation, model). If two places show a predicted position for the
 * same version and time, they show the same point, because they call the same function. Nothing here reads ground truth. */

export interface TimedPoint { readonly t: number; readonly position: Vec3; readonly uncertainty: number }

export interface ForecastView {
  readonly entityId: string;
  /** Identity of the evidence: entity, time of the newest observation, model kind. Changes only when the forecast is genuinely re-made. */
  readonly version: string;
  readonly now: number;
  readonly model: string;
  readonly supported: boolean;
  /** Observed history, oldest first (the real timestamped observations, never extrapolated). */
  readonly trail: readonly TimedPoint[];
  /** The latest observed position. */
  readonly current: TimedPoint;
  /** Forecast samples from `now` to `until`, ascending (first sample is the model's estimate of the present). */
  readonly future: readonly TimedPoint[];
  /** Forecast at an arbitrary time (inside the model's usable range). */
  at(t: number): TimedPoint;
  /** The longest lead time for which the model's own stated uncertainty is within its trust limit. */
  readonly trustedUntil: number;
}

export interface RoutePoint { readonly t: number; readonly position: Vec3 }

export interface Encounter {
  readonly entityId: string;
  readonly label: string;
  readonly assetId: string | null;
  readonly version: string;
  readonly mode: RouteMode;
  readonly moving: boolean;
  /** Simulation time the plan was made. */
  readonly now: number;
  /** Time Baymax reaches the end of the route at the planning speed. */
  readonly arrivalTime: number;
  /** Time the target's forecast position was taken for the route's end point (equals `arrivalTime` for a converged interception; earlier for an aim point). */
  readonly aimTime: number;
  readonly leadLimited: boolean;
  readonly targetNow: TimedPoint;
  readonly targetTrail: readonly TimedPoint[];
  /** The target's forecast from now until the later of aim and arrival. */
  readonly targetFuture: readonly TimedPoint[];
  /** The target as forecast at the aim time, and at Baymax's arrival time. */
  readonly targetAtAim: TimedPoint;
  readonly targetAtArrival: TimedPoint;
  readonly baymaxNow: Vec3;
  /** Baymax's route with the simulation time at each point (start first). */
  readonly route: readonly RoutePoint[];
  readonly baymaxAtArrival: Vec3;
  /** Baymax along the route at time t (clamped to the route). */
  baymaxAt(t: number): Vec3;
  /** Distance between the target's forecast position and Baymax at arrival. Near zero for a converged interception; larger when ATLAS is only aiming. */
  readonly gap: number;
  readonly converged: boolean;
  /** Times at which translucent future copies are drawn (e.g. a third, two thirds and the arrival). */
  readonly ghostTimes: readonly number[];
  /** Forecast at time t for the ghosts. */
  targetAt(t: number): TimedPoint;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function trailOf(track: readonly TrackSample[], max = 80): TimedPoint[] {
  return track.slice(-max).map(s => ({ t: s.time, position: s.position as Vec3, uncertainty: 0 }));
}

/** Forecast of one entity from its fitted model, sampled from `now` to `until`. */
export function buildForecast(entity: Entity, est: Estimate | undefined, track: readonly TrackSample[], now: number, until: number, samples = 28): ForecastView | null {
  if (!est?.ok || !est.fit || est.motion !== 'moving') return null;
  const fit = est.fit;
  const last = track.at(-1);
  const current: TimedPoint = { t: last?.time ?? now, position: entity.position, uncertainty: 0 };
  const at = (t: number): TimedPoint => { const p = positionAt(fit, t); return { t, position: p.position, uncertainty: p.uncertainty }; };
  const span = Math.max(0.5, until - now);
  const future = Array.from({ length: samples + 1 }, (_, i) => at(now + (span * i) / samples));
  // The trusted range: where the stated uncertainty stays within what ATLAS will plan on.
  let trustedUntil = now;
  for (let l = 0.5; l <= 30; l += 0.5) { const p = positionAt(fit, now + l); if (!p.supported || p.uncertainty > 14) break; trustedUntil = now + l; }
  return { entityId: entity.id, version: `${entity.id}@${fit.issuedAt.toFixed(2)}:${fit.kind}`, now, model: fit.kind, supported: positionAt(fit, until).supported, trail: trailOf(track), current, future, at, trustedUntil };
}

/** Baymax's position along a timed route at time t. */
export function alongRoute(route: readonly RoutePoint[], t: number): Vec3 {
  if (route.length === 0) return [0, 0, 0];
  if (t <= route[0]!.t) return route[0]!.position;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!, b = route[i]!;
    if (t <= b.t) { const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t); return [a.position[0] + (b.position[0] - a.position[0]) * k, a.position[1] + (b.position[1] - a.position[1]) * k, a.position[2] + (b.position[2] - a.position[2]) * k]; }
  }
  return route.at(-1)!.position;
}

/** The encounter implied by a plan: where the target is now, where it is forecast to be at the aim time and when Baymax arrives, and where Baymax is
 * on his route at those times. Returns null if the plan is not ready. */
export function buildEncounter(plan: PlanOutcome, entity: Entity, est: Estimate | undefined, track: readonly TrackSample[], baymaxNow: Vec3): Encounter | null {
  if (plan.status !== 'ready' || plan.waypoints.length === 0) return null;
  const now = plan.now;
  const moving = plan.mode === 'intercept' && !!est?.ok && !!est.fit && est.motion === 'moving';
  const route: RoutePoint[] = [{ t: now, position: baymaxNow }, ...plan.waypoints.map(w => ({ t: w.etaSimTime ?? now, position: w.position as Vec3 }))];
  const arrivalTime = route.at(-1)!.t;
  const aimTime = plan.meetingTime ?? arrivalTime;
  const fc = moving ? buildForecast(entity, est, track, now, Math.max(aimTime, arrivalTime), 32) : null;
  const targetAt = (t: number): TimedPoint => (fc ? fc.at(t) : { t, position: plan.meetingPosition ?? entity.position, uncertainty: plan.uncertainty });
  const staticPoint = (): TimedPoint => ({ t: now, position: entity.position, uncertainty: 0 });
  const end = route.at(-1)!.position;
  // For a moving target the route's end point IS the forecast at the aim time plus the stand-off ATLAS added; the encounter compares Baymax with the target.
  const targetAtAim = moving ? targetAt(aimTime) : { t: aimTime, position: plan.meetingPosition ?? entity.position, uncertainty: plan.uncertainty };
  const targetAtArrival = moving ? targetAt(arrivalTime) : targetAtAim;
  const gap = moving ? dist(targetAtArrival.position, end) : dist(targetAtAim.position, end);
  const span = Math.max(0.5, arrivalTime - now);
  const ghostTimes = moving ? [now + span / 3, now + (2 * span) / 3, arrivalTime] : [arrivalTime];
  return {
    entityId: entity.id, label: entity.label, assetId: entity.assetId, version: fc?.version ?? `${entity.id}@static`, mode: plan.mode, moving, now, arrivalTime, aimTime,
    leadLimited: plan.intercept?.leadLimited ?? false,
    targetNow: fc?.current ?? staticPoint(), targetTrail: fc?.trail ?? [], targetFuture: fc?.future ?? [], targetAtAim, targetAtArrival,
    baymaxNow, route, baymaxAtArrival: end, baymaxAt: t => alongRoute(route, t), gap, converged: gap <= 6.4, ghostTimes, targetAt,
  };
}
