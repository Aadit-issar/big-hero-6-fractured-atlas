import { describe, expect, it } from 'vitest';
import { symmetricSpectrum, multiply, sub, scale, norm, distance } from '../src/simulation/linearAlgebra';
import { createSpatialParameters, sampleSpatial, SPATIAL_MODEL } from '../src/simulation/spatialModel';
import { boundedLocalJacobian, deformPosition } from '../src/simulation/deformation';
import { invertWorldPosition } from '../src/simulation/coordinates';
import type { Mat3, Vec3 } from '../src/simulation/types';

const field=createSpatialParameters(17062026),mapping=SPATIAL_MODEL.mapping;
describe('symmetric fold mathematics',()=>{
  it('diagonalizes a rotated matrix and identifies the smallest singular stretch',()=>{
    const matrix:Mat3=[1,1,0,1,1,0,0,0,-3];const s=symmetricSpectrum(matrix);
    expect(s.eigenvalues[0]).toBeCloseTo(-3);expect(s.eigenvalues[1]).toBeCloseTo(0);expect(s.eigenvalues[2]).toBeCloseTo(2);
    s.eigenvectors.forEach((v,i)=>expect(norm(sub(multiply(matrix,v),scale(v,s.eigenvalues[i]!)))).toBeLessThan(1e-10));
    expect(s.minSingularValue).toBeLessThan(1e-10);
  });
  it('matches the world Jacobian and analytical deformation velocity with finite differences',()=>{
    const q:Vec3=[2.3,1.7,-4.2],t=7,h=1e-5,s=sampleSpatial(q,t,field);
    for(let axis=0;axis<3;axis++) {
      const a=[...q] as [number,number,number],b=[...q] as [number,number,number];a[axis]=a[axis]!+h;b[axis]=b[axis]!-h;
      const derivative=scale(sub(deformPosition(a,t,field,mapping),deformPosition(b,t,field,mapping)),1/(2*h*mapping.worldScale));
      for(let row=0;row<3;row++)expect(derivative[row]).toBeCloseTo(s.jacobian[row*3+axis]!,7);
    }
    const temporal=scale(sub(deformPosition(q,t+h,field,mapping),deformPosition(q,t-h,field,mapping)),1/(2*h));
    expect(distance(temporal,s.velocity)).toBeLessThan(1e-7);
  });
  it('contains both stable and compressed regions without numerical divergence',()=>{
    const sigma:number[]=[];
    for(let i=0;i<200;i++) {
      const s=sampleSpatial([Math.sin(i)*6,Math.cos(i*.31)*4,-12+(i%17)],i%40,field);
      expect([...s.gradient,...s.hessian,...s.jacobian,s.hazard,...s.gravity].every(Number.isFinite)).toBe(true);
      expect(s.hazard).toBeGreaterThanOrEqual(0);expect(s.hazard).toBeLessThan(1);sigma.push(s.minSingularValue);
    }
    expect(Math.min(...sigma)).toBeLessThan(.08);expect(Math.max(...sigma)).toBeGreaterThan(.8);
  });
  it('keeps the Phase 2 field finite across seeds and long model intervals',()=>{
    for(const seed of [17062026,7,92341])for(const t of [0,60,600,7200])for(let i=0;i<12;i++) {
      const s=sampleSpatial([i-6,Math.cos(i)*4,-i],t,createSpatialParameters(seed));
      expect([s.value,...s.gradient,...s.hessian,...s.jacobian,...s.velocity,...s.gravity,s.hazard].every(Number.isFinite)).toBe(true);
      expect(distance(s.worldPosition,scale([i-6,Math.cos(i)*4,-i],7.5))).toBeLessThan(26.91);
    }
  });
});

describe('branch-aware damped inverse',()=>{
  it('keeps local terrain stretch bounded and orientation preserving at strong curvature',()=>{
    for(let i=0;i<80;i++) {
      const s=sampleSpatial([Math.sin(i)*6,Math.cos(i)*4,-i%16],i,field);
      const local=symmetricSpectrum(boundedLocalJacobian(s.hessian,mapping.strength));
      for(const eigen of local.eigenvalues){expect(eigen).toBeGreaterThanOrEqual(.82-1e-12);expect(eigen).toBeLessThanOrEqual(1.18+1e-12);}
    }
  });
  it('recovers well-conditioned reference positions from a nearby branch seed',()=>{
    for(const q of [[-3,2,3],[0,5,2],[-4,4,-8]] as Vec3[]) {
      expect(sampleSpatial(q,3,field).minSingularValue).toBeGreaterThan(.3);
      const world=deformPosition(q,3,field,mapping);
      const result=invertWorldPosition(world,3,[q[0]+.03,q[1]-.02,q[2]+.03],field,mapping);
      expect(result.status).toBe('converged');expect(distance(result.referencePosition,q)).toBeLessThan(1e-5);expect(result.residual).toBeLessThan(1e-5);
    }
  });
  it('continues a local branch through successive nearby reference positions',()=>{
    let guess:Vec3=[-3,2,3];
    for(let i=0;i<30;i++) {
      const q:Vec3=[-3+i*.005,2,3];const world=deformPosition(q,i*.01,field,mapping);
      const result=invertWorldPosition(world,i*.01,guess,field,mapping);
      expect(result.status).toBe('converged');expect(distance(result.referencePosition,guess)).toBeLessThan(.02);guess=result.referencePosition;
    }
  });
  it('reports bounded nonconvergence and preserves the last branch estimate',()=>{
    const initial:Vec3=[0,0,0];const result=invertWorldPosition([1000,1000,1000],0,initial,field,mapping,3);
    expect(result.status).toBe('not-converged');expect(result.referencePosition).toEqual(initial);expect(result.iterations).toBeLessThanOrEqual(3);
    expect(result.residual).toBeCloseTo(distance(deformPosition(result.referencePosition,0,field,mapping),[1000,1000,1000]),10);
    expect(invertWorldPosition([NaN,0,0],0,initial,field,mapping).status).toBe('invalid-input');
  });
  it('does not silently switch branches when a perturbed singular inverse fails',()=>{
    const q:Vec3=[4,-1,-8],guess:Vec3=[4.03,-1.02,-7.97];
    expect(sampleSpatial(q,3,field).minSingularValue).toBeLessThan(.001);
    const result=invertWorldPosition(deformPosition(q,3,field,mapping),3,guess,field,mapping);
    expect(result.status).toBe('not-converged');expect(result.referencePosition).toEqual(guess);
  });
});
