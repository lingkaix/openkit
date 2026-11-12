import {
  OPERATION_DEFINITIONS,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** EU-WEB: the reserved divider line must not move the next run when a count arrives. */
test('W6 a delayed null-to-count earlierUnread does not move the next run at 360px', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspaceId = workspaces[0]?.workspace.id;
    if (!workspaceId) throw new Error('The isolated stack has no admitted Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Delayed earlier unread',
      visibility: 'workspace',
    });
    const selector = { workspaceId, threadId: thread.id };
    const messages: TimelineItem[] = [];
    // These owner operations create the real lineage used by the HTTP fixture.
    // Build the retrieval kernel before running this spec, as the normal e2e stack requires.
    for (let index = 0; index < 3; index += 1) {
      const turn = await client.operations['turn.start']({
        ...selector,
        agentId: 'agent_codex_host',
        modelId: 'reasoning',
        input: `Reply briefly for delayed-count layout run ${index + 1}.`,
      });
      await expect
        .poll(
          async () => {
            const dashboard = await client.operations['thread.dashboard'](selector);
            return dashboard.turns.find((entry) => entry.id === turn.id)?.status;
          },
          { timeout: 30_000 }
        )
        .toBe('completed');
      const { items } = await client.operations['thread.items'](selector);
      const found = items.find(
        (item) => item.turnId === turn.id && item.type === 'assistant-message'
      );
      if (!found) throw new Error('The completed simulator run has no assistant message.');
      const value = ItemSchema.parse({
        ...found,
        text: ['Earlier eligible message', 'Boundary message', 'Next run after the divider'][index],
      });
      messages.push({
        id: value.id,
        turnId: value.turnId,
        type: value.type,
        placement: 'narrative',
        status: value.status,
        createdAt: value.createdAt,
        completedAt: value.completedAt,
        actor: null,
        detail: { kind: 'complete', value },
        steer: null,
        policy: null,
      });
    }
    const [earlier, boundary, next] = messages;
    if (!earlier || !boundary || !next) throw new Error('The fixture needs three completed runs.');
    const dashboard = await client.operations['thread.dashboard'](selector);
    const viewer = dashboard.viewerUserId;
    if (!viewer) throw new Error('The isolated stack has no admitted viewer.');
    const run = (item: TimelineItem, order: number): TimelineRunEntry => ({
      id: item.turnId,
      admissionOrder: order,
      status: 'completed',
      triggerActor: { kind: 'user', id: viewer },
      agentId: null,
      triggerSource: null,
      startedAt: item.createdAt,
      completedAt: item.completedAt,
      durationMs: 1_000,
      error: null,
      long: false,
      narrative: [item],
      plan: null,
      noteItemIds: [],
      finalItemId: item.id,
      narrativeCursor: null,
      statistics: {
        steps: 0,
        failedStepCount: 0,
        failedCommandCount: 0,
        filesChanged: 0,
        messages: 1,
        itemCounts: { 'assistant-message': 1 },
        coverage: 'complete',
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
    });
    // Keep the independent receipt read fixed while only earlierUnread changes.
    // Receipts displayed after open do not move this visit's divider at B.
    await page.route('**/api/app/operations/thread.read-state', async (route) => {
      OPERATION_DEFINITIONS['thread.read-state'].inputSchema.parse(route.request().postDataJSON());
      const payload = OPERATION_DEFINITIONS['thread.read-state'].outputSchema.parse({
        readItemIds: [boundary.id, next.id],
        unreadItemIds: [earlier.id],
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    let countAvailable = false;
    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const input = OPERATION_DEFINITIONS['thread.timeline'].inputSchema.parse(
        route.request().postDataJSON()
      );
      if (input.workspaceId !== workspaceId || input.threadId !== thread.id) {
        await route.continue();
        return;
      }
      const itemView = input.view === 'items';
      const shown = input.turnId === next.turnId ? next : boundary;
      const payload = ThreadTimelineResponseSchema.parse({
        ...selector,
        view: itemView ? 'items' : 'runs',
        runs: itemView ? [] : [run(boundary, 2), run(next, 3)],
        items: itemView ? [shown] : [],
        beforeCursor: null,
        afterCursor: null,
        anchor: { turnId: boundary.turnId, itemId: boundary.id },
        catchUpAnchor: { turnId: boundary.turnId, itemId: boundary.id },
        itemWindow: itemView
          ? null
          : { turnId: boundary.turnId, items: [boundary], beforeCursor: null, afterCursor: null },
        earlierUnread: countAvailable
          ? { count: 1, capped: false, oldest: { turnId: earlier.turnId, itemId: earlier.id } }
          : null,
        digest: { lines: [], coverage: 'complete' },
        restrictedReferences: false,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${stack.webUrl}/tasks/${workspaceId}/${thread.id}?catchUp=1`);
    const divider = page.getByRole('group', { name: 'New since you were here' });
    const followingRun = page.getByText('Next run after the divider', { exact: true });
    await expect(divider).toBeVisible({ timeout: 30_000 });
    await expect(divider.getByText('Earlier unread is not in this window.')).toBeVisible();
    await expect(followingRun).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Logical scroll-content coordinates expose reflow even if native scroll anchoring
    // compensates the viewport. No user input, reload or resize occurs during delivery.
    const position = () =>
      followingRun.evaluate((element) => {
        const scroller = element.closest('[data-timeline-scroll]');
        if (!(scroller instanceof HTMLElement)) throw new Error('The timeline has no scrollport.');
        return (
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        );
      });
    let previous = await position();
    let samples = 0;
    await expect
      .poll(
        async () => {
          const current = await position();
          const stable = Math.abs(current - previous) <= 0.1;
          previous = current;
          samples += 1;
          return stable && samples >= 3;
        },
        { intervals: [250] }
      )
      .toBe(true);
    const before = await position();
    countAvailable = true;
    // The ordinary idle poll supplies the delayed result to the existing mounted view.
    await expect(divider.getByRole('button', { name: '1 earlier unread ›' })).toBeVisible({
      timeout: 25_000,
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const after = await position();
    console.log(
      `TBREVIEW5 W6 next-run-before=${before} next-run-after=${after} movement=${Math.abs(after - before)}`
    );
    expect(
      Math.abs(after - before),
      'The delayed earlier-unread count must not move the next run by more than 1 px'
    ).toBeLessThanOrEqual(1);
  } finally {
    await stack.stop();
  }
});
