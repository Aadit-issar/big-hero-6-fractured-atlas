import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, OctahedronGeometry, Quaternion, Vector3 } from 'three';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { createSeededRandom } from '../../simulation/seededRandom';
import type { Vec3 } from '../../simulation/types';
import { cavernPoint, cavernRadius, VORTEX } from './layout';
import { FIELD_CENTRE, VORTEX_AXIS } from './Vortex';

export interface DebrisChunk { readonly position: Vec3; readonly scale: Vec3; readonly rotation: Vec3; readonly omega: number; readonly phase: number }

/** Seeded debris: spiral streams pulled toward the vortex, suspended clouds of
 * chunks through the chamber (kept clear of islands) and corridor drift. */
export function debrisField(seed: number, count: number, islandCentres: readonly Vec3[]): DebrisChunk[] {
  const random = createSeededRandom(seed ^ 0x2545f491);
  const r = (a: number, b: number) => a + random() * (b - a);
  const toward = new Vector3().copy(FIELD_CENTRE).sub(new Vector3(...VORTEX)).normalize();
  const side = new Vector3().crossVectors(toward, new Vector3(0, 1, 0)).normalize(), vup = new Vector3().crossVectors(side, toward);
  const chunks: DebrisChunk[] = [];
  for (let tries = 0; chunks.length < count && tries < count * 4; tries += 1) {
    const kind = random();
    let p: Vec3, omega = 0, size: number;
    if (kind < 0.6) {
      const arm = Math.floor(r(0, 4)), t = r(0, 1) ** 0.8, angle = arm * (Math.PI / 2) + t * 6.2 + r(-0.35, 0.35), rad = 10 + t * 150;
      const q = new Vector3(...VORTEX).addScaledVector(side, Math.cos(angle) * rad).addScaledVector(vup, Math.sin(angle) * rad * 0.8).addScaledVector(toward, t * 90 + r(-12, 12));
      p = [q.x, q.y, q.z]; omega = 0.05 * (1.2 - t); size = r(0.8, 3.2) * (0.6 + t);
    } else if (kind < 0.9) {
      const u = r(0.36, 0.68), c = cavernPoint(u), radius = cavernRadius(u), a = r(0, Math.PI * 2), k = Math.sqrt(r(0.02, 0.6));
      p = [c[0] + Math.cos(a) * radius.horizontal * k, c[1] + Math.sin(a) * 55 * k, c[2] + r(-25, 25)];
      if (islandCentres.some((ic) => Math.hypot(p[0] - ic[0], p[1] - ic[1], p[2] - ic[2]) < 16)) continue;
      size = r(0.35, 1.6);
    } else {
      const u = r(0.04, 0.33), c = cavernPoint(u), radius = cavernRadius(u), a = r(0, Math.PI * 2), k = r(0.2, 0.85);
      p = [c[0] + Math.cos(a) * radius.horizontal * k, c[1] + Math.sin(a) * radius.up * k, c[2] + r(-6, 6)];
      size = r(0.2, 1.1);
    }
    chunks.push({ position: p, scale: [size * r(0.5, 0.8), size * r(1.2, 2.0), size * r(0.5, 0.8)], rotation: [r(0, 6.3), r(0, 6.3), r(0, 6.3)], omega, phase: r(0, 6.3) });
  }
  return chunks;
}

/** One instanced draw. Orbits are evaluated on the GPU from model time, so the
 * currents freeze on pause and replay identically after reset. */
/** Sparse faceted crystals carried by the currents (rendering only). */
export function DebrisCurrents({ engine, count }: { readonly engine: SimulationEngine; readonly count: number }) {
  const chunks = useMemo(() => debrisField(engine.seed, count, engine.world.islands.map((i) => engine.evaluateIsland(i, 0) as Vec3)), [engine, count]);
  const geometry = useMemo(() => {
    const g = new OctahedronGeometry(1, 0), p = g.getAttribute('position'), random = createSeededRandom(0xdeb1);
    // Faceted crystal: displace shared corners consistently (non-indexed geometry duplicates them).
    const jitter = new Map<string, number>();
    for (let i = 0; i < p.count; i += 1) {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      if (!jitter.has(key)) jitter.set(key, 0.65 + random() * 0.6);
      const k = jitter.get(key)!; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
    }
    g.computeVertexNormals();
    g.setAttribute('aOrbit', new InstancedBufferAttribute(new Float32Array(chunks.flatMap((c) => [c.omega, c.phase])), 2));
    return g;
  }, [chunks]);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uVortex: { value: new Vector3(...VORTEX) }, uAxis: { value: VORTEX_AXIS } }), []);
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ color: new Color('#2e1a66'), roughness: 0.08, metalness: 0.7, emissive: new Color('#5a1fa8'), emissiveIntensity: 0.22, envMapIntensity: 2.2, flatShading: true });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = 'attribute vec2 aOrbit;\nuniform float uTime;\nuniform vec3 uVortex, uAxis;\n' + shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  #endif
  vec3 rel = mvPosition.xyz - uVortex;
  float along = dot(rel, uAxis);
  vec3 radial = rel - uAxis * along;
  float ang = uTime * aOrbit.x;
  mvPosition.xyz = uVortex + uAxis * along + radial * cos(ang) + cross(uAxis, radial) * sin(ang);
  mvPosition.y += sin(uTime * 0.5 + aOrbit.y) * 0.5;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`);
    };
    m.customProgramCacheKey = () => 'fractured-debris';
    return m;
  }, [uniforms]);
  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geometry, material, chunks.length);
    const matrix = new Matrix4(), q = new Quaternion(), e = new Vector3();
    chunks.forEach((c, i) => {
      q.setFromAxisAngle(e.set(...c.rotation).normalize(), c.rotation[0] + c.rotation[1]);
      matrix.compose(new Vector3(...c.position), q, new Vector3(...c.scale));
      instanced.setMatrixAt(i, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.frustumCulled = false;
    instanced.name = 'debris-currents';
    return instanced;
  }, [geometry, material, chunks]);
  useEffect(() => () => { geometry.dispose(); material.dispose(); mesh.dispose(); }, [geometry, material, mesh]);
  useFrame(() => { uniforms.uTime.value = engine.clock.time; });
  return <primitive object={mesh} />;
}
