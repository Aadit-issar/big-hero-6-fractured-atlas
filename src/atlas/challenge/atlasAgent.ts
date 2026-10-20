import type { AtlasView } from '../core/runtime';
import type { SceneKnowledge } from '../live/knowledge';
import { evaluateLeg, legLength } from './clearance';
import type { Obstacle } from './clearance';
import { fitTrack, predictMotion, staticEstimate } from './motionModel';
import type { MotionFit, MotionKind } from './motionModel';
import { planRoute, summarise } from './timePlanner';
import type { PlannedLeg, PlanResult, RoutePlan, Waypoint } from './timePlanner';
import type { ChallengeParams, TrackSample, Vec3 } from './types';

/** ATLAS-side decision loop of the Moving Corridor challenge.
 *
 * Each tick it receives ONLY the runtime's accepted view (exploration memory) and the scene-scan memory. From them it
 *   1. fits and validates a motion model per observed island,
 *   2. freezes forecasts and scores them against later observations (the ledger),
 *   3. once it has observed long enough and knows the destination, evaluates the direct candidate and searches for another,
 *   4. while Baymax flies, re-validates the remaining route against the newest models and replans only if it no longer meets the constraint.
 * It has no handle on the world, the fixtures or the evaluator. */

export const FORECAST_LEADS = [2, 4, 6] as const;
/** Planning keeps this much extra clearance so that estimate noise does not flip a route back and forth (hysteresis); validation needs none. */
export const PLAN_SLACK = 2.5;
/** A committed route is re-validated only over the next COMMIT_SECONDS of flight: conflicts further out are left to be handled when they come within reach (lazy replanning, which avoids chasing predictions that will change). */
export const COMMIT_SECONDS = 10;
/** Hysteresis: a route is abandoned only when its predicted margin falls below -REPLAN_TOLERANCE u (plans demand +PLAN_SLACK u, so the band is 3 u wide). */
export const REPLAN_TOLERANCE = 0.5;
/** ATLAS commits to a route only when every motion estimate has settled: its prediction SETTLE_LEAD s ahead moved by at most SETTLE_TOLERANCE u
 * since one second earlier. Gives up waiting after SETTLE_PATIENCE s past the minimum observation time. */
export const SETTLE_LEAD = 8;
export const SETTLE_TOLERANCE = 1.0;
export const SETTLE_PATIENCE = 8;

export type AgentStatus = 'observing' | 'flying' | 'arrived' | 'no-route';
export interface ForecastRecord {
  readonly id: string;
  readonly obstacleId: string;
  readonly issuedAt: number;
  readonly lead: number;
  readonly targetTime: number;
  readonly model: MotionKind;
  /** Frozen at issue; never refitted. */
  readonly estimate: Vec3;
  readonly allowance: number;
  /** Persistence baseline: where the obstacle was last observed. */
  readonly baseline: Vec3;
  /** The measurement made at the target time, once it exists. */
  readonly observed: Vec3 | null;
  readonly observedAt: number | null;
  readonly modelError: number | null;
  readonly baselineError: number | null;
  readonly status: 'pending' | 'scored' | 'expired';
}
export interface AgentEvent { readonly time: number; readonly kind: 'goal-acquired' | 'model-published' | 'model-withheld' | 'forecast-scored' | 'direct-rejected' | 'route-committed' | 'route-kept' | 'replan' | 'no-route' | 'arrived'; readonly text: string }

export interface ObstacleSummary { readonly id: string; readonly observedPosition: Vec3; readonly fit: MotionFit | null; readonly reasons: readonly string[] }

export interface PlanDecision {
  readonly id: number;
  readonly time: number;
  readonly trigger: 'initial' | 'invalidated';
  /** For a replan: the route that stopped meeting the constraint and why. */
  readonly replaced: { readonly routeId: number; readonly obstacleId: string | null; readonly margin: number; readonly atTime: number } | null;
  readonly start: Vec3;
  readonly goal: Vec3;
  /** The direct candidate judged by a static plan that assumes nothing moves (what a map would say). */
  readonly directStatic: RoutePlan;
  /** The direct candidate judged with the fitted motion models. */
  readonly directModelled: RoutePlan;
  readonly chosen: RoutePlan | null;
  readonly alternatives: readonly RoutePlan[];
  readonly obstacles: readonly ObstacleSummary[];
  readonly candidateWaypoints: number;
  readonly legsEvaluated: number;
  readonly legsRejected: number;
  /** Wall-clock planning time. Profiling only; excluded from determinism comparisons. */
  readonly computeMs: number;
}

export interface AgentStep {
  readonly tick: number;
  readonly time: number;
  readonly status: AgentStatus;
  readonly goal: Vec3 | null;
  readonly obstacles: readonly ObstacleSummary[];
  /** The route Baymax is committed to (a polyline from `routeStartTime`), if any. */
  readonly route: RoutePlan | null;
  readonly routeId: number;
  readonly routeStartTime: number | null;
  readonly decisionId: number | null;
  readonly events: readonly AgentEvent[];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export interface AgentInput { readonly tick: number; readonly view: AtlasView; readonly scene: SceneKnowledge }

export class AtlasAgent {
  readonly decisions: PlanDecision[] = [];
  readonly forecasts: ForecastRecord[] = [];
  readonly events: AgentEvent[] = [];
  private route: RoutePlan | null = null;
  private routeId = 0;
  private routeStart: number | null = null;
  private status: AgentStatus = 'observing';
  private known = new Set<string>();
  private goalAnnounced = false;
  private waitNoted = false;
  private nextForecast = 1;
  private history: { time: number; fits: ReadonlyMap<string, MotionFit> }[] = [];

  constructor(private readonly params: ChallengeParams, private readonly observeSeconds: number, private readonly goalKind = 'capsule_shell_remnant') {}

  step(input: AgentInput): AgentStep {
    const { tick, view, scene } = input;
    const observation = view.observation;
    if (!observation) throw new RangeError('The agent steps only on accepted observations.');
    const now = observation.time;
    const here = view.mapping.explorer.latestPosition ?? observation.observerWorldPosition;
    const newEvents: AgentEvent[] = [];
    const emit = (kind: AgentEvent['kind'], text: string) => { const e = Object.freeze({ time: now, kind, text }); newEvents.push(e); this.events.push(e); };

    // 1. Motion models for every island observed right now.
    const summaries: ObstacleSummary[] = [];
    const tracks = new Map<string, readonly TrackSample[]>();
    for (const island of view.mapping.islands) {
      if (!island.currentlyObserved) continue;
      const track: TrackSample[] = island.track.map(s => ({ time: s.time, position: s.position, breakBefore: s.breakBefore }));
      tracks.set(island.id, track);
      const fit = fitTrack(island.id, track, now);
      summaries.push(Object.freeze({ id: island.id, observedPosition: island.currentPosition ?? island.lastKnownPosition, fit: fit.ok ? fit.fit : null, reasons: fit.ok ? [] : fit.reasons }));
      const was = this.known.has(island.id);
      if (fit.ok && !was) { this.known.add(island.id); emit('model-published', `${island.id}: ${fit.fit.validation!.selected} motion model validated (${fit.fit.validation!.reason})`); }
      if (!fit.ok && was) { this.known.delete(island.id); emit('model-withheld', `${island.id}: model withheld. ${fit.reasons[0]}`); }
    }

    this.history.push({ time: now, fits: new Map(summaries.flatMap(x => (x.fit ? [[x.id, x.fit] as const] : []))) });
    if (this.history.length > 12) this.history.shift();

    // 2. Forecast ledger: score what has matured, then publish new frozen forecasts once a second.
    this.scoreForecasts(now, tracks, emit);
    if (tick % 4 === 0) for (const s of summaries) {
      if (!s.fit) continue;
      const last = tracks.get(s.id)!.at(-1)!;
      for (const lead of FORECAST_LEADS) {
        const target = now + lead;
        const p = predictMotion(s.fit, target);
        this.forecasts.push(Object.freeze({ id: `f${this.nextForecast++}`, obstacleId: s.id, issuedAt: now, lead, targetTime: target, model: s.fit.kind, estimate: p.position, allowance: p.uncertainty, baseline: last.position,
          observed: null, observedAt: null, modelError: null, baselineError: null, status: 'pending' as const }));
      }
    }

    // 3. Destination: only what a scan has actually acquired.
    const capsule = scene.records.find(r => r.kind === this.goalKind);
    const goal: Vec3 | null = capsule ? capsule.lastKnownPosition : null;
    if (goal && !this.goalAnnounced) { this.goalAnnounced = true; emit('goal-acquired', `Destination recorded: damaged capsule, ${dist(here, goal).toFixed(0)} units away.`); }

    let decisionId: number | null = null;
    if (goal && this.status !== 'arrived') {
      if (this.status === 'observing') {
        const settled = this.settled(now, summaries);
        const ready = now >= this.observeSeconds - 1e-9 && summaries.length > 0 && summaries.every(s => s.fit) && (settled || now >= this.observeSeconds + SETTLE_PATIENCE);
        if (now >= this.observeSeconds - 1e-9 && !ready && !this.waitNoted && summaries.every(s => s.fit)) { this.waitNoted = true; emit('model-withheld', 'Motion estimates are still changing; waiting for them to settle before committing to a route.'); }
        if (ready) {
          const decision = this.decide(now, here, goal, summaries, 'initial', null, emit);
          decisionId = decision.id;
        }
      } else if (this.status === 'flying' && this.route) {
        if (dist(here, goal) < 0.75) { this.status = 'arrived'; this.route = null; emit('arrived', 'Baymax reached the capsule.'); }
        else {
          const check = this.validateRemaining(now, here, summaries);
          if (check.margin < -REPLAN_TOLERANCE) {
            const decision = this.decide(now, here, goal, summaries, 'invalidated', { routeId: this.routeId, obstacleId: check.obstacleId, margin: check.margin, atTime: check.atTime }, emit);
            decisionId = decision.id;
          }
        }
      }
    }
    return Object.freeze({ tick, time: now, status: this.status, goal, obstacles: Object.freeze(summaries), route: this.route, routeId: this.routeId, routeStartTime: this.routeStart, decisionId, events: Object.freeze(newEvents) });
  }

  /** Every current estimate agrees with the one from about a second ago about where its obstacle will be SETTLE_LEAD s from now. */
  private settled(now: number, summaries: readonly ObstacleSummary[]): boolean {
    const earlier = [...this.history].reverse().find(h => now - h.time >= 1 - 1e-9);
    if (!earlier) return false;
    return summaries.every(s => {
      const before = earlier.fits.get(s.id);
      if (!s.fit || !before) return false;
      const a = predictMotion(s.fit, now + SETTLE_LEAD).position, b = predictMotion(before, now + SETTLE_LEAD).position;
      return dist(a, b) <= SETTLE_TOLERANCE;
    });
  }

  private obstaclesFor(summaries: readonly ObstacleSummary[]): Obstacle[] {
    return summaries.flatMap(s => (s.fit ? [{ id: s.id, fit: s.fit, bound: this.params.obstacleBound }] : []));
  }

  private decide(now: number, start: Vec3, goal: Vec3, summaries: readonly ObstacleSummary[], trigger: PlanDecision['trigger'], replaced: PlanDecision['replaced'], emit: (kind: AgentEvent['kind'], text: string) => void): PlanDecision {
    const fitted = this.obstaclesFor(summaries);
    const staticView: Obstacle[] = summaries.map(s => ({ id: s.id, fit: staticEstimate(s.id, [{ time: now, position: s.observedPosition }])!, bound: this.params.obstacleBound }));
    // Planning demands PLAN_SLACK extra clearance (hysteresis). The reported direct verdicts use the plain constraint.
    const slackParams: ChallengeParams = { ...this.params, margin: this.params.margin + PLAN_SLACK };
    const planned: PlanResult = planRoute({ now, start, goal, obstacles: fitted, params: slackParams });
    const directStatic = summarise([{ id: 'start', kind: 'start', position: start }, { id: 'goal', kind: 'goal', position: goal }], [leg(start, goal, now, staticView, this.params)]);
    const directModelled = summarise([{ id: 'start', kind: 'start', position: start }, { id: 'goal', kind: 'goal', position: goal }], [leg(start, goal, now, fitted, this.params)]);
    // Re-evaluate the chosen route against the plain constraint so reported margins mean the same thing everywhere.
    const rescore = (r: RoutePlan | null) => (r ? replay(r, now, fitted, this.params) : null);
    const chosen = rescore(planned.chosen);
    const decision: PlanDecision = Object.freeze({
      id: this.decisions.length + 1, time: now, trigger, replaced, start, goal, directStatic, directModelled, chosen,
      alternatives: Object.freeze(planned.alternatives.map(a => replay(a, now, fitted, this.params))), obstacles: Object.freeze([...summaries]),
      candidateWaypoints: planned.candidateWaypoints, legsEvaluated: planned.legsEvaluated, legsRejected: planned.legsRejected, computeMs: planned.computeMs,
    });
    this.decisions.push(decision);
    const verdict = (r: RoutePlan) => `${r.worstObstacleId ?? 'obstacle'} margin ${r.minMargin.toFixed(1)} u`;
    if (trigger === 'initial') {
      emit('direct-rejected',
        `Direct route: a static plan finds it ${directStatic.feasible ? 'clear' : 'blocked'}; with the fitted motion it ${directModelled.feasible ? 'stays clear' : `violates the clearance constraint (${verdict(directModelled)})`}.`);
    } else {
      emit('replan', `Route no longer meets the constraint (${replaced!.obstacleId ?? 'obstacle'}, margin ${replaced!.margin.toFixed(1)} u at t=${replaced!.atTime.toFixed(1)} s). Recomputed.`);
    }
    if (chosen) {
      this.route = chosen; this.routeId += 1; this.routeStart = now; this.status = 'flying';
      emit('route-committed', `Route ${this.routeId}: ${chosen.waypoints.length - 1} leg${chosen.waypoints.length === 2 ? '' : 's'}, ${chosen.length.toFixed(1)} units, minimum modelled margin ${chosen.minMargin.toFixed(1)} u.`);
    } else {
      this.route = null; this.status = 'no-route';
      emit('no-route', 'No candidate met the modelled-clearance constraint; Baymax holds position.');
    }
    return decision;
  }

  /** Re-checks what remains of the committed route (from where Baymax is now) against the newest models. */
  private validateRemaining(now: number, here: Vec3, summaries: readonly ObstacleSummary[]): { margin: number; obstacleId: string | null; atTime: number } {
    const route = this.route!;
    const obstacles = this.obstaclesFor(summaries);
    // Index of the leg Baymax is on (by distance flown since the route was committed).
    const flown = (now - this.routeStart!) * this.params.speed;
    let acc = 0, index = route.legs.length - 1;
    for (let i = 0; i < route.legs.length; i += 1) { acc += route.legs[i]!.length; if (flown < acc) { index = i; break; } }
    let t = now, from = here, worst = { margin: Infinity, obstacleId: null as string | null, atTime: now };
    const until = now + COMMIT_SECONDS;
    for (let i = index; i < route.legs.length && t < until - 1e-9; i += 1) {
      let to = route.legs[i]!.to.position;
      const full = legLength({ from, to }) / this.params.speed;
      if (t + full > until) { const f = (until - t) / full; to = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f]; }
      const rep = evaluateLeg({ from, to, t0: t, speed: this.params.speed }, obstacles, this.params);
      if (rep.minMargin < worst.margin) worst = { margin: rep.minMargin, obstacleId: rep.worst?.id ?? null, atTime: rep.worst?.timeAtMin ?? t };
      t += legLength({ from, to }) / this.params.speed; from = to;
    }
    return worst;
  }

  private scoreForecasts(now: number, tracks: Map<string, readonly TrackSample[]>, emit: (kind: AgentEvent['kind'], text: string) => void): void {
    for (let i = 0; i < this.forecasts.length; i += 1) {
      const f = this.forecasts[i]!;
      if (f.status !== 'pending' || f.targetTime > now + 1e-9) continue;
      const sample = tracks.get(f.obstacleId)?.find(s => Math.abs(s.time - f.targetTime) < 1e-6);
      if (!sample) { if (now - f.targetTime > 0.15) this.forecasts[i] = Object.freeze({ ...f, status: 'expired' as const }); continue; }
      const scored = Object.freeze({ ...f, observed: sample.position, observedAt: sample.time, modelError: dist(f.estimate, sample.position), baselineError: dist(f.baseline, sample.position), status: 'scored' as const });
      this.forecasts[i] = scored;
      if (f.lead === 4 && f.obstacleId === this.primaryId) emit('forecast-scored', `${f.obstacleId}: forecast for t=${f.targetTime.toFixed(1)} s missed the later measurement by ${scored.modelError.toFixed(2)} u; "it stayed put" missed by ${scored.baselineError.toFixed(2)} u.`);
    }
  }

  /** The obstacle whose scored forecasts are narrated as events (the first one validated). */
  private get primaryId(): string | null { return this.known.values().next().value ?? null; }
}

function leg(from: Vec3, to: Vec3, t0: number, obstacles: readonly Obstacle[], params: ChallengeParams): PlannedLeg {
  const length = legLength({ from, to });
  const clearance = evaluateLeg({ from, to, t0, speed: params.speed }, obstacles, params);
  const a: Waypoint = { id: 'start', kind: 'start', position: from }, b: Waypoint = { id: 'goal', kind: 'goal', position: to };
  return Object.freeze({ from: a, to: b, tStart: t0, tEnd: t0 + length / params.speed, length, clearance, cost: length });
}

/** Re-evaluates a planned polyline against given obstacles with the plain (slack-free) constraint. */
export function replay(plan: RoutePlan, t0: number, obstacles: readonly Obstacle[], params: ChallengeParams): RoutePlan {
  let t = t0;
  const legs = plan.legs.map(l => { const next = (() => { const length = legLength({ from: l.from.position, to: l.to.position }); const clearance = evaluateLeg({ from: l.from.position, to: l.to.position, t0: t, speed: params.speed }, obstacles, params); return Object.freeze({ ...l, tStart: t, tEnd: t + length / params.speed, clearance }); })(); t = next.tEnd; return next; });
  const rebuilt = summarise(plan.waypoints, legs);
  return Object.freeze({ ...rebuilt, cost: plan.cost });
}
