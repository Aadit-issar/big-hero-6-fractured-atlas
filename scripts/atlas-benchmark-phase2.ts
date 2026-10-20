import { chromium } from '@playwright/test';
import { AtlasRuntime } from '../src/atlas/core/runtime';
import { createStressObservation } from '../src/atlas/lab/fixtures';

const iterations = 1_000;
const observation = createStressObservation();
const runtime = new AtlasRuntime({ mapping: { entityTrackLimit: 32, environmentTrackLimit: 512 } });
for (let index = 0; index < 40; index += 1) runtime.receive({ ...observation, time: index * 0.25 }, index * 250);
const updateDurationsMs: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  runtime.receive({ ...observation, time: (index + 40) * 0.25 }, (index + 40) * 250);
  updateDurationsMs.push(performance.now() - started);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5180';
  await page.addInitScript({ content: 'globalThis.__name = (value) => value;' });
  await page.goto(baseUrl + '/?mode=stress');
  await page.locator('.map-island').last().waitFor();
  const ui = await page.evaluate(async () => {
    const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    const zoomOut = document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
    if (!zoomIn || !zoomOut) throw new Error('Map zoom controls did not render.');
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const durations: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const start = performance.now();
      zoomIn.click();
      await frame();
      zoomOut.click();
      await frame();
      durations.push(performance.now() - start);
    }
    return {
      viewport: [window.innerWidth, window.innerHeight],
      mapIslands: document.querySelectorAll('.map-island').length,
      mapFolds: document.querySelectorAll('.map-fold').length,
      interactionFrameMs: durations,
      overflowPixels: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  const sortedUpdates = [...updateDurationsMs].sort((a, b) => a - b);
  const sortedUi = [...ui.interactionFrameMs].sort((a, b) => a - b);
  console.log(JSON.stringify({
    runtime: {
      iterations,
      fixtureEntitiesPerSample: observation.islands.length + observation.connections.length,
      uniqueIslands: runtime.getView(iterations * 250).mapping.summary.uniqueIslands,
      uniqueFolds: runtime.getView(iterations * 250).mapping.summary.uniqueFolds,
      environmentSamplesRetained: runtime.getView(iterations * 250).mapping.summary.environmentSampleCount,
      meanUpdateMs: updateDurationsMs.reduce((sum, value) => sum + value, 0) / updateDurationsMs.length,
      p95UpdateMs: sortedUpdates[Math.floor(sortedUpdates.length * 0.95)],
    },
    chrome: {
      mode: 'STRESS FIXTURE · NOT LIVE',
      mapIslands: ui.mapIslands,
      mapFolds: ui.mapFolds,
      viewport: ui.viewport,
      zoomInOutCycleMeanMs: ui.interactionFrameMs.reduce((sum, value) => sum + value, 0) / ui.interactionFrameMs.length,
      zoomInOutCycleP95Ms: sortedUi[Math.floor(sortedUi.length * 0.95)],
      horizontalOverflowPixels: ui.overflowPixels,
      cycles: ui.interactionFrameMs.length,
    },
  }, null, 2));
} finally {
  await browser.close();
}
