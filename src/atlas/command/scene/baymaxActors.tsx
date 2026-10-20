import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, Group, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import * as BaymaxApi from '../../../baymax';
import { BaymaxHero, buildBaymax } from '../../../baymax';
import type { BaymaxHeroState } from '../../../baymax';
import type { CommandSnapshot } from '../session';
import { boost } from './entities';
import { hologramMaterial } from './models';
import type { DisplayAnchors } from './types';

/** Baymax now (the real hero component, smoothed between 4 Hz frames) and Baymax at his planned arrival (a translucent hologram of the same model). */
const UP = new Vector3(0, 1, 0);

export function BaymaxAvatar({ snapshotRef, anchorsRef, base }: { readonly snapshotRef: MutableRefObject<CommandSnapshot>; readonly anchorsRef: MutableRefObject<DisplayAnchors>; readonly base: string }) {
  // After the shared module's GLB hero lands it reads `heroBaseUrl`; the procedural one ignores it.
  const heroProps = useMemo(() => ({ heroBaseUrl: `${base}models/` }) as object, [base]);
  const grp = useRef<Group>(null);
  const state = useRef<BaymaxHeroState>({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], acceleration: [0, 0, 0], yawRate: 0, boost: false });
  const sm = useRef({ pos: new Vector3(), vel: new Vector3(), prevVel: new Vector3(), acc: new Vector3(), yaw: 0, init: false, q: new Quaternion() });
  useFrame((_, delta) => {
    const snap = snapshotRef.current, pose = snap.pose, a = anchorsRef.current;
    if (!pose) { if (grp.current) grp.current.visible = false; a.baymaxVisible = false; return; }
    const s = sm.current, dt = Math.max(1e-3, Math.min(delta, 0.1));
    // Dead-reckon between 4 Hz frames with the measured vehicle velocity, then smooth: the camera follows this very point.
    const age = Math.min(0.4, (performance.now() - snap.poseAtWall) / 1000);
    const tx = pose.position[0] + pose.velocity[0] * age, ty = pose.position[1] + pose.velocity[1] * age, tz = pose.position[2] + pose.velocity[2] * age;
    if (!s.init) { s.pos.set(tx, ty, tz); s.init = true; }
    const k = 1 - Math.exp(-dt * 14);
    s.pos.x += (tx - s.pos.x) * k; s.pos.y += (ty - s.pos.y) * k; s.pos.z += (tz - s.pos.z) * k;
    s.prevVel.copy(s.vel); s.vel.set(pose.velocity[0], pose.velocity[1], pose.velocity[2]);
    s.acc.copy(s.vel).sub(s.prevVel).multiplyScalar(1 / dt).clampLength(0, 30);
    const fwd = pose.forward;
    const yaw = Math.atan2(-fwd[0], -fwd[2]);
    let dyaw = yaw - s.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    s.yaw += dyaw * (1 - Math.exp(-dt * 10));
    s.q.setFromAxisAngle(UP, s.yaw);
    const hs = state.current as unknown as { quaternion: [number, number, number, number]; velocity: [number, number, number]; acceleration: [number, number, number]; yawRate: number; boost: boolean };
    hs.quaternion = [s.q.x, s.q.y, s.q.z, s.q.w];
    hs.velocity = [s.vel.x, s.vel.y, s.vel.z]; hs.acceleration = [s.acc.x, s.acc.y, s.acc.z]; hs.yawRate = dyaw / dt; hs.boost = s.vel.length() > 20;
    a.baymax.copy(s.pos); a.baymaxYaw = s.yaw; a.baymaxVisible = true;
    const scale = boost(a.scale, 18, 4.2);
    a.baymaxExtent = 1.1 * scale;
    if (grp.current) { grp.current.visible = true; grp.current.scale.setScalar(scale); grp.current.position.copy(s.pos); }
  });
  return <group ref={grp} visible={false}><BaymaxHero state={state} lod="low" showFx {...heroProps} /></group>;
}

/** What the overlay layer wants the Baymax hologram to do this frame. */
export interface GhostBaymaxState { visible: boolean; x: number; y: number; z: number; yaw: number }

interface GhostBuilt { readonly root: Object3D; dispose(): void }
type GhostFactory = (lod: 'low', base: string) => Promise<GhostBuilt & { setOpacity?(o: number): void }> | (GhostBuilt & { setOpacity?(o: number): void });

/** Baymax at his planned arrival: the shared module's `createBaymaxGhost` (async, same GLB as the hero) when present; otherwise the old procedural body with a hologram material. */
export function BaymaxGhost({ stateRef, anchorsRef, base }: { readonly stateRef: MutableRefObject<GhostBaymaxState>; readonly anchorsRef: MutableRefObject<DisplayAnchors>; readonly base: string }) {
  const grp = useRef<Group>(null);
  useEffect(() => {
    const host = grp.current; if (!host) return;
    let alive = true; let dispose: () => void = () => undefined;
    const fallback = () => {
      const rig = buildBaymax('low');
      const mat = hologramMaterial(new Color('#b9a6ff'), 0.62);
      rig.root.traverse(o => { const m = o as Mesh; if (m.isMesh) m.material = mat; else if ((o as Object3D & { isPoints?: boolean }).isPoints || (o as Object3D & { isLine?: boolean }).isLine) o.visible = false; });
      host.add(rig.root); dispose = () => { rig.root.removeFromParent(); rig.dispose(); mat.dispose(); };
    };
    const factory = (BaymaxApi as unknown as { createBaymaxGhost?: GhostFactory }).createBaymaxGhost;
    if (typeof factory === 'function') {
      void Promise.resolve(factory('low', `${base}models/`)).then(g => {
        if (!alive) { g.dispose(); return; }
        g.setOpacity?.(0.5); host.add(g.root); dispose = () => g.dispose();
      }).catch(() => { if (alive) fallback(); });
    } else fallback();
    return () => { alive = false; dispose(); };
  }, [base]);
  const q = useMemo(() => new Quaternion(), []);
  useFrame(() => {
    const g = grp.current; if (!g) return;
    const s = stateRef.current;
    g.visible = s.visible;
    if (!s.visible) return;
    g.position.set(s.x, s.y, s.z); g.quaternion.copy(q.setFromAxisAngle(UP, s.yaw));
    g.scale.setScalar(boost(anchorsRef.current.scale, 18, 4.2));
  });
  return <group ref={grp} visible={false} />;
}
