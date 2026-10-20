import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { capture } from './capture';

const read=(page:Page)=>page.evaluate(()=>window.__FRACTURED_DIAGNOSTICS__!.read());

test('loads detailed geology and materials, keeps terrain parented, and isolates quality from physics',async({page})=>{
  test.setTimeout(90_000);
  const errors:string[]=[];const failed:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('requestfailed',r=>failed.push(r.url()));
  page.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${r.url()}`);});

  await page.goto('/');
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  const loaded=await read(page);
  expect(loaded.render.texturesReady).toBe(true);
  expect(loaded.render.textureFallback).toBe(false);
  expect(loaded.render.skyReady).toBe(true);
  expect(loaded.render.terrainReady).toBe(14);
  // Every island has detailed geology parented to its simulation-driven transform.
  for(const [i,mesh] of loaded.render.terrainMeshes.entries()) {
    expect(mesh).not.toBeNull();
    expect(mesh!.parent).toBe(loaded.renderedIslands[i]!.id);
    expect(mesh!.vertices).toBeGreaterThan(1000);
  }
  await capture(page,'phase3-loaded.png');

  // Freeze model time, then switch rendering quality: simulation state must not change.
  await page.getByTestId('play-pause').click();await page.waitForTimeout(250);
  const frozen=await read(page);
  await page.getByTestId('quality-performance').click();await page.waitForTimeout(150);
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});
  await page.waitForTimeout(300);
  const performance=await read(page);
  expect(performance.time).toBe(frozen.time);
  expect(performance.connections).toEqual(frozen.connections);
  expect(performance.debris).toEqual(frozen.debris);
  expect(performance.renderedIslands).toEqual(frozen.renderedIslands);
  expect(performance.referencePosition).toEqual(frozen.referencePosition);
  await page.getByTestId('quality-balanced').click();await page.waitForTimeout(150);
  await expect(page.locator('main')).toHaveAttribute('data-render-ready','true',{timeout:60_000});

  // Rendering-only viewpoints move the camera; R returns to the opening reference pose.
  await page.getByTestId('reset-camera').click();await page.waitForTimeout(200);
  const opening=(await read(page)).cameraPosition;
  await page.locator('canvas').click({position:{x:700,y:430}});
  await page.keyboard.press('Digit2');await page.waitForTimeout(200);
  expect((await read(page)).cameraPosition).not.toEqual(opening);
  await capture(page,'phase3-closeup.png');
  await page.keyboard.press('KeyR');await page.waitForTimeout(200);
  expect((await read(page)).cameraPosition).toEqual(opening);

  // H hides the HUD for presentation without unbinding controls.
  await page.keyboard.press('KeyH');
  await expect(page.locator('.hud-shell')).toBeHidden();
  await page.keyboard.press('KeyH');
  await expect(page.getByTestId('play-pause')).toBeVisible();

  // Reset restores the same seed-dependent world transforms.
  await page.getByTestId('reset-simulation').click();await page.getByTestId('play-pause').click();await page.waitForTimeout(250);
  const reset=await read(page);
  expect(reset.time).toBeLessThan(.5);
  expect(reset.render.terrainMeshes.every(m=>m!==null)).toBe(true);
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});
