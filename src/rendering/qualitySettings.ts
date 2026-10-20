import { TERRAIN_RESOLUTIONS } from '../scene/terrain/terrainGenerator';
import type { TerrainResolution } from '../scene/terrain/terrainGenerator';

export type QualityLevel = 'performance' | 'balanced' | 'cinematic';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['performance', 'balanced', 'cinematic'];

export interface BloomSettings { readonly strength: number; readonly radius: number; readonly threshold: number; readonly resolutionScale: number }
/** Raymarched gas: march resolution (fraction of the canvas), steps, 3D noise size. */
export interface GasQuality { readonly resolutionScale: number; readonly steps: number; readonly noiseSize: number }

/** Rendering presets. None of these values reach src/simulation: physics,
 * graph state, probes and the clock are identical across presets. */
export interface QualitySettings {
  readonly level: QualityLevel;
  readonly maxDpr: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly terrain: TerrainResolution;
  readonly skyCubeSize: number;
  readonly anisotropy: number;
  readonly gas: GasQuality;
  readonly motes: number;
  readonly crystals: number;
  readonly mirrorPanes: number;
  readonly bloom: BloomSettings | null;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualitySettings>> = {
  performance: {
    level: 'performance', maxDpr: 1, shadows: true, shadowMapSize: 1024, terrain: TERRAIN_RESOLUTIONS.performance,
    skyCubeSize: 512, anisotropy: 2, gas: { resolutionScale: 0.33, steps: 24, noiseSize: 96 },
    motes: 1200, crystals: 90, mirrorPanes: 2, bloom: null,
  },
  balanced: {
    level: 'balanced', maxDpr: 1, shadows: true, shadowMapSize: 2048, terrain: TERRAIN_RESOLUTIONS.balanced,
    skyCubeSize: 1024, anisotropy: 8, gas: { resolutionScale: 0.5, steps: 44, noiseSize: 128 },
    motes: 2400, crystals: 160, mirrorPanes: 3, bloom: { strength: 0.35, radius: 0.5, threshold: 1.2, resolutionScale: 0.5 },
  },
  cinematic: {
    level: 'cinematic', maxDpr: 1.5, shadows: true, shadowMapSize: 4096, terrain: TERRAIN_RESOLUTIONS.cinematic,
    skyCubeSize: 2048, anisotropy: 16, gas: { resolutionScale: 0.6, steps: 52, noiseSize: 128 },
    motes: 4000, crystals: 240, mirrorPanes: 5, bloom: { strength: 0.4, radius: 0.55, threshold: 1.15, resolutionScale: 0.6 },
  },
};

const STORAGE_KEY = 'fractured.quality';

export function parseQuality(value: string | null | undefined): QualityLevel | null {
  return value === 'performance' || value === 'balanced' || value === 'cinematic' ? value : null;
}

/** URL `?quality=` wins, then the remembered choice, then balanced. */
export function initialQuality(): QualityLevel {
  try {
    const fromUrl = parseQuality(new URLSearchParams(window.location.search).get('quality'));
    if (fromUrl) return fromUrl;
    return parseQuality(window.localStorage.getItem(STORAGE_KEY)) ?? 'balanced';
  } catch {
    return 'balanced';
  }
}

export function rememberQuality(level: QualityLevel): void {
  try { window.localStorage.setItem(STORAGE_KEY, level); } catch { /* storage unavailable */ }
}
