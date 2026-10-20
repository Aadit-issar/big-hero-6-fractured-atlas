/** Mulberry32 produces a repeatable stream of 32-bit pseudorandom values. */
export function createSeededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`Seed must be a safe integer; received ${seed}.`);
  }

  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function seedToUint32(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`Seed must be a safe integer; received ${seed}.`);
  }
  return seed >>> 0;
}
