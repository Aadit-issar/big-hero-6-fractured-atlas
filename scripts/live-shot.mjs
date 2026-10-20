// Opens ATLAS Command, connects it to a running Dimension in a second real window, optionally waits, and saves screenshots of both.
// Usage: node scripts/live-shot.mjs [atlasUrl] [dimensionUrl] [outDir] [waitSeconds]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5180/';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4183/?quality=performance';
const out = process.argv[4] ?? 'docs/evidence/live-shots';
const wait = Number(process.argv[5] ?? 6);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const atlas = await context.newPage();
const logs = [];
atlas.on('pageerror', e => logs.push(`atlas pageerror: ${e.message}`));
atlas.on('console', m => { if (m.type() === 'error') logs.push(`atlas console: ${m.text()}`); });
await atlas.goto(`${atlasBase}?dimension=${encodeURIComponent(dimensionUrl)}`);
await atlas.waitForSelector('[data-testid="cmd-opening"]');
await atlas.screenshot({ path: join(out, '01-atlas-opening.png') });
const [dimension] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByTestId('open-dimension').click()]);
dimension.on('pageerror', e => logs.push(`dimension pageerror: ${e.message}`));
dimension.on('console', m => { if (m.type() === 'error') logs.push(`dimension console: ${m.text()}`); });
await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
await dimension.setViewportSize({ width: 1280, height: 720 });
await atlas.waitForTimeout(wait * 1000);
await atlas.screenshot({ path: join(out, '02-atlas-live.png') });
await dimension.screenshot({ path: join(out, '03-dimension.png') });
if (process.env.FLOW) {
  await atlas.waitForTimeout(6000);
  await atlas.getByTestId('target-capsule-abigail').click();
  await atlas.waitForTimeout(1500);
  await atlas.screenshot({ path: join(out, '04-selected.png') });
  await atlas.getByTestId('tab-predict').click();
  await atlas.waitForTimeout(3000);
  await atlas.screenshot({ path: join(out, '05-predict.png') });
  await atlas.getByTestId('tab-route').click();
  await atlas.waitForTimeout(1500);
  await atlas.screenshot({ path: join(out, '06-route.png') });
  await atlas.getByTestId('send-route').click();
  await atlas.waitForTimeout(2500);
  await atlas.screenshot({ path: join(out, '07-sent.png') });
  await dimension.screenshot({ path: join(out, '08-dimension-nav.png') });
}
const snap = await atlas.evaluate(() => { const s = window.__ATLAS_COMMAND__.snapshot(); return { status: s.link.status, sim: s.simTime, entities: s.entities.length, targets: s.targets.length, pose: s.pose?.position }; });
console.log(JSON.stringify(snap));
console.log(logs.slice(0, 20).join('\n') || 'no browser errors');
await browser.close();
