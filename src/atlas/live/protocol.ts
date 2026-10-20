import type { AtlasObservation } from '../../shared/atlasContract';
import { validateObservation } from '../core/observation';
import { LIVE_CHANNEL, LIVE_VERSION, parseClock, parseDisturbance, parseIslandForm, parseNavReport, parsePose, parseRouteAck, quat4 } from '../../shared/liveLink';
import type { ClockReport, NavReport, ObservedDisturbance, ObservedIslandForm, PoseReport, QuatTuple, RouteAck } from '../../shared/liveLink';

/** ATLAS live link protocol v2 (consumer side). The wire contract is `src/shared/liveLink.ts`, byte-identical in both branches;
 * the publisher lives in the Dimension branch (`src/bridge/atlasBridge.ts`).
 * Everything arriving over the link is untrusted input and is validated here before use. */
export const LINK_CHANNEL = LIVE_CHANNEL;
export const LINK_VERSION = LIVE_VERSION;

export type ScanMode = 'continuous' | 'manual';
export type SceneCategory = 'microbot' | 'concrete' | 'rubble' | 'steel' | 'scaffold' | 'walkway' | 'pipe' | 'electrical' | 'panel' | 'landmark' | 'baymax';
export type SceneFamily = 'microbot' | 'concrete' | 'industrial' | 'baymax' | 'capsule';
export type Vec3Tuple = readonly [number, number, number];

export interface SceneObjectObservation {
  readonly id: string;
  readonly category: SceneCategory;
  readonly family: SceneFamily;
  readonly kind: string;
  readonly label?: string;
  readonly orientation?: QuatTuple;
  readonly position: Vec3Tuple;
  readonly radius: number;
  readonly range: number;
}
export interface SceneScan {
  readonly scanId: number;
  readonly time: number;
  readonly observerPosition: Vec3Tuple;
  readonly range: number;
  readonly coverage: 'proximity-sphere';
  readonly trigger: ScanMode | 'request';
  readonly requestId?: string;
  readonly objects: readonly SceneObjectObservation[];
  readonly omitted: number;
  readonly fields?: readonly ObservedDisturbance[];
  /** Shape descriptors of islands within sensor range (extent and generator seed): what a scan of an island measures. */
  readonly islandForms?: readonly ObservedIslandForm[];
}
export type { ObservedIslandForm };
export interface WelcomeMessage {
  readonly type: 'welcome'; readonly session: string; readonly seq: number; readonly startedAtWallMs: number; readonly simTime: number;
  readonly sensorRange: number; readonly scanRange: number; readonly scanMode: ScanMode; readonly origin: string;
  readonly seed: number; readonly modelVersion: string; readonly clock: ClockReport; readonly pose: PoseReport | null;
}
export interface FrameMessage {
  readonly type: 'frame'; readonly session: string; readonly seq: number; readonly wallMs: number;
  readonly observation: AtlasObservation; readonly scan?: SceneScan; readonly scanMode: ScanMode;
  readonly pose: PoseReport; readonly clock: ClockReport; readonly nav?: NavReport;
}
export interface GoalRequestMessage { readonly type: 'select-goal'; readonly session: string; readonly seq: number; readonly goalId: string }
export type RouteAckMessage = RouteAck;
export type DimensionMessage = WelcomeMessage | FrameMessage | GoalRequestMessage | RouteAckMessage;

/** Advisory sent from ATLAS to the Dimension: data only (never commands). The Dimension validates every field again. */
export const ADVISORY_VERSION = 1;
export interface AdvisoryPayload {
  readonly status: 'route' | 'needs-revalidation' | 'no-route' | 'explore' | 'abstain';
  readonly episode: number;
  readonly simTime: number | null;
  readonly goal: { readonly id: string; readonly label: string } | null;
  readonly title: string;
  readonly detail: string;
  readonly action: 'follow-route' | 'observe' | 'refresh' | 'none';
  readonly target: Vec3Tuple | null;
  readonly waypoints: readonly Vec3Tuple[];
  readonly segments: readonly { readonly kind: 'fold' | 'approach' | 'track'; readonly caution: boolean; readonly remembered: boolean }[];
  readonly limitations: readonly string[];
  readonly goals: readonly { readonly id: string; readonly label: string }[];
}

const CATEGORIES: readonly string[] = ['microbot', 'concrete', 'rubble', 'steel', 'scaffold', 'walkway', 'pipe', 'electrical', 'panel', 'landmark', 'baymax'];
const FAMILIES: readonly string[] = ['microbot', 'concrete', 'industrial', 'baymax', 'capsule'];
const MAX_OBJECTS = 400;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown, max = 120): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseScan(raw: unknown): SceneScan | null {
  if (!isObject(raw) || !finite(raw.scanId) || !finite(raw.time) || !vec3(raw.observerPosition) || !finite(raw.range) || raw.range <= 0) return null;
  if (raw.coverage !== 'proximity-sphere' || !Array.isArray(raw.objects) || raw.objects.length > MAX_OBJECTS || !finite(raw.omitted) || raw.omitted < 0) return null;
  if (!['continuous', 'manual', 'request'].includes(String(raw.trigger))) return null;
  const objects: SceneObjectObservation[] = [];
  for (const o of raw.objects) {
    if (!isObject(o) || !text(o.id) || !CATEGORIES.includes(String(o.category)) || !FAMILIES.includes(String(o.family)) || !text(o.kind) || !vec3(o.position) || !finite(o.radius) || !finite(o.range)) return null;
    const orientation = o.orientation === undefined ? undefined : quat4(o.orientation) ? o.orientation : null;
    if (orientation === null || (o.label !== undefined && !text(o.label, 80))) return null;
    objects.push({ id: o.id, category: o.category as SceneCategory, family: o.family as SceneFamily, kind: o.kind, ...(typeof o.label === 'string' ? { label: o.label } : {}), ...(orientation ? { orientation } : {}), position: o.position, radius: o.radius, range: o.range });
  }
  const fields: ObservedDisturbance[] = [];
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || raw.fields.length > 16) return null;
    for (const f of raw.fields) { const parsed = parseDisturbance(f); if (!parsed) return null; fields.push(parsed); }
  }
  const forms: ObservedIslandForm[] = [];
  if (raw.islandForms !== undefined) {
    if (!Array.isArray(raw.islandForms) || raw.islandForms.length > 32) return null;
    for (const f of raw.islandForms) { const parsed = parseIslandForm(f); if (!parsed) return null; forms.push(parsed); }
  }
  return {
    scanId: raw.scanId, time: raw.time, observerPosition: raw.observerPosition, range: raw.range, coverage: 'proximity-sphere',
    trigger: raw.trigger as SceneScan['trigger'], ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId.slice(0, 80) } : {}), objects, omitted: raw.omitted,
    ...(fields.length ? { fields } : {}), ...(forms.length ? { islandForms: forms } : {}),
  };
}

/** Parses one message from the Dimension. Returns null for anything that is not a well-formed v1 message. */
export function parseDimensionMessage(data: unknown): DimensionMessage | null {
  if (!isObject(data) || data.channel !== LINK_CHANNEL || data.v !== LINK_VERSION) return null;
  if (!text(data.session, 80) || !finite(data.seq) || data.seq < 0 || !Number.isInteger(data.seq)) return null;
  if (data.type === 'welcome') {
    if (!finite(data.startedAtWallMs) || !finite(data.simTime) || !finite(data.sensorRange) || !finite(data.scanRange) || !text(data.origin, 200)) return null;
    if (data.scanMode !== 'continuous' && data.scanMode !== 'manual') return null;
    const clock = parseClock(data.clock);
    if (!clock || !finite(data.seed) || !text(data.modelVersion, 40)) return null;
    const pose = data.pose === null ? null : parsePose(data.pose);
    if (data.pose !== null && !pose) return null;
    return { type: 'welcome', session: data.session, seq: data.seq, startedAtWallMs: data.startedAtWallMs, simTime: data.simTime, sensorRange: data.sensorRange, scanRange: data.scanRange, scanMode: data.scanMode, origin: data.origin, seed: data.seed, modelVersion: data.modelVersion, clock, pose };
  }
  if (data.type === 'route-ack') return parseRouteAck(data);
  if (data.type === 'select-goal') {
    if (!text(data.goalId, 120)) return null;
    return { type: 'select-goal', session: data.session, seq: data.seq, goalId: data.goalId };
  }
  if (data.type === 'frame') {
    if (!finite(data.wallMs) || (data.scanMode !== 'continuous' && data.scanMode !== 'manual')) return null;
    const validation = validateObservation(data.observation);
    if (!validation.ok) return null;
    let scan: SceneScan | undefined;
    if (data.scan !== undefined) { const parsed = parseScan(data.scan); if (!parsed) return null; scan = parsed; }
    const pose = parsePose(data.pose), clock = parseClock(data.clock);
    if (!pose || !clock) return null;
    let nav: NavReport | undefined;
    if (data.nav !== undefined) { const n = parseNavReport(data.nav); if (!n) return null; nav = n; }
    return { type: 'frame', session: data.session, seq: data.seq, wallMs: data.wallMs, observation: validation.observation, ...(scan ? { scan } : {}), scanMode: data.scanMode, pose, clock, ...(nav ? { nav } : {}) };
  }
  return null;
}
