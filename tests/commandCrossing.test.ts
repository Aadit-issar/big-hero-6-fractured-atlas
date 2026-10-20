import { describe, expect, it } from 'vitest';
import { runStrategy } from './support/closedLoop';
import { CrossingWorld } from './support/crossingWorld';

/** Authored crossing target through the real ATLAS session and frame pipeline (see scripts/atlas-crossing-report.ts for the full matrix). */
describe('authored crossing target: predictive interception vs pursuit of the last seen position', () => {
  for (const [targetSpeed, baymaxSpeed] of [[4, 5.6], [5, 9]] as const) {
    it(`target ${targetSpeed} m/s, Baymax ${baymaxSpeed} m/s: ATLAS reaches it clearly sooner on a shorter path`, () => {
      const make = () => { const w = new CrossingWorld([40, 12, -50], [-targetSpeed, 0, 0]); w.baymax = [0, 12, 0]; return w; };
      const sc = { start: [0, 12, 0] as [number, number, number], speed: baymaxSpeed, warmup: 10, makeWorld: make };
      const atlas = runStrategy('atlas', sc, 90), chase = runStrategy('chase', sc, 90);
      expect(atlas?.success).toBe(true);
      expect(chase?.success).toBe(true);
      console.log(`target ${targetSpeed}, Baymax ${baymaxSpeed}: ATLAS ${atlas!.seconds.toFixed(1)} s / ${atlas!.pathLength.toFixed(0)} m; chase ${chase!.seconds.toFixed(1)} s / ${chase!.pathLength.toFixed(0)} m`);
      expect(atlas!.seconds).toBeLessThan(chase!.seconds * 0.92);
      expect(atlas!.pathLength).toBeLessThan(chase!.pathLength);
    });
  }
});
