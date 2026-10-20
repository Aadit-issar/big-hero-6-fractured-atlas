// Frame-pacing benchmark for the Augmented Dimension. Usage: node scripts/atlas-augmented-perf.mjs [base] [out.json] [seconds]
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:5184/';
const out = process.argv[3] ?? 'docs/atlas-evidence/live-intelligence-final/performance.json';
const seconds = Number(process.argv[4] ?? 10);
const launch = () => chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const results = [];
for (const [label, query, size] of [
  ['opening 1080p balanced', '', [1920, 1080]],
  ['mission t=3.5 (islands, fold, Baymax, 11 scene objects)', '?at=3.5', [1920, 1080]],
  ['mission t=12 (4 islands, fold, clusters, change overlay)', '?at=12', [1920, 1080]],
  ['mission t=12 performance preset', '?at=12&quality=performance', [1920, 1080]],
  ['mission t=12 at 1440x900', '?at=12', [1440, 900]],
  ['isolated lab 1080p', '?experience=lab', [1920, 1080]],
]) {
  // One browser per case: a previous page's GL context teardown must not share the GPU with the measured page.
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  await page.goto(`${base}${query}`);
  await page.waitForTimeout(4000);
  const stats = await page.evaluate(async ms => {
    const deltas = [];
    let last = performance.now();
    await new Promise(resolve => {
      const start = last;
      const tick = now => { deltas.push(now - last); last = now; if (now - start < ms) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    deltas.shift();
    const sorted = [...deltas].sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      frames: deltas.length, fps: 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length),
      p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: sorted.at(-1), over33: deltas.filter(d => d > 33.4).length,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
    };
  }, seconds * 1000);
  results.push({ label, ...stats });
  console.log(label, JSON.stringify(stats));
  await browser.close();
  await new Promise(r => setTimeout(r, 2500));
}
await writeFile(out, JSON.stringify({ base, seconds, results }, null, 2));
