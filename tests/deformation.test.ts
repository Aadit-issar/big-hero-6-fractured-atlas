import { describe, expect, it } from 'vitest';
import { DEFORMATION } from '../src/simulation/constants';
import { deformPosition, deformationJacobian, determinant3 } from '../src/simulation/deformation';
import { createFieldParameters, evaluateField } from '../src/simulation/field';
import type { Vec3 } from '../src/simulation/types';

const PARAMETERS = createFieldParameters(8801);
const POSITION: Vec3 = [-3.2, 1.4, 5.8];
const TIME = 9.25;

describe('coordinate deformation', () => {
  it('maps reference coordinates using X = L(q + α∇Φ)', () => {
    const gradient = evaluateField(POSITION, TIME, PARAMETERS).gradient;
    const expected = POSITION.map((coordinate, index) => (
      DEFORMATION.worldScale * (coordinate + DEFORMATION.strength * gradient[index]!)
    ));
    expect(deformPosition(POSITION, TIME, PARAMETERS)).toEqual(expected);
  });

  it('matches the analytical deformation Jacobian by differentiating the mapping', () => {
    const h = 1e-5;
    const jacobian = deformationJacobian(POSITION, TIME, PARAMETERS);

    for (let column = 0; column < 3; column += 1) {
      const positive = [...POSITION] as [number, number, number];
      const negative = [...POSITION] as [number, number, number];
      positive[column] = positive[column]! + h;
      negative[column] = negative[column]! - h;
      const upper = deformPosition(positive, TIME, PARAMETERS);
      const lower = deformPosition(negative, TIME, PARAMETERS);

      for (let row = 0; row < 3; row += 1) {
        const numerical = (upper[row]! - lower[row]!) / (2 * h * DEFORMATION.worldScale);
        expect(jacobian[row * 3 + column]).toBeCloseTo(numerical, 7);
      }
    }
  });

  it('does not accumulate deformation across evaluations', () => {
    const first = deformPosition(POSITION, TIME, PARAMETERS);
    const later = deformPosition(POSITION, TIME + 1, PARAMETERS);
    const again = deformPosition(POSITION, TIME, PARAMETERS);
    expect(again).toEqual(first);
    expect(later).not.toEqual(first);
  });

  it('reports a finite diagnostic Jacobian determinant', () => {
    const matrix = deformationJacobian(POSITION, TIME, PARAMETERS);
    expect(matrix.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(determinant3(matrix))).toBe(true);
  });

  it('rejects invalid world scales rather than masking them', () => {
    expect(() => deformPosition(POSITION, TIME, PARAMETERS, { worldScale: 0, strength: 0.9 })).toThrow(RangeError);
    expect(() => deformPosition(POSITION, TIME, PARAMETERS, { worldScale: 7.5, strength: Number.NaN })).toThrow(RangeError);
  });
});
