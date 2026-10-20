import { ISLAND_COUNT } from './constants';
import { createSeededRandom, seedToUint32 } from './seededRandom';
import type { IslandDefinition, Vec3, WorldDefinition } from './types';

const ANCHORS: readonly Vec3[] = [
  [-0.2, -0.15, 0.1],
  [-2.8, 0.5, -1.7],
  [2.5, -0.4, -2.6],
  [-4.8, 1.1, -4.3],
  [0.2, 0.75, -5.2],
  [4.3, -0.6, -5.9],
  [-2.4, -1.35, -7.4],
  [2.1, 0.1, -8.7],
  [-6.2, -0.3, -9.4],
  [5.4, 1.2, -10.1],
  [-0.3, 2.1, -12.3],
  [-7.4, 0.65, -13.2],
  [7.8, -1.15, -14.4],
  [3.1, 2.3, -16.3],
];

const COLORS = ['#a8c8df', '#a5a5c9', '#87c4c9', '#b3a4c5', '#94b5d0', '#a8bbb2'] as const;

function mixSeed(seed: number): number {
  return (seed ^ 0x9e3779b9) >>> 0;
}

export function createWorld(seed: number): WorldDefinition {
  const normalizedSeed = seedToUint32(seed);
  const random = createSeededRandom(mixSeed(normalizedSeed));
  const islands: IslandDefinition[] = ANCHORS.map((anchor, index) => {
    const position: Vec3 = [
      anchor[0] + (random() - 0.5) * 0.65,
      anchor[1] + (random() - 0.5) * 0.55,
      anchor[2] + (random() - 0.5) * 0.75,
    ];
    const radius = index === 0 ? 4.35 : 2.2 + random() * 1.65;

    return {
      id: `island-${String(index + 1).padStart(2, '0')}`,
      referencePosition: position,
      radius,
      height: 1.2 + random() * 1.45,
      facetSeed: Math.floor(random() * 0xffff_ffff),
      color: COLORS[Math.floor(random() * COLORS.length)]!,
    };
  });

  return { seed: normalizedSeed, islands };
}

export function assertWorldIsDeterministic(world: WorldDefinition): void {
  if (world.islands.length !== ISLAND_COUNT) {
    throw new RangeError(`Expected ${ISLAND_COUNT} islands, received ${world.islands.length}.`);
  }

  for (const island of world.islands) {
    if (!island.referencePosition.every(Number.isFinite)
      || !Number.isFinite(island.radius)
      || !Number.isFinite(island.height)) {
      throw new RangeError(`Island ${island.id} contains non-finite generation data.`);
    }
  }
}
