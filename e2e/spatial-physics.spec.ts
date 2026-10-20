import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { capture } from './capture';

const read=(page:Page)=>page.evaluate(()=>window.__FRACTURED_DIAGNOSTICS__!.read());
const separation=(a:readonly number[],b:readonly number[])=>Math.hypot(...a.map((v,i)=>v-b[i]!));
async function lookAt(page:Page,target:readonly number[]) {
  const d=await read(page),q=d.cameraQuaternion;
  const forward=[-2*(q[0]!*q[2]!+q[3]!*q[1]!),-2*(q[1]!*q[2]!-q[3]!*q[0]!),-(1-2*(q[0]!**2+q[1]!**2))];
  const v=target.map((x,i)=>x-d.cameraPosition[i]!),length=Math.hypot(...v);
  const yaw=Math.atan2(-forward[0]!,-forward[2]!),desiredYaw=Math.atan2(-v[0]!,-v[2]!);
  const yawChange=Math.atan2(Math.sin(yaw-desiredYaw),Math.cos(yaw-desiredYaw));
  const pitchChange=Math.asin(forward[1]!)-Math.asin(v[1]!/length);
  await page.mouse.move(700,430);await page.mouse.down();
  await page.mouse.move(700+yawChange/.0025,430+pitchChange/.0025,{steps:8});await page.mouse.up();await page.waitForTimeout(180);
}

test('approaches a real fold, changes reference branch, and resets all physics',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect.poll(()=>page.evaluate(()=>!!window.__FRACTURED_DIAGNOSTICS__),{timeout:20_000}).toBe(true);
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  await page.getByTestId('play-pause').click();await page.waitForTimeout(300);
  const initial=await read(page);
  expect(initial.connections.filter(c=>c.open).length).toBeGreaterThan(0);
  await capture(page,'phase2-overview.png');
  await page.locator('canvas').click({position:{x:700,y:430}});
  await page.keyboard.down('w');
  await expect.poll(async()=>{const d=await read(page);return d.nearby?.worldDistance??100;},{timeout:9000,intervals:[40]}).toBeLessThan(4.6);
  await page.keyboard.up('w');await page.waitForTimeout(180);
  const approach=await read(page);expect(approach.nearby?.connection.open).toBe(true);
  const nearby=approach.nearby!;
  await lookAt(page,nearby.side==='A'?nearby.connection.entryWorldPosition:nearby.connection.exitWorldPosition);
  const before=await read(page);
  await expect(page.getByTestId('traversal-hint')).toContainText('E');
  await capture(page,'phase2-active-fold.png');
  await page.keyboard.press('e');
  await expect.poll(async()=>(await read(page)).traversalCount).toBe(1);
  const after=await read(page);
  expect(after.regionId).not.toBe(before.regionId);expect(separation(after.referencePosition,before.referencePosition)).toBeGreaterThan(1.8);
  expect(after.cameraPosition.every(Number.isFinite)).toBe(true);expect(after.cameraQuaternion).toEqual(before.cameraQuaternion);
  expect(separation(after.cameraPosition,before.cameraPosition)).toBeGreaterThan(.5);
  await page.keyboard.press('e');expect((await read(page)).traversalCount).toBe(1);
  // Orientation preservation is asserted above; then use ordinary mouse look
  // to frame the destination terrain for the handoff evidence.
  await lookAt(page,after.renderedIslands[4]!.position!);
  await capture(page,'phase2-traversal.png');
  await page.keyboard.down('a');await page.waitForTimeout(180);await page.keyboard.up('a');
  expect(separation((await read(page)).cameraPosition,after.cameraPosition)).toBeGreaterThan(1);
  const frozen=await read(page);await page.waitForTimeout(350);const still=await read(page);
  expect(still.time).toBe(frozen.time);expect(still.debris).toEqual(frozen.debris);expect(still.connections).toEqual(frozen.connections);
  await page.getByTestId('speed-2').click();await page.getByTestId('play-pause').click();await page.waitForTimeout(1700);
  await page.getByTestId('play-pause').click();await page.waitForTimeout(200);
  const evolved=await read(page);expect(evolved.debrisTick).toBeGreaterThan(frozen.debrisTick);expect(evolved.debris).not.toEqual(frozen.debris);
  expect(evolved.local.hazard).not.toBe(frozen.local.hazard);
  expect(evolved.renderedIslands).not.toEqual(frozen.renderedIslands);
  await lookAt(page,evolved.renderedIslands[4]!.position!);
  await capture(page,'phase2-instability.png');
  await page.getByTestId('reset-simulation').click();await page.getByTestId('play-pause').click();await page.waitForTimeout(200);
  const reset=await read(page);expect(reset.regionId).toBe('origin');expect(reset.traversalCount).toBe(0);expect(reset.time).toBeLessThan(.2);
  expect(reset.cameraPosition.every(Number.isFinite)).toBe(true);expect(errors).toEqual([]);
});

test('connection windows close on model time and refuse later entry',async({page})=>{
  await page.goto('/');await expect.poll(()=>page.evaluate(()=>!!window.__FRACTURED_DIAGNOSTICS__),{timeout:20_000}).toBe(true);
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  const initial=await read(page);const id=initial.primaryFoldId!;
  expect(initial.connections.find(c=>c.id===id)!.open).toBe(true);
  await page.getByTestId('speed-2').click();
  await expect.poll(async()=>(await read(page)).connections.find(c=>c.id===id)!.state,{timeout:20_000,intervals:[150]}).toBe('closing');
  await page.getByTestId('play-pause').click();
  const closing=await read(page);expect(closing.connections.find(c=>c.id===id)!.open).toBe(false);
  await page.locator('canvas').click({position:{x:700,y:430}});await page.keyboard.press('e');
  expect((await read(page)).traversalCount).toBe(0);
});
