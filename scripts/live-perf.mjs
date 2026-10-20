// Measures frame rates of the two applications, alone and together (both windows visible, linked, with a route active), in real Chrome.
//   node scripts/live-perf.mjs [atlasUrl] [dimensionUrl] [outFile] [seconds]
// The Dimension reports its own frame times (engine.performance); ATLAS is measured by counting requestAnimationFrame callbacks. Results depend on
// the machine's GPU and on what else is running: benchmark with other GPU-heavy applications closed.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5184/';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4183/?quality=performance&view=baymax&atlas=http://127.0.0.1:5184/';
const outFile = process.argv[4] ?? 'docs/evidence/live-perf.json';
const seconds = Number(process.argv[5] ?? 20);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const info = await (async () => { const c = await browser.newContext(); const p = await c.newPage(); await p.goto('about:blank'); const v = browser.version(); await c.close(); return { chrome: v }; })();

const dimStats = page => page.evaluate(() => { const p = window.__FRACTURED_DIAGNOSTICS__.readPerformance(); return { fps: +p.averageFps.toFixed(1), p50Ms: +p.p50FrameMs.toFixed(1), p95Ms: +p.p95FrameMs.toFixed(1), p99Ms: +p.p99FrameMs.toFixed(1), frames: p.frameCount, drawCalls: p.drawCalls, triangles: p.triangles }; });
const rafFps = (page, ms) => page.evaluate(ms => new Promise(resolve => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(tick); }), ms);

const result = { when: new Date().toISOString(), ...info, seconds, viewports: { atlas: '1600x900', dimension: '1280x720' } };

// Phase A: the Dimension alone.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(dimensionUrl);
  await page.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
  await page.waitForFunction(() => document.querySelector('main[data-render-ready="true"]'), null, { timeout: 180000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__FRACTURED_DIAGNOSTICS__.read(); });
  await page.waitForTimeout(seconds * 1000);
  result.dimensionAlone = await dimStats(page);
  await ctx.close();
}

// Phase B: both windows, linked, route active.
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const atlas = await ctx.newPage();
  await atlas.goto(`${atlasBase}?dimension=${encodeURIComponent(dimensionUrl)}`);
  await atlas.waitForSelector('[data-testid="cmd-opening"]');
  const [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByTestId('open-dimension').click()]);
  await dim.setViewportSize({ width: 1280, height: 720 });
  await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 180000 });
  await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
  await atlas.waitForTimeout(8000);
  await atlas.getByTestId('target-capsule-abigail').click().catch(() => undefined);
  await atlas.getByTestId('tab-route').click();
  await atlas.getByTestId('send-route').click().catch(() => undefined);
  await atlas.waitForTimeout(3000);
  // Headless Chrome throttles the background page, so each window is measured while it is in front (the other keeps running, throttled).
  await atlas.bringToFront();
  const atlasFpsFront = await rafFps(atlas, seconds * 1000);
  await dim.bringToFront();
  const dimFpsFront = await rafFps(dim, seconds * 1000);
  result.both = { note: 'two linked windows, route active; each measured while in front', atlasFpsInFront: atlasFpsFront, dimensionFpsInFront: dimFpsFront, dimensionEngineStats: await dimStats(dim) };
  result.atlasSceneStats = await atlas.evaluate(() => { const s = window.__ATLAS_COMMAND__.snapshot(); return { entities: s.entities.length, targets: s.targets.length, simTime: +s.simTime.toFixed(1), link: s.link.status }; });
  await ctx.close();
}
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
