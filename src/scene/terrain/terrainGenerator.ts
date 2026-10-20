import type { IslandDefinition } from '../../simulation/types';
import { archetypeFor, createDensityField, isHero } from './archetypes';
import type { DensityField, TerrainArchetype } from './archetypes';
import { cornerIndex, extractSurface, removeSmallComponents } from './surfaceNets';
import type { ScalarGrid } from './surfaceNets';

/** Plain transferable mesh data (no Three.js objects), produced in workers. */
export interface TerrainMeshData {
  readonly islandId: string;
  readonly archetype: TerrainArchetype;
  readonly cellSize: number;
  readonly positions: Float32Array;
  /** Outward unit normals from the density gradient. */
  readonly normals: Float32Array;
  /** Per-vertex [cavity AO, sky exposure, normalized height, macro variation] as 0..255. */
  readonly terrain: Uint8Array;
  readonly indices: Uint32Array;
  readonly envelope: number;
  readonly maxVertexRadius: number;
  readonly milliseconds: number;
  readonly phases: { readonly sampleMs: number; readonly meshMs: number; readonly attributeMs: number; readonly gridCorners: number };
}

export interface TerrainResolution {
  readonly heroCell: number;
  readonly supportCell: number;
}

export const TERRAIN_RESOLUTIONS = {
  performance: { heroCell: 0.17, supportCell: 0.24 },
  balanced: { heroCell: 0.115, supportCell: 0.17 },
  cinematic: { heroCell: 0.085, supportCell: 0.13 },
} as const satisfies Record<string, TerrainResolution>;

export interface TerrainRequest {
  readonly island: IslandDefinition;
  readonly index: number;
  /** Absolute cell size in geometry-local rendering units. */
  readonly cellSize: number;
  /** Overrides identity-based casting (decorative distant scenery only). */
  readonly archetype?: TerrainArchetype;
}

export function cellSizeFor(island: IslandDefinition, index: number, resolution: TerrainResolution, lodScale = 1): number {
  return (isHero(archetypeFor(island, index)) ? resolution.heroCell : resolution.supportCell) * lodScale;
}

const BLOCK = 4;
const len = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);

function gridLayout(field: DensityField, cell: number) {
  const V = field.envelope;
  const margin = cell * 2;
  const origin = [-V - margin, field.yMin - margin, -V - margin] as const;
  const nx = Math.ceil((2 * V + 2 * margin) / cell / BLOCK) * BLOCK;
  const ny = Math.ceil((field.yMax - field.yMin + 2 * margin) / cell / BLOCK) * BLOCK;
  return { origin, nx, ny, nz: nx, blockRows: nx / BLOCK };
}

/** Samples block rows [fromRow, toRow) along z. Rows are processed in the same
 * order as a full pass, so merged slabs are bit-identical to one-pass output. */
function sampleGrid(field: DensityField, cell: number, fromRow = 0, toRow = Infinity): ScalarGrid {
  const { origin, nx, ny, nz } = gridLayout(field, cell);
  const values = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const slack = field.detailBound + cell * 2;
  // Distances here are approximate; 1.5 bounds their Lipschitz constant.
  const blockSlack = slack + BLOCK * cell * Math.sqrt(3) * 1.5;
  const bx = nx / BLOCK, by = ny / BLOCK, bz = nz / BLOCK;
  const blockValues = new Float32Array((bx + 1) * (by + 1) * (bz + 1));
  const bIndex = (i: number, j: number, k: number) => i + (bx + 1) * (j + (by + 1) * k);
  for (let k = 0; k <= bz; k += 1) for (let j = 0; j <= by; j += 1) for (let i = 0; i <= bx; i += 1) {
    blockValues[bIndex(i, j, k)] = field.coarse(origin[0] + i * BLOCK * cell, origin[1] + j * BLOCK * cell, origin[2] + k * BLOCK * cell);
  }
  const corner = new Float64Array(8);
  for (let bk = fromRow; bk < Math.min(bz, toRow); bk += 1) for (let bj = 0; bj < by; bj += 1) for (let bi = 0; bi < bx; bi += 1) {
    let far = true;
    for (let c = 0; c < 8; c += 1) {
      const v = blockValues[bIndex(bi + (c & 1), bj + ((c >> 1) & 1), bk + ((c >> 2) & 1))]!;
      corner[c] = v;
      if (Math.abs(v) <= blockSlack || Math.sign(v) !== Math.sign(corner[0]!)) far = false;
    }
    for (let dk = 0; dk <= BLOCK; dk += 1) for (let dj = 0; dj <= BLOCK; dj += 1) for (let di = 0; di <= BLOCK; di += 1) {
      const i = bi * BLOCK + di, j = bj * BLOCK + dj, k = bk * BLOCK + dk;
      const index = cornerIndex({ nx, ny }, i, j, k);
      if (i === 0 || j === 0 || k === 0 || i === nx || j === ny || k === nz) { values[index] = -1; continue; }
      if (far) {
        // Whole block is far from the surface: interpolate the coarse distance.
        const tx = di / BLOCK, ty = dj / BLOCK, tz = dk / BLOCK;
        const x0 = corner[0]! + (corner[1]! - corner[0]!) * tx, x1 = corner[2]! + (corner[3]! - corner[2]!) * tx;
        const x2 = corner[4]! + (corner[5]! - corner[4]!) * tx, x3 = corner[6]! + (corner[7]! - corner[6]!) * tx;
        const y0 = x0 + (x1 - x0) * ty, y1 = x2 + (x3 - x2) * ty;
        values[index] = -(y0 + (y1 - y0) * tz);
        continue;
      }
      const x = origin[0] + i * cell, y = origin[1] + j * cell, z = origin[2] + k * cell;
      const coarse = field.coarse(x, y, z);
      // Only evaluate expensive detail inside the shell where it can flip the sign.
      values[index] = -(Math.abs(coarse) > slack ? coarse : field.full(x, y, z));
    }
  }
  return { nx, ny, nz, origin, cell, values };
}

function sampleTrilinear(grid: ScalarGrid, x: number, y: number, z: number): number {
  const fx = (x - grid.origin[0]) / grid.cell, fy = (y - grid.origin[1]) / grid.cell, fz = (z - grid.origin[2]) / grid.cell;
  if (fx < 0 || fy < 0 || fz < 0 || fx >= grid.nx || fy >= grid.ny || fz >= grid.nz) return -1;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const v = (a: number, b: number, c: number) => grid.values[cornerIndex(grid, i + a, j + b, k + c)]!;
  const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * tx, x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * tx;
  const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * tx, x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * tx;
  const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
  return y0 + (y1 - y0) * tz;
}

function prepare({ island, index, cellSize, archetype: override }: TerrainRequest) {
  if (!(cellSize > 0.02) || !Number.isFinite(cellSize)) throw new RangeError('Terrain cell size must be finite and > 0.02.');
  const archetype = override ?? archetypeFor(island, index);
  return { archetype, field: createDensityField(island, archetype) };
}

export function terrainBlockRows(request: TerrainRequest): number {
  const { field } = prepare(request);
  return gridLayout(field, request.cellSize).blockRows;
}

export interface TerrainSlab { readonly offset: number; readonly values: Float32Array; readonly milliseconds: number }

/** Parallel stage: one z-slab of corner samples (rows k in [4*from, 4*to]). */
export function sampleTerrainSlab(request: TerrainRequest, fromRow: number, toRow: number): TerrainSlab {
  const started = Date.now();
  const { field } = prepare(request);
  const grid = sampleGrid(field, request.cellSize, fromRow, toRow);
  const plane = (grid.nx + 1) * (grid.ny + 1);
  const lastRow = Math.min(grid.nz, toRow * BLOCK);
  return { offset: fromRow * BLOCK * plane, values: grid.values.slice(fromRow * BLOCK * plane, (lastRow + 1) * plane), milliseconds: Date.now() - started };
}

/** Merges slabs in row order (later rows overwrite shared boundary rows exactly
 * as a single pass would) and finishes the mesh. */
export function finishTerrainFromSlabs(request: TerrainRequest, slabs: readonly TerrainSlab[]): TerrainMeshData {
  const started = Date.now();
  const { archetype, field } = prepare(request);
  const { origin, nx, ny, nz } = gridLayout(field, request.cellSize);
  const values = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  for (const slab of [...slabs].sort((a, b) => a.offset - b.offset)) values.set(slab.values, slab.offset);
  const sampleMs = slabs.reduce((longest, slab) => Math.max(longest, slab.milliseconds), 0);
  return finish(request, archetype, field, { nx, ny, nz, origin, cell: request.cellSize, values }, started - sampleMs);
}

export function generateTerrain(request: TerrainRequest): TerrainMeshData {
  const started = Date.now();
  const { archetype, field } = prepare(request);
  return finish(request, archetype, field, sampleGrid(field, request.cellSize), started);
}

function finish({ island, cellSize }: TerrainRequest, archetype: TerrainArchetype, field: DensityField, grid: ScalarGrid, started: number): TerrainMeshData {
  const sampled = Date.now();
  const mesh = removeSmallComponents(extractSurface(grid), 24);
  const meshed = Date.now();
  const { positions, normals } = mesh;
  const count = positions.length / 3;
  const terrain = new Uint8Array(count * 4);
  const span = Math.max(1e-6, field.top - field.bottom);
  let maxVertexRadius = 0;
  const unit = Math.max(1, field.envelope / 5.6);
  const reach = [0.35 * unit, 0.8 * unit, 1.6 * unit];
  for (let v = 0; v < count; v += 1) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const nx = normals[v * 3]!, ny = normals[v * 3 + 1]!, nz = normals[v * 3 + 2]!;
    maxVertexRadius = Math.max(maxVertexRadius, len(x, y, z));
    // Cavity occlusion: how much solid rock lies along the outward normal.
    let occlusion = 0;
    for (const d of reach) occlusion += Math.max(0, Math.min(1, sampleTrilinear(grid, x + nx * d, y + ny * d, z + nz * d) / d + 0.15));
    // Sky exposure: upward-facing and not covered by an overhang.
    let covered = 0;
    for (const d of [0.6, 1.4, 2.6]) if (sampleTrilinear(grid, x, y + d * unit, z) > 0) covered += 1;
    const exposure = Math.max(0, Math.min(1, (ny - 0.45) / 0.4)) * (1 - covered / 3);
    const height = Math.max(0, Math.min(1, (y - field.bottom) / span));
    const variation = 0.5 + 0.5 * Math.sin((x * 0.53 + Math.sin(z * 0.41 / unit) * 2.1 * unit) / unit) * Math.cos((z * 0.37 - y * 0.29) / unit);
    terrain[v * 4] = Math.round(255 * Math.max(0, 1 - occlusion / reach.length * 1.25));
    terrain[v * 4 + 1] = Math.round(255 * exposure);
    terrain[v * 4 + 2] = Math.round(255 * height);
    terrain[v * 4 + 3] = Math.round(255 * variation);
  }
  return {
    islandId: island.id, archetype, cellSize, positions, normals, terrain, indices: mesh.indices,
    envelope: field.envelope, maxVertexRadius, milliseconds: Date.now() - started,
    phases: { sampleMs: sampled - started, meshMs: meshed - sampled, attributeMs: Date.now() - meshed, gridCorners: grid.values.length },
  };
}
