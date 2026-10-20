import { writeFileSync, mkdirSync } from 'node:fs';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { SPATIAL_MODEL } from '../src/simulation/spatialModel';

const engine=new SimulationEngine();
const initial=engine.network.getConnections(0);
const windows=engine.network.anchors.map(a=>{
  const transitions:{time:number;state:string}[]=[];
  let previous='';
  for(let tick=0;tick<=240;tick++) {
    const time=tick*.25,state=engine.network.getConnectionState(a.id,time)!.state;
    if(state!==previous){transitions.push({time,state});previous=state;}
  }
  return {id:a.id,transitions};
});
const counts=[0,4,8,12,16,24,32,40,60].map(time=>({time,active:engine.network.getActiveConnections(time).length}));
const evidence={seed:engine.seed,model:SPATIAL_MODEL,primary:engine.explorer.primaryFoldId,openingReference:engine.explorer.openingReference,
  initial:initial.map(c=>({id:c.id,state:c.state,referencePosition:c.referencePosition,entryReference:c.entryReferencePosition,exitReference:c.exitReferencePosition,
    entryWorld:c.entryWorldPosition,exitWorld:c.exitWorldPosition,minSigma:c.minSingularValue,endpointMinSigma:c.endpointMinSigma,
    referenceDistance:c.referenceDistance,worldDistance:c.worldDistance,orientationProduct:c.orientationProduct,stability:c.stability})),windows,counts};
mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/connection-history.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({primary:evidence.primary,counts,windows},null,2));
