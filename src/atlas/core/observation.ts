import type { AtlasObservation, ObservedConnectionState, WorldVec3 } from '../../shared/atlasContract';

const connectionStates = new Set<ObservedConnectionState>([
  'inactive', 'forming', 'open', 'unstable', 'closing', 'closed',
]);

/** Operational guard against malformed or adversarial contract-shaped payloads. */
const MAX_ENTITIES_PER_KIND = 2048;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_VALIDATION_ERRORS = 32;

export type ObservationValidation =
  | { readonly ok: true; readonly observation: AtlasObservation }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readWorldVec3(value: unknown, label: string, errors: string[]): WorldVec3 | null {
  if (!Array.isArray(value) || value.length !== 3) {
    errors.push(`${label} must contain exactly three finite world coordinates.`);
    return null;
  }
  // Read each component exactly once; do not trust overridable Array methods or
  // reread accessor-backed values after validation.
  const x: unknown = value[0];
  const y: unknown = value[1];
  const z: unknown = value[2];
  const valid = typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof z === 'number' && Number.isFinite(z);
  if (!valid) {
    errors.push(`${label} must contain exactly three finite world coordinates.`);
    return null;
  }
  return Object.freeze([x as number, y as number, z as number]) as WorldVec3;
}

function readIdentifier(value: unknown, label: string, errors: string[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    errors.push(`${label} must be a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} characters without control characters.`);
    return null;
  }
  return value;
}

function invalid(errors: readonly string[]): ObservationValidation {
  const bounded = errors.slice(0, MAX_VALIDATION_ERRORS);
  if (errors.length > MAX_VALIDATION_ERRORS) bounded.push(`${errors.length - MAX_VALIDATION_ERRORS} additional validation errors omitted.`);
  return { ok: false, errors: Object.freeze(bounded) };
}

function validateObservationUnchecked(input: unknown): ObservationValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return invalid(['Observation must be an object.']);
  if (input.contractVersion !== 1) errors.push('Unsupported sensor contract version; expected version 1.');

  const time = input.time;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    errors.push('Simulation time must be a finite, non-negative number.');
  }
  const sensorRange = input.sensorRange;
  if (typeof sensorRange !== 'number' || !Number.isFinite(sensorRange) || sensorRange <= 0) {
    errors.push('Sensor range must be a positive finite number.');
  }
  const observerWorldPosition = readWorldVec3(input.observerWorldPosition, 'Observer position', errors);

  let gravity: WorldVec3 | null = null;
  let hazard: number | null = null;
  if (!isRecord(input.local)) {
    errors.push('Local environmental reading is unavailable or malformed.');
  } else {
    gravity = readWorldVec3(input.local.gravity, 'Gravity vector', errors);
    if (gravity && !Number.isFinite(Math.hypot(...gravity))) errors.push('Gravity magnitude is outside the finite numeric range.');
    const rawHazard = input.local.hazard;
    if (typeof rawHazard !== 'number' || !Number.isFinite(rawHazard) || rawHazard < 0 || rawHazard > 1) {
      errors.push('Hazard reading must be a finite value in the observed range 0–1.');
    } else {
      hazard = rawHazard;
    }
  }

  const islands: AtlasObservation['islands'][number][] = [];
  const seenIslandIds = new Set<string>();
  if (!Array.isArray(input.islands)) {
    errors.push('Observed island list is unavailable or malformed.');
  } else if (input.islands.length > MAX_ENTITIES_PER_KIND) {
    errors.push(`Observed island list exceeds the operational limit of ${MAX_ENTITIES_PER_KIND} entities.`);
  } else {
    for (let index = 0; index < input.islands.length; index += 1) {
      const entry: unknown = input.islands[index];
      const label = `Island ${index + 1}`;
      if (!isRecord(entry)) {
        errors.push(`${label} must be an object.`);
        continue;
      }
      const id = readIdentifier(entry.id, `${label} identifier`, errors);
      const worldPosition = readWorldVec3(entry.worldPosition, `${label} position`, errors);
      const range = entry.range;
      if (typeof range !== 'number' || !Number.isFinite(range) || range < 0) {
        errors.push(`${label} range must be a non-negative finite distance.`);
      } else if (typeof sensorRange === 'number' && Number.isFinite(sensorRange) && range > sensorRange) {
        errors.push(`${label} reported distance exceeds the observed sensor radius.`);
      }
      if (id !== null) {
        if (seenIslandIds.has(id)) errors.push(`Island identifier “${id}” is duplicated.`);
        seenIslandIds.add(id);
      }
      if (id !== null && worldPosition !== null && typeof range === 'number' && Number.isFinite(range) && range >= 0) {
        const measuredRange = observerWorldPosition === null
          ? Number.NaN
          : Math.hypot(worldPosition[0] - observerWorldPosition[0], worldPosition[1] - observerWorldPosition[1], worldPosition[2] - observerWorldPosition[2]);
        if (!Number.isFinite(measuredRange) || Math.abs(range - measuredRange) > Math.max(1e-6, measuredRange * 1e-8)) {
          errors.push(`${label} reported range does not match its observed world position.`);
          continue;
        }
        islands.push(Object.freeze({ id, worldPosition, range }));
      }
    }
  }

  const connections: AtlasObservation['connections'][number][] = [];
  const seenConnectionIds = new Set<string>();
  if (!Array.isArray(input.connections)) {
    errors.push('Observed connection list is unavailable or malformed.');
  } else if (input.connections.length > MAX_ENTITIES_PER_KIND) {
    errors.push(`Observed connection list exceeds the operational limit of ${MAX_ENTITIES_PER_KIND} entities.`);
  } else {
    for (let index = 0; index < input.connections.length; index += 1) {
      const entry: unknown = input.connections[index];
      const label = `Connection ${index + 1}`;
      if (!isRecord(entry)) {
        errors.push(`${label} must be an object.`);
        continue;
      }
      const id = readIdentifier(entry.id, `${label} identifier`, errors);
      const state = entry.state;
      if (typeof state !== 'string' || !connectionStates.has(state as ObservedConnectionState)) {
        errors.push(`${label} has an unknown visible state.`);
      }
      const entryWorldPosition = readWorldVec3(entry.entryWorldPosition, `${label} entry position`, errors);
      const exitWorldPosition = readWorldVec3(entry.exitWorldPosition, `${label} exit position`, errors);
      const range = entry.range;
      if (typeof range !== 'number' || !Number.isFinite(range) || range < 0) {
        errors.push(`${label} range must be a non-negative finite distance.`);
      } else if (typeof sensorRange === 'number' && Number.isFinite(sensorRange) && range > sensorRange) {
        errors.push(`${label} reported distance exceeds the observed sensor radius.`);
      }
      if (id !== null) {
        if (seenConnectionIds.has(id)) errors.push(`Connection identifier “${id}” is duplicated.`);
        seenConnectionIds.add(id);
      }
      if (id !== null && typeof state === 'string' && connectionStates.has(state as ObservedConnectionState)
        && entryWorldPosition !== null && exitWorldPosition !== null
        && typeof range === 'number' && Number.isFinite(range) && range >= 0) {
        const entryRange = observerWorldPosition === null ? Number.NaN : Math.hypot(entryWorldPosition[0] - observerWorldPosition[0], entryWorldPosition[1] - observerWorldPosition[1], entryWorldPosition[2] - observerWorldPosition[2]);
        const exitRange = observerWorldPosition === null ? Number.NaN : Math.hypot(exitWorldPosition[0] - observerWorldPosition[0], exitWorldPosition[1] - observerWorldPosition[1], exitWorldPosition[2] - observerWorldPosition[2]);
        const measuredRange = Math.min(entryRange, exitRange);
        if (!Number.isFinite(measuredRange) || Math.abs(range - measuredRange) > Math.max(1e-6, measuredRange * 1e-8)) {
          errors.push(`${label} reported range does not match its nearer observed endpoint.`);
          continue;
        }
        connections.push(Object.freeze({ id, state: state as ObservedConnectionState, entryWorldPosition, exitWorldPosition, range }));
      }
    }
  }

  if (errors.length > 0 || observerWorldPosition === null || gravity === null || hazard === null
    || typeof time !== 'number' || typeof sensorRange !== 'number') {
    return invalid(errors);
  }

  const local = Object.freeze({ gravity, hazard });
  const observation: AtlasObservation = Object.freeze({
    contractVersion: 1,
    time,
    observerWorldPosition,
    sensorRange,
    local,
    islands: Object.freeze(islands),
    connections: Object.freeze(connections),
  });
  return { ok: true, observation };
}

/** Validate untrusted runtime data and copy it into an immutable contract snapshot.
 * Throwing property accessors, proxies and revoked proxies are treated as invalid input. */
export function validateObservation(input: unknown): ObservationValidation {
  try {
    return validateObservationUnchecked(input);
  } catch {
    return invalid(['Observation could not be safely read; sensor data was rejected.']);
  }
}
