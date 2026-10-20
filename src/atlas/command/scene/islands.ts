import { BufferAttribute, BufferGeometry } from 'three';
import { cellSizeFor, TERRAIN_RESOLUTIONS } from '../../../scene/terrain/terrainGenerator';
import { terrainLibrary } from '../../../scene/terrain/terrainLibrary';
import type { ObservedIslandForm } from '../../live/protocol';

/** The same islands as the Dimension: the Dimension's own deterministic rock generator (identity → archetype → density field → surface nets),
 * fed with the extent and seed a scan of the island reports, and generated in the same worker pool at a coarser tactical resolution.
 * (The Dimension additionally applies a bounded local strain to each island; ATLAS draws the unstrained form.) */
const geometries = new Map<string, Promise<BufferGeometry | null>>();
/** ATLAS draws at roughly half the Dimension's `performance` resolution. */
const TACTICAL = { heroCell: TERRAIN_RESOLUTIONS.performance.heroCell * 2.2, supportCell: TERRAIN_RESOLUTIONS.performance.supportCell * 2.2 } as const;

export function islandGeometry(form: ObservedIslandForm): Promise<BufferGeometry | null> {
  const key = `${form.id}:${form.facetSeed}:${form.radius}:${form.height}`;
  let hit = geometries.get(key);
  if (!hit) {
    const island = { id: form.id, referencePosition: [0, 0, 0] as const, radius: form.radius, height: form.height, facetSeed: form.facetSeed, color: form.color };
    hit = terrainLibrary.request({ island, index: form.index, cellSize: cellSizeFor(island, form.index, TACTICAL) }).then(data => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(data.positions, 3));
      g.setAttribute('normal', new BufferAttribute(data.normals, 3));
      g.setAttribute('terrain', new BufferAttribute(data.terrain, 4, true));
      g.setIndex(new BufferAttribute(data.indices, 1));
      g.computeBoundingSphere();
      return g;
    }).catch(() => null);
    geometries.set(key, hit);
  }
  return hit;
}
