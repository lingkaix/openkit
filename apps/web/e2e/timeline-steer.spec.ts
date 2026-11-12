import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineResponseSchema, type TimelineItem } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
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
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Steer receipt',
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
    const taskUrl = `${stack.webUrl}/tasks/${workspace.id}/${thread.id}`;
    const userId = allocateEntityId('usr');
    const turnId = allocateEntityId('tu');
    const itemId = allocateEntityId('it');
    const latestTurnId = allocateEntityId('tu');
    const latestItemId = allocateEntityId('it');
    const value = ItemSchema.parse({
      id: itemId,
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: userId },
      text: NOTE,
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    const latestValue = ItemSchema.parse({
      id: latestItemId,
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId: latestTurnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'Latest window has no receipt line',
      createdAt: '2026-11-08T12:00:01.000Z',
      completedAt: '2026-11-08T12:00:01.000Z',
    });
    let delivery: 'accepted' | 'not-delivered' | 'unknown' = 'accepted';
    const requestFor = {
      accepted: 'req_accepted',
      'not-delivered': 'req_kept',
      unknown: 'req_unknown',
    } as const;
    const steered = (state: typeof delivery): TimelineItem => ({
      id: itemId,
      turnId,
      type: 'user-message',
      placement: 'narrative',
      status: 'completed',
      createdAt: value.createdAt,
      completedAt: value.completedAt,
      actor: value.actor ?? null,
      detail: { kind: 'complete', value },
      steer: { requestId: requestFor[state], state, reason: null },
    });
    const latestItem: TimelineItem = {
      id: latestItemId,
      turnId: latestTurnId,
      type: 'assistant-message',
      placement: 'narrative',
      status: 'completed',
      createdAt: latestValue.createdAt,
      completedAt: latestValue.completedAt,
      actor: null,
      detail: { kind: 'complete', value: latestValue },
      steer: null,
    };
    const shell = {
      workspaceId: workspace.id,
      threadId: thread.id,
      view: 'runs' as const,
      items: [] as TimelineItem[],
      beforeCursor: null,
      itemWindow: null,
      restrictedReferences: false,
      digest: { lines: [], coverage: 'complete' as const },
    };
    const fulfill = async (target: Page) => {
      await target.route('**/api/app/operations/thread.timeline', async (route) => {
        const request = route.request().postDataJSON() as {
          anchor?: { kind?: string };
          cursor?: string;
        };
        const latest = request.anchor?.kind === 'latest';
        const payload = ThreadTimelineResponseSchema.parse(
          latest
            ? {
                ...shell,
                runs: [
                  {
                    id: latestTurnId,
                    admissionOrder: 1,
                    status: 'completed',
                    triggerActor: { kind: 'user', id: userId },
                    agentId: null,
                    triggerSource: null,
                    startedAt: '2026-11-08T12:00:00.000Z',
                    completedAt: '2026-11-08T12:00:01.000Z',
                    durationMs: 1000,
                    error: null,
                    long: false,
                    narrative: [latestItem],
                    plan: null,
                    noteItemIds: [],
                    finalItemId: null,
                    narrativeCursor: null,
                    statistics: {
                      steps: 0,
                      failedStepCount: 0,
                      failedCommandCount: 0,
                      filesChanged: 0,
                      messages: 1,
                      itemCounts: {},
                      coverage: 'complete',
                    },
                    interruptedBy: { visibility: 'available', actor: null },
                    restrictedReferences: false,
                  },
                ],
                afterCursor: null,
                anchor: null,
                catchUpAnchor: null,
              }
            : {
                ...shell,
                runs: [
                  {
                    id: turnId,
                    admissionOrder: 2,
                    status: 'running',
                    triggerActor: { kind: 'user', id: userId },
                    agentId: null,
                    triggerSource: null,
                    startedAt: '2026-11-08T12:00:00.000Z',
                    completedAt: null,
                    durationMs: null,
                    error: null,
                    long: false,
                    narrative: [steered(delivery)],
                    plan: null,
                    noteItemIds: [],
                    finalItemId: null,
                    narrativeCursor: null,
                    statistics: {
                      steps: 0,
                      failedStepCount: 0,
                      failedCommandCount: 0,
                      filesChanged: 0,
                      messages: 1,
                      itemCounts: {},
                      coverage: 'complete',
                    },
                    interruptedBy: { visibility: 'available', actor: null },
                    restrictedReferences: false,
                  },
                ],
                afterCursor: request.cursor ? null : 'tail',
                anchor: { turnId, itemId },
                catchUpAnchor: { turnId, itemId },
              }
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
      });
    };
    await fulfill(page);
    for (const viewport of [
      { width: 1280, height: 800, suffix: 'desktop' },
      { width: 360, height: 740, suffix: '360' },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      delivery = 'accepted';
      await page.goto(taskUrl);
      await expect(page.getByText(NOTE).first()).toBeVisible({ timeout: 40_000 });
      await expect(page.getByText('Accepted by the running worker')).toBeVisible();
      await expect(page.locator('[data-steer-state="accepted"]')).toHaveAttribute(
        'data-request-id',
        requestFor.accepted
      );
      await expect(page.locator('[data-steer-state="accepted"]')).toHaveAttribute(
        'data-steer-text',
        NOTE
      );
      expect(new URL(page.url()).search).not.toMatch(/request|steer|scene/);
      await page.reload();
      await expect(page.getByText('Accepted by the running worker')).toBeVisible();
      await expect(page.locator('[data-steer-state="accepted"]')).toHaveAttribute(
        'data-request-id',
        requestFor.accepted
      );
      const second = await browser.newContext({ viewport });
      const other = await second.newPage();
      try {
        await fulfill(other);
        await other.goto(taskUrl);
        await expect(other.getByText('Accepted by the running worker')).toBeVisible();
        await expect(other.locator('[data-steer-state="accepted"]')).toHaveAttribute(
          'data-request-id',
          requestFor.accepted
        );
      } finally {
        await second.close();
      }
      await page.screenshot({ path: join(SHOTS, `accepted-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);

      delivery = 'not-delivered';
      await page.goto(taskUrl);
      await expect(page.getByText('Not delivered')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(page.locator('[data-steer-state="not-delivered"]')).toHaveAttribute(
        'data-request-id',
        requestFor['not-delivered']
      );
      await expect(page.locator('[data-steer-state="not-delivered"]')).toHaveAttribute(
        'data-steer-text',
        NOTE
      );
      await page.screenshot({ path: join(SHOTS, `not-delivered-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);

      delivery = 'unknown';
      await page.goto(taskUrl);
      await expect(page.getByText('Delivery unknown')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByRole('button', { name: 'Check' })).toBeVisible();
      await expect(page.locator('[data-steer-state="unknown"]')).toHaveAttribute(
        'data-request-id',
        requestFor.unknown
      );
      await expect(page.locator('[data-steer-state="unknown"]')).toHaveAttribute(
        'data-steer-text',
        NOTE
      );
      await page.screenshot({ path: join(SHOTS, `unknown-${viewport.suffix}.png`) });
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
