import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CustomBlending, DoubleSide, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, OneFactor, OneMinusSrcAlphaFactor,
  PlaneGeometry, RingGeometry, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { CommandSnapshot } from '../session';
import type { Entity } from '../world';
import { buildEnvelope } from './envelope';
import type { P3 } from './envelope';
import { ghostMaterial, instantiate, loadTemplate, setMaterial } from './models';
import type { Instance } from './models';
import { PathLine } from './pathLine';
import { boost } from './entities';
import type { MarkPool } from './marks';
import type { AtlasView } from './sceneApi';
import type { GhostBaymaxState } from './baymaxActors';

/** Everything ATLAS draws about the FUTURE and about selection, from `snapshot.forecast` and `snapshot.encounter` only (the same samples the planner and
 * the Dimension use; there is no second estimator here). It is imperative and allocation-free in steady state: lines and the envelope are written in place. */

const C = { lilac: '#f0b4f4', orchid: '#e467e6', trail: '#cdb8ff', path: '#f59bf6', route: '#ffd2fa', routeHalo: '#e04ce0', amber: '#ffb35c', cobalt: '#1d3bd6', violet: '#8a3fe0' };

// ---------- ring / reticle quad ----------
const RING_V = `varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_F = `
uniform vec3 uColor; uniform float uAlpha, uStyle, uTime; varying vec2 vUv;
void main() {
  float r = length(vUv);
  float ring = smoothstep(0.80, 0.85, r) * (1.0 - smoothstep(0.90, 0.95, r));
  float glow = exp(-abs(r - 0.875) * 9.0) * 0.45;
  float shadow = exp(-abs(r - 0.935) * 16.0) * 0.4;
  float a = atan(vUv.y, vUv.x) + uTime * 0.25;
  float tick = uStyle > 0.5 ? smoothstep(0.93, 1.0, abs(cos(a * 2.0))) * smoothstep(0.62, 0.78, r) * (1.0 - smoothstep(0.98, 1.0, r)) : 0.0;
  float arcs = uStyle < 0.5 ? 0.55 + 0.45 * smoothstep(-0.2, 0.6, sin(a * 3.0)) : 1.0;
  float core = (ring * arcs + tick);
  vec3 col = uColor * (core + glow) + vec3(0.02, 0.02, 0.12) * shadow;
  float alpha = clamp(core + glow * 0.8 + shadow * 0.7, 0.0, 1.0) * uAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col * uAlpha, alpha);
}`;
class RingQuad {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  constructor(color: string, style: number) {
    this.material = new ShaderMaterial({
      vertexShader: RING_V, fragmentShader: RING_F, transparent: true, depthWrite: false, depthTest: false, fog: false,
      blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor,
      uniforms: { uColor: { value: new Color(color) }, uAlpha: { value: 1 }, uStyle: { value: style }, uTime: { value: 0 } },
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material); this.mesh.renderOrder = 8; this.mesh.frustumCulled = false; this.mesh.visible = false;
  }
  place(camera: PerspectiveCamera, p: Vector3 | null, size: number, alpha: number, time: number): void {
    this.mesh.visible = !!p && alpha > 0.01;
    if (!p) return;
    this.mesh.position.copy(p); this.mesh.quaternion.copy(camera.quaternion); this.mesh.scale.setScalar(size);
    this.material.uniforms.uAlpha!.value = alpha; this.material.uniforms.uTime!.value = time;
  }
  dispose(): void { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ---------- instanced dots ----------
class Dots {
  readonly mesh: InstancedMesh;
  private n = 0;
  private readonly m = new Matrix4();
  constructor(max: number, color: string, opacity: number, depthTest = true) {
    this.mesh = new InstancedMesh(new SphereGeometry(1, 10, 8), new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest, fog: false }), max);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 7; this.mesh.count = 0;
  }
  begin(): void { this.n = 0; }
  add(x: number, y: number, z: number, s: number): void { if (this.n >= this.mesh.instanceMatrix.count) return; this.m.makeScale(s, s, s).setPosition(x, y, z); this.mesh.setMatrixAt(this.n, this.m); this.n += 1; }
  end(): void { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; this.mesh.visible = this.n > 0; }
  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as MeshBasicMaterial).dispose(); this.mesh.dispose(); }
}

// ---------- translucent copies of an actual asset ----------
class GhostSlot {
  readonly group = new Group();
  private inst: Instance | null = null;
  private asset: string | null = null;
  private token = 0;
  constructor(private readonly base: string) { this.group.visible = false; }
  show(assetId: string | null, p: Vector3 | readonly number[], orientation: readonly number[] | null, scale: number, opacity: number): void {
    if (!assetId) { this.group.visible = false; return; }
    if (assetId !== this.asset) {
      this.asset = assetId; this.token += 1; const t = this.token;
      this.inst?.root.removeFromParent(); this.inst = null;
      void loadTemplate(assetId, this.base).then(tp => { if (!tp || t !== this.token) return; this.inst = instantiate(tp); this.group.add(this.inst.root); this.applied = ''; });
    }
    this.group.visible = true;
    const x = (p as readonly number[])[0]!, y = (p as readonly number[])[1]!, z = (p as readonly number[])[2]!;
    this.group.position.set(x, y, z);
    if (orientation) this.group.quaternion.set(orientation[0]!, orientation[1]!, orientation[2]!, orientation[3]!);
    this.group.scale.setScalar(scale);
    const key = opacity.toFixed(2);
    if (this.inst && this.applied !== key) { setMaterial(this.inst, ghostMaterial(new Color(C.lilac), opacity)); this.applied = key; }
  }
  private applied = '';
  hide(): void { this.group.visible = false; }
}

const MAX_TRAIL = 80, MAX_FUTURE = 40, GHOSTS = 4;
const rel = (t: number, now: number) => `T + ${Math.max(0, t - now).toFixed(1)} s`;

export interface OverlayAnchors { readonly entities: Map<string, Vector3>; readonly extents: Map<string, number>; baymax: Vector3; scale: number; meeting: Vector3 | null; ghost: Vector3 | null }
export interface OverlayContext {
  readonly camera: PerspectiveCamera; readonly dt: number; readonly time: number; readonly wall: number; readonly view: AtlasView; readonly width: number; readonly height: number;
  readonly hoverId: string | null; readonly baymaxYaw: number; readonly ghostBaymax: GhostBaymaxState;
}

export class OverlayLayer {
  readonly root = new Group();
  private readonly trail = new PathLine({ color: C.trail, width: 2.0, opacity: 0.7, halo: 6, haloOpacity: 0.1 });
  private readonly forecastLine = new PathLine({ color: C.path, width: 2.6, opacity: 0.95, halo: 8, haloOpacity: 0.18, dash: [2.4, 1.5] });
  private readonly routeLine = new PathLine({ color: C.route, width: 3, opacity: 0.95, halo: 10, haloOpacity: 0.22, depthTest: false });
  private readonly planLine = new PathLine({ color: C.route, width: 3, opacity: 0.9, halo: 10, haloOpacity: 0.2, dash: [2.6, 1.6], depthTest: false });
  private readonly aimLine = new PathLine({ color: C.amber, width: 1.6, opacity: 0.8, dash: [0.9, 0.8], depthTest: false });
  private readonly trailDots = new Dots(MAX_TRAIL, C.trail, 0.85);
  private readonly ticks = new Dots(16, '#ffe3ff', 0.95);
  private readonly waypoints = new Dots(16, C.route, 0.95, false);
  private readonly frozen = new Dots(24, C.lilac, 0.9, false);
  private readonly envelope: Mesh;
  private readonly envPos = new Float32Array(MAX_FUTURE * 10 * 3);
  private readonly envIdx = new Uint16Array((MAX_FUTURE - 1) * 10 * 6);
  private readonly envPts: P3[] = Array.from({ length: MAX_FUTURE }, () => [0, 0, 0] as P3);
  private readonly envRad: number[] = new Array<number>(MAX_FUTURE).fill(0);
  private readonly ghosts: GhostSlot[];
  private readonly selRing = new RingQuad('#ffd6ff', 0);
  private readonly hoverRing = new RingQuad('#cdd3ff', 0);
  private readonly rdv = new RingQuad(C.amber, 1);
  private readonly approach = new RingQuad(C.lilac, 0);
  private readonly scan = new Mesh(new RingGeometry(0.992, 1, 96), new MeshBasicMaterial({ color: C.lilac, side: DoubleSide, transparent: true, opacity: 0.2, depthWrite: false, fog: false }));
  private readonly sensor = new Mesh(new RingGeometry(0.994, 1, 96), new MeshBasicMaterial({ color: C.cobalt, side: DoubleSide, transparent: true, opacity: 0.35, depthWrite: false, fog: false }));
  private readonly pulses = Array.from({ length: 6 }, () => new Mesh(new RingGeometry(0.985, 1, 64), new MeshBasicMaterial({ color: C.orchid, side: DoubleSide, transparent: true, opacity: 0, depthWrite: false, fog: false })));
  private readonly evalLines: LineSegments;
  private readonly fields = Array.from({ length: 4 }, () => new Mesh(new SphereGeometry(1, 28, 18), new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false, depthTest: true,
    uniforms: { uI: { value: 0.5 }, uT: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uI, uT; varying vec3 vN; varying vec3 vV; void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.5); gl_FragColor = vec4(vec3(0.9, 0.3, 0.9) * f * uI, 0.03 * uI + f * 0.22 * uI); }',
  })));
  private readonly tmp = { a: new Vector3(), b: new Vector3(), c: new Vector3() };
  private readonly tick = { v: 0 };

  constructor(base: string) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.envPos, 3)); g.setIndex(new BufferAttribute(this.envIdx, 1)); g.setDrawRange(0, 0);
    this.envelope = new Mesh(g, new ShaderMaterial({
      transparent: true, depthWrite: false, side: DoubleSide, fog: false, uniforms: { uOpacity: { value: 0.1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uOpacity; varying vec3 vN; varying vec3 vV; void main() { gl_FragColor = vec4(0.86, 0.45, 0.98, uOpacity); }',
    }));
    this.envelope.frustumCulled = false; this.envelope.renderOrder = 4; this.envelope.visible = false;
    this.ghosts = Array.from({ length: GHOSTS }, () => new GhostSlot(base));
    const eg = new BufferGeometry(); eg.setAttribute('position', new BufferAttribute(new Float32Array(8 * 6), 3));
    this.evalLines = new LineSegments(eg, new LineBasicMaterial({ color: C.amber, transparent: true, opacity: 0.85, depthTest: false, fog: false })); this.evalLines.frustumCulled = false; this.evalLines.renderOrder = 7;
    for (const m of [this.scan, this.sensor]) { m.rotation.x = -Math.PI / 2; m.visible = false; m.frustumCulled = false; }
    for (const m of this.pulses) { m.rotation.x = -Math.PI / 2; m.visible = false; m.frustumCulled = false; }
    this.root.add(this.scan, this.sensor, ...this.pulses, ...this.fields, this.envelope, this.trail.root, this.forecastLine.root, this.routeLine.root, this.planLine.root, this.aimLine.root,
      this.trailDots.mesh, this.ticks.mesh, this.waypoints.mesh, this.frozen.mesh, this.evalLines, ...this.ghosts.map(s => s.group),
      this.selRing.mesh, this.hoverRing.mesh, this.rdv.mesh, this.approach.mesh);
  }

  update(snap: CommandSnapshot, a: OverlayAnchors, marks: MarkPool, ctx: OverlayContext): void {
    const { camera, view, time } = ctx;
    const lines = [this.trail, this.forecastLine, this.routeLine, this.planLine, this.aimLine];
    for (const l of lines) l.setResolution(ctx.width, ctx.height);
    const bx = a.baymax;
    const unit = Math.max(0.8, a.scale / 60);                 // world size of small markers at this zoom
    const entity = (id: string | null): Entity | null => (id ? snap.entities.find(e => e.id === id) ?? null : null);
    const sel = entity(snap.selectedId);
    const now = snap.simTime;
    const fc = snap.forecast, enc = snap.encounter;
    const pushOutline = (id: string | null) => (id ? a.entities.get(id) ?? null : null);

    // ----- scan rings and pulses (restrained: they say "what Baymax's sensors cover") -----
    const range = snap.link.scanRange ?? 45, sensor = snap.link.sensorRange ?? 60;
    this.scan.position.copy(bx); this.scan.scale.setScalar(range); this.scan.visible = snap.connected;
    this.sensor.position.copy(bx); this.sensor.scale.setScalar(sensor); this.sensor.visible = snap.connected;
    this.pulses.forEach((m, i) => {
      const p = snap.pulses[snap.pulses.length - 1 - i];
      const age = p ? (ctx.wall - p.atWall) / 1600 : 2;
      if (!p || age > 1) { m.visible = false; return; }
      m.visible = true; m.position.set(p.origin[0], p.origin[1], p.origin[2]);
      m.scale.setScalar(Math.max(1, p.range * (1 - (1 - age) ** 3))); (m.material as MeshBasicMaterial).opacity = 0.5 * (1 - age);
    });

    // ----- disturbance fields -----
    this.fields.forEach((f, i) => {
      const d = snap.fields[i];
      if (!d) { f.visible = false; return; }
      f.visible = true; f.position.set(d.position[0], d.position[1], d.position[2]); f.scale.setScalar(d.radius * (0.94 + 0.06 * Math.sin(ctx.wall / 600 + i)));
      (f.material as ShaderMaterial).uniforms.uI!.value = (view === 'tactical' ? 0.5 : 0.25) * (0.5 + 0.5 * d.intensity);
    });

    // ----- the selected target: observed history, forecast path, uncertainty, ghosts -----
    const targetAsset = sel?.assetId ?? enc?.assetId ?? null;
    const target = sel ?? entity(enc?.entityId ?? null);
    const trailSrc = fc?.trail ?? enc?.targetTrail ?? [];
    const futureSrc = fc?.future ?? enc?.targetFuture ?? [];
    const showTrail = !!target && trailSrc.length > 1;
    const trailAlpha = view === 'predict' ? 0.75 : view === 'route' ? 0.5 : 0.35;
    if (showTrail) {
      const n = Math.min(trailSrc.length, MAX_TRAIL), off = trailSrc.length - n;
      this.trail.set(n, (i, o) => { const p = trailSrc[off + i]!.position; o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; });
      this.trail.setOpacity(trailAlpha);
      this.trailDots.begin();
      if (view !== 'tactical') for (let i = 0; i < n; i += n > 40 ? 2 : 1) { const p = trailSrc[off + i]!.position; this.trailDots.add(p[0], p[1], p[2], 0.12 * unit * (0.5 + (i / n) * 0.7)); }
      this.trailDots.end();
    } else { this.trail.hide(); this.trailDots.begin(); this.trailDots.end(); }

    const showFuture = !!target && futureSrc.length > 1 && (view !== 'tactical' || !!fc);
    this.ticks.begin();
    if (showFuture) {
      const n = Math.min(futureSrc.length, 64);
      this.forecastLine.set(n, (i, o) => { const p = futureSrc[i]!.position; o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; });
      this.forecastLine.setOpacity(view === 'tactical' ? 0.55 : 1);
      // Time ticks along the path: every second (every two for long horizons), from the model itself.
      if (view !== 'tactical') {
        const t0 = futureSrc[0]!.t, t1 = futureSrc[futureSrc.length - 1]!.t, step = t1 - t0 > 10 ? 2 : 1;
        const sampleAt = (t: number) => (fc ? fc.at(t) : enc!.targetAt(t));
        for (let t = Math.ceil((t0 + 0.01) / step) * step; t <= t1 + 1e-6; t += step) { const p = sampleAt(t).position; this.ticks.add(p[0], p[1], p[2], 0.26 * unit); }
      }
    } else this.forecastLine.hide();
    this.ticks.end();

    // Uncertainty envelope: radius = the estimator's own stated uncertainty at each sample.
    const showEnv = showFuture && (view === 'predict' || view === 'route');
    if (showEnv) {
      const n = Math.min(futureSrc.length, MAX_FUTURE), pts = this.envPts, rad = this.envRad;
      for (let i = 0; i < n; i += 1) { const p = futureSrc[i]!.position, q = pts[i] as [number, number, number]; q[0] = p[0]; q[1] = p[1]; q[2] = p[2]; rad[i] = Math.min(18, futureSrc[i]!.uncertainty); }
      const m = buildEnvelope(pts, rad, 10, { positions: this.envPos, indices: this.envIdx }, n);
      (this.envelope.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true; this.envelope.geometry.index!.needsUpdate = true;
      this.envelope.geometry.setDrawRange(0, (m.rings - 1) * m.sides * 6);
      (this.envelope.material as ShaderMaterial).uniforms.uOpacity!.value = view === 'predict' ? 0.12 : 0.07;
      this.envelope.visible = true;
    } else this.envelope.visible = false;

    // ----- ghosts (translucent copies of the SAME asset) -----
    let g = 0;
    const gscale = boost(a.scale, 70, 3.2);
    let ghostPos: Vector3 | null = null;
    marks.begin();
    if (target && fc && view === 'predict') {
      const last = fc.future[fc.future.length - 1]!.t;
      const tg = Math.max(fc.now, Math.min(last, snap.scrubTime ?? enc?.arrivalTime ?? fc.now + snap.horizon));
      const p = fc.at(tg);
      ghostPos = this.tmp.a.set(p.position[0], p.position[1], p.position[2]);
      if (tg - fc.now > 0.6) this.ghosts[g++]!.show(targetAsset, ghostPos, target.orientation, gscale, 0.6);
      marks.add('ghost-scrub', `AT ${rel(tg, now).toUpperCase()}`, `±${p.uncertainty.toFixed(1)} m · forecast`, 'ghost', 1, p.position[0], p.position[1] + Math.max(1.2, (target.radius) * gscale) + 0.6, p.position[2]);
      const cur = pushOutline(target.id);
      if (cur) marks.add('target-now', target.label.toUpperCase(), 'NOW · observed', 'target', 1, cur.x, cur.y, cur.z, target.id);
    }
    if (enc && view === 'route') {
      const cur = pushOutline(enc.entityId);
      if (cur) marks.add('target-now', enc.label.toUpperCase(), 'NOW · observed', 'target', 1, cur.x, cur.y, cur.z, enc.entityId);
      if (enc.moving) {
        const times = enc.ghostTimes;
        for (let i = 0; i < times.length && g < GHOSTS; i += 1) {
          const t = times[i]!, p = enc.targetAt(t), last = i === times.length - 1;
          this.tmp.b.set(p.position[0], p.position[1], p.position[2]);
          this.ghosts[g++]!.show(targetAsset, this.tmp.b, target?.orientation ?? null, gscale, last ? 0.5 : 0.3 + 0.07 * i);
          if (!last || !enc.converged) marks.add(`ghost-${i}`, `AT ${rel(t, now).toUpperCase()}`, last ? 'target at arrival' : '', 'ghost', last ? 1 : 2, p.position[0], p.position[1] + Math.max(1.2, (target?.radius ?? 1) * gscale) + 0.6, p.position[2]);
          if (last) ghostPos = this.tmp.a.copy(this.tmp.b);
        }
      }
    }
    for (; g < GHOSTS; g += 1) this.ghosts[g]!.hide();

    // ----- route (planned, dashed; or the one sent to Baymax, solid), Baymax at arrival, the rendezvous -----
    const route = snap.route, plan = snap.plan;
    const active = !!route.command && (route.state === 'accepted' || route.state === 'sent');
    const wps = active ? route.command!.waypoints : plan?.status === 'ready' ? plan.waypoints : [];
    const idx = active ? route.nav?.activeIndex ?? 0 : 0;
    const showRoute = wps.length > 0 && !!snap.pose && (view === 'route' || active);
    this.waypoints.begin();
    if (showRoute) {
      const remaining = wps.length - idx, line = active ? this.routeLine : this.planLine, other = active ? this.planLine : this.routeLine;
      line.set(remaining + 1, (i, o) => { if (i === 0) { o[0] = bx.x; o[1] = bx.y; o[2] = bx.z; } else { const p = wps[idx + i - 1]!.position; o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; } });
      other.hide();
      for (let i = idx; i < wps.length - 1; i += 1) { const p = wps[i]!.position; this.waypoints.add(p[0], p[1], p[2], 0.34 * unit); }
    } else { this.routeLine.hide(); this.planLine.hide(); }
    this.waypoints.end();

    // Baymax at his planned arrival, and the rendezvous / aim / approach marker.
    const gb = ctx.ghostBaymax;
    let rdvPos: Vector3 | null = null, approachPos: Vector3 | null = null;
    this.aimLine.hide();
    if (enc && (view === 'route' || view === 'predict') && showRoute) {
      const e = enc.baymaxAtArrival;
      const r = enc.route;
      const a1 = r[Math.max(0, r.length - 2)]!.position;
      const yaw = Math.hypot(e[0] - a1[0], e[2] - a1[2]) > 0.05 ? Math.atan2(-(e[0] - a1[0]), -(e[2] - a1[2])) : ctx.baymaxYaw;
      if (view === 'route') {
        gb.visible = true; gb.x = e[0]; gb.y = e[1]; gb.z = e[2]; gb.yaw = yaw;
        marks.add('baymax-ghost', 'BAYMAX', rel(enc.arrivalTime, now).toUpperCase(), 'baymax', 2, e[0], e[1] + 2.1 * boost(a.scale, 18, 4.2), e[2]);
        if (enc.moving) {
          rdvPos = this.tmp.c.set(e[0], e[1], e[2]);
          if (enc.converged) marks.add('rendezvous', 'PLANNED RENDEZVOUS', rel(enc.arrivalTime, now).toUpperCase(), 'rendezvous', 1, e[0], e[1] - 1.5 * unit, e[2]);
          else {
            marks.add('rendezvous', 'AIM POINT', `${enc.gap.toFixed(1)} m gap · ${rel(enc.arrivalTime, now).toUpperCase()}`, 'warning', 1, e[0], e[1] - 1.5 * unit, e[2]);
            const t = enc.targetAtArrival.position;
            this.aimLine.set(2, (i, o) => { const p = i === 0 ? e : t; o[0] = p[0]; o[1] = p[1]; o[2] = p[2]; });
          }
        } else {
          approachPos = this.tmp.c.set(e[0], e[1], e[2]);
          marks.add('approach', 'APPROACH POINT', rel(enc.arrivalTime, now).toUpperCase(), 'info', 1, e[0], e[1] - 1.5 * unit, e[2]);
        }
      } else gb.visible = false;
    } else gb.visible = false;
    this.rdv.place(camera, rdvPos, Math.max(2.4, a.scale * 0.022), enc && enc.converged ? 0.9 : 0.6, time);
    this.approach.place(camera, approachPos, Math.max(2.2, a.scale * 0.02), 0.8, time);
    a.meeting = rdvPos ? (a.meeting ?? new Vector3()).copy(rdvPos) : null;
    a.ghost = ghostPos ? (a.ghost ?? new Vector3()).copy(ghostPos) : null;

    // ----- frozen forecasts and their measured errors -----
    this.frozen.begin();
    let ev = 0;
    const ep = this.evalLines.geometry.getAttribute('position') as BufferAttribute;
    if (target && view !== 'tactical') {
      for (const f of snap.forecasts) {
        const e = snap.evaluations.get(f.id);
        if (e && ev < 8) { ep.setXYZ(ev * 2, f.position[0], f.position[1], f.position[2]); ep.setXYZ(ev * 2 + 1, e.observed[0], e.observed[1], e.observed[2]); ev += 1; this.frozen.add(e.observed[0], e.observed[1], e.observed[2], 0.2 * unit); }
        if (!e && f.targetTime > now - 1) this.frozen.add(f.position[0], f.position[1], f.position[2], 0.3 * unit);
        if (e || f.targetTime > now - 1) this.frozen.add(f.position[0], f.position[1], f.position[2], 0.22 * unit);
      }
    }
    ep.needsUpdate = true; this.evalLines.geometry.setDrawRange(0, ev * 2); this.evalLines.visible = ev > 0;
    this.frozen.end();

    // ----- selection and hover: a luminous ring, never a filled disc -----
    const selPos = sel ? a.entities.get(sel.id) ?? null : null;
    const ext = (id: string) => Math.max(1.6, (a.extents.get(id) ?? 1.5) * 1.35);
    this.selRing.place(camera, selPos, sel ? ext(sel.id) * (1 + 0.025 * Math.sin(time * 2.4)) : 1, 0.95, time);
    const hov = ctx.hoverId && ctx.hoverId !== snap.selectedId ? a.entities.get(ctx.hoverId) ?? null : null;
    this.hoverRing.place(camera, hov, hov ? ext(ctx.hoverId!) : 1, 0.7, time);
    void this.tick;
  }

  dispose(): void {
    for (const l of [this.trail, this.forecastLine, this.routeLine, this.planLine, this.aimLine]) l.dispose();
    for (const d of [this.trailDots, this.ticks, this.waypoints, this.frozen]) d.dispose();
    for (const r of [this.selRing, this.hoverRing, this.rdv, this.approach]) r.dispose();
    this.envelope.geometry.dispose(); (this.envelope.material as ShaderMaterial).dispose();
    for (const m of [this.scan, this.sensor, ...this.pulses]) { m.geometry.dispose(); (m.material as MeshBasicMaterial).dispose(); }
    for (const f of this.fields) { f.geometry.dispose(); (f.material as ShaderMaterial).dispose(); }
    this.evalLines.geometry.dispose(); (this.evalLines.material as LineBasicMaterial).dispose();
  }
}
