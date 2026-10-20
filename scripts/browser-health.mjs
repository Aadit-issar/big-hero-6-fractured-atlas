import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const health={url:process.argv[2]??'http://127.0.0.1:4174',errors:[],warnings:[],failedRequests:[]};
page.on('pageerror',e=>health.errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')health.errors.push(m.text());if(m.type()==='warning')health.warnings.push(m.text());});
page.on('requestfailed',r=>health.failedRequests.push(r.url()));
try {
  await page.goto(health.url);await page.locator('canvas').waitFor();await page.waitForTimeout(5000);
  await page.getByTestId('play-pause').click();await page.waitForTimeout(200);
  const graphics=await page.evaluate(()=>{
    const gl=document.querySelector('canvas').getContext('webgl2');
    const d=window.__FRACTURED_DIAGNOSTICS__.read();
    return {webglError:gl.getError(),contextLost:gl.isContextLost(),islands:d.renderedIslands.length,
      allIslandTransformsFinite:d.renderedIslands.every(i=>i.position.every(Number.isFinite)),activeConnections:d.connections.filter(c=>c.open).length,
      time:d.time,referenceStatus:d.referenceStatus,performance:window.__FRACTURED_DIAGNOSTICS__.readPerformance()};
  });
  const report={...health,...graphics};writeFileSync('docs/evidence/browser-health.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(health.errors.length||health.failedRequests.length||graphics.webglError||graphics.contextLost||!graphics.allIslandTransformsFinite)throw new Error('Browser health check failed.');
}finally{await browser.close();}
