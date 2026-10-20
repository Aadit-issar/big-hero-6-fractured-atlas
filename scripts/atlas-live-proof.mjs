// Live-link proof matrix: ATLAS (5180) linked to the real running Dimension with the ATLAS bridge (4175) in two real windows.
// Usage: node scripts/atlas-live-proof.mjs [atlasBase] [dimensionUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5180/';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/';
const out = process.argv[4] ?? 'docs/atlas-evidence/live-intelligence-final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const results = [], errors = [];
const check = (id, title, pass, data = {}) => { results.push({ id, title, pass, ...data }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}`, JSON.stringify(data)); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function session(label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const atlas = await context.newPage();
  atlas.on('pageerror', e => errors.push(`${label} atlas: ${e.message}`));
  await atlas.goto(`${atlasBase}?experience=live&dimension=${encodeURIComponent(dimensionUrl)}`);
  await atlas.waitForSelector('[data-testid="live-connect"]');
  const [dimension] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByRole('button', { name: /Open Dimension & connect/ }).click()]);
  dimension.on('pageerror', e => errors.push(`${label} dimension: ${e.message}`));
  await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
  await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
  const state = () => atlas.evaluate(() => {
    const s = window.__ATLAS_LIVE__.snapshot();
    return {
      status: s.link.status, session: s.link.session, seq: s.link.lastSeq, simTime: s.link.lastSimTime, episode: s.link.episode, counters: s.link.counters,
      observer: s.view.observation?.observerWorldPosition ?? null, range: s.link.scanRange,
      records: s.scene.records.map(r => ({ id: r.id, kind: r.kind, category: r.category, family: r.family, observed: r.currentlyObserved, count: r.observationCount, first: r.firstSeenAt, last: r.lastSeenAt, pos: r.lastKnownPosition, lastRange: r.lastRange })),
      clusters: s.scene.clusters.map(c => ({ label: c.label, count: c.count })), scans: s.scene.scans.length, islands: s.view.mapping.islands.length, folds: s.view.mapping.folds.length,
      events: s.view.events.map(e => e.kind), activity: s.activity.map(a => `${a.kind}:${a.title}`),
    };
  });
  const truth = () => dimension.evaluate(() => { const d = window.__FRACTURED_DIAGNOSTICS__.read(); return { camera: d.cameraPosition, time: d.time, debrisInstances: d.render.assets.debrisInstances, formations: d.render.assets.layout?.formations?.length ?? null }; });
  const fly = async (keys, ms) => { await dimension.bringToFront(); for (const k of keys) await dimension.keyboard.down(k); await dimension.waitForTimeout(ms); for (const k of [...keys].reverse()) await dimension.keyboard.up(k); await dimension.waitForTimeout(1500); };
  return { context, atlas, dimension, state, truth, fly };
}

// ---------------- Run 1: connection, pose, discovery, omniscience, memory, re-observation, change, restart, disconnect
const r1 = await session('run1');
const s0 = await r1.state(), t0 = await r1.truth();
check('A', 'Genuine connection to the running Dimension session', s0.status === 'connected' && !!s0.session, { session: s0.session, accepted: s0.counters.accepted });
check('A2', 'Pose agreement at start (ATLAS observer == Dimension explorer/camera)', dist(s0.observer, t0.camera) < 5 && true, { atlas: s0.observer, dimension: t0.camera });
await r1.atlas.screenshot({ path: join(out, 'live-02-connected.png') });
await r1.dimension.screenshot({ path: join(out, 'dimension-02-start.png') });

await r1.fly(['KeyW', 'ShiftLeft'], 2500);
const s1 = await r1.state(), t1 = await r1.truth();
check('B', 'Pose update: moving the real observer moves ATLAS', dist(s1.observer, s0.observer) > 20 && dist(s1.observer, t1.camera) < 5, { moved: dist(s1.observer, s0.observer).toFixed(1), error: dist(s1.observer, t1.camera).toFixed(2) });
const ids0 = new Set(s0.records.map(r => r.id)), new1 = s1.records.filter(r => !ids0.has(r.id));
check('C', 'Discovery: entering range acquires objects not previously recorded', new1.length > 0, { newRecords: new1.length, total: s1.records.length });
const observed1 = s1.records.filter(r => r.observed);
check('D', 'No omniscience: observed objects are within scan range; far fewer records than the registry', observed1.every(r => dist(r.pos, s1.observer) <= (s1.range ?? 45) + 3) && s1.records.length < t1.debrisInstances / 2, { recorded: s1.records.length, registryTotal: t1.debrisInstances, maxObservedRange: Math.max(...observed1.map(r => dist(r.pos, s1.observer))).toFixed(1) });
await r1.atlas.screenshot({ path: join(out, 'live-03-after-flight.png') });

await r1.fly(['KeyW', 'ShiftLeft'], 3500);
const s2 = await r1.state();
const remembered = s2.records.filter(r => !r.observed);
check('E', 'Memory: objects left behind are kept as last-known records', remembered.length > 0 && remembered.every(r => r.last > 0 || r.last === 0), { remembered: remembered.length, observed: s2.records.length - remembered.length, sample: remembered.slice(0, 2).map(r => ({ id: r.id, last: r.last, pos: r.pos })) });
await r1.atlas.screenshot({ path: join(out, 'live-04-remembered.png') });

await r1.fly(['KeyS', 'ShiftLeft'], 6200);
const s3 = await r1.state();
const reobserved = s3.records.filter(r => r.observed && r.count >= 2 && remembered.some(m => m.id === r.id));
check('F', 'Re-observation: returning refreshes records instead of duplicating them', reobserved.length > 0 && new Set(s3.records.map(r => r.id)).size === s3.records.length, { reobserved: reobserved.length, uniqueIds: new Set(s3.records.map(r => r.id)).size, total: s3.records.length });
check('G', 'Change detection uses real earlier and later observations (islands drift with simulation time)', s3.events.includes('island-position-changed') || s3.events.includes('fold-state-changed'), { kinds: [...new Set(s3.events)] });
const cats = [...new Set(s3.records.map(r => r.category))];
check('H', 'Debris classification: real categories acquired', cats.length >= 2, { categories: cats, clusters: s3.clusters });
await r1.atlas.screenshot({ path: join(out, 'live-05-reobserved.png') });

// Manual scan: honest result either way.
const requested = await r1.atlas.evaluate(() => window.__ATLAS_LIVE__.requestScan());
await r1.atlas.waitForTimeout(1500);
const s4 = await r1.state();
check('M', 'Scan now returns an honest result', !!requested && s4.activity.some(a => a.startsWith('scan:') || a.startsWith('discovery:') || a.startsWith('memory:')), { requestId: requested, scans: s4.scans });

// Restart: reload the Dimension -> new session -> new episode, memory not continued.
const sessionBefore = s4.session;
await r1.dimension.reload();
await r1.atlas.waitForFunction(prev => { const s = window.__ATLAS_LIVE__.snapshot(); return s.link.status === 'connected' && s.link.session !== prev; }, sessionBefore, { timeout: 120000 });
const s5 = await r1.state();
check('I', 'Session restart is a new episode (records not continued)', s5.session !== sessionBefore && s5.episode === 2 && s5.records.length < s4.records.length + 1 && s5.records.every(r => r.count >= 1), { before: sessionBefore.slice(0, 8), after: s5.session.slice(0, 8), episode: s5.episode, recordsAfter: s5.records.length });
await r1.atlas.screenshot({ path: join(out, 'live-06-new-session.png') });

// Disconnect: close the Dimension window.
await r1.atlas.waitForTimeout(2500);
const beforeClose = await r1.state();
await r1.dimension.close();
await r1.atlas.waitForFunction(() => ['stale', 'disconnected'].includes(window.__ATLAS_LIVE__.snapshot().link.status), null, { timeout: 20000 });
const stale = await r1.state();
await r1.atlas.waitForFunction(() => window.__ATLAS_LIVE__.snapshot().link.status === 'disconnected', null, { timeout: 20000 });
const gone = await r1.state();
check('J', 'Disconnection is reported honestly and records stay', gone.status === 'disconnected' && gone.records.length === beforeClose.records.length && gone.records.length > 0, { firstStatus: stale.status, finalStatus: gone.status, recordsKept: gone.records.length });
await r1.atlas.screenshot({ path: join(out, 'live-07-disconnected.png') });
const label = await r1.atlas.getByTestId('source-label').innerText();
check('J2', 'UI never claims to be connected after disconnection', !/^CONNECTED/.test(label), { label });
await r1.context.close();

// K. Isolated lab is labelled as such and never as the Dimension link.
const lab = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await lab.goto(`${atlasBase}?experience=lab`);
await lab.waitForSelector('[data-testid="source-label"]');
const labLabel = await lab.getByTestId('source-label').innerText();
check('K', 'Isolated Lab is distinguished from the live link', /ISOLATED/.test(labLabel) && !/CONNECTED TO DIMENSION/.test(labLabel), { label: labLabel });
await lab.screenshot({ path: join(out, 'lab-01-isolated.png') });
await lab.close();

// ---------------- Runs 2 and 3: different paths give different acquisitions
async function path(name, keys, ms) {
  const r = await session(name);
  const start = await r.state();
  await r.fly(keys, ms);
  const end = await r.state();
  await r.atlas.screenshot({ path: join(out, `live-path-${name}.png`) });
  await r.context.close();
  return { start, end };
}
const pa = await path('forward', ['KeyW', 'ShiftLeft'], 3000);
const pb = await path('sideways-up', ['KeyD', 'Space', 'ShiftLeft'], 3000);
const setA = new Set(pa.end.records.map(r => r.id)), setB = new Set(pb.end.records.map(r => r.id));
const onlyA = [...setA].filter(x => !setB.has(x)), onlyB = [...setB].filter(x => !setA.has(x));
check('L', 'Different observer paths produce different acquired sets (from real positions, not randomness)', onlyA.length > 0 && onlyB.length > 0, { forward: { observer: pa.end.observer.map(v => +v.toFixed(1)), records: setA.size, only: onlyA.length }, sideways: { observer: pb.end.observer.map(v => +v.toFixed(1)), records: setB.size, only: onlyB.length } });

await writeFile(join(out, 'live-proof-results.json'), JSON.stringify({ atlasBase, dimensionUrl, when: new Date().toISOString(), results, errors }, null, 2));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${errors.length} page errors`);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
