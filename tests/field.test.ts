import { describe, expect, it } from 'vitest';
import { createFieldParameters, evaluateField } from '../src/simulation/field';
import type { Vec3 } from '../src/simulation/types';

const PARAMETERS = createFieldParameters(17062026);
const TEST_POSITION: Vec3 = [1.37, -2.2, 3.65];
const TEST_TIME = 4.75;

describe('dimensional distortion field', () => {
  it('reproduces the same field, gradient, and Hessian for a seed, point, and time', () => {
    const first = createFieldParameters(451);
    const second = createFieldParameters(451);
    expect(first).toEqual(second);
    expect(evaluateField(TEST_POSITION, TEST_TIME, first)).toEqual(
      evaluateField(TEST_POSITION, TEST_TIME, second),
    );
  });

  it('uses different seeded wave configurations', () => {
    expect(createFieldParameters(451)).not.toEqual(createFieldParameters(452));
  });

  it('matches central finite differences for the analytical gradient', () => {
    const h = 1e-5;
    const numerical = [0, 1, 2].map((axis) => {
      const positive = [...TEST_POSITION] as [number, number, number];
      const negative = [...TEST_POSITION] as [number, number, number];
      positive[axis] = positive[axis]! + h;
      negative[axis] = negative[axis]! - h;
      const upper = evaluateField(positive, TEST_TIME, PARAMETERS).value;
      const lower = evaluateField(negative, TEST_TIME, PARAMETERS).value;
      return (upper - lower) / (2 * h);
    });
    const analytical = evaluateField(TEST_POSITION, TEST_TIME, PARAMETERS).gradient;

    analytical.forEach((component, index) => expect(component).toBeCloseTo(numerical[index]!, 8));
  });

  it('matches central finite differences of the gradient for every Hessian column', () => {
    const h = 1e-5;
    const analytical = evaluateField(TEST_POSITION, TEST_TIME, PARAMETERS).hessian;

    for (let column = 0; column < 3; column += 1) {
      const positive = [...TEST_POSITION] as [number, number, number];
      const negative = [...TEST_POSITION] as [number, number, number];
      positive[column] = positive[column]! + h;
      negative[column] = negative[column]! - h;
      const upper = evaluateField(positive, TEST_TIME, PARAMETERS).gradient;
      const lower = evaluateField(negative, TEST_TIME, PARAMETERS).gradient;

      for (let row = 0; row < 3; row += 1) {
        const numerical = (upper[row]! - lower[row]!) / (2 * h);
        expect(analytical[row * 3 + column]).toBeCloseTo(numerical, 7);
      }
    }
  });

  it('returns finite, bounded values through the intended spatial and temporal ranges', () => {
    for (let index = 0; index < 48; index += 1) {
      const position: Vec3 = [
        Math.sin(index * 0.73) * 90,
        Math.cos(index * 0.31) * 55,
        Math.sin(index * 0.17 + 1) * 110,
      ];
      const time = (index / 47) * 7200;
      const result = evaluateField(position, time, PARAMETERS);
      expect(Number.isFinite(result.value)).toBe(true);
      expect(result.value).toBeGreaterThan(-1.1);
      expect(result.value).toBeLessThan(1.1);
      expect(result.gradient.every(Number.isFinite)).toBe(true);
      expect(result.hessian.every(Number.isFinite)).toBe(true);
    }
  });

  it('keeps samples finite across a spread of safe seeded parameter configurations', () => {
    for (let seed = 1; seed <= 48; seed += 1) {
      const parameters = createFieldParameters(seed * 1049);
      const result = evaluateField([seed - 24, seed * 0.31, 44 - seed], seed * 17.5, parameters);
      expect(Number.isFinite(result.value)).toBe(true);
      expect(result.gradient.every(Number.isFinite)).toBe(true);
      expect(result.hessian.every(Number.isFinite)).toBe(true);
    }
  });

  it('changes in time and distinguishes representative spatial points', () => {
    const initial = evaluateField([1, -2, 3], 0, PARAMETERS).value;
    const later = evaluateField([1, -2, 3], 7, PARAMETERS).value;
    const remote = evaluateField([8, 4, -6], 0, PARAMETERS).value;

    expect(Math.abs(initial - later)).toBeGreaterThan(1e-4);
    expect(Math.abs(initial - remote)).toBeGreaterThan(1e-4);
  });

  it('rejects invalid coordinates, time, and unsafe wave parameters', () => {
    expect(() => evaluateField([Infinity, 0, 0], 0, PARAMETERS)).toThrow(RangeError);
    expect(() => evaluateField([0, 0, 0], Number.NaN, PARAMETERS)).toThrow(RangeError);
    expect(() => evaluateField([1e308, 1e308, 1e308], 0, PARAMETERS)).toThrow(RangeError);
  });
});
