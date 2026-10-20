import { expect, test } from '@playwright/test';

const labPath = '/src/atlas/lab/index.html';

test('fixture console renders observed data, radar markers, selection, events and timeline', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });

  await page.goto(`${labPath}?mode=fixture`);
  await expect(page.getByText('FIXTURE DATA · NOT LIVE')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proximity radar' })).toBeVisible();
  await expect(page.getByText('Receiving observations')).toBeVisible();
  await expect(page.locator('.object-row').filter({ hasText: 'island-07' })).toBeVisible();
  await expect(page.getByTestId('event-feed')).toContainText('First valid sensor observation received.');
  await expect(page.locator('.timeline-chart circle').nth(1)).toBeVisible({ timeout: 5000 });

  const marker = page.locator('.radar-island-marker').first();
  await expect(marker).toBeVisible();
  const markerPosition = await marker.evaluate((node) => ({ x: Number(node.getAttribute('cx')), y: Number(node.getAttribute('cy')) }));
  expect(markerPosition.x).toBeGreaterThan(260);
  expect(markerPosition.y).toBeLessThan(300);

  const radarIsland = page.locator('.radar-island').first();
  await radarIsland.focus();
  await expect(radarIsland).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('selected-object-panel')).toContainText('island-07');

  const radarFold = page.getByTestId('local-radar-panel').getByRole('button', { name: 'Select fold fold-A3 entry' });
  await radarFold.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-fold-detail')).toContainText('fold-A3');
  await page.locator('.object-row').filter({ hasText: 'fold-A3' }).click();
  await expect(page.getByTestId('selected-fold-detail')).toContainText('fold-A3');
  await expect(page.getByTestId('selected-fold-detail')).toContainText('open');
  await expect(page.getByTestId('selected-fold-detail')).toContainText('not a closure forecast');
  await page.getByRole('button', { name: 'Gravity magnitude' }).click();
  await expect(page.getByRole('img', { name: /Gravity magnitude measured from/ })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('live lab receives real snapshots through observe(engine)', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });

  await page.goto(`${labPath}?mode=live`);
  await expect(page.getByText('LIVE LAB · ISOLATED SIMULATION')).toBeVisible();
  await expect(page.getByText('Receiving observations')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.mission-metric').first()).not.toContainText('—');
  await expect(page.locator('.timeline-chart circle').nth(1)).toBeVisible({ timeout: 8_000 });
  expect(browserErrors).toEqual([]);
});

test('empty and unavailable sensor views communicate missing data without fake readings', async ({ page }) => {
  await page.goto(`${labPath}?mode=empty`);
  await expect(page.getByText('AWAITING LINK · TEST VIEW')).toBeVisible();
  await expect(page.locator('.health-notice').getByText('Awaiting observation')).toBeVisible();
  await expect(page.getByText('Radar awaiting sensor lock')).toBeVisible();
  await expect(page.getByText('No accepted samples are available to plot.')).toBeVisible();

  await page.goto(`${labPath}?mode=offline`);
  await expect(page.getByText('OFFLINE STATE · TEST VIEW')).toBeVisible();
  await expect(page.locator('.health-notice').getByText('Sensor unavailable')).toBeVisible();
  await expect(page.getByText('Local readings are unavailable until a valid snapshot arrives.')).toBeVisible();
  await expect(page.getByText('No valid sample')).toBeVisible();
});

test('console remains within a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${labPath}?mode=fixture`);
  await expect(page.getByRole('heading', { name: 'ATLAS' })).toBeVisible();
  await expect(page.getByTestId('local-radar-panel')).toBeVisible();
  await expect(page.getByTestId('nearby-objects')).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

test('replay progressively builds session memory and keeps missing folds historical rather than closed', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });

  await page.goto(`${labPath}?mode=replay`);
  await expect(page.getByText('REPLAY FIXTURE · NOT LIVE')).toBeVisible();
  await expect(page.getByTestId('exploration-map')).toBeVisible();
  await expect(page.getByText('NO ACCUMULATED DISCOVERIES')).toHaveCount(0);
  await expect(page.getByTestId('map-island-island-C')).toBeVisible({ timeout: 4_000 });
  await expect(page.getByTestId('map-island-island-B')).toHaveClass(/map-historical/);
  await expect(page.getByTestId('map-fold-fold-A')).toHaveAttribute('aria-label', /current state unknown/, { timeout: 3_000 });
  await expect(page.getByTestId('map-inspector')).toContainText('fold');
  await expect(page.getByTestId('event-feed')).toContainText('discovered from a sensor observation');
  await expect(page.getByTestId('exploration-map')).toContainText('not a physical route');

  await page.getByTestId('map-fold-fold-A-entry').click();
  await expect(page.getByTestId('map-inspector')).toContainText('Destination evidence');
  await expect(page.getByTestId('map-inspector')).toContainText('not independently explored');

  await expect(page.getByTestId('map-island-island-A')).toHaveClass(/map-current/, { timeout: 5_000 });
  await expect(page.getByTestId('map-fold-fold-A')).toHaveAttribute('aria-label', /currently observed/);
  await expect(page.getByTestId('map-inspector')).toContainText('closed');
  await page.getByTestId('map-history-fold-fold-A-0').click();
  await expect(page.getByTestId('historical-sample-highlight')).toHaveAttribute('aria-label', /simulation time 0.0 seconds/);
  expect(browserErrors).toEqual([]);
});

test('exploration map selection, projection, pan, zoom, fit, follow and layer controls work', async ({ page }) => {
  await page.goto(`${labPath}?mode=replay`);
  const canvas = page.getByTestId('exploration-canvas');
  await expect(canvas).toBeVisible();
  const keyboardIsland = page.getByTestId('map-island-island-A');
  await keyboardIsland.focus();
  await expect(keyboardIsland).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('map-inspector')).toContainText('island-A');
  await page.getByTestId('map-history-island-island-A-0').click();
  await expect(page.getByTestId('historical-sample-highlight')).toBeVisible();
  const keyboardFold = page.getByTestId('map-fold-fold-A-entry');
  await keyboardFold.focus();
  await expect(keyboardFold).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('map-inspector')).toContainText('fold-A');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width * 0.8;
  const startY = box!.y + box!.height * 0.8;
  const beforePan = Number(await canvas.getAttribute('data-camera-horizontal'));
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 70, startY + 35, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Follow explorer' })).toHaveAttribute('aria-pressed', 'false');
  expect(Number(await canvas.getAttribute('data-camera-horizontal'))).not.toBe(beforePan);

  const beforeZoom = Number(await canvas.getAttribute('data-scale'));
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeGreaterThan(beforeZoom);
  const zoomBox = await canvas.boundingBox();
  expect(zoomBox).not.toBeNull();
  const beforeWheelZoom = Number(await canvas.getAttribute('data-scale'));
  await canvas.evaluate((svg) => svg.addEventListener('wheel', () => svg.setAttribute('data-native-wheel', 'seen'), { once: true }));
  await page.mouse.move(zoomBox!.x + zoomBox!.width / 2, zoomBox!.y + zoomBox!.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(canvas).toHaveAttribute('data-native-wheel', 'seen');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scale'))).toBeGreaterThan(beforeWheelZoom);

  await page.getByRole('button', { name: 'Elevation Z/Y' }).click();
  await expect(canvas).toHaveAttribute('aria-label', /side elevation map using world Z and Y/);
  await page.getByRole('button', { name: 'Fit observations' }).click();
  await page.getByRole('button', { name: 'Follow explorer' }).click();
  await expect(page.getByRole('button', { name: 'Follow explorer' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reset camera' }).click();

  await page.getByLabel('Islands', { exact: true }).uncheck();
  await expect(page.getByTestId('map-island-island-A')).toHaveCount(0);
  await page.getByLabel('Islands', { exact: true }).check();
  await expect(page.getByTestId('map-island-island-A')).toBeVisible();
});

test('exploration map has clear empty and unavailable states and fits a mobile viewport', async ({ page }) => {
  await page.goto(`${labPath}?mode=empty`);
  await expect(page.getByTestId('exploration-map')).toContainText('NO ACCUMULATED DISCOVERIES');
  await expect(page.getByTestId('map-inspector')).toContainText('Select a remembered island or fold marker');

  await page.goto(`${labPath}?mode=offline`);
  await expect(page.getByTestId('exploration-map')).toContainText('NO ACCUMULATED DISCOVERIES');
  await expect(page.locator('.health-notice')).toContainText('Sensor unavailable');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${labPath}?mode=replay`);
  await expect(page.getByTestId('exploration-map')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Top-down X/Z' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Elevation Z/Y' })).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

test('labelled stress fixture renders a bounded dense map without browser errors', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  await page.goto(`${labPath}?mode=stress`);
  await expect(page.getByText('STRESS FIXTURE · NOT LIVE')).toBeVisible();
  await expect(page.locator('.map-island')).toHaveCount(128);
  await expect(page.locator('.map-fold')).toHaveCount(32);
  await expect(page.getByTestId('exploration-map')).toContainText('128');
  expect(browserErrors).toEqual([]);
});

test('temporal fixture learns from sensor-shaped history, draws estimates separately and audits later readings', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  await page.goto(`${labPath}?mode=temporal`);
  await expect(page.getByText('TEMPORAL FIXTURE · NOT LIVE')).toBeVisible();
  await expect(page.getByTestId('temporal-panel')).toBeVisible();
  await expect(page.getByText('Fold-state forecasting disabled', { exact: true })).toBeVisible();
  await expect(page.getByTestId('environment-model').locator('.model-estimate').getByText(/ESTIMATE AT t=/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('forecast-geometry')).toBeVisible();
  await expect(page.getByTestId('map-fold-fold-temporal-A')).toBeVisible();
  await expect(page.getByTestId('local-radar-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Gravity evidence' }).click();
  await expect(page.getByTestId('temporal-chart')).toHaveAttribute('aria-label', /gravity/);
  const originalWindowStart = await page.getByTestId('temporal-chart-start').textContent();
  await page.getByLabel('Environmental chart time window').selectOption('4');
  await expect(page.getByTestId('temporal-chart-start')).not.toHaveText(originalWindowStart!);
  await page.getByRole('button', { name: 'Inspect forecast audit' }).click();
  await expect(page.getByTestId('forecast-audit').locator('tbody tr').first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('forecast-audit')).toContainText('hazard');
  await page.getByLabel('Temporal fold selection').selectOption('fold-temporal-A');
  await expect(page.getByTestId('fold-analysis')).toContainText('SAMPLED CHANGES');
  await expect(page.getByTestId('fold-analysis')).toContainText('FIRST SEEN');
  const motionChart = page.getByTestId('fold-motion-chart');
  await expect(motionChart).toBeVisible();
  expect(Number(await motionChart.getAttribute('data-observed-points'))).toBeGreaterThan(5);
  await page.getByLabel('World coordinate axis').selectOption('1');
  await expect(motionChart).toHaveAttribute('aria-label', /Y coordinate/);
  await page.getByLabel('Fold endpoint').selectOption('exit');
  await expect(motionChart).toHaveAttribute('aria-label', /reported exit/);
  expect(browserErrors).toEqual([]);
});

test('sparse evidence abstains and measured hazard advisories identify their source', async ({ page }) => {
  await page.goto(`${labPath}?mode=insufficient`);
  await expect(page.getByText('SPARSE FIXTURE · NOT LIVE')).toBeVisible();
  await expect(page.getByTestId('environment-model')).toContainText('ESTIMATE WITHHELD');
  await expect(page.getByTestId('environment-model')).toContainText('Need 6 contiguous samples');

  await page.goto(`${labPath}?mode=warning`);
  await expect(page.getByText('WARNING FIXTURE · NOT LIVE')).toBeVisible();
  await expect(page.getByTestId('temporal-concerns')).toContainText('Elevated measured instability');
  await expect(page.getByTestId('temporal-concerns')).toContainText('not a harm probability');
  await expect(page.getByTestId('temporal-concerns')).not.toContainText('Safe to traverse');
});

test('temporal analysis remains readable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${labPath}?mode=temporal`);
  await expect(page.getByTestId('temporal-panel')).toBeVisible();
  await expect(page.getByTestId('local-radar-panel')).toBeVisible();
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});
