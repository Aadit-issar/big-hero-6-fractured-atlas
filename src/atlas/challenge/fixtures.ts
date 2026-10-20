import trajectories from './fixtures/realIslandTrajectories.v1.json';
import type { Vec3 } from './types';

/** Typed access to the pinned fixture. The numbers were produced offline by scripts/atlas-challenge-fixture.ts from the production
 * island law; this file only reads them. It is "world side": ATLAS-side modules must not import it (see tests/atlasChallenge.test.ts). */
export interface RealIslandTrajectory { readonly id: string; readonly radius: number; readonly height: number; readonly samples: readonly Vec3[] }
export interface TrajectoryFixture {
  readonly schema: string;
  readonly provenance: { readonly dimensionSeed: number; readonly modelVersion: string; readonly sampleIntervalSeconds: number; readonly durationSeconds: number; readonly law: string; readonly generator: string; readonly precision: string };
  readonly islands: readonly RealIslandTrajectory[];
}

export const REAL_TRAJECTORIES = trajectories as unknown as TrajectoryFixture;
export const TRAJECTORY_DT = REAL_TRAJECTORIES.provenance.sampleIntervalSeconds;

export function realTrajectory(id: string): RealIslandTrajectory {
  const found = REAL_TRAJECTORIES.islands.find(i => i.id === id);
  if (!found) throw new RangeError(`Unknown island ${id}`);
  return found;
}
