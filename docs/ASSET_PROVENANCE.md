# Asset provenance

All external assets are photographic PBR texture sets from **Poly Haven** (https://polyhaven.com). Every asset there is published under **CC0 1.0 (public domain dedication)**. The licence was checked on 17 October 2026 at https://polyhaven.com/license ("CC0 means absolute freedom"). Asset metadata (names and authors) was read from the public Poly Haven API (`https://api.polyhaven.com/info/<id>`). The files were downloaded from Poly Haven's own CDN (`dl.polyhaven.org`) on **17 October 2026** and are stored unmodified.

No meshes, HDRIs, fonts or other third-party media are included. Rock geometry, the sky, clouds and the distant scenery are generated procedurally at runtime by project code.

| Asset | Source URL | Authors (per Poly Haven) | Licence | Original format | Project location | Purpose |
| --- | --- | --- | --- | --- | --- | --- |
| Cliff Side (`cliff_side`), 2K: diffuse, OpenGL normal, ARM (AO/rough/metal) | https://polyhaven.com/a/cliff_side | James Ray Cock (photography), Dario Barresi (photography), Jenelle van Heerden (processing) | CC0 1.0 | JPEG 2048² | `public/assets/textures/cliff_side/` | Stratified cliff faces on every island (triplanar), recoloured toward basalt/slate in the shader |
| Rocks Ground 06 (`rocks_ground_06`), 1K: diffuse, OpenGL normal, ARM | https://polyhaven.com/a/rocks_ground_06 | Rob Tuytel | CC0 1.0 | JPEG 1024² | `public/assets/textures/rocks_ground_06/` | Weathered, broken plateau tops (top-down projection) |
| Lichen Rock (`lichen_rock`), 1K: diffuse, OpenGL normal, ARM | https://polyhaven.com/a/lichen_rock | Rico Cilliers | CC0 1.0 | JPEG 1024² | `public/assets/textures/lichen_rock/` | Dark undersides and hanging roots (triplanar) |

Total texture payload: about 14.6 MB (nine JPEGs). Colour (`diff`) maps are decoded as sRGB. Normal and ARM maps are treated as linear data (`NoColorSpace`); see `src/scene/terrain/rockMaterial.ts`.

If a file fails to load, the material substitutes a neutral 1×1 map and the renderer reports `textureFallback: true` through the read-only diagnostics, so the scene keeps rendering procedural shading instead of failing.

## Assets evaluated but not used

- Other Poly Haven rock sets were previewed through their public thumbnails: `rock_face_03`, `marble_cliff_04`, `marble_cliff_06`, `rock_06`, `seaside_rock`, `tiger_rock`, `rock_face`, `aerial_rocks_02`, `rock_boulder_cracked`. None of them were downloaded into the project.
- No Poly Haven scanned rock models were used. Procedural surface-nets geology already provides the landmass forms, and per-model texture sets would have roughly doubled the texture memory.
- No HDRI was used. Image-based lighting comes from the project's own baked nebula sky (PMREM), so reflections match the visible sky.

## ATLAS challenge scene models (LOD1)

The Moving Corridor challenge scene (`?experience=challenge`) shows its scanned wreckage with six LOD1 models copied unchanged from the Dimension's released asset set (`C:\Users\aadit\BigHero6`, branch `dimension`, `public/assets/models/candidates/`). They are original project geometry with procedural PBR textures; see the Dimension's `docs/ASSET_PROVENANCE.md` for their generation. No third-party mesh or texture.

| Model | Dimension source | Licence | Project location | Purpose |
| --- | --- | --- | --- | --- |
| Capsule shell remnant (LOD1, 18k tris) | `candidates/capsule/capsule_shell_remnant_lod1.glb` | Project-owned | `src/atlas/lab/public/models/capsule_shell_remnant.glb` | The destination |
| Capsule heat-shield panel (LOD1) | `candidates/capsule/capsule_heatshield_panel_lod1.glb` | Project-owned | `.../capsule_heatshield_panel.glb` | Wreckage |
| Twisted I-beam (LOD1) | `candidates/industrial/industrial_ibeam_twisted_lod1.glb` | Project-owned | `.../industrial_ibeam_twisted.glb` | Wreckage |
| Fractured large pipe (LOD1) | `candidates/industrial/industrial_pipe_large_fractured_lod1.glb` | Project-owned | `.../industrial_pipe_large_fractured.glb` | Wreckage |
| Bent column (LOD1) | `candidates/industrial/industrial_column_bent_lod1.glb` | Project-owned | `.../industrial_column_bent.glb` | Wreckage |
| Concrete slab with rebar (LOD1) | `candidates/concrete/concrete_slab_rebar_lod1.glb` | Project-owned | `.../concrete_slab_rebar.glb` | Wreckage |

The models are illustrative: the planner never reads their geometry, only the position and radius recorded by the proximity scan.
