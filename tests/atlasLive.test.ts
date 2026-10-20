import { describe, expect, it } from 'vitest';
import { LINK_CHANNEL, LINK_VERSION, parseDimensionMessage } from '../src/atlas/live/protocol';
import type { SceneObjectObservation, SceneScan } from '../src/atlas/live/protocol';
import { LinkCore } from '../src/atlas/live/linkCore';
import { SceneObjectMemory, deriveClusters } from '../src/atlas/mapping/sceneObjectMemory';
import type { AtlasObservation } from '../src/shared/atlasContract';

const ORIGIN = 'http://127.0.0.1:4175';
const obs = (time: number, p: [number, number, number] = [0, 0, 0]): AtlasObservation => ({
  contractVersion: 1, time, observerWorldPosition: p, sensorRange: 60, local: { gravity: [0, 0, 0], hazard: 0.1 }, islands: [], connections: [],
});
const CLOCK = { time: 0, running: true, timeScale: 1, visible: true };
const POSE = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] };
const welcome = (session: string, seq = 0) => ({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session, seq, startedAtWallMs: 1, simTime: 0, sensorRange: 60, scanRange: 45, scanMode: 'continuous', origin: ORIGIN, seed: 1, modelVersion: 'fractured-2.0', clock: CLOCK, pose: null });
const frame = (session: string, seq: number, time = seq / 4, scan?: SceneScan) => ({
  channel: LINK_CHANNEL, v: LINK_VERSION, type: 'frame', session, seq, wallMs: seq * 250, observation: obs(time), scanMode: 'continuous', pose: POSE, clock: { ...CLOCK, time }, ...(scan ? { scan } : {}),
});
const object = (id: string, p: [number, number, number], family: SceneObjectObservation['family'] = 'concrete', category: SceneObjectObservation['category'] = 'concrete'): SceneObjectObservation =>
  ({ id, category, family, kind: 'k', position: p, radius: 1, range: 10 });
const scan = (scanId: number, objects: SceneObjectObservation[], extra: Partial<SceneScan> = {}): SceneScan =>
  ({ scanId, time: scanId / 2, observerPosition: [0, 0, 0], range: 45, coverage: 'proximity-sphere', trigger: 'continuous', objects, omitted: 0, ...extra });

describe('protocol validation', () => {
  it('accepts well-formed frames and rejects malformed or wrong-channel input', () => {
    expect(parseDimensionMessage(frame('s', 1))?.type).toBe('frame');
    expect(parseDimensionMessage({ ...frame('s', 1), channel: 'other' })).toBeNull();
    expect(parseDimensionMessage({ ...frame('s', 1), v: 1 })).toBeNull();
    expect(parseDimensionMessage({ ...frame('s', 1), pose: undefined })).toBeNull();
    expect(parseDimensionMessage({ ...frame('s', 1), observation: { ...obs(1), time: -3 } })).toBeNull();
    expect(parseDimensionMessage({ ...frame('s', 1.5) })).toBeNull();
    expect(parseDimensionMessage(null)).toBeNull();
    expect(parseDimensionMessage('frame')).toBeNull();
  });
  it('rejects malformed scene scans and bounds their size', () => {
    expect(parseDimensionMessage(frame('s', 1, 0, scan(1, [{ ...object('a', [0, 0, 0]), category: 'unicorn' as never }])))).toBeNull();
    expect(parseDimensionMessage(frame('s', 1, 0, scan(1, [object('a', [Number.NaN, 0, 0])])))).toBeNull();
    const many = Array.from({ length: 401 }, (_, i) => object(`o${i}`, [i, 0, 0]));
    expect(parseDimensionMessage(frame('s', 1, 0, scan(1, many)))).toBeNull();
  });
});

describe('link session, sequence and staleness', () => {
  const connect = () => { const c = new LinkCore({ expectedOrigin: null }); c.beginConnecting(0); expect(c.handle(ORIGIN, welcome('A'), 10).kind).toBe('welcome'); return c; };

  it('refuses frames before a handshake, from the wrong origin and for other sessions', () => {
    const c = new LinkCore({ expectedOrigin: null });
    expect(c.handle(ORIGIN, frame('A', 1), 0)).toMatchObject({ kind: 'ignored' });
    c.beginConnecting(0);
    expect(c.handle(ORIGIN, frame('A', 1), 0)).toMatchObject({ kind: 'ignored', reason: 'foreign-session' });
    expect(c.handle('https://evil.example', welcome('A'), 0)).toMatchObject({ reason: 'bad-origin' });
    expect(c.handle(ORIGIN, { ...welcome('A'), origin: 'http://127.0.0.1:9' }, 0)).toMatchObject({ reason: 'bad-origin' });
    expect(c.handle(ORIGIN, welcome('A'), 0).kind).toBe('welcome');
    expect(c.handle('http://127.0.0.1:9999', frame('A', 1), 0)).toMatchObject({ reason: 'bad-origin' });
    expect(c.handle(ORIGIN, frame('B', 1), 0)).toMatchObject({ reason: 'foreign-session' });
    expect(c.state().counters.foreignSession).toBe(2);
  });

  it('rejects duplicate and out-of-order sequence numbers', () => {
    const c = connect();
    expect(c.handle(ORIGIN, frame('A', 1), 20).kind).toBe('frame');
    expect(c.handle(ORIGIN, frame('A', 1), 30)).toMatchObject({ reason: 'duplicate' });
    expect(c.handle(ORIGIN, frame('A', 3), 40).kind).toBe('frame');
    expect(c.handle(ORIGIN, frame('A', 2), 50)).toMatchObject({ reason: 'duplicate' });
    expect(c.state().counters).toMatchObject({ accepted: 2, duplicate: 2 });
  });

  it('treats a different session as a new episode, never a continuation', () => {
    const c = connect();
    c.handle(ORIGIN, frame('A', 5), 20);
    const next = c.handle(ORIGIN, welcome('B'), 30);
    expect(next).toMatchObject({ kind: 'welcome', newSession: true });
    expect(c.state().episode).toBe(2);
    expect(c.handle(ORIGIN, frame('A', 6), 40)).toMatchObject({ reason: 'foreign-session' });
    expect(c.handle(ORIGIN, frame('B', 1), 50).kind).toBe('frame');
  });

  it('goes stale and then disconnected without frames, and recovers on the next one', () => {
    const c = connect();
    c.handle(ORIGIN, frame('A', 1), 100);
    expect(c.tick(1000)).toBe(false);
    expect(c.tick(2000)).toBe(true); expect(c.state().status).toBe('stale');
    expect(c.tick(7000)).toBe(true); expect(c.state().status).toBe('disconnected');
    expect(c.handle(ORIGIN, frame('A', 2), 7100).kind).toBe('frame');
    expect(c.state().status).toBe('connected');
  });

  it('ignores everything after the link is closed', () => {
    const c = connect();
    c.close();
    expect(c.handle(ORIGIN, frame('A', 1), 20).kind).toBe('ignored');
  });
});

describe('scene-object memory', () => {
  it('creates records only from scans and refreshes rather than duplicates them', () => {
    const m = new SceneObjectMemory();
    expect(m.read().records).toHaveLength(0);
    const e1 = m.update(scan(1, [object('a', [1, 0, 0]), object('b', [2, 0, 0])]));
    expect(e1[0]).toMatchObject({ kind: 'scene-objects-acquired', counts: { acquired: 2 } });
    const e2 = m.update(scan(2, [object('a', [1, 0, 0]), object('b', [2, 0, 0])]));
    expect(e2[0]).toMatchObject({ kind: 'scene-scan-unchanged' });
    expect(m.read().records).toHaveLength(2);
    expect(m.read().records.find(r => r.id === 'a')).toMatchObject({ observationCount: 2, currentlyObserved: true });
  });

  it('remembers objects that leave range, and re-observation restores them', () => {
    const m = new SceneObjectMemory();
    m.update(scan(1, [object('a', [1, 0, 0]), object('b', [2, 0, 0])]));
    const left = m.update(scan(2, [object('b', [2, 0, 0])]));
    expect(left.some(e => e.kind === 'scene-objects-left')).toBe(true);
    expect(m.read().records.find(r => r.id === 'a')).toMatchObject({ currentlyObserved: false, knowledgeStatus: 'previously-observed', lastSeenAt: 0.5 });
    m.update(scan(3, [object('a', [1, 0, 0]), object('b', [2, 0, 0])]));
    expect(m.read().records.find(r => r.id === 'a')).toMatchObject({ currentlyObserved: true, observationCount: 2, firstSeenAt: 0.5 });
    expect(m.read().records).toHaveLength(2);
  });

  it('reports a negative result honestly and ignores a repeated scan id', () => {
    const m = new SceneObjectMemory();
    expect(m.update(scan(1, []))[0]).toMatchObject({ kind: 'scene-scan-empty' });
    expect(m.update(scan(1, [object('a', [0, 0, 0])]))).toEqual([]);
    expect(m.read().records).toHaveLength(0);
  });

  it('does not mark in-range objects as left when the scan cap omitted them', () => {
    const m = new SceneObjectMemory();
    m.update(scan(1, [object('a', [1, 0, 0]), object('b', [2, 0, 0])]));
    m.update(scan(2, [object('b', [2, 0, 0])], { omitted: 3 }));
    expect(m.read().records.find(r => r.id === 'a')?.currentlyObserved).toBe(true);
    m.update(scan(3, [object('b', [2, 0, 0])], { omitted: 3, observerPosition: [500, 0, 0] }));
    expect(m.read().records.find(r => r.id === 'a')?.currentlyObserved).toBe(false);
  });

  it('flags objects reported at a different position than recorded', () => {
    const m = new SceneObjectMemory();
    m.update(scan(1, [object('a', [1, 0, 0])]));
    const e = m.update(scan(2, [object('a', [4, 0, 0])]));
    expect(e.some(x => x.kind === 'scene-object-moved')).toBe(true);
    expect(m.read().records[0]!.maxReportedShift).toBeCloseTo(3);
  });
});

describe('cluster aggregation', () => {
  const records = (objs: SceneObjectObservation[]) => { const m = new SceneObjectMemory(); m.update(scan(1, objs)); return m.read().records; };

  it('groups neighbouring same-family objects and keeps isolated ones individual', () => {
    const recs = records([
      object('c1', [0, 0, 0]), object('c2', [5, 0, 0]), object('c3', [9, 2, 0]), object('c4', [12, 0, 3]),
      object('far', [400, 0, 0]),
      object('s1', [2, 0, 2], 'industrial', 'steel'),
    ]);
    const clusters = deriveClusters(recs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ group: 'concrete', count: 4, partial: true, label: 'Concrete debris field' });
    expect(clusters[0]!.composition).toEqual({ concrete: 4 });
  });

  it('always reports capsule wreckage, even a single piece', () => {
    const clusters = deriveClusters(records([object('cap', [0, 0, 0], 'capsule', 'landmark')]));
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.group).toBe('capsule');
  });

  it('counts only acquired objects and tracks remembered members', () => {
    const m = new SceneObjectMemory();
    m.update(scan(1, [object('c1', [0, 0, 0]), object('c2', [3, 0, 0]), object('c3', [6, 0, 0])]));
    m.update(scan(2, [object('c1', [0, 0, 0])]));
    const [cluster] = deriveClusters(m.read().records);
    expect(cluster).toMatchObject({ count: 3, currentlyObserved: 1, remembered: 2 });
  });
});

import { MissionReplay, missionScan, MISSION_SCAN_RANGE } from '../src/atlas/lab/missionReplay';

describe('guided replay: scene objects stay causal', () => {
  const ids = (r: MissionReplay) => r.knowledge().scene.records.map(x => `${x.id}:${x.currentlyObserved}:${x.observationCount}:${x.lastSeenAt}`);

  it('reconstructs the earlier knowledge state after a backward seek', () => {
    const a = new MissionReplay();
    a.seek(2);
    const early = ids(a);
    a.seek(20);
    expect(ids(a).length).toBeGreaterThan(early.length);
    a.seek(2);
    expect(ids(a)).toEqual(early);
    expect(a.knowledge().activity.every(e => (e.simTime ?? 0) <= 2)).toBe(true);
  });

  it('is deterministic across independent runs', () => {
    const a = new MissionReplay(), b = new MissionReplay();
    a.seek(14); b.seek(14);
    expect(ids(a)).toEqual(ids(b));
    expect(a.knowledge().activity.map(e => e.title)).toEqual(b.knowledge().activity.map(e => e.title));
  });

  it('only contains objects a scan could have acquired by that time (no future or out-of-range knowledge)', () => {
    const r = new MissionReplay();
    r.seek(3);
    const acquirable = new Set<string>();
    for (let tick = 0; tick <= 12; tick += 1) for (const o of missionScan(tick)?.objects ?? []) acquirable.add(o.id);
    for (const rec of r.knowledge().scene.records) {
      expect(acquirable.has(rec.id), rec.id).toBe(true);
      expect(rec.lastRange).toBeLessThanOrEqual(MISSION_SCAN_RANGE);
      expect(rec.firstSeenAt).toBeLessThanOrEqual(3);
    }
    // The industrial wreckage and the capsule piece are out of range at the start and acquired only later.
    const early = r.knowledge().scene.records.map(x => x.id);
    expect(early.some(id => id.startsWith('sim-industrial'))).toBe(false);
    expect(early.some(id => id.startsWith('sim-capsule'))).toBe(false);
    r.seek(12);
    expect(r.knowledge().scene.records.some(x => x.id.startsWith('sim-capsule'))).toBe(true);
  });

  it('remembers objects the observer leaves behind', () => {
    const r = new MissionReplay();
    r.seek(14);
    const concrete = r.knowledge().scene.records.filter(x => x.id.startsWith('sim-concrete'));
    expect(concrete.length).toBeGreaterThan(0);
    expect(concrete.some(x => !x.currentlyObserved && x.knowledgeStatus === 'previously-observed')).toBe(true);
  });
});

describe('goal requests from the Dimension', () => {
  const goalReq = (session: string, seq: number, goalId: unknown) => ({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'select-goal', session, seq, goalId });
  const connected = () => { const c = new LinkCore({ expectedOrigin: null }); c.beginConnecting(0); c.handle(ORIGIN, welcome('A'), 1); return c; };

  it('parses a well-formed goal request and rejects malformed ones', () => {
    expect(parseDimensionMessage(goalReq('A', 3, 'ISLAND 01'))).toMatchObject({ type: 'select-goal', goalId: 'ISLAND 01' });
    expect(parseDimensionMessage(goalReq('A', 3, ''))).toBeNull();
    expect(parseDimensionMessage(goalReq('A', 3, 42))).toBeNull();
    expect(parseDimensionMessage(goalReq('A', 3, 'x'.repeat(200)))).toBeNull();
  });

  it('accepts a goal request only from the active session, in order, from the pinned origin', () => {
    const c = connected();
    expect(c.handle(ORIGIN, goalReq('A', 2, 'ISLAND 01'), 10)).toMatchObject({ kind: 'goal-request', goalId: 'ISLAND 01' });
    expect(c.handle(ORIGIN, goalReq('A', 2, 'ISLAND 02'), 11)).toMatchObject({ kind: 'ignored', reason: 'duplicate' });
    expect(c.handle(ORIGIN, goalReq('B', 9, 'ISLAND 02'), 12)).toMatchObject({ kind: 'ignored', reason: 'foreign-session' });
    expect(c.handle('http://127.0.0.1:1', goalReq('A', 10, 'ISLAND 02'), 13)).toMatchObject({ kind: 'ignored', reason: 'bad-origin' });
  });
});
