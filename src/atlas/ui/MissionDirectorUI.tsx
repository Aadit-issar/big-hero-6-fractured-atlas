import { useState } from 'react';
import type { AtlasView } from '../core/runtime';
import type { KnowledgeSnapshot } from '../live/knowledge';
import type { NavigationAdvice } from '../navigation/types';
import type { ForecastArchiveEntry, SceneModel } from '../scene/sceneModel';
import { decisionText, FEATURED_MISS, foldChange, STORY_FOLD } from '../director/missionDirector';
import type { Chip, MissionBeat, Pipeline } from '../director/missionDirector';
import { forecastScoreboard, forecastStory, formatAllowance, formatUnits } from '../director/missionFacts';
import type { ForecastStory } from '../director/missionFacts';
import './mission-director.css';

const f1 = (n: number, d = 1) => n.toFixed(d);
const fmtPos = (p: readonly number[]) => p.map(n => n.toFixed(1)).join(', ');

/** Lower-left caption: one headline the audience can read from the back of a room, one sentence, and a few progress chips. */
export function Caption({ beat }: { beat: MissionBeat }) {
  if (!beat.headline && !beat.line) return null;
  return (
    <div className="md-caption" data-reserve="" data-testid="mission-caption" key={beat.key}>
      {beat.kicker && <p className="md-kicker">{beat.kicker}</p>}
      {beat.headline && <h1 className="md-headline" data-testid="mission-headline">{beat.headline}</h1>}
      {beat.line && <p className="md-line">{beat.line}</p>}
      {beat.chips.length > 0 && <ChipRow chips={beat.chips} />}
    </div>
  );
}

function ChipRow({ chips }: { chips: readonly Chip[] }) {
  return <ol className="md-chips" aria-label="Progress">{chips.map(c => <li key={c.label} className={`tone-${c.tone} state-${c.state}`}><i />{c.label}</li>)}</ol>;
}

/** SENSOR → MEMORY → ANALYSIS → DECISION. Lit only for stages that have actually happened in the replay. */
export function PipelineBar({ pipeline }: { pipeline: Pipeline | null }) {
  if (!pipeline) return null;
  const nodes: [keyof Pipeline, string][] = [['sensor', 'SENSOR'], ['memory', 'MEMORY'], ['analysis', 'ANALYSIS'], ['decision', 'DECISION']];
  return (
    <ol className="md-pipeline" aria-label="How ATLAS processes an observation" data-testid="pipeline">
      {nodes.map(([k, label], i) => <li key={k} className={`s-${pipeline[k]}`} data-node={k}>{i > 0 && <span className="md-pipe-arrow">→</span>}<b>{label}</b></li>)}
    </ol>
  );
}

/** CURRENT VIEW against ATLAS MEMORY. Draws from the same knowledge; choosing a view never deletes anything. */
export function LensToggle({ lens, hint, onChange }: { lens: 'memory' | 'sensor'; hint: boolean; onChange: (lens: 'memory' | 'sensor') => void }) {
  return (
    <div className={`md-lens ${hint ? 'hint' : ''}`} role="group" aria-label="Knowledge view" data-reserve="" data-testid="lens-toggle">
      <button aria-pressed={lens === 'sensor'} onClick={() => onChange('sensor')} data-lens="sensor"><b>CURRENT VIEW</b><small>what Baymax senses now</small></button>
      <button aria-pressed={lens === 'memory'} onClick={() => onChange('memory')} data-lens="memory"><b>ATLAS MEMORY</b><small>everything ATLAS knows</small></button>
    </div>
  );
}

export function Legend({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className={`md-legend ${open ? 'open' : ''}`} data-reserve="" data-testid="legend">
      <button onClick={onToggle} aria-expanded={open}>{open ? 'Hide legend' : 'Legend'}</button>
      {open && <ul>
        <li><i className="sw observed" /><b>OBSERVED NOW</b><span>bright and solid: in the current observation</span></li>
        <li><i className="sw remembered" /><b>REMEMBERED</b><span>dim and dashed: last-known, not confirmed now</span></li>
        <li><i className="sw changed" /><b>CHANGED</b><span>amber: two observations disagree</span></li>
        <li><i className="sw estimated" /><b>ESTIMATED</b><span>hollow diamond: a projection, not a measurement</span></li>
        <li><i className="sw unknown" /><b>UNKNOWN</b><span>not drawn: nothing has established it</span></li>
      </ul>}
    </div>
  );
}

/** Before and after, side by side, from the fold's own records. */
export function CompareCard({ knowledge, step }: { knowledge: KnowledgeSnapshot; step: number }) {
  const ch = foldChange(knowledge);
  if (!ch) return null;
  const shift = ch.distance;
  return (
    <section className="md-card md-compare" data-reserve="" data-testid="card-compare" aria-label={`${STORY_FOLD} before and after`} data-step={step}>
      <div className="md-cols">
        <div className={`md-panel before ${step >= 0 ? 'on' : ''}`}>
          <p className="md-panel-k">BEFORE · EARLIER RECORD</p>
          <p className="md-state">{ch.fromState.toUpperCase()}</p>
          <p className="md-meta">observed t {f1(ch.fromT, 2)} s</p>
          <p className="md-meta">entry {fmtPos(ch.from)}</p>
        </div>
        <div className={`md-arrow ${step >= 2 ? 'on' : ''}`} aria-hidden="true">
          <span>{step >= 2 ? `${f1(shift)} units` : ''}</span>
          <svg viewBox="0 0 80 14"><path d="M2 7h70M64 2l8 5-8 5" /></svg>
        </div>
        <div className={`md-panel after ${step >= 1 ? 'on' : ''}`}>
          <p className="md-panel-k">AFTER · NEWER OBSERVATION</p>
          <p className="md-state">{ch.toState.toUpperCase()}</p>
          <p className="md-meta">observed t {f1(ch.toT, 2)} s</p>
          <p className="md-meta">entry {fmtPos(ch.to)}</p>
        </div>
      </div>
      <p className={`md-verdict ${step >= 3 ? 'on' : ''}`}>{ch.fromState !== ch.toState ? `${ch.fromState.toUpperCase()} → ${ch.toState.toUpperCase()}` : 'STATE UNCHANGED'}{shift > 1 ? ` · position shifted ${f1(shift)} units` : ''}</p>
    </section>
  );
}

/** Measured / estimated / measured later, on one small chart. The estimate is a different kind of mark from every measurement. */
export function EstimateStrip({ knowledge, archive, foldId, issuedAt, step }: { knowledge: KnowledgeSnapshot; archive: readonly ForecastArchiveEntry[]; foldId: string; issuedAt: number; step: number }) {
  const view = knowledge.view;
  const story = forecastStory(view, archive, foldId, issuedAt);
  const abstain = step === 9;
  const measured = abstain || !story ? measuredWindow(view, foldId) : story.measured;
  if (measured.length === 0) return null;
  const showEstimate = !!story && step >= 1 && step !== 9;
  const showArrival = !!story?.arrival && step >= 3 && step !== 9;
  const check = story?.check && step >= 4 && !abstain ? story.check : null;
  const W = 520, H = 196, L = 46, R = 18, T = 20, B = 36;
  const ts = [...measured.map(m => m.t), ...(showEstimate ? [story!.estimate.t] : [])];
  const t0 = Math.min(...ts), tEnd = Math.max(...ts, t0 + 1);
  const t1 = abstain ? t0 + (tEnd - t0) * 1.45 : tEnd;
  const vs = [...measured.map(m => m.s), ...(showEstimate ? [story!.estimate.s - story!.allowance, story!.estimate.s + story!.allowance] : []), ...(showArrival ? [story!.arrival!.s] : [])];
  let v0 = Math.min(...vs), v1 = Math.max(...vs);
  if (v1 - v0 < 1) { v0 -= 0.5; v1 += 0.5; }
  const pad = (v1 - v0) * 0.12; v0 -= pad; v1 += pad;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const last = measured.at(-1)!;
  const verdict = check ? (check.covered ? 'WITHIN ALLOWANCE' : 'OUTSIDE ALLOWANCE') : null;
  return (
    <section className={`md-card md-strip ${abstain ? 'abstain' : ''}`} data-reserve="" data-testid="card-strip" data-step={step} aria-label="Measured, estimated and later observed positions">
      <div className="md-strip-head">
        <span className="k-measured"><i />MEASURED</span>
        <span className={`k-estimate ${showEstimate ? '' : 'off'}`}><i />ESTIMATE · NOT OBSERVED</span>
        <span className={`k-later ${showArrival ? '' : 'off'}`}><i />OBSERVED LATER</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chart of the fold's position over time">
        <line className="axis" x1={L} y1={H - B} x2={W - R} y2={H - B} />
        <line className="axis" x1={L} y1={T} x2={L} y2={H - B} />
        <text className="tick" x={L} y={H - 12}>t {f1(t0, 2)} s</text>
        <text className="tick" x={W - R} y={H - 12} textAnchor="end">t {f1(tEnd, 2)} s</text>
        <text className="axis-name" transform={`translate(14 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">position</text>
        <text className="axis-name" x={(L + W - R) / 2} y={H - 12} textAnchor="middle">time</text>
        <polyline className="trail" points={measured.map(m => `${x(m.t)},${y(m.s)}`).join(' ')} />
        {measured.map(m => <circle key={m.t} className="dot measured" cx={x(m.t)} cy={y(m.s)} r={3.4} />)}
        {showEstimate && <>
          <line className="project" x1={x(last.t)} y1={y(last.s)} x2={x(story!.estimate.t)} y2={y(story!.estimate.s)} />
          <line className="allow" x1={x(story!.estimate.t)} y1={y(story!.estimate.s - story!.allowance)} x2={x(story!.estimate.t)} y2={y(story!.estimate.s + story!.allowance)} />
          <rect className="diamond" x={x(story!.estimate.t) - 7} y={y(story!.estimate.s) - 7} width={14} height={14} transform={`rotate(45 ${x(story!.estimate.t)} ${y(story!.estimate.s)})`} />
        </>}
        {showArrival && check && <line className={`miss ${check.covered ? 'ok' : ''}`} x1={x(story!.estimate.t)} y1={y(story!.estimate.s)} x2={x(story!.arrival!.t)} y2={y(story!.arrival!.s)} />}
        {showArrival && <circle className="dot later" cx={x(story!.arrival!.t)} cy={y(story!.arrival!.s)} r={5.2} />}
        {abstain && <g className="no-estimate"><rect x={x(last.t) + 14} y={T + 22} width={Math.max(40, W - R - x(last.t) - 22)} height={H - T - B - 44} rx={6} /><text x={x(last.t) + 14 + Math.max(40, W - R - x(last.t) - 22) / 2} y={(H - B + T) / 2 - 4} textAnchor="middle">NO ESTIMATE</text><text x={x(last.t) + 14 + Math.max(40, W - R - x(last.t) - 22) / 2} y={(H - B + T) / 2 + 14} textAnchor="middle">PUBLISHED</text></g>}
      </svg>
      {check && story && (
        <div className={`md-result ${check.covered ? 'ok' : 'bad'}`} data-testid="forecast-result">
          <b>{verdict}</b>
          <span>Estimate was off by <em>{formatUnits(check.error)}</em> units · allowed error {formatAllowance(check.allowance)} · “nothing moves” would have been off by {formatUnits(check.noChangeError)}</span>
        </div>
      )}
      {!check && story && step >= 1 && step !== 9 && <p className="md-result-pending">Issued at t {f1(story.issuedAt, 2)} s for t {f1(story.targetTime, 2)} s · allowed error {formatAllowance(story.allowance)}{showArrival ? ' · comparing…' : ' · target not reached yet'}</p>}
    </section>
  );
}

function measuredWindow(view: AtlasView, foldId: string): { t: number; s: number }[] {
  const fold = view.mapping.folds.find(f => f.id === foldId);
  if (!fold) return [];
  const span = view.temporal.policy.windowSamples * 0.25;
  const end = fold.track.at(-1)?.time ?? 0;
  const used = fold.track.filter(s => s.time >= end - span);
  const o = used[0]?.entryPosition;
  if (!o) return [];
  const range = [0, 1, 2].map(k => Math.max(...used.map(s => s.entryPosition[k]!)) - Math.min(...used.map(s => s.entryPosition[k]!)));
  const axis = range.indexOf(Math.max(...range));
  return used.map(s => ({ t: s.time, s: s.entryPosition[axis]! - o[axis]! }));
}

/** What the audience reads while the planner answers. The words come from the planner's own advice. */
export function DecisionCard({ step, advice, knowledge }: { step: number; advice: NavigationAdvice; knowledge: KnowledgeSnapshot }) {
  const text = decisionText(step, advice);
  const s = knowledge.view.mapping.summary;
  const scene = knowledge.scene.records;
  const sceneNow = scene.filter(r => r.currentlyObserved).length;
  const board = forecastScoreboard(knowledge.view, `fold:${STORY_FOLD}:entry`);
  const changes = knowledge.view.events.filter(e => e.kind === 'fold-state-changed' || e.kind === 'island-position-changed').length;
  return (
    <section className={`md-decision step-${step}`} data-reserve="" data-testid="card-decision" key={step} aria-live="polite">
      <p className="md-kicker">05 / 05 · UNDERSTAND</p>
      <h1 className="md-headline" data-testid="mission-headline">{text.title}</h1>
      {text.lines.map((l, i) => <p key={i} className={`md-line ${i === 0 ? '' : 'sub'}`}>{l}</p>)}
      {step === 0 && (
        <dl className="md-ledger" data-testid="mission-summary">
          <div className="k-observed"><dt>OBSERVED NOW</dt><dd>{s.currentlyObservedIslands} island{s.currentlyObservedIslands === 1 ? '' : 's'}, {s.currentlyObservedFolds} fold{s.currentlyObservedFolds === 1 ? '' : 's'}, {sceneNow} scanned object{sceneNow === 1 ? '' : 's'}</dd></div>
          <div className="k-remembered"><dt>REMEMBERED</dt><dd>{s.previouslyObservedIslands} island{s.previouslyObservedIslands === 1 ? '' : 's'}, {s.historicalFolds} fold{s.historicalFolds === 1 ? '' : 's'}, {scene.length - sceneNow} scanned object{scene.length - sceneNow === 1 ? '' : 's'} as last-known</dd></div>
          <div className="k-changed"><dt>CHANGED</dt><dd>{changes} recorded change{changes === 1 ? '' : 's'}: a fold’s state differs from its earlier record</dd></div>
          <div className="k-estimated"><dt>ESTIMATED</dt><dd>{board.scored} one-second forecasts of {STORY_FOLD}’s position, each compared with a later measurement: {board.withinAllowance} within allowance, {board.missed} missed</dd></div>
          <div className="k-unknown"><dt>UNKNOWN</dt><dd>everything no observation has established</dd></div>
        </dl>
      )}
      {step === 3 && <p className="md-hint">Open “Why?” in the advisor for the full evidence.</p>}
    </section>
  );
}

export function FinaleCard({ headline, line, onReplay }: { headline: string; line: string; onReplay: () => void }) {
  return (
    <section className="md-finale" data-reserve="" data-testid="mission-finale" aria-live="polite">
      <h1 className="md-headline" data-testid="mission-headline">{headline}</h1>
      <p className="md-line">{line}</p>
      <div className="md-finale-actions">
        <a className="md-prove" href="?experience=live" data-testid="prove-live">PROVE IT LIVE <small>connect to the Dimension</small></a>
        <button className="md-again" onClick={onReplay}>↺ Replay mission</button>
      </div>
      <p className="md-fine">That was a guided replay of authored, simulated observations. Live Scan reads the running Dimension; if no Dimension session is open, it says so and does not substitute this replay.</p>
    </section>
  );
}

/** Evidence the viewer can open for any major event. Rows are read from ATLAS's own records at the moment the mission is paused there. */
export interface EvidenceEvent { readonly id: string; readonly label: string; readonly clock: number }
export function EvidenceDrawer({ event, knowledge, archive, advice, onClose }: { event: EvidenceEvent; knowledge: KnowledgeSnapshot; archive: readonly ForecastArchiveEntry[]; advice: NavigationAdvice | null; onClose: () => void }) {
  const rows = evidenceRows(event.id, knowledge, archive, advice);
  return (
    <aside className="md-drawer" data-reserve="" data-testid="evidence-drawer" aria-label={`Evidence: ${event.label}`}>
      <button className="md-close" aria-label="Return to the mission" onClick={onClose}>×</button>
      <p className="md-kicker">EVIDENCE</p>
      <h2>{event.label}</h2>
      <p className="md-note">{rows.summary}</p>
      <dl>{rows.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="md-note faint">{rows.source}</p>
      <button className="md-return" onClick={onClose}>Return to the mission</button>
    </aside>
  );
}

export function evidenceRows(id: string, knowledge: KnowledgeSnapshot, archive: readonly ForecastArchiveEntry[], advice: NavigationAdvice | null): { summary: string; rows: [string, string][]; source: string } {
  const view = knowledge.view;
  const source = 'Source: authored, simulated observations delivered to the real ATLAS pipeline (guided replay).';
  if (id === 'island') {
    const i = view.mapping.islands.find(x => x.id === 'ISLAND 01');
    if (!i) return { summary: 'Not recorded yet.', rows: [], source };
    return { summary: 'The first thing ATLAS recorded: an island delivered by Baymax’s first observation.', source, rows: [
      ['Record', i.id], ['First observed', `t ${f1(i.firstSeenAt, 2)} s`], ['Last observed', `t ${f1(i.lastSeenAt, 2)} s`], ['Observations', String(i.observationCount)],
      ['Position', fmtPos(i.currentPosition ?? i.lastKnownPosition)], ['Status', i.currentlyObserved ? 'observed now' : 'remembered (last-known)'],
    ] };
  }
  if (id === 'change') {
    const ch = foldChange(knowledge);
    if (!ch) return { summary: 'No difference between observations has been recorded yet.', rows: [], source };
    return { summary: `${STORY_FOLD}’s newest observation disagrees with ATLAS’s earlier record of it.`, source, rows: [
      ['Earlier record', `${ch.fromState} at t ${f1(ch.fromT, 2)} s, entry ${fmtPos(ch.from)}`], ['Newer observation', `${ch.toState} at t ${f1(ch.toT, 2)} s, entry ${fmtPos(ch.to)}`],
      ['Position shift', `${f1(ch.distance, 2)} units`], ['State', `${ch.fromState} → ${ch.toState}`], ['Observations of the fold', String(view.mapping.folds.find(f => f.id === STORY_FOLD)?.observationCount ?? 0)],
    ] };
  }
  if (id === 'forecast' || id === 'check' || id === 'miss') {
    const issued = id === 'miss' ? FEATURED_MISS : 16;
    const story = forecastStory(view, archive, STORY_FOLD, issued);
    if (!story) return { summary: 'No estimate has been published yet.', rows: [], source };
    const rows: [string, string][] = [
      ['Published', `t ${f1(story.issuedAt, 2)} s (before its target)`], ['Estimate is for', `t ${f1(story.targetTime, 2)} s`], ['Method', 'local linear fit of the last measurements'],
      ['Measurements used', String(story.measured.length)], ['Allowed error', `${formatAllowance(story.allowance)} units (descriptive, not a probability)`],
      ['Target observation', story.arrival ? `delivered (t ${f1(story.arrival.t, 2)} s)` : 'not delivered yet'],
    ];
    if (story.check) rows.push(['Compared at', `t ${f1(story.check.evaluatedAt, 2)} s`], ['Error', `${formatUnits(story.check.error)} units`], ['Result', story.check.covered ? 'within the allowed error' : 'outside the allowed error'], ['“Nothing moves” error', `${formatUnits(story.check.noChangeError)} units`]);
    return { summary: 'A frozen estimate is never recomputed with later information. It is compared with the first later measurement at its target time.', rows, source };
  }
  if (id === 'recommendation') {
    if (!advice) return { summary: 'The advisor is not open yet.', rows: [], source };
    return { summary: advice.recommendation.detail, source: 'Source: the ATLAS navigation planner, using only acquired knowledge. It ranks candidates; it does not claim a path is safe.', rows: [
      ['Status', advice.status], ['Recommendation', advice.recommendation.title],
      ...advice.evidence.slice(0, 4).map((e, i): [string, string] => [`${e.kind} ${i + 1}`, e.text]),
      ...advice.limitations.slice(0, 3).map((l, i): [string, string] => [`limit ${i + 1}`, l]),
    ] };
  }
  return { summary: '', rows: [], source };
}

/** Evidence menu: jump the mission to a major event and open its records. */
export function EvidenceMenu({ events, onPick }: { events: readonly EvidenceEvent[]; onPick: (event: EvidenceEvent) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="md-evmenu">
      <button onClick={() => setOpen(v => !v)} aria-expanded={open} data-testid="evidence-menu">◇ Show me the evidence</button>
      {open && <ul role="menu">{events.map(e => <li key={e.id} role="none"><button role="menuitem" onClick={() => { setOpen(false); onPick(e); }}>{e.label}</button></li>)}</ul>}
    </span>
  );
}

/** The model is used by overlays that need scene-space data (kept for tests that render cards alone). */
export type { SceneModel, ForecastStory };
