import { realTrajectory, TRAJECTORY_DT } from './fixtures';
import { CHALLENGE_PARAMS } from './types';
import type { ChallengeParams, Vec3 } from './types';
import type { ObstacleSpec, SceneItem, ScenarioSpec } from './world';
import { interpolate } from './world';

/** World-side authoring of a challenge geometry from real island trajectories. Used to pin the showcase and to generate the held-out placements.
 * The construction is declared, not hidden: the corridor is laid so that the primary obstacle, travelling at its real speed, crosses it
 * `crossingSeconds` after Baymax sets off, having been at least the static clearance away when Baymax set off. */

export interface PlacementParams {
  readonly id: string;
  readonly seed: number;
  readonly primary: { readonly island: string; readonly realStartSeconds: number; readonly lateralTruth: number };
  /** Secondary obstacle: placed relative to the goal, driven by another real island. */
  readonly secondary: { readonly island: string; readonly realStartSeconds: number; readonly offsetFromGoal: Vec3; readonly rotateY?: number } | null;
  readonly crossingLength: number;
  readonly beyondLength: number;
  readonly params?: Partial<ChallengeParams>;
  readonly observeSeconds?: number;
  readonly durationSeconds?: number;
  /** Which side of the primary's travel the corridor approaches from (+1 or -1). */
  readonly approachSign?: 1 | -1;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const unit = (v: Vec3): Vec3 => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function wreckage(goal: Vec3): SceneItem[] {
  const at = (dx: number, dy: number, dz: number): Vec3 => [goal[0] + dx, goal[1] + dy, goal[2] + dz];
  return [
    { id: 'sim-capsule-1', category: 'landmark', family: 'capsule', kind: 'capsule_shell_remnant', position: goal, radius: 2.6 },
    { id: 'sim-capsule-2', category: 'panel', family: 'capsule', kind: 'capsule_heatshield_panel', position: at(-3.4, -1.2, 2.6), radius: 1.4 },
    { id: 'sim-industrial-1', category: 'steel', family: 'industrial', kind: 'industrial_ibeam_twisted', position: at(3.8, -0.8, 2.4), radius: 2.2 },
    { id: 'sim-industrial-2', category: 'pipe', family: 'industrial', kind: 'industrial_pipe_large_fractured', position: at(-2.2, 1.1, -3.6), radius: 1.6 },
    { id: 'sim-industrial-3', category: 'steel', family: 'industrial', kind: 'industrial_column_bent', position: at(5.2, 0.6, -2.4), radius: 1.8 },
    { id: 'sim-concrete-1', category: 'concrete', family: 'concrete', kind: 'concrete_slab_rebar', position: at(1.4, -1.8, -4.4), radius: 2.0 },
  ];
}

export function buildPlacement(p: PlacementParams): ScenarioSpec {
  const params: ChallengeParams = { ...CHALLENGE_PARAMS, ...p.params };
  const observeSeconds = p.observeSeconds ?? 10;
  const track = realTrajectory(p.primary.island);
  const truthA = (tau: number): Vec3 => interpolate(track.samples, (p.primary.realStartSeconds + tau) / TRAJECTORY_DT);
  const tCross = observeSeconds + p.crossingLength / params.speed;
  // Mean velocity of the primary over the approach; the corridor is laid perpendicular to it (horizontal-ish), so drift is a lateral closing speed.
  const v = unit(sub(truthA(tCross), truthA(observeSeconds)));
  const d = unit(cross(v, [0, 1, 0]));
  const dir: Vec3 = (p.approachSign ?? 1) === 1 ? d : [-d[0], -d[1], -d[2]];
  const lateralAxis = unit(cross(dir, [0, 1, 0]));
  // Crossing point: where the primary will be, shifted by the requested truth lateral offset (so the direct line passes that close to its centre).
  const crossing = add(truthA(tCross), lateralAxis, p.primary.lateralTruth);
  const start = add(crossing, dir, -p.crossingLength).map(x => +x.toFixed(2)) as unknown as Vec3;
  const goal = add(crossing, dir, p.beyondLength).map(x => +x.toFixed(2)) as unknown as Vec3;
  // The primary keeps its real trajectory: the rigid translation is the identity (positions are the real ones shifted so the corridor sits at the origin region).
  const shift: Vec3 = sub([0, 0, 0], start);
  const moved = (q: Vec3): Vec3 => add(q, shift);
  const obstacles: ObstacleSpec[] = [{ id: p.primary.island, label: 'Island A', source: { island: p.primary.island, realStartSeconds: p.primary.realStartSeconds, offset: shift.map(x => +x.toFixed(2)) as unknown as Vec3 } }];
  if (p.secondary) {
    const offset = sub(add(moved(goal), p.secondary.offsetFromGoal), interpolate(realTrajectory(p.secondary.island).samples, p.secondary.realStartSeconds / TRAJECTORY_DT));
    obstacles.push({ id: p.secondary.island, label: 'Island B', source: { island: p.secondary.island, realStartSeconds: p.secondary.realStartSeconds, offset: offset.map(x => +x.toFixed(2)) as unknown as Vec3, rotateY: p.secondary.rotateY ?? 0 } });
  }
  return {
    id: p.id, title: 'Moving Corridor', seed: p.seed, durationSeconds: p.durationSeconds ?? 42, tickHz: 4, sensorRange: 60, scanRange: 60, noiseSigma: 0.1,
    start: moved(start), goal: moved(goal), goalId: 'sim-capsule-1', observeSeconds, params, obstacles, scene: wreckage(moved(goal)),
  };
}
