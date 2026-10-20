// Pins the real Dimension island trajectories used by the Moving Corridor challenge.
// This is the ONLY place the challenge touches src/simulation, offline and read-only. ATLAS code never imports it.
// Usage: npx tsx scripts/atlas-challenge-fixture.ts [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { SimulationEngine } from '../src/simulation/simulationEngine';
import { SPATIAL_MODEL } from '../src/simulation/spatialModel';

const OUT = 'src/atlas/challenge/fixtures/realIslandTrajectories.v1.json';
const DT = 0.25;
const DURATION = 160;

export function buildTrajectories() {
  const engine = new SimulationEngine();
  const ticks = Math.round(DURATION / DT);
  const islands = engine.world.islands.map(island => ({
    id: island.id, radius: +island.radius.toFixed(3), height: +island.height.toFixed(3),
    samples: Array.from({ length: ticks + 1 }, (_, i) => engine.evaluateIsland(island, i * DT).map(v => +v.toFixed(3))),
  }));
  return {
    schema: 'atlas-challenge-trajectories/1',
    provenance: {
      generator: 'scripts/atlas-challenge-fixture.ts',
      law: 'SimulationEngine.evaluateIsland(island, t) = 7.5 * (q + 4 * gradPhi(q, t)) with the production field',
      dimensionSeed: engine.seed, modelVersion: SPATIAL_MODEL.version, sampleIntervalSeconds: DT, durationSeconds: DURATION, precision: 'rounded to 0.001 world units',
    },
    islands,
  };
}

if (process.argv[1]?.endsWith('atlas-challenge-fixture.ts')) {
  const next = JSON.stringify(buildTrajectories());
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== next) { console.error('Pinned trajectories differ from the current Dimension law. Regenerate deliberately.'); process.exit(1); }
    console.log('Pinned trajectories match the current Dimension law.');
  } else {
    mkdirSync('src/atlas/challenge/fixtures', { recursive: true });
    writeFileSync(OUT, next);
    console.log(`Wrote ${OUT} (${(next.length / 1024).toFixed(0)} KiB)`);
  }
}
