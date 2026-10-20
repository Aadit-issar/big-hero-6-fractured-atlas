// Deterministic frame capture of the Moving Corridor mission (film mode).
// Usage: node scripts/atlas-challenge-film.mjs <outDir> <fps> <startFrame> <endFrameExclusive> [base] [extraQuery]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [out, fpsArg, a, b, baseArg, extra = ''] = process.argv.slice(2);
const fps = Number(fpsArg), start = Number(a), end = Number(b);
const base = baseArg ?? 'http://127.0.0.1:5180/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const issues = [];
page.on('pageerror', e => issues.push(e.message));
page.on('console', m => { if (m.type() === 'error') issues.push(m.text()); });
await page.goto(`${base}?experience=challenge&film=1&t=${(start / fps).toFixed(3)}${extra}`);
await page.waitForFunction(() => window.__film && window.__film.ready(), null, { timeout: 120000 });
const warm = 12, t0 = Date.now();
for (let f = start - warm; f < end; f += 1) {
  const clock = Math.max(0, f) / fps;
  await page.evaluate(([c, ms]) => { window.__film.setClock(c); window.__film.step(ms); }, [clock, 1000 / fps]);
  if (f >= start) {
    await page.screenshot({ path: join(out, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
    if ((f - start) % 50 === 0) console.log(`frame ${f} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
if (issues.length) console.log('ISSUES', [...new Set(issues)].slice(0, 5));
await browser.close();
