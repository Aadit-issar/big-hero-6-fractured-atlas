import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AugmentedWorld } from '../scene/AugmentedWorld';
import type { RenderQuality } from '../scene/AugmentedWorld';
import { buildSceneModel, EMPTY_SCENE } from '../scene/sceneModel';
import type { ForecastArchiveEntry, SceneModel } from '../scene/sceneModel';
import { simToClock } from '../lab/missionTimeline';
import type { MissionBeat } from '../director/missionDirector';
import { primaryInsight } from '../live/knowledge';
import { adviseNavigation, diffAdvice } from '../navigation/advisor';
import type { NavChange } from '../navigation/advisor';
import type { NavigationAdvice } from '../navigation/types';
import type { WorldVec3 } from '../../shared/atlasContract';
import { NavigationPanel } from './NavigationPanel';
import { formatAllowance, formatUnits, plainReason } from '../director/missionFacts';
import type { ActivityEntry, KnowledgeSnapshot } from '../live/knowledge';
import './mission-experience.css';
import './augmented.css';


export interface NavigationController {
  readonly advice: NavigationAdvice;
  readonly goalId: string | null;
  readonly setGoal: (id: string | null) => void;
  readonly changes: readonly NavChange[];
}

const NO_ADVICE: NavigationAdvice = {
  status: 'abstain', episode: 0, simTime: null, goalId: null, goalLabel: null, route: null, waypoints: [], goals: [], alternatives: [], frontiers: [],
  recommendation: { title: 'Navigation is off', detail: '', target: null, targetId: null, action: 'none' }, evidence: [], limitations: [], reason: null,
};

/** In-browser navigation for sources that do not compute it themselves (replay and isolated lab). Pure advice from the knowledge snapshot;
 * successive advice is compared so that genuine changes, not frame updates, produce messages. */
function useLocalNavigation(knowledge: KnowledgeSnapshot, enabled: boolean): NavigationController {
  const [goalId, setGoalId] = useState<string | null>(null);
  const [changes, setChanges] = useState<NavChange[]>([]);
  const previous = useRef<NavigationAdvice | null>(null);
  const k = useMemo(() => ({ view: knowledge.view, scene: knowledge.scene, episode: 0 }), [knowledge]);
  const advice = useMemo(() => (enabled ? adviseNavigation(k, goalId) : NO_ADVICE), [enabled, k, goalId]);
  useEffect(() => {
    if (!enabled) { previous.current = null; return; }
    const p = previous.current;
    previous.current = advice;
    if (!p || p.goalId !== advice.goalId) { setChanges([]); return; }
    // Scrubbing backwards is not a change in the world; only forward knowledge produces messages.
    if (p.simTime !== null && advice.simTime !== null && advice.simTime < p.simTime) { setChanges([]); return; }
    const d = diffAdvice(p, advice, k);
    if (d.length) setChanges(c => [...c.slice(-4), ...d]);
  }, [advice, enabled, k]);
  return { advice, goalId, setGoal: setGoalId, changes };
}

export type StageClock =
  | { readonly kind: 'replay'; readonly time: number; readonly playing: boolean; readonly speed: number; readonly begun: boolean }
  | { readonly kind: 'wall'; readonly now: () => number };

export interface StageProps {
  readonly knowledge: KnowledgeSnapshot;
  readonly mode: 'mission' | 'live' | 'isolated';
  readonly sourceLabel: string;
  readonly sourceTone?: 'ok' | 'warn' | 'bad' | 'neutral';
  readonly clock: StageClock;
  readonly chapter: number;
  readonly follow?: boolean;
  readonly onAnalysis: () => void;
  /** Rendered while the opening is showing (replay before Begin). */
  readonly opening?: ReactNode;
  readonly caption?: ReactNode;
  readonly bottom: ReactNode;
  readonly onTogglePlay?: () => void;
  readonly onStage?: (stage: number) => void;
  readonly onFollowChange?: (follow: boolean) => void;
  readonly extraTools?: ReactNode;
  /** Navigation computed by the source (the live session); replay and lab compute it locally. */
  readonly navigation?: NavigationController;
  /** Lightweight mode: no WebGL scene is created, so the GPU is left to the Dimension. Observation, memory and navigation keep running. */
  readonly lightweight?: boolean;
  readonly onLightweightChange?: (light: boolean) => void;
  /** Render-rate cap for this stage (0 = uncapped). */
  readonly maxFps?: number;
  readonly dataAttributes?: Record<string, string | number>;
  /** Guided mission only: the current beat of the presentation director, and everything the director needs from the stage. */
  readonly beat?: MissionBeat;
  readonly archive?: readonly ForecastArchiveEntry[];
  /** Lens the viewer chose (overrides the beat's lens until the next beat). */
  readonly lens?: 'memory' | 'sensor';
  /** Director overlays (captions, cards). Rendered inside the stage with access to the scene model and the live navigation advice. */
  readonly overlay?: (context: { readonly model: SceneModel; readonly nav: NavigationController }) => ReactNode;
  /** Opening state of the viewer's own label choice: when false the directed label subset is lifted and every label is drawn. */
  readonly onGuidedChange?: (guided: boolean) => void;
  /** Draw the route in the world but not the advisor panel (the finale composition). */
  readonly hideNavPanel?: boolean;
}

const fmt = (p: readonly number[]) => p.map(n => n.toFixed(1)).join(', ');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const prettyKind = (kind: string) => kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function useQuery(): { quality: RenderQuality; hud: boolean } {
  return useMemo(() => {
    const q = new URLSearchParams(location.search);
    return { quality: q.get('quality') === 'performance' ? 'performance' : 'balanced', hud: q.get('hud') !== '0' };
  }, []);
}

const SIGNIFICANCE: Record<ActivityEntry['tone'], string> = {
  new: 'Added to ATLAS memory from an accepted observation.',
  memory: 'Kept as a last-known record; it may have moved since.',
  warn: 'Compared against an earlier record or reported as a limitation.',
  info: 'Recorded in the observation history.',
};

export function AugmentedStage(props: StageProps) {
  const { knowledge, mode, sourceLabel, sourceTone = 'neutral', clock, chapter, follow = false, caption, bottom, opening } = props;
  const { quality, hud } = useQuery();
  const [guided, setGuided] = useState(true);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get('select'));
  const [hidden, setHidden] = useState(!hud);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const ambient = useRef(0);
  const manual = useCallback(() => setGuided(false), []);
  const onGuidedChange = props.onGuidedChange;
  useEffect(() => { onGuidedChange?.(guided); }, [guided, onGuidedChange]);

  const lightweight = props.lightweight ?? new URLSearchParams(location.search).has('no3d');
  const [navOpen, setNavOpen] = useState(() => new URLSearchParams(location.search).get('nav') === '1');
  useEffect(() => { if (lightweight) setNavOpen(true); }, [lightweight]);
  const [focusPoint, setFocusPoint] = useState<WorldVec3 | null>(null);
  const localNav = useLocalNavigation(knowledge, navOpen && !props.navigation);
  const nav = props.navigation ?? localNav;
  const knowledgeNav = useMemo<KnowledgeSnapshot>(() => (navOpen ? { ...knowledge, navigation: { advice: nav.advice, goalId: nav.goalId, changes: nav.changes } } : knowledge), [knowledge, navOpen, nav.advice, nav.goalId, nav.changes]);
  // The mission director opens the advisor and chooses its question; afterwards the viewer's own choices are respected until the next beat.
  const beat = props.beat;
  const beatKey = beat?.key ?? '';
  const appliedNav = useRef('');
  useEffect(() => {
    if (mode !== 'mission' || !beat || new URLSearchParams(location.search).get('nav') === '1') return;
    if (appliedNav.current === `${beatKey}|${beat.navOpen}|${beat.navGoal}|${nav.advice.goals.length > 0}`) return;
    setNavOpen(beat.navOpen);
    if (!beat.navOpen) { setFocusPoint(null); appliedNav.current = `${beatKey}|${beat.navOpen}|${beat.navGoal}|${nav.advice.goals.length > 0}`; return; }
    const capsule = nav.advice.goals.find(g => g.id.startsWith('cluster-capsule'));
    if (beat.navGoal === 'capsule' && !capsule) return; // wait for the planner to know the destination
    nav.setGoal(beat.navGoal === 'capsule' ? capsule!.id : null);
    appliedNav.current = `${beatKey}|${beat.navOpen}|${beat.navGoal}|${nav.advice.goals.length > 0}`;
  }, [mode, beat, beatKey, nav]);
  // Category filters change only what is drawn; ATLAS's memory is untouched.
  const [show, setShow] = useState({ islands: true, folds: true, debris: true });
  const base = useMemo<SceneModel>(() => {
    const m = knowledge.view.mapping;
    const directed = beat ? { lens: props.lens ?? beat.lens, hero: beat.hero, shot: beat.shot, focus: beat.focus, showEstimates: beat.showEstimates, featured: beat.featured, archive: props.archive ?? [] } : {};
    if (!knowledge.view.observation && m.islands.length + m.folds.length === 0) return { ...EMPTY_SCENE, ...(beat ? { lens: props.lens ?? beat.lens, hero: beat.hero, shot: beat.shot, focus: beat.focus } : {}) };
    const full = buildSceneModel(knowledgeNav, 0, clock.kind === 'replay' ? { toClock: simToClock, motionReference: 1.8, stage: chapter, ...directed } : {});
    return {
      ...full, islands: show.islands ? full.islands : [], folds: show.folds ? full.folds : [], objects: show.debris ? full.objects : [], clusters: show.debris ? full.clusters : [],
      changes: show.folds ? full.changes : [], estimates: show.folds ? full.estimates : [], navigation: full.navigation,
    };
  }, [knowledge, knowledgeNav, clock.kind, chapter, show, beat, props.lens, props.archive]);
  const modelRef = useRef<SceneModel>(base);
  const loop = useRef({ render: clock.kind === 'replay' ? clock.time : 0, base, clock });
  loop.current.base = base; loop.current.clock = clock;

  useEffect(() => {
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(q.matches);
    q.addEventListener('change', change);
    return () => q.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const c = loop.current, k = c.clock;
      if (k.kind === 'replay') {
        // Ambient atmosphere runs before the mission begins and while it plays; it freezes on pause.
        if (!k.begun || k.playing) ambient.current += dt;
        // The mission clock is the animation clock: display time runs smoothly between state updates and snaps on any seek.
        if (c.render < k.time || c.render - k.time > 1.5) c.render = k.time;
        else if (k.playing) c.render = Math.min(c.render + dt * k.speed, k.time + 0.25);
        modelRef.current = { ...c.base, time: c.render };
      } else {
        ambient.current += dt;
        modelRef.current = { ...c.base, time: k.now() };
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  // A stage change releases the selection and resumes the guided camera, except for a selection that came from the URL (?select=).
  const firstChapter = useRef(true);
  const keepUrlSelection = useRef(new URLSearchParams(location.search).has('select'));
  useEffect(() => {
    if (firstChapter.current) { firstChapter.current = false; return; }
    if (keepUrlSelection.current) { keepUrlSelection.current = false; return; }
    setSelected(null); setGuided(true);
  }, [chapter]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
      if (e.code === 'Space' && mode === 'mission') { e.preventDefault(); props.onTogglePlay?.(); }
      if (e.key === 'Escape') setSelected(null);
      if (e.key.toLowerCase() === 'g') setGuided(true);
      if (e.key.toLowerCase() === 'h') setHidden(v => !v);
      if (e.key === 'ArrowRight' && mode === 'mission') props.onStage?.(Math.min(4, chapter + 1));
      if (e.key === 'ArrowLeft' && mode === 'mission') props.onStage?.(Math.max(0, chapter - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [props, mode, chapter]);

  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen(); } catch { /* unsupported */ }
  };
  const view = knowledge.view, summary = view.mapping.summary;
  const fold = view.mapping.folds.find(f => f.id === selected);
  const island = view.mapping.islands.find(i => i.id === selected);
  const object = knowledge.scene.records.find(r => r.id === selected);
  const cluster = knowledge.scene.clusters.find(c => c.id === selected);
  const observerSelected = selected === 'baymax-observer' && !!view.observation;
  const insight = primaryInsight(knowledge.activity);
  const recent = knowledge.activity.slice(-5).reverse();
  const sceneObserved = knowledge.scene.records.filter(r => r.currentlyObserved).length;
  const sceneRemembered = knowledge.scene.records.length - sceneObserved;
  const tone = sourceTone;
  // While the story is directed, only the labels the beat names are drawn; taking the camera (manual) lifts the restriction.
  const allLabels = useMemo(() => new URLSearchParams(location.search).get('labels') === 'all', []);
  const allowed = (id: string) => !beat || !guided || allLabels || beat.labels.includes(id);

  return (
    <div className={lightweight ? 'aug-shell light' : 'aug-shell'} ref={root} data-testid="mission-experience" data-mode={mode} data-source={knowledge.source} data-chapter={chapter} data-beat={beat?.key ?? ''} data-lens={base.lens} data-guided={guided ? '1' : '0'} data-time={view.observation?.time ?? -1}
      data-samples={view.sampleCount} data-hud={hidden ? 'off' : 'on'} data-scene-objects={knowledge.scene.records.length} {...Object.fromEntries(Object.entries(props.dataAttributes ?? {}).map(([k, v]) => [`data-${k}`, v]))}>
      {!lightweight && <AugmentedWorld model={base} modelRef={modelRef} ambient={ambient} guided={guided} chapter={chapter} selected={selected} reducedMotion={reduced}
        onSelect={setSelected} onManual={manual} labelLayer={labels} quality={quality} follow={follow} maxFps={props.maxFps ?? 0} focusPoint={focusPoint} />}
      <div className="aug-vignette" />

      <div className="aug-labels" ref={labels} aria-hidden="true">
        {view.observation && allowed('baymax-observer') && <div className="aug-label observer" data-anchor="baymax-observer"><b>BAYMAX</b><span>OBSERVER · sim t {view.observation.time.toFixed(2)}s</span></div>}
        {show.islands && view.mapping.islands.filter(i => allowed(i.id)).map(i => (
          <div key={i.id} className={`aug-label island ${i.currentlyObserved ? 'observed' : 'remembered'}`} data-anchor={i.id}>
            <b>{i.id}</b><span>{i.currentlyObserved ? 'OBSERVED' : 'REMEMBERED'} · t {i.lastSeenAt.toFixed(2)}s</span>
          </div>
        ))}
        {show.folds && view.mapping.folds.filter(f => allowed(f.id)).map(f => (
          <div key={f.id} className={`aug-label fold ${f.currentlyObserved ? 'observed' : 'remembered'}`} data-anchor={f.id}>
            <b>{f.id}</b><span>{(f.currentState ?? f.lastObservedState).toUpperCase()} · {f.currentlyObserved ? 'OBSERVED' : 'LAST KNOWN'} · t {f.lastSeenAt.toFixed(2)}s</span>
          </div>
        ))}
        {(clock.kind === 'wall' || chapter >= 2) && !beat && base.changes.map(c => (
          <div key={`c-${c.id}`} className="aug-label change" data-anchor={`change-${c.id}`}>
            <b>RECORDED CHANGE · {c.id}</b>
            <span>{c.distance.toFixed(1)} units · observed t {c.fromT.toFixed(2)} → {c.toT.toFixed(2)}{c.state ? ` · ${c.state.from} → ${c.state.to}` : ''}</span>
          </div>
        ))}
        {beat && base.changes.filter(c => allowed(`cmp-before-${c.id}`)).map(c => (
          <div key={`cb-${c.id}`} className="aug-label tag before" data-anchor={`cmp-before-${c.id}`}><b>BEFORE</b><span>t {c.fromT.toFixed(2)} · {(c.state?.from ?? 'recorded').toUpperCase()}</span></div>
        ))}
        {beat && base.changes.filter(c => allowed(`cmp-after-${c.id}`)).map(c => (
          <div key={`ca-${c.id}`} className="aug-label tag after" data-anchor={`cmp-after-${c.id}`}><b>AFTER</b><span>t {c.toT.toFixed(2)} · {(c.state?.to ?? 'observed').toUpperCase()}</span></div>
        ))}
        {beat && base.estimates.filter(e => (e.evaluation?.observed ?? e.arrival) && allowed(`estimate-observed-${e.id}`)).map(e => (
          <div key={`eo-${e.id}`} className="aug-label tag observed" data-anchor={`estimate-observed-${e.id}`}><b>OBSERVED LATER</b><span>measured at t {e.targetTime?.toFixed(2)}</span></div>
        ))}
        {(clock.kind === 'wall' || chapter >= 3) && base.estimates.filter(e => allowed(`estimate-${e.id}`)).map(e => (
          <div key={`e-${e.id}`} className={`aug-label estimate ${e.status}`} data-anchor={`estimate-${e.id}`}>
            {e.status === 'estimate'
              ? <><b>ESTIMATE · NOT OBSERVED</b><span>{e.id} · for t {e.targetTime?.toFixed(2)} · allowed error {formatAllowance(e.allowance ?? 0)}{e.evaluation ? ` · later measured: off by ${formatUnits(e.evaluation.error)}, ${e.evaluation.covered ? 'within' : 'outside'} its allowance` : beat ? '' : e.lastCheck ? ` · awaiting a later observation (previous estimate: off by ${formatUnits(e.lastCheck.error)}, ${e.lastCheck.covered ? 'within' : 'outside'} its own allowance ${formatAllowance(e.lastCheck.allowance)})` : ' · awaiting a later observation'}</span></>
              : <><b>NO ESTIMATE · INSUFFICIENT EVIDENCE</b><span>{e.id} · {plainReason(e.reason ?? undefined)}</span></>}
          </div>
        ))}
        {navOpen && base.navigation?.target && allowed('nav-target') && <div className="aug-label nav" data-anchor="nav-target"><b>{base.navigation.target.action === 'follow-route' ? 'NEXT WAYPOINT' : 'OBSERVE NEXT'}</b><span>{base.navigation.target.label}</span></div>}
        {navOpen && base.navigation && base.navigation.points.length > 0 && allowed('nav-goal') && <div className="aug-label nav goal" data-anchor="nav-goal"><b>DESTINATION</b><span>{base.navigation.points.at(-1)!.label} · candidate only</span></div>}
        {show.debris && knowledge.scene.clusters.filter(c => allowed(c.id)).map(c => (
          <div key={c.id} className={`aug-label cluster ${c.currentlyObserved > 0 ? 'observed' : 'remembered'}`} data-anchor={c.id}>
            <b>{c.label.toUpperCase()}</b><span>{plural(c.count, 'object')} · {c.currentlyObserved > 0 ? `${c.currentlyObserved} OBSERVED` : 'REMEMBERED'}</span>
          </div>
        ))}
        {show.debris && !beat && knowledge.scene.records.filter(r => r.kind === 'capsule_shell_remnant').map(r => (
          <div key={r.id} className={`aug-label object ${r.currentlyObserved ? 'observed' : 'remembered'}`} data-anchor={r.id}>
            <b>CAPSULE WRECKAGE</b><span>{r.currentlyObserved ? 'ACQUIRED' : 'REMEMBERED'} · t {r.lastSeenAt.toFixed(2)}s</span>
          </div>
        ))}
      </div>

      {!hidden && <>
        <header className="aug-top">
          <a className="aug-brand" href="?experience=mission" aria-label="ATLAS Mission Demo"><span>ATLAS</span><small>THE MEMORY OF A BROKEN WORLD</small></a>
          <nav aria-label="ATLAS experiences">
            <a aria-current={mode === 'mission' ? 'page' : undefined} href="?experience=mission">Mission</a>
            <a aria-current={mode === 'live' ? 'page' : undefined} href="?experience=live">Live Scan</a>
            <a aria-current={mode === 'isolated' ? 'page' : undefined} href="?experience=lab">Isolated Lab</a>
            <button onClick={props.onAnalysis}>Analysis</button>
          </nav>
          <span className={`aug-source tone-${tone}`} data-testid="source-label"><i />{sourceLabel}</span>
        </header>

        {opening}
        {caption}
        {props.overlay?.({ model: base, nav })}

        <div className="aug-rail" data-reserve={beat ? '' : undefined}>
          {beat ? (beat.insight && <aside className={`aug-insight beat tone-${beat.insight.tone}`} aria-label="ATLAS insight" data-testid="insight" key={beat.key}>
            <p className="aug-kicker">{beat.insight.kicker}</p>
            <p className="aug-insight-title static">{beat.insight.title}</p>
            <p className="aug-insight-detail">{beat.insight.detail}</p>
          </aside>) : <aside className="aug-insight" aria-label="ATLAS insight" data-testid="insight">
            <p className="aug-kicker">ATLAS INSIGHT</p>
            {insight ? <>
              <button className="aug-insight-title" disabled={!insight.focusId} onClick={() => insight.focusId && setSelected(insight.focusId)}>{insight.title}</button>
              <p className="aug-insight-detail">{insight.detail}</p>
              <p className="aug-insight-sig">{SIGNIFICANCE[insight.tone]}</p>
              {recent.length > 1 && <ul className="aug-feed">{recent.slice(1, 5).map(e => <li key={e.id} className={`tone-${e.tone}`}><i />{e.title}</li>)}</ul>}
            </> : <p className="aug-insight-detail">Waiting for the first observation. ATLAS only knows what is observed.</p>}
            <p className="aug-counts">{plural(summary.currentlyObservedIslands, 'island')} · {plural(summary.currentlyObservedFolds, 'fold')} · {plural(sceneObserved, 'scene object')} observed now · {summary.previouslyObservedIslands + summary.historicalFolds + sceneRemembered} remembered</p>
          </aside>}

          {navOpen && !props.hideNavPanel && <NavigationPanel advice={nav.advice} goalId={nav.goalId} onGoal={id => { nav.setGoal(id); setFocusPoint(null); }} onFocus={p => { setFocusPoint(p); setGuided(true); }} changes={nav.changes} onClose={() => { setNavOpen(false); setFocusPoint(null); }} />}
          <aside className={`aug-evidence ${island || fold || object || cluster || observerSelected ? 'open' : ''}`} aria-label="Selected record" data-testid="evidence">
            {(island || fold || object || cluster || observerSelected) && <>
              <button className="aug-close" aria-label="Close selected record" onClick={() => setSelected(null)}>×</button>
              {observerSelected && view.observation && <>
                <p className="aug-kicker">OBSERVER · SENSOR OBSERVATION</p>
                <h2>Baymax</h2>
                <p className="aug-state now">{knowledge.source === 'replay' ? 'AUTHORED REPLAY POSE' : knowledge.source === 'live-linked' ? 'LIVE EXPLORER POSE' : 'ISOLATED SIMULATION POSE'}</p>
                <dl>
                  <div><dt>Simulation time</dt><dd>t {view.observation.time.toFixed(2)}s</dd></div>
                  <div><dt>Position</dt><dd>{fmt(view.observation.observerWorldPosition)}</dd></div>
                  <div><dt>Local instability</dt><dd>{view.observation.local.hazard.toFixed(3)}</dd></div>
                  <div><dt>Gravity anomaly</dt><dd>{fmt(view.observation.local.gravity)}</dd></div>
                  <div><dt>Sensor range</dt><dd>{view.observation.sensorRange} units</dd></div>
                  <div><dt>Accepted observations</dt><dd>{view.sampleCount}</dd></div>
                </dl>
                <p className="aug-note">The pose is the sensor's reported observer position. Smoothing, heading, lean and thruster glow are presentation animation derived from that motion.</p>
              </>}
              {(island || fold) && (() => {
                const record = (fold ?? island)!;
                return <>
                  <p className="aug-kicker">{fold ? 'DIMENSIONAL FOLD · SENSOR OBSERVATION' : 'FLOATING ISLAND · SENSOR OBSERVATION'}</p>
                  <h2>{record.id}</h2>
                  <p className={`aug-state ${record.currentlyObserved ? 'now' : 'memory'}`}>{record.currentlyObserved ? 'OBSERVED NOW' : 'REMEMBERED · CURRENT STATE UNKNOWN'}</p>
                  <dl>
                    <div><dt>First recorded</dt><dd>t {record.firstSeenAt.toFixed(2)}s</dd></div>
                    <div><dt>Last observed</dt><dd>t {record.lastSeenAt.toFixed(2)}s</dd></div>
                    <div><dt>Observations</dt><dd>{record.observationCount}</dd></div>
                    {island && <div><dt>{island.currentlyObserved ? 'Position' : 'Last-known position'}</dt><dd>{fmt(island.currentPosition ?? island.lastKnownPosition)}</dd></div>}
                    {fold && <><div><dt>Recorded state</dt><dd>{fold.currentState ?? fold.lastObservedState}</dd></div>
                      <div><dt>{fold.currentlyObserved ? 'Entry' : 'Last-known entry'}</dt><dd>{fmt(fold.currentEntryPosition ?? fold.lastKnownEntryPosition)}</dd></div>
                      <div><dt>Reported exit</dt><dd>{fmt(fold.lastKnownExitPosition)}</dd></div></>}
                  </dl>
                  <p className="aug-note">{fold ? 'Source: authorised sensor. The far endpoint has not been independently explored.' : 'Source: authorised sensor. The rock shown is an illustrative form, not a measured scan.'}</p>
                </>;
              })()}
              {object && <>
                <p className="aug-kicker">SCENE OBJECT · PROXIMITY SCAN</p>
                <h2>{prettyKind(object.kind)}</h2>
                <p className={`aug-state ${object.currentlyObserved ? 'now' : 'memory'}`}>{object.currentlyObserved ? 'ACQUIRED · IN SCAN RANGE' : 'REMEMBERED · MAY HAVE MOVED'}</p>
                <dl>
                  <div><dt>Identity</dt><dd>{object.id}</dd></div>
                  <div><dt>Category</dt><dd>{object.category} · {object.family}</dd></div>
                  <div><dt>First acquired</dt><dd>t {object.firstSeenAt.toFixed(2)}s</dd></div>
                  <div><dt>Last observed</dt><dd>t {object.lastSeenAt.toFixed(2)}s</dd></div>
                  <div><dt>Observations</dt><dd>{object.observationCount}</dd></div>
                  <div><dt>{object.currentlyObserved ? 'Position' : 'Last-known position'}</dt><dd>{fmt(object.lastKnownPosition)}</dd></div>
                  <div><dt>Range at last scan</dt><dd>{object.lastRange.toFixed(1)} units</dd></div>
                </dl>
                <p className="aug-note">{knowledge.source === 'replay' ? 'Simulated replay object, acquired by the same proximity rule as the live scanner.' : 'Acquired by the scene-object scanner (proximity sphere, no occlusion). Not part of the sensor contract. The shape drawn is illustrative.'}</p>
              </>}
              {cluster && <>
                <p className="aug-kicker">DEBRIS CLUSTER · DERIVED FROM ACQUIRED OBJECTS</p>
                <h2>{cluster.label}</h2>
                <p className={`aug-state ${cluster.currentlyObserved ? 'now' : 'memory'}`}>{cluster.currentlyObserved} OBSERVED NOW · {cluster.remembered} REMEMBERED</p>
                <dl>
                  <div><dt>Acquired objects</dt><dd>{cluster.count}</dd></div>
                  <div><dt>Composition</dt><dd>{Object.entries(cluster.composition).map(([k, v]) => `${v} ${k}`).join(', ')}</dd></div>
                  <div><dt>Centre</dt><dd>{fmt(cluster.centre)}</dd></div>
                  <div><dt>Extent</dt><dd>{cluster.extent.toFixed(1)} units</dd></div>
                  <div><dt>Last observed</dt><dd>t {cluster.lastSeenAt.toFixed(2)}s</dd></div>
                </dl>
                <ul className="aug-members">{cluster.memberIds.slice(0, 6).map(id => { const r = knowledge.scene.records.find(x => x.id === id); return <li key={id}><button onClick={() => setSelected(id)}>{r ? prettyKind(r.kind) : id}</button></li>; })}{cluster.memberIds.length > 6 && <li>+{cluster.memberIds.length - 6} more</li>}</ul>
                <p className="aug-note">Partial: this cluster counts only objects that scans have acquired. It does not describe the whole field.</p>
              </>}
            </>}
          </aside>
        </div>

        <footer className="aug-timeline">
          {bottom}
          <div className="aug-tools">
            {props.extraTools}
            <span className="aug-filters" role="group" aria-label="Show categories">
              {(['islands', 'folds', 'debris'] as const).map(k => <button key={k} aria-pressed={show[k]} onClick={() => setShow(s => ({ ...s, [k]: !s[k] }))}>{show[k] ? '●' : '○'} {k[0]!.toUpperCase() + k.slice(1)}</button>)}
            </span>
            {props.onLightweightChange && <button onClick={() => props.onLightweightChange!(!lightweight)} aria-pressed={lightweight} data-testid="lightweight-toggle" title="Stop rendering the 3D scene so the GPU is free for the Dimension. Observations, memory and guidance keep running.">{lightweight ? '◐ Lightweight on' : '◐ Lightweight (no 3D)'}</button>}
            {mode === 'live' && !lightweight && <button onClick={() => { props.onFollowChange?.(!follow); setGuided(true); }} aria-pressed={follow}>{follow ? '◎ Following Baymax' : '◎ Follow Baymax'}</button>}
            <button onClick={() => { setNavOpen(v => !v); setFocusPoint(null); }} aria-pressed={navOpen} data-testid="navigation-toggle">{navOpen ? '◈ Navigation on' : '◈ Navigation'}</button>
            <button onClick={() => { setSelected(null); setFocusPoint(null); setGuided(true); }} aria-pressed={guided}>{guided ? '◎ Guided camera' : '◎ Resume guided'}</button>
            <button onClick={fullscreen}>⛶ Fullscreen</button>
          </div>
        </footer>
      </>}
    </div>
  );
}
