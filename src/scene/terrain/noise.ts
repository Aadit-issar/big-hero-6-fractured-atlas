import { createSeededRandom } from '../../simulation/seededRandom';

/** Seeded improved-Perlin gradient noise. Pure, allocation-free after creation,
 * used only for visual terrain detail (never for authoritative simulation). */
export interface Noise3 {
  (x: number, y: number, z: number): number;
}

const GRADIENTS = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function createNoise3(seed: number): Noise3 {
  const random = createSeededRandom(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const t = p[i]!; p[i] = p[j]!; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) perm[i] = p[i & 255]!;

  const grad = (hash: number, x: number, y: number, z: number) => {
    const g = (hash & 15) * 3;
    return GRADIENTS[g]! * x + GRADIENTS[g + 1]! * y + GRADIENTS[g + 2]! * z;
  };

  return (x, y, z) => {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X]! + Y, AA = perm[A]! + Z, AB = perm[A + 1]! + Z;
    const B = perm[X + 1]! + Y, BA = perm[B]! + Z, BB = perm[B + 1]! + Z;
    const x1 = x - 1, y1 = y - 1, z1 = z - 1;
    const l1 = grad(perm[AA]!, x, y, z) + u * (grad(perm[BA]!, x1, y, z) - grad(perm[AA]!, x, y, z));
    const l2 = grad(perm[AB]!, x, y1, z) + u * (grad(perm[BB]!, x1, y1, z) - grad(perm[AB]!, x, y1, z));
    const l3 = grad(perm[AA + 1]!, x, y, z1) + u * (grad(perm[BA + 1]!, x1, y, z1) - grad(perm[AA + 1]!, x, y, z1));
    const l4 = grad(perm[AB + 1]!, x, y1, z1) + u * (grad(perm[BB + 1]!, x1, y1, z1) - grad(perm[AB + 1]!, x, y1, z1));
    const m1 = l1 + v * (l2 - l1);
    const m2 = l3 + v * (l4 - l3);
    return m1 + w * (m2 - m1);
  };
}

/** Fractal Brownian motion in roughly [-1, 1]. */
export function fbm(noise: Noise3, x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0, amplitude = 1, total = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * noise(x, y, z);
    total += amplitude;
    x *= lacunarity; y *= lacunarity; z *= lacunarity;
    amplitude *= gain;
  }
  return sum / total;
}

/** Ridged multifractal in [0, 1]: sharp crests read as fractured rock edges. */
export function ridged(noise: Noise3, x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amplitude = 0.5, weight = 1, total = 0;
  for (let i = 0; i < octaves; i += 1) {
    let n = 1 - Math.abs(noise(x, y, z));
    n *= n * weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += n * amplitude;
    total += amplitude;
    x *= 2.1; y *= 2.1; z *= 2.1;
    amplitude *= 0.5;
  }
  return sum / total;
}
