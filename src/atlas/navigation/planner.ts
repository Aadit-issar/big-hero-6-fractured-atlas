import { DEFAULT_POLICY, NAV_WEIGHTS } from './types';
import type { NavEdge, NavGraph, NavPolicy, Route, RouteSegment, SegmentSupport } from './types';

export interface EdgeAssessment {
  /** null when the edge cannot be used under the policy. */
  readonly cost: number | null;
  readonly support: SegmentSupport;
  readonly caution: boolean;
  readonly notes: readonly string[];
  readonly excludedBecause: string | null;
}

const age = (graph: NavGraph, t: number | null) => (graph.simTime === null || t === null ? null : Math.max(0, graph.simTime - t));

/** Transparent, deterministic edge evaluation. Hard constraints first, then quantitative terms, then flags. */
export function assessEdge(edge: NavEdge, graph: NavGraph, policy: NavPolicy = DEFAULT_POLICY): EdgeAssessment {
  if (edge.kind === 'fold-transition') {
    const state = edge.foldState ?? 'inactive';
    const a = age(graph, edge.verifiedAt);
    if (state === 'closed' || state === 'inactive') return { cost: null, support: 'remembered-fold', caution: true, notes: [], excludedBecause: `fold is ${state} in its latest record` };
    if (state === 'forming' || state === 'closing') return { cost: null, support: 'remembered-fold', caution: true, notes: [], excludedBecause: `fold is ${state}, not reliably open` };
    const stale = !edge.currentlyObserved || (a !== null && a > policy.staleAfter);
    if (stale && !policy.allowRemembered) return { cost: null, support: 'remembered-fold', caution: true, notes: [], excludedBecause: 'fold is not currently observed' };
    const notes: string[] = [];
    let cost = edge.length * NAV_WEIGHTS.distance + NAV_WEIGHTS.foldTransition;
    if (state === 'unstable') { cost += NAV_WEIGHTS.foldUnstable; notes.push('fold is reported unstable'); }
    if (stale) { cost += NAV_WEIGHTS.foldStale; notes.push(`rests on a last-known record${a === null ? '' : ` ${a.toFixed(1)}s old`}; revalidate before committing`); }
    else notes.push('fold is open in the current observation');
    return { cost, support: stale ? 'remembered-fold' : 'observed-fold', caution: stale || state === 'unstable', notes, excludedBecause: null };
  }
  const unobserved = 1 - edge.observedCoverage;
  let cost = edge.length * NAV_WEIGHTS.distance + edge.length * NAV_WEIGHTS.unobservedPerUnit * unobserved - edge.length * NAV_WEIGHTS.trackDiscount * edge.trackSupport;
  cost = Math.max(cost, edge.length * 0.3);
  const notes: string[] = [];
  if (edge.constraints.length > 0) { cost += NAV_WEIGHTS.nearObstacle; notes.push(...edge.constraints); }
  if (edge.nearbyHazard) notes.push(`local hazard readings near the segment: up to ${edge.nearbyHazard.max.toFixed(2)} (${edge.nearbyHazard.readings} reading${edge.nearbyHazard.readings === 1 ? '' : 's'})`);
  const onTrack = edge.trackSupport >= 0.8;
  return { cost, support: onTrack ? 'recorded-track' : 'unverified-approach', caution: edge.constraints.length > 0 || (edge.nearbyHazard?.max ?? 0) >= 0.5, notes, excludedBecause: null };
}

/** Dijkstra over known places from the observer. Deterministic: ties break on node id. */
export function planRoute(graph: NavGraph, goalId: string, policy: NavPolicy = DEFAULT_POLICY, excluded: ReadonlySet<string> = new Set()): Route | null {
  const start = graph.nodes.find(n => n.kind === 'observer');
  if (!start || !graph.nodes.some(n => n.id === goalId) || goalId === start.id) return null;
  const out = new Map<string, { edge: NavEdge; to: string; a: EdgeAssessment }[]>();
  for (const e of graph.edges) {
    if (excluded.has(e.id)) continue;
    const a = assessEdge(e, graph, policy);
    if (a.cost === null) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push({ edge: e, to: e.to, a });
    if (!e.directed) (out.get(e.to) ?? out.set(e.to, []).get(e.to)!).push({ edge: e, to: e.from, a });
  }
  const best = new Map<string, number>([[start.id, 0]]);
  const prev = new Map<string, { node: string; edge: NavEdge; a: EdgeAssessment }>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    for (const [id, c] of best) if (!done.has(id) && (u === null || c < best.get(u)! || (c === best.get(u)! && id < u))) u = id;
    if (u === null) break;
    if (u === goalId) break;
    done.add(u);
    for (const { edge, to, a } of out.get(u) ?? []) {
      const c = best.get(u)! + a.cost!;
      if (!done.has(to) && (!best.has(to) || c < best.get(to)! - 1e-9)) { best.set(to, c); prev.set(to, { node: u, edge, a }); }
    }
  }
  if (!prev.has(goalId)) return null;
  const steps: { node: string; edge: NavEdge; a: EdgeAssessment }[] = [];
  for (let cur = goalId; cur !== start.id;) { const p = prev.get(cur)!; steps.push({ node: cur, edge: p.edge, a: p.a }); cur = p.node; }
  steps.reverse();
  const nodes = [start.id], segments: RouteSegment[] = [];
  let from = start.id;
  for (const s of steps) {
    segments.push({ edgeId: s.edge.id, from, to: s.node, kind: s.edge.kind, support: s.a.support, length: s.edge.length, cost: s.a.cost!, caution: s.a.caution, notes: s.a.notes });
    nodes.push(s.node); from = s.node;
  }
  const folds = steps.filter(s => s.edge.kind === 'fold-transition').map(s => ({ foldId: s.edge.id.replace(/^fold:/, ''), state: s.edge.foldState!, currentlyObserved: s.edge.currentlyObserved }));
  const ages = steps.map(s => age(graph, s.edge.verifiedAt)).filter((x): x is number => x !== null);
  return { nodes, segments, totalLength: segments.reduce((t, s) => t + s.length, 0), totalCost: segments.reduce((t, s) => t + s.cost, 0), foldDependencies: folds, oldestSupportAge: ages.length ? Math.max(...ages) : null };
}

/** The preferred route plus up to two alternatives that avoid one of its most expensive segments. */
export function planWithAlternatives(graph: NavGraph, goalId: string, policy: NavPolicy = DEFAULT_POLICY): { route: Route | null; alternatives: Route[] } {
  const route = planRoute(graph, goalId, policy);
  if (!route) return { route: null, alternatives: [] };
  const seen = new Set([route.nodes.join('>')]);
  const alternatives: Route[] = [];
  for (const seg of [...route.segments].sort((a, b) => b.cost - a.cost || (a.edgeId < b.edgeId ? -1 : 1)).slice(0, 2)) {
    const alt = planRoute(graph, goalId, policy, new Set([seg.edgeId]));
    if (alt && !seen.has(alt.nodes.join('>'))) { seen.add(alt.nodes.join('>')); alternatives.push(alt); }
  }
  return { route, alternatives };
}
