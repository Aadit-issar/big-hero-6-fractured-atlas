import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AtlasConsole } from './AtlasConsole';
import { AugmentedStage } from './AugmentedStage';
import type { StageProps } from './AugmentedStage';
import { SceneObjectsAnalysis } from './SceneObjectsAnalysis';
import { Caption, DecisionCard, EstimateStrip, CompareCard, EvidenceDrawer, EvidenceMenu, FinaleCard, Legend, LensToggle, PipelineBar } from './MissionDirectorUI';
import type { EvidenceEvent } from './MissionDirectorUI';
import { initialMute, MissionAudio, persistMute } from './missionAudio';
import { direct } from '../director/missionDirector';
import type { MissionBeat } from '../director/missionDirector';
import { clockToSim, MISSION_CLOCK_END, OBSERVATION_START, segmentAt, STAGE_NAMES, STAGE_START_CLOCK, TIMELINE } from '../lab/missionTimeline';
import type { ForecastArchiveEntry } from '../scene/sceneModel';
import type { KnowledgeSnapshot } from '../live/knowledge';

export interface AugmentedMissionProps {
  knowledge: KnowledgeSnapshot;
  archive: readonly ForecastArchiveEntry[];
  /** Mission clock, seconds. */
  clock: number; playing: boolean; begun: boolean;
  onPlay: () => void; onSeek: (clock: number) => void; onReplay: () => void; onStage: (stage: number) => void;
  speed: number; onSpeed: (speed: number) => void; onStart: (clock: number) => void;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}`;
const at = (segment: string, offset: number) => TIMELINE.find(s => s.id === segment)!.from + offset;
/** Major scientific events the viewer can open the evidence for. Each is a moment on the mission clock. */
export const EVIDENCE_EVENTS: readonly EvidenceEvent[] = [
  { id: 'island', label: 'First island acquired', clock: at('discover-island', 3.6) },
  { id: 'change', label: 'Fold state change', clock: at('detect-compare', 6) },
  { id: 'forecast', label: 'Forecast published', clock: at('estimate-publish', 4) },
  { id: 'check', label: 'Forecast checked against later evidence', clock: at('estimate-result', 1) },
  { id: 'miss', label: 'A forecast that missed', clock: at('estimate-miss', 1.2) },
  { id: 'recommendation', label: 'Navigation recommendation', clock: at('understand-decision', 14) },
];

/** Keeps the previous beat object while nothing in it changed, so the 3D scene is not rebuilt on every clock update. */
function useStableBeat(beat: MissionBeat): MissionBeat {
  const ref = useRef<{ json: string; beat: MissionBeat } | null>(null);
  const json = JSON.stringify(beat);
  if (!ref.current || ref.current.json !== json) ref.current = { json, beat };
  return ref.current.beat;
}

export function AugmentedMission(props: AugmentedMissionProps) {
  const { knowledge, archive, clock, playing, begun, speed } = props;
  const [analysis, setAnalysis] = useState(false);
  const [lensOverride, setLensOverride] = useState<'memory' | 'sensor' | null>(null);
  const [guided, setGuided] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceEvent | null>(null);
  const [muted, setMuted] = useState(initialMute);
  const audio = useRef<MissionAudio | null>(null);
  if (!audio.current) audio.current = new MissionAudio(initialMute());
  const userSeek = useRef(false);

  const beat = useStableBeat(direct(clock, { knowledge, archive, sim: clockToSim(clock) }));
  const stage = Math.max(0, beat.stage);
  useEffect(() => { setLensOverride(null); }, [beat.segment]);
  useEffect(() => { setLegendOpen(beat.legend); }, [beat.legend, beat.segment]);
  const lens = lensOverride ?? beat.lens;
  const source = 'GUIDED SIMULATION REPLAY';

  // Sound: started from the Begin gesture, paused with the mission, cued by beats that play forward on their own.
  const lastKey = useRef('');
  useEffect(() => {
    if (!begun) return;
    const natural = playing && !userSeek.current; userSeek.current = false;
    if (beat.key !== lastKey.current) { lastKey.current = beat.key; if (beat.cue && natural) audio.current?.cue(beat.cue); }
  }, [begun, playing, beat.key, beat.cue]);
  useEffect(() => { if (playing) void audio.current?.resume(); else audio.current?.pause(); }, [playing]);
  useEffect(() => () => audio.current?.dispose(), []);
  const toggleMute = () => { const next = !muted; setMuted(next); persistMute(next); audio.current?.setMuted(next); void audio.current?.start(); };
  const startAudio = () => { void audio.current?.start(); };

  const seek = (t: number) => { userSeek.current = true; props.onSeek(t); };
  const onGuidedChange = useCallback((g: boolean) => setGuided(g), []);
  const pickEvidence = (e: EvidenceEvent) => { userSeek.current = true; props.onSeek(e.clock); setEvidence(e); };
  const closeEvidence = () => setEvidence(null);

  const overlay: NonNullable<StageProps['overlay']> = ({ nav }) => {
    if (!begun) return null;
    const card = beat.card;
    return (
      <>
        <PipelineBar pipeline={beat.pipeline} />
        {stage >= 1 && begun && beat.card?.kind !== 'finale' && <LensToggle lens={lens} hint={beat.lensHint && lensOverride === null} onChange={setLensOverride} />}
        {begun && beat.stage >= 1 && <Legend open={legendOpen} onToggle={() => setLegendOpen(v => !v)} />}
        {!card && <Caption beat={beat} />}
        {card?.kind === 'compare' && <><Caption beat={beat} /><CompareCard knowledge={knowledge} step={card.step} /></>}
        {card?.kind === 'strip' && <><Caption beat={beat} /><EstimateStrip knowledge={knowledge} archive={archive} foldId={card.foldId} issuedAt={card.issuedAt} step={card.step} /></>}
        {card?.kind === 'decision' && <DecisionCard step={card.step} advice={nav.advice} knowledge={knowledge} />}
        {card?.kind === 'finale' && <FinaleCard headline={beat.headline ?? ''} line={beat.line ?? ''} onReplay={props.onReplay} />}
        {evidence && <EvidenceDrawer event={evidence} knowledge={knowledge} archive={archive} advice={nav.advice} onClose={closeEvidence} />}
      </>
    );
  };

  if (analysis) {
    return <div className="mission-analysis"><div className="analysis-return"><button onClick={() => setAnalysis(false)}>← Return to the dimension</button><span>{source} · FROZEN EVIDENCE</span></div>
      <AtlasConsole view={knowledge.view} sourceLabel={source} /><SceneObjectsAnalysis knowledge={knowledge} /></div>;
  }

  const opening = !begun ? (
    <div className="aug-opening" data-testid="mission-opening">
      <p className="aug-kicker">BIG HERO 6 · FRACTURED</p>
      <h1>Stranded in an unknown dimension.</h1>
      <p className="aug-sub">Baymax has no map. ATLAS must learn the world from what his sensors observe. Everything you will see arrives through an accepted observation or scan.</p>
      <div className="aug-actions">
        <button className="aug-begin" data-testid="begin-mission" onClick={() => { startAudio(); props.onStart(0); }}>Begin Mission</button>
        <button className="aug-ghost" onClick={() => { startAudio(); props.onStart(OBSERVATION_START); }}>Skip to first discovery</button>
        <a className="aug-ghost" href="?experience=live">Live Scan of the real Dimension →</a>
      </div>
      <p className="aug-fine">About two minutes · works with the sound off · a guided replay of authored, simulated observations processed by the real ATLAS pipeline</p>
    </div>
  ) : null;

  const bottom = (
    <>
      <div className="aug-transport">
        <button aria-label={playing ? 'Pause mission' : 'Play mission'} onClick={() => { startAudio(); props.onPlay(); }}>{playing ? 'Ⅱ' : '▶'}</button>
        <button aria-label="Restart mission" onClick={() => { startAudio(); props.onReplay(); }}>↺</button>
        <span className="aug-clock" data-testid="mission-clock">{mmss(clock)} / {mmss(MISSION_CLOCK_END)}</span>
        <select aria-label="Playback speed" value={speed} onChange={e => props.onSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}×</option>)}</select>
      </div>
      <div className="aug-track">
        <input type="range" min={0} max={MISSION_CLOCK_END} step={0.1} value={clock} aria-label="Mission timeline" onChange={e => seek(Number(e.target.value))} style={{ '--p': `${(clock / MISSION_CLOCK_END) * 100}%` } as CSSProperties} />
        <div className="aug-chapters">{STAGE_NAMES.map((name, i) => <button key={name} style={{ left: `${(STAGE_START_CLOCK[i]! / MISSION_CLOCK_END) * 100}%` }} aria-current={begun && beat.stage === i ? 'step' : undefined} onClick={() => { userSeek.current = true; props.onStage(i); }}><i />{name}</button>)}</div>
      </div>
    </>
  );

  const extraTools = (
    <>
      <EvidenceMenu events={EVIDENCE_EVENTS} onPick={pickEvidence} />
      <button onClick={toggleMute} aria-pressed={!muted} data-testid="sound-toggle" title="Optional sound. The mission is complete without it.">{muted ? '🔇 Sound off' : '🔊 Sound on'}</button>
    </>
  );

  return <AugmentedStage knowledge={knowledge} mode="mission" sourceLabel={source} sourceTone="neutral" clock={{ kind: 'replay', time: clock, playing, speed, begun }} chapter={stage}
    beat={begun ? beat : { ...beat, labels: [], navOpen: false, insight: null, pipeline: null, card: null, headline: null, line: null, chips: [] }} archive={archive} {...(lensOverride ? { lens: lensOverride } : {})}
    hideNavPanel={beat.card?.kind === 'finale'} onGuidedChange={onGuidedChange} extraTools={extraTools}
    onAnalysis={() => { setAnalysis(true); if (playing) props.onPlay(); }} opening={opening} overlay={overlay} bottom={bottom} onTogglePlay={props.onPlay}
    onStage={(i: number) => { userSeek.current = true; props.onStage(i); }} dataAttributes={{ segment: segmentAt(clock).id, 'sound': muted ? 'off' : 'on', 'guided-labels': guided ? 'directed' : 'all' }} />;
}
