import type { AtlasView } from '../core/runtime';
import type { AtlasEvent } from '../core/events';
import { deriveClusters } from '../mapping/sceneObjectMemory';
import type { NavigationAdvice } from '../navigation/types';
import type { NavChange } from '../navigation/advisor';
import type { SceneCluster, SceneMemoryEvent, SceneObjectRecord, SceneScanSummary } from '../mapping/sceneObjectMemory';

/** One entry of the intelligence activity feed. Every entry is created from a real subsystem event. */
export interface ActivityEntry {
  readonly id: number;
  readonly kind: 'link' | 'scan' | 'discovery' | 'memory' | 'change' | 'estimate' | 'system' | 'navigation';
  readonly tone: 'info' | 'new' | 'memory' | 'warn';
  readonly title: string;
  readonly detail: string;
  readonly simTime: number | null;
  /** Presentation-clock seconds at which the entry was produced. */
  readonly atS: number;
  readonly focusId?: string;
}

/** A visual scan pulse, emitted when a scan actually recorded something or was requested by the user. */
export interface ScanPulse { readonly atS: number; readonly range: number }

export interface SceneKnowledge {
  readonly records: readonly SceneObjectRecord[];
  readonly clusters: readonly SceneCluster[];
  readonly scans: readonly SceneScanSummary[];
}
export const NO_SCENE_KNOWLEDGE: SceneKnowledge = { records: [], clusters: [], scans: [] };

export type KnowledgeSource = 'replay' | 'live-linked' | 'isolated';

/** Navigation state carried with a snapshot when the source computes it (the live session does, so it keeps working while ATLAS is in the background). */
export interface NavigationState { readonly advice: NavigationAdvice; readonly goalId: string | null; readonly changes: readonly NavChange[] }

/** Everything the augmented experience needs to know about ATLAS's current knowledge. Source-agnostic. */
export interface KnowledgeSnapshot {
  readonly source: KnowledgeSource;
  readonly view: AtlasView;
  readonly scene: SceneKnowledge;
  readonly activity: readonly ActivityEntry[];
  /** Presentation-clock seconds at which each entity (island, fold or scene object) was first recorded. */
  readonly appear: ReadonlyMap<string, number>;
  /** Presentation-clock seconds of the most recent scan summary, if any. */
  readonly lastScanAtS: number | null;
  readonly pulses: readonly ScanPulse[];
  readonly navigation?: NavigationState;
}

export function sceneKnowledge(records: readonly SceneObjectRecord[], scans: readonly SceneScanSummary[]): SceneKnowledge {
  return { records, scans, clusters: deriveClusters(records) };
}

const RUNTIME_ACTIVITY: Partial<Record<AtlasEvent['kind'], { kind: ActivityEntry['kind']; tone: ActivityEntry['tone']; title: string }>> = {
  'island-discovered': { kind: 'discovery', tone: 'new', title: 'Island recorded' },
  'fold-discovered': { kind: 'discovery', tone: 'new', title: 'Fold recorded' },
  'island-left': { kind: 'memory', tone: 'memory', title: 'Island left sensor range' },
  'fold-left': { kind: 'memory', tone: 'memory', title: 'Fold left sensor range' },
  'island-reobserved': { kind: 'memory', tone: 'info', title: 'Island re-observed' },
  'fold-reobserved': { kind: 'memory', tone: 'info', title: 'Fold re-observed' },
  'fold-state-changed': { kind: 'change', tone: 'warn', title: 'Recorded fold state changed' },
  'island-position-changed': { kind: 'change', tone: 'warn', title: 'Island position differs from record' },
  'analytical-concern': { kind: 'estimate', tone: 'warn', title: 'Analysis note' },
  'sensor-unavailable': { kind: 'system', tone: 'warn', title: 'Sensor unavailable' },
  'sensor-recovered': { kind: 'system', tone: 'info', title: 'Sensor recovered' },
  'session-reset': { kind: 'system', tone: 'warn', title: 'New observation session' },
  'observation-rejected': { kind: 'system', tone: 'warn', title: 'Observation rejected' },
};

/** Maps a runtime event to an activity entry (or null for kinds that are not worth a headline). */
export function activityFromRuntimeEvent(event: AtlasEvent, view: AtlasView, atS: number, id: number): ActivityEntry | null {
  const spec = RUNTIME_ACTIVITY[event.kind];
  if (!spec) return null;
  const ids = [...view.mapping.islands.map(i => i.id), ...view.mapping.folds.map(f => f.id)];
  const focus = ids.find(x => event.message.includes(x));
  return { id, kind: spec.kind, tone: spec.tone, title: spec.title, detail: event.message, simTime: event.simulationTime, atS, ...(focus ? { focusId: focus } : {}) };
}

const SCENE_TITLE: Record<SceneMemoryEvent['kind'], { title: string; tone: ActivityEntry['tone']; kind: ActivityEntry['kind'] }> = {
  'scene-objects-acquired': { title: 'Scene objects acquired', tone: 'new', kind: 'discovery' },
  'scene-objects-refreshed': { title: 'Records refreshed', tone: 'info', kind: 'scan' },
  'scene-objects-left': { title: 'Objects left scan range', tone: 'memory', kind: 'memory' },
  'scene-scan-empty': { title: 'Scan complete: nothing in range', tone: 'info', kind: 'scan' },
  'scene-scan-unchanged': { title: 'Scan complete: no new objects', tone: 'info', kind: 'scan' },
  'scene-object-moved': { title: 'Object position differs from record', tone: 'warn', kind: 'change' },
};

export function activityFromSceneEvent(event: SceneMemoryEvent, atS: number, id: number): ActivityEntry {
  const spec = SCENE_TITLE[event.kind];
  return { id, kind: spec.kind, tone: spec.tone, title: spec.title, detail: event.message, simTime: event.simulationTime, atS, ...(event.ids[0] ? { focusId: event.ids[0] } : {}) };
}

/** The headline insight for the intelligence panel: the most recent notable activity entry. */
export function primaryInsight(activity: readonly ActivityEntry[]): ActivityEntry | null {
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const e = activity[i]!;
    if (e.tone !== 'info' || e.kind === 'scan' || e.kind === 'link') return e;
  }
  return activity.at(-1) ?? null;
}
