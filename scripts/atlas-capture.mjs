import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5180';
const outputDir = resolve(process.argv[3] ?? 'docs/atlas-evidence/phase1');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const save = (name, options = {}) => page.screenshot({ path: join(outputDir, name), fullPage: true, animations: 'disabled', ...options });

try {
  await page.goto(`${baseUrl}/?mode=empty`);
  await page.getByText('Radar awaiting sensor lock').waitFor();
  await save('01-initial-awaiting.png');

  await page.goto(`${baseUrl}/`);
  await page.getByText('LIVE LAB · ISOLATED SIMULATION').waitFor();
  await page.getByText('Receiving observations').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.timeline-chart circle').length > 1, null, { timeout: 15000 });
  await save('02-live-observation.png');

  await page.goto(`${baseUrl}/?mode=fixture`);
  await page.getByText('FIXTURE DATA · NOT LIVE').waitFor();
  await page.locator('.radar-island-marker').first().waitFor();
  await save('03-local-radar-fixture.png');

  await page.locator('.object-row').filter({ hasText: 'fold-A3' }).click();
  await page.getByTestId('selected-fold-detail').waitFor();
  await save('04-selected-fold-fixture.png');

  await page.locator('.environment-panel').screenshot({ path: join(outputDir, '05-environment-readings-fixture.png'), animations: 'disabled' });

  await page.goto(`${baseUrl}/?mode=offline`);
  await page.locator('.health-notice').waitFor();
  await save('06-sensor-unavailable.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?mode=fixture`);
  await page.getByText('FIXTURE DATA · NOT LIVE').waitFor();
  await save('07-responsive-mobile-fixture.png');

  for (const name of [
    '01-initial-awaiting.png', '02-live-observation.png', '03-local-radar-fixture.png',
    '04-selected-fold-fixture.png', '05-environment-readings-fixture.png',
    '06-sensor-unavailable.png', '07-responsive-mobile-fixture.png',
  ]) console.log(join(outputDir, name));
} finally {
  await browser.close();
}
