# Architecture — Phases 2 and 3

## Authoritative data flow

```text
seed → original field draws → versioned spatial scale/time parameters
                               ↓ Φ / gradient / Hessian / temporal derivative
                       map + symmetric Jacobian spectrum
                       ├─ fold roots → endpoint rules → sampled connection graph
                       ├─ hazard / gravity → fixed-step tethered probes
                       ├─ branch-local inverse → explorer reference estimate
                       └─ island centers + bounded local affine strain
single model clock ─────────────┴─────────────→ rendering / throttled HUD
E + nearby graph endpoint → atomic branch transfer → actual camera pose
```

Simulation modules do not import React or Three.js. Renderer effects consume graph/field state; no glow creates connectivity. Original Phase 1 seed generation, procedural geometry, clock controls and regression tests remain intact.

## Modules and interfaces

| Module | Responsibility |
| --- | --- |
| `field.ts`, `seededRandom.ts` | Original deterministic coupled waves and analytical derivatives |
| `spatialModel.ts` | Versioned Phase 2 configuration, J, spectrum, velocity, hazard and gravity sampling |
| `linearAlgebra.ts` | Bounded symmetric eigensolver, 3×3 solve and vector operations |
| `deformation.ts` | Exact center map, determinant and bounded local affine representation |
| `fractures.ts` | Sparse discovery, root tracking, endpoint validation, time-reconstructed graph |
| `coordinates.ts` | Bounded damped least-squares inverse with explicit confidence/failure |
| `explorer.ts` | Reference branch, explicit entrance selection, safe exit, cooldown and scenario state |
| `debris.ts` | Seeded 1/60-second deterministic particle integration and bounded replay |
| `simulationEngine.ts` | Owns field, world, clock, graph, explorer and debris; sample/evaluate/reset/scenario API |
| `worldGenerator.ts` | Unchanged fourteen stable island IDs, references, colors, shapes and sizes |
| `scene/FloatingIsland.tsx` | Exact center map and field-derived local matrix; proper grouped terrain materials |
| `scene/SpatialEffects.tsx` | Graph-colored apertures, candidate markers, four hazard samples, instanced gravity probes |
| `scene/ExplorationCamera.tsx` | Existing normalized flight, drag look, engine advance, E and reset synchronization |
| `scene/telemetry.ts`, `ui/` | Branch-aware simulated diagnostics, compact graph hint and controls |
| `scene/diagnostics.ts` | Read-only browser evidence, scene transforms and performance counters; no mutations |

`sampleField(q,t)` supplies field, derivatives, mapped position, minimum singular value, compression, hazard, gravity and velocity. `network.getActiveConnections(t)`, `getConnectionsForRegion(id,t)` and `getConnectionState(id,t)` expose navigation-ready edge data without routing or ATLAS. `engine.scenario()` returns normalized seed, model version, time, reference and region.

## Time, coordinates and state

The camera frame first advances the single clock and fixed-step probes, updates world-space flight, then computes a local inverse from the previous reference estimate. E processes once per key press, rechecks the graph and transfers atomically while preserving camera quaternion. A reset revision synchronizes engine reset and actual camera reset. R/camera reset restores the opening reference at current time; full reset also clears traversal history and probes.

Graph states depend solely on quarter-second model ticks and neighboring temporal samples. There is no mutable lifecycle accumulated per frame. Caches affect cost only:96 raw tick entries,64 graph entries. Root tracking follows fixed seed-derived reference lines, preserving IDs without a render-dependent nearest-neighbor identity algorithm.

World flight can leave the image of the current local branch. Failure retains the previous reference estimate with status/residual; it never moves the camera to hide the problem. E is an explicit choice of a nearby entrance branch. Region IDs identify graph sheets, not a full global chart atlas. Safe exits are searched and checked before any state mutation. Rendering all sheets is intentional; paired colored apertures and transfer text communicate the shortcut.

## Rendering and resource bounds

- Fourteen procedural island geometries are created once. Field-driven object matrices avoid rebuilding vertices. Correct material group attachments distinguish upper surfaces and rock undersides.
- A single instanced mesh renders12 probes. Four line arrows share one buffer. The static seeded star field remains one draw.
- At most four nearest graph indicators and four hazard volumes are displayed. The complete eight-edge graph remains available independently.
- Graph/indicator updates occur at4Hz model time; moving the camera four units also refreshes the visible nearest-indicator selection from cached graph state, including during pause. HUD updates at roughly6.7Hz real time. Flight and affine transforms stay in refs/Three objects, not per-frame React trees.
- DPR is capped1.5, standard WebGL2 materials/fog remain, and R3F disposes mounted geometries/materials. No external assets, postprocessing stack or physics framework was added.
- Probe replay is bounded240 ticks/call and reports incomplete catch-up. Normal clock updates require at most12 ticks at2×.
- Performance history/caches are bounded. `performance.now()` only measures detector/graph cost and never drives availability.

`scripts/benchmark.mjs` measures real rAF intervals after warmup, intercepts WebGL draws/triangle counts, samples JS heap and reads renderer physics timings. Evidence records the tested browser/GPU rather than implying universal laptop performance. See the Phase 2 report and evidence JSON.

## Phase 3 rendering integration

Phase 3B (see `docs/PHASE_3B_REPORT.md`) replaced the cloud sea and distant scenery with the gas pipeline below; the terrain pipeline is unchanged.

```text
island definition (id, facetSeed, radius, height) -> archetype by id -> SDF -> surface nets   (worker pool; hero sampling split into z-slabs)
                                                                         -> positions, normals, [cavity, exposure, height, variation]
engine.clock.time + evaluateField -> exact centre + boundedLocalJacobian -> island <group> matrix -> terrain mesh (child, island-local units)
sampleField(ref, floor(4t)/4).hazard -> per-island mineral uniforms        baked sky cube -> background, PMREM environment, haze source
```

| Module | Responsibility |
| --- | --- |
| `scene/terrain/noise.ts`, `surfaceNets.ts` | Seeded Perlin/fBm/ridged noise; closed-surface extraction and speck removal |
| `scene/terrain/archetypes.ts` | Identity-based casting (3 heroes, 4 supporting forms), density fields, clearance envelope `0.84(r+h)` |
| `scene/terrain/terrainGenerator.ts` | Block-skipping grid sampling, slab sampling and bit-identical merge, vertex attributes |
| `scene/terrain/terrainWorker.ts`, `terrainLibrary.ts` | Module-worker pool (2–6), priority queue, bounded cache by identity and resolution, main-thread fallback |
| `scene/terrain/rockMaterial.ts` | Triplanar PBR layering on `MeshStandardMaterial`, cavity AO, hazard-driven mineral seams, sky-coloured aerial haze; texture loading with neutral fallbacks |
| `scene/environment/CosmicSky.tsx` | One-time procedural sky bake to a cubemap, used as background, PMREM and haze mip |
| `scene/gas/gasNoise.ts`, `GasVolumePass.ts` | (Phase 3B) Tileable seeded 3D Perlin–Worley noise; depth-aware half-resolution raymarch with explicit-LOD fetches, composite with saturation lift |
| `scene/gas/gasInputs.ts`, `GasWorld.tsx`, `GasMotes.tsx` | (Phase 3B) Read-only simulation adapter (fold endpoints by state, hazard samples, 4 Hz lattice); frame composer (scene → gas → bloom → Neutral OutputPass); hazard-driven motes |
| `scene/dimension/Vortex.tsx`, `MirrorPlanes.tsx`, `DebrisCurrents.tsx`, `layout.ts` | (Phase 3B) Focal vortex, displaced-space panes and mirror floor, sparse crystals, layout constants |
| `scene/Lighting.tsx` | Key light with a light-space-fitted shadow frustum; fill, rim, bounce and hemisphere lights |
| `scene/SpatialEffects.tsx` | Aperture rings, glow and shard rims; pooled aperture lights; fresnel hazard shells; instanced probes |
| `scene/cinematicViews.ts` | Rendering-only viewpoints (keys 1–7) computed from current island centres |
| `rendering/qualitySettings.ts`, `renderReadiness.ts` | Presets (DPR, shadows, terrain cell, sky size, clouds, distant count, anisotropy); load tracking for the veil and screenshot gating |

The simulation remains unaware of rendering: `src/simulation/` is byte-identical to Phase 2. Rendering reads clock time, field samples and graph state only. Terrain is a pure function of island data and resolution, so switching quality regenerates geometry without touching engine state; unit and browser tests assert this. Decorative distant scenery and clouds are not part of the engine and never take part in folds, gravity, clearance or traversal. Diagnostics gained a read-only `render` block (readiness, plus each island's terrain mesh and parent). See `docs/PHASE_3_VISUAL_DESIGN.md`.

## Errors and extension boundaries

Existing WebGL2/context/error UI remains. Numerical input guards throw instead of substituting plausible state. Inverse nonconvergence is a recoverable explicit result. Closed folds and unavailable exits reject interaction atomically. No global inverse or collision engine is assumed.

Phase 3 replaced terrain generation and materials behind `FloatingIsland` while preserving stable reference identities and exact centres. Phase 4 effects should extend `SpatialEffects`, `rockMaterial` and the sky bake rather than the terrain pipeline. Future shader implementations must match the CPU field and documented local representation. Fracture graphics consume connection state; they cannot change its rules. Instanced debris can expand the current bounded probe renderer without altering integration.

Future navigation can consume connection endpoints, region IDs, sampled windows, costs and hazard scores. Future hazards can extend the same field-derived sampler. ATLAS must receive a separate intentionally limited observation interface; the read-only engineering diagnostics and hidden truth sampler are not that interface. No ATLAS or cinematic-effect (Phase 4) work has been started.
