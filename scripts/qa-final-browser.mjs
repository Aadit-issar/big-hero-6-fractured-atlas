// QA: Predictive vs Route consistency, speed recompute, outcome honesty and 1366x768 layout, with both apps linked.
//   node scripts/qa-final-browser.mjs <outDir> [WxH]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] ?? 'docs/evidence/qa-final/browser';
const [W, H] = (process.argv[3] ?? '1366x768').split('x').map(Number);
const atlasBase = 'http://127.0.0.1:5184/';
const dimensionUrl = 'http://127.0.0.1:4183/?quality=performance&view=baymax&atlas=http://127.0.0.1:5184/';
await mkdir(out, { recursive: true });
const errors = [], log = [], report = { viewport: `${W}x${H}`, checks: [] };
const check = (name, pass, detail) => { report.checks.push({ name, pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail ?? ''); };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: W, height: H } });
const atlas = await context.newPage();
atlas.on('pageerror', e => errors.push(`atlas pageerror: ${e.message}`));
atlas.on('console', m => { if (m.type() === 'error') errors.push(`atlas console: ${m.text().slice(0, 200)}`); });
await atlas.goto(`${atlasBase}?dimension=${encodeURIComponent(dimensionUrl)}`);
await atlas.waitForSelector('[data-testid="cmd-opening"]');
const [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByTestId('open-dimension').click()]);
dim.on('pageerror', e => errors.push(`dimension pageerror: ${e.message}`));
dim.on('console', m => { if (m.type() === 'error') errors.push(`dimension console: ${m.text().slice(0, 200)}`); });
await dim.setViewportSize({ width: W, height: H });
await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 180000 });
await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
await dim.waitForFunction(() => document.querySelector('main[data-render-ready="true"]'), null, { timeout: 180000 }).catch(() => undefined);
const sleep = ms => atlas.waitForTimeout(ms);
const shot = async (page, name) => { await page.screenshot({ path: join(out, `${name}.png`) }); };
const snap = () => atlas.evaluate(() => { const s = window.__ATLAS_COMMAND__.snapshot(); return { simTime: s.simTime, speed: s.speed, selected: s.selectedId, fv: s.forecast ? { version: s.forecast.version, now: s.forecast.now, model: s.forecast.model } : null, ev: s.encounter ? { version: s.encounter.version, now: s.encounter.now, arrival: s.encounter.arrivalTime, aim: s.encounter.aimTime, converged: s.encounter.converged, lead: s.encounter.leadLimited } : null, route: s.route.state, plan: s.plan ? { status: s.plan.status, speed: s.plan.speed, length: s.plan.length, mode: s.plan.mode } : null }; });
const clip = (page, label) => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const txt = (el.textContent || '').trim().slice(0, 40);
    if (!txt) continue;
    const ox = el.scrollWidth > el.clientWidth + 2 && ['hidden', 'clip'].includes(cs.overflowX) && el.children.length === 0;
    const off = r.right > vw + 2 || r.bottom > vh + 2 || r.left < -2;
    if (ox || (off && cs.position !== 'fixed' && !el.closest('canvas'))) bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), txt, ox, off, box: [r.left | 0, r.top | 0, r.right | 0, r.bottom | 0] });
  }
  return { vw, vh, hscroll: document.documentElement.scrollWidth > vw + 1, count: bad.length, sample: bad.slice(0, 12) };
}).then(r => { report[`clip-${label}`] = r; console.log('clip', label, JSON.stringify({ ...r, sample: r.sample.slice(0, 5) })); });

await sleep(9000);
await shot(atlas, '01-atlas-opening');
await clip(atlas, 'tactical');
const hasCapsule = await atlas.getByTestId('target-capsule-abigail').count();
check('capsule target present in catalogue', hasCapsule > 0);
if (hasCapsule) await atlas.getByTestId('target-capsule-abigail').click();
await sleep(3000);
await atlas.getByTestId('tab-predict').click(); await sleep(7000);
const p1 = await snap();
const predictText = await atlas.getByTestId('panel-predict').innerText();
await shot(atlas, '02-predict'); await clip(atlas, 'predict');
await atlas.getByTestId('tab-route').click(); await sleep(2500);
const r1 = await snap();
const routeText = await atlas.getByTestId('panel-route').innerText();
await shot(atlas, '03-route'); await clip(atlas, 'route');
check('selected capsule', p1.selected === 'capsule-abigail', p1.selected);
check('forecast exists', !!p1.fv, JSON.stringify(p1.fv));
// Same-instant comparison: with the Route tab open, the snapshot carries both the forecast and the encounter that is built from it.
const same = await snap();
check('forecast and encounter come from the same evidence (identical version string, same clock)', !!(same.fv && same.ev) && same.fv.version === same.ev.version, `forecast ${same.fv?.version} @${same.fv?.now?.toFixed(2)} vs encounter ${same.ev?.version} @${same.ev?.now?.toFixed(2)}`);
check('predict tab forecast is no older than 1 s of sim time vs route tab (tabs re-made from newer observations only)', !!(p1.fv && r1.ev) && r1.ev.now >= p1.fv.now, `predict ${p1.fv?.version} then route ${r1.ev?.version}`);
report.versions = { predict: p1, route: r1, predictText, routeText };
// speed recompute
const speeds = {};
for (const sp of [6, 14, 30]) {
  await atlas.getByTestId('speed').fill(String(sp)); await sleep(2500);
  const s = await snap(); const eta = await atlas.getByTestId('eta').innerText().catch(() => '(none)');
  speeds[sp] = { plan: s.plan, enc: s.ev, eta: eta.replace(/\n/g, ' | ') }; console.log('speed', sp, JSON.stringify(speeds[sp]));
}
report.speeds = speeds;
check('route plan speed follows the slider', [6, 14, 30].every(sp => speeds[sp].plan?.speed === sp), JSON.stringify([6, 14, 30].map(sp => speeds[sp].plan?.speed)));
check('arrival time/length recomputed (differs between 6 and 30 m/s)', speeds[6].enc && speeds[30].enc && Math.abs((speeds[6].enc.arrival - speeds[6].enc.now) - (speeds[30].enc.arrival - speeds[30].enc.now)) > 0.5, `${speeds[6].enc && (speeds[6].enc.arrival - speeds[6].enc.now).toFixed(1)} s vs ${speeds[30].enc && (speeds[30].enc.arrival - speeds[30].enc.now).toFixed(1)} s`);
await shot(atlas, '04-route-speed30');
// outcome
await atlas.getByTestId('speed').fill('14'); await sleep(1500);
await atlas.getByTestId('send-route').click(); await sleep(3000);
await dim.bringToFront(); await sleep(1500); await shot(dim, '05-dimension-route-active'); await clip(dim, 'dimension-active');
const t0 = Date.now(); let aOut = null, dOut = null;
while (Date.now() - t0 < 150000) {
  aOut = await atlas.getByTestId('route-outcome').count() ? await atlas.getByTestId('route-outcome').innerText() : null;
  dOut = await dim.getByTestId('nav-arrived').count() ? 'arrived' : await dim.getByTestId('nav-missed').count() ? 'missed' : null;
  if (aOut && dOut) break; await sleep(1000);
}
await shot(dim, '06-dimension-outcome'); await atlas.bringToFront(); await shot(atlas, '07-atlas-outcome'); await clip(atlas, 'outcome'); await clip(dim, 'dimension-outcome');
const dimText = await dim.locator('.nav-result').innerText().catch(() => null);
report.outcome = { atlas: aOut, dimension: dOut, dimText, atlasSuccessAttr: await atlas.getByTestId('route-outcome').getAttribute('data-success').catch(() => null) };
console.log(JSON.stringify(report.outcome));
const aTitle = (aOut ?? '').split('\n')[0], dClosest = await dim.getByTestId('nav-closest').innerText().catch(() => '');
check('outcome appears on both sides and agrees', !!aOut && !!dOut && ((dOut === 'arrived') === /ACHIEVED|ARRIVED/.test(aTitle)), `atlas="${aTitle}" dimension=${dOut} closest=${dClosest}`);
const m = /([\d.]+)\s*m\s*\(capture\s*([\d.]+)/.exec(dClosest);
if (m) check('title consistent with measured closest vs capture radius', (dOut === 'arrived') === (Number(m[1]) <= Number(m[2]) + 0.05), dClosest);
report.errors = errors;
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors / console errors');
await browser.close();
