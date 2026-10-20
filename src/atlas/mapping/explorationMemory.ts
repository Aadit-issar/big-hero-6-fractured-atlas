import type { AtlasObservation, ObservedConnectionState, WorldVec3 } from '../../shared/atlasContract';

export type KnowledgeStatus = 'currently-observed' | 'previously-observed';
export type KnowledgeFreshness = 'current' | 'recent' | 'stale';

export interface PositionSample {
  readonly time: number;
  readonly position: WorldVec3;
  /** A large observed jump breaks a displayed line; it does not explain the jump. */
  readonly breakBefore: boolean;
}

export interface IslandMemoryRecord {
  readonly id: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly firstPosition: WorldVec3;
  readonly lastKnownPosition: WorldVec3;
  readonly currentPosition: WorldVec3 | null;
  readonly currentlyObserved: boolean;
  readonly knowledgeStatus: KnowledgeStatus;
  readonly freshness: KnowledgeFreshness;
  readonly observationCount: number;
  readonly lastReportedRange: number;
  readonly track: readonly PositionSample[];
}

export interface FoldMemoryRecord {
  readonly id: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly firstEntryPosition: WorldVec3;
  readonly firstExitPosition: WorldVec3;
  readonly lastKnownEntryPosition: WorldVec3;
  readonly lastKnownExitPosition: WorldVec3;
  readonly currentEntryPosition: WorldVec3 | null;
  readonly currentExitPosition: WorldVec3 | null;
  readonly currentlyObserved: boolean;
  readonly knowledgeStatus: KnowledgeStatus;
  readonly freshness: KnowledgeFreshness;
  readonly lastObservedState: ObservedConnectionState;
  /** Null means no fold-state measurement exists in the latest accepted observation. */
  readonly currentState: ObservedConnectionState | null;
  readonly observationCount: number;
  readonly directionality: 'unknown';
  readonly provenance: 'sensor-reported';
  /** The sensor reports an endpoint coordinate; it does not confirm independent exploration there. */
  readonly remoteEndpointIndependentlyObserved: false;
  readonly track: readonly {
    readonly time: number;
    readonly entryPosition: WorldVec3;
    readonly exitPosition: WorldVec3;
    readonly state: ObservedConnectionState;
  }[];
}

export interface ExplorerMemory {
  readonly firstPosition: WorldVec3 | null;
  readonly latestPosition: WorldVec3 | null;
  readonly lastSeenAt: number | null;
  readonly observationCount: number;
  readonly track: readonly PositionSample[];
}

export interface EnvironmentalMemorySample {
  readonly time: number;
  readonly observerWorldPosition: WorldVec3;
  readonly gravity: WorldVec3;
  readonly gravityMagnitude: number;
  readonly hazard: number;
  readonly visibleIslandCount: number;
  readonly visibleFoldCount: number;
  /** True if a bounded-history trim removed intervening samples. */
  readonly breakBefore: boolean;
}

export type TopologyNode =
  | { readonly id: string; readonly kind: 'island'; readonly entityId: string; readonly position: WorldVec3; readonly currentlyObserved: boolean }
  | { readonly id: string; readonly kind: 'fold-entry'; readonly entityId: string; readonly position: WorldVec3; readonly relationCurrentlyObserved: boolean }
  | { readonly id: string; readonly kind: 'fold-exit'; readonly entityId: string; readonly position: WorldVec3; readonly relationCurrentlyObserved: boolean; readonly independentlyObserved: false };

export interface TopologyEdge {
  readonly id: string;
  readonly kind: 'sensor-reported-fold';
  readonly endpoints: readonly [string, string];
  readonly directionality: 'unknown';
  readonly provenance: 'sensor-reported';
  readonly currentlyObserved: boolean;
  readonly currentState: ObservedConnectionState | null;
  readonly lastObservedState: ObservedConnectionState;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface ExplorationSummary {
  readonly uniqueIslands: number;
  readonly uniqueFolds: number;
  readonly currentlyObservedIslands: number;
  readonly previouslyObservedIslands: number;
  readonly currentlyObservedFolds: number;
  readonly historicalFolds: number;
  readonly distinctExplorerSamples: number;
  readonly explorerTrackLength: number;
  readonly explorerSampledDisplacement: number;
  readonly environmentSampleCount: number;
  readonly evictedEntityRecords: number;
  readonly latestSimulationTime: number | null;
}

/** Immutable read model for later mapping, fold-analysis and route systems. */
export interface ExplorationMapSnapshot {
  readonly session: number;
  readonly latestSimulationTime: number | null;
  readonly islands: readonly IslandMemoryRecord[];
  readonly folds: readonly FoldMemoryRecord[];
  readonly explorer: ExplorerMemory;
  readonly environment: readonly EnvironmentalMemorySample[];
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly summary: ExplorationSummary;
}

export type MappingEventKind =
  | 'island-discovered'
  | 'island-reobserved'
  | 'island-position-changed'
  | 'fold-discovered'
  | 'fold-reobserved'
  | 'explorer-discontinuity';

export interface MappingEvent {
  readonly kind: MappingEventKind;
  readonly simulationTime: number;
  readonly message: string;
}

export interface ExplorationMemoryOptions {
  readonly maxEntityRecords?: number;
  readonly entityTrackLimit?: number;
  readonly explorerTrackLimit?: number;
  readonly environmentTrackLimit?: number;
  readonly positionChangeEventThreshold?: number;
  readonly discontinuityDistance?: number;
  readonly staleAfterSeconds?: number;
}

interface MutableIsland {
  id: string;
  firstSeenAt: number;
  lastSeenAt: number;
  firstPosition: WorldVec3;
  lastKnownPosition: WorldVec3;
  currentPosition: WorldVec3 | null;
  currentlyObserved: boolean;
  observationCount: number;
  lastCountedAt: number;
  lastReportedRange: number;
  track: PositionSample[];
  recency: number;
}

interface MutableFold {
  id: string;
  firstSeenAt: number;
  lastSeenAt: number;
  firstEntryPosition: WorldVec3;
  firstExitPosition: WorldVec3;
  lastKnownEntryPosition: WorldVec3;
  lastKnownExitPosition: WorldVec3;
  currentEntryPosition: WorldVec3 | null;
  currentExitPosition: WorldVec3 | null;
  currentlyObserved: boolean;
  lastObservedState: ObservedConnectionState;
  currentState: ObservedConnectionState | null;
  observationCount: number;
  lastCountedAt: number;
  track: { time: number; entryPosition: WorldVec3; exitPosition: WorldVec3; state: ObservedConnectionState }[];
  recency: number;
}

function distance3(a: WorldVec3, b: WorldVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function immutablePosition(position: WorldVec3): WorldVec3 {
  return Object.freeze([position[0], position[1], position[2]]) as WorldVec3;
}

function retainFirstAndRecent<T>(values: T[], limit: number): void {
  if (values.length <= limit) return;
  if (limit === 1) {
    const latest = values[values.length - 1]!;
    values.splice(0, values.length, latest);
    return;
  }
  values.splice(1, values.length - limit);
}

function retainPositionSamples(track: PositionSample[], limit: number): void {
  if (track.length <= limit) return;
  if (limit === 1) {
    const latest = track[track.length - 1]!;
    track.splice(0, track.length, latest);
    return;
  }
  track.splice(1, track.length - limit);
  const firstRecent = track[1];
  if (firstRecent) track[1] = Object.freeze({ ...firstRecent, breakBefore: true });
}

function freshness(currentlyObserved: boolean, latestTime: number, lastSeenAt: number, staleAfterSeconds: number): KnowledgeFreshness {
  if (currentlyObserved) return 'current';
  return latestTime - lastSeenAt > staleAfterSeconds ? 'stale' : 'recent';
}

/**
 * Bounded cumulative memory built only from validated, contract-compatible observations.
 * It deliberately stores evidence and relations, not simulation entities or a world model.
 */
export class ExplorationMemory {
  private readonly islandsById = new Map<string, MutableIsland>();
  private readonly foldsById = new Map<string, MutableFold>();
  private readonly maxEntityRecords: number;
  private readonly entityTrackLimit: number;
  private readonly explorerTrackLimit: number;
  private readonly environmentTrackLimit: number;
  private readonly positionChangeEventThreshold: number;
  private readonly discontinuityDistance: number;
  private readonly staleAfterSeconds: number;
  private serial = 0;
  private evictedEntityRecords = 0;
  private session = 1;
  private latestTime: number | null = null;
  private explorerFirstPosition: WorldVec3 | null = null;
  private explorerLastPosition: WorldVec3 | null = null;
  private explorerTrack: PositionSample[] = [];
  private explorerCount = 0;
  private explorerLastCountedAt: number | null = null;
  private environmentTrack: EnvironmentalMemorySample[] = [];
  private snapshotValue: ExplorationMapSnapshot;

  constructor(options: ExplorationMemoryOptions = {}) {
    this.maxEntityRecords = options.maxEntityRecords ?? 2048;
    this.entityTrackLimit = options.entityTrackLimit ?? 64;
    this.explorerTrackLimit = options.explorerTrackLimit ?? 512;
    this.environmentTrackLimit = options.environmentTrackLimit ?? 2048;
    this.positionChangeEventThreshold = options.positionChangeEventThreshold ?? 0.25;
    this.discontinuityDistance = options.discontinuityDistance ?? 75;
    this.staleAfterSeconds = options.staleAfterSeconds ?? 5;
    if (!Number.isInteger(this.maxEntityRecords) || this.maxEntityRecords < 1) throw new RangeError('Entity memory limit must be a positive integer.');
    if (!Number.isInteger(this.entityTrackLimit) || this.entityTrackLimit < 1) throw new RangeError('Entity track limit must be a positive integer.');
    if (!Number.isInteger(this.explorerTrackLimit) || this.explorerTrackLimit < 1) throw new RangeError('Explorer track limit must be a positive integer.');
    if (!Number.isInteger(this.environmentTrackLimit) || this.environmentTrackLimit < 1) throw new RangeError('Environment track limit must be a positive integer.');
    if (!Number.isFinite(this.positionChangeEventThreshold) || this.positionChangeEventThreshold < 0) throw new RangeError('Position event threshold must be non-negative and finite.');
    if (!Number.isFinite(this.discontinuityDistance) || this.discontinuityDistance <= 0) throw new RangeError('Discontinuity distance must be positive and finite.');
    if (!Number.isFinite(this.staleAfterSeconds) || this.staleAfterSeconds < 0) throw new RangeError('Stale interval must be non-negative and finite.');
    this.snapshotValue = this.makeSnapshot();
  }

  reset(session: number): void {
    this.islandsById.clear();
    this.foldsById.clear();
    this.serial = 0;
    this.evictedEntityRecords = 0;
    this.session = session;
    this.latestTime = null;
    this.explorerFirstPosition = null;
    this.explorerLastPosition = null;
    this.explorerTrack = [];
    this.explorerCount = 0;
    this.explorerLastCountedAt = null;
    this.environmentTrack = [];
    this.snapshotValue = this.makeSnapshot();
  }

  /** Apply one already validated observation. Equal simulation times replace that moment. */
  update(observation: AtlasObservation, session: number): readonly MappingEvent[] {
    if (session !== this.session || (this.latestTime !== null && observation.time < this.latestTime)) this.reset(session);
    this.session = session;
    const previousTime = this.latestTime;
    const newMoment = previousTime === null || observation.time > previousTime;
    const events: MappingEvent[] = [];
    const presentIslandIds = new Set(observation.islands.map((island) => island.id));
    const presentFoldIds = new Set(observation.connections.map((fold) => fold.id));

    for (const [id, record] of this.islandsById) {
      if (record.currentlyObserved && !presentIslandIds.has(id)) {
        record.currentlyObserved = false;
        record.currentPosition = null;
      }
    }
    for (const [id, record] of this.foldsById) {
      if (record.currentlyObserved && !presentFoldIds.has(id)) {
        record.currentlyObserved = false;
        record.currentState = null;
        record.currentEntryPosition = null;
        record.currentExitPosition = null;
      }
    }

    for (const measured of observation.islands) {
      const worldPosition = immutablePosition(measured.worldPosition);
      let record = this.islandsById.get(measured.id);
      if (!record) {
        this.makeRoom();
        record = {
          id: measured.id,
          firstSeenAt: observation.time,
          lastSeenAt: observation.time,
          firstPosition: worldPosition,
          lastKnownPosition: worldPosition,
          currentPosition: worldPosition,
          currentlyObserved: true,
          observationCount: 1,
          lastCountedAt: observation.time,
          lastReportedRange: measured.range,
          track: [{ time: observation.time, position: worldPosition, breakBefore: false }],
          recency: ++this.serial,
        };
        this.islandsById.set(measured.id, record);
        events.push({ kind: 'island-discovered', simulationTime: observation.time, message: 'Island ' + measured.id + ' discovered from a sensor observation.' });
      } else {
        if (!record.currentlyObserved && newMoment) {
          events.push({ kind: 'island-reobserved', simulationTime: observation.time, message: 'Previously recorded island ' + measured.id + ' observed again.' });
        }
        if (newMoment && distance3(record.lastKnownPosition, worldPosition) >= this.positionChangeEventThreshold
          && distance3(record.lastKnownPosition, worldPosition) > 0) {
          events.push({ kind: 'island-position-changed', simulationTime: observation.time, message: 'Observed position changed for island ' + measured.id + '.' });
        }
        const islandJump = distance3(record.lastKnownPosition, worldPosition);
        this.recordPosition(record.track, observation.time, worldPosition, islandJump > this.discontinuityDistance);
        if (newMoment && record.lastCountedAt !== observation.time) {
          record.observationCount += 1;
          record.lastCountedAt = observation.time;
        }
        record.lastSeenAt = observation.time;
        record.lastKnownPosition = worldPosition;
        record.currentPosition = worldPosition;
        record.currentlyObserved = true;
        record.lastReportedRange = measured.range;
        record.recency = ++this.serial;
      }
    }

    for (const measured of observation.connections) {
      const entryPosition = immutablePosition(measured.entryWorldPosition);
      const exitPosition = immutablePosition(measured.exitWorldPosition);
      let record = this.foldsById.get(measured.id);
      if (!record) {
        this.makeRoom();
        record = {
          id: measured.id,
          firstSeenAt: observation.time,
          lastSeenAt: observation.time,
          firstEntryPosition: entryPosition,
          firstExitPosition: exitPosition,
          lastKnownEntryPosition: entryPosition,
          lastKnownExitPosition: exitPosition,
          currentEntryPosition: entryPosition,
          currentExitPosition: exitPosition,
          currentlyObserved: true,
          lastObservedState: measured.state,
          currentState: measured.state,
          observationCount: 1,
          lastCountedAt: observation.time,
          track: [{ time: observation.time, entryPosition, exitPosition, state: measured.state }],
          recency: ++this.serial,
        };
        this.foldsById.set(measured.id, record);
        events.push({ kind: 'fold-discovered', simulationTime: observation.time, message: 'Fold ' + measured.id + ' recorded as a sensor-reported connection.' });
      } else {
        if (!record.currentlyObserved && newMoment) {
          events.push({ kind: 'fold-reobserved', simulationTime: observation.time, message: 'Previously recorded fold ' + measured.id + ' observed again.' });
        }
        this.recordFoldPosition(record.track, observation.time, entryPosition, exitPosition, measured.state);
        if (newMoment && record.lastCountedAt !== observation.time) {
          record.observationCount += 1;
          record.lastCountedAt = observation.time;
        }
        record.lastSeenAt = observation.time;
        record.lastKnownEntryPosition = entryPosition;
        record.lastKnownExitPosition = exitPosition;
        record.currentEntryPosition = entryPosition;
        record.currentExitPosition = exitPosition;
        record.lastObservedState = measured.state;
        record.currentState = measured.state;
        record.currentlyObserved = true;
        record.recency = ++this.serial;
      }
    }

    const observerPosition = immutablePosition(observation.observerWorldPosition);
    if (this.explorerLastPosition === null) {
      this.explorerFirstPosition = observerPosition;
      this.explorerLastPosition = observerPosition;
      this.explorerTrack = [{ time: observation.time, position: observerPosition, breakBefore: false }];
      this.explorerCount = 1;
      this.explorerLastCountedAt = observation.time;
    } else {
      const jump = distance3(this.explorerLastPosition, observerPosition);
      const breakBefore = jump > this.discontinuityDistance;
      if (newMoment && breakBefore) {
        events.push({ kind: 'explorer-discontinuity', simulationTime: observation.time, message: 'A large explorer position discontinuity was observed; no connecting path is assumed.' });
      }
      this.recordPosition(this.explorerTrack, observation.time, observerPosition, breakBefore, this.explorerTrackLimit);
      if (newMoment && this.explorerLastCountedAt !== observation.time) {
        this.explorerCount += 1;
        this.explorerLastCountedAt = observation.time;
      }
      this.explorerLastPosition = observerPosition;
    }

    this.recordEnvironment(observation, observerPosition);

    this.latestTime = observation.time;
    this.snapshotValue = this.makeSnapshot();
    return Object.freeze(events.map((event) => Object.freeze(event)));
  }

  /** Return an immutable snapshot; internal maps and mutable records never escape. */
  read(): ExplorationMapSnapshot { return this.snapshotValue; }

  private recordPosition(track: PositionSample[], time: number, position: WorldVec3, breakBefore = false, limit = this.entityTrackLimit): void {
    const last = track.at(-1);
    if (last?.time === time) {
      const previous = track.at(-2);
      const actualBreak = previous ? distance3(previous.position, position) > this.discontinuityDistance : false;
      track[track.length - 1] = Object.freeze({ time, position, breakBefore: actualBreak });
      return;
    }
    track.push(Object.freeze({ time, position, breakBefore }));
    retainPositionSamples(track, limit);
  }

  private recordFoldPosition(track: MutableFold['track'], time: number, entryPosition: WorldVec3, exitPosition: WorldVec3, state: ObservedConnectionState): void {
    const sample = Object.freeze({ time, entryPosition, exitPosition, state });
    const last = track.at(-1);
    if (last?.time === time) track[track.length - 1] = sample;
    else {
      track.push(sample);
      retainFirstAndRecent(track, this.entityTrackLimit);
    }
  }

  private recordEnvironment(observation: AtlasObservation, observerPosition: WorldVec3): void {
    const sample = Object.freeze({
      time: observation.time,
      observerWorldPosition: observerPosition,
      gravity: immutablePosition(observation.local.gravity),
      gravityMagnitude: Math.hypot(...observation.local.gravity),
      hazard: observation.local.hazard,
      visibleIslandCount: observation.islands.length,
      visibleFoldCount: observation.connections.length,
      breakBefore: false,
    });
    const last = this.environmentTrack.at(-1);
    if (last?.time === observation.time) {
      this.environmentTrack[this.environmentTrack.length - 1] = Object.freeze({ ...sample, breakBefore: last.breakBefore });
      return;
    }
    this.environmentTrack.push(sample);
    if (this.environmentTrack.length > this.environmentTrackLimit) {
      if (this.environmentTrackLimit === 1) this.environmentTrack.splice(0, this.environmentTrack.length - 1);
      else {
        this.environmentTrack.splice(1, this.environmentTrack.length - this.environmentTrackLimit);
        const firstRecent = this.environmentTrack[1];
        if (firstRecent) this.environmentTrack[1] = Object.freeze({ ...firstRecent, breakBefore: true });
      }
    }
  }

  private makeRoom(): void {
    if (this.islandsById.size + this.foldsById.size < this.maxEntityRecords) return;
    let candidate: { kind: 'island' | 'fold'; id: string; recency: number } | null = null;
    for (const record of this.islandsById.values()) {
      if (!candidate || record.recency < candidate.recency || (record.recency === candidate.recency && ('island:' + record.id).localeCompare(candidate.kind + ':' + candidate.id) < 0)) {
        candidate = { kind: 'island', id: record.id, recency: record.recency };
      }
    }
    for (const record of this.foldsById.values()) {
      if (!candidate || record.recency < candidate.recency || (record.recency === candidate.recency && ('fold:' + record.id).localeCompare(candidate.kind + ':' + candidate.id) < 0)) {
        candidate = { kind: 'fold', id: record.id, recency: record.recency };
      }
    }
    if (!candidate) return;
    if (candidate.kind === 'island') this.islandsById.delete(candidate.id);
    else this.foldsById.delete(candidate.id);
    this.evictedEntityRecords += 1;
  }

  private makeSnapshot(): ExplorationMapSnapshot {
    const latestTime = this.latestTime;
    const islands: IslandMemoryRecord[] = [...this.islandsById.values()].map((record) => Object.freeze({
      id: record.id,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      firstPosition: record.firstPosition,
      lastKnownPosition: record.lastKnownPosition,
      currentPosition: record.currentPosition,
      currentlyObserved: record.currentlyObserved,
      knowledgeStatus: record.currentlyObserved ? 'currently-observed' : 'previously-observed',
      freshness: freshness(record.currentlyObserved, latestTime ?? record.lastSeenAt, record.lastSeenAt, this.staleAfterSeconds),
      observationCount: record.observationCount,
      lastReportedRange: record.lastReportedRange,
      track: Object.freeze([...record.track]),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const folds: FoldMemoryRecord[] = [...this.foldsById.values()].map((record) => Object.freeze({
      id: record.id,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      firstEntryPosition: record.firstEntryPosition,
      firstExitPosition: record.firstExitPosition,
      lastKnownEntryPosition: record.lastKnownEntryPosition,
      lastKnownExitPosition: record.lastKnownExitPosition,
      currentEntryPosition: record.currentEntryPosition,
      currentExitPosition: record.currentExitPosition,
      currentlyObserved: record.currentlyObserved,
      knowledgeStatus: record.currentlyObserved ? 'currently-observed' : 'previously-observed',
      freshness: freshness(record.currentlyObserved, latestTime ?? record.lastSeenAt, record.lastSeenAt, this.staleAfterSeconds),
      lastObservedState: record.lastObservedState,
      currentState: record.currentState,
      observationCount: record.observationCount,
      directionality: 'unknown',
      provenance: 'sensor-reported',
      remoteEndpointIndependentlyObserved: false,
      track: Object.freeze([...record.track]),
    })).sort((a, b) => a.id.localeCompare(b.id));

    const nodes: TopologyNode[] = [];
    for (const island of islands) nodes.push(Object.freeze({ id: 'island:' + island.id, kind: 'island', entityId: island.id, position: island.lastKnownPosition, currentlyObserved: island.currentlyObserved }));
    for (const fold of folds) {
      nodes.push(Object.freeze({ id: 'fold-entry:' + fold.id, kind: 'fold-entry', entityId: fold.id, position: fold.lastKnownEntryPosition, relationCurrentlyObserved: fold.currentlyObserved }));
      nodes.push(Object.freeze({ id: 'fold-exit:' + fold.id, kind: 'fold-exit', entityId: fold.id, position: fold.lastKnownExitPosition, relationCurrentlyObserved: fold.currentlyObserved, independentlyObserved: false }));
    }
    const edges: TopologyEdge[] = folds.map((fold) => Object.freeze({
      id: 'fold-relation:' + fold.id,
      kind: 'sensor-reported-fold',
      endpoints: Object.freeze(['fold-entry:' + fold.id, 'fold-exit:' + fold.id]) as readonly [string, string],
      directionality: 'unknown',
      provenance: 'sensor-reported',
      currentlyObserved: fold.currentlyObserved,
      currentState: fold.currentState,
      lastObservedState: fold.lastObservedState,
      firstSeenAt: fold.firstSeenAt,
      lastSeenAt: fold.lastSeenAt,
    }));
    const explorer = Object.freeze({
      firstPosition: this.explorerFirstPosition,
      latestPosition: this.explorerLastPosition,
      lastSeenAt: latestTime,
      observationCount: this.explorerCount,
      track: Object.freeze([...this.explorerTrack]),
    });
    const summary = Object.freeze({
      uniqueIslands: islands.length,
      uniqueFolds: folds.length,
      currentlyObservedIslands: islands.filter((record) => record.currentlyObserved).length,
      previouslyObservedIslands: islands.filter((record) => !record.currentlyObserved).length,
      currentlyObservedFolds: folds.filter((record) => record.currentlyObserved).length,
      historicalFolds: folds.filter((record) => !record.currentlyObserved).length,
      distinctExplorerSamples: this.explorerCount,
      explorerTrackLength: this.explorerTrack.length,
      explorerSampledDisplacement: this.explorerTrack.reduce((total, sample, index) => {
        if (index === 0 || sample.breakBefore) return total;
        const previous = this.explorerTrack[index - 1];
        return previous ? total + distance3(previous.position, sample.position) : total;
      }, 0),
      environmentSampleCount: this.environmentTrack.length,
      evictedEntityRecords: this.evictedEntityRecords,
      latestSimulationTime: latestTime,
    });
    return Object.freeze({
      session: this.session,
      latestSimulationTime: latestTime,
      islands: Object.freeze(islands),
      folds: Object.freeze(folds),
      explorer,
      environment: Object.freeze([...this.environmentTrack]),
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      summary,
    });
  }
}
