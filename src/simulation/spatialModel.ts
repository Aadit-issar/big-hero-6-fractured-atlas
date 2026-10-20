import { createFieldParameters, evaluateField } from './field';
import { determinant3 } from './deformation';
import { symmetricSpectrum, norm, scale } from './linearAlgebra';
import type { FieldParameters, Mat3, Vec3, DeformationSettings } from './types';

export const SPATIAL_MODEL = {
  version: 'fractured-2.0',
  waveNumberScale: 2,
  frequencyScale: 0.16,
  phaseOrigin: 20,
  mapping: { worldScale: 7.5, strength: 4 } as DeformationSettings,
  sampleInterval: 0.25,
  foldSigma: 0.08,
  connectionDistance: 6,
  referenceSeparation: 1.8,
  endpointSigma: 0.06,
  approachRadius: 5,
  traversalCooldown: 1.5,
  safeHorizon: 1,
} as const;

/** Preserve the Phase 1 seed sequence; change only spatial and temporal scales. */
export function createSpatialParameters(seed: number, waveNumberScale: number = SPATIAL_MODEL.waveNumberScale): FieldParameters {
  const original = createFieldParameters(seed);
  return { ...original, waves: original.waves.map((wave) => ({
    ...wave, waveVector: scale(wave.waveVector, waveNumberScale),
    angularFrequency: wave.angularFrequency * SPATIAL_MODEL.frequencyScale,
    phase: wave.phase - wave.angularFrequency * SPATIAL_MODEL.frequencyScale * SPATIAL_MODEL.phaseOrigin,
  })) };
}

export function jacobianFromHessian(h: Mat3, alpha: number): Mat3 {
  return [1 + alpha * h[0], alpha * h[1], alpha * h[2], alpha * h[3], 1 + alpha * h[4], alpha * h[5], alpha * h[6], alpha * h[7], 1 + alpha * h[8]];
}

export function fieldVelocity(q: Vec3, t: number, field: FieldParameters, mapping: DeformationSettings): Vec3 {
  const phases = field.waves.map((w) => w.waveVector[0] * q[0] + w.waveVector[1] * q[1] + w.waveVector[2] * q[2] - w.angularFrequency * t + w.phase);
  const velocity = [0, 0, 0];
  field.waves.forEach((w, i) => {
    for (let a = 0; a < 3; a++) velocity[a] = velocity[a]! + w.amplitude * w.angularFrequency * Math.sin(phases[i]!) * w.waveVector[a]!;
    for (let j = i + 1; j < field.waves.length; j++) {
      const r = field.waves[j]!; const ss = Math.sin(phases[i]!) * Math.sin(phases[j]!); const cc = Math.cos(phases[i]!) * Math.cos(phases[j]!);
      for (let a = 0; a < 3; a++) velocity[a] = velocity[a]! + field.interactionStrength * w.amplitude * r.amplitude * (
        (w.angularFrequency * ss - r.angularFrequency * cc) * w.waveVector[a]!
        + (r.angularFrequency * ss - w.angularFrequency * cc) * r.waveVector[a]!
      );
    }
  });
  return scale(velocity as unknown as Vec3, mapping.worldScale * mapping.strength);
}

export function sampleSpatial(q: Vec3, t: number, field: FieldParameters, mapping: DeformationSettings = SPATIAL_MODEL.mapping) {
  const evaluation = evaluateField(q, t, field);
  const jacobian = jacobianFromHessian(evaluation.hessian, mapping.strength);
  const spectrum = symmetricSpectrum(jacobian);
  const velocity = fieldVelocity(q, t, field, mapping);
  const compression = 1 / (1 + (spectrum.minSingularValue / 0.28) ** 2);
  const curvature = Math.hypot(...evaluation.hessian);
  const hazard = 0.5 * compression + 0.25 * curvature / (0.3 + curvature) + 0.25 * norm(velocity) / (8 + norm(velocity));
  return {
    ...evaluation, ...spectrum, jacobian, jacobianDeterminant: determinant3(jacobian),
    gradientMagnitude: norm(evaluation.gradient), velocity, compression, hazard, stability: 1 - hazard,
    gravity: scale(evaluation.gradient, -0.65 * (1 + hazard)),
    worldPosition: [
      mapping.worldScale * (q[0] + mapping.strength * evaluation.gradient[0]),
      mapping.worldScale * (q[1] + mapping.strength * evaluation.gradient[1]),
      mapping.worldScale * (q[2] + mapping.strength * evaluation.gradient[2]),
    ] as Vec3,
  };
}
