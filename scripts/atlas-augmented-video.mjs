// Real-browser walkthrough recording plus interaction evidence. Usage: node scripts/atlas-augmented-video.mjs [base] [outDir]
import { chromium } from '@playwright/test';
import { mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5180/';
const out = process.argv[3] ?? 'docs/atlas-evidence/augmented-dimension-milestone1';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const size = { width: 1440, height: 810 };
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(base);
await page.waitForTimeout(5000);                                   // opening atmosphere
await page.getByRole('button', { name: 'Begin Mission' }).click();
await page.waitForTimeout(11000);                                  // discovery: pulse, reveal, push-in
// Entity inspection: click the rock just below the ISLAND 01 label.
const box = await page.locator('[data-anchor="ISLAND 01"]').boundingBox();
if (box) await page.mouse.click(box.x + 40, box.y + box.height + 70);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, '08-entity-selected.png') });
await page.keyboard.press('Escape');
// Free camera: drag to orbit, then resume the guided camera.
await page.mouse.move(700, 400); await page.mouse.down(); await page.mouse.move(520, 380, { steps: 25 }); await page.mouse.up();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '09-free-camera.png') });
await page.getByRole('button', { name: /Resume guided/ }).click();
await page.waitForTimeout(6000);
await page.screenshot({ path: join(out, '10-guided-resumed.png') });
await context.close();
const video = (await readdir(out)).find(f => f.endsWith('.webm'));
if (video) await rename(join(out, video), join(out, 'walkthrough.webm'));
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors', video ? 'video saved' : 'no video');
await browser.close();
