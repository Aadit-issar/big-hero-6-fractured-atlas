import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, DirectionalLight, Matrix4, Object3D, Vector3 } from 'three';
import type { SimulationEngine } from '../simulation/simulationEngine';
import { SUN_DIRECTION } from './environment/CosmicSky';
import { envelopeRadius } from './terrain/archetypes';

/** Islands move at most a few rendering units from their t=0 image (Phase 2
 * sampled maximum 12.2u); the shadow frustum is padded for that drift. */
const DRIFT_PADDING = 14;

/** Key/rim/fill rig. One shadow-casting key light; its orthographic frustum is
 * fitted to the island field in light space instead of covering empty space. */
export function Lighting({ engine, shadows, shadowMapSize }: { readonly engine: SimulationEngine; readonly shadows: boolean; readonly shadowMapSize: number }) {
  const key = useRef<DirectionalLight>(null);
  const { scene } = useThree();
  const target = useMemo(() => new Object3D(), []);
  const fit = useMemo(() => {
    const points = engine.world.islands.map((island) => ({ c: new Vector3(...engine.evaluateIsland(island, 0)), r: envelopeRadius(island) }));
    const center = points.reduce((sum, p) => sum.add(p.c), new Vector3()).divideScalar(points.length);
    const position = center.clone().addScaledVector(SUN_DIRECTION, 220);
    const view = new Matrix4().lookAt(position, center, new Vector3(0, 1, 0)).setPosition(position).invert();
    const box = new Box3();
    for (const p of points) {
      const local = p.c.clone().applyMatrix4(view);
      const pad = p.r + DRIFT_PADDING;
      box.expandByPoint(local.clone().addScalar(pad)); box.expandByPoint(local.clone().subScalar(pad));
    }
    // Camera space looks down -z: near/far are distances along the view direction.
    return { center, position, left: box.min.x, right: box.max.x, bottom: box.min.y, top: box.max.y, near: Math.max(1, -box.max.z), far: -box.min.z };
  }, [engine]);

  useEffect(() => {
    target.position.copy(fit.center);
    scene.add(target);
    const light = key.current;
    if (light) { light.target = target; light.shadow.needsUpdate = true; }
    return () => { scene.remove(target); };
  }, [fit, scene, target]);

  return (
    <>
      <hemisphereLight args={['#6c43d6', '#160b34', 0.75]} />
      <directionalLight
        ref={key}
        color="#ffd9ad"
        intensity={5.2}
        position={fit.position.toArray()}
        castShadow={shadows}
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
        shadow-camera-left={fit.left}
        shadow-camera-right={fit.right}
        shadow-camera-top={fit.top}
        shadow-camera-bottom={fit.bottom}
        shadow-camera-near={fit.near}
        shadow-camera-far={fit.far}
        shadow-bias={-0.0004}
        shadow-normalBias={0.06}
        shadow-radius={2}
      />
      {/* The key light is the vortex itself (warm gold). Violet fill from the
          camera side keeps backlit cliffs readable; cobalt rim from above;
          magenta bounce from the glowing matter below the mirror floor. */}
      <directionalLight color="#8a62ff" intensity={1.1} position={[-150, 55, 140]} />
      <directionalLight color="#3d6bff" intensity={1.6} position={[-200, 140, -80]} />
      <directionalLight color="#d43fd8" intensity={0.6} position={[60, -140, 40]} />
    </>
  );
}
