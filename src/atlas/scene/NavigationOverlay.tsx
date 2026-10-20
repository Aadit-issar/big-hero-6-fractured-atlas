import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, OctahedronGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import type { SceneModel } from './sceneModel';
import { PALETTE } from './palette';

const CAPACITY = 320;
const COLOR = {
  fold: new Color(PALETTE.orchid), approach: new Color('#c9b3ff'), track: new Color('#f3e2ff'), caution: new Color(PALETTE.amber), remembered: new Color('#8f78d8'),
};

/** Navigation guidance drawn into the scene. Segment style encodes the evidence class: bright fold arcs for a fold the sensor reports open,
 * dim for a remembered fold, soft dotted lines for unverified free flight (amber where a limitation is known), firmer dots along recorded
 * observer movement. Nothing is drawn beyond known places, and the observation target is a ring, never a path into unknown space. */
export function NavigationOverlay({ modelRef }: { readonly modelRef: { current: SceneModel } }) {
  const dots = useRef<InstancedMesh>(null);
  const markers = useRef<(Mesh | null)[]>([]);
  const target = useRef<{ ring: Mesh | null; core: Mesh | null }>({ ring: null, core: null });
  const geo = useMemo(() => ({ dot: new SphereGeometry(0.2, 8, 6), oct: new OctahedronGeometry(1, 0), ring: new TorusGeometry(1, 0.045, 8, 56) }), []);
  const mat = useMemo(() => ({
    dots: new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, opacity: 0.95 }),
    marker: new MeshBasicMaterial({ color: '#d9c6ff', transparent: true, opacity: 0.85, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    goal: new MeshBasicMaterial({ color: new Color(PALETTE.magenta), transparent: true, opacity: 0.9, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    ring: new MeshBasicMaterial({ color: '#f3e2ff', transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    core: new MeshBasicMaterial({ color: new Color(PALETTE.amber), transparent: true, opacity: 0.9, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
  }), []);
  useEffect(() => () => { Object.values(geo).forEach(g => g.dispose()); Object.values(mat).forEach(m => m.dispose()); }, [geo, mat]);
  const scratch = useMemo(() => ({ m: new Matrix4(), q: new Quaternion(), p: new Vector3(), s: new Vector3(), c: new Color() }), []);

  useFrame(({ camera }) => {
    const model = modelRef.current, nav = model.navigation, mesh = dots.current;
    if (!mesh) return;
    const { m, q, p, s, c } = scratch;
    let n = 0;
    if (nav) {
      for (const seg of nav.segments) {
        const len = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1], seg.to[2] - seg.from[2]);
        const count = Math.min(44, Math.max(5, Math.round(len / (seg.kind === 'fold' ? 1.4 : 2.4))));
        const base = seg.kind === 'fold' ? (seg.remembered ? COLOR.remembered : COLOR.fold) : seg.caution ? COLOR.caution : seg.kind === 'track' ? COLOR.track : COLOR.approach;
        for (let i = 0; i <= count && n < CAPACITY; i += 1) {
          const t = i / count;
          // A flow of light along the route; frozen with the presentation clock when paused.
          const pulse = 0.55 + 0.45 * Math.max(0, Math.sin(i * 0.55 - model.time * 2.6));
          // Fold arcs bow upward so a transition reads as a different kind of connection from a straight approach.
          const lift = seg.kind === 'fold' ? Math.sin(t * Math.PI) * Math.min(6, len * 0.12) : 0;
          p.set(seg.from[0] + (seg.to[0] - seg.from[0]) * t, seg.from[1] + (seg.to[1] - seg.from[1]) * t + lift, seg.from[2] + (seg.to[2] - seg.from[2]) * t);
          const size = (seg.kind === 'fold' ? 2.6 : seg.kind === 'track' ? 2.0 : 1.5) * (0.7 + 0.6 * pulse);
          s.setScalar(size);
          m.compose(p, q.identity(), s);
          mesh.setMatrixAt(n, m);
          mesh.setColorAt(n, c.copy(base).multiplyScalar(seg.remembered ? 0.55 : 0.55 + 0.6 * pulse));
          n += 1;
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const pts = nav?.points ?? [];
    markers.current.forEach((mk, i) => {
      if (!mk) return;
      const pt = pts[i];
      mk.visible = !!pt;
      if (!pt) return;
      mk.position.set(pt.position[0], pt.position[1] + 1.2, pt.position[2]);
      mk.rotation.y = model.time * 0.8;
      mk.scale.setScalar(pt.kind === 'goal' ? 2.4 : pt.kind === 'fold' ? 1.5 : 1.2);
      mk.material = pt.kind === 'goal' ? mat.goal : mat.marker;
    });
    const t = nav?.target, tr = target.current;
    if (tr.ring && tr.core) {
      tr.ring.visible = tr.core.visible = !!t;
      if (t) {
        const pulse = 1 + 0.09 * Math.sin(model.time * 2.2);
        tr.ring.position.set(t.position[0], t.position[1], t.position[2]);
        tr.ring.quaternion.copy(camera.quaternion);
        tr.ring.scale.setScalar(2.6 * pulse);
        tr.core.position.copy(tr.ring.position);
        tr.core.scale.setScalar(0.55);
        tr.core.rotation.y = model.time;
        tr.core.material = t.action === 'follow-route' ? mat.marker : mat.core;
      }
    }
  });

  return (
    <group>
      <instancedMesh ref={dots} args={[geo.dot, mat.dots, CAPACITY]} frustumCulled={false} count={0} />
      {Array.from({ length: 10 }, (_, i) => <mesh key={i} ref={el => { markers.current[i] = el; }} geometry={geo.oct} material={mat.marker} visible={false} frustumCulled={false} />)}
      <mesh ref={el => { target.current.ring = el; }} geometry={geo.ring} material={mat.ring} visible={false} frustumCulled={false} />
      <mesh ref={el => { target.current.core = el; }} geometry={geo.oct} material={mat.core} visible={false} frustumCulled={false} />
    </group>
  );
}
