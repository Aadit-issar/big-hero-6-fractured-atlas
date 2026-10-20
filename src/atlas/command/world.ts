import type { ObservedConnectionState } from '../../shared/atlasContract';
import type { ClockReport, PoseReport, QuatTuple } from '../../shared/liveLink';
import type { FrameMessage, ObservedIslandForm } from '../live/protocol';
import type { TrackSample } from '../challenge/types';

/** What ATLAS knows about the world, built only from accepted frames of one Dimension session.
 *
 * Every entity keeps a chronological track of timestamped observed positions. An entity is CURRENT when the latest observation of its
 * source (the sensor frame for islands and folds, the latest scan for scene objects) contained it, and REMEMBERED otherwise: its position
 * is then last-known and may be wrong. Nothing here is ever extrapolated; forecasts live in forecast.ts and are always labelled predicted. */

export type Vec3 = readonly [number, number, number];
export type EntityKind = 'island' | 'fold' | 'capsule' | 'equipment' | 'debris' | 'wreckage' | 'swarm';
export type Knowledge = 'current' | 'remembered';

export interface Entity {
  readonly id: string;
  readonly kind: EntityKind;
  /** Registry asset id of the physical model, when it is a scene object; folds and islands have their own representations. */
  readonly assetId: string | null;
  readonly label: string;
  readonly position: Vec3;
  /** Fold exit: observed alongside the entrance. Where it leads is not observed. */
  readonly exitPosition: Vec3 | null;
  readonly foldState: ObservedConnectionState | null;
  readonly orientation: QuatTuple | null;
  /** Bounding radius (m): the scene object's measured radius, or ATLAS's assumed bound for islands and folds. */
  readonly radius: number;
  readonly island: ObservedIslandForm | null;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly knowledge: Knowledge;
  readonly observations: number;
}

interface Mutable {
  id: string; kind: EntityKind; assetId: string | null; label: string; position: Vec3; exitPosition: Vec3 | null; foldState: ObservedConnectionState | null;
  orientation: QuatTuple | null; radius: number; island: ObservedIslandForm | null; firstSeen: number; lastSeen: number; knowledge: Knowledge; observations: number;
}

export const ASSUMED_ISLAND_BOUND = 6;
export const ASSUMED_FOLD_BOUND = 2;
const MAX_TRACK = 900;

const KIND_OF_FAMILY: Record<string, EntityKind> = { capsule: 'capsule', baymax: 'equipment', industrial: 'debris', concrete: 'wreckage', microbot: 'swarm' };

/** Entities named by the Dimension that carry a stable identity beyond a position: they get a human label from the scan. */
function labelFor(id: string, kind: EntityKind, assetId: string | null, given: string | undefined): string {
  if (given) return given;
  if (kind === 'island') return `Floating ${id.replace('island-', 'Island ')}`;
  if (kind === 'fold') return `Fold ${id}`;
  const pretty = (assetId ?? kind).replace(/_/g, ' ');
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

export class WorldMemory {
  private entities = new Map<string, Mutable>();
  private tracks = new Map<string, TrackSample[]>();
  private latestPose: PoseReport | null = null;
  private latestClock: ClockReport | null = null;
  private latestFrameSim = -Infinity;
  private rejected = { outOfOrder: 0 };

  reset(): void { this.entities.clear(); this.tracks.clear(); this.latestPose = null; this.latestClock = null; this.latestFrameSim = -Infinity; this.rejected = { outOfOrder: 0 }; }

  get pose(): PoseReport | null { return this.latestPose; }
  get clock(): ClockReport | null { return this.latestClock; }
  /** Simulation time of the newest accepted frame: ATLAS's only notion of "now". */
  get now(): number { return Number.isFinite(this.latestFrameSim) ? this.latestFrameSim : 0; }
  get outOfOrderRejected(): number { return this.rejected.outOfOrder; }

  entity(id: string): Entity | undefined { return this.entities.get(id); }
  all(): Entity[] { return [...this.entities.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }
  track(id: string): readonly TrackSample[] { return this.tracks.get(id) ?? []; }

  private touch(id: string, init: () => Mutable, time: number, position: Vec3): Mutable {
    let e = this.entities.get(id);
    if (!e) { e = init(); this.entities.set(id, e); }
    e.lastSeen = time; e.position = position; e.knowledge = 'current'; e.observations += 1;
    const track = this.tracks.get(id) ?? [];
    const last = track.at(-1);
    if (!last || time > last.time + 1e-9) { track.push({ time, position }); if (track.length > MAX_TRACK) track.splice(0, track.length - MAX_TRACK); }
    else if (time < last.time - 1e-9) this.rejected.outOfOrder += 1;
    this.tracks.set(id, track);
    return e;
  }

  /** Ingest one accepted frame. Frames older than the newest one already accepted are ignored (never reordered into the history). */
  ingest(frame: FrameMessage): { newEntities: string[]; stale: boolean } {
    const time = frame.observation.time;
    if (time < this.latestFrameSim - 1e-9) { this.rejected.outOfOrder += 1; return { newEntities: [], stale: true }; }
    const before = new Set(this.entities.keys());
    this.latestFrameSim = time; this.latestPose = frame.pose; this.latestClock = frame.clock;

    const current = new Set<string>();
    for (const island of frame.observation.islands) {
      const e = this.touch(island.id, () => ({ id: island.id, kind: 'island', assetId: null, label: labelFor(island.id, 'island', null, undefined), position: island.worldPosition, exitPosition: null, foldState: null, orientation: null, radius: ASSUMED_ISLAND_BOUND, island: null, firstSeen: time, lastSeen: time, knowledge: 'current', observations: 0 }), time, island.worldPosition);
      void e; current.add(island.id);
    }
    for (const c of frame.observation.connections) {
      const e = this.touch(c.id, () => ({ id: c.id, kind: 'fold', assetId: null, label: labelFor(c.id, 'fold', null, undefined), position: c.entryWorldPosition, exitPosition: c.exitWorldPosition, foldState: c.state, orientation: null, radius: ASSUMED_FOLD_BOUND, island: null, firstSeen: time, lastSeen: time, knowledge: 'current', observations: 0 }), time, c.entryWorldPosition);
      e.exitPosition = c.exitWorldPosition; e.foldState = c.state; current.add(c.id);
    }
    if (frame.scan) {
      const scan = frame.scan;
      for (const form of scan.islandForms ?? []) { const e = this.entities.get(form.id); if (e) { e.island = form; e.radius = Math.max(ASSUMED_ISLAND_BOUND * 0.5, form.radius + form.height * 0.5); } }
      for (const o of scan.objects) {
        const kind = KIND_OF_FAMILY[o.family] ?? 'wreckage';
        const e = this.touch(o.id, () => ({ id: o.id, kind, assetId: o.kind, label: labelFor(o.id, kind, o.kind, o.label), position: o.position, exitPosition: null, foldState: null, orientation: o.orientation ?? null, radius: o.radius, island: null, firstSeen: time, lastSeen: time, knowledge: 'current', observations: 0 }), scan.time, o.position);
        if (o.orientation) e.orientation = o.orientation;
        current.add(o.id);
      }
      // Scene objects not in the latest scan are remembered (they left sensor range or the scan did not reach them).
      for (const e of this.entities.values()) if (e.kind !== 'island' && e.kind !== 'fold' && !current.has(e.id)) e.knowledge = 'remembered';
    }
    // Islands and folds are in every frame: absent from this one means out of sensor range.
    for (const e of this.entities.values()) if ((e.kind === 'island' || e.kind === 'fold') && !current.has(e.id)) e.knowledge = 'remembered';
    return { newEntities: [...this.entities.keys()].filter(id => !before.has(id)), stale: false };
  }

  /** Snapshot of entities with immutable fields. */
  snapshot(): Entity[] { return this.all().map(e => ({ ...e })); }
}
