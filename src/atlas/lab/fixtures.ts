import type { AtlasObservation, WorldVec3 } from '../../shared/atlasContract';

/** Deterministic demonstration-only samples. Every UI route using this file is labeled FIXTURE. */
export function createFixtureObservation(time: number): AtlasObservation {
  const hazard = 0.57 + 0.035 * Math.sin(time * 1.7);
  return Object.freeze({
    contractVersion: 1,
    time,
    observerWorldPosition: Object.freeze([0, 0, 0]) as readonly [number, number, number],
    sensorRange: 60,
    local: Object.freeze({
      gravity: Object.freeze([0.82 + time * 0.006, -0.34, 0.27]) as readonly [number, number, number],
      hazard,
    }),
    islands: Object.freeze([
      Object.freeze({ id: 'island-07', worldPosition: Object.freeze([14, 3, -11]) as readonly [number, number, number], range: Math.hypot(14, 3, -11) }),
      Object.freeze({ id: 'island-12', worldPosition: Object.freeze([-26, 8, 17]) as readonly [number, number, number], range: Math.hypot(-26, 8, 17) }),
      Object.freeze({ id: 'island-18', worldPosition: Object.freeze([7, -6, 34]) as readonly [number, number, number], range: Math.hypot(7, -6, 34) }),
    ]),
    connections: Object.freeze([
      Object.freeze({
        id: 'fold-A3', state: 'open' as const,
        entryWorldPosition: Object.freeze([22, 4, 8]) as readonly [number, number, number],
        exitWorldPosition: Object.freeze([42, 10, -21]) as readonly [number, number, number],
        range: Math.hypot(22, 4, 8),
      }),
      Object.freeze({
        id: 'fold-C1', state: 'unstable' as const,
        entryWorldPosition: Object.freeze([-18, 3, 20]) as readonly [number, number, number],
        exitWorldPosition: Object.freeze([11, 17, 39]) as readonly [number, number, number],
        range: Math.hypot(-18, 3, 20),
      }),
    ]),
  });
}

const replayObserverPositions: readonly WorldVec3[] = [
  [0, 0, 0],
  [9, 1, 3],
  [18, 4, 7],
  [105, 31, -74],
  [111, 33, -69],
];

function rangeFrom(origin: WorldVec3, position: WorldVec3): number {
  return Math.hypot(position[0] - origin[0], position[1] - origin[1], position[2] - origin[2]);
}

function island(id: string, origin: WorldVec3, position: WorldVec3) {
  return Object.freeze({ id, worldPosition: Object.freeze([...position]) as unknown as WorldVec3, range: rangeFrom(origin, position) });
}

function fold(id: string, state: 'inactive' | 'forming' | 'open' | 'unstable' | 'closing' | 'closed', origin: WorldVec3, entry: WorldVec3, exit: WorldVec3) {
  return Object.freeze({
    id,
    state,
    entryWorldPosition: Object.freeze([...entry]) as unknown as WorldVec3,
    exitWorldPosition: Object.freeze([...exit]) as unknown as WorldVec3,
    range: Math.min(rangeFrom(origin, entry), rangeFrom(origin, exit)),
  });
}

/** Deterministic, explicitly labelled replay evidence for map interactions and tests. */
export function createReplayObservation(stage: number): AtlasObservation {
  const index = Math.max(0, Math.min(4, Math.floor(stage)));
  const time = index * 2;
  const observer = replayObserverPositions[index]!;
  const islandRecords = index === 0
    ? [island('island-A', observer, [12, 4, -10]), island('island-B', observer, [-22, 9, 13])]
    : index === 1
      ? [island('island-A', observer, [15, 5, -8]), island('island-C', observer, [23, -2, 14])]
      : index === 2
        ? [island('island-B', observer, [-16, 9, 11]), island('island-C', observer, [28, -1, 20])]
        : index === 3
          ? [island('island-D', observer, [116, 34, -77]), island('island-E', observer, [86, 25, -55])]
          : [island('island-A', observer, [124, 40, -78]), island('island-D', observer, [117, 35, -76])];
  const foldRecords = index === 0
    ? [fold('fold-A', 'open', observer, [24, 5, 8], [114, 32, -76])]
    : index === 1
      ? [fold('fold-A', 'unstable', observer, [25, 5, 9], [116, 34, -74])]
      : index === 2
        ? [fold('fold-B', 'forming', observer, [26, 8, 9], [129, 43, -88])]
        : index === 3
          ? [fold('fold-B', 'open', observer, [109, 33, -72], [17, 6, 12])]
          : [fold('fold-A', 'closed', observer, [120, 35, -65], [18, 5, 10])];

  return Object.freeze({
    contractVersion: 1,
    time,
    observerWorldPosition: Object.freeze([...observer]) as unknown as WorldVec3,
    sensorRange: 60,
    local: Object.freeze({ gravity: Object.freeze([0.8 + index * 0.14, -0.32 + index * 0.03, 0.24]) as WorldVec3, hazard: [0.24, 0.36, 0.51, 0.44, 0.67][index]! }),
    islands: Object.freeze(islandRecords),
    connections: Object.freeze(foldRecords),
  });
}

export const REPLAY_STAGE_COUNT = 5;

/** Bounded deterministic time series for analytical verification; never a live-world observation. */
export function createTemporalObservation(time: number): AtlasObservation {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Temporal fixture time must be nonnegative and finite.');
  const x = time <= 8 ? 12 + time * 0.7 : time <= 9 ? 17.6 - (time - 8) * 2 : time <= 12 ? 15.6 - (time - 9) * 1.1 : 12.3;
  const hazard = Math.min(0.7, 0.42 + Math.min(time, 20) * 0.014);
  const states = ['open', 'unstable', 'open', 'forming'] as const;
  const state = states[Math.floor(time / 2) % states.length]!;
  const observer: WorldVec3 = [0, 0, 0];
  return Object.freeze({
    contractVersion: 1, time, observerWorldPosition: Object.freeze(observer), sensorRange: 60,
    local: Object.freeze({ gravity: Object.freeze([0.8 + Math.min(time, 20) * 0.02, -0.3, 0.25]) as WorldVec3, hazard }),
    islands: Object.freeze([island('island-temporal-A', observer, [15 + Math.min(time, 20) * 0.2, 5, -4])]),
    connections: Object.freeze([fold('fold-temporal-A', state, observer, [x, 3, 8], [42 + Math.min(time, 20) * 0.4, 12, -18])]),
  });
}

/** Bounded map-density fixture for visual and browser performance checks; never used in live mode. */
export function createStressObservation(): AtlasObservation {
  const observer: WorldVec3 = [0, 0, 0];
  const sphericalPosition = (index: number, minimumRadius: number, radiusSpan: number): WorldVec3 => {
    const radius = minimumRadius + (index * 17 % 100) / 100 * radiusSpan;
    const azimuth = index * 2.399963229728653;
    const elevation = Math.asin((((index * 29) % 101) / 100) * 1.6 - 0.8);
    return [radius * Math.cos(azimuth) * Math.cos(elevation), radius * Math.sin(elevation), radius * Math.sin(azimuth) * Math.cos(elevation)];
  };
  const islands = Object.freeze(Array.from({ length: 128 }, (_, index) => {
    const position = sphericalPosition(index, 8, 46);
    return island('fixture-island-' + String(index + 1).padStart(3, '0'), observer, position);
  }));
  const connections = Object.freeze(Array.from({ length: 32 }, (_, index) => {
    const entry = sphericalPosition(index + 11, 14, 38);
    const exit: WorldVec3 = [110 + index * 2, 28 + index % 9, -95 + index * 3];
    const states = ['forming', 'open', 'unstable', 'closing'] as const;
    return fold('fixture-fold-' + String(index + 1).padStart(2, '0'), states[index % states.length]!, observer, entry, exit);
  }));
  return Object.freeze({
    contractVersion: 1,
    time: 0,
    observerWorldPosition: Object.freeze([0, 0, 0]) as WorldVec3,
    sensorRange: 60,
    local: Object.freeze({ gravity: Object.freeze([0.25, -0.62, 0.14]) as WorldVec3, hazard: 0.42 }),
    islands,
    connections,
  });
}
