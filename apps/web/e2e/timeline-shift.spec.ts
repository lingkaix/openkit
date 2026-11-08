import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** Records layout shift for the next document, ignoring shifts caused by input. */
async function armLayoutShift(page: Page) {
  await page.addInitScript(() => {
    const bucket = { value: 0 };
    (window as unknown as { __cls: { value: number } }).__cls = bucket;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput && typeof shift.value === 'number') bucket.value += shift.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

/** Cumulative layout shift recorded since this document started. */
async function layoutShift(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __cls: { value: number } }).__cls.value);
}

/**
 * U8: first paint and a short reserved-height stream stay within the shift budget.
 * The fixture route is the same dev-only surface the other timeline checks open.
 */
test('keeps first load and a short stream within the shift budget', async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  try {
    await armLayoutShift(page);
    await page.goto(`${stack.webUrl}/__timeline-fixture`);
    await expect(page.getByRole('heading', { name: 'Timeline fixture' })).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(600);
    expect(await layoutShift(page)).toBeLessThanOrEqual(0.05);

    await page.goto(`${stack.webUrl}/__timeline-fixture?stream=1`);
    await expect(page.locator('[data-stream-slot="run"]')).toBeVisible();
    await expect(
      page.getByText('The first run appeared with its plan and progress.')
    ).toBeVisible();
    await page.waitForTimeout(600);
    expect(await layoutShift(page)).toBeLessThanOrEqual(0.05);
  } finally {
    await stack.stop();
  }
});
