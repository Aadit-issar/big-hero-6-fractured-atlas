import type { Vec3 } from '../simulation/types';

export interface SimulationTelemetry {
  readonly time: number;
  readonly cameraPosition: Vec3;
  readonly fieldValue: number;
  readonly distortion: number;
  readonly jacobianDeterminant: number;
  readonly referencePosition:Vec3;
  readonly referenceStatus:string;
  readonly referenceResidual:number;
  readonly regionId:string;
  readonly minSingularValue:number;
  readonly gravity:number;
  readonly hazard:number;
  readonly activeConnections:number;
  readonly nearestFold:string;
  readonly interactionHint:string;
  readonly traversalCount:number;
  readonly lastTransition:string;
}
