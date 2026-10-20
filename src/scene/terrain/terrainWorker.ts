/// <reference lib="webworker" />
import { finishTerrainFromSlabs, generateTerrain, sampleTerrainSlab } from './terrainGenerator';
import type { TerrainRequest, TerrainSlab } from './terrainGenerator';
import { generateGasNoise } from '../gas/gasNoise';

export type TerrainJob =
  | { readonly kind: 'generate'; readonly request: TerrainRequest }
  | { readonly kind: 'slab'; readonly request: TerrainRequest; readonly fromRow: number; readonly toRow: number }
  | { readonly kind: 'finish'; readonly request: TerrainRequest; readonly slabs: readonly TerrainSlab[] }
  | { readonly kind: 'gas'; readonly seed: number; readonly size: number; readonly fromZ: number; readonly toZ: number };

// Visual terrain is generated off the main thread; results are transferred, not copied.
self.onmessage = (event: MessageEvent<{ readonly id: number; readonly job: TerrainJob }>) => {
  const { id, job } = event.data;
  const worker = self as unknown as Worker;
  try {
    if (job.kind === 'gas') {
      const noise = generateGasNoise(job.seed, job.size, job.fromZ, job.toZ);
      worker.postMessage({ id, data: noise }, [noise.data.buffer]);
      return;
    }
    if (job.kind === 'slab') {
      const slab = sampleTerrainSlab(job.request, job.fromRow, job.toRow);
      worker.postMessage({ id, data: slab }, [slab.values.buffer]);
      return;
    }
    const data = job.kind === 'finish' ? finishTerrainFromSlabs(job.request, job.slabs) : generateTerrain(job.request);
    worker.postMessage({ id, data }, [data.positions.buffer, data.normals.buffer, data.terrain.buffer, data.indices.buffer]);
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
