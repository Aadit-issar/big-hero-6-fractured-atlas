/** Fixed-capacity ring buffer of past positions (x, y, z). Pure data structure: no allocation after construction, newest-first access.
 * A mover's trail is the buffer of its own past MAPPED positions, so it is derived from observed state only and never from the future. */
export class TrailBuffer {
  readonly data: Float64Array;
  private head = 0; // index of the next write
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('Trail capacity must be an integer of at least 2.');
    this.data = new Float64Array(capacity * 3);
  }

  get length(): number { return this.size; }

  clear(): void { this.head = 0; this.size = 0; }

  push(x: number, y: number, z: number): void {
    const o = this.head * 3;
    this.data[o] = x; this.data[o + 1] = y; this.data[o + 2] = z;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Write sample `age` (0 = newest) into `out[offset..offset+2]`. Returns false when there is no such sample. */
  read(age: number, out: { [index: number]: number }, offset = 0): boolean {
    if (age < 0 || age >= this.size) return false;
    const o = ((this.head - 1 - age + 2 * this.capacity) % this.capacity) * 3;
    out[offset] = this.data[o]!; out[offset + 1] = this.data[o + 1]!; out[offset + 2] = this.data[o + 2]!;
    return true;
  }

  /** Total polyline length of the stored samples (metres). */
  pathLength(): number {
    let sum = 0, px = 0, py = 0, pz = 0;
    for (let age = 0; age < this.size; age += 1) {
      const o = ((this.head - 1 - age + 2 * this.capacity) % this.capacity) * 3;
      const x = this.data[o]!, y = this.data[o + 1]!, z = this.data[o + 2]!;
      if (age > 0) sum += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
    }
    return sum;
  }
}

/** Trail sampling: one mapped position every TRAIL_STRIDE integrator ticks (20 Hz) and TRAIL_CAPACITY samples (3.2 s of history). */
export const TRAIL_STRIDE = 3;
export const TRAIL_CAPACITY = 64;
