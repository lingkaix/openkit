import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

/**
 * Phone width covers the five section buttons, one opened thread, Gateway, and Knowledge.
 * The phone row has no Personal Assistant control. That existing sidebar entry opens the
 * thread, and the opened thread is then shown at 360 by 800.
 */
test('opens one thread, Gateway, and Knowledge at 360 by 800', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Action Center', exact: true })).toBeVisible();

  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveCount(5);
  await sections.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Action Center', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Action Center/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Action Center', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(sections.getByRole('button', { name: 'More', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 824, height: 800 });
  const opening = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/thread.create' && response.ok()
  );
  await page.getByRole('button', { name: 'Personal Assistant', exact: true }).click();
  await opening;
  await expect(page).toHaveURL(/\/chat\/[^/]+\/[^/]+$/);

  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole('heading', { name: 'Assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  const more = sections.getByRole('button', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await more.click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Gateway', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/gateway$/);
});
