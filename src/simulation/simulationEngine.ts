import { DEFAULT_SEED } from './constants';
import { deformPosition } from './deformation';
import { createSpatialParameters, sampleSpatial, SPATIAL_MODEL } from './spatialModel';
import { FoldNetwork } from './fractures';
import { ExplorerState } from './explorer';
import { DebrisSystem } from './debris';
import { SimulationClock } from './simulationClock';
import { assertWorldIsDeterministic, createWorld } from './worldGenerator';
import type { FieldParameters, IslandDefinition, Vec3, WorldDefinition } from './types';

export type FieldSample = ReturnType<typeof sampleSpatial>;

/** Stateless field access plus an independent simulation clock. */
export class SimulationEngine {
  readonly seed: number;
  readonly field: FieldParameters;
  readonly world: WorldDefinition;
  readonly clock = new SimulationClock();
  readonly mapping = SPATIAL_MODEL.mapping;
  readonly network: FoldNetwork;
  readonly explorer: ExplorerState;
  readonly debris: DebrisSystem;
  resetRevision = 0;
  readonly performance = { frames: [] as number[], drawCalls: 0, triangles: 0, geometries: 0, textures: 0, detectionMs: 0, graphMs: 0 };

  constructor(seed = DEFAULT_SEED) {
    this.field = createSpatialParameters(seed);
    this.seed = this.field.seed;
    this.world = createWorld(this.seed);
    assertWorldIsDeterministic(this.world);
    this.network = new FoldNetwork(this.field,this.mapping);
    this.explorer = new ExplorerState(this.network,this.world);
    const primary=this.explorer.primaryFoldId?this.network.getConnectionState(this.explorer.primaryFoldId,0):null;
    this.debris = new DebrisSystem(this.seed,primary?.referencePosition??[0,2,0],this.field,this.mapping);
  }

  sampleField(referencePosition: Vec3, simulationTime: number): FieldSample {
    return sampleSpatial(referencePosition,simulationTime,this.field,this.mapping);
  }

  evaluateIsland(island: IslandDefinition, simulationTime: number): Vec3 {
    return deformPosition(island.referencePosition, simulationTime, this.field,this.mapping);
  }

  advance(delta:number):void {this.clock.advance(delta);this.debris.advanceTo(this.clock.time);}
  scenario(){return {seed:this.seed,modelVersion:SPATIAL_MODEL.version,time:this.clock.time,regionId:this.explorer.regionId,referencePosition:this.explorer.referencePosition};}
  reset(): void { this.clock.reset();this.explorer.reset();this.debris.reset();this.resetRevision++; }
}
