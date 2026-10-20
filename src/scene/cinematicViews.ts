import type { SimulationEngine } from '../simulation/simulationEngine';
import type { Vec3 } from '../simulation/types';
import { MIRROR_Y, VORTEX, cavernPoint } from './dimension/layout';

export type ViewpointName = 'hero-overview' | 'geology-closeup' | 'fracture-corridor' | 'mirror-chamber' | 'collapse-toward-light' | 'turbulent-wide' | 'fracture-region' | 'spire-closeup' | 'rift-closeup';
export const VIEWPOINTS: readonly ViewpointName[] = ['hero-overview', 'geology-closeup', 'fracture-corridor', 'mirror-chamber', 'collapse-toward-light', 'turbulent-wide', 'fracture-region', 'spire-closeup', 'rift-closeup'];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rendering-only camera framings (keys 1–9) for inspection and screenshots.
 * Poses derive from the islands' current mapped centres and the fixed
 * dimension layout; selecting one is an ordinary free-flight jump and does
 * not alter simulation state. Region tracking re-localises honestly afterwards. */
export function viewpointPose(name: ViewpointName, engine: SimulationEngine): { position: Vec3; target: Vec3 } {
  const t = engine.clock.time;
  const island = (id: string) => engine.evaluateIsland(engine.world.islands.find((i) => i.id === id)!, t);
  const plateau = island('island-01'), spire = island('island-05'), rift = island('island-03');
  switch (name) {
    case 'hero-overview':
      return { position: add(plateau, [-15, 7.5, 15]), target: mix(plateau, spire, 0.38) };
    case 'geology-closeup':
      return { position: add(plateau, [7.4, 1.4, 6.9]), target: add(plateau, [-0.4, -1.4, 0]) };
    case 'fracture-corridor':
      return { position: cavernPoint(0.16), target: cavernPoint(0.42) };
    case 'mirror-chamber':
      return { position: [-62, MIRROR_Y + 9, 6], target: [10, MIRROR_Y + 14, -70] };
    case 'collapse-toward-light':
      return { position: cavernPoint(0.7), target: VORTEX };
    case 'turbulent-wide':
      return { position: add(plateau, [-48, 26, 30]), target: mix(plateau, VORTEX, 0.25) };
    case 'fracture-region': {
      const id = engine.explorer.primaryFoldId;
      const fold = id ? engine.network.getConnectionState(id, t) : null;
      const entry = fold?.entryWorldPosition ?? spire;
      return { position: add(entry, [-9, 1.5, 11]), target: mix(entry, spire, 0.25) };
    }
    case 'spire-closeup':
      return { position: add(spire, [8.5, 1.5, 9]), target: add(spire, [0, 0.4, 0]) };
    case 'rift-closeup':
      return { position: add(rift, [8.5, 3.2, 7.5]), target: add(rift, [0, -0.6, 0]) };
  }
}
