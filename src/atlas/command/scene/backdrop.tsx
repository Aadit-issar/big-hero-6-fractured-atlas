import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, FogExp2, GridHelper, LineBasicMaterial, LinearFilter, LinearMipmapLinearFilter, Mesh, PlaneGeometry, Points, RGBAFormat,
  RepeatWrapping, ShaderMaterial, Sprite, SpriteMaterial, Vector3,
} from 'three';
import type { Group } from 'three';
import { CosmicSky, SUN_DIRECTION } from '../../../scene/environment/CosmicSky';
import type { AtmosphereUniforms } from '../../../scene/terrain/rockMaterial';
import type { SceneQuality } from './sceneApi';

/** The projection of the Dimension into ATLAS: the same baked nebula sky (also the image-based light and the haze source for the rock), the same
 * key/hemisphere light rig, and cheap layered cloud sheets and puffs standing in for the Dimension's raymarched gas (no raymarch here: a baked tileable
 * noise texture sampled by a handful of large quads). Everything is world-fixed, so it parallaxes correctly under the orbiting camera. */
export const WORLD_SEED = 17062026;

export interface QualityProfile {
  readonly skyCube: number; readonly sheets: number; readonly puffs: number; readonly motes: number; readonly anisotropy: number; readonly fog: number; readonly dpr: number;
}
export const QUALITY: Readonly<Record<SceneQuality, QualityProfile>> = {
  cinematic: { skyCube: 512, sheets: 3, puffs: 30, motes: 520, anisotropy: 4, fog: 0.0016, dpr: 1.5 },
  balanced: { skyCube: 256, sheets: 2, puffs: 18, motes: 320, anisotropy: 2, fog: 0.0016, dpr: 1 },
  performance: { skyCube: 128, sheets: 1, puffs: 8, motes: 160, anisotropy: 1, fog: 0.0012, dpr: 1 },
};

// ---------- baked noise ----------
const hash = (x: number, y: number, s: number) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967295; };
/** Tileable value-noise fBm: every octave's lattice period divides the texture size, so the result repeats seamlessly. */
function bakeNoise(size: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const octaves = 5;
  for (let c = 0; c < 3; c += 1) {
    const lattices: Float32Array[] = [];
    for (let o = 0; o < octaves; o += 1) { const p = 4 << o; const l = new Float32Array(p * p); for (let j = 0; j < p; j += 1) for (let i = 0; i < p; i += 1) l[j * p + i] = hash(i, j, c * 17 + o * 5 + 3); lattices.push(l); }
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      let v = 0, a = 0.5, norm = 0;
      for (let o = 0; o < octaves; o += 1) {
        const p = 4 << o, fx = (x / size) * p, fy = (y / size) * p;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const l = lattices[o]!, x1 = (ix + 1) % p, y1 = (iy + 1) % p;
        const top = l[iy * p + ix]! * (1 - tx) + l[iy * p + x1]! * tx, bot = l[y1 * p + ix]! * (1 - tx) + l[y1 * p + x1]! * tx;
        v += a * (top * (1 - ty) + bot * ty); norm += a; a *= 0.5;
      }
      data[(y * size + x) * 4 + c] = Math.round(255 * Math.min(1, v / norm));
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping; t.magFilter = LinearFilter; t.minFilter = LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

/** A soft cloud puff (alpha only in the red channel is not enough for a Sprite, so this bakes a white RGBA disc with noisy, feathered edges). */
function bakePuff(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = (x / (size - 1)) * 2 - 1, dy = (y / (size - 1)) * 2 - 1, r = Math.hypot(dx, dy);
    const n = 0.55 + 0.45 * (hash(Math.floor(x / 6), Math.floor(y / 6), 9) * 0.6 + hash(Math.floor(x / 14), Math.floor(y / 14), 4) * 0.4);
    const a = Math.max(0, 1 - r) ** 1.6 * n;
    const i = (y * size + x) * 4; data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.round(255 * Math.min(1, a * 1.4));
  }
  const t = new DataTexture(data, size, size, RGBAFormat); t.magFilter = LinearFilter; t.minFilter = LinearFilter; t.needsUpdate = true; return t;
}

// ---------- cloud sheets ----------
const SHEET_V = /* glsl */`varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SHEET_F = /* glsl */`
uniform sampler2D uNoise; uniform float uTime, uScale, uAlpha, uSeed; uniform vec3 uCam;
varying vec3 vWorld;
void main() {
  vec2 uv = vWorld.xz * uScale + vec2(uTime * 0.004 + uSeed, uTime * 0.0025 - uSeed);
  vec3 n0 = texture2D(uNoise, uv).rgb;
  vec3 n1 = texture2D(uNoise, uv * 2.7 + vec2(0.31, 0.77) + (n0.rg - 0.5) * 0.18).rgb;
  vec3 n2 = texture2D(uNoise, uv * 0.43 + vec2(0.5)).rgb;
  float body = n0.r * 0.5 + n1.g * 0.3 + n2.b * 0.4;
  float dens = smoothstep(0.42, 0.86, body);
  float crest = smoothstep(0.55, 0.95, n1.r * 0.7 + dens * 0.5);
  vec3 indigo = vec3(0.04, 0.04, 0.27), cobalt = vec3(0.10, 0.20, 0.82), violet = vec3(0.48, 0.17, 0.82), magenta = vec3(0.90, 0.28, 0.85), lilac = vec3(1.0, 0.74, 0.97);
  vec3 col = mix(indigo, cobalt, smoothstep(0.0, 0.45, dens));
  col = mix(col, violet, smoothstep(0.3, 0.7, dens + n2.g * 0.25));
  col = mix(col, magenta, smoothstep(0.45, 0.9, dens * 0.8 + n1.b * 0.35));
  col = mix(col, lilac, crest * crest * 0.55);
  float d = length(vWorld.xz - uCam.xz);
  float fade = 1.0 - smoothstep(500.0, 1500.0, d);
  float a = dens * uAlpha * fade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

// ---------- motes ----------
const MOTE_V = /* glsl */`
attribute float aSeed; uniform vec3 uCenter; uniform float uTime, uSize; varying float vA;
void main() {
  vec3 span = vec3(420.0, 200.0, 420.0);
  vec3 p = mod(position - uCenter + span * 0.5, span) - span * 0.5;
  p.y += sin(uTime * 0.25 + aSeed * 40.0) * 1.2;
  vec4 mv = viewMatrix * vec4(p + uCenter, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (60.0 / -mv.z) * (0.6 + aSeed), 1.0, 5.0);
  vA = (0.35 + 0.65 * aSeed) * (1.0 - smoothstep(120.0, 210.0, length(p)));
}`;
const MOTE_F = /* glsl */`varying float vA; void main() { vec2 q = gl_PointCoord - 0.5; float r = length(q) * 2.0; float a = smoothstep(1.0, 0.0, r) * vA; if (a < 0.01) discard; gl_FragColor = vec4(vec3(0.95, 0.78, 1.0), a * 0.8); }`;

function seeded(i: number, k: number): number { return hash(i, k, 77); }

export function Backdrop({ quality, atmosphere, showGrid, centerRef }: { readonly quality: SceneQuality; readonly atmosphere: AtmosphereUniforms; readonly showGrid: boolean; readonly centerRef: { readonly current: Vector3 } }) {
  const q = QUALITY[quality];
  const { scene, camera } = useThree();
  const noise = useMemo(() => bakeNoise(256), []);
  const puffTex = useMemo(() => bakePuff(), []);
  const sheetGroup = useRef<Group>(null);

  const sheets = useMemo(() => {
    const ys = [-150, -88, -46];
    const scales = [0.0017, 0.0023, 0.0032];
    const alphas = [0.82, 0.62, 0.5];
    return Array.from({ length: q.sheets }, (_, i) => {
      const material = new ShaderMaterial({
        vertexShader: SHEET_V, fragmentShader: SHEET_F, transparent: true, depthWrite: false, side: DoubleSide, fog: false,
        uniforms: { uNoise: { value: noise }, uTime: { value: 0 }, uScale: { value: scales[i]! }, uAlpha: { value: alphas[i]! }, uSeed: { value: i * 0.37 }, uCam: { value: new Vector3() } },
      });
      const mesh = new Mesh(new PlaneGeometry(3600, 3600, 1, 1), material);
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = ys[i]!; mesh.renderOrder = -10 + i; mesh.frustumCulled = false;
      return mesh;
    });
  }, [q.sheets, noise]);

  const puffs = useMemo(() => {
    const colors = ['#d442d8', '#8a2fe0', '#2a3fe0', '#e86fe8', '#5a2fc8', '#f2a6f4'];
    return Array.from({ length: q.puffs }, (_, i) => {
      const m = new SpriteMaterial({ map: puffTex, color: new Color(colors[i % colors.length]), transparent: true, opacity: 0.26 + 0.18 * seeded(i, 1), depthWrite: false, fog: false });
      const s = new Sprite(m);
      const ang = seeded(i, 2) * Math.PI * 2, rad = 160 + seeded(i, 3) * 520;
      s.position.set(Math.cos(ang) * rad, -80 + seeded(i, 4) * 260, Math.sin(ang) * rad);
      const size = 120 + seeded(i, 5) * 260; s.scale.set(size, size * (0.6 + 0.4 * seeded(i, 6)), 1);
      s.renderOrder = -6; return s;
    });
  }, [q.puffs, puffTex]);

  const motes = useMemo(() => {
    const g = new BufferGeometry();
    const n = q.motes, p = new Float32Array(n * 3), s = new Float32Array(n);
    for (let i = 0; i < n; i += 1) { p[i * 3] = (seeded(i, 11) - 0.5) * 4000; p[i * 3 + 1] = (seeded(i, 12) - 0.5) * 2000; p[i * 3 + 2] = (seeded(i, 13) - 0.5) * 4000; s[i] = seeded(i, 14); }
    g.setAttribute('position', new BufferAttribute(p, 3)); g.setAttribute('aSeed', new BufferAttribute(s, 1));
    const m = new ShaderMaterial({ vertexShader: MOTE_V, fragmentShader: MOTE_F, transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, uniforms: { uCenter: { value: new Vector3() }, uTime: { value: 0 }, uSize: { value: 4 } } });
    const pts = new Points(g, m); pts.frustumCulled = false; pts.renderOrder = -4; return pts;
  }, [q.motes]);

  const grid = useMemo(() => {
    const g = new GridHelper(600, 30, new Color('#7a4bd0'), new Color('#2a3fb0'));
    const m = g.material as LineBasicMaterial; m.transparent = true; m.opacity = 0.16; m.depthWrite = false; m.fog = false;
    return g;
  }, []);

  useEffect(() => {
    scene.fog = new FogExp2(new Color('#4a2a9a'), q.fog);
    return () => { scene.fog = null; };
  }, [scene, q.fog]);
  useEffect(() => () => {
    noise.dispose(); puffTex.dispose();
    sheets.forEach(s => { s.geometry.dispose(); (s.material as ShaderMaterial).dispose(); });
    puffs.forEach(s => s.material.dispose());
    motes.geometry.dispose(); (motes.material as ShaderMaterial).dispose();
    grid.geometry.dispose(); (grid.material as LineBasicMaterial).dispose();
  }, [noise, puffTex, sheets, puffs, motes, grid]);

  useFrame(() => {
    const t = performance.now() / 1000, c = camera.position;
    for (const s of sheets) { s.position.x = c.x; s.position.z = c.z; const u = (s.material as ShaderMaterial).uniforms; u.uTime!.value = t; (u.uCam!.value as Vector3).copy(c); }
    const mu = (motes.material as ShaderMaterial).uniforms; mu.uTime!.value = t; (mu.uCenter!.value as Vector3).copy(c);
    const b = centerRef.current;
    grid.visible = showGrid; grid.position.set(Math.round(b.x / 20) * 20, b.y - 26, Math.round(b.z / 20) * 20);
  });

  return (
    <>
      <CosmicSky seed={WORLD_SEED} size={q.skyCube} atmosphere={atmosphere} />
      {/* The Dimension's rig: violet hemisphere fill plus a warm key from the nebula's bright core. */}
      <hemisphereLight args={['#6c43d6', '#160b34', 0.9]} />
      <directionalLight color="#ffd9ad" intensity={4.6} position={[SUN_DIRECTION.x * 200, SUN_DIRECTION.y * 200, SUN_DIRECTION.z * 200]} />
      <directionalLight color="#7a6cff" intensity={0.9} position={[-SUN_DIRECTION.x * 120, -40, -SUN_DIRECTION.z * 120]} />
      <group ref={sheetGroup}>{sheets.map((s, i) => <primitive key={`s${i}`} object={s} />)}</group>
      {puffs.map((s, i) => <primitive key={`p${i}`} object={s} />)}
      <primitive object={motes} />
      <primitive object={grid} />
    </>
  );
}
