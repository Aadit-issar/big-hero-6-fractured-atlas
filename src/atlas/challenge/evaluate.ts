import { fitTrack, predictMotion } from './motionModel';
import type { MotionKind } from './motionModel';
import { realTrajectory, TRAJECTORY_DT } from './fixtures';
import { gaussian, interpolate } from './world';
import type { TrackSample, Vec3 } from './types';

/** Offline evaluation of the motion model on real-law trajectories (acceptance protocol A in docs/ATLAS_CONTROLLED_CHALLENGE_DISCOVERY.md).
 * Evaluation only: it holds truth, so no ATLAS-side module imports this file. */

export const PROTOCOL_A = Object.freeze({
  islands: 14, startSeconds: [10, 30, 50, 70, 90, 110] as readonly number[], noiseSeeds: [1, 2, 3] as readonly number[],
  observeSeconds: 9, leads: [2, 4, 6] as readonly number[], primaryLead: 4, noiseSigma: 0.1,
  /** Pass: mean model error <= this fraction of mean persistence error, and the model beats persistence in at least `winRate` of cases. */
  maxErrorRatio: 0.5, winRate: 0.9,
  /** v2 only (added after the first full run, see docs/ATLAS_CONTROLLED_CHALLENGE_SCIENCE.md): the same two thresholds are applied to cases where the
   * fitted speed at issue is at least this many world units/s ("moving"); slower cases are reported and only bounded for harm. */
  movingSpeed: 0.4, slowMaxHarmRatio: 1.5,
});

export interface MotionCase { readonly island: string; readonly start: number; readonly seed: number }
export interface LeadScore { readonly lead: number; readonly modelError: number; readonly persistenceError: number; readonly modelTruthError: number; readonly persistenceTruthError: number }
export interface MotionCaseResult { readonly case: MotionCase; readonly published: boolean; readonly selected: MotionKind | null; readonly fitSpeed: number | null; readonly reasons: readonly string[]; readonly scores: readonly LeadScore[] }

export function motionCases(): MotionCase[] {
  const out: MotionCase[] = [];
  for (let n = 1; n <= PROTOCOL_A.islands; n += 1) for (const start of PROTOCOL_A.startSeconds) for (const seed of PROTOCOL_A.noiseSeeds) out.push({ island: `island-${String(n).padStart(2, '0')}`, start, seed });
  return out;
}

export function runMotionCase(c: MotionCase): MotionCaseResult {
  const t = realTrajectory(c.island);
  const truthAt = (tau: number): Vec3 => interpolate(t.samples, (c.start + tau) / TRAJECTORY_DT);
  const observeAt = (tick: number): Vec3 => { const p = truthAt(tick / 4); return [0, 1, 2].map(a => p[a]! + PROTOCOL_A.noiseSigma * gaussian(c.seed, c.island, tick + Math.round(c.start * 4), a)) as unknown as Vec3; };
  const now = PROTOCOL_A.observeSeconds;
  const history: TrackSample[] = [];
  for (let tick = 0; tick <= now * 4; tick += 1) history.push({ time: tick / 4, position: observeAt(tick) });
  const fit = fitTrack(c.island, history, now);
  if (!fit.ok) return { case: c, published: false, selected: null, fitSpeed: null, reasons: fit.reasons, scores: [] };
  const last = history.at(-1)!.position;
  const scores = PROTOCOL_A.leads.map((lead): LeadScore => {
    const target = now + lead;
    const later = observeAt(Math.round(target * 4)), truth = truthAt(target);
    const p = predictMotion(fit.fit, target).position;
    const d = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    return { lead, modelError: d(p, later), persistenceError: d(last, later), modelTruthError: d(p, truth), persistenceTruthError: d(last, truth) };
  });
  return { case: c, published: true, selected: fit.fit.kind, fitSpeed: fit.fit.speed, reasons: [], scores };
}

export interface StratumReport {
  readonly name: string;
  readonly cases: number;
  readonly selectedCounts: Readonly<Record<string, number>>;
  readonly perLead: readonly { readonly lead: number; readonly meanModelError: number; readonly meanPersistenceError: number; readonly ratio: number; readonly winRate: number; readonly meanModelTruthError: number; readonly meanPersistenceTruthError: number; readonly p95ModelError: number }[];
  readonly primary: { readonly ratio: number; readonly winRate: number };
}
export interface MotionProtocolReport {
  readonly cases: number;
  readonly published: number;
  readonly withheld: number;
  /** Protocol v1 as pre-registered: all published cases pooled. */
  readonly v1: StratumReport & { readonly pass: boolean; readonly criteria: string };
  /** Protocol v2: stratified by fitted speed at issue. Added after v1 was run; v1 stays in the report. */
  readonly moving: StratumReport & { readonly pass: boolean; readonly criteria: string };
  readonly slow: StratumReport & { readonly pass: boolean; readonly criteria: string };
  readonly pass: boolean;
}

function stratum(name: string, rows: readonly MotionCaseResult[]): StratumReport {
  const selectedCounts: Record<string, number> = {};
  for (const r of rows) selectedCounts[r.selected!] = (selectedCounts[r.selected!] ?? 0) + 1;
  const mean = (v: readonly number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  const perLead = PROTOCOL_A.leads.map(lead => {
    const sc = rows.map(r => r.scores.find(s => s.lead === lead)!);
    const m = mean(sc.map(r => r.modelError)), p = mean(sc.map(r => r.persistenceError));
    const sorted = sc.map(r => r.modelError).sort((a, b) => a - b);
    return { lead, meanModelError: m, meanPersistenceError: p, ratio: m / p, winRate: sc.filter(r => r.modelError < r.persistenceError).length / Math.max(1, sc.length),
      meanModelTruthError: mean(sc.map(r => r.modelTruthError)), meanPersistenceTruthError: mean(sc.map(r => r.persistenceTruthError)), p95ModelError: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? NaN };
  });
  const primary = perLead.find(l => l.lead === PROTOCOL_A.primaryLead)!;
  return { name, cases: rows.length, selectedCounts, perLead, primary: { ratio: primary.ratio, winRate: primary.winRate } };
}

export function summariseMotion(results: readonly MotionCaseResult[]): MotionProtocolReport {
  const published = results.filter(r => r.published);
  const moving = published.filter(r => r.fitSpeed! >= PROTOCOL_A.movingSpeed), slow = published.filter(r => r.fitSpeed! < PROTOCOL_A.movingSpeed);
  const v1 = stratum('all published cases (protocol v1)', published), mv = stratum(`moving: fitted speed >= ${PROTOCOL_A.movingSpeed} u/s`, moving), sl = stratum(`slow: fitted speed < ${PROTOCOL_A.movingSpeed} u/s`, slow);
  const lead = `At ${PROTOCOL_A.primaryLead} s lead: mean model error <= ${PROTOCOL_A.maxErrorRatio} x persistence and the model beats persistence in >= ${PROTOCOL_A.winRate * 100}% of cases.`;
  const v1Pass = v1.primary.ratio <= PROTOCOL_A.maxErrorRatio && v1.primary.winRate >= PROTOCOL_A.winRate;
  const movingPass = mv.primary.ratio <= PROTOCOL_A.maxErrorRatio && mv.primary.winRate >= PROTOCOL_A.winRate;
  const slowPass = sl.primary.ratio <= PROTOCOL_A.slowMaxHarmRatio;
  return {
    cases: results.length, published: published.length, withheld: results.length - published.length,
    v1: { ...v1, pass: v1Pass, criteria: lead },
    moving: { ...mv, pass: movingPass, criteria: lead },
    slow: { ...sl, pass: slowPass, criteria: `Reported only; bounded harm: mean model error <= ${PROTOCOL_A.slowMaxHarmRatio} x persistence at ${PROTOCOL_A.primaryLead} s.` },
    pass: movingPass && slowPass,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ground-truth evaluation of a closed-loop run (protocol B). Truth is used only here, after the fact.
// ---------------------------------------------------------------------------------------------------------------------------------
import type { ChallengeRun } from './run';
import { pointOnRoute } from './run';
import { staticClearance } from './types';

export interface TruthClearance {
  /** Smallest (centre distance - required clearance) over the path. Negative = the modelled-clearance constraint was violated in truth. */
  readonly minMargin: number;
  readonly minDistance: number;
  readonly required: number;
  readonly atTime: number;
  readonly obstacleId: string | null;
  readonly samples: number;
  /** Where Baymax and the obstacle were at the closest approach (for the proof overlay). */
  readonly baymaxAt: Vec3;
  readonly obstacleAt: Vec3;
}

/** Where Baymax actually was at time `t`, reconstructed from the routes ATLAS committed (exact, including corners inside a tick). */
export function executedPosition(run: ChallengeRun, t: number): Vec3 {
  const tick = Math.min(run.ticks.length - 1, Math.max(0, Math.floor(t * run.spec.tickHz + 1e-9)));
  const rec = run.ticks[tick]!;
  const { route, routeStartTime } = rec.step;
  if (!route || routeStartTime === null) return rec.baymax;
  const pts = route.waypoints.map(w => w.position);
  return pointOnRoute(pts, (t - routeStartTime) * run.spec.params.speed).position;
}

export function truthClearance(run: ChallengeRun, position: (t: number) => Vec3, from: number, to: number, step = 0.02): TruthClearance {
  const required = staticClearance(run.spec.params);
  let best: TruthClearance = { minMargin: Infinity, minDistance: Infinity, required, atTime: from, obstacleId: null, samples: 0, baymaxAt: position(from), obstacleAt: position(from) };
  let n = 0;
  for (let t = from; t <= to + 1e-9; t += step) {
    const b = position(t);
    for (const id of run.world.obstacleIds) {
      const o = run.world.truthAt(id, t);
      const d = Math.hypot(b[0] - o[0], b[1] - o[1], b[2] - o[2]);
      if (d - required < best.minMargin) best = { minMargin: d - required, minDistance: d, required, atTime: t, obstacleId: id, samples: 0, baymaxAt: b, obstacleAt: o };
    }
    n += 1;
  }
  return { ...best, samples: n };
}

/** Distance from a flown (or counterfactual) path to the nearest island in ground truth, sampled every `step` seconds. */
export function truthSeries(run: ChallengeRun, position: (t: number) => Vec3, from: number, to: number, step = 0.25): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const b = position(t); let m = Infinity;
    for (const id of run.world.obstacleIds) { const o = run.world.truthAt(id, t); m = Math.min(m, Math.hypot(b[0] - o[0], b[1] - o[1], b[2] - o[2])); }
    out.push({ t, v: m });
  }
  return out;
}

export interface RouteVerdict {
  readonly departure: number;
  readonly arrival: number | null;
  readonly length: number;
  readonly truth: TruthClearance;
}
export interface ShowcaseEvaluation {
  readonly departure: number;
  readonly atlas: RouteVerdict;
  readonly direct: RouteVerdict;
  /** What a static plan (assumes nothing moves) concluded about the direct route at decision time, from the run's first decision. */
  readonly staticPlanSaysDirectClear: boolean;
  readonly modelledPlanSaysDirectClear: boolean;
  readonly replans: number;
  readonly pass: Readonly<Record<'directTrulyConflicts' | 'staticPlanAcceptedDirect' | 'atlasRejectedDirect' | 'atlasTrulyClear' | 'replannedForCause', boolean>>;
}

export function evaluateShowcase(run: ChallengeRun): ShowcaseEvaluation | null {
  const first = run.decisions[0];
  if (!first || !first.chosen) return null;
  const speed = run.spec.params.speed;
  const departure = first.time;
  // ATLAS: executed path until arrival (or the end of the run).
  const arrivedTick = run.ticks.find(t => t.step.status === 'arrived');
  const end = arrivedTick ? arrivedTick.time : run.spec.durationSeconds;
  const atlasTruth = truthClearance(run, t => executedPosition(run, t), departure, end);
  // Direct counterfactual: straight from the same departure at the same speed.
  const start = first.start, goal = first.goal;
  const length = Math.hypot(goal[0] - start[0], goal[1] - start[1], goal[2] - start[2]);
  const directEnd = departure + length / speed;
  const dir: Vec3 = [(goal[0] - start[0]) / length, (goal[1] - start[1]) / length, (goal[2] - start[2]) / length];
  const directTruth = truthClearance(run, t => { const s = Math.min(length, (t - departure) * speed); return [start[0] + dir[0] * s, start[1] + dir[1] * s, start[2] + dir[2] * s]; }, departure, directEnd);
  const replans = run.decisions.filter(d => d.trigger === 'invalidated').length;
  let atlasLength = 0;
  for (let t = departure; t < end - 1e-9; t += 0.05) { const a = executedPosition(run, t), b = executedPosition(run, Math.min(end, t + 0.05)); atlasLength += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
  const pass = {
    directTrulyConflicts: directTruth.minMargin < 0,
    staticPlanAcceptedDirect: first.directStatic.feasible,
    atlasRejectedDirect: !first.directModelled.feasible,
    atlasTrulyClear: atlasTruth.minMargin >= 0,
    replannedForCause: replans >= 1 && run.decisions.filter(d => d.trigger === 'invalidated').every(d => d.replaced !== null && d.replaced.margin < 0),
  };
  return {
    departure, atlas: { departure, arrival: arrivedTick?.time ?? null, length: atlasLength, truth: atlasTruth },
    direct: { departure, arrival: directEnd, length, truth: directTruth },
    staticPlanSaysDirectClear: first.directStatic.feasible, modelledPlanSaysDirectClear: first.directModelled.feasible, replans, pass,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Protocol D: held-out placements. Fixed before results were inspected. The planner is unchanged between the showcase and these runs.
// ---------------------------------------------------------------------------------------------------------------------------------
import { buildPlacement } from './placements';
import type { PlacementParams } from './placements';
import { runChallenge } from './run';

export const PROTOCOL_D = Object.freeze({ placements: 24, minClearRate: 0.9 });

/** Variant 'centred' (D1): the corridor passes through the primary's path (|offset| <= 1.5 u). Variant 'offset' (D2, added after D1 was run): the line is laid
 * 3 to 6 u off the primary's centre line on the side it approaches from, the geometry in which a static plan can be fooled. Same planner, same criteria. */
export function heldOutPlacements(variant: 'centred' | 'offset' = 'centred'): PlacementParams[] {
  const out: PlacementParams[] = [];
  const hash = (k: number, salt: number) => { let h = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b); h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); return ((h ^ (h >>> 13)) >>> 0) / 4294967296; };
  const name = (n: number) => `island-${String((n % 14) + 1).padStart(2, '0')}`;
  for (let k = 0; k < PROTOCOL_D.placements; k += 1) {
    out.push({
      id: `heldout${variant === 'offset' ? '-offset' : ''}-${String(k + 1).padStart(2, '0')}`, seed: 1000 + k,
      primary: { island: name(k), realStartSeconds: 10 + Math.floor(hash(k, 1) * 45) * 2, lateralTruth: variant === 'centred' ? (Math.floor(hash(k, 2) * 5) - 2) * 0.75 : -(3 + 3 * hash(k, 2)) * (k % 2 === 0 ? 1 : -1) },
      secondary: { island: name(k + 5), realStartSeconds: Math.floor(hash(k, 3) * 50) * 2, offsetFromGoal: [(hash(k, 4) - 0.5) * 80, (hash(k, 5) - 0.5) * 40, (hash(k, 6) - 0.5) * 80] as const },
      crossingLength: 34, beyondLength: 22, durationSeconds: 48, approachSign: k % 2 === 0 ? 1 : -1,
    });
  }
  return out;
}

export interface HeldOutRow {
  readonly id: string;
  readonly primary: string;
  readonly directTrulyConflicts: boolean;
  readonly staticAcceptedDirect: boolean;
  readonly atlasRejectedDirect: boolean;
  readonly arrived: boolean;
  readonly replans: number;
  readonly atlasTruthMargin: number | null;
  readonly directTruthMargin: number | null;
  readonly clear: boolean;
  readonly note: string;
}
export function runHeldOut(variant: 'centred' | 'offset' = 'centred'): HeldOutRow[] {
  return heldOutPlacements(variant).map((p): HeldOutRow => {
    const run = runChallenge(buildPlacement(p));
    const ev = evaluateShowcase(run);
    const arrived = run.ticks.at(-1)!.step.status === 'arrived';
    if (!ev) return { id: p.id, primary: p.primary.island, directTrulyConflicts: false, staticAcceptedDirect: false, atlasRejectedDirect: false, arrived, replans: 0, atlasTruthMargin: null, directTruthMargin: null, clear: false, note: 'no route was committed' };
    return { id: p.id, primary: p.primary.island, directTrulyConflicts: ev.pass.directTrulyConflicts, staticAcceptedDirect: ev.pass.staticPlanAcceptedDirect, atlasRejectedDirect: ev.pass.atlasRejectedDirect, arrived, replans: ev.replans,
      atlasTruthMargin: ev.atlas.truth.minMargin, directTruthMargin: ev.direct.truth.minMargin, clear: ev.pass.atlasTrulyClear, note: '' };
  });
}
export function summariseHeldOut(rows: readonly HeldOutRow[]) {
  const conflicts = rows.filter(r => r.directTrulyConflicts);
  const clear = conflicts.filter(r => r.clear);
  return {
    placements: rows.length, directTrulyConflicts: conflicts.length, atlasClearAmongConflicts: clear.length,
    clearRate: conflicts.length ? clear.length / conflicts.length : NaN, arrivedAll: rows.filter(r => r.arrived).length,
    atlasRejectedDirectAmongConflicts: conflicts.filter(r => r.atlasRejectedDirect).length,
    staticAcceptedDirect: rows.filter(r => r.staticAcceptedDirect).length,
    pass: conflicts.length >= 6 && clear.length / Math.max(1, conflicts.length) >= PROTOCOL_D.minClearRate,
    criteria: `Among placements where the direct route truly violates the constraint (needs >= 6 such cases), ATLAS's executed path stays clear in truth in >= ${PROTOCOL_D.minClearRate * 100}%.`,
  };
}
