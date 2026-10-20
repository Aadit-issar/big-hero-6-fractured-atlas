import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
const base = process.argv[2] ?? 'http://127.0.0.1:5173/src/atlas/lab/index.html';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = { environment: { cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryGiB: os.totalmem() / 2 ** 30, freeMemoryGiB: os.freemem() / 2 ** 30, browser: browser.version(), headless: true }, measurements: [] };
try {
  const page = await browser.newPage(); const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const seek = async t => page.getByRole('slider', { name: 'Replay simulation time' }).evaluate((node, time) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,String(time)); node.dispatchEvent(new Event('input',{bubbles:true})); },t);
  const sample = async (name, url, width, height, active = false) => {
    await page.setViewportSize({width,height}); await page.goto(url);
    if (name.startsWith('mission')) { await seek(16); if (active) await page.getByRole('button', {name:'Resume mission'}).click(); }
    await page.waitForTimeout(2200);
    const frames = await page.evaluate(() => new Promise(resolve => {
      const durations=[]; let last=performance.now(), start=last;
      function tick(now) { durations.push(now-last);last=now;if(now-start<8000)requestAnimationFrame(tick);else {durations.shift();durations.sort((a,b)=>a-b);const q=p=>durations[Math.floor((durations.length-1)*p)];const gl=document.querySelector('canvas')?.getContext('webgl2');const ext=gl?.getExtension('WEBGL_debug_renderer_info'); resolve({frames:durations.length, averageFps:1000/(durations.reduce((a,b)=>a+b,0)/durations.length),medianFrameMs:q(.5),p95FrameMs:q(.95),p99FrameMs:q(.99),gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unavailable',render:JSON.parse(document.querySelector('canvas')?.dataset.renderMetrics ?? '{}')});} } requestAnimationFrame(tick);
    }));
    const metrics = await cdp.send('Performance.getMetrics');
    output.measurements.push({name,width,height,active,...frames, heapUsedMiB:metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value/2**20});
    console.log(JSON.stringify(output.measurements.at(-1)));
  };
  await sample('mission-playing-1080',base,1920,1080,true);
  await sample('mission-paused-900',base,1440,900);
  await sample('live-900',`${base}?experience=live`,1440,900);
  await sample('stress-900',`${base}?experience=stress`,1440,900);
  await page.goto(base); await seek(28); await page.waitForTimeout(1000);
  const memory = async () => { await cdp.send('HeapProfiler.collectGarbage'); return { heap: (await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize')?.value / 2**20, render: JSON.parse(await page.locator('canvas').getAttribute('data-render-metrics') ?? '{}') }; };
  const before = await memory(); const cycles=[];
  for(let i=0;i<10;i++){ await seek(0); await seek(28); await page.waitForTimeout(200); if(i===4||i===9) { await page.waitForTimeout(1100); cycles.push({cycle:i+1,...await memory()}); } }
  output.replayMemory = {before,cycles};
  await mkdir('docs/atlas-evidence/holographic-mission',{recursive:true});
  await writeFile('docs/atlas-evidence/holographic-mission/performance.json',JSON.stringify(output,null,2));
} finally { await browser.close(); }
