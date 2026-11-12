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

// RA3-SF3 / RUNANCHOR2-VERIFY: inherited HTML inertness must retain the same
// pending run-placement intent as an inert attribute on the entry itself.
type Counts = { focus: number; scroll: number };
declare global {
  interface Window {
    __ra3Placement?: Counts;
  }
}
let stack: IsolatedWebStack;
let client: CoreClient;
let workspaceId: string;

test.describe('RA3 inert placement resumption', () => {
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

  for (const owner of ['self', 'ancestor'] as const) {
    test(`${owner} inertness resumes the addressed run after its owner clears`, async ({
      page,
    }) => {
      await journey(page, owner);
    });
  }
});

async function frames(page: Page, total: number) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const step = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    total
  );
}
async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => ({ ...window.__ra3Placement! }));
}
async function observe(page: Page, targetId: string) {
  await page.addInitScript((target) => {
    const calls = { focus: 0, scroll: 0 };
    window.__ra3Placement = calls;
    const addressed = (node: HTMLElement) =>
      node.closest('[data-timeline-entry]')?.getAttribute('data-timeline-entry') === target;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      if (addressed(this)) calls.focus += 1;
      focus.call(this, options);
    };
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      if (addressed(this)) calls.scroll += 1;
      scroll.call(this, options);
    };
  }, targetId);
}

async function journey(page: Page, owner: 'self' | 'ancestor') {
  const name = `RA3 ${owner} inert owner`;
  const thread = await client.operations['thread.create']({
    workspaceId,
    name,
    visibility: 'workspace',
  });
  const threadId = thread.id;
  if (!isThreadId(threadId)) throw new Error('The native owner returned no Thread identity.');
  const latest = await client.operations['turn.start']({
    workspaceId,
    threadId,
    agentId: 'agent_codex_host',
    modelId: 'reasoning',
    input: 'Reply with one short sentence.',
  });
  await expect
    .poll(
      async () => {
        const dashboard = await client.operations['thread.dashboard']({ workspaceId, threadId });
        return dashboard.turns.find((turn) => turn.id === latest.id)?.status;
      },
      { timeout: 45_000 }
    )
    .toMatch(/completed|failed|cancelled/);

  // The shared fixture's prefix types are narrower than SDK response strings;
  // the native identities have been checked by public protocol validators.
  const f = tw8Fixture(
    workspaceId as NonNullable<Parameters<typeof tw8Fixture>[0]>,
    threadId as NonNullable<Parameters<typeof tw8Fixture>[1]>
  );
  const targetId = allocateEntityId('tu');
  const targetText = 'RA3 addressed historical run';
  const runs = Array.from({ length: 31 }, (_, index) =>
    f.run(
      index + 1,
      index === 20 ? targetId : index === 30 ? latest.id : allocateEntityId('tu'),
      index === 20
        ? targetText
        : index === 30
          ? 'RA3 latest run'
          : `Earlier run ${index + 1}: ${'retained context '.repeat(8)}`
    )
  );
  await observe(page, targetId);
  let anchoredReadDelivered = false;
  await page.route(`**${operationHttpPath('thread.timeline')}`, async (route) => {
    const input = ThreadTimelineInputSchema.parse(route.request().postDataJSON());
    const addressed = input.anchor?.kind === 'turn' && input.anchor.turnId === targetId;
    await route.fulfill({
      json: ThreadTimelineResponseSchema.parse(
        f.page(runs, addressed ? { turnId: targetId } : null)
      ),
    });
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
            threadId,
            turnId: targetId,
            category: 'artifact',
            action: 'artifact.version-commit',
            outcome: 'succeeded',
            summary: 'RA3 historical Audit event',
            severity: 'info',
            createdAt: f.at,
          },
          ...body.auditEvents,
        ].slice(0, 50),
      }),
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${stack.webUrl}/chat/${workspaceId}/${threadId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('RA3 latest run', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.goto(`${stack.webUrl}/workspace/usage`);
  await page.getByRole('button', { name: 'Records', exact: true }).click();
  const source = page
    .getByText('RA3 historical Audit event', { exact: true })
    .locator('..')
    .getByRole('link', { name: new RegExp(`^From: ${name}`) });
  await expect(source).toBeVisible();

  let release = () => {};
  const reveal = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gateEntered = false;
  let catalogDelivered = false;
  await page.route(`**${operationHttpPath('conversation.targets')}`, async (route) => {
    const definition = OPERATION_DEFINITIONS['conversation.targets'];
    const input = definition.inputSchema.parse(route.request().postDataJSON());
    if (input.threadId !== threadId) {
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

  let clearInert: (() => Promise<void>) | undefined;
  try {
    await source.click();
    const content = page.getByText(targetText, { exact: true });
    await expect.poll(() => gateEntered).toBe(true);
    await expect.poll(() => anchoredReadDelivered).toBe(true);
    await expect(content).toBeAttached();
    await expect(content).not.toBeVisible();
    expect(await counts(page), 'The hidden opening has not been placed').toEqual({
      focus: 0,
      scroll: 0,
    });

    // Browser-boundary fault injection, not a retained-record or query write.
    // Attribute ownership is the only difference between the two cases.
    const inertOwner = await content.evaluateHandle((node, kind) => {
      const entry = node.closest<HTMLElement>('[data-timeline-entry]');
      const held = kind === 'ancestor' ? entry?.parentElement : entry;
      if (!held) throw new Error('The addressed run has no inert owner.');
      held.inert = true;
      return held;
    }, owner);
    clearInert = () =>
      inertOwner.evaluate((node) => {
        node.inert = false;
      });
    release();
    await expect.poll(() => catalogDelivered).toBe(true);
    await expect
      .poll(() => content.evaluate((node) => node.getBoundingClientRect().height > 0))
      .toBe(true);
    const blocked = await content.evaluate((node) => {
      const entry = node.closest<HTMLElement>('[data-timeline-entry]')!;
      return { own: entry.inert, inherited: Boolean(entry.closest('[inert]')) };
    });
    expect(blocked).toEqual({ own: owner === 'self', inherited: true });
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[role="dialog"], [role="menu"]'))
      )
    ).toBe(false);
    await frames(page, 45);
    const before = await counts(page);
    console.log(`RA3 ${owner} blocked-focus=${before.focus} blocked-scroll=${before.scroll}`);
    expect(
      before.focus,
      'Inert content must not receive per-frame placement attempts'
    ).toBeLessThanOrEqual(1);
    expect(
      before.scroll,
      'Inert content must not receive per-frame scroll attempts'
    ).toBeLessThanOrEqual(1);

    await clearInert();
    expect(await content.evaluate((node) => Boolean(node.closest('[inert]')))).toBe(false);
    // No user scroll, navigation or competing focus occurs. The pending intent
    // must therefore survive until its inert owner clears, regardless of where
    // the attribute was attached.
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
          message: 'Clearing the inert owner must resume focus on the addressed run',
        }
      )
      .toBe(true);
    const completed = await counts(page);
    expect(completed.focus - before.focus).toBeLessThanOrEqual(1);
    expect(completed.scroll - before.scroll).toBeLessThanOrEqual(1);
    await frames(page, 30);
    expect(await counts(page), 'Completed placement must not restart').toEqual(completed);
    console.log(`RA3 ${owner} target-in-view=1 target-focused=1 resumed-once=1`);
  } finally {
    release();
    await clearInert?.();
  }
}
