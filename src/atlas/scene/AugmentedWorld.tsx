import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { HalfFloatType, NeutralToneMapping, NoToneMapping, Vector2, Vector3, WebGLRenderTarget } from 'three';
import type { PerspectiveCamera } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { SceneModel } from './sceneModel';
import { NebulaSky } from './NebulaSky';
import { IslandBody } from './IslandBody';
import { FoldTear } from './FoldTear';
import { BaymaxActor } from './BaymaxActor';
import { ScanPulses } from './ScanPulses';
import { ObjectField } from './ObjectField';
import { TemporalOverlay } from './TemporalOverlay';
import { NavigationOverlay } from './NavigationOverlay';
import { Motes } from './Motes';
import { CameraRig } from './CameraRig';
import { distanceFromObserver, PULSE_SPEED, REVEAL_SECONDS } from './timing';

export interface LabelAnchor {
  readonly id: string;
  readonly kind: 'island' | 'fold' | 'observer' | 'cluster' | 'object' | 'change' | 'estimate' | 'nav' | 'tag';
  readonly position: readonly [number, number, number];
  /** Replay time after which the label may be shown. */
  readonly appearsAt: number;
  readonly extent?: number;
}

export type RenderQuality = 'balanced' | 'performance';

export interface AugmentedWorldProps {
  readonly model: SceneModel;
  readonly modelRef: { current: SceneModel };
  readonly ambient: { current: number };
  readonly guided: boolean;
  readonly chapter: number;
  readonly selected: string | null;
  readonly reducedMotion: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onManual: () => void;
  readonly labelLayer: { current: HTMLElement | null };
  readonly quality: RenderQuality;
  /** Camera follows the observer instead of framing the whole accumulated map. */
  readonly follow?: boolean;
  /** Maximum render rate (0 = uncapped). Live mode caps ATLAS so the Dimension keeps its share of a shared GPU. */
  readonly maxFps?: number;
  /** A world position the guided camera should frame (navigation target), overriding the selection. */
  readonly focusPoint?: readonly [number, number, number] | null;
}

/** Render levels: 0 full (device pixel ratio up to 1.5, bloom), 1 reduced (pixel ratio 1), 2 minimal (0.75, no bloom, coarse nebula).
 * Presentation quality only: it never changes what ATLAS knows or how it is drawn semantically. */
export const LEVEL_DPR = [1.5, 1, 0.75] as const;
export const LEVEL_SKY = [0.6, 0.45, 0.3] as const;

/** Adaptive quality: steps the render level down when frames run long (for example when the Dimension renders on the same GPU)
 * and steps back up only after a long stretch of headroom, so it does not oscillate. */
function Governor({ level, setLevel, floor, maxFps, gate }: { readonly level: number; readonly setLevel: (level: number) => void; readonly floor: number; readonly maxFps: number; readonly gate: { current: boolean } }) {
  const setDpr = useThree(s => s.setDpr);
  const acc = useRef({ sum: 0, frames: 0, windowStart: 0, fastWindows: 0, slowWindows: 0, lastChange: 0, warm: 0, lastRender: 0 });
  useEffect(() => { setDpr(Math.min(window.devicePixelRatio || 1, LEVEL_DPR[level]!)); (window as unknown as { __ATLAS_LEVEL__?: number }).__ATLAS_LEVEL__ = level; }, [level, setDpr]);
  // Render-rate cap (runs before every other frame callback): frames that would exceed maxFps are skipped entirely, leaving
  // the GPU to other windows (the live Dimension). The previous frame stays on screen (preserveDrawingBuffer).
  useFrame(({ clock }) => {
    const a = acc.current;
    if (maxFps > 0 && clock.elapsedTime - a.lastRender < 1 / maxFps - 0.002) { gate.current = false; return; }
    a.lastRender = clock.elapsedTime; gate.current = true;
  }, -10);
  useFrame(({ clock }, delta) => {
    const a = acc.current;
    if (!gate.current) return;
    a.warm += 1;
    if (a.warm < 240 || document.hidden) return; // ignore start-up compilation and hidden tabs
    a.sum += delta; a.frames += 1;
    const now = clock.elapsedTime;
    if (a.windowStart === 0) a.windowStart = now;
    if (now - a.windowStart < 2) return;
    const mean = a.sum / Math.max(1, a.frames);
    a.sum = 0; a.frames = 0; a.windowStart = now;
    const slow = Math.max(0.027, maxFps > 0 ? 1.3 / maxFps : 0), fast = Math.min(0.019, maxFps > 0 ? 0.7 / maxFps : 1);
    if (mean > slow && level < 2) {
      a.fastWindows = 0; a.slowWindows += 1;
      if (a.slowWindows >= 2) { a.slowWindows = 0; a.lastChange = now; setLevel(level + 1); }
      return;
    }
    a.slowWindows = 0;
    if (mean < fast && level > floor) {
      a.fastWindows += 1;
      if (a.fastWindows >= 8 && now - a.lastChange > 30) { a.fastWindows = 0; a.lastChange = now; setLevel(level - 1); }
    } else a.fastWindows = 0;
  });
  return null;
}

export function Composer({ quality, gate }: { readonly quality: RenderQuality; readonly gate: { current: boolean } }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useRef<EffectComposer | null>(null);
  const bloom = useRef<UnrealBloomPass | null>(null);
  useEffect(() => {
    gl.toneMapping = NeutralToneMapping;
    gl.toneMappingExposure = 1.0;
    const pr = gl.getPixelRatio();
    const target = new WebGLRenderTarget(size.width * pr, size.height * pr, { type: HalfFloatType });
    const c = new EffectComposer(gl, target);
    c.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new Vector2(size.width * pr, size.height * pr), 0.5, 0.65, 0.88);
    c.addPass(bloomPass);
    c.addPass(new OutputPass());
    composer.current = c; bloom.current = bloomPass;
    // Read-only render statistics for lifecycle and performance checks (no mutation API).
    (window as unknown as { __ATLAS_RENDER__?: unknown }).__ATLAS_RENDER__ = () => ({ geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0, calls: gl.info.render.calls, triangles: gl.info.render.triangles, dpr: gl.getPixelRatio(), bloom: bloomPass.enabled });
    return () => {
      delete (window as unknown as { __ATLAS_RENDER__?: unknown }).__ATLAS_RENDER__;
      c.passes.forEach(p => p.dispose?.()); c.dispose(); target.dispose(); composer.current = null; bloom.current = null; gl.toneMapping = NoToneMapping;
    };
    // The composer is built once per renderer, scene and camera; size and quality are applied separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);
  useEffect(() => { if (bloom.current) bloom.current.enabled = quality !== 'performance'; }, [quality]);
  useEffect(() => { composer.current?.setSize(size.width, size.height); }, [size]);
  useFrame(() => { if (gate.current) composer.current?.render(); }, 1);
  return null;
}

/** Projects world anchors to the DOM label layer each frame without React state, then keeps the labels on screen,
 * clear of the top and bottom bars and out of each other's way (greedy, priority-ordered). */
function LabelProjector({ anchors, layer, modelRef }: { readonly anchors: readonly LabelAnchor[]; readonly layer: { current: HTMLElement | null }; readonly modelRef: { current: SceneModel } }) {
  const { camera, size } = useThree();
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const scratch = useRef(new Vector3());
  const PRIORITY: Record<LabelAnchor['kind'], number> = { tag: 0, observer: 0, fold: 1, estimate: 1, change: 1, nav: 1, island: 2, cluster: 3, object: 3 };
  useFrame(() => {
    const root = layer.current;
    if (!root) return;
    const cam = camera as PerspectiveCamera;
    const v = scratch.current;
    const items: { el: HTMLElement; x: number; y: number; w: number; h: number; dy: number; p: number }[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-anchor]'))) {
      const a = anchorsRef.current.find(x => x.id === el.dataset.anchor);
      if (!a) continue;
      v.set(a.position[0], a.position[1] + (a.kind === 'island' ? 5 : a.kind === 'fold' ? 9 : a.kind === 'cluster' ? Math.max(4, (a.extent ?? 6) * 0.6) : a.kind === 'object' ? 3 : a.kind === 'change' ? 5 : a.kind === 'estimate' ? 6 : a.kind === 'nav' ? 4 : a.kind === 'tag' ? 5 : -3.6), a.position[2]).project(cam);
      el.dataset.behind = v.z > 1 ? '1' : '0';
      el.dataset.show = modelRef.current.time >= a.appearsAt ? '1' : '0';
      const w = Number(el.dataset.w) || el.offsetWidth, h = Number(el.dataset.h) || el.offsetHeight;
      if (w && !el.dataset.w) { el.dataset.w = String(w); el.dataset.h = String(h); }
      const dy = a.kind === 'observer' ? 6 : a.kind === 'tag' ? -34 : -46;
      items.push({ el, x: (v.x * 0.5 + 0.5) * size.width, y: (1 - (v.y * 0.5 + 0.5)) * size.height, w: w || 170, h: h || 42, dy, p: PRIORITY[a.kind] });
    }
    items.sort((a, b) => a.p - b.p || a.y - b.y);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    // Reserved UI zones act as obstacles: the right-hand rail and the bottom-left caption.
    const rail = root.parentElement?.querySelector('.aug-rail')?.getBoundingClientRect();
    if (rail && rail.width > 0) placed.push({ x: rail.left - 8, y: rail.top - 8, w: rail.width + 16, h: Math.min(rail.height, size.height) + 16 });
    const caption = root.parentElement?.querySelector('.aug-stage')?.getBoundingClientRect();
    if (caption && caption.width > 0) placed.push({ x: caption.left - 8, y: caption.top - 8, w: caption.width + 16, h: caption.height + 16 });
    // Mission panels (headline, cards, evidence strip) declare themselves with data-reserve: world labels never sit on them.
    root.parentElement?.querySelectorAll<HTMLElement>('[data-reserve]').forEach(panel => {
      const r = panel.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) placed.push({ x: r.left - 8, y: r.top - 8, w: r.width + 16, h: r.height + 16 });
    });
    let shownCount = 0;
    for (const it of items) {
      let x = Math.min(Math.max(it.x - 4, 12), size.width - it.w - 12);
      let y = Math.min(Math.max(it.y + it.dy, 92), size.height - 100 - it.h);
      if (it.el.dataset.show === '1' && it.el.dataset.behind === '0') {
        for (let i = 0; i < 8; i += 1) {
          const hit = placed.find(r => x < r.x + r.w + 6 && x + it.w + 6 > r.x && y < r.y + r.h + 4 && y + it.h + 4 > r.y);
          if (!hit) break;
          y = hit.y + hit.h + 6;
          if (y > size.height - 100 - it.h) { y = Math.max(92, hit.y - it.h - 6); x = Math.min(x + 40, size.width - it.w - 12); }
        }
        const stillHit = shownCount >= 16 || placed.some(r => x < r.x + r.w + 6 && x + it.w + 6 > r.x && y < r.y + r.h + 4 && y + it.h + 4 > r.y);
        // A label that cannot be placed without overlapping something is hidden rather than drawn over it.
        it.el.dataset.hide = stillHit ? '1' : '0';
        if (!stillHit) { placed.push({ x, y, w: it.w, h: it.h }); shownCount += 1; }
      }
      // The CSS margin is already part of the anchor offset, so translate to the final top-left directly.
      it.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  });
  return null;
}

export function AugmentedWorld(props: AugmentedWorldProps) {
  const floor = props.quality === 'performance' ? 1 : 0;
  const [level, setLevel] = useState(floor);
  const gate = useRef(true);
  const maxFps = props.maxFps ?? 0;
  const { model, modelRef, ambient, guided, chapter, selected, reducedMotion, onSelect, onManual, labelLayer, quality, follow = false } = props;
  const anchors = useMemo<LabelAnchor[]>(() => [
    ...(model.observer ? [{ id: 'baymax-observer', kind: 'observer' as const, position: model.observer.position, appearsAt: model.observer.firstSeenAt + 0.8 }] : []),
    ...model.islands.map(i => ({ id: i.id, kind: 'island' as const, position: i.position, appearsAt: i.firstSeenAt + distanceFromObserver(model, i.position) / PULSE_SPEED + REVEAL_SECONDS * 0.7 })),
    ...model.folds.map(f => ({ id: f.id, kind: 'fold' as const, position: f.entry, appearsAt: f.firstSeenAt + distanceFromObserver(model, f.entry) / PULSE_SPEED + REVEAL_SECONDS * 0.7 })),
    ...model.changes.map(c => ({ id: `change-${c.id}`, kind: 'change' as const, position: [(c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2, (c.from[2] + c.to[2]) / 2] as const, appearsAt: 0 })),
    ...model.changes.flatMap(c => [
      { id: `cmp-before-${c.id}`, kind: 'tag' as const, position: c.from, appearsAt: 0 },
      { id: `cmp-after-${c.id}`, kind: 'tag' as const, position: c.to, appearsAt: 0 },
    ]),
    ...model.estimates.filter(e => e.evaluation?.observed).map(e => ({ id: `estimate-observed-${e.id}`, kind: 'tag' as const, position: e.evaluation!.observed!, appearsAt: 0 })),
    ...model.estimates.map(e => ({ id: `estimate-${e.id}`, kind: 'estimate' as const, position: (e.estimate ?? e.from) as readonly [number, number, number], appearsAt: 0 })),
    ...(model.navigation?.target ? [{ id: 'nav-target', kind: 'nav' as const, position: model.navigation.target.position, appearsAt: 0 }] : []),
    ...(model.navigation && model.navigation.points.length ? [{ id: 'nav-goal', kind: 'nav' as const, position: model.navigation.points.at(-1)!.position, appearsAt: 0 }] : []),
    ...model.clusters.map(c => ({ id: c.id, kind: 'cluster' as const, position: c.centre, extent: c.extent, appearsAt: 0 })),
    ...model.objects.filter(o => o.family === 'capsule').map(o => ({ id: o.id, kind: 'object' as const, position: o.position, appearsAt: o.firstSeenAt + distanceFromObserver(model, o.position) / PULSE_SPEED + 0.8 })),
  ], [model]);
  const focus = useMemo(() => {
    if (props.focusPoint) return props.focusPoint;
    if (!selected) return null;
    if (selected === 'baymax-observer') return model.observer ? model.observer.position : null;
    const i = model.islands.find(x => x.id === selected);
    if (i) return i.position;
    const f = model.folds.find(x => x.id === selected);
    if (f) return f.entry;
    const o = model.objects.find(x => x.id === selected);
    if (o) return o.position;
    const c = model.clusters.find(x => x.id === selected);
    return c ? c.centre : null;
  }, [selected, model, props.focusPoint]);
  const handleSelect = useCallback((id: string) => onSelect(id), [onSelect]);
  useEffect(() => { (window as unknown as { __atlasAnchors?: unknown }).__atlasAnchors = anchors; }, [anchors]);
  return (
    <Canvas className="aug-canvas" dpr={[0.75, quality === 'performance' ? 1 : 1.5]} camera={{ fov: 50, near: 0.5, far: 2000, position: [-4, 17, 40] }}
      gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }} onPointerMissed={() => onSelect(null)}>
      <NebulaSky sceneTime={ambient} scale={LEVEL_SKY[level]!} gate={gate} />
      <Motes sceneTime={ambient} />
      {model.islands.map(i => <IslandBody key={i.id} island={i} modelRef={modelRef} selected={selected === i.id} onSelect={handleSelect} />)}
      {model.folds.map(f => <FoldTear key={f.id} fold={f} modelRef={modelRef} selected={selected === f.id} onSelect={handleSelect} />)}
      <ObjectField objects={model.objects} clusters={model.clusters} modelRef={modelRef} selected={selected} onSelect={handleSelect} />
      <ScanPulses modelRef={modelRef} />
      <TemporalOverlay modelRef={modelRef} />
      <NavigationOverlay modelRef={modelRef} />
      <BaymaxActor modelRef={modelRef} ambient={ambient} onSelect={handleSelect} />
      <CameraRig modelRef={modelRef} ambient={ambient} guided={guided} focus={focus} chapter={chapter} reducedMotion={reducedMotion} onManual={onManual} follow={follow} focusExtent={model.clusters.find(c => c.id === selected)?.extent ?? null} />
      <LabelProjector anchors={anchors} layer={labelLayer} modelRef={modelRef} />
      <Governor level={level} setLevel={setLevel} floor={floor} maxFps={maxFps} gate={gate} />
      <Composer quality={level >= 2 ? 'performance' : quality} gate={gate} />
    </Canvas>
  );
}
