import { allocateEntityId } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import {
  completeServerBootstrap,
  type IsolatedWebStack,
  startIsolatedWebStack,
} from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

/** Oversized conversation hints must fit the viewport without intercepting adjacent rows. */
test('contains long conversation previews and keeps the next row clickable', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const threadIds = [allocateEntityId('th'), allocateEntityId('th')];
  const title = `Improve the observed retained_baseline_conflict ${'VeryLongUnbrokenTaskIdentifier'.repeat(80)}`;
  await page.route('**/api/app/operations/conversation.navigation', async (route) => {
    const workspaceId = route.request().postDataJSON().workspaceId;
    await route.fulfill({
      json: {
        items: [title, 'Next conversation'].map((name, index) => ({
          thread: {
            id: threadIds[index],
            owner: { kind: 'workspace', workspaceId: workspaceId },
            name,
            preview: 'Conversation preview',
            status: 'active',
            entryPath: 'conversation',
            visibility: 'workspace',
            createdAt: '2026-09-18T00:00:00.000Z',
            updatedAt: '2026-09-18T00:00:00.000Z',
          },
          activity: index === 0 ? 'goal' : 'chat',
          state: 'idle',
          unreadCount: 0,
          lastActivityAt: '2026-09-18T00:00:00.000Z',
        })),
      },
    });
  });
  await page.setViewportSize({ width: 824, height: 803 });
  await page.goto(stack.webUrl);
  const row = page.getByRole('button', { name: title, exact: true });
  // A second chat is the one Assistant row. Its button label is Personal Assistant.
  const next = page.getByRole('button', { name: 'Personal Assistant', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  const expander = page.getByRole('button', { name: `Show tasks for ${title}`, exact: true });
  await expect(row).toBeVisible();
  await expect(expander).toBeVisible();
  const navigationBounds = await navigation.boundingBox();
  const expanderBounds = await expander.boundingBox();
  expect(navigationBounds).not.toBeNull();
  expect(expanderBounds).not.toBeNull();
  expect(expanderBounds!.x).toBeGreaterThanOrEqual(navigationBounds!.x);
  expect(expanderBounds!.x + expanderBounds!.width).toBeLessThanOrEqual(
    navigationBounds!.x + navigationBounds!.width
  );
  const navigationOverflow = await navigation.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(navigationOverflow.scroll).toBeLessThanOrEqual(navigationOverflow.client);
  await page.mouse.move(824 - 20, 100);
  await row.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.boundingBox();
  expect(bounds!.height).toBeLessThan(160);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(824);
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
  await expect(page).toHaveURL(new RegExp(`/chat/[^/]+/${threadIds[1]}$`));

  // Below 800px the sidebar is replaced by the phone row; the Goal list is under Work.
  await page.setViewportSize({ width: 600, height: 803 });
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await expect(row).toBeVisible();
  await expect(expander).toBeVisible();
  const phoneRowBounds = await row.boundingBox();
  expect(phoneRowBounds).not.toBeNull();
  expect(phoneRowBounds!.x).toBeGreaterThanOrEqual(0);
  expect(phoneRowBounds!.x + phoneRowBounds!.width).toBeLessThanOrEqual(600);
  await page.mouse.move(600 - 20, 100);
  await row.hover();
  await expect(tooltip).toBeVisible();
  const phoneTooltipBounds = await tooltip.boundingBox();
  expect(phoneTooltipBounds!.x).toBeGreaterThanOrEqual(0);
  expect(phoneTooltipBounds!.x + phoneTooltipBounds!.width).toBeLessThanOrEqual(600);
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

  await expect(page.getByRole('img', { name: 'OpenKit', exact: true })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Action Center$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Action Center' })).toBeVisible();

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
 * Narrow workbench: no minimum floor, phone row below 800px, persistent nav at 800px.
 */
test('keeps Settings and Chat usable at 600 and 742 without page overflow', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });

  await page.setViewportSize({ width: 600, height: 600 });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  const phoneDestinations = page.getByRole('navigation').getByRole('button');
  await expect(phoneDestinations).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Work', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toHaveCount(0);
  let overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.setViewportSize({ width: 360, height: 640 });
  await expect(phoneDestinations).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Artifacts', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toHaveCount(0);
  overflow = await pageOverflow(page);
  expect(overflow.viewportWidth).toBeLessThanOrEqual(360);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  await page.setViewportSize({ width: 600, height: 600 });

  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();

  await more.click();
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(dialog).toBeHidden();

  await more.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();

  await page.goto(`${stack.webUrl}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(more).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.goto(`${stack.webUrl}/chat`);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.setViewportSize({ width: 742, height: 600 });
  await page.goto(`${stack.webUrl}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(more).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.goto(`${stack.webUrl}/chat`);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await more.click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  overflow = await pageOverflow(page);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  await page.setViewportSize({ width: 600, height: 600 });
  await expect(phoneDestinations).toHaveCount(5);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/**
 * Shared modal layout keeps an action reachable when dialog content exceeds the viewport.
 */
test('keeps a tall dialog action reachable by normal pointer interaction', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'server', useSimulator: true });
  await page.setViewportSize({ width: 800, height: 600 });
  // Wait for actual browser admission before checking the unauthenticated account surface.
  const admission = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/app/operations/workspace.list') &&
      response.request().method() === 'POST'
  );
  await page.goto(stack.webUrl);
  expect((await admission).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
  const owner = {
    email: 'dialog@example.test',
    name: 'Dialog Test User',
    password: 'OpenKit-dialog-test-password-2026!',
  };
  await completeServerBootstrap(stack, owner);
  await page.getByRole('textbox', { name: 'Email' }).fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  // Start the layout assertion after account creation, as in the account-sharing fixture.
  const signInResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/sign-in/email') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  expect((await signInResponse).status()).toBe(200);
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
