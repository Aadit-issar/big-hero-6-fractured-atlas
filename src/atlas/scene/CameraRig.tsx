import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneModel } from './sceneModel';
import { smooth } from './timing';

export interface CameraRigProps {
  readonly modelRef: { current: SceneModel };
  readonly ambient: { current: number };
  readonly guided: boolean;
  /** World-space point to focus (selected entity); null = frame the whole accumulated map. */
  readonly focus: readonly [number, number, number] | null;
  readonly chapter: number;
  readonly reducedMotion: boolean;
  readonly onManual: () => void;
  readonly follow?: boolean;
  readonly focusExtent?: number | null;
}

const CHAPTER_YAW = [0.1, -0.14, 0.16, 0.28, 0.0] as const;

/** Points the guided camera frames. In the mission each stage has its own subject so the camera is deliberate:
 * Discover frames Baymax with the nearest discoveries, Remember the retained records, Detect and Estimate the fold
 * under analysis, Understand the whole accumulated map. Outside the mission (stage null) everything recorded is framed. */
function stagePoints(model: SceneModel): number[][] {
  const obs = model.observer ? [[...model.observer.position]] : [];
  const near = (p: readonly number[]) => (model.observer ? Math.hypot(p[0]! - model.observer.position[0], p[1]! - model.observer.position[1], p[2]! - model.observer.position[2]) : 0);
  const all = [...obs, ...model.islands.map(i => [...i.position]), ...model.folds.map(f => [...f.entry]), ...model.clusters.map(c => [...c.centre])];
  const stage = model.stage;
  if (model.navigation && (stage === null || stage === 4)) {
    const nav = model.navigation;
    const pts = [...obs, ...nav.points.map(p => [...p.position]), ...(nav.target ? [[...nav.target.position]] : [])];
    if (pts.length > 1) return pts;
  }
  if (stage === 0) return [...obs, ...model.islands.map(i => [...i.position]).sort((a, b) => near(a) - near(b)).slice(0, 2), ...model.folds.map(f => [...f.entry]).slice(0, 1)];
  if (stage === 1) {
    const kept = [...model.islands.filter(i => !i.observed).map(i => [...i.position]), ...model.folds.filter(f => !f.observed).map(f => [...f.entry]), ...model.clusters.filter(c => c.observed === 0).map(c => [...c.centre])];
    return kept.length ? [...obs, ...kept] : all;
  }
  if (stage === 2 || stage === 3) {
    const fold = model.changes[0] ? [[...model.changes[0].from], [...model.changes[0].to]] : model.folds.map(f => [...f.entry]).slice(0, 1);
    const est = model.estimates.flatMap(e => (e.estimate ? [[...e.estimate]] : []));
    const pts = [...obs, ...fold, ...(stage === 3 ? est : [])];
    return pts.length > 1 ? pts : all;
  }
  return all;
}

/** Cinematic camera: frames the accumulated map (never hidden state), pushes toward each newly recorded
 * entity, drifts slowly, and hands over to orbit controls on user input. Damped, never cut. */
export function CameraRig({ modelRef, ambient, guided, focus, chapter, reducedMotion, onManual, follow = false, focusExtent = null }: CameraRigProps) {
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const pos = useRef(new Vector3(-4, 17, 40));
  const look = useRef(new Vector3(4, 3, -6));
  const guidedRef = useRef(guided);
  guidedRef.current = guided;
  const scratch = useRef({ centre: new Vector3(), want: new Vector3(), wantLook: new Vector3(), newest: new Vector3() });

  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08; c.minDistance = 6; c.maxDistance = 140; c.maxPolarAngle = Math.PI * 0.92;
    const start = () => onManual();
    c.addEventListener('start', start);
    controls.current = c;
    return () => { c.removeEventListener('start', start); c.dispose(); controls.current = null; };
  }, [camera, gl, onManual]);

  useEffect(() => {
    // Resuming guided mode continues from wherever the manual camera is.
    if (guided) { pos.current.copy(camera.position); if (controls.current) look.current.copy(controls.current.target); }
  }, [guided, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    if (!guidedRef.current) { c.update(); return; }
    const model = modelRef.current, { centre, want, wantLook, newest } = scratch.current;
    const pts: number[][] = stagePoints(model);
    let dist: number;
    if (pts.length === 0) {
      centre.set(4, 3, -6); dist = 40;
    } else if (pts.length === 1 || follow) {
      // Hero framing: Baymax alone (or followed), close enough that the character reads.
      const p = model.observer?.position ?? pts[0]!;
      centre.set(p[0], p[1] + 0.4, p[2]); dist = follow ? 19 : 17;
    } else {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of pts) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
      centre.set((min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2);
      const radius = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2;
      dist = Math.max(34, (radius + 9) * 1.95 + 10);
      // Push toward the newest recorded entity for a few seconds after it is first recorded.
      const entities = [...model.islands.map(i => ({ t: i.firstSeenAt, p: i.position })), ...model.folds.map(f => ({ t: f.firstSeenAt, p: f.entry }))]
        .filter(e => e.t <= model.time).sort((a, b) => b.t - a.t);
      const latest = entities[0];
      if (latest) {
        const age = model.time - latest.t;
        const e = smooth(age / 1.2) * (1 - smooth((age - 3.4) / 1.6));
        newest.set(latest.p[0], latest.p[1], latest.p[2]);
        centre.lerp(newest, e * 0.55);
        dist += (Math.max(20, dist * 0.62) - dist) * e;
      }
    }
    if (focus) { centre.set(focus[0], focus[1], focus[2]); dist = focusExtent ? Math.max(24, focusExtent * 3) : 17; }
    // An authored shot (mission director) replaces the automatic framing unless the viewer selected something or is following Baymax.
    const shot = !focus && !follow ? model.shot : null;
    if (shot) { centre.set(shot.centre[0], shot.centre[1], shot.centre[2]); dist = shot.dist; }
    const drift = shot ? shot.drift : 1;
    const yaw = (shot ? shot.yaw : follow && !focus ? 0.62 : (CHAPTER_YAW[chapter] ?? 0)) + (reducedMotion ? 0 : Math.sin(ambient.current * 0.07) * 0.07 * drift);
    const pitch = (shot ? shot.pitch : follow && !focus ? 0.13 : 0.36) + (reducedMotion ? 0 : Math.sin(ambient.current * 0.05 + 1.3) * 0.025 * drift);
    want.set(centre.x + Math.sin(yaw) * Math.cos(pitch) * dist, centre.y + Math.sin(pitch) * dist + 1.5, centre.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    wantLook.copy(centre);
    const k = 1 - Math.exp(-delta * (shot ? 1.25 : 1.6));
    pos.current.lerp(want, k);
    look.current.lerp(wantLook, k);
    camera.position.copy(pos.current);
    c.target.copy(look.current);
    camera.lookAt(look.current);
    c.update();
  });
  return null;
}
