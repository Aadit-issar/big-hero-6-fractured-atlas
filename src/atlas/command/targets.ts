import type { GoalMotion, RouteMode } from '../../shared/liveLink';
import type { Estimate } from './forecast';
import type { Entity, Knowledge, Vec3 } from './world';

/** The destination catalogue: everything ATLAS has legitimately observed that Baymax could be sent to.
 * Nothing is listed that has not been acquired in this session; folds are listed with their observed state, never with an assumed destination. */

export type TargetClass = 'moving-object' | 'static-object' | 'island' | 'fold';
export type CatalogueFilter = 'all' | 'moving' | 'objects' | 'islands' | 'folds';

export interface NavTarget {
  readonly id: string;
  readonly label: string;
  readonly entityKind: Entity['kind'];
  readonly targetClass: TargetClass;
  readonly motion: GoalMotion;
  readonly knowledge: Knowledge;
  /** Current observed position, or the last-known position of a remembered entity. */
  readonly position: Vec3;
  /** Seconds since the entity was last observed (simulation time). */
  readonly age: number;
  readonly assetId: string | null;
  /** The strategy the planner will use for this target. */
  readonly mode: RouteMode;
  readonly speed: number | null;
  readonly constraints: readonly string[];
  readonly note: string;
}

const KIND_ORDER: Record<Entity['kind'], number> = { capsule: 0, equipment: 1, wreckage: 2, debris: 3, fold: 4, island: 5, swarm: 6 };

export function classify(entity: Entity, est: Estimate | undefined): TargetClass {
  if (entity.kind === 'island') return 'island';
  if (entity.kind === 'fold') return 'fold';
  return est?.motion === 'moving' ? 'moving-object' : 'static-object';
}

export function motionOf(est: Estimate | undefined): GoalMotion { return !est ? 'unknown' : est.motion; }

export function modeFor(entity: Entity, est: Estimate | undefined): RouteMode {
  if (entity.kind === 'fold') return 'entrance';
  if (entity.kind === 'island') return 'approach';
  if (est?.motion === 'moving') return est.ok ? 'intercept' : 'reconnaissance';
  return entity.knowledge === 'remembered' ? 'reconnaissance' : 'approach';
}

const MODE_TEXT: Record<RouteMode, string> = {
  intercept: 'Predict where it will be and meet it there',
  approach: 'Fly to an approach point beside it',
  entrance: 'Fly to the fold entrance',
  transit: 'Transit',
  reconnaissance: 'Last-known position only: approach and re-observe',
};

export function buildTargets(entities: readonly Entity[], now: number, estimates: ReadonlyMap<string, Estimate>): NavTarget[] {
  const out: NavTarget[] = [];
  for (const e of entities) {
    if (e.kind === 'swarm') continue;
    const est = estimates.get(e.id);
    const cls = classify(e, est);
    const constraints: string[] = [];
    let note = '';
    if (e.knowledge === 'remembered') { constraints.push(`Last observed ${Math.max(0, now - e.lastSeen).toFixed(0)} s ago; it may have moved.`); }
    if (e.kind === 'fold') {
      note = e.foldState === 'open' ? 'Entrance open. Where it leads is not observed.' : `Entrance ${e.foldState ?? 'state unknown'}. Where it leads is not observed.`;
      if (e.foldState && e.foldState !== 'open') constraints.push(`Currently ${e.foldState}: it may not be passable on arrival.`);
    } else if (e.kind === 'island') note = 'Plans an approach point above the island, not its centre.';
    else if (cls === 'moving-object') note = est?.ok ? `Moving at ${est.speed!.toFixed(1)} m/s; planned as an interception.` : 'Moving; not enough validated observations to forecast yet.';
    else note = est?.motion === 'static' ? 'Has not moved while observed.' : 'Too few observations to tell whether it moves.';
    out.push({
      id: e.id, label: e.label, entityKind: e.kind, targetClass: cls, motion: motionOf(est), knowledge: e.knowledge, position: e.position, age: Math.max(0, now - e.lastSeen), assetId: e.assetId,
      mode: modeFor(e, est), speed: est?.speed ?? null, constraints, note: `${MODE_TEXT[modeFor(e, est)]}. ${note}`.trim(),
    });
  }
  return out.sort((a, b) => KIND_ORDER[a.entityKind] - KIND_ORDER[b.entityKind] || a.age - b.age || (a.id < b.id ? -1 : 1));
}

export function filterTargets(targets: readonly NavTarget[], filter: CatalogueFilter, query: string): NavTarget[] {
  const q = query.trim().toLowerCase();
  return targets.filter(t => {
    if (filter === 'moving' && t.targetClass !== 'moving-object') return false;
    if (filter === 'objects' && t.targetClass !== 'moving-object' && t.targetClass !== 'static-object') return false;
    if (filter === 'islands' && t.targetClass !== 'island') return false;
    if (filter === 'folds' && t.targetClass !== 'fold') return false;
    return !q || t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.entityKind.includes(q);
  });
}

// ---------- Quick-target catalogue (tiers, featured selection, grouping, search) ----------
// The catalogue is a quick-target list, not the database: what matters is featured; categories are collapsed by default; generic debris is
// aggregated ("Concrete rubble x34"). All of it is a pure function of the targets, so it is tested without a browser.

export type CatalogueTier = 'mission' | 'equipment' | 'structure' | 'debris';
export type CategoryId = 'mission' | 'islands' | 'folds' | 'moving' | 'equipment' | 'all';

export interface RankContext {
  readonly baymax: Vec3 | null;
  readonly selectedId: string | null;
  /** Most recent first. */
  readonly recentIds: readonly string[];
  /** The destination of an active route, if any. */
  readonly routeTargetId?: string | null;
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function tierOf(t: NavTarget): CatalogueTier {
  if (t.entityKind === 'capsule') return 'mission';
  if (t.entityKind === 'equipment') return 'equipment';
  if (t.entityKind === 'island' || t.entityKind === 'fold') return 'structure';
  return 'debris';
}

/** Importance of a target for a quick-target list. Mission objects dominate, then moving things and Baymax equipment, then structure, then debris;
 * nearness adds a bounded bonus and a remembered (not currently observed) target loses a little. */
export function importance(t: NavTarget, ctx: Pick<RankContext, 'baymax'>): number {
  const tier = tierOf(t);
  let s = tier === 'mission' ? (t.targetClass === 'moving-object' ? 100 : 35) : tier === 'equipment' ? 40 : tier === 'structure' ? 25 : 4;
  if (t.targetClass === 'moving-object') s += tier === 'debris' ? 20 : 30;
  if (t.entityKind === 'fold' && t.constraints.length === 0) s += 15;
  if (t.knowledge === 'remembered') s -= 8;
  if (ctx.baymax) s += 20 * Math.exp(-dist3(t.position, ctx.baymax) / 80);
  return s;
}

export interface FeaturedTarget { readonly target: NavTarget; readonly reason: string }

export function featuredTargets(targets: readonly NavTarget[], ctx: RankContext, max = 8): FeaturedTarget[] {
  const out: FeaturedTarget[] = [];
  const seen = new Set<string>();
  const add = (t: NavTarget | undefined, reason: string) => { if (t && !seen.has(t.id) && out.length < max) { seen.add(t.id); out.push({ target: t, reason }); } };
  const near = (t: NavTarget) => (ctx.baymax ? dist3(t.position, ctx.baymax) : 0);
  const byImportance = (a: NavTarget, b: NavTarget) => importance(b, ctx) - importance(a, ctx) || (a.id < b.id ? -1 : 1);
  const live = (list: NavTarget[]) => { const c = list.filter(t => t.knowledge === 'current'); return c.length ? c : list; };
  targets.filter(t => tierOf(t) === 'mission').sort(byImportance).slice(0, 2).forEach(t => add(t, 'Mission objective'));
  if (ctx.routeTargetId) add(targets.find(t => t.id === ctx.routeTargetId), 'Active route');
  targets.filter(t => tierOf(t) === 'equipment').sort(byImportance).slice(0, 2).forEach(t => add(t, 'Baymax equipment'));
  add(live(targets.filter(t => t.entityKind === 'island')).sort((a, b) => near(a) - near(b))[0], 'Nearest island');
  const folds = targets.filter(t => t.entityKind === 'fold');
  add(live(folds.filter(t => t.constraints.length === 0)).sort((a, b) => near(a) - near(b))[0] ?? live(folds).sort((a, b) => near(a) - near(b))[0], 'Nearest fold');
  for (const id of ctx.recentIds.slice(0, 3)) add(targets.find(t => t.id === id), 'Recent');
  if (ctx.selectedId) add(targets.find(t => t.id === ctx.selectedId), 'Selected');
  return out;
}

/** The label with a trailing variant suffix ("a", "b", "03") removed: "Concrete chunk a" and "Concrete chunk b" are the same kind of thing. */
export function stemOf(t: NavTarget): string {
  if (t.entityKind === 'wreckage') return 'Concrete rubble';
  return t.label.replace(/[\s-]+(?:[a-z]|\d+)$/i, '').trim() || t.label;
}

export type CatalogueItem =
  | { readonly kind: 'single'; readonly target: NavTarget }
  | { readonly kind: 'group'; readonly key: string; readonly label: string; readonly count: number; readonly members: readonly NavTarget[]; readonly containsSelected: boolean };

/** Collapse runs of three or more static, same-kind targets into one row ("Concrete rubble x34"); moving, island, fold and mission targets stay individual. */
export function aggregate(targets: readonly NavTarget[], selectedId: string | null = null, minGroup = 3): CatalogueItem[] {
  const groupable = (t: NavTarget) => t.targetClass === 'static-object' && (tierOf(t) !== 'structure');
  const keyOf = (t: NavTarget) => `${t.entityKind}:${stemOf(t)}`;
  const buckets = new Map<string, NavTarget[]>();
  for (const t of targets) if (groupable(t)) { const k = keyOf(t); const list = buckets.get(k); if (list) list.push(t); else buckets.set(k, [t]); }
  const items: CatalogueItem[] = [];
  const emitted = new Set<string>();
  for (const t of targets) {
    const members = groupable(t) ? buckets.get(keyOf(t)) : undefined;
    if (members && members.length >= minGroup) {
      const key = keyOf(t);
      if (emitted.has(key)) continue;
      emitted.add(key);
      items.push({ kind: 'group', key, label: `${stemOf(t)} ×${members.length}`, count: members.length, members, containsSelected: members.some(m => m.id === selectedId) });
    } else items.push({ kind: 'single', target: t });
  }
  return items;
}

export interface CatalogueCategory { readonly id: CategoryId; readonly label: string; readonly count: number; readonly items: readonly CatalogueItem[] }

const CATEGORY_LABEL: Record<CategoryId, string> = { mission: 'Mission objects', islands: 'Islands', folds: 'Folds', moving: 'Moving objects', equipment: 'Equipment', all: 'All scanned objects' };
const CATEGORY_TEST: Record<CategoryId, (t: NavTarget) => boolean> = {
  mission: t => tierOf(t) === 'mission',
  islands: t => t.entityKind === 'island',
  folds: t => t.entityKind === 'fold',
  moving: t => t.targetClass === 'moving-object',
  equipment: t => tierOf(t) === 'equipment',
  all: t => t.entityKind !== 'island' && t.entityKind !== 'fold',
};

/** Categories with counts; empty categories are dropped. Each category is ranked by importance (nearest first within a tier). */
export function categorise(targets: readonly NavTarget[], ctx: RankContext, opts: { liveOnly?: boolean } = {}): CatalogueCategory[] {
  const pool = opts.liveOnly ? targets.filter(t => t.knowledge === 'current') : targets;
  const rank = (a: NavTarget, b: NavTarget) => importance(b, ctx) - importance(a, ctx) || (a.id < b.id ? -1 : 1);
  return (Object.keys(CATEGORY_LABEL) as CategoryId[]).map(id => {
    const list = pool.filter(CATEGORY_TEST[id]).sort(rank);
    return { id, label: CATEGORY_LABEL[id], count: list.length, items: aggregate(list, ctx.selectedId) };
  }).filter(c => c.count > 0);
}

/** Flat ranked search: prefix matches first, then word and substring matches; ids and the kind are searchable. Aggregation is not applied: a search names things. */
export function searchTargets(targets: readonly NavTarget[], query: string, ctx: Pick<RankContext, 'baymax'>, limit = 40): NavTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const score = (t: NavTarget): number => {
    const label = t.label.toLowerCase();
    if (label.startsWith(q)) return 3;
    if (label.split(/\s+/).some(w => w.startsWith(q))) return 2;
    if (label.includes(q) || t.id.toLowerCase().includes(q) || t.entityKind.includes(q)) return 1;
    return 0;
  };
  return targets.map(t => ({ t, s: score(t) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || importance(b.t, ctx) - importance(a.t, ctx) || (a.t.id < b.t.id ? -1 : 1)).slice(0, limit).map(x => x.t);
}
