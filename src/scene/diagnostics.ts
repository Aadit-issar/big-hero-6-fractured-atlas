import type { SimulationEngine } from '../simulation/simulationEngine';
import type { Camera, Scene } from 'three';
import { Mesh, Vector3 } from 'three';
import { readReadiness } from '../rendering/renderReadiness';

export function readPerformance(engine:SimulationEngine) {
  const frames=engine.performance.frames;
  const sorted=[...frames].sort((a,b)=>a-b);
  const percentile=(p:number)=>sorted[Math.floor(Math.max(0,sorted.length-1)*p)]??0;
  const summarize=(values:readonly number[])=>({mean:values.reduce((a,b)=>a+b,0)/Math.max(1,values.length),p95:[...values].sort((a,b)=>a-b)[Math.floor(values.length*.95)]??0,max:Math.max(0,...values)});
  return {...engine.performance,frames:undefined,frameCount:frames.length,
    averageFps:frames.length?1000/(frames.reduce((a,b)=>a+b,0)/frames.length):0,
    p50FrameMs:percentile(.5),p95FrameMs:percentile(.95),p99FrameMs:percentile(.99),
    detection:summarize(engine.network.detectionTimings),graph:summarize(engine.network.graphTimings)};
}

/** Engineering readout only; production gameplay and future ATLAS must use
 * their own deliberately restricted observation interfaces. No mutation API. */
function createDiagnosticApi(engine:SimulationEngine,camera:Camera,scene:Scene) {
  const api={
    read:()=>({
      ...engine.scenario(),cameraPosition:camera.position.toArray(),cameraQuaternion:camera.quaternion.toArray(),
      referenceStatus:engine.explorer.inverse.status,residual:engine.explorer.inverse.residual,
      traversalCount:engine.explorer.traversalCount,lastTransition:engine.explorer.lastTransition,
      openingReference:engine.explorer.openingReference,primaryFoldId:engine.explorer.primaryFoldId,
      connections:engine.network.getConnections(engine.clock.time),nearby:engine.explorer.nearby(engine.clock.time),
      local:engine.sampleField(engine.explorer.referencePosition,engine.clock.time),
      debris:engine.debris.states.map(s=>({...s})),debrisTick:engine.debris.tick,
      renderedIslands:engine.world.islands.map(i=>({id:i.id,referencePosition:i.referencePosition,position:scene.getObjectByName(i.id)?.getWorldPosition(new Vector3()).toArray()})),
      render:{...readReadiness(),terrainMeshes:engine.world.islands.map(i=>{
        const mesh=scene.getObjectByName(`${i.id}-terrain`);
        return mesh instanceof Mesh?{id:i.id,vertices:mesh.geometry.getAttribute('position').count,parent:mesh.parent?.name??null}:null;
      })},
    }),readPerformance:()=>readPerformance(engine),
  };
  return api;
}
export function attachDiagnostics(engine:SimulationEngine,camera:Camera,scene:Scene) {
  const api=createDiagnosticApi(engine,camera,scene);window.__FRACTURED_DIAGNOSTICS__=api;
  return ()=>{if(window.__FRACTURED_DIAGNOSTICS__===api)delete window.__FRACTURED_DIAGNOSTICS__;};
}
declare global { interface Window { __FRACTURED_DIAGNOSTICS__?:ReturnType<typeof createDiagnosticApi> } }
