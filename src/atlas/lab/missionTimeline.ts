/** The mission clock.
 *
 * The guided mission runs on one presentation clock `M` (seconds). The authored observations run on simulation time `sim`.
 * A deterministic, piecewise-linear script maps M to sim: some segments advance simulation time, others HOLD it so the story can
 * stop on one scientific moment (a comparison, a frozen estimate) without inventing, skipping or reordering any observation.
 * Everything that must stay in step (delivery of observations, stage identity, captions, camera, animation, audio) reads this one table.
 *
 * Holding simulation time never changes what ATLAS knows: during a hold no new observation is delivered. */

export type StageIndex = 0 | 1 | 2 | 3 | 4;
export const STAGE_NAMES = ['Discover', 'Remember', 'Detect', 'Estimate', 'Understand'] as const;

export interface TimelineSegment {
  readonly id: string;
  /** Mission-clock seconds. */
  readonly from: number;
  readonly to: number;
  /** Simulation seconds at the start and end of the segment; null before the first observation. */
  readonly simFrom: number | null;
  readonly simTo: number | null;
  readonly stage: StageIndex | -1;
}

type Spec = readonly [id: string, duration: number, simFrom: number | null, simTo: number | null, stage: StageIndex | -1];

/** Authored pacing. Durations are mission-clock seconds.
 * Stage starts are the first segment of each stage; see STAGE_START_CLOCK. */
const SPEC: readonly Spec[] = [
  ['intro', 6, null, null, -1],
  // DISCOVER: one island, one fold, one debris cluster
  ['discover-island', 5, 0, 0, 0],
  ['discover-run', 3.5, 0, 2, 0],
  ['discover-fold', 5, 2, 2, 0],
  ['discover-run-2', 1, 2, 3, 0],
  ['discover-debris', 4.5, 3, 3, 0],
  ['discover-run-3', 4.5, 3, 5, 0],
  // REMEMBER: current sensor view against ATLAS's memory
  ['remember-leave', 3.5, 5, 7, 1],
  ['remember-lens', 10, 7, 7, 1],
  ['remember-run', 3, 7, 10, 1],
  // DETECT: the earlier record against the later observation
  ['detect-reobserve', 2.5, 10, 10, 2],
  ['detect-run', 4, 10, 12, 2],
  ['detect-compare', 8.5, 12, 12, 2],
  ['detect-run-2', 2, 12, 14, 2],
  // ESTIMATE: evidence, a frozen estimate, later reality, an honest miss, and a refusal
  ['estimate-run', 3, 14, 16, 3],
  ['estimate-publish', 7, 16, 16, 3],
  ['estimate-wait', 2.5, 16, 17, 3],
  ['estimate-arrive', 3, 17, 17, 3],
  ['estimate-step', 0.5, 17, 17.25, 3],
  ['estimate-result', 3.5, 17.25, 17.25, 3],
  ['estimate-run-2', 3, 17.25, 21.75, 3],
  ['estimate-miss', 4.5, 21.75, 21.75, 3],
  ['estimate-run-3', 1, 21.75, 23, 3],
  ['estimate-abstain', 4.5, 23, 23, 3],
  // UNDERSTAND: knowledge becomes a decision
  ['understand-run', 1.5, 23, 24, 4],
  ['understand-decision', 19.5, 24, 24, 4],
  ['understand-run-2', 3, 24, 28, 4],
  ['understand-end', 3, 28, 28, 4],
];

function build(): { segments: TimelineSegment[]; end: number } {
  const segments: TimelineSegment[] = [];
  let at = 0;
  for (const [id, d, a, b, stage] of SPEC) { segments.push({ id, from: at, to: at + d, simFrom: a, simTo: b, stage }); at += d; }
  return { segments, end: at };
}
const BUILT = build();
export const TIMELINE: readonly TimelineSegment[] = BUILT.segments;
/** Total length of the guided mission on the mission clock. */
export const MISSION_CLOCK_END = BUILT.end;
/** Mission-clock second at which the first observation is delivered; the clock before it is the opening. */
export const OBSERVATION_START = TIMELINE.find(s => s.simFrom !== null)!.from;
/** Mission-clock second of the first segment of each stage. */
export const STAGE_START_CLOCK: readonly number[] = ([0, 1, 2, 3, 4] as const).map(st => TIMELINE.find(s => s.stage === st)!.from);
/** Simulation second at which each stage starts: the evidence a stage is about to present exists from then on. */
export const STAGE_START_SIM: readonly number[] = ([0, 1, 2, 3, 4] as const).map(st => TIMELINE.find(s => s.stage === st)!.simFrom!);

export function segmentAt(clock: number): TimelineSegment {
  const c = Math.min(Math.max(clock, 0), MISSION_CLOCK_END);
  for (const s of TIMELINE) if (c < s.to) return s;
  return TIMELINE[TIMELINE.length - 1]!;
}

/** Simulation time at mission-clock `clock`, or null while nothing has been observed yet. Non-decreasing in `clock`. */
export function clockToSim(clock: number): number | null {
  const s = segmentAt(clock);
  if (s.simFrom === null || s.simTo === null) return null;
  if (s.simFrom === s.simTo) return s.simFrom;
  const f = Math.min(1, Math.max(0, (clock - s.from) / (s.to - s.from)));
  return s.simFrom + (s.simTo - s.simFrom) * f;
}

/** Quantised to the 4 Hz delivery grid: the last tick whose observation the runtime has received at this clock. */
export function clockToTick(clock: number): number { const t = clockToSim(clock); return t === null ? -1 : Math.floor(t * 4 + 1e-9); }

/** The first mission-clock second at which simulation time `sim` is reached (the moment its observation is delivered). */
export function simToClock(sim: number): number {
  for (const s of TIMELINE) {
    if (s.simFrom === null || s.simTo === null) continue;
    if (sim >= s.simFrom - 1e-9 && sim <= s.simTo + 1e-9) {
      if (s.simFrom === s.simTo) return s.from;
      return s.from + ((sim - s.simFrom) / (s.simTo - s.simFrom)) * (s.to - s.from);
    }
  }
  return sim < 0 ? OBSERVATION_START : MISSION_CLOCK_END;
}

/** Stage identity is a pure, monotone function of the mission clock: it can never step backwards during forward playback. */
export function stageAtClock(clock: number): StageIndex | -1 { return segmentAt(clock).stage; }

/** Stage identity for a simulation second, for evidence checks against the replay engine. */
export function stageAtSim(sim: number): StageIndex {
  let stage: StageIndex = 0;
  STAGE_START_SIM.forEach((t, i) => { if (sim >= t - 1e-9) stage = i as StageIndex; });
  return stage;
}
