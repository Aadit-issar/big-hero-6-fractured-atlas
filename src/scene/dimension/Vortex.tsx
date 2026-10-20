import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CustomBlending, DoubleSide, OneFactor, OneMinusSrcAlphaFactor, Quaternion, ShaderMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { VORTEX } from './layout';

/** Field centre the vortex faces; its axis defines the funnel's pull direction. */
export const FIELD_CENTRE = new Vector3(0, 2, -55);
export const VORTEX_AXIS = new Vector3(...VORTEX).sub(FIELD_CENTRE).normalize();

const VERTEX = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Logarithmic spiral arms, a blinding warm core and radial light streaks.
// HDR output (core ≫ 1) is meant to bloom. Rotation follows model time.
const FRAGMENT = /* glsl */`
uniform float uTime, uIntensity;
varying vec2 vUv;
float h(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p), a = atan(p.y, p.x);
  float lr = log(max(r, 1e-3));
  float swirl = a + lr * 3.2 - uTime * 0.09;
  float arms = 0.5 + 0.5 * sin(swirl * 3.0);
  float turb = n2(vec2(swirl * 2.2, lr * 5.0 - uTime * 0.05)) * 0.6 + n2(vec2(swirl * 7.0, lr * 13.0)) * 0.4;
  float body = pow(arms, 3.4) * (0.3 + 1.0 * turb) * smoothstep(1.0, 0.2, r) * smoothstep(0.0, 0.08, r);
  float core = exp(-r * 60.0) * 3.0 + exp(-r * 16.0) * 0.35;
  float rays = pow(n2(vec2(a * 18.0, 0.0)), 7.0) * smoothstep(0.9, 0.05, r) * smoothstep(0.02, 0.12, r) * 0.9;
  vec3 gold = vec3(1.0, 0.7, 0.38), pink = vec3(1.0, 0.38, 0.78), violet = vec3(0.52, 0.22, 1.0), cobalt = vec3(0.18, 0.28, 1.0);
  vec3 armTint = mix(pink, violet, smoothstep(0.12, 0.55, r));
  armTint = mix(armTint, cobalt, smoothstep(0.55, 0.95, r) * 0.6);
  armTint = mix(gold, armTint, smoothstep(0.03, 0.3, r));
  vec3 col = armTint * body * 0.9 + gold * core + mix(gold, pink, r) * rays * 0.5;
  float edge = smoothstep(1.0, 0.7, r);
  // Premultiplied: dark lanes between arms absorb what lies behind, giving the
  // whirlpool contrast instead of a flat additive glare.
  float lanes = (1.0 - arms) * (0.35 + 0.4 * turb) * smoothstep(1.0, 0.35, r) * smoothstep(0.05, 0.2, r);
  float alpha = clamp(lanes * 0.85 + min(core, 1.0), 0.0, 1.0) * edge * min(uIntensity * 3.0, 1.0);
  gl_FragColor = vec4(col * edge * uIntensity, alpha);
}`;

export function Vortex({ engine }: { readonly engine: SimulationEngine }) {
  const disc = useRef<Mesh>(null), halo = useRef<Mesh>(null);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, side: DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.55 } },
  }), []);
  const haloMaterial = useMemo(() => {
    const m = material.clone(); m.uniforms.uIntensity!.value = 0.14; return m;
  }, [material]);
  useEffect(() => () => { material.dispose(); haloMaterial.dispose(); }, [material, haloMaterial]);
  const orientation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), VORTEX_AXIS.clone().negate()), []);
  useFrame(() => {
    material.uniforms.uTime!.value = engine.clock.time;
    haloMaterial.uniforms.uTime!.value = engine.clock.time * 0.6 + 40;
  });
  return <group position={VORTEX} quaternion={orientation}>
    <mesh ref={disc} material={material} renderOrder={2} frustumCulled={false}><planeGeometry args={[420, 420]} /></mesh>
    <mesh ref={halo} material={haloMaterial} position={[0, 0, -40]} rotation={[0, 0, 1.3]} renderOrder={2} frustumCulled={false}><planeGeometry args={[620, 620]} /></mesh>
  </group>;
}
