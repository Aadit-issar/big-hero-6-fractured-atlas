import { expect, test, type Page } from '@playwright/test';
import { TIMELINE } from '../src/atlas/lab/missionTimeline';

const path = '/src/atlas/lab/index.html';
const stage = (page: Page) => page.getByTestId('mission-experience');
const at = (id: string, offset = 0.5) => TIMELINE.find(s => s.id === id)!.from + offset;
const open = async (page: Page, clock: number, query = '') => { await page.goto(`${path}?sound=0&at=${clock}${query}`); await expect(stage(page)).toHaveAttribute('data-beat', /.+/); };

test('opening is a hero shot with empty knowledge; sound can be switched off', async ({ page }) => {
  await page.goto(`${path}?sound=0`);
  await expect(page.getByRole('heading', { name: 'Stranded in an unknown dimension.' })).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-time', '-1');
  await expect(stage(page)).toHaveAttribute('data-scene-objects', '0');
  await expect(page.getByTestId('sound-toggle')).toContainText('Sound off');
  await page.getByTestId('begin-mission').click();
  await expect(page.getByTestId('mission-headline')).toContainText('STRANDED IN AN UNKNOWN DIMENSION.');
  await expect(page.getByTestId('insight')).toContainText('AWAITING SENSOR INPUT.');
  await expect(stage(page)).toHaveAttribute('data-time', '-1'); // still nothing observed during the opening
});

test('discover: the acquisition sequence names scan, island and memory in order', async ({ page }) => {
  await open(page, at('discover-island', 0.4));
  await expect(page.getByTestId('mission-caption')).toContainText('SCAN RECEIVED');
  await open(page, at('discover-island', 4));
  await expect(page.getByTestId('insight')).toContainText('NEW ISLAND RECORDED.');
  await expect(page.getByTestId('pipeline').locator('[data-node="memory"]')).toHaveClass(/s-(active|done)/);
});

test('remember: sensor view loses the objects, memory view restores them, and nothing is erased', async ({ page }) => {
  await open(page, at('remember-lens', 1));
  await expect(stage(page)).toHaveAttribute('data-lens', 'sensor');
  await expect(page.getByTestId('mission-headline')).toHaveText('OUT OF SENSOR VIEW.');
  const records = await stage(page).getAttribute('data-scene-objects');
  await open(page, at('remember-lens', 4.5));
  await expect(stage(page)).toHaveAttribute('data-lens', 'memory');
  await expect(page.getByTestId('mission-headline')).toHaveText('BUT NOT FORGOTTEN.');
  await expect(page.locator('[data-anchor="ISLAND 02"]')).toContainText('REMEMBERED');
  await expect(stage(page)).toHaveAttribute('data-scene-objects', records!);
  // The viewer can flip the lens on their own; it changes only what is drawn.
  await page.getByRole('button', { name: /CURRENT VIEW/ }).click();
  await expect(stage(page)).toHaveAttribute('data-lens', 'sensor');
  await expect(stage(page)).toHaveAttribute('data-scene-objects', records!);
  await page.getByRole('button', { name: /ATLAS MEMORY/ }).click();
  await expect(stage(page)).toHaveAttribute('data-lens', 'memory');
});

test('detect: before and after come from the fold records', async ({ page }) => {
  await open(page, at('detect-compare', 6.5));
  const card = page.getByTestId('card-compare');
  await expect(card).toContainText('OPEN'); await expect(card).toContainText('UNSTABLE'); await expect(card).toContainText('3.2 units');
  await expect(page.getByTestId('mission-headline')).toContainText('FOLD 01 CHANGED.');
  await expect(page.getByTestId('insight')).not.toContainText('Analysis note');
});

test('estimate: published first, later observation second, then a comparison; a miss is kept; abstention is real', async ({ page }) => {
  await open(page, at('estimate-publish', 5));
  await expect(page.getByTestId('mission-headline')).toHaveText('PREDICTION PUBLISHED.');
  await expect(page.getByTestId('card-strip')).not.toContainText('OUTSIDE ALLOWANCE');
  await expect(page.locator('.k-later.off')).toHaveCount(1); // no later observation yet
  await open(page, at('estimate-arrive', 1));
  await expect(page.getByTestId('mission-headline')).toHaveText('NEW OBSERVATION RECEIVED.');
  await expect(page.getByTestId('forecast-result')).toHaveCount(0); // observed, not yet compared
  await open(page, at('estimate-result', 2));
  await expect(page.getByTestId('forecast-result')).toContainText('WITHIN ALLOWANCE');
  await open(page, at('estimate-miss', 1));
  await expect(page.getByTestId('forecast-result')).toContainText('OUTSIDE ALLOWANCE');
  await expect(page.getByTestId('forecast-result')).toContainText('4.710');
  await open(page, at('estimate-abstain', 1));
  await expect(page.getByTestId('mission-headline')).toHaveText('INSUFFICIENT EVIDENCE.');
  await expect(page.getByTestId('forecast-result')).toHaveCount(0);
});

test('understand: the question, the planner\'s answers, the limits, then the live-proof handoff', async ({ page }) => {
  await open(page, at('understand-decision', 1));
  await expect(page.getByTestId('mission-headline')).toHaveText('WHAT SHOULD BAYMAX DO NEXT?');
  await expect(page.getByTestId('mission-summary')).toContainText('one-second forecasts');
  await open(page, at('understand-decision', 4));
  await expect(page.getByTestId('navigation-status')).toHaveText('OBSERVATION PRIORITY');
  await open(page, at('understand-decision', 15));
  await expect(page.getByTestId('card-decision')).toContainText('APPROACH NOT VERIFIED');
  await expect(page.getByTestId('card-decision')).toContainText('NEXT ACTION');
  await expect(page.getByTestId('navigation-panel').getByRole('button', { name: 'Why?' })).toBeVisible();
  await open(page, at('understand-end', 1));
  const prove = page.getByTestId('prove-live');
  await expect(prove).toContainText('PROVE IT LIVE');
  await expect(prove).toHaveAttribute('href', '?experience=live');
  await expect(page.getByTestId('source-label')).toHaveText('GUIDED SIMULATION REPLAY');
});

test('stage identity never regresses during playback and stage jumps land in the right stage', async ({ page }) => {
  await page.goto(`${path}?sound=0&at=88&autoplay=1`);
  const seen: number[] = [];
  for (let i = 0; i < 14; i++) { seen.push(Number(await stage(page).getAttribute('data-chapter'))); await page.waitForTimeout(700); }
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
  for (const [i, name] of ['Discover', 'Remember', 'Detect', 'Estimate', 'Understand'].entries()) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(stage(page)).toHaveAttribute('data-chapter', String(i));
  }
});

test('evidence menu jumps to an event and shows records, then returns to the mission', async ({ page }) => {
  await open(page, 3);
  await page.getByTestId('evidence-menu').click();
  await page.getByRole('menuitem', { name: 'Forecast checked against later evidence' }).click();
  const drawer = page.getByTestId('evidence-drawer');
  await expect(drawer).toContainText('Published'); await expect(drawer).toContainText('within the allowed error'); await expect(drawer).toContainText('before its target');
  await page.getByRole('button', { name: 'Return to the mission' }).first().click();
  await expect(drawer).toHaveCount(0);
});

for (const [w, h] of [[1918, 830], [1920, 1080], [1600, 900], [1280, 720]] as const) {
  test(`readable layout at ${w}x${h}: headline legible, no horizontal scroll, panels clear of each other`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const c of [at('detect-compare', 6.5), at('estimate-result', 2), at('understand-decision', 1), at('understand-end', 1)]) {
      await open(page, c);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const size = await page.getByTestId('mission-headline').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(24);
      const boxes = await page.locator('[data-reserve]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { c: e.className, x: r.left, y: r.top, w: r.width, h: r.height }; }).filter(b => b.w > 0));
      for (const b of boxes) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(w + 1); expect(b.y + b.h).toBeLessThanOrEqual(h + 1); }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const overlap = a.x < b.x + b.w - 2 && a.x + a.w > b.x + 2 && a.y < b.y + b.h - 2 && a.y + a.h > b.y + 2;
        expect(overlap, `${a.c} overlaps ${b.c} at ${w}x${h} clock ${c}`).toBe(false);
      }
    }
  });
}

test('reduced motion removes decorative animation but keeps every message', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, at('detect-compare', 6.5));
  await expect(page.getByTestId('mission-headline')).toContainText('FOLD 01 CHANGED.');
  expect(await page.locator('.md-caption').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});

test('mission is repeatable: restart returns to the same opening state', async ({ page }) => {
  await open(page, at('estimate-result', 2));
  const first = await page.getByTestId('forecast-result').innerText();
  await page.getByRole('button', { name: 'Restart mission' }).click();
  await page.waitForTimeout(300);
  await open(page, at('estimate-result', 2));
  expect(await page.getByTestId('forecast-result').innerText()).toBe(first);
});
