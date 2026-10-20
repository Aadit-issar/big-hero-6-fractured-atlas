import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AtlasView } from '../core/runtime';
import { observe } from '../../sensors/atlasSensor';
import { SimulationEngine } from '../../simulation/simulationEngine';
import { AtlasRuntime } from '../core/runtime';
import { AtlasConsole } from '../ui/AtlasConsole';
import { createFixtureObservation, createReplayObservation, createStressObservation, createTemporalObservation } from './fixtures';

type LabMode = 'live' | 'fixture' | 'replay' | 'temporal' | 'insufficient' | 'warning' | 'stress' | 'offline' | 'empty';

function readMode(): LabMode {
  const requested = new URLSearchParams(window.location.search).get('mode');
  if (requested === 'fixture' || requested === 'replay' || requested === 'temporal' || requested === 'insufficient' || requested === 'warning' || requested === 'stress' || requested === 'offline' || requested === 'empty') return requested;
  return 'live';
}

function sourceLabel(mode: LabMode): string {
  if (mode === 'fixture') return 'FIXTURE DATA · NOT LIVE';
  if (mode === 'replay') return 'REPLAY FIXTURE · NOT LIVE';
  if (mode === 'temporal') return 'TEMPORAL FIXTURE · NOT LIVE';
  if (mode === 'insufficient') return 'SPARSE FIXTURE · NOT LIVE';
  if (mode === 'warning') return 'WARNING FIXTURE · NOT LIVE';
  if (mode === 'stress') return 'STRESS FIXTURE · NOT LIVE';
  if (mode === 'offline') return 'OFFLINE STATE · TEST VIEW';
  if (mode === 'empty') return 'AWAITING LINK · TEST VIEW';
  return 'LIVE LAB · ISOLATED SIMULATION';
}

/** The only module allowed to host the dimension engine for the standalone lab. */
export function AtlasLab({ renderView }: { renderView?: (view: AtlasView) => ReactNode } = {}) {
  const runtimeRef = useRef<AtlasRuntime | null>(null);
  if (!runtimeRef.current) runtimeRef.current = new AtlasRuntime();
  const runtime = runtimeRef.current;
  const mode = readMode();
  const [view, setView] = useState(() => runtime.getView(Date.now()));

  useEffect(() => {
    let frame = 0;
    let interval = 0;
    let active = true;
    const healthInterval = window.setInterval(() => {
      if (active) setView(runtime.getView(Date.now()));
    }, 500);

    if (mode === 'offline') {
      setView(runtime.markUnavailable('Live simulation connection disabled for the offline test view.', Date.now()));
    } else if (mode === 'fixture') {
      let sampleIndex = 0;
      const deliver = () => {
        if (!active) return;
        setView(runtime.receive(createFixtureObservation(sampleIndex * 0.25), Date.now()));
        sampleIndex += 1;
      };
      deliver();
      interval = window.setInterval(deliver, 250);
    } else if (mode === 'replay') {
      let stage = 0;
      const deliver = () => {
        if (!active) return;
        setView(runtime.receive(createReplayObservation(stage), Date.now()));
        stage = Math.min(4, stage + 1);
      };
      deliver();
      interval = window.setInterval(deliver, 900);
    } else if (mode === 'temporal') {
      let sampleIndex = 0;
      const deliver = () => {
        if (!active) return;
        setView(runtime.receive(createTemporalObservation(sampleIndex * 0.25), Date.now()));
        sampleIndex += 1;
      };
      deliver();
      interval = window.setInterval(deliver, 250);
    } else if (mode === 'insufficient') {
      const deliver = () => { if (active) setView(runtime.receive(createTemporalObservation(0), Date.now())); };
      deliver();
      interval = window.setInterval(deliver, 250);
    } else if (mode === 'warning') {
      const deliver = () => { if (active) setView(runtime.receive(createTemporalObservation(30), Date.now())); };
      deliver();
      interval = window.setInterval(deliver, 250);
    } else if (mode === 'stress') {
      setView(runtime.receive(createStressObservation(), Date.now()));
    } else if (mode === 'empty') {
      setView(runtime.getView(Date.now()));
    } else {
      try {
        const engine = new SimulationEngine();
        setView(runtime.receive(observe(engine), Date.now()));
        let previousFrame: number | null = null;
        let lastDelivery = 0;
        const step = (frameTime: number) => {
          if (!active) return;
          if (previousFrame !== null) {
            const deltaSeconds = Math.min(0.05, Math.max(0, (frameTime - previousFrame) / 1000));
            engine.advance(deltaSeconds);
          }
          previousFrame = frameTime;
          if (lastDelivery === 0 || frameTime - lastDelivery >= 250) {
            setView(runtime.receive(observe(engine), Date.now()));
            lastDelivery = frameTime;
          }
          frame = window.requestAnimationFrame(step);
        };
        frame = window.requestAnimationFrame(step);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Simulation host could not provide an observation.';
        setView(runtime.markUnavailable(reason, Date.now()));
      }
    }

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.clearInterval(healthInterval);
    };
  }, [mode, runtime]);

  return renderView ? renderView(view) : <AtlasConsole view={view} sourceLabel={sourceLabel(mode)} />;
}
