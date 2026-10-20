import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5173/src/atlas/lab/index.html';
const output = 'docs/atlas-evidence/holographic-mission';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const captures = [], errors = [];
const seek = async (page, time) => {
  await page.getByRole('slider', { name: 'Replay simulation time' }).evaluate((node, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, String(value));
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
  await page.waitForFunction(t => document.querySelector('[data-testid="mission-experience"]')?.getAttribute('data-time') === String(t), time);
};
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => errors.push(e.message));
  const capture = async (name, title) => {
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(output, name) });
    captures.push({ name, title, viewport: page.viewportSize(), time: await page.locator('[data-testid="mission-experience"]').evaluateAll(nodes => nodes[0]?.getAttribute('data-time') ?? null) });
    console.log(`Captured ${name}`);
  };
  await page.goto(base); await capture('01-opening.png', 'Mission briefing');
  await seek(page, 3); await capture('02-discovery.png', 'Accepted observations reveal the world');
  await seek(page, 8); await capture('03-memory.png', 'Discoveries persist beyond visibility');
  await page.getByLabel('Inspect a discovery').selectOption('ISLAND 02');
  await capture('04-current-historical.png', 'Last-known position, current location unknown');
  await page.getByRole('button', { name: 'Close selected record' }).click();
  await seek(page, 12); await capture('05-fold-change.png', 'Measured fold change and earlier position');
  await seek(page, 16); await capture('06-supported-estimate.png', 'Published short-horizon estimate');
  await seek(page, 17.25); await capture('07-later-evaluation.png', 'Earlier estimate checked against a later observation');
  await seek(page, 22.25); await capture('08-motion-discrepancy.png', 'Changed movement challenges the earlier estimate');
  await seek(page, 22.5); await capture('09-withheld.png', 'Visibility lost: current motion estimate withheld');
  await seek(page, 26); await capture('10-mission-summary.png', 'What is known and what needs another observation');
  await page.getByRole('button', { name: 'Can Baymax trust the last-known portal?' }).click();
  await capture('11-portal-evidence.png', 'Further observation required');
  await page.getByRole('button', { name: 'Advanced Analysis' }).click();
  await capture('12-advanced-analysis.png', 'Original analytical tools, active replay snapshot');
  await page.goto(`${base}?experience=live`); await capture('13-live-exploration.png', 'Authorised live Lab observations');
  await page.goto(base); await seek(page, 16);
  await page.setViewportSize({ width: 1440, height: 900 }); await capture('14-laptop-1440.png', '1440 × 900 presentation');
  await page.setViewportSize({ width: 1280, height: 720 }); await capture('15-laptop-1280.png', '1280 × 720 presentation');
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await capture('16-mobile-reduced-motion.png', 'Narrow viewport and reduced motion');
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`${base}?experience=stress`); await capture('17-dense-stress.png', '128 islands and 32 folds, labelled fixture');
  await page.close();

  const sheet = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const cells = await Promise.all(captures.map(async c => `<figure><img src="data:image/png;base64,${(await readFile(join(output, c.name))).toString('base64')}"><figcaption>${c.title}</figcaption></figure>`));
  await sheet.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#100920;color:#f2eaf7;font-family:Arial}h1{font-size:30px;letter-spacing:5px;font-weight:400;margin:0 0 9px}p{color:#c677b3;font-size:13px;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}figure{margin:0;min-height:340px;background:#1a1029}img{width:100%;height:300px;object-fit:contain}figcaption{padding:12px 15px;font-size:14px}</style><h1>ATLAS / THE MEMORY OF A BROKEN WORLD</h1><p>Actual interactive application · Authored simulation replay / authorised live Lab / labelled stress fixture · ${captures.length} browser captures</p><div class="grid">${cells.join('')}</div></html>`);
  await sheet.screenshot({ path: join(output, 'contact-sheet.png'), fullPage: true }); await sheet.close();
  await writeFile(join(output, 'capture-manifest.json'), JSON.stringify({ base, captures, pageErrors: errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));

  if (!process.argv.includes('--no-video')) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } });
    const movie = await context.newPage(); await movie.goto(base); await movie.waitForTimeout(1800);
    const video = movie.video(); await movie.getByRole('button', { name: 'Begin Mission' }).click();
    console.log('Recording full 115-second interactive mission at normal speed.');
    await movie.waitForFunction(() => document.querySelector('[data-testid="mission-experience"]')?.getAttribute('data-time') === '28', { }, { timeout: 145000 });
    await movie.waitForTimeout(2500); await context.close();
    await rename(await video.path(), join(output, 'mission-full-playback.webm'));
    console.log('Recorded mission-full-playback.webm');
  }
} finally { await browser.close(); }
