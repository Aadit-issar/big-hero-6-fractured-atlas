import { deformPosition } from './deformation';
import { evaluateField } from './field';
import { add, sub, scale, multiply, norm, distance, solve3, symmetricSpectrum } from './linearAlgebra';
import { jacobianFromHessian } from './spatialModel';
import type { DeformationSettings, FieldParameters, Mat3, Vec3 } from './types';

export interface InverseResult { readonly referencePosition:Vec3;readonly status:'converged'|'ill-conditioned'|'not-converged'|'invalid-input';readonly residual:number;readonly iterations:number;readonly minSingularValue:number }

/** Local branch continuation using damped least squares and a trust radius.
 * Failure returns the last accepted reference coordinate, never X/L. */
export function invertWorldPosition(world:Vec3,time:number,initial:Vec3,field:FieldParameters,mapping:DeformationSettings,maxIterations=14):InverseResult {
  if(!world.every(Number.isFinite)||!initial.every(Number.isFinite)||!Number.isFinite(time)||Math.abs(time)>999_990||world.some(v=>Math.abs(v)>1e6)||initial.some(v=>Math.abs(v)>999_990))
    return {referencePosition:initial,status:'invalid-input',residual:Infinity,iterations:0,minSingularValue:0};
  const target=scale(world,1/mapping.worldScale);let q=initial;
  let residual=Infinity,sigma=0,attempts=0;
  for(let iteration=0;iteration<maxIterations;iteration++) {
    attempts=iteration+1;
    const e=evaluateField(q,time,field),j=jacobianFromHessian(e.hessian,mapping.strength);
    sigma=symmetricSpectrum(j).minSingularValue;
    const error=sub(add(q,scale(e.gradient,mapping.strength)),target);residual=norm(error)*mapping.worldScale;
    if(residual<1e-5)return {referencePosition:q,status:sigma<.03?'ill-conditioned':'converged',residual,iterations:iteration,minSingularValue:sigma};
    const damping=sigma<.1?.015:1e-5;
    // Symmetry permits JᵀJ = JJ. Tikhonov damping prevents singular inversion.
    const normal:number[]=[];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++) {
      let value=0;for(let k=0;k<3;k++)value+=j[k*3+r]!*j[k*3+c]!;
      normal.push(value+(r===c?damping*damping:0));
    }
    const step=solve3(normal as unknown as Mat3,multiply(j,error));if(!step)break;
    const bounded=scale(step,Math.min(1,.35/Math.max(norm(step),1e-12)));
    let accepted=false;
    for(const fraction of [1,.5,.25,.125]) {
      const trial=sub(q,scale(bounded,fraction));
      if(distance(trial,initial)>1.8)continue;
      const trialResidual=distance(deformPosition(trial,time,field,mapping),world);
      if(trialResidual<residual) {q=trial;accepted=true;break;}
    }
    if(!accepted)break;
  }
  // Failure diagnostics must describe the returned estimate, not a discarded trial.
  residual=distance(deformPosition(initial,time,field,mapping),world);
  sigma=symmetricSpectrum(jacobianFromHessian(evaluateField(initial,time,field).hessian,mapping.strength)).minSingularValue;
  return {referencePosition:initial,status:'not-converged',residual,iterations:attempts,minSingularValue:sigma};
}
