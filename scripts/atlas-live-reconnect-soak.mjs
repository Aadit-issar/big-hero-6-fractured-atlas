// Repeated disconnect / reconnect of the live link: no listener growth, no duplicate records, no duplicate ingestion.
// Usage: node scripts/atlas-live-reconnect-soak.mjs [atlasBase] [dimensionUrl] [cycles] [out.json]
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const atlasBase = process.argv[2] ?? 'http://127.0.0.1:5184/', dimensionUrl = process.argv[3] ?? 'http://127.0.0.1:4173/?quality=performance', cycles = Number(process.argv[4] ?? 8), out = process.argv[5] ?? 'docs/atlas-evidence/atlas-final-release/reconnect-soak.json';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const atlas = await context.newPage();
await atlas.goto(`${atlasBase}?experience=live&dimension=${encodeURIComponent(dimensionUrl)}&light=1`);
const [dim] = await Promise.all([atlas.waitForEvent('popup'), atlas.getByRole('button', { name: /Open Dimension & connect/ }).click()]);
await atlas.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120000 });
await dim.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120000 });
const cdp = await atlas.context().newCDPSession(atlas);
const listeners = async () => {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  return listeners.filter(l => l.type === 'message').length;
};
const state = () => atlas.evaluate(() => { window.gc?.(); const s = window.__ATLAS_LIVE__.snapshot(); const ids = s.scene.records.map(r => r.id); return { status: s.link.status, session: s.link.session, episode: s.link.episode, records: ids.length, unique: new Set(ids).size, heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), accepted: s.link.counters.accepted, duplicates: s.link.counters.duplicate }; });
await atlas.waitForTimeout(4000);
const series = [{ cycle: 0, messageListeners: await listeners(), ...(await state()) }];
for (let i = 1; i <= cycles; i += 1) {
  await atlas.getByRole('button', { name: 'Disconnect' }).click();
  await atlas.waitForTimeout(600);
  await atlas.getByRole('button', { name: 'Reconnect' }).click();
  await atlas.waitForFunction(() => window.__ATLAS_LIVE__.snapshot().link.status === 'connected', null, { timeout: 60000 });
  await atlas.waitForTimeout(1500);
  const row = { cycle: i, messageListeners: await listeners(), ...(await state()) }; series.push(row); console.log(JSON.stringify(row));
}
const verdict = { listenersStable: series.every(s => s.messageListeners === series[0].messageListeners), noDuplicateRecords: series.every(s => s.records === s.unique), sameSessionKept: new Set(series.map(s => s.session)).size === 1 && new Set(series.map(s => s.episode)).size === 1, heapGrowthMB: +(series.at(-1).heapMB - series[1].heapMB).toFixed(1) };
await writeFile(out, JSON.stringify({ cycles, series, verdict }, null, 2));
console.log('verdict', JSON.stringify(verdict));
await browser.close();
