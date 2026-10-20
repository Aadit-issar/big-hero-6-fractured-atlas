import {
  AdditiveBlending, DoubleSide, LatheGeometry, Mesh, ShaderMaterial, SphereGeometry, Vector2,
} from 'three';
import type { BufferGeometry, Camera, Scene, WebGLRenderer } from 'three';
import type { ThrusterSocket } from './model';
import { SOCKET_IDS, flicker } from './thrust';
import type { SocketId, ThrustOutput } from './thrust';

/**
 * Exhaust plumes: a fixed budget of 12 additive meshes (per socket: outer plume, white-hot core, nozzle heat glow),
 * all sharing two geometries and two materials. Per-mesh intensity is pushed through onBeforeRender, so nothing is
 * allocated per frame. Meshes are parented to each socket's nozzle object, so the plume follows its WORLD transform
 * (+Z of the socket is the exhaust direction).
 */
const PLUME_V = /* glsl */`
varying float vT; varying vec3 vN; varying vec3 vW;
void main() {
  vT = position.z;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const PLUME_F = /* glsl */`
uniform float uInt, uTime, uSeed, uCore, uBoost;
varying float vT; varying vec3 vN; varying vec3 vW;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = pow(abs(dot(normalize(vN), V)), 1.25);
  float t = clamp(vT, 0.0, 1.0);
  float fall = pow(1.0 - t, 1.35) * smoothstep(0.0, 0.05, t);
  // Travelling pressure bands (shock-diamond-like) that stream downstream; deterministic in time.
  float band = 0.88 + 0.12 * sin(t * 34.0 - uTime * 38.0 + uSeed * 6.0);
  vec3 cobalt = vec3(0.18, 0.28, 1.0), violet = vec3(0.62, 0.28, 1.0), magenta = vec3(1.0, 0.25, 0.8);
  vec3 col = mix(magenta, violet, smoothstep(0.0, 0.45, t));
  col = mix(col, cobalt, smoothstep(0.35, 0.95, t));
  float hot = pow(1.0 - t, 2.2) * (0.35 + 0.65 * uCore);
  col = mix(col, vec3(1.0, 0.93, 1.0), clamp(hot * 0.7 * facing + uCore * 0.35 * (1.0 - t), 0.0, 1.0));
  float a = uInt * fall * facing * band * mix(0.55, 0.8 - 0.25 * uBoost, uCore);
  gl_FragColor = vec4(col * (1.1 + 0.25 * uBoost), a);
}`;

const GLOW_F = /* glsl */`
uniform float uInt;
varying float vT; varying vec3 vN; varying vec3 vW;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float c = pow(abs(dot(normalize(vN), V)), 2.2);
  vec3 col = mix(vec3(0.75, 0.35, 1.0), vec3(1.0, 0.92, 1.0), c);
  gl_FragColor = vec4(col * 1.4, uInt * c);
}`;

interface PlumeData { i: number; core: number; seed: number }

export interface BaymaxFx {
  /** Number of draw calls the fx adds (fixed). */
  readonly meshCount: number;
  readonly dispose: () => void;
  /** Internal: per-socket meshes keyed by id. */
  readonly parts: Record<SocketId, { plume: Mesh; core: Mesh; glow: Mesh; data: { plume: PlumeData; core: PlumeData; glow: PlumeData } }>;
  readonly state: { time: number; boost: number };
}

export function createBaymaxFx(sockets: readonly ThrusterSocket[]): BaymaxFx {
  // Plume profile (radius vs. axial t in 0..1): flares just off the nozzle, then tapers to a tip.
  const pts: Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new Vector2(Math.max(0.01, (0.6 + 0.5 * Math.sin(Math.min(t * 2.2, 1) * Math.PI * 0.5)) * Math.pow(1 - t, 0.8)), t));
  }
  const plumeGeo: BufferGeometry = new LatheGeometry(pts, 20);
  plumeGeo.rotateX(Math.PI / 2); // axis Y -> +Z
  const glowGeo: BufferGeometry = new SphereGeometry(1, 16, 10);

  const mk = (frag: string, extra: Record<string, { value: number }>): ShaderMaterial => new ShaderMaterial({
    vertexShader: PLUME_V, fragmentShader: frag, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
    uniforms: { uInt: { value: 0 }, ...extra },
  });
  const plumeMat = mk(PLUME_F, { uTime: { value: 0 }, uSeed: { value: 0 }, uCore: { value: 0 }, uBoost: { value: 0 } });
  const glowMat = mk(GLOW_F, {});

  const state = { time: 0, boost: 0 };
  const hook = (mesh: Mesh, data: PlumeData, isPlume: boolean): void => {
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.visible = false;
    mesh.onBeforeRender = (_r: WebGLRenderer, _s: Scene, _c: Camera, _g: BufferGeometry, material) => {
      const m = material as ShaderMaterial;
      const u = m.uniforms;
      (u.uInt as { value: number }).value = data.i;
      if (isPlume) {
        (u.uCore as { value: number }).value = data.core;
        (u.uSeed as { value: number }).value = data.seed;
        (u.uTime as { value: number }).value = state.time;
        (u.uBoost as { value: number }).value = state.boost;
      }
      m.uniformsNeedUpdate = true;
    };
  };

  const parts = {} as BaymaxFx['parts'];
  for (const s of sockets) {
    const seed = SOCKET_IDS.indexOf(s.id) + 1;
    const plume = new Mesh(plumeGeo, plumeMat);
    const core = new Mesh(plumeGeo, plumeMat);
    const glow = new Mesh(glowGeo, glowMat);
    plume.name = `plume-${s.id}`; core.name = `plume-core-${s.id}`; glow.name = `glow-${s.id}`;
    const data = { plume: { i: 0, core: 0, seed }, core: { i: 0, core: 1, seed: seed + 0.5 }, glow: { i: 0, core: 0, seed } };
    hook(plume, data.plume, true);
    hook(core, data.core, true);
    hook(glow, data.glow, false);
    s.object.add(plume, core, glow);
    parts[s.id] = { plume, core, glow, data };
  }

  return {
    meshCount: sockets.length * 3, parts, state,
    dispose() {
      plumeGeo.dispose(); glowGeo.dispose(); plumeMat.dispose(); glowMat.dispose();
      for (const s of sockets) {
        const p = parts[s.id];
        s.object.remove(p.plume, p.core, p.glow);
      }
    },
  };
}

/** Per-socket plume dimensions at a given thrust (metres). Pure, exported for tests. */
export function plumeDimensions(thrust: number, boost: number, nozzleRadius: number): { length: number; width: number; intensity: number } {
  const t = Math.max(0, Math.min(1, thrust));
  const length = (0.08 + 1.5 * Math.pow(t, 1.15)) * (1 + 0.6 * boost);
  const width = nozzleRadius * (1.0 + 0.8 * t + 0.35 * boost);
  const intensity = Math.min(1.1, 0.25 + 0.85 * t + 0.1 * boost) * (t < 0.01 ? 0 : 1);
  return { length, width, intensity };
}

/**
 * Non-React fx update: sizes and brightens each plume from the smoothed thrust values.
 * `time` is seconds (use the simulation clock so fx freeze on pause).
 */
export function updateBaymaxFx(fx: BaymaxFx, sockets: readonly ThrusterSocket[], thrust: ThrustOutput, time: number): void {
  fx.state.time = time;
  fx.state.boost = thrust.boost;
  for (const s of sockets) {
    const p = fx.parts[s.id];
    const v = thrust.sockets[s.id];
    const seed = SOCKET_IDS.indexOf(s.id) + 1;
    const f = flicker(time, seed);
    const d = plumeDimensions(v, thrust.boost, s.nozzleRadius);
    const on = d.intensity > 0;
    p.plume.visible = p.core.visible = p.glow.visible = on;
    if (!on) continue;
    p.plume.scale.set(d.width, d.width, d.length * f);
    p.core.scale.set(d.width * 0.5, d.width * 0.5, d.length * 0.62 * f);
    p.glow.scale.setScalar(s.nozzleRadius * (0.9 + 1.1 * v + 0.6 * thrust.boost));
    p.data.plume.i = d.intensity * f;
    p.data.core.i = d.intensity * f;
    p.data.glow.i = d.intensity * 0.8 * f;
  }
}
