import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5180';
const outputDir = resolve(process.argv[3] ?? 'docs/atlas-evidence/phase2');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const save = (name) => page.screenshot({ path: join(outputDir, name), fullPage: true, animations: 'disabled' });

try {
  await page.goto(baseUrl + '/?mode=empty');
  await page.getByTestId('exploration-map').waitFor();
  await save('01-empty-exploration.png');

  await page.goto(baseUrl + '/');
  await page.getByText('LIVE LAB · ISOLATED SIMULATION').waitFor();
  await page.getByTestId('exploration-canvas').waitFor();
  await page.waitForTimeout(1800);
  await save('02-live-observation-map.png');

  await page.goto(baseUrl + '/?mode=replay');
  await page.getByTestId('map-island-island-A').waitFor();
  await save('03-replay-first-discovery-fixture.png');

  await page.getByTestId('map-fold-fold-A').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="map-fold-fold-A"]')?.getAttribute('aria-label')?.includes('current state unknown'));
  await page.getByTestId('map-island-island-A').click();
  await save('04-accumulated-historical-knowledge-fixture.png');

  await page.waitForFunction(() => document.querySelector('[data-testid="map-fold-fold-A"]')?.getAttribute('aria-label')?.includes('currently observed'));
  await page.getByTestId('map-fold-fold-A-entry').click();
  await save('05-selected-fold-and-updated-island-fixture.png');

  await page.goto(baseUrl + '/?mode=stress');
  await page.getByText('STRESS FIXTURE · NOT LIVE').waitFor();
  await page.locator('.map-island').last().waitFor();
  await save('06-dense-map-stress-fixture.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl + '/?mode=replay');
  await page.getByTestId('exploration-map').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="map-island-island-C"]') !== null);
  await save('07-mobile-exploration-map-fixture.png');

  for (const name of [
    '01-empty-exploration.png',
    '02-live-observation-map.png',
    '03-replay-first-discovery-fixture.png',
    '04-accumulated-historical-knowledge-fixture.png',
    '05-selected-fold-and-updated-island-fixture.png',
    '06-dense-map-stress-fixture.png',
    '07-mobile-exploration-map-fixture.png',
  ]) console.log(join(outputDir, name));
} finally {
  await browser.close();
}
