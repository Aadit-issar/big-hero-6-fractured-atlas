import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/simulation/worldGenerator';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { archetypeFor, envelopeRadius, HERO_ARCHETYPES } from '../src/scene/terrain/archetypes';
import { cellSizeFor, finishTerrainFromSlabs, generateTerrain, sampleTerrainSlab, TERRAIN_RESOLUTIONS, terrainBlockRows } from '../src/scene/terrain/terrainGenerator';
import type { TerrainMeshData } from '../src/scene/terrain/terrainGenerator';
import { QUALITY_PRESETS } from '../src/rendering/qualitySettings';
import { MIRROR_Y } from '../src/scene/dimension/layout';
import { generateGasNoise } from '../src/scene/gas/gasNoise';
import { FOLD_OPENING, gasSimulationInputs } from '../src/scene/gas/gasInputs';

const world = createWorld(17062026);
const coarse = { heroCell: 0.24, supportCell: 0.3 };
const meshes = new Map<string, TerrainMeshData>();
const meshFor = (index: number) => {
  const island = world.islands[index]!;
  if (!meshes.has(island.id)) meshes.set(island.id, generateTerrain({ island, index, cellSize: cellSizeFor(island, index, coarse) }));
  return meshes.get(island.id)!;
};

describe('Phase 3 procedural geology', () => {
  it('casts three distinct hero archetypes onto stable island identities and varies supporting forms', () => {
    const cast = world.islands.map((island, index) => archetypeFor(island, index));
    for (const [id, archetype] of Object.entries(HERO_ARCHETYPES)) expect(cast[world.islands.findIndex((i) => i.id === id)]).toBe(archetype);
    expect(new Set(Object.values(HERO_ARCHETYPES)).size).toBe(3);
    const supporting = cast.filter((_, i) => !HERO_ARCHETYPES[world.islands[i]!.id]);
    expect(new Set(supporting).size).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < cast.length; i += 1) expect(cast[i]).not.toBe(cast[i - 1]);
  });

  it('generates identical meshes for identical inputs (deterministic, no hidden randomness)', () => {
    const island = world.islands[4]!;
    const a = generateTerrain({ island, index: 4, cellSize: 0.25 });
    const b = generateTerrain({ island, index: 4, cellSize: 0.25 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
  });

  it('slab-parallel sampling merges into exactly the single-pass mesh', () => {
    const request = { island: world.islands[2]!, index: 2, cellSize: 0.22 };
    const rows = terrainBlockRows(request);
    const slabs = [sampleTerrainSlab(request, 0, 3), sampleTerrainSlab(request, 3, 7), sampleTerrainSlab(request, 7, rows)];
    const merged = finishTerrainFromSlabs(request, [slabs[2]!, slabs[0]!, slabs[1]!]);
    const single = generateTerrain(request);
    expect(Array.from(merged.positions)).toEqual(Array.from(single.positions));
    expect(Array.from(merged.indices)).toEqual(Array.from(single.indices));
    expect(Array.from(merged.terrain)).toEqual(Array.from(single.terrain));
  });

  it('produces finite, unit-normal, well-indexed, non-degenerate geometry for every island', () => {
    for (let index = 0; index < world.islands.length; index += 1) {
      const mesh = meshFor(index);
      const vertices = mesh.positions.length / 3;
      expect(vertices).toBeGreaterThan(200);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      for (let v = 0; v < vertices; v += 1) {
        const n = Math.hypot(mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!);
        expect(Math.abs(n - 1)).toBeLessThan(1e-4);
      }
      let max = 0;
      for (const i of mesh.indices) max = Math.max(max, i);
      expect(max).toBeLessThan(vertices);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
        expect(a !== b && b !== c && a !== c).toBe(true);
      }
    }
  });

  it('keeps all visual rock inside the explorer clearance sphere, even at maximum local strain', () => {
    for (let index = 0; index < world.islands.length; index += 1) {
      const island = world.islands[index]!;
      const mesh = meshFor(index);
      expect(mesh.maxVertexRadius).toBeLessThanOrEqual(envelopeRadius(island) + 1e-3);
      // boundedLocalJacobian stretches by at most 1.18 (Phase 2 bound), so a
      // checked traversal exit (clearance > 1u) can never sit inside rock.
      expect(mesh.maxVertexRadius * 1.18).toBeLessThan(island.radius + island.height);
    }
  });

  it('builds closed surfaces without open boundary edges', () => {
    for (const index of [0, 2, 4, 7]) {
      const mesh = meshFor(index);
      const edges = new Map<string, number>();
      for (let t = 0; t < mesh.indices.length; t += 3) {
        for (let e = 0; e < 3; e += 1) {
          const a = mesh.indices[t + e]!, b = mesh.indices[t + ((e + 1) % 3)]!;
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      const counts = [...edges.values()];
      expect(counts.some((count) => count === 1)).toBe(false);
      // Surface nets can pinch rare ambiguous cells into non-manifold (4-face) edges; measured ≈0.2% at test resolution.
      expect(counts.filter((count) => count !== 2).length / counts.length).toBeLessThan(0.005);
    }
  });

  it('orients triangles outward (positive enclosed volume)', () => {
    const mesh = meshFor(0);
    const p = mesh.positions;
    let volume = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]! * 3, b = mesh.indices[t + 1]! * 3, c = mesh.indices[t + 2]! * 3;
      volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
        - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
        + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
    }
    expect(volume).toBeGreaterThan(20);
  });

  it('rejects invalid resolutions instead of clamping them', () => {
    expect(() => generateTerrain({ island: world.islands[0]!, index: 0, cellSize: Number.NaN })).toThrow(RangeError);
    expect(() => generateTerrain({ island: world.islands[0]!, index: 0, cellSize: 0 })).toThrow(RangeError);
  });

  it('keeps the mirror floor below every island path', () => {
    const engine = new SimulationEngine();
    for (const island of engine.world.islands) {
      for (let t = 0; t <= 240; t += 4) expect(engine.evaluateIsland(island, t)[1] - (island.radius + island.height)).toBeGreaterThan(MIRROR_Y);
    }
  });
});

describe('gaseous dimension inputs', () => {
  it('generates deterministic tileable gas noise whose parallel slabs merge exactly', () => {
    const whole = generateGasNoise(17062026, 24);
    expect(generateGasNoise(17062026, 24).data).toEqual(whole.data);
    const merged = new Uint8Array(whole.data.length);
    for (const [from, to] of [[0, 7], [7, 15], [15, 24]] as const) {
      const slab = generateGasNoise(17062026, 24, from, to);
      merged.set(slab.data, from * 24 * 24 * 2);
    }
    expect(merged).toEqual(whole.data);
    let low = 255, high = 0;
    for (let i = 0; i < whole.data.length; i += 2) { low = Math.min(low, whole.data[i]!); high = Math.max(high, whole.data[i]!); }
    expect(high - low).toBeGreaterThan(120);
    expect(generateGasNoise(17062027, 24).data).not.toEqual(whole.data);
  });

  it('opens gas passages only at real graph connections and reads hazards without mutating the engine', () => {
    const engine = new SimulationEngine(), reference = new SimulationEngine();
    for (const t of [0, 7.3, 16.25, 48.6]) {
      const inputs = gasSimulationInputs(engine, t, [0, 10, 20]);
      expect(gasSimulationInputs(engine, t, [0, 10, 20])).toEqual(inputs);
      const lattice = Math.floor(t * 4) / 4;
      const endpoints = engine.network.getConnections(lattice).filter((c) => c.valid && (FOLD_OPENING[c.state] ?? 0) > 0)
        .flatMap((c) => [c.entryWorldPosition, c.exitWorldPosition]);
      for (const f of inputs.folds) {
        expect(f[3]).toBeGreaterThan(0);
        expect(endpoints.some((p) => p[0] === f[0] && p[1] === f[1] && p[2] === f[2])).toBe(true);
      }
      expect(inputs.hazards).toHaveLength(4);
      for (const h of inputs.hazards) { expect(h.every(Number.isFinite)).toBe(true); expect(h[3]).toBeGreaterThanOrEqual(0); expect(h[3]).toBeLessThanOrEqual(1); }
      expect(engine.network.getConnections(lattice)).toEqual(reference.network.getConnections(lattice));
    }
    // A closed connection never opens a passage.
    expect(FOLD_OPENING.closed).toBe(0);
    expect(FOLD_OPENING.inactive).toBe(0);
  });
});

describe('rendering quality isolation', () => {
  it('quality presets carry only rendering parameters and leave the simulation identical', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(Object.keys(preset).sort()).toEqual(['anisotropy', 'bloom', 'crystals', 'gas', 'level', 'maxDpr', 'mirrorPanes', 'motes', 'shadowMapSize', 'shadows', 'skyCubeSize', 'terrain'].sort());
      expect(Object.values(TERRAIN_RESOLUTIONS)).toContain(preset.terrain);
    }
    const a = new SimulationEngine(), b = new SimulationEngine();
    // Generating terrain at any preset must not touch engine state.
    generateTerrain({ island: a.world.islands[1]!, index: 1, cellSize: cellSizeFor(a.world.islands[1]!, 1, QUALITY_PRESETS.performance.terrain) });
    for (const t of [0, 3.25, 17.5]) {
      expect(a.sampleField([0.3, 1, -2], t)).toEqual(b.sampleField([0.3, 1, -2], t));
      expect(a.network.getConnections(t)).toEqual(b.network.getConnections(t));
    }
    expect(a.world).toEqual(b.world);
  });
});
