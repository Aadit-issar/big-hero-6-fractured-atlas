import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { CommandSnapshot } from '../session';
import type { CameraMode, SceneApi, SceneApiRef, ScenePresentation } from '../scene/sceneApi';
import type { DisplayAnchors } from '../scene/types';
import { CameraController } from './cameraController';
import type { Framing } from './cameraController';
import { orbitPosition, pushOut, resolveAutoMode } from './cameraMath';
import type { Sphere, V3, Weighted } from './cameraMath';
import { framingFor } from './framing';
import type { FramingEntity, FramingWorld } from './framing';
import { readInsets } from './insets';

/** Applies the camera controller to the R3F camera, turns pointer input into orbit/pan/zoom/pick, resolves the automatic mode from the view and the
 * selection, and exposes the controller through SceneApi. Camera state lives in `CameraController`; this file only wires it to the world. */
export interface RigProps {
  readonly snapshotRef: MutableRefObject<CommandSnapshot>;
  readonly anchorsRef: MutableRefObject<DisplayAnchors>;
  readonly cameraRef: MutableRefObject<PerspectiveCamera | null>;
  readonly presentationRef: MutableRefObject<ScenePresentation>;
  readonly apiRef?: SceneApiRef;
  readonly onSelect: (id: string | null) => void;
  readonly onManual: () => void;
  /** Legacy imperative props (only honoured when the UI does not drive the scene through `presentation`/`apiRef`). */
  readonly legacy: { readonly active: boolean; readonly follow: boolean; readonly focusNonce: number; readonly focusId: string | null };
  readonly controllerRef: MutableRefObject<CameraController | null>;
}

const ACTIVE_FOLD = new Set(['open', 'unstable', 'forming', 'closing']);
const MANUAL_HOLD = 6; // seconds after manual input during which view/selection changes do not retarget the camera

export function CameraRig(props: RigProps) {
  const { camera, gl } = useThree();
  const cam = camera as PerspectiveCamera;
  const ctrl = useMemo(() => new CameraController({ tx: 0, ty: 10, tz: 0 }), []);
  const sess = useRef({
    focusId: null as string | null, lastViewSel: '', lastAuto: 'overview' as CameraMode, framing: null as Framing | null, framingAt: -1, framingMode: '' as string, init: false,
    spheres: [] as Sphere[], legacyFollow: props.legacy.follow, legacyNonce: props.legacy.focusNonce, view: { w: 0, h: 0, x: 0, y: 0 }, snapId: '' as string,
  });
  const propsRef = useRef(props); propsRef.current = props;

  // ---- imperative API ----
  useEffect(() => {
    const now = () => performance.now() / 1000;
    const s = sess.current;
    const set = (mode: CameraMode, focus?: string | null) => {
      if (focus !== undefined) s.focusId = focus;
      ctrl.setMode(mode, now()); s.framingAt = -1;
    };
    const api: SceneApi = {
      overview: () => set('overview'),
      setFollow: on => { if (on) set('follow'); else if (ctrl.mode === 'follow' || ctrl.mode === 'manual') autoApply(true); },
      focus: id => set('focus', id ?? propsRef.current.snapshotRef.current.selectedId),
      fitPrediction: () => set('prediction', propsRef.current.snapshotRef.current.selectedId),
      fitRoute: () => set('route'),
      fitInterception: () => set('interception'),
      mode: () => ctrl.mode,
      onMode: l => ctrl.onMode(l),
      manual: () => { if (ctrl.mode !== 'manual') ctrl.userPan(0, 0, 0, now()); },
      auto: () => autoApply(true),
      telemetry: () => { const t = ctrl.telemetry(); return { mode: t.mode, target: t.target, position: t.position, distance: t.distance, yaw: t.yaw, pitch: t.pitch, followError: t.followError, secondsSinceUserInput: ctrl.sinceUser(now()) }; },
    };
    const autoApply = (force: boolean) => {
      const snap = propsRef.current.snapshotRef.current, pres = propsRef.current.presentationRef.current;
      const auto = resolveAutoMode(pres.view, snap.selectedId, { forecast: !!snap.forecast, encounter: !!snap.encounter });
      s.lastAuto = auto; s.focusId = snap.selectedId;
      if (force || ctrl.mode !== auto) { ctrl.setMode(auto, now()); s.framingAt = -1; }
    };
    propsRef.current.controllerRef.current = ctrl;
    if (propsRef.current.apiRef) propsRef.current.apiRef.current = api;
    (window as unknown as { __ATLAS_SCENE__?: unknown }).__ATLAS_SCENE__ = { api, telemetry: api.telemetry };
    (s as unknown as { autoApply: typeof autoApply }).autoApply = autoApply;
    const off = ctrl.onMode(m => { if (m === 'manual') propsRef.current.onManual(); });
    return () => {
      off();
      if (propsRef.current.apiRef?.current === api) propsRef.current.apiRef.current = null;
      propsRef.current.controllerRef.current = null;
      delete (window as unknown as { __ATLAS_SCENE__?: unknown }).__ATLAS_SCENE__;
    };
  }, [ctrl]);

  // ---- pointer input ----
  useEffect(() => {
    props.cameraRef.current = cam;
    const el = gl.domElement;
    let drag: null | { x: number; y: number; id: number; pan: boolean; moved: number } = null;
    const v = new Vector3();
    const now = () => performance.now() / 1000;
    const pick = (clientX: number, clientY: number, generous: number): string | null => {
      const a = propsRef.current.anchorsRef.current, rect = el.getBoundingClientRect();
      let best: string | null = null, bestScore = generous;
      for (const [id, p] of a.entities) {
        v.copy(p).project(cam);
        if (v.z > 1 || v.z < -1) continue;
        const d = Math.hypot(rect.left + (v.x * 0.5 + 0.5) * rect.width - clientX, rect.top + (-v.y * 0.5 + 0.5) * rect.height - clientY);
        // The visible size of the object (projected) widens its pick area; nearer, bigger things win ties.
        const pxPerM = rect.height / (2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(1, cam.position.distanceTo(p)));
        const score = d - Math.min(40, (a.extents?.get(id) ?? 1) * pxPerM * 0.6);
        if (score < bestScore) { bestScore = score; best = id; }
      }
      return best;
    };
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId, pan: e.button === 2 || e.shiftKey, moved: 0 }; el.setPointerCapture(e.pointerId); };
    let hoverRaf = 0, hx = 0, hy = 0;
    const move = (e: PointerEvent) => {
      if (!drag) { hx = e.clientX; hy = e.clientY; if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; const id = pick(hx, hy, 30); const a = propsRef.current.anchorsRef.current; if (a.hoverId !== id) { a.hoverId = id; el.style.cursor = id ? 'pointer' : ''; } }); return; }
      if (drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved <= 4) return;
      if (drag.pan) {
        const k = ctrl.orbit.dist * 0.0016;
        const right = new Vector3().setFromMatrixColumn(cam.matrix, 0), up = new Vector3().setFromMatrixColumn(cam.matrix, 1);
        ctrl.userPan((-dx * right.x + dy * up.x) * k, (-dx * right.y + dy * up.y) * k, (-dx * right.z + dy * up.z) * k, now());
      } else ctrl.userRotate(dx * 0.005, dy * 0.005, now());
    };
    const up = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const click = drag.moved <= 4 && !drag.pan;
      drag = null; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (click) propsRef.current.onSelect(pick(e.clientX, e.clientY, 38));
    };
    const leave = () => { const a = propsRef.current.anchorsRef.current; a.hoverId = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); ctrl.userZoom(Math.exp(e.deltaY * 0.0012), now()); };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('contextmenu', ctx);
    return () => {
      cancelAnimationFrame(hoverRaf);
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel); el.removeEventListener('contextmenu', ctx);
      props.cameraRef.current = null;
    };
  }, [cam, gl, ctrl, props.cameraRef]);

  useFrame((_, delta) => {
    const p = propsRef.current, s = sess.current, a = p.anchorsRef.current, snap = p.snapshotRef.current;
    const dt = Math.min(delta, 0.1), now = performance.now() / 1000;
    const pres = p.presentationRef.current;
    const autoApply = (s as unknown as { autoApply?: (f: boolean) => void }).autoApply;

    // First frame: start framed on the mapped region around Baymax.
    if (!s.init && snap.pose) { s.init = true; ctrl.snapTo([snap.pose.position[0], snap.pose.position[1], snap.pose.position[2]], 120); if (p.legacy.active && p.legacy.follow) ctrl.setMode('follow', now); else autoApply?.(true); }

    // Legacy imperative props (old UI): the Follow toggle is sticky while it is on; everything else follows the automatic rules below.
    if (p.legacy.active && p.legacy.follow !== s.legacyFollow) { s.legacyFollow = p.legacy.follow; if (p.legacy.follow) ctrl.setMode('follow', now); else if (ctrl.mode === 'follow') autoApply?.(true); }
    const stickyFollow = p.legacy.active && p.legacy.follow && ctrl.mode === 'follow';
    if (!stickyFollow) {
      // Automatic mode: the view and the selection decide, unless the user is driving by hand.
      const viewSel = `${pres.view}|${snap.selectedId}`;
      const auto = resolveAutoMode(pres.view, snap.selectedId, { forecast: !!snap.forecast, encounter: !!snap.encounter });
      const holding = ctrl.mode === 'manual' && ctrl.sinceUser(now) < MANUAL_HOLD;
      if (viewSel !== s.lastViewSel) {
        s.lastViewSel = viewSel;
        if (!holding && s.init) { s.lastAuto = auto; s.focusId = snap.selectedId; ctrl.setMode(auto, now); s.framingAt = -1; }
      } else if (auto !== s.lastAuto) {
        // The data for a better framing arrived (e.g. the plan became ready) or went away: follow it only if the camera is still on the previous automatic mode.
        const was = s.lastAuto; s.lastAuto = auto;
        if (ctrl.mode === was) { ctrl.setMode(auto, now); s.focusId = snap.selectedId; s.framingAt = -1; }
      }
    }
    a.mode = ctrl.mode; a.presentation = pres;

    // Framing is recomputed at 10 Hz (the snapshot itself changes at 4 Hz).
    const mode = ctrl.mode;
    if (mode !== 'follow' && mode !== 'manual' && (now - s.framingAt > 0.1 || s.framingMode !== mode)) {
      s.framingAt = now; s.framingMode = mode;
      const world = worldFor(snap, a);
      s.framing = framingFor(mode, world, s.focusId);
      s.spheres = world.entities.filter(e => e.kind === 'island').map(e => ({ c: e.position, r: e.radius * 0.8 }));
    }

    // Free area between the panels.
    const size = gl.domElement.getBoundingClientRect();
    const W = Math.max(1, size.width), H = Math.max(1, size.height);
    const ins = readInsets(W, H);
    const freeW = Math.max(200, W - ins.left - ins.right), freeH = Math.max(200, H - ins.top - ins.bottom);
    const vfov = (cam.fov * Math.PI) / 180;
    ctrl.update(dt, now, { baymax: [a.baymax.x, a.baymax.y, a.baymax.z], framing: s.framing, vfov, aspect: freeW / freeH });

    const o = ctrl.orbit;
    const pos: [number, number, number] = [...orbitPosition(o)];
    if (mode !== 'manual') pushOut(pos, s.spheres, 2);
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(o.tx, o.ty, o.tz);
    // Centre the scene in the free area by shifting the principal point (labels project through the same matrix).
    const dx = (ins.left - ins.right) / 2, dy = (ins.top - ins.bottom) / 2;
    const vw = s.view;
    if (Math.abs(vw.w - W) > 0.5 || Math.abs(vw.h - H) > 0.5 || Math.abs(vw.x - -dx) > 1 || Math.abs(vw.y - -dy) > 1) {
      vw.w = W; vw.h = H; vw.x = -dx; vw.y = -dy; cam.setViewOffset(W, H, -dx, -dy, W, H);
    }
    a.scale = o.dist;
  });
  return null;
}

// ---------- snapshot -> framing world (10 Hz, not per frame) ----------
function worldFor(snap: CommandSnapshot, a: DisplayAnchors): FramingWorld {
  const entities: FramingEntity[] = [];
  for (const e of snap.entities) {
    if (e.kind === 'swarm') continue;
    const pos = a.entities.get(e.id);
    entities.push({ id: e.id, kind: e.kind, position: pos ? [pos.x, pos.y, pos.z] : e.position, radius: e.radius, moving: snap.estimates.get(e.id)?.motion === 'moving', foldActive: e.foldState ? ACTIVE_FOLD.has(e.foldState) : false });
  }
  const bay: V3 = [a.baymax.x, a.baymax.y, a.baymax.z];
  const forecastPoints: Weighted[] = [], routePoints: Weighted[] = [], rendezvousPoints: Weighted[] = [];
  const fc = snap.forecast, enc = snap.encounter;
  let axisFrom: V3 | null = null, axisTo: V3 | null = null;
  if (fc) {
    for (let i = 0; i < fc.trail.length; i += Math.max(1, Math.floor(fc.trail.length / 12))) forecastPoints.push({ p: fc.trail[i]!.position, r: 0.8 });
    forecastPoints.push({ p: fc.current.position, r: 2 });
    for (let i = 0; i < fc.future.length; i += 4) forecastPoints.push({ p: fc.future[i]!.position, r: Math.min(3, 0.5 * fc.future[i]!.uncertainty) });
    const last = fc.future[fc.future.length - 1]; if (last) forecastPoints.push({ p: last.position, r: Math.min(3, 0.5 * last.uncertainty) });
    axisFrom = fc.current.position; axisTo = last?.position ?? null;
  }
  if (enc) {
    routePoints.push({ p: enc.targetNow.position, r: 3 }, { p: enc.targetAtArrival.position, r: 3 }, { p: enc.baymaxAtArrival, r: 3 });
    for (const r of enc.route) routePoints.push({ p: r.position, r: 1.5 });
    for (const t of enc.ghostTimes) routePoints.push({ p: enc.targetAt(t).position, r: 2.5 });
    rendezvousPoints.push({ p: enc.baymaxAtArrival, r: 4 }, { p: enc.targetAtArrival.position, r: 4 }, { p: enc.targetAtAim.position, r: 3 }, { p: bay, r: 3 });
    for (const t of enc.ghostTimes) rendezvousPoints.push({ p: enc.targetAt(t).position, r: 2.5 });
    if (!fc) { axisFrom = bay; axisTo = enc.baymaxAtArrival; }
  }
  if (snap.plan && !enc) for (const w of snap.plan.waypoints) routePoints.push({ p: w.position, r: 2 });
  return { baymax: bay, entities, selectedId: snap.selectedId, forecastPoints, routePoints, rendezvousPoints, axisFrom: enc ? bay : axisFrom, axisTo: enc ? enc.baymaxAtArrival : axisTo };
}
