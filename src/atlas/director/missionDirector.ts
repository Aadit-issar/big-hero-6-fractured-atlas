import type { WorldVec3 } from '../../shared/atlasContract';
import type { KnowledgeSnapshot } from '../live/knowledge';
import type { CameraShot, ForecastArchiveEntry, SceneFocus } from '../scene/sceneModel';
import type { NavigationAdvice } from '../navigation/types';
import { MISSION_CLOCK_END, segmentAt, STAGE_NAMES } from '../lab/missionTimeline';
import type { StageIndex } from '../lab/missionTimeline';
import { formatAllowance, formatUnits, forecastScoreboard, plainReason } from './missionFacts';

/** The presentation director.
 *
 * SCIENTIFIC EVENT → PRESENTATION BEAT → CAMERA + EMPHASIS + CAPTION.
 * A beat is a pure function of the mission clock and of what ATLAS knows at that moment. It chooses what to look at, what to say and how the
 * camera frames it. It never creates, alters or anticipates an observation: every number it prints is read from the knowledge snapshot,
 * and what the story is about (a fold, a forecast issue time) is the only authored part. */

export type PipelineState = 'off' | 'active' | 'done';
export interface Pipeline { readonly sensor: PipelineState; readonly memory: PipelineState; readonly analysis: PipelineState; readonly decision: PipelineState }
export type ChipTone = 'new' | 'memory' | 'change' | 'estimate' | 'warn' | 'decision';
export interface Chip { readonly label: string; readonly state: 'todo' | 'active' | 'done'; readonly tone: ChipTone }
export type InsightTone = 'new' | 'memory' | 'change' | 'estimate' | 'warn' | 'decision' | 'idle';
export interface Insight { readonly kicker: string; readonly title: string; readonly detail: string; readonly tone: InsightTone }
export type BeatCard =
  | { readonly kind: 'compare'; readonly step: number }
  | { readonly kind: 'strip'; readonly foldId: string; readonly issuedAt: number; readonly step: number }
  | { readonly kind: 'decision'; readonly step: number }
  | { readonly kind: 'finale' };

export interface MissionBeat {
  /** Timeline segment id. */
  readonly segment: string;
  /** Changes whenever the caption or cue changes: animation restarts and audio cues fire on it. */
  readonly key: string;
  readonly stage: StageIndex | -1;
  readonly kicker: string | null;
  readonly headline: string | null;
  readonly line: string | null;
  readonly chips: readonly Chip[];
  readonly pipeline: Pipeline | null;
  readonly insight: Insight | null;
  readonly lens: 'memory' | 'sensor';
  /** Draws attention to the lens switch. */
  readonly lensHint: boolean;
  /** Anchor ids allowed to show a world label. Everything else stays quiet while the story is directed. */
  readonly labels: readonly string[];
  readonly focus: SceneFocus | null;
  readonly shot: CameraShot | null;
  readonly hero: WorldVec3 | null;
  readonly showEstimates: boolean;
  readonly featured: readonly number[];
  readonly card: BeatCard | null;
  readonly navOpen: boolean;
  readonly navGoal: 'none' | 'capsule';
  readonly legend: boolean;
  readonly cue: string | null;
  /** Simulation time is held: no observation is delivered while this beat plays. */
  readonly hold: boolean;
}

export interface DirectorInput { readonly knowledge: KnowledgeSnapshot; readonly archive: readonly ForecastArchiveEntry[]; readonly sim: number | null }

/** Fold forecasts the story presents (issue times on the simulation clock). The first is a steady-motion forecast that holds;
 * the second is published just before the fold's motion changes and misses. Both are read from the archive, never computed here. */
export const FEATURED_HIT = 16;
export const FEATURED_MISS = 20.5;
export const STORY_FOLD = 'FOLD 01';
export const STORY_ISLAND = 'ISLAND 01';

const OFF: Pipeline = { sensor: 'off', memory: 'off', analysis: 'off', decision: 'off' };
const pipe = (p: Partial<Pipeline>): Pipeline => ({ ...OFF, ...p });
const fixed = (n: number, d = 1) => n.toFixed(d);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

function centreOf(points: readonly (readonly number[])[]): { centre: WorldVec3; radius: number } {
  if (points.length === 0) return { centre: [0, 0, 0], radius: 0 };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
  const centre: WorldVec3 = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
  return { centre, radius: Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2 };
}
const frame = (points: readonly (readonly number[])[], yaw: number, pitch: number, drift: number, pad = 12, minDist = 26, scale = 2.1): CameraShot => {
  const { centre, radius } = centreOf(points);
  return { centre, dist: Math.max(minDist, (radius + pad) * scale), yaw, pitch, drift };
};

const base: MissionBeat = {
  segment: '', key: '', stage: -1, kicker: null, headline: null, line: null, chips: [], pipeline: null, insight: null, lens: 'memory', lensHint: false, labels: [],
  focus: null, shot: null, hero: null, showEstimates: false, featured: [], card: null, navOpen: false, navGoal: 'none', legend: false, cue: null, hold: false,
};
const kickerOf = (stage: StageIndex) => `0${stage + 1} / 05 · ${STAGE_NAMES[stage].toUpperCase()}`;
const chips = (labels: readonly string[], active: number, tone: ChipTone): Chip[] => labels.map((label, i) => ({ label, tone, state: i < active ? 'done' : i === active ? 'active' : 'todo' }));

/** Composition per beat: how far to slide the subject to the right of the frame (clear of the caption on the left) and to lift it
 * above a bottom banner. Fractions of the camera distance. */
const COMPOSE: Readonly<Record<string, readonly [shift: number, lift: number]>> = {
  'discover-island': [0.1, 0], 'discover-run': [0.1, 0], 'discover-fold': [0.12, 0], 'discover-debris': [0.1, 0], 'discover-run-3': [0.12, 0],
  'remember-leave': [0.12, 0], 'remember-lens': [0.12, 0], 'remember-run': [0.1, 0], 'understand-run': [0.14, 0], 'understand-decision': [0.15, 0],
  'understand-run-2': [0.02, 0.2], 'understand-end': [0.02, 0.2],
};
const CLEARANCE = 12;

/** Keeps an authored shot honest: the camera never ends up inside an island, and the subject sits where the captions are not. */
function finishShot(shot: CameraShot, segment: string, obstacles: readonly (readonly number[])[]): CameraShot {
  const [shift, lift] = COMPOSE[segment] ?? [0, 0];
  const place = (yaw: number) => {
    const c = Math.cos(shot.pitch);
    return [shot.centre[0] + Math.sin(yaw) * c * shot.dist, shot.centre[1] + Math.sin(shot.pitch) * shot.dist + 1.5, shot.centre[2] + Math.cos(yaw) * c * shot.dist] as const;
  };
  let yaw = shot.yaw;
  for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3, 1.9, -1.9, 2.6, -2.6, Math.PI]) {
    const cam = place(shot.yaw + off);
    if (obstacles.every(o => dist(cam, o) > CLEARANCE)) { yaw = shot.yaw + off; break; }
  }
  const right: WorldVec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const centre: WorldVec3 = [shot.centre[0] - right[0] * shift * shot.dist, shot.centre[1] - lift * shot.dist, shot.centre[2] - right[2] * shift * shot.dist];
  return { ...shot, yaw, centre };
}

/** Direct the mission at mission-clock second `clock`. */
export function direct(clock: number, input: DirectorInput): MissionBeat {
  const beat = directRaw(clock, input);
  if (!beat.shot) return beat;
  const obstacles = input.knowledge.view.mapping.islands.map(i => i.currentPosition ?? i.lastKnownPosition);
  return { ...beat, shot: finishShot(beat.shot, beat.segment, obstacles) };
}

function directRaw(clock: number, input: DirectorInput): MissionBeat {
  const { knowledge } = input;
  const seg = segmentAt(clock);
  const u = Math.max(0, clock - seg.from);
  const view = knowledge.view, map = view.mapping, scene = knowledge.scene;
  const observer: WorldVec3 = map.explorer.latestPosition ?? [0, 0, 0];
  const island = (id: string) => map.islands.find(i => i.id === id);
  const fold = map.folds.find(f => f.id === STORY_FOLD);
  const foldPos: WorldVec3 | null = fold ? (fold.currentEntryPosition ?? fold.lastKnownEntryPosition) : null;
  const cluster = (group: string) => scene.clusters.find(c => c.group === group);
  const hold = seg.simFrom !== null && seg.simFrom === seg.simTo;
  const stage = seg.stage;
  const b = (o: Partial<MissionBeat>): MissionBeat => ({ ...base, segment: seg.id, key: seg.id, stage, hold, ...o, ...(stage >= 0 ? { kicker: kickerOf(stage as StageIndex) } : {}) });
  const posOf = (id: string): WorldVec3 | null => { const i = island(id); if (i) return i.currentPosition ?? i.lastKnownPosition; return null; };

  switch (seg.id) {
    case 'intro': {
      const line = u < 2.2 ? 'STRANDED IN AN UNKNOWN DIMENSION.' : u < 4.4 ? 'NO MAP. UNSTABLE FOLDS. LIMITED OBSERVATIONS.' : 'INITIATING ATLAS.';
      return b({
        key: `intro-${u < 2.2 ? 0 : u < 4.4 ? 1 : 2}`, kicker: 'BIG HERO 6 · FRACTURED', headline: line, hero: [0, 0, 0], labels: [],
        shot: { centre: [0, 1.1, 0], dist: 10.5, yaw: 0.5, pitch: 0.08, drift: 1 },
        insight: { kicker: 'ATLAS INSIGHT', title: 'AWAITING SENSOR INPUT.', detail: 'ATLAS has received nothing yet. It knows only what Baymax observes.', tone: 'idle' },
        pipeline: u > 4.4 ? pipe({ sensor: 'active' }) : null, cue: u > 4.4 ? 'boot' : null,
      });
    }
    case 'discover-island': {
      const step = u < 1.6 ? 0 : u < 3.2 ? 1 : 2;
      const isl = island(STORY_ISLAND);
      const range = isl ? dist(observer, isl.currentPosition ?? isl.lastKnownPosition) : 0;
      const ps = isl ? [observer, isl.currentPosition ?? isl.lastKnownPosition] : [observer];
      return b({
        key: `d-island-${step}`, headline: 'Baymax scans.', line: 'ATLAS records what his sensors actually detect.',
        chips: chips(['SCAN RECEIVED', `${STORY_ISLAND} ACQUIRED`, 'ADDED TO MEMORY'], step, 'new'),
        pipeline: pipe({ sensor: step === 0 ? 'active' : 'done', memory: step === 0 ? 'off' : step === 1 ? 'active' : 'done' }),
        insight: step === 0 ? { kicker: 'ATLAS INSIGHT', title: 'SCAN RECEIVED.', detail: 'Baymax’s sensor has delivered its first observation.', tone: 'idle' }
          : { kicker: 'ATLAS INSIGHT', title: 'NEW ISLAND RECORDED.', detail: `${STORY_ISLAND} · ${fixed(range)} units from Baymax · first observed at t 0.00 s.`, tone: 'new' },
        labels: ['baymax-observer', STORY_ISLAND], focus: { ids: [STORY_ISLAND], debris: false },
        shot: { ...frame(ps, 0.12, 0.26, 1, 9, 30), dist: 34 }, cue: `scan-${step}`,
      });
    }
    case 'discover-run': {
      const labels = ['baymax-observer', STORY_ISLAND, ...(u > 1.4 ? ['ISLAND 02'] : [])];
      const pts = map.islands.map(i => i.currentPosition ?? i.lastKnownPosition);
      return b({
        key: u > 1.4 ? 'd-run-2' : 'd-run-1', headline: 'Baymax scans.', line: u > 1.4 ? 'A second island enters sensor range.' : 'ATLAS records what his sensors actually detect.',
        pipeline: pipe({ sensor: 'active', memory: map.islands.length > 1 ? 'active' : 'done' }),
        insight: map.islands.length > 1 ? { kicker: 'ATLAS INSIGHT', title: 'NEW ISLAND RECORDED.', detail: `ISLAND 02 · observed at t ${fixed(island('ISLAND 02')?.firstSeenAt ?? 0, 2)} s.`, tone: 'new' } : null,
        labels, focus: { ids: ['ISLAND 01', 'ISLAND 02'], debris: false }, shot: frame([observer, ...pts], 0.1, 0.28, 1, 10, 34), cue: u > 1.4 ? 'ack' : null,
      });
    }
    case 'discover-fold': {
      const step = u < 1.8 ? 0 : u < 3.4 ? 1 : 2;
      const state = (fold?.currentState ?? fold?.lastObservedState ?? 'open').toUpperCase();
      return b({
        key: `d-fold-${step}`, headline: 'A dimensional fold.', line: `A connection between regions. ATLAS knows its state only from observations: ${state} at t ${fixed(fold?.lastSeenAt ?? 2, 2)} s.`,
        chips: chips(['FOLD DETECTED', `STATE: ${state}`, 'ADDED TO MEMORY'], step, 'new'),
        pipeline: pipe({ sensor: step === 0 ? 'active' : 'done', memory: step === 0 ? 'off' : step === 1 ? 'active' : 'done' }),
        insight: { kicker: 'ATLAS INSIGHT', title: 'NEW FOLD RECORDED.', detail: `${STORY_FOLD} · reported ${state} · its far end has not been explored.`, tone: 'new' },
        labels: [STORY_FOLD], focus: { ids: [STORY_FOLD], debris: false },
        shot: foldPos ? { centre: foldPos, dist: 25, yaw: 0.16, pitch: 0.22, drift: 0.6 } : null, cue: `fold-${step}`,
      });
    }
    case 'discover-run-2':
    case 'discover-debris': {
      const c = cluster('concrete');
      const step = seg.id === 'discover-run-2' ? 0 : u < 2 ? 1 : 2;
      return b({
        key: `d-debris-${step}`, headline: 'Debris, grouped.', line: 'ATLAS records meaningful clusters, not hundreds of loose pieces.',
        chips: c ? chips([`${c.label.toUpperCase()}`, `${plural(c.count, 'OBJECT')} ACQUIRED`, 'ONE CLUSTER IN MEMORY'], step, 'new') : [],
        pipeline: pipe({ sensor: 'done', memory: 'active' }),
        insight: c ? { kicker: 'ATLAS INSIGHT', title: 'DEBRIS CLUSTER RECORDED.', detail: `${c.label}: ${plural(c.count, 'scanned object')} grouped (acquired by the scan at t 0.00 s).`, tone: 'new' } : null,
        labels: c ? [c.id] : [], focus: { ids: [], debris: true }, shot: c ? { centre: c.centre, dist: Math.max(28, c.extent * 4.4), yaw: -0.9, pitch: 0.24, drift: 0.6 } : null, cue: step === 1 ? 'ack' : null,
      });
    }
    case 'discover-run-3': {
      const pts = [observer, ...map.islands.map(i => i.currentPosition ?? i.lastKnownPosition), ...(foldPos ? [foldPos] : []), ...scene.clusters.map(c => c.centre)];
      return b({
        key: 'd-sum', headline: 'The first picture forms.', line: `${plural(map.summary.uniqueIslands, 'island')}, ${plural(map.summary.uniqueFolds, 'fold')} and ${plural(scene.clusters.length, 'debris cluster')}: every item arrived through an accepted observation or scan.`,
        pipeline: pipe({ sensor: 'done', memory: 'done' }), labels: ['baymax-observer'], focus: null,
        shot: frame(pts, 0.14, 0.34, 1, 12, 44, 1.75),
      });
    }
    case 'remember-leave': {
      const remembered = [...map.islands.filter(i => !i.currentlyObserved).map(i => i.currentPosition ?? i.lastKnownPosition), ...map.folds.filter(f => !f.currentlyObserved).map(f => f.lastKnownEntryPosition)];
      return b({
        key: 'r-leave', headline: 'Baymax moves on.', line: 'Some of what he saw is no longer in his sensor view.', lens: 'sensor', lensHint: true,
        pipeline: pipe({ sensor: 'active' }), labels: ['baymax-observer'], focus: { ids: [STORY_ISLAND], debris: false },
        shot: frame([observer, ...remembered], 0.04, 0.3, 0.5, 14, 50, 1.9),
        insight: { kicker: 'ATLAS INSIGHT', title: 'SENSOR VIEW UPDATED.', detail: 'ISLAND 02 and FOLD 01 are not in the current observation.', tone: 'memory' }, cue: 'leave',
      });
    }
    case 'remember-lens': {
      const step = u < 3.2 ? 0 : u < 6.4 ? 1 : 2;
      const remembered = [...map.islands.filter(i => !i.currentlyObserved).map(i => i.currentPosition ?? i.lastKnownPosition), ...map.folds.filter(f => !f.currentlyObserved).map(f => f.lastKnownEntryPosition)];
      const f = fold, i2 = island('ISLAND 02');
      const lines = ['OUT OF SENSOR VIEW.', 'BUT NOT FORGOTTEN.', 'LAST-KNOWN POSITION RETAINED.'];
      const sub = [
        'This is what Baymax’s sensor shows right now. ISLAND 02 and FOLD 01 are gone from it.',
        'ATLAS’s memory still holds them, drawn dim and cool: remembered, not observed.',
        `${i2 ? `ISLAND 02 last seen t ${fixed(i2.lastSeenAt, 2)} s. ` : ''}${f ? `FOLD 01 last recorded ${f.lastObservedState.toUpperCase()} at t ${fixed(f.lastSeenAt, 2)} s. ` : ''}Their current state is unknown.`,
      ];
      return b({
        key: `r-lens-${step}`, headline: lines[step]!, line: sub[step]!, lens: step === 0 ? 'sensor' : 'memory', lensHint: true,
        chips: chips(['CURRENT VIEW', 'ATLAS MEMORY', 'LAST-KNOWN RETAINED'], step, 'memory'),
        pipeline: pipe({ sensor: step === 0 ? 'active' : 'done', memory: step === 0 ? 'off' : 'active' }),
        insight: step === 0 ? { kicker: 'ATLAS INSIGHT', title: 'OBJECT OUT OF SENSOR VIEW.', detail: 'It is no longer in the current observation.', tone: 'memory' }
          : { kicker: 'ATLAS INSIGHT', title: 'LAST-KNOWN STATE RETAINED.', detail: 'Memory keeps the record; it does not claim the object is still there.', tone: 'memory' },
        labels: step === 0 ? ['baymax-observer'] : ['baymax-observer', 'ISLAND 02', STORY_FOLD], focus: { ids: ['ISLAND 02', STORY_FOLD, STORY_ISLAND], debris: false },
        shot: frame([observer, ...remembered], 0.04, 0.3, 0.25, 14, 50, 1.9), legend: step >= 1, cue: `lens-${step}`,
      });
    }
    case 'remember-run': {
      return b({
        key: 'r-run', headline: 'Baymax keeps exploring.', line: 'Memory stays in place while he moves.', lens: 'memory',
        pipeline: pipe({ memory: 'active' }), labels: ['baymax-observer'], focus: { ids: [STORY_FOLD, 'ISLAND 02', STORY_ISLAND], debris: false },
        shot: frame([observer, ...(foldPos ? [foldPos] : []), ...(posOf('ISLAND 02') ? [posOf('ISLAND 02')!] : [])], 0.1, 0.3, 0.6, 14, 44, 1.9),
      });
    }
    case 'detect-reobserve': {
      const prior = fold?.track[0];
      const same = fold && prior ? fold.currentState === prior.state : true;
      return b({
        key: 'x-reobserve', headline: `${STORY_FOLD} is observed again.`, line: same ? 'ATLAS compares the new measurement with its earlier record. So far they agree: OPEN, same place.' : 'ATLAS compares the new measurement with its earlier record.',
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'active' }),
        insight: { kicker: 'ATLAS INSIGHT', title: 'FOLD RE-OBSERVED.', detail: `${STORY_FOLD} is back in the current observation. Comparing with the record from t ${fixed(fold?.track.filter(s => s.time < 6).at(-1)?.time ?? 4.75, 2)} s.`, tone: 'memory' },
        labels: [STORY_FOLD], focus: { ids: [STORY_FOLD], debris: false }, shot: foldPos ? { centre: foldPos, dist: 21, yaw: 0.2, pitch: 0.16, drift: 0 } : null, cue: 'compare',
      });
    }
    case 'detect-run': {
      const changed = knowledge.view.events.some(e => e.kind === 'fold-state-changed');
      return b({
        key: changed ? 'x-run-diff' : 'x-run', headline: changed ? 'The record no longer matches.' : `${STORY_FOLD} is observed again.`, line: changed ? 'A newer observation disagrees with the earlier one.' : 'ATLAS compares the new measurement with its earlier record.',
        pipeline: pipe({ analysis: 'active', memory: 'done' }),
        insight: changed ? { kicker: 'ATLAS INSIGHT', title: 'NEW OBSERVATION DIFFERS FROM PREVIOUS RECORD.', detail: `${STORY_FOLD}: the recorded state changed.`, tone: 'change' } : null,
        labels: [STORY_FOLD], focus: { ids: [STORY_FOLD], debris: false }, shot: foldPos ? { centre: foldPos, dist: 21, yaw: 0.2, pitch: 0.16, drift: 0 } : null, cue: changed ? 'change' : null,
      });
    }
    case 'detect-compare': {
      const step = u < 1.6 ? 0 : u < 3.4 ? 1 : u < 5.4 ? 2 : 3;
      const ch = foldChange(knowledge);
      const text = ch ? [
        ['BEFORE.', `The earlier record: ${ch.fromState.toUpperCase()}, last seen at t ${fixed(ch.fromT, 2)} s.`],
        ['AFTER.', `The newer observation: ${ch.toState.toUpperCase()}, at t ${fixed(ch.toT, 2)} s.`],
        ['POSITION SHIFT DETECTED.', `The fold's entry moved ${fixed(ch.distance)} units between the two observations.`],
        [`${STORY_FOLD} CHANGED.`, `${ch.fromState.toUpperCase()} → ${ch.toState.toUpperCase()}.${ch.distance > 1 ? ` Shifted ${fixed(ch.distance)} units.` : ''}`],
      ][step]! : ['COMPARING.', 'Earlier record against the newest observation.'];
      return b({
        key: `x-cmp-${step}`, headline: text[0]!, line: text[1]!,
        chips: chips(['BEFORE', 'AFTER', 'DIFFERENCE', 'CONCLUSION'], step, 'change'),
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'active' }),
        insight: { kicker: 'ATLAS INSIGHT', title: step === 3 ? 'FOLD STATE CHANGE RECORDED.' : 'NEW OBSERVATION DIFFERS FROM PREVIOUS RECORD.', detail: ch ? `${STORY_FOLD}: ${ch.fromState} (t ${fixed(ch.fromT, 2)}) → ${ch.toState} (t ${fixed(ch.toT, 2)}).` : 'Comparing observations.', tone: 'change' },
        labels: [`cmp-before-${STORY_FOLD}`, `cmp-after-${STORY_FOLD}`], focus: { ids: [STORY_FOLD], debris: false },
        card: { kind: 'compare', step }, shot: ch ? { centre: [(ch.from[0] + ch.to[0]) / 2, (ch.from[1] + ch.to[1]) / 2, (ch.from[2] + ch.to[2]) / 2], dist: 19, yaw: 0.14, pitch: 0.14, drift: 0 } : null,
        cue: step === 3 ? 'changed' : `cmp-${step}`,
      });
    }
    case 'detect-run-2': {
      return b({
        key: 'x-run-2', headline: 'ATLAS keeps measuring.', line: 'Each new observation adds to the fold’s record.',
        pipeline: pipe({ analysis: 'active', memory: 'done' }), labels: [], focus: { ids: [STORY_FOLD], debris: false },
        shot: foldPos ? { centre: foldPos, dist: 22, yaw: 0.16, pitch: 0.18, drift: 0.3 } : null,
      });
    }
    case 'estimate-run':
    case 'estimate-publish':
    case 'estimate-wait':
    case 'estimate-arrive':
    case 'estimate-step':
    case 'estimate-result': return estimateBeat(seg.id, u, input, b);
    case 'estimate-run-2': {
      return b({
        key: 'e-run-2', headline: 'Time passes.', line: 'Then the fold’s motion changes.', pipeline: pipe({ analysis: 'active' }), showEstimates: false,
        labels: [], focus: { ids: [STORY_FOLD], debris: false }, shot: foldPos ? { centre: foldPos, dist: 24, yaw: 0.12, pitch: 0.2, drift: 0.3 } : null,
      });
    }
    case 'estimate-miss': return estimateBeat('estimate-miss', u, input, b);
    case 'estimate-run-3': {
      return b({ key: 'e-run-3', headline: 'Then the fold leaves view.', line: 'ATLAS no longer has current measurements of it.', pipeline: pipe({ analysis: 'active' }), showEstimates: false, labels: [], focus: { ids: [STORY_FOLD], debris: false }, shot: foldPos ? { centre: foldPos, dist: 28, yaw: 0.12, pitch: 0.22, drift: 0.3 } : null });
    }
    case 'estimate-abstain': {
      const dyn = view.temporal.folds[0];
      const reason = plainReason(dyn?.entry.reasons[0]);
      const step = u < 2.2 ? 0 : 1;
      return b({
        key: `e-abstain-${step}`, headline: step === 0 ? 'INSUFFICIENT EVIDENCE.' : 'ANOTHER OBSERVATION REQUIRED.', line: step === 0 ? 'ATLAS declines to estimate where the fold will be. Guessing would not be knowledge.' : reason,
        chips: chips(['NO ESTIMATE PUBLISHED', 'MORE EVIDENCE NEEDED'], step, 'warn'), showEstimates: true,
        pipeline: pipe({ memory: 'done', analysis: 'active' }),
        insight: { kicker: 'ATLAS INSIGHT', title: 'INSUFFICIENT EVIDENCE FOR A RELIABLE ESTIMATE.', detail: reason, tone: 'warn' },
        labels: [`estimate-${STORY_FOLD}`], focus: { ids: [STORY_FOLD], debris: false },
        card: { kind: 'strip', foldId: STORY_FOLD, issuedAt: FEATURED_MISS, step: 9 }, shot: foldPos ? { centre: foldPos, dist: 24, yaw: 0.12, pitch: 0.2, drift: 0 } : null, cue: 'abstain',
      });
    }
    case 'understand-run': {
      const pts = [observer, ...map.islands.map(i => i.currentPosition ?? i.lastKnownPosition), ...(foldPos ? [foldPos] : []), ...scene.clusters.map(c => c.centre)];
      return b({
        key: 'u-run', headline: 'What does ATLAS know now?', line: 'The observations so far form a partial map.', pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'done', decision: 'active' }),
        labels: ['baymax-observer'], shot: frame(pts, 0.18, 0.4, 0.6, 14, 56, 1.8), cue: 'rise',
      });
    }
    case 'understand-decision': {
      const step = u < 3.5 ? 0 : u < 8 ? 1 : u < 13 ? 2 : 3;
      const capsule = cluster('capsule');
      const pts = [observer, ...map.islands.map(i => i.currentPosition ?? i.lastKnownPosition), ...(foldPos ? [foldPos] : []), ...scene.clusters.map(c => c.centre)];
      const shot = step >= 2 && capsule ? frame([observer, capsule.centre], 0.2, 0.3, 0.5, 14, 44, 1.9) : frame(pts, 0.18, 0.4, 0.6, 14, 56, 1.8);
      return b({
        key: `u-dec-${step}`, headline: step === 0 ? 'WHAT SHOULD BAYMAX DO NEXT?' : null, line: null,
        chips: chips(['THE QUESTION', 'NEXT OBSERVATION', 'DESTINATION', 'THE LIMITS'], step, 'decision'),
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'done', decision: 'active' }),
        navOpen: step >= 1, navGoal: step >= 2 ? 'capsule' : 'none', card: { kind: 'decision', step }, legend: false,
        labels: step >= 2 && capsule ? ['baymax-observer', 'nav-goal', 'nav-target'] : ['baymax-observer', 'nav-target'], focus: step >= 2 && capsule ? { ids: [], debris: true } : null,
        shot, cue: `decision-${step}`,
      });
    }
    case 'understand-run-2':
    case 'understand-end': {
      const capsule = cluster('capsule');
      return b({
        key: 'u-finale', stage: 4, kicker: 'ATLAS', headline: 'AN UNKNOWN WORLD IS BECOMING UNDERSTANDABLE.',
        line: 'ATLAS doesn’t know the entire dimension. It learns enough to help Baymax decide what to do next.',
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'done', decision: 'done' }), navOpen: true, navGoal: 'capsule', card: { kind: 'finale' },
        labels: ['baymax-observer', 'nav-goal'], focus: capsule ? { ids: [], debris: true } : null,
        shot: capsule ? frame([observer, capsule.centre], 0.28, 0.26, 0.6, 14, 42, 1.9) : null, cue: 'finale',
      });
    }
  }
  return b({});
}

/** The measured change of the story fold, from its own record: the earlier record against the newest observation. */
export function foldChange(knowledge: KnowledgeSnapshot): { from: WorldVec3; to: WorldVec3; fromT: number; toT: number; fromState: string; toState: string; distance: number } | null {
  const fold = knowledge.view.mapping.folds.find(f => f.id === STORY_FOLD);
  if (!fold) return null;
  const maxGap = knowledge.view.temporal.policy.maxGapSeconds;
  let before = fold.track[0];
  for (let i = fold.track.length - 1; i > 0; i -= 1) if (fold.track[i]!.time - fold.track[i - 1]!.time > maxGap) { before = fold.track[i - 1]; break; }
  const after = fold.track.at(-1);
  if (!before || !after || after.time <= before.time) return null;
  return { from: before.entryPosition, to: after.entryPosition, fromT: before.time, toT: after.time, fromState: before.state, toState: after.state, distance: dist(before.entryPosition, after.entryPosition) };
}

function estimateBeat(id: string, u: number, input: DirectorInput, b: (o: Partial<MissionBeat>) => MissionBeat): MissionBeat {
  const { knowledge, archive } = input;
  const view = knowledge.view;
  const fold = view.mapping.folds.find(f => f.id === STORY_FOLD);
  const pos: WorldVec3 | null = fold ? (fold.currentEntryPosition ?? fold.lastKnownEntryPosition) : null;
  const miss = id === 'estimate-miss';
  const issuedAt = miss ? FEATURED_MISS : FEATURED_HIT;
  const entry = archive.find(p => p.key === `fold:${STORY_FOLD}:entry` && p.forecast.issuedAt === issuedAt);
  const ev = view.temporal.evaluations.find(e => e.key === `fold:${STORY_FOLD}:entry` && e.published && e.issuedAt === issuedAt);
  const arrived = !!fold?.track.find(s => entry && Math.abs(s.time - entry.forecast.targetTime) < 1e-9);
  const shot = pos ? { centre: pos, dist: 21, yaw: 0.12, pitch: 0.18, drift: 0 } : null;
  const common = { labels: [`estimate-${STORY_FOLD}`, ...(arrived ? [`estimate-observed-${STORY_FOLD}`] : [])], focus: { ids: [STORY_FOLD], debris: false } as SceneFocus, shot };
  const stripCard = (step: number): BeatCard => ({ kind: 'strip', foldId: STORY_FOLD, issuedAt, step });
  const dyn = view.temporal.folds.find(f => f.id === STORY_FOLD);
  switch (id) {
    case 'estimate-run':
      return b({ key: 'e-run', headline: 'Repeated observations.', line: 'The fold is being measured over and over. Each dot is something Baymax’s sensor actually reported.', pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'active' }), showEstimates: false,
        card: stripCard(0), labels: [], focus: common.focus, shot, cue: 'measure', insight: { kicker: 'ATLAS INSIGHT', title: 'TREND UNDER ANALYSIS.', detail: `${plural(dyn?.sampleCount ?? 0, 'measurement')} of ${STORY_FOLD}’s entry position.`, tone: 'estimate' } });
    case 'estimate-publish': {
      const step = u < 3.4 ? 0 : 1;
      return b({
        key: `e-pub-${step}`, headline: step === 0 ? 'WHAT WAS MEASURED.' : 'PREDICTION PUBLISHED.', line: step === 0 ? 'Solid dots: measurements. The fold has moved steadily.' : `ESTIMATE — NOT OBSERVED. Where ATLAS expects the fold at t ${fixed(entry?.forecast.targetTime ?? 17, 2)} s. It is now frozen.`,
        chips: chips(['MEASURED', 'ESTIMATE PUBLISHED', 'NEW OBSERVATION', 'RESULT COMPARED'], step, 'estimate'),
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'active' }), showEstimates: step === 1, featured: step === 1 ? [issuedAt] : [],
        insight: step === 0 ? { kicker: 'ATLAS INSIGHT', title: 'EVIDENCE GATHERED.', detail: 'Repeated measurements support a short, limited estimate.', tone: 'estimate' }
          : { kicker: 'ATLAS INSIGHT', title: 'ESTIMATE PUBLISHED — AWAITING LATER EVIDENCE.', detail: entry ? `For t ${fixed(entry.forecast.targetTime, 2)} s. Allowed error ${formatAllowance(entry.forecast.errorAllowance)} units${entry.forecast.errorAllowance < 0.0005 ? ': the fold had moved in a perfectly straight line' : ''}.` : 'Awaiting a later observation.', tone: 'estimate' },
        card: stripCard(step), ...common, labels: step === 1 ? [`estimate-${STORY_FOLD}`] : [], cue: step === 1 ? 'predict' : null,
      });
    }
    case 'estimate-wait':
      return b({ key: 'e-wait', headline: 'TIME MOVES FORWARD.', line: 'The estimate cannot change. The target time has not arrived yet.', chips: chips(['MEASURED', 'ESTIMATE PUBLISHED', 'NEW OBSERVATION', 'RESULT COMPARED'], 1, 'estimate'),
        pipeline: pipe({ memory: 'done', analysis: 'active' }), showEstimates: true, featured: [issuedAt], card: stripCard(2), ...common, labels: [`estimate-${STORY_FOLD}`] });
    case 'estimate-arrive':
      return b({ key: 'e-arrive', headline: 'NEW OBSERVATION RECEIVED.', line: `Baymax’s sensor reports the fold’s position at t ${fixed(entry?.forecast.targetTime ?? 17, 2)} s.`, chips: chips(['MEASURED', 'ESTIMATE PUBLISHED', 'NEW OBSERVATION', 'RESULT COMPARED'], 2, 'estimate'),
        pipeline: pipe({ sensor: 'active', memory: 'done', analysis: 'active' }), showEstimates: true, featured: [issuedAt], card: stripCard(3), ...common,
        insight: { kicker: 'ATLAS INSIGHT', title: 'LATER OBSERVATION RECEIVED.', detail: 'ATLAS has not yet compared it with the estimate.', tone: 'estimate' }, cue: 'arrive' });
    case 'estimate-step':
    case 'estimate-result':
    case 'estimate-miss': {
      const ok = ev?.covered ?? true;
      const headline = !ev ? 'RESULT COMPARED.' : miss && u > 2.4 ? 'ATLAS KEEPS THE MISS ON RECORD.' : 'RESULT COMPARED.';
      const line = !ev ? 'Comparing the frozen estimate with the new observation.'
        : ok ? `Off by ${formatUnits(ev.error)} units, within the allowed error (${formatAllowance(ev.errorAllowance)}). Assuming “nothing moves” would have missed by ${formatUnits(ev.persistenceError)}.`
        : u > 2.4 && miss ? 'The fold’s motion changed. A published estimate is checked, never quietly replaced.'
        : `Off by ${formatUnits(ev.error)} units, outside the allowed error (${formatAllowance(ev.errorAllowance)}). The fold’s motion changed after the estimate was made.`;
      return b({
        key: `e-res-${id}-${miss && u > 2.4 ? 1 : 0}`, headline, line,
        chips: chips(['MEASURED', 'ESTIMATE PUBLISHED', 'NEW OBSERVATION', 'RESULT COMPARED'], 3, ok ? 'estimate' : 'warn'),
        pipeline: pipe({ sensor: 'done', memory: 'done', analysis: 'active' }), showEstimates: true, featured: [issuedAt],
        insight: ev ? { kicker: 'ATLAS INSIGHT', title: 'ESTIMATE COMPARED AGAINST LATER OBSERVATION.', detail: `Issued t ${fixed(ev.issuedAt, 2)} s for t ${fixed(ev.targetTime, 2)} s: ${ok ? 'within' : 'outside'} its allowance.`, tone: ok ? 'estimate' : 'warn' } : null,
        card: stripCard(4), ...common, cue: ev ? (ok ? 'match' : 'miss') : null,
      });
    }
  }
  return b({});
}

/** Words for the final decision, taken from the planner's own advice. The planner decides; this only phrases its answer. */
export function decisionText(step: number, advice: NavigationAdvice): { title: string; lines: string[] } {
  const rec = advice.recommendation;
  const limits = advice.limitations.slice(0, 2);
  if (step === 0) return { title: 'WHAT SHOULD BAYMAX DO NEXT?', lines: ['ATLAS reads only its own records: what is observed, what is remembered, what has changed.'] };
  if (step === 1) return { title: 'NEXT OBSERVATION RECOMMENDED.', lines: [rec.title, rec.detail] };
  if (step === 2) {
    const route = advice.route;
    return { title: 'DESTINATION IDENTIFIED.', lines: [route ? `${advice.goalLabel ?? 'Destination'}: observed now. One candidate approach of about ${route.segments.reduce((n, s) => n + s.length, 0).toFixed(0)} units.` : rec.title, 'This is a candidate. It is not a verified path.'] };
  }
  const unverified = advice.route?.segments.some(s => s.support === 'unverified-approach');
  return {
    title: unverified ? 'APPROACH NOT VERIFIED.' : advice.status === 'route' ? 'ROUTE SUPPORTED BY RECORDS.' : 'THE LIMITS.',
    lines: [...limits, unverified ? 'NEXT ACTION: acquire more evidence along the approach before committing.' : rec.detail],
  };
}

export { forecastScoreboard, MISSION_CLOCK_END };
