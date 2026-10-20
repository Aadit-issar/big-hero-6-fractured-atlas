import type { SimulationEngine } from '../simulation/simulationEngine';
import type { TimeScale } from '../simulation/simulationClock';
import { QUALITY_LEVELS } from '../rendering/qualitySettings';
import type { QualityLevel } from '../rendering/qualitySettings';

interface SimulationControlsProps {
  readonly engine: SimulationEngine;
  readonly onStateChange: () => void;
  readonly onResetCamera: () => void;
  readonly quality: QualityLevel;
  readonly onQualityChange: (level: QualityLevel) => void;
}

const QUALITY_LABELS: Readonly<Record<QualityLevel, string>> = { performance: 'Perf', balanced: 'Bal', cinematic: 'Cine' };

const TIME_SCALES: readonly TimeScale[] = [0.25, 1, 2];

export function SimulationControls({ engine, onStateChange, onResetCamera, quality, onQualityChange }: SimulationControlsProps) {
  const togglePlayback = () => {
    if (engine.clock.isRunning) engine.clock.pause();
    else engine.clock.resume();
    onStateChange();
  };

  const resetSimulation = () => {
    engine.reset();
    onStateChange();
  };

  const chooseSpeed = (scale: TimeScale) => {
    engine.clock.setTimeScale(scale);
    onStateChange();
  };

  return (
    <section className="control-dock" aria-label="Simulation controls">
      <button
        className="primary-control"
        type="button"
        onClick={togglePlayback}
        aria-label={`${engine.clock.isRunning ? 'Pause' : 'Resume'} simulation`}
        data-testid="play-pause"
      >
        <span className="control-icon" aria-hidden="true">{engine.clock.isRunning ? 'Ⅱ' : '▶'}</span>
        {engine.clock.isRunning ? 'Pause' : 'Resume'}
      </button>

      <div className="speed-control" role="group" aria-label="Simulation time scale">
        <span className="control-label">TIME RATE</span>
        {TIME_SCALES.map((scale) => (
          <button
            type="button"
            key={scale}
            className={engine.clock.timeScale === scale ? 'speed-button is-selected' : 'speed-button'}
            aria-pressed={engine.clock.timeScale === scale}
            aria-label={`Set simulation speed to ${scale}×`}
            data-testid={`speed-${String(scale).replace('.', '-')}`}
            onClick={() => chooseSpeed(scale)}
          >
            {scale}×
          </button>
        ))}
      </div>

      <button type="button" className="icon-control" onClick={resetSimulation} aria-label="Reset simulation" data-testid="reset-simulation">
        <span aria-hidden="true">↺</span>
        <span className="visually-hidden">Reset simulation</span>
      </button>

      <span className="dock-divider" aria-hidden="true" />

      <button type="button" className="camera-control" onClick={onResetCamera} aria-label="Reset camera" data-testid="reset-camera">
        <span aria-hidden="true">⌖</span>
        <span>Reset view</span>
      </button>

      <span className="dock-divider" aria-hidden="true" />

      {/* Rendering quality only; the simulation is unaffected by this choice. */}
      <div className="speed-control" role="group" aria-label="Rendering quality">
        <span className="control-label">QUALITY</span>
        {QUALITY_LEVELS.map((level) => (
          <button
            type="button"
            key={level}
            className={quality === level ? 'speed-button is-selected' : 'speed-button'}
            aria-pressed={quality === level}
            aria-label={`Set rendering quality to ${level}`}
            data-testid={`quality-${level}`}
            onClick={() => onQualityChange(level)}
          >
            {QUALITY_LABELS[level]}
          </button>
        ))}
      </div>
    </section>
  );
}
