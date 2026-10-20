import { describe, expect, it } from 'vitest';
import type { AtlasObservation, WorldVec3 } from '../src/shared/atlasContract';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { ExplorationMemory } from '../src/atlas/mapping/explorationMemory';
import { projectWorldPosition, worldDistance3D } from '../src/atlas/mapping/projection';
import { createReplayObservation, createStressObservation } from '../src/atlas/lab/fixtures';

interface SampleOptions {
  readonly observer?: WorldVec3;
  readonly islands?: readonly { readonly id: string; readonly position: WorldVec3 }[];
  readonly folds?: readonly { readonly id: string; readonly state?: AtlasObservation['connections'][number]['state']; readonly entry: WorldVec3; readonly exit: WorldVec3 }[];
}

function sample(time: number, options: SampleOptions = {}): AtlasObservation {
  const observer = options.observer ?? [0, 0, 0];
  const islands = (options.islands ?? []).map(({ id, position }) => ({
    id,
    worldPosition: position,
    range: worldDistance3D(observer, position),
  }));
  const connections = (options.folds ?? []).map(({ id, state = 'open', entry, exit }) => ({
    id,
    state,
    entryWorldPosition: entry,
    exitWorldPosition: exit,
    range: Math.min(worldDistance3D(observer, entry), worldDistance3D(observer, exit)),
  }));
  return {
    contractVersion: 1,
    time,
    observerWorldPosition: observer,
    sensorRange: 60,
    local: { gravity: [0.2, -0.6, 0.1], hazard: 0.3 },
    islands,
    connections,
  } as AtlasObservation;
}

describe('ATLAS Phase 2 exploration memory', () => {
  it('creates records and topology only from the accepted observation', () => {
    const runtime = new AtlasRuntime();
    const view = runtime.receive(sample(2, {
      islands: [{ id: 'island-1', position: [12, 6, 3] }],
      folds: [{ id: 'fold-1', entry: [20, 0, 0], exit: [120, 20, -50] }],
    }), 100);

    expect(view.mapping.summary.uniqueIslands).toBe(1);
    expect(view.mapping.summary.uniqueFolds).toBe(1);
    expect(view.mapping.islands[0]).toMatchObject({ id: 'island-1', firstSeenAt: 2, lastSeenAt: 2, currentlyObserved: true, observationCount: 1 });
    expect(view.mapping.edges).toHaveLength(1);
    expect(view.mapping.edges[0]).toMatchObject({ kind: 'sensor-reported-fold', directionality: 'unknown', provenance: 'sensor-reported', currentState: 'open' });
    expect(view.mapping.nodes.map(({ kind }) => kind)).toEqual(['island', 'fold-entry', 'fold-exit']);
  });

  it('updates stable-ID tracks and count only once per distinct simulation timestamp', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(3, { observer: [0, 0, 0], islands: [{ id: 'i', position: [10, 0, 0] }] }), 100);
    const updated = runtime.receive(sample(3, { observer: [2, 0, 0], islands: [{ id: 'i', position: [12, 4, 0] }] }), 350);
    expect(updated.sampleCount).toBe(1);
    expect(updated.mapping.summary.distinctExplorerSamples).toBe(1);
    expect(updated.mapping.islands[0]).toMatchObject({ observationCount: 1, firstSeenAt: 3, lastSeenAt: 3, lastKnownPosition: [12, 4, 0] });
    expect(updated.mapping.islands[0]?.track).toHaveLength(1);
    expect(updated.mapping.explorer.latestPosition).toEqual([2, 0, 0]);
  });

  it('retains disappeared islands as historical and re-associates stable IDs on reappearance', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(1, { islands: [{ id: 'moving-island', position: [8, 0, 4] }] }), 100);
    const absent = runtime.receive(sample(2), 200);
    expect(absent.mapping.islands[0]).toMatchObject({ currentlyObserved: false, knowledgeStatus: 'previously-observed', currentPosition: null, lastKnownPosition: [8, 0, 4] });
    const returned = runtime.receive(sample(4, { islands: [{ id: 'moving-island', position: [18, 7, -2] }] }), 300);
    expect(returned.mapping.islands).toHaveLength(1);
    expect(returned.mapping.islands[0]).toMatchObject({ currentlyObserved: true, observationCount: 2, firstSeenAt: 1, lastSeenAt: 4, lastKnownPosition: [18, 7, -2] });
    expect(returned.mapping.islands[0]?.track.map(({ time, position }) => [time, position])).toEqual([
      [1, [8, 0, 4]], [4, [18, 7, -2]],
    ]);
    expect(returned.events.map(({ kind }) => kind)).toContain('island-reobserved');
    expect(returned.events.map(({ kind }) => kind)).toContain('island-position-changed');
  });

  it('retains discoveries after the rolling sensor history evicts old snapshots', () => {
    const runtime = new AtlasRuntime({ historyLimit: 512, mapping: { explorerTrackLimit: 6, environmentTrackLimit: 6 } });
    runtime.receive(sample(0, { islands: [{ id: 'early-discovery', position: [5, 0, 0] }] }), 0);
    for (let time = 1; time <= 520; time += 1) runtime.receive(sample(time), time * 250);
    const view = runtime.getView(520 * 250);
    expect(view.history).toHaveLength(512);
    expect(view.history[0]?.time).toBe(9);
    expect(view.mapping.islands[0]?.id).toBe('early-discovery');
    expect(view.mapping.islands[0]?.currentlyObserved).toBe(false);
    expect(view.mapping.summary.distinctExplorerSamples).toBe(521);
    expect(view.mapping.summary.explorerTrackLength).toBe(6);
    expect(view.mapping.explorer.track[0]?.time).toBe(0);
    expect(view.mapping.explorer.track.at(-1)?.time).toBe(520);
    expect(view.mapping.environment).toHaveLength(6);
    expect(view.mapping.environment[0]?.time).toBe(0);
    expect(view.mapping.environment[1]?.breakBefore).toBe(true);
    expect(view.mapping.environment.at(-1)?.time).toBe(520);
  });

  it('keeps entity storage bounded and exposes deterministic eviction accounting', () => {
    const memory = new ExplorationMemory({ maxEntityRecords: 2 });
    memory.update(sample(0, { islands: [{ id: 'a', position: [1, 0, 0] }, { id: 'b', position: [2, 0, 0] }] }), 1);
    const view = memory.update(sample(1, { islands: [{ id: 'b', position: [2, 0, 0] }, { id: 'c', position: [3, 0, 0] }] }), 1);
    expect(memory.read().islands.map(({ id }) => id)).toEqual(['b', 'c']);
    expect(memory.read().summary.evictedEntityRecords).toBe(1);
    expect(view.map(({ kind }) => kind)).toContain('island-discovered');
  });

  it('records fold appearance, status changes, disappearance, and reappearance without inferring closure', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(1, { folds: [{ id: 'f', state: 'open', entry: [4, 0, 0], exit: [80, 0, 0] }] }), 100);
    const missing = runtime.receive(sample(4), 200);
    expect(missing.mapping.folds[0]).toMatchObject({ currentlyObserved: false, currentState: null, lastObservedState: 'open' });
    expect(missing.mapping.edges[0]).toMatchObject({ currentlyObserved: false, currentState: null, lastObservedState: 'open' });
    expect(missing.mapping.folds[0]?.freshness).toBe('recent');
    const closed = runtime.receive(sample(8, { folds: [{ id: 'f', state: 'closed', entry: [5, 0, 0], exit: [81, 2, 0] }] }), 300);
    expect(closed.mapping.folds[0]).toMatchObject({ currentlyObserved: true, currentState: 'closed', lastObservedState: 'closed', observationCount: 2 });
    expect(closed.mapping.folds[0]?.track.map(({ state }) => state)).toEqual(['open', 'closed']);
    const stale = runtime.receive(sample(14), 400);
    expect(stale.mapping.folds[0]).toMatchObject({ currentlyObserved: false, currentState: null, lastObservedState: 'closed', freshness: 'stale' });
    expect(stale.mapping.edges[0]?.currentState).toBeNull();
  });

  it('does not turn remote endpoints into independent destinations or add proximity edges', () => {
    const runtime = new AtlasRuntime();
    const view = runtime.receive(sample(0, {
      islands: [{ id: 'near-entry', position: [4, 0, 0] }, { id: 'far-side', position: [50, 3, 0] }],
      folds: [{ id: 'portal', entry: [5, 0, 0], exit: [50, 3, 0] }],
    }), 100);
    expect(view.mapping.edges).toHaveLength(1);
    expect(view.mapping.edges[0]?.endpoints).toEqual(['fold-entry:portal', 'fold-exit:portal']);
    expect(view.mapping.edges[0]?.directionality).toBe('unknown');
    expect(view.mapping.nodes.find((node) => node.id === 'fold-exit:portal')).toMatchObject({ independentlyObserved: false });
    expect(view.mapping.folds[0]?.remoteEndpointIndependentlyObserved).toBe(false);
    expect(view.mapping.edges.some((edge) => edge.endpoints.some((endpoint) => endpoint.startsWith('island:')))).toBe(false);
  });

  it('does not connect trajectory segments across a large unexplained displacement', () => {
    const runtime = new AtlasRuntime({ mapping: { discontinuityDistance: 75 } });
    runtime.receive(sample(0, { observer: [0, 0, 0] }), 100);
    runtime.receive(sample(1, { observer: [10, 0, 0] }), 200);
    const jumped = runtime.receive(sample(2, { observer: [110, 25, -30] }), 300);
    expect(jumped.mapping.explorer.track.map(({ breakBefore }) => breakBefore)).toEqual([false, false, true]);
    expect(jumped.events.map(({ kind }) => kind)).toContain('explorer-discontinuity');
    expect(jumped.mapping.explorer.track.map(({ position }) => position)).toEqual([[0, 0, 0], [10, 0, 0], [110, 25, -30]]);
  });

  it('breaks island track lines for large observed position jumps without predicting motion', () => {
    const runtime = new AtlasRuntime({ mapping: { discontinuityDistance: 75 } });
    runtime.receive(sample(0, { observer: [0, 0, 0], islands: [{ id: 'i', position: [4, 0, 0] }] }), 100);
    const updated = runtime.receive(sample(2, { observer: [100, 0, 0], islands: [{ id: 'i', position: [100, 0, 0] }] }), 200);
    expect(updated.mapping.islands[0]?.track.map(({ breakBefore }) => breakBefore)).toEqual([false, true]);
    expect(updated.mapping.islands[0]?.track.map(({ time }) => time)).toEqual([0, 2]);
  });

  it('resets all session exploration knowledge when simulation time moves backwards', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(20, { islands: [{ id: 'old-session', position: [3, 0, 0] }] }), 100);
    const next = runtime.receive(sample(0, { islands: [{ id: 'new-session', position: [2, 0, 0] }] }), 200);
    expect(next.session).toBe(2);
    expect(next.mapping.session).toBe(2);
    expect(next.mapping.islands.map(({ id }) => id)).toEqual(['new-session']);
    expect(next.mapping.explorer.track.map(({ time }) => time)).toEqual([0]);
    expect(next.mapping.environment.map(({ time }) => time)).toEqual([0]);
  });

  it('uses simulation time for staleness, so a paused timestamp does not age records', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(10, { islands: [{ id: 'i', position: [2, 0, 0] }] }), 100);
    runtime.receive(sample(10, { islands: [{ id: 'i', position: [2, 0, 0] }] }), 60_000);
    const paused = runtime.getView(63_000);
    expect(paused.status).toBe('stale');
    expect(paused.mapping.islands[0]?.freshness).toBe('current');
    expect(paused.mapping.environment).toHaveLength(1);
    const aged = runtime.receive(sample(16), 60_250);
    expect(aged.mapping.islands[0]?.freshness).toBe('stale');
  });

  it('does not mutate input snapshots and exposes immutable read-only map snapshots', () => {
    const input = sample(1, { islands: [{ id: 'i', position: [2, 0, 0] }] });
    const original = JSON.stringify(input);
    const runtime = new AtlasRuntime();
    const view = runtime.receive(input, 100);
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(view.mapping)).toBe(true);
    expect(Object.isFrozen(view.mapping.islands)).toBe(true);
    expect(Object.isFrozen(view.mapping.islands[0]?.track)).toBe(true);
    expect(Object.isFrozen(view.mapping.environment)).toBe(true);
    expect(() => (view.mapping.islands as unknown as unknown[]).push({})).toThrow();
  });

  it('rejects malformed coordinates without changing accumulated map knowledge', () => {
    const runtime = new AtlasRuntime();
    const accepted = runtime.receive(sample(1, { islands: [{ id: 'i', position: [2, 0, 0] }] }), 100);
    const before = accepted.mapping;
    const invalid = { ...sample(2), observerWorldPosition: [Number.NaN, 0, 0] };
    const rejected = runtime.receive(invalid, 200);
    expect(rejected.status).toBe('invalid');
    expect(rejected.mapping).toBe(before);
    expect(rejected.mapping.islands[0]?.lastSeenAt).toBe(1);
  });

  it('keeps identical replay results and stores only actual sampled positions', () => {
    const run = () => {
      const runtime = new AtlasRuntime();
      for (let stage = 0; stage < 5; stage += 1) runtime.receive(createReplayObservation(stage), stage * 900);
      return runtime.getView(4_000).mapping;
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(first.summary.uniqueIslands).toBe(5);
    expect(first.summary.uniqueFolds).toBe(2);
    expect(first.islands.find(({ id }) => id === 'island-A')?.track.map(({ time }) => time)).toEqual([0, 2, 8]);
    expect(first.folds.find(({ id }) => id === 'fold-A')).toMatchObject({ lastObservedState: 'closed', currentlyObserved: true });
  });

  it('retains environmental measurements and visible counts as simulation-timed evidence', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(2, { islands: [{ id: 'i', position: [4, 0, 0] }] }), 100);
    runtime.receive({ ...sample(4), local: { gravity: [0.5, -0.3, 0.2], hazard: 0.7 } }, 200);
    const measurements = runtime.getView(200).mapping.environment;
    expect(measurements.map(({ time }) => time)).toEqual([2, 4]);
    expect(measurements[0]).toMatchObject({ visibleIslandCount: 1, visibleFoldCount: 0, hazard: 0.3 });
    expect(measurements[1]?.gravityMagnitude).toBeCloseTo(Math.hypot(0.5, -0.3, 0.2));
    expect(measurements[1]?.hazard).toBe(0.7);
  });

  it('accepts the labelled map-density fixture through the real observation validator', () => {
    const runtime = new AtlasRuntime();
    const view = runtime.receive(createStressObservation(), 100);
    expect(view.status).toBe('receiving');
    expect(view.mapping.summary.uniqueIslands).toBe(128);
    expect(view.mapping.summary.uniqueFolds).toBe(32);
    expect(view.mapping.edges).toHaveLength(32);
    expect(view.mapping.nodes).toHaveLength(192);
  });
});

describe('ATLAS world map projection', () => {
  it('uses X/Z for the world-aligned plan and Z/Y for side elevation', () => {
    expect(projectWorldPosition([10, 40, -7], 'xz')).toEqual([10, -7]);
    expect(projectWorldPosition([10, 40, -7], 'zy')).toEqual([-7, 40]);
  });

  it('computes full three-dimensional distance rather than a flattened map distance', () => {
    expect(worldDistance3D([0, 0, 0], [3, 4, 12])).toBe(13);
    expect(worldDistance3D([0, 0, 0], [3, 100, 12])).toBeCloseTo(Math.sqrt(10_153));
  });
});
