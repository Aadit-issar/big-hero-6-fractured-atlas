import { Color, Euler, Object3D, Quaternion, ShaderMaterial } from 'three';
import type { BufferGeometry, Group, Material, Mesh, Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ThrusterSocket } from './model';
import type { SocketId, ThrustOutput } from './thrust';
import { POSE_TUNING } from './pose';
import type { PoseOutput } from './pose';

/**
 * Loader, rig and ghost for the armoured Baymax GLB (`baymax_hero.glb` ~88k tris, `baymax_hero_lod1.glb` ~18k tris; identical node
 * names and proportions). 1 unit = 1 m, origin mid torso, faces -Z, +Y up, wings modelled deployed.
 *
 * Base URL: each app serves the files from a different place.
 *  - Dimension: `/assets/models/baymax_hero/<file>` (the default: `import.meta.env.BASE_URL + 'assets/models/baymax_hero/'`).
 *  - ATLAS: `${import.meta.env.BASE_URL}models/<file>`: pass it as `heroBaseUrl` to <BaymaxHero> and as `base` to
 *    loadBaymaxHero / createBaymaxGhost.
 */
export const BAYMAX_HERO_FILES = { high: 'baymax_hero.glb', low: 'baymax_hero_lod1.glb' } as const;
export type HeroLod = keyof typeof BAYMAX_HERO_FILES;

export const HERO_NODES = [
  'baymax_root', 'pelvis', 'torso', 'head',
  'shoulder_L', 'upperarm_L', 'forearm_L', 'hand_L', 'shoulder_R', 'upperarm_R', 'forearm_R', 'hand_R',
  'wing_L', 'wing_R', 'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R',
] as const;
export type HeroNodeName = (typeof HERO_NODES)[number];

/** GLB socket node for each thruster id. +Z of each node is the exhaust direction in its local space. */
export const HERO_SOCKET_NODES: Record<SocketId, string> = {
  'pack-left': 'socket_pack_left', 'pack-right': 'socket_pack_right', 'foot-left': 'socket_foot_left', 'foot-right': 'socket_foot_right',
};
const SOCKET_SPEC: Record<SocketId, { maxThrust: number; radius: number }> = {
  'pack-left': { maxThrust: 480, radius: 0.085 }, 'pack-right': { maxThrust: 480, radius: 0.085 },
  'foot-left': { maxThrust: 140, radius: 0.055 }, 'foot-right': { maxThrust: 140, radius: 0.055 },
};

export function defaultHeroBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const b = env?.BASE_URL ?? '/';
  return `${b.endsWith('/') ? b : `${b}/`}assets/models/baymax_hero/`;
}

export interface HeroTemplate {
  readonly url: string;
  /** The parsed scene. Never add it to a render graph: instantiate (clone) it. Geometry and materials are shared by every clone. */
  readonly scene: Group;
}

const cache = new Map<string, Promise<HeroTemplate>>();

/** Load (once per URL) and cache the hero GLB. */
export function loadBaymaxHero(lod: HeroLod = 'high', base: string = defaultHeroBase()): Promise<HeroTemplate> {
  const url = `${base.endsWith('/') ? base : `${base}/`}${BAYMAX_HERO_FILES[lod]}`;
  let p = cache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => ({ url, scene: g.scene }));
    p.catch(() => { cache.delete(url); });
    cache.set(url, p);
  }
  return p;
}

/** Free every cached template's GPU resources (tests, hot reload). Live instances become invalid. */
export function disposeBaymaxHeroCache(): void {
  for (const p of cache.values()) {
    void p.then((t) => {
      t.scene.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        (m.geometry as BufferGeometry).dispose();
        const mat = m.material as Material | Material[];
        for (const mm of Array.isArray(mat) ? mat : [mat]) {
          for (const v of Object.values(mm as unknown as Record<string, unknown>)) if (v && (v as Texture).isTexture) (v as Texture).dispose();
          mm.dispose();
        }
      });
    }, () => undefined);
  }
  cache.clear();
}

export interface HeroRig {
  /** The cloned hierarchy; <BaymaxHero> puts it inside the lean/bank/bob group. */
  readonly root: Group;
  readonly nodes: Readonly<Record<HeroNodeName, Object3D>>;
  readonly sockets: ThrusterSocket[];
  readonly missing: string[];
  dispose(): void;
}

const tmpQ = new Quaternion();
const tmpE = new Euler();
const restQ = new WeakMap<Object3D, Quaternion>();

/** Clone the template's node hierarchy (geometry and materials stay shared) and locate nodes and sockets by name. */
export function instantiateHero(template: HeroTemplate): HeroRig {
  const root = template.scene.clone(true);
  root.name = 'baymax-hero-glb';
  const found = new Map<string, Object3D>();
  root.traverse((o) => { if (o.name && !found.has(o.name)) found.set(o.name, o); });
  const missing: string[] = [];
  const nodes = {} as Record<HeroNodeName, Object3D>;
  for (const n of HERO_NODES) {
    const o = found.get(n);
    if (!o) { missing.push(n); nodes[n] = new Object3D(); continue; }
    nodes[n] = o;
    restQ.set(o, o.quaternion.clone());
  }
  const sockets: ThrusterSocket[] = [];
  for (const id of Object.keys(HERO_SOCKET_NODES) as SocketId[]) {
    const o = found.get(HERO_SOCKET_NODES[id]);
    if (!o) { missing.push(HERO_SOCKET_NODES[id]); continue; }
    sockets.push({ id, object: o, maxThrust: SOCKET_SPEC[id].maxThrust, nozzleRadius: SOCKET_SPEC[id].radius });
  }
  return { root, nodes, sockets, missing, dispose() { root.removeFromParent(); } };
}

function setRot(node: Object3D, x: number, y: number, z: number): void {
  const q = restQ.get(node);
  tmpQ.setFromEuler(tmpE.set(x, y, z));
  if (q) node.quaternion.copy(q).multiply(tmpQ);
  else node.quaternion.copy(tmpQ);
}

/** Wings: rotate about X first (turn the blade plane), then Z (fold down), then Y (swing the blade to lie flat on the back); Euler order YZX. */
function setRotYZX(node: Object3D, x: number, y: number, z: number): void {
  const q = restQ.get(node);
  tmpQ.setFromEuler(tmpE.set(x, y, z, 'YZX'));
  if (q) node.quaternion.copy(q).multiply(tmpQ);
  else node.quaternion.copy(tmpQ);
}

/**
 * Apply the articulation for the current flight state (no allocation). Arms and legs trail back with speed, the head counters the
 * lean to keep looking ahead, the toes drop with foot thrust, and the wings fold (rotation about Z) or deploy with speed and boost.
 */
export function applyHeroPose(rig: HeroRig, pose: PoseOutput, thrust: ThrustOutput): void {
  const T = POSE_TUNING;
  const n = rig.nodes;
  const pitch = thrust.lean.pitch;
  const fold = T.wingFold * (1 - pose.wing);
  const sweep = T.wingSweep * pose.sweep;
  const foldX = T.wingFoldX * (1 - pose.wing);
  const foldY = T.wingFoldY * (1 - pose.wing);
  setRotYZX(n.wing_R, foldX, foldY - sweep, -fold);
  setRotYZX(n.wing_L, foldX, -foldY + sweep, fold);
  const armBack = -(T.armBack * pose.arm + 0.35 * Math.max(pitch, 0));
  const forearm = -T.forearmBend * pose.arm;
  setRot(n.upperarm_L, armBack, 0, 0);
  setRot(n.upperarm_R, armBack, 0, 0);
  setRot(n.forearm_L, forearm, 0, 0);
  setRot(n.forearm_R, forearm, 0, 0);
  const thigh = -T.legBack * pose.leg;
  const knee = -T.kneeBend * pose.leg;
  const foot = -T.toeDown * pose.toe + T.legBack * pose.leg * 0.6;
  setRot(n.thigh_L, thigh, 0, 0);
  setRot(n.thigh_R, thigh, 0, 0);
  setRot(n.shin_L, knee, 0, 0);
  setRot(n.shin_R, knee, 0, 0);
  setRot(n.foot_L, foot, 0, 0);
  setRot(n.foot_R, foot, 0, 0);
  setRot(n.torso, -T.torsoExtra * pitch, 0, 0);
  setRot(n.head, T.headCounter * pitch, 0, 0);
}

// ------------------------------------------------------------------------------------------------------------- ghost
const GHOST_V = /* glsl */`
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const GHOST_F = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a = uOpacity * (0.22 + 0.55 * pow(f, 1.4));
  gl_FragColor = vec4(uColor * (0.8 + 0.3 * f), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface BaymaxGhost {
  readonly root: Group;
  setOpacity(o: number): void;
  dispose(): void;
}

/**
 * Translucent, lit-free lavender (#f0b4f4, alpha-blended so overlapping parts do not blow out) copy of the hero (wings deployed, no FX) for "Baymax at arrival time" markers.
 * Geometry is shared with the cached template (no re-parse; instantiation is a node-graph clone plus one small material). Each ghost
 * owns its own material so opacities are independent; dispose() frees only that material and detaches the root.
 */
export async function createBaymaxGhost(lod: HeroLod = 'low', base: string = defaultHeroBase()): Promise<BaymaxGhost> {
  const tpl = await loadBaymaxHero(lod, base);
  const root = tpl.scene.clone(true);
  root.name = 'baymax-ghost';
  const mat = new ShaderMaterial({
    vertexShader: GHOST_V, fragmentShader: GHOST_F, transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new Color('#f0b4f4') }, uOpacity: { value: 0.5 } },
  });
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) { m.material = mat; m.renderOrder = 10; m.castShadow = false; m.receiveShadow = false; }
  });
  return {
    root,
    setOpacity(o: number) {
      const v = Math.max(0, Math.min(1, o));
      (mat.uniforms.uOpacity as { value: number }).value = v;
      root.visible = v > 0.003;
    },
    dispose() { root.removeFromParent(); mat.dispose(); },
  };
}
