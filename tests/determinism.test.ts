import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { createFieldParameters } from '../src/simulation/field';
import { createWorld } from '../src/simulation/worldGenerator';

describe('seeded world reproducibility', () => {
  it('rebuilds identical wave and island configurations from the same seed', () => {
    const left = new SimulationEngine(2026);
    const right = new SimulationEngine(2026);

    expect(left.field).toEqual(right.field);
    expect(left.world).toEqual(right.world);
    expect(left.world.islands.length).toBeGreaterThanOrEqual(8);
  });

  it('changes world layout and field samples when the seed changes', () => {
    const left = new SimulationEngine(2026);
    const right = new SimulationEngine(2027);

    expect(left.field).not.toEqual(right.field);
    expect(left.world.islands[0]).not.toEqual(right.world.islands[0]);
    expect(left.sampleField([2, 1, -4], 3).value).not.toBe(right.sampleField([2, 1, -4], 3).value);
  });

  it('reproduces the same deformed island positions at explicitly supplied times', () => {
    const first = new SimulationEngine(5021);
    const second = new SimulationEngine(5021);
    const times = [0, 0.3, 3.25, 15, 240];

    for (const time of times) {
      first.world.islands.forEach((island, index) => {
        expect(first.evaluateIsland(island, time)).toEqual(
          second.evaluateIsland(second.world.islands[index]!, time),
        );
      });
    }
  });

  it('normalizes seeds to a documented unsigned 32-bit generator range', () => {
    expect(createFieldParameters(7).seed).toBe(createFieldParameters(4_294_967_303).seed);
    expect(createWorld(7)).toEqual(createWorld(4_294_967_303));
  });
});
