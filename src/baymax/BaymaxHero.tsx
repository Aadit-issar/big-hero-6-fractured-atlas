import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { buildBaymax } from './model';
import type { BaymaxLod, ThrusterSocket } from './model';
import { createBaymaxFx, updateBaymaxFx } from './fx';
import { FlightDynamics } from './thrust';
import type { FlightState, Quat, Vec3 } from './thrust';
import { applyHeroPose, instantiateHero, loadBaymaxHero } from './glb';
import type { HeroRig, HeroTemplate } from './glb';
import { PoseDynamics } from './pose';

export interface BaymaxHeroState extends FlightState {
  /** World position of the body centre of mass, metres. */
  readonly position: Vec3;
  /** World orientation [x, y, z, w]; Baymax faces local -Z. */
  readonly quaternion: Quat;
}

export interface BaymaxHeroProps {
  /** Read every frame; the parent may mutate it (or swap the object) without re-rendering React. */
  readonly state: BaymaxHeroState | { readonly current: BaymaxHeroState };
  readonly lod?: BaymaxLod;
  readonly showFx?: boolean;
  /** Simulation clock in seconds. When supplied, motion freezes with it (use engine.clock.time). Otherwise real frame time. */
  readonly timeSource?: () => number;
  /** Pre-converge the dynamics before the first frame (deterministic stills). */
  readonly settle?: boolean;
  /** Fixed time for bob and flicker (deterministic stills). */
  readonly fixedTime?: number;
  /**
   * Folder (URL) that serves baymax_hero.glb and baymax_hero_lod1.glb. Default: `${import.meta.env.BASE_URL}assets/models/baymax_hero/`
   * (Dimension). ATLAS passes `${import.meta.env.BASE_URL}models/`.
   */
  readonly heroBaseUrl?: string;
  /** Called once when the GLB is instantiated (or the procedural fallback is shown after a load failure). */
  readonly onReady?: (info: { readonly glb: boolean }) => void;
  /** Force the wing deployment (0 folded .. 1 deployed), e.g. for stills and the reference pose. Omit for flight-driven deployment. */
  readonly wingOverride?: number;
}

const isRef = (s: BaymaxHeroProps['state']): s is { readonly current: BaymaxHeroState } => 'current' in s;

interface ActiveRig {
  readonly root: Group;
  readonly body: Group;
  readonly sockets: ThrusterSocket[];
  readonly hero: HeroRig | null;
  dispose(): void;
}

/**
 * Armoured Baymax with flight-pack and foot thrusters. The pose root takes position and orientation; the lean/bank/bob pose is applied
 * to the inner body group only, so sockets (and the plumes parented to them) follow the visible nozzles. The articulated GLB is loaded
 * once and cloned (shared geometry and materials); nothing is drawn while it loads. If the GLB cannot be loaded the old procedural body
 * is shown as a fallback so the flight never loses its avatar.
 */
export function BaymaxHero({ state, lod = 'high', showFx = true, timeSource, settle = false, fixedTime, heroBaseUrl, onReady, wingOverride }: BaymaxHeroProps) {
  const [tpl, setTpl] = useState<HeroTemplate | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    setTpl(null);
    loadBaymaxHero(lod, heroBaseUrl).then((t) => { if (alive) setTpl(t); }, (e: unknown) => {
      console.warn('[baymax] hero GLB failed to load, using the procedural fallback', e);
      if (alive) setTpl('failed');
    });
    return () => { alive = false; };
  }, [lod, heroBaseUrl]);

  const rig = useMemo<ActiveRig | null>(() => {
    if (tpl === null) return null;
    if (tpl === 'failed') {
      const p = buildBaymax(lod);
      return { root: p.root, body: p.body, sockets: p.sockets, hero: null, dispose: () => p.dispose() };
    }
    const hero = instantiateHero(tpl);
    if (hero.missing.length) console.warn('[baymax] hero GLB is missing nodes', hero.missing);
    return { root: hero.root, body: hero.root, sockets: hero.sockets, hero, dispose: () => hero.dispose() };
  }, [tpl, lod]);

  const fx = useMemo(() => (showFx && rig ? createBaymaxFx(rig.sockets) : null), [rig, showFx]);
  const dyn = useRef(new FlightDynamics());
  const poseDyn = useRef(new PoseDynamics());
  const last = useRef<number | null>(null);
  const settled = useRef(false);
  const rootRef = useRef<Group>(null);

  useEffect(() => () => { fx?.dispose(); }, [fx]);
  useEffect(() => () => { rig?.dispose(); }, [rig]);
  useEffect(() => { settled.current = false; }, [settle, rig]);
  useEffect(() => { if (rig) onReady?.({ glb: rig.hero !== null }); }, [rig, onReady]);

  useFrame((_, delta) => {
    const root = rootRef.current;
    if (!root || !rig) return;
    const s = isRef(state) ? state.current : state;
    root.position.set(s.position[0], s.position[1], s.position[2]);
    root.quaternion.set(s.quaternion[0], s.quaternion[1], s.quaternion[2], s.quaternion[3]);

    let dt = Math.min(delta, 0.1);
    if (timeSource) {
      const t = timeSource();
      dt = last.current === null ? 0 : Math.min(Math.max(t - last.current, 0), 0.1);
      last.current = t;
    }
    const speed = Math.hypot(s.velocity[0], s.velocity[1], s.velocity[2]);
    if (settle && !settled.current) {
      settled.current = true;
      for (let i = 0; i < 300; i++) poseDyn.current.step(1 / 60, speed, dyn.current.step(1 / 60, s, s.quaternion));
      dt = 0;
    }
    const out = dyn.current.step(dt, s, s.quaternion);
    const pose = poseDyn.current.step(dt, speed, out);
    if (rig.hero) applyHeroPose(rig.hero, wingOverride === undefined ? pose : { ...pose, wing: wingOverride }, out);
    rig.body.rotation.set(-out.lean.pitch, 0, -out.lean.roll);
    rig.body.position.y = out.hoverBob;
    if (fx) updateBaymaxFx(fx, rig.sockets, out, fixedTime ?? dyn.current.elapsed);
  });

  return <group ref={rootRef}>{rig ? <primitive object={rig.root} /> : null}</group>;
}
