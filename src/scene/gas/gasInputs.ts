import type { SimulationEngine } from '../../simulation/simulationEngine';
import type { Vec3 } from '../../simulation/types';
import { MAX_FOLDS, MAX_HAZARDS } from './GasVolumePass';

/** How strongly a connection state opens the surrounding gas (rendering only). */
export const FOLD_OPENING: Readonly<Record<string, number>> = { open: 1, unstable: 0.85, forming: 0.45, closing: 0.35, inactive: 0, closed: 0 };

export type Vec4 = readonly [number, number, number, number];

/** Simulation-derived shaping inputs for the gas, sampled on the 4 Hz model
 * lattice: fold endpoints (only real graph connections open passages) and the
 * same hazard sample points the hazard shells use. Read-only on the engine. */
export function gasSimulationInputs(engine: SimulationEngine, time: number, camera: Vec3): { readonly folds: Vec4[]; readonly hazards: Vec4[] } {
  const lattice = Math.floor(time * 4) / 4;
  const endpoints: Array<{ p: Vec3; w: number }> = [];
  for (const c of engine.network.getConnections(lattice)) {
    const w = c.valid ? FOLD_OPENING[c.state] ?? 0 : 0;
    if (w <= 0) continue;
    endpoints.push({ p: c.entryWorldPosition, w }, { p: c.exitWorldPosition, w });
  }
  endpoints.sort((a, b) => dist2(a.p, camera) - dist2(b.p, camera));
  const folds: Vec4[] = endpoints.slice(0, MAX_FOLDS).map((e) => [e.p[0], e.p[1], e.p[2], e.w]);
  const hazards: Vec4[] = [1, 2, 4, 6].slice(0, MAX_HAZARDS).map((index) => {
    const ref = engine.world.islands[index]!.referencePosition;
    const sample = engine.sampleField([ref[0], ref[1] + 1.1, ref[2]], lattice);
    return [sample.worldPosition[0], sample.worldPosition[1], sample.worldPosition[2], sample.hazard];
  });
  return { folds, hazards };
}

function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
