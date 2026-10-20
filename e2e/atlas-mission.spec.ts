import { expect, test, type Page } from '@playwright/test';

const path = '/src/atlas/lab/index.html';
const stage = (page: Page) => page.getByTestId('mission-experience');

async function seek(page: Page, time: number) {
  await page.goto(`${path}?labels=all&sim=${time}`);
  await expect(stage(page)).toHaveAttribute('data-time', String(time));
}

test('mission opens with an empty knowledge state, plays, pauses and navigates the five stages', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Begin Mission' })).toBeVisible();
  await expect(page.getByTestId('source-label')).toHaveText('GUIDED SIMULATION REPLAY');
  await expect(page.locator('canvas')).toBeVisible();
  // Before Begin ATLAS has received nothing: no observation, no records.
  await expect(stage(page)).toHaveAttribute('data-time', '-1');
  await expect(stage(page)).toHaveAttribute('data-scene-objects', '0');
  await page.getByRole('button', { name: 'Begin Mission' }).click();
  await expect(stage(page)).not.toHaveAttribute('data-time', '-1');
  await page.getByRole('button', { name: 'Pause mission' }).click();
  const time = await stage(page).getAttribute('data-time');
  await page.waitForTimeout(1300);
  await expect(stage(page)).toHaveAttribute('data-time', time!);
  const names = ['Remember', 'Detect', 'Estimate', 'Understand'];
  for (let chapter = 1; chapter < 5; chapter++) {
    await page.getByRole('button', { name: names[chapter - 1]!, exact: true }).click();
    await expect(stage(page)).toHaveAttribute('data-chapter', String(chapter));
  }
  expect(errors).toEqual([]);
});

test('memory, change, estimate, abstention and backward seek reflect genuine runtime state', async ({ page }) => {
  await page.goto(`${path}?labels=all&sim=8`);
  await expect(stage(page)).toHaveAttribute('data-time', '8');
  // ISLAND 02 and the concrete debris field left range: remembered, still recorded.
  await expect(page.locator('[data-anchor="ISLAND 02"]')).toContainText('REMEMBERED');
  const objectsAt8 = Number(await stage(page).getAttribute('data-scene-objects'));
  expect(objectsAt8).toBeGreaterThan(0);
  await seek(page, 12);
  await expect(page.getByTestId('card-compare')).toContainText('UNSTABLE');
  await seek(page, 16);
  await expect(page.getByTestId('card-strip')).toBeVisible();
  await seek(page, 23);
  await expect(page.locator('[data-anchor="estimate-FOLD 01"]')).toContainText('NO ESTIMATE');
  const objectsLate = Number(await stage(page).getAttribute('data-scene-objects'));
  expect(objectsLate).toBeGreaterThanOrEqual(objectsAt8);
  // Backward seek discards the future: the earlier knowledge state is reconstructed exactly.
  await seek(page, 8);
  await expect(stage(page)).toHaveAttribute('data-scene-objects', String(objectsAt8));
  await expect(page.locator('[data-anchor="estimate-FOLD 01"]')).toHaveCount(0);
  await seek(page, 0);
  await expect(stage(page)).toHaveAttribute('data-samples', '1');
});

test('advanced analysis preserves the active replay snapshot and returns to the dimension', async ({ page }) => {
  await page.goto(`${path}?labels=all&sim=18`);
  await expect(stage(page)).toHaveAttribute('data-time', '18');
  await page.getByRole('button', { name: 'Analysis', exact: true }).click();
  await expect(page.getByTestId('exploration-map')).toBeVisible();
  await expect(page.getByTestId('scene-analysis')).toContainText('Scene-object scans');
  await expect(page.getByText('GUIDED SIMULATION REPLAY · FROZEN EVIDENCE')).toBeVisible();
  await page.getByRole('button', { name: 'Return to the dimension' }).click();
  await expect(stage(page)).toHaveAttribute('data-time', '18');
});

test('live scan starts unlinked and never shows data it has not received', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${path}?experience=live`);
  await expect(page.getByTestId('live-connect')).toBeVisible();
  await expect(page.getByTestId('source-label')).toHaveText('NOT CONNECTED');
  await expect(stage(page)).toHaveAttribute('data-mode', 'live');
  await expect(stage(page)).toHaveAttribute('data-time', '-1');
  await expect(stage(page)).toHaveAttribute('data-scene-objects', '0');
  await expect(page.getByRole('button', { name: /Scan now/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open Dimension & connect' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('isolated lab uses its own simulation and is labelled as not the Dimension', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${path}?experience=lab`);
  await expect(page.getByTestId('source-label')).toContainText('ISOLATED SIMULATION');
  await expect(page.getByTestId('source-label')).not.toContainText('CONNECTED');
  await expect(stage(page)).not.toHaveAttribute('data-time', '-1');
  await expect(page.locator('canvas')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(Number(await stage(page).getAttribute('data-samples'))).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('keyboard transport, manual camera, entity selection and narrow reduced-motion layout work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${path}?labels=all&sim=8&select=ISLAND 02`);
  await expect(page.getByRole('complementary', { name: 'Selected record' })).toContainText('REMEMBERED');
  await page.getByRole('button', { name: 'Close selected record' }).click();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause mission' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play mission' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(stage(page)).toHaveAttribute('data-chapter', '2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.4);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.45, { steps: 6 }); await page.mouse.up();
  await expect(page.getByRole('button', { name: /Resume guided/ })).toBeVisible();
  await page.getByRole('button', { name: /Resume guided/ }).click();
  await expect(page.getByRole('button', { name: /Guided camera/ })).toBeVisible();
});

test('baymax can be selected and reports the sensor pose it is animated from', async ({ page }) => {
  await page.goto(`${path}?labels=all&sim=6&select=baymax-observer`);
  const panel = page.getByRole('complementary', { name: 'Selected record' });
  await expect(panel).toContainText('Baymax');
  await expect(panel).toContainText('AUTHORED REPLAY POSE');
  await expect(panel).toContainText('presentation animation');
});

test('dense hologram keeps identities available and WebGL loss preserves evidence access', async ({ page }) => {
  await page.goto(`${path}?experience=stress`);
  await expect(page.getByText('STRESS FIXTURE · NOT LIVE', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Inspect a discovery').locator('option')).toHaveCount(161);
  await page.getByLabel('Inspect a discovery').selectOption({ index: 1 });
  await expect(page.getByRole('complementary', { name: 'Spatial evidence' })).toContainText('CURRENTLY OBSERVED');
  await page.locator('canvas').evaluate(canvas => canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext());
  await expect(page.getByRole('heading', { name: 'Spatial records remain available' })).toBeVisible();
  await page.getByRole('button', { name: 'Why does ATLAS know this?' }).click();
  await expect(page.getByTestId('mission-evidence')).toContainText('labelled stress fixture');
});

test('category filters change what is drawn without changing what ATLAS knows', async ({ page }) => {
  await page.goto(`${path}?labels=all&sim=12`);
  await expect(stage(page)).toHaveAttribute('data-time', '12');
  const records = await stage(page).getAttribute('data-scene-objects');
  await expect(page.locator('[data-anchor^="cluster-"]').first()).toBeAttached();
  await page.getByRole('button', { name: /Debris/ }).click();
  await expect(page.locator('[data-anchor^="cluster-"]')).toHaveCount(0);
  await expect(stage(page)).toHaveAttribute('data-scene-objects', records!);
  await page.getByRole('button', { name: /Debris/ }).click();
  await expect(page.locator('[data-anchor^="cluster-"]').first()).toBeAttached();
  await page.getByRole('button', { name: /Folds/ }).click();
  await expect(page.locator('[data-anchor="FOLD 01"]')).toHaveCount(0);
});

test('the Understand stage ends on a decision: a candidate route with honest limitations', async ({ page }) => {
  await page.goto(`${path}?at=108`);
  await expect(stage(page)).toHaveAttribute('data-chapter', '4');
  const panel = page.getByTestId('navigation-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('navigation-status')).toHaveText('CANDIDATE ROUTE');
  await expect(panel).toContainText('Candidate route to Capsule wreckage');
  await expect(panel).toContainText('unverified approach');
  await expect(page.getByTestId('card-decision')).toContainText('DESTINATION IDENTIFIED');
});

test('navigation: choose a destination, ask for the next observation, inspect evidence, and never route to unknown places', async ({ page }) => {
  await page.goto(`${path}?labels=all&sim=12&nav=1`);
  const panel = page.getByTestId('navigation-panel');
  await expect(panel).toBeVisible();
  const select = panel.getByLabel('Navigation destination');
  // Only recorded places are offered; at t=12 the capsule landmark and the industrial cluster are recorded, at t=1 they are not.
  await expect(select.locator('option', { hasText: 'Capsule wreckage' })).toHaveCount(1);
  await select.selectOption({ label: 'ISLAND 03' });
  await expect(page.getByTestId('navigation-status')).not.toHaveText('INSUFFICIENT EVIDENCE');
  await panel.getByRole('button', { name: 'Why?' }).click();
  const evidence = page.getByTestId('navigation-evidence');
  await expect(evidence).toContainText('Baymax observed at');
  await expect(evidence).toContainText('Limitations');
  await expect(evidence).toContainText('does not claim a safe path');
  await panel.getByRole('button', { name: 'Recommend next observation' }).click();
  await expect(page.getByTestId('navigation-status')).toHaveText('OBSERVATION PRIORITY');
  await expect(select).toHaveValue('');
  await page.goto(`${path}?labels=all&sim=1&nav=1`);
  await expect(page.getByTestId('navigation-panel').getByLabel('Navigation destination').locator('option', { hasText: 'Capsule wreckage' })).toHaveCount(0);
  await expect(page.getByTestId('navigation-panel').getByLabel('Navigation destination').locator('option', { hasText: 'Industrial wreckage cluster' })).toHaveCount(0);
});
