import { buildNavGraph, dist, listGoals } from './knowledgeGraph';
import type { NavigationKnowledge } from './knowledgeGraph';
import { findFrontiers } from './frontier';
import { assessEdge, planWithAlternatives } from './planner';
import { DEFAULT_POLICY } from './types';
import type { EvidenceItem, Frontier, NavGraph, NavigationAdvice, NavPolicy, Recommendation, Route, RoutePoint } from './types';

const ALWAYS_LIMITS = [
  'ATLAS does not claim a safe path: clearance and hazard between known places are not measured.',
  'Fold availability is not predicted; a route using a fold needs a fresh observation of that fold.',
];

const unique = <T,>(xs: readonly T[]) => [...new Set(xs)];

function frontierRecommendation(f: Frontier | undefined): Recommendation {
  if (!f) return { title: 'No supported next observation', detail: 'ATLAS has no recorded positions to reason from yet. Move and let the sensors observe.', target: null, targetId: null, action: 'none' };
  return { title: f.label, detail: f.reasons.join('. ') + '.', target: f.target, targetId: f.id, action: f.kind === 'refresh-stale' ? 'refresh' : 'observe' };
}

function describeRoute(route: Route, graph: NavGraph, goalLabel: string): { title: string; detail: string } {
  const unverified = route.segments.filter(s => s.support === 'unverified-approach').length;
  const folds = route.segments.filter(s => s.kind === 'fold-transition').length;
  const parts = [`${route.segments.length} segment${route.segments.length === 1 ? '' : 's'}, about ${route.totalLength.toFixed(0)} units`];
  if (folds) parts.push(`${folds} fold transition${folds === 1 ? '' : 's'}`);
  if (unverified) parts.push(`${unverified} unverified approach${unverified === 1 ? '' : 'es'} whose hazard is unknown`);
  const next = graph.nodes.find(n => n.id === route.nodes[1]);
  return { title: `Candidate route to ${goalLabel}`, detail: `${parts.join('; ')}. Next waypoint: ${next?.label ?? route.nodes[1]}.` };
}

/** Pure, deterministic navigation advice from knowledge. Route when a supported candidate exists, revalidate when it rests on stale
 * records, explore when the destination is unknown or unreachable, and abstain when there is nothing to reason from. */
export function adviseNavigation(k: NavigationKnowledge, goalId: string | null, policy: NavPolicy = DEFAULT_POLICY): NavigationAdvice {
  const graph = buildNavGraph(k, policy);
  const goals = listGoals(graph);
  const base = { episode: graph.episode, simTime: graph.simTime, goalId, goalLabel: null as string | null, route: null, waypoints: [] as RoutePoint[], goals, alternatives: [] as Route[], frontiers: [] as Frontier[], evidence: [] as EvidenceItem[], limitations: [...ALWAYS_LIMITS] };
  const observer = graph.nodes.find(n => n.kind === 'observer');
  if (!observer) {
    return { ...base, status: 'abstain', recommendation: { title: 'Waiting for observations', detail: 'ATLAS has not recorded where Baymax is, so it cannot reason about routes.', target: null, targetId: null, action: 'none' }, reason: 'no observer position has been recorded' };
  }
  const evidence: EvidenceItem[] = [{ kind: 'observation', text: `Baymax observed at ${observer.position.map(v => v.toFixed(1)).join(', ')} (t ${observer.lastSeenAt.toFixed(2)}s).`, refs: ['explorer'] }];
  const goal = goalId ? graph.nodes.find(n => n.id === goalId) ?? null : null;
  const frontiers = findFrontiers(graph, goal?.position ?? null, policy);

  if (goalId && !goal) {
    return { ...base, frontiers, evidence, goalLabel: null, status: 'explore', reason: 'the selected destination is not in the records of this episode', recommendation: frontierRecommendation(frontiers[0]) };
  }
  if (!goal) {
    return { ...base, frontiers, evidence, status: frontiers.length ? 'explore' : 'abstain', reason: frontiers.length ? null : 'no frontier is supported by the recorded observations', recommendation: frontierRecommendation(frontiers[0]) };
  }

  evidence.push({ kind: goal.status === 'current' ? 'observation' : 'memory', text: `${goal.label} ${goal.status === 'current' ? 'is observed now' : `is a last-known record from t ${goal.lastSeenAt.toFixed(2)}s`} at ${goal.position.map(v => v.toFixed(1)).join(', ')}.`, refs: goal.evidence });
  const { route, alternatives } = planWithAlternatives(graph, goal.id, policy);

  if (!route) {
    const excluded = graph.edges.filter(e => e.kind === 'fold-transition').map(e => ({ e, a: assessEdge(e, graph, policy) })).filter(x => x.a.excludedBecause);
    for (const x of excluded) evidence.push({ kind: 'derived', text: `${x.e.id.replace('fold:', '')} excluded: ${x.a.excludedBecause}.`, refs: x.e.evidence });
    return { ...base, goalLabel: goal.label, frontiers, evidence, status: 'no-route', reason: `no supported connection from Baymax to ${goal.label}`, recommendation: frontierRecommendation(frontiers[0]) };
  }

  for (const seg of route.segments) {
    const from = graph.nodes.find(n => n.id === seg.from)?.label ?? seg.from, to = graph.nodes.find(n => n.id === seg.to)?.label ?? seg.to;
    evidence.push({ kind: seg.kind === 'fold-transition' ? (seg.support === 'observed-fold' ? 'observation' : 'memory') : 'derived', text: `${from} to ${to}: ${seg.kind === 'fold-transition' ? 'fold transition' : 'free-flight candidate'}, ${seg.length.toFixed(1)} units, ${seg.support.replace(/-/g, ' ')}${seg.notes.length ? `. ${seg.notes.join('; ')}` : ''}.`, refs: [seg.edgeId] });
  }
  evidence.push({ kind: 'assumption', text: 'Free-flight segments are straight lines between known places; ATLAS has not verified clearance or hazard along them.', refs: [] });
  const limitations = unique([...ALWAYS_LIMITS, ...route.segments.flatMap(s => graph.edges.find(e => e.id === s.edgeId)?.unknowns ?? [])]);
  const needsRevalidation = route.segments.some(s => s.support === 'remembered-fold') || (route.oldestSupportAge !== null && route.oldestSupportAge > policy.staleAfter);
  const described = describeRoute(route, graph, goal.label);
  const waypoints: RoutePoint[] = route.nodes.flatMap(id => { const n = graph.nodes.find(x => x.id === id); return n ? [{ id: n.id, label: n.label, position: n.position, kind: n.kind }] : []; });

  if (needsRevalidation) {
    const staleFold = route.foldDependencies.find(f => !f.currentlyObserved);
    const refresh = frontiers.find(f => staleFold && f.id === `refresh:${staleFold.foldId}:entry`) ?? frontiers.find(f => f.kind === 'refresh-stale') ?? frontiers[0];
    return { ...base, goalLabel: goal.label, route, waypoints, alternatives, frontiers, evidence, limitations, status: 'needs-revalidation', reason: 'the route depends on a fold that is not currently observed', recommendation: { ...frontierRecommendation(refresh), title: refresh ? refresh.label : described.title, detail: `${described.title} exists but rests on a last-known fold record. ${refresh ? refresh.reasons[0] + '.' : ''}` } };
  }
  const next = graph.nodes.find(n => n.id === route.nodes[1]);
  return { ...base, goalLabel: goal.label, route, waypoints, alternatives, frontiers, evidence, limitations, status: 'route', reason: null, recommendation: { title: described.title, detail: described.detail, target: next ? next.position : null, targetId: next ? next.id : null, action: 'follow-route' } };
}

export type NavChangeKind = 'session-reset' | 'route-found' | 'route-withdrawn' | 'route-changed' | 'route-needs-revalidation' | 'route-refreshed' | 'goal-lost' | 'fold-state-changed';
export interface NavChange { readonly kind: NavChangeKind; readonly message: string; readonly simTime: number | null }

/** Holds the selected goal and compares successive advice, so a plan is preserved, updated or withdrawn only when genuine knowledge changes. */
export class NavigationRuntime {
  private goalId: string | null = null;
  private previous: NavigationAdvice | null = null;
  constructor(private readonly policy: NavPolicy = DEFAULT_POLICY) {}

  setGoal(id: string | null): void { this.goalId = id; this.previous = null; }
  getGoal(): string | null { return this.goalId; }

  update(k: NavigationKnowledge): { advice: NavigationAdvice; changes: NavChange[] } {
    const advice = adviseNavigation(k, this.goalId, this.policy);
    const changes = this.previous ? diffAdvice(this.previous, advice, k) : [];
    this.previous = advice;
    return { advice, changes };
  }
}

export function diffAdvice(prev: NavigationAdvice, next: NavigationAdvice, k: NavigationKnowledge): NavChange[] {
  const t = next.simTime, out: NavChange[] = [];
  if (prev.episode !== next.episode) { out.push({ kind: 'session-reset', message: 'A different Dimension session began; earlier guidance was discarded.', simTime: t }); return out; }
  const label = next.goalLabel ?? prev.goalLabel ?? 'the destination';
  if (prev.goalId && !next.goalLabel && prev.goalLabel) out.push({ kind: 'goal-lost', message: `${prev.goalLabel} is no longer in ATLAS's records.`, simTime: t });
  if (prev.route) {
    for (const dep of prev.route.foldDependencies) {
      const f = k.view.mapping.folds.find(x => x.id === dep.foldId);
      const state = f ? (f.currentState ?? f.lastObservedState) : null;
      if (state && state !== dep.state) out.push({ kind: 'fold-state-changed', message: `${dep.foldId} changed from ${dep.state} to ${state}; the route that used it was reassessed.`, simTime: t });
    }
  }
  const had = !!prev.route, has = !!next.route;
  if (!had && has && next.status === 'route') out.push({ kind: 'route-found', message: `A candidate route to ${label} is now supported by the records.`, simTime: t });
  else if (had && !has) out.push({ kind: 'route-withdrawn', message: `Candidate route to ${label} withdrawn: ${next.reason ?? 'evidence no longer supports it'}.`, simTime: t });
  else if (had && has) {
    if (prev.status === 'route' && next.status === 'needs-revalidation') out.push({ kind: 'route-needs-revalidation', message: `Route to ${label} now rests on a last-known fold record; revalidate it.`, simTime: t });
    else if (prev.status === 'needs-revalidation' && next.status === 'route') out.push({ kind: 'route-refreshed', message: `New observation refreshed the route to ${label}.`, simTime: t });
    else if (prev.route!.nodes.join('>') !== next.route!.nodes.join('>')) out.push({ kind: 'route-changed', message: `New evidence changed the preferred route to ${label}.`, simTime: t });
  }
  return out;
}

export { dist, listGoals };
