import { describe, expect, it } from 'vitest';
import { DebrisSystem, DEBRIS_STEP } from '../src/simulation/debris';
import { createSpatialParameters, sampleSpatial, SPATIAL_MODEL } from '../src/simulation/spatialModel';
import { add, scale, distance } from '../src/simulation/linearAlgebra';
import { SimulationEngine } from '../src/simulation/simulationEngine';

const field=createSpatialParameters(17062026),mapping=SPATIAL_MODEL.mapping;
describe('field gravity and hazard',()=>{
  it('derives a real probe velocity change from the field force',()=>{
    const system=new DebrisSystem(5,[0,2,0],field,mapping);const state=system.states[0]!;
    state.velocity=[0,0,0];const q=state.referencePosition;const gravity=sampleSpatial(q,0,field).gravity;
    system.advanceTo(DEBRIS_STEP);
    expect(distance(state.velocity,scale(gravity,DEBRIS_STEP))).toBeLessThan(1e-12);
    expect(distance(state.referencePosition,add(q,scale(gravity,DEBRIS_STEP**2)))).toBeLessThan(1e-12);
    expect(distance(q,state.referencePosition)).toBeGreaterThan(0);
  });
  it('replays fixed steps identically under different update cadences',()=>{
    const a=new DebrisSystem(5,[0,2,0],field,mapping),b=new DebrisSystem(5,[0,2,0],field,mapping);
    a.advanceTo(4,1000);for(let i=1;i<=80;i++)b.advanceTo(i*.05);
    expect(a.states).toEqual(b.states);expect(a.tick).toBe(240);
    for(const state of a.states)expect(state.referencePosition.every(Number.isFinite)).toBe(true);
    a.reset();expect(a.states).toEqual(a.initial);
  });
  it('bounds catch-up work explicitly and distinguishes hazard over space and time',()=>{
    const system=new DebrisSystem(5,[0,2,0],field,mapping);
    expect(system.advanceTo(100,10)).toBe(false);expect(system.tick).toBe(10);
    const samples=Array.from({length:50},(_,i)=>sampleSpatial([Math.sin(i)*5,Math.cos(i)*3,-i*.2],i%12,field));
    const scores=samples.map(s=>s.hazard);
    expect(Math.max(...scores)-Math.min(...scores)).toBeGreaterThan(.3);
    expect(samples[0]!.gravity).not.toEqual(samples[1]!.gravity);
  });
  it('confines gravity probes during a two-minute deterministic stress replay',()=>{
    const system=new DebrisSystem(5,[0,2,0],field,mapping);
    for(let i=0;i<31;i++)system.advanceTo(120);
    expect(system.targetReached).toBe(true);expect(system.tick).toBe(7200);
    for(const state of system.states) {
      expect([...state.referencePosition,...state.velocity].every(Number.isFinite)).toBe(true);
      expect(distance(state.referencePosition,state.anchor)).toBeLessThan(5);
    }
  });
  it('freezes debris and all sampled environment state on pause, and resets identically',()=>{
    const engine=new SimulationEngine();engine.advance(.05);engine.clock.pause();
    const before=JSON.stringify({states:engine.debris.states,connections:engine.network.getConnections(engine.clock.time)});
    engine.advance(.1);expect(JSON.stringify({states:engine.debris.states,connections:engine.network.getConnections(engine.clock.time)})).toBe(before);
    engine.reset();expect(engine.debris.states).toEqual(engine.debris.initial);expect(engine.clock.time).toBe(0);
  });
  it('reproduces the complete authoritative environment under different frame cadences',()=>{
    const a=new SimulationEngine(),b=new SimulationEngine();
    for(let i=0;i<120;i++)a.advance(1/60);
    for(let i=0;i<40;i++)b.advance(.05);
    expect(a.clock.time).toBeCloseTo(b.clock.time,10);expect(a.debris.states).toEqual(b.debris.states);
    expect(a.network.getConnections(a.clock.time)).toEqual(b.network.getConnections(b.clock.time));
    for(const island of a.world.islands)expect(distance(a.evaluateIsland(island,a.clock.time),b.evaluateIsland(island,b.clock.time))).toBeLessThan(1e-10);
    const sa=a.sampleField([2,1,-3],a.clock.time),sb=b.sampleField([2,1,-3],b.clock.time);
    expect(sa.hazard).toBeCloseTo(sb.hazard,12);expect(distance(sa.gravity,sb.gravity)).toBeLessThan(1e-12);
  });
});
