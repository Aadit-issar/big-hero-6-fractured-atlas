import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Color, Group, Matrix4, MeshStandardMaterial } from 'three';
import { MIRROR_Y } from './dimension/layout';
import { boundedLocalJacobian } from '../simulation/deformation';
import { evaluateField } from '../simulation/field';
import type { SimulationEngine } from '../simulation/simulationEngine';
import type { IslandDefinition } from '../simulation/types';
import { createIslandGeometry } from './islandGeometry';
import type { TerrainMeshData } from './terrain/terrainGenerator';
import { createRockMaterial } from './terrain/rockMaterial';
import type { AtmosphereUniforms, RockTextureSet } from './terrain/rockMaterial';

interface FloatingIslandProps {
  readonly island: IslandDefinition;
  readonly engine: SimulationEngine;
  readonly terrain: TerrainMeshData | null;
  readonly textures: RockTextureSet;
  readonly atmosphere: AtmosphereUniforms;
  readonly shadows: boolean;
  /** Render a mirror echo reflected through the chamber's glass floor. */
  readonly mirror: boolean;
}

/** Reflection through the plane y = MIRROR_Y (determinant −1; three.js flips winding). */
export const MIRROR_MATRIX = new Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * MIRROR_Y, 0, 0, 1, 0, 0, 0, 0, 1);

export function terrainGeometry(data: TerrainMeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('terrain', new BufferAttribute(data.terrain, 4, true));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const STABLE_MINERAL = new Color('#b45cff');
const UNSTABLE_MINERAL = new Color('#f0a65c');

export function FloatingIsland({ island, engine, terrain, textures, atmosphere, shadows, mirror }: FloatingIslandProps) {
  const group = useRef<Group>(null);
  const echo = useRef<Group>(null);
  // The Phase 2 faceted mesh remains as an immediate placeholder while the
  // detailed geology is generated off-thread.
  const placeholder = useMemo(() => createIslandGeometry(island.facetSeed, island.radius, island.height), [island.facetSeed, island.height, island.radius]);
  const placeholderMaterial = useMemo(() => new MeshStandardMaterial({ color: '#4a566d', roughness: 1, flatShading: true }), []);
  const geometry = useMemo(() => (terrain ? terrainGeometry(terrain) : null), [terrain]);
  const material = useMemo(() => createRockMaterial({ textures, atmosphere, rim: 0.8 }), [textures, atmosphere]);
  useEffect(() => () => { placeholder.dispose(); placeholderMaterial.dispose(); }, [placeholder, placeholderMaterial]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  const hazardTick = useRef(-1);

  useFrame(() => {
    const target = group.current;
    if (!target) return;

    const time = engine.clock.time;
    const sample = evaluateField(island.referencePosition, time, engine.field);
    const { hessian, gradient } = sample;
    const {worldScale:L,strength:alpha}=engine.mapping;
    const j=boundedLocalJacobian(hessian,alpha);
    target.matrix.set(j[0],j[1],j[2],L*(island.referencePosition[0]+alpha*gradient[0]),
      j[3],j[4],j[5],L*(island.referencePosition[1]+alpha*gradient[1]),
      j[6],j[7],j[8],L*(island.referencePosition[2]+alpha*gradient[2]),0,0,0,1);
    target.matrixWorldNeedsUpdate=true;
    // The echo is a pure reflection of the authoritative transform, never independent motion.
    if (echo.current) { echo.current.matrix.multiplyMatrices(MIRROR_MATRIX, target.matrix); echo.current.matrixWorldNeedsUpdate = true; }

    // Mineral seams read the island's sampled hazard on the 4 Hz model lattice.
    const tick = Math.floor(time * 4);
    if (tick !== hazardTick.current) {
      hazardTick.current = tick;
      const hazard = engine.sampleField(island.referencePosition, tick / 4).hazard;
      material.userData.mineralIntensity.value = 0.25 + 2.4 * hazard * hazard;
      material.userData.mineralColor.value.copy(STABLE_MINERAL).lerp(UNSTABLE_MINERAL, Math.min(1, hazard * 1.4));
    }
  });

  return (
    <>
      <group name={island.id} ref={group} matrixAutoUpdate={false}>
        {geometry
          ? <mesh name={`${island.id}-terrain`} geometry={geometry} material={material} castShadow={shadows} receiveShadow={shadows} />
          : <mesh name={`${island.id}-placeholder`} geometry={placeholder} material={placeholderMaterial} />}
      </group>
      {mirror && geometry && (
        <group name={`${island.id}-mirror`} ref={echo} matrixAutoUpdate={false}>
          <mesh geometry={geometry} material={material} />
        </group>
      )}
    </>
  );
}
