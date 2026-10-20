export type Vec3 = readonly [number, number, number];

/** Row-major 3 by 3 matrix. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface WaveComponent {
  readonly amplitude: number;
  readonly waveVector: Vec3;
  readonly angularFrequency: number;
  readonly phase: number;
}

export interface FieldParameters {
  readonly seed: number;
  readonly interactionStrength: number;
  readonly waves: readonly WaveComponent[];
}

export interface FieldEvaluation {
  readonly value: number;
  readonly gradient: Vec3;
  readonly hessian: Mat3;
}

export interface IslandDefinition {
  readonly id: string;
  readonly referencePosition: Vec3;
  readonly radius: number;
  readonly height: number;
  readonly facetSeed: number;
  readonly color: string;
}

export interface WorldDefinition {
  readonly seed: number;
  readonly islands: readonly IslandDefinition[];
}

export interface DeformationSettings {
  readonly worldScale: number;
  readonly strength: number;
}
