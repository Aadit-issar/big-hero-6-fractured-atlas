// Real two-window walkthrough: the Dimension (integration build) and ATLAS linked to it, recorded side by side.
// The ATLAS window is opened from the Dimension with the L key, exactly as in the judge runbook.
// Usage: node scripts/atlas-live-walkthrough.mjs [atlasUrl] [dimensionUrl] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const atlasUrl = process.argv[2] ?? 'http://127.0.0.1:5180/?experience=live';
const dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/';
const out = process.argv[4] ?? 'docs/atlas-evidence/live-intelligence-final';
const tmp = join(out, '_videos');
await mkdir(tmp, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const size = { width: 1280, height: 720 };
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size } });
const steps = [], errors = [];
const t0 = Date.now();
const mark = (name, extra = {}) => { steps.push({ atMs: Date.now() - t0, name, ...extra }); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`); };

const dimension = await context.newPage();
dimension.on('pageerror', e => errors.push(`dimension: ${e.message}`));
const dimensionCreatedAt = Date.now() - t0;
const dimensionTarget = new URL(dimensionUrl); dimensionTarget.searchParams.set("atlas", atlasUrl);
await dimension.goto(dimensionTarget.toString());
await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
await dimension.waitForTimeout(4000);
mark('dimension running');

// Judge flow: press L inside the Dimension; ATLAS opens linked to this very session.
const [atlas] = await Promise.all([dimension.waitForEvent('popup'), dimension.keyboard.press('KeyL')]);
const atlasCreatedAt = Date.now() - t0;
atlas.on('pageerror', e => errors.push(`atlas: ${e.message}`));
await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
mark('atlas connected to dimension session', await atlas.evaluate(() => ({ session: window.__ATLAS_LIVE__.snapshot().link.session })));
await atlas.evaluate(() => { window.__frames = []; let last = performance.now(); const loop = now => { window.__frames.push(now - last); last = now; requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
await atlas.waitForTimeout(5000);

const fly = async (keys, ms) => { await dimension.bringToFront(); for (const k of keys) await dimension.keyboard.down(k); await dimension.waitForTimeout(ms); for (const k of [...keys].reverse()) await dimension.keyboard.up(k); };
mark('fly forward (real explorer)'); await fly(['KeyW', 'ShiftLeft'], 2200); await atlas.waitForTimeout(3500);
mark('scan now (user-requested)'); await atlas.evaluate(() => window.__ATLAS_LIVE__.requestScan()); await atlas.waitForTimeout(4000);
mark('fly further: earlier objects leave range and are remembered'); await fly(['KeyW', 'ShiftLeft'], 3200); await atlas.waitForTimeout(4500);
const cluster = await atlas.locator('[data-anchor^="cluster-"][data-show="1"]').first().boundingBox();
if (cluster) { mark('inspect a debris cluster'); await atlas.mouse.click(cluster.x + 30, cluster.y + cluster.height + 40); await atlas.waitForTimeout(4500); }
mark('navigation: choose a destination; ATLAS builds a graph from recorded knowledge only');
await atlas.getByTestId('navigation-toggle').click(); await atlas.waitForTimeout(1500);
const goal = await atlas.evaluate(() => { const g = window.__ATLAS_LIVE__.snapshot().navigation.advice.goals; return (g.find(x => x.id.startsWith('cluster-capsule')) ?? g.find(x => x.kind === 'island') ?? g[0]).id; });
await atlas.getByLabel('Navigation destination').selectOption(goal); await atlas.waitForTimeout(3500);
await atlas.getByRole('button', { name: 'Why?' }).click(); await atlas.waitForTimeout(3500);
await atlas.getByRole('button', { name: 'Hide evidence' }).click();
mark('the same guidance inside the Dimension (N): bearing arrow, distance, limitation');
await dimension.bringToFront(); await dimension.keyboard.press('KeyN'); await dimension.waitForTimeout(3500);
mark('move the real observer: guidance updates in both windows'); await fly(['KeyD', 'ShiftLeft'], 2200); await dimension.waitForTimeout(3500);
mark('ask for the next observation'); await atlas.getByRole('button', { name: 'Recommend next observation' }).click(); await atlas.waitForTimeout(3500);
mark('return toward the start: records refreshed, not duplicated'); await fly(['KeyS', 'ShiftLeft'], 5200); await atlas.waitForTimeout(4500);
mark('close the Dimension: ATLAS must report disconnection'); const dimensionClosedAt = Date.now() - t0; await dimension.close();
await atlas.waitForFunction(() => window.__ATLAS_LIVE__.snapshot().link.status === 'disconnected', null, { timeout: 30000 });
await atlas.waitForTimeout(3500);
const frames = await atlas.evaluate(() => { const d = window.__frames.slice(10).sort((a, b) => a - b); const q = p => d[Math.min(d.length - 1, Math.floor(d.length * p))]; return { frames: d.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: d.at(-1), over33: d.filter(x => x > 33.4).length }; });
steps.push({ name: 'atlas frame pacing during the live session (ATLAS window, recording active)', ...frames });
console.log('frame pacing', JSON.stringify(frames));
mark('done', await atlas.evaluate(() => { const s = window.__ATLAS_LIVE__.snapshot(); return { status: s.link.status, records: s.scene.records.length, remembered: s.scene.records.filter(r => !r.currentlyObserved).length }; }));
const atlasClosedAt = Date.now() - t0;
await context.close();

const videos = (await readdir(tmp)).filter(f => f.endsWith('.webm'));
// Playwright names videos randomly; identify by creation order (the Dimension page was created first).
const stat = await Promise.all(videos.map(async f => ({ f, t: (await import('node:fs/promises')).stat(join(tmp, f)).then(s => s.birthtimeMs) })));
const resolved = await Promise.all(stat.map(async s => ({ f: s.f, t: await s.t })));
resolved.sort((a, b) => a.t - b.t);
const [dimVideo, atlasVideo] = resolved.map(r => join(tmp, r.f));
// Playwright starts each clip at the page's first paint, not at its creation, so align the clips by their END times (the Dimension page closes at dimensionClosedAt, the ATLAS page at atlasClosedAt).
const duration = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const dimStart = dimensionClosedAt / 1000 - duration(dimVideo), atlasStart = atlasClosedAt / 1000 - duration(atlasVideo);
const offset = (atlasStart - dimStart).toFixed(2);
const final = join(out, 'live-walkthrough-side-by-side.mp4');
execFileSync('ffmpeg', ['-y', '-i', dimVideo, '-i', atlasVideo,
  '-filter_complex', `[0:v]scale=960:540,setpts=PTS-STARTPTS[a];[1:v]scale=960:540,setpts=PTS-STARTPTS+${offset}/TB[b];[a][b]hstack=inputs=2:shortest=0,format=yuv420p[v]`, '-map', '[v]', '-c:v', 'libx264', '-crf', '24', '-preset', 'fast', final], { stdio: 'ignore' });
await rename(dimVideo, join(out, 'live-walkthrough-dimension.webm'));
await rename(atlasVideo, join(out, 'live-walkthrough-atlas.webm'));
await writeFile(join(out, 'live-walkthrough-steps.json'), JSON.stringify({ atlasUrl, dimensionUrl, offsetSeconds: Number(offset), steps, errors }, null, 2));
console.log(errors.length ? `errors: ${errors.join('\n')}` : 'no page errors', '->', final);
await browser.close();
