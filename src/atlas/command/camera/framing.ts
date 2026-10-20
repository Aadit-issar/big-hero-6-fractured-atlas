import type { CameraMode } from '../scene/sceneApi';
import { dist3, sphereOf, sphereWithin } from './cameraMath';
import type { Sphere, V3, Weighted } from './cameraMath';
import type { Framing } from './cameraController';

/** Semantic framing: which things a mode cares about, reduced to a bounding sphere. Pure and structural (the scene adapts the session snapshot to
 * `FramingWorld`), so it is unit-tested without React. A frame never uses "all ~100 objects": it uses Baymax, the islands that matter, active folds,
 * mission objects, moving objects, and (per mode) the forecast, the route and the rendezvous. */
export interface FramingEntity {
  readonly id: string;
  readonly kind: 'island' | 'fold' | 'capsule' | 'equipment' | 'debris' | 'wreckage' | 'swarm';
  readonly position: V3;
  readonly radius: number;
  readonly moving: boolean;
  readonly foldActive: boolean;
}
export interface FramingWorld {
  readonly baymax: V3;
  readonly entities: readonly FramingEntity[];
  readonly selectedId: string | null;
  /** Observed trail + forecast samples of the selected target (PREDICTION). */
  readonly forecastPoints: readonly Weighted[];
  /** Route polyline, destination, target now/at arrival, Baymax at arrival (ROUTE). */
  readonly routePoints: readonly Weighted[];
  /** The rendezvous: Baymax and target at the planned time, plus ghosts (INTERCEPTION). */
  readonly rendezvousPoints: readonly Weighted[];
  /** Position of the target now and of Baymax at the rendezvous, for the broadside axis. */
  readonly axisFrom: V3 | null;
  readonly axisTo: V3 | null;
}

export const OVERVIEW_RANGE = 170;
export const OVERVIEW_MAX_RADIUS = 170;
export const OVERVIEW_MIN_RADIUS = 34;

/** Visual enlargement applied to small objects at distance (legibility). Mirrors the scene's `boost`. */
const legible = (r: number) => Math.max(r, 1.6);

export function overviewPoints(w: FramingWorld): Weighted[] {
  const pts: Weighted[] = [{ p: w.baymax, r: 3 }];
  for (const e of w.entities) {
    if (dist3(e.position, w.baymax) > OVERVIEW_RANGE) continue;
    const major = e.kind === 'island' || e.kind === 'capsule' || e.kind === 'equipment' || (e.kind === 'fold' && e.foldActive) || e.moving;
    if (major) pts.push({ p: e.position, r: e.kind === 'island' ? Math.min(e.radius, 14) : legible(e.radius) });
  }
  return pts;
}

export function focusSphere(w: FramingWorld, id: string | null): Sphere | null {
  const e = id ? w.entities.find(x => x.id === id) : null;
  if (!e) return null;
  // An island is framed by its size; small debris by a legible minimum so the camera never goes to extreme zoom.
  const r = e.kind === 'island' ? Math.max(e.radius * 1.25, 8) : e.kind === 'fold' ? 7 : Math.max(e.radius * 3.2, 5);
  return { c: e.position, r };
}

const horizontal = (a: V3 | null, b: V3 | null): readonly [number, number] | null => (a && b ? [b[0] - a[0], b[2] - a[2]] : null);

export function framingFor(mode: CameraMode, w: FramingWorld, focusId: string | null): Framing | null {
  switch (mode) {
    case 'overview': return { sphere: clampOverview(sphereWithin(overviewPoints(w), w.baymax, OVERVIEW_MAX_RADIUS)) };
    case 'focus': {
      const s = focusSphere(w, focusId ?? w.selectedId);
      return s ? { sphere: s } : framingFor('overview', w, null);
    }
    case 'prediction': {
      const s = sphereOf(w.forecastPoints);
      return s ? { sphere: { c: s.c, r: Math.max(s.r, 7) }, axis: horizontal(w.axisFrom, w.axisTo) } : framingFor('focus', w, focusId);
    }
    case 'route': {
      const s = sphereOf([{ p: w.baymax, r: 3 }, ...w.routePoints]);
      return s ? { sphere: { c: s.c, r: Math.max(s.r, 14) }, axis: horizontal(w.baymax, w.axisTo) } : framingFor('focus', w, focusId);
    }
    case 'interception': {
      const s = sphereOf(w.rendezvousPoints);
      return s ? { sphere: { c: s.c, r: Math.max(s.r, 10) }, axis: horizontal(w.axisFrom, w.axisTo) } : framingFor('route', w, focusId);
    }
    default: return null;
  }
}

function clampOverview(s: Sphere | null): Sphere | null { return s ? { c: s.c, r: Math.max(OVERVIEW_MIN_RADIUS, s.r) } : null; }
