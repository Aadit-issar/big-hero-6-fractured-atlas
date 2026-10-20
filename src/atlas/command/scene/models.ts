import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial } from 'three';
import type { Material, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SHARED_ASSETS } from '../../../shared/assetManifest';

/** Loads the shared physical models (src/shared/assetManifest.ts) exactly as the Dimension draws them: same GLB, authored origin at the entity
 * position, no re-centring, scale 1. ATLAS draws the manifest's `atlasLevel` (a lower level of the SAME model). Templates are cached; instances
 * share geometry and materials, so adding an entity costs one Group, not a copy of the mesh. */
export interface Template { readonly id: string; readonly root: Group; readonly radius: number; readonly file: string; readonly triangles: number }

const cache = new Map<string, Promise<Template | null>>();
const loader = new GLTFLoader();

export function assetFileFor(assetId: string): string | null {
  const a = SHARED_ASSETS[assetId];
  return a ? a.levels[a.atlasLevel]!.name : null;
}

export function loadTemplate(assetId: string, base: string): Promise<Template | null> {
  let hit = cache.get(assetId);
  if (!hit) {
    const asset = SHARED_ASSETS[assetId];
    if (!asset) hit = Promise.resolve(null);
    else {
      const level = asset.levels[asset.atlasLevel]!;
      hit = loader.loadAsync(`${base}models/${level.name}`).then(gltf => {
        const root = new Group();
        root.add(gltf.scene);
        liftMaterials(gltf.scene);
        return { id: assetId, root, radius: Math.max(...asset.size) / 2, file: level.name, triangles: level.triangles } satisfies Template;
      }).catch(() => null);
    }
    cache.set(assetId, hit);
  }
  return hit;
}

/** The map is lit by a nebula with no sun-bounce: dark metals read as black cut-outs. Lift them toward the Dimension's own look (cool violet fill,
 * stronger environment reflection, metalness capped) on the ATLAS copy of the material only; the shared GLB bytes are untouched. */
function liftMaterials(scene: Object3D): void {
  const done = new Set<Material>();
  scene.traverse((o: Object3D) => {
    const m = o as Mesh; if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as MeshStandardMaterial;
      if (!std.isMeshStandardMaterial || done.has(mat)) continue;
      done.add(mat);
      std.envMapIntensity = Math.max(std.envMapIntensity, 1.7);
      std.metalness = Math.min(std.metalness, 0.55);
      if (!std.emissiveMap) { std.emissive = new Color('#33237a'); std.emissiveIntensity = 0.5; }
    }
  });
}

/** Materials shared by every ghost/forecast instance. */
export const GHOST_COLOR = new Color('#6f7bff');
export const FORECAST_COLOR = new Color('#f0b4f4');
/** Lavender hologram: faint body, bright silhouette rim, so a translucent copy of an asset keeps its shape against bright nebula. */
export function hologramMaterial(color: Color, opacity: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true, depthWrite: false, side: DoubleSide, fog: false,
    uniforms: { uColor: { value: color.clone() }, uOpacity: { value: opacity } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV; void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); gl_FragColor = vec4(mix(uColor, vec3(0.85, 0.88, 1.0), f) * (0.8 + 0.9 * f), uOpacity * (0.45 + 1.0 * f)); }',
  });
}
const ghost = hologramMaterial(GHOST_COLOR, 0.55);
const forecast = hologramMaterial(FORECAST_COLOR, 0.7);
const outline = new MeshBasicMaterial({ color: '#ff5ce6', side: 1 /* BackSide */, transparent: true, opacity: 0.95, depthWrite: false });
const dim = new MeshBasicMaterial({ color: '#4b3f99', transparent: true, opacity: 0.2, depthWrite: false });
export type Variant = 'solid' | 'remembered' | 'forecast' | 'dim' | 'custom';
const VARIANT_MATERIAL: Record<Exclude<Variant, 'solid' | 'custom'>, Material> = { remembered: ghost, forecast, dim };
/** Translucent ghost materials by opacity/colour, shared (a handful at most). */
const ghostCache = new Map<string, ShaderMaterial>();
export function ghostMaterial(color: Color, opacity: number): ShaderMaterial {
  const key = `${color.getHexString()}:${opacity.toFixed(2)}`;
  let m = ghostCache.get(key);
  if (!m) { m = hologramMaterial(color, opacity); ghostCache.set(key, m); }
  return m;
}

export interface Instance { readonly template: Template; readonly root: Group; readonly meshes: Mesh[]; readonly original: Map<Mesh, Material | Material[]>; variant: Variant; hull: Group | null }

/** One drawable instance of a template. */
export function instantiate(template: Template): Instance {
  const root = new Group();
  const body = template.root.clone(true);
  root.add(body);
  const meshes: Mesh[] = [];
  const original = new Map<Mesh, Material | Material[]>();
  body.traverse((o: Object3D) => { const m = o as Mesh; if (m.isMesh) { meshes.push(m); original.set(m, m.material); } });
  return { template, root, meshes, original, variant: 'solid', hull: null };
}

export function setVariant(inst: Instance, variant: Exclude<Variant, 'custom'>): void {
  if (inst.variant === variant) return;
  inst.variant = variant;
  for (const m of inst.meshes) {
    m.material = variant === 'solid' ? inst.original.get(m)! : VARIANT_MATERIAL[variant];
    m.renderOrder = variant === 'solid' ? 0 : 2;
  }
}

/** Draws the instance with one explicit (shared) material, e.g. a ghost of a given opacity. */
export function setMaterial(inst: Instance, material: Material): void {
  inst.variant = 'custom';
  for (const m of inst.meshes) { m.material = material; m.renderOrder = 2; }
}

/** Selection outline: a slightly enlarged back-face copy of the same meshes. */
export function setOutline(inst: Instance, on: boolean): void {
  if (on && !inst.hull) {
    const hull = inst.template.root.clone(true);
    hull.traverse((o: Object3D) => { const m = o as Mesh; if (m.isMesh) { m.material = outline; m.renderOrder = 1; } });
    hull.scale.setScalar(1.06);
    inst.root.add(hull);
    inst.hull = hull;
  }
  if (inst.hull) inst.hull.visible = on;
}

export function standardRock(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: '#8470e0', roughness: 0.85, metalness: 0.05, emissive: '#241878', emissiveIntensity: 0.5 });
}

/** Back-face outline material is shared; its colour follows the selection ring. */
export function setOutlineColor(hex: string): void { outline.color.set(hex); }
