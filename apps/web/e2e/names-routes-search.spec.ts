import { createCoreClient } from '@openkit/core-client';
import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/** WEB-UX B1: old addresses redirect, and Search never drops a keystroke. */
test.describe.configure({ mode: 'serial' });

const THREAD_NAME = 'Quarterly planning notes';

let stack: IsolatedWebStack | null = null;
let workspaceId = '';
let threadId = '';
let personal = false;

test.beforeAll(async () => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const { items } = await client.operations['workspace.list']({});
  const workspace = items[0]?.workspace;
  if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
  workspaceId = workspace.id;
  personal = items.some(
    (item) =>
      item.workspace.kind === 'personal' && item.isOwner && item.membershipStatus === 'active'
  );
  const thread = await client.operations['thread.create']({
    workspaceId,
    name: THREAD_NAME,
    visibility: 'workspace',
  });
  threadId = thread.id;
});

test.afterAll(async () => {
  await stack?.stop();
  stack = null;
});

function web(path: string): string {
  if (!stack) throw new Error('stack not started');
  return `${stack.webUrl}${path}`;
}

function threadUrl(rest = ''): RegExp {
  const escaped =
    `/w/${encodeURIComponent(workspaceId)}/t/${encodeURIComponent(threadId)}${rest}`.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
  return new RegExp(`${escaped}$`);
}

/** The Thread activity hint React Router stores in `history.state.usr`. */
async function routeActivity(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      (window.history.state as { usr?: { threadActivity?: unknown } } | null)?.usr?.threadActivity
  );
}

async function openApp(page: Page) {
  await page.goto(web('/'));
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
}

test.describe('old routes redirect', () => {
  test('/chat/:w/:t opens the Thread route as a Chat', async ({ page }) => {
    await page.goto(web(`/chat/${workspaceId}/${threadId}?x=1`));
    await expect(page).toHaveURL(threadUrl('?x=1'));
    expect(await routeActivity(page)).toBe('chat');
    await expect(page.getByRole('main').getByText(THREAD_NAME).first()).toBeVisible();
  });

  test('/tasks/:w/:t opens the Thread route as a Task', async ({ page }) => {
    await page.goto(web(`/tasks/${workspaceId}/${threadId}`));
    await expect(page).toHaveURL(threadUrl());
    expect(await routeActivity(page)).toBe('task');
    await expect(page.getByRole('main').getByText(THREAD_NAME).first()).toBeVisible();
  });

  test('/goals/:w/:t and its Artifact review open the Thread route as a Goal', async ({ page }) => {
    await page.goto(web(`/goals/${workspaceId}/${threadId}?card=c-1`));
    await expect(page).toHaveURL(threadUrl('?card=c-1'));
    expect(await routeActivity(page)).toBe('goal');

    await page.goto(web(`/goals/${workspaceId}/${threadId}/artifacts/art-1`));
    await expect(page).toHaveURL(threadUrl('/artifacts/art-1'));
    expect(await routeActivity(page)).toBe('goal');
  });

  test('old addresses keep their letter case, trailing slash, search and hash forms', async ({
    page,
  }) => {
    await page.goto(web(`/chat/${workspaceId}/${threadId}/?item=fixture#anchor`));
    await expect(page).toHaveURL(threadUrl('?item=fixture#anchor'));
    expect(await routeActivity(page)).toBe('chat');
    await expect(page.getByRole('main').getByText(THREAD_NAME).first()).toBeVisible();

    await page.goto(web(`/Tasks/${workspaceId}/${threadId}`));
    await expect(page).toHaveURL(threadUrl());
    expect(await routeActivity(page)).toBe('task');

    await page.goto(web(`/goals/${workspaceId}/${threadId}/artifacts/art-1/`));
    await expect(page).toHaveURL(threadUrl('/artifacts/art-1'));
    expect(await routeActivity(page)).toBe('goal');
  });

  test('/attention opens Needs you', async ({ page }) => {
    await page.goto(web('/attention'));
    await expect(page).toHaveURL(/\/needs-you$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
  });

  test('/chat opens the Personal Assistant, keeping search and hash', async ({ page }) => {
    await page.goto(web('/chat?item=fixture#anchor'));
    if (personal) {
      await expect(page).toHaveURL(/\/w\/[^/]+\/t\/[^/?#]+\?item=fixture#anchor$/);
      expect(await routeActivity(page)).toBe('chat');
    } else {
      await expect(page).toHaveURL(/\/assistant\?item=fixture#anchor$/);
      await expect(page.getByText('Your account has no personal Workspace yet.')).toBeVisible();
    }
  });
});

test.describe('Search palette', () => {
  test('keeps every keystroke typed right after Ctrl K', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+K');
    await page.keyboard.type('Quarterly plan');
    const input = page.getByRole('dialog', { name: 'Search' }).getByRole('searchbox');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Quarterly plan');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden();
  });

  test('keeps every keystroke typed right after a click on the Search row', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.keyboard.type('Quarterly plan');
    const input = page.getByRole('dialog', { name: 'Search' }).getByRole('searchbox');
    await expect(input).toHaveValue('Quarterly plan');
  });

  test('Arrow and Enter open a Thread', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+K');
    await page.keyboard.type('Quarterly');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    const option = dialog.getByRole('menuitem', { name: THREAD_NAME, exact: true });
    await expect(option).toBeVisible();
    // Focus stays in the input; the arrow keys move the virtual focus between results.
    await page.keyboard.press('ArrowDown');
    for (let step = 0; step < 3 && (await option.getAttribute('data-focused')) !== 'true'; step++) {
      await page.keyboard.press('ArrowUp');
    }
    await expect(option).toHaveAttribute('data-focused', 'true');
    await expect(dialog.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(threadUrl());
    await expect(dialog).toBeHidden();
  });

  test('View all results opens the Search page with the query', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+K');
    await page.keyboard.type('Quarterly');
    await page.keyboard.press('Control+Enter');
    await expect(page).toHaveURL(/\/search\?q=Quarterly$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    const result = page.getByRole('link', { name: THREAD_NAME });
    await expect(result).toBeVisible();
    await expect(result.locator('mark')).toHaveText('Quarterly');
    await page.getByRole('button', { name: /Type/ }).click();
    await page.getByRole('option', { name: 'Artifacts', exact: true }).click();
    await expect(page).toHaveURL(/type=artifact/);
    await expect(page.getByRole('link', { name: THREAD_NAME })).toBeHidden();
  });

  test('a phone opens the Search page instead of the palette', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Needs you, not `/`: a phone opens the Personal Assistant from `/`, which would move on.
    await page.goto(web('/needs-you'));
    await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
    await page.keyboard.press('Control+K');
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
  });
});
