# ATLAS Command overhaul: what changed and what was measured

Scope: the "final overhaul" pass on top of the verified live build (`docs/ATLAS_LIVE_FINAL_ARCHITECTURE.md`). Nothing was merged or reset; the original worktrees, the scripted Mission replay (`?experience=mission`) and the submitted archive are untouched. Before/after screenshots at 1920x1080: `docs/evidence/overhaul/before/` and `docs/evidence/overhaul/after/`.

## 1. One forecast, three modes

`src/atlas/command/encounter.ts` builds one `ForecastView` and one `Encounter` per evidence version. Predictive analysis, Route planning, the 3D scene and the route command sent to the Dimension all read these two objects; `tests/commandTrace.test.ts` asserts the forecast version, aim time, target position at the aim time, route end point, waypoints and the sent command agree (to 1e-9 m before wire rounding). A speed change recomputes the encounter from the same observations (same version, new arrival time and endpoint).

* Tactical map: what exists (97 known targets summarised, five quick targets, collapsible categories, search; rubble is aggregated, not listed).
* Predictive analysis: where will it go (history trail, solid current target, translucent copy of the same asset at the previewed time, scrubber that previews only, frozen-forecast-versus-reality list, uncertainty only from the estimator).
* Route planning: where must Baymax go and why (destination, speed, predicted encounter, why-this-route, evidence in a collapsed section, sticky Send footer).

## 2. Interception made visible

ATLAS: capsule now, forecast path with ticks, capsule hologram at the planned time, Baymax hologram at arrival, shared amber "PLANNED RENDEZVOUS" marker (or "AIM POINT" when the forecast is only trusted for a limited lead, or "APPROACH POINT" for a stationary target).

Dimension: the route is a dashed world-space line drawn in the luminous overlay after the gas; a translucent projection of the capsule at `targetPath(interception.simTime)` using the shared asset; a rendezvous reticle; bracket and edge indicator for the real target; labels are laid out together so they do not overlap. The measured outcome is decided inside the Dimension from true positions: success when Baymax is within the capture radius (`mover.radius + 4` m) of the true capsule, a miss when the planned time has passed by more than 6 s or the range opens more than 3 m past the closest approach. The result card reports closest approach, capture radius, time, prediction error at the planned time. `RENDEZVOUS ACHIEVED` is shown only from that measurement.

Measured in the Dimension nav QA harness (`scripts/nav-qa.mjs`): one real intercept flight achieved (closest 6.2 m, capture 6.4 m, 2.6 s after the planned time, prediction error 11.3 m); a deliberately biased forecast was a miss (44.3 m, decided at planned + 6.0 s); island and fold arrivals succeeded. This is a handful of flights, not a success-rate claim.

## 3. ATLAS as a projection of the same universe

The scene uses the Dimension's own sky bake, lights, PMREM, rock generator and CC0 rock material, the shared GLBs for every object, and the armoured Baymax GLB (LOD1) plus a ghost copy from the same file. Camera modes (overview, follow, focus, prediction, route, interception, manual) with frame-rate-independent damping, framing inside the free area between panels, semantic bounds, no snaps (16 unit tests and a browser run). Labels are tiered (rubble hidden by default, budget by mode, collision avoidance, focus dimming). Island clearance spheres are drawn as faint rims only.

## 4. Dimension dynamics (`docs/DIMENSION_DYNAMICS_OVERHAUL.md` in the Dimension branch)

Seven new movers with different mass, drag and lanes (ellipse, figure-eight, trefoil), three new disturbances (fracture sheet, breathing well, precessing vortex) and fold-coupled funnels read from the real connection states on the 4 Hz lattice. The capsule's lane and constants are bit-identical to the previous model (frozen fixture test, 4 x 301 comparisons); `src/simulation/**` is unchanged. Trails, flow lines and glow are rendering only, derived from mover state. Not done: fold traversal stretch (entry and exit are about 1.6 m apart in world space, so it would look like the funnel).

## 5. Baymax

Armoured red hero GLB per `Design/Baymax Design`: 96,525 triangles (hero) and 18,822 (LOD1), articulated nodes, deployable wings, thruster sockets, same file in both apps (sha256 in the shared manifest). Built with the existing Blender pipeline on branch `baymax-armoured-hero` of the asset worktree. Known weaknesses (from the specialist and from my own review): silhouette still smooth and inflated compared with the reference, chest plates look laid on a balloon, spindly fingers, shell-like wing without stepped feathers, folded wings overlap the lower back, LOD1 slightly faceted; the hip z-fighting fix was not re-rendered by the specialist.

## 6. Honest comparison with chasing (measured; nothing tuned)

The advantage of predicting is real but conditional, and it is not large for this world's default capsule.

* Baymax at 6, 10, 14 and 22 m/s against the default (cruise) capsule, 316 closed-loop runs over 10 start phases and 4 offsets (`docs/evidence/qa-final/science-cruise.json`): ATLAS captured 39/39 at every speed, chase 40/40; mean time to capture was equal within 0.1 s (for example 1.67 s vs 1.67 s at 14 m/s); ATLAS was faster than chase in 0 of 156 paired runs and slower in 4 (at 6 m/s). Earlier reports at the same ratios: cruise-1x 4.02 s vs 3.99 s, cruise-2.2x 9.70 s vs 9.73 s.
* Baymax only slightly faster than the capsule (2.5, 3.5 and 5 m/s, 70 runs, `science-cruise-lowspeed.json`): at 2.5 m/s ATLAS 10.7 s vs chase 13.4 s (ATLAS faster in 8 of 11 pairs, slower in none); at 3.5 m/s 7.39 s vs 7.87 s; at 5 m/s 5.0 s vs 4.94 s (a tie). Replans per run averaged 2.8 / 1.9 / 1.6.
* Fast capsule variant (4 to 6.5 m/s, `science-fast*.json`): at 6 to 22 m/s a tie (ATLAS faster in 1 of 48 pairs, chase faster in 10, mostly within 0.25 s). At 2.5 and 3.5 m/s Baymax is slower than the capsule on part of its lane: ATLAS captured 8/12 and 9/12 (the rest were honest misses), chase 3/12 (the rest timed out) and 12/12 (slowly, 33 s mean).
* Authored crossing target (`scripts/atlas-crossing-report.ts`, labelled authored): ATLAS faster in 18 of 18 scenarios, mean 8.17 s vs 9.78 s, path 56 m vs 66 m.

So the live demonstration shows the interception geometry (meeting point ahead of the target, one forecast, a measured result) and a measurable time saving only when Baymax is not much faster than the target. At high Baymax speed a straight chase works just as well, and the product does not claim otherwise.

## 7. Verification at the commits listed in `ATLAS_LIVE_RELEASE.md`

Dimension 25 files / 219 tests, ATLAS 28 files / 317 tests, `tsc --noEmit` clean in both, production builds, `sync-shared.mjs --check` in sync (35 models), `scripts/live-e2e.mjs` 10 / 10 (run against 5184 / 4183). Performance: the ATLAS canvas holds its 30 fps cap with the Dimension window open in headless Chrome (30.3 to 30.5 renders/s counted); the Dimension alone measured 26-44 fps headless earlier and the physics layers added no measurable cost (49.4 vs 49.9 fps at 1280x720). Headed measurement on the demo machine is still advisable.

## 8. Independent QA findings (specialist 5; `docs/evidence/qa-final/`, `tests/qaFinalBoundary.test.ts`)

* No crash, hang or page error in any browser run (1366x768 and 1920x1080). Every "arrived" had a measured closest approach inside the 6.4 m capture radius; every miss had it outside; a route sent without flying produced `RENDEZVOUS MISSED` in both apps (closest approach 29 to 32 m).
* Information boundary tests: movers without a beacon and islands/folds beyond 60 m are absent from observations; scanned objects carry no velocity or future state; hostile origins (`evil.com`, `null`, `file:`, `javascript:`, `0.0.0.0`) are refused, while any loopback origin is accepted unless `?atlasOrigin=` is set. Route parsing rejects NaN, Infinity, out-of-range coordinates, speed outside (0, 200], more than 24 waypoints, over-long strings and bad enums.
* Fixed after the audit: an unbounded `revision` could lock an ATLAS session out of the Dimension; `revision` is now limited to 1e6 and `issuedSimTime` to 1e7 s (Dimension `f2ab1e5`, synced).
* Documented, not changed: Abigail's capsule carries a 100 m beacon (its `beaconRange`) beyond the 60 m sensor range; the nav report returns the true distance to the goal and closest approach for the route ATLAS itself sent (display only, the planner reads none of it); no payload size limit before parsing (loopback `postMessage` only).
* Cosmetic, open: at 1366x768 some scene labels are partly under the side panels and one list line is truncated.
* Not verified in a browser: an in-browser arrival measured against the capture radius (the e2e reports only "arrived"; the closed-loop tests and the nav harness measure it).
