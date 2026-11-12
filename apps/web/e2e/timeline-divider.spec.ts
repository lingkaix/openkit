import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

const shotsDir =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-divider');

async function armLayoutShift(page: Page) {
  await page.addInitScript(() => {
    const bucket = { value: 0, detail: [] as { value: number; text: string }[] };
    (window as unknown as { __cls: typeof bucket }).__cls = bucket;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
          sources?: { node?: Node }[];
        };
        if (shift.hadRecentInput || typeof shift.value !== 'number') continue;
        bucket.value += shift.value;
        const text = (shift.sources ?? [])
          .map((source) => {
            const element = source.node instanceof Element ? source.node : null;
            const label = element?.className?.toString?.() || element?.tagName || '';
            const snippet = (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
            return `${label} ${snippet}`.trim();
          })
          .join(' | ')
          .slice(0, 180);
        bucket.detail.push({ value: shift.value, text });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

function message(input: {
  order: number;
  turnId: string;
  itemId: string;
  text: string;
  workspaceId: string;
  threadId: string;
  userId: string;
}): TimelineItem {
  const value = ItemSchema.parse({
    id: input.itemId,
    owner: { kind: 'workspace', workspaceId: input.workspaceId },
    threadId: input.threadId,
    turnId: input.turnId,
    type: 'user-message',
    status: 'completed',
    actor: { kind: 'user', id: input.userId },
    text: input.text,
    createdAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:00.000Z',
  });
  return {
    id: input.itemId,
    turnId: input.turnId,
    type: 'user-message',
    placement: 'narrative',
    status: 'completed',
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    actor: value.actor ?? null,
    detail: { kind: 'complete', value },
    steer: null,
  };
}

function runEntry(input: {
  order: number;
  turnId: string;
  items: TimelineItem[];
  status: 'completed' | 'running';
  userId: string;
}): TimelineRunEntry {
  return {
    id: input.turnId,
    admissionOrder: input.order,
    status: input.status,
    triggerActor: { kind: 'user', id: input.userId },
    agentId: null,
    triggerSource: null,
    startedAt: '2026-11-08T12:00:00.000Z',
    completedAt: input.status === 'running' ? null : '2026-11-08T12:00:01.000Z',
    durationMs: input.status === 'running' ? null : 1000,
    error: null,
    long: false,
    narrative: input.items,
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      filesChanged: 0,
      messages: input.items.length,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  };
}

/**
 * Desktop and 360×740: a long tail opens at the divider inside a running run,
 * the earlier-unread jump replaces history, and a short tail follows the end.
 */
test('opens a long tail at the catch-up divider and follows a short one', async ({ page }) => {
  test.setTimeout(240_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  let releaseStream = () => {};
  const streamHeld = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;
    const userId = allocateEntityId('usr');
    const longThread = await client.operations['thread.create']({
      workspaceId,
      name: 'Divider check',
      visibility: 'workspace',
    });
    await client.operations['turn.start']({
      workspaceId,
      threadId: longThread.id,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence so the divider check has a run.',
    });
    const shortThread = await client.operations['thread.create']({
      workspaceId,
      name: 'Short tail check',
      visibility: 'workspace',
    });
    await client.operations['turn.start']({
      workspaceId,
      threadId: shortThread.id,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence so the short tail has a run.',
    });

    const paragraph = (label: string) => Array.from({ length: 24 }, () => label).join('\n');
    const prefix = Array.from({ length: 8 }, (_, index) => {
      const turnId = allocateEntityId('tu');
      const itemId = allocateEntityId('it');
      return {
        order: index + 10,
        turnId,
        itemId,
        item: message({
          order: index + 10,
          turnId,
          itemId,
          text: paragraph(`Prefix note ${index + 10}`),
          workspaceId,
          threadId: longThread.id,
          userId,
        }),
      };
    });
    const unread = prefix[0]!;
    const runningTurnId = allocateEntityId('tu');
    const seenId = allocateEntityId('it');
    const catchUpId = allocateEntityId('it');
    const freshId = allocateEntityId('it');
    const runningItems = [
      message({
        order: 18,
        turnId: runningTurnId,
        itemId: seenId,
        text: 'Seen note',
        workspaceId,
        threadId: longThread.id,
        userId,
      }),
      message({
        order: 18,
        turnId: runningTurnId,
        itemId: catchUpId,
        text: 'Catch-up note',
        workspaceId,
        threadId: longThread.id,
        userId,
      }),
      message({
        order: 18,
        turnId: runningTurnId,
        itemId: freshId,
        text: 'New since note',
        workspaceId,
        threadId: longThread.id,
        userId,
      }),
    ];
    const longRuns = [
      ...prefix.map((entry) =>
        runEntry({
          order: entry.order,
          turnId: entry.turnId,
          items: [entry.item],
          status: 'completed',
          userId,
        })
      ),
      runEntry({
        order: 18,
        turnId: runningTurnId,
        items: runningItems,
        status: 'running',
        userId,
      }),
    ];
    const earlierRuns = Array.from({ length: 4 }, (_, index) => {
      const turnId = allocateEntityId('tu');
      const itemId = allocateEntityId('it');
      return runEntry({
        order: index + 1,
        turnId,
        items: [
          message({
            order: index + 1,
            turnId,
            itemId,
            text: `Loaded earlier ${index + 1}`,
            workspaceId,
            threadId: longThread.id,
            userId,
          }),
        ],
        status: 'completed',
        userId,
      });
    });
    const shortPrefix = Array.from({ length: 4 }, (_, index) => {
      const turnId = allocateEntityId('tu');
      const itemId = allocateEntityId('it');
      return runEntry({
        order: index + 1,
        turnId,
        items: [
          message({
            order: index + 1,
            turnId,
            itemId,
            text: paragraph(`Far above ${index + 1}`),
            workspaceId,
            threadId: shortThread.id,
            userId,
          }),
        ],
        status: 'completed',
        userId,
      });
    });
    const shortTurnId = allocateEntityId('tu');
    const shortCatchUpId = allocateEntityId('it');
    const shortTailId = allocateEntityId('it');
    const shortRuns = [
      ...shortPrefix,
      runEntry({
        order: 5,
        turnId: shortTurnId,
        items: [
          message({
            order: 5,
            turnId: shortTurnId,
            itemId: shortCatchUpId,
            text: 'Short catch-up note',
            workspaceId,
            threadId: shortThread.id,
            userId,
          }),
          message({
            order: 5,
            turnId: shortTurnId,
            itemId: shortTailId,
            text: 'Short tail note',
            workspaceId,
            threadId: shortThread.id,
            userId,
          }),
        ],
        status: 'completed',
        userId,
      }),
    ];

    const timelineFor = (body: {
      threadId?: string;
      cursor?: string;
      anchor?: { kind?: string; itemId?: string };
    }) => {
      if (body.threadId === shortThread.id) {
        return {
          workspaceId,
          threadId: shortThread.id,
          view: 'runs' as const,
          runs: shortRuns,
          items: [],
          beforeCursor: null,
          afterCursor: null,
          itemWindow: null,
          anchor:
            body.anchor?.kind === 'catch-up'
              ? { turnId: shortTurnId, itemId: shortCatchUpId }
              : null,
          catchUpAnchor: { turnId: shortTurnId, itemId: shortCatchUpId },
          digest: { lines: [], coverage: 'complete' as const },
          restrictedReferences: false,
        };
      }
      if (body.cursor === 'earlier-1') {
        return {
          workspaceId,
          threadId: longThread.id,
          view: 'runs' as const,
          runs: earlierRuns,
          items: [],
          beforeCursor: null,
          afterCursor: null,
          itemWindow: null,
          anchor: null,
          catchUpAnchor: { turnId: runningTurnId, itemId: catchUpId },
          digest: {
            lines: [
              {
                kind: 'new-messages' as const,
                count: 4,
                anchor: { kind: 'item' as const, itemId: freshId },
              },
              {
                kind: 'problems' as const,
                count: 1,
                anchor: { kind: 'turn' as const, turnId: runningTurnId },
              },
            ],
            coverage: 'complete' as const,
          },
          restrictedReferences: false,
        };
      }
      const itemAnchor = body.anchor?.kind === 'item';
      return {
        workspaceId,
        threadId: longThread.id,
        view: 'runs' as const,
        runs: longRuns,
        items: [],
        beforeCursor: 'earlier-1',
        afterCursor: null,
        itemWindow: {
          turnId: runningTurnId,
          items: runningItems,
          beforeCursor: null,
          afterCursor: itemAnchor ? null : 'tail',
        },
        anchor: itemAnchor
          ? { turnId: unread.turnId, itemId: unread.itemId }
          : { turnId: runningTurnId, itemId: catchUpId },
        catchUpAnchor: { turnId: runningTurnId, itemId: catchUpId },
        digest: {
          lines: [
            {
              kind: 'new-messages' as const,
              count: 4,
              anchor: { kind: 'item' as const, itemId: freshId },
            },
            {
              kind: 'problems' as const,
              count: 1,
              anchor: { kind: 'turn' as const, turnId: runningTurnId },
            },
          ],
          coverage: 'complete' as const,
        },
        restrictedReferences: false,
      };
    };

    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const request = route.request().postDataJSON() as {
        threadId?: string;
        cursor?: string;
        anchor?: { kind?: string; itemId?: string };
      };
      const payload = ThreadTimelineResponseSchema.parse(timelineFor(request));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    const readState = (threadId: string) => ({
      readItemIds: [] as string[],
      unreadItemIds: threadId === longThread.id ? [unread.itemId] : [],
    });
    await page.route('**/api/app/operations/thread.read-state', async (route) => {
      const request = route.request().postDataJSON() as { threadId?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(readState(request.threadId ?? '')),
      });
    });
    await page.route('**/api/app/operations/thread.mark-read', async (route) => {
      const request = route.request().postDataJSON() as { threadId?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(readState(request.threadId ?? '')),
      });
    });
    await page.route('**/api/workspaces/**/events**', async (route) => {
      await streamHeld;
      try {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: '',
        });
      } catch {
        // The page closed while the stream was held.
      }
    });

    await mkdir(shotsDir, { recursive: true });
    await armLayoutShift(page);

    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'phone', width: 360, height: 740 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${stack.webUrl}/tasks/${workspaceId}/${longThread.id}`);
      const divider = page.locator('[data-catch-up-divider]');
      await expect(divider).toBeVisible({ timeout: 40_000 });
      await expect(divider).toContainText('New since you were here');
      await expect(divider.getByRole('button', { name: '4 new messages' })).toBeVisible();
      await expect(divider.getByRole('button', { name: '1 problem' })).toBeVisible();
      await expect(divider.getByRole('button', { name: /need you/ })).toHaveCount(0);
      await expect(divider.getByText(/lower bound/)).toHaveCount(0);
      await expect(page.locator('[data-agent-profile="task"]')).toBeVisible();
      const runStatus = await divider.evaluate(
        (node) => node.closest('[data-timeline-entry]')?.getAttribute('data-run-status') ?? ''
      );
      expect(runStatus).toBe('running');
      const jump = page.getByRole('button', { name: '1 earlier unread ›' });
      await expect(jump).toBeVisible();
      await expect(page.locator('[data-unread="true"]')).toHaveCount(1);
      await page.evaluate(() => {
        const bucket = (window as unknown as { __cls?: { value: number; detail: unknown[] } })
          .__cls;
        if (!bucket) return;
        bucket.value = 0;
        bucket.detail = [];
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      const opened = await page.evaluate(() => {
        const bucket = (window as unknown as { __cls?: { value: number; detail: unknown[] } })
          .__cls;
        return bucket ?? { value: 0, detail: [] as unknown[] };
      });
      console.log(`cls-open ${viewport.name}=${opened.value}`);
      if (opened.value > 0.05) {
        console.log(`CLS open ${viewport.name} ${JSON.stringify(opened.detail)}`);
      }
      expect(opened.value).toBeLessThanOrEqual(0.05);
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-divider.png`),
        fullPage: false,
      });
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-running.png`),
        fullPage: false,
      });
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-digest.png`),
        fullPage: false,
      });

      const scroller = page.locator('[data-timeline-scroll]');
      const before = await scroller.evaluate((node) => {
        node.scrollTop = 0;
        const top = node.getBoundingClientRect().top;
        const entry = [...document.querySelectorAll<HTMLElement>('[data-timeline-entry]')].find(
          (candidate) => candidate.getBoundingClientRect().bottom > top + 8
        );
        return {
          id: entry?.getAttribute('data-timeline-entry') ?? '',
          top: entry?.getBoundingClientRect().top ?? 0,
        };
      });
      await expect
        .poll(async () => page.locator('[data-timeline-entry]').count())
        .toBeGreaterThan(9);
      const afterTop = await page.evaluate((id) => {
        const entry = document.querySelector<HTMLElement>(
          `[data-timeline-entry="${CSS.escape(id)}"]`
        );
        return entry?.getBoundingClientRect().top ?? 0;
      }, before.id);
      const prependDelta = Math.abs(afterTop - before.top);
      console.log(`prepend-px ${viewport.name}=${prependDelta}`);
      expect(prependDelta).toBeLessThanOrEqual(2);

      const historyLength = await page.evaluate(() => history.length);
      await jump.click();
      await expect(page).toHaveURL(new RegExp(`item=${unread.itemId}`));
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      await expect(page.getByText('Prefix note 10').first()).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-earlier-unread.png`),
        fullPage: false,
      });
      await page.goto(`${stack.webUrl}/tasks/${workspaceId}/${longThread.id}`);
      const digestDivider = page.locator('[data-catch-up-divider]');
      await expect(digestDivider).toBeVisible({ timeout: 40_000 });
      const digestHistory = await page.evaluate(() => history.length);
      await digestDivider.getByRole('button', { name: '4 new messages' }).click();
      await expect(page).toHaveURL(new RegExp(`item=${freshId}`));
      expect(await page.evaluate(() => history.length)).toBe(digestHistory);
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-digest-anchor.png`),
        fullPage: false,
      });

      if (viewport.width === 360) {
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          timeline:
            document.querySelector('[data-timeline-scroll]')?.scrollWidth ??
            document.documentElement.clientWidth,
          port:
            document.querySelector('[data-timeline-scroll]')?.clientWidth ??
            document.documentElement.clientWidth,
        }));
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
        expect(widths.timeline).toBeLessThanOrEqual(widths.port + 1);
      }

      await page.goto(`${stack.webUrl}/tasks/${workspaceId}/${shortThread.id}`);
      await expect(page.getByText('Short tail note')).toBeVisible({ timeout: 40_000 });
      await expect
        .poll(async () =>
          scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
        )
        .toBeLessThanOrEqual(48);
      const pinned = await page.locator('[data-catch-up-divider]').evaluate((node) => {
        const port = node.closest('[data-timeline-scroll]');
        if (!port) return true;
        return Math.abs(node.getBoundingClientRect().top - port.getBoundingClientRect().top) < 8;
      });
      expect(pinned).toBe(false);
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-short-end.png`),
        fullPage: false,
      });
    }
  } finally {
    releaseStream();
    await stack.stop();
  }
});
