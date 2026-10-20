// Records the complete guided mission in a real browser and samples stage identity and frame times while it plays.
// Usage: node scripts/atlas-mission-record.mjs <outDir> [WxH] [base]
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/atlas-evidence/mission-directors-cut/video';
const [W, H] = (process.argv[3] ?? '1918x830').split('x').map(Number);
const base = process.argv[4] ?? 'http://127.0.0.1:5180/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } } });
const page = await context.newPage();
const issues = [];
page.on('pageerror', e => issues.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') issues.push(m.text()); });
await page.goto(`${base}?sound=0`);
await page.waitForSelector('[data-testid="begin-mission"]');
await page.evaluate(() => {
  window.__frames = []; let last = performance.now();
  const tick = now => { window.__frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(2500);
await page.getByTestId('begin-mission').click();
const samples = [];
const started = Date.now();
for (;;) {
  const s = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="mission-experience"]');
    return { chapter: Number(el?.getAttribute('data-chapter')), beat: el?.getAttribute('data-beat'), clock: document.querySelector('[data-testid="mission-clock"]')?.textContent, headline: document.querySelector('[data-testid="mission-headline"]')?.textContent ?? null, level: window.__ATLAS_LEVEL__ ?? null };
  });
  samples.push({ wall: (Date.now() - started) / 1000, ...s });
  if (s.clock?.startsWith('2:02') || Date.now() - started > 150000) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(3000);
const frames = await page.evaluate(() => window.__frames.slice(30));
const sorted = [...frames].sort((a, b) => a - b);
const stats = { frames: frames.length, meanMs: frames.reduce((a, b) => a + b, 0) / frames.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)], p99Ms: sorted[Math.floor(sorted.length * 0.99)], maxMs: sorted.at(-1), over50ms: frames.filter(f => f > 50).length };
let regressions = 0;
for (let i = 1; i < samples.length; i += 1) if (samples[i].chapter < samples[i - 1].chapter) regressions += 1;
const video = page.video();
await context.close();
const path = await video.path();
await rename(path, join(out, 'mission-full.webm'));
await writeFile(join(out, 'run.json'), JSON.stringify({ viewport: `${W}x${H}`, wallSeconds: (Date.now() - started) / 1000, stats, stageRegressions: regressions, consoleIssues: issues, samples }, null, 1));
console.log(JSON.stringify({ stats, stageRegressions: regressions, consoleIssues: issues.length }));
await browser.close();
