import { chromium } from '@playwright/test';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { TemporalIntelligence } from '../src/atlas/analysis/temporalIntelligence';
import { createStressObservation } from '../src/atlas/lab/fixtures';
import { ExplorationMemory } from '../src/atlas/mapping/explorationMemory';

const iterations = Number(process.argv[2] ?? 3_000);
const observation = createStressObservation();
const runtime = new AtlasRuntime({ mapping: { entityTrackLimit: 64, environmentTrackLimit: 2_048 } });
for (let index = 0; index < 100; index += 1) runtime.receive({ ...observation, time: index * 0.25 }, index * 250);
const forceGC = (globalThis as typeof globalThis & { gc?: () => void }).gc;
forceGC?.();
const heapBefore = process.memoryUsage().heapUsed;
const updateMs: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  runtime.receive({ ...observation, time: (index + 100) * 0.25 }, (index + 100) * 250);
  updateMs.push(performance.now() - started);
}
forceGC?.();
const heapAfter = process.memoryUsage().heapUsed;
const sorted = [...updateMs].sort((a, b) => a - b);

const profileIterations = Math.min(iterations, 1_000);
const memory = new ExplorationMemory({ entityTrackLimit: 64, environmentTrackLimit: 2_048 });
const analyzer = new TemporalIntelligence();
for (let index = 0; index < 100; index += 1) {
  const input = { ...observation, time: index * 0.25 };
  memory.update(input, 1);
  analyzer.update(input, memory.read());
}
const mappingMs: number[] = [];
const analysisMs: number[] = [];
for (let index = 0; index < profileIterations; index += 1) {
  const input = { ...observation, time: (index + 100) * 0.25 };
  let started = performance.now();
  memory.update(input, 1);
  const snapshot = memory.read();
  mappingMs.push(performance.now() - started);
  started = performance.now();
  analyzer.update(input, snapshot);
  analysisMs.push(performance.now() - started);
}
const sortedMapping = [...mappingMs].sort((a, b) => a - b);
const sortedAnalysis = [...analysisMs].sort((a, b) => a - b);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let ui: Record<string, unknown>;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const baseUrl = process.argv[3] ?? 'http://127.0.0.1:5180';
  await page.addInitScript({ content: 'globalThis.__name = (value) => value;' });
  await page.goto(`${baseUrl}/?mode=stress`, { waitUntil: 'networkidle' });
  await page.locator('.map-island').last().waitFor();
  await page.getByTestId('temporal-panel').waitFor();
  const windowSelect = page.getByLabel('Environmental chart time window');
  const fit = page.getByRole('button', { name: 'Fit observations' });
  const interactionCycleMs: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const started = performance.now();
    await windowSelect.selectOption(i % 2 ? '4' : '8');
    await fit.click();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    interactionCycleMs.push(performance.now() - started);
  }
  ui = await page.evaluate((durations) => ({
    viewport: [innerWidth, innerHeight],
    islands: document.querySelectorAll('.map-island').length,
    folds: document.querySelectorAll('.map-fold').length,
    temporalCharts: document.querySelectorAll('[data-testid="temporal-chart"]').length,
    interactionCycleMs: durations,
    horizontalOverflowPixels: document.documentElement.scrollWidth - innerWidth,
  }), interactionCycleMs);
} finally {
  await browser.close();
}

const uiDurations = ui.interactionCycleMs as number[];
const sortedUi = [...uiDurations].sort((a, b) => a - b);
console.log(JSON.stringify({
  runtime: {
    iterations,
    fixtureEntities: observation.islands.length + observation.connections.length,
    uniqueIslands: runtime.getView(iterations * 250).mapping.summary.uniqueIslands,
    uniqueFolds: runtime.getView(iterations * 250).mapping.summary.uniqueFolds,
    observationHistoryRetained: runtime.getView(iterations * 250).sampleCount,
    mappingEnvironmentSamplesRetained: runtime.getView(iterations * 250).mapping.summary.environmentSampleCount,
    meanUpdateMs: updateMs.reduce((a, b) => a + b, 0) / updateMs.length,
    p95UpdateMs: sorted[Math.floor(sorted.length * 0.95)],
    observedProcessHeapDeltaBytes: heapAfter - heapBefore,
    forcedGarbageCollectionAvailable: Boolean(forceGC),
    heapDeltaCaveat: forceGC ? 'Heap delta after forced garbage collection; includes retained runtime state and benchmark arrays.' : 'Approximate heap delta without forced garbage collection; includes benchmark harness allocations.',
    phaseBreakdown: {
      iterations: profileIterations,
      mappingUpdateMeanMs: mappingMs.reduce((a, b) => a + b, 0) / mappingMs.length,
      mappingUpdateP95Ms: sortedMapping[Math.floor(sortedMapping.length * 0.95)],
      temporalAnalysisMeanMs: analysisMs.reduce((a, b) => a + b, 0) / analysisMs.length,
      temporalAnalysisP95Ms: sortedAnalysis[Math.floor(sortedAnalysis.length * 0.95)],
    },
  },
  chrome: {
    fixture: 'STRESS FIXTURE · NOT LIVE',
    controls: '40 Playwright-driven chart time-window changes and map-fit actions, each followed by two browser animation frames',
    ...ui,
    interactionCycleMeanMs: uiDurations.reduce((a, b) => a + b, 0) / uiDurations.length,
    interactionCycleP95Ms: sortedUi[Math.floor(sortedUi.length * 0.95)],
  },
}, null, 2));
