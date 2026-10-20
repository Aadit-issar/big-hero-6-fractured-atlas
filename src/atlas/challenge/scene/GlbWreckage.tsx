import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, Sphere } from 'three';
import { PMREMGenerator } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { KEY_LIGHT } from '../../scene/NebulaSky';
import { smooth } from '../../scene/timing';
import type { OverlayData } from '../presentation';

/** The scanned wreckage, drawn with the project's own premium GLB assets (LOD1). The scene-scan memory decides WHAT exists and WHERE; the meshes are
 * representative models of those records. They are illustrative: the planner never sees their geometry, only the record's position and radius. */
const FILE_OF: Record<string, string> = {
  capsule_shell_remnant: 'capsule_shell_remnant', capsule_heatshield_panel: 'capsule_heatshield_panel', industrial_ibeam_twisted: 'industrial_ibeam_twisted',
  industrial_pipe_large_fractured: 'industrial_pipe_large_fractured', industrial_column_bent: 'industrial_column_bent', concrete_slab_rebar: 'concrete_slab_rebar',
};
const hash = (s: string, salt: number) => { let h = 2166136261 ^ salt; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; return (h >>> 0) / 4294967296; };

interface Loaded { readonly root: Object3D; readonly radius: number }

export function GlbWreckage({ overlayRef, base, onReady }: { readonly overlayRef: { current: OverlayData }; readonly base: string; readonly onReady?: () => void }) {
  const models = useRef(new Map<string, Loaded>());
  const group = useRef<Group>(null);
  const placed = useRef(new Map<string, Group>());
  const [ready, setReady] = useState(false);
  const { gl, scene } = useThree();
  // Image-based light for the PBR models only (the island and sky shaders ignore it), so metal reads as metal.
  useEffect(() => {
    const pm = new PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = env.texture; scene.environmentIntensity = 0.9;
    return () => { scene.environment = null; env.dispose(); pm.dispose(); };
  }, [gl, scene]);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();
    const tasks = Object.values(FILE_OF).map(file => loader.loadAsync(`${base}models/${file}.glb`).then(gltf => {
      const box = new Box3().setFromObject(gltf.scene), sphere = box.getBoundingSphere(new Sphere());
      // Centre the model on its own bounds so the scan record's position is its centre.
      gltf.scene.position.sub(sphere.center);
      const holder = new Group(); holder.add(gltf.scene);
      gltf.scene.traverse(o => { const m = o as Mesh; if (m.isMesh) { m.frustumCulled = true; const mat = m.material as MeshStandardMaterial; if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = 1; } });
      models.current.set(file, { root: holder, radius: sphere.radius });
    }));
    void Promise.all(tasks).then(() => { if (alive) { setReady(true); onReady?.(); } }).catch(() => { if (alive) onReady?.(); });
    return () => { alive = false; };
  }, [base, onReady]);

  useEffect(() => () => {
    placed.current.forEach(g => g.parent?.remove(g));
    placed.current.clear();
    models.current.forEach(m => m.root.traverse(o => { const mesh = o as Mesh; if (mesh.isMesh) { mesh.geometry.dispose(); const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]; mats.forEach(mt => { Object.values(mt as unknown as Record<string, unknown>).forEach(v => { const t = v as { isTexture?: boolean; dispose?: () => void }; if (t && t.isTexture) t.dispose?.(); }); mt.dispose(); }); } }));
    models.current.clear();
  }, []);

  useFrame(() => {
    const g = group.current; if (!g || !ready) return;
    const o = overlayRef.current;
    const present = new Set(o.scanItems.map(i => i.id));
    for (const [id, holder] of placed.current) if (!present.has(id)) { holder.parent?.remove(holder); placed.current.delete(id); }
    for (const item of o.scanItems) {
      const file = FILE_OF[item.kind]; const model = file ? models.current.get(file) : undefined;
      if (!model) continue;
      let holder = placed.current.get(item.id);
      if (!holder) {
        holder = new Group(); holder.add(model.root.clone(true)); g.add(holder); placed.current.set(item.id, holder);
        holder.rotation.set((hash(item.id, 1) - 0.5) * 0.9, hash(item.id, 2) * Math.PI * 2, (hash(item.id, 3) - 0.5) * 0.7);
      }
      const reveal = smooth((o.clock - item.revealAt - 0.8) / 1.6);
      holder.visible = reveal > 0.001;
      const s = (item.radius / model.radius) * 1.7 * (0.2 + 0.8 * reveal);
      holder.scale.setScalar(s);
      // A faint bob driven by the film clock (frozen when the film is paused).
      holder.position.set(item.position[0], item.position[1] + Math.sin(o.clock * 0.45 + hash(item.id, 4) * 6) * 0.12, item.position[2]);
    }
  });

  return (
    <>
      <group ref={group} />
      <directionalLight color="#ffe2ff" intensity={2.6} position={[KEY_LIGHT.x * 60, KEY_LIGHT.y * 60, KEY_LIGHT.z * 60]} />
      <hemisphereLight args={['#6f5cff', '#b02bd0', 0.75]} />
    </>
  );
}
