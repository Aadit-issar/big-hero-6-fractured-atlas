# Mathematical model — Phase 2

## Scope

This is fictional computational world physics. Nonlinear coupling does not establish chaos. Coordinate degeneracy does not itself create a wormhole: the temporary connection law below is an explicit additional fictional rule.

## Field, coordinates and derivatives

```text
Φ(q,t) = Σᵢ Aᵢ sin(uᵢ) + λ Σᵢ<ⱼ AᵢAⱼ sin(uᵢ)sin(uⱼ)
uᵢ = kᵢ·q − ωᵢt + θᵢ
X(q,t) = L[q + α∇Φ(q,t)]
J = I + αHΦ;    DX/Dq = LJ;    det(DX/Dq) = L³ det J
```

`q` is dimensionless reference space, `X` is rendering units and `t` is model seconds. Geometry-local vertices use rendering units. The authoritative Phase 2 configuration in `SPATIAL_MODEL` uses **L=7.5, α=4**, four waves and seed `17062026`. Original Phase 1 `createFieldParameters()` and `DEFORMATION` (.9) remain intact for reproducibility/regression.

`createSpatialParameters()` preserves the original seeded draws but sets `k=2k₀`, `ω=.16ω₀`, `θ=θ₀−20ω`. This is a spatial-scale change and a time shift/stretch of the same wave family, not a replacement field. The origin selects a legitimate accessible opening fold; the slower temporal scale provides useful traversal windows.

| Quantity | Phase 2 generated range |
| --- | --- |
| A | [.12,.20) |
| magnitude k | [.56,.94) |
| ω | [.0512,.1024) radians/model second |
| λ | [.24,.32) |

Validation allows 1–8 waves, A [.02,.30], magnitude k [.05,1.25], ω [.02,1.5], λ [0,.5]. Unsupported/non-finite parameters are rejected. Seed integers normalize to uint32 and Mulberry32 generates independent field, terrain and probe streams. Seeds differing by 2³² intentionally alias.

The analytical gradient is

```text
∇Φ = Σ Aᵢ cos(uᵢ)kᵢ
   + λΣᵢ<ⱼ AᵢAⱼ[cos(uᵢ)sin(uⱼ)kᵢ + sin(uᵢ)cos(uⱼ)kⱼ]
HΦ = −Σ Aᵢ sin(uᵢ)kᵢkᵢᵀ
   + λΣᵢ<ⱼ AᵢAⱼ[−sin(uᵢ)sin(uⱼ)(kᵢkᵢᵀ+kⱼkⱼᵀ)
                          +cos(uᵢ)cos(uⱼ)(kᵢkⱼᵀ+kⱼkᵢᵀ)]
```

Matrices are row-major. `fieldVelocity` analytically differentiates the gradient in time and multiplies by Lα. Tests compare gradient, Hessian, world Jacobian and temporal velocity against central differences. New Jacobian checks use 1e-5 steps and seven decimal places; velocity error must be below 1e-7. Existing derivative/stress tests remain in place, including long-time samples through 7,200 seconds.

## Bounded parameter investigation

Run `npm run analyze:field`. The recorded grid samples x[-6,6]/1.5, y[-2,4]/1.5, z[-12,4]/2 at t=0,5,10,20,40: 2,025 samples for each of 19 configurations. Original temporal parameters are retained for the four original-k baseline comparisons; alternatives use the final Phase 2 temporal configuration. This is a reproducible sampled comparison, not a proof over continuous space.

| Regime | min σ | fraction σ<.08 | fraction σ>.5 | p95 displacement |
| --- | ---: | ---: | ---: | ---: |
| Phase 1: k×1, α=.9 | .92054 | 0% | 100% | 1.208u |
| k×1, α=12 | .000940 | 2.22% | 79.11% | 16.107u |
| selected k×2, α=4 | .0003324 | 6.37% | 72.05% | 10.141u |

Selected determinant range is [-.29480,2.52672], median displacement 5.317u, maximum sampled displacement 12.161u. All 38,475 sampled evaluations were finite. Increasing spatial frequency produces useful curvature with less displacement than simply increasing α to 12. See `evidence/parameter-search.json` for all alternatives.

For generated parameters, |Φ|<.88, |∇Φ|≤4(.2)(.94)+6(.32)(.2²)(1.88)<.897. Thus field displacement is conservatively <26.91 rendering units for every time. Periodic bounded trigonometric terms prevent time growth, though they do not prevent map singularities. Input coordinates/time are bounded to ±1,000,000 to avoid inappropriate phase precision.

## Compression and candidate discovery

The symmetric J is diagonalized using bounded Jacobi rotations. Its singular values are absolute eigenvalues; **σ=min |eigenvalue(J)|** detects directional compression without determinant scale ambiguity. The corresponding eigenvector gives the compression axis. Negative determinant alone never authorizes traversal.

Initial discovery samples a 7×4×9 grid over q x[-6,6], y[-2,4], z[-12,4] at t=0,16,32. Sign changes of the smallest eigenvalue are refined with ten bisections, at most 80 edges per time. Roots cluster at reference separation 1.35. Eight anchors are selected deterministically, prioritizing legitimate valid opening windows and spatial spread. Anchor IDs remain fixed.

At a requested quarter-second sample, each anchor searches its fixed reference line ±1.8 with eight subintervals and nine root bisections. The closest root is tracked; no root means invalid. Candidate positions/orientations evolve with the field. This deliberately bounded detector covers selected regions, not all singular surfaces. A confidence of `1−σ/.08` measures numerical root quality only.

## Explicit connection law and lifecycle

Two endpoints straddle the root along its current compression eigenvector, at offsets .95,1.15 or1.35 reference units. Choose the first offset whose two endpoint σ values are at least .06. A valid pair requires:

- a real eigenvalue sign-change root and root σ<.08;
- reference separation ≥1.8 (normally 1.9) and mapped separation <6 rendering units;
- opposite directional stretch signs: `(aᵀJₐa)(aᵀJᵦa)<0`;
- endpoint minimum stretch ≥.06 and endpoint hazard <.85.

This joins distinct reference sheets compressed near one another, rather than arbitrary rendered portal positions. A normal is normalized `J_endpoint a`. The graph stores both reference/world endpoints, region IDs, orientation, stability, traversal cost and sampled time.

Availability reconstructs from integer ticks `floor(t/.25)`, independent of request order. A valid candidate with no valid sample one second earlier is forming. Four valid future quarter-second samples give a **sampled** one-second safety horizon; failure of this lookahead means closing. Otherwise stability below .48 is unstable, above it open. Only open/unstable with stability≥.25 permit traversal. Invalid immediately after a prior valid sample is closed, then inactive. This temporal guard is hysteresis derived from field samples, not frame history. It cannot guarantee validity at every intermediate continuous time.

All eight are usable at t=0. For F05, open becomes unstable at14.75s, closing15.25s, closed16.25s; it forms again48.5s and becomes usable49.5s. F08 closes earlier at6.75s and reopens45s. See `evidence/connection-history.json` for exact sampled windows and pair metrics. Some times have no active connections; reset restores the opening demonstration.

## Branch-aware coordinates and traversal

There is no globally unique inverse. A damped least-squares solve uses the previous valid reference coordinate, `JᵀJ+μ²I`, at most14 iterations, per-step trust radius .35, total branch radius1.8 and bounded backtracking. Damping μ=.015 when σ<.1, otherwise1e-5. Convergence requires world residual<1e-5. Exact solutions with σ<.03 report ill-conditioned. Failure returns the prior reference, residual and explicit status; it does not silently substitute X/L or switch branches.

World-space free flight can cross a caustic where that local inverse branch terminates. Diagnostics then describe the last valid estimate and mark uncertainty. An explicit E interaction within5 world units selects the nearby mathematically defined entrance branch (reference proximity breaks overlapping-aperture ambiguity), rechecks graph availability and atomically transfers to the opposite sheet. This explicit branch selection is permitted even if the continuous flight inverse is uncertain; it is not an implicit inverse claim.

Exit selection searches bounded outward reference offsets [.8,1.2,1.6,2] and vertical lifts [0,.4,.8,1.3,1.9,2.7], requiring σ≥.2, distance>4u from the destination aperture and conservative island clearance>1u. Unavailable safe exits reject traversal without mutation. Orientation is preserved; region ID/ref/world position change together. A 1.5-model-second cooldown prevents repeated entry. Accepted transfers are atomic, so closing cannot strand a partial transition. Clearance uses conservative island center/radius/height bounds; this is not general collision detection.

## Gravity and instability

Let `C=1/(1+(σ/.28)²)`, curvature `K=||H||F`, world deformation velocity `V=|∂tX|`. Define

```text
h = .5 C + .25 K/(.3+K) + .25 V/(8+V)
stability = 1−h
g(q,t) = −.65(1+h)∇Φ(q,t)  [reference units/model second²]
```

.28 is a strong-compression scale; .3 is a reference curvature scale; 8u/s is a deformation-speed scale. Saturating ratios keep h in[0,1) without hiding invalid arithmetic. Hazard changes fold stability/traversal cost (`1+4h+endpointDistance/6`) and amplifies gravity. It is not an arbitrary decorative color score.

Twelve seeded probes obey `q''=g−.65(q−anchor)−.95q'`, integrated symplectic Euler at1/60 model second from deterministic initial conditions. The tether/damping are explicit confinement, not silent position clamps. Visual positions use the same nonlinear map; four arrows show normalized Jg direction. Integer ticks make final probe state independent of render cadence. Calls replay at most240 steps; an explicit `targetReached` reports any remaining catch-up. Normal capped clock progression never exceeds this budget. Reverse time/reset rebuilds the initial state. Non-finite/runaway velocity throws.

## Local island representation and time

Island centers always map original reference coordinates. Their local rendering vertices receive `Jlocal=I+ηαH`, where `η=min(.3,.18/(|α| ||H||F))`. This bounded first-order field deformation guarantees stretch in[.82,1.18] and preserves triangle orientation. It is deliberately not an exact globally folded mesh, avoiding unreadable inverted terrain until later terrain work. Three.js normal matrices follow this affine transform.

One clock controls islands, graph, hazards and probes. Pause freezes all authoritative evolution while flight remains usable. A real-time update is capped at .1 seconds before time scaling; no unbounded stall catch-up. Reset restores time0/speed1/running/probes/branch history. Same seed+model+explicit time reproduces field/graph; probes additionally replay fixed ticks. Wall-clock profiling values never affect simulation decisions.
