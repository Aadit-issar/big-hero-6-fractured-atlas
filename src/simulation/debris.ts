import { createSeededRandom } from './seededRandom';
import { add, scale, sub, norm } from './linearAlgebra';
import { sampleSpatial } from './spatialModel';
import type { DeformationSettings, FieldParameters, Vec3 } from './types';

export interface DebrisState { readonly id:string; readonly anchor:Vec3; referencePosition:Vec3; velocity:Vec3 }
export const DEBRIS_STEP=1/60;

/** Symplectic Euler at integer model ticks. Spring confinement and drag are
 * explicit fictional forces; intensity modulates the field-derived gravity. */
export class DebrisSystem {
  readonly initial:readonly DebrisState[];
  states:DebrisState[];
  tick=0;
  targetReached=true;
  constructor(seed:number,origin:Vec3,readonly field:FieldParameters,readonly mapping:DeformationSettings) {
    const random=createSeededRandom(seed^0x675a89);
    this.initial=Array.from({length:12},(_,i)=>{
      const anchor=add(origin,[(random()-.5)*3,(random()-.5)*2.8,(random()-.5)*3]);
      return {id:`probe-${i}`,anchor,referencePosition:anchor,velocity:[(random()-.5)*.1,(random()-.5)*.1,(random()-.5)*.1] as Vec3};
    });
    this.states=this.initial.map(s=>({...s}));
  }
  reset(){this.tick=0;this.states=this.initial.map(s=>({...s}));this.targetReached=true;}
  advanceTo(time:number,budget=240):boolean {
    if(!Number.isFinite(time)||time<0)throw new RangeError('Invalid debris time.');
    const target=Math.floor((time+1e-9)/DEBRIS_STEP);
    if(target<this.tick)this.reset();
    let work=0;
    while(this.tick<target&&work<budget) {
      const t=this.tick*DEBRIS_STEP;
      for(const state of this.states) {
        const gravity=sampleSpatial(state.referencePosition,t,this.field,this.mapping).gravity;
        const acceleration=sub(sub(gravity,scale(sub(state.referencePosition,state.anchor),.65)),scale(state.velocity,.95));
        state.velocity=add(state.velocity,scale(acceleration,DEBRIS_STEP));
        state.referencePosition=add(state.referencePosition,scale(state.velocity,DEBRIS_STEP));
        if(!state.referencePosition.every(Number.isFinite)||norm(state.velocity)>100)throw new RangeError('Debris integration failed.');
      }
      this.tick++;work++;
    }
    this.targetReached=this.tick===target;return this.targetReached;
  }
}
