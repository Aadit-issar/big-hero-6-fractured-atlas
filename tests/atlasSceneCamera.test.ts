import { describe, expect, it } from 'vitest';
import { broadsideYaw, damp, dampFactor, frameDistance, orbitPosition, pushOut, resolveAutoMode, sphereOf, sphereWithin } from '../src/atlas/command/camera/cameraMath';
import type { V3 } from '../src/atlas/command/camera/cameraMath';
import { CameraController } from '../src/atlas/command/camera/cameraController';
import type { Framing } from '../src/atlas/command/camera/cameraController';
import { framingFor, OVERVIEW_MAX_RADIUS, OVERVIEW_MIN_RADIUS } from '../src/atlas/command/camera/framing';
import type { FramingEntity, FramingWorld } from '../src/atlas/command/camera/framing';

const VFOV = (50 * Math.PI) / 180, ASPECT = 16 / 9;

describe('camera maths', () => {
  it('damping is frame-rate independent', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 60; i += 1) a = damp(a, 10, 4, 1 / 60);
    for (let i = 0; i < 15; i += 1) b = damp(b, 10, 4, 1 / 15);
    expect(a).toBeCloseTo(b, 6);
    expect(dampFactor(5, 0)).toBe(0);
    expect(dampFactor(5, 100)).toBeCloseTo(1, 6);
  });
  it('the enclosing sphere contains every input', () => {
    const pts = [{ p: [0, 0, 0] as V3, r: 2 }, { p: [40, 10, -5] as V3, r: 6 }, { p: [-12, -8, 30] as V3, r: 1 }];
    const s = sphereOf(pts)!;
    for (const { p, r } of pts) expect(Math.hypot(p[0] - s.c[0], p[1] - s.c[1], p[2] - s.c[2]) + r).toBeLessThanOrEqual(s.r + 1e-9);
    expect(sphereOf([])).toBeNull();
  });
  it('outliers are dropped before the sphere exceeds the cap (no extreme zoom)', () => {
    const pts = [{ p: [0, 0, 0] as V3, r: 3 }, { p: [30, 0, 0] as V3, r: 3 }, { p: [900, 0, 0] as V3, r: 3 }];
    const s = sphereWithin(pts, [0, 0, 0], 100)!;
    expect(s.r).toBeLessThanOrEqual(100);
    expect(sphereWithin(pts.slice(0, 1), [0, 0, 0], 1)!.r).toBe(3);
  });
  it('the framing distance fits the sphere in both axes', () => {
    for (const aspect of [0.8, 1.2, ASPECT]) {
      const r = 50, d = frameDistance(r, VFOV, aspect, 1);
      const hfov = 2 * Math.atan(Math.tan(VFOV / 2) * aspect);
      expect(Math.asin(r / d)).toBeLessThanOrEqual(Math.min(VFOV, hfov) / 2 + 1e-9);
    }
  });
  it('orbit placement keeps the requested distance and elevation', () => {
    const p = orbitPosition({ tx: 1, ty: 2, tz: 3, yaw: 0.7, pitch: 0.5, dist: 40 });
    expect(Math.hypot(p[0] - 1, p[1] - 2, p[2] - 3)).toBeCloseTo(40, 6);
    expect(p[1]).toBeGreaterThan(2);
  });
  it('broadside yaw is perpendicular to the action', () => {
    const y = broadsideYaw(1, 0, 0);
    expect(Math.sin(y) * 1 + Math.cos(y) * 0).toBeCloseTo(0, 6);
    expect(broadsideYaw(0, 0, 1.23)).toBe(1.23);
  });
  it('the camera is pushed out of rock', () => {
    const p: [number, number, number] = [1, 0, 0];
    pushOut(p, [{ c: [0, 0, 0], r: 10 }], 2);
    expect(Math.hypot(...p)).toBeCloseTo(12, 6);
  });
  it('views and selection resolve to the right mode', () => {
    const none = { forecast: false, encounter: false }, all = { forecast: true, encounter: true };
    expect(resolveAutoMode('tactical', null, none)).toBe('overview');
    expect(resolveAutoMode('tactical', 'a', none)).toBe('focus');
    expect(resolveAutoMode('predict', 'a', all)).toBe('prediction');
    expect(resolveAutoMode('predict', 'a', none)).toBe('focus');
    expect(resolveAutoMode('route', 'a', all)).toBe('route');
    expect(resolveAutoMode('route', null, none)).toBe('overview');
  });
});

const ent = (id: string, kind: FramingEntity['kind'], p: V3, radius = 1, moving = false, foldActive = false): FramingEntity => ({ id, kind, position: p, radius, moving, foldActive });
function world(over: Partial<FramingWorld> = {}): FramingWorld {
  const entities: FramingEntity[] = [ent('island-1', 'island', [30, 5, 10], 12), ent('island-9', 'island', [2000, 0, 0], 12), ent('capsule', 'capsule', [-20, 0, 15], 2, true), ent('f1', 'fold', [10, 20, 40], 2, false, true), ent('f2', 'fold', [10, 22, 41], 2, false, false)];
  for (let i = 0; i < 90; i += 1) entities.push(ent(`rubble-${i}`, 'wreckage', [(i % 10) * 12 - 60, 0, Math.floor(i / 10) * 12 - 60], 1));
  return { baymax: [0, 0, 0], entities, selectedId: null, forecastPoints: [], routePoints: [], rendezvousPoints: [], axisFrom: null, axisTo: null, ...over };
}

describe('semantic framing', () => {
  it('overview ignores rubble, far islands and inactive folds and stays within bounds', () => {
    const f = framingFor('overview', world(), null)!;
    expect(f.sphere!.r).toBeGreaterThanOrEqual(OVERVIEW_MIN_RADIUS);
    expect(f.sphere!.r).toBeLessThanOrEqual(OVERVIEW_MAX_RADIUS);
    expect(Math.hypot(...f.sphere!.c)).toBeLessThan(60);
  });
  it('focus frames small debris closer than an island', () => {
    const w = world();
    const small = framingFor('focus', w, 'rubble-3')!.sphere!.r, island = framingFor('focus', w, 'island-1')!.sphere!.r;
    expect(small).toBeLessThan(island);
    expect(small).toBeGreaterThanOrEqual(5);
  });
  it('prediction, route and interception frame their own points and fall back sensibly', () => {
    const w = world({ selectedId: 'capsule', forecastPoints: [{ p: [-20, 0, 15], r: 1 }, { p: [10, 5, 50], r: 3 }], routePoints: [{ p: [40, 0, 0], r: 3 }], rendezvousPoints: [{ p: [40, 0, 0], r: 3 }, { p: [42, 1, 2], r: 3 }], axisFrom: [-20, 0, 15], axisTo: [10, 5, 50] });
    expect(framingFor('prediction', w, 'capsule')!.axis).toEqual([30, 35]);
    expect(framingFor('route', w, null)!.sphere!.r).toBeGreaterThanOrEqual(14);
    expect(framingFor('interception', w, null)!.sphere!.r).toBeGreaterThanOrEqual(10);
    expect(framingFor('prediction', world({ selectedId: 'capsule' }), 'capsule')!.sphere!.c).toEqual([-20, 0, 15]);
  });
});

function run(c: CameraController, seconds: number, dt: number, baymaxAt: (t: number) => V3, framing: Framing | null, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) { t += dt; c.update(dt, t, { baymax: baymaxAt(t), framing, vfov: VFOV, aspect: ASPECT }); }
  return t;
}

describe('camera controller', () => {
  it('follow tracks continuous Baymax flight with bounded lag, no snaps and a preserved orbit angle', () => {
    const c = new CameraController({ tx: 0, ty: 0, tz: 0 });
    c.setMode('follow', 0);
    c.userRotate(0.4, 0.1, 0);
    const yaw0 = c.orbit.yaw, pitch0 = c.orbit.pitch;
    const speed = 14;
    const path = (t: number): V3 => [speed * t, 3 * Math.sin(t), 0.5 * speed * t * Math.sin(0.3 * t) * 0.1];
    let last: V3 = [c.orbit.tx, c.orbit.ty, c.orbit.tz], maxStep = 0, maxErr = 0, t = 0;
    for (let i = 0; i < 600; i += 1) {
      t += 1 / 60; c.update(1 / 60, t, { baymax: path(t), framing: null, vfov: VFOV, aspect: ASPECT });
      const now: V3 = [c.orbit.tx, c.orbit.ty, c.orbit.tz];
      maxStep = Math.max(maxStep, Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2])); last = now;
      if (t > 2) maxErr = Math.max(maxErr, c.telemetry().followError);
    }
    expect(maxStep).toBeLessThan((speed * 2) / 60 + 0.5);
    expect(maxErr).toBeLessThan(speed / 7 + 1.5);
    expect(c.orbit.yaw).toBeCloseTo(yaw0, 9);
    expect(c.orbit.pitch).toBeCloseTo(pitch0, 9);
    expect(c.telemetry().mode).toBe('follow');
    const p = c.telemetry().position, b = path(t);
    expect(Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2])).toBeLessThan(c.telemetry().followDistance * 1.2);
  });

  it('every tracking mode keeps moving while its subject moves (no motionless camera)', () => {
    for (const mode of ['follow', 'overview', 'focus', 'prediction', 'route', 'interception'] as const) {
      const c = new CameraController();
      c.setMode(mode, 0);
      const moving = (t: number): V3 => [10 * t, 0, 0];
      let t = 0; const start = c.telemetry().target;
      for (let i = 0; i < 180; i += 1) { t += 1 / 60; c.update(1 / 60, t, { baymax: moving(t), framing: { sphere: { c: moving(t), r: 20 } }, vfov: VFOV, aspect: ASPECT }); }
      const end = c.telemetry().target;
      expect(Math.abs(end[0] - start[0]), mode).toBeGreaterThan(5);
    }
  });

  it('repeated mode switching never produces a jump larger than the damped step', () => {
    const c = new CameraController({ tx: 0, ty: 0, tz: 0, dist: 100 });
    const modes = ['overview', 'follow', 'focus', 'prediction', 'route', 'interception', 'follow', 'overview'] as const;
    const spheres = [{ c: [0, 0, 0] as V3, r: 60 }, { c: [80, 10, 20] as V3, r: 8 }, { c: [-50, 30, 40] as V3, r: 25 }];
    let t = 0, maxPos = 0;
    let prev = c.telemetry().position;
    for (let k = 0; k < 24; k += 1) {
      c.setMode(modes[k % modes.length]!, t, [1, 0.3]);
      const fr: Framing = { sphere: spheres[k % spheres.length]!, axis: [1, 0.3] };
      for (let i = 0; i < 20; i += 1) {
        t += 1 / 60; c.update(1 / 60, t, { baymax: [5 * t, 0, 0], framing: fr, vfov: VFOV, aspect: ASPECT });
        const p = c.telemetry().position;
        maxPos = Math.max(maxPos, Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])); prev = p;
      }
    }
    expect(maxPos).toBeLessThan(8);
    expect(Number.isFinite(c.telemetry().distance)).toBe(true);
  });

  it('manual panning takes control without fighting, and follow can resume', () => {
    const c = new CameraController();
    c.setMode('follow', 0);
    const events: string[] = []; c.onMode(m => events.push(m));
    c.userPan(5, 0, 0, 1);
    expect(c.mode).toBe('manual');
    const before = c.telemetry().target;
    run(c, 2, 1 / 30, t => [100 * t, 0, 0], null, 1);
    expect(c.telemetry().target).toEqual(before);
    c.setMode('follow', 4);
    run(c, 3, 1 / 30, () => [50, 0, 0], null, 4);
    expect(c.telemetry().followError).toBeLessThan(0.5);
    expect(events).toEqual(['manual', 'follow']);
  });

  it('rotation in a framing mode orbits without leaving the mode; zoom scales the framing', () => {
    const c = new CameraController();
    c.setMode('focus', 0);
    const fr: Framing = { sphere: { c: [10, 0, 10], r: 10 } };
    const t = run(c, 4, 1 / 60, () => [0, 0, 0], fr);
    const d0 = c.orbit.dist;
    c.userRotate(0.5, 0, t); c.userZoom(0.5, t);
    run(c, 4, 1 / 60, () => [0, 0, 0], fr, t);
    expect(c.mode).toBe('focus');
    expect(c.orbit.dist).toBeLessThan(d0 * 0.6);
    expect(c.orbit.tx).toBeCloseTo(10, 2);
  });
});
