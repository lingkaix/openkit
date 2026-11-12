import {
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

const TOTAL_RUNS = 5_000;
const TOTAL_ITEMS = 10_000;
const PAGE = 31;

/**
 * Spec-scale address space (5,000 runs, 10,000 Items). One response stays inside
 * the 31-run cap. The newest run is on screen and receives a text delta every
 * 100 ms. Layout shift is armed before first paint and is not reset.
 */
test('measures the visible run while sustained deltas arrive at spec scale', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Scale measure',
      visibility: 'workspace',
    });
    const threadId = thread.id;
    const turn = await client.operations['turn.start']({
      workspaceId,
      threadId,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence so the scale measure has a visible run.',
    });
    let resolvedItemId = '';
    await expect
      .poll(
        async () => {
          const { items } = await client.operations['thread.items']({ workspaceId, threadId });
          resolvedItemId =
            items.find((item) => item.turnId === turn.id && item.type === 'assistant-message')
              ?.id ?? '';
          return resolvedItemId;
        },
        { timeout: 40_000 }
      )
      .not.toBe('');
    const userId = allocateEntityId('usr');
    const turnIds = Array.from({ length: TOTAL_RUNS }, () => allocateEntityId('tu'));
    const itemIds = Array.from({ length: TOTAL_ITEMS }, () => allocateEntityId('it'));
    const liveValue = ItemSchema.parse({
      id: resolvedItemId,
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Scale run 5000',
      createdAt: '2026-11-08T12:00:02.000Z',
      completedAt: null,
    });

    const userItem = (order: number): TimelineItem => {
      const turnId = order === TOTAL_RUNS ? turn.id : turnIds[order - 1]!;
      const itemId = itemIds[(order - 1) * 2]!;
      const value = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        actor: { kind: 'user', id: userId },
        text: `Note ${order}`,
        createdAt: '2026-11-08T12:00:00.000Z',
        completedAt: '2026-11-08T12:00:00.000Z',
      });
      return {
        id: itemId,
        turnId,
        type: 'user-message',
        placement: 'narrative',
        status: 'completed',
        createdAt: value.createdAt,
        completedAt: value.completedAt,
        actor: value.actor ?? null,
        detail: { kind: 'complete', value },
        steer: null,
      };
    };

    const assistantItem = (order: number): TimelineItem => {
      if (order === TOTAL_RUNS) {
        return {
          id: liveValue.id,
          turnId: liveValue.turnId,
          type: 'assistant-message',
          placement: 'narrative',
          status: 'in_progress',
          createdAt: liveValue.createdAt,
          completedAt: null,
          actor: null,
          detail: { kind: 'complete', value: liveValue },
          steer: null,
        };
      }
      const turnId = turnIds[order - 1]!;
      const itemId = itemIds[(order - 1) * 2 + 1]!;
      const value = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId,
        type: 'assistant-message',
        status: 'completed',
        text: `Scale run ${order}`,
        createdAt: '2026-11-08T12:00:01.000Z',
        completedAt: '2026-11-08T12:00:01.000Z',
      });
      return {
        id: itemId,
        turnId,
        type: 'assistant-message',
        placement: 'narrative',
        status: 'completed',
        createdAt: value.createdAt,
        completedAt: value.completedAt,
        actor: null,
        detail: { kind: 'complete', value },
        steer: null,
      };
    };

    const runAt = (order: number): TimelineRunEntry => {
      const turnId = order === TOTAL_RUNS ? turn.id : turnIds[order - 1]!;
      const running = order === TOTAL_RUNS;
      return {
        id: turnId,
        admissionOrder: order,
        status: running ? 'running' : 'completed',
        triggerActor: { kind: 'user', id: userId },
        agentId: null,
        triggerSource: null,
        startedAt: '2026-11-08T12:00:00.000Z',
        completedAt: running ? null : '2026-11-08T12:00:01.000Z',
        durationMs: running ? null : 1000,
        error: null,
        long: false,
        narrative: [userItem(order), assistantItem(order)],
        plan: null,
        noteItemIds: [],
        finalItemId: null,
        narrativeCursor: null,
        statistics: {
          steps: 0,
          failedStepCount: 0,
          failedCommandCount: 0,
          filesChanged: 0,
          messages: 2,
          itemCounts: {},
          coverage: 'complete',
        },
        interruptedBy: { visibility: 'available', actor: null },
        restrictedReferences: false,
      };
    };

    const endOrder = (cursor: string | undefined): number => {
      if (cursor?.startsWith('before-')) {
        const end = Number(cursor.slice('before-'.length));
        if (Number.isInteger(end) && end >= PAGE) return Math.min(end, TOTAL_RUNS);
      }
      if (cursor?.startsWith('after-')) {
        const start = Number(cursor.slice('after-'.length));
        if (Number.isInteger(start) && start >= 1) {
          return Math.min(TOTAL_RUNS, start + PAGE - 1);
        }
      }
      return TOTAL_RUNS;
    };

    const pageFor = (body: {
      cursor?: string;
      view?: string;
      turnId?: string;
      placement?: string;
    }) => {
      const shell = {
        workspaceId,
        threadId,
        anchor: null,
        catchUpAnchor: null,
        itemWindow: null,
        digest: { lines: [], coverage: 'complete' as const },
        restrictedReferences: false,
      };
      if (body.view === 'items') {
        const order = body.turnId === turn.id ? TOTAL_RUNS : turnIds.indexOf(body.turnId ?? '') + 1;
        const items =
          body.placement === 'step' || order < 1 ? [] : [userItem(order), assistantItem(order)];
        return {
          ...shell,
          view: 'items' as const,
          runs: [],
          items,
          beforeCursor: null,
          afterCursor: null,
        };
      }
      const end = endOrder(body.cursor);
      const start = Math.max(1, end - PAGE + 1);
      const runs = [];
      for (let order = start; order <= end; order += 1) runs.push(runAt(order));
      return {
        ...shell,
        view: 'runs' as const,
        runs,
        items: [],
        beforeCursor: start > 1 ? `before-${start - 1}` : null,
        afterCursor: end < TOTAL_RUNS ? `after-${end + 1}` : null,
      };
    };

    expect(turnIds).toHaveLength(TOTAL_RUNS);
    expect(itemIds).toHaveLength(TOTAL_ITEMS);
    const latest = ThreadTimelineResponseSchema.parse(pageFor({}));
    expect(latest.runs).toHaveLength(PAGE);
    expect(latest.runs[0]?.admissionOrder).toBe(4_970);
    expect(latest.runs[PAGE - 1]?.admissionOrder).toBe(TOTAL_RUNS);
    const earlier = ThreadTimelineResponseSchema.parse(pageFor({ cursor: 'before-4969' }));
    expect(earlier.runs[0]?.admissionOrder).toBe(4_939);
    expect(earlier.runs[PAGE - 1]?.admissionOrder).toBe(4_969);

    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const request = route.request().postDataJSON() as {
        cursor?: string;
        view?: string;
        turnId?: string;
        placement?: string;
      };
      const payload = ThreadTimelineResponseSchema.parse(pageFor(request));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await page.route('**/api/app/operations/thread.items', async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try {
        const body = JSON.parse(text) as {
          items?: { id?: string; status?: string; completedAt?: string | null; text?: string }[];
        };
        for (const item of body.items ?? []) {
          if (item.id !== resolvedItemId) continue;
          item.status = 'in_progress';
          item.completedAt = null;
          item.text = 'Scale run 5000';
        }
        await route.fulfill({
          status: response.status(),
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      } catch {
        await route.fulfill({ status: response.status(), body: text });
      }
    });
    await page.route('**/api/app/operations/thread.dashboard', async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try {
        const body = JSON.parse(text) as {
          turns?: { id?: string; status: string; completedAt: string | null }[];
        };
        for (const entry of body.turns ?? []) {
          if (entry.id !== turn.id && entry !== body.turns?.at(-1)) continue;
          entry.status = 'running';
          entry.completedAt = null;
        }
        await route.fulfill({
          status: response.status(),
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      } catch {
        await route.fulfill({ status: response.status(), body: text });
      }
    });

    await armMeasure(page, {
      workspaceId,
      threadId,
      turnId: turn.id,
      itemId: resolvedItemId,
      item: liveValue,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const streamOpened = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('measure-stream-open'),
      timeout: 30_000,
    });
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${threadId}`);
    await streamOpened;
    const live = page.getByText('Scale run 5000').last();
    await expect(live).toBeVisible({ timeout: 20_000 });
    const painted = (await page.locator('[data-timeline-lens]').textContent()) ?? '';
    expect(painted).toContain('Scale run 4970');
    expect(painted).toContain('Scale run 5000');
    expect(painted).not.toContain('Scale run 4969');

    const samples: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      if (index > 0) await page.waitForTimeout(5_000);
      samples.push((await live.textContent())?.length ?? 0);
    }
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1] ?? 0);
    }

    const measured = await page.evaluate(() => {
      const cls = (window as unknown as { __cls?: { value: number } }).__cls?.value ?? 0;
      const commits = (window as unknown as { __commits?: number }).__commits ?? 0;
      const deltas = (window as unknown as { __measureDeltas?: number }).__measureDeltas ?? 0;
      const nodes = document.querySelectorAll('[data-timeline-lens] *').length;
      const runs = document.querySelectorAll('[data-timeline-entry]').length;
      return { cls, commits, deltas, nodes, runs };
    });
    expect(measured.runs).toBeGreaterThan(10);
    expect(measured.runs).toBeLessThanOrEqual(40);
    expect(measured.nodes).toBeLessThanOrEqual(3_000);
    expect(measured.nodes).toBeGreaterThan(0);
    expect(measured.deltas).toBeGreaterThanOrEqual(200);
    expect(measured.commits).toBeGreaterThan(0);
    const line = `MEASURE cls=${measured.cls} nodes=${measured.nodes} commits=${measured.commits} deltas=${measured.deltas} runs=${measured.runs} samples=${samples.join(',')} scale=5000+10000`;
    console.log(line);
    testInfo.annotations.push({ type: 'measure', description: line });
  } finally {
    await stack.stop();
  }
});

async function armMeasure(
  page: Page,
  cfg: {
    workspaceId: string;
    threadId: string;
    turnId: string;
    itemId: string;
    item: unknown;
  }
): Promise<void> {
  await page.addInitScript((input) => {
    const bucket = { value: 0, detail: [] as { value: number; text: string }[] };
    (window as unknown as { __cls: typeof bucket }).__cls = bucket;
    (window as unknown as { __commits: number }).__commits = 0;
    (window as unknown as { __measureDeltas: number }).__measureDeltas = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (shift.hadRecentInput || typeof shift.value !== 'number') continue;
        bucket.value += shift.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });

    const hook = {
      isDisabled: false,
      supportsFiber: true,
      inject() {
        return 1;
      },
      onCommitFiberRoot() {
        const holder = window as unknown as { __commits: number };
        holder.__commits += 1;
      },
    };
    (
      window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: typeof hook }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

    const native = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url;
      if (!url.includes('/threads/') || !url.includes('/events')) return native(resource, init);
      console.log('measure-stream-open');
      const encoder = new TextEncoder();
      let sequence = 1;
      let timer = 0;
      const stream = new ReadableStream({
        start(controller) {
          const emit = (event: string, data: unknown) => {
            const frame = {
              protocolVersion: '0.7.0',
              event,
              sequence,
              requestId: '11111111-1111-4111-8111-111111111111',
              timestamp: '2026-11-08T12:00:02.000Z',
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              turnId: input.turnId,
              data,
            };
            sequence += 1;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          };
          emit('item.created', { type: 'item-created', item: input.item });
          timer = window.setInterval(() => {
            emit('item.delta', {
              type: 'item-delta',
              itemId: input.itemId,
              itemType: 'assistant-message',
              deltaKind: 'text-delta',
              delta: 'x',
            });
            const holder = window as unknown as { __measureDeltas: number };
            holder.__measureDeltas += 1;
          }, 100);
        },
        cancel() {
          window.clearInterval(timer);
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    };
  }, cfg);
}
