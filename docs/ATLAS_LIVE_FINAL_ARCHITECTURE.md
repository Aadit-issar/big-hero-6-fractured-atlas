# ATLAS Command: live architecture

*One world, one intelligence, one connected navigation experience.* This document records what is actually built, where it lives, how the two applications talk, the mathematics each side uses, and what has and has not been verified. It describes the code at the final commits of `atlas-live-interception` and `dimension-live-interception`; every number below is a measurement from `docs/evidence/` or from the test suites, not an estimate.

## 1. The closed loop

```
 DIMENSION (truth)                                         ATLAS COMMAND (intelligence)
 ┌─────────────────────────┐   frame @4 Hz: pose, clock,  ┌──────────────────────────────────┐
 │ field Φ(q,t), map X(q,t)│   sensor observation, scan   │ WorldMemory  (CURRENT / REMEMBERED)│
 │ movers (capsule, armour,│ ───────────────────────────▶ │ tracks → motion fit → FORECAST     │
 │ girder) + disturbance   │                              │ target catalogue (6 classes)       │
 │ explorer = Baymax       │   route r<n> (waypoints,     │ rendezvous solver + route planner  │
 │ route manager + HUD     │ ◀─────────────────────────── │ replan policy (hysteresis, reasons)│
 │ decides ARRIVAL on truth│   reason, assumptions        │ explanations                       │
 └─────────────────────────┘   route-ack, nav report      └──────────────────────────────────┘
        ▲ Baymax flies the waypoints; new observations arrive; the loop repeats ▲
```

`DIMENSION → OBSERVATION → ATLAS MEMORY → PREDICTION → PLANNING → DIMENSION NAVIGATION → NEW OBSERVATIONS`. Each arrow is code that runs in a real browser; `scripts/live-e2e.mjs` drives it end to end (section 11).

## 2. Repository, branches, ports

| | Dimension | ATLAS Command |
|---|---|---|
| Worktree | `C:\Users\aadit\BigHero6-wk-live-dimension` | `C:\Users\aadit\BigHero6-wk-live-atlas` |
| Branch | `dimension-live-interception` (from `dimension` 2b6fd4e) | `atlas-live-interception` (from `atlas-controlled-challenge` 2b6ccdb) |
| Port | 4183 (preview or dev) | 5184 (preview), 5180 (dev) |
| Entry | `src/main.tsx` → `App` | `src/atlas/lab/index.html` → `MissionApp` → `CommandApp` (default); `?experience=mission` is the preserved scripted replay |

The branches share one Git history and are never merged: they exchange only the byte-identical shared files below, copied by `scripts/sync-shared.mjs` (reads the Dimension branch with `git show`, so it works from any worktree; `--check` reports drift). The original `dimension` and `atlas-*` branches and the submitted Mission archive are untouched.

Shared, byte-identical: `src/shared/liveLink.ts` (wire contract), `src/shared/assetManifest.ts` (asset identity, generated), `src/baymax/**` (hero model and thrusters).

## 3. Clock, coordinates, identity

* **One clock.** `engine.clock.time` (model seconds) in the Dimension. Every frame carries it as `clock.time` plus `running`, `timeScale` and `visible`; ATLAS's only notion of "now" is the simulation time of its newest accepted frame (`WorldMemory.now`). Wall time is used only for link health (`stale` after 3.5 s, `disconnected` after 9 s) and for smoothing the drawn pose between 4 Hz frames. A paused or hidden Dimension stops the clock; ATLAS shows "paused / tab hidden" and keeps everything coherent, and frames whose simulation time goes backwards are rejected and counted.
* **Coordinates.** World units are metres; the same world frame in both applications (+Y up, explorer forward is camera −Z). Reference space (`q`) is never sent.
* **Identity.** Islands `island-NN`, folds `F0N`, scattered objects `obj-NNN` (positional in the seeded layout), movers by stable name (`capsule-abigail`, `armor-chest`, `armor-shoulder`, `girder-drift`). Each scene object carries its registry asset id (section 9). A different Dimension `session` (new page load) is a new episode: ATLAS discards memory, forecasts, selection and route.

## 4. The world and its dynamical extension (Dimension, `src/world/movers.ts`)

The current spatial law, read from `src/simulation/spatialModel.ts`: `X(q,t) = L·(q + α∇Φ(q,t))` with `L = 7.5`, `α = 4` (`SPATIAL_MODEL.mapping`; the older `.9` strength remains only for regression tests). Φ is a sum of four seeded travelling waves plus pairwise interaction terms, so it **is** time dependent: islands drift by several metres over tens of seconds (island-05 moves from (7.8, 9.4, −34.0) at t = 0 to (−1.1, 6.5, −39.2) at t = 30). The map alone, however, only distorts positions; it gives objects no dynamics. The movers add a documented extension in *reference* space and push the result through the unchanged map:

```
q̈ = −k (q − g(t)) − c q̇ − μ ∇Φ(q,t) + a_d(q,t)          X = L (q + α ∇Φ(q,t))
```

* `g(t)` is a closed guide lane `C + a·cos(ωt+φ₁)·e₁ + b·sin(ωt+φ₁)·e₂ + c·sin(κωt+φ₂)·e₃` (so the object never leaves its neighbourhood);
* `k = 2.6`, `c = 3.0` is a damped spring to that lane;
* `−μ∇Φ` is a conservative force from the same field that defines the map (field-influenced motion);
* `a_d` is one localised, time-modulated swirl, the **dimensional disturbance** (not gravity: it is a fictional additional law, drawn as a visible region by `DisturbanceField`).

Integration is symplectic Euler at integer 1/60 s ticks from a lane-aligned initial state, so a state is a pure function of the tick count: replay and reset are exact (`tests/movers.test.ts`: identical states after rewind, finite and bounded for 180 s, never crossing island rock, the field force and the disturbance each measurably change the path, engine untouched). Attitude is analytic (`q₀ ⊗ spin(t)`).

**Why this lane.** Local polynomial motion models extrapolate a path only as well as the path is smooth, and the map multiplies curvature. `scripts/mover-search.ts` searched 300 seeded lanes for the lowest 95th-percentile turn rate that stayed inside the cavern, clear of islands and near the opening; the chosen capsule lane has p95 turn 0.152 rad/s and mean speed 1.9 m/s (range 1.0–2.8 m/s). A faster alternative is available as `?capsule=fast` (about 4 m/s, p95 turn 0.32 rad/s) and is used as the stress case in section 8. Abigail's capsule carries a distress beacon (acquired to 100 m); the other movers use the standard 60 m sensor range.

Populations: `capsule-abigail` (`capsule_shell_remnant`, flagship), `armor-chest`, `armor-shoulder` (Baymax armour), `girder-drift` (`industrial_ibeam_twisted`). The scattered layout's own copy of the capsule shell is suppressed, so there is exactly one Abigail's capsule.

## 5. The bridge (protocol v2)

Transport: `window.postMessage` between the two windows (the existing, origin-validated bridge, extended; no server). The handshake links one window to the other (ATLAS opens the Dimension, or the player presses **L** in a running Dimension and ATLAS opens linked to it). Contract: `src/shared/liveLink.ts` (types, constants, pure validators).

| Direction | Message | Content |
|---|---|---|
| D → A | `welcome` | session id, seed, model version, clock, pose, ranges |
| D → A | `frame` (4 Hz) | `pose` (position, attitude, forward, **vehicle** velocity), `clock`, sensor `observation` (islands, folds), optional `scan` (objects with label and attitude, disturbances, island forms), optional `nav` report |
| D → A | `route-ack` | route id, revision, accepted / rejected / cancelled, code, detail, sim time |
| A → D | `hello`, `bye`, `scan-request`, `set-scan-mode`, `advisory` (v1 data) | |
| A → D | `route`, `route-cancel` | routeId, **revision** (strictly increasing per ATLAS page), goal, mode, speed, waypoints (position, kind, arrival radius, ETA), interception, event-derived reason, assumptions |

Robustness: every field is validated (finite numbers, bounded coordinates, ≤ 24 waypoints, string limits, unknown fields dropped); `LinkCore` rejects wrong origin, foreign session, duplicate and out-of-order sequence numbers; the Dimension ignores any route revision not newer than the newest accepted from the same ATLAS page, rejects a route addressed to another Dimension session, clears its route on simulation reset, and decides **arrival itself** (section 7). Peers must be loopback origins (or the single origin passed as `?atlasOrigin=`); services bind to 127.0.0.1. A route can never move Baymax or change the simulation; it is display data the player may follow.

## 6. What ATLAS may know (the information boundary)

ATLAS receives Baymax's own pose, clock and vehicle velocity; sensor observations (positions of islands and folds within 60 m, fold lifecycle states); scans (positions, attitudes and labels of objects within range, never their velocities, parameters or future positions). `tests/commandUnits.test.ts` asserts that scan and observation payloads contain no velocity, forecast, trajectory, parameter or reference-space fields, and that no file under `src/atlas/command/` imports the simulation or the sensor. Offline tests use ground truth only through `tests/support/` (a copy of the Dimension's movers and route manager) to score ATLAS after the fact.

Knowledge states (`world.ts`): **CURRENT** — present in the latest observation of its source; **REMEMBERED** — previously observed, not in the latest (last-known position, age shown, uncertainty grows with age); **PREDICTED** — a forecast, always drawn as a translucent copy of the same asset at the forecast position with an uncertainty volume.

## 7. Prediction, rendezvous, routing (ATLAS, `src/atlas/command/`)

**Motion model** (`forecast.ts`) reuses the controlled challenge's validated estimator (`challenge/motionModel.ts`: rolling-origin validation of linear and quadratic fits against persistence, parsimony, an explicit growing uncertainty) with a policy matched to the live cadence (2 Hz scans: ≥ 8 samples over ≥ 2.5 s, 2.5 s validation lead, spans 3/5 s linear and 5 s quadratic). The spans were chosen from an offline study of polynomial extrapolators on the capsule's true path: quadratics over 4–6 s windows reduced the median 3 s error from 6.1 m (persistence) to 0.45–0.73 m, whereas a 12 s quadratic gave 2.0 m. A first forecast needs about 6–10 s of observation; until then ATLAS says why it has none.

**Calibration.** Measured against ground truth over many origins (tests/commandCore): the model's own bound covered 88 % of 3 s forecasts but about half of 6 s ones, so `calibration(lead)` widens the stated radius linearly from ×1 (≤ 3 s) to ×1.75 (≥ 6 s). With it:

| horizon | n | mean forecast error | "has not moved" error | within stated uncertainty |
|---|---|---|---|---|
| 3 s | 18 | 2.1 m | 5.8 m | 89 % |
| 6 s | 15 | 6.6 m | 10.9 m | 87 % |
| 10 s | 12 | 16.3 m | 16.6 m | 92 % |

At 10 s the forecast is no better than persistence (honestly: the path bends faster than a local polynomial can follow); ATLAS never aims that far ahead (below).

**Frozen forecasts** (`ForecastBook`): issued with source evidence, issue time, target time, position, uncertainty, model; never edited; evaluated against the first observation of that entity at or after the target time (≤ 1 s later) with the persistence baseline beside it; a forecast whose entity was not observed in time is reported as unresolved rather than adjusted. In the live proof a 4 s forecast frozen at t = 11.4 s was checked by the observation at t = 15.5 s: error 0.67 m against 9.05 m for "has not moved".

**Rendezvous** (`intercept.ts`): find `T` with `|P(T) − B₀| / v = T − t₀` where `P` is the target estimate. Step 1 solves the unobstructed case exactly (scan for the first sign change at 0.25 s, bisect 48 times). Step 2 hands the meeting point to the challenge's time-aware route planner (label-setting search over candidate waypoints, exact moving-obstacle clearance) and iterates `T` to the planner's own flight time (≤ 8 iterations, tolerance 0.3 s). Safeguards, each added after measurement:
* **Bounded lead (6 s).** If the exact meeting is further ahead, ATLAS aims at the target's position 6 s from now and refines as Baymax closes in (labelled AIM POINT instead of MEETING POINT).
* **Pursuit fallback.** If the extrapolated target outruns Baymax but Baymax is at least 80 % of its speed, ATLAS pursues the 6 s-ahead position; only a clearly hopeless chase is reported `unreachable`.
* **Clearance bubbles** around observed islands are shrunk just enough that a goal beside an island (a fold entrance, a meeting point near rock) lies outside them; every other bubble keeps its full size and the reduction is stated.

**Targets** (`targets.ts`, `route.ts`): moving object → predicted rendezvous (stand-off 0.9 × radius on the arrival side); static or remembered object → approach point at radius + 2.5 m (remembered ones carry a growing last-known uncertainty and a reconnaissance label); island → hover point `height + 5 m` above it, not its centre; fold → its observed entrance with the observed state; **where a fold leads is never inferred** and is listed under "Still unknown" as unverified. The catalogue lists only what was acquired in the session (searchable, filterable).

**Replanning** (`replan.ts`): a plan is recomputed at 2 Hz of simulation time but a new route revision is issued only for a reason: new target; planning speed change; **mode change** (e.g. enough observations arrived to forecast); the (aim/meeting) point moved ≥ max(3.5 m, 12 % of the remaining distance); Baymax more than 12 m from the route; a 25 s old interception route; never faster than every 1.5 s. Each decision carries a sentence built from the measured difference ("New Abigail's Capsule observations moved the predicted meeting point 3.6 m. Interception recalculated."), which is shown in ATLAS, sent with the route and displayed in the Dimension HUD.

**Arrival** is decided inside the Dimension from true positions: for a moving object, Baymax within `radius + 4 m` (6.4 m for the capsule) of the object's **actual** position (not of ATLAS's forecast); for a fold, inside the 5 m approach radius of the entrance; for an island, at its approach waypoint.

## 8. Does prediction change the result? (measured, not asserted)

`scripts/atlas-intercept-report.ts` runs the real ATLAS session against the real simulation and mover dynamics (closed loop, arrival by truth) and compares ATLAS with a plain chase of the last observed position on identical initial conditions. Raw data: `docs/evidence/intercept-report-*.json`; summary in `docs/ATLAS_LIVE_PROGRESS.md`. Honest findings:

1. **Defects found and fixed by this comparison.** The first version of the planner lost badly to a plain chase at slow speeds (mean 9.5 s versus 4.8 s on the fast lane at 55 m): it aimed at forecasts far in the future, stalled when the exact rendezvous did not exist, and did not replan when a target changed from "static" to "forecastable". Bounded lead, the pursuit fallback and mode-change replanning removed the gap.
2. **In this world a chase is as good.** After the fixes ATLAS and chase are equivalent against the capsule because it (1–6.5 m/s) is slower than Baymax at the speeds tried. Final runs (closed loop, identical starts, arrival by truth, 4–14 m/s for the default lane and 8–24 m/s for the fast lane):

   | lane, observer distance | scenarios | both reached | mean time ATLAS / chase | mean path ATLAS / chase | faster ATLAS / chase | routes issued by ATLAS |
   |---|---|---|---|---|---|---|
   | default, ~25 m | 60 | 60 / 60 | 4.02 s / 3.99 s | 24.4 m / 24.2 m | 1 / 2 | 1.4 |
   | fast, ~25 m | 36 | 36 / 36 | 2.17 s / 2.12 s | 26.4 m / 26.0 m | 1 / 3 | 1.3 |
   | fast, ~55 m | 36 | 36 / 36 | 5.18 s / 5.26 s | 63.1 m / 64.2 m | 7 / 1 | 2.6 |

   (A run on the default lane at ~55 m was started but not completed; no result is claimed for it.) We report the tie rather than tuning a scenario to make ATLAS look better.
3. **Where prediction wins.** In a controlled crossing-target challenge (target 4 m/s crossing, Baymax 6 m/s from 60 m, `tests/commandUnits.test.ts`) the lead aim reaches it in 12.0 s versus 15.0 s for pursuit (−20 %). The planner additionally avoids islands, which pure chase (flying through rock in the comparison) does not, and it explains itself; neither is a speed advantage.
4. **Planner cost.** The comparison also exposed a performance defect: planning could take 0.5–5 s with three nearby islands. The planner now returns the direct leg without searching when it is already clear (typically 10–20 ms) and stops at a 150 ms budget otherwise (reported as "no route found within the time budget").

## 9. One asset, two viewers

`src/shared/assetManifest.ts` (generated by `scripts/build-asset-manifest.ts` from the Dimension's measured registry) names, for each of the 34 physical assets, its levels (file, bytes, triangles, **sha256**) and the level ATLAS draws. Conventions are identical in both viewers: 1 unit = 1 m, authored GLB origin at the entity position, entity attitude applied as observed, scale 1 (ATLAS may enlarge a model uniformly at tactical zoom for legibility, never change its proportions). The Dimension draws the nearest level it needs; ATLAS draws a lower level of the **same model** (same silhouette, material family and texture atlas). `tests/commandUnits.test.ts` verifies that every file ATLAS draws exists in its worktree and is byte-identical to the Dimension model it names; `sync-shared --check` verifies the rest. Islands use the Dimension's own deterministic rock generator (identity → archetype → density field → surface nets, same worker pool) fed with the extent and seed that a scan reports, at a coarser tactical resolution (the Dimension additionally applies a bounded local strain; ATLAS draws the unstrained form). Folds are drawn as tears with the same lifecycle states. Paired captures: `docs/evidence/live-e2e/p3-dimension-close-range.png` and `p3-atlas-arrived.png` show the same capsule in both applications.

## 10. Navigation HUD (Dimension, `src/ui/NavHud.tsx`, `src/bridge/hudProjection.ts`)

The reported defect (guidance unusable inside ~10 units) is fixed by construction, not by tuning. `projectToScreen` rotates the world vector by the inverse of the published camera quaternion and projects with the camera's own field of view and aspect, so a marker is exactly where the waypoint is in the rendered world (unit-tested for ahead, behind, left/right, above/below, yaw, pitch, translation, close range, the field-of-view edge). Off-screen waypoints get a clamped edge indicator (behind the camera it is pinned to the lower edge on the correct side, never mirrored); the route polyline is clipped at the near plane; the ring is the waypoint's arrival radius as it appears at that distance. Distance and elevation are Baymax's own (in Baymax view the camera trails him by 7 m); inside max(12 m, 2.5 × arrival radius) the HUD switches to **precision**: reticle plus camera-relative offsets ("3.1 m ahead · 1.8 m up"). Waypoints advance in order (several can be passed in one fast step); the final one completes on the true object. The real-browser proof sampled the HUD during an eased approach: 23–64 samples inside 10 m, readout error ≤ 0.36 m, ring or edge cue always present.

## 11. Verification

| What | How | Result |
|---|---|---|
| Dimension unit tests | `npx vitest run` (dimension worktree) | 157 / 157 |
| ATLAS unit tests | `npx vitest run` (atlas worktree) | 253 / 253 |
| Typecheck, builds | `npx tsc --noEmit`, `vite build` both | clean |
| Shared files | `node scripts/sync-shared.mjs --check` | in sync (34 models) |
| Live product | `node scripts/live-e2e.mjs` (two real Chrome windows, keyboard/mouse flight) | 10 / 10, 0 page errors (A, P1, S, P2, G5, P3a, P3b, F, HUD, R) |
| L-key flow | `node scripts/live-opener-check.mjs` | connected from the Dimension's opener |
| Cold start | `scripts/start-live-demo.ps1` from no servers | builds, serves, reports URLs |
| Strategy comparison | `scripts/atlas-intercept-report.ts` | section 8 |
| Frame rate | `scripts/live-perf.mjs` | `docs/evidence/live-perf.json` (headless Chrome, integrated GPU; Dimension alone measured 26–44 fps across runs with p50 17–24 ms, so treat as indicative; ATLAS figure counts animation callbacks, the canvas itself is capped at 30 fps) |
| Independent QA audit | a separate auditor agent, `docs/evidence/qa/` | 11 scenarios; no console or page errors; findings fixed afterwards: revision re-sync, island replan noise, HUD edge insets, label clipping, misleading ETA, link-lost state, peer heartbeat (re-verified by `live-e2e` 10/10 after the fixes); near-object click picking and the unexplained unchanged session id after a popup re-navigation were not conclusively verified |

The existing Dimension Playwright suite (`npm run test:e2e`, run against port 4183) passes 8 of 9 and fails `assets.spec.ts › freezes all motion on pause`; the same test fails intermittently on the **unmodified** original build on this machine (measured: 2 of 5 runs of the pixel-difference probe) and is therefore recorded as a pre-existing flake, not a regression.

## 12. Limitations

* Prediction is a local polynomial extrapolation with measured, finite skill (useful to about 6 s on this path); it is not a model of the world's law and is never presented as one.
* Folds: selecting and navigating to an entrance works for any observed fold; traversal remains the Dimension's existing `E` mechanic; exits are not predicted and objects disappearing into folds are not tracked.
* The live comparison against a plain chase is a tie in this world (section 8).
* ATLAS draws islands without the Dimension's local strain, at coarse resolution; the first island meshes appear a second or two after the first scan.
* The two windows are linked by `postMessage`, so one must open the other (button or **L**); two independently opened tabs cannot find each other without a server.
* Frame rates: the integrated GPU is shared. `docs/evidence/live-perf.json` was measured headless with each window in front in turn; with both windows visible they compete (ATLAS has an Eco switch and a 30 fps cap for this reason).
