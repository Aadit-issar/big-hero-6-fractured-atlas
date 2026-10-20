import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { invertWorldPosition } from '../src/simulation/coordinates';
import { distance } from '../src/simulation/linearAlgebra';
import { SPATIAL_MODEL } from '../src/simulation/spatialModel';

const engine=new SimulationEngine();
describe('field-derived connection graph',()=>{
  it('provides real near-degenerate candidates and open connections at the default start',()=>{
    const active=engine.network.getActiveConnections(0);expect(active.length).toBeGreaterThan(0);
    for(const c of active) {
      expect(c.minSingularValue).toBeLessThan(.001);expect(c.referenceDistance).toBeGreaterThanOrEqual(1.8);
      expect(c.worldDistance).toBeLessThan(6);expect(c.orientationProduct).toBeLessThan(0);expect(c.endpointMinSigma).toBeGreaterThanOrEqual(.06);
      expect(distance(engine.network.map(c.entryReferencePosition,c.sampledAtTime),c.entryWorldPosition)).toBeLessThan(1e-10);
      expect(c.sampledSafeUntil).toBeGreaterThanOrEqual(1);
      expect(engine.network.getConnectionsForRegion(c.fromRegionId,0).some(x=>x.id===c.id)).toBe(true);
    }
  });
  it('reconstructs opening and closing from explicit time independent of request order',()=>{
    const other=new SimulationEngine();
    for(const t of [24,0,8,3,16,2,0])expect(other.network.getConnections(t)).toEqual(engine.network.getConnections(t));
    const first=engine.network.getConnections(0)[0]!;
    const states=Array.from({length:100},(_,i)=>engine.network.getConnectionState(first.id,i*.25)!.state);
    expect(states).toContain('open');expect(states).toContain('closing');expect(states).toContain('closed');
  });
  it('rejects invalid geometric pairs and reports uncertainty at singularity',()=>{
    const invalid=Array.from({length:161},(_,i)=>engine.network.getConnections(i*.25)).flat().filter(c=>!c.valid);
    expect(invalid.length).toBeGreaterThan(0);
    for(const c of invalid)expect(c.open).toBe(false);
    const root=engine.network.getActiveConnections(0)[0]!;
    const inverse=invertWorldPosition(root.worldPosition,0,root.referencePosition,engine.field,engine.mapping);
    expect(inverse.status).toBe('ill-conditioned');expect(inverse.residual).toBeLessThan(1e-5);
  });
});

describe('atomic fold traversal',()=>{
  it('changes the reference branch, preserves a finite clear exit, and prevents immediate reentry',()=>{
    const e=new SimulationEngine();const c=e.network.getConnectionState(e.explorer.primaryFoldId!,0)!;
    e.explorer.referencePosition=c.entryReferencePosition;e.explorer.updateWorld(c.entryWorldPosition,0);
    const before=e.explorer.referencePosition;const result=e.explorer.traverse(0,c.id);
    expect(result.accepted).toBe(true);expect(e.explorer.regionId).toBe(c.toRegionId);
    expect(distance(before,e.explorer.referencePosition)).toBeGreaterThan(1.8);
    expect(e.explorer.worldPosition.every(Number.isFinite)).toBe(true);expect(e.explorer.clearance(e.explorer.worldPosition,0)).toBeGreaterThan(1);
    expect(e.sampleField(e.explorer.referencePosition,0).minSingularValue).toBeGreaterThanOrEqual(.2);
    expect(distance(e.explorer.worldPosition,c.exitWorldPosition)).toBeGreaterThan(4);
    expect(e.explorer.traverse(.1).accepted).toBe(false);expect(e.explorer.traversalCount).toBe(1);
  });
  it('rejects closing connections and resets the explorer coherently',()=>{
    const e=new SimulationEngine();const id=e.explorer.primaryFoldId!;
    const time=Array.from({length:160},(_,i)=>i*.25).find(t=>e.network.getConnectionState(id,t)!.state==='closing')!;
    expect(time).toBeDefined();const c=e.network.getConnectionState(id,time)!;
    e.explorer.referencePosition=c.entryReferencePosition;e.explorer.updateWorld(c.entryWorldPosition,time);
    const before=e.explorer.worldPosition;expect(e.explorer.traverse(time,id).accepted).toBe(false);expect(e.explorer.worldPosition).toEqual(before);
    e.reset();expect(e.explorer.regionId).toBe('origin');expect(e.explorer.traversalCount).toBe(0);expect(e.scenario().modelVersion).toBe(SPATIAL_MODEL.version);
  });
  it('allows explicit entrance selection after a local inverse branch terminates',()=>{
    const e=new SimulationEngine(),c=e.network.getConnectionState(e.explorer.primaryFoldId!,0)!;
    e.explorer.worldPosition=c.entryWorldPosition;
    e.explorer.referencePosition=c.entryReferencePosition;
    e.explorer.inverse={referencePosition:e.explorer.referencePosition,status:'not-converged',residual:1,iterations:14,minSingularValue:0};
    expect(e.explorer.traverse(0,c.id).accepted).toBe(true);
    expect(e.explorer.inverse.status).toBe('converged');expect(e.explorer.regionId).toBe(c.toRegionId);
  });
});
