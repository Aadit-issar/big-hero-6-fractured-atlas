import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const url=process.argv[2]??'http://127.0.0.1:4173';
const output=process.argv[3]??'test-results/phase2-performance.json';
const measurementSeconds=Number(process.argv[4]??8);
const query=process.argv[5]??'';
if(!Number.isFinite(measurementSeconds)||measurementSeconds<1||measurementSeconds>120)throw new RangeError('Measurement duration must be 1–120 seconds.');
const browser=await chromium.launch({channel:'chrome',headless:true});
const [width,height]=(process.argv[6]??'1440x900').split('x').map(Number);
const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
  const metrics={record:false,frames:[],calls:[],triangles:[],draws:0,tris:0,last:0};
  window.__graphicsBenchmark=metrics;
  for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
    const original=WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name]=function(...args){
      metrics.draws++;
      const count=name.startsWith('drawArrays')?args[2]:args[1];
      const instances=name.endsWith('Instanced')?args[args.length-1]:1;
      if(args[0]===4)metrics.tris+=count/3*instances;
      return original.apply(this,args);
    };
  }
  const frame=(time)=>{
    if(metrics.record&&metrics.last){metrics.frames.push(time-metrics.last);metrics.calls.push(metrics.draws);metrics.triangles.push(metrics.tris);}
    metrics.last=time;metrics.draws=0;metrics.tris=0;requestAnimationFrame(frame);
  };requestAnimationFrame(frame);
});
try {
  const loadStart=Date.now();
  await page.goto(url+query);await page.locator('canvas').waitFor();
  // Phase 3 exposes data-render-ready once terrain, textures and sky are loaded; Phase 2 has no attribute.
  await page.waitForFunction(()=>{const m=document.querySelector('main');return !m||!m.hasAttribute('data-render-ready')||m.getAttribute('data-render-ready')==='true';},null,{timeout:90_000});
  const loadSeconds=(Date.now()-loadStart)/1000;
  await page.waitForTimeout(2000);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBeforeGc=(await cdp.send('Runtime.getHeapUsage')).usedSize;
  const heapBefore=await page.evaluate(()=>performance.memory?.usedJSHeapSize??null);
  await page.evaluate(()=>{window.__graphicsBenchmark.record=true;});
  const memorySamples=[];
  for(let elapsed=0;elapsed<measurementSeconds;elapsed+=2) {
    await page.waitForTimeout(Math.min(2,measurementSeconds-elapsed)*1000);
    memorySamples.push(await page.evaluate(()=>({time:window.__FRACTURED_DIAGNOSTICS__?.read().time,
      heap:performance.memory?.usedJSHeapSize??null,geometries:window.__FRACTURED_DIAGNOSTICS__?.readPerformance().geometries})));
  }
  const result=await page.evaluate(()=>{
    const b=window.__graphicsBenchmark;b.record=false;
    const sorted=[...b.frames].sort((a,b)=>a-b);const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
    const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {frames:b.frames.length,averageFps:1000/mean(b.frames),meanFrameMs:mean(b.frames),p50FrameMs:sorted[Math.floor(sorted.length*.5)],
      p95FrameMs:sorted[Math.floor(sorted.length*.95)],p99FrameMs:sorted[Math.floor(sorted.length*.99)],maxFrameMs:sorted.at(-1),
      averageDrawCalls:mean(b.calls),maxDrawCalls:Math.max(...b.calls),averageTriangles:mean(b.triangles),
      heapAfter:performance.memory?.usedJSHeapSize??null,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      userAgent:navigator.userAgent,physics:window.__FRACTURED_DIAGNOSTICS__?.readPerformance?.()??null};
  });
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfterGc=(await cdp.send('Runtime.getHeapUsage')).usedSize;
  const report={url:url+query,viewport:`${width}x${height}, DPR 1`,loadSeconds,headless:true,warmupSeconds:2,measurementSeconds,heapBefore,heapBeforeGc,heapAfterGc,memorySamples,errors,...result};
  mkdirSync('test-results',{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
