import type { AtlasObservation, WorldVec3 } from '../../shared/atlasContract';
import { AtlasRuntime, type AtlasView } from '../core/runtime';
import type { NumericForecast } from '../analysis/types';
import type { SceneCategory, SceneFamily, SceneObjectObservation, SceneScan } from '../live/protocol';
import { SceneObjectMemory } from '../mapping/sceneObjectMemory';
import { activityFromRuntimeEvent, activityFromSceneEvent, sceneKnowledge } from '../live/knowledge';
import type { ActivityEntry, KnowledgeSnapshot, ScanPulse } from '../live/knowledge';
import { MISSION_CLOCK_END, STAGE_START_SIM, simToClock, stageAtSim } from './missionTimeline';

/** Authored sensor-valid input, never a claim to be a captured live expedition. */
export const MISSION_DURATION = 28;
/** Length of the guided mission on the presentation (mission) clock; see missionTimeline.ts. */
export const PRESENTATION_DURATION = MISSION_CLOCK_END;
/** Simulation second at which each stage's evidence begins. */
export const CHAPTER_TIMES = STAGE_START_SIM;
export interface PublishedPosition { readonly key: string; readonly forecast: NumericForecast }

export function missionObservation(time: number): AtlasObservation {
  if (!Number.isFinite(time) || time < 0 || time > MISSION_DURATION) throw new RangeError('Invalid mission time');
  const observer: WorldVec3 = time < 5 ? [0, 0, 0] : [Math.min(12, (time - 5) * 2), 1, 3];
  const range = (p: WorldVec3) => Math.hypot(...p.map((v, i) => v - observer[i]!));
  const island = (id: string, p: WorldVec3) => ({ id, worldPosition: p, range: range(p) });
  const islands = [island('ISLAND 01', [8, 3, -16])];
  if (time >= 1 && time < 5) islands.push(island('ISLAND 02', [-23, 6, 5]));
  if (time >= 6) islands.push(island('ISLAND 03', [27, -3, 19]));
  if (time >= 8) islands.push(island('ISLAND 04', [35, 9, -24]));
  // Deliberate loss of visibility, re-observation, smooth movement, then changing motion.
  const x = time < 10 ? 17 : time <= 21 ? 17 + (time - 10) * 1.6 : 34.6 + Math.sin((time - 21) * 9) * 4;
  const entry: WorldVec3 = [x, 5, 6];
  const exit: WorldVec3 = [43, 13, -19];
  const visible = time >= 2 && (time < 5 || (time >= 10 && time < 22.5) || (time >= 23 && time < 24));
  return {
    contractVersion: 1, time, observerWorldPosition: observer, sensorRange: 60,
    local: { gravity: [0.8, -0.32, 0.24], hazard: 0.2 + Math.min(time, 24) * 0.012 },
    islands,
    connections: visible ? [{ id: 'FOLD 01', state: time < 10.25 ? 'open' : 'unstable', entryWorldPosition: entry, exitWorldPosition: exit, range: Math.min(range(entry), range(exit)) }] : [],
  };
}

/** Authored, simulated scene objects of the replay fixture (the replay's own small "world", like its authored islands).
 * They are never visible to ATLAS directly: only a proximity scan from the authored observer path can acquire them. */
interface SimGroup {
  readonly id: string; readonly centre: WorldVec3; readonly spread: number;
  readonly items: readonly (readonly [SceneCategory, SceneFamily, string, number])[];
}
const SIM_GROUPS: readonly SimGroup[] = [
  { id: 'concrete', centre: [-30, 2, -18], spread: 4.5, items: [['concrete', 'concrete', 'concrete_chunk_a', 1.1], ['concrete', 'concrete', 'concrete_chunk_b', 1.3], ['rubble', 'concrete', 'concrete_rubble_cluster_a', 1.0], ['concrete', 'concrete', 'concrete_slab_plain', 2.1], ['rubble', 'concrete', 'concrete_rubble_cluster_b', 0.9], ['concrete', 'concrete', 'concrete_chunk_c', 1.2]] },
  { id: 'armour', centre: [-8, -6, 30], spread: 3.2, items: [['baymax', 'baymax', 'baymax_chest_armor', 0.9], ['baymax', 'baymax', 'baymax_shoulder_shell', 0.7], ['baymax', 'baymax', 'baymax_forearm_shell', 0.6], ['baymax', 'baymax', 'baymax_plating_shard', 0.5]] },
  { id: 'swarm', centre: [25, 8, 20], spread: 0.1, items: [['microbot', 'microbot', 'microbot_swarm', 3.2]] },
  { id: 'industrial', centre: [50, 4, 6], spread: 4.2, items: [['steel', 'industrial', 'industrial_ibeam_twisted', 2.2], ['pipe', 'industrial', 'industrial_pipe_large_fractured', 1.6], ['scaffold', 'industrial', 'industrial_scaffold_section', 2.4], ['walkway', 'industrial', 'industrial_walkway_torn', 2.0], ['steel', 'industrial', 'industrial_ibeam_bolted', 2.0]] },
  { id: 'capsule', centre: [44, -2, -14], spread: 0.1, items: [['landmark', 'capsule', 'capsule_shell_remnant', 2.6]] },
];
function authoredWorld(): SceneObjectObservation[] {
  const out: SceneObjectObservation[] = [];
  for (const g of SIM_GROUPS) {
    g.items.forEach(([category, family, kind, radius], i) => {
      const a = (i * 2.399963) % (Math.PI * 2), r = g.spread * (0.35 + ((i * 0.37) % 0.65));
      out.push({
        id: `sim-${g.id}-${i + 1}`, category, family, kind, radius, range: 0,
        position: [g.centre[0] + Math.cos(a) * r, g.centre[1] + Math.sin(i * 1.7) * g.spread * 0.4, g.centre[2] + Math.sin(a) * r],
      });
    });
  }
  return out;
}
const SIM_WORLD = authoredWorld();
export const MISSION_SCAN_RANGE = 45;

/** Proximity scan of the authored objects from the authored observer path: the same acquisition rule as the live scanner. */
export function missionScan(tick: number): SceneScan | null {
  if (tick % 2 !== 0) return null; // 2 Hz, like the live continuous scanner
  const o = missionObservation(tick / 4).observerWorldPosition;
  const objects = SIM_WORLD
    .map(w => ({ ...w, range: Math.hypot(w.position[0] - o[0], w.position[1] - o[1], w.position[2] - o[2]) }))
    .filter(w => w.range <= MISSION_SCAN_RANGE).sort((a, b) => a.range - b.range);
  return { scanId: tick / 2 + 1, time: tick / 4, observerPosition: o, range: MISSION_SCAN_RANGE, coverage: 'proximity-sphere', trigger: 'continuous', objects, omitted: 0 };
}

/** Only chronological quarter-second deliveries reach the actual hardened runtime and the scene-object memory.
 * Arrival time is deterministic replay metadata, separate from presentation time.
 * Seeking backwards discards the entire runtime, scene memory, activity and all archived forecasts. */
export class MissionReplay {
  private runtime = new AtlasRuntime();
  private memory = new SceneObjectMemory();
  private tick = -1;
  private published: PublishedPosition[] = [];
  private activity: ActivityEntry[] = [];
  private pulses: ScanPulse[] = [];
  private nextActivity = 1;
  private lastEventId = 0;
  private knownEntities = new Set<string>();
  private view = this.runtime.getView(0);
  private cached: KnowledgeSnapshot | null = null;

  /** Discards everything delivered so far: the state before the first observation. */
  reset(): AtlasView {
    this.runtime = new AtlasRuntime(); this.memory.reset(); this.tick = -1; this.published = []; this.view = this.runtime.getView(0);
    this.activity = []; this.pulses = []; this.nextActivity = 1; this.lastEventId = 0; this.knownEntities = new Set(); this.cached = null;
    return this.view;
  }

  seek(time: number): AtlasView {
    if (!Number.isFinite(time) || time < 0 || time > MISSION_DURATION) throw new RangeError('Invalid replay cursor');
    const target = Math.floor(time * 4 + 1e-9);
    if (target < this.tick) this.reset();
    while (this.tick < target) {
      this.tick++;
      const sim = this.tick / 4, atS = simToClock(sim);
      this.view = this.runtime.receive(missionObservation(sim), this.tick * 250);
      for (const fold of this.view.temporal.folds) {
        if (fold.entry.forecast) this.published.push({ key: fold.entry.key, forecast: fold.entry.forecast });
      }
      for (const e of this.view.events.slice().reverse()) {
        if (e.id <= this.lastEventId) continue;
        const entry = activityFromRuntimeEvent(e, this.view, atS, this.nextActivity);
        if (entry) { this.activity.push(entry); this.nextActivity += 1; }
      }
      this.lastEventId = Math.max(this.lastEventId, ...this.view.events.map(e => e.id), 0);
      let pulse = this.tick === 0;
      for (const e of [...this.view.mapping.islands, ...this.view.mapping.folds]) if (!this.knownEntities.has(e.id)) { this.knownEntities.add(e.id); pulse = true; }
      const scan = missionScan(this.tick);
      if (scan) {
        const events = this.memory.update(scan);
        const changes = events.filter(e => e.kind !== 'scene-scan-unchanged' && e.kind !== 'scene-scan-empty');
        for (const e of changes) { this.activity.push(activityFromSceneEvent(e, atS, this.nextActivity)); this.nextActivity += 1; }
        if (changes.some(e => e.kind === 'scene-objects-acquired')) pulse = true;
      }
      const lastPulse = this.pulses.at(-1);
      if (pulse && (!lastPulse || atS - lastPulse.atS >= 2.5)) this.pulses.push({ atS, range: MISSION_SCAN_RANGE });
    }
    this.cached = null;
    return this.view;
  }
  readPublished(): readonly PublishedPosition[] { return this.published; }
  /** Number of observation ticks delivered so far. */
  get delivered(): number { return this.tick + 1; }

  /** Source-agnostic knowledge for the augmented stage. Times are on the presentation clock. */
  knowledge(): KnowledgeSnapshot {
    if (this.cached) return this.cached;
    const mem = this.memory.read();
    this.cached = {
      source: 'replay', view: this.view, scene: sceneKnowledge(mem.records, mem.scans), activity: this.activity.slice(-40), appear: new Map(),
      lastScanAtS: mem.lastScanTime === null ? null : simToClock(mem.lastScanTime), pulses: this.pulses.slice(-8),
    };
    return this.cached;
  }
}

/** Stage identity is a pure, monotone function of simulation time (the evidence a stage presents exists from its start;
 * see tests). It deliberately does not look at the knowledge state, so it can never step backwards while the mission plays forward. */
export function missionChapter(time: number): number {
  return stageAtSim(time);
}
