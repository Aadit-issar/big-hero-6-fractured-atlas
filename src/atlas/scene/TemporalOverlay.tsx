import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, CylinderGeometry, Group, Mesh, OctahedronGeometry, ShaderMaterial, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import type { SceneChange, SceneEstimate, SceneModel } from './sceneModel';
import { PALETTE, linear } from './palette';

const V = /* glsl */`varying vec3 vN; varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const F = /* glsl */`uniform vec3 uCam, uColor; uniform float uAlpha, uRim; varying vec3 vN; varying vec3 vW;
void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 1.6); gl_FragColor = vec4(uColor * (0.5 + f * uRim), uAlpha * (0.25 + 0.75 * f)); }`;

const UP = new Vector3(0, 1, 0);
const COUNT = 6;
function placeBeam(mesh: Mesh, a: readonly number[], b: readonly number[], radius = 0.07) {
  const d = new Vector3(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!), len = d.length();
  mesh.visible = len > 0.01;
  if (!mesh.visible) return;
  mesh.position.set((a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2);
  mesh.quaternion.setFromUnitVectors(UP, d.normalize());
  mesh.scale.set(radius, len, radius);
}
const makeMaterial = (color: string, alpha: number, rim = 1.4) => new ShaderMaterial({
  vertexShader: V, fragmentShader: F, transparent: true, depthWrite: false, blending: AdditiveBlending,
  uniforms: { uCam: { value: new Vector3() }, uColor: { value: linear(color) }, uAlpha: { value: alpha }, uRim: { value: rim } },
});

/** Scene overlays for temporal analysis: previous-record ghosts with a change vector (Detect), limited-estimate ghosts
 * with an allowance halo, the later observation and its discrepancy (Estimate), and the abstention ring.
 * All geometry comes from fold memory and the temporal analysis snapshot; nothing here extrapolates on its own. */
export function TemporalOverlay({ modelRef }: { readonly modelRef: { current: SceneModel } }) {
  const geometry = useMemo(() => ({ beam: new CylinderGeometry(1, 1, 1, 8, 1, true), ghost: new OctahedronGeometry(1, 0), halo: new SphereGeometry(1, 28, 14), ring: new TorusGeometry(1, 0.035, 8, 48), dot: new SphereGeometry(0.16, 10, 8) }), []);
  const mats = useMemo(() => ({
    ghost: makeMaterial('#b9a2f0', 0.5), change: makeMaterial(PALETTE.amber, 1.0, 2.6), estimate: makeMaterial('#e8c8ff', 0.55), halo: makeMaterial(PALETTE.orchid, 0.16, 0.8),
    observed: makeMaterial('#ffffff', 0.9, 1.6), withheld: makeMaterial('#9a7ad8', 0.5),
  }), []);
  useEffect(() => () => { Object.values(geometry).forEach(g => g.dispose()); Object.values(mats).forEach(m => m.dispose()); }, [geometry, mats]);
  const root = useRef<Group>(null);
  const items = useRef<{ change: Mesh[]; ghost: Mesh[]; est: Mesh[]; dots: Mesh[][]; halo: Mesh[]; obs: Mesh[]; err: Mesh[]; ring: Mesh[] }>({ change: [], ghost: [], est: [], dots: [], halo: [], obs: [], err: [], ring: [] });

  useFrame(({ camera }) => {
    const model = modelRef.current;
    if (!root.current) return;
    Object.values(mats).forEach(m => (m.uniforms.uCam!.value as Vector3).copy(camera.position));
    const showChanges = model.stage === null || model.stage === 2 || model.stage === 4, showEstimates = model.stage === null || model.stage >= 3;
    const it = items.current;
    const changes: readonly SceneChange[] = showChanges ? model.changes : [], estimates: readonly SceneEstimate[] = showEstimates ? model.estimates : [];
    for (let i = 0; i < COUNT; i += 1) {
      const c = changes[i], gm = it.ghost[i], bm = it.change[i];
      if (gm) { gm.visible = !!c; if (c) { gm.position.set(c.from[0], c.from[1], c.from[2]); gm.scale.set(0.8, 4.2, 0.8); } }
      if (bm) { bm.visible = !!c; if (c) placeBeam(bm, c.from, c.to, 0.16); }
      const e = estimates[i];
      const em = it.est[i], hm = it.halo[i], om = it.obs[i], xm = it.err[i], rm = it.ring[i];
      if (em) { em.visible = !!e?.estimate; if (e?.estimate) { em.position.set(e.estimate[0], e.estimate[1], e.estimate[2]); em.scale.set(0.9, 4.2, 0.9); } }
      if (hm) { hm.visible = !!e?.estimate && e.allowance !== null; if (e?.estimate && e.allowance !== null) { hm.position.set(e.estimate[0], e.estimate[1], e.estimate[2]); hm.scale.setScalar(Math.max(1.2, e.allowance)); } }
      const dots = it.dots[i];
      if (dots) dots.forEach((d, k) => {
        d.visible = !!e?.estimate;
        if (e?.estimate) { const t = (k + 1) / (dots.length + 1); d.position.set(e.from[0] + (e.estimate[0] - e.from[0]) * t, e.from[1] + (e.estimate[1] - e.from[1]) * t, e.from[2] + (e.estimate[2] - e.from[2]) * t); }
      });
      const seen = e?.evaluation?.observed ?? e?.arrival?.position ?? null;
      if (om) { om.visible = !!seen; if (seen) { om.position.set(seen[0], seen[1], seen[2]); om.scale.set(0.9, 4.2, 0.9); } }
      if (xm) { xm.visible = !!(e?.estimate && e.evaluation?.observed); if (e?.estimate && e.evaluation?.observed) placeBeam(xm, e.estimate, e.evaluation.observed, 0.1); }
      if (rm) {
        // Abstention: a faint ring at the fold that never turns into a projection.
        rm.visible = e?.status === 'withheld';
        if (e?.status === 'withheld') { rm.position.set(e.from[0], e.from[1] - 3.5, e.from[2]); rm.scale.setScalar(2.4 * (1 + 0.06 * Math.sin(model.time * 1.6))); rm.rotation.x = Math.PI / 2; }
      }
    }
  });
  const n = Array.from({ length: COUNT }, (_, i) => i);
  const put = (list: keyof typeof items.current, i: number) => (el: Mesh | null) => { if (el) (items.current[list] as Mesh[])[i] = el; };
  return (
    <group ref={root}>
      {n.map(i => <mesh key={`g${i}`} ref={put('ghost', i)} geometry={geometry.ghost} material={mats.ghost} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`c${i}`} ref={put('change', i)} geometry={geometry.beam} material={mats.change} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`e${i}`} ref={put('est', i)} geometry={geometry.ghost} material={mats.estimate} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`h${i}`} ref={put('halo', i)} geometry={geometry.halo} material={mats.halo} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`o${i}`} ref={put('obs', i)} geometry={geometry.ghost} material={mats.observed} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`x${i}`} ref={put('err', i)} geometry={geometry.beam} material={mats.change} visible={false} frustumCulled={false} />)}
      {n.map(i => <mesh key={`r${i}`} ref={put('ring', i)} geometry={geometry.ring} material={mats.withheld} visible={false} frustumCulled={false} />)}
      {n.map(i => (
        <group key={`d${i}`}>
          {Array.from({ length: 10 }, (_, k) => <mesh key={k} ref={el => { if (el) (items.current.dots[i] ??= [])[k] = el; }} geometry={geometry.dot} material={mats.estimate} visible={false} frustumCulled={false} />)}
        </group>
      ))}
    </group>
  );
}
