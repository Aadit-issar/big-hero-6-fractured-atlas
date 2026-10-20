import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Composer } from '../../scene/AugmentedWorld';
import { BaymaxActor } from '../../scene/BaymaxActor';
import { IslandBody } from '../../scene/IslandBody';
import { Motes } from '../../scene/Motes';
import { NebulaSky } from '../../scene/NebulaSky';
import { ScanPulses } from '../../scene/ScanPulses';
import type { SceneModel } from '../../scene/sceneModel';
import type { FilmBeat } from '../director';
import type { Presentation } from '../presentation';
import { GlbWreckage } from './GlbWreckage';
import { ChallengeOverlay3D } from './ChallengeOverlay3D';

export interface StageLabel { readonly key: string; readonly text: string; readonly sub?: string | undefined; readonly position: readonly [number, number, number]; readonly tone: 'neutral' | 'amber' | 'lilac' | 'warm' }

/** Deterministic camera: the pose is a pure function of the film clock and the director's shot, so a captured film is repeatable.
 * Dragging hands control to the viewer (orbit); `Resume` returns to the directed camera. */
function DirectedCamera({ stateRef, beatRef, manual, onManual }: { readonly stateRef: { current: Presentation }; readonly beatRef: { current: FilmBeat }; readonly manual: boolean; readonly onManual: () => void }) {
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const manualRef = useRef(manual); manualRef.current = manual;
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08; c.minDistance = 6; c.maxDistance = 160;
    const start = () => onManual();
    c.addEventListener('start', start); controls.current = c;
    return () => { c.removeEventListener('start', start); c.dispose(); controls.current = null; };
  }, [camera, gl, onManual]);
  useFrame(() => {
    const c = controls.current; if (!c) return;
    if (manualRef.current) { c.update(); return; }
    const shot = stateRef.current.scene.shot, t = stateRef.current.scene.time; if (!shot) return;
    const yaw = shot.yaw + Math.sin(t * 0.07) * 0.06 * shot.drift, pitch = shot.pitch + Math.sin(t * 0.05 + 1.3) * 0.02 * shot.drift;
    camera.position.set(shot.centre[0] + Math.sin(yaw) * Math.cos(pitch) * shot.dist, shot.centre[1] + Math.sin(pitch) * shot.dist + 1.2, shot.centre[2] + Math.cos(yaw) * Math.cos(pitch) * shot.dist);
    c.target.set(shot.centre[0], shot.centre[1], shot.centre[2]);
    camera.lookAt(c.target);
    c.update();
  });
  void beatRef;
  return null;
}

/** Projects the label anchors to the DOM each frame (no React state). */
function LabelProjector({ labelsRef, layer }: { readonly labelsRef: { current: readonly StageLabel[] }; readonly layer: { current: HTMLElement | null } }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const root = layer.current; if (!root) return;
    const cam = camera as PerspectiveCamera;
    const panel = document.querySelector('.ch-chartpanel')?.getBoundingClientRect();
    for (const l of labelsRef.current) {
      const el = root.querySelector<HTMLElement>(`[data-key="${l.key}"]`); if (!el) continue;
      v.set(l.position[0], l.position[1], l.position[2]).project(cam);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * size.width, y = (1 - (v.y * 0.5 + 0.5)) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const hidden = !!panel && x > panel.left - 20 && x < panel.right + 20 && y > panel.top - 60 && y < panel.bottom + 20;
      el.dataset.behind = behind || hidden ? '1' : '0';
    }
  });
  return null;
}

/** Hands frame stepping to the film exporter: with frameloop "never" every frame is advanced explicitly with a fixed time step. */
function FilmDriver({ film, onApi }: { readonly film: boolean; readonly onApi: (api: { step: (ms: number) => void }) => void }) {
  const advance = useThree(s => s.advance);
  useEffect(() => { if (film) onApi({ step: (ms: number) => advance(ms, true) }); }, [film, advance, onApi]);
  return null;
}

export interface ChallengeStageProps {
  readonly presentation: Presentation;
  readonly beat: FilmBeat;
  readonly labels: readonly StageLabel[];
  readonly film: boolean;
  readonly assetBase: string;
  readonly primaryId: string;
  readonly manual: boolean;
  readonly onManual: () => void;
  readonly onReady: () => void;
  readonly onStepApi: (api: { step: (ms: number) => void }) => void;
  readonly labelLayer: { current: HTMLElement | null };
}

export function ChallengeStage(props: ChallengeStageProps) {
  const { presentation, beat, labels, film, assetBase, primaryId, manual } = props;
  const stateRef = useRef(presentation); stateRef.current = presentation;
  const beatRef = useRef(beat); beatRef.current = beat;
  const modelRef = useRef<SceneModel>(presentation.scene); modelRef.current = presentation.scene;
  const overlayRef = useRef(presentation.overlay); overlayRef.current = presentation.overlay;
  const labelsRef = useRef(labels); labelsRef.current = labels;
  const ambient = useRef(0); ambient.current = presentation.scene.time;
  const gate = useRef(true);
  const [glbReady, setGlbReady] = useState(false);
  const readyOnce = useRef(false);
  useEffect(() => { if (glbReady && !readyOnce.current) { readyOnce.current = true; props.onReady(); } }, [glbReady, props]);
  const onGlb = useCallback(() => setGlbReady(true), []);
  const select = useCallback(() => undefined, []);
  return (
    <Canvas className="ch-canvas" frameloop={film ? 'never' : 'always'} dpr={film ? 1 : [0.75, 1.25]} camera={{ fov: 50, near: 0.5, far: 2000, position: [-4, 17, 40] }}
      gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}>
      <NebulaSky sceneTime={ambient} scale={0.6} gate={gate} />
      <Motes sceneTime={ambient} />
      {presentation.scene.islands.map(i => <IslandBody key={i.id} island={i} modelRef={modelRef} selected={false} onSelect={select} />)}
      <GlbWreckage overlayRef={overlayRef} base={assetBase} onReady={onGlb} />
      <ScanPulses modelRef={modelRef} />
      <BaymaxActor modelRef={modelRef} ambient={ambient} />
      <ChallengeOverlay3D overlayRef={overlayRef} primaryId={primaryId} />
      <DirectedCamera stateRef={stateRef} beatRef={beatRef} manual={manual} onManual={props.onManual} />
      <LabelProjector labelsRef={labelsRef} layer={props.labelLayer} />
      <FilmDriver film={film} onApi={props.onStepApi} />
      <Composer quality="balanced" gate={gate} />
    </Canvas>
  );
}
