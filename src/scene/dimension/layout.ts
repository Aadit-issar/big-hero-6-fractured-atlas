import type { Vec3 } from '../../simulation/types';

/** Gaseous-dimension layout constants (rendering only). Pure; nothing here is
 * read back by the simulation. */

/** Dominant escape vortex, placed straight behind the opening view's fold so the
 * whole composition is pulled toward it. */
export const VORTEX: Vec3 = [111, 74, -246];
/** Glass mirror floor of the central chamber (below every island's swept path). */
export const MIRROR_Y = -34;

/** Cavern centreline: entrance corridor behind the opening pose, the island
 * chamber, then a funnel collapsing into the vortex. */
export const CAVERN_PATH: readonly Vec3[] = [[-4, 10, 190], [-3, 10, 90], [-2, 9, 34], [0, 2, -40], [20, 12, -120], [64, 40, -192], VORTEX];

/** Elliptical radii along normalised arc length: [u, horizontal, up, down]. */
const PROFILE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 16, 14, 14], [0.2, 21, 17, 17], [0.31, 25, 21, 21], [0.385, 78, 58, 90],
  [0.49, 145, 90, 250], [0.66, 128, 84, 225], [0.85, 82, 64, 66], [0.95, 62, 54, 54], [1, 58, 52, 52],
];

export function cavernRadius(u: number): { horizontal: number; up: number; down: number } {
  const t = Math.min(1, Math.max(0, u));
  for (let i = 1; i < PROFILE.length; i += 1) {
    const a = PROFILE[i - 1]!, b = PROFILE[i]!;
    if (t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0]), s = k * k * (3 - 2 * k);
      return { horizontal: a[1] + (b[1] - a[1]) * s, up: a[2] + (b[2] - a[2]) * s, down: a[3] + (b[3] - a[3]) * s };
    }
  }
  const last = PROFILE[PROFILE.length - 1]!;
  return { horizontal: last[1], up: last[2], down: last[3] };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);


/** Approximate centreline point by piecewise-linear arc length (pure, no Three). */
export function cavernPoint(u: number): Vec3 {
  const lengths = CAVERN_PATH.slice(1).map((p, i) => len(sub(p, CAVERN_PATH[i]!)));
  const total = lengths.reduce((a, b) => a + b, 0);
  let target = Math.min(1, Math.max(0, u)) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (target <= lengths[i]! || i === lengths.length - 1) return addv(CAVERN_PATH[i]!, scl(sub(CAVERN_PATH[i + 1]!, CAVERN_PATH[i]!), Math.min(1, target / lengths[i]!)));
    target -= lengths[i]!;
  }
  return VORTEX;
}
