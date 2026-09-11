import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;

  if (current) {
    await current.stop();
  }
});

/**
 * Minimal L4 smoke: rebuilt shell loads against a live NanoCore and reaches Settings → Debug.
 */
test('loads the rebuilt shell against a live NanoCore', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));

  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(stack.webUrl);

  await expect(page.getByText('OpenKit', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Overview$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  const settings = page.getByRole('button', { name: /^Settings$/ });
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await page.getByRole('button', { name: /^Debug$/ }).click();
  await expect(page.getByRole('heading', { name: 'Debug' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence bundles' })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.viewportWidth);
  expect(runtimeErrors).toEqual([]);
});

/**
 * Shared modal layout keeps an action reachable when dialog content exceeds the viewport.
 */
test('keeps a tall dialog action reachable by normal pointer interaction', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'server', useSimulator: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Dialog Test User');
  await page.getByRole('textbox', { name: 'Email' }).fill('dialog@example.test');
  await page.getByLabel('Password').fill('OpenKit-dialog-test-password-2026!');
  await page.getByRole('button', { name: 'Sign up' }).last().click();
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^Debug$/ }).click();

  const trigger = page.getByRole('button', { name: 'Open dialog' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm change' });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 800, height: 120 });
  const modalBounds = await dialog.locator('..').boundingBox();
  expect(modalBounds).not.toBeNull();
  expect(modalBounds!.y).toBeGreaterThanOrEqual(0);
  expect(modalBounds!.y + modalBounds!.height).toBeLessThanOrEqual(120);
  const action = page.getByRole('button', { name: 'Done' });
  await action.scrollIntoViewIfNeeded();
  const actionBounds = await action.boundingBox();
  expect(actionBounds).not.toBeNull();
  expect(actionBounds!.y).toBeGreaterThanOrEqual(0);
  expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(120);
  await action.click();
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
