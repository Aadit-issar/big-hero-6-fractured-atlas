import { describe, expect, it } from 'vitest';
import { CHAPTER_TIMES, MissionReplay, missionChapter, missionObservation } from '../src/atlas/lab/missionReplay';
import { AtlasRuntime } from '../src/atlas/core/runtime';

describe('cinematic mission observation integrity', () => {
  it('delivers valid chronological authored observations through the unchanged runtime', () => {
    const runtime = new AtlasRuntime();
    for (let tick = 0; tick <= 112; tick++) {
      const view = runtime.receive(missionObservation(tick / 4), tick * 250);
      expect(view.lastError).toBeNull(); expect(view.observation?.time).toBe(tick / 4);
    }
  });
  it('reveals entities only after their input observation, then retains last-known positions', () => {
    const replay = new MissionReplay();
    expect(replay.seek(0).mapping.summary.uniqueIslands).toBe(1);
    expect(replay.seek(1).mapping.summary.uniqueIslands).toBe(2);
    expect(replay.seek(1.75).mapping.folds).toHaveLength(0);
    const first = replay.seek(2).mapping.folds[0]!;
    const historical = replay.seek(5).mapping.folds[0]!;
    expect(historical.currentState).toBeNull(); expect(historical.lastObservedState).toBe('open');
    expect(historical.lastKnownEntryPosition).toEqual(first.lastKnownEntryPosition);
    expect(replay.seek(5).mapping.islands.find(i => i.id === 'ISLAND 02')?.currentlyObserved).toBe(false);
  });
  it('has the evidence each stage presents by the time its hero moment is reached', () => {
    const replay = new MissionReplay();
    CHAPTER_TIMES.forEach((t, index) => expect(missionChapter(t)).toBe(index));
    expect(replay.seek(5).mapping.summary.previouslyObservedIslands).toBeGreaterThan(0); // Remember
    expect(replay.seek(12).temporal.folds[0]?.observedTransitions).toBe(1); // Detect
    expect(replay.seek(16).temporal.folds[0]?.entry.forecast).not.toBeNull(); // Estimate
    expect(replay.seek(23).mapping.summary.historicalFolds + replay.seek(24).mapping.summary.previouslyObservedIslands).toBeGreaterThan(0); // Understand
  });
  it('archives published estimates before their targets and evaluates them with later evidence', () => {
    const replay = new MissionReplay();
    const forecast = replay.seek(16).temporal.folds[0]!.entry.forecast!;
    expect(forecast.issuedAt).toBe(16); expect(forecast.targetTime).toBe(17);
    expect(forecast.estimate[0]).toBeCloseTo(28.2);
    const before = JSON.stringify(forecast);
    expect(replay.seek(17).temporal.evaluations.some(e => e.issuedAt === 16)).toBe(false);
    const evaluated = replay.seek(17.25).temporal.evaluations.find(e => e.key === 'fold:FOLD 01:entry' && e.issuedAt === 16)!;
    expect(evaluated.published).toBe(true); expect(evaluated.observedAt).toBe(17); expect(evaluated.evaluatedAt).toBe(17.25);
    expect(evaluated.error).toBeLessThan(1e-10);
    expect(JSON.stringify(forecast)).toBe(before);
    expect(replay.readPublished().find(p => p.forecast.issuedAt === 16)?.forecast).toEqual(forecast);
  });
  it('records a changed-motion discrepancy and withholds when visibility is lost', () => {
    const replay = new MissionReplay();
    const changed = replay.seek(22.25).temporal.evaluations.filter(e => e.key === 'fold:FOLD 01:entry' && e.published && !e.covered);
    expect(changed.some(e => e.error > 1)).toBe(true);
    const missing = replay.seek(22.5).temporal.folds[0]!;
    expect(missing.entry.quality).toBe('withheld'); expect(missing.entry.forecast).toBeNull();
    const returned = replay.seek(23).temporal.folds[0]!;
    expect(returned.entry.quality).toBe('insufficient'); expect(returned.entry.forecast).toBeNull();
  });
  it('rewinds by discarding future knowledge, forecasts, scores and discovery records', () => {
    const replay = new MissionReplay(); replay.seek(28);
    expect(replay.seek(0)).toEqual(new MissionReplay().seek(0)); expect(replay.readPublished()).toHaveLength(0);
    expect(replay.seek(16)).toEqual(new MissionReplay().seek(16));
  });
  it('is deterministic for sequential playback, direct seek and repeated full replay', () => {
    const one = new MissionReplay(); for (let t = 0; t <= 28; t += 0.25) one.seek(t);
    const two = new MissionReplay(); expect(one.seek(28)).toEqual(two.seek(28));
    two.seek(0); expect(two.seek(28)).toEqual(one.seek(28));
  });
  it('rejects invalid replay cursors without silently accepting corrupt input', () => {
    const replay = new MissionReplay();
    for (const t of [-1, 29, NaN, Infinity]) expect(() => replay.seek(t)).toThrow(RangeError);
  });
});
