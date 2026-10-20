import type { WorldVec3, ObservedConnectionState } from '../../shared/atlasContract';
import type { SceneCategory, SceneFamily } from '../live/protocol';
import type { KnowledgeSnapshot, ScanPulse } from '../live/knowledge';
import type { NavigationAdvice } from '../navigation/types';
import type { NumericForecast } from '../analysis/types';
export type { ScanPulse };

/** Presentation view model: the only bridge from ATLAS knowledge to the renderer.
 * It contains exactly what ATLAS's memories hold (observed or remembered); nothing else can be drawn.
 * All times in this model are presentation-clock seconds, so animation durations are authored in real seconds. */
export interface SceneIsland {
  readonly id: string;
  readonly position: WorldVec3;
  readonly observed: boolean;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly observationCount: number;
}
export interface SceneFold {
  readonly id: string;
  readonly entry: WorldVec3;
  readonly exit: WorldVec3;
  readonly observed: boolean;
  /** State at the most recent measurement of this fold (stale if not currently observed). */
  readonly state: ObservedConnectionState;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly observationCount: number;
}
export interface SceneObject {
  readonly id: string;
  readonly category: SceneCategory;
  readonly family: SceneFamily;
  readonly kind: string;
  readonly position: WorldVec3;
  readonly radius: number;
  readonly observed: boolean;
  readonly firstSeenAt: number;
}
export interface SceneClusterView {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly centre: WorldVec3;
  readonly extent: number;
  readonly count: number;
  readonly observed: number;
  readonly remembered: number;
}
/** A recorded change of a fold position between two observations (never an invented path). */
export interface SceneChange {
  readonly id: string;
  readonly from: WorldVec3;
  readonly to: WorldVec3;
  readonly distance: number;
  readonly fromT: number;
  readonly toT: number;
  readonly state: { readonly from: ObservedConnectionState; readonly to: ObservedConnectionState } | null;
}
/** An evidence-limited estimate (or the abstention from making one) for a fold entry position. */
export interface SceneEstimate {
  readonly id: string;
  readonly status: 'estimate' | 'withheld';
  readonly from: WorldVec3;
  readonly estimate: WorldVec3 | null;
  readonly allowance: number | null;
  readonly issuedAt: number;
  readonly targetTime: number | null;
  readonly reason: string | null;
  /** The later check of THIS forecast (same issue time), with this forecast's own allowance. Null until a later observation arrives. */
  readonly evaluation: { readonly error: number; readonly covered: boolean; readonly observedAt: number; readonly observed: WorldVec3 | null; readonly allowance: number } | null;
  /** The measurement at this forecast's target time, once it has been delivered (it may arrive before the check is computed). */
  readonly arrival: { readonly time: number; readonly position: WorldVec3 } | null;
  /** The most recent check of an EARLIER forecast, reported on its own terms (never mixed with this forecast's allowance). */
  readonly lastCheck: { readonly issuedAt: number; readonly targetTime: number; readonly error: number; readonly allowance: number; readonly covered: boolean } | null;
}

/** A previously published forecast, kept exactly as issued. */
export interface ForecastArchiveEntry { readonly key: string; readonly forecast: NumericForecast }
/** Presentation camera shot, authored by the mission director. World-space centre with spherical offsets. */
export interface CameraShot {
  readonly centre: WorldVec3;
  readonly dist: number;
  readonly yaw: number;
  readonly pitch: number;
  /** 0 holds the camera still for comparisons; 1 allows the usual gentle drift. */
  readonly drift: number;
}
/** What the director wants emphasised. Everything else recedes. Presentation only. */
export interface SceneFocus { readonly ids: readonly string[]; readonly debris: boolean }

/** Navigation guidance as drawn: segments by evidence class, waypoints and the observation target. Derived from NavigationAdvice only. */
export interface SceneNavSegment { readonly from: WorldVec3; readonly to: WorldVec3; readonly kind: 'fold' | 'approach' | 'track'; readonly remembered: boolean; readonly caution: boolean }
export interface SceneNavPoint { readonly position: WorldVec3; readonly label: string; readonly kind: 'waypoint' | 'goal' | 'fold' }
export interface SceneNavigation {
  readonly status: NavigationAdvice['status'];
  readonly segments: readonly SceneNavSegment[];
  readonly points: readonly SceneNavPoint[];
  /** The next observation (or next waypoint) the recommendation points at. */
  readonly target: { readonly position: WorldVec3; readonly label: string; readonly action: NavigationAdvice['recommendation']['action'] } | null;
}

export interface SceneModel {
  /** Presentation clock (seconds). */
  readonly time: number;
  readonly observer: { readonly position: WorldVec3; readonly firstSeenAt: number } | null;
  readonly islands: readonly SceneIsland[];
  readonly folds: readonly SceneFold[];
  readonly objects: readonly SceneObject[];
  readonly clusters: readonly SceneClusterView[];
  readonly pulses: readonly ScanPulse[];
  /** Observer speed (units per presentation second) at which Baymax's thrusters reach full power. */
  readonly motionReference: number;
  readonly changes: readonly SceneChange[];
  readonly estimates: readonly SceneEstimate[];
  /** Mission stage index for gating stage-specific overlays; null shows them whenever the data exists. */
  readonly stage: number | null;
  readonly navigation: SceneNavigation | null;
  /** 'memory' draws everything ATLAS knows; 'sensor' draws only what is observed now. A lens never edits memory. */
  readonly lens: 'memory' | 'sensor';
  /** Baymax before the first observation arrives (the opening). Not map knowledge: it is only where the character stands. */
  readonly hero: WorldVec3 | null;
  readonly shot: CameraShot | null;
  readonly focus: SceneFocus | null;
}

export const EMPTY_SCENE: SceneModel = { time: 0, observer: null, islands: [], folds: [], objects: [], clusters: [], pulses: [], motionReference: 7, changes: [], estimates: [], stage: null, navigation: null, lens: 'memory', hero: null, shot: null, focus: null };

export interface SceneBuildOptions {
  /** Presentation seconds per observation (simulation) second, used to place observation times on the clock. */
  readonly scale?: number;
  /** Explicit first-recorded presentation times (live mode); entities without an entry fall back to scale. */
  readonly appear?: ReadonlyMap<string, number>;
  readonly pulses?: readonly ScanPulse[];
  readonly motionReference?: number;
  readonly stage?: number | null;
  /** Clock mapping for the guided mission (simulation seconds to presentation seconds); takes precedence over `scale`. */
  readonly toClock?: (simTime: number) => number;
  readonly lens?: 'memory' | 'sensor';
  readonly hero?: WorldVec3 | null;
  readonly shot?: CameraShot | null;
  readonly focus?: SceneFocus | null;
  /** Every forecast published so far, and the issue times to present. Without `featured` the current forecast is shown, with no check attached. */
  readonly archive?: readonly ForecastArchiveEntry[];
  readonly featured?: readonly number[];
  /** False hides estimates entirely (the story has not reached them yet). */
  readonly showEstimates?: boolean;
}

export function buildSceneModel(knowledge: KnowledgeSnapshot, time: number, options: SceneBuildOptions = {}): SceneModel {
  const scale = options.scale ?? 1;
  const clock = options.toClock ?? ((t: number) => t * scale);
  const appear = options.appear ?? knowledge.appear;
  const at = (id: string, simTime: number) => appear.get(id) ?? clock(simTime);
  const m = knowledge.view.mapping;
  const observer = m.explorer.latestPosition && m.explorer.lastSeenAt !== null
    ? { position: m.explorer.latestPosition, firstSeenAt: appear.get('baymax-observer') ?? clock(m.explorer.track[0]?.time ?? m.explorer.lastSeenAt) }
    : null;
  return {
    time, observer,
    islands: m.islands.map(i => ({
      id: i.id, position: i.currentPosition ?? i.lastKnownPosition, observed: i.currentlyObserved,
      firstSeenAt: at(i.id, i.firstSeenAt), lastSeenAt: clock(i.lastSeenAt), observationCount: i.observationCount,
    })),
    folds: m.folds.map(f => ({
      id: f.id, entry: f.currentEntryPosition ?? f.lastKnownEntryPosition, exit: f.currentExitPosition ?? f.lastKnownExitPosition,
      observed: f.currentlyObserved, state: f.currentState ?? f.lastObservedState,
      firstSeenAt: at(f.id, f.firstSeenAt), lastSeenAt: clock(f.lastSeenAt), observationCount: f.observationCount,
    })),
    objects: knowledge.scene.records.map(r => ({
      id: r.id, category: r.category, family: r.family, kind: r.kind, position: r.lastKnownPosition, radius: r.radius,
      observed: r.currentlyObserved, firstSeenAt: at(r.id, r.firstSeenAt),
    })),
    clusters: knowledge.scene.clusters.map(c => ({
      id: c.id, label: c.label, group: c.group, centre: c.centre, extent: c.extent, count: c.count, observed: c.currentlyObserved, remembered: c.remembered,
    })),
    pulses: options.pulses ?? knowledge.pulses,
    motionReference: options.motionReference ?? 7,
    stage: options.stage ?? null,
    lens: options.lens ?? 'memory', hero: options.hero ?? null, shot: options.shot ?? null, focus: options.focus ?? null,
    ...hideEstimates(temporalGeometry(knowledge, options.archive ?? [], options.featured ?? []), options.showEstimates === false),
    navigation: navigationGeometry(knowledge),
  };
}

function navigationGeometry(knowledge: KnowledgeSnapshot): SceneNavigation | null {
  const advice = knowledge.navigation?.advice;
  if (!advice || advice.status === 'abstain') return null;
  const at = new Map(advice.waypoints.map(w => [w.id, w]));
  const segments: SceneNavSegment[] = [], points: SceneNavPoint[] = [];
  if (advice.route) {
    for (const s of advice.route.segments) {
      const a = at.get(s.from), b = at.get(s.to);
      if (!a || !b) continue;
      segments.push({ from: a.position, to: b.position, kind: s.kind === 'fold-transition' ? 'fold' : s.support === 'recorded-track' ? 'track' : 'approach', remembered: s.support === 'remembered-fold', caution: s.caution });
    }
    advice.waypoints.slice(1).forEach((w, i, all) => points.push({ position: w.position, label: w.label, kind: i === all.length - 1 ? 'goal' : w.kind === 'fold-entry' || w.kind === 'fold-exit' ? 'fold' : 'waypoint' }));
  }
  const r = advice.recommendation;
  return { status: advice.status, segments, points, target: r.target ? { position: r.target, label: r.title, action: r.action } : null };
}

/** The sample that precedes the most recent gap in a fold's observations (it was last seen there before leaving view and being found again),
 * or the first sample when it has never left view. Comparing against it is comparing against ATLAS's own earlier record. */
export function earlierRecord<T extends { readonly time: number }>(track: readonly T[], maxGap: number): T | undefined {
  for (let i = track.length - 1; i > 0; i -= 1) if (track[i]!.time - track[i - 1]!.time > maxGap) return track[i - 1];
  return track[0];
}

function hideEstimates<T extends { estimates: SceneEstimate[] }>(g: T, hide: boolean): T { return hide ? { ...g, estimates: [] } : g; }

function temporalGeometry(knowledge: KnowledgeSnapshot, archive: readonly ForecastArchiveEntry[], featured: readonly number[]): { changes: SceneChange[]; estimates: SceneEstimate[] } {
  const view = knowledge.view;
  const changes: SceneChange[] = [], estimates: SceneEstimate[] = [];
  const maxGap = view.temporal.policy.maxGapSeconds;
  for (const f of view.mapping.folds) {
    const first = earlierRecord(f.track, maxGap), last = f.track.at(-1);
    if (first && last && last.time > first.time) {
      const d = Math.hypot(last.entryPosition[0] - first.entryPosition[0], last.entryPosition[1] - first.entryPosition[1], last.entryPosition[2] - first.entryPosition[2]);
      const stateChanged = first.state !== last.state;
      if (d > 1 || stateChanged) changes.push({ id: f.id, from: first.entryPosition, to: last.entryPosition, distance: d, fromT: first.time, toT: last.time, state: stateChanged ? { from: first.state, to: last.state } : null });
    }
  }
  for (const dyn of view.temporal.folds) {
    const record = view.mapping.folds.find(r => r.id === dyn.id);
    if (!record) continue;
    const a = dyn.entry, current = record.currentEntryPosition ?? record.lastKnownEntryPosition;
    const latest = [...view.temporal.evaluations].reverse().find(e => e.key === a.key && e.published);
    const lastCheck = latest ? { issuedAt: latest.issuedAt, targetTime: latest.targetTime, error: latest.error, allowance: latest.errorAllowance, covered: latest.covered } : null;
    // A forecast is presented together with the check of that same forecast only, and with the allowance it was published with.
    const pinned = featured.map(t => archive.find(p => p.key === a.key && p.forecast.issuedAt === t)?.forecast).find(f => !!f);
    const forecast = pinned ?? a.forecast;
    if (forecast && forecast.estimate.length === 3) {
      const ev = view.temporal.evaluations.find(e => e.key === a.key && e.published && e.issuedAt === forecast.issuedAt && e.targetTime === forecast.targetTime);
      const sample = ev ? record.track.find(s => Math.abs(s.time - ev.observedAt) < 1e-9) ?? null : null;
      const arrival = record.track.find(s => Math.abs(s.time - forecast.targetTime) < 1e-9) ?? null;
      // The path of a forecast starts at the measurement it was made from, not at wherever the fold is by now.
      const origin = record.track.find(s => Math.abs(s.time - forecast.issuedAt) < 1e-9)?.entryPosition ?? current;
      estimates.push({
        id: dyn.id, status: 'estimate', from: origin, estimate: [forecast.estimate[0]!, forecast.estimate[1]!, forecast.estimate[2]!], allowance: forecast.errorAllowance,
        issuedAt: forecast.issuedAt, targetTime: forecast.targetTime, reason: null,
        evaluation: ev ? { error: ev.error, covered: ev.covered, observedAt: ev.observedAt, observed: sample ? sample.entryPosition : null, allowance: ev.errorAllowance } : null,
        arrival: arrival ? { time: arrival.time, position: arrival.entryPosition } : null,
        lastCheck: ev ? null : lastCheck,
      });
    } else if (a.sampleCount > 0 && (a.quality === 'withheld' || a.quality === 'insufficient')) {
      estimates.push({ id: dyn.id, status: 'withheld', from: current, estimate: null, allowance: null, issuedAt: view.temporal.time ?? 0, targetTime: null, reason: a.reasons[0] ?? 'Insufficient evidence for a reliable estimate.', evaluation: null, arrival: null, lastCheck });
    }
  }
  return { changes, estimates };
}

/** Deterministic string hash → [0,1) values used only for illustrative form. */
export function hashUnit(key: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
