// Dimension frame pacing under the three presentation configurations (the Dimension window is what the user plays in).
// Usage: node scripts/atlas-config-perf.mjs [atlasBase] [dimensionUrl] [out.json]
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5184/', dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/?quality=performance', out = process.argv[4] ?? 'docs/atlas-evidence/atlas-final-release/performance-configurations.json';
const sample = (page, ms) => page.evaluate(async d => { const a = []; let last = performance.now(); await new Promise(res => { const s = last; const t = n => { a.push(n - last); last = n; if (n - s < d) requestAnimationFrame(t); else res(); }; requestAnimationFrame(t); }); a.shift(); const q = [...a].sort((x, y) => x - y); const at = p => q[Math.min(q.length - 1, Math.floor(q.length * p))]; return { frames: a.length, fps: +(1000 / (a.reduce((x, y) => x + y, 0) / a.length)).toFixed(1), p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), p99: +at(0.99).toFixed(1), over33: a.filter(x => x > 33.4).length }; }, ms);
const results = [];
for (const [label, atlasQuery] of [['Dimension alone (performance preset)', null], ['Configuration A: Dimension + ATLAS lightweight (no 3D), linked', '&light=1'], ['Configuration B: Dimension + full cinematic ATLAS, linked (30 fps cap, performance preset)', '&quality=performance']]) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let dim, atlas;
  if (atlasQuery === null) { dim = await context.newPage(); await dim.goto(dimensionUrl); }
  else {
    atlas = await context.newPage();
    await atlas.goto(`${atlasBase}?experience=live&dimension=${encodeURIComponent(dimensionUrl)}${atlasQuery}`);
    [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByRole('button', { name: /Open Dimension & connect/ }).click()]);
    await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
  }
  await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
  await dim.bringToFront(); await dim.waitForTimeout(6000);
  const idle = await sample(dim, 8000);
  await dim.keyboard.down('KeyW'); await dim.keyboard.down('ShiftLeft');
  const flying = await sample(dim, 6000);
  await dim.keyboard.up('KeyW'); await dim.keyboard.up('ShiftLeft');
  const row = { label, dimensionIdle: idle, dimensionFlying: flying };
  if (atlas) { const s = await atlas.evaluate(() => { const v = window.__ATLAS_LIVE__.snapshot(); return { accepted: v.link.counters.accepted, status: v.link.status }; }); row.atlasLinkAfterRun = s; }
  results.push(row); console.log(label, JSON.stringify({ idle, flying }));
  await browser.close(); await new Promise(r => setTimeout(r, 3000));
}
await writeFile(out, JSON.stringify({ note: 'Frame intervals measured in the Dimension window (headless Chrome, integrated AMD Radeon, 1280x720). The measured window is the one being played; frame intervals are not GPU times.', results }, null, 2));
