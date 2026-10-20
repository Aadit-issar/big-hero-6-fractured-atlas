import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Real application captures: waits for terrain/materials/sky, then frames
// rendering-only viewpoints (keys 1–5). Usage:
// node scripts/capture-views.mjs <url> <outDir> <quality> <width> <height> [hud=0|1] [views=0,1,2,3,4,5] [wait=seconds]
const [url='http://127.0.0.1:4173', out='test-results/views', quality='balanced', width='1440', height='900', hud='1', views='0', wait='2.5']=process.argv.slice(2);
mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=d3d11','--enable-gpu-rasterization','--ignore-gpu-blocklist']});
try {
  const page=await browser.newPage({viewport:{width:Number(width),height:Number(height)},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errors.push(m.text());});
  await page.goto(`${url}/?quality=${quality}&hud=${hud}`);
  await page.waitForSelector('[data-render-ready="true"]',{timeout:90_000});
  await page.waitForTimeout(Number(wait)*1000);
  for(const view of views.split(',')) {
    if(view!=='0'){await page.keyboard.press(`Digit${view}`);await page.waitForTimeout(900);}
    await page.screenshot({path:`${out}/view-${view}-${quality}.png`});
  }
  if(errors.length)console.log('console:',errors.join('\n'));
} finally {await browser.close();}
