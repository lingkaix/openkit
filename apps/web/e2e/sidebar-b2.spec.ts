import { createCoreClient } from '@openkit/core-client';
import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * WEB-UX B2: the sidebar is one creation control, a top block, and one Thread list per
 * Workspace group, with a Task nested under its Goal (ia.md §1).
 *
 * The isolated simulator cannot admit a Goal Task without a coordinator run, and
 * conversation.navigation lists only Threads with activity. So the three Threads are created on
 * the live stack and the browser's conversation.navigation response lists them: one as a Goal and
 * one as its Task through `thread.parentThreadId`, the protocol field Goal Task admission sets.
 * Opening a row reads the real Thread.
 */
test.describe.configure({ mode: 'serial' });

const GOAL = 'Spring launch plan';
const TASK = 'Draft pricing page';
const CHAT = 'Loose ideas';

let stack: IsolatedWebStack | null = null;
let workspaceId = '';
let workspaceName = '';
let goalId = '';
let taskId = '';
let threads: Awaited<
  ReturnType<ReturnType<typeof createCoreClient>['operations']['thread.create']>
>[] = [];

test.beforeAll(async () => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  // A shared Workspace, not the Personal one the shell opens first.
  const { items } = await client.operations['workspace.list']({});
  const workspace = items.find((item) => item.workspace.kind !== 'personal')?.workspace;
  if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
  workspaceId = workspace.id;
  workspaceName = workspace.name;
  const create = (name: string) =>
    client.operations['thread.create']({ workspaceId, name, visibility: 'workspace' });
  threads = [await create(GOAL), await create(TASK), await create(CHAT)];
  goalId = threads[0]!.id;
  taskId = threads[1]!.id;
});

test.afterAll(async () => {
  await stack?.stop();
  stack = null;
});

/** Serves the live navigation rows with the Goal and its Task marked; counts goal.read calls. */
async function prepare(page: Page): Promise<{ goalReads: () => number; groupReads: () => number }> {
  let goalReads = 0;
  let groupReads = 0;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === '/api/app/operations/goal.read') goalReads += 1;
    if (
      pathname === '/api/app/operations/conversation.navigation' &&
      request.postDataJSON()?.workspaceId === workspaceId
    ) {
      groupReads += 1;
    }
  });
  await page.route('**/api/app/operations/conversation.navigation', async (route) => {
    const response = await route.fetch();
    if (route.request().postDataJSON().workspaceId !== workspaceId) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as { items: { thread: { id: string } }[] };
    const ours = new Set(threads.map((thread) => thread.id));
    const items = [
      ...threads.map((thread) => ({
        thread: thread.id === taskId ? { ...thread, parentThreadId: goalId } : thread,
        activity: thread.id === goalId ? 'goal' : thread.id === taskId ? 'task' : 'chat',
        state: 'idle',
        unreadCount: 0,
        lastActivityAt: thread.updatedAt,
      })),
      ...body.items.filter((item) => !ours.has(item.thread.id)),
    ];
    await route.fulfill({ response, json: { ...body, items } });
  });
  return { goalReads: () => goalReads, groupReads: () => groupReads };
}

function rowOf(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

test('desktop: one creation control, one Thread list, a nested Task, no goal.read', async ({
  page,
}) => {
  if (!stack) throw new Error('stack not started');
  await page.setViewportSize({ width: 1280, height: 800 });
  const { goalReads, groupReads } = await prepare(page);
  await page.goto(`${stack.webUrl}/needs-you`);
  const nav = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox())?.width).toBe(240);

  // Top block order (ia.md §1).
  const top = nav.getByRole('button', {
    name: /^(New|Search|Needs you|Personal Assistant|Artifacts|Knowledge|Automations)\b/,
  });
  const names = (await top.allInnerTexts()).map((text) => text.split('\n')[0]?.trim());
  expect(names.slice(0, 7)).toEqual([
    'New',
    'Search',
    'Needs you',
    'Personal Assistant',
    'Artifacts',
    'Knowledge',
    'Automations',
  ]);

  // Exactly one work creation control in persistent chrome; New workspace makes a Workspace.
  const creation = await nav.getByRole('button', { name: /^New\b/ }).allInnerTexts();
  expect(creation.map((text) => text.split('\n')[0]?.trim())).toEqual(['New', 'New workspace']);
  for (const name of ['New Task', 'New Goal', 'New Chat']) {
    await expect(nav.getByRole('button', { name, exact: true })).toHaveCount(0);
  }

  // No section partitioned by type: one group per Workspace with one Thread list.
  const group = nav.getByRole('region', { name: workspaceName, exact: true });
  await expect(group).toBeVisible();
  for (const name of ['Assistant', 'Chats', 'Tasks', 'Goals']) {
    await expect(nav.getByRole('heading', { name, exact: true })).toHaveCount(0);
    await expect(nav.getByRole('region', { name, exact: true })).toHaveCount(0);
  }
  // G5: a closed group reads its Threads only when it opens.
  const header = group.getByRole('button', { name: workspaceName, exact: true });
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  expect(groupReads()).toBe(0);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(group.getByRole('treegrid').or(group.getByRole('tree'))).toHaveCount(1);
  expect(groupReads()).toBeGreaterThan(0);
  // G3: the nesting below comes from conversation.navigation, not goal.read.
  expect(goalReads()).toBe(0);
  await expect(group.getByRole('link', { name: CHAT, exact: true })).toBeVisible();

  // The Task sits under its Goal; the arrow keys expand and collapse it.
  const goal = group.getByRole('link', { name: GOAL, exact: true });
  await expect(rowOf(page, GOAL)).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByRole('link', { name: TASK, exact: true })).toHaveCount(0);
  await goal.click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/t/${goalId}$`));
  await expect(goal).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowRight');
  const task = group.getByRole('link', { name: TASK, exact: true });
  await expect(task).toBeVisible();
  await expect(rowOf(page, GOAL)).toHaveAttribute('aria-expanded', 'true');
  await expect(rowOf(page, TASK)).toHaveAttribute('aria-level', '2');
  const goalBox = await goal.boundingBox();
  const taskBox = await task.boundingBox();
  expect(taskBox!.y).toBeGreaterThan(goalBox!.y);
  expect(taskBox!.x).toBeGreaterThan(goalBox!.x);
  await page.keyboard.press('ArrowLeft');
  await expect(task).toHaveCount(0);
  await expect(rowOf(page, GOAL)).toHaveAttribute('aria-expanded', 'false');

  // Opening the Task keeps its Goal expanded.
  await page.keyboard.press('ArrowRight');
  await task.click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/t/${taskId}$`));
  await expect(task).toHaveAttribute('aria-current', 'page');

  // The group ⋯ menu replaces the switcher pill and the icon grid.
  await group.getByRole('button', { name: `${workspaceName} options`, exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'New Task', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'All', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.keyboard.press('Escape');

  // G3: the sidebar never polls goal.read. The Goal page read it once while it was open;
  // after a reload onto Needs you no further read comes from the sidebar.
  await page.goto(`${stack.webUrl}/needs-you`);
  await expect(group.getByRole('link', { name: GOAL, exact: true })).toBeVisible();
  const settled = goalReads();
  await page.waitForTimeout(3_000);
  expect(goalReads()).toBe(settled);
});

test('phone: the drawer shows the same sidebar content', async ({ page }) => {
  if (!stack) throw new Error('stack not started');
  await page.setViewportSize({ width: 360, height: 800 });
  await prepare(page);
  await page.goto(`${stack.webUrl}/needs-you`);
  await expect(page.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'More', exact: true })
    .click();
  const drawer = page.getByRole('dialog', { name: 'More' });
  for (const name of ['New', 'Search', 'Personal Assistant', 'Artifacts', 'Knowledge']) {
    await expect(drawer.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const group = drawer.getByRole('region', { name: workspaceName, exact: true });
  await group.getByRole('button', { name: workspaceName, exact: true }).click();
  await expect(group.getByRole('link', { name: GOAL, exact: true })).toBeVisible();
  await expect(
    group.getByRole('button', { name: `${workspaceName} options`, exact: true })
  ).toBeVisible();
  await group.getByRole('link', { name: CHAT, exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/t/[^/]+$`));
});
