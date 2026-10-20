// The other way round: the Dimension is running first, the player presses L, and ATLAS opens linked to THAT running session.
// Usage: node scripts/live-opener-check.mjs [dimensionUrlWithAtlasParam]
import { chromium } from '@playwright/test';
const url = process.argv[2] ?? 'http://127.0.0.1:4183/?quality=performance&view=baymax&atlas=http://127.0.0.1:5184/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
const dimension = await context.newPage();
await dimension.goto(url);
await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
const dimSession = await dimension.evaluate(() => document.querySelector('[data-testid="world-scene"]') ? 'running' : 'missing');
const [atlas] = await Promise.all([context.waitForEvent('page'), dimension.keyboard.press('KeyL')]);
await atlas.waitForFunction(() => window.__ATLAS_COMMAND__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
const s = await atlas.evaluate(() => { const x = window.__ATLAS_COMMAND__.snapshot(); return { status: x.link.status, episode: x.episode, entities: x.entities.length, sim: x.simTime }; });
console.log(JSON.stringify({ dimension: dimSession, atlas: s, pass: s.status === 'connected' && s.entities > 5 }));
await browser.close();
process.exit(s.status === 'connected' ? 0 : 1);
