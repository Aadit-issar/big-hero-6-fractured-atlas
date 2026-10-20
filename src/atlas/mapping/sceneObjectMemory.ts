import type { SceneCategory, SceneFamily, SceneObjectObservation, SceneScan, Vec3Tuple } from '../live/protocol';

/** Memory of scene objects acquired by proximity scans. It is additive to the Phase 1-3 exploration memory:
 * these records come from the scene-object scanner (category B), never from the sensor contract (category A).
 * Nothing is ever created from a registry; a record exists only because a scan reported it. */

export type SceneKnowledge = 'currently-observed' | 'previously-observed';

export interface SceneObjectRecord {
  readonly id: string;
  readonly category: SceneCategory;
  readonly family: SceneFamily;
  readonly kind: string;
  readonly radius: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly firstScanId: number;
  readonly lastScanId: number;
  readonly lastKnownPosition: Vec3Tuple;
  readonly currentlyObserved: boolean;
  readonly knowledgeStatus: SceneKnowledge;
  readonly observationCount: number;
  readonly lastRange: number;
  /** Largest displacement between any two reported positions; non-zero only if the scene moved the object. */
  readonly maxReportedShift: number;
}

export type SceneEventKind = 'scene-objects-acquired' | 'scene-objects-refreshed' | 'scene-objects-left' | 'scene-scan-empty' | 'scene-scan-unchanged' | 'scene-object-moved';
export interface SceneMemoryEvent {
  readonly kind: SceneEventKind;
  readonly simulationTime: number;
  readonly scanId: number;
  readonly message: string;
  /** Ids involved, capped for display. */
  readonly ids: readonly string[];
  readonly counts: { readonly acquired: number; readonly refreshed: number; readonly left: number; readonly inRange: number };
}

export interface SceneScanSummary {
  readonly scanId: number;
  readonly time: number;
  readonly trigger: SceneScan['trigger'];
  readonly inRange: number;
  readonly omitted: number;
  readonly acquired: number;
  readonly refreshed: number;
  readonly left: number;
  readonly observerPosition: Vec3Tuple;
  readonly range: number;
}

export interface SceneCluster {
  readonly id: string;
  readonly group: ClusterGroup;
  readonly label: string;
  readonly count: number;
  readonly currentlyObserved: number;
  readonly remembered: number;
  readonly centre: Vec3Tuple;
  readonly extent: number;
  readonly lastSeenAt: number;
  readonly composition: Readonly<Record<string, number>>;
  readonly memberIds: readonly string[];
  /** Always true: a cluster describes acquired objects only, never the whole field. */
  readonly partial: true;
}

export type ClusterGroup = 'concrete' | 'industrial' | 'baymax' | 'capsule' | 'microbot';
const GROUP_OF: Record<SceneFamily, ClusterGroup> = { concrete: 'concrete', industrial: 'industrial', baymax: 'baymax', capsule: 'capsule', microbot: 'microbot' };
const GROUP_LABEL: Record<ClusterGroup, string> = {
  concrete: 'Concrete debris field', industrial: 'Industrial wreckage cluster', baymax: 'Armour fragment scatter', capsule: 'Capsule wreckage', microbot: 'Microbot formation',
};
export const CLUSTER_CELL = 14;
export const MIN_CLUSTER_SIZE = 3;

const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class SceneObjectMemory {
  private records = new Map<string, SceneObjectRecord>();
  private scans: SceneScanSummary[] = [];
  private lastScanId = -1;
  private lastScanTime = -Infinity;

  reset(): void { this.records = new Map(); this.scans = []; this.lastScanId = -1; this.lastScanTime = -Infinity; }

  /** Ingests one scan. Scans must arrive with strictly increasing ids; a repeat is ignored. */
  update(scan: SceneScan): SceneMemoryEvent[] {
    if (scan.scanId <= this.lastScanId) return [];
    this.lastScanId = scan.scanId;
    const seen = new Set<string>();
    const acquired: string[] = [], refreshed: string[] = [], moved: string[] = [];
    for (const o of scan.objects) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const prev = this.records.get(o.id);
      if (!prev) {
        acquired.push(o.id);
        this.records.set(o.id, this.fresh(o, scan));
      } else {
        refreshed.push(o.id);
        const shift = dist(prev.lastKnownPosition, o.position);
        if (shift > 0.5) moved.push(o.id);
        this.records.set(o.id, {
          ...prev, kind: o.kind, radius: o.radius, lastSeenAt: scan.time, lastScanId: scan.scanId, lastKnownPosition: o.position, currentlyObserved: true,
          knowledgeStatus: 'currently-observed', observationCount: prev.observationCount + 1, lastRange: o.range, maxReportedShift: Math.max(prev.maxReportedShift, shift),
        });
      }
    }
    // Objects that were current but are not in this scan: out of range (remembered), unless the per-scan cap
    // omitted in-range objects, in which case absence is not evidence and their status is left unchanged.
    const left: string[] = [];
    for (const [id, r] of this.records) {
      if (seen.has(id) || !r.currentlyObserved) continue;
      const couldBeOmitted = scan.omitted > 0 && dist(r.lastKnownPosition, scan.observerPosition) <= scan.range;
      if (couldBeOmitted) continue;
      left.push(id);
      this.records.set(id, { ...r, currentlyObserved: false, knowledgeStatus: 'previously-observed' });
    }
    const summary: SceneScanSummary = {
      scanId: scan.scanId, time: scan.time, trigger: scan.trigger, inRange: scan.objects.length + scan.omitted, omitted: scan.omitted,
      acquired: acquired.length, refreshed: refreshed.length, left: left.length, observerPosition: scan.observerPosition, range: scan.range,
    };
    this.scans.push(summary);
    if (this.scans.length > 64) this.scans.shift();
    this.lastScanTime = scan.time;
    return this.events(scan, summary, acquired, refreshed, left, moved);
  }

  private fresh(o: SceneObjectObservation, scan: SceneScan): SceneObjectRecord {
    return {
      id: o.id, category: o.category, family: o.family, kind: o.kind, radius: o.radius, firstSeenAt: scan.time, lastSeenAt: scan.time, firstScanId: scan.scanId, lastScanId: scan.scanId,
      lastKnownPosition: o.position, currentlyObserved: true, knowledgeStatus: 'currently-observed', observationCount: 1, lastRange: o.range, maxReportedShift: 0,
    };
  }

  private events(scan: SceneScan, s: SceneScanSummary, acquired: string[], refreshed: string[], left: string[], moved: string[]): SceneMemoryEvent[] {
    const counts = { acquired: acquired.length, refreshed: refreshed.length, left: left.length, inRange: s.inRange };
    const base = { simulationTime: scan.time, scanId: scan.scanId, counts };
    const out: SceneMemoryEvent[] = [];
    if (acquired.length > 0) out.push({ ...base, kind: 'scene-objects-acquired', ids: acquired.slice(0, 12), message: `${plural(acquired.length, 'new scene object')} acquired within ${scan.range.toFixed(0)} units of the observer.` });
    if (moved.length > 0) out.push({ ...base, kind: 'scene-object-moved', ids: moved.slice(0, 12), message: `${plural(moved.length, 'object')} reported at a different position than previously recorded.` });
    if (left.length > 0) out.push({ ...base, kind: 'scene-objects-left', ids: left.slice(0, 12), message: `${plural(left.length, 'object')} left scan range and ${left.length === 1 ? 'is' : 'are'} now remembered as last-known.` });
    if (acquired.length === 0 && left.length === 0 && moved.length === 0) {
      out.push(scan.objects.length === 0
        ? { ...base, kind: 'scene-scan-empty', ids: [], message: 'No scene objects within scan range.' }
        : { ...base, kind: 'scene-scan-unchanged', ids: [], message: `No new scene objects acquired. ${plural(refreshed.length, 'existing record')} refreshed.` });
    }
    return out;
  }

  read(): { readonly records: readonly SceneObjectRecord[]; readonly scans: readonly SceneScanSummary[]; readonly lastScanTime: number | null } {
    return { records: [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), scans: [...this.scans], lastScanTime: Number.isFinite(this.lastScanTime) ? this.lastScanTime : null };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Spatial aggregation of acquired records: same-group objects connected through neighbouring grid cells form a
 * cluster once at least MIN_CLUSTER_SIZE members exist. The capsule group is always reported (never hidden in a
 * larger cluster) because a single landmark piece is meaningful on its own. */
export function deriveClusters(records: readonly SceneObjectRecord[]): SceneCluster[] {
  const byGroup = new Map<ClusterGroup, SceneObjectRecord[]>();
  for (const r of records) {
    const g = GROUP_OF[r.family];
    const list = byGroup.get(g) ?? [];
    list.push(r);
    byGroup.set(g, list);
  }
  const clusters: SceneCluster[] = [];
  for (const [group, members] of byGroup) {
    const cell = (r: SceneObjectRecord) => r.lastKnownPosition.map(v => Math.floor(v / CLUSTER_CELL)) as [number, number, number];
    const parent = members.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
    const index = new Map<string, number[]>();
    members.forEach((m, i) => { const key = cell(m).join(','); (index.get(key) ?? index.set(key, []).get(key)!).push(i); });
    members.forEach((m, i) => {
      const [cx, cy, cz] = cell(m);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
        for (const j of index.get(`${cx! + dx},${cy! + dy},${cz! + dz}`) ?? []) if (j !== i && dist(m.lastKnownPosition, members[j]!.lastKnownPosition) <= CLUSTER_CELL) parent[find(i)] = find(j);
      }
    });
    const comps = new Map<number, SceneObjectRecord[]>();
    members.forEach((m, i) => { const root = find(i); (comps.get(root) ?? comps.set(root, []).get(root)!).push(m); });
    for (const comp of comps.values()) {
      if (comp.length < MIN_CLUSTER_SIZE && group !== 'capsule') continue;
      const centre: [number, number, number] = [0, 0, 0];
      for (const m of comp) for (let k = 0; k < 3; k += 1) centre[k]! += m.lastKnownPosition[k]! / comp.length;
      const extent = Math.max(...comp.map(m => dist(centre, m.lastKnownPosition) + m.radius));
      const composition: Record<string, number> = {};
      for (const m of comp) composition[m.category] = (composition[m.category] ?? 0) + 1;
      const ids = comp.map(m => m.id).sort();
      clusters.push({
        id: `cluster-${group}-${ids[0]}`, group, label: GROUP_LABEL[group], count: comp.length, currentlyObserved: comp.filter(m => m.currentlyObserved).length,
        remembered: comp.filter(m => !m.currentlyObserved).length, centre, extent, lastSeenAt: Math.max(...comp.map(m => m.lastSeenAt)), composition, memberIds: ids, partial: true,
      });
    }
  }
  return clusters.sort((a, b) => (a.id < b.id ? -1 : 1));
}
