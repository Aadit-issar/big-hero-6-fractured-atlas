// Real-browser evidence for the Augmented Dimension milestone. Usage: node scripts/atlas-augmented-capture.mjs [base] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5180/';
const out = process.argv[3] ?? 'docs/atlas-evidence/augmented-dimension-milestone1';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const errors = [], shots = [];
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
const shot = async (name, note, wait = 2500) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, name) });
  shots.push({ name, note, time: await page.locator('[data-testid="mission-experience"]').getAttribute('data-time') });
  console.log('captured', name);
};
const url = (q = '') => `${base}${q}`;

await page.goto(url()); await shot('01-opening.png', 'Opening: nebula only, ATLAS has received nothing', 4500);
await page.goto(url('?at=3')); await shot('02-observed-island-and-fold.png', 'Replay t=3: islands and fold recorded by accepted observations', 9000);
await page.goto(url('?at=3&hud=0')); await shot('03-clean-view.png', 'Same state, HUD hidden', 9000);
await page.goto(url('?at=8')); await shot('04-remembered.png', 'Replay t=8: ISLAND 02 and FOLD 01 out of range, kept as remembered', 9000);
await page.goto(url()); await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Begin Mission' }).click();
await shot('05-reveal-sequence-a.png', 'Begin: scan pulse leaves observer', 1200);
await shot('06-reveal-sequence-b.png', 'Island contour sweep in progress', 1700);
await shot('07-reveal-sequence-c.png', 'Island resolved; label appears', 2600);
await page.goto(url('?at=3'));
await page.waitForTimeout(9000);
await page.mouse.click(960, 540); // empty-space click must not select anything
await page.waitForTimeout(500);
const anchors = await page.evaluate(() => window.__atlasAnchors);
await writeFile(join(out, 'anchors.json'), JSON.stringify(anchors, null, 2));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ base, viewport: '1920x1080', shots, consoleIssues: errors }, null, 2));
console.log(errors.length ? `console issues:\n${errors.join('\n')}` : 'no console issues');
await browser.close();
