import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion,
  ShaderMaterial, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import { createIslandForm } from '../../scene/islandProxy';
import { PALETTE } from '../../scene/palette';
import type { IslandForm } from '../../scene/islandProxy';
import type { OverlayData } from '../presentation';
import type { Vec3 } from '../types';

/** The mathematical layer, drawn into the same world. One visual identity per meaning (no abstract symbols):
 *   dim dots           historical observations (what the sensor reported)
 *   lilac curve        the fitted motion model: solid through the past, brighter into the future
 *   translucent island the same island at an ESTIMATED position;  hollow ring = where "it stays put" would have put it;  warm bead = the later measurement
 *   wire sphere        the keep-out radius for Baymax's centre around an estimated island
 *   amber dashes       the direct route;  white-lilac flowing light = the route ATLAS selected;  faint lavender = candidates it considered
 *   small lavender pin a waypoint of the selected route */

const C = {
  trail: new Color('#9a86d4'), fitPast: new Color('#f0b4f4'), fitFuture: new Color('#ffd9ff'), direct: new Color(PALETTE.amber), chosen: new Color('#fff0ff'), candidate: new Color('#a98bff'),
  baymaxTrail: new Color('#cdbbff'), replaced: new Color('#ff9e6b'), ghost: new Color('#d9b3ff'), shell: new Color('#ffcf94'), bound: new Color('#b48cff'), way: new Color('#c9a8ff'), goal: new Color('#ff9de8'),
  measured: new Color('#fff2d2'), persistence: new Color('#c9c2ff'), link: new Color('#ffe0b0'),
};
const CAP = 420;
const wireMat = (c: Color, o: number) => new LineBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false });
const lineMat = (c: Color) => new LineBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false });
const twoPoint = () => { const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3)); return g; };

class Dots {
  /** Camera position, set each frame: dot size follows distance so the route reads at a steady apparent size. */
  static cam: Vector3 | null = null;
  readonly mesh: InstancedMesh;
  private n = 0;
  private readonly m = new Matrix4(); private readonly q = new Quaternion(); private readonly p = new Vector3(); private readonly s = new Vector3(); private readonly c = new Color();
  constructor(geo: BufferGeometry, mat: MeshBasicMaterial, capacity = CAP) {
    this.mesh = new InstancedMesh(geo, mat, capacity); this.mesh.count = 0; this.mesh.frustumCulled = false;
  }
  begin(): void { this.n = 0; }
  add(x: number, y: number, z: number, size: number, color: Color, k: number): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    const sk = Dots.cam ? Math.min(1.5, Math.max(0.45, Dots.cam.distanceTo(this.p.set(x, y, z)) / 50)) : 1;
    this.m.compose(this.p.set(x, y, z), this.q.identity(), this.s.setScalar(size * sk));
    this.mesh.setMatrixAt(this.n, this.m); this.mesh.setColorAt(this.n, this.c.copy(color).multiplyScalar(k)); this.n += 1;
  }
  /** Dots along a polyline, spacing in world units; `reveal` draws only the first fraction; `dash` leaves gaps. */
  path(pts: readonly Vec3[], spacing: number, size: number, color: Color, time: number, opts: { reveal?: number; dash?: number; flow?: number; k?: number } = {}): void {
    const reveal = opts.reveal ?? 1; const dash = opts.dash ?? 0; const k = opts.k ?? 1;
    let total = 0; for (let i = 1; i < pts.length; i += 1) total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1], pts[i]![2] - pts[i - 1]![2]);
    const limit = total * reveal; let acc = 0, next = 0, idx = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!, b = pts[i]!; const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      while (next <= acc + seg && next <= limit) {
        const f = seg === 0 ? 0 : (next - acc) / seg; idx += 1;
        if (!(dash > 0 && idx % (dash + 2) >= dash)) {
          const pulse = opts.flow ? 0.6 + 0.4 * Math.max(0, Math.sin(next * 0.45 - time * opts.flow)) : 1;
          this.add(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, size * (0.75 + 0.5 * pulse), color, k * (0.55 + 0.6 * pulse));
        }
        next += spacing;
      }
      acc += seg;
    }
  }
  end(): void { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
}

const GHOST_V = /* glsl */`varying vec3 vN; varying vec3 vW; varying vec3 vL; void main() { vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const GHOST_F = /* glsl */`uniform vec3 uCam, uColor; uniform float uAlpha, uTime; varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0); float lines = 0.5 + 0.5 * sin(vL.y * 4.5 - uTime * 0.9);
  gl_FragColor = vec4(uColor * (0.4 + f * 1.5 + lines * 0.14), uAlpha * (0.1 + f * 0.7)); }`;
const FRESNEL_F = /* glsl */`uniform vec3 uCam, uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() { vec3 V = normalize(uCam - vW); float f = pow(1.0 - abs(dot(normalize(vN), V)), 3.2); gl_FragColor = vec4(uColor * (0.5 + f * 1.4), uAlpha * (0.015 + f * 0.5)); }`;

function ringLines(): BufferGeometry {
  // Three great circles and two latitude rings of a unit sphere as separate loops, merged into line segments.
  const pos: number[] = []; const N = 72;
  const circle = (fn: (a: number) => [number, number, number]) => { for (let i = 0; i < N; i += 1) { const a = fn((i / N) * Math.PI * 2), b = fn(((i + 1) / N) * Math.PI * 2); pos.push(...a, ...b); } };
  circle(a => [Math.cos(a), 0, Math.sin(a)]); circle(a => [Math.cos(a), Math.sin(a), 0]); circle(a => [0, Math.cos(a), Math.sin(a)]);
  for (const h of [0.5, -0.5]) circle(a => [Math.cos(a) * Math.sqrt(1 - h * h), h, Math.sin(a) * Math.sqrt(1 - h * h)]);
  const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(pos, 3)); return g;
}

export function ChallengeOverlay3D({ overlayRef, primaryId }: { readonly overlayRef: { current: OverlayData }; readonly primaryId: string }) {
  const form = useMemo<IslandForm>(() => createIslandForm(primaryId, 14), [primaryId]);
  const res = useMemo(() => {
    const dotGeo = new SphereGeometry(1, 6, 4);
    const mat = () => new MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false, opacity: 0.95 });
    const dots = { trail: [new Dots(dotGeo, mat()), new Dots(dotGeo, mat())], fitPast: new Dots(dotGeo, mat()), fitFuture: new Dots(dotGeo, mat()), direct: new Dots(dotGeo, mat()), chosen: new Dots(dotGeo, mat(), 600), replaced: new Dots(dotGeo, mat()), baymax: new Dots(dotGeo, mat()), cand: [new Dots(dotGeo, mat()), new Dots(dotGeo, mat()), new Dots(dotGeo, mat())], pins: new Dots(dotGeo, mat(), 24), link: new Dots(dotGeo, mat(), 200) };
    const ghostMat = new ShaderMaterial({ vertexShader: GHOST_V, fragmentShader: GHOST_F, transparent: true, depthWrite: false, side: DoubleSide, uniforms: { uCam: { value: new Vector3() }, uColor: { value: C.ghost.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 } } });
    const ghostMat2 = ghostMat.clone();
    const sphereGeo = new SphereGeometry(1, 36, 18);
    const fres = () => new ShaderMaterial({ vertexShader: GHOST_V, fragmentShader: FRESNEL_F, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, uniforms: { uCam: { value: new Vector3() }, uColor: { value: C.bound.clone() }, uAlpha: { value: 0 } } });
    const halo = fres(), bounds = [fres(), fres()];
    const wire = ringLines();
    const ring = new TorusGeometry(1, 0.05, 8, 64);
    const linkGeo = twoPoint(), proofGeo = [twoPoint(), twoPoint()];
    const link = new Line(linkGeo, lineMat(C.link)); const proofLines = [new Line(proofGeo[0]!, lineMat(C.chosen)), new Line(proofGeo[1]!, lineMat(C.direct))];
    for (const l of [link, ...proofLines]) { l.frustumCulled = false; l.visible = false; }
    return { dotGeo, dots, ghostMat, ghostMat2, sphereGeo, halo, bounds, wire, ring, linkGeo, proofGeo, link, proofLines };
  }, []);
  const ref = useRef<{ ghost: Mesh | null; ghost2: Mesh | null; halo: Mesh | null; bound: (Mesh | null)[]; shellCritical: Object3D | null; shellBound: (Object3D | null)[]; persist: Mesh | null; measured: Mesh | null; goal: Mesh | null; criticalLink: Line | null; futureBaymax: Mesh | null; proofLines: (Line | null)[]; proofBeads: (Mesh | null)[] }>({ ghost: null, ghost2: null, halo: null, bound: [null, null], shellCritical: null, shellBound: [null, null], persist: null, measured: null, goal: null, criticalLink: null, futureBaymax: null, proofLines: [null, null], proofBeads: [null, null, null, null] });
  const mats = useMemo(() => ({
    pin: new MeshBasicMaterial({ color: C.way, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
    ring: new MeshBasicMaterial({ color: C.persistence, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
    measured: new MeshBasicMaterial({ color: C.measured, transparent: true, opacity: 1, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
    goal: new MeshBasicMaterial({ color: C.goal, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
    future: new MeshBasicMaterial({ color: C.baymaxTrail, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    proofD: new MeshBasicMaterial({ color: C.direct, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
    shellCrit: wireMat(C.shell, 0.55), shellBound: wireMat(C.bound, 0.22),
  }), []);
  useEffect(() => () => {
    res.dotGeo.dispose(); res.sphereGeo.dispose(); res.wire.dispose(); res.ring.dispose(); form.geometry.dispose(); res.linkGeo.dispose(); res.proofGeo.forEach(g => g.dispose());
    [res.link, ...res.proofLines].forEach(l => (l.material as LineBasicMaterial).dispose());
    [res.ghostMat, res.ghostMat2, res.halo, ...res.bounds].forEach(m => m.dispose());
    Object.values(mats).forEach(m => m.dispose());
    const all = [...res.dots.trail, res.dots.fitPast, res.dots.fitFuture, res.dots.direct, res.dots.chosen, res.dots.replaced, res.dots.baymax, ...res.dots.cand, res.dots.pins, res.dots.link];
    all.forEach(d => (d.mesh.material as MeshBasicMaterial).dispose());
  }, [res, mats, form]);

  useFrame(({ camera }) => {
    const o = overlayRef.current, t = o.clock, d = res.dots, r = ref.current;
    Dots.cam = camera.position;
    const set3 = (obj: Object3D | null, p: Vec3, s: number) => { if (obj) { obj.position.set(p[0], p[1], p[2]); obj.scale.setScalar(s); } };
    // Dot paths.
    o.trails.forEach((tr, i) => { const dd = d.trail[i]; if (!dd) return; dd.begin(); tr.points.forEach((p, k) => { if (k % 2 === 0 || k === tr.points.length - 1) dd.add(p[0], p[1], p[2], 0.17, C.trail, 0.5 + 0.5 * (k / tr.points.length)); }); dd.end(); });
    for (let i = o.trails.length; i < 2; i += 1) { d.trail[i]!.begin(); d.trail[i]!.end(); }
    d.fitPast.begin(); d.fitFuture.begin();
    for (const f of o.fits) { d.fitPast.path(f.past, 0.5, 0.11, C.fitPast, t, { k: 0.8 }); d.fitFuture.path(f.future, 0.38, 0.17, C.fitFuture, t, { flow: 2.2 }); }
    d.fitPast.end(); d.fitFuture.end();
    d.direct.begin(); if (o.direct) d.direct.path([o.direct.from, o.direct.to], 0.95, o.direct.mode === 'map' ? 0.16 : 0.2, C.direct, t, { dash: 3, k: o.direct.mode === 'map' ? 0.8 : 1 }); d.direct.end();
    d.chosen.begin(); if (o.chosen) d.chosen.path(o.chosen, 0.55, 0.2, C.chosen, t, { flow: 3.2, reveal: 1 }); d.chosen.end();
    d.replaced.begin(); if (o.replaced) d.replaced.path(o.replaced.points, 0.8, 0.17, C.replaced, t, { dash: 2, k: o.replaced.fade }); d.replaced.end();
    d.baymax.begin(); d.baymax.path(o.baymaxTrail as Vec3[], 0.9, 0.1, C.baymaxTrail, t, { k: 0.7 }); d.baymax.end();
    d.cand.forEach((c, i) => { c.begin(); const pts = o.candidates[i]; if (pts) c.path(pts, 0.8, 0.12, C.candidate, t, { reveal: o.candidateReveal, k: 0.55 }); c.end(); });
    d.pins.begin(); d.pins.end();

    // Ghosts and halos.
    const forecast = o.ghosts.find(g => g.kind === 'forecast'), critical = o.ghosts.find(g => g.kind === 'critical');
    const g1 = r.ghost, g2 = r.ghost2;
    for (const [mesh, ghost, mat] of [[g1, forecast, res.ghostMat], [g2, critical, res.ghostMat2]] as const) {
      if (!mesh) continue;
      mesh.visible = !!ghost; if (!ghost) continue;
      mesh.position.set(ghost.position[0], ghost.position[1], ghost.position[2]);
      mat.uniforms.uAlpha!.value = 0.55; mat.uniforms.uTime!.value = t; (mat.uniforms.uCam!.value as Vector3).copy(camera.position);
    }
    if (r.halo) { r.halo.visible = !!forecast; if (forecast) { set3(r.halo, forecast.position, forecast.radius); (res.halo.uniforms.uCam!.value as Vector3).copy(camera.position); res.halo.uniforms.uAlpha!.value = 0.9; } }
    if (r.persist) { r.persist.visible = !!o.persistence; if (o.persistence) { set3(r.persist, o.persistence.position, 0.9); r.persist.quaternion.copy(camera.quaternion); } }
    if (r.measured) { r.measured.visible = !!o.measured; if (o.measured) { set3(r.measured, o.measured.position, 0.42 + 0.06 * Math.sin(t * 3)); } }
    // Keep-out shell and the link between the estimated island and where Baymax would be.
    if (r.shellCritical) { r.shellCritical.visible = !!o.critical; if (o.critical) set3(r.shellCritical, o.critical.obstacle, o.critical.shell); }
    if (r.futureBaymax) { r.futureBaymax.visible = !!o.critical; if (o.critical) set3(r.futureBaymax, o.critical.baymax, 0.9); }
    if (r.criticalLink) {
      r.criticalLink.visible = !!o.critical;
      if (o.critical) { const a = res.linkGeo.getAttribute('position'); a.setXYZ(0, ...o.critical.obstacle); a.setXYZ(1, ...o.critical.baymax); a.needsUpdate = true; }
    }
    // Obstacle bounds (nominal) around observed islands.
    for (let i = 0; i < 2; i += 1) {
      const b = o.bounds[i], m = r.bound[i], w = r.shellBound[i];
      if (m) { m.visible = !!b; if (b) { set3(m, b.position, b.radius); (res.bounds[i]!.uniforms.uCam!.value as Vector3).copy(camera.position); res.bounds[i]!.uniforms.uAlpha!.value = 0.55; } }
      if (w) { w.visible = !!b; if (b) set3(w, b.position, b.radius); }
    }
    // Goal beacon.
    const goalSeen = o.scanItems.some(i => i.kind === 'capsule_shell_remnant' && o.clock >= i.revealAt + 1.2);
    if (r.goal) { r.goal.visible = goalSeen; set3(r.goal, [o.goal[0], o.goal[1], o.goal[2]], 3.6 + 0.35 * Math.sin(t * 1.6)); r.goal.quaternion.copy(camera.quaternion); }
    // Waypoint pins.
    d.pins.begin();
    o.waypoints.forEach(w => d.pins.add(w[0], w[1], w[2], 0.55 + 0.08 * Math.sin(t * 2.4), C.way, 1.2));
    o.centres.forEach(c => d.pins.add(c.position[0], c.position[1], c.position[2], 0.34, C.chosen, 1.1));
    if (forecast) d.pins.add(forecast.position[0], forecast.position[1], forecast.position[2], 0.4, C.fitFuture, 1.4);
    d.pins.end();
    // Proof: the closest approaches, ATLAS's flown path against the direct line.
    r.proofLines.forEach((line, i) => {
      if (!line) return; const pr = o.proof; line.visible = !!pr;
      if (pr) { const c = i === 0 ? pr.atlasClosest : pr.directClosest; const a = res.proofGeo[i]!.getAttribute('position'); a.setXYZ(0, ...c.baymax); a.setXYZ(1, ...c.obstacle); a.needsUpdate = true; }
    });
    r.proofBeads.forEach((bead, i) => { if (!bead) return; const pr = o.proof; bead.visible = !!pr; if (pr) { const c = i < 2 ? pr.atlasClosest : pr.directClosest; set3(bead, i % 2 === 0 ? c.baymax : c.obstacle, i % 2 === 0 ? 0.4 : 0.55); } });
  });

  const R = ref.current;
  return (
    <group>
      {res.dots.trail.map((x, i) => <primitive key={`t${i}`} object={x.mesh} />)}
      <primitive object={res.dots.fitPast.mesh} /><primitive object={res.dots.fitFuture.mesh} /><primitive object={res.dots.direct.mesh} /><primitive object={res.dots.chosen.mesh} />
      <primitive object={res.dots.replaced.mesh} /><primitive object={res.dots.baymax.mesh} />
      {res.dots.cand.map((x, i) => <primitive key={`c${i}`} object={x.mesh} />)}
      <primitive object={res.dots.pins.mesh} />
      <mesh ref={el => { R.ghost = el; }} geometry={form.geometry} material={res.ghostMat} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.ghost2 = el; }} geometry={form.geometry} material={res.ghostMat2} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.halo = el; }} geometry={res.sphereGeo} material={res.halo} visible={false} frustumCulled={false} />
      {[0, 1].map(i => <mesh key={`b${i}`} ref={el => { R.bound[i] = el; }} geometry={res.sphereGeo} material={res.bounds[i]!} visible={false} frustumCulled={false} />)}
      {[0, 1].map(i => <lineSegments key={`w${i}`} ref={el => { R.shellBound[i] = el; }} geometry={res.wire} material={mats.shellBound} visible={false} frustumCulled={false} />)}
      <lineSegments ref={el => { R.shellCritical = el; }} geometry={res.wire} material={mats.shellCrit} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.persist = el; }} geometry={res.ring} material={mats.ring} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.measured = el; }} geometry={res.sphereGeo} material={mats.measured} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.goal = el; }} geometry={res.ring} material={mats.goal} visible={false} frustumCulled={false} />
      <mesh ref={el => { R.futureBaymax = el; }} geometry={res.sphereGeo} material={mats.future} visible={false} frustumCulled={false} />
      <primitive object={res.link} ref={(el: Line | null) => { R.criticalLink = el; }} />
      {res.proofLines.map((l, i) => <primitive key={`p${i}`} object={l} ref={(el: Line | null) => { R.proofLines[i] = el; }} />)}
      {[0, 1, 2, 3].map(i => <mesh key={`pb${i}`} ref={el => { R.proofBeads[i] = el; }} geometry={res.sphereGeo} material={i < 2 ? mats.measured : mats.proofD} visible={false} frustumCulled={false} />)}
    </group>
  );
}

