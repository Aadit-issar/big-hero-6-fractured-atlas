import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AtlasView } from '../core/runtime';
import { AtlasLab } from '../lab/AtlasLab';
import { AtlasConsole } from './AtlasConsole';
import { AugmentedStage } from './AugmentedStage';
import { SceneObjectsAnalysis } from './SceneObjectsAnalysis';
import { LiveSession } from '../live/liveSession';
import { activityFromRuntimeEvent, NO_SCENE_KNOWLEDGE } from '../live/knowledge';
import type { ActivityEntry, KnowledgeSnapshot, ScanPulse } from '../live/knowledge';
import type { LinkState } from '../live/linkCore';

/** Where the integration build of the Dimension (with the read-only ATLAS bridge) is served. */
export const DEFAULT_DIMENSION_URL = 'http://127.0.0.1:4173/?quality=performance';

function describeLink(link: LinkState, nowMs: number): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  const short = link.session ? link.session.slice(0, 8) : '';
  switch (link.status) {
    case 'connected': return { label: `CONNECTED TO DIMENSION · ${short}`, tone: 'ok' };
    case 'stale': return { label: `DATA STALE · ${link.lastFrameAtMs === null ? '' : `${Math.round((nowMs - link.lastFrameAtMs) / 1000)}s since last frame`}`, tone: 'warn' };
    case 'disconnected': return { label: 'DISCONNECTED · LAST KNOWN STATE', tone: 'bad' };
    case 'connecting': return { label: 'CONNECTING TO DIMENSION…', tone: 'warn' };
    default: return { label: 'NOT CONNECTED', tone: 'neutral' };
  }
}

export function LiveExperience() {
  const params = new URLSearchParams(location.search);
  const [session] = useState(() => new LiveSession({ dimensionUrl: params.get('dimension') ?? DEFAULT_DIMENSION_URL }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [analysis, setAnalysis] = useState(false);
  const [follow, setFollow] = useState(true);
  const [light, setLight] = useState(() => params.get('light') === '1');
  useEffect(() => {
    // Opened from the Dimension (key L): the opener is the world to link to.
    if (window.opener) session.linkOpener();
    (window as unknown as { __ATLAS_LIVE__?: unknown }).__ATLAS_LIVE__ = { snapshot: () => session.getSnapshot(), requestScan: () => session.requestScan() };
    return () => { session.dispose(); delete (window as unknown as { __ATLAS_LIVE__?: unknown }).__ATLAS_LIVE__; };
  }, [session]);

  const { link } = snapshot;
  const { label, tone } = describeLink(link, session.wallNow());
  const view = snapshot.view;
  const connected = link.status === 'connected';

  if (analysis) {
    return <div className="mission-analysis"><div className="analysis-return"><button onClick={() => setAnalysis(false)}>← Return to the dimension</button><span>{label}</span></div>
      <AtlasConsole view={view} sourceLabel={label} /><SceneObjectsAnalysis knowledge={snapshot} link={link} /></div>;
  }
  const opening = link.status === 'idle' || link.status === 'connecting' || (link.status === 'disconnected' && !view.observation) ? (
    <div className="aug-opening" data-testid="live-connect">
      <p className="aug-kicker">LIVE SCAN · LINKED TO THE RUNNING DIMENSION</p>
      <h1>{link.status === 'connecting' ? 'Waiting for the Dimension to answer…' : 'Connect ATLAS to the real Dimension.'}</h1>
      <p className="aug-sub">
        ATLAS receives observations from the same running world you fly through, over a read-only, origin-checked link. Nothing is shown until Baymax's sensors or scanner acquire it. This is not the replay.
      </p>
      <div className="aug-actions">
        <button className="aug-begin" onClick={() => session.openDimension()}>{link.status === 'connecting' ? 'Retry connection' : 'Open Dimension & connect'}</button>
        <a className="aug-ghost" href="?experience=lab">Isolated Lab (not the real Dimension)</a>
        <a className="aug-ghost" href="?experience=mission">Guided replay</a>
      </div>
      <p className="aug-fine">Already running the Dimension? Press <b>L</b> inside it to open ATLAS linked to that session.{link.status === 'disconnected' ? ' The last attempt timed out.' : ''}</p>
    </div>
  ) : null;
  const lastScan = snapshot.lastScan;
  const caption = !opening ? (
    <div className="aug-stage" key={snapshot.episode}>
      <p className="aug-kicker">{connected ? 'LIVE SCAN · OBSERVING THE RUNNING DIMENSION' : 'LIVE SCAN · NO NEW DATA'}</p>
      <p className="aug-line">{lastScan ? `Scan #${lastScan.scanId} at sim t ${lastScan.time.toFixed(1)}s: ${lastScan.inRange} object${lastScan.inRange === 1 ? '' : 's'} in range, ${lastScan.acquired} new, ${lastScan.left} left range.` : 'Move through the Dimension. ATLAS records what Baymax observes.'}</p>
      <p className="aug-meta">Simulation time {link.lastSimTime === null ? '—' : link.lastSimTime.toFixed(2)}s · scan range {link.scanRange ?? '—'} · mode {link.scanMode ?? '—'}</p>
    </div>
  ) : null;
  const bottom = (
    <>
      <div className="aug-transport live-controls">
        <button className="aug-scan" disabled={!connected || snapshot.scanPending} onClick={() => session.requestScan()}>{snapshot.scanPending ? 'Scanning…' : '◉ Scan now'}</button>
        <button onClick={() => session.setScanMode(link.scanMode === 'manual' ? 'continuous' : 'manual')} disabled={!connected} aria-pressed={link.scanMode === 'continuous'}>{link.scanMode === 'manual' ? 'Manual scans' : 'Continuous scans'}</button>
        <button onClick={() => (connected ? session.disconnect() : session.reconnect())}>{connected ? 'Disconnect' : 'Reconnect'}</button>
      </div>
      <span className="aug-live-note">{link.session ? `session ${link.session.slice(0, 8)} · seq ${link.lastSeq} · ${link.counters.accepted} frames` : 'not linked'}</span>
    </>
  );
  return <AugmentedStage knowledge={snapshot} mode="live" sourceLabel={label} sourceTone={tone} clock={{ kind: 'wall', now: () => session.presentationNow() }} chapter={snapshot.episode}
    follow={follow} onFollowChange={setFollow} maxFps={connected ? 30 : 0} lightweight={light} onLightweightChange={setLight}
    navigation={{ advice: snapshot.navigation.advice, goalId: snapshot.navigation.goalId, setGoal: id => { session.setGoal(id); }, changes: snapshot.navigation.changes }} onAnalysis={() => setAnalysis(true)} opening={opening} caption={caption} bottom={bottom}
    dataAttributes={{ link: link.status, episode: link.episode, scans: snapshot.scene.scans.length }} />;
}

/** The standalone isolated lab, rendered through the same stage. It runs its own SimulationEngine and is never a link to the Dimension. */
export function IsolatedExperience() {
  const appear = useRef(new Map<string, number>());
  const activity = useRef<ActivityEntry[]>([]);
  const lastEvent = useRef(0);
  const t0 = useRef(performance.now());
  const [analysis, setAnalysis] = useState<AtlasView | null>(null);
  const nowS = () => (performance.now() - t0.current) / 1000;
  const label = 'ISOLATED SIMULATION · NOT THE LIVE DIMENSION';
  return <AtlasLab renderView={view => {
    const at = nowS();
    for (const i of [...view.mapping.islands, ...view.mapping.folds]) if (!appear.current.has(i.id)) appear.current.set(i.id, at);
    if (!appear.current.has('baymax-observer') && view.mapping.explorer.latestPosition) appear.current.set('baymax-observer', at);
    for (const e of view.events.slice().reverse()) {
      if (e.id <= lastEvent.current) continue;
      const entry = activityFromRuntimeEvent(e, view, at, activity.current.length + 1);
      if (entry) activity.current = [...activity.current.slice(-39), entry];
    }
    lastEvent.current = Math.max(lastEvent.current, ...view.events.map(e => e.id), 0);
    const pulses: ScanPulse[] = [...appear.current.values()].sort((a, b) => a - b).slice(-8).map(atS => ({ atS, range: 45 }));
    const knowledge: KnowledgeSnapshot = { source: 'isolated', view, scene: NO_SCENE_KNOWLEDGE, activity: activity.current, appear: new Map(appear.current), lastScanAtS: null, pulses };
    if (analysis) return <div className="mission-analysis"><div className="analysis-return"><button onClick={() => setAnalysis(null)}>← Return to the dimension</button><span>{label}</span></div><AtlasConsole view={view} sourceLabel={label} /></div>;
    return <AugmentedStage knowledge={knowledge} mode="isolated" sourceLabel={label} sourceTone="warn" clock={{ kind: 'wall', now: nowS }} chapter={0} onAnalysis={() => setAnalysis(view)}
      caption={<div className="aug-stage"><p className="aug-kicker">ISOLATED LAB</p><p className="aug-line">A separate simulation running inside ATLAS, for technical analysis. It is not linked to the Dimension you fly through.</p></div>}
      bottom={<span className="aug-live-note">isolated engine · stationary observer · for the real world use Live Scan</span>} />;
  }} />;
}
