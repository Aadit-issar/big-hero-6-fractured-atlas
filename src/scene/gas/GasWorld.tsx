import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DepthTexture, HalfFloatType, Vector2, Vector3, WebGLRenderTarget } from 'three';
import type { Data3DTexture, PerspectiveCamera, Vector4 } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { SimulationEngine } from '../../simulation/simulationEngine';
import { updateReadiness } from '../../rendering/renderReadiness';
import type { BloomSettings, GasQuality } from '../../rendering/qualitySettings';
import { terrainLibrary } from '../terrain/terrainLibrary';
import { envelopeRadius } from '../terrain/archetypes';
import { SUN_DIRECTION } from '../environment/CosmicSky';
import { VORTEX } from '../dimension/layout';
import { FIELD_CENTRE, VORTEX_AXIS } from '../dimension/Vortex';
import { createGasTexture, GasVolumePass } from './GasVolumePass';
import { gasSimulationInputs } from './gasInputs';

/** Owns the frame: scene → raymarched gas (depth-aware) → soft bloom → ACES/sRGB.
 * Gas uniforms follow the live island transforms every frame and the fold graph
 * and hazard samples on the 4 Hz model lattice. Rendering only. */
export function GasWorld({ engine, gas, bloom }: { readonly engine: SimulationEngine; readonly gas: GasQuality | null; readonly bloom: BloomSettings | null }) {
  const { gl, scene, camera, size } = useThree();
  const [noise, setNoise] = useState<Data3DTexture | null>(null);
  useEffect(() => {
    let alive = true, texture: Data3DTexture | null = null;
    if (!gas) { updateReadiness({ gasReady: true }); return; }
    updateReadiness({ gasReady: false });
    const size = gas.noiseSize;
    void terrainLibrary.gasNoise(engine.seed, size).then((data) => {
      if (!alive) return;
      texture = createGasTexture(data, size);
      setNoise(texture);
      updateReadiness({ gasReady: true });
    });
    return () => { alive = false; texture?.dispose(); setNoise(null); };
  }, [engine.seed, gas]);

  const pipeline = useMemo(() => {
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthTexture: new DepthTexture(1, 1) });
    const composer = new EffectComposer(gl, target);
    composer.addPass(new RenderPass(scene, camera));
    const volume = noise && gas ? new GasVolumePass(camera as PerspectiveCamera, noise, gas) : null;
    if (volume) composer.addPass(volume);
    const glow = bloom ? new UnrealBloomPass(new Vector2(256, 256), bloom.strength, bloom.radius, bloom.threshold) : null;
    if (glow) composer.addPass(glow);
    composer.addPass(new OutputPass());
    return { composer, volume, glow };
  }, [gl, scene, camera, noise, gas, bloom]);

  useEffect(() => {
    pipeline.composer.setPixelRatio(gl.getPixelRatio());
    pipeline.composer.setSize(size.width, size.height);
    pipeline.glow?.resolution.set(size.width * (bloom?.resolutionScale ?? 0.5), size.height * (bloom?.resolutionScale ?? 0.5));
  }, [pipeline, gl, size, bloom]);
  useEffect(() => {
    gl.info.autoReset = false;
    return () => { gl.info.autoReset = true; pipeline.composer.dispose(); pipeline.volume?.dispose(); };
  }, [gl, pipeline]);

  const tick = useRef(-1);
  const camPos = useMemo(() => new Vector3(), []);
  useFrame((_, delta) => {
    const volume = pipeline.volume;
    if (volume) {
      const u = volume.march.uniforms;
      u.uTime!.value = engine.clock.time;
      (u.uVortex!.value as Vector3).set(...VORTEX);
      (u.uAxis!.value as Vector3).copy(VORTEX_AXIS);
      (u.uLight!.value as Vector3).copy(SUN_DIRECTION);
      (u.uFieldCentre!.value as Vector3).copy(FIELD_CENTRE);
      // Live island centres (set this frame by FloatingIsland's simulation matrix).
      const islands = u.uIslands!.value as Vector4[];
      engine.world.islands.forEach((island, i) => {
        const object = scene.getObjectByName(island.id);
        const e = object?.matrix.elements;
        if (e) islands[i]!.set(e[12]!, e[13]!, e[14]!, envelopeRadius(island) * 1.05);
      });
      const next = Math.floor(engine.clock.time * 4);
      if (next !== tick.current) {
        tick.current = next;
        camPos.copy(camera.position);
        const inputs = gasSimulationInputs(engine, engine.clock.time, [camPos.x, camPos.y, camPos.z]);
        (u.uFolds!.value as Vector4[]).forEach((v, i) => { const f = inputs.folds[i]; if (f) v.set(...f); else v.set(0, -1e5, 0, 0); });
        (u.uHazards!.value as Vector4[]).forEach((v, i) => { const h = inputs.hazards[i]; if (h) v.set(...h); else v.set(0, -1e5, 0, 0); });
      }
    }
    gl.info.reset();
    pipeline.composer.render(delta);
  }, 1);
  return null;
}
