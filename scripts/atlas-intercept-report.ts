// Strategy comparison on identical initial conditions: ATLAS (predicted rendezvous, replanned on new observations) versus a plain chase of the
// last observed position. Both run the REAL ATLAS session against the REAL simulation and mover dynamics (tests/support/closedLoop.ts); arrival is decided
// by true positions. Nothing is tuned per scenario and failures are reported, not dropped.
//   npx tsx scripts/atlas-intercept-report.ts [outFile]            default lane (capsule about 1-3.5 m/s)
//   VARIANT=fast npx tsx scripts/atlas-intercept-report.ts [outFile]   stress lane (capsule about 4-6.5 m/s)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runStrategy } from '../tests/support/closedLoop';
import type { Outcome, Scenario } from '../tests/support/closedLoop';
import { LiveWorld } from '../tests/support/liveWorld';

const variant = process.env.VARIANT === 'fast' ? 'fast' : 'cruise';
// DISTANCE scales the observer's standoff from the capsule (1 = about 25 m; 2.2 = about 55 m, near the edge of the 60 m sensor range).
const scale = Number(process.env.DISTANCE ?? 1);
const out = process.argv[2] ?? `docs/evidence/intercept-report-${variant}-${scale}x.json`;
// Observer positions are placed 25-30 m from where the capsule will be, so that it is in sensor range during the warm-up.
const warmups = [14, 24, 40, 56];
// Cruise is 14 m/s and boost 42 m/s; slow speeds (4-8 m/s, a careful approach) are where the capsule (1-3.5 m/s) is hardest to catch.
const speeds = variant === 'fast' ? [8, 14, 24] : [4, 5, 6, 8, 14];
const rows: { scenario: Scenario & { offset: number }; atlas: Outcome | null; chase: Outcome | null }[] = [];
for (const warmup of warmups) {
  const probe = new LiveWorld('probe', variant); probe.advance(warmup);
  const c = probe.truth('capsule-abigail');
  for (const [i, offset] of [[22, 6, 14], [-24, 8, -10], [4, -4, 28]].entries()) {
    const start = [c[0] + offset![0]! * scale, c[1] + offset![1]! * scale, c[2] + offset![2]! * scale] as unknown as [number, number, number];
    void i;
    for (const speed of speeds) {
      const scenario = { start, speed, warmup, offset: offset![0]!, variant };
      const atlas = runStrategy('atlas', scenario), chase = runStrategy('chase', scenario);
      rows.push({ scenario, atlas, chase });
      console.log(`warmup ${warmup} speed ${speed} start (${start.map(v => v.toFixed(0))}): ATLAS ${atlas ? `${atlas.success ? 'reached' : 'MISSED'} in ${atlas.seconds.toFixed(1)} s, path ${atlas.pathLength.toFixed(0)} m, ${atlas.corrections} routes` : 'n/a'} | chase ${chase ? `${chase.success ? 'reached' : 'MISSED'} in ${chase.seconds.toFixed(1)} s, path ${chase.pathLength.toFixed(0)} m` : 'n/a'}`);
    }
  }
}
const valid = rows.filter(r => r.atlas && r.chase) as { scenario: Scenario; atlas: Outcome; chase: Outcome }[];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const both = valid.filter(r => r.atlas.success && r.chase.success);
const summary = {
  scenarios: valid.length,
  atlasReached: valid.filter(r => r.atlas.success).length,
  chaseReached: valid.filter(r => r.chase.success).length,
  bothReached: both.length,
  meanSecondsWhenBothReached: { atlas: mean(both.map(r => r.atlas.seconds)), chase: mean(both.map(r => r.chase.seconds)) },
  meanPathWhenBothReached: { atlas: mean(both.map(r => r.atlas.pathLength)), chase: mean(both.map(r => r.chase.pathLength)) },
  atlasFasterIn: both.filter(r => r.atlas.seconds < r.chase.seconds - 0.25).length,
  chaseFasterIn: both.filter(r => r.chase.seconds < r.atlas.seconds - 0.25).length,
  meanClosestApproach: { atlas: mean(valid.map(r => r.atlas.closest)), chase: mean(valid.map(r => r.chase.closest)) },
  meanRoutesIssuedByAtlas: mean(valid.map(r => r.atlas.corrections)),
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
