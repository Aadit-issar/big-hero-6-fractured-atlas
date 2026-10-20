import { describe, expect, it } from 'vitest';
import { MissionReplay, MISSION_DURATION, missionChapter } from '../src/atlas/lab/missionReplay';
import { clockToSim, clockToTick, MISSION_CLOCK_END, OBSERVATION_START, segmentAt, simToClock, stageAtClock, STAGE_START_CLOCK, TIMELINE } from '../src/atlas/lab/missionTimeline';
import { direct, FEATURED_HIT, FEATURED_MISS, STORY_FOLD } from '../src/atlas/director/missionDirector';
import { forecastScoreboard, forecastStory, formatAllowance } from '../src/atlas/director/missionFacts';
import { buildSceneModel } from '../src/atlas/scene/sceneModel';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { NO_SCENE_KNOWLEDGE } from '../src/atlas/live/knowledge';
import type { KnowledgeSnapshot } from '../src/atlas/live/knowledge';

const EMPTY: KnowledgeSnapshot = { source: 'replay', view: new AtlasRuntime().getView(0), scene: NO_SCENE_KNOWLEDGE, activity: [], appear: new Map(), lastScanAtS: null, pulses: [] };
function at(replay: MissionReplay, clock: number) {
  const sim = clockToSim(clock);
  if (sim === null) { replay.reset(); return { knowledge: EMPTY, sim }; }
  replay.seek(sim);
  return { knowledge: replay.knowledge(), sim };
}
const beatAt = (replay: MissionReplay, clock: number) => { const { knowledge, sim } = at(replay, clock); return direct(clock, { knowledge, archive: replay.readPublished(), sim }); };

describe('mission clock', () => {
  it('is contiguous, ordered and ends on the last authored observation', () => {
    TIMELINE.forEach((s, i) => { expect(s.to).toBeGreaterThan(s.from); if (i > 0) { expect(s.from).toBeCloseTo(TIMELINE[i - 1]!.to, 9); if (s.simFrom !== null && TIMELINE[i - 1]!.simTo !== null) expect(s.simFrom).toBeCloseTo(TIMELINE[i - 1]!.simTo!, 9); } });
    expect(clockToSim(MISSION_CLOCK_END)).toBe(MISSION_DURATION);
    expect(MISSION_CLOCK_END).toBeGreaterThan(110); expect(MISSION_CLOCK_END).toBeLessThan(130);
  });
  it('maps clock to simulation time monotonically; holds never skip or reorder observations', () => {
    let last = -1;
    for (let c = 0; c <= MISSION_CLOCK_END; c += 0.05) {
      const s = clockToSim(c);
      if (s === null) { expect(last).toBe(-1); continue; }
      expect(s).toBeGreaterThanOrEqual(last); last = s;
    }
    for (let c = 0; c < MISSION_CLOCK_END; c += 0.25) expect(clockToTick(c)).toBeLessThanOrEqual(clockToTick(c + 0.25));
  });
  it('maps simulation time back to the first clock second at which it is delivered', () => {
    for (const sim of [0, 2, 5, 10, 12, 16, 17, 17.25, 21.75, 23, 24, 28]) expect(clockToSim(simToClock(sim))).toBeCloseTo(sim, 6);
    expect(simToClock(0)).toBe(OBSERVATION_START);
  });
  it('has no stage regression during forward playback, and every stage jump lands inside its own stage', () => {
    let last = -1;
    for (let c = 0; c <= MISSION_CLOCK_END; c += 0.05) { const st = stageAtClock(c); expect(st).toBeGreaterThanOrEqual(last); last = st; }
    STAGE_START_CLOCK.forEach((c, i) => expect(stageAtClock(c)).toBe(i));
    for (let sim = 0; sim <= MISSION_DURATION; sim += 0.25) expect(missionChapter(sim)).toBeGreaterThanOrEqual(missionChapter(Math.max(0, sim - 0.25)));
  });
});

describe('forecast accounting and numerical display', () => {
  it('pairs a forecast only with the check of that same forecast and its own allowance (the 4.616 vs 0.048 defect)', () => {
    const replay = new MissionReplay(); replay.seek(22.5);
    const knowledge = replay.knowledge();
    // The old label read the CURRENT forecast's allowance and the LATEST evaluation of an earlier forecast.
    const evals = knowledge.view.temporal.evaluations.filter(e => e.key === 'fold:FOLD 01:entry' && e.published);
    expect(new Set(evals.map(e => e.errorAllowance)).size).toBeGreaterThan(1); // allowances really differ between forecasts
    const small = evals.find(e => Math.abs(e.error - 0.048) < 0.001)!; // the miss that was shown beside a different forecast's allowance
    expect(small.covered).toBe(false); expect(small.errorAllowance).toBeLessThan(small.error);
    const model = buildSceneModel(knowledge, 0, { archive: replay.readPublished(), featured: [small.issuedAt] });
    const est = model.estimates[0]!;
    expect(est.issuedAt).toBe(small.issuedAt); expect(est.evaluation!.allowance).toBe(small.errorAllowance); expect(est.allowance).toBe(small.errorAllowance);
    expect(est.evaluation!.covered).toBe(est.evaluation!.error <= est.evaluation!.allowance + 1e-9);
    // Without a pinned forecast, the current one is shown with no check attached, and the earlier check is reported separately.
    const current = buildSceneModel(knowledge, 0, {}).estimates[0];
    if (current?.status === 'estimate') { expect(current.evaluation).toBeNull(); expect(current.lastCheck).not.toBeNull(); }
  });
  it('every covered flag agrees with error <= its own allowance across the whole replay', () => {
    const replay = new MissionReplay(); const view = replay.seek(28);
    for (const e of view.temporal.evaluations) expect(e.covered).toBe(e.error <= e.errorAllowance + 1e-9);
  });
  it('counts distinct forecasts of one quantity, not overlapping rolling forecasts of every quantity', () => {
    const replay = new MissionReplay(); const view = replay.seek(24);
    const all = view.temporal.evaluations.filter(e => e.published).length;
    const board = forecastScoreboard(view, 'fold:FOLD 01:entry');
    expect(all).toBeGreaterThan(300); // what the old summary displayed ("441 published estimates")
    expect(board.scored).toBeLessThan(all / 5);
    expect(board.scored).toBe(board.withinAllowance + board.missed);
    const issued = view.temporal.evaluations.filter(e => e.key === 'fold:FOLD 01:entry' && e.published).map(e => e.issuedAt);
    expect(new Set(issued).size).toBe(issued.length); // no duplicate accounting of one forecast
    expect(board.windowFull).toBe(false);
    expect(board.missed).toBeGreaterThan(0); // the miss is counted, not hidden
  });
  it('formats allowances without hiding a zero', () => { expect(formatAllowance(3.5e-15)).toBe('± 0.000'); expect(formatAllowance(1.509)).toBe('± 1.509'); });
});

describe('estimate story causality', () => {
  it('publishes the featured forecast before its target observation exists, and evaluates it only later', () => {
    const replay = new MissionReplay();
    replay.seek(16);
    const published = replay.readPublished().find(p => p.forecast.issuedAt === FEATURED_HIT)!;
    expect(published.forecast.targetTime).toBe(17);
    const before = forecastStory(replay.knowledge().view, replay.readPublished(), STORY_FOLD, FEATURED_HIT)!;
    expect(before.arrival).toBeNull(); expect(before.check).toBeNull();
    expect(Math.max(...before.measured.map(m => m.t))).toBeLessThanOrEqual(FEATURED_HIT); // only evidence available at the time
    replay.seek(17);
    const arrived = forecastStory(replay.knowledge().view, replay.readPublished(), STORY_FOLD, FEATURED_HIT)!;
    expect(arrived.arrival).not.toBeNull(); expect(arrived.check).toBeNull(); // observation delivered, comparison not yet made
    replay.seek(17.25);
    const done = forecastStory(replay.knowledge().view, replay.readPublished(), STORY_FOLD, FEATURED_HIT)!;
    expect(done.check).not.toBeNull(); expect(done.check!.covered).toBe(true); expect(done.estimate).toEqual(before.estimate); // frozen: never recomputed
  });
  it('presents a genuine miss with its own allowance', () => {
    const replay = new MissionReplay(); replay.seek(21.75);
    const story = forecastStory(replay.knowledge().view, replay.readPublished(), STORY_FOLD, FEATURED_MISS)!;
    expect(story.check!.covered).toBe(false); expect(story.check!.error).toBeGreaterThan(1); expect(story.check!.allowance).toBe(story.allowance);
  });
  it('abstains when the fold leaves view: no estimate is drawn', () => {
    const replay = new MissionReplay(); replay.seek(23);
    const model = buildSceneModel(replay.knowledge(), 0, {});
    expect(model.estimates.every(e => e.status === 'withheld')).toBe(true); expect(model.estimates[0]?.estimate).toBeNull();
  });
});

describe('presentation director', () => {
  it('never shows knowledge that has not been delivered: the opening is empty', () => {
    const replay = new MissionReplay();
    const beat = beatAt(replay, 1);
    expect(beat.segment).toBe('intro'); expect(beat.labels).toEqual([]); expect(beat.hero).not.toBeNull();
    expect(replay.knowledge().view.mapping.summary.uniqueIslands).toBe(0);
  });
  it('every headline is on screen text and every beat names its stage', () => {
    const replay = new MissionReplay(); let prevStage = -1;
    for (let c = 0; c <= MISSION_CLOCK_END; c += 0.5) {
      const beat = beatAt(replay, c);
      expect(beat.stage).toBe(stageAtClock(c)); expect(beat.stage).toBeGreaterThanOrEqual(prevStage); prevStage = beat.stage;
      expect(beat.segment).toBe(segmentAt(c).id);
      if (beat.card?.kind !== 'decision') expect(beat.headline || beat.line || beat.card).toBeTruthy();
      expect(beat.labels.length).toBeLessThanOrEqual(3);
    }
  });
  it('shows the sensor view before memory in the Remember hero beat, and never edits memory', () => {
    const replay = new MissionReplay();
    const lens = TIMELINE.find(s => s.id === 'remember-lens')!;
    const first = beatAt(replay, lens.from + 0.5), second = beatAt(replay, lens.from + 4), third = beatAt(replay, lens.from + 8);
    expect([first.lens, second.lens, third.lens]).toEqual(['sensor', 'memory', 'memory']);
    expect(first.headline).toBe('OUT OF SENSOR VIEW.'); expect(second.headline).toBe('BUT NOT FORGOTTEN.'); expect(third.headline).toContain('RETAINED');
    const view = replay.knowledge().view.mapping;
    expect(view.islands.find(i => i.id === 'ISLAND 02')!.currentlyObserved).toBe(false);
    expect(view.islands.find(i => i.id === 'ISLAND 02')!.lastKnownPosition).toBeDefined();
    const sensor = buildSceneModel(replay.knowledge(), 0, { lens: 'sensor' }), memory = buildSceneModel(replay.knowledge(), 0, { lens: 'memory' });
    expect(sensor.islands).toEqual(memory.islands); expect(sensor.folds).toEqual(memory.folds); // the lens is a drawing flag only
  });
  it('compares an earlier record with a later one using the fold\'s own samples', () => {
    const replay = new MissionReplay();
    const seg = TIMELINE.find(s => s.id === 'detect-compare')!;
    const beat = beatAt(replay, seg.from + 6);
    expect(beat.card).toEqual({ kind: 'compare', step: 3 });
    const model = buildSceneModel(replay.knowledge(), 0, {});
    const c = model.changes[0]!;
    expect(c.fromT).toBeLessThan(6); expect(c.toT).toBeGreaterThanOrEqual(11.75); expect(c.state).toEqual({ from: 'open', to: 'unstable' }); expect(c.distance).toBeGreaterThan(2);
  });
  it('reveals the estimate only after it is published, and abstention only when the engine abstains', () => {
    const replay = new MissionReplay();
    const pub = TIMELINE.find(s => s.id === 'estimate-publish')!;
    const evidence = beatAt(replay, pub.from + 1), published = beatAt(replay, pub.from + 5);
    expect(evidence.showEstimates).toBe(false); expect(evidence.featured).toEqual([]);
    expect(published.showEstimates).toBe(true); expect(published.featured).toEqual([FEATURED_HIT]);
    const ab = TIMELINE.find(s => s.id === 'estimate-abstain')!;
    const beat = beatAt(replay, ab.from + 1);
    expect(beat.headline).toBe('INSUFFICIENT EVIDENCE.');
    expect(replay.knowledge().view.temporal.folds[0]!.entry.forecast).toBeNull();
  });
  it('seeking backwards restores earlier beats and discards future events', () => {
    const replay = new MissionReplay();
    beatAt(replay, 100); const late = replay.readPublished().length;
    const early = beatAt(replay, 20);
    expect(replay.readPublished().length).toBeLessThan(late);
    const fresh = new MissionReplay();
    expect(JSON.stringify(early)).toBe(JSON.stringify(beatAt(fresh, 20)));
    expect(replay.knowledge().view).toEqual(fresh.knowledge().view);
  });
  it('is deterministic across a full playthrough', () => {
    const run = () => { const r = new MissionReplay(); const out: string[] = []; for (let c = 0; c <= MISSION_CLOCK_END; c += 0.5) out.push(JSON.stringify(beatAt(r, c))); return out; };
    expect(run()).toEqual(run());
  });
});
