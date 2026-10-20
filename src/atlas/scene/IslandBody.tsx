import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, FrontSide, Group, ShaderMaterial, Vector3 } from 'three';
import type { SceneIsland, SceneModel } from './sceneModel';
import { hashUnit } from './sceneModel';
import { createIslandForm } from './islandProxy';
import { KEY_LIGHT } from './NebulaSky';
import { NOISE_GLSL, PALETTE, linear } from './palette';
import { revealOf } from './timing';

const VERTEX = /* glsl */`
varying vec3 vLocal; varying vec3 vWorld; varying vec3 vN;
void main() {
  vLocal = position; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Dark violet rock, strata and fracture veins, key + cobalt fill + orchid rim, aerial haze.
// uReveal sweeps a luminous contour up the form; uMemory dims and cools it into a translucent last-known record.
const FRAGMENT = /* glsl */`
uniform vec3 uLight, uCam, cRock, cRock2, cKey, cFill, cRim, cVein, cHaze, cScan;
uniform float uReveal, uMemory, uMinY, uMaxY, uSelected, uSeed, uDim, uHide;
varying vec3 vLocal; varying vec3 vWorld; varying vec3 vN;
${NOISE_GLSL}
void main() {
  float span = uMaxY - uMinY;
  float front = uMinY - 0.3 + (span + 0.6) * uReveal;
  if (vLocal.y > front) discard;
  vec3 V = normalize(uCam - vWorld);
  vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 bump = vec3(vnoise(vLocal * 1.7), vnoise(vLocal * 1.7 + 7.1), vnoise(vLocal * 1.7 + 13.7)) - 0.5;
  vec3 N = normalize(mix(normalize(vN), fn, 0.5) + bump * 0.55);
  if (dot(N, V) < 0.0 && !gl_FrontFacing) N = -N;
  float strata = vnoise(vec3(vLocal.x * 0.35, vLocal.y * 1.9, vLocal.z * 0.35) + uSeed);
  float grit = vnoise(vLocal * 2.2 + uSeed * 1.7);
  vec3 albedo = mix(cRock, cRock2, strata * 0.75 + grit * 0.25);
  float topness = smoothstep(0.55, 0.95, normalize(vN).y);
  albedo = mix(albedo, cRock2 * 1.5, topness * 0.35);
  // Horizontal strata ledges: darkened crevices between rock bands.
  float ledge = smoothstep(0.0, 0.18, abs(fract(vLocal.y * 0.55 + strata * 0.9) - 0.5) * 2.0);
  albedo *= mix(0.55, 1.0, ledge);
  float ndl = max(dot(N, uLight), 0.0);
  float under = max(dot(N, vec3(0.0, -1.0, 0.0)), 0.0);
  vec3 col = albedo * (cFill * 0.9 + cKey * ndl * 1.9 + cFill * under * 1.4);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += cRim * fres * (0.55 + 1.6 * ndl);
  // Fracture veins: luminous mineral seams that read as cracks, never as connections.
  float vein = 1.0 - smoothstep(0.0, 0.035, abs(vnoise(vLocal * 0.9 + uSeed * 3.1) - 0.5));
  vein *= smoothstep(0.25, 0.7, grit);
  col += cVein * vein * 0.9 * (1.0 - uMemory);
  // Reveal: leading contour band plus fine contour lines that fade as the form solidifies.
  float edge = smoothstep(0.55, 0.0, front - vLocal.y);
  float lines = 1.0 - smoothstep(0.0, 0.045, abs(fract(vLocal.y * 0.7 + 0.5) - 0.5));
  float contour = (1.0 - smoothstep(0.75, 1.0, uReveal)) * 0.85 + uSelected * 0.22 + uMemory * 0.14;
  col += cScan * (edge * edge * 1.6 * step(uReveal, 0.999) + lines * contour * (0.35 + 0.65 * edge));
  col += cScan * uSelected * fres * 0.55;
  float haze = 1.0 - exp(-distance(vWorld, uCam) * 0.0075);
  col = mix(col, cHaze, haze * 0.5);
  // Remembered: cooler, flatter, translucent.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 mem = mix(vec3(lum), cFill * 2.4, 0.45) * 0.8 + cRim * fres * 0.5;
  col = mix(col, mem, uMemory);
  // Receding secondary subject: darker and hazier, never removed.
  col = mix(col, cHaze * 0.55, uDim * 0.5);
  float alpha = mix(1.0, 0.3 + 0.4 * fres, uMemory) * (1.0 - 0.25 * uDim);
  // Sensor lens: what is not observed now fades out (memory itself is untouched).
  alpha *= 1.0 - uHide * uMemory;
  gl_FragColor = vec4(col, alpha);
}`;

export interface IslandBodyProps {
  readonly island: SceneIsland;
  readonly modelRef: { current: SceneModel };
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

export function IslandBody({ island, modelRef, selected, onSelect }: IslandBodyProps) {
  const group = useRef<Group>(null);
  const form = useMemo(() => createIslandForm(island.id), [island.id]);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, side: FrontSide,
    uniforms: {
      uLight: { value: KEY_LIGHT.clone() }, uCam: { value: new Vector3() },
      cRock: { value: new Color('#0d0425') }, cRock2: { value: new Color('#35146a') },
      cKey: { value: linear(PALETTE.orchid).multiplyScalar(1.25) }, cFill: { value: linear('#1a3cc8').multiplyScalar(0.22) },
      cRim: { value: linear(PALETTE.lilac).multiplyScalar(0.55) }, cVein: { value: linear(PALETTE.magenta).multiplyScalar(1.1) },
      cHaze: { value: linear(PALETTE.violet).multiplyScalar(0.8) }, cScan: { value: linear('#ffd6ff').multiplyScalar(0.9) },
      uReveal: { value: 0 }, uMemory: { value: 0 }, uMinY: { value: form.minY }, uMaxY: { value: form.maxY },
      uSelected: { value: 0 }, uSeed: { value: hashUnit(island.id, 3) * 40 }, uDim: { value: 0 }, uHide: { value: 0 },
    },
  }), [form, island.id]);
  useEffect(() => () => { form.geometry.dispose(); material.dispose(); }, [form, material]);
  const memory = useRef(island.observed ? 0 : 1);
  const sel = useRef(0);
  const dim = useRef(0), hide = useRef(0);
  const state = useRef({ observed: island.observed, firstSeenAt: island.firstSeenAt, position: island.position });
  state.current = { observed: island.observed, firstSeenAt: island.firstSeenAt, position: island.position };
  useFrame(({ camera }, delta) => {
    const model = modelRef.current, s = state.current;
    memory.current += ((s.observed ? 0 : 1) - memory.current) * Math.min(1, delta * 2.6);
    sel.current += ((selected ? 1 : 0) - sel.current) * Math.min(1, delta * 6);
    const u = material.uniforms;
    u.uReveal!.value = revealOf(model, s.firstSeenAt, s.position);
    u.uMemory!.value = memory.current;
    u.uSelected!.value = sel.current;
    const focus = model.focus;
    dim.current += ((focus && !focus.ids.includes(island.id) ? 1 : 0) - dim.current) * Math.min(1, delta * 3);
    hide.current += ((model.lens === 'sensor' ? 1 : 0) - hide.current) * Math.min(1, delta * 3.5);
    u.uDim!.value = dim.current; u.uHide!.value = hide.current;
    (u.uCam!.value as Vector3).copy(camera.position);
    const g = group.current;
    if (g) {
      // A slow, state-independent float: the island itself never drifts, only this sub-unit bob (frozen on pause).
      g.position.set(s.position[0], s.position[1] + Math.sin(model.time * 0.5 + u.uSeed!.value) * 0.12, s.position[2]);
      g.visible = u.uReveal!.value > 0.001 && !(hide.current > 0.985 && memory.current > 0.9);
    }
  });
  return (
    <group ref={group} name={island.id}>
      <mesh geometry={form.geometry} material={material} onClick={e => { e.stopPropagation(); onSelect(island.id); }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }} />
    </group>
  );
}
