import { MAX_FRAME_DELTA_SECONDS } from './constants';

export type TimeScale = 0.25 | 1 | 2;

export class SimulationClock {
  private elapsed = 0;
  private scale: TimeScale = 1;
  private running = true;

  get time(): number { return this.elapsed; }
  get timeScale(): TimeScale { return this.scale; }
  get isRunning(): boolean { return this.running; }

  advance(realDeltaSeconds: number): number {
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds < 0) {
      throw new RangeError('Real elapsed time must be a finite nonnegative number.');
    }

    if (this.running) {
      this.elapsed += Math.min(realDeltaSeconds, MAX_FRAME_DELTA_SECONDS) * this.scale;
    }
    return this.elapsed;
  }

  pause(): void { this.running = false; }
  resume(): void { this.running = true; }

  setTimeScale(scale: TimeScale): void {
    if (scale !== 0.25 && scale !== 1 && scale !== 2) {
      throw new RangeError('Time scale must be 0.25×, 1×, or 2×.');
    }
    this.scale = scale;
  }

  reset(): void {
    this.elapsed = 0;
    this.scale = 1;
    this.running = true;
  }
}
