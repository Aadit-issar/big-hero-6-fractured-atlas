import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Captures the opening view and a forward-flight close-up of whatever build is served.
// Phase 3 builds are captured after terrain, textures and sky report ready.
const url=process.argv[2]??'http://127.0.0.1:4173';
const out=process.argv[3]??'docs/evidence/phase3/before';
mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  await page.goto(url);await page.locator('canvas').waitFor();
  await page.waitForFunction(()=>{const m=document.querySelector('main');return !m||!m.hasAttribute('data-render-ready')||m.getAttribute('data-render-ready')==='true';},null,{timeout:90_000});
  await page.waitForTimeout(2500);
  await page.getByTestId('play-pause').click();await page.waitForTimeout(300);
  await page.screenshot({path:`${out}/opening-view.png`});
  await page.locator('canvas').click({position:{x:700,y:430}});
  await page.mouse.move(700,430);await page.mouse.down();await page.mouse.move(700,560,{steps:6});await page.mouse.up();
  await page.keyboard.down('w');await page.waitForTimeout(900);await page.keyboard.up('w');await page.waitForTimeout(300);
  await page.screenshot({path:`${out}/island-closeup.png`});
} finally {await browser.close();}
