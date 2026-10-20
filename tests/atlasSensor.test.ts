import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { observe } from '../src/sensors/atlasSensor';

const FORBIDDEN = ['referencePosition', 'entryReferencePosition', 'exitReferencePosition', 'sampledSafeUntil', 'traversalCost', 'stability', 'confidence', 'hessian', 'gradient', 'value', 'field', 'waves', 'minSingularValue', 'axis'];

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}

describe('ATLAS sensor contract', () => {
  it('exposes only present, bounded, non-privileged observations', () => {
    const engine = new SimulationEngine();
    const o = observe(engine);
    expect(o.contractVersion).toBe(1);
    expect(o.time).toBe(engine.clock.time);
    for (const key of FORBIDDEN) expect(keysDeep(o).has(key)).toBe(false);
    for (const i of o.islands) expect(i.range).toBeLessThanOrEqual(o.sensorRange);
    for (const c of o.connections) expect(c.range).toBeLessThanOrEqual(o.sensorRange);
    expect(o.local.gravity.every(Number.isFinite)).toBe(true);
    expect(o.local.hazard).toBeGreaterThanOrEqual(0);
    expect(o.local.hazard).toBeLessThanOrEqual(1);
  });

  it('is deterministic and does not mutate the engine', () => {
    const a = new SimulationEngine(), b = new SimulationEngine();
    a.advance(0.1); b.advance(0.1);
    const before = JSON.stringify([a.scenario(), a.debris.states, a.network.getConnections(a.clock.time)]);
    expect(observe(a)).toEqual(observe(b));
    observe(a, { sensorRange: 500 });
    expect(JSON.stringify([a.scenario(), a.debris.states, a.network.getConnections(a.clock.time)])).toBe(before);
  });

  it('respects the sensor range and rejects invalid ranges', () => {
    const engine = new SimulationEngine();
    expect(observe(engine, { sensorRange: 1e6 }).islands).toHaveLength(14);
    expect(observe(engine, { sensorRange: 1e-3 }).islands).toHaveLength(0);
    expect(() => observe(engine, { sensorRange: Number.NaN })).toThrow(RangeError);
    expect(() => observe(engine, { sensorRange: 0 })).toThrow(RangeError);
  });
});
