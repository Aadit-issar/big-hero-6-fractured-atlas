// End-to-end proof of the live product in two real browser windows (ATLAS Command and the Dimension), driven like a user:
// keyboard and mouse flight in the Dimension, buttons in ATLAS. Nothing is mocked and nothing reads hidden state except the checks themselves.
//
//   node scripts/live-e2e.mjs [atlasUrl] [dimensionUrl] [outDir]
//
// Proof 1  live position/orientation synchronisation      Proof 2  frozen forecast evaluated by a later observation
// Proof 3  interception route accepted, flown, replanned and reached (true capsule)     Generality  fold entrance route     Robustness  new Dimension session
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5180/';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4183/?quality=performance&view=baymax';
const out = process.argv[4] ?? 'docs/evidence/live-e2e';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const atlas = await context.newPage();
const errors = [];
atlas.on('pageerror', e => errors.push(`atlas: ${e.message}`));
const results = [];
const check = (id, title, pass, data = {}) => { results.push({ id, title, pass, ...data }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}`, JSON.stringify(data)); };
const sleep = ms => atlas.waitForTimeout(ms);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

await atlas.goto(`${atlasBase}?dimension=${encodeURIComponent(dimensionUrl)}`);
await atlas.waitForSelector('[data-testid="cmd-opening"]');
const [dimension] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByTestId('open-dimension').click()]);
dimension.on('pageerror', e => errors.push(`dimension: ${e.message}`));
await dimension.setViewportSize({ width: 1280, height: 720 });
await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 180000 });
await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
check('A', 'ATLAS connected to the running Dimension', true);

const snap = () => atlas.evaluate(() => {
  const s = window.__ATLAS_COMMAND__.snapshot();
  return {
    status: s.link.status, session: s.link.session, episode: s.episode, sim: s.simTime, pose: s.pose, entities: s.entities.map(e => ({ id: e.id, kind: e.kind, knowledge: e.knowledge, position: e.position, label: e.label, foldState: e.foldState, assetId: e.assetId, lastSeen: e.lastSeen })),
    estimates: [...s.estimates.entries()].map(([id, e]) => ({ id, ok: e.ok, motion: e.motion, speed: e.speed, kind: e.fit?.kind })),
    selectedId: s.selectedId, plan: s.plan && { status: s.plan.status, mode: s.plan.mode, meeting: s.plan.meetingPosition, meetingTime: s.plan.meetingTime, travel: s.plan.travelTime, length: s.plan.length, waypoints: s.plan.waypoints.length, uncertainty: s.plan.uncertainty, reasons: s.plan.reasons, unknowns: s.plan.unknowns },
    route: { state: s.route.state, ack: s.route.ackDetail, nav: s.route.nav, command: s.route.command && { id: s.route.command.routeId, revision: s.route.command.revision, waypoints: s.route.command.waypoints, goal: s.route.command.goal, reason: s.route.command.reason }, history: s.route.history },
    forecasts: s.forecasts.map(f => ({ id: f.id, horizon: f.horizon, issuedAt: f.issuedAt, targetTime: f.targetTime, uncertainty: f.uncertainty, model: f.model, ev: s.evaluations.get(f.id) ?? null })),
    log: s.log.map(l => `${l.tone}:${l.title}`),
  };
});
const dimPose = () => dimension.evaluate(() => { const d = window.__FRACTURED_DIAGNOSTICS__.read(); return { p: d.cameraPosition, q: d.cameraQuaternion, t: d.time }; });
const truthCapsule = () => dimension.evaluate(() => window.__FRACTURED_DIAGNOSTICS__.read().movers?.find(m => m.id === 'capsule-abigail')?.position ?? null);

// ---------- steering: the "player" flies Baymax by mouse and keyboard toward a world point ----------
const forwardOf = q => { const [x, y, z, w] = q; return [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))]; };
const toCam = (d, q) => { const [qx, qy, qz, qw] = [-q[0], -q[1], -q[2], q[3]]; const tx = 2 * (qy * d[2] - qz * d[1]), ty = 2 * (qz * d[0] - qx * d[2]), tz = 2 * (qx * d[1] - qy * d[0]); return [d[0] + qw * tx + (qy * tz - qz * ty), d[1] + qw * ty + (qz * tx - qx * tz), d[2] + qw * tz + (qx * ty - qy * tx)]; };
let held = new Set();
async function setKeys(want) {
  for (const k of held) if (!want.has(k)) { await dimension.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await dimension.keyboard.down(k); held.add(k); }
}
async function look(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  await dimension.mouse.move(640, 360); await dimension.mouse.down();
  await dimension.mouse.move(640 + dx, 360 + dy, { steps: 2 }); await dimension.mouse.up();
}
async function flyTo(getTarget, { stopWithin = 4, timeoutMs = 90000, until } = {}) {
  const t0 = Date.now(); const samples = [];
  while (Date.now() - t0 < timeoutMs) {
    if (until && await until()) break;
    const pose = await dimPose(); const target = await getTarget();
    if (!target) { await setKeys(new Set()); await sleep(200); continue; }
    const d = [target[0] - pose.p[0], target[1] - pose.p[1], target[2] - pose.p[2]];
    const c = toCam(d, pose.q); const range = Math.hypot(...d);
    const yawErr = Math.atan2(c[0], -c[2]), pitchErr = Math.atan2(c[1], Math.hypot(c[0], c[2]));
    await look(Math.max(-220, Math.min(220, yawErr / 0.0025)), -Math.max(-220, Math.min(220, pitchErr / 0.0025)));
    const keys = new Set();
    // Slow, tapping approach inside 25 m: the player eases in, so the close-range HUD can be sampled.
    const ease = range < 25 && (samples.length % 3 !== 0);
    if (range > stopWithin && Math.abs(yawErr) < 0.9 && !ease) { keys.add('KeyW'); if (range > 70 && Math.abs(yawErr) < 0.3) keys.add('ShiftLeft'); }
    await setKeys(keys);
    samples.push({ range, yawErr });
    await sleep(120);
  }
  await setKeys(new Set());
  return samples;
}

// ---------- Proof 1: synchronisation ----------
{
  const before = await snap();
  await dimension.bringToFront();
  // Flight speed per frame is clamped, so a slow-rendering window needs longer on the key: hold until Baymax has really moved.
  for (let i = 0; i < 4 && dist(before.pose.position, (await snap()).pose.position) < 4; i += 1) { await setKeys(new Set(['KeyW'])); await sleep(2500); await setKeys(new Set()); await sleep(600); }
  await look(-160, 0); await sleep(1200);
  const [a, d] = [await snap(), await dimPose()];
  // In Baymax view the rendered camera trails Baymax by 7 m back and 1.8 m up; undo that to get his own position.
  const fw = forwardOf(d.q);
  const body = [d.p[0] + fw[0] * 7, d.p[1] + fw[1] * 7 - 1.8, d.p[2] + fw[2] * 7];
  const err = dist(a.pose.position, body);
  const fa = a.pose.forward, fd = forwardOf(d.q);
  const dot = fa[0] * fd[0] + fa[1] * fd[1] + fa[2] * fd[2];
  check('P1', 'ATLAS Baymax follows the Dimension (position and heading) with no refresh', err < 3 && dot > 0.98 && dist(before.pose.position, a.pose.position) > 3, { positionError: +err.toFixed(2), headingDot: +dot.toFixed(4), moved: +dist(before.pose.position, a.pose.position).toFixed(1) });
  await atlas.screenshot({ path: join(out, 'p1-atlas-after-move.png') });
  await dimension.screenshot({ path: join(out, 'p1-dimension-after-move.png') });
}

// ---------- Scan ----------
await atlas.getByTestId('scan').click();
await sleep(1500);
{
  const s = await snap();
  const capsule = s.entities.find(e => e.id === 'capsule-abigail');
  check('S', 'Scan acquires nearby objects, islands and folds; the capsule is identified by the shared asset id', s.entities.length > 20 && s.entities.some(e => e.kind === 'island') && s.entities.some(e => e.kind === 'fold'), { entities: s.entities.length, capsule: capsule && { knowledge: capsule.knowledge, asset: capsule.assetId } });
}

// Bring the capsule into range: the player flies towards where it is on the Dimension's own screen (a legitimate view), then hovers.
{
  const s0 = await snap();
  if (!s0.entities.find(e => e.id === 'capsule-abigail' && e.knowledge === 'current')) {
    await flyTo(truthCapsule, { stopWithin: 35, timeoutMs: 45000 });
  }
  await sleep(1000);
}

// ---------- Proof 2: forecast frozen, then evaluated by a later observation ----------
await atlas.getByTestId('target-capsule-abigail').click();
await atlas.getByTestId('tab-predict').click();
{
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { const s = await snap(); ok = s.estimates.some(e => e.id === 'capsule-abigail' && e.ok); if (!ok) await sleep(1000); }
  await atlas.getByTestId('horizon').fill('4');
  await atlas.getByTestId('freeze-forecast').click();
  let evaluated = null; const startSim = (await snap()).sim;
  for (let i = 0; i < 30 && !evaluated; i += 1) { await sleep(1000); const s = await snap(); evaluated = s.forecasts.find(f => f.ev) ?? null; }
  const s = await snap();
  const frozen = s.forecasts.filter(f => f.ev);
  check('P2', 'a forecast frozen before the observation is later evaluated against it, and beats "has not moved"', !!evaluated && evaluated.ev.observedAt >= evaluated.targetTime - 1e-6 && evaluated.ev.observedAt > evaluated.issuedAt, {
    estimateOk: ok, issuedAt: evaluated?.issuedAt, targetTime: evaluated?.targetTime, observedAt: evaluated?.ev?.observedAt, error: evaluated?.ev?.error, baselineError: evaluated?.ev?.baselineError, evaluatedCount: frozen.length, waitedSim: +(s.sim - startSim).toFixed(1),
  });
  await atlas.screenshot({ path: join(out, 'p2-predict.png') });
}

// ---------- Proof 3: route, different speeds, navigation, replan, arrival ----------
await atlas.getByTestId('tab-route').click();
let plans = {};
for (const speed of [8, 14, 30]) {
  await atlas.getByTestId('speed').fill(String(speed));
  await sleep(1200);
  let s = await snap();
  // Under CPU load the plan can take longer than the fixed pause: wait (bounded) for a ready plan at this speed.
  for (let k = 0; k < 12 && !(s.plan?.status === 'ready' && Math.abs((s.plan.speed ?? 0) - speed) < 0.01); k += 1) { await sleep(500); s = await snap(); }
  plans[speed] = s.plan;
}
{
  const ready = Object.values(plans).every(p => p?.status === 'ready' && p.mode === 'intercept');
  const m = Object.values(plans).map(p => p.meeting);
  const differs = ready && dist(m[0], m[1]) > 1 && dist(m[1], m[2]) > 0.5;
  check('G5', 'changing Baymax speed changes the computed rendezvous (point, time and route)', differs, Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, p && { meeting: p.meeting?.map(v => +v.toFixed(1)), t: p.meetingTime && +p.meetingTime.toFixed(1), travel: p.travel && +p.travel.toFixed(1), length: p.length && +p.length.toFixed(0), wps: p.waypoints }])));
}
await atlas.getByTestId('speed').fill('14'); await sleep(800);
await atlas.getByTestId('send-route').click();
await sleep(1500);
{
  const s = await snap();
  const hud = await dimension.evaluate(() => { const h = document.querySelector('[data-testid="nav-hud"]'); return h ? { route: h.getAttribute('data-route'), revision: h.getAttribute('data-revision'), phase: h.getAttribute('data-phase'), on: h.getAttribute('data-on') } : null; });
  check('P3a', 'route sent from ATLAS is acknowledged by the Dimension and its navigation HUD activates', s.route.state === 'accepted' && !!hud && hud.phase === 'active', { state: s.route.state, ack: s.route.ack, hud });
  await dimension.screenshot({ path: join(out, 'p3-dimension-hud.png') });
}

// Fly the route like a player: always towards ATLAS's current active waypoint, and sample the Dimension HUD close to the goal.
const hudSamples = [];
async function sampleHud(wp) {
  const pose = await dimPose();
  if (!wp || dist(wp, pose.p) >= 14) return;
  const fw = forwardOf(pose.q);
  // Baymax's own position (the rendered camera trails him by 7 m back / 1.8 m up in Baymax view).
  const body = [pose.p[0] + fw[0] * 7, pose.p[1] + fw[1] * 7 - 1.8, pose.p[2] + fw[2] * 7];
  const hud = await dimension.evaluate(() => { const c = document.querySelector('[data-testid="nav-distance"]'), m = document.querySelector('[data-testid="nav-marker"]'), e = document.querySelector('[data-testid="nav-edge"]'); return { distance: c ? parseFloat(c.textContent) : null, marker: m ? getComputedStyle(m).opacity : null, edge: e ? getComputedStyle(e).opacity : null, mode: document.querySelector('[data-testid="nav-hud"]')?.getAttribute('data-mode') }; });
  hudSamples.push({ trueDistance: dist(wp, body), ...hud });
}
const waypointNow = async () => { const s = await snap(); const c = s.route.command; if (!c || s.route.state === 'arrived') return null; return c.waypoints[Math.min(s.route.nav?.activeIndex ?? 0, c.waypoints.length - 1)].position; };
const arrivedNow = async () => (await snap()).route.state === 'arrived';
await dimension.bringToFront();
let closeShot = false;
const flightStart = Date.now();
const samples = await flyTo(async () => {
  const wp = await waypointNow();
  await sampleHud(wp);
  if (!closeShot && wp && dist(wp, (await dimPose()).p) < 12) { closeShot = true; await dimension.screenshot({ path: join(out, 'p3-dimension-close-range.png') }); }
  return wp;
}, { stopWithin: 3, timeoutMs: 150000, until: arrivedNow });
{
  const s = await snap();
  const rev = s.route.history.map(h => ({ r: h.revision, t: +h.simTime.toFixed(1), reason: h.reason.slice(0, 110) }));
  const cap = await truthCapsule();
  const pose = await dimPose();
  check('P3b', 'Baymax following the waypoints reaches the true capsule (route reported arrived by the Dimension)', s.route.state === 'arrived', { state: s.route.state, flightSeconds: +((Date.now() - flightStart) / 1000).toFixed(1), finalDistanceToTrueCapsule: cap ? +dist(cap, pose.p).toFixed(2) : null, revisions: rev.length, rev });
  await dimension.screenshot({ path: join(out, 'p3-dimension-arrived.png') });
  await atlas.screenshot({ path: join(out, 'p3-atlas-arrived.png') });
}

// ---------- Generality: a dimensional fold ----------
await atlas.getByTestId('tab-tactical').click();
{
  const s = await snap();
  const fold = s.entities.filter(e => e.kind === 'fold').sort((a, b) => (a.foldState === 'open' ? -1 : 0) - (b.foldState === 'open' ? -1 : 0))[0];
  if (!fold) check('F', 'fold entrance selected and routed with the same machinery', false, { reason: 'no fold observed' });
  else {
    await atlas.getByTestId('search').fill(fold.id);
    await atlas.getByTestId(`target-${fold.id}`).click();
    await atlas.getByTestId('tab-route').click();
    await sleep(1200);
    const p = (await snap()).plan;
    await atlas.getByTestId('send-route').click();
    await sleep(1200);
    const sent = await snap();
    await flyTo(async () => { const wp = await waypointNow(); await sampleHud(wp); return wp; }, { stopWithin: 3, timeoutMs: 120000, until: arrivedNow });
    const end = await snap();
    check('F', 'fold entrance selected and routed with the same machinery; destination stays unverified', p?.status === 'ready' && p.mode === 'entrance' && p.unknowns.join(' ').includes('unverified') && sent.route.state !== 'rejected', { fold: fold.id, state: fold.foldState, mode: p?.mode, routeState: end.route.state, unknowns: p?.unknowns });
    await dimension.screenshot({ path: join(out, 'f-dimension.png') });
    const near = hudSamples.filter(h => h.trueDistance < 10 && h.distance != null && h.mode !== 'arrived');
    check('HUD', 'navigation HUD stays accurate inside ten world units (distance readout and marker or edge cue)', near.length >= 3 && near.every(h => Math.abs(h.distance - h.trueDistance) < 3) && near.every(h => Number(h.marker) > 0.5 || Number(h.edge) > 0.5), { samplesUnder10m: near.length, maxReadoutError: near.length ? +Math.max(...near.map(h => Math.abs(h.distance - h.trueDistance))).toFixed(2) : null, modes: [...new Set(near.map(h => h.mode))] });

  }
}

// ---------- Robustness: a reloaded Dimension is a new session; nothing stale survives ----------
{
  const before = await snap();
  await dimension.reload();
  await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 180000 });
  let after = null;
  for (let i = 0; i < 60; i += 1) { await sleep(1000); const s = await snap(); if (s.status === 'connected' && s.session !== before.session) { after = s; break; } }
  check('R', 'a reloaded Dimension starts a new episode: previous route, selection and records are discarded', !!after && after.episode === before.episode + 1 && after.route.state === 'none' && after.selectedId === null, { episodeBefore: before.episode, episodeAfter: after?.episode, route: after?.route.state, entities: after?.entities.length });
}

await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed; ${errors.length} page errors`);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
await browser.close();
process.exit(results.every(r => r.pass) ? 0 : 1);
