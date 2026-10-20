/** Shared contract between the dimension (Claude Code) and ATLAS (Codex).
 * Types only. Changing this file requires coordination between both agents
 * (see docs/PARALLEL_DEVELOPMENT.md). ATLAS consumes AtlasObservation values; it
 * never receives the field, its parameters, reference-space coordinates or any
 * future/lookahead simulation state. */

export type WorldVec3 = readonly [number, number, number];

/** Visible lifecycle label of a connection at the observation instant. */
export type ObservedConnectionState = 'inactive' | 'forming' | 'open' | 'unstable' | 'closing' | 'closed';

export interface ObservedIsland {
  readonly id: string;
  /** Mapped world position (rendering units) at the observation time. */
  readonly worldPosition: WorldVec3;
  readonly range: number;
}

export interface ObservedConnection {
  readonly id: string;
  readonly state: ObservedConnectionState;
  readonly entryWorldPosition: WorldVec3;
  readonly exitWorldPosition: WorldVec3;
  readonly range: number;
}

/** Local environment measured at the observer's own position. */
export interface LocalReading {
  /** Gravity anomaly expressed in world rendering units / model s². */
  readonly gravity: WorldVec3;
  /** Instability in [0, 1]. */
  readonly hazard: number;
}

export interface AtlasObservation {
  readonly contractVersion: 1;
  /** engine.clock.time at capture (model seconds). Observations cannot be taken at other times. */
  readonly time: number;
  readonly observerWorldPosition: WorldVec3;
  /** Sensor radius in rendering units; objects beyond it are absent. */
  readonly sensorRange: number;
  readonly local: LocalReading;
  /** Sorted by id; only those within sensorRange. */
  readonly islands: readonly ObservedIsland[];
  /** Sorted by id; only valid connections whose nearer endpoint is within sensorRange. */
  readonly connections: readonly ObservedConnection[];
}

export interface AtlasSensorOptions {
  readonly sensorRange?: number;
}

export const DEFAULT_SENSOR_RANGE = 60;
