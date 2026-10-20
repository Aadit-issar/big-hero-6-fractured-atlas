import { memo, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { NeutralToneMapping, PCFShadowMap, SRGBColorSpace } from 'three';
import { ExplorationCamera } from './ExplorationCamera';
import { FloatingIsland } from './FloatingIsland';
import { Lighting } from './Lighting';
import { SpatialEffects } from './SpatialEffects';
import { OPENING_CAMERA_POSITION } from './cameraDefaults';
import { CosmicSky } from './environment/CosmicSky';
import { Vortex } from './dimension/Vortex';
import { MirrorPlanes } from './dimension/MirrorPlanes';
import { DebrisCurrents } from './dimension/DebrisCurrents';
import { GasWorld } from './gas/GasWorld';
import { GasMotes } from './gas/GasMotes';
import { archetypeFor, isHero } from './terrain/archetypes';
import { cellSizeFor } from './terrain/terrainGenerator';
import type { TerrainMeshData } from './terrain/terrainGenerator';
import { terrainLibrary } from './terrain/terrainLibrary';
import { createAtmosphereUniforms, loadRockTextures } from './terrain/rockMaterial';
import type { SimulationTelemetry } from './sceneTypes';
import type { SimulationEngine } from '../simulation/simulationEngine';
import type { QualitySettings } from '../rendering/qualitySettings';
import { updateReadiness } from '../rendering/renderReadiness';

interface DimensionSceneProps {
  readonly engine: SimulationEngine;
  readonly quality: QualitySettings;
  readonly onTelemetry: (telemetry: SimulationTelemetry) => void;
  readonly resetCameraVersion: number;
  readonly onWebGLReady: () => void;
}

/** Requests every island's geology, heroes first. Requests are cached by
 * identity and resolution, so calling this early (App start-up) lets workers
 * run while WebGL initialises and shaders compile. */
export function requestIslandTerrain(engine: SimulationEngine, quality: QualitySettings) {
  const islands = engine.world.islands.map((island, index) => ({ island, index }));
  // Priority requests are unshifted, so request the least important first.
  const ordered = [...islands].sort((a, b) => Number(isHero(archetypeFor(a.island, a.index))) - Number(isHero(archetypeFor(b.island, b.index))) || b.index - a.index);
  return ordered.map(({ island, index }) => ({ island, promise: terrainLibrary.request({ island, index, cellSize: cellSizeFor(island, index, quality.terrain) }, true) }));
}

function useIslandTerrain(engine: SimulationEngine, quality: QualitySettings) {
  const [terrain, setTerrain] = useState<Record<string, TerrainMeshData>>({});
  useEffect(() => {
    let alive = true;
    updateReadiness({ terrainReady: 0, terrainTotal: engine.world.islands.length });
    const started = performance.now();
    let ready = 0;
    for (const { island, promise } of requestIslandTerrain(engine, quality)) {
      void promise.then((data) => {
        if (!alive) return;
        ready += 1;
        updateReadiness({ terrainReady: ready, terrainMilliseconds: performance.now() - started });
        setTerrain((current) => ({ ...current, [island.id]: data }));
      }).catch((error: unknown) => {
        // A failed island keeps its Phase 2 placeholder; count it so loading completes.
        console.warn(`Terrain generation failed for ${island.id}`, error);
        if (alive) { ready += 1; updateReadiness({ terrainReady: ready }); }
      });
    }
    return () => { alive = false; setTerrain({}); };
  }, [engine, quality]);
  return terrain;
}

/** Profiling aid: `?disable=gas,bloom,panes,crystals,motes,vortex` removes decorative layers
 * (rendering only) so their individual cost can be measured. */
function disabledLayers(): Set<string> {
  try { return new Set((new URLSearchParams(window.location.search).get('disable') ?? '').split(',').filter(Boolean)); } catch { return new Set(); }
}

function World({ engine, quality }: { readonly engine: SimulationEngine; readonly quality: QualitySettings }) {
  const off = useMemo(disabledLayers, []);
  const { gl } = useThree();
  const textures = useMemo(() => loadRockTextures(gl, quality.anisotropy), [gl, quality.anisotropy]);
  useEffect(() => {
    let alive = true;
    updateReadiness({ texturesReady: false });
    void textures.ready.then(({ failed }) => { if (alive) updateReadiness({ texturesReady: true, textureFallback: failed }); });
    return () => { alive = false; textures.dispose(); };
  }, [textures]);
  const atmosphere = useMemo(() => createAtmosphereUniforms(), []);
  const terrain = useIslandTerrain(engine, quality);
  useEffect(() => { gl.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxDpr)); }, [gl, quality.maxDpr]);
  useEffect(() => { gl.shadowMap.enabled = quality.shadows; gl.shadowMap.needsUpdate = true; }, [gl, quality.shadows]);

  return (
    <>
      <CosmicSky seed={engine.seed} size={quality.skyCubeSize} atmosphere={atmosphere} />
      <Lighting key={quality.shadowMapSize} engine={engine} shadows={quality.shadows} shadowMapSize={quality.shadowMapSize} />
      {engine.world.islands.map((island) => (
        <FloatingIsland key={island.id} island={island} engine={engine} terrain={terrain[island.id] ?? null} textures={textures} atmosphere={atmosphere} shadows={quality.shadows} mirror={false} />
      ))}
      {/* Gaseous dimension: raymarched matter (in GasWorld), displaced-space panes,
          sparse crystals and motes. Decorative, model-time driven. */}
      {!off.has('panes') && <MirrorPlanes seed={engine.seed} panes={quality.mirrorPanes} />}
      {!off.has('vortex') && <Vortex engine={engine} />}
      {!off.has('crystals') && <DebrisCurrents engine={engine} count={quality.crystals} />}
      {!off.has('motes') && <GasMotes engine={engine} count={quality.motes} />}
      <SpatialEffects engine={engine}/>
      <GasWorld engine={engine} gas={off.has('gas') ? null : quality.gas} bloom={off.has('bloom') ? null : quality.bloom} />
    </>
  );
}

export const DimensionScene = memo(function DimensionScene({
  engine,
  quality,
  onTelemetry,
  resetCameraVersion,
  onWebGLReady,
}: DimensionSceneProps) {
  return (
    <Canvas
      className="dimension-canvas"
      camera={{ position: OPENING_CAMERA_POSITION, fov: 56, near: 0.1, far: 3200 }}
      dpr={[1, quality.maxDpr]}
      shadows={{ type: PCFShadowMap, enabled: quality.shadows }}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false, preserveDrawingBuffer: false }}
      onCreated={({ gl }) => {
        if (!gl.capabilities.isWebGL2) throw new Error('This simulation requires WebGL2.');
        // Khronos PBR Neutral keeps the saturated violet/magenta hues that ACES bleaches.
        gl.toneMapping = NeutralToneMapping;
        gl.toneMappingExposure = 1.0;
        gl.outputColorSpace = SRGBColorSpace;
        onWebGLReady();
      }}
    >
      <ExplorationCamera
        engine={engine}
        onTelemetry={onTelemetry}
        resetVersion={resetCameraVersion}
      />
      <World engine={engine} quality={quality} />
    </Canvas>
  );
});
