import { createSeededRandom } from '../../simulation/seededRandom';

/** Tileable 3D cloud noise for the raymarched gas volume (rendering only).
 * R = Perlin–Worley billow density (cauliflower cloud structure),
 * G = low-frequency Perlin fBm used for domain warp and colour variation.
 * Deterministic in the seed; generated once off the main thread. */
export interface GasNoiseData { readonly size: number; readonly fromZ: number; readonly data: Uint8Array; readonly milliseconds: number }

const GRAD = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]] as const;

function hash(seed: number, x: number, y: number, z: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a: number, p: number) => ((a % p) + p) % p;

/** Gradient noise whose lattice wraps every `period` cells (tileable). */
function periodicPerlin(seed: number, x: number, y: number, z: number, period: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  let result = 0;
  for (let c = 0; c < 8; c += 1) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    const g = GRAD[hash(seed, mod(ix + dx, period), mod(iy + dy, period), mod(iz + dz, period)) % 12]!;
    const dot = g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
    result += dot * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return result;
}

/** Inverted Worley (1 at feature points) on a wrapping grid of `period` cells. */
function periodicWorley(seed: number, x: number, y: number, z: number, period: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const h = hash(seed ^ 0x51ed, mod(cx, period), mod(cy, period), mod(cz, period));
    const px = cx + (h & 1023) / 1023, py = cy + ((h >>> 10) & 1023) / 1023, pz = cz + ((h >>> 20) & 1023) / 1023;
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.max(0, 1 - Math.sqrt(best));
}

/** Generates z-slices [fromZ, toZ); voxels are independent, so slabs merge exactly. */
export function generateGasNoise(seed: number, size = 128, fromZ = 0, toZ = size): GasNoiseData {
  const started = Date.now();
  const s = createSeededRandom(seed)() * 0xffffffff >>> 0;
  const data = new Uint8Array(size * size * (toZ - fromZ) * 2);
  for (let z = fromZ; z < toZ; z += 1) for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size, v = y / size, w = z / size;
    // Perlin fBm (periods 4, 8, 16, 32 lattice cells across the tile).
    let perlin = 0, amp = 0.5, total = 0;
    for (const period of [4, 8, 16, 32]) { perlin += amp * periodicPerlin(s, u * period, v * period, w * period, period); total += amp; amp *= 0.5; }
    perlin = perlin / total * 0.5 + 0.5;
    // Worley fBm gives billowing, rounded cauliflower lobes.
    const worley = periodicWorley(s, u * 6, v * 6, w * 6, 6) * 0.625 + periodicWorley(s + 1, u * 12, v * 12, w * 12, 12) * 0.25 + periodicWorley(s + 2, u * 24, v * 24, w * 24, 24) * 0.125;
    // Perlin–Worley remap: Perlin structure, Worley billows at its edges.
    const billow = Math.min(1, Math.max(0, (perlin - (1 - worley)) / Math.max(1e-3, worley) * 0.5 + 0.5 * worley));
    let warp = 0; amp = 0.5; total = 0;
    for (const period of [2, 4, 8]) { warp += amp * periodicPerlin(s + 7, u * period, v * period, w * period, period); total += amp; amp *= 0.5; }
    const k = (x + size * (y + size * (z - fromZ))) * 2;
    data[k] = Math.round(255 * Math.min(1, billow * 1.4));
    data[k + 1] = Math.round(255 * Math.min(1, Math.max(0, warp / total * 0.5 + 0.5)));
  }
  return { size, fromZ, data, milliseconds: Date.now() - started };
}
