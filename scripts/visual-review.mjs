// Visual review capture at presentation resolution: both applications, every ATLAS mode, selection states and the Dimension navigation view.
//   node scripts/visual-review.mjs <outDir> [atlasUrl] [dimensionUrl]
// Output is a set of PNGs named in review order. LOOK at them; they are the evidence for the visual quality gates.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/evidence/overhaul/after';
const atlasBase = process.argv[3] ?? 'http://127.0.0.1:5184/';
const dimensionUrl = process.argv[4] ?? 'http://127.0.0.1:4183/?quality=performance&view=baymax&atlas=http://127.0.0.1:5184/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const [W, H] = (process.env.VIEWPORT ?? '1920x1080').split('x').map(Number);
const context = await browser.newContext({ viewport: { width: W, height: H } });
const atlas = await context.newPage();
const errors = [];
atlas.on('pageerror', e => errors.push(`atlas: ${e.message}`));
await atlas.goto(`${atlasBase}?dimension=${encodeURIComponent(dimensionUrl)}`);
await atlas.waitForSelector('[data-testid="cmd-opening"]');
const [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByTestId('open-dimension').click()]);
dim.on('pageerror', e => errors.push(`dimension: ${e.message}`));
await dim.setViewportSize({ width: W, height: H });
await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 180000 });
await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
await dim.waitForFunction(() => document.querySelector('main[data-render-ready="true"]'), null, { timeout: 180000 }).catch(() => undefined);
const shot = async (page, name) => { await page.screenshot({ path: join(out, `${name}.png`) }); console.log('saved', name); };
const sleep = ms => atlas.waitForTimeout(ms);

await dim.bringToFront(); await sleep(2500);
await shot(dim, '01-dimension-baymax-view');
await dim.keyboard.down('KeyW'); await sleep(1800); await dim.keyboard.up('KeyW'); await sleep(600);
await shot(dim, '02-dimension-flight');
await dim.keyboard.press('KeyV'); await sleep(800);
await shot(dim, '03-dimension-first-person');
await dim.keyboard.press('KeyV');

await atlas.bringToFront(); await sleep(9000);
await shot(atlas, '10-atlas-tactical-opening');
const hasCapsule = await atlas.getByTestId('target-capsule-abigail').count();
if (hasCapsule) {
  await atlas.getByTestId('target-capsule-abigail').click(); await sleep(2500);
  await shot(atlas, '11-atlas-tactical-capsule-selected');
}
await atlas.getByTestId('tab-predict').click(); await sleep(7000);
await shot(atlas, '12-atlas-predictive');
await atlas.getByTestId('tab-route').click(); await sleep(3000);
await shot(atlas, '13-atlas-route-capsule');
await atlas.getByTestId('speed').fill('8').catch(() => undefined); await sleep(1500);
await shot(atlas, '14-atlas-route-capsule-speed8');
await atlas.getByTestId('send-route').click().catch(() => undefined); await sleep(3500);
await shot(atlas, '15-atlas-route-sent');
await dim.bringToFront(); await sleep(1500);
await shot(dim, '16-dimension-route-sent');
await sleep(2500);
await shot(dim, '17-dimension-route-progress');

await atlas.bringToFront();
await atlas.getByTestId('tab-tactical').click();
const fold = await atlas.evaluate(() => window.__ATLAS_COMMAND__.snapshot().entities.find(e => e.kind === 'fold')?.id ?? null);
if (fold) {
  await atlas.getByTestId('search').fill(fold).catch(() => undefined);
  await atlas.getByTestId(`target-${fold}`).click().catch(() => undefined);
  await atlas.getByTestId('tab-route').click(); await sleep(3000);
  await shot(atlas, '18-atlas-route-fold');
}
await writeFile(join(out, 'errors.json'), JSON.stringify(errors, null, 2));
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
