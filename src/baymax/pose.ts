import { smoothDamp } from './thrust';
import type { ThrustOutput } from './thrust';

/**
 * Pure articulation targets for the armoured Baymax GLB, driven only by flight state (no randomness, no free-running limb motion).
 * Angles are radians, applied as node rotations about the parent's axes (X: pitch, Z: wing fold).
 *
 * Wing convention (also in assets-src/workflows/baymax_hero/README.md): the GLB is modelled with the wings DEPLOYED (identity
 * rotation). Folded pose (Euler order YZX): wing_R = (x: FOLDX, y: +FOLDY, z: -FOLD), wing_L = (x: FOLDX, y: -FOLDY, z: +FOLD); the blade swings down
 * and lies flat on the back. In boost the wings also sweep back: wing_R.y -= sweep, wing_L.y += sweep.
 */
export const POSE_TUNING = {
  wingFold: 1.5,
  /** Turn of the blade plane about X (both wings) applied before the fold, so the folded blades lie flat beside the spine. */
  wingFoldX: -0.95,
  /** Final swing about Y (R: +, L: -) that lays the folded blade flat on the back, tip down, chord outward. */
  wingFoldY: 1.35,
  wingSweep: 0.2,
  /** Wings start opening above this speed (m/s) and are fully deployed above `deployHi` (boost forces full deployment). */
  deployLo: 2.5,
  deployHi: 9,
  armBack: 0.5,
  forearmBend: 0.35,
  legBack: 0.28,
  kneeBend: 0.4,
  toeDown: 0.32,
  headCounter: 0.6,
  torsoExtra: 0.12,
} as const;

export interface PoseOutput {
  /** 0 folded .. 1 deployed. */
  readonly wing: number;
  readonly sweep: number;
  readonly arm: number;
  readonly leg: number;
  readonly toe: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Wing deployment target from speed and the (smoothed) boost level. */
export function wingTarget(speed: number, boost: number): number {
  const T = POSE_TUNING;
  const t = clamp((speed - T.deployLo) / (T.deployHi - T.deployLo), 0, 1);
  const s = t * t * (3 - 2 * t);
  return Math.max(s, clamp(boost * 1.5, 0, 1));
}

const CH = ['wing', 'sweep', 'arm', 'leg', 'toe'] as const;
type Ch = (typeof CH)[number];

/** Critically damped pose channels; allocation-free per step. */
export class PoseDynamics {
  private readonly v: Record<Ch, number> = { wing: 0, sweep: 0, arm: 0, leg: 0, toe: 0 };
  private readonly d: Record<Ch, number> = { wing: 0, sweep: 0, arm: 0, leg: 0, toe: 0 };
  private readonly out = { wing: 0, sweep: 0, arm: 0, leg: 0, toe: 0 };

  reset(): void {
    for (const c of CH) { this.v[c] = 0; this.d[c] = 0; }
  }

  step(dt: number, speed: number, thrust: ThrustOutput): PoseOutput {
    const dd = clamp(dt, 0, 0.1);
    const sp = clamp(speed / 18, 0, 1);
    const foot = (thrust.sockets['foot-left'] + thrust.sockets['foot-right']) * 0.5;
    const target: Record<Ch, number> = {
      wing: wingTarget(speed, thrust.boost),
      sweep: thrust.boost,
      arm: sp,
      leg: sp,
      toe: clamp((foot - 0.2) / 0.8, 0, 1),
    };
    for (const c of CH) {
      const omega = c === 'wing' ? 4.2 : c === 'sweep' ? 5 : 6;
      const [nv, vv] = smoothDamp(this.v[c], this.d[c], target[c], omega, dd);
      this.v[c] = nv;
      this.d[c] = vv;
    }
    const o = this.out;
    o.wing = clamp(this.v.wing, 0, 1);
    o.sweep = clamp(this.v.sweep, 0, 1);
    o.arm = clamp(this.v.arm, 0, 1);
    o.leg = clamp(this.v.leg, 0, 1);
    o.toe = clamp(this.v.toe, 0, 1);
    return o;
  }
}
