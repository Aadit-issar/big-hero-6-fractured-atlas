import { describe, expect, it } from 'vitest';
import { connectionPill, inSeconds, outcomeView, planBadge, routeChangeNote, routeStages, scrubReadout, timeMarkers, validityOf, vec } from '../src/atlas/command/ui/panels/logic';
import type { RouteView } from '../src/atlas/command/session';
import type { ForecastView } from '../src/atlas/command/encounter';
import type { NavReport } from '../src/shared/liveLink';

const route = (over: Partial<RouteView> = {}): RouteView => ({ state: 'accepted', active: null, command: null, ackDetail: '', nav: null, sentAtSim: 10, arrivedAtSim: null, history: [], ...over });
const nav = (over: Partial<NavReport> = {}): NavReport => ({ routeId: 'r', revision: 1, status: 'active', activeIndex: 0, waypointCount: 2, distanceToWaypoint: 10, distanceToGoal: 30, arrivedAtSimTime: null, ...over });
const active = { routeId: 'r', revision: 1, targetId: 'c', issuedAt: 0, speed: 14, meetingPosition: null, meetingTime: null, goalPosition: [100, 0, 0] as [number, number, number], waypoints: [[0, 0, 0], [100, 0, 0]] as [number, number, number][], mode: 'approach' as const };

describe('time language', () => {
  it('writes NOW and IN x.x s', () => {
    expect(inSeconds(10, 10)).toBe('NOW');
    expect(inSeconds(14.25, 10)).toBe('IN 4.3 s');
    expect(inSeconds(9, 10)).toBe('NOW');
  });
  it('merges ETA and interception into one marker when they are the same moment', () => {
    const m = timeMarkers(0, { eta: 3.8, aim: 3.7 });
    expect(m.map(x => x.key)).toEqual(['now', 'intercept']);
    expect(m[1]!.label).toBe('ETA = INTERCEPT IN 3.8 s');
    const d = timeMarkers(0, { eta: 6, aim: 3, trustedUntil: 10 });
    expect(d.map(x => x.key)).toEqual(['now', 'intercept', 'eta', 'trusted']);
  });
  it('vec never prints negative zero', () => { expect(vec([-0.2, 3.6, -52.4])).toBe('0, 4, -52'); });
});

describe('connection pill', () => {
  const link = (status: string) => ({ status }) as never;
  it('uses plain words and no technical ids', () => {
    expect(connectionPill({ link: link('connected'), clock: { time: 1, running: true, timeScale: 1, visible: true }, simTime: 12.34 })).toEqual({ text: 'LIVE', tone: 'ok', detail: 't 12.3 s' });
    expect(connectionPill({ link: link('connected'), clock: { time: 1, running: false, timeScale: 1, visible: true }, simTime: 3 }).text).toBe('PAUSED');
    expect(connectionPill({ link: link('stale'), clock: null, simTime: 3 }).tone).toBe('warn');
    expect(connectionPill({ link: link('disconnected'), clock: null, simTime: 0 }).tone).toBe('bad');
    expect(connectionPill({ link: link('idle'), clock: null, simTime: 0 }).text).toBe('NOT CONNECTED');
  });
});

describe('plan badge', () => {
  it('names the plan type', () => {
    expect(planBadge('intercept').text).toBe('INTERCEPT');
    expect(planBadge('entrance').text).toBe('INVESTIGATE FOLD');
    expect(planBadge('approach').text).toBe('APPROACH');
    expect(planBadge('reconnaissance').text).toBe('NAVIGATE');
  });
});

describe('forecast scrubber', () => {
  const fc = { now: 20, trustedUntil: 26, at: (t: number) => ({ t, position: [t, 0, 0], uncertainty: (t - 20) / 10 }), current: { t: 20, position: [20, 0, 0], uncertainty: 0 } } as unknown as ForecastView;
  it('reads the forecast at now + offset and clamps to the trusted range', () => {
    expect(scrubReadout(fc, 0).label).toBe('NOW');
    const r = scrubReadout(fc, 4.2);
    expect(r.label).toBe('IN 4.2 s');
    expect(r.position[0]).toBeCloseTo(24.2);
    expect(r.trusted).toBe(true);
    expect(scrubReadout(fc, 99).offset).toBe(6);
    expect(scrubReadout(fc, -3).offset).toBe(0);
  });
});

describe('validity in plain words', () => {
  it('states honestly when there is not enough evidence', () => {
    const v = validityOf({ observations: 3, span: 1.2, evidenceAge: 0.3, ok: false, motion: 'unknown', model: null, note: 'Too few samples.', heldOutError: null, baselineError: null, leadSeconds: null });
    expect(v.tone).toBe('none');
    expect(v.lines.join(' ')).toContain('Too few samples.');
  });
  it('compares held-out error with "has not moved"', () => {
    const v = validityOf({ observations: 55, span: 26.8, evidenceAge: 0.3, ok: true, motion: 'moving', model: 'quadratic', note: null, heldOutError: 0.6, baselineError: 5.2, leadSeconds: 2.5 });
    expect(v.tone).toBe('good');
    expect(v.lines.at(-1)).toContain('0.6 m');
    expect(v.lines.at(-1)).toContain('5.2 m');
    expect(validityOf({ observations: 9, span: 5, evidenceAge: 0, ok: true, motion: 'moving', model: 'linear', note: null, heldOutError: 6, baselineError: 5, leadSeconds: 2 }).tone).toBe('limited');
  });
});

describe('route stages', () => {
  it('follows the real state: sent, accepted, flying, arrived', () => {
    const s = (r: RouteView) => routeStages(r)!.steps.find(x => x.current)?.key;
    expect(routeStages(route({ state: 'none' }))).toBeNull();
    expect(s(route({ state: 'sent' }))).toBe('sent');
    expect(s(route({ state: 'accepted' }))).toBe('accepted');
    expect(s(route({ state: 'accepted', nav: nav() }))).toBe('flying');
    const done = routeStages(route({ state: 'arrived', nav: nav({ status: 'arrived', distanceToGoal: 2 }) }))!;
    expect(done.terminal).toBe('arrived');
    expect(done.steps.every(x => x.done)).toBe(true);
    expect(done.progress).toBe(1);
  });
  it('derives progress from the distance to go', () => {
    const p = routeStages(route({ active, nav: nav({ distanceToGoal: 25 }) }))!;
    expect(p.progress).toBeCloseTo(0.75);
    expect(p.remaining).toBe(25);
  });
  it('a miss is terminal and not marked arrived', () => {
    const m = routeStages(route({ state: 'missed', nav: nav({ status: 'missed' }) }))!;
    expect(m.terminal).toBe('missed');
    expect(m.steps.at(-1)!.label).toBe('Missed');
  });
});

describe('route outcome (measured, never a timer)', () => {
  const outcome = { success: true, simTime: 41.2, closestApproach: 2.1, captureRadius: 5, plannedSimTime: 40.7, plannedPosition: [1, 2, 3] as [number, number, number], goalPosition: [1, 2, 4] as [number, number, number], plannedError: 1.3 };
  it('is absent until the Dimension reports one', () => {
    expect(outcomeView(route({ state: 'arrived', nav: nav({ status: 'arrived' }) }))).toBeNull();
  });
  it('shows rendezvous achieved with the measured values and the number of corrections', () => {
    const v = outcomeView(route({ state: 'arrived', nav: nav({ status: 'arrived', outcome }), history: [{ revision: 1, simTime: 30, reason: 'a', meeting: null }, { revision: 2, simTime: 33, reason: 'b', meeting: null }, { revision: 3, simTime: 36, reason: 'c', meeting: null }] }))!;
    expect(v.title).toBe('RENDEZVOUS ACHIEVED');
    expect(v.rows.find(r => r.k === 'Closest approach')!.v).toContain('2.1 m');
    expect(v.rows.find(r => r.k === 'Prediction error')!.v).toContain('1.3 m');
    expect(v.rows.find(r => r.k === 'Route corrections')!.v).toBe('2');
    expect(v.rows.find(r => r.k === 'Predicted time')!.v).toContain('+0.5 s');
  });
  it('reports a miss honestly', () => {
    const v = outcomeView(route({ state: 'missed', nav: nav({ status: 'missed', outcome: { ...outcome, success: false, closestApproach: 9.4 } }) }))!;
    expect(v.success).toBe(false);
    expect(v.title).toBe('RENDEZVOUS MISSED');
    expect(v.note).toContain('9.4 m');
  });
  it('a non-intercept arrival is not called a rendezvous', () => {
    const v = outcomeView(route({ state: 'arrived', nav: nav({ status: 'arrived', outcome: { ...outcome, plannedPosition: null, plannedSimTime: null, plannedError: null } }) }))!;
    expect(v.title).toBe('ARRIVED AT DESTINATION');
  });
});

describe('route change notes come from real decisions only', () => {
  it('is silent without a decision', () => { expect(routeChangeNote({ routeDecision: null, route: route() })).toBeNull(); });
  it('explains an update and a retained route', () => {
    expect(routeChangeNote({ routeDecision: { kind: 'updated', simTime: 1, trigger: 'meeting-shifted', reason: '' }, route: route() })!.text).toBe('Route updated — target motion revised');
    expect(routeChangeNote({ routeDecision: { kind: 'retained', simTime: 1, trigger: 'none', reason: '' }, route: route() })!.tone).toBe('stable');
    expect(routeChangeNote({ routeDecision: { kind: 'retained', simTime: 1, trigger: 'none', reason: '' }, route: route({ state: 'arrived' }) })).toBeNull();
  });
});
