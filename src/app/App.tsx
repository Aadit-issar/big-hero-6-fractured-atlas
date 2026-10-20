import { Component, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { DEFAULT_SEED } from '../simulation/constants';
import { SimulationEngine } from '../simulation/simulationEngine';
import type { SimulationTelemetry } from '../scene/sceneTypes';
import { collectTelemetry } from '../scene/telemetry';
import { DimensionScene, requestIslandTerrain } from '../scene/DimensionScene';
import { HelpOverlay } from '../ui/HelpOverlay';
import { SimulationHUD } from '../ui/SimulationHUD';
import { initialQuality, QUALITY_PRESETS, rememberQuality } from '../rendering/qualitySettings';
import type { QualityLevel } from '../rendering/qualitySettings';
import { isRenderReady, readReadiness, subscribeReadiness } from '../rendering/renderReadiness';

function initialHudVisible(): boolean {
  try { return new URLSearchParams(window.location.search).get('hud') !== '0'; } catch { return true; }
}

type ErrorBoundaryState = { readonly message: string | null };

class SceneErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { message: error.message };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.setState({ message: error.message });
  }

  render(): ReactNode {
    if (this.state.message) {
      return (
        <main className="error-state" role="alert">
          <div className="error-symbol">!</div>
          <h1>DIMENSIONAL LINK UNAVAILABLE</h1>
          <p>The 3D scene could not start. Check that your browser supports WebGL2.</p>
          <code>{this.state.message}</code>
        </main>
      );
    }
    return this.props.children;
  }
}

function initialTelemetry(engine: SimulationEngine): SimulationTelemetry {
  return collectTelemetry(engine);
}

function supportsWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    const context = probe.getContext('webgl2');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const engine = useMemo(() => new SimulationEngine(DEFAULT_SEED), []);
  const [telemetry, setTelemetry] = useState(() => initialTelemetry(engine));
  const [, setActionRevision] = useState(0);
  const [cameraResetVersion, setCameraResetVersion] = useState(0);
  const [webGLSupported, setWebGLSupported] = useState<boolean | null>(null);
  const [rendererReady, setRendererReady] = useState(false);

  const updateTelemetry = useCallback((next: SimulationTelemetry) => setTelemetry(next), []);
  const refreshControls = useCallback(() => setActionRevision((revision) => revision + 1), []);
  const resetCamera = useCallback(() => setCameraResetVersion((version) => version + 1), []);
  const onWebGLReady = useCallback(() => setRendererReady(true), []);
  const [qualityLevel, setQualityLevel] = useState<QualityLevel>(initialQuality);
  const quality = QUALITY_PRESETS[qualityLevel];
  // Start off-thread geology immediately; the scene later reuses the cached results.
  useMemo(() => { requestIslandTerrain(engine, quality).forEach(({ promise }) => promise.catch(() => undefined)); }, [engine, quality]);
  const chooseQuality = useCallback((level: QualityLevel) => { rememberQuality(level); setQualityLevel(level); }, []);
  const [hudVisible, setHudVisible] = useState(initialHudVisible);
  const readiness = useSyncExternalStore(subscribeReadiness, readReadiness);

  // H toggles a presentation mode that hides the HUD; controls stay bound.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, select, textarea')) return;
      if (event.code === 'KeyH' && !event.repeat) setHudVisible((visible) => !visible);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setWebGLSupported(supportsWebGL2());
  }, []);

  if (webGLSupported === false) {
    return (
      <main className="error-state" role="alert">
        <div className="error-symbol">!</div>
        <h1>WEBGL2 IS REQUIRED</h1>
        <p>Enable WebGL2 in a supported desktop browser, then reload the simulation.</p>
      </main>
    );
  }

  return (
    <main className={hudVisible ? 'application-shell' : 'application-shell hud-hidden'} data-render-ready={rendererReady && isRenderReady(readiness)}>
      <div className="scene-layer" data-testid="world-scene" data-island-count={engine.world.islands.length}>
        {webGLSupported && (
          <SceneErrorBoundary>
            <DimensionScene
              engine={engine}
              quality={quality}
              onTelemetry={updateTelemetry}
              resetCameraVersion={cameraResetVersion}
              onWebGLReady={onWebGLReady}
            />
          </SceneErrorBoundary>
        )}
        {(!rendererReady || !isRenderReady(readiness)) && <HelpOverlay readiness={readiness} />}
        <div className="vignette" aria-hidden="true" />
      </div>
      <SimulationHUD
        engine={engine}
        telemetry={telemetry}
        onStateChange={refreshControls}
        onResetCamera={resetCamera}
        quality={qualityLevel}
        onQualityChange={chooseQuality}
      />
    </main>
  );
}
