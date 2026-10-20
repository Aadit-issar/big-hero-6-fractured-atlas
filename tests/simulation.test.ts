import { describe, expect, it } from 'vitest';
import { SimulationClock } from '../src/simulation/simulationClock';
import { SimulationEngine } from '../src/simulation/simulationEngine';

describe('simulation time and engine', () => {
  it('freezes time while paused and resumes from the same point', () => {
    const clock = new SimulationClock();
    clock.advance(2);
    expect(clock.time).toBeCloseTo(0.1);
    clock.pause();
    clock.advance(0.08);
    expect(clock.time).toBeCloseTo(0.1);
    clock.resume();
    clock.advance(0.04);
    expect(clock.time).toBeCloseTo(0.14);
  });

  it('applies quarter, normal, and double speed', () => {
    const quarter = new SimulationClock();
    quarter.setTimeScale(0.25);
    quarter.advance(0.08);

    const double = new SimulationClock();
    double.setTimeScale(2);
    double.advance(0.08);

    expect(quarter.time).toBeCloseTo(0.02);
    expect(new SimulationClock().advance(0.08)).toBeCloseTo(0.08);
    expect(double.time).toBeCloseTo(0.16);
  });

  it('caps an individual frame stall to avoid an uncontrolled catch-up jump', () => {
    const clock = new SimulationClock();
    expect(clock.advance(40)).toBeCloseTo(0.1);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
  });

  it('resets clock state and keeps the seed-dependent world stable', () => {
    const engine = new SimulationEngine(17062026);
    engine.clock.setTimeScale(2);
    engine.clock.advance(0.1);
    engine.clock.pause();
    engine.reset();

    expect(engine.clock.time).toBe(0);
    expect(engine.clock.timeScale).toBe(1);
    expect(engine.clock.isRunning).toBe(true);
    expect(engine.world).toEqual(new SimulationEngine(17062026).world);
  });

  it('returns the same state at a supplied model time, regardless of update cadence', () => {
    const first = new SimulationEngine(6655);
    const second = new SimulationEngine(6655);
    for (const delta of [0.03, 0.03, 0.04, 0.025, 0.075]) first.clock.advance(delta);
    for (const delta of [0.08, 0.07, 0.05]) second.clock.advance(delta);
    const targetTime = 6.75;
    const left = first.sampleField([3, -0.5, 8], targetTime);
    const right = second.sampleField([3, -0.5, 8], targetTime);

    expect(left).toEqual(right);
  });
});
