import type { Mat3, Vec3 } from './types';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (v: Vec3): number => Math.hypot(...v);
export const distance = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export const normalize = (v: Vec3): Vec3 => norm(v) > 1e-12 ? scale(v, 1 / norm(v)) : [0, 1, 0];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const multiply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Bounded Jacobi rotations; symmetric eigenvalues are also signed stretches. */
export function symmetricSpectrum(matrix: Mat3) {
  if (!matrix.every(Number.isFinite)) throw new RangeError('Non-finite symmetric matrix.');
  const a: number[][] = [[matrix[0], matrix[1], matrix[2]], [matrix[3], matrix[4], matrix[5]], [matrix[6], matrix[7], matrix[8]]];
  const v: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 18; iteration++) {
    let p = 0; let q = 1;
    for (const [i, j] of [[0, 2], [1, 2]] as const) {
      if (Math.abs(a[i]![j]!) > Math.abs(a[p]![q]!)) { p = i; q = j; }
    }
    if (Math.abs(a[p]![q]!) < 1e-12) break;
    const angle = 0.5 * Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!);
    const c = Math.cos(angle); const s = Math.sin(angle);
    const app = a[p]![p]!; const aqq = a[q]![q]!; const apq = a[p]![q]!;
    a[p]![p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q]![q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p]![q] = a[q]![p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = a[r]![p]!; const arq = a[r]![q]!;
        a[r]![p] = a[p]![r] = c * arp - s * arq;
        a[r]![q] = a[q]![r] = s * arp + c * arq;
      }
      const vrp = v[r]![p]!; const vrq = v[r]![q]!;
      v[r]![p] = c * vrp - s * vrq; v[r]![q] = s * vrp + c * vrq;
    }
  }
  const entries = [0, 1, 2].map((i) => ({ value: a[i]![i]!, vector: [v[0]![i]!, v[1]![i]!, v[2]![i]!] as Vec3 })).sort((a, b) => a.value - b.value);
  const compressed = [...entries].sort((a, b) => Math.abs(a.value) - Math.abs(b.value))[0]!;
  return {
    eigenvalues: entries.map((e) => e.value) as unknown as Vec3,
    eigenvectors: entries.map((e) => e.vector),
    minSingularValue: Math.abs(compressed.value),
    maxSingularValue: Math.max(...entries.map((e) => Math.abs(e.value))),
    compressionAxis: compressed.vector,
  };
}

/** Positive definite 3x3 solve using pivoted Gaussian elimination. */
export function solve3(matrix: Mat3, rhs: Vec3): Vec3 | null {
  const a = [[matrix[0], matrix[1], matrix[2], rhs[0]], [matrix[3], matrix[4], matrix[5], rhs[1]], [matrix[6], matrix[7], matrix[8], rhs[2]]];
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    if (Math.abs(a[pivot]![column]!) < 1e-14) return null;
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    for (let row = column + 1; row < 3; row++) {
      const factor = a[row]![column]! / a[column]![column]!;
      for (let j = column; j < 4; j++) a[row]![j] = a[row]![j]! - factor * a[column]![j]!;
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let value = a[row]![3]!;
    for (let j = row + 1; j < 3; j++) value -= a[row]![j]! * x[j]!;
    x[row] = value / a[row]![row]!;
  }
  return x.every(Number.isFinite) ? x as unknown as Vec3 : null;
}
