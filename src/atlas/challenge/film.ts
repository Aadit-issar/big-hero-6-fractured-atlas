import type { ForecastRecord } from './atlasAgent';
import type { PublicRun } from './publicRun';

/** The film clock.
 *
 * The presentation clock M (seconds) maps to simulation time through a deterministic piecewise-linear table. Some segments advance simulation
 * time, others HOLD it so the story can dwell on one scientific moment. Holding never changes what ATLAS knows: no observation is delivered, skipped or
 * reordered. Everything that must stay in step (the scene, the captions, the narration cues, the exported film) reads this one table. */

export interface FilmFacts {
  readonly primaryId: string;
  readonly secondaryId: string | null;
  /** When the primary obstacle's model was first validated. */
  readonly tModelValid: number;
  /** The frozen forecast shown as proof, before any route is chosen. */
  readonly proof: ForecastRecord | null;
  readonly tDecision: number;
  /** The 4 s forecast issued at the decision, scored during the flight. */
  readonly planning: ForecastRecord | null;
  readonly tSecondSeen: number | null;
  readonly tSecondModel: number | null;
  readonly replans: readonly { readonly time: number; readonly obstacleId: string | null; readonly margin: number }[];
  readonly tArrive: number;
}

export function factsFromRun(run: PublicRun, primaryId: string): FilmFacts {
  const first = run.decisions[0]!;
  const secondary = run.spec.obstacles.find(o => o.id !== primaryId)?.id ?? null;
  const seen = (id: string) => run.ticks.find(t => t.sensed.some(s => s.id === id))?.time ?? null;
  const modelEvent = (id: string) => run.events.find(e => e.kind === 'model-published' && e.text.startsWith(id))?.time ?? null;
  const proof = run.forecasts.find(f => f.obstacleId === primaryId && f.lead === 2 && f.status === 'scored') ?? null;
  const planning = run.forecasts.find(f => f.obstacleId === primaryId && f.lead === 4 && f.issuedAt >= first.time - 1e-9 && f.status === 'scored') ?? null;
  return {
    primaryId, secondaryId: secondary, tModelValid: modelEvent(primaryId) ?? 7.5, proof, tDecision: first.time, planning,
    tSecondSeen: secondary ? seen(secondary) : null, tSecondModel: secondary ? modelEvent(secondary) : null,
    replans: run.decisions.filter(d => d.trigger === 'invalidated').map(d => ({ time: d.time, obstacleId: d.replaced?.obstacleId ?? null, margin: d.replaced?.margin ?? 0 })),
    tArrive: run.ticks.find(t => t.step.status === 'arrived')?.time ?? run.spec.durationSeconds,
  };
}

export interface FilmSegment {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly simFrom: number | null;
  readonly simTo: number | null;
}
export interface Film { readonly segments: readonly FilmSegment[]; readonly duration: number; readonly facts: FilmFacts }

export const SEGMENT_IDS = ['intro', 'reveal', 'observe', 'model', 'verify', 'problem', 'conflict', 'calculate', 'fly', 'adapt', 'arrive', 'proof', 'close'] as const;
export type SegmentId = typeof SEGMENT_IDS[number];

/** Authored pacing (presentation seconds). The simulation ranges come from the recorded run. */
export function buildFilm(facts: FilmFacts): Film {
  const proofIssue = facts.proof?.issuedAt ?? facts.tModelValid + 0.5;
  const proofTarget = facts.proof?.targetTime ?? facts.tDecision;
  const flyEnd = facts.replans[0]?.time ?? facts.tDecision + 5;
  const adaptEnd = Math.min(facts.tArrive - 4, (facts.replans.at(-1)?.time ?? flyEnd) + 2.5);
  const spec: readonly (readonly [SegmentId, number, number | null, number | null])[] = [
    ['intro', 5, null, null],
    ['reveal', 7, 0, 0],
    ['observe', 15, 0, proofIssue],
    ['model', 13, proofIssue, proofIssue],
    ['verify', 8, proofIssue, proofTarget],
    ['problem', 9, facts.tDecision, facts.tDecision],
    ['conflict', 13, facts.tDecision, facts.tDecision],
    ['calculate', 14, facts.tDecision, facts.tDecision],
    ['fly', 14, facts.tDecision, flyEnd],
    ['adapt', 20, flyEnd, adaptEnd],
    ['arrive', 11, adaptEnd, facts.tArrive],
    ['proof', 12, facts.tArrive, facts.tArrive],
    ['close', 9, facts.tArrive, facts.tArrive],
  ];
  const segments: FilmSegment[] = [];
  let at = 0;
  for (const [id, d, a, b] of spec) { segments.push({ id, from: at, to: at + d, simFrom: a, simTo: b }); at += d; }
  return { segments, duration: at, facts };
}

export function segmentAt(film: Film, clock: number): FilmSegment {
  const c = Math.min(Math.max(clock, 0), film.duration);
  for (const s of film.segments) if (c < s.to) return s;
  return film.segments.at(-1)!;
}
export const segment = (film: Film, id: SegmentId): FilmSegment => film.segments.find(s => s.id === id)!;

/** Simulation time at presentation time `clock` (null before the first observation). Non-decreasing. */
export function clockToSim(film: Film, clock: number): number | null {
  const s = segmentAt(film, clock);
  if (s.simFrom === null || s.simTo === null) return null;
  if (s.simFrom === s.simTo) return s.simFrom;
  const f = Math.min(1, Math.max(0, (clock - s.from) / (s.to - s.from)));
  return s.simFrom + (s.simTo - s.simFrom) * f;
}
/** The 4 Hz tick whose observation has been delivered by `clock`; -1 before the first. */
export function clockToTick(film: Film, clock: number): number { const t = clockToSim(film, clock); return t === null ? -1 : Math.floor(t * 4 + 1e-9); }

/** The first presentation time at which simulation time `sim` has been reached. */
export function simToClock(film: Film, sim: number): number {
  for (const s of film.segments) {
    if (s.simFrom === null || s.simTo === null) continue;
    if (sim >= s.simFrom - 1e-9 && sim <= s.simTo + 1e-9) return s.simFrom === s.simTo ? s.from : s.from + ((sim - s.simFrom) / (s.simTo - s.simFrom)) * (s.to - s.from);
  }
  return sim < 0 ? 0 : film.duration;
}
