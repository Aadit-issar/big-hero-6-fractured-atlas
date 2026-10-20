import { evaluateLeg, legLength } from './clearance';
import type { ClearanceReport, Obstacle } from './clearance';
import { predictMotion } from './motionModel';
import { PLAN_WEIGHTS } from './types';
import type { ChallengeParams, Vec3 } from './types';

/** Time-aware route planner.
 *
 * WHAT IT DOES. Given the observer, a goal and obstacle motion estimates, it builds a deterministic set of candidate waypoints
 * (a lattice around the corridor plus points offset from where each obstacle is PREDICTED to be when the direct path would pass it),
 * then runs a label-setting (Dijkstra-style) search over legs of at most `maxLegs`. A label carries its arrival time, because whether a
 * leg is acceptable depends on WHEN it is flown. Every leg is checked with the exact moving-obstacle clearance test in clearance.ts,
 * between waypoints, not only at them. Ties break on node order, so the result is reproducible.
 *
 * WHAT IT DOES NOT DO. It does not use render geometry, a hidden registry or any future observation: it sees only `Obstacle` estimates
 * (fitted from past observations) and the goal ATLAS has scanned. The route cost is a ranking, not a probability. */

export interface Waypoint { readonly id: string; readonly kind: 'start' | 'candidate' | 'goal'; readonly position: Vec3 }
export interface PlannedLeg {
  readonly from: Waypoint;
  readonly to: Waypoint;
  readonly tStart: number;
  readonly tEnd: number;
  readonly length: number;
  readonly clearance: ClearanceReport;
  readonly cost: number;
}
export interface RoutePlan {
  readonly waypoints: readonly Waypoint[];
  readonly legs: readonly PlannedLeg[];
  readonly length: number;
  readonly duration: number;
  readonly cost: number;
  readonly turnRadians: number;
  /** Smallest modelled margin over the whole route (>= 0 means every leg met the modelled-clearance constraint). */
  readonly minMargin: number;
  readonly supportedSeconds: number;
  readonly unsupportedSeconds: number;
  readonly feasible: boolean;
  readonly worstObstacleId: string | null;
}
export interface PlanResult {
  readonly now: number;
  readonly direct: RoutePlan;
  readonly chosen: RoutePlan | null;
  /** Further distinct feasible routes in cost order (for display of considered alternatives). */
  readonly alternatives: readonly RoutePlan[];
  readonly candidateWaypoints: number;
  readonly legsEvaluated: number;
  readonly legsRejected: number;
  readonly computeMs: number;
  readonly notes: readonly string[];
}
export interface PlanInput {
  readonly now: number;
  readonly start: Vec3;
  readonly goal: Vec3;
  readonly obstacles: readonly Obstacle[];
  readonly params: ChallengeParams;
  readonly maxLegs?: number;
  /** Live use: if the direct leg already meets the clearance constraint outright (envelope included) it is returned without searching. Off for the challenge. */
  readonly fastDirect?: boolean;
  /** Live use: wall-clock budget (ms) for the search; when it runs out the best route found so far (possibly none) is returned with a note. */
  readonly budgetMs?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
const unit = (v: Vec3): Vec3 => { const n = norm(v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const round = (n: number) => Math.round(n * 1000) / 1000;

const RING_ANGLES = 8;
const LATTICE_FRACTIONS = [0.25, 0.5, 0.75] as const;
const LATTICE_OFFSETS = [10, 16, 22] as const;
const OBSTACLE_SLACK = 3;
const TOP_ROUTES = 4;
const LABELS_PER_NODE = 4;

interface Label { readonly node: number; readonly time: number; readonly cost: number; readonly legs: number; readonly parent: Label | null; readonly leg: PlannedLeg | null; readonly heading: Vec3 | null; readonly turn: number }

/** Two directions perpendicular to the corridor, so candidates ring the corridor in 3D. */
function frame(d: Vec3): { e1: Vec3; e2: Vec3 } {
  const ref: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(d, ref));
  return { e1, e2: unit(cross(d, e1)) };
}

export function summarise(waypoints: readonly Waypoint[], legs: readonly PlannedLeg[]): RoutePlan {
  let turn = 0;
  for (let i = 1; i < legs.length; i += 1) {
    const a = unit(sub(legs[i - 1]!.to.position, legs[i - 1]!.from.position)), b = unit(sub(legs[i]!.to.position, legs[i]!.from.position));
    turn += Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  }
  const length = legs.reduce((s, l) => s + l.length, 0);
  const minMargin = legs.reduce((m, l) => Math.min(m, l.clearance.minMargin), Infinity);
  const worst = legs.reduce<PlannedLeg | null>((w, l) => (w === null || l.clearance.minMargin < w.clearance.minMargin ? l : w), null);
  return Object.freeze({
    waypoints: Object.freeze([...waypoints]), legs: Object.freeze([...legs]), length, duration: legs.length ? legs.at(-1)!.tEnd - legs[0]!.tStart : 0,
    cost: legs.reduce((s, l) => s + l.cost, 0) + PLAN_WEIGHTS.turn * turn, turnRadians: turn, minMargin,
    supportedSeconds: legs.reduce((s, l) => s + l.clearance.supportedSeconds, 0), unsupportedSeconds: legs.reduce((s, l) => s + l.clearance.unsupportedSeconds, 0),
    feasible: legs.every(l => l.clearance.feasible), worstObstacleId: worst?.clearance.worst?.id ?? null,
  });
}

export function planRoute(input: PlanInput): PlanResult {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const { now, start, goal, obstacles, params } = input;
  const maxLegs = input.maxLegs ?? 3;
  const speed = params.speed;
  const S: Waypoint = { id: 'start', kind: 'start', position: start };
  const G: Waypoint = { id: 'goal', kind: 'goal', position: goal };
  let legsEvaluated = 0, legsRejected = 0;

  const makeLeg = (from: Waypoint, to: Waypoint, tStart: number): PlannedLeg => {
    legsEvaluated += 1;
    const length = legLength({ from: from.position, to: to.position });
    const clearance = evaluateLeg({ from: from.position, to: to.position, t0: tStart, speed }, obstacles, params);
    const unsupportedLength = clearance.unsupportedSeconds * speed;
    return Object.freeze({ from, to, tStart, tEnd: tStart + length / speed, length, clearance, cost: PLAN_WEIGHTS.distance * length + PLAN_WEIGHTS.unsupported * unsupportedLength + (clearance.envelopeClear ? 0 : PLAN_WEIGHTS.envelopeConflict) });
  };

  const directLeg = makeLeg(S, G, now);
  const direct = summarise([S, G], [directLeg]);
  if (input.fastDirect && directLeg.clearance.feasible && directLeg.clearance.envelopeClear) {
    return Object.freeze({ now, direct, chosen: direct, alternatives: Object.freeze([]), candidateWaypoints: 0, legsEvaluated, legsRejected, computeMs: (typeof performance !== 'undefined' ? performance.now() : 0) - started, notes: Object.freeze([]) });
  }
  const deadline = input.budgetMs !== undefined && typeof performance !== 'undefined' ? started + input.budgetMs : Infinity;
  let overBudget = false;

  // Candidate waypoints: deterministic, ordered, named.
  const d = unit(sub(goal, start));
  const { e1, e2 } = frame(d);
  const ring = Array.from({ length: RING_ANGLES }, (_, k): Vec3 => {
    const a = (k / RING_ANGLES) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    return [e1[0] * c + e2[0] * s, e1[1] * c + e2[1] * s, e1[2] * c + e2[2] * s];
  });
  const candidates: Waypoint[] = [];
  const total = norm(sub(goal, start));
  for (const f of LATTICE_FRACTIONS) for (const r of LATTICE_OFFSETS) ring.forEach((n, k) => candidates.push({ id: `lattice:${Math.round(f * 100)}:${r}:${k}`, kind: 'candidate', position: add(add(start, d, total * f), n, r).map(round) as unknown as Vec3 }));
  // Points offset from where each obstacle is PREDICTED to be when the direct path passes it.
  for (const o of obstacles) {
    const at = directLeg.clearance.perObstacle.find(c => c.id === o.id);
    const tPass = at ? at.timeAtMin : now;
    const p = predictMotion(o.fit, tPass);
    const radius = params.baymaxRadius + o.bound + params.margin + p.uncertainty + OBSTACLE_SLACK;
    ring.forEach((n, k) => candidates.push({ id: `around:${o.id}:${k}`, kind: 'candidate', position: add(p.position, n, radius).map(round) as unknown as Vec3 }));
  }
  const nodes: Waypoint[] = [S, G, ...candidates];

  // Label-setting search. Labels are ordered by (cost, time, node) so ties are reproducible.
  const queue: Label[] = [{ node: 0, time: now, cost: 0, legs: 0, parent: null, leg: null, heading: null, turn: 0 }];
  const kept: Label[][] = nodes.map(() => []);
  kept[0]!.push(queue[0]!);
  const goals: Label[] = [];
  const better = (a: Label, b: Label) => a.cost < b.cost - 1e-9 || (Math.abs(a.cost - b.cost) <= 1e-9 && (a.time < b.time - 1e-9 || (Math.abs(a.time - b.time) <= 1e-9 && a.node < b.node)));
  while (queue.length && goals.length < TOP_ROUTES) {
    if (typeof performance !== 'undefined' && performance.now() > deadline) { overBudget = true; break; }
    let bi = 0;
    for (let i = 1; i < queue.length; i += 1) if (better(queue[i]!, queue[bi]!)) bi = i;
    const label = queue.splice(bi, 1)[0]!;
    if (label.node === 1) { goals.push(label); continue; }
    if (label.legs >= maxLegs) continue;
    for (let j = 1; j < nodes.length; j += 1) {
      if (j === label.node) continue;
      if (typeof performance !== 'undefined' && performance.now() > deadline) { overBudget = true; break; }
      if (label.legs === maxLegs - 1 && j !== 1) continue; // the last allowed leg must reach the goal
      const leg = makeLeg(nodes[label.node]!, nodes[j]!, label.time);
      if (!leg.clearance.feasible) { legsRejected += 1; continue; }
      const heading = unit(sub(leg.to.position, leg.from.position));
      const turn = label.heading ? Math.acos(Math.min(1, Math.max(-1, dot(label.heading, heading)))) : 0;
      const next: Label = { node: j, time: leg.tEnd, cost: label.cost + leg.cost + PLAN_WEIGHTS.turn * turn, legs: label.legs + 1, parent: label, leg, heading, turn: label.turn + turn };
      const existing = kept[j]!;
      if (existing.some(e => e.cost <= next.cost + 1e-9 && e.time <= next.time + 1e-9)) continue;
      existing.push(next);
      existing.sort((a, b) => a.cost - b.cost || a.time - b.time);
      if (existing.length > LABELS_PER_NODE) existing.length = LABELS_PER_NODE;
      queue.push(next);
    }
  }
  const toPlan = (l: Label): RoutePlan => {
    const legs: PlannedLeg[] = [];
    for (let c: Label | null = l; c && c.leg; c = c.parent) legs.unshift(c.leg);
    return summarise([legs[0]!.from, ...legs.map(x => x.to)], legs);
  };
  const plans = goals.map(toPlan);
  const notes: string[] = [];
  if (!plans.length) notes.push(overBudget ? 'No route was found within the planning time budget.' : 'No candidate route met the modelled-clearance constraint within the leg limit.');
  const computeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
  return Object.freeze({
    now, direct, chosen: plans[0] ?? null, alternatives: Object.freeze(plans.slice(1)), candidateWaypoints: candidates.length, legsEvaluated, legsRejected, computeMs, notes: Object.freeze(notes),
  });
}
