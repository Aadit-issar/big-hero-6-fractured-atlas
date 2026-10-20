import type { AtlasView, CameraMode } from '../scene/sceneApi';

/** Pure camera mathematics (no three.js, no DOM): damping, bounds, framing distance, orbit placement and mode resolution.
 * Everything here is deterministic and unit-tested (tests/atlasSceneCamera.test.ts). */
export type V3 = readonly [number, number, number];
export interface Sphere { readonly c: V3; readonly r: number }
export interface Weighted { readonly p: V3; readonly r: number }

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Frame-rate independent exponential smoothing factor: applying it N times at dt/N equals once at dt. */
export function dampFactor(lambda: number, dt: number): number { return 1 - Math.exp(-Math.max(0, lambda) * Math.max(0, dt)); }
export function damp(current: number, target: number, lambda: number, dt: number): number { return current + (target - current) * dampFactor(lambda, dt); }
export function wrapAngle(a: number): number { let x = a; while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; }
export function dampAngle(current: number, target: number, lambda: number, dt: number): number { return current + wrapAngle(target - current) * dampFactor(lambda, dt); }

export const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A sphere enclosing every point (with its own radius): centre of the axis-aligned box, radius to the farthest extent. Never smaller than any input. */
export function sphereOf(points: readonly Weighted[]): Sphere | null {
  if (points.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const { p, r } of points) {
    x0 = Math.min(x0, p[0] - r); x1 = Math.max(x1, p[0] + r);
    y0 = Math.min(y0, p[1] - r); y1 = Math.max(y1, p[1] + r);
    z0 = Math.min(z0, p[2] - r); z1 = Math.max(z1, p[2] + r);
  }
  const c: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  let radius = 0;
  for (const { p, r } of points) radius = Math.max(radius, dist3(c, p) + r);
  return { c, r: radius };
}

/** Drops the farthest-from-`anchor` points until the enclosing sphere is no larger than `maxRadius` (the anchor's own entry is never dropped).
 * This keeps a distant outlier from pushing the camera out to an extreme distance. */
export function sphereWithin(points: readonly Weighted[], anchor: V3, maxRadius: number): Sphere | null {
  const sorted = [...points].sort((a, b) => dist3(a.p, anchor) - dist3(b.p, anchor));
  let n = sorted.length;
  let s = sphereOf(sorted);
  while (s && s.r > maxRadius && n > 1) { n -= 1; s = sphereOf(sorted.slice(0, n)); }
  return s;
}

/** Distance from the sphere's centre at which the whole sphere fits the smaller of the vertical/horizontal field of view. */
export function frameDistance(radius: number, vfov: number, aspect: number, margin = 1.18): number {
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const half = Math.min(vfov, hfov) / 2;
  return (radius * margin) / Math.sin(half);
}

export interface Orbit { tx: number; ty: number; tz: number; yaw: number; pitch: number; dist: number }
export function orbitPosition(o: Orbit): V3 {
  const cp = Math.cos(o.pitch);
  return [o.tx + o.dist * cp * Math.sin(o.yaw), o.ty + o.dist * Math.sin(o.pitch), o.tz + o.dist * cp * Math.cos(o.yaw)];
}

/** Yaw that puts the camera broadside to the horizontal direction (dx, dz), choosing the side nearest `current` so the move is short. */
export function broadsideYaw(dx: number, dz: number, current: number): number {
  if (Math.hypot(dx, dz) < 1e-3) return current;
  const a = Math.atan2(dx, dz) + Math.PI / 2;
  const b = a + Math.PI;
  return Math.abs(wrapAngle(a - current)) <= Math.abs(wrapAngle(b - current)) ? a : b;
}

/** Pushes `p` out of every sphere (a little beyond its surface) so the camera never sits inside rock. Continuous in `p`. */
export function pushOut(p: [number, number, number], spheres: readonly Sphere[], pad = 1.5): void {
  for (const s of spheres) {
    const dx = p[0] - s.c[0], dy = p[1] - s.c[1], dz = p[2] - s.c[2];
    const d = Math.hypot(dx, dy, dz), want = s.r + pad;
    if (d < want) {
      const k = d < 1e-6 ? 0 : want / d;
      if (k === 0) p[1] += want; else { p[0] = s.c[0] + dx * k; p[1] = s.c[1] + dy * k; p[2] = s.c[2] + dz * k; }
    }
  }
}

/** The mode a view and selection imply. `route`/`prediction` need their data; without it the best available framing is used. */
export function resolveAutoMode(view: AtlasView, selectedId: string | null, has: { forecast: boolean; encounter: boolean }): CameraMode {
  if (view === 'predict') return has.forecast ? 'prediction' : selectedId ? 'focus' : 'overview';
  if (view === 'route') return has.encounter ? 'route' : selectedId ? 'focus' : 'overview';
  return selectedId ? 'focus' : 'overview';
}

/** Default pitch (elevation, radians) per mode: three-quarter overview, flatter for close inspection. */
export const MODE_PITCH: Readonly<Record<CameraMode, number>> = { overview: 0.62, follow: 0.42, focus: 0.45, prediction: 0.5, route: 0.55, interception: 0.42, manual: 0.5 };
/** Damping rates (1/s) for the look-at target and the distance, per mode. Follow is stiff so Baymax never drifts out of frame. */
export const MODE_LAMBDA: Readonly<Record<CameraMode, { target: number; dist: number }>> = {
  overview: { target: 2.6, dist: 2.2 }, follow: { target: 7, dist: 3.5 }, focus: { target: 4, dist: 3 }, prediction: { target: 3.2, dist: 2.6 },
  route: { target: 3.2, dist: 2.6 }, interception: { target: 3.5, dist: 2.8 }, manual: { target: 0, dist: 0 },
};
