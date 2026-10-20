import { expect, test } from '@playwright/test';
import { capture } from './capture';

test('renders the seeded world and exposes a working WebGL2 scene', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'FRACTURED DIMENSION' })).toBeVisible();
  await expect(page.getByTestId('simulation-status')).toContainText('SIMULATION LIVE');
  await expect(page.getByTestId('world-seed')).toHaveText('17062026');
  await expect(page.getByTestId('world-scene')).toHaveAttribute('data-island-count', '14');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('jacobian-value')).not.toHaveText('NaN');

  const webgl2Active = await page.locator('canvas').evaluate((element) => (
    (element as HTMLCanvasElement).getContext('webgl2') !== null
  ));
  expect(webgl2Active).toBe(true);

  await capture(page,'phase1-world.png');
  await page.waitForTimeout(2_500);
  await capture(page,'phase1-world-in-motion.png');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('pauses, resumes, changes time scale, and resets the simulation', async ({ page }) => {
  await page.goto('/');
  // Interact once the world is loaded: start-up stalls slow the frame-driven HUD.
  await expect(page.locator('main')).toHaveAttribute('data-render-ready', 'true', { timeout: 60_000 });
  await expect(page.getByTestId('sim-time')).toBeVisible();
  const initialFieldValue = await page.getByTestId('field-value').textContent();

  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('simulation-status')).toContainText('PAUSED');
  await page.waitForTimeout(250);
  const pausedTime = await page.getByTestId('sim-time').textContent();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('sim-time')).toHaveText(pausedTime ?? '');

  await page.getByTestId('speed-2').click();
  await expect(page.getByTestId('speed-2')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('play-pause').click();
  await page.waitForTimeout(900);
  const movingTime = await page.getByTestId('sim-time').textContent();
  expect(movingTime).not.toBe(pausedTime);
  expect(await page.getByTestId('field-value').textContent()).not.toBe(initialFieldValue);

  await page.getByTestId('reset-simulation').click();
  await expect(page.getByTestId('simulation-status')).toContainText('LIVE');
  await expect(page.getByTestId('speed-1')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const text = await page.getByTestId('sim-time').textContent() ?? '';
    const match = /T\+\s+(\d+):(\d+\.\d+)/.exec(text);
    return match ? Number(match[1]) * 60 + Number(match[2]) : Number.POSITIVE_INFINITY;
  }).toBeLessThan(0.35);
});

test('moves and rotates the free-flight camera and restores the opening view', async ({ page }) => {
  await page.goto('/');
  // Interact once the world is loaded: start-up stalls slow the frame-driven HUD.
  await expect(page.locator('main')).toHaveAttribute('data-render-ready', 'true', { timeout: 60_000 });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  // Phase 2 spawn follows a mathematically discovered fold. Freeze model time
  // to verify exact reset to that reference-based opening pose.
  await page.getByTestId('play-pause').click();
  await page.getByTestId('reset-camera').click();
  await page.waitForTimeout(300);
  const openingPosition = await page.getByTestId('camera-position').textContent();

  await canvas.click({ position: { x: 700, y: 430 } });
  await page.keyboard.down('w');
  await page.waitForTimeout(550);
  await page.keyboard.up('w');
  await page.waitForTimeout(200);
  const movedPosition = await page.getByTestId('camera-position').textContent();
  expect(movedPosition).not.toBe(openingPosition);

  await canvas.hover({ position: { x: 700, y: 430 } });
  await page.mouse.down();
  await page.mouse.move(835, 374, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  await page.waitForTimeout(200);
  const afterLookingPosition = await page.getByTestId('camera-position').textContent();
  expect(afterLookingPosition).not.toBe(movedPosition);

  await page.getByTestId('reset-camera').click();
  await page.waitForTimeout(200);
  expect(await page.getByTestId('camera-position').textContent()).toBe(openingPosition);
});
