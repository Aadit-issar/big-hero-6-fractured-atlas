import { describe, expect, it } from 'vitest';
import { aggregate, categorise, featuredTargets, importance, searchTargets, stemOf, tierOf } from '../src/atlas/command/targets';
import type { NavTarget, RankContext } from '../src/atlas/command/targets';
import { isRepeatedNote } from '../src/atlas/command/session';
import type { LogEntry } from '../src/atlas/command/session';

function target(id: string, label: string, entityKind: NavTarget['entityKind'], over: Partial<NavTarget> = {}): NavTarget {
  const targetClass: NavTarget['targetClass'] = entityKind === 'island' ? 'island' : entityKind === 'fold' ? 'fold' : 'static-object';
  return { id, label, entityKind, targetClass, motion: 'static', knowledge: 'current', position: [0, 0, 0], age: 0, assetId: null, mode: 'approach', speed: null, constraints: [], note: '', ...over };
}
const bay: RankContext = { baymax: [0, 0, 0], selectedId: null, recentIds: [] };
const world = (): NavTarget[] => [
  target('capsule-abigail', "Abigail's Capsule", 'capsule', { targetClass: 'moving-object', motion: 'moving', mode: 'intercept', position: [40, 0, 0] }),
  target('armour-chest', 'Baymax chest armour', 'equipment', { targetClass: 'moving-object', motion: 'moving', position: [20, 0, 0] }),
  target('armour-shoulder', 'Baymax shoulder armour', 'equipment', { targetClass: 'moving-object', motion: 'moving', position: [30, 0, 0] }),
  target('shard-a', 'Baymax plating shard a', 'equipment', { position: [10, 0, 0] }),
  target('shard-b', 'Baymax plating shard b', 'equipment', { position: [12, 0, 0] }),
  target('shard-c', 'Baymax plating shard c', 'equipment', { position: [14, 0, 0] }),
  target('island-01', 'Floating Island 01', 'island', { position: [60, 0, 0] }),
  target('island-02', 'Floating Island 02', 'island', { position: [20, 0, 0] }),
  target('fold-1', 'Fold F01', 'fold', { position: [90, 0, 0], mode: 'entrance' }),
  target('fold-2', 'Fold F02', 'fold', { position: [30, 0, 0], mode: 'entrance' }),
  ...Array.from({ length: 34 }, (_, i) => target(`rubble-${i}`, `Concrete ${i % 2 ? 'chunk' : 'rubble cluster'} ${String.fromCharCode(97 + (i % 3))}`, 'wreckage', { position: [5 + i, 0, 0] })),
  target('girder', 'Industrial girder', 'debris', { position: [50, 0, 0] }),
];

describe('catalogue tiers and importance', () => {
  it('ranks mission objects, then equipment, then structure, then debris', () => {
    const t = world();
    const get = (id: string) => t.find(x => x.id === id)!;
    expect(tierOf(get('capsule-abigail'))).toBe('mission');
    expect(importance(get('capsule-abigail'), bay)).toBeGreaterThan(importance(get('armour-chest'), bay));
    expect(importance(get('armour-chest'), bay)).toBeGreaterThan(importance(get('island-02'), bay));
    expect(importance(get('island-02'), bay)).toBeGreaterThan(importance(get('rubble-0'), bay));
  });
  it('a remembered target ranks below the same target observed now', () => {
    const live = target('a', 'A', 'island'), old = target('a', 'A', 'island', { knowledge: 'remembered', age: 30 });
    expect(importance(old, bay)).toBeLessThan(importance(live, bay));
  });
});

describe('featured selection', () => {
  it('features the mission object, moving equipment, nearest island and fold; never rubble', () => {
    const f = featuredTargets(world(), bay);
    const ids = f.map(x => x.target.id);
    expect(ids[0]).toBe('capsule-abigail');
    expect(ids).toContain('armour-chest');
    expect(ids).toContain('armour-shoulder');
    expect(ids).toContain('island-02');
    expect(ids).toContain('fold-2');
    expect(ids.some(id => id.startsWith('rubble'))).toBe(false);
    expect(f.length).toBeLessThanOrEqual(8);
  });
  it('adds the selection and recents once, and respects the cap', () => {
    const f = featuredTargets(world(), { ...bay, selectedId: 'rubble-3', recentIds: ['island-01', 'rubble-3', 'girder'] });
    const ids = f.map(x => x.target.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('island-01');
    expect(ids).toContain('rubble-3');
    expect(featuredTargets(world(), bay, 3)).toHaveLength(3);
  });
  it('prefers a currently observed island over a nearer remembered one', () => {
    const t = [target('i1', 'Floating Island 01', 'island', { position: [5, 0, 0], knowledge: 'remembered', age: 20 }), target('i2', 'Floating Island 02', 'island', { position: [50, 0, 0] })];
    expect(featuredTargets(t, bay).map(x => x.target.id)).toEqual(['i2']);
  });
});

describe('grouping and aggregation', () => {
  it('collapses 34 static rubble pieces into one "Concrete rubble x34" row', () => {
    const rubble = world().filter(t => t.entityKind === 'wreckage');
    const items = aggregate(rubble);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'group', count: 34 });
    expect((items[0] as { label: string }).label).toBe('Concrete rubble ×34');
  });
  it('keeps moving, mission and small groups individual', () => {
    const items = aggregate(world().filter(t => tierOf(t) !== 'debris'));
    expect(items.filter(i => i.kind === 'group')).toHaveLength(1);
    expect(items.filter(i => i.kind === 'single' && i.target.targetClass === 'moving-object')).toHaveLength(3);
    expect(aggregate(world().filter(t => t.id === 'shard-a' || t.id === 'shard-b')).every(i => i.kind === 'single')).toBe(true);
  });
  it('flags a group that contains the selection', () => {
    const g = aggregate(world().filter(t => t.entityKind === 'wreckage'), 'rubble-5')[0]!;
    expect(g.kind === 'group' && g.containsSelected).toBe(true);
  });
  it('stems drop the variant suffix', () => {
    expect(stemOf(target('x', 'Baymax plating shard b', 'equipment'))).toBe('Baymax plating shard');
    expect(stemOf(target('x', 'Concrete chunk a', 'wreckage'))).toBe('Concrete rubble');
  });
});

describe('categories', () => {
  it('lists counts per category and puts rubble only under "All scanned objects"', () => {
    const cats = categorise(world(), bay);
    const by = Object.fromEntries(cats.map(c => [c.id, c]));
    expect(by.mission!.count).toBe(1);
    expect(by.islands!.count).toBe(2);
    expect(by.folds!.count).toBe(2);
    expect(by.moving!.count).toBe(3);
    expect(by.equipment!.count).toBe(5);
    expect(by.all!.count).toBe(world().filter(t => t.entityKind !== 'island' && t.entityKind !== 'fold').length);
    expect(by.moving!.items.some(i => i.kind === 'group')).toBe(false);
    expect(cats.filter(c => c.id !== 'all' && c.items.some(i => i.kind === 'single' && i.target.entityKind === 'wreckage'))).toHaveLength(0);
  });
  it('drops empty categories and honours the live filter', () => {
    const t = [target('i', 'Floating Island 01', 'island', { knowledge: 'remembered', age: 9 })];
    expect(categorise(t, bay).map(c => c.id)).toEqual(['islands']);
    expect(categorise(t, bay, { liveOnly: true })).toEqual([]);
  });
});

describe('search', () => {
  it('ranks prefix matches first and finds by id and kind', () => {
    const r = searchTargets(world(), 'fold', bay);
    expect(r.map(t => t.id).slice(0, 2).sort()).toEqual(['fold-1', 'fold-2']);
    expect(searchTargets(world(), 'abigail', bay).map(t => t.id)).toEqual(['capsule-abigail']);
    expect(searchTargets(world(), 'rubble-7', bay).map(t => t.id)).toEqual(['rubble-7']);
    expect(searchTargets(world(), '   ', bay)).toEqual([]);
  });
  it('caps results', () => { expect(searchTargets(world(), 'concrete', bay, 10)).toHaveLength(10); });
});

describe('log de-duplication', () => {
  const e = (id: number, title: string, detail: string, atWall: number): LogEntry => ({ id, tone: 'warn', title, detail, simTime: 0, atWall });
  it('drops a repeated link-health message within a minute but not after', () => {
    const log = [e(1, 'Data stale', 'x', 1000)];
    expect(isRepeatedNote(log, 'Data stale', 'different detail', 20000)).toBe(true);
    expect(isRepeatedNote(log, 'Data stale', 'x', 70000)).toBe(false);
  });
  it('drops identical messages within seconds, keeps distinct ones', () => {
    const log = [e(1, 'Forecast checked: A', 'off by 1.2 m', 1000)];
    expect(isRepeatedNote(log, 'Forecast checked: A', 'off by 1.2 m', 4000)).toBe(true);
    expect(isRepeatedNote(log, 'Forecast checked: A', 'off by 1.9 m', 4000)).toBe(false);
    expect(isRepeatedNote(log, 'Forecast checked: A', 'off by 1.2 m', 20000)).toBe(false);
  });
});
