// Real-browser frames of the guided mission. Usage: node scripts/atlas-mission-frames.mjs <outDir> [WxH] [base] [name=clock ...]
// Each frame jumps the mission clock with ?at=<seconds> and waits for the scene to settle; observations are still delivered chronologically.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/atlas-evidence/mission-directors-cut/frames';
const [W, H] = (process.argv[3] ?? '1918x830').split('x').map(Number);
const base = process.argv[4] ?? 'http://127.0.0.1:5180/';
const custom = process.argv.slice(5).map(a => a.split('='));
const FRAMES = custom.length ? custom : [
  ['01-opening-problem', 'pre'], ['02-baymax-ready-to-scan', 5.3], ['03-first-sensor-acquisition', 7.2], ['04-new-island-recorded', 9.8], ['05-fold-acquired', 18], ['06-debris-cluster-acquired', 23.5],
  ['07-sensor-only-view', 35], ['08-memory-restored-view', 38.5], ['09-last-known-retained', 41.5],
  ['10-fold-before-observation', 47.5], ['11-fold-after-observation', 55], ['12-measured-change-comparison', 59.5],
  ['13-evidence-measured', 67], ['14-frozen-prediction', 71.5], ['15-later-actual-observation', 77], ['16-forecast-evaluation', 81.5], ['17-forecast-miss', 88], ['18-genuine-abstention', 93.5],
  ['19-partial-knowledge-synthesis', 98.5], ['20-next-observation-recommended', 103], ['21-navigation-assessment', 108], ['22-limits-and-why', 114], ['23-cinematic-final-frame', 121],
];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const issues = [], manifest = [];
page.on('pageerror', e => issues.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') issues.push(`${m.type()}: ${m.text()}`); });
for (const [name, at] of FRAMES) {
  const url = at === 'pre' ? `${base}?sound=0` : `${base}?sound=0&at=${at}`;
  await page.goto(url);
  await page.waitForSelector('[data-testid="mission-experience"]');
  await page.waitForTimeout(at === 'pre' ? 6000 : 4500);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="mission-experience"]');
    const text = s => document.querySelector(s)?.textContent ?? null;
    return { beat: el?.getAttribute('data-beat'), chapter: el?.getAttribute('data-chapter'), lens: el?.getAttribute('data-lens'), headline: text('[data-testid="mission-headline"]'), insight: text('[data-testid="insight"]'), clock: text('[data-testid="mission-clock"]') };
  });
  manifest.push({ name, at, ...info });
  console.log(name, at, info.beat, '|', info.headline);
}
await writeFile(join(out, 'manifest.json'), JSON.stringify({ viewport: `${W}x${H}`, frames: manifest, consoleIssues: issues }, null, 2));
console.log(issues.length ? `console issues:\n${issues.join('\n')}` : 'no console issues');
await browser.close();
