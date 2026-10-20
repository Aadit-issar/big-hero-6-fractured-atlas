import { norm, distance } from '../simulation/linearAlgebra';
import type { SimulationEngine } from '../simulation/simulationEngine';
import type { SimulationTelemetry } from './sceneTypes';
import { SPATIAL_MODEL } from '../simulation/spatialModel';

export function collectTelemetry(engine:SimulationEngine):SimulationTelemetry {
  const explorer=engine.explorer,time=engine.clock.time,sample=engine.sampleField(explorer.referencePosition,time);
  const nearby=explorer.nearby(time),connections=engine.network.getConnections(time);
  const nearest=nearby?.connection??[...connections].filter(c=>c.open||c.valid).sort((a,b)=>distance(explorer.worldPosition,a.entryWorldPosition)-distance(explorer.worldPosition,b.entryWorldPosition))[0];
  const separation=nearby?.worldDistance??(nearest?distance(explorer.worldPosition,nearest.entryWorldPosition):0);
  return {time,cameraPosition:explorer.worldPosition,fieldValue:sample.value,distortion:sample.gradientMagnitude,jacobianDeterminant:sample.jacobianDeterminant,
    referencePosition:explorer.referencePosition,referenceStatus:explorer.inverse.status,referenceResidual:explorer.inverse.residual,regionId:explorer.regionId,
    minSingularValue:sample.minSingularValue,gravity:norm(sample.gravity),hazard:sample.hazard,activeConnections:connections.filter(c=>c.open).length,
    nearestFold:nearest?`${nearest.id} · ${nearest.state.toUpperCase()} · ${separation.toFixed(1)}u`:'No open connections',
    interactionHint:time-explorer.lastTraversalTime<SPATIAL_MODEL.traversalCooldown?'Branch transfer cooling down':nearby?.connection.open?(explorer.inverse.status==='not-converged'?'E · Select entrance branch & traverse':'E · Traverse fold'):nearby?'Connection unavailable':'Fly toward a lit aperture',
    traversalCount:explorer.traversalCount,lastTransition:explorer.lastTransition};
}
