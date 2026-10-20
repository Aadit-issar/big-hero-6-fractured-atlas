// Polls read().render during start-up and prints each readiness change: [seconds, terrainReady, texturesReady, skyReady, skyBakeMs].
import { chromium } from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const t0=Date.now();const marks=[];
await page.goto(process.argv[2]);
for(let i=0;i<200;i++){const r=await page.evaluate(()=>window.__FRACTURED_DIAGNOSTICS__?.read().render);if(r)marks.push([(Date.now()-t0)/1000,r.terrainReady,r.texturesReady,r.skyReady,Math.round(r.skyMilliseconds)]);if(r&&r.terrainReady===14&&r.texturesReady&&r.skyReady)break;await page.waitForTimeout(250);}
const uniq=marks.filter((m,i)=>i===0||JSON.stringify(m.slice(1))!==JSON.stringify(marks[i-1].slice(1)));console.log(JSON.stringify(uniq));
console.log(await page.evaluate(()=>navigator.hardwareConcurrency));
await browser.close();
