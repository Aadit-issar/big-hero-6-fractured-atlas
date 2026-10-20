import type { AtlasObservation, WorldVec3 } from '../../shared/atlasContract';
import type { SceneCategory, SceneFamily, SceneObjectObservation, SceneScan } from '../live/protocol';
import { realTrajectory, TRAJECTORY_DT } from './fixtures';
import type { ChallengeParams, Vec3 } from './types';

/** The simulated world of the controlled challenge: the only module (with the evaluator) that holds truth.
 *
 * Truth = real Dimension island trajectories (pinned fixture), rigidly translated into the scenario frame, plus static wreckage.
 * ATLAS never receives truth. It receives what a sensor would deliver: positions of islands inside the sensor range at the current
 * 4 Hz tick, with seeded measurement noise, through the ordinary AtlasObservation contract, and wreckage through an ordinary
 * proximity scan. Noise is a pure function of (seed, entity, tick, axis), so it is identical whatever order or direction time is visited. */

export interface ObstacleSpec {
  readonly id: string;
  readonly label: string;
  /** Which real island's trajectory drives this obstacle, from which real time, shifted by which rigid translation. */
  readonly source: { readonly island: string; readonly realStartSeconds: number; readonly offset: Vec3; /** Rigid rotation about the vertical axis through the starting position (default 0). Motion is unchanged in speed and shape. */ readonly rotateY?: number };
}
export interface SceneItem { readonly id: string; readonly category: SceneCategory; readonly family: SceneFamily; readonly kind: string; readonly position: Vec3; readonly radius: number }
export interface ScenarioSpec {
  readonly id: string;
  readonly title: string;
  readonly seed: number;
  readonly durationSeconds: number;
  readonly tickHz: number;
  readonly sensorRange: number;
  readonly scanRange: number;
  readonly noiseSigma: number;
  readonly start: Vec3;
  readonly goal: Vec3;
  readonly goalId: string;
  /** Baymax hovers and observes until this time before ATLAS may commit a route. */
  readonly observeSeconds: number;
  readonly params: ChallengeParams;
  readonly obstacles: readonly ObstacleSpec[];
  readonly scene: readonly SceneItem[];
}

/** Deterministic hash -> uniform (0,1). */
function unitHash(...parts: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) { h ^= Math.floor(p * 1000) | 0; h = Math.imul(h, 0x01000193); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; }
  h = Math.imul(h ^ (h >>> 16), 0x297a2d39);
  return (((h ^ (h >>> 15)) >>> 0) + 0.5) / 4294967296;
}
const idNumber = (id: string): number => { let h = 7; for (let i = 0; i < id.length; i += 1) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0; return h; };
export function gaussian(seed: number, id: string, tick: number, axis: number): number {
  const a = unitHash(seed, idNumber(id), tick, axis, 1), b = unitHash(seed, idNumber(id), tick, axis, 2);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!] as unknown as Vec3;
const hypot3 = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);

/** Cubic Hermite (Catmull-Rom tangents) through the pinned samples. */
export function interpolate(samples: readonly Vec3[], index: number): Vec3 {
  const last = samples.length - 1;
  const i = Math.min(last - 1, Math.max(0, Math.floor(index)));
  const f = Math.min(1, Math.max(0, index - i));
  const p0 = samples[Math.max(0, i - 1)]!, p1 = samples[i]!, p2 = samples[i + 1]!, p3 = samples[Math.min(last, i + 2)]!;
  const f2 = f * f, f3 = f2 * f;
  return [0, 1, 2].map(a => {
    const m1 = (p2[a]! - p0[a]!) / (i === 0 ? 1 : 2), m2 = (p3[a]! - p1[a]!) / (i + 1 === last ? 1 : 2);
    return (2 * f3 - 3 * f2 + 1) * p1[a]! + (f3 - 2 * f2 + f) * m1 + (-2 * f3 + 3 * f2) * p2[a]! + (f3 - f2) * m2;
  }) as unknown as Vec3;
}

export class ChallengeWorld {
  private readonly tracks = new Map<string, { samples: readonly Vec3[]; startIndex: number; offset: Vec3; rotateY: number; pivot: Vec3 }>();
  /** Largest scenario time at which truth was read through the sensor path. Used by the causality audit. */
  maxSensedSeconds = -Infinity;
  constructor(readonly spec: ScenarioSpec) {
    for (const o of spec.obstacles) {
      const t = realTrajectory(o.source.island);
      this.tracks.set(o.id, { samples: t.samples, startIndex: o.source.realStartSeconds / TRAJECTORY_DT, offset: o.source.offset, rotateY: o.source.rotateY ?? 0, pivot: interpolate(t.samples, o.source.realStartSeconds / TRAJECTORY_DT) });
      if (o.source.realStartSeconds + spec.durationSeconds > (t.samples.length - 1) * TRAJECTORY_DT) throw new RangeError(`${o.id}: fixture too short`);
    }
  }

  /** Noise-free truth in the scenario frame. For the offline evaluator and the sensor only. */
  truthAt(id: string, seconds: number): Vec3 {
    const tr = this.tracks.get(id);
    if (!tr) throw new RangeError(`Unknown obstacle ${id}`);
    const p = interpolate(tr.samples, tr.startIndex + seconds / TRAJECTORY_DT);
    const c = Math.cos(tr.rotateY), sn = Math.sin(tr.rotateY), dx = p[0] - tr.pivot[0], dz = p[2] - tr.pivot[2];
    return [tr.pivot[0] + dx * c + dz * sn + tr.offset[0], p[1] + tr.offset[1], tr.pivot[2] - dx * sn + dz * c + tr.offset[2]];
  }
  get obstacleIds(): readonly string[] { return this.spec.obstacles.map(o => o.id); }

  /** What the sensor delivers at tick `tick` from `observer`. */
  observe(tick: number, observer: Vec3): AtlasObservation {
    const time = tick / this.spec.tickHz;
    this.maxSensedSeconds = Math.max(this.maxSensedSeconds, time);
    const islands = this.spec.obstacles.flatMap(o => {
      const t = this.truthAt(o.id, time);
      const position: WorldVec3 = [0, 1, 2].map(a => +(t[a]! + this.spec.noiseSigma * gaussian(this.spec.seed, o.id, tick, a)).toFixed(3)) as unknown as WorldVec3;
      const range = hypot3(sub(position, observer));
      return range <= this.spec.sensorRange ? [{ id: o.id, worldPosition: position, range }] : [];
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { contractVersion: 1, time, observerWorldPosition: [...observer] as unknown as WorldVec3, sensorRange: this.spec.sensorRange, local: { gravity: [0.8, -0.32, 0.24], hazard: 0.22 }, islands, connections: [] };
  }

  /** Proximity scan of the static wreckage: the same acquisition rule as the live scanner (2 Hz, sphere around the observer). */
  scan(tick: number, observer: Vec3): SceneScan | null {
    if (tick % 2 !== 0) return null;
    const objects: SceneObjectObservation[] = this.spec.scene
      .map(w => ({ id: w.id, category: w.category, family: w.family, kind: w.kind, position: w.position, radius: w.radius, range: hypot3(sub(w.position, observer)) }))
      .filter(w => w.range <= this.spec.scanRange).sort((a, b) => a.range - b.range);
    return { scanId: tick / 2 + 1, time: tick / this.spec.tickHz, observerPosition: observer, range: this.spec.scanRange, coverage: 'proximity-sphere', trigger: 'continuous', objects, omitted: 0 };
  }
}
