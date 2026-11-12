import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationTargetCatalogSchema,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
  type TimelineItem,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

// Screenshots are evidence, not assertions. Set OPENKIT_E2E_SHOTS_DIR to keep them.
const SHOTS =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-steer');

const NOTE = 'Bring the note into this run.';
const RAW_REASON = 'steer_turn_run_denied';

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

function acceptedInRead(body: unknown, requestId: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as {
    runs?: readonly {
      narrative?: readonly { steer?: { state?: string; requestId?: string } | null }[];
    }[];
    itemWindow?: {
      items?: readonly { steer?: { state?: string; requestId?: string } | null }[];
    } | null;
  };
  const items = [
    ...(record.runs ?? []).flatMap((run) => run.narrative ?? []),
    ...(record.itemWindow?.items ?? []),
  ];
  return items.some(
    (item) => item.steer?.state === 'accepted' && item.steer.requestId === requestId
  );
}

test('shows Accepted from the real simulator steer after reload and in a second context', async ({
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
    const startId = randomUUID();
    const started = await page.request.post(`${stack.coreUrl}/api/app/operations/task.start`, {
      headers: { 'x-openkit-request-id': startId },
      data: {
        workspaceId: workspace.id,
        threadId: thread.id,
        input: 'Keep this run on screen.',
        requestId: startId,
      },
    });
    expect(started.status(), await started.text()).toBe(202);
    const requestId = randomUUID();
    const deadline = Date.now() + 45_000;
    let turnId = '';
    let last = 'waiting';
    while (Date.now() < deadline) {
      const catalog = await client.operations['conversation.targets']({
        workspaceId: workspace.id,
        threadId: thread.id,
      });
      const worker = catalog.targets.find((target) => target.kind === 'running-worker');
      if (worker?.steerAvailability === 'available' && worker.activeTurnId) {
        turnId = worker.activeTurnId;
        break;
      }
      last = worker?.steerAvailability ?? 'absent';
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(turnId, `live steer stayed ${last}`).not.toBe('');
    const steered = await client.operations['task.steer']({
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId,
      requestId,
      input: NOTE,
    });
    expect(steered.delivery).toBe('accepted');
    const readDeadline = Date.now() + 20_000;
    let retained = false;
    while (Date.now() < readDeadline) {
      const timeline = await client.operations['thread.timeline']({
        workspaceId: workspace.id,
        threadId: thread.id,
        anchor: { kind: 'latest' },
      });
      retained = acceptedInRead(timeline, requestId);
      if (retained) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(retained).toBe(true);
    const taskUrl = `${stack.webUrl}/tasks/${workspace.id}/${thread.id}`;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(taskUrl);
    await expect(page.getByText(NOTE).first()).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('Accepted by the running worker')).toBeVisible();
    await expect(page.locator('[data-steer-state="accepted"]')).toHaveAttribute(
      'data-request-id',
      requestId
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
      requestId
    );
    const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const other = await second.newPage();
      await other.goto(taskUrl);
      await expect(other.getByText('Accepted by the running worker')).toBeVisible();
      await expect(other.locator('[data-steer-state="accepted"]')).toHaveAttribute(
        'data-request-id',
        requestId
      );
      expect(new URL(other.url()).search).not.toMatch(/request|steer|scene/);
    } finally {
      await second.close();
    }
    await page.screenshot({ path: join(SHOTS, 'accepted-desktop.png') });
    await noHorizontalScroll(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(page.getByText('Accepted by the running worker')).toBeVisible();
    await noHorizontalScroll(page);
  } finally {
    await stack.stop();
  }
});

test('shows the other steer outcomes from controlled reads and keeps an unqualified draft', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
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
      name: 'Receipt run',
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
    let delivery: 'not-delivered' | 'unknown' = 'not-delivered';
    const requestFor = { 'not-delivered': 'req_kept', unknown: 'req_unknown' } as const;
    const steeredItem = (state: typeof delivery): TimelineItem => ({
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
    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const payload = ThreadTimelineResponseSchema.parse({
        ...shell,
        runs: [
          {
            id: turnId,
            admissionOrder: 1,
            status: 'running',
            triggerActor: { kind: 'user', id: userId },
            agentId: null,
            triggerSource: null,
            startedAt: '2026-11-08T12:00:00.000Z',
            completedAt: null,
            durationMs: null,
            error: null,
            long: false,
            narrative: [steeredItem(delivery)],
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
        anchor: { turnId, itemId },
        catchUpAnchor: { turnId, itemId },
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    for (const viewport of [
      { width: 1280, height: 800, suffix: 'desktop' },
      { width: 360, height: 740, suffix: '360' },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      delivery = 'not-delivered';
      await page.goto(taskUrl);
      await expect(page.getByText('Not delivered')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(page.locator('[data-steer-state="not-delivered"]')).toHaveAttribute(
        'data-request-id',
        requestFor['not-delivered']
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
      await page.screenshot({ path: join(SHOTS, `unknown-${viewport.suffix}.png`) });
      await noHorizontalScroll(page);
    }

    await page.unroute('**/api/app/operations/thread.timeline');
    await page.setViewportSize({ width: 1280, height: 800 });
    // Fulfill from this read. route.fetch to the core port was refused while the page was still served.
    const dashboard = ThreadDashboardResponseSchema.parse(
      await client.operations['thread.dashboard']({
        workspaceId: workspace.id,
        threadId: thread.id,
      })
    );
    const catalog = ConversationTargetCatalogSchema.parse(
      await client.operations['conversation.targets']({
        workspaceId: workspace.id,
        threadId: thread.id,
      })
    );
    const turn = dashboard.turns.at(-1);
    if (!turn) throw new Error('The dashboard has no Turn to hold open.');
    turn.status = 'running';
    turn.completedAt = null;
    if (dashboard.now) {
      dashboard.now.status = 'running';
      dashboard.now.turnId = turn.id;
    }
    dashboard.workStatus.activeTurnStatus = 'running';
    const coordinator = catalog.targets.find((target) => target.kind === 'goal-coordinator');
    if (coordinator) {
      coordinator.steerAvailability = 'unsupported';
      coordinator.steerUnavailableReason = 'steer_unsupported';
      coordinator.activeTurnId = null;
    }
    let worker = catalog.targets.find((target) => target.kind === 'running-worker');
    if (!worker) {
      worker = {
        targetRef: 'running-worker:thread:agent',
        kind: 'running-worker',
        label: 'Worker',
        description: null,
        availability: 'busy',
        unavailableReason: 'Worker is busy.',
        threadId: thread.id,
        profileId: null,
        logicalModels: [],
        defaultLogicalModelId: null,
        activeTurnId: turn.id,
        steerAvailability: 'unsupported',
        steerUnavailableReason: RAW_REASON,
      };
      catalog.targets.push(worker);
    }
    worker.steerAvailability = 'unsupported';
    worker.steerUnavailableReason = RAW_REASON;
    const dashboardBody = JSON.stringify(ThreadDashboardResponseSchema.parse(dashboard));
    const catalogBody = JSON.stringify(ConversationTargetCatalogSchema.parse(catalog));
    await page.route('**/api/app/operations/thread.dashboard', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: dashboardBody,
      });
    });
    await page.route('**/api/app/operations/conversation.targets', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: catalogBody,
      });
    });
    // A live Turn event would replace this read with the real terminal Turn.
    await page.route('**/api/workspaces/**/threads/**/events**', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto(taskUrl);
    const input = page.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill(NOTE);
    await expect(page.getByText("This worker can't take notes while running.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep draft', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Steer', exact: true })).toHaveCount(0);
    await expect(page.getByText(RAW_REASON)).toHaveCount(0);
    await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await expect(input).toHaveValue(NOTE);
    expect(steered).toEqual([]);
  } finally {
    await stack.stop();
  }
});
