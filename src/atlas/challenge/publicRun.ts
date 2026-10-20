import type { ClearanceChart } from './chartData';
import type { ChallengeRun } from './run';

/** What the presentation layer may hold: the recorded, delivery-ordered run without the simulated world. Truth-based evaluation reaches the
 * presentation only as the separate, labelled `ProofSummary`, and is shown only after the flight is over. */
export type PublicRun = Omit<ChallengeRun, 'world'>;

/** Offline ground-truth evaluation, revealed at the end of the film. */
export interface ProofSummary {
  readonly atlas: { readonly minDistance: number; readonly required: number; readonly margin: number; readonly atTime: number; readonly obstacle: string | null; readonly baymaxAt: readonly [number, number, number]; readonly obstacleAt: readonly [number, number, number] };
  readonly direct: { readonly minDistance: number; readonly required: number; readonly margin: number; readonly atTime: number; readonly obstacle: string | null; readonly length: number; readonly baymaxAt: readonly [number, number, number]; readonly obstacleAt: readonly [number, number, number] };
  readonly atlasLength: number;
  readonly arrival: number | null;
  readonly proofForecast: { readonly modelError: number; readonly persistenceError: number } | null;
  /** Ground-truth distance to the nearest island over the flight, for the closing chart. */
  readonly chart: ClearanceChart;
}
