import type { AtlasObservation } from '../../shared/atlasContract';

export type AtlasEventKind =
  | 'first-observation' | 'session-reset' | 'island-entered' | 'island-left'
  | 'fold-entered' | 'fold-left' | 'fold-state-changed' | 'hazard-reading-changed'
  | 'island-discovered' | 'island-reobserved' | 'island-position-changed'
  | 'fold-discovered' | 'fold-reobserved' | 'explorer-discontinuity'
  | 'sensor-unavailable' | 'sensor-recovered' | 'observation-rejected' | 'analytical-concern';

export interface AtlasEvent {
  readonly id: number;
  readonly kind: AtlasEventKind;
  readonly simulationTime: number | null;
  readonly message: string;
}

function compareIds(before: readonly { readonly id: string }[], after: readonly { readonly id: string }[]): { entered: string[]; left: string[] } {
  const previous = new Set(before.map(({ id }) => id));
  const next = new Set(after.map(({ id }) => id));
  return {
    entered: after.filter(({ id }) => !previous.has(id)).map(({ id }) => id),
    left: before.filter(({ id }) => !next.has(id)).map(({ id }) => id),
  };
}

/** Changes are emitted only from two accepted snapshots in the same session. */
export function compareObservations(previous: AtlasObservation | null, next: AtlasObservation): Omit<AtlasEvent, 'id'>[] {
  if (!previous) return [{ kind: 'first-observation', simulationTime: next.time, message: 'First valid sensor observation received.' }];
  const events: Omit<AtlasEvent, 'id'>[] = [];
  const islandChanges = compareIds(previous.islands, next.islands);
  for (const id of islandChanges.entered) events.push({ kind: 'island-entered', simulationTime: next.time, message: `Island ${id} entered the observed set.` });
  for (const id of islandChanges.left) events.push({ kind: 'island-left', simulationTime: next.time, message: `Island ${id} left the observed set.` });

  const foldChanges = compareIds(previous.connections, next.connections);
  for (const id of foldChanges.entered) events.push({ kind: 'fold-entered', simulationTime: next.time, message: `Fold ${id} entered the observed set.` });
  for (const id of foldChanges.left) events.push({ kind: 'fold-left', simulationTime: next.time, message: `Fold ${id} left the observed set.` });

  const previousFolds = new Map(previous.connections.map((connection) => [connection.id, connection]));
  for (const connection of next.connections) {
    const before = previousFolds.get(connection.id);
    if (before && before.state !== connection.state) {
      events.push({ kind: 'fold-state-changed', simulationTime: next.time, message: `Fold ${connection.id} visible state changed: ${before.state} → ${connection.state}.` });
    }
  }

  if (Math.abs(previous.local.hazard - next.local.hazard) >= 0.05) {
    events.push({
      kind: 'hazard-reading-changed',
      simulationTime: next.time,
      message: `Local hazard reading changed from ${previous.local.hazard.toFixed(2)} to ${next.local.hazard.toFixed(2)}.`,
    });
  }
  return events;
}
