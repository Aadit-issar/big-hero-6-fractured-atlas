import type { WorldVec3 } from '../../shared/atlasContract';
import type { AtlasView } from '../core/runtime';
import type { SceneKnowledge } from '../live/knowledge';
import { DEFAULT_POLICY } from './types';
import type { Goal, NavEdge, NavGraph, NavNode, NavPolicy } from './types';

/** The minimal slice of ATLAS knowledge navigation may read. It is a subset of a knowledge snapshot. */
export interface NavigationKnowledge {
  readonly view: Pick<AtlasView, 'mapping' | 'observation'>;
  readonly scene: SceneKnowledge;
  /** Live episode (or 0 for the replay and isolated sources). Records never carry across episodes. */
  readonly episode: number;
}

export const dist = (a: WorldVec3, b: WorldVec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function pointToSegment(p: WorldVec3, a: WorldVec3, b: WorldVec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / len2));
  return Math.hypot(p[0] - (a[0] + ab[0]! * t), p[1] - (a[1] + ab[1]! * t), p[2] - (a[2] + ab[2]! * t));
}

const SAMPLES = 14;
const lerp = (a: WorldVec3, b: WorldVec3, t: number): WorldVec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Builds the navigation graph from knowledge only. Every node and edge cites the records that support it, and no node exists
 * for anything ATLAS has not observed or been told by a scan. Free-flight edges are *candidates*: geometry between known places. */
export function buildNavGraph(k: NavigationKnowledge, policy: NavPolicy = DEFAULT_POLICY): NavGraph {
  const m = k.view.mapping;
  const sensorRange = k.view.observation?.sensorRange ?? 60;
  const scans = k.scene.scans;
  const sceneScanRange = scans.at(-1)?.range ?? 45;
  const nodes: NavNode[] = [];

  if (m.explorer.latestPosition && m.explorer.lastSeenAt !== null) {
    nodes.push({ id: 'observer', kind: 'observer', label: 'Baymax', position: m.explorer.latestPosition, status: 'current', source: 'sensor', lastSeenAt: m.explorer.lastSeenAt, evidence: ['explorer'], independentlyObserved: true });
  }
  for (const i of m.islands) {
    nodes.push({ id: i.id, kind: 'island', label: i.id, position: i.currentPosition ?? i.lastKnownPosition, status: i.currentlyObserved ? 'current' : 'remembered', source: 'sensor', lastSeenAt: i.lastSeenAt, evidence: [i.id], independentlyObserved: true });
  }
  for (const f of m.folds) {
    nodes.push({ id: `${f.id}:entry`, kind: 'fold-entry', label: `${f.id} entry`, position: f.currentEntryPosition ?? f.lastKnownEntryPosition, status: f.currentlyObserved ? 'current' : 'remembered', source: 'sensor', lastSeenAt: f.lastSeenAt, evidence: [f.id], independentlyObserved: true });
    nodes.push({ id: `${f.id}:exit`, kind: 'fold-exit', label: `${f.id} reported exit`, position: f.currentExitPosition ?? f.lastKnownExitPosition, status: f.currentlyObserved ? 'current' : 'remembered', source: 'sensor', lastSeenAt: f.lastSeenAt, evidence: [f.id], independentlyObserved: false });
  }
  for (const c of k.scene.clusters) {
    nodes.push({ id: c.id, kind: 'landmark', label: c.label, position: c.centre, status: c.currentlyObserved > 0 ? 'current' : 'remembered', source: 'scene-scan', lastSeenAt: c.lastSeenAt, evidence: c.memberIds.slice(0, 6), independentlyObserved: true });
  }

  const coveragePoints = coverage(k);
  const scanPoints = scans.map(s => s.observerPosition);
  const track = m.explorer.track;
  const edges: NavEdge[] = [];

  // Fold transitions: sensor-reported entry to exit, directed. The reverse is not offered.
  for (const f of m.folds) {
    const a = f.currentEntryPosition ?? f.lastKnownEntryPosition, b = f.currentExitPosition ?? f.lastKnownExitPosition;
    edges.push({
      id: `fold:${f.id}`, kind: 'fold-transition', from: `${f.id}:entry`, to: `${f.id}:exit`, directed: true, length: dist(a, b), foldState: f.currentState ?? f.lastObservedState,
      verifiedAt: f.lastSeenAt, currentlyObserved: f.currentlyObserved, observedCoverage: 0, trackSupport: 0, nearbyHazard: null,
      constraints: [],
      unknowns: ['direction of traversal is reported by the sensor but not independently verified', 'the far endpoint region has not been explored', 'future availability of the fold is not predicted'],
      evidence: [f.id],
    });
  }

  // Free-flight candidates between known places.
  const connectable = nodes.filter(n => n.kind !== 'observer' || true);
  const pairs = new Map<string, [NavNode, NavNode]>();
  const add = (a: NavNode, b: NavNode) => { if (a.id === b.id) return; const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`; if (!pairs.has(key) && dist(a.position, b.position) <= policy.maxFreeFlight) pairs.set(key, a.id < b.id ? [a, b] : [b, a]); };
  for (const a of connectable) {
    const near = connectable.filter(b => b.id !== a.id).sort((x, y) => dist(a.position, x.position) - dist(a.position, y.position) || (x.id < y.id ? -1 : 1)).slice(0, policy.neighbours);
    for (const b of near) add(a, b);
  }
  const observer = nodes.find(n => n.kind === 'observer');
  if (observer) for (const b of connectable) add(observer, b);
  // A fold's own entry and exit are joined by the fold edge, not by free flight.
  for (const f of m.folds) pairs.delete(`${f.id}:entry|${f.id}:exit`);

  for (const [key, [a, b]] of [...pairs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const length = dist(a.position, b.position);
    let covered = 0, onTrack = 0;
    for (let s = 0; s <= SAMPLES; s += 1) {
      const p = lerp(a.position, b.position, s / SAMPLES);
      if (scanPoints.some(q => dist(p, q) <= sceneScanRange)) covered += 1;
      if (nearTrack(p, track, 6)) onTrack += 1;
    }
    const hazards = m.environment.filter(e => pointToSegment(e.observerWorldPosition, a.position, b.position) <= 12);
    const constraints: string[] = [];
    for (const r of k.scene.records) {
      const d = pointToSegment(r.lastKnownPosition, a.position, b.position);
      if (d <= r.radius + 3 && constraints.length < 4) constraints.push(`passes within ${d.toFixed(1)} units of ${r.kind.replace(/_/g, ' ')} (${r.id})${r.currentlyObserved ? '' : ', last-known position'}`);
    }
    for (const n of nodes) {
      if ((n.kind === 'island') && n.id !== a.id && n.id !== b.id && pointToSegment(n.position, a.position, b.position) <= 14) constraints.push(`passes near ${n.label} (island extent is not measured)`);
    }
    const coverageFraction = covered / (SAMPLES + 1);
    const unknowns = ['clearance beyond the acquired scene objects is unverified', 'hazard between local readings is not sampled'];
    if (scanPoints.length === 0) unknowns.push('no scene-object scan has covered this region');
    else if (coverageFraction < 1) unknowns.push(`${Math.round((1 - coverageFraction) * 100)}% of the segment lies outside recorded scan coverage`);
    if (!b.independentlyObserved || !a.independentlyObserved) unknowns.push('a reported fold endpoint has not been explored');
    edges.push({
      id: `ff:${key}`, kind: 'free-flight', from: a.id, to: b.id, directed: false, length, foldState: null, verifiedAt: null,
      currentlyObserved: a.status === 'current' && b.status === 'current', observedCoverage: coverageFraction, trackSupport: onTrack / (SAMPLES + 1),
      nearbyHazard: hazards.length ? { max: Math.max(...hazards.map(h => h.hazard)), readings: hazards.length } : null,
      constraints, unknowns, evidence: [...a.evidence.slice(0, 1), ...b.evidence.slice(0, 1)],
    });
  }
  return { episode: k.episode, simTime: m.latestSimulationTime, nodes, edges, sensorRange, sceneScanRange, coveragePoints };
}

function nearTrack(p: WorldVec3, track: readonly { readonly position: WorldVec3; readonly breakBefore: boolean }[], radius: number): boolean {
  for (let i = 0; i < track.length; i += 1) {
    const t = track[i]!;
    if (dist(p, t.position) <= radius) return true;
    const prev = track[i - 1];
    if (prev && !t.breakBefore && pointToSegment(p, prev.position, t.position) <= radius) return true;
  }
  return false;
}

/** Places where ATLAS has taken readings: recorded observer positions (deduplicated, bounded). */
function coverage(k: NavigationKnowledge): WorldVec3[] {
  const seen = new Set<string>(), out: WorldVec3[] = [];
  const push = (p: WorldVec3) => { const key = p.map(v => Math.round(v / 2)).join(','); if (!seen.has(key)) { seen.add(key); out.push(p); } };
  for (const t of k.view.mapping.explorer.track) push(t.position);
  for (const e of k.view.mapping.environment) push(e.observerWorldPosition);
  for (const s of k.scene.scans) push(s.observerPosition);
  const cap = 400;
  return out.length <= cap ? out : out.filter((_, i) => i % Math.ceil(out.length / cap) === 0);
}

/** Known places a user may select as a destination. Only recorded entities appear; there are no invented targets. */
export function listGoals(graph: NavGraph): Goal[] {
  return graph.nodes.filter(n => n.kind !== 'observer').map(n => ({ id: n.id, label: n.label, kind: n.kind, position: n.position, status: n.status }))
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));
}
