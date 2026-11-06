import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Browser check for the Web surfaces landed on 2026-11-06.
 * Phone is 390 by 844. Desktop is 1280 by 800. The isolated stack is the
 * existing local fixture. Screenshots are evidence, not a second harness.
 */

const EVIDENCE =
  '/home/simonx/AI/temp/backlog-20261015/evidence/web-redesign/browser-check-20261106';
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
      const cursors = readCursors(page, '/api/app/operations/conversation.navigation');
      await page.goto(phone ? `${stack!.webUrl}/attention` : stack!.webUrl);
      await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
      const seen = await cursors;
      const continued = seen.some((cursor) => typeof cursor === 'string' && cursor.length > 0);
      const loadMore = page.getByRole('button', { name: 'Load more', exact: true }).first();
      if (!continued) {
        await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
        notes.push(`${viewport.name} conversation: no next cursor`);
      } else {
        await expect(loadMore).toBeVisible({ timeout: 20_000 });
        const next = page.waitForRequest((request) => {
          if (request.method() !== 'POST') return false;
          if (new URL(request.url()).pathname !== '/api/app/operations/conversation.navigation')
            return false;
          const body = request.postDataJSON() as { cursor?: unknown; limit?: unknown };
          return body.limit === 50 && typeof body.cursor === 'string' && body.cursor.length > 0;
        });
        await loadMore.click();
        await next;
      }
      await shot(`${viewport.name}-conversation-load-more`);
    });

    await check(`${viewport.name} notification list`, async () => {
      const cursors = readCursors(page, '/api/app/operations/notification.list');
      await page.goto(`${stack!.webUrl}/settings/channels`);
      await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
      await expectLoadMoreMatchesCursor(page, 'Load more', await cursors);
      await shot(`${viewport.name}-notification-list`);
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
      const cursors = readCursors(page, '/api/app/operations/knowledge.notebook.list');
      await page.goto(`${stack!.webUrl}/knowledge`);
      await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
      await expectLoadMoreMatchesCursor(page, 'Load earlier', await cursors);
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

    await check(`${viewport.name} toast`, async () => {
      await expect(page.locator('.ok-toast')).toHaveCount(0);
      notes.push(`${viewport.name} toast: no product action queues a toast`);
      await shot(`${viewport.name}-toast`);
    });
  }

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
  const button = page.getByRole('button', { name, exact: true });
  if (continued) await expect(button.first()).toBeVisible();
  else await expect(button).toHaveCount(0);
}
