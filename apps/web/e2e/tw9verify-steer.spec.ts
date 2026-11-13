import {
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { type BrowserContext, expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

// This tests retained receipt projection, not adapter qualification. The fixture
// supplies an already retained acceptance through thread.timeline; no URL or
// mutation-local state supplies the outcome, and no qualification field is invented.
test('TW9VERIFY reads an older Accepted steer on the real Task screen after reload and in another context', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  try {
    const client = createCoreClient({ baseUrl: stack.coreUrl });
    const listed = await client.operations['workspace.list']({});
    const workspace = listed.items[0]?.workspace;
    if (!workspace) throw new Error('The isolated stack must admit a Workspace');
    const thread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Retained steer receipt',
      visibility: 'workspace',
    });
    const oldTurn = await client.operations['turn.start']({
      workspaceId: workspace.id,
      threadId: thread.id,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Create the Task receipt read fixture.',
    });
    const admitted = await client.operations['thread.dashboard']({
      workspaceId: workspace.id,
      threadId: thread.id,
    });
    const actorId = admitted.viewerUserId ?? allocateEntityId('usr');
    const latestTurnId = allocateEntityId('tu');
    const steerId = allocateEntityId('it');
    const text = 'A retained historical steer note';
    const at = '2026-11-08T12:00:00.000Z';
    const message = ItemSchema.parse({
      id: steerId,
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId: oldTurn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: actorId },
      text,
      createdAt: at,
      completedAt: at,
    });
    if (message.type !== 'user-message')
      throw new Error('The receipt fixture must be a user message');
    const receiptItem: TimelineItem = {
      id: steerId,
      turnId: oldTurn.id,
      type: 'user-message',
      placement: 'narrative',
      status: 'completed',
      createdAt: at,
      completedAt: at,
      actor: message.actor,
      detail: { kind: 'complete', value: message },
      steer: { requestId: 'retained-history-one', state: 'accepted', reason: null },
    };
    const run = (id: string, order: number, narrative: TimelineItem[]): TimelineRunEntry => ({
      id,
      admissionOrder: order,
      status: order === 40 ? 'running' : 'completed',
      triggerActor: { kind: 'user', id: actorId },
      agentId: null,
      triggerSource: null,
      startedAt: at,
      completedAt: order === 40 ? null : at,
      durationMs: order === 40 ? null : 1000,
      error: null,
      long: false,
      narrative,
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps: 0,
        failedStepCount: 0,
        failedCommandCount: 0,
        filesChanged: 0,
        messages: narrative.length,
        itemCounts: {},
        coverage: 'complete',
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
    });
    const later = Array.from({ length: 39 }, (_, index) =>
      run(index === 38 ? latestTurnId : allocateEntityId('tu'), index + 2, [])
    );
    const boundary = { turnId: oldTurn.id, itemId: steerId };
    const response = (catchUp: boolean) =>
      ThreadTimelineResponseSchema.parse({
        workspaceId: workspace.id,
        threadId: thread.id,
        view: 'runs',
        runs: catchUp
          ? [run(oldTurn.id, 1, [receiptItem]), ...later.slice(0, 10)]
          : later.slice(-31),
        items: [],
        anchor: catchUp ? boundary : null,
        catchUpAnchor: boundary,
        itemWindow: catchUp
          ? { turnId: oldTurn.id, items: [receiptItem], beforeCursor: null, afterCursor: null }
          : null,
        beforeCursor: catchUp ? null : 'older-runs',
        afterCursor: catchUp ? 'newer-runs' : null,
        digest: { lines: [], coverage: 'complete' },
        restrictedReferences: false,
      });
    const heldDashboard = {
      ...admitted,
      turns: [{ ...oldTurn, id: latestTurnId, status: 'running', completedAt: null, items: [] }],
    };
    const reads = new Map<BrowserContext, number>();
    const install = async (context: BrowserContext) => {
      reads.set(context, 0);
      await context.route('**/api/app/operations/thread.timeline', async (route) => {
        reads.set(context, (reads.get(context) ?? 0) + 1);
        const input = route.request().postDataJSON() as {
          anchor?: { kind?: string };
          cursor?: string;
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response(input.anchor?.kind === 'catch-up')),
        });
      });
      await context.route('**/api/app/operations/thread.dashboard', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(heldDashboard),
        })
      );
      await context.route('**/api/app/operations/thread.read-state', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scope: 'window', readItemIds: [steerId], unreadItemIds: [] }),
        })
      );
      await context.route('**/api/workspaces/**/events**', (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: ': retained receipt read fixture\n\n',
        })
      );
    };
    const url = `${stack.webUrl}/tasks/${workspace.id}/${thread.id}`;
    await install(page.context());
    await page.goto(url);
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByText('Accepted by the running worker')).toBeVisible();
    const beforeReload = reads.get(page.context()) ?? 0;
    await page.reload();
    await expect(page.getByText('Accepted by the running worker')).toBeVisible();
    expect(reads.get(page.context())).toBeGreaterThan(beforeReload);
    const second = await browser.newContext();
    try {
      await install(second);
      const other = await second.newPage();
      await other.goto(url);
      await expect(other.getByText(text)).toBeVisible();
      await expect(other.getByText('Accepted by the running worker')).toBeVisible();
      expect(reads.get(second)).toBeGreaterThan(0);
      await expect(other).not.toHaveURL(/scene=|requestId=|text=/);
    } finally {
      await second.close();
    }
  } finally {
    await stack.stop();
  }
});
