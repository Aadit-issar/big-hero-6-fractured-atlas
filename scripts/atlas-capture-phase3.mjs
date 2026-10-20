import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5180';
const outputDir = process.argv[3] ?? 'docs/atlas-evidence/phase3';
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const capture = async (name, mode, delayMs = 1500, action) => {
    await page.goto(`${baseUrl}/${mode ? `?mode=${mode}` : ''}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(delayMs);
    if (action) await action();
    await page.screenshot({ path: join(outputDir, name), fullPage: true, animations: 'disabled' });
  };

  await capture('01-live-observation.png', '', 3500);
  await capture('02-fold-dynamics-fixture.png', 'temporal', 7000);
  await capture('03-forecast-audit-fixture.png', 'temporal', 7000, async () => {
    await page.getByRole('button', { name: 'Inspect forecast audit' }).click();
    await page.waitForTimeout(500);
  });
  await capture('04-insufficient-evidence-fixture.png', 'insufficient', 800);
  await capture('05-observed-warning-fixture.png', 'warning', 800);
  await capture('06-map-stress-fixture.png', 'stress', 800);

  await page.setViewportSize({ width: 390, height: 844 });
  await capture('07-mobile-temporal-fixture.png', 'temporal', 7000);

  await page.setViewportSize({ width: 1440, height: 1050 });
  await capture('08-offline-degraded-state.png', 'offline', 800);
  console.log(`Captured 8 real browser screenshots under ${outputDir}. Fixture and offline images are labelled in the UI.`);
} finally {
  await browser.close();
}
