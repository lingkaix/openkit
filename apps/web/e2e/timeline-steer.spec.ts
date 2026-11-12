import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreClient } from '@openkit/core-client';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

// Screenshots are evidence, not assertions. Set OPENKIT_E2E_SHOTS_DIR to keep them.
const SHOTS =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-steer');

const NOTE = 'Bring the note into this run.';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('shows steer outcomes from the retained receipt on desktop and a phone', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  try {
    for (const viewport of [
      { width: 1280, height: 800, suffix: 'desktop' },
      { width: 360, height: 740, suffix: '360' },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${stack.webUrl}/__steer-fixture`);
      await expect(page.getByRole('heading', { name: 'Steer fixture' })).toBeVisible();
      await expect(page.getByText(/Sends this note into the run in progress/)).toBeVisible();
      await page.getByRole('textbox', { name: 'Message' }).fill(NOTE);
      await page.screenshot({ path: join(SHOTS, `offer-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);
      await page.getByRole('button', { name: 'Steer' }).click();
      await expect(page.getByText('Accepted by the running worker')).toBeVisible();
      const requestId = await page
        .locator('[data-steer-state="accepted"]')
        .getAttribute('data-request-id');
      const stored = await page
        .locator('[data-steer-state="accepted"]')
        .getAttribute('data-steer-text');
      expect(requestId).toBeTruthy();
      expect(stored).toBe(NOTE);
      await page.reload();
      await expect(page.getByText('Accepted by the running worker')).toBeVisible();
      await expect(page.locator('[data-steer-state="accepted"]')).toHaveAttribute(
        'data-request-id',
        requestId!
      );
      const second = await browser.newContext({ viewport });
      const other = await second.newPage();
      try {
        await other.goto(page.url());
        await expect(other.getByText('Accepted by the running worker')).toBeVisible();
        await expect(other.locator('[data-steer-state="accepted"]')).toHaveAttribute(
          'data-request-id',
          requestId!
        );
      } finally {
        await second.close();
      }
      await page.screenshot({ path: join(SHOTS, `accepted-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);

      await page.goto(
        `${stack.webUrl}/__steer-fixture?scene=not-delivered&text=${encodeURIComponent(NOTE)}&requestId=req_kept`
      );
      await expect(page.getByText('Not delivered')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(NOTE);
      await expect(page.locator('[data-steer-state="not-delivered"]')).toHaveAttribute(
        'data-request-id',
        'req_kept'
      );
      await page.screenshot({ path: join(SHOTS, `not-delivered-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);

      await page.goto(
        `${stack.webUrl}/__steer-fixture?scene=unknown&text=${encodeURIComponent(NOTE)}&requestId=req_unknown`
      );
      await expect(page.getByText('Delivery unknown')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Check' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(NOTE);
      await page.screenshot({ path: join(SHOTS, `unknown-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);

      await page.goto(`${stack.webUrl}/__steer-fixture?scene=unqualified`);
      await expect(page.getByText("This worker can't take notes while running.")).toBeVisible();
      await expect(page.getByRole('button', { name: 'Keep draft' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
      await page.getByRole('textbox', { name: 'Message' }).fill(NOTE);
      await page.getByRole('button', { name: 'Keep draft' }).click();
      await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(NOTE);
      await expect(page).toHaveURL(/scene=unqualified/);
      await page.screenshot({ path: join(SHOTS, `unqualified-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);
    }
  } finally {
    await stack.stop();
  }
});

test('does not call task.steer when the running worker is not qualified', async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const steered: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('task.steer')) steered.push(request.url());
  });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Steer run',
      visibility: 'workspace',
      requestId: randomUUID(),
    });
    const requestId = randomUUID();
    const started = await page.request.post(`${stack.coreUrl}/api/app/operations/task.start`, {
      headers: { 'x-openkit-request-id': requestId },
      data: {
        workspaceId: workspace.id,
        threadId: thread.id,
        input: 'Keep this run on screen.',
        requestId,
      },
    });
    expect(started.status(), await started.text()).toBe(202);
    await page.goto(`${stack.webUrl}/tasks/${workspace.id}/${thread.id}`);
    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill(NOTE);
    const keep = page.getByRole('button', { name: 'Keep draft' });
    if (await keep.isVisible().catch(() => false)) {
      await keep.click();
      await expect(input).toHaveValue(NOTE);
    }
    await expect(page.getByText('Waiting for this run to end')).toHaveCount(0);
    expect(steered).toEqual([]);
  } finally {
    await stack.stop();
  }
});
