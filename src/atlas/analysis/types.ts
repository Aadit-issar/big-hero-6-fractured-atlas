import type { ObservedConnectionState, WorldVec3 } from '../../shared/atlasContract';
import type { LinearFit } from './models';

export type AnalyticalQuality = 'insufficient' | 'provisional' | 'evaluated' | 'withheld';
export interface ForecastScore {
  readonly evaluated: number;
  readonly publishedEvaluated: number;
  readonly meanAbsoluteError: number | null;
  readonly persistenceMeanAbsoluteError: number | null;
  readonly publishedMeanAbsoluteError: number | null;
  readonly envelopeHits: number;
  readonly errorP95: number | null;
  readonly skipped: number;
}
export interface NumericForecast {
  readonly issuedAt: number;
  readonly targetTime: number;
  readonly estimate: readonly number[];
  /** Descriptive residual / historical error allowance, not a probability or guaranteed interval. */
  readonly errorAllowance: number;
  readonly model: 'local-linear';
}
export interface NumericAnalysis {
  readonly key: string;
  readonly label: string;
  readonly units: string;
  readonly observed: readonly number[];
  readonly fits: readonly LinearFit[];
  readonly sampleCount: number;
  readonly supportStart: number | null;
  readonly supportEnd: number | null;
  readonly quality: AnalyticalQuality;
  readonly reasons: readonly string[];
  readonly forecast: NumericForecast | null;
  readonly score: ForecastScore;
}
export interface FoldDynamics {
  readonly id: string;
  readonly firstSeenAt: number;
  readonly currentlyObserved: boolean;
  readonly lastSeenAt: number;
  readonly currentState: ObservedConnectionState | null;
  readonly lastObservedState: ObservedConnectionState;
  readonly sampleCount: number;
  readonly observedTransitions: number;
  readonly stateComparisons: number;
  readonly sampledStateSupportSeconds: number;
  readonly recentTransitions: readonly { readonly from: ObservedConnectionState; readonly to: ObservedConnectionState; readonly earliestAfter: number; readonly latestAt: number }[];
  readonly nextLabelCounts: readonly { readonly state: ObservedConnectionState; readonly count: number }[];
  /** Disabled because sensor-provided fold labels may include approximately one second of lookahead. */
  readonly nextLabelEstimate: null;
  readonly nextLabelTargetTime: null;
  readonly nextLabelReason: string;
  readonly labelScore: { readonly evaluated: 0; readonly correct: 0; readonly persistenceCorrect: 0 };
  readonly entry: NumericAnalysis;
  readonly exit: NumericAnalysis;
  readonly endpointSeparation: NumericAnalysis;
}
export interface AnalyticalConcern {
  readonly id: string;
  readonly severity: 'information' | 'attention' | 'elevated';
  readonly title: string;
  readonly explanation: string;
  readonly source: 'current-measurement' | 'observed-change' | 'data-quality' | 'forecast-validation';
  readonly time: number;
}
export interface ForecastEvaluation {
  readonly key: string;
  readonly published: boolean;
  readonly issuedAt: number;
  readonly targetTime: number;
  readonly observedAt: number;
  readonly evaluatedAt: number;
  readonly error: number;
  readonly persistenceError: number;
  readonly errorAllowance: number;
  readonly covered: boolean;
}
export interface TemporalSnapshot {
  readonly session: number;
  readonly time: number | null;
  readonly available: boolean;
  readonly statusReason: string;
  readonly hazard: NumericAnalysis | null;
  readonly gravity: NumericAnalysis | null;
  readonly folds: readonly FoldDynamics[];
  readonly islands: readonly { readonly id: string; readonly motion: NumericAnalysis }[];
  readonly concerns: readonly AnalyticalConcern[];
  readonly evaluations: readonly ForecastEvaluation[];
  readonly evaluatedForecasts: number;
  readonly pendingForecasts: number;
  readonly policy: Readonly<TemporalPolicy>;
}
export interface TemporalPolicy {
  readonly windowSamples: number;
  readonly minSamples: number;
  readonly minSpanSeconds: number;
  readonly maxGapSeconds: number;
  readonly horizonSeconds: number;
  readonly maxScoreDelaySeconds: number;
  readonly stationaryRadius: number;
  readonly discontinuityDistance: number;
  readonly elevatedHazard: number;
  readonly highHazard: number;
  readonly endpointSpeedAttention: number;
  readonly maxModels: number;
  readonly evaluationLimit: number;
}
export interface TemporalEvent {
  readonly kind: 'analytical-concern';
  readonly simulationTime: number;
  readonly message: string;
}
export interface PositionEvidence { readonly time: number; readonly position: WorldVec3; readonly breakBefore?: boolean }
