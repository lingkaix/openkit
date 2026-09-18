import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

/** Oversized conversation hints must fit the viewport without intercepting adjacent rows. */
test('contains long conversation previews and keeps the next row clickable', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const title = `Improve the observed retained_baseline_conflict ${'VeryLongUnbrokenTaskIdentifier'.repeat(80)}`;
  await page.route('**/api/app/workspaces/*/conversations', async (route) => {
    const workspaceId = new URL(route.request().url()).pathname.split('/')[4]!;
    await route.fulfill({
      json: {
        items: [title, 'Next conversation'].map((name, index) => ({
          thread: {
            id: `th_preview_${index}`,
            workspaceId,
            name,
            preview: 'Conversation preview',
            status: 'active',
            entryPath: 'conversation',
            visibility: 'workspace',
            createdAt: '2026-09-18T00:00:00.000Z',
            updatedAt: '2026-09-18T00:00:00.000Z',
          },
          activity: 'chat',
          state: 'idle',
          lastActivityAt: '2026-09-18T00:00:00.000Z',
        })),
      },
    });
  });
  await page.setViewportSize({ width: 824, height: 803 });
  await page.goto(stack.webUrl);
  const row = page.getByRole('button', { name: title, exact: true });
  const next = page.getByRole('button', { name: 'Next conversation', exact: true });
  for (const width of [824, 600]) {
    await page.setViewportSize({ width, height: 803 });
    if (width < 800) await page.getByRole('button', { name: 'Navigation', exact: true }).click();
    await expect(row).toBeVisible();
    await page.mouse.move(width - 20, 100);
    await row.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds!.height).toBeLessThan(160);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(803);
    await expect(tooltip).toHaveCSS('pointer-events', 'none');
    const hit = await next.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      );
    });
    expect(hit).toBe(true);
    await next.click({ timeout: 2000 });
    await expect(page).toHaveURL(/\/chat\/[^/]+\/th_preview_1$/);
  }
});

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

  const sidebar = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  const sidebarSize = await sidebar.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(sidebarSize.width).toBe(264);
  expect(sidebarSize.scroll).toBeLessThanOrEqual(sidebarSize.client);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Search', exact: true })).toBeVisible();
  const searchSize = await sidebar.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(searchSize.scroll).toBeLessThanOrEqual(searchSize.client);
  await page.keyboard.press('Escape');

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
 * Reads page-level horizontal overflow against the current viewport.
 *
 * @param page Playwright page under test.
 */
async function pageOverflow(page: Page) {
  return page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
}

/**
 * Narrow workbench: 600×600 floor, overlay drawer below 800px, persistent nav at 800px.
 */
test('keeps Settings and Chat usable at 600 and 742 without page overflow', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });

  await page.setViewportSize({ width: 600, height: 600 });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  let overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  const opener = page.getByRole('button', { name: 'Navigation' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Navigation' });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(dialog).toBeHidden();

  await opener.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();

  await page.goto(`${stack.webUrl}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.goto(`${stack.webUrl}/chat`);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.setViewportSize({ width: 742, height: 600 });
  await page.goto(`${stack.webUrl}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.goto(`${stack.webUrl}/chat`);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await opener.click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toHaveCount(0);
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.setViewportSize({ width: 600, height: 600 });
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Navigation' })).toBeVisible();
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
