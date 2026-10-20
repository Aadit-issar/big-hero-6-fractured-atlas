import { useCallback, useEffect, useRef, useState } from 'react';
import type { AtlasView } from '../core/runtime';
import { AtlasConsole } from './AtlasConsole';
import { Hologram } from './Hologram';
import type { PublishedPosition } from '../lab/missionReplay';
import './mission-experience.css';

export const CHAPTERS = [
  ['Discover', 'The dimension\nis unknown.', 'Baymax begins observing what surrounds him. Every arrival on this map begins with an accepted observation.'],
  ['Remember', 'Out of sight.\nNot forgotten.', 'Discoveries remain in memory. Dim silhouettes preserve the last observed position, even when Baymax moves away.'],
  ['Detect', 'The world\nhas changed.', 'A new observation revises an earlier record. The old position remains evidence; the latest position tells a different story.'],
  ['Estimate', 'Patterns emerge\nfrom observation.', 'Repeated measurements support a short estimate. Later observations test it. When the evidence changes, ATLAS withholds its claim.'],
  ['Understand', 'Knowledge changes\nwhat comes next.', 'What is known. What has changed. What needs another look. This is how the search begins.'],
] as const;

export interface MissionExperienceProps {
  view: AtlasView; mode: 'mission' | 'live' | 'stress'; chapter: number; time: number; playing: boolean; begun: boolean;
  published?: readonly PublishedPosition[]; onPlay: () => void; onSeek: (time: number) => void;
  onReplay: () => void; onStage: (stage: number) => void; speed: number; onSpeed: (speed: number) => void;
}

const fmt = (p: readonly number[]) => p.map(n => n.toFixed(2)).join(' / ');

export function MissionExperience(props: MissionExperienceProps) {
  const { view, mode, chapter, time, playing, begun } = props;
  const source = mode === 'mission' ? 'GUIDED SIMULATION REPLAY' : mode === 'stress' ? 'STRESS FIXTURE · NOT LIVE' : 'LIVE LAB · ISOLATED SIMULATION';
  const [selected, setSelected] = useState<string | null>(null);
  const [guided, setGuided] = useState(true);
  const [evidence, setEvidence] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [fullscreenError, setFullscreenError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const manual = useCallback(() => setGuided(false), []);
  const select = useCallback((id: string) => { setSelected(id); setGuided(true); setEvidence(false); }, []);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (selected && !view.mapping.islands.some(i => i.id === selected) && !view.mapping.folds.some(f => f.id === selected)) { setSelected(null); setEvidence(false); }
  }, [view, selected]);
  useEffect(() => { setSelected(null); setEvidence(false); setGuided(true); }, [chapter]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('button, input, select, textarea, a')) return;
      if (event.code === 'Space' && mode === 'mission') { event.preventDefault(); props.onPlay(); }
      if (event.key === 'Escape') { setEvidence(false); setSelected(null); }
      if (event.key.toLowerCase() === 'g') setGuided(true);
      if (event.key === 'ArrowRight' && mode === 'mission') props.onStage(Math.min(4, chapter + 1));
      if (event.key === 'ArrowLeft' && mode === 'mission') props.onStage(Math.max(0, chapter - 1));
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [props, mode, chapter]);

  const summary = view.mapping.summary;
  const fold = view.mapping.folds.find(f => f.id === selected);
  const island = view.mapping.islands.find(i => i.id === selected);
  const record = fold ?? island;
  const dynamics = view.temporal.folds.find(f => f.id === (fold?.id ?? view.mapping.folds[0]?.id));
  const motion = dynamics?.entry;
  const evaluation = [...view.temporal.evaluations].reverse().find(e => e.published && e.key === motion?.key && e.issuedAt >= 16);
  const recordedChanges = view.events.filter(e => e.kind === 'fold-state-changed').length;
  const [title, description] = mode === 'stress' ? ['Spatial memory,\nunder load.', `${view.mapping.summary.uniqueIslands} islands and ${view.mapping.summary.uniqueFolds} reported folds. A labelled stress fixture processed through the real runtime. Select an identity to inspect its evidence.`] : mode === 'live' ? ['The world,\nas observed.', 'An isolated running dimension. Only observations delivered through Baymax’s authorised sensor enter this map.'] : [CHAPTERS[chapter]![1], CHAPTERS[chapter]![2]];
  let insight = `${summary.currentlyObservedIslands} islands visible · ${summary.currentlyObservedFolds} folds visible`;
  if (chapter === 1) insight = `${summary.previouslyObservedIslands} island remembered · ${summary.historicalFolds} fold with current state unknown`;
  if (chapter === 2 && dynamics) insight = `${dynamics.observedTransitions} observed fold state change${dynamics.observedTransitions === 1 ? '' : 's'} · ${dynamics.lastObservedState}`;
  if (chapter === 3) insight = motion?.forecast ? `Movement estimate published · target t ${motion.forecast.targetTime.toFixed(2)}s` : 'Not enough reliable evidence to predict.';
  if (chapter === 4) insight = `${summary.uniqueIslands} islands recorded · ${summary.uniqueFolds} fold remembered`;
  const event = view.events.find(e => ['fold-state-changed', 'fold-left', 'fold-reobserved', 'island-discovered', 'island-left'].includes(e.kind));
  const eventText = event?.kind === 'fold-state-changed' ? 'A new observation changed a portal’s recorded state.' : event?.kind === 'fold-left' ? 'Previously seen portal is no longer visible. Current state unknown.' : event?.kind === 'fold-reobserved' ? 'A remembered portal has been observed again.' : event?.kind === 'island-left' ? 'An island left current visibility. Its last position is remembered.' : event ? 'A new island discovery has been stored.' : null;

  if (analysis) return <div className="mission-analysis"><div className="analysis-return"><button onClick={() => setAnalysis(false)}>← Return to hologram</button><span>{mode === 'mission' ? `${source} · FROZEN EVIDENCE` : source}</span></div><AtlasConsole view={view} sourceLabel={source} /></div>;

  return <div className="mission-shell" ref={root} data-testid="mission-experience" data-chapter={chapter} data-time={view.observation?.time ?? -1} data-samples={view.sampleCount}>
    <Hologram view={view} chapter={chapter} selected={selected} onSelect={select} guided={guided} onManual={manual} reduced={reduced} {...(props.published ? { published: props.published } : {})} />
    <div className="mission-atmosphere" />
    <header className="mission-header">
      <a className="mission-brand" href="?experience=mission" aria-label="ATLAS Mission Demo"><span className="atlas-symbol">A</span><span>ATLAS<small>THE MEMORY OF A BROKEN WORLD</small></span></a>
      <nav aria-label="ATLAS experiences"><a aria-current={mode === 'mission' ? 'page' : undefined} href="?experience=mission">Mission Demo</a><a aria-current={mode === 'live' ? 'page' : undefined} href="?experience=live">Live Exploration</a><button onClick={() => { setAnalysis(true); if (playing) props.onPlay(); }}>Advanced Analysis ↗</button></nav>
      <span className="mission-provenance"><i />{source}</span>
    </header>

    <main className="mission-narrative" key={`${mode}-${chapter}`}>
      <p className="mission-kicker">{!begun && mode === 'mission' ? 'BIG HERO 6: FRACTURED / MISSION BRIEFING' : `${mode === 'live' ? 'LIVE SENSOR LINK' : `CHAPTER 0${chapter + 1} / 05`} · ${mode === 'live' ? 'OBSERVE & REMEMBER' : CHAPTERS[chapter]![0].toUpperCase()}`}</p>
      <h1>{!begun && mode === 'mission' ? <>Before the way home,<br /><em>the unknown.</em></> : title.split('\n').map((line, i) => <span key={line} className={i === 1 ? 'title-accent' : ''}>{line}<br /></span>)}</h1>
      <p className="mission-description">{!begun && mode === 'mission' ? 'Before Baymax can find a way home, he must learn the world he’s lost in.' : description}</p>
      {!begun && mode === 'mission' ? <><button className="mission-begin" onClick={props.onPlay}>Begin Mission <span>↗</span></button><p className="mission-fine">115 seconds · Interactive 3D · Actual ATLAS analysis<br />Authored simulated observations, delivered chronologically.</p></> : <div className="mission-insight" aria-live="polite"><span className="signal-line" /><p>{insight}</p></div>}
      {begun && chapter === 3 && <div className="temporal-story" data-testid="mission-temporal">
        <p className="mission-kicker">{motion?.forecast ? 'OBSERVATION → LIMITED ESTIMATE' : 'ESTIMATE WITHHELD'}</p>
        <strong>{motion?.forecast ? `t ${motion.forecast.issuedAt.toFixed(2)} → ${motion.forecast.targetTime.toFixed(2)}s` : 'ATLAS will wait for further observations.'}</strong>
        {evaluation && <p>Later observation checked the earlier estimate.<br /><b>{evaluation.error.toFixed(3)} world units</b> of measured discrepancy.{!evaluation.covered && ' Observed movement differed from the earlier estimate.'}</p>}
        <button onClick={() => { setEvidence(true); setSelected(view.mapping.folds[0]?.id ?? null); }}>Inspect this evidence ↗</button>
      </div>}
      {chapter === 4 && <div className="mission-summary" data-testid="mission-summary">
        <div><span>WHAT WE KNOW</span><strong>{summary.uniqueIslands} islands. {summary.uniqueFolds} fold.</strong></div>
        <div><span>WHAT HAS CHANGED</span><strong>{recordedChanges} recorded fold state change{recordedChanges === 1 ? '' : 's'}.</strong></div>
        <div><span>WHAT REMAINS UNKNOWN</span><strong>{summary.historicalFolds ? 'Portal availability is not confirmed.' : 'Destination conditions are not observed.'}</strong></div>
        <button onClick={() => { setSelected(view.mapping.folds[0]?.id ?? null); setEvidence(true); }}>Can Baymax trust the last-known portal? ↗</button>
      </div>}
    </main>

    <div className="mission-map-caption"><span>SPATIAL MEMORY / WORLD X · Y · Z</span><p>Island shapes are symbols, not measured scans.<br />Dotted tethers show reported relations, not safe routes.</p></div>
    <div className="mission-legend"><span><i className="legend-current" />Observed</span><span><i className="legend-memory" />Remembered</span><span><i className="legend-estimate" />Estimate</span></div>

    <aside className={`mission-context ${selected || evidence ? 'has-selection' : ''}`} aria-label="Spatial evidence">
      <div className="mission-context-top"><span className="mission-kicker">{selected ? 'SELECTED RECORD' : 'OBSERVER TELEMETRY'}</span>{selected && <button aria-label="Close selected record" onClick={() => { setSelected(null); setEvidence(false); }}>×</button>}</div>
      {record ? <>
        <h2>{record.id}</h2><p className={record.currentlyObserved ? 'current-state' : 'historical-state'}>{record.currentlyObserved ? 'CURRENTLY OBSERVED' : 'REMEMBERED · CURRENT LOCATION UNCONFIRMED'}</p>
        {evidence && fold && !fold.currentlyObserved && <p className="portal-answer">Last-known location recorded.<br />Current availability not confirmed.<br />Destination conditions not observed.<br /><b>Further observation required.</b></p>}
        <dl><div><dt>First observation</dt><dd>t {record.firstSeenAt.toFixed(2)}s</dd></div><div><dt>Last observation</dt><dd>t {record.lastSeenAt.toFixed(2)}s</dd></div><div><dt>{record.currentlyObserved ? 'Observed position' : 'Last-known position'}</dt><dd>{fmt(fold?.lastKnownEntryPosition ?? island!.lastKnownPosition)}</dd></div></dl>
        {fold && <><p>Last observed state: <b>{fold.lastObservedState}</b><br />Current state: <b>{fold.currentState ?? 'unknown'}</b></p><p className="context-note">Reported exit: {fmt(fold.lastKnownExitPosition)}<br />Destination not independently explored. Direction and traversal safety unknown.</p></>}
        <button className="evidence-button" onClick={() => setEvidence(!evidence)}>Why does ATLAS know this? {evidence ? '−' : '+'}</button>
        {evidence && <div className="evidence-details" data-testid="mission-evidence"><p><b>{record.observationCount} accepted observations.</b> Source: {mode === 'mission' ? 'authored simulation replay' : mode === 'stress' ? 'labelled stress fixture' : 'authorised live Lab sensor'}.</p><p>Memory retains delivered measurements only. Missing visibility does not establish closure.</p>{motion && fold && <><p>Endpoint analysis: <b>{motion.quality}</b> · {motion.sampleCount} recent samples. {motion.forecast ? `Issued t ${motion.forecast.issuedAt}s; target t ${motion.forecast.targetTime}s.` : 'No published endpoint estimate.'}</p><p>{motion.reasons.join(' ')}</p>{evaluation && <p>Frozen forecast issued t {evaluation.issuedAt}s. Target t {evaluation.targetTime}s; measured t {evaluation.observedAt}s; evaluated t {evaluation.evaluatedAt}s. Error {evaluation.error.toFixed(3)} units.</p>}</>}<button onClick={() => { setAnalysis(true); if (playing) props.onPlay(); }}>Open full analytical record ↗</button></div>}
      </> : <>
        <div className="local-reading"><strong>{view.observation?.local.hazard.toFixed(2) ?? '—'}</strong><span>LOCAL INSTABILITY<br />At Baymax’s measured position only</span></div>
        <p className="context-note">{view.observation ? `${summary.currentlyObservedIslands} islands · ${summary.currentlyObservedFolds} folds currently visible` : 'Awaiting the first mission observation.'}</p>
        {mode === 'live' && !summary.currentlyObservedFolds && <p>No fold is currently within sensor observation.</p>}
        <p className="context-note">Gravity vector: {view.observation ? fmt(view.observation.local.gravity) : '—'}<br />World units / s² · local measurement</p>
        {mode === 'live' && eventText && <p className="live-event"><span>RECORDED AT t {event!.simulationTime?.toFixed(2)}s</span>{eventText}</p>}
        {mode === 'live' && !['receiving', 'unchanged'].includes(view.status) && <p role="status">Sensor link: {view.status}. This map shows the latest accepted observation.</p>}
      </>}
      <label className="entity-menu">Inspect a discovery<select value={selected ?? ''} onChange={e => e.target.value ? select(e.target.value) : setSelected(null)}><option value="">Choose a recorded entity</option>{view.mapping.islands.map(i => <option key={i.id} value={i.id}>{i.id} · {i.currentlyObserved ? 'observed' : 'remembered'}</option>)}{view.mapping.folds.map(f => <option key={f.id} value={f.id}>{f.id} · {f.currentState ?? 'state unknown'}</option>)}</select></label>
    </aside>

    <div className="mission-view-controls"><button onClick={() => { setSelected(null); setGuided(true); }}>{guided ? '◎ Guided view' : '◎ Resume Guided View'}</button><button onClick={async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen(); } catch { setFullscreenError('Full screen unavailable in this browser.'); } }}>⛶ Full screen</button>{fullscreenError && <span role="status">{fullscreenError}</span>}</div>
    <footer className="mission-timeline">
      {mode === 'mission' ? <><div className="transport"><button aria-label={playing ? 'Pause mission' : 'Resume mission'} onClick={props.onPlay}>{playing ? 'Ⅱ' : '▶'}</button><button aria-label="Replay from start" onClick={() => { setSelected(null); props.onReplay(); }}>↺</button><span>{Math.round(time / 28 * 115).toString().padStart(3, '0')} / 115s</span><label className="speed-control"><span className="sr-only">Playback speed</span><select value={props.speed} onChange={e => props.onSpeed(Number(e.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label></div>
      <div className="chapter-sequence"><button aria-label="Previous stage" onClick={() => props.onStage(Math.max(0, chapter - 1))}>‹</button>{CHAPTERS.map((c, i) => <button key={c[0]} aria-current={chapter === i ? 'step' : undefined} onClick={() => props.onStage(i)}><small>0{i + 1}</small>{c[0]}</button>)}<button aria-label="Next stage" onClick={() => props.onStage(Math.min(4, chapter + 1))}>›</button></div><label className="mission-scrub"><span className="sr-only">Replay simulation time</span><input aria-label="Replay simulation time" type="range" min="0" max="28" step="0.25" value={time} onChange={e => props.onSeek(Number(e.target.value))} /></label></> : <><p>LIVE OBSERVATIONS · {view.sampleCount} retained samples · t {view.observation?.time.toFixed(2) ?? '—'}s</p><p>Drag to orbit · Scroll to zoom · Select an entity to inspect evidence</p></>}
    </footer>
    {begun && chapter === 4 && <p className="mission-closing">The dimension is unpredictable. <em>Knowledge is how the search begins.</em></p>}
  </div>;
}
