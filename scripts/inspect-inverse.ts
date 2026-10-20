import { SimulationEngine } from '../src/simulation/simulationEngine';

// Holds the explorer at the opening pose while model time advances at 60 Hz and
// prints every inverse-status change. Pure simulation; no renderer involved.
const engine = new SimulationEngine();
const pose = engine.explorer.pose(0);
let last = '';
for (let frame = 0; frame <= 60 * 20; frame += 1) {
  const t = frame / 60;
  engine.explorer.updateWorld(pose.position, t);
  const inverse = engine.explorer.inverse;
  if (inverse.status !== last || frame % 300 === 0) {
    console.log(t.toFixed(2), inverse.status, inverse.residual.toExponential(2), engine.explorer.referencePosition.map((v) => v.toFixed(3)).join(','), 'σ', inverse.minSingularValue.toFixed(4));
    last = inverse.status;
  }
}
