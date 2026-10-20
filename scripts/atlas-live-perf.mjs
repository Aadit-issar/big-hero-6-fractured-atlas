// ATLAS frame pacing while the real Dimension renders at the same time on the same GPU (no screen recording).
// Usage: node scripts/atlas-live-perf.mjs [atlasBase] [dimensionUrl] [out.json]
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5184/';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/';
const out = process.argv[4] ?? 'docs/atlas-evidence/live-intelligence-final/performance-live.json';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const results = [];
for (const [label, query, size] of [
  ['balanced, 1280x720 window beside the Dimension', '', { width: 1280, height: 720 }],
  ['performance preset, 1280x720 window beside the Dimension', '&quality=performance', { width: 1280, height: 720 }],
  ['balanced, 1920x1080', '', { width: 1920, height: 1080 }],
  ['performance preset, 1920x1080', '&quality=performance', { width: 1920, height: 1080 }],
]) {
  const context = await browser.newContext({ viewport: size });
  const atlas = await context.newPage();
  await atlas.goto(`${atlasBase}?experience=live&dimension=${encodeURIComponent(dimensionUrl)}${query}`);
  const [dimension] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByRole('button', { name: /Open Dimension & connect/ }).click()]);
  await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
  await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
  await atlas.waitForTimeout(6000);
  const sample = ms => atlas.evaluate(async duration => {
    const deltas = []; let last = performance.now();
    await new Promise(resolve => { const start = last; const tick = now => { deltas.push(now - last); last = now; if (now - start < duration) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
    deltas.shift(); const d = [...deltas].sort((a, b) => a - b); const q = p => d[Math.min(d.length - 1, Math.floor(d.length * p))];
    return { frames: d.length, fps: +(1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length)).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), worst: +d.at(-1).toFixed(1), over33: d.filter(x => x > 33.4).length };
  }, ms);
  const idle = await sample(8000);
  await dimension.bringToFront();
  await dimension.keyboard.down('KeyW'); await dimension.keyboard.down('ShiftLeft');
  const flying = await sample(6000);
  await dimension.keyboard.up('KeyW'); await dimension.keyboard.up('ShiftLeft');
  results.push({ label, idle, flying });
  console.log(label, JSON.stringify({ idle, flying }));
  await context.close();
}
await writeFile(out, JSON.stringify({ atlasBase, dimensionUrl, note: 'ATLAS window frame pacing with the real Dimension (integration build) rendering concurrently on the same integrated AMD Radeon GPU. Both windows are headless Chrome; no recording.', results }, null, 2));
await browser.close();
