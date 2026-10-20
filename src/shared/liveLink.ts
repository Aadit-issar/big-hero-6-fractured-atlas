/** ATLAS ⇄ Dimension live link, protocol version 2: the wire contract shared by both applications.
 *
 * This file is byte-identical in the Dimension and ATLAS branches (scripts/sync-shared.mjs checks it). It contains only types, constants and
 * pure validators. Everything arriving over the link is untrusted input and is validated here before use.
 *
 * Direction summary
 *  Dimension → ATLAS: welcome, frame (pose, clock, sensor observation, optional scan, navigation report), route-ack
 *  ATLAS → Dimension: hello, bye, scan-request, set-scan-mode, advisory (v1 data-only guidance), route, route-cancel
 *
 * The Dimension owns the clock: every message that carries a time uses the Dimension's simulation clock (`simTime`), never ATLAS's.
 * Nothing in this contract carries hidden world state: a scan reports positions and attitudes of objects within sensor range at the scan
 * time, never velocities, parameters or future positions. */

export const LIVE_CHANNEL = 'fractured-atlas-link';
export const LIVE_VERSION = 2;

export type Vec3Tuple = readonly [number, number, number];
export type QuatTuple = readonly [number, number, number, number];

/** Baymax's own vehicle state as reported by the Dimension. Velocity is the vehicle's measured motion, not an object's. */
export interface PoseReport {
  readonly position: Vec3Tuple;
  /** Camera/body attitude (x, y, z, w). The explorer's forward is the local −Z axis. */
  readonly quaternion: QuatTuple;
  readonly forward: Vec3Tuple;
  readonly velocity: Vec3Tuple;
}

export interface ClockReport {
  /** engine.clock.time (model seconds): the one authoritative simulation time. */
  readonly time: number;
  readonly running: boolean;
  readonly timeScale: number;
  /** False while the Dimension's tab is hidden or throttled (its clock does not advance then). */
  readonly visible: boolean;
}

export type RouteMode = 'intercept' | 'approach' | 'entrance' | 'transit' | 'reconnaissance';
export type RouteWaypointKind = 'path' | 'intercept' | 'approach' | 'entrance';
export type GoalMotion = 'static' | 'moving' | 'unknown';

export interface RouteWaypoint {
  readonly id: string;
  readonly position: Vec3Tuple;
  readonly kind: RouteWaypointKind;
  /** The waypoint counts as reached when Baymax is within this distance (metres). */
  readonly arrivalRadius: number;
  /** Simulation time at which Baymax is expected to be there (at the planning speed), or null. */
  readonly etaSimTime: number | null;
}

export interface RouteInterception {
  /** Planned meeting point (a future position of the goal) and the simulation time of the meeting. */
  readonly position: Vec3Tuple;
  readonly simTime: number;
  /** Where the goal was last observed, for comparison with the meeting point. */
  readonly targetNow: Vec3Tuple;
  readonly targetObservedAt: number;
  /** Stated radius around the meeting point the goal is expected to stay within. */
  readonly uncertainty: number;
  /** ATLAS's forecast path of the goal over the flight (<= 40 samples, ascending simTime). Display data for the Dimension; it never steers anything. */
  readonly targetPath?: readonly { readonly simTime: number; readonly position: Vec3Tuple }[];
  /** True when the exact meeting is further ahead than ATLAS trusts: the point is an aim point that is refined as Baymax closes in. */
  readonly leadLimited?: boolean;
  /** Simulation time at which Baymax is expected to reach the end of the route at the planning speed. */
  readonly arrivalSimTime?: number;
}

/** A route proposed by ATLAS. The Dimension validates it, acknowledges it and shows guidance; it never moves Baymax. */
export interface RouteCommand {
  readonly routeId: string;
  /** Strictly increasing per ATLAS page session: a replacement has a higher revision, an older revision is ignored. */
  readonly revision: number;
  readonly atlasSession: string;
  readonly goal: { readonly id: string; readonly label: string; readonly category: string; readonly motion: GoalMotion; /** Registry asset id of the goal's model, so the viewer can draw the same object. */ readonly assetId?: string };
  readonly mode: RouteMode;
  readonly issuedSimTime: number;
  /** Planning speed (m/s) assumed by the time estimates. */
  readonly speed: number;
  readonly waypoints: readonly RouteWaypoint[];
  readonly interception: RouteInterception | null;
  /** Human-readable, event-derived explanation of why this route (or this change) was issued. */
  readonly reason: string;
  readonly assumptions: readonly string[];
  readonly supersedes: number | null;
}

export type NavStatus = 'active' | 'arrived' | 'missed' | 'cancelled' | 'expired';
/** The measured result of a route, decided inside the Dimension from true positions. */
export interface NavOutcome {
  readonly success: boolean;
  /** Simulation time of the encounter (success) or of the decision that it was missed. */
  readonly simTime: number;
  /** Smallest distance between Baymax and the goal's TRUE position during the route (m). */
  readonly closestApproach: number;
  readonly captureRadius: number;
  /** What ATLAS planned: the planned meeting time and the planned meeting position (null for non-intercept routes). */
  readonly plannedSimTime: number | null;
  readonly plannedPosition: Vec3Tuple | null;
  /** Where the goal truly was at `simTime`, and how far that is from the planned meeting position. */
  readonly goalPosition: Vec3Tuple;
  readonly plannedError: number | null;
}
export interface NavReport {
  readonly routeId: string;
  readonly revision: number;
  readonly status: NavStatus;
  readonly activeIndex: number;
  readonly waypointCount: number;
  readonly distanceToWaypoint: number;
  readonly distanceToGoal: number;
  readonly arrivedAtSimTime: number | null;
  /** Smallest distance to the goal's true position so far (m), when the goal is a real object. */
  readonly closestApproach?: number;
  /** Present once the route has ended with arrival or a miss. */
  readonly outcome?: NavOutcome;
}

export type AckCode = 'ok' | 'stale-revision' | 'wrong-session' | 'invalid' | 'cancelled' | 'unknown-route';
export interface RouteAck {
  readonly type: 'route-ack';
  readonly session: string;
  readonly seq: number;
  readonly routeId: string;
  readonly revision: number;
  readonly status: 'accepted' | 'rejected' | 'cancelled';
  readonly code: AckCode;
  readonly detail: string;
  readonly simTime: number;
}

export interface ObservedDisturbance {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3Tuple;
  readonly radius: number;
  readonly intensity: number;
}

/** What a scan of an island measures: its extent and the seed of its (deterministic) rock form. Enough for a viewer to draw the SAME island. */
export interface ObservedIslandForm { readonly id: string; readonly index: number; readonly radius: number; readonly height: number; readonly facetSeed: number; readonly color: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const coord = (v: unknown): v is number => finite(v) && Math.abs(v) < 5000;
export const vec3 = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every(coord);
export const quat4 = (v: unknown): v is QuatTuple => Array.isArray(v) && v.length === 4 && v.every(finite);
const text = (v: unknown, max = 120): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const MODES: readonly string[] = ['intercept', 'approach', 'entrance', 'transit', 'reconnaissance'];
const WP_KINDS: readonly string[] = ['path', 'intercept', 'approach', 'entrance'];
const MOTIONS: readonly string[] = ['static', 'moving', 'unknown'];
export const MAX_WAYPOINTS = 24;

export function parsePose(raw: unknown): PoseReport | null {
  if (!isObject(raw) || !vec3(raw.position) || !quat4(raw.quaternion) || !vec3(raw.forward) || !vec3(raw.velocity)) return null;
  return { position: raw.position, quaternion: raw.quaternion, forward: raw.forward, velocity: raw.velocity };
}

export function parseClock(raw: unknown): ClockReport | null {
  if (!isObject(raw) || !finite(raw.time) || raw.time < 0 || typeof raw.running !== 'boolean' || !finite(raw.timeScale) || typeof raw.visible !== 'boolean') return null;
  return { time: raw.time, running: raw.running, timeScale: raw.timeScale, visible: raw.visible };
}

export function parseNavReport(raw: unknown): NavReport | null {
  if (!isObject(raw) || !text(raw.routeId) || !Number.isInteger(raw.revision) || !['active', 'arrived', 'missed', 'cancelled', 'expired'].includes(String(raw.status))) return null;
  if (!Number.isInteger(raw.activeIndex) || !Number.isInteger(raw.waypointCount) || !finite(raw.distanceToWaypoint) || !finite(raw.distanceToGoal)) return null;
  if (raw.arrivedAtSimTime !== null && !finite(raw.arrivedAtSimTime)) return null;
  let outcome: NavOutcome | undefined;
  if (raw.outcome !== undefined) {
    const o = raw.outcome;
    if (!isObject(o) || typeof o.success !== 'boolean' || !finite(o.simTime) || !finite(o.closestApproach) || !finite(o.captureRadius) || !(o.plannedSimTime === null || finite(o.plannedSimTime)) || !(o.plannedPosition === null || vec3(o.plannedPosition)) || !vec3(o.goalPosition) || !(o.plannedError === null || finite(o.plannedError))) return null;
    outcome = { success: o.success, simTime: o.simTime, closestApproach: o.closestApproach, captureRadius: o.captureRadius, plannedSimTime: o.plannedSimTime as number | null, plannedPosition: o.plannedPosition as Vec3Tuple | null, goalPosition: o.goalPosition, plannedError: o.plannedError as number | null };
  }
  return {
    routeId: raw.routeId, revision: raw.revision as number, status: raw.status as NavStatus, activeIndex: raw.activeIndex as number, waypointCount: raw.waypointCount as number,
    distanceToWaypoint: raw.distanceToWaypoint, distanceToGoal: raw.distanceToGoal, arrivedAtSimTime: raw.arrivedAtSimTime as number | null,
    ...(finite(raw.closestApproach) ? { closestApproach: raw.closestApproach } : {}), ...(outcome ? { outcome } : {}),
  };
}

export function parseDisturbance(raw: unknown): ObservedDisturbance | null {
  if (!isObject(raw) || !text(raw.id) || !text(raw.label) || !vec3(raw.position) || !finite(raw.radius) || raw.radius <= 0 || !finite(raw.intensity)) return null;
  return { id: raw.id, label: raw.label, position: raw.position, radius: raw.radius, intensity: raw.intensity };
}

export function parseIslandForm(f: unknown): ObservedIslandForm | null {
  if (!isObject(f) || !text(f.id) || !Number.isInteger(f.index) || !finite(f.radius) || f.radius <= 0 || !finite(f.height) || f.height <= 0 || !finite(f.facetSeed) || !text(f.color, 20)) return null;
  return { id: f.id, index: f.index as number, radius: f.radius, height: f.height, facetSeed: f.facetSeed, color: f.color };
}

export function parseRouteAck(data: Record<string, unknown>): RouteAck | null {
  if (!text(data.session, 80) || !Number.isInteger(data.seq) || !text(data.routeId) || !Number.isInteger(data.revision) || !finite(data.simTime)) return null;
  if (!['accepted', 'rejected', 'cancelled'].includes(String(data.status)) || !['ok', 'stale-revision', 'wrong-session', 'invalid', 'cancelled', 'unknown-route'].includes(String(data.code)) || typeof data.detail !== 'string') return null;
  return { type: 'route-ack', session: data.session, seq: data.seq as number, routeId: data.routeId, revision: data.revision as number, status: data.status as RouteAck['status'], code: data.code as AckCode, detail: data.detail.slice(0, 200), simTime: data.simTime };
}

/** Strict validation of a route command. Returns null for anything malformed; the caller acknowledges it as invalid. */
export function parseRouteCommand(raw: unknown): RouteCommand | null {
  if (!isObject(raw) || !text(raw.routeId, 80) || !Number.isInteger(raw.revision) || (raw.revision as number) < 0 || (raw.revision as number) > 1_000_000 || !text(raw.atlasSession, 80)) return null;
  if (!isObject(raw.goal) || !text(raw.goal.id) || !text(raw.goal.label) || !text(raw.goal.category, 40) || !MOTIONS.includes(String(raw.goal.motion))) return null;
  if (!MODES.includes(String(raw.mode)) || !finite(raw.issuedSimTime) || Math.abs(raw.issuedSimTime) > 1e7 || !finite(raw.speed) || raw.speed <= 0 || raw.speed > 200) return null;
  if (!Array.isArray(raw.waypoints) || raw.waypoints.length < 1 || raw.waypoints.length > MAX_WAYPOINTS) return null;
  const waypoints: RouteWaypoint[] = [];
  for (const w of raw.waypoints) {
    if (!isObject(w) || !text(w.id, 60) || !vec3(w.position) || !WP_KINDS.includes(String(w.kind)) || !finite(w.arrivalRadius) || w.arrivalRadius <= 0 || w.arrivalRadius > 100) return null;
    if (w.etaSimTime !== null && !finite(w.etaSimTime)) return null;
    waypoints.push({ id: w.id, position: w.position, kind: w.kind as RouteWaypointKind, arrivalRadius: w.arrivalRadius, etaSimTime: w.etaSimTime as number | null });
  }
  let interception: RouteInterception | null = null;
  if (raw.interception !== null && raw.interception !== undefined) {
    const i = raw.interception;
    if (!isObject(i) || !vec3(i.position) || !finite(i.simTime) || !vec3(i.targetNow) || !finite(i.targetObservedAt) || !finite(i.uncertainty) || i.uncertainty < 0) return null;
    let targetPath: { simTime: number; position: Vec3Tuple }[] | undefined;
    if (i.targetPath !== undefined) {
      if (!Array.isArray(i.targetPath) || i.targetPath.length > 40) return null;
      targetPath = [];
      for (const p of i.targetPath) { if (!isObject(p) || !finite(p.simTime) || !vec3(p.position)) return null; targetPath.push({ simTime: p.simTime, position: p.position }); }
    }
    interception = {
      position: i.position, simTime: i.simTime, targetNow: i.targetNow, targetObservedAt: i.targetObservedAt, uncertainty: i.uncertainty,
      ...(targetPath ? { targetPath } : {}), ...(typeof i.leadLimited === 'boolean' ? { leadLimited: i.leadLimited } : {}), ...(finite(i.arrivalSimTime) ? { arrivalSimTime: i.arrivalSimTime } : {}),
    };
  }
  if (typeof raw.reason !== 'string' || !Array.isArray(raw.assumptions) || raw.assumptions.length > 8 || !raw.assumptions.every(a => typeof a === 'string' && a.length <= 200)) return null;
  if (raw.supersedes !== null && raw.supersedes !== undefined && !Number.isInteger(raw.supersedes)) return null;
  return {
    routeId: raw.routeId, revision: raw.revision as number, atlasSession: raw.atlasSession,
    goal: { id: raw.goal.id, label: raw.goal.label, category: raw.goal.category, motion: raw.goal.motion as GoalMotion, ...(typeof raw.goal.assetId === 'string' && raw.goal.assetId.length <= 80 ? { assetId: raw.goal.assetId } : {}) },
    mode: raw.mode as RouteMode, issuedSimTime: raw.issuedSimTime, speed: raw.speed, waypoints, interception,
    reason: raw.reason.slice(0, 280), assumptions: (raw.assumptions as string[]).slice(0, 8), supersedes: (raw.supersedes ?? null) as number | null,
  };
}
