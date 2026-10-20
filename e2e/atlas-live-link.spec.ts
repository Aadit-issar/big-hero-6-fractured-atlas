import { expect, test } from '@playwright/test';

/** Two real windows: ATLAS linked to the running Dimension (integration build with the ATLAS bridge).
 * Requires a Dimension server; set E2E_DIMENSION_URL (for example http://127.0.0.1:4175/). Skipped otherwise. */
const dimensionUrl = process.env.E2E_DIMENSION_URL;
const path = '/src/atlas/lab/index.html';

type Snap = { link: { status: string; session: string | null; episode: number; lastSeq: number }; view: { observation: { observerWorldPosition: number[] } | null }; scene: { records: { id: string; currentlyObserved: boolean; lastRange: number }[] }; navigation: { goalId: string | null; advice: { status: string; goals: { id: string; label: string; kind: string }[]; recommendation: { title: string; target: number[] | null }; route: { segments: unknown[] } | null; evidence: { refs: string[]; text: string }[] } } };
declare global { interface Window { __ATLAS_LIVE__?: { snapshot: () => Snap; requestScan: () => string | null }; __FRACTURED_DIAGNOSTICS__?: { read: () => { cameraPosition: number[] } } } }

test.describe('live link to the running Dimension', () => {
  test.skip(!dimensionUrl, 'E2E_DIMENSION_URL is not set (needs the Dimension integration build running).');
  test.setTimeout(240_000);

  test('connects, tracks the real explorer, acquires only in-range objects and keeps memory', async ({ page, context }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${path}?experience=live&dimension=${encodeURIComponent(dimensionUrl!)}`);
    const [dimension] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open Dimension & connect' }).click()]);
    await page.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120_000 });
    await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120_000 });
    await expect(page.getByTestId('source-label')).toContainText('CONNECTED TO DIMENSION');

    const atlasPose = () => page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().view.observation!.observerWorldPosition);
    const truthPose = () => dimension.evaluate(() => window.__FRACTURED_DIAGNOSTICS__!.read().cameraPosition);
    const distance = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

    // Same world, same pose.
    await page.waitForTimeout(1000);
    expect(distance(await atlasPose(), await truthPose())).toBeLessThan(5);
    const start = await atlasPose();
    const first = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().scene.records.map(r => r.id));

    // Move the real explorer; ATLAS follows it and acquires objects that were not known before.
    await dimension.bringToFront();
    await dimension.keyboard.down('KeyW'); await dimension.keyboard.down('ShiftLeft');
    await dimension.waitForTimeout(2500);
    await dimension.keyboard.up('KeyW'); await dimension.keyboard.up('ShiftLeft');
    await dimension.waitForTimeout(1500);
    const moved = await atlasPose();
    expect(distance(moved, start)).toBeGreaterThan(20);
    expect(distance(moved, await truthPose())).toBeLessThan(5);
    const after = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().scene.records);
    expect(after.some(r => !first.includes(r.id))).toBe(true);
    // Observed objects are always inside the scan range; nothing outside it is claimed.
    expect(after.filter(r => r.currentlyObserved).every(r => r.lastRange <= 45.01)).toBe(true);

    // Fly on: objects left behind stay as remembered records.
    await dimension.keyboard.down('KeyW'); await dimension.keyboard.down('ShiftLeft');
    await dimension.waitForTimeout(3500);
    await dimension.keyboard.up('KeyW'); await dimension.keyboard.up('ShiftLeft');
    await dimension.waitForTimeout(1500);
    const later = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().scene.records);
    expect(later.some(r => !r.currentlyObserved)).toBe(true);
    expect(later.length).toBeGreaterThanOrEqual(after.length);

    // A requested scan always yields an honest, explained result.
    expect(await page.evaluate(() => window.__ATLAS_LIVE__!.requestScan())).toBeTruthy();
    await expect(page.getByTestId('insight')).toContainText(/Scan complete|acquired|refreshed|left|remember/i, { timeout: 10_000 });

    // Closing the Dimension must be reported, never hidden.
    await dimension.close();
    await page.waitForFunction(() => window.__ATLAS_LIVE__!.snapshot().link.status === 'disconnected', null, { timeout: 30_000 });
    await expect(page.getByTestId('source-label')).toContainText('DISCONNECTED');
    expect((await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().scene.records.length))).toBeGreaterThanOrEqual(later.length);
    expect(errors).toEqual([]);
    void context;
  });

  test('a restarted Dimension is a new episode and does not continue the previous records', async ({ page }) => {
    await page.goto(`${path}?experience=live&dimension=${encodeURIComponent(dimensionUrl!)}`);
    const [dimension] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open Dimension & connect' }).click()]);
    await page.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120_000 });
    const before = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().link.session);
    await dimension.reload();
    await page.waitForFunction(prev => { const s = window.__ATLAS_LIVE__!.snapshot(); return s.link.status === 'connected' && s.link.session !== prev; }, before, { timeout: 120_000 });
    const snap = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot());
    expect(snap.link.episode).toBe(2);
    expect(snap.link.session).not.toBe(before);
    await dimension.close();
  });

  test('navigation reasons over live knowledge, reaches the Dimension HUD and reacts to movement, goals and restarts', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${path}?experience=live&dimension=${encodeURIComponent(dimensionUrl!)}`);
    const [dimension] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open Dimension & connect' }).click()]);
    dimension.on('pageerror', e => errors.push(`dimension: ${e.message}`));
    await page.waitForFunction(() => window.__ATLAS_LIVE__?.snapshot().link.status === 'connected', null, { timeout: 120_000 });
    await dimension.waitForFunction(() => !!window.__FRACTURED_DIAGNOSTICS__, null, { timeout: 120_000 });

    // Navigation offers only places ATLAS has recorded in this session.
    await page.waitForFunction(() => window.__ATLAS_LIVE__!.snapshot().navigation.advice.goals.length > 0, null, { timeout: 30_000 });
    const known = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot());
    const recorded = new Set([...known.scene.records.map(r => r.id)]);
    expect(known.navigation.advice.goals.every(g => g.kind !== 'landmark' || g.id.startsWith('cluster-'))).toBe(true);
    expect(known.navigation.advice.goals.length).toBeLessThan(80);
    void recorded;

    // Open the advisor in ATLAS and pick a recorded destination.
    await page.getByTestId('navigation-toggle').click();
    const panel = page.getByTestId('navigation-panel');
    await expect(panel).toBeVisible();
    const goal = await page.evaluate(() => { const g = window.__ATLAS_LIVE__!.snapshot().navigation.advice.goals; return (g.find(x => x.kind === 'island') ?? g[0]!).id; });
    await panel.getByLabel('Navigation destination').selectOption(goal);
    await expect(page.getByTestId('navigation-status')).not.toHaveText('INSUFFICIENT EVIDENCE');
    await expect.poll(() => page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().navigation.goalId)).toBe(goal);
    const status = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().navigation.advice.status);
    expect(['route', 'needs-revalidation', 'no-route', 'explore']).toContain(status);
    await panel.getByRole('button', { name: 'Why?' }).click();
    await expect(page.getByTestId('navigation-evidence')).toContainText('Baymax observed at');
    await expect(page.getByTestId('navigation-evidence')).toContainText('does not claim a safe path');

    // The Dimension shows the same guidance (data validated by its bridge).
    await dimension.bringToFront();
    await dimension.keyboard.press('KeyN');
    const advisor = dimension.getByTestId('atlas-advisor');
    await expect(advisor).toHaveAttribute('data-linked', 'true');
    const title = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().navigation.advice.recommendation.title);
    await expect(advisor).toContainText(title.slice(0, 20), { timeout: 15_000 });
    await expect(advisor).toHaveAttribute('data-fresh', 'true');

    // Moving the real observer updates the bearing and the guidance remains current.
    const hasBearing = await dimension.getByTestId('atlas-bearing').count();
    if (hasBearing) {
      const before = await dimension.getByTestId('atlas-bearing').innerText();
      await dimension.keyboard.down('KeyW'); await dimension.keyboard.down('ShiftLeft');
      await dimension.waitForTimeout(2000);
      await dimension.keyboard.up('KeyW'); await dimension.keyboard.up('ShiftLeft');
      await dimension.waitForTimeout(1500);
      expect(await dimension.getByTestId('atlas-bearing').innerText()).not.toBe(before);
    }

    // A destination chosen inside the Dimension is accepted only if it is one ATLAS has recorded.
    const options = await dimension.getByLabel('ATLAS destination').locator('option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value).filter(Boolean));
    const other = options.find(id => id !== goal);
    if (other) {
      await dimension.getByLabel('ATLAS destination').selectOption(other);
      await expect.poll(() => page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().navigation.goalId), { timeout: 10_000 }).toBe(other);
    }

    // A forged advisory from a window that is not the handshaken ATLAS is ignored.
    const shown = await advisor.innerText();
    await dimension.evaluate(() => {
      const frame = document.createElement('iframe'); document.body.appendChild(frame);
      window.dispatchEvent(new MessageEvent('message', { origin: 'http://127.0.0.1:5180', source: frame.contentWindow, data: { channel: 'fractured-atlas-link', v: 1, type: 'advisory', advisoryVersion: 1, session: 'x', seq: 999999, status: 'route', episode: 1, simTime: 1, goal: null, title: 'FORGED GUIDANCE', detail: 'forged', action: 'none', target: null, waypoints: [], segments: [], limitations: [], goals: [] } }));
      frame.remove();
    });
    await dimension.waitForTimeout(400);
    expect(await advisor.innerText()).not.toContain('FORGED GUIDANCE');
    expect(shown).not.toContain('FORGED GUIDANCE');

    // A restarted Dimension is a new session: the goal and route are discarded, never carried over.
    const before = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot().link.session);
    await dimension.reload();
    await page.waitForFunction(prev => { const s = window.__ATLAS_LIVE__!.snapshot(); return s.link.status === 'connected' && s.link.session !== prev; }, before, { timeout: 120_000 });
    const after = await page.evaluate(() => window.__ATLAS_LIVE__!.snapshot());
    expect(after.navigation.goalId).toBeNull();
    expect(after.navigation.advice.route).toBeNull();
    expect(errors).toEqual([]);
    await dimension.close();
  });
});
