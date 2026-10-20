import type { AtlasObservation, ObservedConnection, ObservedIsland, WorldVec3 } from '../../shared/atlasContract';

export interface IslandDiagnostic {
  readonly observed: ObservedIsland;
  readonly displacement: WorldVec3;
  readonly distance: number;
}

export interface ConnectionDiagnostic {
  readonly observed: ObservedConnection;
  readonly entryDistance: number;
  readonly exitDistance: number;
}

export interface CurrentDiagnostics {
  readonly observerPosition: WorldVec3;
  readonly gravityMagnitude: number;
  readonly hazard: number;
  readonly islands: readonly IslandDiagnostic[];
  readonly connections: readonly ConnectionDiagnostic[];
}

export function distanceBetween(a: WorldVec3, b: WorldVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function diagnose(observation: AtlasObservation): CurrentDiagnostics {
  const observer = observation.observerWorldPosition;
  const islands = observation.islands.map((observed) => Object.freeze({
    observed,
    displacement: Object.freeze([
      observed.worldPosition[0] - observer[0],
      observed.worldPosition[1] - observer[1],
      observed.worldPosition[2] - observer[2],
    ]) as WorldVec3,
    distance: distanceBetween(observer, observed.worldPosition),
  })).sort((a, b) => a.distance - b.distance || a.observed.id.localeCompare(b.observed.id));
  const connections = observation.connections.map((observed) => Object.freeze({
    observed,
    entryDistance: distanceBetween(observer, observed.entryWorldPosition),
    exitDistance: distanceBetween(observer, observed.exitWorldPosition),
  })).sort((a, b) => Math.min(a.entryDistance, a.exitDistance) - Math.min(b.entryDistance, b.exitDistance)
    || a.observed.id.localeCompare(b.observed.id));

  return Object.freeze({
    observerPosition: observer,
    gravityMagnitude: Math.hypot(...observation.local.gravity),
    hazard: observation.local.hazard,
    islands: Object.freeze(islands),
    connections: Object.freeze(connections),
  });
}
