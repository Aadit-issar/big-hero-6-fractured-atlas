import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, ShaderMaterial, Vector4 } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { createSeededRandom } from '../../simulation/seededRandom';
import { gasSimulationInputs } from './gasInputs';
import { MAX_HAZARDS } from './GasVolumePass';

const VERTEX = /* glsl */`
attribute vec4 aSeed;
uniform float uTime;
uniform vec4 uHazards[${MAX_HAZARDS}];
varying float vGlow;
void main() {
  vec3 p = position;
  // Coherent currents: slow drift plus swirls whose speed follows the sampled
  // simulation hazard at each anomaly (gravity/instability made visible).
  p += vec3(sin(uTime * 0.07 + aSeed.x * 6.28), cos(uTime * 0.05 + aSeed.y * 6.28) * 0.6, sin(uTime * 0.06 + aSeed.z * 6.28)) * 3.0;
  float energy = 0.0;
  for (int i = 0; i < ${MAX_HAZARDS}; i++) {
    vec3 c = uHazards[i].xyz;
    vec3 r = p - c;
    float d = length(r.xz);
    float k = uHazards[i].w * exp(-dot(r, r) / 1800.0);
    float a = uTime * (0.05 + 0.6 * k) / (1.0 + d * 0.05);
    p.xz = c.xz + mat2(cos(a), -sin(a), sin(a), cos(a)) * r.xz;
    p.y += sin(uTime * 0.4 + aSeed.w * 6.28) * k * 4.0;
    energy += k;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vGlow = 0.35 + aSeed.w * 0.65 + energy;
  gl_PointSize = clamp((1.2 + aSeed.w * 2.4) * 260.0 / -mv.z, 1.0, 6.0);
  gl_Position = projectionMatrix * mv;
}`;
const FRAGMENT = /* glsl */`
varying float vGlow;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 3.5);
  gl_FragColor = vec4(vec3(1.0, 0.62, 0.9) * a * vGlow * 0.55, a);
}`;

/** Suspended luminous motes threading through the gas. */
export function GasMotes({ engine, count }: { readonly engine: SimulationEngine; readonly count: number }) {
  const geometry = useMemo(() => {
    const random = createSeededRandom(engine.seed ^ 0x6d07e5);
    const positions = new Float32Array(count * 3), seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      positions.set([(random() - 0.5) * 260, -30 + random() * 90, 40 - random() * 230], i * 3);
      seeds.set([random(), random(), random(), random()], i * 4);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    return g;
  }, [engine.seed, count]);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uHazards: { value: Array.from({ length: MAX_HAZARDS }, () => new Vector4(0, -1e5, 0, 0)) } },
  }), []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  const lastTick = useRef(-1);
  useFrame(({ camera }) => {
    material.uniforms.uTime!.value = engine.clock.time;
    const tick = Math.floor(engine.clock.time * 4);
    if (tick === lastTick.current) return;
    lastTick.current = tick;
    const { hazards } = gasSimulationInputs(engine, engine.clock.time, [camera.position.x, camera.position.y, camera.position.z]);
    (material.uniforms.uHazards!.value as Vector4[]).forEach((v, i) => { const h = hazards[i]; if (h) v.set(...h); });
  });
  return <points name="gas-motes" geometry={geometry} material={material} frustumCulled={false} />;
}
