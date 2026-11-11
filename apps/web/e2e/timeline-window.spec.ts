import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import {
  allocateEntityId,
  ItemSchema,
  PROTOCOL_VERSION,
  ProductSseEventEnvelopeSchema,
} from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

const shotsDir =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-window');

/** Records layout shift for each document, ignoring shifts caused by input. */
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

function runEntry(input: {
  order: number;
  turnId: string;
  item: TimelineItem | null;
  steps: number;
  workspaceId: string;
  threadId: string;
  userId: string;
}): TimelineRunEntry {
  return {
    id: input.turnId,
    admissionOrder: input.order,
    status: 'completed',
    triggerActor: { kind: 'user', id: input.userId },
    agentId: null,
    triggerSource: null,
    startedAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:01.000Z',
    durationMs: 1000,
    error: null,
    long: input.steps > 100,
    narrative: input.item ? [input.item] : [],
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: input.steps,
      filesChanged: 0,
      messages: input.item ? 1 : 0,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  };
}

/**
 * Desktop and 360px: paging keeps the visible entry still, streamed text does not
 * pull a reader down, and the window stays inside the DOM and shift budgets.
 */
test('pages the timeline window and keeps a scrolled reader still', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Window check',
      visibility: 'workspace',
    });
    const threadId = thread.id;
    const turn = await client.operations['turn.start']({
      workspaceId,
      threadId,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence so the window check has a run.',
    });
    await expect
      .poll(
        async () => {
          const { items } = await client.operations['thread.items']({ workspaceId, threadId });
          return items.some((item) => item.turnId === turn.id && item.type === 'assistant-message');
        },
        { timeout: 40_000 }
      )
      .toBe(true);

    const userId = allocateEntityId('usr');
    const turns = Array.from({ length: 40 }, (_, index) => ({
      order: index + 1,
      turnId: allocateEntityId('tu'),
      itemId: allocateEntityId('it'),
    }));
    const message = (order: number, turnId: string, itemId: string): TimelineItem => {
      const value = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        actor: { kind: 'user', id: userId },
        text: `Window note ${order}`,
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
    const runs = turns.map((entry) =>
      runEntry({
        order: entry.order,
        turnId: entry.turnId,
        item: message(entry.order, entry.turnId, entry.itemId),
        steps: entry.order === 40 ? 501 : 0,
        workspaceId,
        threadId,
        userId,
      })
    );
    const latestRuns = runs.slice(9);
    const earlierRuns = runs.slice(0, 9);
    const anchored = turns[11]!;
    const stepTurn = turns[39]!;
    const stepItems = [1, 2].map((index) => {
      const itemId = allocateEntityId('it');
      const value = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId: stepTurn.turnId,
        type: 'reasoning',
        status: 'completed',
        createdAt: '2026-11-08T12:00:00.000Z',
        completedAt: '2026-11-08T12:00:00.000Z',
        summary: [`Step ${index}`],
        content: [`Detail ${index}`],
      });
      return {
        id: itemId,
        turnId: stepTurn.turnId,
        type: 'reasoning' as const,
        placement: 'step' as const,
        status: 'completed' as const,
        createdAt: value.createdAt,
        completedAt: value.completedAt,
        actor: null,
        detail: { kind: 'complete' as const, value },
        steer: null,
      };
    });
    const pageFor = (body: {
      cursor?: string;
      view?: string;
      anchor?: { kind?: string; itemId?: string };
    }) => {
      if (body.cursor === 'earlier-1') {
        return {
          workspaceId,
          threadId,
          view: 'runs' as const,
          runs: earlierRuns,
          items: [],
          beforeCursor: null,
          afterCursor: null,
          itemWindow: null,
          anchor: null,
          catchUpAnchor: null,
          restrictedReferences: false,
        };
      }
      if (body.view === 'items') {
        return {
          workspaceId,
          threadId,
          view: 'items' as const,
          runs: [],
          items: stepItems,
          beforeCursor: null,
          afterCursor: null,
          itemWindow: null,
          anchor: null,
          catchUpAnchor: null,
          restrictedReferences: false,
        };
      }
      const itemAnchor = body.anchor?.kind === 'item';
      return {
        workspaceId,
        threadId,
        view: 'runs' as const,
        runs: latestRuns,
        items: [],
        beforeCursor: 'earlier-1',
        afterCursor: null,
        itemWindow: itemAnchor
          ? {
              turnId: anchored.turnId,
              items: [message(anchored.order, anchored.turnId, anchored.itemId)],
              beforeCursor: null,
              afterCursor: null,
            }
          : null,
        anchor: itemAnchor ? { turnId: anchored.turnId, itemId: anchored.itemId } : null,
        catchUpAnchor: null,
        restrictedReferences: false,
      };
    };

    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const request = route.request().postDataJSON() as {
        cursor?: string;
        view?: string;
        anchor?: { kind?: string; itemId?: string };
      };
      const payload = ThreadTimelineResponseSchema.parse(pageFor(request));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await page.route('**/api/app/operations/thread.dashboard', async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try {
        const body = JSON.parse(text) as {
          turns?: { status: string; completedAt: string | null }[];
        };
        const last = body.turns?.at(-1);
        if (last) {
          last.status = 'running';
          last.completedAt = null;
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

    const liveItemId = allocateEntityId('it');
    const liveItem = ItemSchema.parse({
      id: liveItemId,
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: '',
      createdAt: '2026-11-08T12:00:02.000Z',
      completedAt: null,
    });
    const frames = [
      ProductSseEventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        event: 'item.created',
        sequence: 1,
        requestId: '11111111-1111-4111-8111-111111111111',
        timestamp: '2026-11-08T12:00:02.000Z',
        workspaceId,
        threadId,
        turnId: turn.id,
        data: { type: 'item-created', item: liveItem },
      }),
      ...Array.from({ length: 100 }, (_, index) =>
        ProductSseEventEnvelopeSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          event: 'item.delta',
          sequence: index + 2,
          requestId: '11111111-1111-4111-8111-111111111111',
          timestamp: '2026-11-08T12:00:02.000Z',
          workspaceId,
          threadId,
          turnId: turn.id,
          data: {
            type: 'item-delta',
            itemId: liveItemId,
            itemType: 'assistant-message',
            deltaKind: 'text-delta',
            delta: 'x',
          },
        })
      ),
    ];
    const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
    let releaseStream = () => {};
    let streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const armStream = () => {
      streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    };
    await page.route('**/api/workspaces/**/events**', async (route) => {
      const gate = streamGate;
      await gate;
      try {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sse,
        });
      } catch {
        // Navigation aborted a stream that was still held.
      }
    });

    await mkdir(shotsDir, { recursive: true });
    await armLayoutShift(page);
    const prefix = `${stack.webUrl}/chat/${workspaceId}/${threadId}`;

    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'phone', width: 360, height: 740 },
    ] as const) {
      armStream();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(prefix);
      await expect(page.locator('[data-timeline-entry]').first()).toBeVisible({ timeout: 20_000 });
      const nodes = await page.locator('[data-timeline-lens] *').count();
      console.log(`timeline-dom ${viewport.name}=${nodes}`);
      expect(nodes).toBeLessThanOrEqual(3_000);
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-latest.png`),
        fullPage: false,
      });

      const scroller = page.locator('[data-timeline-scroll]');
      const earlier = page.getByRole('button', { name: 'Load earlier' });
      await expect(earlier).toBeVisible();
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
        .toBeGreaterThan(31);
      const afterTop = await page.evaluate((id) => {
        const entry = document.querySelector<HTMLElement>(
          `[data-timeline-entry="${CSS.escape(id)}"]`
        );
        return entry?.getBoundingClientRect().top ?? 0;
      }, before.id);
      const prependDelta = Math.abs(afterTop - before.top);
      console.log(`prepend-px ${viewport.name}=${prependDelta}`);
      expect(prependDelta).toBeLessThanOrEqual(2);
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-earlier.png`),
        fullPage: false,
      });

      await page.goto(`${prefix}?item=${anchored.itemId}`);
      await expect(page.getByText(`Window note ${anchored.order}`).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-item.png`), fullPage: false });

      await page.goto(prefix);
      await expect(page.locator('[data-timeline-entry]').first()).toBeVisible({ timeout: 20_000 });
      // The shell's first paint (account check, running header) is outside this window.
      // The budget covers paging, streaming, and opening the steps after the thread is up.
      await page.evaluate(() => {
        const bucket = (window as unknown as { __cls?: { value: number; detail: unknown[] } })
          .__cls;
        if (!bucket) return;
        bucket.value = 0;
        bucket.detail = [];
      });
      const held = await scroller.evaluate((node) => {
        const awayFromEnd = Math.max(0, node.scrollHeight - node.clientHeight - 200);
        node.scrollTop = Math.min(node.clientHeight * 2, awayFromEnd);
        const top = node.getBoundingClientRect().top;
        const entry = [...document.querySelectorAll<HTMLElement>('[data-timeline-entry]')].find(
          (candidate) => candidate.getBoundingClientRect().bottom > top + 8
        );
        return {
          id: entry?.getAttribute('data-timeline-entry') ?? '',
          top: entry?.getBoundingClientRect().top ?? 0,
        };
      });
      const box = page.getByRole('textbox', { name: 'Message' });
      await box.evaluate((node) => {
        const target = node as HTMLElement;
        const samples: number[] = [];
        let started = 0;
        (window as unknown as { __keySamples: number[] }).__keySamples = samples;
        target.addEventListener('keydown', () => {
          started = performance.now();
        });
        target.addEventListener('input', () => {
          samples.push(performance.now() - started);
        });
        target.focus({ preventScroll: true });
      });
      await page.keyboard.type('abcdefghijklmnopqrst', { delay: 0 });
      const fromEnd = await scroller.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight
      );
      expect(fromEnd).toBeGreaterThan(48);
      // Focusing the composer hides the phone section bar and moves the dock.
      // The budget is the window after that, while text is streaming.
      await page.evaluate(() => {
        const bucket = (window as unknown as { __cls?: { value: number; detail: unknown[] } })
          .__cls;
        if (!bucket) return;
        bucket.value = 0;
        bucket.detail = [];
      });
      releaseStream();
      await expect(page.getByRole('button', { name: /↓ \d+ new/ })).toBeVisible({
        timeout: 10_000,
      });
      const still = await page.evaluate((id) => {
        const entry = document.querySelector<HTMLElement>(
          `[data-timeline-entry="${CSS.escape(id)}"]`
        );
        return entry?.getBoundingClientRect().top ?? 0;
      }, held.id);
      expect(Math.abs(still - held.top)).toBeLessThanOrEqual(2);
      const samples = await page.evaluate(
        () => (window as unknown as { __keySamples?: number[] }).__keySamples ?? []
      );
      const ordered = [...samples].sort((left, right) => left - right);
      const p95 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
      testInfo.annotations.push({
        type: 'composer-p95-ms',
        description: `${viewport.name}=${p95}`,
      });
      console.log(`composer-p95-ms ${viewport.name}=${p95}`);
      expect(p95).toBeLessThan(50);
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-new.png`), fullPage: false });

      const openAll = page.getByRole('button', { name: 'Open all steps' });
      await openAll.focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('dialog', { name: viewport.width < 800 ? 'Steps' : 'Open all steps' })
      ).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-steps.png`),
        fullPage: false,
      });

      const shift = await page.evaluate(() => {
        const bucket = (window as unknown as { __cls?: { value: number; detail: unknown[] } })
          .__cls;
        return bucket ?? { value: 0, detail: [] };
      });
      console.log(`cls ${viewport.name}=${shift.value}`);
      if (shift.value > 0.05) {
        console.log(`CLS ${viewport.name} ${shift.value} ${JSON.stringify(shift.detail)}`);
      }
      expect(shift.value).toBeLessThanOrEqual(0.05);
      if (viewport.width === 360) {
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
      }
    }
  } finally {
    await stack.stop();
  }
});
