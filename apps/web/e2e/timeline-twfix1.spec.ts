import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListHumanAttentionResponseSchema,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

const shotsDir =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-twfix1');

function runEntry(input: {
  order: number;
  turnId: string;
  items: TimelineItem[];
  steps: number;
  userId: string;
  running?: boolean;
  startedAt?: string;
}): TimelineRunEntry {
  return {
    id: input.turnId,
    admissionOrder: input.order,
    status: input.running ? 'running' : 'completed',
    triggerActor: { kind: 'user', id: input.userId },
    agentId: null,
    triggerSource: null,
    startedAt: input.startedAt ?? '2026-11-08T12:00:00.000Z',
    completedAt: input.running ? null : '2026-11-08T12:00:01.000Z',
    durationMs: input.running ? null : 1000,
    error: null,
    long: input.steps > 100,
    narrative: input.items,
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: input.steps,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: input.items.length,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  };
}

test('decision sheet, new updates and live Now stay honest', async ({ page }) => {
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
      name: 'Timeline fix check',
      visibility: 'workspace',
    });
    const threadId = thread.id;
    const turn = await client.operations['turn.start']({
      workspaceId,
      threadId,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence so the timeline check has a run.',
    });
    await expect
      .poll(
        async () => {
          const dashboard = await client.operations['thread.dashboard']({ workspaceId, threadId });
          return dashboard.turns.some((entry) => entry.id === turn.id);
        },
        { timeout: 40_000 }
      )
      .toBe(true);

    const userId = allocateEntityId('usr');
    const recent = new Date(Date.now() - 15_000).toISOString();
    const historical = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString();
    const askedAt = new Date(Date.now() - 20_000).toISOString();
    const questionId = allocateEntityId('it');
    const missingId = allocateEntityId('it');
    const noteId = allocateEntityId('it');
    const questionText = 'Which date format should exports use?';

    const note = (id: string, turnId: string, text: string, createdAt: string): TimelineItem => {
      const value = ItemSchema.parse({
        id,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId,
        type: 'user-message',
        status: 'completed',
        actor: { kind: 'user', id: userId },
        text,
        createdAt,
        completedAt: createdAt,
      });
      return {
        id,
        turnId,
        type: 'user-message',
        placement: 'narrative',
        status: 'completed',
        createdAt,
        completedAt: createdAt,
        actor: value.actor ?? null,
        detail: { kind: 'complete', value },
        steer: null,
      };
    };
    const questionValue = ItemSchema.parse({
      id: questionId,
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: userId,
      userInputRequestId: 'uir1',
      prompt: questionText,
      questions: [
        {
          id: 'tone',
          header: 'Tone',
          question: questionText,
          options: null,
          isOther: false,
          isSecret: false,
        },
      ],
      createdAt: askedAt,
      completedAt: askedAt,
    });
    const question: TimelineItem = {
      id: questionId,
      turnId: turn.id,
      type: 'user-input-request',
      placement: 'narrative',
      status: 'completed',
      createdAt: askedAt,
      completedAt: askedAt,
      actor: null,
      detail: { kind: 'complete', value: questionValue },
      steer: null,
    };
    const fillers = Array.from({ length: 8 }, (_, index) => {
      const turnId = allocateEntityId('tu');
      const itemId = allocateEntityId('it');
      return runEntry({
        order: index + 1,
        turnId,
        userId,
        steps: 0,
        items: [note(itemId, turnId, `Earlier note ${index + 1}`, historical)],
      });
    });
    const main = runEntry({
      order: 9,
      turnId: turn.id,
      userId,
      steps: 501,
      running: true,
      startedAt: recent,
      items: [note(noteId, turn.id, 'Live note from Ada', historical), question],
    });
    const extraTurnId = allocateEntityId('tu');
    const extraItemId = allocateEntityId('it');
    const extra = runEntry({
      order: 10,
      turnId: extraTurnId,
      userId,
      steps: 0,
      items: [note(extraItemId, extraTurnId, 'A note that just arrived', recent)],
    });
    const stepItems = [1, 2].map((index) => {
      const itemId = allocateEntityId('it');
      const value = ItemSchema.parse({
        id: itemId,
        owner: { kind: 'workspace', workspaceId },
        threadId,
        turnId: turn.id,
        type: 'reasoning',
        status: 'completed',
        createdAt: recent,
        completedAt: recent,
        summary: [`Step ${index}`],
        content: [`Detail ${index}`],
      });
      return {
        id: itemId,
        turnId: turn.id,
        type: 'reasoning' as const,
        placement: 'step' as const,
        status: 'completed' as const,
        createdAt: recent,
        completedAt: recent,
        actor: null,
        detail: { kind: 'complete' as const, value },
        steer: null,
      };
    });
    let revealNew = false;
    const pageFor = (body: { view?: string }) => {
      const runs = revealNew ? [...fillers, main, extra] : [...fillers, main];
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
          digest: { lines: [], coverage: 'complete' as const },
          restrictedReferences: false,
        };
      }
      return {
        workspaceId,
        threadId,
        view: 'runs' as const,
        runs,
        items: [],
        beforeCursor: null,
        afterCursor: null,
        itemWindow: null,
        anchor: null,
        catchUpAnchor: null,
        digest: { lines: [], coverage: 'complete' as const },
        restrictedReferences: false,
      };
    };
    const attention = ListHumanAttentionResponseSchema.parse({
      items: [
        {
          id: 'att-loaded',
          kind: 'question',
          workspaceId,
          threadId,
          turnId: turn.id,
          itemId: questionId,
          title: 'Answer required',
          summary: 'Answer the question on its pending request.',
          severity: 'needs_input',
          createdAt: historical,
          ageSeconds: 60,
          blocking: true,
          source: {
            type: 'protocol_item',
            itemType: 'user-input-request',
            workspaceId,
            threadId,
            turnId: turn.id,
            itemId: questionId,
          },
          actions: [],
        },
        {
          id: 'att-missing',
          kind: 'question',
          workspaceId,
          threadId,
          turnId: turn.id,
          itemId: missingId,
          title: 'Answer required',
          summary: 'Answer the question on its pending request.',
          severity: 'needs_input',
          createdAt: askedAt,
          ageSeconds: 20,
          blocking: true,
          source: {
            type: 'protocol_item',
            itemType: 'user-input-request',
            workspaceId,
            threadId,
            turnId: turn.id,
            itemId: missingId,
          },
          actions: [],
        },
      ],
    });

    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const request = route.request().postDataJSON() as { view?: string };
      const payload = ThreadTimelineResponseSchema.parse(pageFor(request));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await page.route('**/api/app/operations/thread.dashboard', async (route) => {
      const response = await route.fetch();
      const body = JSON.parse(await response.text()) as {
        turns?: {
          id: string;
          status: string;
          startedAt: string | null;
          completedAt: string | null;
        }[];
        now?: unknown;
      };
      const match = body.turns?.find((entry) => entry.id === turn.id) ?? body.turns?.at(-1);
      if (match) {
        match.status = 'running';
        match.startedAt = recent;
        match.completedAt = null;
      }
      body.now = {
        turnId: turn.id,
        status: 'running',
        step: null,
        lastEventAt: null,
        queuePosition: null,
        stepsReportedLive: null,
      };
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    await page.route('**/api/app/operations/attention.list', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(attention),
      });
    });
    const readState = { readItemIds: [] as string[], unreadItemIds: [noteId] };
    await page.route('**/api/app/operations/thread.read-state', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(readState),
      });
    });
    await page.route('**/api/app/operations/thread.mark-read', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(readState),
      });
    });
    // A completed simulator run must not overwrite the patched running turn.
    await page.route('**/api/workspaces/**/events**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': hold\n\n',
      });
    });

    await mkdir(shotsDir, { recursive: true });
    const prefix = `${stack.webUrl}/chat/${workspaceId}/${threadId}`;

    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'phone', width: 360, height: 740 },
    ] as const) {
      revealNew = false;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(prefix);
      await expect(page.getByText('Live note from Ada').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/no activity for/)).toHaveCount(0);
      await expect(page.getByText(/Thinking/).first()).toBeVisible();
      await expect(page.getByText(questionText).first()).toBeVisible();

      const mark = page
        .locator('[data-read-dock="bar"]')
        .getByRole('button', { name: 'Mark read' });
      await expect(mark).toBeVisible();
      const placed = await mark.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const dock = node.closest('[data-read-dock="bar"]');
        return {
          mid: rect.x + rect.width / 2,
          width: window.innerWidth,
          docked: dock instanceof HTMLElement,
        };
      });
      expect(placed.docked).toBe(true);
      expect(placed.mid).toBeLessThan(placed.width * 0.4);
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-bar.png`), fullPage: false });

      if (viewport.width < 800) {
        const bar = page.getByRole('button', { name: /2 needs you/ });
        await expect(bar).toBeVisible();
        await bar.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Decision' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(questionText)).toHaveCount(1);
        const fieldFollows = await dialog.evaluate((node, text) => {
          const questionNode = [...node.querySelectorAll('p')].find((entry) =>
            entry.textContent?.includes(text)
          );
          const field = node.querySelector(
            '[data-decision-body] input, [data-decision-body] textarea'
          );
          if (!questionNode || !(field instanceof HTMLElement)) return false;
          const following = Node.DOCUMENT_POSITION_FOLLOWING;
          return (
            (questionNode.compareDocumentPosition(field) & following) === following &&
            field.closest('[data-decision-footer]') == null
          );
        }, questionText);
        expect(fieldFollows).toBe(true);
        const submit = dialog.getByRole('button', { name: 'Submit answers' });
        const submitBox = await submit.boundingBox();
        expect(submitBox).not.toBeNull();
        expect(submitBox!.y).toBeGreaterThan(viewport.height * 0.6);
        await expect(dialog.getByText(/\d+ s ago/)).toBeVisible();
        await expect(dialog.getByText(/Nov/)).toHaveCount(0);
        await page.screenshot({
          path: join(shotsDir, `${viewport.name}-decision.png`),
          fullPage: false,
        });
        await dialog.getByRole('button', { name: /Next decision/ }).focus();
        await page.keyboard.press('Enter');
        await expect(dialog.getByText('Answer required')).toBeVisible();
        await expect(dialog.getByText('Work is waiting')).toBeVisible();
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
        await page.screenshot({
          path: join(shotsDir, `${viewport.name}-unloaded.png`),
          fullPage: false,
        });
        await dialog.getByRole('button', { name: 'Close' }).focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);
      }

      const scroller = page.locator('[data-timeline-scroll]');
      await scroller.evaluate((node) => {
        node.scrollTop = 0;
      });
      await expect
        .poll(() =>
          scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
        )
        .toBeGreaterThan(48);
      revealNew = true;
      await expect(page.getByRole('button', { name: /↓ \d+ new/ })).toBeVisible({
        timeout: 15_000,
      });
      const overlaps = await page.evaluate(() => {
        const pill = document.querySelector('[data-new-updates-dock] button');
        const scroller = document.querySelector('[data-timeline-scroll]');
        if (!(pill instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return true;
        if (pill.closest('[data-timeline-scroll]')) return true;
        const box = pill.getBoundingClientRect();
        const port = scroller.getBoundingClientRect();
        if (box.top < port.bottom - 1) return true;
        const visible = (rect: DOMRect) => {
          const top = Math.max(rect.top, port.top);
          const bottom = Math.min(rect.bottom, port.bottom);
          const left = Math.max(rect.left, port.left);
          const right = Math.min(rect.right, port.right);
          if (bottom <= top || right <= left) return null;
          return { top, bottom, left, right };
        };
        return [...scroller.querySelectorAll('button, [data-timeline-entry]')].some((entry) => {
          const seen = visible(entry.getBoundingClientRect());
          if (!seen) return false;
          return (
            box.top < seen.bottom &&
            box.bottom > seen.top &&
            box.left < seen.right &&
            box.right > seen.left
          );
        });
      });
      expect(overlaps).toBe(false);
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-pill.png`), fullPage: false });

      const openAll = page.getByRole('button', { name: 'Open all steps' });
      await openAll.scrollIntoViewIfNeeded();
      await openAll.focus();
      await page.keyboard.press('Enter');
      const steps = page.getByRole('dialog', { name: 'Steps' });
      await expect(steps).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Open all steps' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Close inspector' })).toHaveCount(0);
      await expect(steps.getByText('Step 1')).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `${viewport.name}-steps.png`),
        fullPage: false,
      });
    }
  } finally {
    await stack.stop();
  }
});
