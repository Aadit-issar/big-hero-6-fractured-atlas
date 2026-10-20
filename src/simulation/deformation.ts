import { DEFORMATION } from './constants';
import { evaluateField } from './field';
import type { DeformationSettings, FieldParameters, Mat3, Vec3 } from './types';

export function deformPosition(
  referencePosition: Vec3,
  time: number,
  parameters: FieldParameters,
  settings: DeformationSettings = DEFORMATION,
): Vec3 {
  const { gradient } = evaluateField(referencePosition, time, parameters);
  const { worldScale, strength } = settings;

  if (!Number.isFinite(worldScale) || worldScale <= 0 || !Number.isFinite(strength)) {
    throw new RangeError('Deformation settings require a positive finite world scale and finite strength.');
  }

  return [
    worldScale * (referencePosition[0] + strength * gradient[0]),
    worldScale * (referencePosition[1] + strength * gradient[1]),
    worldScale * (referencePosition[2] + strength * gradient[2]),
  ];
}

/** J = I + α HΦ, before the global world-scale factor. */
export function deformationJacobian(
  referencePosition: Vec3,
  time: number,
  parameters: FieldParameters,
  strength: number = DEFORMATION.strength,
): Mat3 {
  if (!Number.isFinite(strength)) {
    throw new RangeError('Deformation strength must be finite.');
  }

  const { hessian } = evaluateField(referencePosition, time, parameters);
  return [
    1 + strength * hessian[0], strength * hessian[1], strength * hessian[2],
    strength * hessian[3], 1 + strength * hessian[4], strength * hessian[5],
    strength * hessian[6], strength * hessian[7], 1 + strength * hessian[8],
  ];
}

export function determinant3(matrix: Mat3): number {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function gradientMagnitude(gradient: Vec3): number {
  return Math.hypot(...gradient);
}

/** First-order local terrain response with a proven 18% strain bound.
 * Frobenius norm bounds every eigenvalue, keeping all local stretches > .82. */
export function boundedLocalJacobian(hessian:Mat3,alpha:number):Mat3 {
  const magnitude=Math.abs(alpha)*Math.hypot(...hessian);
  const weight=Math.min(.3,.18/Math.max(magnitude,1e-12))*alpha;
  return [1+weight*hessian[0],weight*hessian[1],weight*hessian[2],weight*hessian[3],1+weight*hessian[4],weight*hessian[5],weight*hessian[6],weight*hessian[7],1+weight*hessian[8]];
}
