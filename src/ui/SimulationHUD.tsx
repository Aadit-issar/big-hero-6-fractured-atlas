import type { SimulationEngine } from '../simulation/simulationEngine';
import type { SimulationTelemetry } from '../scene/sceneTypes';
import { SimulationControls } from './SimulationControls';
import type { QualityLevel } from '../rendering/qualitySettings';

interface SimulationHUDProps {
  readonly engine: SimulationEngine;
  readonly telemetry: SimulationTelemetry;
  readonly onStateChange: () => void;
  readonly onResetCamera: () => void;
  readonly quality: QualityLevel;
  readonly onQualityChange: (level: QualityLevel) => void;
}

function clockDisplay(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${minutes}:${remainingSeconds}`;
}

function coordinateDisplay(position: readonly [number, number, number]): string {
  return position.map((coordinate) => coordinate.toFixed(1).padStart(6, ' ')).join('  ');
}

export function SimulationHUD({ engine, telemetry, onStateChange, onResetCamera, quality, onQualityChange }: SimulationHUDProps) {
  const running = engine.clock.isRunning;

  return (
    <div className="hud-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-kicker">BIG HERO 6 <span>•</span> EXPEDITION SYSTEMS</div>
            <h1>FRACTURED <span>DIMENSION</span></h1>
          </div>
        </div>

        <div className="status-stack">
          <div className={running ? 'live-status' : 'live-status is-paused'} data-testid="simulation-status">
            <span className="status-dot" />
            {running ? 'SIMULATION LIVE' : 'SIMULATION PAUSED'}
          </div>
          <div className="status-subtitle">DETERMINISTIC FIELD MODEL <span>·</span> PHASE 03</div>
        </div>
      </header>

      <section className="telemetry-panel glass-panel" aria-label="Simulated field readout">
        <div className="panel-eyebrow"><span className="signal-glyph">⌁</span> SIMULATED FIELD READOUT</div>
        <div className="time-row">
          <div>
            <span className="metric-label">MODEL TIME</span>
            <strong className="time-value" data-testid="sim-time">T+ {clockDisplay(telemetry.time)} <i>s</i></strong>
          </div>
          <div className="seed-readout">
            <span className="metric-label">WORLD SEED</span>
            <strong data-testid="world-seed">{engine.seed}</strong>
          </div>
        </div>

        <div className="telemetry-divider" />

        <div className="measurement-row">
          <div className="measurement">
            <span className="metric-label">FIELD Φ</span>
            <strong data-testid="field-value">{telemetry.fieldValue.toFixed(4)}</strong>
          </div>
          <div className="measurement">
            <span className="metric-label">∥∇Φ∥ DISTORTION</span>
            <strong data-testid="distortion-value">{telemetry.distortion.toFixed(4)}</strong>
          </div>
          <div className="measurement">
            <span className="metric-label">DET J</span>
            <strong data-testid="jacobian-value">{telemetry.jacobianDeterminant.toFixed(4)}</strong>
          </div>
        </div>

        <div className="camera-readout">
          <span className="metric-label">CAMERA · WORLD UNITS</span>
          <code data-testid="camera-position">{coordinateDisplay(telemetry.cameraPosition)}</code>
        </div>
        <div className="reference-readout">
          <span className="metric-label">REFERENCE BRANCH <strong data-testid="current-region">{telemetry.regionId}</strong></span>
          <code data-testid="reference-position">{coordinateDisplay(telemetry.referencePosition)}</code>
          <span className={telemetry.referenceStatus==='converged'?'inverse-status':'inverse-status uncertain'} data-testid="reference-status">
            {telemetry.referenceStatus.toUpperCase()} · residual {Number.isFinite(telemetry.referenceResidual)?telemetry.referenceResidual.toExponential(1):'invalid'}u
          </span>
        </div>
        <div className="telemetry-divider" />
        <div className="measurement-row">
          <div className="measurement"><span className="metric-label">MIN STRETCH σ</span><strong data-testid="minimum-stretch">{telemetry.minSingularValue.toFixed(4)}</strong></div>
          <div className="measurement"><span className="metric-label">GRAVITY · REF/s²</span><strong data-testid="gravity-value">{telemetry.gravity.toFixed(3)}</strong></div>
          <div className="measurement"><span className="metric-label">RISK</span><strong data-testid="hazard-value">{(telemetry.hazard*100).toFixed(0)}%</strong></div>
        </div>
        <div className="hazard-meter"><span style={{width:`${telemetry.hazard*100}%`}}/></div>
        <p className="probe-note">Measurements follow the tracked reference branch. Amber probes respond to field gravity.</p>
      </section>

      <div className="scene-hint" aria-hidden="true">
        <span className="hint-line" /> FRACTURED SPACE <span className="hint-line" />
      </div>

      <section className="fold-readout glass-panel" aria-label="Nearby spatial connection">
        <div className="panel-eyebrow">SPATIAL CONNECTION <span>{telemetry.activeConnections} OPEN</span></div>
        <strong data-testid="nearest-fold">{telemetry.nearestFold}</strong>
        <p data-testid="traversal-hint">{telemetry.interactionHint}</p>
        {telemetry.traversalCount>0&&<div className="transfer-feedback" data-testid="traversal-result">BRANCH TRANSFER {String(telemetry.traversalCount).padStart(2,'0')} · {telemetry.lastTransition}</div>}
      </section>

      <SimulationControls engine={engine} onStateChange={onStateChange} onResetCamera={onResetCamera} quality={quality} onQualityChange={onQualityChange} />

      <aside className="help-panel glass-panel" aria-label="Flight controls">
        <div className="panel-eyebrow">FLIGHT CONTROLS <span className="help-tag">FREE ROAM</span></div>
        <div className="control-list">
          <div><span className="key-cluster"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>Move</span></div>
          <div><span className="key-wide"><kbd>SPACE</kbd></span><span>Ascend</span></div>
          <div><span className="key-wide"><kbd>CTRL</kbd></span><span>Descend</span></div>
          <div><span className="key-wide"><kbd>SHIFT</kbd></span><span>Boost</span></div>
          <div><span className="key-wide"><kbd>R</kbd></span><span>Reset view</span></div>
          <div><span className="key-wide"><kbd>E</kbd></span><span>Enter fold</span></div>
          <div><span className="key-wide"><kbd>H</kbd></span><span>Hide HUD</span></div>
          <div><span className="key-wide"><kbd>1–9</kbd></span><span>Viewpoints</span></div>
        </div>
        <div className="mouse-hint"><span className="mouse-icon" aria-hidden="true">◉</span> Drag to look around <kbd>ESC</kbd> release</div>
      </aside>

      <footer className="bottom-caption">
        <span>SFIT FIELD RESEARCH</span>
        <span>BRANCH-AWARE SPACE <i>•</i> MODEL v2.0</span>
      </footer>
    </div>
  );
}
