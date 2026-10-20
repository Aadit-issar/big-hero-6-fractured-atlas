// Deterministic stills of the Moving Corridor film at chosen film-clock seconds.
// Usage: node scripts/atlas-challenge-stills.mjs <outDir> <t1,t2,...> [base=http://127.0.0.1:5180/] [extraQuery]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/atlas-evidence/controlled-challenge-final/frames';
const times = (process.argv[3] ?? '3,10,20').split(',').map(Number);
const base = process.argv[4] ?? 'http://127.0.0.1:5180/';
const extra = process.argv[5] ?? '';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const issues = [];
page.on('pageerror', e => issues.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') issues.push(m.text()); });
for (const t of times) {
  await page.goto(`${base}?experience=challenge&film=1&t=${t}${extra}`);
  await page.waitForFunction(() => window.__film && window.__film.ready(), null, { timeout: 90000 });
  // Warm-up: sequential fixed-step frames so smoothed elements (Baymax) settle deterministically.
  const warm = 30;
  for (let i = 0; i < warm; i += 1) { await page.evaluate(([clock, ms]) => { window.__film.setClock(clock); window.__film.step(ms); }, [Math.max(0, t - (warm - 1 - i) / 30), (i + 1) * (1000 / 30)]); }
  await page.waitForTimeout(150);
  const file = join(out, `t${String(t).padStart(6, '0')}.png`);
  await page.screenshot({ path: file });
  console.log('wrote', file);
}
if (issues.length) console.log('ISSUES', [...new Set(issues)].slice(0, 8));
await browser.close();
