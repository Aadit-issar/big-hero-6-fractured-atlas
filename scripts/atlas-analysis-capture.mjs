// Advanced Analysis evidence: replay snapshot with scene-object scans. Usage: node scripts/atlas-analysis-capture.mjs [base] [outDir]
import { chromium } from '@playwright/test';
import { join } from 'node:path';
const base = process.argv[2] ?? 'http://127.0.0.1:5184/';
const out = process.argv[3] ?? 'docs/atlas-evidence/live-intelligence-final';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${base}?at=18`);
await page.waitForTimeout(4000);
await page.getByRole('button', { name: 'Analysis', exact: true }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'analysis-01-top.png') });
await page.getByTestId('scene-analysis').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'analysis-02-scene-objects.png') });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
