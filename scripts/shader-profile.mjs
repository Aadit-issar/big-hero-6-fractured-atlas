// Times each blocking program-info-log call (where ANGLE/FXC compilation completes) during start-up.
import { chromium } from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.addInitScript(()=>{
  const log=[];window.__shaderLog=log;const src=new Map();
  const ss=WebGL2RenderingContext.prototype.shaderSource;WebGL2RenderingContext.prototype.shaderSource=function(s,code){src.set(s,code);return ss.call(this,s,code);};
  const as=WebGL2RenderingContext.prototype.attachShader;WebGL2RenderingContext.prototype.attachShader=function(p,s){(p.__s??=[]).push(s);return as.call(this,p,s);};
  const gp=WebGL2RenderingContext.prototype.getProgramInfoLog;
  WebGL2RenderingContext.prototype.getProgramInfoLog=function(p){const name=0;const t=performance.now();const r=gp.call(this,p);const dt=performance.now()-t;
    if(true){const fs=(p.__s||[]).map(s=>src.get(s)||'');const id=(fs.join('').match(/#define SHADER_NAME (\S+)/)||[])[1]||'';const tag=fs.some(c=>c.includes('triplanar'))?'rock':fs.some(c=>c.includes('starLayer'))?'sky':fs.some(c=>c.includes('uNoise'))?'cloud':fs.some(c=>c.includes('uOpen'))?'glow':id;log.push([tag,Math.round(dt),fs.reduce((a,c)=>a+c.length,0)]);}
    return r;};
});
await page.goto(process.argv[2]);
await page.waitForSelector('[data-render-ready="true"]',{timeout:60000});await page.waitForTimeout(1500);
const log=await page.evaluate(()=>window.__shaderLog);
log.sort((a,b)=>b[1]-a[1]);console.log('programs',log.length,'total ms',log.reduce((a,b)=>a+b[1],0));console.log(JSON.stringify(log.slice(0,14)));
await browser.close();
