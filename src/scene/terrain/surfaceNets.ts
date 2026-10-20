/** Naive surface nets over a scalar grid (positive = solid rock).
 * Grid boundary samples must be non-solid so every extracted surface is closed. */
export interface ScalarGrid {
  readonly nx: number; // cells per axis; corners are n + 1
  readonly ny: number;
  readonly nz: number;
  readonly origin: readonly [number, number, number];
  readonly cell: number;
  readonly values: Float32Array;
}

export interface SurfaceMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const;
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const;

export function cornerIndex(grid: Pick<ScalarGrid, 'nx' | 'ny'>, i: number, j: number, k: number): number {
  return i + (grid.nx + 1) * (j + (grid.ny + 1) * k);
}

/** Central-difference gradient at a corner (one-sided at the boundary). */
function cornerGradient(grid: ScalarGrid, i: number, j: number, k: number, out: Float64Array, offset: number): void {
  const { nx, ny, nz, values } = grid;
  const at = (a: number, b: number, c: number) => values[cornerIndex(grid, a, b, c)]!;
  const i0 = Math.max(0, i - 1), i1 = Math.min(nx, i + 1);
  const j0 = Math.max(0, j - 1), j1 = Math.min(ny, j + 1);
  const k0 = Math.max(0, k - 1), k1 = Math.min(nz, k + 1);
  out[offset] = (at(i1, j, k) - at(i0, j, k)) / (i1 - i0);
  out[offset + 1] = (at(i, j1, k) - at(i, j0, k)) / (j1 - j0);
  out[offset + 2] = (at(i, j, k1) - at(i, j, k0)) / (k1 - k0);
}

export function extractSurface(grid: ScalarGrid): SurfaceMesh {
  const { nx, ny, nz, origin, cell, values } = grid;
  const cellIndex = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const corner = new Float64Array(8);
  const gradients = new Float64Array(24);

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        let mask = 0;
        for (let c = 0; c < 8; c += 1) {
          const o = CORNERS[c]!;
          const v = values[cornerIndex(grid, i + o[0], j + o[1], k + o[2])]!;
          corner[c] = v;
          if (v > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, count = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a]!, vb = corner[b]!;
          if ((va > 0) === (vb > 0)) continue;
          const t = va / (va - vb);
          const oa = CORNERS[a]!, ob = CORNERS[b]!;
          sx += oa[0] + t * (ob[0] - oa[0]);
          sy += oa[1] + t * (ob[1] - oa[1]);
          sz += oa[2] + t * (ob[2] - oa[2]);
          count += 1;
        }
        const fx = sx / count, fy = sy / count, fz = sz / count;

        for (let c = 0; c < 8; c += 1) {
          const o = CORNERS[c]!;
          cornerGradient(grid, i + o[0], j + o[1], k + o[2], gradients, c * 3);
        }
        let gx = 0, gy = 0, gz = 0;
        for (let c = 0; c < 8; c += 1) {
          const o = CORNERS[c]!;
          const w = (o[0] ? fx : 1 - fx) * (o[1] ? fy : 1 - fy) * (o[2] ? fz : 1 - fz);
          gx += w * gradients[c * 3]!; gy += w * gradients[c * 3 + 1]!; gz += w * gradients[c * 3 + 2]!;
        }
        const gl = Math.hypot(gx, gy, gz) || 1;

        cellIndex[i + nx * (j + ny * k)] = positions.length / 3;
        positions.push(origin[0] + (i + fx) * cell, origin[1] + (j + fy) * cell, origin[2] + (k + fz) * cell);
        normals.push(-gx / gl, -gy / gl, -gz / gl);
      }
    }
  }

  const indices: number[] = [];
  const cellAt = (i: number, j: number, k: number) => cellIndex[i + nx * (j + ny * k)]!;
  const emit = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    // Split along the shorter diagonal to avoid long slivers.
    const ac = dist2(positions, a, c), bd = dist2(positions, b, d);
    if (ac <= bd) indices.push(a, b, c, a, c, d);
    else indices.push(a, b, d, b, c, d);
  };

  for (let k = 0; k <= nz; k += 1) {
    for (let j = 0; j <= ny; j += 1) {
      for (let i = 0; i <= nx; i += 1) {
        const inside = values[cornerIndex(grid, i, j, k)]! > 0;
        if (i < nx && j > 0 && k > 0 && j < ny && k < nz) {
          const next = values[cornerIndex(grid, i + 1, j, k)]! > 0;
          if (inside !== next) emit(cellAt(i, j - 1, k - 1), cellAt(i, j, k - 1), cellAt(i, j, k), cellAt(i, j - 1, k), !inside);
        }
        if (j < ny && i > 0 && k > 0 && i < nx && k < nz) {
          const next = values[cornerIndex(grid, i, j + 1, k)]! > 0;
          if (inside !== next) emit(cellAt(i - 1, j, k - 1), cellAt(i - 1, j, k), cellAt(i, j, k), cellAt(i, j, k - 1), !inside);
        }
        if (k < nz && i > 0 && j > 0 && i < nx && j < ny) {
          const next = values[cornerIndex(grid, i, j, k + 1)]! > 0;
          if (inside !== next) emit(cellAt(i - 1, j - 1, k), cellAt(i, j - 1, k), cellAt(i, j, k), cellAt(i - 1, j, k), !inside);
        }
      }
    }
  }

  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

function dist2(p: readonly number[], a: number, b: number): number {
  const dx = p[a * 3]! - p[b * 3]!, dy = p[a * 3 + 1]! - p[b * 3 + 1]!, dz = p[a * 3 + 2]! - p[b * 3 + 2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** Drop connected components below a triangle threshold (sub-cell noise specks),
 * then compact unused vertices. Intentional debris is authored above the threshold. */
export function removeSmallComponents(mesh: SurfaceMesh, minTriangles: number): SurfaceMesh {
  const vertexCount = mesh.positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  };
  const { indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]!), b = find(indices[t + 1]!), c = find(indices[t + 2]!);
    parent[b] = a; parent[find(c)] = a;
  }
  const triangleCount = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t]!);
    triangleCount.set(root, (triangleCount.get(root) ?? 0) + 1);
  }
  const remap = new Int32Array(vertexCount).fill(-1);
  const kept: number[] = [];
  let next = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if ((triangleCount.get(find(indices[t]!)) ?? 0) < minTriangles) continue;
    for (let c = 0; c < 3; c += 1) {
      const v = indices[t + c]!;
      if (remap[v] === -1) remap[v] = next++;
      kept.push(remap[v]!);
    }
  }
  const positions = new Float32Array(next * 3);
  const normals = new Float32Array(next * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    const r = remap[v]!;
    if (r < 0) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), r * 3);
    normals.set(mesh.normals.subarray(v * 3, v * 3 + 3), r * 3);
  }
  return { positions, normals, indices: new Uint32Array(kept) };
}
