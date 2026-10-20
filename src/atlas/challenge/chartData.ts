import type { PlanDecision } from './atlasAgent';
import type { DirectorContext } from './director';
import { predictMotion } from './motionModel';
import type { Vec3 } from './types';

/** Data for the two instrument charts of the film. Everything is computed from the recorded run: the samples that had been delivered, the model as it was
 * fitted at the moment the forecast was issued (frozen), and the routes with the clearance the planner computed. */

export interface TP { readonly t: number; readonly v: number }
export interface ModelChart {
  readonly t0: number; readonly t1: number;
  readonly samples: readonly TP[];
  readonly issue: number; readonly target: number;
  readonly fitPast: readonly TP[]; readonly fitFuture: readonly TP[];
  readonly band: readonly { readonly t: number; readonly lo: number; readonly hi: number }[];
  readonly estimate: { readonly t: number; readonly v: number; readonly allowance: number };
  readonly persistence: { readonly t: number; readonly v: number };
  readonly measured: { readonly t: number; readonly v: number; readonly modelError: number; readonly persistenceError: number } | null;
  readonly unit: string;
}
export interface ClearanceChart {
  readonly t0: number; readonly t1: number;
  readonly direct: readonly TP[];
  readonly chosen: readonly TP[];
  readonly required: readonly TP[];
  /** Presentation of the model's trust horizon: beyond it the requirement widens as a soft envelope. */
  readonly horizonEnd: number;
  readonly conflict: { readonly t: number; readonly distance: number; readonly required: number } | null;
  readonly chosenMin: { readonly t: number; readonly distance: number; readonly required: number } | null;
  readonly obstacle: string;
  readonly decisionTime: number;
  /** What the first curve is: the direct route, the route that was just replaced, or a counterfactual in the ground-truth chart. */
  readonly firstLabel?: string;
  readonly secondLabel?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly requiredLabel?: string;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

function along(points: readonly Vec3[], distance: number): Vec3 {
  let left = Math.max(0, distance);
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!, b = points[i + 1]!, d = norm(sub(b, a));
    if (left <= d || i === points.length - 2) { const f = d === 0 ? 0 : Math.min(1, left / d); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
    left -= d;
  }
  return points.at(-1)!;
}

export function modelChartAt(sim: number, c: DirectorContext): ModelChart | null {
  const pr = c.film.facts.proof;
  if (!pr) return null;
  const issueTick = Math.round(pr.issuedAt * 4);
  const fit = c.run.ticks[issueTick]?.step.obstacles.find(o => o.id === c.primary)?.fit;
  if (!fit) return null;
  const vel = predictMotion(fit, fit.issuedAt).velocity;
  const speed = norm(vel) || 1;
  const u: Vec3 = [vel[0] / speed, vel[1] / speed, vel[2] / speed];
  const tick = Math.min(c.run.ticks.length - 1, Math.floor(sim * 4 + 1e-9));
  const samples: TP[] = [];
  let ref: Vec3 | null = null;
  const t0 = Math.max(0, pr.issuedAt - 6);
  for (let k = 0; k <= tick; k += 1) {
    const s = c.run.ticks[k]!.sensed.find(x => x.id === c.primary); if (!s || s.position === undefined) continue;
    const time = c.run.ticks[k]!.time; if (time < t0 - 1e-9) continue;
    ref ??= s.position;
    samples.push({ t: time, v: dot(sub(s.position, ref), u) });
  }
  if (!ref) return null;
  const at = (p: Vec3) => dot(sub(p, ref!), u);
  const fitPast: TP[] = [], fitFuture: TP[] = [], band: { t: number; lo: number; hi: number }[] = [];
  for (let t = Math.max(fit.support.start, t0); t <= fit.issuedAt + 1e-9; t += 0.25) fitPast.push({ t, v: at(predictMotion(fit, t).position) });
  for (let t = fit.issuedAt; t <= pr.targetTime + 0.3 + 1e-9; t += 0.1) { const p = predictMotion(fit, t); const v = at(p.position); fitFuture.push({ t, v }); band.push({ t, lo: v - p.uncertainty, hi: v + p.uncertainty }); }
  const done = sim >= pr.targetTime - 1e-9 && pr.observed !== null;
  return {
    t0, t1: pr.targetTime + 0.9, samples, issue: pr.issuedAt, target: pr.targetTime, fitPast, fitFuture, band,
    estimate: { t: pr.targetTime, v: at(pr.estimate), allowance: pr.allowance }, persistence: { t: pr.targetTime, v: at(pr.baseline) },
    measured: done ? { t: pr.targetTime, v: at(pr.observed!), modelError: pr.modelError ?? 0, persistenceError: pr.baselineError ?? 0 } : null, unit: 'u along the island’s direction of travel',
  };
}

export function clearanceChartAt(sim: number, c: DirectorContext): ClearanceChart | null {
  // The decision in force: the latest made at or before `sim` (the first one while the film is still on the first decision).
  let d: PlanDecision = c.first;
  for (const x of c.run.decisions) if (x.time <= sim + 1e-9) d = x;
  const obstacleId = d.directModelled.worstObstacleId ?? c.primary;
  const fit = d.obstacles.find(o => o.id === obstacleId)?.fit;
  if (!fit || !d.chosen) return null;
  const params = c.run.spec.params;
  const base = params.baymaxRadius + params.margin + params.obstacleBound;
  const idx = c.run.decisions.indexOf(d);
  const previous = idx > 0 ? c.run.decisions[idx - 1]!.chosen : null;
  let directPts: Vec3[] = [d.start, d.goal];
  let firstLabel = 'direct route';
  if (previous) {
    // The route that was in force: what remains of it from where Baymax is when the decision is made.
    const prev = c.run.decisions[idx - 1]!;
    let flown = (d.time - prev.time) * c.run.spec.params.speed, k = 0;
    const wp = previous.waypoints.map(w => w.position);
    while (k + 1 < wp.length - 1 && flown > norm(sub(wp[k + 1]!, wp[k]!))) { flown -= norm(sub(wp[k + 1]!, wp[k]!)); k += 1; }
    directPts = [d.start, ...wp.slice(k + 1)];
    firstLabel = 'previous route';
  }
  const chosenPts = d.chosen.waypoints.map(w => w.position);
  const lenOf = (pts: readonly Vec3[]) => pts.slice(1).reduce((s, p, i) => s + norm(sub(p, pts[i]!)), 0);
  const tEnd = d.time + Math.max(lenOf(directPts), lenOf(chosenPts)) / params.speed;
  const series = (pts: readonly Vec3[]): TP[] => { const out: TP[] = []; const dur = lenOf(pts) / params.speed; for (let t = d.time; t <= d.time + dur + 1e-9; t += 0.25) out.push({ t, v: norm(sub(along(pts, (t - d.time) * params.speed), predictMotion(fit, t).position)) }); return out; };
  const required: TP[] = []; for (let t = d.time; t <= tEnd + 1e-9; t += 0.25) required.push({ t, v: base + predictMotion(fit, t).uncertainty });
  const direct = series(directPts), chosen = series(chosenPts);
  const worst = previous ? (() => { const dd = direct; const m = dd.reduce((a, b) => (b.v - (required.find(r => Math.abs(r.t - b.t) < 1e-6)?.v ?? 0) < a.v - (required.find(r => Math.abs(r.t - a.t) < 1e-6)?.v ?? 0) ? b : a)); const req = required.find(r => Math.abs(r.t - m.t) < 1e-6)?.v ?? 0; return { timeAtMin: m.t, clearanceAtMin: m.v, requiredAtMin: req }; })() : (d.directModelled.legs[0]?.clearance.worst ?? null);
  const cmin = d.chosen.legs.reduce<{ t: number; distance: number; required: number } | null>((m, leg) => { const w = leg.clearance.perObstacle.find(x => x.id === obstacleId); if (!w) return m; return m === null || w.clearanceAtMin - w.requiredAtMin < m.distance - m.required ? { t: w.timeAtMin, distance: w.clearanceAtMin, required: w.requiredAtMin } : m; }, null);
  return { t0: d.time, t1: tEnd, direct, chosen, required, horizonEnd: d.time + fit.horizon, conflict: worst ? { t: worst.timeAtMin, distance: worst.clearanceAtMin, required: worst.requiredAtMin } : null, chosenMin: cmin, obstacle: obstacleId === c.primary ? 'Island A' : 'Island B', decisionTime: d.time, firstLabel, secondLabel: previous ? 'new route' : 'ATLAS route' };
}
