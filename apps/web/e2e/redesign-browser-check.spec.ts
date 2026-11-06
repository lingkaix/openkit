import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type CoreClient, createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Browser check for the Web surfaces landed on 2026-11-06.
 * Phone is 390 by 844. Desktop is 1280 by 800. The isolated stack is the
 * existing local fixture. Screenshots are evidence, not a second harness.
 */

const EVIDENCE =
  '/home/simonx/AI/temp/backlog-20261015/evidence/web-redesign/browser-check-20261106';
const PAGED_OPERATIONS = new Set([
  '/api/app/operations/conversation.navigation',
  '/api/app/operations/knowledge.notebook.list',
  '/api/app/operations/notification.list',
]);
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

test('checks the landed surfaces at phone and desktop widths', async ({ page }) => {
  test.setTimeout(360_000);
  await mkdir(EVIDENCE, { recursive: true });
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const seeded = await seedConversationAndKnowledge(client);
  await installSmallPageLimit(page);

  const defects: string[] = [];
  const notes: string[] = [];

  async function shot(name: string) {
    await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  }

  async function check(name: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      defects.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(stack.webUrl);
    await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
    const phone = viewport.name === 'phone';

    await check(`${viewport.name} section bar`, async () => {
      const sections = page.getByRole('navigation', { name: 'Sections' });
      const sidebar = page.getByRole('navigation', { name: 'Primary workspace navigation' });
      if (phone) {
        await expect(sections.getByRole('button')).toHaveCount(5);
        await expect(sidebar).toHaveCount(0);
        for (const label of ['Assistant', 'Work', 'Knowledge', 'Artifacts', 'More']) {
          const button = sections.getByRole('button', { name: label, exact: true });
          const box = await button.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        }
      } else {
        await expect(sections).toHaveCount(0);
        await expect(sidebar).toBeVisible();
      }
      const overflow = await horizontalOverflow(page);
      expect(overflow).toBeLessThanOrEqual(1);
      await shot(`${viewport.name}-section-bar`);
    });

    await check(`${viewport.name} more drawer`, async () => {
      if (!phone) {
        await expect(
          page.getByRole('button', { name: 'Action Center', exact: true })
        ).toBeVisible();
        await shot(`${viewport.name}-more-drawer`);
        return;
      }
      await expect(page.getByText('Loading Assistant…')).toBeHidden({ timeout: 20_000 });
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('button', { name: 'More', exact: true })
        .click();
      const drawer = page.getByRole('dialog', { name: 'More' });
      await shot(`${viewport.name}-more-drawer`);
      await expect(drawer.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(drawer.getByRole('button', { name: /^Action Center/ })).toBeVisible();
      await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
      await expect(drawer).toBeHidden();
    });

    await check(`${viewport.name} sandbox select`, async () => {
      if (phone) {
        await page
          .getByRole('navigation', { name: 'Sections' })
          .getByRole('button', { name: 'Work', exact: true })
          .click();
        await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
      }
      await page.getByRole('button', { name: 'New Task', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      const sandbox = dialog.getByRole('button', { name: /Sandbox/ });
      await expect(sandbox).toBeVisible();
      const box = await sandbox.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await sandbox.click();
      await expect(page.getByRole('option', { name: 'Fresh', exact: true })).toBeVisible();
      await shot(`${viewport.name}-sandbox-select`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await check(`${viewport.name} conversation load more`, async () => {
      const recent = page
        .getByRole('main')
        .locator('section')
        .filter({ has: page.getByText('Recent', { exact: true }) });
      await proveContinuation(page, {
        pathname: '/api/app/operations/conversation.navigation',
        ready: async () => {
          await page.goto(`${stack!.webUrl}/chat`);
          await expect(page.getByRole('heading', { name: 'What can we get done?' })).toBeVisible();
        },
        button: () => recent.getByRole('button', { name: 'Load more', exact: true }),
        names: async () =>
          (await recent.getByRole('button').allTextContents())
            .map((name) => name.trim())
            .filter((name) => name.length > 0 && name !== 'Load more'),
      });
      notes.push(`${viewport.name} conversation: page 2 appended`);
      await shot(`${viewport.name}-conversation-load-more`);
    });

    await check(`${viewport.name} governance usage`, async () => {
      const usage = readCursors(page, '/api/app/operations/usage.read');
      const audit = readCursors(page, '/api/app/operations/audit.workspace-list');
      const permission = readCursors(page, '/api/app/operations/permission.workspace-list');
      await page.goto(`${stack!.webUrl}/workspace/usage`);
      await expect(page.getByRole('heading', { name: 'Usage & audit', exact: true })).toBeVisible();
      await expectLoadMoreMatchesCursor(page, 'Load more', [
        ...(await usage),
        ...(await audit),
        ...(await permission),
      ]);
      await shot(`${viewport.name}-governance-usage`);
    });

    await check(`${viewport.name} governance server audit`, async () => {
      const audit = readCursors(page, '/api/app/operations/audit.server-list');
      const permission = readCursors(page, '/api/app/operations/permission.server-list');
      await page.goto(`${stack!.webUrl}/settings/server-audit`);
      await expect(page.getByRole('heading', { name: 'Server audit', exact: true })).toBeVisible();
      await expectLoadMoreMatchesCursor(page, 'Load more', [
        ...(await audit),
        ...(await permission),
      ]);
      await shot(`${viewport.name}-governance-audit`);
    });

    await check(`${viewport.name} knowledge list`, async () => {
      const pages = page.getByRole('list', { name: 'Pages' });
      await proveContinuation(page, {
        pathname: '/api/app/operations/knowledge.notebook.list',
        ready: async () => {
          await page.goto(`${stack!.webUrl}/knowledge`);
          await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
        },
        button: () => page.getByRole('button', { name: 'Load earlier', exact: true }),
        names: async () =>
          (await pages.locator('.knowledge-ui-title').allTextContents()).map((name) => name.trim()),
      });
      notes.push(`${viewport.name} knowledge: page 2 appended`);
      await shot(`${viewport.name}-knowledge-list`);
    });

    await check(`${viewport.name} administration sandboxes`, async () => {
      await page.goto(`${stack!.webUrl}/settings/administration`);
      await expect(
        page.getByRole('heading', { name: 'Administration', exact: true })
      ).toBeVisible();
      await expect(page.getByText(/retained Sandboxes/)).toBeVisible();
      await expect(page.getByText('Worker environment', { exact: true })).toHaveCount(0);
      const sandboxes = page.getByRole('heading', { name: 'Sandboxes', exact: true });
      if ((await sandboxes.count()) > 0) await expect(sandboxes).toBeVisible();
      await shot(`${viewport.name}-sandboxes`);
    });

    await check(`${viewport.name} gateway family`, async () => {
      const diagnostics = await client.operations['diagnostics.app']({});
      const model = diagnostics.gateway.models.find((item) => item.displayName === 'Reasoning');
      if (!model) throw new Error('The fixture has no Reasoning logical model.');
      const published = Object.hasOwn(model.contract ?? {}, 'modelFamilyId')
        ? model.contract?.modelFamilyId
        : Object.hasOwn(model, 'modelFamilyId')
          ? model.modelFamilyId
          : undefined;
      const expected =
        published === undefined
          ? 'Family unknown'
          : published === null
            ? 'mixed'
            : `Family ${published}`;
      await page.goto(`${stack!.webUrl}/settings/gateway`);
      const card = page.getByRole('region', { name: 'Reasoning' });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Contract', exact: true }).click();
      await expect(card.getByText(expected, { exact: true })).toBeVisible();
      notes.push(`${viewport.name} gateway family: ${expected}`);
      await shot(`${viewport.name}-gateway-family`);
    });
  }

  await check('notification list', async () => {
    await seedNotifications(client, seeded.workspaceId);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const region = page.getByRole('region', { name: 'Notification deliveries' });
      const phoneList = viewport.name === 'phone';
      await proveContinuation(page, {
        pathname: '/api/app/operations/notification.list',
        ready: async () => {
          await page.goto(`${stack!.webUrl}/settings/channels`);
          await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
          if (!phoneList) {
            await region.getByRole('button', { name: 'Records', exact: true }).click();
          }
        },
        button: () => region.getByRole('button', { name: 'Load more', exact: true }),
        names: async () =>
          phoneList
            ? distinctLabels(
                (
                  await region
                    .locator('p')
                    .filter({ hasText: 'an attention link' })
                    .allTextContents()
                ).map((name) => name.trim())
              )
            : region
                .getByRole('link', { name: 'Inspect request' })
                .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? '')),
      });
      notes.push(`${viewport.name} notification: page 2 appended`);
      await shot(`${viewport.name}-notification-list`);
    }
  });

  await check('toast', async () => {
    // The local fixture does not publish a goal or task handoff. The design
    // has no toast for a same-thread send, so this check measures the toast
    // primitive on Debug and confirms a thread page queues none.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${stack!.webUrl}/tasks/${seeded.workspaceId}/${seeded.threadId}`);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeVisible();
    await expect(page.locator('.ok-toast')).toHaveCount(0);
    await page.goto(`${stack!.webUrl}/settings/debug`);
    const toast = page.locator('.ok-toast', { hasText: 'Scout finished the teardown.' });
    await toast.scrollIntoViewIfNeeded();
    await expect(toast).toBeVisible();
    const action = toast.getByRole('button', { name: 'View', exact: true });
    const actionBox = await action.boundingBox();
    expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(actionBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    await shot('phone-toast');
    await page.setViewportSize({ width: 1280, height: 800 });
    await toast.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    const desktopBox = await action.boundingBox();
    expect(desktopBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(desktopBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    await shot('desktop-toast');
    notes.push(
      'toast: finding, the fixture cannot hand off; Debug primitive View is 44px; a thread page queues no toast'
    );
  });

  await check('offline banner and composer', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(stack!.webUrl);
    await expect(page.getByRole('button', { name: 'Personal Assistant', exact: true })).toBeVisible(
      {
        timeout: 20_000,
      }
    );
    await page.getByRole('button', { name: 'Personal Assistant', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await page.context().setOffline(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('Last opened on this device.', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('OpenKit needs a connection.')).toBeVisible();
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await shot('phone-offline');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText('Last opened on this device.', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('OpenKit needs a connection.')).toBeVisible();
    await shot('desktop-offline');
    await page.context().setOffline(false);
  });

  test.info().annotations.push({ type: 'notes', description: notes.join(' | ') });
  expect(defects, defects.join('\n')).toEqual([]);
});

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

function readCursors(page: Page, pathname: string): Promise<unknown[]> {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === pathname,
      { timeout: 15_000 }
    )
    .then(async (response) => {
      const body = (await response.json()) as { nextCursor?: unknown };
      return [body.nextCursor ?? null];
    })
    .catch(() => ['missing']);
}

async function expectLoadMoreMatchesCursor(page: Page, name: string, cursors: unknown[]) {
  const continued = cursors.some((cursor) => typeof cursor === 'string' && cursor.length > 0);
  const button = page.getByRole('main').getByRole('button', { name, exact: true });
  if (continued) await expect(button.first()).toBeVisible();
  else await expect(button).toHaveCount(0);
}

/** Rewrites only this spec's page size. The published clients keep limit 50. */
async function installSmallPageLimit(page: Page) {
  await page.route('**/api/app/operations/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'POST' || !PAGED_OPERATIONS.has(pathname)) {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as { limit?: unknown } | null;
    if (!body || body.limit !== 50) {
      await route.continue();
      return;
    }
    await route.continue({ postData: JSON.stringify({ ...body, limit: 2 }) });
  });
}

async function seedConversationAndKnowledge(client: CoreClient) {
  const { items } = await client.operations['workspace.list']({});
  const workspace =
    items.find((item) => item.workspace.kind === 'personal')?.workspace ?? items[0]?.workspace;
  if (!workspace) throw new Error('The fixture has no workspace.');
  const created = await Promise.all(
    ['Paging alpha', 'Paging bravo', 'Paging charlie'].map((name) =>
      client.operations['thread.create']({
        workspaceId: workspace.id,
        name,
        visibility: 'workspace',
      })
    )
  );
  for (const [path, title] of [
    ['notes/aa-page.md', 'Alpha note'],
    ['notes/bb-page.md', 'Bravo note'],
    ['notes/cc-page.md', 'Charlie note'],
  ] as const) {
    const listed = await client.operations['knowledge.notebook.list']({
      workspaceId: workspace.id,
    });
    await client.operations['knowledge.notebook.create']({
      requestId: createRequestId(),
      workspaceId: workspace.id,
      baseRevision: listed.notebookRevision,
      path,
      content: knowledgePage(workspace.id, title),
      summary: `Create ${title}`,
    });
  }
  const navigation = await client.operations['conversation.navigation']({
    workspaceId: workspace.id,
    limit: 2,
  });
  if (typeof navigation.nextCursor !== 'string' || navigation.nextCursor.length === 0) {
    throw new Error('Conversation fixture has no second page.');
  }
  const notebook = await client.operations['knowledge.notebook.list']({
    workspaceId: workspace.id,
    limit: 2,
  });
  if (typeof notebook.nextCursor !== 'string' || notebook.nextCursor.length === 0) {
    throw new Error('Knowledge fixture has no second page.');
  }
  const threadId = created[0]?.id;
  if (!threadId) throw new Error('Conversation fixture did not create a thread.');
  return { workspaceId: workspace.id, threadId };
}

async function seedNotifications(client: CoreClient, workspaceId: string) {
  const threads = await Promise.all(
    ['Notice one', 'Notice two', 'Notice three'].map((name) =>
      client.operations['thread.create']({ workspaceId, name, visibility: 'workspace' })
    )
  );
  await Promise.all(
    threads.map((thread) =>
      client.operations['turn.start']({
        workspaceId,
        threadId: thread.id,
        agentId: 'agent_codex_host',
        modelId: 'reasoning',
        input: 'Raise the deterministic simulator question for the notification page.',
      })
    )
  );
  await expect
    .poll(
      async () => {
        const listed = await client.operations['notification.list']({ limit: 2 });
        return typeof listed.nextCursor === 'string' && listed.nextCursor.length > 0;
      },
      { timeout: 60_000, message: 'Notification fixture has no second page.' }
    )
    .toBe(true);
}

function knowledgePage(workspaceId: string, title: string): string {
  return [
    '---',
    'type: KnowledgePage',
    `title: ${title}`,
    'schema_version: openkit-scope-knowledge-schema-v4',
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_status: active',
    'status: stable',
    `scope: {kind: workspace, workspaceId: ${workspaceId}}`,
    'source_refs: []',
    'review_state: user-authored',
    'sensitivity: normal',
    'freshness: current',
    'created_at: 2026-11-06T00:00:00.000Z',
    'updated_at: 2026-11-06T00:00:00.000Z',
    '---',
    title,
    '',
  ].join('\n');
}

async function proveContinuation(
  page: Page,
  input: {
    pathname: string;
    ready: () => Promise<void>;
    button: () => Locator;
    names: () => Promise<string[]>;
  }
) {
  const first = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === input.pathname &&
      response.ok(),
    { timeout: 20_000 }
  );
  await input.ready();
  const opened = (await (await first).json()) as { nextCursor?: unknown };
  expect(typeof opened.nextCursor).toBe('string');
  const cursor = opened.nextCursor as string;
  const control = input.button();
  await expect(control).toBeVisible();
  const before = await input.names();
  expect(before.length).toBeGreaterThan(0);
  expect(new Set(before).size).toBe(before.length);
  const continued = page.waitForRequest((request) => {
    if (request.method() !== 'POST') return false;
    if (new URL(request.url()).pathname !== input.pathname) return false;
    const payload = request.postDataJSON() as { cursor?: unknown };
    return payload.cursor === cursor;
  });
  const second = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST' || !response.ok()) return false;
    if (new URL(response.url()).pathname !== input.pathname) return false;
    const payload = response.request().postDataJSON() as { cursor?: unknown };
    return payload.cursor === cursor;
  });
  await control.click();
  await continued;
  const pageTwo = (await (await second).json()) as { nextCursor?: unknown };
  expect(pageTwo.nextCursor ?? null).toBeNull();
  await expect(control).toHaveCount(0);
  const after = await input.names();
  expect(after.length).toBeGreaterThan(before.length);
  expect(new Set(after).size).toBe(after.length);
  for (const name of before) expect(after).toContain(name);
}

/** Keeps repeated sentences distinct so one clock second does not collapse two rows. */
function distinctLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}
