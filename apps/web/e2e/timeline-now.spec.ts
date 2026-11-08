import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/**
 * U2 and U4 on a fixture with several decisions.
 * Idle motion is empty. Reduced motion stays empty even while the Now dot is marked live.
 */
test('keeps emphasis within three and stays still when idle or reduced', async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  try {
    await page.goto(`${stack.webUrl}/__timeline-fixture`);
    await expect(page.getByRole('heading', { name: 'Timeline fixture' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(4);
    expect(await page.locator('[data-emphasis]').count()).toBeLessThanOrEqual(3);
    const accepted = page.getByText('Run accepted');
    await expect(accepted).toBeVisible();
    expect(
      await accepted.locator('xpath=ancestor-or-self::*[contains(@class, "bg-notice")]').count()
    ).toBe(0);
    await expect(page.locator('time[datetime]').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${stack.webUrl}/__timeline-fixture?motion=live`);
    await expect(page.locator('.ok-now-dot[data-live="true"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  } finally {
    await stack.stop();
  }
});
