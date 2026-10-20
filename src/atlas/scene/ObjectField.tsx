import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  AdditiveBlending, BackSide, BoxGeometry, BufferGeometry, Color, CylinderGeometry, DoubleSide, Euler, Float32BufferAttribute, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh,
  Matrix4, Mesh, OctahedronGeometry, Quaternion, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneClusterView, SceneModel, SceneObject } from './sceneModel';
import { hashUnit } from './sceneModel';
import { KEY_LIGHT } from './NebulaSky';
import { NOISE_GLSL, PALETTE, linear } from './palette';
import { PULSE_SPEED } from './timing';

type Shape = 'rock' | 'beam' | 'tube' | 'plate' | 'shell' | 'capsule' | 'swarm';
const SHAPES: readonly Shape[] = ['rock', 'beam', 'tube', 'plate', 'shell', 'capsule', 'swarm'];
const CAPACITY = 640;

const SHAPE_OF: Record<string, Shape> = {
  concrete: 'rock', rubble: 'rock', steel: 'beam', scaffold: 'beam', pipe: 'tube', electrical: 'tube', walkway: 'plate', panel: 'plate', baymax: 'shell', landmark: 'capsule', microbot: 'swarm',
};
const TINT: Record<string, string> = { concrete: '#9d86c8', industrial: '#8a86d6', baymax: '#fbf1ff', capsule: '#ecd0ff', microbot: '#ff5ce6' };

const V = /* glsl */`
attribute vec3 aState; attribute vec3 aTint;
varying vec3 vN; varying vec3 vW; varying vec3 vL; varying vec3 vTint; varying vec3 vState;
void main() {
  vL = position; vTint = aTint; vState = aState;
  float grow = smoothstep(0.0, 0.9, aState.y);
  vec4 w = modelMatrix * instanceMatrix * vec4(position * (0.25 + 0.75 * grow), 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
// Lit like the islands and fragments of the Dimension: dark violet bodies, key light, magenta bounce, lilac rim, haze.
const F = /* glsl */`
uniform vec3 uCam, uLight, uHaze; uniform float uEmissive, uDim, uHide;
varying vec3 vN; varying vec3 vW; varying vec3 vL; varying vec3 vTint; varying vec3 vState;
${NOISE_GLSL}
void main() {
  if (vState.y < 0.0) discard;
  vec3 V = normalize(uCam - vW);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  float ndl = max(dot(N, uLight), 0.0);
  float grit = vnoise(vL * 3.0 + vState.z * 17.0);
  vec3 base = vTint * (0.42 + 0.3 * grit);
  vec3 col = base * (0.28 + 1.5 * ndl + max(-N.y, 0.0) * 0.55);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.94, 0.7, 1.0) * fres * (0.35 + 0.9 * ndl);
  col += vTint * uEmissive;
  // Acquisition flash: a brief luminous surge when the scan resolves the object.
  float flash = (1.0 - smoothstep(0.35, 1.5, vState.y)) * smoothstep(0.0, 0.2, vState.y);
  col += vec3(1.0, 0.85, 1.0) * flash * (0.8 + fres * 1.5);
  float haze = 1.0 - exp(-distance(vW, uCam) * 0.0065);
  col = mix(col, uHaze, haze * 0.45);
  // Remembered: cool, flat and translucent.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 mem = mix(vec3(lum), vec3(0.28, 0.3, 0.85), 0.45) * 0.8 + vec3(0.7, 0.55, 1.0) * fres * 0.5;
  float memory = step(0.5, vState.x);
  col = mix(col, mem, memory);
  col = mix(col, uHaze * 0.5, uDim * 0.5);
  gl_FragColor = vec4(col, mix(1.0, 0.3 + 0.35 * fres, memory) * (1.0 - 0.3 * uDim) * (1.0 - uHide * memory));
}`;

const HALO_V = /* glsl */`varying vec3 vN; varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const HALO_F = /* glsl */`uniform vec3 uCam, uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vW;
void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 3.2); gl_FragColor = vec4(uColor * (0.2 + f), uAlpha * (0.01 + f * 0.45)); }`;

function displaced(seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 2);
  const p = g.getAttribute('position');
  const rnd = (i: number) => hashUnit(`rock${seed}`, i);
  const out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.72 + 0.5 * hashUnit(`rock${seed}:${Math.round(x * 4)}:${Math.round(y * 4)}:${Math.round(z * 4)}`, 1) * (0.6 + 0.4 * rnd(1));
    out[i * 3] = x * k; out[i * 3 + 1] = y * k * 0.8; out[i * 3 + 2] = z * k * 1.1;
  }
  g.setAttribute('position', new Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

function swarmGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 44; i += 1) {
    const a = hashUnit('swarm', i) * Math.PI * 2, b = Math.acos(2 * hashUnit('swarm', i + 40) - 1), r = 0.25 + 0.75 * Math.cbrt(hashUnit('swarm', i + 80));
    const o = new OctahedronGeometry(0.035 + 0.025 * hashUnit('swarm', i + 120), 0);
    o.translate(Math.sin(b) * Math.cos(a) * r, Math.sin(b) * Math.sin(a) * r * 0.7, Math.cos(b) * r);
    parts.push(o);
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach(g => g.dispose());
  return merged;
}

/** Scene objects acquired by the proximity scanner, drawn as lightweight illustrative stand-ins (not measured meshes).
 * Only objects present in ATLAS's scene-object memory are ever drawn. */
export function ObjectField({ objects, clusters, modelRef, selected, onSelect }: {
  readonly objects: readonly SceneObject[]; readonly clusters: readonly SceneClusterView[]; readonly modelRef: { current: SceneModel };
  readonly selected: string | null; readonly onSelect: (id: string) => void;
}) {
  const geometries = useMemo<Record<Shape, BufferGeometry>>(() => {
    const tube = new CylinderGeometry(0.16, 0.16, 2.2, 10); tube.rotateZ(Math.PI / 2);
    const capsule = mergeGeometries([new CylinderGeometry(0.62, 1, 1.0, 24, 1, true), new CylinderGeometry(0.66, 0.66, 0.08, 24).translate(0, 0.5, 0)])!;
    const shell = new SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    return { rock: displaced(1), beam: new BoxGeometry(2.4, 0.22, 0.22), tube, plate: new BoxGeometry(1.7, 0.07, 1.1), shell, capsule, swarm: swarmGeometry() };
  }, []);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: V, fragmentShader: F, transparent: true, side: DoubleSide,
    uniforms: { uCam: { value: new Vector3() }, uLight: { value: KEY_LIGHT.clone() }, uHaze: { value: linear(PALETTE.violet).multiplyScalar(0.8) }, uEmissive: { value: 0 }, uDim: { value: 0 }, uHide: { value: 0 } },
  }), []);
  const swarmMaterial = useMemo(() => { const m = material.clone(); m.uniforms = { ...m.uniforms, uEmissive: { value: 0.9 } }; return m; }, [material]);
  const meshes = useRef<Partial<Record<Shape, InstancedMesh>>>({});
  const ids = useRef<Record<Shape, string[]>>({ rock: [], beam: [], tube: [], plate: [], shell: [], capsule: [], swarm: [] });
  const attrs = useRef<Partial<Record<Shape, { state: InstancedBufferAttribute; tint: InstancedBufferAttribute }>>>({});
  const halos = useMemo(() => new SphereGeometry(1, 32, 16), []);
  const haloMaterial = useMemo(() => new ShaderMaterial({
    vertexShader: HALO_V, fragmentShader: HALO_F, transparent: true, depthWrite: false, side: BackSide, blending: AdditiveBlending,
    uniforms: { uCam: { value: new Vector3() }, uColor: { value: linear(PALETTE.orchid) }, uAlpha: { value: 0.28 } },
  }), []);
  const haloMeshes = useRef<(Mesh | null)[]>([]);
  useEffect(() => () => { Object.values(geometries).forEach(g => g.dispose()); material.dispose(); swarmMaterial.dispose(); halos.dispose(); haloMaterial.dispose(); }, [geometries, material, swarmMaterial, halos, haloMaterial]);

  const objectsRef = useRef(objects); objectsRef.current = objects;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  // Rebuild instance matrices when the set of records changes (a few times per second at most).
  useEffect(() => {
    const m = new Matrix4(), q = new Quaternion(), e = new Euler(), p = new Vector3(), s = new Vector3();
    for (const shape of SHAPES) ids.current[shape] = [];
    const counts: Record<Shape, number> = { rock: 0, beam: 0, tube: 0, plate: 0, shell: 0, capsule: 0, swarm: 0 };
    for (const o of objects) {
      const shape = SHAPE_OF[o.category] ?? 'rock';
      const mesh = meshes.current[shape], list = ids.current[shape];
      if (!mesh || list.length >= CAPACITY) continue;
      const seed = hashUnit(o.id, 3);
      const base = shape === 'beam' || shape === 'tube' ? o.radius / 1.15 : shape === 'plate' ? o.radius / 0.9 : shape === 'capsule' ? Math.max(1.4, o.radius * 0.95) : shape === 'swarm' ? Math.max(2, o.radius) : Math.max(0.6, o.radius * 0.9);
      e.set(seed * 6.28, hashUnit(o.id, 5) * 6.28, hashUnit(o.id, 7) * 6.28);
      q.setFromEuler(e); p.set(o.position[0], o.position[1], o.position[2]); s.set(base, base, base);
      m.compose(p, q, s);
      const index = list.length;
      mesh.setMatrixAt(index, m);
      list.push(o.id);
      const color = new Color(TINT[o.family] ?? '#aaaaff');
      attrs.current[shape]!.tint.setXYZ(index, color.r, color.g, color.b);
      attrs.current[shape]!.state.setZ(index, seed);
      counts[shape] += 1;
    }
    for (const shape of SHAPES) {
      const mesh = meshes.current[shape]; if (!mesh) continue;
      mesh.count = counts[shape]; mesh.instanceMatrix.needsUpdate = true; attrs.current[shape]!.tint.needsUpdate = true;
    }
  }, [objects]);

  const dimRef = useRef(0), hideRef = useRef(0);
  useFrame(({ camera }, delta) => {
    const model = modelRef.current, o = model.observer, lookup = new Map(objectsRef.current.map(x => [x.id, x]));
    (material.uniforms.uCam!.value as Vector3).copy(camera.position);
    (swarmMaterial.uniforms.uCam!.value as Vector3).copy(camera.position);
    (haloMaterial.uniforms.uCam!.value as Vector3).copy(camera.position);
    dimRef.current += ((model.focus && !model.focus.debris ? 1 : 0) - dimRef.current) * Math.min(1, delta * 3);
    hideRef.current += ((model.lens === 'sensor' ? 1 : 0) - hideRef.current) * Math.min(1, delta * 3.5);
    for (const m of [material, swarmMaterial]) { m.uniforms.uDim!.value = dimRef.current; m.uniforms.uHide!.value = hideRef.current; }
    haloMaterial.uniforms.uAlpha!.value = 0.28 * (1 - 0.7 * dimRef.current);
    for (const shape of SHAPES) {
      const a = attrs.current[shape], list = ids.current[shape];
      if (!a) continue;
      for (let i = 0; i < list.length; i += 1) {
        const rec = lookup.get(list[i]!);
        if (!rec) continue;
        const sinceSeen = model.time - rec.firstSeenAt;
        // The scan pulse reaches an object after distance / speed; very old records have long since arrived.
        const delay = o && sinceSeen < 6 ? Math.min(2.6, Math.hypot(rec.position[0] - o.position[0], rec.position[1] - o.position[1], rec.position[2] - o.position[2]) / PULSE_SPEED) : 0;
        a.state.setXY(i, rec.observed ? 0 : 1, sinceSeen - delay);
      }
      a.state.needsUpdate = true;
    }
    haloMeshes.current.forEach(mesh => { if (mesh) mesh.visible = true; });
  });

  const pick = (shape: Shape) => (event: ThreeEvent<MouseEvent>) => {
    if (event.instanceId === undefined) return;
    const id = ids.current[shape][event.instanceId];
    if (id) { event.stopPropagation(); onSelect(id); }
  };
  return (
    <>
      {SHAPES.map(shape => (
        <instancedMesh key={shape} args={[geometries[shape], shape === 'swarm' ? swarmMaterial : material, CAPACITY]} frustumCulled={false} count={0}
          ref={(mesh: InstancedMesh | null) => {
            if (!mesh) return;
            meshes.current[shape] = mesh;
            if (!attrs.current[shape]) {
              const state = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3), tint = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
              mesh.geometry.setAttribute('aState', state); mesh.geometry.setAttribute('aTint', tint);
              attrs.current[shape] = { state, tint };
            }
          }}
          onClick={pick(shape)} onPointerOver={() => { document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }} />
      ))}
      {clusters.filter(c => c.count >= 5).map((c, i) => (
        <mesh key={c.id} geometry={halos} material={haloMaterial} position={[c.centre[0], c.centre[1], c.centre[2]]} scale={Math.max(3, c.extent * 1.15)} ref={el => { haloMeshes.current[i] = el; }} frustumCulled={false}
          onClick={e => { e.stopPropagation(); onSelect(c.id); }} />
      ))}
    </>
  );
}
