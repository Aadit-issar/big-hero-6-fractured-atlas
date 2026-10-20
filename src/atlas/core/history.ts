import type { AtlasObservation } from '../../shared/atlasContract';

export type HistoryAppendResult =
  | { readonly kind: 'appended'; readonly session: number }
  | { readonly kind: 'same-time'; readonly session: number }
  | { readonly kind: 'reset'; readonly session: number };

/** Fixed-capacity observation ring buffer, ordered by simulation time. */
export class ObservationHistory {
  private readonly slots: (AtlasObservation | undefined)[];
  private start = 0;
  private size = 0;
  private currentSession = 1;

  constructor(readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('History capacity must be a positive integer.');
    this.slots = new Array<AtlasObservation | undefined>(capacity);
  }

  get length(): number { return this.size; }
  get session(): number { return this.currentSession; }

  append(observation: AtlasObservation): HistoryAppendResult {
    const last = this.at(this.size - 1);
    if (last && observation.time < last.time) {
      this.clearSlots();
      this.currentSession += 1;
      this.push(observation);
      return { kind: 'reset', session: this.currentSession };
    }
    if (last && observation.time === last.time) {
      const index = (this.start + this.size - 1) % this.capacity;
      this.slots[index] = observation;
      return { kind: 'same-time', session: this.currentSession };
    }
    this.push(observation);
    return { kind: 'appended', session: this.currentSession };
  }

  /** Return a frozen chronological copy, so callers cannot mutate the buffer. */
  read(): readonly AtlasObservation[] {
    const values: AtlasObservation[] = [];
    for (let i = 0; i < this.size; i += 1) {
      const observation = this.slots[(this.start + i) % this.capacity];
      if (observation) values.push(observation);
    }
    return Object.freeze(values);
  }

  private at(offset: number): AtlasObservation | undefined {
    if (offset < 0 || offset >= this.size) return undefined;
    return this.slots[(this.start + offset) % this.capacity];
  }

  private push(observation: AtlasObservation): void {
    if (this.size < this.capacity) {
      this.slots[(this.start + this.size) % this.capacity] = observation;
      this.size += 1;
      return;
    }
    this.slots[this.start] = observation;
    this.start = (this.start + 1) % this.capacity;
  }

  private clearSlots(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.size = 0;
  }
}
