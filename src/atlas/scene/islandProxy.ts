import { BufferGeometry, IcosahedronGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashUnit } from './sceneModel';

/** Illustrative floating-island form. The sensor reports an island's position and range only, so this
 * shape is a stylised proxy seeded from the island's id. It is NOT a measured scan and is labelled so. */
function hash3(x: number, y: number, z: number, s: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ s) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, z: number, s: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz, s);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x: number, y: number, z: number, s: number, oct = 4): number {
  let sum = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i += 1) { sum += a * vnoise(x, y, z, s + i * 131); n += a; x = x * 2.03 + 11.7; y = y * 2.03 + 11.7; z = z * 2.03 + 11.7; a *= 0.5; }
  return sum / n;
}

export interface IslandForm { readonly geometry: BufferGeometry; readonly radius: number; readonly minY: number; readonly maxY: number }

export function createIslandForm(id: string, detail = 26): IslandForm {
  const seed = Math.floor(hashUnit(id, 7) * 1e9);
  const radius = 5.2 + hashUnit(id, 11) * 2.4;
  const spire = 0.8 + hashUnit(id, 13) * 0.7;
  const base = new IcosahedronGeometry(1, detail);
  base.deleteAttribute('normal'); base.deleteAttribute('uv');
  const geometry = mergeVertices(base, 1e-4);
  base.dispose();
  const pos = geometry.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    const dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const bulk = fbm(dx * 1.5 + 3, dy * 1.5, dz * 1.5 + 9, seed, 3);
    let rad = 0.86 + 0.5 * (bulk - 0.5) + 0.22 * (fbm(dx * 3.2, dy * 3.2, dz * 3.2, seed + 5, 3) - 0.5);
    let xz: number, y: number;
    if (dy >= 0) {
      // Weathered upper plateau: low dome, stepped terraces, ridges.
      const terrain = fbm(dx * 2.6, 0.5, dz * 2.6, seed + 9, 4);
      const terrace = Math.round(terrain * 6) / 6;
      y = dy * 0.2 + dy * (0.05 + 0.34 * (terrain * 0.4 + terrace * 0.6));
      xz = rad * (1 - 0.1 * dy);
    } else {
      // Inverted rocky spire with hanging buttresses.
      const t = -dy;
      const ridge = 1 - Math.abs(2 * fbm(dx * 2.2 + 5, dy * 1.4, dz * 2.2, seed + 21, 4) - 1);
      y = dy * (0.85 + 0.5 * ridge) * spire;
      xz = rad * (1 - 0.78 * Math.pow(t, 0.95)) * (0.92 + 0.3 * ridge * t);
    }
    // Fine fracture relief along the radial direction.
    const fine = 1 + 0.045 * (fbm(dx * 8, dy * 8, dz * 8, seed + 33, 3) - 0.5);
    const px = dx * xz * fine * radius, pz = dz * xz * fine * radius, py = y * radius;
    out[i * 3] = px; out[i * 3 + 1] = py; out[i * 3 + 2] = pz;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  // Floating fragments in the same local frame (decorative, seeded by id; part of the illustrative form).
  const parts: BufferGeometry[] = [geometry];
  const chunks = 5 + Math.floor(hashUnit(id, 17) * 4);
  for (let c = 0; c < chunks; c += 1) {
    const a = hashUnit(id, 100 + c) * Math.PI * 2, rr = radius * (0.95 + hashUnit(id, 120 + c) * 0.7);
    const size = radius * (0.07 + hashUnit(id, 140 + c) * 0.13);
    const cy = radius * (-0.75 + hashUnit(id, 160 + c) * 1.05);
    const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
    const ico = new IcosahedronGeometry(1, 5);
    ico.deleteAttribute('normal'); ico.deleteAttribute('uv');
    const g = mergeVertices(ico, 1e-4);
    ico.dispose();
    const p = g.getAttribute('position');
    const o = new Float32Array(p.count * 3);
    const sx = 0.8 + hashUnit(id, 180 + c) * 0.8, sy = 0.45 + hashUnit(id, 200 + c) * 0.5;
    for (let i = 0; i < p.count; i += 1) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = 0.75 + 0.5 * fbm(x * 1.8 + c * 3, y * 1.8, z * 1.8, seed + 300 + c, 3);
      o[i * 3] = cx + x * r * size * sx; o[i * 3 + 1] = cy + y * r * size * sy * (y < 0 ? 1.5 : 1); o[i * 3 + 2] = cz + z * r * size * sx;
    }
    g.setAttribute('position', new Float32BufferAttribute(o, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach(g => g.dispose());
  merged.computeBoundingSphere();
  let lo = Infinity, hi = -Infinity;
  const mp = merged.getAttribute('position');
  for (let i = 0; i < mp.count; i += 1) { const y = mp.getY(i); if (y < lo) lo = y; if (y > hi) hi = y; }
  return { geometry: merged, radius, minY: lo, maxY: hi };
}
