import { SimulationEngine } from '../../src/simulation/simulationEngine';
import { observe } from '../../src/sensors/atlasSensor';
import { MoverSystem, moverDefsFor } from './dimensionMovers';
import type { MoverVariant } from './dimensionMovers';
import type { FrameMessage } from '../../src/atlas/live/protocol';
import type { Vec3 } from '../../src/atlas/command/world';

/** A stand-in for the Dimension's publisher, built from the real simulation engine and the real mover dynamics. It is TRUTH-SIDE test code:
 * it produces the frames the Dimension would send (poses, observations, scans of objects within range) and exposes ground truth separately
 * (`truth`) so tests can score ATLAS's forecasts after the fact. ATLAS code never sees `truth`. */
export class LiveWorld {
  readonly engine = new SimulationEngine();
  readonly movers: MoverSystem;
  seq = 0;
  scanId = 0;
  baymax: Vec3 = [-3.8, 10.3, 23.6];
  quaternion: readonly [number, number, number, number] = [0, 0, 0, 1];

  readonly defs;
  constructor(readonly session = 'test-session', readonly variant: MoverVariant = 'cruise') { this.defs = moverDefsFor(variant); this.movers = new MoverSystem(this.engine.field, this.engine.mapping, this.defs); }

  get time(): number { return this.engine.clock.time; }

  /** Advance simulation time by `dt` seconds (the Dimension owns the clock). */
  advance(dt: number): void {
    const steps = Math.max(1, Math.round(dt / 0.05));
    for (let i = 0; i < steps; i += 1) this.engine.advance(dt / steps);
    this.movers.syncTo(this.engine.clock.time);
  }

  /** Ground truth: where a mover really is at the current time. */
  truth(id: string): Vec3 { return this.movers.states().find(s => s.id === id)!.position as Vec3; }
  truthAt(id: string, t: number): Vec3 { const m = new MoverSystem(this.engine.field, this.engine.mapping, this.defs); m.syncTo(t); return m.states().find(s => s.id === id)!.position as Vec3; }

  frame(withScan: boolean, range = 60): FrameMessage {
    (this.engine.explorer as { worldPosition: Vec3 }).worldPosition = this.baymax;
    const observation = observe(this.engine);
    this.seq += 1;
    const objects = withScan ? this.movers.states().flatMap(s => {
      const def = this.defs.find(m => m.id === s.id)!;
      const r = Math.hypot(s.position[0] - this.baymax[0], s.position[1] - this.baymax[1], s.position[2] - this.baymax[2]);
      return r <= (def.beaconRange ?? range) ? [{ id: def.id, category: def.category, family: def.family, kind: def.assetId, label: def.label, orientation: s.quaternion, position: s.position, radius: def.radius, range: r }] : [];
    }) : [];
    this.scanId += withScan ? 1 : 0;
    return {
      type: 'frame', session: this.session, seq: this.seq, wallMs: this.seq * 250, observation, scanMode: 'continuous',
      ...(withScan ? { scan: { scanId: this.scanId, time: this.time, observerPosition: this.baymax, range: 45, coverage: 'proximity-sphere' as const, trigger: 'continuous' as const, objects, omitted: 0 } } : {}),
      pose: { position: this.baymax, quaternion: this.quaternion, forward: [0, 0, -1], velocity: [0, 0, 0] },
      clock: { time: this.time, running: true, timeScale: 1, visible: true },
    };
  }
}
