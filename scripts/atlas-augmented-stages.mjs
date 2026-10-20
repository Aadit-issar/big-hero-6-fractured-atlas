// Mission stage evidence from the real app (replay states reached by chronological delivery). Usage: node scripts/atlas-augmented-stages.mjs [base] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const base = process.argv[2] ?? 'http://127.0.0.1:5180/';
const out = process.argv[3] ?? 'docs/atlas-evidence/live-intelligence-final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const errors = [], shots = [];
const states = [
  ['mission-01-opening', '', 4000, 'Opening: nothing received yet'],
  ['mission-02-discover', '?at=3.5', 9000, 'Discover: islands, fold and the first scene objects acquired by scans'],
  ['mission-03-remember', '?at=8', 9000, 'Remember: ISLAND 02 and the concrete field left range and are last-known records'],
  ['mission-04-detect', '?at=12', 9000, 'Detect: previous record, new observation and the measured displacement'],
  ['mission-05-estimate', '?at=16.5', 9000, 'Estimate: limited projection from observed history'],
  ['mission-06-evaluation', '?at=17.5', 9000, 'Evaluation: later observation against the published estimate'],
  ['mission-07-withheld', '?at=22.5', 9000, 'Abstention: visibility lost, estimate withheld with reason'],
  ['mission-08-understand', '?at=26', 9000, 'Understand: evidence-backed synthesis'],
];
for (const [name, query, wait, note] of states) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}${query}`);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, `${name}.png`) });
  shots.push({ name, query, note, time: await page.getByTestId('mission-experience').getAttribute('data-time'), sceneObjects: await page.getByTestId('mission-experience').getAttribute('data-scene-objects') });
  console.log('captured', name);
  await page.close();
}
await writeFile(join(out, 'mission-stages-manifest.json'), JSON.stringify({ base, shots, errors }, null, 2));
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
