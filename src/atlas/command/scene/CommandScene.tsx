import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Color, NeutralToneMapping, SRGBColorSpace, Vector3 } from 'three';
import type { Material, PerspectiveCamera } from 'three';
import { createAtmosphereUniforms, createRockMaterial } from '../../../scene/terrain/rockMaterial';
import { CameraRig } from '../camera/CameraRig';
import type { CameraController } from '../camera/cameraController';
import type { CommandSnapshot } from '../session';
import { Backdrop, QUALITY } from './backdrop';
import { BaymaxAvatar, BaymaxGhost } from './baymaxActors';
import type { GhostBaymaxState } from './baymaxActors';
import { EntityLayer } from './entities';
import { hologramMaterial } from './models';
import { MarkPool } from './marks';
import { OverlayLayer } from './overlays';
import { loadAtlasRockTextures } from './rockTextures';
import type { ScenePresentation } from './sceneApi';
import type { SceneProps } from './types';

export type { DisplayAnchors, SceneProps } from './types';

/** The tactical 3D scene: ATLAS looking into the same universe as the Dimension. It draws what ATLAS knows in unmistakable treatments:
 *   CURRENT     solid, the same GLB the Dimension draws, lit by the same baked nebula and key light;
 *   REMEMBERED  a cool translucent hologram at the last-known position;
 *   PREDICTED   lavender holograms of the SAME model at forecast times, a luminous path with time ticks, and the estimator's stated uncertainty;
 *   ROUTE       the planner's route, Baymax at his arrival time and the planned rendezvous.
 * Per-frame work reads refs; React re-renders only when props change. */

function World({ props, presentationRef, controllerRef }: { props: SceneProps; presentationRef: MutableRefObject<ScenePresentation>; controllerRef: MutableRefObject<CameraController | null> }) {
  const { gl, camera } = useThree();
  const pres = presentationRef.current;
  const q = QUALITY[pres.quality];
  const textures = useMemo(() => loadAtlasRockTextures(gl, q.anisotropy), [gl, q.anisotropy]);
  const atmosphere = useMemo(() => createAtmosphereUniforms(), []);
  const rocks = useMemo(() => {
    const solid = createRockMaterial({ textures, atmosphere, rim: 0.8 });
    const dim = createRockMaterial({ textures, atmosphere, rim: 0.2, mineral: false });
    dim.transparent = true; dim.opacity = 0.2; dim.depthWrite = false;
    const ghost: Material = hologramMaterial(new Color('#7f8cff'), 0.5);
    return { solid, dim, ghost };
  }, [textures, atmosphere]);
  const layer = useMemo(() => new EntityLayer(props.base, rocks), [props.base, rocks]);
  const overlay = useMemo(() => new OverlayLayer(props.base), [props.base]);
  const marks = useMemo(() => new MarkPool(), []);
  const ghostBaymax = useRef<GhostBaymaxState>({ visible: false, x: 0, y: 0, z: 0, yaw: 0 });
  const hold = useRef<{ key: string; set: Set<string> | null }>({ key: '', set: null });
  const centre = useRef(new Vector3());
  const clock = useRef(0);

  useEffect(() => { props.anchorsRef.current.marks = marks; props.anchorsRef.current.extents ??= new Map(); }, [marks, props.anchorsRef]);
  useEffect(() => () => { layer.dispose(); }, [layer]);
  useEffect(() => () => { overlay.dispose(); }, [overlay]);
  useEffect(() => () => { rocks.solid.dispose(); rocks.dim.dispose(); rocks.ghost.dispose(); }, [rocks]);
  useEffect(() => () => { textures.dispose(); }, [textures]);
  useEffect(() => { gl.setPixelRatio(q.dpr > 1 ? Math.min(window.devicePixelRatio, q.dpr) : 1); }, [gl, q.dpr]);

  useFrame((state, delta) => {
    const a = props.anchorsRef.current, snap: CommandSnapshot = props.snapshotRef.current;
    const p = presentationRef.current;
    clock.current += Math.min(delta, 0.1);
    a.extents ??= new Map();
    centre.current.copy(a.baymax);
    // Focus mode: with something selected in Predict/Route, unrelated objects recede; the selection and the obstacles on its route stay.
    let focus: Set<string> | null = null;
    if (p.view !== 'tactical' && snap.selectedId) {
      const key = `${snap.version}|${snap.selectedId}`;
      if (hold.current.key !== key) {
        const s = new Set<string>([snap.selectedId]);
        for (const id of snap.plan?.obstacles ?? []) s.add(id);
        hold.current = { key, set: s };
      }
      focus = hold.current.set;
    }
    layer.update(snap, { entities: a.entities, extents: a.extents }, { dt: delta, viewDistance: a.scale, camera: camera.position, selectedId: snap.selectedId, focus, time: clock.current });
    overlay.update(snap, { entities: a.entities, extents: a.extents, baymax: a.baymax, scale: a.scale, meeting: a.meeting, ghost: a.ghost }, marks, {
      camera: camera as PerspectiveCamera, dt: delta, time: clock.current, wall: props.session.wall(), view: p.view, width: state.size.width, height: state.size.height,
      hoverId: a.hoverId ?? null, baymaxYaw: a.baymaxYaw ?? 0, ghostBaymax: ghostBaymax.current,
    });
    a.meeting = a.meeting ?? null; a.ghost = a.ghost ?? null;
  });

  return (
    <>
      <BaymaxAvatar snapshotRef={props.snapshotRef} anchorsRef={props.anchorsRef} base={props.base} />
      <BaymaxGhost stateRef={ghostBaymax} anchorsRef={props.anchorsRef} base={props.base} />
      <CameraRig snapshotRef={props.snapshotRef} anchorsRef={props.anchorsRef} cameraRef={props.cameraRef} presentationRef={presentationRef} {...(props.apiRef ? { apiRef: props.apiRef } : {})} onSelect={props.onSelect} onManual={props.onManual}
        legacy={{ active: !props.presentation, follow: props.follow, focusNonce: props.focusNonce, focusId: props.focusId }} controllerRef={controllerRef} />
      <primitive object={layer.root} />
      <primitive object={overlay.root} />
      <Backdrop quality={pres.quality} atmosphere={atmosphere} showGrid={pres.showGrid} centerRef={centre} />
    </>
  );
}

/** Drives the demand-mode canvas at a fixed rate and pauses while the page is hidden. */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) invalidate(); }, 1000 / Math.max(2, fps));
    return () => window.clearInterval(id);
  }, [fps, invalidate]);
  return null;
}

export function CommandScene(props: SceneProps) {
  const presentation: ScenePresentation = props.presentation ?? { view: props.view, showAllLabels: false, showGrid: false, quality: 'balanced' };
  const presentationRef = useRef(presentation); presentationRef.current = presentation;
  const controllerRef = useRef<CameraController | null>(null);
  useEffect(() => { props.anchorsRef.current.presentation = presentation; });
  return (
    <Canvas
      className="cmd-canvas"
      camera={{ position: [60, 60, 80], fov: 50, near: 0.5, far: 4000 }}
      dpr={1}
      frameloop="demand"
      gl={{ antialias: false, powerPreference: 'default', alpha: false }}
      onCreated={({ gl }) => { gl.toneMapping = NeutralToneMapping; gl.toneMappingExposure = 1.0; gl.outputColorSpace = SRGBColorSpace; }}
    >
      <FrameLimiter fps={props.fps} />
      <World props={props} presentationRef={presentationRef} controllerRef={controllerRef} />
    </Canvas>
  );
}
