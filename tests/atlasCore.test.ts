import { describe, expect, it } from 'vitest';
import type { AtlasObservation, ObservedConnection, ObservedIsland } from '../src/shared/atlasContract';
import { diagnose } from '../src/atlas/core/diagnostics';
import { ObservationHistory } from '../src/atlas/core/history';
import { validateObservation } from '../src/atlas/core/observation';
import { AtlasRuntime } from '../src/atlas/core/runtime';

function sample(time: number, changes: Partial<AtlasObservation> = {}): AtlasObservation {
  const island: ObservedIsland = { id: 'island-a', worldPosition: [3, 4, 0], range: 5 };
  const connection: ObservedConnection = {
    id: 'fold-a', state: 'open', entryWorldPosition: [0, 0, 3], exitWorldPosition: [0, 4, 0], range: 3,
  };
  const observation: AtlasObservation = {
    contractVersion: 1,
    time,
    observerWorldPosition: [0, 0, 0],
    sensorRange: 60,
    local: { gravity: [3, 4, 0], hazard: 0.3 },
    islands: [island],
    connections: [connection],
    ...changes,
  };
  if (!changes.observerWorldPosition) return observation;
  const observer = observation.observerWorldPosition;
  return {
    ...observation,
    islands: observation.islands.map((entry) => ({ ...entry, range: Math.hypot(entry.worldPosition[0] - observer[0], entry.worldPosition[1] - observer[1], entry.worldPosition[2] - observer[2]) })),
    connections: observation.connections.map((entry) => ({ ...entry, range: Math.min(
      Math.hypot(entry.entryWorldPosition[0] - observer[0], entry.entryWorldPosition[1] - observer[1], entry.entryWorldPosition[2] - observer[2]),
      Math.hypot(entry.exitWorldPosition[0] - observer[0], entry.exitWorldPosition[1] - observer[1], entry.exitWorldPosition[2] - observer[2]),
    ) })),
  };
}

describe('ATLAS observation boundary', () => {
  it('accepts and freezes a valid version 1 sensor snapshot', () => {
    const result = validateObservation(sample(4.25));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.time).toBe(4.25);
    expect(result.observation.contractVersion).toBe(1);
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.islands[0])).toBe(true);
    expect(Object.isFrozen(result.observation.observerWorldPosition)).toBe(true);
  });

  it('rejects non-finite coordinates and preserves the previous good reading', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(1), 100);
    const invalid = { ...sample(2), observerWorldPosition: [0, Number.NaN, 1] };
    const view = runtime.receive(invalid, 200);
    expect(view.status).toBe('invalid');
    expect(view.sampleCount).toBe(1);
    expect(view.observation?.time).toBe(1);
    expect(view.lastError).toContain('Observer position');
  });

  it('rejects unsupported fold states, malformed endpoint tuples and out-of-range hazard', () => {
    const badState = sample(1, { connections: [{ ...sample(1).connections[0]!, state: 'guaranteed' as never }] });
    const result = validateObservation(badState);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/unknown visible state/);

    const badHazard = sample(1, { local: { gravity: [0, 0, 0], hazard: 1.4 } });
    const hazardResult = validateObservation(badHazard);
    expect(hazardResult.ok).toBe(false);
    if (!hazardResult.ok) expect(hazardResult.errors.join(' ')).toMatch(/0–1/);

    const badRange = sample(1, { islands: [{ ...sample(1).islands[0]!, range: -1 }] });
    expect(validateObservation(badRange).ok).toBe(false);

    const beyondRadius = sample(1, { islands: [{ ...sample(1).islands[0]!, range: 61 }] });
    const radiusResult = validateObservation(beyondRadius);
    expect(radiusResult.ok).toBe(false);
    if (!radiusResult.ok) expect(radiusResult.errors.join(' ')).toContain('exceeds the observed sensor radius');
  });

  it('rejects self-inconsistent range measurements and non-finite derived magnitudes', () => {
    const badIslandRange = sample(1, { islands: [{ id: 'island-a', worldPosition: [3, 4, 0], range: 4 }] });
    const islandResult = validateObservation(badIslandRange);
    expect(islandResult.ok).toBe(false);
    if (!islandResult.ok) expect(islandResult.errors.join(' ')).toContain('does not match its observed world position');

    const badFoldRange = sample(1, { connections: [{ id: 'fold-a', state: 'open', entryWorldPosition: [0, 0, 3], exitWorldPosition: [0, 4, 0], range: 4 }] });
    const foldResult = validateObservation(badFoldRange);
    expect(foldResult.ok).toBe(false);
    if (!foldResult.ok) expect(foldResult.errors.join(' ')).toContain('does not match its nearer observed endpoint');

    const overflowMagnitude = sample(1, { local: { gravity: [1.7e308, 1.7e308, 1.7e308], hazard: 0.3 } });
    const magnitudeResult = validateObservation(overflowMagnitude);
    expect(magnitudeResult.ok).toBe(false);
    if (!magnitudeResult.ok) expect(magnitudeResult.errors.join(' ')).toContain('Gravity magnitude');
  });

  it('bounds entity lists and identifiers and safely rejects throwing input accessors', () => {
    const tooMany = sample(1, { islands: new Array(2049).fill({}) });
    const listResult = validateObservation(tooMany);
    expect(listResult.ok).toBe(false);
    if (!listResult.ok) expect(listResult.errors.join(' ')).toContain('operational limit of 2048');

    const longId = sample(1, { islands: [{ id: 'x'.repeat(257), worldPosition: [3, 4, 0], range: 5 }] });
    const idResult = validateObservation(longId);
    expect(idResult.ok).toBe(false);
    if (!idResult.ok) expect(Object.isFrozen(idResult.errors)).toBe(true);

    const throwing = Object.defineProperty({}, 'contractVersion', { get() { throw new Error('hostile getter'); } });
    const thrownResult = validateObservation(throwing);
    expect(thrownResult.ok).toBe(false);
    if (!thrownResult.ok) expect(thrownResult.errors).toEqual(['Observation could not be safely read; sensor data was rejected.']);
  });

  it('copies coordinates once and does not trust array iteration overrides', () => {
    const coordinate = [0, 0, 0];
    let reads = 0;
    Object.defineProperty(coordinate, '0', { get: () => { reads += 1; return reads === 1 ? 1 : Number.NaN; } });
    const hostileIslands = [{ id: 'island-a', worldPosition: [3, 4, 0], range: 5 }] as unknown[];
    Object.defineProperty(hostileIslands, 'forEach', { value: () => { throw new Error('must not run caller iteration code'); } });
    const result = validateObservation(sample(1, {
      local: { gravity: coordinate as unknown as AtlasObservation['local']['gravity'], hazard: 0.2 },
      islands: hostileIslands as AtlasObservation['islands'],
    }));
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
    if (result.ok) {
      expect(result.observation.local.gravity[0]).toBe(1);
      expect(result.observation.islands.map((island) => island.id)).toEqual(['island-a']);
    }
  });

  it('caps validation diagnostics for a bounded but malformed observation', () => {
    const result = validateObservation(sample(1, { islands: new Array(2048).fill(null) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(33);
      expect(result.errors.at(-1)).toContain('additional validation errors omitted');
      expect(Object.isFrozen(result.errors)).toBe(true);
    }
  });

  it('accepts empty visible sets and reports only contract-provided local readings', () => {
    const result = validateObservation(sample(0, { islands: [], connections: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagnostics = diagnose(result.observation);
    expect(diagnostics.islands).toEqual([]);
    expect(diagnostics.connections).toEqual([]);
    expect(diagnostics.gravityMagnitude).toBe(5);
    expect(diagnostics.hazard).toBe(0.3);
  });

  it('rejects a missing required local measurement rather than inventing one', () => {
    const missing = { ...sample(1), local: { gravity: [0, 0, 0] } };
    const result = validateObservation(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('Hazard reading');
  });

  it('does not mutate the input snapshot and owns a separate immutable copy', () => {
    const original = sample(1);
    const before = JSON.stringify(original);
    const result = validateObservation(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation).not.toBe(original);
    expect(result.observation.islands).not.toBe(original.islands);
    expect(Object.isFrozen(original)).toBe(false);
  });
});

describe('ATLAS current diagnostics', () => {
  it('calculates full world-space distance, displacement and fold endpoint distances', () => {
    const result = validateObservation(sample(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagnostics = diagnose(result.observation);
    expect(diagnostics.islands[0]?.distance).toBe(5);
    expect(diagnostics.islands[0]?.displacement).toEqual([3, 4, 0]);
    expect(diagnostics.connections[0]?.entryDistance).toBe(3);
    expect(diagnostics.connections[0]?.exitDistance).toBe(4);
  });

  it('sorts observed islands and folds by calculated distance without relabeling their state', () => {
    const observation = sample(2, {
      islands: [
        { id: 'far', worldPosition: [20, 0, 0], range: 20 },
        { id: 'near', worldPosition: [2, 0, 0], range: 2 },
      ],
      connections: [
        { id: 'far-fold', state: 'closing', entryWorldPosition: [10, 0, 0], exitWorldPosition: [11, 0, 0], range: 10 },
        { id: 'near-fold', state: 'open', entryWorldPosition: [1, 0, 0], exitWorldPosition: [30, 0, 0], range: 1 },
      ],
    });
    const result = validateObservation(observation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagnostics = diagnose(result.observation);
    expect(diagnostics.islands.map((entry) => entry.observed.id)).toEqual(['near', 'far']);
    expect(diagnostics.connections.map((entry) => entry.observed.id)).toEqual(['near-fold', 'far-fold']);
    expect(diagnostics.connections[1]?.observed.state).toBe('closing');
  });
});

describe('ATLAS simulation-time history', () => {
  it('keeps a bounded chronological buffer and evicts the oldest samples', () => {
    const history = new ObservationHistory(3);
    for (let time = 0; time < 5; time += 1) {
      const result = validateObservation(sample(time));
      expect(result.ok).toBe(true);
      if (result.ok) history.append(result.observation);
    }
    expect(history.length).toBe(3);
    expect(history.read().map(({ time }) => time)).toEqual([2, 3, 4]);
    expect(Object.isFrozen(history.read())).toBe(true);
  });

  it('coalesces repeated simulation timestamps without growing history', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(0), 100);
    const moved = sample(0, { observerWorldPosition: [1, 0, 0] });
    const view = runtime.receive(moved, 350);
    expect(view.status).toBe('unchanged');
    expect(view.sampleCount).toBe(1);
    expect(view.history[0]?.observerWorldPosition).toEqual([1, 0, 0]);
  });

  it('does not fabricate samples while simulation time is paused', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(8), 100);
    runtime.receive(sample(8), 350);
    runtime.receive(sample(8), 600);
    expect(runtime.getView(600).status).toBe('unchanged');
    expect(runtime.getView(600).sampleCount).toBe(1);
  });

  it('clears the previous episode when simulation time moves backwards', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(12), 100);
    const view = runtime.receive(sample(0.25), 400);
    expect(view.session).toBe(2);
    expect(view.sampleCount).toBe(1);
    expect(view.history.map(({ time }) => time)).toEqual([0.25]);
    expect(view.events.map(({ kind }) => kind)).toEqual(['first-observation', 'fold-discovered', 'island-discovered', 'session-reset']);
    expect(view.mapping.session).toBe(2);
  });

  it('reports delivery staleness separately from unchanged simulation time', () => {
    const runtime = new AtlasRuntime({ staleAfterMs: 1000 });
    runtime.receive(sample(3), 100);
    runtime.receive(sample(3), 350);
    expect(runtime.getView(500).status).toBe('unchanged');
    expect(runtime.getView(1401).status).toBe('stale');
  });

  it('rejects invalid or regressing delivery-clock inputs without changing runtime state', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(2), 100);
    expect(() => runtime.receive(sample(3), Number.NaN)).toThrow(/delivery time must be finite/);
    expect(() => runtime.markUnavailable('offline', 99)).toThrow(/must not move backwards/);
    expect(runtime.getView(100).observation?.time).toBe(2);
    expect(runtime.getView(100).status).toBe('receiving');
  });

  it('reports sensor unavailability and recovery from actual source status', () => {
    const runtime = new AtlasRuntime();
    const unavailable = runtime.markUnavailable('test connection unavailable', 100);
    expect(unavailable.status).toBe('unavailable');
    const recovered = runtime.receive(sample(0), 250);
    expect(recovered.status).toBe('receiving');
    expect(recovered.events.map(({ kind }) => kind)).toContain('sensor-recovered');
  });

  it('bounds and sanitizes externally supplied sensor-unavailable diagnostics', () => {
    const runtime = new AtlasRuntime();
    const view = runtime.markUnavailable(`  ${'x'.repeat(600)}\nunsafe\u0000text  `, 100);
    expect(view.lastError).toHaveLength(512);
    expect(view.lastError).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('records valid delivery recovery after invalid data and a stale interval', () => {
    const runtime = new AtlasRuntime({ staleAfterMs: 1000 });
    runtime.receive(sample(0), 100);
    runtime.receive({ ...sample(1), time: Number.NaN }, 200);
    const fromInvalid = runtime.receive(sample(1), 300);
    expect(fromInvalid.events.filter(({ kind }) => kind === 'sensor-recovered')).toHaveLength(1);

    const fromStale = runtime.receive(sample(2), 1500);
    expect(fromStale.events.filter(({ kind }) => kind === 'sensor-recovered')).toHaveLength(2);
  });

  it('bounds the event feed and emits object, fold state and measured-hazard changes', () => {
    const runtime = new AtlasRuntime({ eventLimit: 8 });
    runtime.receive(sample(0), 100);
    const changed = sample(1, {
      local: { gravity: [3, 4, 0], hazard: 0.4 },
      islands: [{ id: 'island-b', worldPosition: [5, 0, 0], range: 5 }],
      connections: [{ ...sample(1).connections[0]!, state: 'closing' }],
    });
    const view = runtime.receive(changed, 350);
    const kinds = view.events.map(({ kind }) => kind);
    expect(kinds).toContain('island-entered');
    expect(kinds).toContain('island-left');
    expect(kinds).toContain('fold-state-changed');
    expect(kinds).toContain('hazard-reading-changed');

    for (let time = 2; time < 7; time += 1) runtime.receive(sample(time), 350 + time * 250);
    expect(runtime.getView(2000).events.length).toBeLessThanOrEqual(8);
  });

  it('does not add numeric hazard events for changes smaller than the documented feed threshold', () => {
    const runtime = new AtlasRuntime();
    runtime.receive(sample(0), 100);
    const view = runtime.receive(sample(1, { local: { gravity: [3, 4, 0], hazard: 0.33 } }), 350);
    expect(view.events.some(({ kind }) => kind === 'hazard-reading-changed')).toBe(false);
  });
});
