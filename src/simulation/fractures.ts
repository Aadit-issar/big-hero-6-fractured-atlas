import { deformPosition } from './deformation';
import { add, sub, scale, distance, dot, multiply, normalize } from './linearAlgebra';
import { sampleSpatial, SPATIAL_MODEL } from './spatialModel';
import type { DeformationSettings, FieldParameters, Vec3 } from './types';

export interface FoldAnchor { readonly id: string; readonly referencePosition: Vec3; readonly axis: Vec3; readonly discoveredAt: number }
export interface FoldCandidate {
  readonly id: string; readonly referencePosition: Vec3; readonly worldPosition: Vec3; readonly sampledAtTime: number;
  readonly axis: Vec3; readonly minSingularValue: number; readonly distortion: number; readonly stability: number;
  readonly confidence: number; readonly valid: boolean; readonly entryReferencePosition: Vec3; readonly exitReferencePosition: Vec3;
  readonly entryWorldPosition: Vec3; readonly exitWorldPosition: Vec3; readonly entryNormal: Vec3; readonly exitNormal: Vec3;
  readonly referenceDistance: number; readonly worldDistance: number; readonly endpointMinSigma: number; readonly orientationProduct: number; readonly hazard: number;
}
export type ConnectionStatus = 'inactive' | 'forming' | 'open' | 'unstable' | 'closing' | 'closed';
export interface FoldConnection extends FoldCandidate {
  readonly state: ConnectionStatus; readonly open: boolean; readonly fromRegionId: string; readonly toRegionId: string;
  readonly traversalCost: number; readonly sampledSafeUntil: number;
}

const canonical = (v: Vec3): Vec3 => {
  const axis = [0,1,2].sort((a,b)=>Math.abs(v[b]!) - Math.abs(v[a]!))[0]!;
  return scale(v, v[axis]! < 0 ? -1 : 1);
};

/** Initial sparse sign-change scan, followed by bounded eigenvalue bisection. */
export function discoverFoldAnchors(field: FieldParameters, mapping: DeformationSettings): FoldAnchor[] {
  const result: FoldAnchor[] = [];
  for (const time of [0, 16, 32]) {
    const nodes: { q: Vec3; eigen: number }[] = [];
    const nx = 7, ny = 4, nz = 9;
    for (let x=0;x<nx;x++) for(let y=0;y<ny;y++) for(let z=0;z<nz;z++) {
      const q: Vec3 = [-6+x*2, -2+y*2, -12+z*2];
      nodes.push({q,eigen:sampleSpatial(q,time,field,mapping).eigenvalues[0]});
    }
    const at=(x:number,y:number,z:number)=>nodes[(x*ny+y)*nz+z]!;
    let refined = 0;
    for(let x=0;x<nx;x++) for(let y=0;y<ny;y++) for(let z=0;z<nz;z++) {
      const a=at(x,y,z);
      for(const [dx,dy,dz] of [[1,0,0],[0,1,0],[0,0,1]] as const) {
        if(x+dx>=nx||y+dy>=ny||z+dz>=nz||refined>=80) continue;
        const b=at(x+dx,y+dy,z+dz);
        if(a.eigen*b.eigen>=0) continue;
        let lo=a.q, hi=b.q, sign=a.eigen;
        for(let i=0;i<10;i++) {
          const mid=scale(add(lo,hi),.5); const e=sampleSpatial(mid,time,field,mapping).eigenvalues[0];
          if(e*sign>0) {lo=mid;sign=e;} else hi=mid;
        }
        const q=scale(add(lo,hi),.5); const s=sampleSpatial(q,time,field,mapping); refined++;
        if(result.some(r=>distance(r.referencePosition,q)<1.35)) continue;
        result.push({id:`fold-${result.length.toString().padStart(2,'0')}`,referencePosition:q,axis:canonical(s.compressionAxis),discoveredAt:time});
      }
    }
  }
  return result;
}

/** Track a root along a fixed seed-derived reference line, not a rendered path. */
export function evaluateFoldAnchor(anchor: FoldAnchor, time: number, field: FieldParameters, mapping: DeformationSettings): FoldCandidate {
  let root: Vec3 | null = null;
  let lo=add(anchor.referencePosition,scale(anchor.axis,-1.8));
  let previous=sampleSpatial(lo,time,field,mapping).eigenvalues[0];
  for(let i=1;i<=8;i++) {
    const hi=add(anchor.referencePosition,scale(anchor.axis,-1.8+i*.45));
    const value=sampleSpatial(hi,time,field,mapping).eigenvalues[0];
    if(previous*value<=0) {
      let a=lo, b=hi, sign=previous;
      for(let j=0;j<9;j++) {
        const mid=scale(add(a,b),.5); const e=sampleSpatial(mid,time,field,mapping).eigenvalues[0];
        if(sign*e>0) {a=mid;sign=e;} else b=mid;
      }
      const candidate=scale(add(a,b),.5);
      if(!root||distance(candidate,anchor.referencePosition)<distance(root,anchor.referencePosition)) root=candidate;
    }
    previous=value;lo=hi;
  }
  const q=root??anchor.referencePosition; const s=sampleSpatial(q,time,field,mapping);
  const axis=canonical(s.compressionAxis);
  let chosen: {a:Vec3;b:Vec3;sa:ReturnType<typeof sampleSpatial>;sb:ReturnType<typeof sampleSpatial>} | null=null;
  for(const offset of [.95,1.15,1.35]) {
    const a=sub(q,scale(axis,offset)), b=add(q,scale(axis,offset));
    const sa=sampleSpatial(a,time,field,mapping),sb=sampleSpatial(b,time,field,mapping);
    chosen={a,b,sa,sb};
    if(Math.min(sa.minSingularValue,sb.minSingularValue)>=SPATIAL_MODEL.endpointSigma) break;
  }
  const {a,b,sa,sb}=chosen!;
  const orientationProduct=dot(axis,multiply(sa.jacobian,axis))*dot(axis,multiply(sb.jacobian,axis));
  const referenceDistance=distance(a,b), worldDistance=distance(sa.worldPosition,sb.worldPosition);
  const endpointMinSigma=Math.min(sa.minSingularValue,sb.minSingularValue);
  const hazard=Math.max(sa.hazard,sb.hazard);
  const valid=!!root&&s.minSingularValue<SPATIAL_MODEL.foldSigma&&referenceDistance>=SPATIAL_MODEL.referenceSeparation
    &&worldDistance<SPATIAL_MODEL.connectionDistance&&orientationProduct<0&&endpointMinSigma>=SPATIAL_MODEL.endpointSigma&&hazard<.85;
  return {id:anchor.id,referencePosition:q,worldPosition:s.worldPosition,sampledAtTime:time,axis,minSingularValue:s.minSingularValue,
    distortion:s.compression,stability:1-hazard,confidence:root?Math.max(0,1-s.minSingularValue/SPATIAL_MODEL.foldSigma):0,valid,
    entryReferencePosition:a,exitReferencePosition:b,entryWorldPosition:sa.worldPosition,exitWorldPosition:sb.worldPosition,
    entryNormal:normalize(multiply(sa.jacobian,axis)),exitNormal:normalize(multiply(sb.jacobian,axis)),
    referenceDistance,worldDistance,endpointMinSigma,orientationProduct,hazard};
}

/** Pure sampled-time graph. Cache eviction changes cost, never availability. */
export class FoldNetwork {
  readonly anchors: readonly FoldAnchor[];
  private cache=new Map<number,FoldCandidate[]>();
  detectionMilliseconds=0;
  graphMilliseconds=0;
  readonly detectionTimings:number[]=[];
  readonly graphTimings:number[]=[];
  private graphCache=new Map<number,FoldConnection[]>();
  constructor(readonly field:FieldParameters,readonly mapping:DeformationSettings) {
    const discovered=discoverFoldAnchors(field,mapping);
    const ranked=discovered.map(anchor=>{
      const now=evaluateFoldAnchor(anchor,0,field,mapping);
      const durable=now.valid&&[-1,1,2].every(t=>evaluateFoldAnchor(anchor,t,field,mapping).valid);
      return {anchor,now,durable};
    }).sort((a,b)=>Number(b.durable)-Number(a.durable)||Number(b.now.valid)-Number(a.now.valid)
      ||distance(a.now.worldPosition,[0,12,16])-distance(b.now.worldPosition,[0,12,16]));
    const selected:FoldAnchor[]=[];
    for(const {anchor} of ranked) {
      if(selected.some(s=>distance(s.referencePosition,anchor.referencePosition)<2))continue;
      selected.push({...anchor,id:`F${String(selected.length+1).padStart(2,'0')}`});
      if(selected.length===8)break;
    }
    this.anchors=selected;
  }
  private raw(tick:number):FoldCandidate[] {
    const cached=this.cache.get(tick);if(cached)return cached;
    const start=performance.now();
    const result=this.anchors.map(a=>evaluateFoldAnchor(a,tick*SPATIAL_MODEL.sampleInterval,this.field,this.mapping));
    this.detectionMilliseconds=performance.now()-start;
    this.detectionTimings.push(this.detectionMilliseconds);if(this.detectionTimings.length>256)this.detectionTimings.shift();
    this.cache.set(tick,result);if(this.cache.size>96)this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
  getConnections(time:number):FoldConnection[] {
    if(!Number.isFinite(time)||Math.abs(time)>999_990)throw new RangeError('Invalid connection time.');
    const tick=Math.floor((time+1e-10)/SPATIAL_MODEL.sampleInterval);
    const cached=this.graphCache.get(tick);if(cached)return cached;
    const now=this.raw(tick),before=this.raw(tick-4);
    const horizon=[1,2,3,4].map(offset=>this.raw(tick+offset));
    const start=performance.now();
    const result=now.map((candidate,i):FoldConnection=>{
      const prior=before[i]!.valid,future=horizon.every(sample=>sample[i]!.valid);
      const state:ConnectionStatus=!candidate.valid?(prior?'closed':'inactive'):!future?'closing':!prior?'forming':candidate.stability<.48?'unstable':'open';
      return {...candidate,state,open:(state==='open'||state==='unstable')&&candidate.stability>=.25,
        fromRegionId:`${candidate.id}:A`,toRegionId:`${candidate.id}:B`,traversalCost:1+candidate.hazard*4+candidate.worldDistance/6,
        sampledSafeUntil:future?(tick+4)*SPATIAL_MODEL.sampleInterval:tick*SPATIAL_MODEL.sampleInterval};
    });
    this.graphMilliseconds=performance.now()-start;
    this.graphTimings.push(this.graphMilliseconds);if(this.graphTimings.length>256)this.graphTimings.shift();
    this.graphCache.set(tick,result);if(this.graphCache.size>64)this.graphCache.delete(this.graphCache.keys().next().value!);
    return result;
  }
  getActiveConnections(t:number){return this.getConnections(t).filter(c=>c.open);}
  getConnectionsForRegion(regionId:string,t:number){return this.getConnections(t).filter(c=>c.fromRegionId===regionId||c.toRegionId===regionId);}
  getConnectionState(id:string,t:number){return this.getConnections(t).find(c=>c.id===id)??null;}
  map(q:Vec3,t:number){return deformPosition(q,t,this.field,this.mapping);}
}
