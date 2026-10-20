import { invertWorldPosition } from './coordinates';
import type { InverseResult } from './coordinates';
import { add, distance, scale } from './linearAlgebra';
import type { FoldConnection, FoldNetwork } from './fractures';
import { sampleSpatial, SPATIAL_MODEL } from './spatialModel';
import type { Vec3, WorldDefinition } from './types';

export class ExplorerState {
  referencePosition:Vec3;
  worldPosition:Vec3;
  regionId='origin';
  traversalCount=0;
  lastTraversalTime=-Infinity;
  lastTransition='';
  inverse:InverseResult;
  readonly openingReference:Vec3;
  readonly primaryFoldId:string|null;
  constructor(readonly network:FoldNetwork,readonly world:WorldDefinition) {
    const primary=network.getActiveConnections(0).find(c=>c.entryWorldPosition[1]>8&&this.clearance(c.entryWorldPosition,0)>5)
      ??network.getActiveConnections(0).find(c=>this.clearance(c.entryWorldPosition,0)>3);
    this.primaryFoldId=primary?.id??null;
    // Keep the original foreground world in view while facing a genuine discovered fold.
    this.openingReference=[0,2,3.5];
    this.referencePosition=this.openingReference;
    this.worldPosition=network.map(this.referencePosition,0);
    this.inverse={referencePosition:this.referencePosition,status:'converged',residual:0,iterations:0,minSingularValue:1};
  }
  clearance(position:Vec3,time:number):number {
    return Math.min(...this.world.islands.map(i=>distance(position,this.network.map(i.referencePosition,time))-i.radius-i.height));
  }
  pose(time:number) {
    const position=this.network.map(this.openingReference,time);
    const c=this.primaryFoldId?this.network.getConnectionState(this.primaryFoldId,time):null;
    return {position,target:c?.entryWorldPosition??this.network.map([0,0,-4],time)};
  }
  reset(time=0,clearHistory=true) {
    this.referencePosition=this.openingReference;this.worldPosition=this.network.map(this.openingReference,time);this.regionId='origin';
    this.inverse={referencePosition:this.referencePosition,status:'converged',residual:0,iterations:0,minSingularValue:1};
    if(clearHistory){this.traversalCount=0;this.lastTraversalTime=-Infinity;this.lastTransition='';}
  }
  updateWorld(position:Vec3,time:number) {
    if(!position.every(Number.isFinite))return;
    this.worldPosition=position;
    this.inverse=invertWorldPosition(position,time,this.referencePosition,this.network.field,this.network.mapping);
    if(this.inverse.status==='converged'||this.inverse.status==='ill-conditioned')this.referencePosition=this.inverse.referencePosition;
  }
  nearby(time:number) {
    const choices=this.network.getConnections(time).filter(c=>c.valid).flatMap(c=>[
      {connection:c,side:'A' as const,worldDistance:distance(this.worldPosition,c.entryWorldPosition),referenceDistance:distance(this.referencePosition,c.entryReferencePosition)},
      {connection:c,side:'B' as const,worldDistance:distance(this.worldPosition,c.exitWorldPosition),referenceDistance:distance(this.referencePosition,c.exitReferencePosition)},
    ]).filter(c=>c.worldDistance<SPATIAL_MODEL.approachRadius);
    return choices.sort((a,b)=>a.referenceDistance-b.referenceDistance||a.worldDistance-b.worldDistance)[0]??null;
  }
  traverse(time:number,id?:string):{accepted:boolean;reason:string;connection?:FoldConnection} {
    if(time-this.lastTraversalTime<SPATIAL_MODEL.traversalCooldown)return {accepted:false,reason:'Traversal cooldown'};
    const nearby=this.nearby(time);
    if(!nearby||id&&nearby.connection.id!==id)return {accepted:false,reason:'Approach a fold aperture'};
    const c=this.network.getConnectionState(nearby.connection.id,time);
    if(!c?.open)return {accepted:false,reason:'Connection is not open'};
    // E is an explicit branch selection: the nearby mathematical endpoint
    // identifies the entrance even if free flight crossed a local inverse caustic.
    // Never silently relocalize the continuous flight probe to another branch.
    if(this.inverse.status==='invalid-input')return {accepted:false,reason:'Invalid explorer coordinates'};
    const reverse=nearby.side==='B';const destination=reverse?c.entryReferencePosition:c.exitReferencePosition;
    let exit:Vec3|null=null;
    for(const offset of [.8,1.2,1.6,2]) {
      for(const lift of [0,.4,.8,1.3,1.9,2.7]) {
        const q=add(add(destination,scale(c.axis,reverse?-offset:offset)),[0,lift,0]);
        const sample=sampleSpatial(q,time,this.network.field,this.network.mapping);
        if(sample.minSingularValue>=.2&&distance(sample.worldPosition,this.network.map(destination,time))>4&&this.clearance(sample.worldPosition,time)>1){exit=q;break;}
      }
      if(exit)break;
    }
    if(!exit)return {accepted:false,reason:'Exit clearance unavailable'};
    const oldRegion=this.regionId;
    this.referencePosition=exit;this.worldPosition=this.network.map(exit,time);
    this.regionId=reverse?c.fromRegionId:c.toRegionId;
    this.traversalCount++;this.lastTraversalTime=time;this.lastTransition=`${oldRegion} → ${this.regionId}`;
    this.inverse={referencePosition:exit,status:'converged',residual:0,iterations:0,minSingularValue:sampleSpatial(exit,time,this.network.field,this.network.mapping).minSingularValue};
    return {accepted:true,reason:this.lastTransition,connection:c};
  }
}
