import type { WorldVec3 } from '../../shared/atlasContract';

export interface ScalarSample { readonly time: number; readonly value: number }
export interface LinearFit {
  readonly count: number;
  readonly firstTime: number;
  readonly lastTime: number;
  readonly span: number;
  readonly slope: number;
  readonly atLastTime: number;
  readonly residualRms: number;
}

/** Least squares in model seconds, centered at the last time and value.
 * The accessor lets temporal analysis fit stored tracks without allocating mapped samples. */
export function fitVectorBy<T extends { readonly time: number }>(
  samples: readonly T[],
  dimensions: number,
  valueAt: (sample: T, axis: number) => number,
): readonly (LinearFit | null)[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || samples.length < 2) return Object.freeze(Array.from({ length: Math.max(0, dimensions) }, () => null));
  const last = samples.at(-1)!;
  const lastValues = new Array<number>(dimensions);
  for (let axis = 0; axis < dimensions; axis += 1) {
    lastValues[axis] = valueAt(last, axis);
    if (!Number.isFinite(lastValues[axis])) return Object.freeze(Array.from({ length: dimensions }, () => null));
  }
  let sumX = 0;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || sample.time <= previousTime) return Object.freeze(Array.from({ length: dimensions }, () => null));
    previousTime = sample.time;
    sumX += sample.time - last.time;
    for (let axis = 0; axis < dimensions; axis += 1) if (!Number.isFinite(valueAt(sample, axis))) return Object.freeze(Array.from({ length: dimensions }, () => null));
  }
  const meanX = sumX / samples.length;
  if (!Number.isFinite(meanX)) return Object.freeze(Array.from({ length: dimensions }, () => null));
  let xx = 0;
  for (const sample of samples) {
    const centeredX = sample.time - last.time - meanX;
    xx += centeredX * centeredX;
  }
  if (!(xx > 0) || !Number.isFinite(xx)) return Object.freeze(Array.from({ length: dimensions }, () => null));
  const result: LinearFit[] = [];
  for (let axis = 0; axis < dimensions; axis += 1) {
    const lastValue = lastValues[axis]!;
    let meanDeltaY = 0;
    for (const sample of samples) meanDeltaY += valueAt(sample, axis) - lastValue;
    meanDeltaY /= samples.length;
    if (!Number.isFinite(meanDeltaY)) return Object.freeze(Array.from({ length: dimensions }, () => null));
    let xy = 0;
    for (const sample of samples) {
      const x = sample.time - last.time - meanX;
      const y = valueAt(sample, axis) - lastValue - meanDeltaY;
      xy += x * y;
    }
    const slope = xy / xx;
    const lastOffset = meanDeltaY - slope * meanX;
    const atLastTime = lastValue + lastOffset;
    let squaredError = 0;
    for (const sample of samples) {
      const observedOffset = valueAt(sample, axis) - lastValue;
      const fittedOffset = lastOffset + slope * (sample.time - last.time);
      squaredError += (observedOffset - fittedOffset) ** 2;
    }
    const residualRms = Math.sqrt(squaredError / samples.length);
    if (![slope, lastOffset, atLastTime, residualRms].every(Number.isFinite)) return Object.freeze(Array.from({ length: dimensions }, () => null));
    result.push(Object.freeze({ count: samples.length, firstTime: samples[0]!.time, lastTime: last.time, span: last.time - samples[0]!.time, slope, atLastTime, residualRms }));
  }
  return Object.freeze(result);
}

/** Scalar reference implementation used by unit tests and simple consumers. */
export function fitLinear(samples: readonly ScalarSample[]): LinearFit | null {
  return fitVectorBy(samples, 1, (sample) => sample.value)[0] ?? null;
}

export function fitVector(samples: readonly { readonly time: number; readonly value: readonly number[] }[], dimensions: number): readonly (LinearFit | null)[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || samples.some((sample) => sample.value.length !== dimensions)) {
    return Object.freeze(Array.from({ length: Math.max(0, dimensions) }, () => null));
  }
  return fitVectorBy(samples, dimensions, (sample, axis) => sample.value[axis]!);
}

export function predictLinear(fit: LinearFit, time: number): number {
  return fit.atLastTime + fit.slope * (time - fit.lastTime);
}

export function distance3(a: WorldVec3, b: WorldVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0 || !Number.isFinite(quantile) || values.some((value) => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

/** Only the contiguous suffix is model support. Missing time is never interpolated into evidence. */
export function contiguousSuffix<T extends { readonly time: number }>(samples: readonly T[], maxGap: number, limit: number, breakBefore: (s: T, index: number, items: readonly T[]) => boolean = () => false): readonly T[] {
  return contiguousSuffixFrom(samples, maxGap, limit, Number.NEGATIVE_INFINITY, breakBefore);
}

/** Time-indexed suffix without allocating a filtered copy of a larger bounded track. */
export function contiguousSuffixFrom<T extends { readonly time: number }>(samples: readonly T[], maxGap: number, limit: number, notBefore: number, breakBefore: (s: T, index: number, items: readonly T[]) => boolean = () => false): readonly T[] {
  let first = 0;
  let last = samples.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (samples[middle]!.time < notBefore) first = middle + 1;
    else last = middle;
  }
  if (first === samples.length || limit < 1) return Object.freeze([]);
  let start = Math.max(first, samples.length - limit);
  for (let i = samples.length - 1; i > start; i -= 1) {
    if (breakBefore(samples[i]!, i, samples) || samples[i]!.time - samples[i - 1]!.time > maxGap) { start = i; break; }
  }
  return samples.slice(Math.max(start, first));
}
