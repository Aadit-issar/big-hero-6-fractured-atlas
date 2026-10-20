import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { SceneObjectMemory } from '../src/atlas/mapping/sceneObjectMemory';
import { sceneKnowledge } from '../src/atlas/live/knowledge';
import type { SceneScan } from '../src/atlas/live/protocol';
import { MissionReplay } from '../src/atlas/lab/missionReplay';
import { adviseNavigation, NavigationRuntime } from '../src/atlas/navigation/advisor';
import { buildNavGraph, listGoals } from '../src/atlas/navigation/knowledgeGraph';
import type { NavigationKnowledge } from '../src/atlas/navigation/knowledgeGraph';
import { findFrontiers } from '../src/atlas/navigation/frontier';
import { planRoute } from '../src/atlas/navigation/planner';
import { DEFAULT_POLICY } from '../src/atlas/navigation/types';
import type { AtlasObservation, ObservedConnectionState, WorldVec3 } from '../src/shared/atlasContract';

// Synthetic fixtures. Every observation passes through the real ATLAS runtime, so graph inputs are genuine memory records.
type Island = { id: string; p: WorldVec3 };
type Fold = { id: string; entry: WorldVec3; exit: WorldVec3; state: ObservedConnectionState };
const obs = (time: number, observer: WorldVec3, islands: Island[] = [], folds: Fold[] = []): AtlasObservation => ({
  contractVersion: 1, time, observerWorldPosition: observer, sensorRange: 150, local: { gravity: [0, 0, 0], hazard: 0.1 },
  islands: islands.map(i => ({ id: i.id, worldPosition: i.p, range: Math.hypot(i.p[0] - observer[0], i.p[1] - observer[1], i.p[2] - observer[2]) })),
  connections: folds.map(f => ({ id: f.id, state: f.state, entryWorldPosition: f.entry, exitWorldPosition: f.exit, range: Math.min(Math.hypot(f.entry[0] - observer[0], f.entry[1] - observer[1], f.entry[2] - observer[2]), Math.hypot(f.exit[0] - observer[0], f.exit[1] - observer[1], f.exit[2] - observer[2])) })),
});
function know(seq: AtlasObservation[], scans: SceneScan[] = [], episode = 0): NavigationKnowledge {
  const runtime = new AtlasRuntime(), memory = new SceneObjectMemory();
  let view = runtime.getView(0);
  seq.forEach((o, i) => { view = runtime.receive(o, i * 250); });
  for (const s of scans) memory.update(s);
  const mem = memory.read();
  return { view, scene: sceneKnowledge(mem.records, mem.scans), episode };
}
const A: Island = { id: 'ISLAND A', p: [100, 0, 0] };
const bridge = (state: ObservedConnectionState): Fold => ({ id: 'FOLD 1', entry: [5, 0, 0], exit: [95, 0, 0], state });
const seqWith = (fold: Fold) => [obs(0, [0, 0, 0], [A], [fold]), obs(0.25, [0, 0, 0], [A], [fold])];

describe('navigation graph is built only from knowledge', () => {
  it('has no nodes, goals or frontiers when nothing has been observed', () => {
    const k = know([]);
    const graph = buildNavGraph(k);
    expect(graph.nodes).toHaveLength(0);
    expect(listGoals(graph)).toHaveLength(0);
    expect(findFrontiers(graph, null)).toHaveLength(0);
    expect(adviseNavigation(k, null).status).toBe('abstain');
    expect(adviseNavigation(k, 'ISLAND A').status).toBe('abstain');
  });

  it('contains exactly the recorded entities and cites supporting records', () => {
    const k = know(seqWith(bridge('open')));
    const graph = buildNavGraph(k);
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['FOLD 1:entry', 'FOLD 1:exit', 'ISLAND A', 'observer']);
    for (const n of graph.nodes) expect(n.evidence.length).toBeGreaterThan(0);
    expect(graph.nodes.find(n => n.id === 'FOLD 1:exit')!.independentlyObserved).toBe(false);
  });

  it('labels every free-flight edge as unverified geometry with explicit unknowns', () => {
    const graph = buildNavGraph(know(seqWith(bridge('open'))));
    const free = graph.edges.filter(e => e.kind === 'free-flight');
    expect(free.length).toBeGreaterThan(0);
    for (const e of free) { expect(e.unknowns.length).toBeGreaterThan(0); expect(e.verifiedAt).toBeNull(); }
    // The fold is a directed entry to exit edge and is not duplicated as free flight.
    expect(graph.edges.find(e => e.id === 'fold:FOLD 1')).toMatchObject({ directed: true, from: 'FOLD 1:entry', to: 'FOLD 1:exit' });
    expect(free.some(e => e.id.includes('FOLD 1:entry|FOLD 1:exit'))).toBe(false);
  });
});

describe('route planning', () => {
  it('uses an open observed fold when it beats unobserved free flight, and says so', () => {
    const advice = adviseNavigation(know(seqWith(bridge('open'))), 'ISLAND A');
    expect(advice.status).toBe('route');
    expect(advice.route!.segments.some(s => s.kind === 'fold-transition' && s.support === 'observed-fold')).toBe(true);
    expect(advice.limitations.join(' ')).toMatch(/does not claim a safe path/);
    expect(advice.evidence.some(e => e.kind === 'assumption')).toBe(true);
  });

  it('excludes closed, closing and forming folds', () => {
    for (const state of ['closed', 'closing', 'forming', 'inactive'] as const) {
      const advice = adviseNavigation(know(seqWith(bridge(state))), 'ISLAND A');
      expect(advice.route === null || advice.route.segments.every(s => s.kind !== 'fold-transition'), state).toBe(true);
    }
  });

  it('keeps fold transitions directed: the exit cannot be used to reach the entry', () => {
    const k = know([obs(0, [95, 0, 0], [], [bridge('open')]), obs(0.25, [95, 0, 0], [], [bridge('open')])]);
    const route = planRoute(buildNavGraph(k), 'FOLD 1:entry');
    expect(route).not.toBeNull();
    expect(route!.segments.every(s => s.kind !== 'fold-transition')).toBe(true);
  });

  it('never treats a last-known fold as fresh: a route through it needs revalidation', () => {
    const seq = [obs(0, [0, 0, 0], [A], [bridge('open')]), obs(0.25, [0, 0, 0], [A], [bridge('open')]), obs(0.5, [0, 0, 0], [A], []), obs(0.75, [0, 0, 0], [A], [])];
    const advice = adviseNavigation(know(seq), 'ISLAND A');
    const fold = advice.route?.segments.find(s => s.kind === 'fold-transition');
    if (fold) { expect(fold.support).toBe('remembered-fold'); expect(advice.status).toBe('needs-revalidation'); expect(advice.recommendation.action).toBe('refresh'); }
    else expect(advice.status).toBe('route');
    // With remembered folds disallowed by policy the fold can never be used.
    const strict = adviseNavigation(know(seq), 'ISLAND A', { ...DEFAULT_POLICY, allowRemembered: false });
    expect(strict.route?.segments.every(s => s.kind !== 'fold-transition') ?? true).toBe(true);
  });

  it('is deterministic for identical knowledge', () => {
    const a = JSON.stringify(adviseNavigation(know(seqWith(bridge('open'))), 'ISLAND A'));
    const b = JSON.stringify(adviseNavigation(know(seqWith(bridge('open'))), 'ISLAND A'));
    expect(a).toBe(b);
  });

  it('does not invent a route to an unknown destination and falls back to a grounded frontier', () => {
    const advice = adviseNavigation(know(seqWith(bridge('open'))), 'THE HIDDEN PASSAGE');
    expect(advice.route).toBeNull();
    expect(advice.status).toBe('explore');
    expect(advice.reason).toMatch(/not in the records/);
    expect(advice.recommendation.action === 'observe' || advice.recommendation.action === 'refresh').toBe(true);
  });

  it('reports an honest no-route result when no supported connection exists, then recommends where to observe', () => {
    const k = know([obs(0, [0, 0, 0], [A]), obs(0.25, [0, 0, 0], [A])]);
    const advice = adviseNavigation(k, 'ISLAND A', { ...DEFAULT_POLICY, maxFreeFlight: 30 });
    expect(advice.status).toBe('no-route');
    expect(advice.route).toBeNull();
    expect(advice.reason).toMatch(/no supported connection/);
    expect(advice.recommendation.action).not.toBe('follow-route');
    expect(adviseNavigation(know([obs(0, [0, 0, 0])]), 'ISLAND A').status).toBe('explore');
  });
});

describe('frontiers', () => {
  it('appear next to recorded coverage and disappear once the space has been observed', () => {
    const one = buildNavGraph(know([obs(0, [0, 0, 0], [A])]));
    const f1 = findFrontiers(one, null);
    expect(f1.length).toBeGreaterThan(0);
    expect(f1.every(f => f.reasons.length > 0)).toBe(true);
    const moved = buildNavGraph(know([obs(0, [0, 0, 0], [A]), obs(1, [41, 0, 0], [A]), obs(2, [82, 0, 0], [A])]));
    const target = f1.find(f => f.kind === 'coverage-edge' && f.target[0] > 35 && Math.abs(f.target[1]) < 5 && Math.abs(f.target[2]) < 5);
    expect(target).toBeDefined();
    expect(findFrontiers(moved, null).some(f => f.id === target!.id)).toBe(false);
  });

  it('prioritise refreshing a stale island and carry traceable reasons', () => {
    const seq = [obs(0, [0, 0, 0], [A]), obs(0.25, [0, 0, 0], [A]), obs(20, [0, 0, 0], []), obs(20.25, [0, 0, 0], [])];
    const advice = adviseNavigation(know(seq), null);
    expect(advice.status).toBe('explore');
    expect(advice.recommendation.action).toBe('refresh');
    expect(advice.frontiers[0]!.refs).toContain('ISLAND A');
    expect(advice.frontiers[0]!.reasons.join(' ')).toMatch(/last observed/);
  });

  it('differ for different exploration histories', () => {
    const left = findFrontiers(buildNavGraph(know([obs(0, [0, 0, 0]), obs(1, [-30, 0, 0])])), null).map(f => f.id);
    const right = findFrontiers(buildNavGraph(know([obs(0, [0, 0, 0]), obs(1, [30, 0, 0])])), null).map(f => f.id);
    expect(left).not.toEqual(right);
  });
});

describe('invalidation as knowledge changes', () => {
  it('withdraws or reassesses a route when the fold it used changes state, with a derived explanation', () => {
    const nav = new NavigationRuntime();
    nav.setGoal('ISLAND A');
    const first = nav.update(know(seqWith(bridge('open'))));
    expect(first.advice.status).toBe('route');
    expect(first.advice.route!.foldDependencies).toHaveLength(1);
    const next = nav.update(know([...seqWith(bridge('open')), obs(0.5, [0, 0, 0], [A], [bridge('closing')]), obs(0.75, [0, 0, 0], [A], [bridge('closing')])]));
    expect(next.changes.map(c => c.kind)).toContain('fold-state-changed');
    expect(next.changes.some(c => /changed from open to closing/.test(c.message))).toBe(true);
    expect(next.advice.route === null || next.advice.route.segments.every(s => s.kind !== 'fold-transition')).toBe(true);
  });

  it('discards guidance when a different Dimension session begins', () => {
    const nav = new NavigationRuntime();
    nav.setGoal('ISLAND A');
    nav.update(know(seqWith(bridge('open')), [], 1));
    const reset = nav.update(know([obs(0, [0, 0, 0])], [], 2));
    expect(reset.changes.map(c => c.kind)).toEqual(['session-reset']);
    expect(reset.advice.route).toBeNull();
    expect(reset.advice.episode).toBe(2);
  });

  it('does not emit changes for identical knowledge', () => {
    const nav = new NavigationRuntime();
    nav.setGoal('ISLAND A');
    nav.update(know(seqWith(bridge('open'))));
    expect(nav.update(know(seqWith(bridge('open')))).changes).toEqual([]);
  });
});

describe('evidence integrity', () => {
  it('every evidence reference points at an actual record or edge', () => {
    const k = know(seqWith(bridge('open')));
    const graph = buildNavGraph(k);
    const valid = new Set<string>(['explorer', ...k.view.mapping.islands.map(i => i.id), ...k.view.mapping.folds.map(f => f.id), ...graph.edges.map(e => e.id), ...k.scene.records.map(r => r.id)]);
    const advice = adviseNavigation(k, 'ISLAND A');
    for (const item of advice.evidence) for (const ref of item.refs) expect(valid.has(ref), ref).toBe(true);
  });

  it('navigation modules import nothing from the simulation, sensor, renderer or live link', () => {
    const dir = join(process.cwd(), 'src', 'atlas', 'navigation');
    for (const f of readdirSync(dir)) {
      const source = readFileSync(join(dir, f), 'utf8');
      expect(source, f).not.toMatch(/from\s+['"][^'"]*(?:simulation|atlasSensor|\/scene\/|three|react)[^'"]*['"]/);
      expect(source, f).not.toMatch(/\b(?:window|document|performance\.now|Math\.random|Date\.now)\b/);
    }
  });
});

describe('navigation on the guided replay (real runtime and scene memory)', () => {
  it('offers only goals that have been recorded by that time, and reasons from them', () => {
    const early = new MissionReplay();
    early.seek(1);
    const goalsEarly = listGoals(buildNavGraph({ view: early.knowledge().view, scene: early.knowledge().scene, episode: 0 })).map(g => g.id);
    expect(goalsEarly.some(id => id.includes('industrial') || id.includes('capsule'))).toBe(false);
    const late = new MissionReplay();
    late.seek(12);
    const k = late.knowledge();
    const goals = listGoals(buildNavGraph({ view: k.view, scene: k.scene, episode: 0 }));
    expect(goals.some(g => g.kind === 'landmark')).toBe(true);
    const advice = adviseNavigation({ view: k.view, scene: k.scene, episode: 0 }, 'ISLAND 03');
    expect(['route', 'needs-revalidation']).toContain(advice.status);
    expect(advice.route!.nodes[0]).toBe('observer');
  });
});
