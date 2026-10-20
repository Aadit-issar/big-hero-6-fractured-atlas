import { deformPosition } from '../../src/simulation/deformation';
import { evaluateField } from '../../src/simulation/field';
import type { SimulationEngine } from '../../src/simulation/simulationEngine';
import type { FieldParameters, DeformationSettings, Vec3 } from '../../src/simulation/types';
import { TRAIL_CAPACITY, TRAIL_STRIDE, TrailBuffer } from './trail';

/** Dynamical extension of the Dimension: a few physical objects that move under an explicit, deterministic law.
 *
 * The spatial law X(q,t) = L (q + α ∇Φ(q,t)) is a MAP, not a force, so on its own it only distorts positions. The movers add the
 * missing dynamics in REFERENCE space and then push the result through the unchanged map:
 *
 *     q̈ = −k (q − g(t)) − c q̇ − μ ∇Φ(q,t) + a_d(q,t)         X = L (q + α ∇Φ(q,t))
 *
 *  - g(t) is a slow closed guide orbit (the object's intended drift lane),
 *  - k, c are a damped-spring pull towards that lane (it never leaves the neighbourhood of the lane),
 *  - −μ∇Φ is a conservative force from the SAME field Φ that defines the map (field-influenced motion),
 *  - a_d is one localised, time-modulated swirl: the "dimensional disturbance" (not gravity; a fictional additional law).
 *
 * Overhaul extensions (docs/DIMENSION_DYNAMICS_OVERHAUL.md). All of them are ADDITIVE terms that are absent (bit-identical to the law above)
 * unless a mover or disturbance opts in, so the original four movers, and in particular Abigail's capsule, follow exactly the same path:
 *
 *     m q̈ᵉˣᵗ-terms:   q̈ = −k (q − g(t)) − c q̇ − c₂ |q̇| q̇ − μ ∇Φ + (1/m) [ Σ_d a_d(q,t) + a_fold(q,t) ]
 *
 *  - c₂ (`drag`): quadratic drag, so light/flat pieces decelerate hard after a kick while compact ones coast,
 *  - m (`mass`): inertia against the disturbance and fold forces only (Φ already has its own `fieldCoupling`),
 *  - a_d: swirl | slip sheet | breathing well (see DisturbanceDef.kind), each with an `affects` list of mover ids,
 *  - a_fold: a funnel through each currently-open fold (entry attracts, exit ejects) weighted by the fold's real state on the 4 Hz lattice,
 *  - ψ̇ = κ_ψ Σ (disturbance + fold activity): extra spin angle about the body axis (objects spin up inside a disturbance).
 *
 * Integration is symplectic Euler at integer 1/60 s ticks from a seeded initial state, so a state is a pure function of the seed and
 * the tick count: reset and replay are exact. Nothing here imports rendering, and nothing in src/simulation depends on it. */

export const MOVER_STEP = 1 / 60;
export type Quat = readonly [number, number, number, number];

export type DisturbanceKind = 'swirl' | 'sheet' | 'well';

export interface DisturbanceDef {
  readonly id: string;
  readonly label: string;
  /** Reference-space centre; its world position is the map of this point at time t. */
  readonly centre: Vec3;
  /** Gaussian width (reference units). */
  readonly sigma: number;
  /** swirl: rotation axis. sheet: surface normal n. well: unused. */
  readonly axis: Vec3;
  /** Peak acceleration (reference units / s²). */
  readonly strength: number;
  /** Modulation: s(t) = 0.5 + 0.5 sin(ω t + φ) (well: p(t) = sin(ω t + φ), so it alternately attracts and repels). */
  readonly omega: number;
  readonly phase: number;
  /** Law of the force. Default 'swirl' (the original disturbance, unchanged).
   *   swirl:  a = A s(t) w(r) (n̂ × r)/σ,            w = exp(−|r|²/2σ²), n̂ = axis (optionally precessing)
   *   sheet:  a = A s(t) tanh(h/δ) e^(−h²/2(4δ)²) e^(−|r∥|²/2σ²) t̂,   h = n̂·r: the force FLIPS SIGN across the surface h = 0 (slip along t̂)
   *   well:   a = −A p(t) w(r) r/σ                    a breathing attractor/repeller */
  readonly kind?: DisturbanceKind;
  /** Mover ids this disturbance acts on. Absent = every mover (the original disturbance). */
  readonly affects?: readonly string[];
  /** sheet: slip direction (projected into the surface). */
  readonly direction?: Vec3;
  /** sheet: half thickness δ of the shear layer (reference units). */
  readonly thickness?: number;
  /** swirl: axis precession n̂(t) = unit(n̂₀ + tilt (cos Ωt u₁ + sin Ωt u₂)), a rotating shear. */
  readonly precession?: { readonly rate: number; readonly tilt: number };
}

export interface MoverDef {
  readonly id: string;
  readonly label: string;
  /** Registry asset id of the physical model (the SAME id is used by every viewer of this object). */
  readonly assetId: string;
  readonly role: 'capsule' | 'equipment' | 'debris';
  readonly category: 'landmark' | 'baymax' | 'steel' | 'concrete' | 'pipe';
  readonly family: 'capsule' | 'baymax' | 'industrial' | 'concrete';
  /** Bounding radius (m), used for approach and clearance. */
  readonly radius: number;
  /** Range (m) at which the object's transponder is acquired. Abigail's capsule carries a distress beacon; the rest rely on the standard sensor range. */
  readonly beaconRange?: number;
  readonly centre: Vec3;
  /** Orbit semi-axes (reference units) along the orthonormal frame (e1, e2, e3). */
  readonly semiAxes: Vec3;
  readonly frame: readonly [Vec3, Vec3, Vec3];
  readonly omega: number;
  readonly secondaryRatio: number;
  readonly phase: readonly [number, number];
  readonly stiffness: number;
  readonly damping: number;
  readonly fieldCoupling: number;
  readonly spin: { readonly axis: Vec3; readonly rate: number; readonly q0: Quat };
  // --- additive overhaul parameters (absent on the original four movers) ---
  /** Inertia against disturbance/fold forces (default 1). Heavy objects barely deflect, light ones are thrown. */
  readonly mass?: number;
  /** Quadratic drag coefficient c₂ (1/m in reference units). */
  readonly drag?: number;
  /** Lane shape (default 'ellipse', the original Lissajous). */
  readonly lane?: LaneKind;
  /** Strength κ of the fold funnel force; 0/absent = ignores folds. */
  readonly foldCoupling?: number;
  /** Extra spin rate (rad/s) per unit of disturbance/fold activity. */
  readonly spinCoupling?: number;
  /** Draws a fading trail of this mover's own past mapped positions. */
  readonly trail?: boolean;
}

export type LaneKind = 'ellipse' | 'figure8' | 'trefoil';

const frameFrom = (yaw: number, tilt: number): readonly [Vec3, Vec3, Vec3] => {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const e1: Vec3 = [cy, 0, -sy];
  const e2: Vec3 = [sy * ct, st, cy * ct];
  const e3: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return [e1, e2, e3];
};

const SPRING = { stiffness: 2.6, damping: 3.0 };

/** The authored population. Parameters are fixed constants (not random), so the world is identical in every run. */
export const CORE_MOVER_DEFS: readonly MoverDef[] = [
  {
    id: 'capsule-abigail', label: "Abigail's Capsule", assetId: 'capsule_shell_remnant', role: 'capsule', category: 'landmark', family: 'capsule', radius: 2.4, beaconRange: 100,
    centre: [-0.1537, 2.0585, -3.5875], semiAxes: [3.3874, 2.2618, 0.7472], frame: [[0.089, 0, -0.996], [0.931, -0.355, 0.084], [-0.353, -0.935, -0.032]], omega: 0.0823, secondaryRatio: 1.7, phase: [3.6082, 1.3873], ...SPRING, fieldCoupling: 1.7343,
    spin: { axis: [0, 1, 0], rate: 0.22, q0: [0.12, 0.2, 0.05, 0.97] },
  },
  {
    id: 'armor-chest', label: 'Baymax chest armour', assetId: 'baymax_chest_armor', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.9,
    centre: [-0.8, 1.2, -1.2], semiAxes: [1.4, 0.9, 0.3], frame: frameFrom(-0.6, 0.15), omega: 0.09, secondaryRatio: 2.1, phase: [2.2, 1.1], ...SPRING, fieldCoupling: 1.2,
    spin: { axis: [0.3, 1, 0.1], rate: 0.35, q0: [0.3, 0.1, -0.2, 0.92] },
  },
  {
    id: 'armor-shoulder', label: 'Baymax shoulder armour', assetId: 'baymax_shoulder_shell', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.7,
    centre: [1.5, 0.9, -3.0], semiAxes: [1.2, 1.0, 0.3], frame: frameFrom(0.9, -0.2), omega: 0.07, secondaryRatio: 1.9, phase: [4.0, 2.2], ...SPRING, fieldCoupling: 1.0,
    spin: { axis: [1, 0.2, 0.4], rate: 0.28, q0: [-0.1, 0.4, 0.2, 0.88] },
  },
  {
    id: 'girder-drift', label: 'Drifting steel girder', assetId: 'industrial_ibeam_twisted', role: 'debris', category: 'steel', family: 'industrial', radius: 2.4,
    centre: [-0.2, 2.0, -3.4], semiAxes: [1.6, 1.0, 0.4], frame: frameFrom(-1.3, 0.4), omega: 0.06, secondaryRatio: 1.5, phase: [1.4, 3.3], ...SPRING, fieldCoupling: 0.8,
    spin: { axis: [0.1, 0.2, 1], rate: 0.16, q0: [0, 0.25, 0, 0.97] },
  },
];

/** The overhaul population (docs/DIMENSION_DYNAMICS_OVERHAUL.md): seven new movers with distinct inertia, drag, lane shape and coupling to the
 * new disturbances and to the real folds. Lanes were found with scripts/mover-design.ts (seeded random search over lane parameters) under the
 * constraints: inside the cavern, clear of every island's rock, at least 8 m from Abigail's capsule at all times, bounded speed. The statistics in
 * the comment above each entry are from that search (first 120 s: seconds spent inside the home disturbance, mean/max world speed, 95th-percentile
 * turn rate, clearance beyond rock + radius, nearest approach to the capsule). */
export const OVERHAUL_MOVER_DEFS: readonly MoverDef[] = [
  // home 70s fold 0s mean 2.16 max 11.46 p95turn 1.515 maxcurv 16.188 clear 5.9 capDist 24.2
  {
    id: 'shard-glider', label: 'Baymax plating shard', assetId: 'baymax_plating_shard', role: 'debris', category: 'baymax', family: 'baymax', radius: 0.6,
    centre: [3.7807,3.0023,-4.4259], semiAxes: [1.9294,0.887,0.5278], frame: [[0.3127,0,-0.9499],[0.9441,0.1103,0.3108],[0.1048,-0.9939,0.0345]], omega: 0.0951, secondaryRatio: 2.3943, phase: [0.7946,1.9598], fieldCoupling: 1.2507, stiffness: 1.8, damping: 1.8,
    mass: 0.55, drag: 0.16, spinCoupling: 1.2, lane: 'trefoil', trail: true,
    spin: { axis: [-0.0347,1,0.079], rate: 0.9, q0: [-0.0898,0.173,0.1537,0.9] },
  },
  // home 58s fold 23s mean 2.27 max 5.79 p95turn 1.631 maxcurv 10.494 clear 5.3 capDist 26.8
  {
    id: 'heatshield-skimmer', label: 'Capsule heat-shield panel', assetId: 'capsule_heatshield_panel', role: 'debris', category: 'landmark', family: 'capsule', radius: 0.9,
    centre: [4.5911,1.6859,-4.4413], semiAxes: [2.0172,1.0689,0.3372], frame: [[0.0852,0,0.9964],[-0.9367,-0.3408,0.0801],[0.3396,-0.9401,-0.0291]], omega: 0.1794, secondaryRatio: 1.6432, phase: [5.1654,5.978], fieldCoupling: 0.8669, stiffness: 2.0, damping: 2.2,
    mass: 0.6, drag: 0.08, foldCoupling: 2.0, spinCoupling: 0.8, lane: 'figure8', trail: true,
    spin: { axis: [-0.4035,1,-0.2994], rate: 0.6, q0: [-0.0707,0.1584,-0.0947,0.9] },
  },
  // home 45s fold 38s mean 2.45 max 5.94 p95turn 0.944 maxcurv 11.303 clear 3.9 capDist 11.7 (300 s search)
  {
    id: 'joint-orbiter', label: 'Baymax joint shell', assetId: 'baymax_joint_shell', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.55,
    centre: [1.9112,2.6321,-3.0325], semiAxes: [1.803,0.8443,0.4717], frame: [[0.9081,0,0.4188],[-0.4131,-0.1646,0.8957],[0.0689,-0.9864,-0.1495]], omega: 0.1935, secondaryRatio: 1.5141, phase: [0.0346,1.3081], fieldCoupling: 1.1392, stiffness: 2.2, damping: 2.4,
    mass: 0.8, drag: 0.02, foldCoupling: 3.2, spinCoupling: 1.0, trail: true,
    spin: { axis: [0.4025,1,-0.4652], rate: 0.7, q0: [-0.1122,-0.1638,0.1443,0.9] },
  },
  // home 140s fold 0s mean 1.24 max 5.13 p95turn 1.188 maxcurv 8.699 clear 4.4 capDist 11.8 (300 s search)
  {
    id: 'collar-ring', label: 'Capsule collar ring', assetId: 'capsule_collar_ring', role: 'debris', category: 'landmark', family: 'capsule', radius: 1.0,
    centre: [-0.4101,2.2236,-2.9146], semiAxes: [1.4297,0.8674,0.3179], frame: [[0.3089,0,0.9511],[-0.9354,0.181,0.3038],[-0.1721,-0.9835,0.0559]], omega: 0.0867, secondaryRatio: 1.751, phase: [1.8004,5.5351], fieldCoupling: 1.3338, stiffness: 2.4, damping: 2.6,
    mass: 1.0, spinCoupling: 2.2, trail: true,
    spin: { axis: [-0.3028,1,0.1078], rate: 0.5, q0: [-0.0772,-0.0499,0.0016,0.9] },
  },
  // home 168s fold 0s mean 1.61 max 3.59 p95turn 0.759 maxcurv 7.128 clear 1.4 capDist 16.2 (300 s search)
  {
    id: 'forearm-tumbler', label: 'Baymax forearm shell', assetId: 'baymax_forearm_shell', role: 'equipment', category: 'baymax', family: 'baymax', radius: 0.7,
    centre: [-3.3314,-0.3021,-4.8208], semiAxes: [1.2798,0.9246,0.3818], frame: [[0.1666,0,-0.986],[0.9086,0.3884,0.1535],[0.383,-0.9215,0.0647]], omega: 0.1295, secondaryRatio: 2.2502, phase: [0.476,6.0495], fieldCoupling: 1.1865, stiffness: 2.6, damping: 2.8,
    mass: 1.6, spinCoupling: 1.6, trail: true,
    spin: { axis: [0.1251,1,0.398], rate: 0.3, q0: [0.1571,-0.0054,-0.143,0.9] },
  },
  // home 88s fold 0s mean 0.90 max 2.15 p95turn 0.439 maxcurv 3.874 clear 6.3 capDist 16.1
  {
    id: 'pipe-long', label: 'Fractured steel pipe', assetId: 'industrial_pipe_large_fractured', role: 'debris', category: 'pipe', family: 'industrial', radius: 2.0,
    centre: [-2.6876,-0.8879,-4.2048], semiAxes: [1.2338,0.7138,0.4395], frame: [[0.7772,0,0.6293],[-0.6292,-0.0095,0.7771],[0.006,-1,-0.0074]], omega: 0.0748, secondaryRatio: 1.6713, phase: [1.5434,1.942], fieldCoupling: 0.8872, stiffness: 2.6, damping: 3.0,
    mass: 3.0, spinCoupling: 0.5, trail: true,
    spin: { axis: [-0.4195,1,0.3287], rate: 0.14, q0: [0.1097,-0.1136,-0.0712,0.9] },
  },
  // home 84s fold 0s mean 0.71 max 1.02 p95turn 0.211 maxcurv 8.856 clear 6.6 capDist 19.8
  {
    id: 'slab-drifter', label: 'Concrete slab with rebar', assetId: 'concrete_slab_rebar', role: 'debris', category: 'concrete', family: 'concrete', radius: 1.8,
    centre: [4.5458,1.9373,-4.1078], semiAxes: [1.0882,0.6993,0.2301], frame: [[0.5116,0,0.8592],[-0.8194,0.3009,0.4879],[-0.2585,-0.9537,0.1539]], omega: 0.0848, secondaryRatio: 1.4823, phase: [6.0204,5.2726], fieldCoupling: 0.5716, stiffness: 2.6, damping: 3.0,
    mass: 6.0, drag: 0.1, spinCoupling: 0.25, trail: true,
    spin: { axis: [0.2003,1,0.0952], rate: 0.1, q0: [-0.1178,-0.1473,-0.0814,0.9] },
  },
];

/** The full population. The first four entries are the original movers, unchanged in definition and order. */
export const MOVER_DEFS: readonly MoverDef[] = [...CORE_MOVER_DEFS, ...OVERHAUL_MOVER_DEFS];

/** An alternate, equally deterministic lane for Abigail's capsule: about twice as fast (mean 4 m/s, up to 6.5 m/s) and about twice as sharply
 * curved. It is the stress case for predictive interception (`?capsule=fast`, tested in tests/commandCore and scripts/atlas-intercept-report.ts):
 * a target this quick is not caught by simply flying at where it was last seen. The default lane is the one tuned for learnable motion. */
export type MoverVariant = 'cruise' | 'fast';
export const FAST_CAPSULE: MoverDef = {
  ...MOVER_DEFS[0]!,
  centre: [1.325, 2.1845, -1.8808], semiAxes: [4.2887, 2.8382, 0.4665], frame: [[0.123, 0, 0.992], [-0.974, 0.193, 0.121], [-0.192, -0.981, 0.024]], omega: 0.1474, phase: [6.1837, 5.7161], fieldCoupling: 0.6025,
};
export function moverDefsFor(variant: MoverVariant): readonly MoverDef[] { return variant === 'fast' ? [FAST_CAPSULE, ...MOVER_DEFS.slice(1)] : MOVER_DEFS; }
function variantFromUrl(): MoverVariant { try { return new URLSearchParams(window.location.search).get('capsule') === 'fast' ? 'fast' : 'cruise'; } catch { return 'cruise'; } }

/** The disturbances in the reference volume the movers share (the first is the original swirl and acts on every mover). Positions drift with the map, so each is a moving region. */
export const DISTURBANCES: readonly DisturbanceDef[] = [
  { id: 'disturbance-1', label: 'Dimensional disturbance', centre: [1.8, 1.7, -2.4], sigma: 0.9, axis: [0, 1, 0.2], strength: 2.6, omega: 0.21, phase: 0.6 },
  // Overhaul disturbances. Each acts only on the listed movers (never on Abigail's capsule or the original armour/girder).
  // A fracture sheet: the force flips sign across a surface, so objects on either side are slipped in opposite directions.
  { id: 'fracture-sheet', label: 'Fracture slip sheet', centre: [4.3, 2.6, -4.2], sigma: 1.3, axis: [1, 0.2, 0.3], strength: 4.2, omega: 0.17, phase: 1.1, kind: 'sheet', direction: [0, 0.3, -1], thickness: 0.18, affects: ['shard-glider', 'heatshield-skimmer', 'slab-drifter'] },
  // A breathing well: attracts, then repels, on an 18 s cycle.
  { id: 'breathing-well', label: 'Breathing well', centre: [-3.2, -0.8, -4.5], sigma: 0.85, axis: [0, 1, 0], strength: 5.5, omega: 0.35, phase: 0.4, kind: 'well', affects: ['forearm-tumbler', 'pipe-long'] },
  // A rotating shear: a swirl whose axis precesses, so the sense of the deflection turns over time.
  { id: 'precessing-vortex', label: 'Precessing shear vortex', centre: [-0.5, 2.5, -3.0], sigma: 0.8, axis: [0.2, 1, 0.1], strength: 4.0, omega: 0.13, phase: 2.0, kind: 'swirl', precession: { rate: 0.45, tilt: 0.7 }, affects: ['collar-ring', 'joint-orbiter', 'shard-glider'] },
];

export const MOVER_IDS: readonly string[] = MOVER_DEFS.map(m => m.id);

interface Body { q: Vec3; v: Vec3 }

export interface MoverState {
  readonly id: string;
  /** Mapped world position (rendering units, metres) at the state's own time. */
  readonly position: Vec3;
  readonly quaternion: Quat;
  /** Reference-space speed × map scale is NOT the world speed; the world velocity is the finite difference of the map. */
  readonly referencePosition: Vec3;
}

const guide = (m: MoverDef, t: number): Vec3 => {
  const a = m.omega * t + m.phase[0], b = m.secondaryRatio * m.omega * t + m.phase[1];
  let x: number, y: number;
  switch (m.lane) {
    // Lemniscate-like figure eight: the lane crosses itself, so the object changes direction twice per period.
    case 'figure8': x = m.semiAxes[0] * Math.sin(a); y = m.semiAxes[1] * Math.sin(2 * a) * 0.5; break;
    // Trefoil knot projection: three lobes, strongly curved lane.
    case 'trefoil': x = m.semiAxes[0] * (Math.sin(a) + 2 * Math.sin(2 * a)) / 3; y = m.semiAxes[1] * (Math.cos(a) - 2 * Math.cos(2 * a)) / 3; break;
    default: x = m.semiAxes[0] * Math.cos(a); y = m.semiAxes[1] * Math.sin(a);
  }
  const z = m.semiAxes[2] * Math.sin(b);
  return [0, 1, 2].map(i => m.centre[i]! + x * m.frame[0][i]! + y * m.frame[1][i]! + z * m.frame[2][i]!) as unknown as Vec3;
};

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => { const n = norm3(v); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 1, 0]; };

/** Unit-quaternion product (x, y, z, w). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const normalizeQuat = (q: Quat): Quat => { const n = Math.hypot(q[0], q[1], q[2], q[3]); return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };

/** Orientation: a fixed initial attitude followed by a constant-rate spin about a body axis (analytic); movers with `spinCoupling` add the
 * integrated disturbance spin angle ψ(t) (a state of the integrator, still a pure function of the tick count). */
export function moverQuaternion(m: MoverDef, t: number, extraAngle = 0): Quat {
  const axis = unit(m.spin.axis), half = 0.5 * (m.spin.rate * t + extraAngle), s = Math.sin(half);
  return normalizeQuat(quatMultiply(normalizeQuat(m.spin.q0), [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]));
}

export interface DisturbanceState { readonly id: string; readonly label: string; readonly position: Vec3; readonly radius: number; readonly intensity: number }

/** A fold as the movers see it: its reference-space endpoints and its real state weight (0 = closed/invalid) on the 4 Hz lattice. */
export interface FoldAnchor { readonly id: string; readonly entry: Vec3; readonly exit: Vec3; readonly weight: number }
export type FoldSource = (latticeTime: number) => readonly FoldAnchor[];
/** How strongly a connection state pulls objects (same ordering as the gas's FOLD_OPENING). */
export const FOLD_FORCE_WEIGHT: Readonly<Record<string, number>> = { open: 1, unstable: 0.85, forming: 0.45, closing: 0.35, inactive: 0, closed: 0 };
/** Fold anchors from the engine's public network API (valid connections only). Deterministic in the lattice time. */
export function foldSourceFor(engine: SimulationEngine): FoldSource {
  return latticeTime => engine.network.getConnections(latticeTime).flatMap(c => {
    const weight = c.valid ? FOLD_FORCE_WEIGHT[c.state] ?? 0 : 0;
    return weight > 0 ? [{ id: c.id, entry: c.entryReferencePosition, exit: c.exitReferencePosition, weight }] : [];
  });
}
/** Fold funnel width ρ (reference units). */
export const FOLD_RANGE = 0.9;

/** Samples per tick window kept for trails. */
export const TRAIL_WINDOW_TICKS = TRAIL_STRIDE * TRAIL_CAPACITY;

const modulation = (d: DisturbanceDef, t: number): number => 0.5 + 0.5 * Math.sin(d.omega * t + d.phase);
/** Public intensity 0..1 of a disturbance: its force envelope s(t) (well: |p(t)|, since it alternates sign). */
export const disturbanceIntensity = (d: DisturbanceDef, t: number): number => (d.kind === 'well' ? Math.abs(Math.sin(d.omega * t + d.phase)) : modulation(d, t));

/** Axis of a (possibly precessing) swirl at time t. Without precession this is exactly unit(axis). */
export function swirlAxis(d: DisturbanceDef, t: number): Vec3 {
  const n = unit(d.axis);
  if (!d.precession) return n;
  const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u1 = unit(cross(n, helper)), u2 = cross(n, u1);
  const ph = d.precession.rate * t, c = Math.cos(ph) * d.precession.tilt, sn = Math.sin(ph) * d.precession.tilt;
  return unit([n[0] + c * u1[0] + sn * u2[0], n[1] + c * u1[1] + sn * u2[1], n[2] + c * u1[2] + sn * u2[2]]);
}

/** In-plane slip direction of a sheet (the requested direction projected into the plane, unit). */
export function sheetSlip(d: DisturbanceDef): Vec3 {
  const n = unit(d.axis), dir = d.direction ?? [1, 0, 0];
  const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
  return unit([dir[0] - dn * n[0], dir[1] - dn * n[1], dir[2] - dn * n[2]]);
}

/** Deterministic fixed-step mover integrator. Use `syncTo(time)` with the engine clock time; rewinding replays from tick 0. */
export class MoverSystem {
  private bodies: Body[];
  /** Extra spin angle ψ per mover (rad), integrated from disturbance/fold activity. Zero unless `spinCoupling` is set. */
  private psi: number[];
  /** Activity (0..) of each disturbance on each mover at the last tick, row-major [mover][disturbance]. Read by the visuals only. */
  readonly influence: Float64Array;
  /** Total fold-funnel activity per mover at the last tick (visuals only). */
  readonly foldActivity: Float64Array;
  private readonly trails: (TrailBuffer | null)[];
  private recordFrom = 0;
  private foldKey = -1;
  private foldAnchors: readonly FoldAnchor[] = [];
  private readonly usesFolds: boolean;
  tick = 0;

  constructor(readonly field: FieldParameters, readonly mapping: DeformationSettings, readonly defs: readonly MoverDef[] = MOVER_DEFS, readonly disturbances: readonly DisturbanceDef[] = DISTURBANCES, private readonly folds: FoldSource | null = null) {
    this.bodies = this.initial();
    this.psi = this.defs.map(() => 0);
    this.influence = new Float64Array(this.defs.length * Math.max(1, this.disturbances.length));
    this.foldActivity = new Float64Array(this.defs.length);
    this.trails = this.defs.map(m => (m.trail ? new TrailBuffer(TRAIL_CAPACITY) : null));
    this.usesFolds = folds !== null && this.defs.some(m => (m.foldCoupling ?? 0) !== 0);
  }

  private initial(): Body[] {
    // Start exactly on the lane with the lane's own velocity, so there is no start-up transient.
    return this.defs.map(m => {
      const g0 = guide(m, 0), g1 = guide(m, MOVER_STEP);
      return { q: g0, v: [(g1[0] - g0[0]) / MOVER_STEP, (g1[1] - g0[1]) / MOVER_STEP, (g1[2] - g0[2]) / MOVER_STEP] as Vec3 };
    });
  }

  reset(): void {
    this.tick = 0; this.bodies = this.initial(); this.psi = this.defs.map(() => 0);
    this.influence.fill(0); this.foldActivity.fill(0); this.foldKey = -1; this.foldAnchors = [];
    for (const tr of this.trails) tr?.clear();
  }

  /** The trail buffer of a mover (its recent mapped positions, oldest overwritten), or null when it has none. */
  trailOf(id: string): TrailBuffer | null { const i = this.defs.findIndex(m => m.id === id); return i < 0 ? null : this.trails[i] ?? null; }

  private foldsAt(tick: number): readonly FoldAnchor[] {
    // The 4 Hz lattice the gas and the hazards use: 15 ticks per lattice step, an exact integer relation.
    const key = Math.floor(tick / 15);
    if (key !== this.foldKey) { this.foldKey = key; this.foldAnchors = this.folds ? this.folds(key * 0.25) : []; }
    return this.foldAnchors;
  }

  private acceleration(m: MoverDef, bi: number, b: Body, t: number): Vec3 {
    const g = guide(m, t);
    const grad = evaluateField(b.q, t, this.field).gradient;
    const a: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) a[i] = -m.stiffness * (b.q[i]! - g[i]!) - m.damping * b.v[i]! - m.fieldCoupling * grad[i]!;
    if (m.drag) { const speed = norm3(b.v); for (let i = 0; i < 3; i += 1) a[i]! -= m.drag * speed * b.v[i]!; }
    const D = this.disturbances.length;
    let activity = 0;
    for (let di = 0; di < D; di += 1) {
      const d = this.disturbances[di]!;
      this.influence[bi * D + di] = 0;
      if (d.affects && !d.affects.includes(m.id)) continue;
      const r: Vec3 = [b.q[0] - d.centre[0], b.q[1] - d.centre[1], b.q[2] - d.centre[2]];
      const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
      const kind = d.kind ?? 'swirl';
      if (kind === 'swirl') {
        const w = Math.exp(-r2 / (2 * d.sigma * d.sigma));
        if (w < 1e-4) continue;
        const mod = 0.5 + 0.5 * Math.sin(d.omega * t + d.phase);
        const swirl = cross(d.precession ? swirlAxis(d, t) : unit(d.axis), r);
        for (let i = 0; i < 3; i += 1) { const f = d.strength * mod * w * swirl[i]! / d.sigma; a[i]! += m.mass === undefined ? f : f / m.mass; }
        this.influence[bi * D + di] = mod * w; activity += mod * w;
      } else if (kind === 'sheet') {
        const n = unit(d.axis), delta = d.thickness ?? 0.2;
        const h = r[0] * n[0] + r[1] * n[1] + r[2] * n[2];
        const par2 = Math.max(0, r2 - h * h);
        const env = Math.exp(-par2 / (2 * d.sigma * d.sigma)) * Math.exp(-(h * h) / (2 * 16 * delta * delta));
        if (env < 1e-4) continue;
        const mod = modulation(d, t), slip = sheetSlip(d);
        const f = d.strength * mod * Math.tanh(h / delta) * env / (m.mass ?? 1);
        for (let i = 0; i < 3; i += 1) a[i]! += f * slip[i]!;
        this.influence[bi * D + di] = mod * env; activity += mod * env;
      } else {
        const w = Math.exp(-r2 / (2 * d.sigma * d.sigma));
        if (w < 1e-4) continue;
        const p = Math.sin(d.omega * t + d.phase);
        const f = -d.strength * p * w / d.sigma / (m.mass ?? 1);
        for (let i = 0; i < 3; i += 1) a[i]! += f * r[i]!;
        this.influence[bi * D + di] = Math.abs(p) * w; activity += Math.abs(p) * w;
      }
    }
    let fold = 0;
    if (this.usesFolds && (m.foldCoupling ?? 0) !== 0) {
      const kappa = m.foldCoupling! / (m.mass ?? 1), rho = FOLD_RANGE;
      for (const f of this.foldsAt(this.tick)) {
        const ax = unit([f.exit[0] - f.entry[0], f.exit[1] - f.entry[1], f.exit[2] - f.entry[2]]);
        // Entry: a funnel that draws the object in. Exit: a jet along entry -> exit that throws it out. Both Gaussian, so bounded.
        for (let side = 0; side < 2; side += 1) {
          const e = side === 0 ? f.entry : f.exit;
          const rx = b.q[0] - e[0], ry = b.q[1] - e[1], rz = b.q[2] - e[2];
          const w = Math.exp(-(rx * rx + ry * ry + rz * rz) / (2 * rho * rho));
          if (w < 1e-4) continue;
          const k = kappa * f.weight * w;
          if (side === 0) { a[0]! -= k * rx / rho; a[1]! -= k * ry / rho; a[2]! -= k * rz / rho; }
          else { a[0]! += k * (ax[0] + 0.4 * rx / rho); a[1]! += k * (ax[1] + 0.4 * ry / rho); a[2]! += k * (ax[2] + 0.4 * rz / rho); }
          fold += f.weight * w;
        }
      }
    }
    this.foldActivity[bi] = fold;
    if (m.spinCoupling) this.psi[bi]! += m.spinCoupling * (activity + fold) * MOVER_STEP;
    return a;
  }

  private step(): void {
    const t = this.tick * MOVER_STEP;
    const record = (this.tick + 1) % TRAIL_STRIDE === 0 && this.tick + 1 >= this.recordFrom;
    this.defs.forEach((m, i) => {
      const b = this.bodies[i]!;
      const a = this.acceleration(m, i, b, t);
      const v: Vec3 = [b.v[0] + a[0] * MOVER_STEP, b.v[1] + a[1] * MOVER_STEP, b.v[2] + a[2] * MOVER_STEP];
      const q: Vec3 = [b.q[0] + v[0] * MOVER_STEP, b.q[1] + v[1] * MOVER_STEP, b.q[2] + v[2] * MOVER_STEP];
      if (!q.every(Number.isFinite) || norm3(v) > 50) throw new RangeError(`Mover ${m.id} integration failed.`);
      this.bodies[i] = { q, v };
      const trail = this.trails[i];
      if (record && trail) { const p = deformPosition(q, (this.tick + 1) * MOVER_STEP, this.field, this.mapping); trail.push(p[0], p[1], p[2]); }
    });
    this.tick += 1;
  }

  /** Advance to the tick containing `time` (a pure function of the tick count). Earlier times replay from the start. */
  syncTo(time: number): void {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Invalid mover time.');
    const target = Math.floor((time + 1e-9) / MOVER_STEP);
    if (target < this.tick) this.reset();
    // Only the last TRAIL_WINDOW_TICKS before the target are ever drawn, so earlier samples are not recorded (the content is the same pure function).
    this.recordFrom = target - TRAIL_WINDOW_TICKS;
    while (this.tick < target) this.step();
  }

  /** Model time of the integrated state (an integer tick). */
  get time(): number { return this.tick * MOVER_STEP; }

  /** Mapped states at the integrated tick; the field is evaluated at that same instant. */
  states(): MoverState[] {
    const t = this.time;
    return this.defs.map((m, i) => ({ id: m.id, position: deformPosition(this.bodies[i]!.q, t, this.field, this.mapping), quaternion: moverQuaternion(m, t, this.psi[i]!), referencePosition: this.bodies[i]!.q }));
  }

  /** Reference-space velocity of a mover (a state of the integrator). Engineering use (tests, tools); not sent to ATLAS. */
  referenceVelocity(id: string): Vec3 | null { const i = this.defs.findIndex(m => m.id === id); return i < 0 ? null : this.bodies[i]!.v; }

  /** Mapped position of the disturbance regions at the integrated tick. Intensity is its current modulation 0..1. */
  disturbanceStates(): DisturbanceState[] {
    const t = this.time;
    return this.disturbances.map(d => ({ id: d.id, label: d.label, position: deformPosition(d.centre, t, this.field, this.mapping), radius: d.sigma * this.mapping.worldScale * 1.6, intensity: disturbanceIntensity(d, t) }));
  }
}

const systems = new WeakMap<SimulationEngine, MoverSystem>();
/** The mover system attached to an engine, advanced to the engine clock. The engine itself is untouched. */
export function moversFor(engine: SimulationEngine): MoverSystem {
  let system = systems.get(engine);
  if (!system) { system = new MoverSystem(engine.field, engine.mapping, moverDefsFor(variantFromUrl()), DISTURBANCES, foldSourceFor(engine)); systems.set(engine, system); }
  system.syncTo(engine.clock.time);
  return system;
}

export function moverDef(id: string): MoverDef | undefined { return MOVER_DEFS.find(m => m.id === id); }

/** A disturbance prepared for evaluation at one instant (axis/normal, slip direction, signed amplitude), so that the force can be evaluated at many
 * points without allocating. Used by the flow-line visuals and tests; `MoverSystem` keeps its own inline evaluation (bit-identical to the original law). */
export interface DisturbanceFrame {
  kind: DisturbanceKind; cx: number; cy: number; cz: number; nx: number; ny: number; nz: number; sx: number; sy: number; sz: number;
  /** swirl/sheet: strength·s(t). well: strength·p(t) (signed). */
  amp: number; sigma: number; delta: number;
}
export const newDisturbanceFrame = (): DisturbanceFrame => ({ kind: 'swirl', cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, sx: 1, sy: 0, sz: 0, amp: 0, sigma: 1, delta: 0.2 });

export function disturbanceFrame(d: DisturbanceDef, t: number, f: DisturbanceFrame = newDisturbanceFrame()): DisturbanceFrame {
  const kind = d.kind ?? 'swirl';
  f.kind = kind; f.cx = d.centre[0]; f.cy = d.centre[1]; f.cz = d.centre[2]; f.sigma = d.sigma; f.delta = d.thickness ?? 0.2;
  if (kind === 'well') { f.amp = d.strength * Math.sin(d.omega * t + d.phase); return f; }
  f.amp = d.strength * modulation(d, t);
  const n = kind === 'swirl' ? (d.precession ? swirlAxis(d, t) : unit(d.axis)) : unit(d.axis);
  f.nx = n[0]; f.ny = n[1]; f.nz = n[2];
  if (kind === 'sheet') { const s = sheetSlip(d); f.sx = s[0]; f.sy = s[1]; f.sz = s[2]; }
  return f;
}

/** Writes the unit-mass acceleration (reference units / s²) of a prepared disturbance at (x, y, z) into out[0..2]. */
export function frameAcceleration(f: DisturbanceFrame, x: number, y: number, z: number, out: Float64Array): void {
  const rx = x - f.cx, ry = y - f.cy, rz = z - f.cz, r2 = rx * rx + ry * ry + rz * rz, s2 = f.sigma * f.sigma;
  if (f.kind === 'swirl') {
    const k = f.amp * Math.exp(-r2 / (2 * s2)) / f.sigma;
    out[0] = k * (f.ny * rz - f.nz * ry); out[1] = k * (f.nz * rx - f.nx * rz); out[2] = k * (f.nx * ry - f.ny * rx);
  } else if (f.kind === 'sheet') {
    const h = rx * f.nx + ry * f.ny + rz * f.nz;
    const env = Math.exp(-Math.max(0, r2 - h * h) / (2 * s2)) * Math.exp(-(h * h) / (2 * 16 * f.delta * f.delta));
    const k = f.amp * Math.tanh(h / f.delta) * env;
    out[0] = k * f.sx; out[1] = k * f.sy; out[2] = k * f.sz;
  } else {
    const k = -f.amp * Math.exp(-r2 / (2 * s2)) / f.sigma;
    out[0] = k * rx; out[1] = k * ry; out[2] = k * rz;
  }
}

/** Acceleration (reference units / s², unit mass) that disturbance `d` imposes at reference point `q` and time `t`. A test checks that this
 * agrees with the force `MoverSystem` applies. */
export function disturbanceAcceleration(d: DisturbanceDef, q: Vec3, t: number): Vec3 {
  const out = new Float64Array(3);
  frameAcceleration(disturbanceFrame(d, t), q[0], q[1], q[2], out);
  return [out[0]!, out[1]!, out[2]!];
}
