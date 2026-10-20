// Resource-lifecycle soak for the augmented experience: repeated restart, seek, analysis mount/unmount, camera mode changes.
// Reports GPU object counts (geometries, textures, shader programs) and JS heap across cycles. Usage: node scripts/atlas-augmented-soak.mjs [base] [cycles] [out.json]
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:5180/';
const cycles = Number(process.argv[3] ?? 25);
const out = process.argv[4] ?? 'docs/atlas-evidence/live-intelligence-final/soak.json';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?at=12`);
await page.waitForFunction(() => !!window.__ATLAS_RENDER__, null, { timeout: 60000 });
const sample = () => page.evaluate(() => { window.gc?.(); return { render: window.__ATLAS_RENDER__?.() ?? null, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null, listeners: document.querySelectorAll('canvas').length }; });
const seek = t => page.getByRole('slider', { name: 'Mission timeline' }).evaluate((n, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, String(v)); n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, t);
await page.waitForTimeout(3000);
const series = [{ cycle: 0, ...(await sample()) }];
for (let i = 1; i <= cycles; i += 1) {
  await seek(2); await page.waitForTimeout(150); await seek(26); await page.waitForTimeout(150); await seek(12);
  await page.getByRole('button', { name: 'Restart mission' }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Pause mission' }).click();
  await page.getByRole('button', { name: /Guided camera|Resume guided/ }).click();
  // Navigation: open the advisor, change destination, ask for the next observation, close it.
  await page.getByTestId('navigation-toggle').click();
  const sel = page.getByLabel('Navigation destination');
  await sel.selectOption({ index: 1 }); await page.waitForTimeout(80); await sel.selectOption({ index: 2 }); await page.waitForTimeout(80);
  await page.getByRole('button', { name: 'Recommend next observation' }).click();
  await page.getByTestId('navigation-toggle').click();
  await page.getByRole('button', { name: 'Analysis', exact: true }).click();      // unmounts the whole 3D stage
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Return to the dimension' }).click();   // remounts it
  await page.waitForFunction(() => !!window.__ATLAS_RENDER__, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  if (i % 5 === 0 || i === cycles) { const s = { cycle: i, ...(await sample()) }; series.push(s); console.log(JSON.stringify(s)); }
}
await page.waitForTimeout(1500);
const first = series[1] ?? series[0], last = series.at(-1);
const verdict = {
  geometriesStable: last.render.geometries <= first.render.geometries + 2,
  texturesStable: last.render.textures <= first.render.textures + 2,
  programsStable: last.render.programs <= first.render.programs + 1,
  singleCanvas: series.every(s => s.listeners === 1),
  heapGrowthMB: last.heapMB !== null && first.heapMB !== null ? +(last.heapMB - first.heapMB).toFixed(1) : null,
};
await writeFile(out, JSON.stringify({ base, cycles, series, verdict, errors: errors.slice(0, 10) }, null, 2));
console.log('verdict', JSON.stringify(verdict), errors.length ? `errors: ${errors.length}` : 'no errors');
await browser.close();
