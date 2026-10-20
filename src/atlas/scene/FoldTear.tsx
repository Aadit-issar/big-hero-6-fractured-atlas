import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, CustomBlending, Group, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial } from 'three';
import type { ObservedConnectionState } from '../../shared/atlasContract';
import type { SceneFold, SceneModel } from './sceneModel';
import { hashUnit } from './sceneModel';
import { NOISE_GLSL, PALETTE, linear } from './palette';
import { revealOf } from './timing';

const VERTEX = /* glsl */`varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// An irregular tear in space: jagged S-bent lens, a deep displaced-space interior and a chromatically split
// luminous rim. Width/glow/jitter encode the fold's recorded lifecycle state, so states differ by shape as well as colour.
const FRAGMENT = /* glsl */`
uniform float uTime, uReveal, uWidth, uGlow, uJitter, uMemory, uSeed, uHalo, uDim, uHide;
uniform vec3 cDeep, cCobalt, cRim, cEdge, cAmber;
varying vec2 vUv;
${NOISE_GLSL}
float n1(float x, float s) { return vnoise(vec3(x, s, 0.5)); }
void main() {
  vec2 p = vUv;
  float y = p.y;
  float reveal = uReveal;
  // The tear opens from its middle outwards.
  float openY = smoothstep(abs(y) - 0.02, abs(y) + 0.3, reveal * 1.25);
  float jig = uJitter * (n1(y * 9.0 + uTime * 1.8, uSeed) - 0.5);
  float bend = sin(y * 2.3 + uSeed * 6.0) * 0.1 + (n1(y * 3.0, uSeed + 2.0) - 0.5) * 0.18 + jig * 0.35;
  float body = pow(max(1.0 - y * y, 0.0), 0.72);
  float jag = 1.0 + (n1(y * 8.0, uSeed + 5.0) - 0.5) * 1.1 + (n1(y * 21.0, uSeed + 9.0) - 0.5) * 0.55 + jig;
  float half_ = uWidth * body * jag * openY;
  float d = abs(p.x - bend) - half_;
  float inside = 1.0 - smoothstep(-0.012, 0.012, d);
  // Interior: depth-parallaxed swirling displaced space.
  vec2 q = p * vec2(1.2, 2.2);
  float f1 = fbm3(vec3(q * 2.2 + vec2(0.0, uTime * 0.05), uSeed));
  float f2 = fbm3(vec3(q * 5.0 - vec2(uTime * 0.04, 0.0) + f1, uSeed + 4.0));
  vec3 interior = mix(cDeep, cCobalt, smoothstep(0.35, 0.8, f1 * 0.6 + f2 * 0.6));
  interior += vec3(0.35, 0.25, 0.8) * pow(f2, 5.0) * 0.45;
  // Rim: sharp inner edge + soft aura, split a little per colour channel.
  float dr = d + 0.012, db = d - 0.012;
  vec3 rim = vec3(exp(-abs(dr) * 55.0), exp(-abs(d) * 55.0), exp(-abs(db) * 55.0));
  float edgeFade = (1.0 - smoothstep(0.7, 1.0, abs(y))) * (1.0 - smoothstep(0.55, 1.0, abs(p.x)));
  float aura = exp(-max(d, 0.0) * 9.0) * uHalo * (1.0 - inside) * edgeFade;
  rim *= edgeFade;
  float shimmer = 0.75 + 0.25 * n1(y * 13.0 - uTime * 2.2, uSeed + 12.0);
  vec3 col = interior * inside;
  // A remembered fold is a last-known record, not a live phenomenon: its glow is largely gone and what remains is a cool, flat outline.
  float live = 1.0 - uMemory * 0.82;
  col += cEdge * rim * uGlow * shimmer * live;
  col += cRim * aura * 0.38 * uGlow * live;
  col = mix(col, vec3(dot(col, vec3(0.333))) * vec3(0.62, 0.7, 1.15), uMemory * 0.8);
  float outline = exp(-abs(d) * 70.0) * edgeFade * uMemory * 0.55;
  col += vec3(0.55, 0.62, 1.0) * outline;
  float a = clamp(inside * 0.97, 0.0, 1.0) * (1.0 - uMemory * 0.7);
  float k = smoothstep(0.0, 0.05, reveal);
  float recede = (1.0 - uDim * 0.6) * (1.0 - uHide * uMemory);
  // Premultiplied: the interior occludes the nebula behind it; rim and aura only add light.
  gl_FragColor = vec4(col * k * (1.0 - uMemory * 0.35) * recede, a * k * recede);
}`;

const STATE_LOOK: Record<ObservedConnectionState, { width: number; glow: number; jitter: number }> = {
  inactive: { width: 0.05, glow: 0.35, jitter: 0 },
  forming: { width: 0.13, glow: 0.8, jitter: 0.35 },
  open: { width: 0.3, glow: 1.25, jitter: 0 },
  unstable: { width: 0.26, glow: 1.6, jitter: 1 },
  closing: { width: 0.11, glow: 0.8, jitter: 0.45 },
  closed: { width: 0.035, glow: 0.4, jitter: 0 },
};

export interface FoldTearProps {
  readonly fold: SceneFold;
  readonly modelRef: { current: SceneModel };
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

export function FoldTear({ fold, modelRef, selected, onSelect }: FoldTearProps) {
  const group = useRef<Group>(null);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor,
    uniforms: {
      uTime: { value: 0 }, uReveal: { value: 0 }, uWidth: { value: 0.3 }, uGlow: { value: 1 }, uJitter: { value: 0 }, uMemory: { value: 0 },
      uSeed: { value: hashUnit(fold.id, 5) * 30 }, uHalo: { value: 1 }, uDim: { value: 0 }, uHide: { value: 0 },
      cDeep: { value: new Color('#02031a').multiplyScalar(1) }, cCobalt: { value: linear('#1632c8').multiplyScalar(0.38) },
      cRim: { value: linear(PALETTE.orchid) }, cEdge: { value: linear('#ffe3ff').multiplyScalar(1.6) }, cAmber: { value: linear(PALETTE.amber) },
    },
  }), [fold.id]);
  useEffect(() => () => material.dispose(), [material]);
  const s = useRef(fold); s.current = fold;
  const memory = useRef(fold.observed ? 0 : 1);
  const look = useRef({ ...STATE_LOOK[fold.state] });
  const sel = useRef(0);
  const dim = useRef(0), hide = useRef(0);
  useFrame(({ camera }, delta) => {
    const model = modelRef.current, f = s.current, u = material.uniforms;
    const target = STATE_LOOK[f.state], k = Math.min(1, delta * 3);
    look.current.width += (target.width - look.current.width) * k;
    look.current.glow += (target.glow - look.current.glow) * k;
    look.current.jitter += (target.jitter - look.current.jitter) * k;
    memory.current += ((f.observed ? 0 : 1) - memory.current) * Math.min(1, delta * 2.6);
    sel.current += ((selected ? 1 : 0) - sel.current) * Math.min(1, delta * 6);
    u.uTime!.value = model.time;
    u.uReveal!.value = revealOf(model, f.firstSeenAt, f.entry);
    u.uWidth!.value = look.current.width; u.uGlow!.value = look.current.glow * (1 + sel.current * 0.35); u.uJitter!.value = look.current.jitter;
    u.uMemory!.value = memory.current;
    const focus = model.focus;
    dim.current += ((focus && !focus.ids.includes(f.id) ? 1 : 0) - dim.current) * Math.min(1, delta * 3);
    hide.current += ((model.lens === 'sensor' ? 1 : 0) - hide.current) * Math.min(1, delta * 3.5);
    u.uDim!.value = dim.current; u.uHide!.value = hide.current;
    const g = group.current;
    if (g) {
      g.position.set(f.entry[0], f.entry[1], f.entry[2]);
      // Anchored in space, turned about the vertical axis toward the viewer so its depth reads from every angle.
      const dx = camera.position.x - f.entry[0], dz = camera.position.z - f.entry[2];
      g.rotation.set(0, Math.atan2(dx, dz), 0);
      g.visible = u.uReveal!.value > 0.001 && !(hide.current > 0.985 && memory.current > 0.9);
    }
  });
  const H = 8.4;
  return (
    <group ref={group} name={fold.id}>
      <mesh material={material} onClick={e => { e.stopPropagation(); onSelect(fold.id); }}>
        <planeGeometry args={[H * 1.1, H * 2]} />
      </mesh>
    </group>
  );
}
