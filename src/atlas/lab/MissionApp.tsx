import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MissionReplay, MISSION_DURATION } from './missionReplay';
import { clockToSim, MISSION_CLOCK_END, simToClock, STAGE_START_CLOCK } from './missionTimeline';
import { MissionExperience } from '../ui/MissionExperience';
import { AugmentedMission } from '../ui/AugmentedMission';
import { IsolatedExperience, LiveExperience } from '../ui/LiveExperience';
import { AtlasRuntime } from '../core/runtime';
import { createStressObservation } from './fixtures';
import { NO_SCENE_KNOWLEDGE } from '../live/knowledge';
import { ChallengeApp } from '../challenge/app/ChallengeApp';
import { CommandApp } from '../command/ui/CommandApp';
import type { KnowledgeSnapshot } from '../live/knowledge';

function StressApp() {
  const [view] = useState(() => new AtlasRuntime().receive(createStressObservation(), 0));
  const noop = () => undefined;
  return <MissionExperience view={view} mode="stress" chapter={0} time={0} playing={false} begun published={[]} onPlay={noop} onSeek={noop} onReplay={noop} onStage={noop} speed={1} onSpeed={noop} />;
}

/** The guided mission: an authored chronological replay of valid simulated observations and scans, processed by the real ATLAS runtime.
 * One mission clock drives everything. It maps onto simulation time through missionTimeline (some segments hold simulation time while the story
 * dwells on a result), so observations are always delivered in order, never skipped and never early. Seeking rebuilds the state from the start. */
function ReplayApp() {
  const replay = useRef(new MissionReplay());
  const cursor = useRef(0);
  const [clock, setClock] = useState(0);
  // Before the first observation ATLAS has received nothing: the opening shows an empty knowledge state.
  const empty = useMemo<KnowledgeSnapshot>(() => ({ source: 'replay', view: new AtlasRuntime().getView(0), scene: NO_SCENE_KNOWLEDGE, activity: [], appear: new Map(), lastScanAtS: null, pulses: [] }), []);
  const [knowledge, setKnowledge] = useState<KnowledgeSnapshot>(empty);
  const [playing, setPlaying] = useState(false);
  const [begun, setBegun] = useState(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1); speedRef.current = speed;
  const apply = useCallback((m: number) => {
    const t = Math.min(MISSION_CLOCK_END, Math.max(0, m));
    cursor.current = t; setClock(t);
    const sim = clockToSim(t);
    if (sim === null) { if (replay.current.delivered > 0) replay.current.reset(); setKnowledge(empty); return; }
    replay.current.seek(Math.min(MISSION_DURATION, sim));
    setKnowledge(replay.current.knowledge());
  }, [empty]);
  const seek = useCallback((t: number) => { apply(t); setBegun(true); }, [apply]);
  useEffect(() => {
    // Evidence hooks: ?at=<mission clock seconds> jumps to a moment, ?sim=<simulation seconds> to the moment that observation is delivered, ?stage=<1-5> to a stage start; observations are still delivered chronologically.
    const q = new URLSearchParams(location.search);
    const at = Number(q.get('at')), stage = Number(q.get('stage')), sim = Number(q.get('sim'));
    if (Number.isFinite(at) && q.has('at') && at >= 0 && at <= MISSION_CLOCK_END) seek(at);
    else if (Number.isFinite(sim) && q.has('sim') && sim >= 0 && sim <= MISSION_DURATION) seek(simToClock(sim));
    else if (Number.isInteger(stage) && stage >= 1 && stage <= 5) seek(STAGE_START_CLOCK[stage - 1]!);
    if (q.get('autoplay') === '1') setPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!playing) return;
    // The clock advances by real elapsed time (capped, so a suspended tab pauses the story instead of skipping it).
    let last = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
      const next = Math.min(MISSION_CLOCK_END, cursor.current + dt * speedRef.current);
      apply(next);
      if (next >= MISSION_CLOCK_END) setPlaying(false);
    }, 70);
    return () => window.clearInterval(interval);
  }, [playing, apply]);
  const play = () => { setBegun(true); if (cursor.current >= MISSION_CLOCK_END) apply(0); setPlaying(v => !v); };
  const start = (t: number) => { seek(t); setPlaying(true); };
  const archive = replay.current.readPublished();
  return <AugmentedMission knowledge={knowledge} archive={archive} clock={clock} playing={playing} begun={begun}
    onPlay={play} onStart={start} onSeek={seek} onReplay={() => { seek(0); setPlaying(true); }} onStage={(i: number) => seek(STAGE_START_CLOCK[i]!)} speed={speed} onSpeed={setSpeed} />;
}

export function MissionApp() {
  const experience = new URLSearchParams(location.search).get('experience');
  if (experience === 'live') return <LiveExperience />;
  if (experience === 'lab') return <IsolatedExperience />;
  if (experience === 'stress') return <StressApp />;
  if (experience === 'challenge') return <ChallengeApp />;
  // The scripted mission film is preserved as `?experience=mission` (and the ATLAS Command is the default product).
  if (experience === 'mission' || experience === 'replay') return <ReplayApp />;
  return <CommandApp />;
}
