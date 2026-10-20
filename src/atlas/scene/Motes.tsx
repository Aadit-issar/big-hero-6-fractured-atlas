import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, ShaderMaterial } from 'three';
import { PALETTE, linear } from './palette';

const V = /* glsl */`
attribute float aSeed; uniform float uTime, uScale; varying float vA;
void main() {
  vec3 p = position + vec3(sin(uTime * 0.07 + aSeed * 40.0), cos(uTime * 0.05 + aSeed * 23.0), sin(uTime * 0.06 + aSeed * 11.0)) * 1.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uScale * (0.5 + aSeed) / -mv.z, 1.0, 5.0);
  vA = 0.35 + 0.65 * aSeed;
}`;
const F = /* glsl */`uniform vec3 uColor; varying float vA; void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); gl_FragColor = vec4(uColor, a * a * vA * 0.8); }`;

/** Decorative atmospheric dust that gives depth and parallax. Carries no ATLAS information. */
export function Motes({ sceneTime, count = 260 }: { readonly sceneTime: { current: number }; readonly count?: number }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    let s = 1234567;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < count; i += 1) {
      const r = 14 + rnd() * 80, a = rnd() * Math.PI * 2, y = (rnd() - 0.35) * 46;
      pos.set([Math.cos(a) * r * 1.2 + 8, y, Math.sin(a) * r - 6], i * 3); seed[i] = rnd();
    }
    g.setAttribute('position', new BufferAttribute(pos, 3)); g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    return g;
  }, [count]);
  const material = useMemo(() => new ShaderMaterial({
    vertexShader: V, fragmentShader: F, transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 160 }, uColor: { value: linear(PALETTE.lilac) } },
  }), []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useFrame(() => { material.uniforms.uTime!.value = sceneTime.current; });
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
