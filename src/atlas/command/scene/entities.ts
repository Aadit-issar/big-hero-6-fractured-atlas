import { AdditiveBlending, BufferGeometry, Color, CustomBlending, DoubleSide, Group, IcosahedronGeometry, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import type { Material } from 'three';
import { NOISE_GLSL } from '../../scene/palette';
import type { CommandSnapshot } from '../session';
import type { Entity } from '../world';
import { assetFileFor, instantiate, loadTemplate, setVariant, standardRock } from './models';
import type { Instance } from './models';
import { islandGeometry } from './islands';

/** The persistent things of the map: islands (the Dimension's own rock, same generator and material), scene objects (the same GLBs), and folds
 * (state-coloured dimensional tears). Imperative, one pass per frame over a Map: no per-frame React work and no allocation in steady state. */
export interface RockMaterials { readonly solid: Material; readonly dim: Material; readonly ghost: Material }

export const boost = (distance: number, divisor: number, max: number) => Math.max(1, Math.min(max, distance / divisor));

// ---------- fold tear ----------
const FOLD_V = /* glsl */`varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FOLD_F = /* glsl */`
uniform float uTime, uWidth, uGlow, uJitter, uMemory, uSeed, uDim, uSel;
uniform vec3 cDeep, cCobalt, cRim, cEdge;
varying vec2 vUv;
${NOISE_GLSL}
float n1(float x, float s) { return vnoise(vec3(x, s, 0.5)); }
void main() {
  vec2 p = vUv; float y = p.y;
  float jig = uJitter * (n1(y * 9.0 + uTime * 1.8, uSeed) - 0.5);
  float bend = sin(y * 2.3 + uSeed * 6.0) * 0.1 + (n1(y * 3.0, uSeed + 2.0) - 0.5) * 0.18 + jig * 0.35;
  float body = pow(max(1.0 - y * y, 0.0), 0.72);
  float jag = 1.0 + (n1(y * 8.0, uSeed + 5.0) - 0.5) * 1.1 + (n1(y * 21.0, uSeed + 9.0) - 0.5) * 0.55 + jig;
  float d = abs(p.x - bend) - uWidth * body * jag;
  float inside = 1.0 - smoothstep(-0.012, 0.012, d);
  vec2 q = p * vec2(1.2, 2.2);
  float f1 = fbm3(vec3(q * 2.2 + vec2(0.0, uTime * 0.05), uSeed));
  float f2 = fbm3(vec3(q * 5.0 - vec2(uTime * 0.04, 0.0) + f1, uSeed + 4.0));
  vec3 interior = mix(cDeep, cCobalt, smoothstep(0.35, 0.8, f1 * 0.6 + f2 * 0.6));
  interior += vec3(0.6, 0.3, 0.95) * pow(f2, 3.0) * 0.55;
  float dr = d + 0.012, db = d - 0.012;
  vec3 rim = vec3(exp(-abs(dr) * 55.0), exp(-abs(d) * 55.0), exp(-abs(db) * 55.0));
  float edgeFade = (1.0 - smoothstep(0.7, 1.0, abs(y))) * (1.0 - smoothstep(0.55, 1.0, abs(p.x)));
  float aura = exp(-max(d, 0.0) * 9.0) * (1.0 - inside) * edgeFade;
  rim *= edgeFade;
  float shimmer = 0.75 + 0.25 * n1(y * 13.0 - uTime * 2.2, uSeed + 12.0);
  float live = 1.0 - uMemory * 0.8;
  vec3 col = interior * inside;
  col += cEdge * rim * uGlow * shimmer * live * (1.0 + uSel * 0.5);
  col += cRim * aura * 0.42 * uGlow * live;
  col = mix(col, vec3(dot(col, vec3(0.333))) * vec3(0.62, 0.7, 1.15), uMemory * 0.8);
  col += vec3(0.55, 0.62, 1.0) * exp(-abs(d) * 70.0) * edgeFade * uMemory * 0.5;
  float a = clamp(inside * 0.96, 0.0, 1.0) * (1.0 - uMemory * 0.7);
  float recede = 1.0 - uDim * 0.82;
  gl_FragColor = vec4(col * recede, a * recede);
}`;
const FOLD_LOOK: Record<string, { width: number; glow: number; jitter: number; rim: string; edge: string }> = {
  inactive: { width: 0.05, glow: 0.35, jitter: 0, rim: '#8a7cff', edge: '#c9c0ff' },
  forming: { width: 0.13, glow: 0.85, jitter: 0.35, rim: '#8f9cff', edge: '#e0e4ff' },
  open: { width: 0.3, glow: 1.25, jitter: 0, rim: '#e467e6', edge: '#ffe3ff' },
  unstable: { width: 0.26, glow: 1.6, jitter: 1, rim: '#ffb35c', edge: '#fff0d6' },
  closing: { width: 0.11, glow: 0.8, jitter: 0.45, rim: '#b06cff', edge: '#e9d6ff' },
  closed: { width: 0.035, glow: 0.4, jitter: 0, rim: '#7c6cd8', edge: '#b9b0ee' },
};
const FOLD_GEO = new PlaneGeometry(6.4, 11.6);

function foldMaterial(seed: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FOLD_V, fragmentShader: FOLD_F, transparent: true, depthWrite: false, side: DoubleSide, fog: false,
    blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor,
    uniforms: {
      uTime: { value: 0 }, uWidth: { value: 0.3 }, uGlow: { value: 1 }, uJitter: { value: 0 }, uMemory: { value: 0 }, uSeed: { value: seed }, uDim: { value: 0 }, uSel: { value: 0 },
      cDeep: { value: new Color('#120a52') }, cCobalt: { value: new Color('#4a3cf0').multiplyScalar(0.75) }, cRim: { value: new Color('#e467e6') }, cEdge: { value: new Color('#ffe3ff').multiplyScalar(1.5) },
    },
  });
}
const hashId = (id: string) => { let h = 0; for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 33; };

interface Node {
  readonly id: string; readonly kind: Entity['kind']; readonly group: Group; readonly pos: Vector3; inited: boolean; alive: boolean;
  inst: Instance | null; mesh: Mesh | null; fold: ShaderMaterial | null; geoKey: string; extent: number; look: { width: number; glow: number; jitter: number };
}
export interface UpdateContext { readonly dt: number; readonly viewDistance: number; readonly camera: Vector3; readonly selectedId: string | null; readonly focus: ReadonlySet<string> | null; readonly time: number }
export interface EntityAnchors { readonly entities: Map<string, Vector3>; readonly extents: Map<string, number> }

const drawable = (e: Entity) => e.kind !== 'swarm' && (e.kind !== 'capsule' && e.kind !== 'equipment' && e.kind !== 'debris' && e.kind !== 'wreckage' ? true : !!e.assetId && assetFileFor(e.assetId) !== null);

export class EntityLayer {
  readonly root = new Group();
  private nodes = new Map<string, Node>();
  private proxyGeo = new IcosahedronGeometry(1, 1);
  private proxyMat = standardRock();
  constructor(private readonly base: string, private readonly rocks: RockMaterials) { this.root.name = 'atlas-entities'; }

  private create(e: Entity): Node {
    const n: Node = { id: e.id, kind: e.kind, group: new Group(), pos: new Vector3(...e.position), inited: false, alive: true, inst: null, mesh: null, fold: null, geoKey: '', extent: e.radius, look: { ...FOLD_LOOK.open! } };
    n.group.name = e.id;
    if (e.kind === 'island') {
      n.mesh = new Mesh(this.proxyGeo, this.proxyMat); n.mesh.scale.setScalar(Math.max(3, e.radius)); n.group.add(n.mesh);
    } else if (e.kind === 'fold') {
      n.fold = foldMaterial(hashId(e.id)); const m = new Mesh(FOLD_GEO, n.fold); m.frustumCulled = false; m.renderOrder = 3; n.mesh = m; n.group.add(m);
    } else if (e.assetId) {
      void loadTemplate(e.assetId, this.base).then(t => { if (!n.alive || !t) return; const i = instantiate(t); n.inst = i; n.group.add(i.root); });
    }
    this.root.add(n.group);
    return n;
  }

  private remove(n: Node): void {
    n.alive = false; this.root.remove(n.group);
    if (n.inst) n.inst.root.removeFromParent();
    n.fold?.dispose();
  }

  update(snap: CommandSnapshot, anchors: EntityAnchors, ctx: UpdateContext): void {
    const k = 1 - Math.exp(-Math.min(ctx.dt, 0.1) * 9);
    let seen = 0;
    for (const e of snap.entities) {
      if (!drawable(e)) continue;
      seen += 1;
      let n = this.nodes.get(e.id);
      if (!n) { n = this.create(e); this.nodes.set(e.id, n); }
      const first = !n.inited; n.inited = true;
      const kk = first ? 1 : k;
      n.pos.x += (e.position[0] - n.pos.x) * kk; n.pos.y += (e.position[1] - n.pos.y) * kk; n.pos.z += (e.position[2] - n.pos.z) * kk;
      n.group.position.copy(n.pos);
      anchors.entities.set(e.id, n.pos);
      const dim = !!ctx.focus && !ctx.focus.has(e.id);
      const remembered = e.knowledge !== 'current';
      const sel = ctx.selectedId === e.id;

      if (e.kind === 'island') {
        const form = e.island;
        const key = form ? `${form.facetSeed}:${form.radius}:${form.height}` : '';
        if (form && n.geoKey !== key) {
          n.geoKey = key;
          void islandGeometry(form).then(g => { if (g && n!.alive && n!.geoKey === key && n!.mesh) { n!.mesh.geometry = g as BufferGeometry; n!.mesh.scale.setScalar(1); } });
        }
        if (n.mesh) n.mesh.material = remembered ? this.rocks.ghost : dim ? this.rocks.dim : n.geoKey ? this.rocks.solid : this.proxyMat;
        // Legibility at tactical distance: islands grow up to 1.6x when the view is wide (they stay proportionate to each other).
        const si = boost(ctx.viewDistance, 100, 1.6);
        n.extent = Math.max(4, e.radius) * si;
        n.group.scale.setScalar(si);
      } else if (e.kind === 'fold') {
        const s = boost(ctx.viewDistance, 90, 2.3);
        n.group.scale.setScalar(s); n.extent = 5 * s;
        n.group.rotation.y = Math.atan2(ctx.camera.x - n.pos.x, ctx.camera.z - n.pos.z);
        const u = n.fold!.uniforms, look = FOLD_LOOK[e.foldState ?? 'open'] ?? FOLD_LOOK.open!, kl = Math.min(1, ctx.dt * 3);
        n.look.width += (look.width - n.look.width) * kl; n.look.glow += (look.glow - n.look.glow) * kl; n.look.jitter += (look.jitter - n.look.jitter) * kl;
        u.uWidth!.value = n.look.width; u.uGlow!.value = n.look.glow; u.uJitter!.value = n.look.jitter; u.uTime!.value = ctx.time;
        u.uMemory!.value += ((remembered ? 1 : 0) - (u.uMemory!.value as number)) * Math.min(1, ctx.dt * 2.5);
        u.uDim!.value += ((dim ? 1 : 0) - (u.uDim!.value as number)) * Math.min(1, ctx.dt * 4);
        u.uSel!.value = sel ? 1 : 0;
        (u.cRim!.value as Color).set(look.rim); (u.cEdge!.value as Color).set(look.edge).multiplyScalar(1.5);
      } else {
        const s = boost(ctx.viewDistance, 55, 4.4);
        n.group.scale.setScalar(s); n.extent = Math.max(0.6, e.radius, n.inst?.template.radius ?? 0) * s;
        if (e.orientation) n.group.quaternion.set(e.orientation[0], e.orientation[1], e.orientation[2], e.orientation[3]);
        const i = n.inst;
        if (i) {
          setVariant(i, remembered ? 'remembered' : dim ? 'dim' : 'solid');
          void sel;
        }
      }
      anchors.extents.set(e.id, n.extent);
    }
    if (this.nodes.size > seen) {
      const live = new Set<string>(); for (const e of snap.entities) live.add(e.id);
      for (const [id, n] of this.nodes) if (!live.has(id) || !drawable(snap.entities.find(x => x.id === id)!)) { this.remove(n); this.nodes.delete(id); anchors.entities.delete(id); anchors.extents.delete(id); }
    }
  }

  /** Visible mesh roots (for tests). */
  count(): number { return this.nodes.size; }

  dispose(): void {
    for (const n of this.nodes.values()) this.remove(n);
    this.nodes.clear(); this.proxyGeo.dispose(); this.proxyMat.dispose();
    void AdditiveBlending;
  }
}
