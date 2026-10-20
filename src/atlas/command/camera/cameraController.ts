import type { CameraMode } from '../scene/sceneApi';
import { MODE_LAMBDA, MODE_PITCH, broadsideYaw, clamp, damp, dampAngle, frameDistance, orbitPosition } from './cameraMath';
import type { Orbit, Sphere, V3 } from './cameraMath';

/** The camera STATE machine, separate from telemetry and from three.js: an orbit (target, yaw, pitch, distance) that eases toward what the current
 * mode asks for. Modes ask for a target and a distance (follow: Baymax; others: a bounding sphere to frame); the user's orbit angle and zoom are kept
 * as offsets and never fought. Rotation never leaves a tracking mode (it orbits the tracked point); panning does (-> manual). */
export interface Framing { readonly sphere: Sphere | null; /** Horizontal direction of the action; the camera goes broadside to it. */ readonly axis?: readonly [number, number] | null }
export interface FrameQuery { readonly baymax: V3; readonly framing: Framing | null; readonly vfov: number; readonly aspect: number }

export interface Telemetry {
  readonly mode: CameraMode;
  readonly target: V3;
  readonly position: V3;
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly zoom: number;
  readonly followDistance: number;
  readonly lastUserInput: number;
  readonly modeChangedAt: number;
  /** Distance from Baymax to the look-at point, for the follow acceptance check. */
  readonly followError: number;
}

const MIN_DIST = 7, MAX_DIST = 520;

export class CameraController {
  readonly orbit: Orbit;
  private _mode: CameraMode = 'overview';
  private zoom = 1;
  private followDist = 34;
  private goal: { axis: boolean; pitch: number; until: number } | null = null;
  private lastUser = -Infinity;
  private changedAt = 0;
  private listeners = new Set<(m: CameraMode) => void>();
  private lastBaymax: V3 = [0, 0, 0];

  constructor(initial: Partial<Orbit> = {}) {
    this.orbit = { tx: 0, ty: 10, tz: 0, yaw: 0.75, pitch: MODE_PITCH.overview, dist: 120, ...initial };
  }

  get mode(): CameraMode { return this._mode; }
  onMode(l: (m: CameraMode) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  /** Switches mode. `axis` (optional) is the horizontal direction of the action, used to turn the camera broadside to it. Same mode: only re-aims. */
  setMode(mode: CameraMode, now: number, axis: readonly [number, number] | null = null): void {
    const changed = mode !== this._mode;
    if (mode === 'follow' && changed) this.followDist = clamp(this.orbit.dist, 18, 80);
    if (changed) { this.zoom = 1; this.changedAt = now; }
    this._mode = mode;
    if (mode === 'manual') this.goal = null;
    else if (mode !== 'follow') this.goal = { axis: true, pitch: MODE_PITCH[mode], until: now + 2.2 };
    else this.goal = null;
    void axis;
    if (changed) for (const l of this.listeners) l(mode);
  }

  resetZoom(): void { this.zoom = 1; }

  /** Orbit input (radians). Takes effect around whatever the mode tracks. */
  userRotate(dyaw: number, dpitch: number, now: number): void {
    this.orbit.yaw -= dyaw; this.orbit.pitch = clamp(this.orbit.pitch + dpitch, -1.45, 1.45);
    this.goal = null; this.lastUser = now;
  }

  userZoom(factor: number, now: number): void {
    this.lastUser = now;
    if (this._mode === 'follow') this.followDist = clamp(this.followDist * factor, 10, 180);
    else if (this._mode === 'manual') this.orbit.dist = clamp(this.orbit.dist * factor, MIN_DIST, MAX_DIST);
    else this.zoom = clamp(this.zoom * factor, 0.3, 3.2);
  }

  /** Translates the look-at point (world units). Leaves any tracking mode for manual. */
  userPan(dx: number, dy: number, dz: number, now: number): void {
    if (this._mode !== 'manual') { this.followDist = clamp(this.orbit.dist, 18, 80); this._mode = 'manual'; this.goal = null; this.changedAt = now; for (const l of this.listeners) l('manual'); }
    this.orbit.tx += dx; this.orbit.ty += dy; this.orbit.tz += dz; this.lastUser = now;
  }

  /** Teleports the orbit (first frame / tests). */
  snapTo(target: V3, dist: number): void { this.orbit.tx = target[0]; this.orbit.ty = target[1]; this.orbit.tz = target[2]; this.orbit.dist = dist; }

  update(dt: number, now: number, q: FrameQuery): void {
    this.lastBaymax = q.baymax;
    const m = this._mode;
    if (m === 'manual') return;
    const o = this.orbit, lam = MODE_LAMBDA[m];
    let tx = o.tx, ty = o.ty, tz = o.tz, dist = o.dist;
    if (m === 'follow') { tx = q.baymax[0]; ty = q.baymax[1]; tz = q.baymax[2]; dist = this.followDist; }
    else if (q.framing?.sphere) {
      const s = q.framing.sphere;
      tx = s.c[0]; ty = s.c[1]; tz = s.c[2];
      dist = clamp(frameDistance(s.r, q.vfov, q.aspect) * this.zoom, MIN_DIST, MAX_DIST);
    }
    o.tx = damp(o.tx, tx, lam.target, dt); o.ty = damp(o.ty, ty, lam.target, dt); o.tz = damp(o.tz, tz, lam.target, dt);
    o.dist = damp(o.dist, dist, lam.dist, dt);
    if (this.goal && now < this.goal.until) {
      o.pitch = damp(o.pitch, this.goal.pitch, 2.4, dt);
      const ax = q.framing?.axis;
      if (this.goal.axis && ax) o.yaw = dampAngle(o.yaw, broadsideYaw(ax[0], ax[1], o.yaw), 2.0, dt);
    }
  }

  telemetry(): Telemetry {
    const o = this.orbit;
    return {
      mode: this._mode, target: [o.tx, o.ty, o.tz], position: orbitPosition(o), yaw: o.yaw, pitch: o.pitch, distance: o.dist, zoom: this.zoom, followDistance: this.followDist,
      lastUserInput: this.lastUser, modeChangedAt: this.changedAt, followError: Math.hypot(o.tx - this.lastBaymax[0], o.ty - this.lastBaymax[1], o.tz - this.lastBaymax[2]),
    };
  }
  /** Seconds since the user last gave orbit/zoom/pan input. */
  sinceUser(now: number): number { return now - this.lastUser; }
}
