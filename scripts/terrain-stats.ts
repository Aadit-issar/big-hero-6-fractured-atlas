import { createWorld } from '../src/simulation/worldGenerator';
import { cellSizeFor, generateTerrain, TERRAIN_RESOLUTIONS } from '../src/scene/terrain/terrainGenerator';
import type { TerrainResolution } from '../src/scene/terrain/terrainGenerator';

// Per-island terrain statistics for a quality preset (default balanced).
const level = (process.argv[2] ?? 'balanced') as keyof typeof TERRAIN_RESOLUTIONS;
const resolution: TerrainResolution = TERRAIN_RESOLUTIONS[level];
const world = createWorld(17062026);
let triangles = 0, milliseconds = 0;
const rows = world.islands.map((island, index) => {
  const t = generateTerrain({ island, index, cellSize: cellSizeFor(island, index, resolution) });
  triangles += t.indices.length / 3; milliseconds += t.milliseconds;
  return { id: island.id, archetype: t.archetype, cellSize: t.cellSize, triangles: t.indices.length / 3, vertices: t.positions.length / 3, ms: t.milliseconds, maxVertexRadius: +t.maxVertexRadius.toFixed(3), envelope: +t.envelope.toFixed(3) };
});
console.log(JSON.stringify({ level, seed: world.seed, triangles, singleThreadMs: milliseconds, islands: rows }, null, 2));
