import type { DeformationSettings } from './types';

/** Stable seed for the opening scene. */
export const DEFAULT_SEED = 17062026;
export const DEFAULT_WAVE_COUNT = 4;

/** A reference-space unit maps to 7.5 rendering units before deformation. */
export const DEFORMATION: DeformationSettings = {
  worldScale: 7.5,
  strength: 0.9,
};

export const MAX_FRAME_DELTA_SECONDS = 0.1;
export const HUD_UPDATE_INTERVAL_SECONDS = 0.15;
export const ISLAND_COUNT = 14;

export const SAFE_PARAMETER_RANGES = {
  waveCount: [1, 8] as const,
  amplitude: [0.02, 0.3] as const,
  waveNumberMagnitude: [0.05, 1.25] as const,
  angularFrequency: [0.02, 1.5] as const,
  interactionStrength: [0, 0.5] as const,
};
