import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { CommandSession } from '../session';
import type { CommandSnapshot } from '../session';
import { CommandScene } from '../scene/CommandScene';
import type { DisplayAnchors } from '../scene/CommandScene';
import type { AtlasView, SceneApi, ScenePresentation, SceneQuality } from '../scene/sceneApi';
import { Labels } from './Labels';
import { Header } from './panels/Header';
import { Catalogue } from './panels/Catalogue';
import { TacticalPanel } from './panels/TacticalPanel';
import { PredictPanel } from './panels/PredictPanel';
import { RoutePanel } from './panels/RoutePanel';
import { EventToast } from './panels/EventToast';
import { OpeningCard } from './panels/OpeningCard';
import './command.css';

export const DEFAULT_DIMENSION_URL = 'http://127.0.0.1:4183/?quality=cinematic&view=baymax';

function useSnapshot(session: CommandSession): CommandSnapshot { return useSyncExternalStore(session.subscribe, session.getSnapshot); }
const QUALITIES: readonly SceneQuality[] = ['performance', 'balanced', 'cinematic'];

export function CommandApp() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [session] = useState(() => new CommandSession({ dimensionUrl: params.get('dimension') ?? DEFAULT_DIMENSION_URL }));
  const snap = useSnapshot(session);
  const snapRef = useRef(snap); snapRef.current = snap;
  const anchors = useRef<DisplayAnchors>({ baymax: new Vector3(0, 10, 0), entities: new Map(), meeting: null, ghost: null, scale: 110 });
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const [view, setViewState] = useState<AtlasView>('tactical');
  const [follow, setFollow] = useState(true);
  const [focusNonce, setFocusNonce] = useState(0);
  const [eco, setEco] = useState(() => params.get('eco') === '1');
  const [labels, setLabels] = useState(false);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1200);
  const [quality, setQuality] = useState<SceneQuality>(() => { const q = params.get('quality'); return QUALITIES.includes(q as SceneQuality) ? (q as SceneQuality) : 'balanced'; });
  const presentation = useMemo<ScenePresentation>(() => ({ view, showAllLabels: labels, showGrid: false, quality }), [view, labels, quality]);
  const fps = Number(params.get('fps')) || (eco ? 12 : 30);
  const base = import.meta.env.BASE_URL;
  const scene = useCallback(() => apiRef.current, []);

  useEffect(() => {
    if (window.opener) session.linkOpener();
    (window as unknown as { __ATLAS_COMMAND__?: unknown }).__ATLAS_COMMAND__ = { session, snapshot: () => session.getSnapshot() };
    return () => { session.dispose(); delete (window as unknown as { __ATLAS_COMMAND__?: unknown }).__ATLAS_COMMAND__; };
  }, [session]);

  /** Camera commands are issued a moment after state changes so the scene resolves them against the new selection, plan and forecast. */
  const frame = useCallback((v: AtlasView) => {
    window.setTimeout(() => {
      const api = apiRef.current, s = snapRef.current;
      if (!api || !s.selectedId) return;
      if (v === 'predict') api.fitPrediction();
      else if (v === 'route') { if (s.plan?.mode === 'intercept') api.fitInterception(); else api.fitRoute(); }
    }, 80);
  }, []);

  const setView = useCallback((v: AtlasView) => {
    setViewState(v);
    if (v !== 'tactical' && snapRef.current.selectedId) { setFollow(false); apiRef.current?.setFollow(false); setFocusNonce(n => n + 1); frame(v); }
  }, [frame]);

  const select = useCallback((id: string | null) => {
    session.select(id);
    if (!id) return;
    setFollow(false); apiRef.current?.setFollow(false); setFocusNonce(n => n + 1);
    if (viewRef.current !== 'tactical') frame(viewRef.current);
  }, [session, frame]);
  const viewRef = useRef(view); viewRef.current = view;

  const onFollow = () => { const next = !follow; setFollow(next); apiRef.current?.setFollow(next); };
  const onOverview = () => { setFollow(false); apiRef.current?.setFollow(false); apiRef.current?.overview(); };
  const onFit = () => { const api = apiRef.current; if (!api) return; if (view === 'predict') api.fitPrediction(); else if (snap.plan?.mode === 'intercept') api.fitInterception(); else api.fitRoute(); };
  const fitLabel = !snap.selectedId ? null : view === 'predict' ? 'Fit prediction' : view === 'route' ? (snap.plan?.mode === 'intercept' ? 'Show rendezvous' : 'Fit route') : null;

  const hasData = snap.entities.length > 0 || snap.pose !== null;
  const opening = snap.link.status === 'idle' || snap.link.status === 'connecting' || (snap.link.status === 'disconnected' && !hasData);
  const panel = { snap, session, scene, setView };

  return (
    <div className="cmd-root" data-testid="atlas-command" data-link={snap.link.status} data-view={view} data-entities={snap.entities.length} data-route={snap.route.state}>
      <div className="cmd-stage">
        <CommandScene snapshotRef={snapRef} session={session} follow={follow} focusNonce={focusNonce} focusId={snap.selectedId} onManual={() => setFollow(false)} onSelect={select}
          cameraRef={cameraRef} anchorsRef={anchors} base={base} view={view} fps={fps} presentation={presentation} apiRef={apiRef} />
        <Labels snapshotRef={snapRef} anchorsRef={anchors} cameraRef={cameraRef} onSelect={select} presentation={presentation} />
      </div>

      <Header snap={snap} session={session} view={view} setView={setView} follow={follow} onFollow={onFollow} onOverview={onOverview} onFit={onFit} fitLabel={fitLabel}
        eco={eco} setEco={setEco} labels={labels} setLabels={setLabels} quality={quality} setQuality={setQuality} />

      {opening && <OpeningCard snap={snap} session={session} />}

      {!opening && (
        <>
          <aside className={`left ${leftOpen ? '' : 'closed'}`}>
            {leftOpen
              ? <Catalogue snap={snap} onSelect={select} onCollapse={() => setLeftOpen(false)} />
              : <button type="button" className="rail-tab" onClick={() => setLeftOpen(true)} aria-label="Open the target list" data-testid="open-catalogue"><span>{'›'}</span><b>Targets</b><em>{snap.targets.length}</em></button>}
          </aside>
          <aside className="right">
            {view === 'tactical' && <TacticalPanel {...panel} />}
            {view === 'predict' && <PredictPanel {...panel} />}
            {view === 'route' && <RoutePanel {...panel} />}
          </aside>
          <EventToast snap={snap} session={session} />
        </>
      )}
    </div>
  );
}
