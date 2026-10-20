// AUTHORED crossing-target comparison (clearly not the Dimension's own dynamics): the same closed loop as atlas-intercept-report (real ATLAS session,
// real frame pipeline, arrival by true position) with a capsule crossing Baymax's approach at constant velocity. Baymax is only modestly faster than the target,
// where flying at the last seen position loses ground and a lead aim does not.
//   npx tsx scripts/atlas-crossing-report.ts [outFile]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runStrategy } from '../tests/support/closedLoop';
import { CrossingWorld } from '../tests/support/crossingWorld';

const out = process.argv[2] ?? 'docs/evidence/intercept-report-crossing.json';
const rows: unknown[] = [];
for (const targetSpeed of [3, 4, 5]) {
  for (const ratio of [1.4, 1.8, 2.5]) {
    const speed = Math.round(targetSpeed * ratio * 10) / 10;
    for (const side of [1, -1]) {
      // The capsule starts 40 m to one side at the observer's height and crosses in front of Baymax (who hovers at the origin facing the line of travel).
      const velocity: [number, number, number] = [-side * targetSpeed, 0, 0];
      const origin: [number, number, number] = [side * 40, 12, -50];
      const make = () => { const w = new CrossingWorld(origin, velocity); w.baymax = [0, 12, 0]; return w; };
      const sc = { start: [0, 12, 0] as [number, number, number], speed, warmup: 10, makeWorld: make };
      const atlas = runStrategy('atlas', sc, 90), chase = runStrategy('chase', sc, 90);
      rows.push({ targetSpeed, baymaxSpeed: speed, side, atlas, chase });
      console.log(`target ${targetSpeed} m/s, Baymax ${speed} m/s (x${ratio}), side ${side}: ATLAS ${atlas ? `${atlas.success ? 'reached' : 'MISSED'} ${atlas.seconds.toFixed(1)} s, path ${atlas.pathLength.toFixed(0)} m, ${atlas.corrections} routes` : 'n/a'} | chase ${chase ? `${chase.success ? 'reached' : 'MISSED'} ${chase.seconds.toFixed(1)} s, path ${chase.pathLength.toFixed(0)} m` : 'n/a'}`);
    }
  }
}
type O = { success: boolean; seconds: number; pathLength: number; closest: number; corrections: number };
const valid = (rows as { atlas: O | null; chase: O | null; baymaxSpeed: number; targetSpeed: number }[]).filter(r => r.atlas && r.chase);
const both = valid.filter(r => r.atlas!.success && r.chase!.success);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const summary = {
  scenarios: valid.length, atlasReached: valid.filter(r => r.atlas!.success).length, chaseReached: valid.filter(r => r.chase!.success).length, bothReached: both.length,
  meanSeconds: { atlas: mean(both.map(r => r.atlas!.seconds)), chase: mean(both.map(r => r.chase!.seconds)) },
  meanPath: { atlas: mean(both.map(r => r.atlas!.pathLength)), chase: mean(both.map(r => r.chase!.pathLength)) },
  atlasFaster: both.filter(r => r.atlas!.seconds < r.chase!.seconds - 0.25).length, chaseFaster: both.filter(r => r.chase!.seconds < r.atlas!.seconds - 0.25).length,
  meanRoutesIssuedByAtlas: mean(valid.map(r => r.atlas!.corrections)),
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ authored: true, note: 'Authored crossing-target scenario; not the Dimension dynamics.', summary, rows }, null, 2));
