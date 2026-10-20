import { staticEstimate } from '../challenge/motionModel';
import type { Obstacle } from '../challenge/clearance';
import { CHALLENGE_PARAMS } from '../challenge/types';
import type { GoalMotion, RouteCommand, RouteMode, RouteWaypoint, RouteWaypointKind } from '../../shared/liveLink';
import { estimate, positionAt, trustedLead } from './forecast';
import type { Estimate } from './forecast';
import { solveIntercept } from './intercept';
import type { InterceptResult, TargetPath } from './intercept';
import type { Entity, Vec3, WorldMemory } from './world';
import { modeFor } from './targets';

/** Turns "go to this target" into a route: a target path (static, or a forecast from observations), an approach geometry per target class,
 * the obstacle set (observed islands near the corridor), the rendezvous solution, and a human explanation derived from those numbers. */

export const ARRIVAL_RADIUS = { path: 6, final: 5 } as const;
/** Clearance bubble ATLAS keeps around an island on top of its assumed radius (the challenge's Baymax radius + margin). */
const ISLAND_CORRIDOR_SLACK = 14;

export interface PlanRequest {
  readonly memory: WorldMemory;
  readonly targetId: string;
  readonly baymax: Vec3;
  readonly speed: number;
  readonly now: number;
  /** Estimates already computed this frame (shared with the UI); missing ones are fitted on demand. */
  readonly estimates?: ReadonlyMap<string, Estimate>;
}

export type PlanStatus = 'ready' | 'unreachable' | 'no-route' | 'unknown-target';
export interface PlanOutcome {
  readonly status: PlanStatus;
  readonly targetId: string;
  readonly label: string;
  readonly category: Entity['kind'];
  readonly motion: GoalMotion;
  readonly mode: RouteMode;
  readonly now: number;
  readonly speed: number;
  readonly start: Vec3;
  readonly waypoints: readonly RouteWaypoint[];
  readonly intercept: InterceptResult | null;
  /** The target's last observed position, for comparison with the meeting point. */
  readonly targetNow: Vec3;
  readonly targetObservedAt: number;
  readonly meetingPosition: Vec3 | null;
  readonly meetingTime: number | null;
  readonly travelTime: number | null;
  readonly length: number | null;
  readonly uncertainty: number;
  readonly obstacles: readonly string[];
  /** Registry asset id of the target's model (for drawing the same object). */
  readonly assetId: string | null;
  /** The target's forecast over the flight (<= 32 samples), the same samples the scene and the Dimension draw. Empty for static targets. */
  readonly targetPath: readonly { readonly simTime: number; readonly position: Vec3 }[];
  /** Short factual statements answering "why this route / why this position / what is unknown". */
  readonly reasons: readonly string[];
  readonly unknowns: readonly string[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const dist3 = (a: Vec3, b: Vec3) => len(sub(a, b));
const round = (v: Vec3): Vec3 => [Math.round(v[0] * 100) / 100, Math.round(v[1] * 100) / 100, Math.round(v[2] * 100) / 100];

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a), ap = sub(p, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

function offsetFor(entity: Entity, baymax: Vec3, at: Vec3): Vec3 {
  if (entity.kind === 'fold') return [0, 0, 0];
  if (entity.kind === 'island') return [0, (entity.island?.height ?? 2.5) + 5, 0];
  // Stand off on the side Baymax approaches from, so the route never ends inside the object.
  const d = sub(baymax, at), n = len(d) || 1;
  const standOff = entity.kind === 'capsule' ? entity.radius * 0.9 : entity.radius + 2.5;
  return [d[0] / n * standOff, d[1] / n * standOff, d[2] / n * standOff];
}

export function targetPathFor(entity: Entity, est: Estimate | undefined, now: number): { path: TargetPath; moving: boolean; staleUncertainty: number } {
  if (est?.ok && est.fit && est.motion === 'moving') {
    const fit = est.fit;
    return { moving: true, staleUncertainty: 0, path: { kind: 'moving', ...(est.speed != null ? { speedHint: est.speed } : {}), at: t => positionAt(fit, t) } };
  }
  // Static, or last-known only: a remembered entity's uncertainty grows with how long ago it was seen (its drift is unknown).
  const age = Math.max(0, now - entity.lastSeen);
  const uncertainty = entity.knowledge === 'remembered' ? Math.min(40, 1.0 * age) : 0;
  return { moving: false, staleUncertainty: uncertainty, path: { kind: 'static', at: () => ({ position: entity.position, uncertainty, supported: true }) } };
}

export function planToTarget(req: PlanRequest): PlanOutcome {
  const { memory, baymax, speed, now } = req;
  const entity = memory.entity(req.targetId);
  const empty = (status: PlanStatus): PlanOutcome => ({
    status, targetId: req.targetId, label: entity?.label ?? req.targetId, category: entity?.kind ?? 'debris', motion: 'unknown', mode: 'approach', now, speed, start: baymax, waypoints: [], intercept: null,
    targetNow: entity?.position ?? baymax, targetObservedAt: entity?.lastSeen ?? now, meetingPosition: null, meetingTime: null, travelTime: null, length: null, uncertainty: 0, obstacles: [], assetId: entity?.assetId ?? null, targetPath: [], reasons: [], unknowns: [],
  });
  if (!entity) return empty('unknown-target');

  const est = req.estimates?.get(entity.id) ?? estimate(entity.id, memory.track(entity.id), now);
  const { path, moving, staleUncertainty } = targetPathFor(entity, est, now);
  const mode = modeFor(entity, est);
  const offset = offsetFor(entity, baymax, entity.position);

  // Obstacles: observed islands near the straight corridor (the target's own island is not an obstacle to reaching it).
  const rough = round([entity.position[0] + offset[0], entity.position[1] + offset[1], entity.position[2] + offset[2]]);
  const obstacles: Obstacle[] = [];
  const shrunk: string[] = [];
  for (const other of memory.all()) {
    if (other.kind !== 'island' || other.id === entity.id) continue;
    const here = other.position;
    if (distToSegment(here, baymax, rough) > other.radius + CHALLENGE_PARAMS.margin + CHALLENGE_PARAMS.baymaxRadius + ISLAND_CORRIDOR_SLACK) continue;
    const e = estimate(other.id, memory.track(other.id), now);
    const fit = e.fit ?? staticEstimate(other.id, memory.track(other.id));
    // A goal beside an island (a fold entrance, wreckage) would sit inside that island's own clearance bubble. The bubble is shrunk just
    // enough for the goal to lie outside it; every other island keeps its full bound.
    const room = dist3(here, rough) - (CHALLENGE_PARAMS.baymaxRadius + CHALLENGE_PARAMS.margin) - 0.5;
    const bound = Math.max(1, Math.min(other.radius, room));
    if (bound < other.radius) shrunk.push(`${other.id} (${bound.toFixed(1)} m of ${other.radius.toFixed(1)} m)`);
    if (fit) obstacles.push({ id: other.id, fit, bound });
  }

  const leadCap = est?.fit ? trustedLead(est.fit) : 6;
  const result = solveIntercept({ now, start: baymax, speed, target: path, offset, obstacles, params: CHALLENGE_PARAMS, leadCap });
  const base = {
    targetId: entity.id, label: entity.label, category: entity.kind, motion: (est?.motion ?? 'unknown') as GoalMotion, mode, now, speed, start: baymax, intercept: result,
    targetNow: entity.position, targetObservedAt: entity.lastSeen, obstacles: obstacles.map(o => o.id), assetId: entity.assetId, targetPath: [] as { simTime: number; position: Vec3 }[],
  };
  const reasons: string[] = [];
  const unknowns: string[] = [];

  if (result.status !== 'ok' || !result.plan) {
    reasons.push(...result.notes);
    return { ...base, status: result.status === 'unreachable' ? 'unreachable' : 'no-route', waypoints: [], meetingPosition: null, meetingTime: null, travelTime: null, length: null, uncertainty: result.uncertainty, reasons, unknowns };
  }

  const kind: RouteWaypointKind = mode === 'intercept' ? 'intercept' : mode === 'entrance' ? 'entrance' : 'approach';
  const plan = result.plan;
  const waypoints: RouteWaypoint[] = [];
  plan.legs.forEach((leg, i) => {
    const last = i === plan.legs.length - 1;
    waypoints.push({ id: last ? `goal-${entity.id}` : `wp-${i + 1}`, position: round(leg.to.position), kind: last ? kind : 'path', arrivalRadius: last ? ARRIVAL_RADIUS.final : ARRIVAL_RADIUS.path, etaSimTime: Math.round(leg.tEnd * 100) / 100 });
  });

  // Explanation: derived from the actual numbers of this plan.
  const gap = len(sub(result.meetingPosition, entity.position));
  if (mode === 'intercept') {
    reasons.push(`${entity.label} is moving at about ${est?.speed?.toFixed(1) ?? '?'} m/s (${est?.fit?.kind ?? 'model'} fit over ${est?.fit?.support.count ?? '?'} observations).`);
    if (result.leadLimited && !result.straight) reasons.push(`At ${speed.toFixed(0)} m/s Baymax is barely faster than ${entity.label}: ATLAS pursues where it will be ${(result.meetingTime - now).toFixed(0)} s ahead and refines the aim as it closes in.`);
    else if (result.leadLimited) reasons.push(`At ${speed.toFixed(0)} m/s the exact meeting is ${(result.straight!.time - now).toFixed(0)} s away. ATLAS aims ${(result.meetingTime - now).toFixed(0)} s ahead, ${gap.toFixed(0)} m from where it was last seen, and refines the aim as Baymax closes in.`);
    else reasons.push(`At ${speed.toFixed(0)} m/s Baymax can meet it in ${result.travelTime.toFixed(1)} s, ${gap.toFixed(0)} m from where it was last seen.`);
    if (result.straight && plan.waypoints.length > 2) reasons.push(`A direct flight would pass too close to ${obstacles.map(o => o.id).join(', ')}; the route bends to keep clear.`);
  } else if (mode === 'entrance') {
    reasons.push(`Fold ${entity.id} entrance is ${len(sub(entity.position, baymax)).toFixed(0)} m away; the route ends inside its approach radius.`);
    if (entity.foldState !== 'open') reasons.push(`Its last observed state is ${entity.foldState}; it may not be open when Baymax arrives.`);
  } else if (mode === 'approach') {
    reasons.push(entity.kind === 'island' ? `Approach point ${((entity.island?.height ?? 2.5) + 5).toFixed(0)} m above ${entity.label}, not its centre.` : `Approach point ${(entity.radius + 2.5).toFixed(1)} m from ${entity.label}, on the side Baymax arrives from.`);
  } else reasons.push(`${entity.label} was last observed ${Math.max(0, now - entity.lastSeen).toFixed(0)} s ago; the route goes to that position so Baymax can re-observe it.`);
  if (obstacles.length && plan.waypoints.length <= 2) reasons.push(`Clearance to ${obstacles.map(o => o.id).join(', ')} is modelled and met on the direct line.`);

  if (shrunk.length) unknowns.push(`Clearance was reduced near the goal for ${shrunk.join(', ')} so the goal itself is reachable.`);
  if (entity.kind === 'fold') unknowns.push('Where this fold leads has not been observed; it is unverified.');
  if (entity.knowledge === 'remembered' && !moving) unknowns.push(`Position is last-known (${Math.max(0, now - entity.lastSeen).toFixed(0)} s old).`);
  if (!moving && entity.kind !== 'island' && entity.kind !== 'fold' && est && !est.ok) unknowns.push('Too few observations to tell whether this object moves.');
  if (mode === 'intercept') {
    unknowns.push(`Meeting position uncertain by about ±${result.uncertainty.toFixed(1)} m.`);
  }
  for (const n of result.notes) unknowns.push(n);

  // The forecast samples that accompany the route (the same function the scene draws).
  const lastTime = Math.max(result.meetingTime, waypoints.at(-1)?.etaSimTime ?? result.meetingTime);
  const targetPath = mode === 'intercept' && est?.fit ? Array.from({ length: 25 }, (_, i) => { const t = now + ((lastTime - now) * i) / 24; return { simTime: Math.round(t * 100) / 100, position: round(positionAt(est.fit!, t).position) }; }) : [];
  return {
    ...base, targetPath, status: 'ready', waypoints, meetingPosition: result.meetingPosition, meetingTime: result.meetingTime, travelTime: result.travelTime, length: plan.length,
    uncertainty: Math.max(result.uncertainty, staleUncertainty), reasons, unknowns,
  };
}

export interface CommandIdentity { readonly routeId: string; readonly revision: number; readonly atlasSession: string; readonly supersedes: number | null }

/** The wire form of a plan. The reason text is event-derived (passed in by the caller); assumptions are the plan's stated unknowns. */
export function toRouteCommand(outcome: PlanOutcome, id: CommandIdentity, reason: string): RouteCommand | null {
  if (outcome.status !== 'ready' || outcome.waypoints.length === 0) return null;
  return {
    routeId: id.routeId, revision: id.revision, atlasSession: id.atlasSession,
    goal: { id: outcome.targetId, label: outcome.label, category: outcome.category, motion: outcome.motion, ...(outcome.assetId ? { assetId: outcome.assetId } : {}) },
    mode: outcome.mode, issuedSimTime: outcome.now, speed: outcome.speed, waypoints: outcome.waypoints,
    interception: outcome.mode === 'intercept' && outcome.meetingPosition && outcome.meetingTime !== null
      ? {
        position: outcome.meetingPosition, simTime: outcome.meetingTime, targetNow: outcome.targetNow, targetObservedAt: outcome.targetObservedAt, uncertainty: outcome.uncertainty,
        ...(outcome.targetPath.length ? { targetPath: outcome.targetPath } : {}), ...(outcome.intercept ? { leadLimited: outcome.intercept.leadLimited } : {}), ...(outcome.waypoints.at(-1)?.etaSimTime != null ? { arrivalSimTime: outcome.waypoints.at(-1)!.etaSimTime! } : {}),
      } : null,
    reason: reason.slice(0, 270), assumptions: outcome.unknowns.slice(0, 6).map(u => u.slice(0, 190)), supersedes: id.supersedes,
  };
}
