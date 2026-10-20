import type { SimulationEngine } from '../simulation/simulationEngine';
import { distance, multiply, scale } from '../simulation/linearAlgebra';
import type { Vec3 } from '../simulation/types';
import { DEFAULT_SENSOR_RANGE } from '../shared/atlasContract';
import type { AtlasObservation, AtlasSensorOptions, ObservedConnection, ObservedIsland } from '../shared/atlasContract';

/** The only bridge from the simulation to ATLAS. It reads the engine at the
 * current clock time only, from the explorer's own position, within a bounded
 * range, and strips hidden quantities (reference coordinates, field values,
 * Hessians, safety horizons, traversal costs, stability/confidence scores).
 * It never mutates the engine and never queries other times. */
export function observe(engine: SimulationEngine, options: AtlasSensorOptions = {}): AtlasObservation {
  const range = options.sensorRange ?? DEFAULT_SENSOR_RANGE;
  if (!Number.isFinite(range) || range <= 0) throw new RangeError('Sensor range must be a positive finite number.');
  const time = engine.clock.time;
  const observer = engine.explorer.worldPosition;

  const sample = engine.sampleField(engine.explorer.referencePosition, time);
  // Express gravity in the world frame: J·g, scaled to rendering units.
  const gravity = scale(multiply(sample.jacobian, sample.gravity), engine.mapping.worldScale);

  const islands: ObservedIsland[] = [];
  for (const island of engine.world.islands) {
    const worldPosition = engine.evaluateIsland(island, time);
    const r = distance(observer, worldPosition);
    if (r <= range) islands.push({ id: island.id, worldPosition: copy(worldPosition), range: r });
  }

  const connections: ObservedConnection[] = [];
  for (const c of engine.network.getConnections(time)) {
    if (!c.valid) continue;
    const r = Math.min(distance(observer, c.entryWorldPosition), distance(observer, c.exitWorldPosition));
    if (r <= range) connections.push({ id: c.id, state: c.state, entryWorldPosition: copy(c.entryWorldPosition), exitWorldPosition: copy(c.exitWorldPosition), range: r });
  }

  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    contractVersion: 1, time, observerWorldPosition: copy(observer), sensorRange: range,
    local: { gravity: copy(gravity), hazard: sample.hazard },
    islands: islands.sort(byId), connections: connections.sort(byId),
  };
}

const copy = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
