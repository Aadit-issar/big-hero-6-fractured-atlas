import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';

// A fresh directory avoids Windows image-preview locks on prior evidence.
export const captureDirectory=`test-results/captures/${Date.now()}-${process.pid}`;
export async function capture(page:Page,name:string) {
  await mkdir(captureDirectory,{recursive:true});
  await page.screenshot({path:`${captureDirectory}/${name}`,fullPage:true});
}
