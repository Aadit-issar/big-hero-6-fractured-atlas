import { createSeededRandom } from '../../simulation/seededRandom';
import type { IslandDefinition } from '../../simulation/types';
import { createNoise3, fbm, ridged } from './noise';

/** Visual geology archetypes. They change only rendered rock form; island
 * identity, reference position and the authoritative map are untouched. */
export type TerrainArchetype = 'shattered-plateau' | 'splintered-spire' | 'rift-archipelago' | 'mesa' | 'spire' | 'shard-cluster' | 'tilted-slab';

/** Stable visual casting by island identity (identities are seed-independent). */
export const HERO_ARCHETYPES: Readonly<Record<string, TerrainArchetype>> = {
  'island-01': 'shattered-plateau',
  'island-05': 'splintered-spire',
  'island-03': 'rift-archipelago',
};
const SUPPORTING: readonly TerrainArchetype[] = ['mesa', 'tilted-slab', 'spire', 'shard-cluster'];

export function archetypeFor(island: IslandDefinition, index: number): TerrainArchetype {
  const hero = HERO_ARCHETYPES[island.id];
  if (hero) return hero;
  // Rotate through supporting forms in identity order so neighbours differ.
  const heroesBefore = Object.keys(HERO_ARCHETYPES).filter((id) => Number(id.slice(-2)) - 1 < index).length;
  return SUPPORTING[(index - heroesBefore) % SUPPORTING.length]!;
}

export const isHero = (archetype: TerrainArchetype) =>
  archetype === 'shattered-plateau' || archetype === 'splintered-spire' || archetype === 'rift-archipelago';

/** Visual rock must stay inside the explorer's clearance sphere (radius+height),
 * including the maximum 1.18 local strain applied by the field matrix. */
export const ENVELOPE_FRACTION = 0.84;
export const envelopeRadius = (island: Pick<IslandDefinition, 'radius' | 'height'>) => ENVELOPE_FRACTION * (island.radius + island.height);

export interface DensityField {
  readonly envelope: number;
  readonly yMin: number;
  readonly yMax: number;
  /** Cheap smooth signed distance (negative inside) without 3D detail. */
  readonly coarse: (x: number, y: number, z: number) => number;
  /** Full signed distance with crags, warping and carving. */
  readonly full: (x: number, y: number, z: number) => number;
  /** |full - coarse| never exceeds this bound (plus warp Lipschitz slack). */
  readonly detailBound: number;
  /** Plateau top height used for material zoning. */
  readonly top: number;
  readonly bottom: number;
}

// Math.hypot is several times slower than sqrt in V8; this runs ~10⁷ times per world.
const len = (a: number, b: number, c = 0) => Math.sqrt(a * a + b * b + c * c);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smoothstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
const fract = (v: number) => v - Math.floor(v);

interface Capsule { ax: number; ay: number; az: number; bx: number; by: number; bz: number; ra: number; rb: number }
function taperedCapsule(c: Capsule, x: number, y: number, z: number): number {
  const bax = c.bx - c.ax, bay = c.by - c.ay, baz = c.bz - c.az;
  const pax = x - c.ax, pay = y - c.ay, paz = z - c.az;
  const t = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  const dx = pax - bax * t, dy = pay - bay * t, dz = paz - baz * t;
  return len(dx, dy, dz) - (c.ra + (c.rb - c.ra) * t);
}

interface PlateauShape {
  radius: number; top: number; depth: number; lip: number; outlineAmp: number;
  strataFreq: number; strataAmp: number; flute: number; terraceAmp: number; tiltX: number; tiltZ: number;
}

/** Plateau body: broad noisy footprint, overhanging lip, stratified cliffs and a
 * tapering, fluted underside. Returns a coarse (no 3D noise) distance. */
function plateauDistance(s: PlateauShape, outline: Float64Array, topNoise: (x: number, z: number) => number, x: number, y: number, z: number, strataNoise: (x: number, y: number, z: number) => number): number {
  // Optional tilt makes slab variants without rotating the authoritative transform.
  const yy = y - s.tiltX * x - s.tiltZ * z;
  const rho = len(x, z);
  const theta = Math.atan2(z, x);
  const bin = ((theta / (Math.PI * 2) + 1) % 1) * outline.length;
  const i0 = Math.floor(bin) % outline.length, i1 = (i0 + 1) % outline.length, f = bin - Math.floor(bin);
  const edge = s.radius * (outline[i0]! * (1 - f) + outline[i1]! * f);
  const topY = s.top + s.terraceAmp * topNoise(x, z);
  const sDepth = clamp((topY - yy) / s.depth, 0, 1);
  const lip = 1 + s.lip * smoothstep(0, 0.08, sDepth) * (1 - smoothstep(0.1, 0.32, sDepth));
  const taper = Math.pow(1 - sDepth, 0.72);
  // Sawtooth strata: each layer leans outward then steps back, reading as ledges.
  // Layer phase wanders with position so ledges never form a regular comb.
  const phase = yy * s.strataFreq + 0.9 * strataNoise(x * 0.22, yy * 0.15, z * 0.22) + 0.3 * Math.sin(theta * 2);
  const layer = Math.floor(phase);
  const layerAmp = 0.35 + 0.65 * fract(Math.sin(layer * 12.9898) * 43758.5453);
  const strata = s.strataAmp * layerAmp * smoothstep(0.15, 0.95, fract(phase));
  // Underside roots: angular fluting grows with depth.
  const flute = 1 + s.flute * sDepth * (strataNoise(Math.cos(theta) * 2.2, yy * 0.08, Math.sin(theta) * 2.2) * 1.1);
  const side = (rho - edge * lip * taper * (1 + strata) * flute) * 0.8;
  const topSurface = yy - topY;
  const floor = (topY - s.depth) - yy;
  return Math.max(side, topSurface, floor);
}

function makeOutline(seed: number, samples: number, amplitude: number, lobes: number): Float64Array {
  const noise = createNoise3(seed);
  const random = createSeededRandom(seed ^ 0x5bd1e995);
  const phase = random() * Math.PI * 2;
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const a = (i / samples) * Math.PI * 2;
    const n = fbm(noise, Math.cos(a) * 1.6 + 7.1, Math.sin(a) * 1.6 - 3.3, 0.5, 4);
    out[i] = 1 + amplitude * (n * 1.4 + 0.22 * Math.sin(a * lobes + phase));
  }
  return out;
}

/** Large decorative masses reuse the same geology at a scaled feature size, so
 * crags, strata and cracks keep their proportions instead of shrinking. */
export function createDensityField(island: IslandDefinition, archetype: TerrainArchetype): DensityField {
  const unit = Math.max(1, envelopeRadius(island) / 5.6);
  if (unit === 1) return createUnitDensityField(island, archetype);
  const f = createUnitDensityField({ ...island, radius: island.radius / unit, height: island.height / unit }, archetype);
  return {
    envelope: f.envelope * unit, yMin: f.yMin * unit, yMax: f.yMax * unit, detailBound: f.detailBound * unit,
    top: f.top * unit, bottom: f.bottom * unit,
    coarse: (x, y, z) => unit * f.coarse(x / unit, y / unit, z / unit),
    full: (x, y, z) => unit * f.full(x / unit, y / unit, z / unit),
  };
}

function createUnitDensityField(island: IslandDefinition, archetype: TerrainArchetype): DensityField {
  const V = envelopeRadius(island);
  const random = createSeededRandom(island.facetSeed ^ 0x27d4eb2f);
  const detailNoise = createNoise3(island.facetSeed);
  const warpNoise = createNoise3(island.facetSeed ^ 0x165667b1);
  const topNoiseField = createNoise3(island.facetSeed ^ 0x3c6ef372);
  const strataNoise = createNoise3(island.facetSeed ^ 0x1b873593);
  // Broken terraces (flat treads, short risers) cached on a 2D lattice.
  const terraceStep = 0.08, terraceSize = Math.ceil((2 * V) / terraceStep) + 2;
  const terraceTable = new Float32Array(terraceSize * terraceSize);
  for (let j = 0; j < terraceSize; j += 1) for (let i = 0; i < terraceSize; i += 1) {
    const x = -V + i * terraceStep, z = -V + j * terraceStep;
    const n = fbm(topNoiseField, x * 0.16, 0.37, z * 0.16, 3) * 2.2;
    const step = Math.floor(n * 1.6) / 1.6;
    terraceTable[i + j * terraceSize] = step + (n - step) * 0.25;
  }
  const terrace = (x: number, z: number) => {
    const fx = clamp((x + V) / terraceStep, 0, terraceSize - 1.001), fz = clamp((z + V) / terraceStep, 0, terraceSize - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, o = i + j * terraceSize;
    const a = terraceTable[o]! + (terraceTable[o + 1]! - terraceTable[o]!) * tx;
    const b = terraceTable[o + terraceSize]! + (terraceTable[o + terraceSize + 1]! - terraceTable[o + terraceSize]!) * tx;
    return a + (b - a) * tz;
  };
  const r = (a: number, b: number) => a + random() * (b - a);

  const hero = isHero(archetype);
  const cragAmp = hero ? 0.34 : 0.26;
  const warpAmp = hero ? 0.45 : 0.32;
  const detailBound = cragAmp * 0.75 + 0.12;

  let coarse: (x: number, y: number, z: number) => number;
  let top = 0.25 * V, bottom = -0.8 * V, yMin = -V, yMax = V;

  const carve: Array<(x: number, y: number, z: number, d: number) => number> = [];
  const extras: Array<(x: number, y: number, z: number) => number> = [];

  const addCracks = (count: number, radius: number, depthFrac: number, width: number) => {
    for (let i = 0; i < count; i += 1) {
      const a = r(0, Math.PI * 2), nx = Math.cos(a), nz = Math.sin(a);
      const offset = r(-0.35, 0.35) * radius, inner = radius * r(1 - depthFrac, 1 - depthFrac * 0.5);
      const w = width * r(0.7, 1.3);
      // Direction toward the rim the crack opens from.
      const sign = random() < 0.5 ? 1 : -1, mx = -nz * sign, mz = nx * sign;
      carve.push((x, y, z, d) => {
        const along = x * mx + z * mz;
        const jag = 0.35 * strataNoise(along * 0.45 + i * 7.3, y * 0.6, 3.1 * i) + 0.12 * strataNoise(along * 1.7, y * 2.1, i);
        const slab = Math.abs(x * nx + z * nz - offset - jag) - w * (0.4 + 0.6 * smoothstep(-radius, top, y));
        const crack = Math.max(slab, inner - along);
        return Math.max(d, -crack);
      });
    }
  };
  // Angular blocks (rotated, slightly rounded boxes) read as fractured rock, not blobs.
  const block = (bx: number, by: number, bz: number, hx: number, hy: number, hz: number) => {
    const yaw = r(0, Math.PI), tilt = r(-0.5, 0.5), cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
    return (x: number, y: number, z: number) => {
      const dx = x - bx, dy = y - by, dz = z - bz;
      const lx = cy * dx + sy * dz, lz0 = -sy * dx + cy * dz;
      const ly = ct * dy - st * lz0, lz = st * dy + ct * lz0;
      const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy, qz = Math.abs(lz) - hz;
      return len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - 0.05;
    };
  };
  const addBoulders = (count: number, radius: number, surface: (x: number, z: number) => number, size: [number, number]) => {
    for (let i = 0; i < count; i += 1) {
      const a = r(0, Math.PI * 2), rr = radius * Math.sqrt(r(0.05, 0.7));
      const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr, br = r(size[0], size[1]);
      const hx = br * r(0.7, 1.3), hy = br * r(0.45, 0.9), hz = br * r(0.6, 1.1);
      const by = surface(bx, bz) + hy * 0.35;
      extras.push(block(bx, by, bz, hx, hy, hz));
    }
  };
  // Hanging spikes blend smoothly into an underside (floating-island roots).
  const attached: Capsule[] = [];
  const addSpikes = (count: number, radius: number, from: number, to: [number, number], thickness: [number, number]) => {
    for (let i = 0; i < count; i += 1) {
      const a = r(0, Math.PI * 2), rr = radius * Math.sqrt(r(0, 0.55));
      const ax = Math.cos(a) * rr, az = Math.sin(a) * rr;
      // Varied length and lean so roots never read as a row of icicles.
      const length = r(0, 1) ** 1.6;
      attached.push({ ax, ay: from, az, bx: ax * r(0.3, 1.2) + r(-0.6, 0.6), by: to[1] + (to[0] - to[1]) * length, bz: az * r(0.3, 1.2) + r(-0.6, 0.6),
        ra: r(thickness[0], thickness[1]) * (1.2 - 0.5 * (1 - length)), rb: r(0.04, 0.16) });
    }
  };
  const addDebris = (count: number, size: [number, number], minR: number, maxR: number, yRange: [number, number]) => {
    for (let i = 0; i < count; i += 1) {
      const a = r(0, Math.PI * 2), rr = r(minR, maxR), br = r(size[0], size[1]);
      extras.push(block(Math.cos(a) * rr, r(yRange[0], yRange[1]), Math.sin(a) * rr, br * r(0.7, 1.3), br * r(0.5, 1.0), br * r(0.6, 1.2)));
    }
  };

  if (archetype === 'shattered-plateau' || archetype === 'mesa' || archetype === 'tilted-slab') {
    const big = archetype === 'shattered-plateau';
    const slab = archetype === 'tilted-slab';
    const shape: PlateauShape = {
      radius: V * (big ? 0.8 : slab ? r(0.68, 0.78) : r(0.62, 0.74)),
      top: V * (big ? 0.24 : r(0.12, 0.26)),
      depth: V * (big ? 1.02 : r(0.7, 0.98)),
      lip: big ? 0.07 : r(0.02, 0.07),
      outlineAmp: big ? 0.16 : r(0.1, 0.2),
      strataFreq: big ? 2.1 : r(1.6, 2.8),
      strataAmp: big ? 0.045 : r(0.025, 0.05),
      flute: big ? 0.32 : r(0.15, 0.35),
      terraceAmp: big ? 0.42 : r(0.15, 0.35),
      tiltX: slab ? r(-0.32, 0.32) : 0,
      tiltZ: slab ? r(0.18, 0.36) * (random() < 0.5 ? -1 : 1) : 0,
    };
    const outline = makeOutline(island.facetSeed, 512, shape.outlineAmp, big ? 5 : 3 + Math.floor(random() * 3));
    top = shape.top; bottom = shape.top - shape.depth;
    yMin = Math.max(-V, bottom - 0.6); yMax = Math.min(V, top + V * 0.42);
    const surface = (x: number, z: number) => shape.top + shape.terraceAmp * terrace(x, z) + shape.tiltX * x + shape.tiltZ * z;
    coarse = (x, y, z) => plateauDistance(shape, outline, terrace, x, y, z, strataNoise);
    if (big) {
      addCracks(5, shape.radius, 0.48, 0.22);
      addBoulders(6, shape.radius, surface, [0.32, 0.7]);
      addSpikes(4, shape.radius, top - shape.depth * 0.45, [-V * 0.92, -V * 0.55], [0.5, 0.95]);
      addDebris(8, [0.18, 0.42], shape.radius * 0.95, V * 0.95, [bottom * 0.15, top - 0.2]);
      // A broken shelf part-way down one cliff: a second, lower terrace tier.
      const a = r(0, Math.PI * 2), sx = Math.cos(a) * shape.radius * 0.78, sz = Math.sin(a) * shape.radius * 0.78;
      const shelfTop = top - V * 0.3, shelfR = shape.radius * 0.38;
      extras.push((x, y, z) => {
        const rs = len(x - sx, z - sz);
        return Math.max(rs - shelfR, y - shelfTop, shelfTop - 1.5 * (1 - rs / shelfR) - y);
      });
    } else {
      addCracks(slab ? 2 : 3, shape.radius, 0.4, 0.16);
      addBoulders(slab ? 2 : 4, shape.radius, surface, [0.2, 0.45]);
      addSpikes(2 + Math.floor(random() * 3), shape.radius * 0.8, top - shape.depth * 0.5, [-V * 0.85, -V * 0.6], [0.3, 0.55]);
      addDebris(3 + Math.floor(random() * 3), [0.16, 0.34], shape.radius, V * 0.95, [bottom * 0.3, top]);
    }
  } else if (archetype === 'splintered-spire' || archetype === 'spire') {
    const big = archetype === 'splintered-spire';
    const baseR = V * (big ? 0.46 : r(0.42, 0.52));
    const baseY = V * (big ? -0.12 : r(-0.2, -0.05));
    top = V * 0.85; bottom = -V * 0.92;
    const capsules: Capsule[] = [];
    const spireCount = big ? 7 : 3 + Math.floor(random() * 3);
    for (let i = 0; i < spireCount; i += 1) {
      const a = r(0, Math.PI * 2) + i * 2.4, rr = baseR * (i === 0 ? 0.05 : r(0.25, 0.68));
      const ax = Math.cos(a) * rr, az = Math.sin(a) * rr;
      const height = V * (i === 0 ? (big ? 0.9 : 0.8) : r(0.42, big ? 0.82 : 0.68));
      const lean = r(0.05, 0.22);
      capsules.push({ ax, ay: baseY, az, bx: ax * (1 + lean) + r(-0.3, 0.3), by: Math.min(height, V * 0.9), bz: az * (1 + lean) + r(-0.3, 0.3),
        ra: V * (i === 0 ? 0.24 : r(0.13, 0.2)), rb: V * r(0.012, 0.035) });
    }
    const roots: Capsule[] = [];
    const rootCount = big ? 5 : 2 + Math.floor(random() * 2);
    for (let i = 0; i < rootCount; i += 1) {
      const a = r(0, Math.PI * 2), rr = baseR * (i === 0 ? 0 : r(0.2, 0.55));
      const ax = Math.cos(a) * rr, az = Math.sin(a) * rr;
      roots.push({ ax, ay: baseY, az, bx: ax * 0.6, by: -V * (i === 0 ? 0.9 : r(0.45, 0.78)), bz: az * 0.6,
        ra: V * (i === 0 ? 0.3 : r(0.14, 0.22)), rb: V * 0.02 });
    }
    yMin = -V; yMax = V;
    coarse = (x, y, z) => {
      const theta = Math.atan2(z, x);
      // Fluted, slightly stratified base mass.
      const rho = len(x, z);
      const strata = 0.05 * smoothstep(0.1, 0.9, fract(y * 2.4 + 0.3 * Math.sin(theta * 2)));
      let d = (len(rho / (baseR * (1 + strata) * (1 + 0.12 * Math.sin(theta * 5))), (y - baseY) / (V * 0.3)) - 1) * Math.min(baseR, V * 0.3);
      for (const c of capsules) d = smin(d, taperedCapsule(c, x, y, z) * (1 - 0.18 * Math.sin(Math.atan2(z - c.az, x - c.ax) * 6)), big ? 0.55 : 0.45);
      for (const c of roots) d = smin(d, taperedCapsule(c, x, y, z), 0.6);
      return d;
    };
    if (big) {
      // Splinter cracks: thin vertical slabs through the spire cluster.
      for (let i = 0; i < 4; i += 1) {
        const a = r(0, Math.PI), nx = Math.cos(a), nz = Math.sin(a), off = r(-0.4, 0.4) * baseR, w = r(0.06, 0.12);
        const yStart = r(baseY + 0.4, V * 0.35);
        carve.push((x, y, z, d) => Math.max(d, -Math.max(Math.abs(x * nx + z * nz - off) - w, yStart - y)));
      }
      // Broken shards that have split away from the spires.
      for (let i = 0; i < 5; i += 1) {
        const a = r(0, Math.PI * 2), rr = r(baseR * 0.9, V * 0.78), y0 = r(-V * 0.2, V * 0.55);
        const ax = Math.cos(a) * rr, az = Math.sin(a) * rr, len = r(0.5, 1.1);
        const c: Capsule = { ax, ay: y0, az, bx: ax + r(-0.2, 0.2), by: y0 + len, bz: az + r(-0.2, 0.2), ra: r(0.16, 0.28), rb: 0.03 };
        extras.push((x, y, z) => taperedCapsule(c, x, y, z));
      }
      addDebris(6, [0.14, 0.3], baseR, V * 0.9, [-V * 0.5, V * 0.2]);
    } else {
      addDebris(3, [0.14, 0.3], baseR, V * 0.9, [-V * 0.4, V * 0.2]);
    }
  } else {
    // Rift archipelago / shard cluster: one stratified landmass shattered into
    // Voronoi fragments that drifted apart, keeping shared strata and origin.
    const big = archetype === 'rift-archipelago';
    const shape: PlateauShape = {
      radius: V * (big ? 0.6 : 0.55), top: V * (big ? 0.2 : 0.14), depth: V * (big ? 0.82 : 0.7), lip: 0.05,
      outlineAmp: 0.14, strataFreq: big ? 2.6 : 2.2, strataAmp: 0.08, flute: 0.25, terraceAmp: 0.25, tiltX: 0, tiltZ: 0,
    };
    const outline = makeOutline(island.facetSeed, 512, shape.outlineAmp, 4);
    top = shape.top; bottom = shape.top - shape.depth;
    yMin = -V; yMax = V * 0.75;
    const pieces = big ? 5 : 3;
    const seeds: Array<[number, number]> = [[0, 0]];
    const offsets: Array<[number, number, number]> = [[0, 0, 0]];
    for (let i = 1; i < pieces; i += 1) {
      const a = (i / (pieces - 1)) * Math.PI * 2 + r(-0.4, 0.4), rr = shape.radius * r(0.65, 0.85);
      seeds.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      const push = r(0.45, big ? 0.95 : 0.7);
      offsets.push([Math.cos(a) * push, r(-0.9, 0.55) * (big ? 1 : 0.6), Math.sin(a) * push]);
    }
    const gap = big ? 0.2 : 0.14;
    const cellDistance = (i: number, x: number, z: number) => {
      let d = -Infinity;
      const [sx, sz] = seeds[i]!;
      for (let j = 0; j < seeds.length; j += 1) {
        if (j === i) continue;
        const [tx, tz] = seeds[j]!;
        const nx = tx - sx, nz = tz - sz, l = len(nx, nz);
        d = Math.max(d, ((x - (sx + tx) / 2) * nx + (z - (sz + tz) / 2) * nz) / l);
      }
      return d;
    };
    const base = (x: number, y: number, z: number) => plateauDistance(shape, outline, terrace, x, y, z, strataNoise);
    coarse = (x, y, z) => {
      let best = Infinity;
      for (let i = 0; i < pieces; i += 1) {
        const [ox, oy, oz] = offsets[i]!;
        const qx = x - ox, qy = y - oy, qz = z - oz;
        const cell = cellDistance(i, qx, qz) + gap;
        if (cell > best) continue;
        best = Math.min(best, Math.max(base(qx, qy, qz), cell));
      }
      return best;
    };
    addDebris(big ? 10 : 4, [0.14, 0.36], shape.radius * 0.3, V * 0.9, [bottom, top + 0.6]);
    if (big) addBoulders(4, shape.radius * 0.7, (x, z) => shape.top + shape.terraceAmp * terrace(x, z), [0.22, 0.42]);
  }

  const withExtras = (x: number, y: number, z: number, d: number) => {
    for (const c of attached) d = smin(d, taperedCapsule(c, x, y, z), 0.7);
    for (const e of extras) d = Math.min(d, e(x, y, z));
    return d;
  };

  const full = (x: number, y: number, z: number) => {
    const wx = warpNoise(x * 0.32 + 11.3, y * 0.32, z * 0.32) * warpAmp;
    const wy = warpNoise(x * 0.32, y * 0.32 + 5.7, z * 0.32) * warpAmp * 0.6;
    const wz = warpNoise(x * 0.32, y * 0.32, z * 0.32 - 8.9) * warpAmp;
    const px = x + wx, py = y + wy, pz = z + wz;
    let d = withExtras(px, py, pz, coarse(px, py, pz));
    // Top surfaces get gentler detail; cliffs get vertically stretched crags
    // (directional erosion runnels) plus finer fractured breakup.
    const topness = smoothstep(top - 0.9, top + 0.2, py) * (1 - smoothstep(top + 0.45, top + 1.1, py));
    const crag = ridged(detailNoise, px * 0.85, py * 0.42, pz * 0.85, 4);
    const fine = fbm(detailNoise, px * 2.3 + 17, py * 2.3, pz * 2.3, 3);
    d -= (crag - 0.45) * cragAmp * (1 - 0.7 * topness);
    d += fine * 0.1 * (1 - 0.6 * topness);
    for (const c of carve) d = c(px, py, pz, d);
    return Math.max(d, len(x, y, z) - V);
  };
  const coarseWithExtras = (x: number, y: number, z: number) => Math.max(withExtras(x, y, z, coarse(x, y, z)), len(x, y, z) - V);

  return { envelope: V, yMin, yMax, coarse: coarseWithExtras, full, detailBound: detailBound + warpAmp * 1.3, top, bottom };
}
