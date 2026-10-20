// Baymax close-ups from the real running app: idle, thrust while moving, scan pose. Usage: node scripts/atlas-baymax-capture.mjs [base] [outDir]
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const base = process.argv[2] ?? 'http://127.0.0.1:5180/';
const out = process.argv[3] ?? 'docs/atlas-evidence/live-intelligence-final';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${base}?at=4.5&select=baymax-observer`);
await page.waitForTimeout(7000);
await page.screenshot({ path: join(out, 'baymax-01-idle-closeup.png') });
await page.getByRole('button', { name: 'Play mission' }).click();
for (let i = 0; i < 6; i += 1) { await page.waitForTimeout(1800); await page.screenshot({ path: join(out, `baymax-0${i + 2}-motion-${i}.png`) }); }
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
