import {
  OPERATION_DEFINITIONS,
  operationHttpPath,
  ThreadTimelineInputSchema,
  ThreadTimelineResponseSchema,
} from '@openkit/app-api-schemas';
import { type CoreClient, createCoreClient } from '@openkit/core-client';
import { allocateEntityId, isThreadId, isWorkspaceId } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { tw8Fixture } from '../src/screens/chat/timeline/tw8-verify-fixture';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

// RUNANCHOR-VERIFY S2 / Conversation Timeline U12: a pending run back-link
// waits for addressability without repeatedly fighting a user's modal. The
// browser records native placement calls; it never replaces their results.
type PlacementCall = {
  method: 'focus' | 'scroll';
  hidden: boolean;
  width: number;
  height: number;
};
declare global {
  interface Window {
    __runanchor2Placement?: PlacementCall[];
  }
}
type Journey = 'inside' | 'outside' | 'delayed' | 'modal';
let stack: IsolatedWebStack;
let client: CoreClient;
let workspaceId: string;

test.describe('RUNANCHOR2 placement respects modal-owned focus', () => {
  test.setTimeout(180_000);
  test.beforeAll(async () => {
    stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
    client = createCoreClient({ baseUrl: stack.coreUrl });
    const workspace = (await client.operations['workspace.list']({})).items[0]?.workspace;
    if (!workspace || !isWorkspaceId(workspace.id))
      throw new Error('The isolated stack has no admitted Workspace identity.');
    workspaceId = workspace.id;
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  for (const kind of ['inside', 'outside', 'delayed'] as const) {
    test(`positive: ${kind} run back-link is focused and in view`, async ({ page }) => {
      await runJourney(page, kind);
    });
  }
  test('an inert run gets at most one placement attempt while More owns focus, then resumes', async ({
    page,
  }) => {
    await runJourney(page, 'modal');
  });
});

/** Count calls to this addressed run only, preserving native browser effects. */
async function observePlacement(page: Page, turnId: string) {
  await page.addInitScript((target) => {
    const calls: PlacementCall[] = [];
    window.__runanchor2Placement = calls;
    const record = (element: HTMLElement, method: PlacementCall['method']) => {
      if (element.closest('[data-timeline-entry]')?.getAttribute('data-timeline-entry') !== target)
        return;
      const box = element.getBoundingClientRect();
      calls.push({
        method,
        hidden: Boolean(element.closest('[hidden]')),
        width: box.width,
        height: box.height,
      });
    };
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      record(this, 'focus');
      nativeFocus.call(this, options);
    };
    const nativeScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      record(this, 'scroll');
      nativeScroll.call(this, options);
    };
  }, turnId);
}

/** A fixed browser-frame window, not an elapsed-time guess or a mocked clock. */
async function frames(page: Page, count: number) {
  await page.evaluate(
    (total) =>
      new Promise<void>((resolve) => {
        let remaining = total;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count
  );
}
async function placementCounts(page: Page) {
  return page.evaluate(() => {
    const calls = window.__runanchor2Placement ?? [];
    return {
      focus: calls.filter((call) => call.method === 'focus').length,
      scroll: calls.filter((call) => call.method === 'scroll').length,
    };
  });
}

async function runJourney(page: Page, kind: Journey) {
  const threadName = `Independent ${kind} run anchor`;
  const thread = await client.operations['thread.create']({
    workspaceId,
    name: threadName,
    visibility: 'workspace',
  });
  const threadId = thread.id;
  if (!isThreadId(threadId)) throw new Error('The native owner returned no Thread identity.');
  const latest = await client.operations['turn.start']({
    workspaceId,
    threadId: thread.id,
    agentId: 'agent_codex_host',
    modelId: 'reasoning',
    input: 'Reply with one short sentence.',
  });
  await expect
    .poll(
      async () => {
        const dashboard = await client.operations['thread.dashboard']({
          workspaceId,
          threadId: thread.id,
        });
        return dashboard.turns.find((run) => run.id === latest.id)?.status;
      },
      { timeout: 45_000 }
    )
    .toMatch(/completed|failed|cancelled/);

  // The shared fixture's prefix types are narrower than SDK response strings.
  // Both native identities were checked with the public protocol validators.
  const f = tw8Fixture(
    workspaceId as NonNullable<Parameters<typeof tw8Fixture>[0]>,
    threadId as NonNullable<Parameters<typeof tw8Fixture>[1]>
  );
  const targetId = allocateEntityId('tu');
  const total = kind === 'outside' ? 93 : 31;
  const targetText = 'Independent historical run target';
  const runs = Array.from({ length: total }, (_, index) =>
    f.run(
      index + 1,
      index === 20 ? targetId : index === total - 1 ? latest.id : allocateEntityId('tu'),
      index === 20
        ? targetText
        : index === total - 1
          ? 'Latest admitted run'
          : `Earlier run ${index + 1}: ${'retained context '.repeat(8)}`
    )
  );
  await observePlacement(page, targetId);
  let anchoredReadDelivered = false;
  await page.route(`**${operationHttpPath('thread.timeline')}`, async (route) => {
    const input = ThreadTimelineInputSchema.parse(route.request().postDataJSON());
    const addressed = input.anchor?.kind === 'turn' && input.anchor.turnId === targetId;
    const selected = kind === 'outside' ? (addressed ? runs.slice(5, 36) : runs.slice(-31)) : runs;
    const body = ThreadTimelineResponseSchema.parse(
      f.page(selected, addressed ? { turnId: targetId } : null)
    );
    await route.fulfill({ json: body });
    if (addressed) anchoredReadDelivered = true;
  });
  await page.route(`**${operationHttpPath('audit.workspace-list')}`, async (route) => {
    const definition = OPERATION_DEFINITIONS['audit.workspace-list'];
    definition.inputSchema.parse(route.request().postDataJSON());
    const response = await route.fetch();
    const body = definition.outputSchema.parse(await response.json());
    await route.fulfill({
      json: definition.outputSchema.parse({
        ...body,
        auditEvents: [
          {
            id: 'aud_11111111-2222-5333-8444-555555555555',
            workspaceId,
            threadId: thread.id,
            turnId: targetId,
            category: 'artifact',
            action: 'artifact.version-commit',
            outcome: 'succeeded',
            summary: 'Independent historical Audit event',
            severity: 'info',
            createdAt: f.at,
          },
          ...body.auditEvents,
        ].slice(0, 50),
      }),
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
  await expect(page.getByRole('heading', { name: threadName, exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Latest admitted run', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  if (kind === 'outside') await expect(page.getByText(targetText, { exact: true })).toHaveCount(0);
  await page.goto(`${stack.webUrl}/workspace/usage`);
  await page.getByRole('button', { name: 'Records', exact: true }).click();
  const auditRow = page
    .getByText('Independent historical Audit event', { exact: true })
    .locator('..');
  const source = auditRow.getByRole('link', { name: new RegExp(`^From: ${threadName}`) });
  await expect(source).toBeVisible();

  let releaseReveal: (() => void) | undefined;
  let gateEntered = false;
  let catalogDelivered = false;
  if (kind === 'delayed' || kind === 'modal') {
    const reveal = new Promise<void>((resolve) => {
      releaseReveal = resolve;
    });
    await page.route(`**${operationHttpPath('conversation.targets')}`, async (route) => {
      const definition = OPERATION_DEFINITIONS['conversation.targets'];
      const input = definition.inputSchema.parse(route.request().postDataJSON());
      if (input.threadId !== thread.id) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      definition.outputSchema.parse(await response.json());
      gateEntered = true;
      await reveal;
      await route.fulfill({ response });
      catalogDelivered = true;
    });
  }

  try {
    await source.click();
    const content = page.getByText(targetText, { exact: true });
    if (releaseReveal) {
      await expect.poll(() => gateEntered).toBe(true);
      await expect.poll(() => anchoredReadDelivered).toBe(true);
      await expect(content).not.toBeVisible();
      await frames(page, 3);
      expect(await placementCounts(page), 'Hidden opening content must not be placed').toEqual({
        focus: 0,
        scroll: 0,
      });
      if (kind === 'modal') {
        await page.setViewportSize({ width: 360, height: 740 });
        await page.getByRole('button', { name: 'More', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'More', exact: true });
        await expect(dialog).toBeVisible();
        await expect
          .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
          .toBe(true);
        const before = await placementCounts(page);
        releaseReveal();
        await expect.poll(() => catalogDelivered).toBe(true);
        // Observe after the transport handoff without prescribing whether a fix
        // defers reveal, suspends focus, or uses another addressability signal.
        await frames(page, 45);
        const after = await placementCounts(page);
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        const focus = after.focus - before.focus;
        const scroll = after.scroll - before.scroll;
        console.log(`RUNANCHOR2 modal frames=45 focus-attempts=${focus} scroll-attempts=${scroll}`);
        // Dispatch bound: at most one attempted placement, not one per frame.
        // Soft assertions deliberately let the resumption checks execute on red.
        expect
          .soft(focus, 'Modal-owned focus permits at most one placement focus attempt')
          .toBeLessThanOrEqual(1);
        expect
          .soft(scroll, 'An inert run permits at most one placement scroll attempt')
          .toBeLessThanOrEqual(1);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      } else {
        releaseReveal();
      }
    }

    await expect(content).toBeInViewport({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          content.evaluate((node) => {
            const entry = node.closest('[data-timeline-entry]');
            return Boolean(
              entry &&
                document.activeElement !== document.body &&
                entry.contains(document.activeElement)
            );
          }),
        {
          timeout: 10_000,
          message: 'The addressed run must own focus after it becomes addressable',
        }
      )
      .toBe(true);
    const calls = await page.evaluate(() => window.__runanchor2Placement ?? []);
    expect(calls.filter((call) => call.method === 'focus').length).toBeGreaterThan(0);
    expect(calls.every((call) => !call.hidden && call.width > 0 && call.height > 0)).toBe(true);
    console.log(`RUNANCHOR2 ${kind} target-in-view=1 target-focused=1`);

    // Successful placement must finish: later human focus/scroll is not reclaimed.
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.click();
    const scroller = page.locator('[data-timeline-scroll]');
    await scroller.hover();
    await page.mouse.wheel(0, -500);
    let previous = -1;
    await expect
      .poll(async () => {
        const next = await scroller.evaluate((node) => node.scrollTop);
        const stable = previous === next;
        previous = next;
        return stable;
      })
      .toBe(true);
    const heldTop = await scroller.evaluate((node) => node.scrollTop);
    const heldCalls = await placementCounts(page);
    await frames(page, 30);
    await expect(message).toBeFocused();
    expect(await placementCounts(page)).toEqual(heldCalls);
    expect(
      Math.abs((await scroller.evaluate((node) => node.scrollTop)) - heldTop)
    ).toBeLessThanOrEqual(2);
  } finally {
    releaseReveal?.();
  }
}
