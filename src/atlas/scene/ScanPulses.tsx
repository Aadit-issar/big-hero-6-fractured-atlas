import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, DoubleSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { SceneModel } from './sceneModel';
import { PULSE_LIFE, PULSE_SPEED, smooth } from './timing';
import { PALETTE, linear } from './palette';

const V = /* glsl */`varying vec3 vN; varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const F = /* glsl */`
uniform vec3 uCam, uColor; uniform float uAlpha;
varying vec3 vN; varying vec3 vW;
void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 7.0); gl_FragColor = vec4(uColor * (0.1 + f * 1.8), uAlpha * (0.012 + f)); }`;
const POOL = 6;

/** Scan pulses: a thin shell expanding from the observer. One is spawned only for a scan that recorded something or was
 * requested by the user (see SceneModel.pulses); it stops at the scan's range. */
export function ScanPulses({ modelRef }: { readonly modelRef: { current: SceneModel } }) {
  const geometry = useMemo(() => new SphereGeometry(1, 48, 24), []);
  const materials = useMemo(() => Array.from({ length: POOL }, () => new ShaderMaterial({
    vertexShader: V, fragmentShader: F, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
    uniforms: { uCam: { value: new Vector3() }, uColor: { value: linear(PALETTE.lilac).multiplyScalar(1.6) }, uAlpha: { value: 0 } },
  })), []);
  const meshes = useRef<(Mesh | null)[]>([]);
  useEffect(() => () => { geometry.dispose(); materials.forEach(m => m.dispose()); }, [geometry, materials]);
  useFrame(({ camera }) => {
    const model = modelRef.current, o = model.observer;
    const live = o ? model.pulses.filter(p => model.time >= p.atS && model.time - p.atS < PULSE_LIFE).slice(-POOL) : [];
    materials.forEach((m, i) => {
      const mesh = meshes.current[i], p = live[i];
      if (!mesh) return;
      if (!p || !o) { mesh.visible = false; return; }
      const age = model.time - p.atS;
      mesh.visible = true;
      mesh.position.set(o.position[0], o.position[1] + 0.6, o.position[2]);
      mesh.scale.setScalar(Math.max(0.1, Math.min(p.range, age * PULSE_SPEED)));
      (m.uniforms.uCam!.value as Vector3).copy(camera.position);
      m.uniforms.uAlpha!.value = 0.65 * Math.pow(1 - age / PULSE_LIFE, 1.4) * smooth(age / 0.2);
    });
  });
  return <>{materials.map((m, i) => <mesh key={i} geometry={geometry} material={m} ref={el => { meshes.current[i] = el; }} visible={false} frustumCulled={false} />)}</>;
}
