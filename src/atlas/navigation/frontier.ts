import type { WorldVec3 } from '../../shared/atlasContract';
import { dist } from './knowledgeGraph';
import { DEFAULT_POLICY } from './types';
import type { Frontier, NavGraph, NavNode, NavPolicy } from './types';

/** Scoring terms for the observation-priority heuristic. These rank where to look next; they are not an information-gain model. */
export const FRONTIER_WEIGHTS = {
  refreshBase: 40, refreshPerAgeSecond: 0.5, refreshAgeCap: 60,
  exitBase: 35, coverageBase: 20, coveragePerNeighbour: 4, coverageNeighbourCap: 4,
  /** Penalty per unit of distance from the observer. */
  perDistance: 0.2,
  /** Bonus when the candidate lies toward the selected goal. */
  towardGoal: 15,
} as const;

const unit = (a: WorldVec3, b: WorldVec3): WorldVec3 => { const d = dist(a, b) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d]; };
const step = (p: WorldVec3, dir: WorldVec3, d: number): WorldVec3 => [p[0] + dir[0] * d, p[1] + dir[1] * d, p[2] + dir[2] * d];
const AXES: readonly WorldVec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Observation priorities: places where knowledge is stale, a reported endpoint is unexplored, or recorded coverage ends.
 * With no recorded observations there are no frontiers. Positions are only ever offsets from recorded positions. */
export function findFrontiers(graph: NavGraph, goalPosition: WorldVec3 | null, policy: NavPolicy = DEFAULT_POLICY): Frontier[] {
  const observer = graph.nodes.find(n => n.kind === 'observer');
  if (!observer || graph.coveragePoints.length === 0) return [];
  const W = FRONTIER_WEIGHTS;
  const out: Frontier[] = [];
  const toward = (target: WorldVec3) => (goalPosition && dist(target, goalPosition) + 10 < dist(observer.position, goalPosition) ? W.towardGoal : 0);
  const ageOf = (n: NavNode) => (graph.simTime === null ? 0 : Math.max(0, graph.simTime - n.lastSeenAt));
  const reach = graph.sceneScanRange;

  // 1. Stale knowledge: a remembered place can be re-observed by moving within sensor reach of its last-known position.
  for (const n of graph.nodes) {
    if (n.kind === 'observer' || n.kind === 'fold-exit' || n.status !== 'remembered') continue;
    const d = dist(observer.position, n.position), standoff = Math.min(d, reach * 0.5);
    const target = d <= standoff ? n.position : step(n.position, unit(n.position, observer.position), standoff);
    const a = ageOf(n);
    const reasons = [`last observed at t ${n.lastSeenAt.toFixed(2)}s (${a.toFixed(1)}s ago); it is a last-known record only`];
    if (a > policy.staleAfter) reasons.push(`older than the ${policy.staleAfter}s freshness policy`);
    const edge = graph.edges.find(e => e.kind === 'fold-transition' && (e.from === n.id || e.to === n.id));
    if (edge) reasons.push(`recorded fold state: ${edge.foldState}; a route through it would need revalidation`);
    out.push({ id: `refresh:${n.id}`, kind: 'refresh-stale', label: `Re-observe ${n.label}`, target, score: W.refreshBase + Math.min(a, W.refreshAgeCap) * W.refreshPerAgeSecond - dist(observer.position, target) * W.perDistance + toward(target), distance: dist(observer.position, target), reasons, refs: n.evidence });
  }

  // 2. A sensor-reported fold exit that has never been explored independently.
  for (const n of graph.nodes) {
    if (n.kind !== 'fold-exit') continue;
    const edge = graph.edges.find(e => e.to === n.id && e.kind === 'fold-transition');
    if (edge && (edge.foldState === 'closed' || edge.foldState === 'inactive')) continue;
    out.push({ id: `exit:${n.id}`, kind: 'unexplored-exit', label: `Observe near ${n.label}`, target: n.position, score: W.exitBase - dist(observer.position, n.position) * W.perDistance + toward(n.position), distance: dist(observer.position, n.position), reasons: ['the sensor reports this endpoint, but nothing there has been observed', 'ATLAS does not know what lies beyond the fold'], refs: n.evidence });
  }

  // 3. Coverage edge: space adjacent to recorded observer positions that no recorded position has covered.
  const cells = new Map<string, { target: WorldVec3; neighbours: number }>();
  const points = graph.coveragePoints.length <= 120 ? graph.coveragePoints : graph.coveragePoints.filter((_, i) => i % Math.ceil(graph.coveragePoints.length / 120) === 0);
  for (const p of points) {
    for (const axis of AXES) {
      const target = step(p, axis, reach * 0.9);
      if (graph.coveragePoints.some(q => dist(q, target) < reach * 0.75)) continue;
      const key = target.map(v => Math.round(v / 30)).join(',');
      const c = cells.get(key);
      if (c) c.neighbours += 1; else cells.set(key, { target, neighbours: 1 });
    }
  }
  for (const [key, c] of [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({
      id: `edge:${key}`, kind: 'coverage-edge', label: 'Scan beyond the observed boundary', target: c.target,
      score: W.coverageBase + Math.min(c.neighbours, W.coverageNeighbourCap) * W.coveragePerNeighbour - dist(observer.position, c.target) * W.perDistance + toward(c.target),
      distance: dist(observer.position, c.target),
      reasons: ['no recorded observer position has covered this space', `it lies ${(reach * 0.9).toFixed(0)} units beyond ${c.neighbours} recorded position${c.neighbours === 1 ? '' : 's'}`], refs: [],
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, 6);
}
