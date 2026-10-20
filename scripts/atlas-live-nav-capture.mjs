// Navigation evidence from the real linked session: ATLAS navigation advisor + the in-Dimension advisor. Usage: node scripts/atlas-live-nav-capture.mjs [atlasBase] [dimensionUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5184/', dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/?quality=performance', out = process.argv[4] ?? 'docs/atlas-evidence/atlas-final-release';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const atlas = await context.newPage(); const errors = [], log = [];
atlas.on('pageerror', e => errors.push(`atlas: ${e.message}`));
await atlas.goto(`${atlasBase}?experience=live&dimension=${encodeURIComponent(dimensionUrl)}`);
const [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByRole('button', { name: /Open Dimension & connect/ }).click()]);
dim.on('pageerror', e => errors.push(`dimension: ${e.message}`));
await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
const snap = () => atlas.evaluate(() => { const s = window.__ATLAS_LIVE__.snapshot(); const a = s.navigation.advice; return { sim: s.link.lastSimTime, observer: s.view.observation?.observerWorldPosition, goal: s.navigation.goalId, status: a.status, title: a.recommendation.title, detail: a.recommendation.detail, segments: a.route?.segments.map(x => `${x.kind}:${x.support}:${x.length.toFixed(0)}`) ?? [], goals: a.goals.map(g => g.id), frontiers: a.frontiers.slice(0, 3).map(f => `${f.kind}:${f.label}`), changes: s.navigation.changes.map(c => c.message) }; });
const step = async (name) => { const v = await snap(); log.push({ name, ...v }); console.log(name, JSON.stringify({ status: v.status, goal: v.goal, title: v.title, segments: v.segments })); };
await atlas.waitForTimeout(4000);
await dim.bringToFront(); await dim.keyboard.down('KeyW'); await dim.keyboard.down('ShiftLeft'); await dim.waitForTimeout(1800); await dim.keyboard.up('KeyW'); await dim.keyboard.up('ShiftLeft');
await atlas.waitForTimeout(2500);

// 1. No destination: ATLAS recommends where to look next, from recorded coverage.
await atlas.getByTestId('navigation-toggle').click(); await atlas.waitForTimeout(3500);
await step('explore (no destination)');
await atlas.screenshot({ path: join(out, 'nav-live-01-observation-priority.png') });

// 2. A recorded destination: candidate route with limitations.
const goal = await atlas.evaluate(() => { const g = window.__ATLAS_LIVE__.snapshot().navigation.advice.goals; return (g.find(x => x.id.startsWith('cluster-capsule')) ?? g.find(x => x.kind === 'landmark') ?? g.find(x => x.kind === 'island') ?? g[0]).id; });
await atlas.getByLabel('Navigation destination').selectOption(goal); await atlas.waitForTimeout(4500);
await step(`goal ${goal}`);
await atlas.getByRole('button', { name: 'Why?' }).click(); await atlas.waitForTimeout(1500);
await atlas.screenshot({ path: join(out, 'nav-live-02-route-and-evidence.png') });
await atlas.getByRole('button', { name: 'Hide evidence' }).click();

// 3. The same guidance inside the Dimension, with bearing to the target.
await dim.bringToFront(); await dim.keyboard.press('KeyN'); await dim.waitForTimeout(2500);
await dim.screenshot({ path: join(out, 'nav-live-03-dimension-advisor.png') });
const bearing1 = await dim.getByTestId('atlas-bearing').innerText().catch(() => null);

// 4. Move the real observer: the guidance updates in both windows.
await dim.keyboard.down('KeyD'); await dim.keyboard.down('ShiftLeft'); await dim.waitForTimeout(1800); await dim.keyboard.up('KeyD'); await dim.keyboard.up('ShiftLeft');
await dim.waitForTimeout(2500);
const bearing2 = await dim.getByTestId('atlas-bearing').innerText().catch(() => null);
await step('after moving the real observer');
log.push({ name: 'bearing in the Dimension HUD', before: bearing1, after: bearing2 });
await dim.screenshot({ path: join(out, 'nav-live-04-dimension-advisor-after-move.png') });
await atlas.screenshot({ path: join(out, 'nav-live-05-route-after-move.png') });

// 5. Pick a different destination from inside the Dimension.
const options = await dim.getByLabel('ATLAS destination').locator('option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
const other = options.find(id => id !== goal);
if (other) { await dim.getByLabel('ATLAS destination').selectOption(other); await dim.waitForTimeout(3500); await step(`goal changed in the Dimension to ${other}`); await atlas.screenshot({ path: join(out, 'nav-live-06-goal-from-dimension.png') }); }
await writeFile(join(out, 'nav-live-log.json'), JSON.stringify({ atlasBase, dimensionUrl, log, errors }, null, 2));
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
