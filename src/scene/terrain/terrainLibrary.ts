import { archetypeFor, isHero } from './archetypes';
import { generateTerrain, terrainBlockRows } from './terrainGenerator';
import type { TerrainMeshData, TerrainRequest, TerrainSlab } from './terrainGenerator';
import type { TerrainJob } from './terrainWorker';
import { generateGasNoise } from '../gas/gasNoise';
import type { GasNoiseData } from '../gas/gasNoise';

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void };
const HERO_SLABS = 3;

/** Bounded worker pool with a geometry cache keyed by identity and resolution.
 * Falls back to main-thread generation when module workers are unavailable. */
class TerrainLibrary {
  private workers: Worker[] | null = null;
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ id: number; job: TerrainJob }> = [];
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, Promise<TerrainMeshData>>();
  private nextId = 1;

  private ensureWorkers(): Worker[] | null {
    if (this.workers || typeof Worker === 'undefined') return this.workers;
    try {
      const size = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
      this.workers = Array.from({ length: size }, () => {
        const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; data?: unknown; error?: string }>) => {
          const job = this.pending.get(event.data.id);
          this.pending.delete(event.data.id);
          if (event.data.data) job?.resolve(event.data.data);
          else job?.reject(new Error(event.data.error ?? 'Terrain worker failed.'));
          this.idle.push(worker);
          this.pump();
        };
        return worker;
      });
      this.idle.push(...this.workers);
    } catch {
      this.workers = null;
    }
    return this.workers;
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift()!;
      this.idle.pop()!.postMessage(job);
    }
  }

  private run<T>(job: TerrainJob, priority: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
      if (priority) this.queue.unshift({ id, job }); else this.queue.push({ id, job });
      this.pump();
    });
  }

  /** Hero islands dominate load time, so their sampling is split into z-slabs
   * across workers and merged deterministically before meshing. */
  private async generateInWorkers(request: TerrainRequest, priority: boolean): Promise<TerrainMeshData> {
    if (!isHero(request.archetype ?? archetypeFor(request.island, request.index))) return this.run<TerrainMeshData>({ kind: 'generate', request }, priority);
    const rows = terrainBlockRows(request), step = Math.ceil(rows / HERO_SLABS);
    const slabs = await Promise.all(Array.from({ length: Math.ceil(rows / step) }, (_, i) =>
      this.run<TerrainSlab>({ kind: 'slab', request, fromRow: i * step, toRow: Math.min(rows, (i + 1) * step) }, priority)));
    return this.run<TerrainMeshData>({ kind: 'finish', request, slabs }, true);
  }

  private readonly gas = new Map<string, Promise<Uint8Array>>();

  /** Tileable 3D gas noise (RG8, size³), generated as parallel z-slabs. */
  gasNoise(seed: number, size: number): Promise<Uint8Array> {
    const key = `${seed}:${size}`;
    let volume = this.gas.get(key);
    if (!volume) {
      const slabs = 4, step = Math.ceil(size / slabs);
      volume = (this.ensureWorkers()
        ? Promise.all(Array.from({ length: slabs }, (_, i) => this.run<GasNoiseData>({ kind: 'gas', seed, size, fromZ: i * step, toZ: Math.min(size, (i + 1) * step) }, true)))
        : new Promise<GasNoiseData[]>((resolve) => setTimeout(() => resolve([generateGasNoise(seed, size)]), 0))
      ).then((parts) => {
        const data = new Uint8Array(size * size * size * 2);
        for (const part of parts) data.set(part.data, part.fromZ * size * size * 2);
        return data;
      });
      this.gas.set(key, volume);
    }
    return volume;
  }

  request(request: TerrainRequest, priority = false): Promise<TerrainMeshData> {
    const key = `${request.island.id}:${request.island.facetSeed}:${request.island.radius}:${request.island.height}:${request.cellSize}:${request.archetype ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const promise = this.ensureWorkers() ? this.generateInWorkers(request, priority) : new Promise<TerrainMeshData>((resolve, reject) => {
      setTimeout(() => { try { resolve(generateTerrain(request)); } catch (e) { reject(e as Error); } }, 0);
    });
    this.cache.set(key, promise);
    // Bound the cache: islands × three quality presets plus distant scenery.
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value!);
    return promise;
  }
}

export const terrainLibrary = new TerrainLibrary();
