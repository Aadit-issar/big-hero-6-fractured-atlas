import { writeFileSync, mkdirSync } from 'node:fs';
import { createFieldParameters } from '../src/simulation/field';
import { sampleSpatial, createSpatialParameters, SPATIAL_MODEL } from '../src/simulation/spatialModel';
import { distance, scale } from '../src/simulation/linearAlgebra';
import type { Vec3 } from '../src/simulation/types';

const results = [];
for (const waveScale of [1, 1.5, 2, 2.5]) for (const alpha of waveScale === 1 ? [0.9, 8, 12, 16] : [2, 3, 4, 5, 6]) {
  const field = waveScale === 1 ? createFieldParameters(17062026) : createSpatialParameters(17062026, waveScale);
  const sigma: number[] = []; const determinant: number[] = []; const displacement: number[] = [];
  for (const t of [0, 5, 10, 20, 40]) for (let x = -6; x <= 6; x += 1.5) for (let y = -2; y <= 4; y += 1.5) for (let z = -12; z <= 4; z += 2) {
    const q: Vec3 = [x, y, z]; const s = sampleSpatial(q, t, field, {worldScale: 7.5, strength: alpha});
    sigma.push(s.minSingularValue); determinant.push(s.jacobianDeterminant); displacement.push(distance(s.worldPosition, scale(q, 7.5)));
  }
  sigma.sort((a,b) => a-b); determinant.sort((a,b)=>a-b); displacement.sort((a,b)=>a-b);
  const percentile = (a: number[], p: number) => a[Math.floor((a.length - 1) * p)]!;
  results.push({ waveScale, alpha, samples: sigma.length, minSigma: sigma[0], nearFoldFraction: sigma.filter(s=>s<0.08).length/sigma.length,
    stableFraction: sigma.filter(s=>s>0.5).length/sigma.length, determinantRange: [determinant[0],determinant.at(-1)],
    displacementMedian: percentile(displacement,.5), displacementP95: percentile(displacement,.95), displacementMax: displacement.at(-1), finite: [...sigma,...determinant,...displacement].every(Number.isFinite) });
}
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/parameter-search.json', JSON.stringify({seed:17062026,model:SPATIAL_MODEL,baseline:'waveScale=1 uses original Phase 1 temporal parameters; other rows use Phase 2 temporal parameters',grid:'x[-6,6]/1.5 y[-2,4]/1.5 z[-12,4]/2; t=0,5,10,20,40',results}, null, 2));
console.table(results);
