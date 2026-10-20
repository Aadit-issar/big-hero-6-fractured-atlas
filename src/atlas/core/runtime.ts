import type { AtlasObservation } from '../../shared/atlasContract';
import { diagnose, type CurrentDiagnostics } from './diagnostics';
import { compareObservations, type AtlasEvent, type AtlasEventKind } from './events';
import { ObservationHistory } from './history';
import { validateObservation } from './observation';
import { ExplorationMemory, type ExplorationMapSnapshot, type ExplorationMemoryOptions } from '../mapping/explorationMemory';
import { TemporalIntelligence } from '../analysis/temporalIntelligence';
import type { TemporalPolicy, TemporalSnapshot } from '../analysis/types';

export type SensorStatus = 'awaiting' | 'receiving' | 'unchanged' | 'stale' | 'invalid' | 'unavailable';

export interface AtlasView {
  readonly status: SensorStatus;
  readonly observation: AtlasObservation | null;
  readonly diagnostics: CurrentDiagnostics | null;
  readonly history: readonly AtlasObservation[];
  readonly events: readonly AtlasEvent[];
  readonly session: number;
  readonly lastError: string | null;
  readonly deliveryAgeMs: number | null;
  readonly sampleCount: number;
  readonly mapping: ExplorationMapSnapshot;
  readonly temporal: TemporalSnapshot;
}

export interface AtlasRuntimeOptions {
  readonly historyLimit?: number;
  readonly eventLimit?: number;
  readonly staleAfterMs?: number;
  readonly mapping?: ExplorationMemoryOptions;
  readonly temporal?: Partial<TemporalPolicy>;
}

const MAX_DIAGNOSTIC_LENGTH = 512;

function diagnosticText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length === 0) return fallback;
  return text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…` : text;
}

/** Session coordinator: validates snapshots, retains bounded history and derives local events. */
export class AtlasRuntime {
  readonly history: ObservationHistory;
  readonly explorationMemory: ExplorationMemory;
  readonly temporalIntelligence: TemporalIntelligence;
  private readonly eventLimit: number;
  private readonly staleAfterMs: number;
  private events: AtlasEvent[] = [];
  private nextEventId = 1;
  private previous: AtlasObservation | null = null;
  private current: AtlasObservation | null = null;
  private lastDeliveryAt: number | null = null;
  private lastAdvancedAt: number | null = null;
  private lastDeliveryStatus: 'valid' | 'invalid' | 'unavailable' | null = null;
  private lastError: string | null = null;

  constructor(options: AtlasRuntimeOptions = {}) {
    this.history = new ObservationHistory(options.historyLimit ?? 512);
    this.explorationMemory = new ExplorationMemory(options.mapping);
    this.temporalIntelligence = new TemporalIntelligence(options.temporal);
    this.eventLimit = options.eventLimit ?? 64;
    this.staleAfterMs = options.staleAfterMs ?? 2500;
    if (!Number.isInteger(this.eventLimit) || this.eventLimit < 1) throw new RangeError('Event limit must be a positive integer.');
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) throw new RangeError('Stale interval must be positive and finite.');
  }

  receive(input: unknown, arrivalTimeMs: number): AtlasView {
    this.assertArrivalTime(arrivalTimeMs);
    if (this.lastDeliveryAt !== null && arrivalTimeMs < this.lastDeliveryAt) {
      throw new RangeError('Sensor delivery time must not move backwards.');
    }
    const deliveryWasStale = this.lastDeliveryAt !== null && arrivalTimeMs - this.lastDeliveryAt > this.staleAfterMs;
    const wasDegraded = deliveryWasStale || this.lastDeliveryStatus === 'unavailable' || this.lastDeliveryStatus === 'invalid';
    this.lastDeliveryAt = arrivalTimeMs;
    this.lastDeliveryStatus = 'valid';
    this.lastError = null;
    const validation = validateObservation(input);
    if (!validation.ok) {
      this.temporalIntelligence.interrupt();
      this.lastDeliveryStatus = 'invalid';
      this.lastError = diagnosticText(validation.errors.join(' '), 'Sensor observation was rejected.');
      if (this.events.at(-1)?.kind !== 'observation-rejected') {
        this.pushEvent('observation-rejected', this.current?.time ?? null, `Observation rejected: ${this.lastError}`);
      }
      return this.getView(arrivalTimeMs);
    }

    const observation = validation.observation;
    if (wasDegraded) this.temporalIntelligence.interrupt();
    const append = this.history.append(observation);
    if (append.kind === 'reset') {
      this.events = [];
      this.previous = null;
      this.explorationMemory.reset(append.session);
      this.temporalIntelligence.reset(append.session);
      this.pushEvent('session-reset', observation.time, 'Simulation time moved backwards; a new observation session began.');
      this.lastAdvancedAt = arrivalTimeMs;
    } else if (append.kind === 'appended') {
      this.lastAdvancedAt = arrivalTimeMs;
    }

    this.current = observation;
    for (const event of this.explorationMemory.update(observation, append.session)) {
      this.pushEvent(event.kind, event.simulationTime, event.message);
    }
    for (const event of this.temporalIntelligence.update(observation, this.explorationMemory.read())) {
      this.pushEvent(event.kind, event.simulationTime, event.message);
    }
    for (const event of compareObservations(this.previous, observation)) {
      this.pushEvent(event.kind, event.simulationTime, event.message);
    }
    this.previous = observation;
    if (wasDegraded) this.pushEvent('sensor-recovered', observation.time, 'Valid sensor observations resumed after a degraded or unavailable interval.');
    return this.getView(arrivalTimeMs);
  }

  markUnavailable(reason: string, arrivalTimeMs: number): AtlasView {
    this.assertArrivalTime(arrivalTimeMs);
    if (this.lastDeliveryAt !== null && arrivalTimeMs < this.lastDeliveryAt) {
      throw new RangeError('Sensor delivery time must not move backwards.');
    }
    this.temporalIntelligence.interrupt();
    const alreadyUnavailable = this.lastDeliveryStatus === 'unavailable';
    this.lastDeliveryAt = arrivalTimeMs;
    this.lastDeliveryStatus = 'unavailable';
    this.lastError = diagnosticText(reason, 'Sensor source unavailable.');
    if (!alreadyUnavailable) this.pushEvent('sensor-unavailable', this.current?.time ?? null, `Sensor unavailable: ${this.lastError}`);
    return this.getView(arrivalTimeMs);
  }

  getView(nowMs: number): AtlasView {
    this.assertArrivalTime(nowMs);
    const deliveryAgeMs = this.lastDeliveryAt === null ? null : Math.max(0, nowMs - this.lastDeliveryAt);
    let status: SensorStatus;
    if (this.lastDeliveryStatus === 'unavailable') status = 'unavailable';
    else if (this.lastDeliveryAt === null) status = 'awaiting';
    else if (deliveryAgeMs !== null && deliveryAgeMs > this.staleAfterMs) status = 'stale';
    else if (this.lastDeliveryStatus === 'invalid') status = 'invalid';
    else if (this.current && this.lastAdvancedAt !== this.lastDeliveryAt) status = 'unchanged';
    else status = 'receiving';

    return Object.freeze({
      status,
      observation: this.current,
      diagnostics: this.current ? diagnose(this.current) : null,
      history: this.history.read(),
      events: Object.freeze([...this.events].reverse()),
      session: this.history.session,
      lastError: this.lastError,
      deliveryAgeMs,
      sampleCount: this.history.length,
      mapping: this.explorationMemory.read(),
      temporal: this.temporalIntelligence.read(status),
    });
  }

  private pushEvent(kind: AtlasEventKind, simulationTime: number | null, message: string): void {
    this.events.push(Object.freeze({ id: this.nextEventId, kind, simulationTime, message }));
    this.nextEventId += 1;
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
  }

  private assertArrivalTime(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Sensor delivery time must be finite and non-negative wall-clock milliseconds.');
  }
}
