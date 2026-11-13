import { createHash, randomUUID } from 'node:crypto';
import {
  ListHumanAttentionResponseSchema,
  OPERATION_DEFINITIONS,
  type OperationId,
  ThreadDashboardResponseSchema,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId, type Item, ItemSchema, ProductTurnSchema } from '@openkit/protocol';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

// P6-FIX / U11–U12: preserve a later focus choice and offer useful, identifier-safe history.
// The simulator owns bootstrap/records; controlled HTTP projections keep UI cases deterministic.
const HUMAN = 'Please prepare the release note. User content may say Turn';
const CLAIM = 'The release note is ready for review.';
const GENERATED = 'A generated continuation summary.';
let stack: IsolatedWebStack;
let guards: string[][] = [];
test.beforeEach(() => {
  guards = [];
});

test.beforeAll(async () => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.close();
  expect(guards.flat(), 'All transport projections satisfy public schemas').toEqual([]);
});
test.afterAll(async () => {
  await stack?.stop();
});

async function fixture(
  page: Page,
  options: {
    needs?: boolean;
    live?: boolean;
    paging?: boolean;
    interrupted?: boolean;
    padding?: boolean;
  } = {}
) {
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const workspace = (await client.operations['workspace.list']({})).items[0]?.workspace;
  if (!workspace) throw new Error('The disposable simulator must admit a Workspace.');
  const ws = workspace.id;
  const thread = await client.operations['thread.create']({
    workspaceId: ws,
    name: 'Release review',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  const turn = await client.operations['turn.start']({
    workspaceId: ws,
    threadId: thread.id,
    agentId: 'agent_codex_host',
    modelId: 'reasoning',
    input: 'Prepare a release note for the acceptance reader.',
  });
  await expect
    .poll(
      async () =>
        (
          await client.operations['thread.items']({ workspaceId: ws, threadId: thread.id })
        ).items.some((item) => item.type === 'command-execution'),
      { timeout: 30_000 }
    )
    .toBe(true);
  const admitted = await client.operations['thread.dashboard']({
    workspaceId: ws,
    threadId: thread.id,
  });
  const nativeItems = (
    await client.operations['thread.items']({ workspaceId: ws, threadId: thread.id })
  ).items;
  const question = nativeItems.find((item) => item.type === 'user-input-request');
  if (options.needs && !question)
    throw new Error('The existing simulator must produce its pending question.');
  const viewer = admitted.viewerUserId;
  if (!viewer) throw new Error('The admitted response must name the current viewer.');
  const at = new Date(Date.now() - 60_000).toISOString();
  const owner = { kind: 'workspace' as const, workspaceId: ws };
  const make = (fields: Record<string, unknown>) =>
    ItemSchema.parse({
      id: allocateEntityId('it'),
      owner,
      threadId: thread.id,
      turnId: turn.id,
      status: 'completed',
      createdAt: at,
      completedAt: at,
      ...fields,
    });
  const humanText = `${HUMAN} ${turn.id}`;
  const human = make({
    type: 'user-message',
    actor: { kind: 'user', id: viewer },
    text: humanText,
  });
  const claim = make({ type: 'assistant-message', text: CLAIM });
  const hash = `sha256:${createHash('sha256')
    .update(humanText + CLAIM)
    .digest('hex')}`;
  const generated = make({
    type: 'context-summary',
    strategy: 'rolling',
    logicalModelId: 'reasoning',
    text: GENERATED,
    environmentDigest: hash,
    sourceRange: {
      firstItemId: human.id,
      lastItemId: claim.id,
      itemCount: 2,
      sourceDigest: hash,
      evidenceDigest: hash,
    },
  });
  const step = make({
    type: 'command-execution',
    command: 'printf release-ready',
    cwd: '.',
    output: 'release-ready',
    exitCode: 0,
    durationMs: 1200,
  });
  const detail = (value: Item): TimelineItem => ({
    id: value.id,
    turnId: value.turnId,
    type: value.type,
    placement: value.type === 'command-execution' ? 'step' : 'narrative',
    status: value.status,
    createdAt: value.createdAt,
    completedAt: value.completedAt ?? null,
    actor: 'actor' in value ? (value.actor ?? null) : null,
    detail: { kind: 'complete', value },
    steer: null,
  });
  const state: {
    status: 'running' | 'completed' | 'interrupted';
    steer: TimelineItem | null;
    earlier: boolean;
    later: boolean;
  } = {
    status: options.live ? 'running' : options.interrupted ? 'interrupted' : 'completed',
    steer: null as TimelineItem | null,
    earlier: false,
    later: false,
  };
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const faults: string[] = [];
  guards.push(faults);
  const mainRun = (): TimelineRunEntry => ({
    id: turn.id,
    admissionOrder: 10,
    status: state.status,
    triggerActor: { kind: 'user', id: viewer },
    agentId: turn.agentId ?? null,
    triggerSource: null,
    startedAt: at,
    completedAt: state.status === 'running' ? null : at,
    durationMs: state.status === 'running' ? null : 1200,
    error: null,
    long: false,
    narrative: [
      detail(human),
      detail(claim),
      detail(generated),
      ...(options.needs && question ? [detail(question)] : []),
      ...(state.steer ? [state.steer] : []),
    ],
    plan: null,
    noteItemIds: [],
    finalItemId: claim.id,
    narrativeCursor: null,
    statistics: {
      steps: 1,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: 2,
      itemCounts: { 'command-execution': 1, 'user-message': 1, 'assistant-message': 1 },
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  });
  const neighbour = (order: number, label: string) => {
    const id = allocateEntityId('tu');
    const value = make({ turnId: id, type: 'assistant-message', text: label });
    return {
      ...mainRun(),
      id,
      admissionOrder: order,
      narrative: [detail(value)],
      finalItemId: value.id,
      statistics: { ...mainRun().statistics, steps: 0, messages: 1 },
    };
  };
  const padding = options.padding
    ? Array.from({ length: 8 }, (_, i) => neighbour(i + 2, `Recorded release context ${i + 1}`))
    : [];
  const older = neighbour(options.padding ? 1 : 9, 'Earlier recorded release context');
  const newer = neighbour(11, 'Later recorded release context');
  const apiTurn = () =>
    ProductTurnSchema.parse({
      ...turn,
      status: state.status,
      startedAt: at,
      completedAt: state.status === 'running' ? null : at,
      durationMs: state.status === 'running' ? null : 1200,
    });
  const dashboard = () =>
    ThreadDashboardResponseSchema.parse({
      ...admitted,
      serverTime: new Date().toISOString(),
      turns: [apiTurn()],
      pendingRequests: options.needs ? admitted.pendingRequests : [],
      now:
        options.live && state.status === 'running'
          ? {
              turnId: turn.id,
              status: 'running',
              step: { itemId: step.id, kind: 'command-execution', title: null, startedAt: at },
              lastEventAt: at,
              queuePosition: null,
              stepsReportedLive: true,
            }
          : undefined,
      workStatus: {
        selectedAgentId: turn.agentId ?? null,
        activeTurnStatus: state.status,
        pendingApprovalCount: 0,
        pendingQuestionCount: options.needs ? 1 : 0,
        latestArtifact: null,
      },
    });
  const attention = () =>
    ListHumanAttentionResponseSchema.parse({
      items:
        options.needs && question
          ? [
              {
                id: `question:${question.id}`,
                kind: 'question',
                workspaceId: ws,
                threadId: thread.id,
                turnId: turn.id,
                itemId: question.id,
                title: 'Choose a release style',
                summary: 'Answer the pending release question.',
                createdAt: at,
                blocking: true,
                severity: 'needs_input',
                source: {
                  type: 'protocol_item',
                  itemType: 'user-input-request',
                  workspaceId: ws,
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: question.id,
                },
                actions: [],
              },
            ]
          : [],
    });
  const catalog = await client.operations['conversation.targets']({
    workspaceId: ws,
    threadId: thread.id,
  });
  const chosen =
    catalog.targets.find((t) => t.kind === 'new-task-worker' || t.kind === 'warm-worker') ??
    catalog.targets[0];
  if (!chosen) throw new Error('The simulator must supply a conversation target.');
  const methods: OperationId[] = [
    'thread.timeline',
    'thread.dashboard',
    'thread.read-state',
    'attention.list',
    ...(options.live ? ['conversation.targets', 'task.steer', 'turn.interrupt'] : []),
  ] as OperationId[];
  for (const name of methods) {
    await page.route(`**/api/app/operations/${name}`, async (route) => {
      try {
        const definition = OPERATION_DEFINITIONS[name];
        const wire = route.request().postDataJSON();
        // The real SDK carries mutating request identity in this public header, not JSON.
        const input = definition.inputSchema.parse(
          definition.mutating
            ? { ...wire, requestId: await route.request().headerValue('x-openkit-request-id') }
            : wire
        ) as Record<string, unknown>;
        calls.push({ name, input });
        let body: unknown;
        if (name === 'thread.dashboard') body = dashboard();
        else if (name === 'thread.read-state')
          body = { scope: 'window', readItemIds: [], unreadItemIds: [] };
        else if (name === 'attention.list') body = attention();
        else if (name === 'conversation.targets')
          body = {
            ...catalog,
            defaultTargetRef: chosen.targetRef,
            targets: [
              {
                ...chosen,
                kind: 'running-worker',
                availability: 'available',
                unavailableReason: null,
                activeTurnId: turn.id,
                steerAvailability: 'available',
                steerUnavailableReason: null,
              },
            ],
          };
        else if (name === 'task.steer') {
          const value = make({
            type: 'user-message',
            actor: { kind: 'user', id: viewer },
            text: input.input,
          });
          state.steer = {
            ...detail(value),
            steer: { requestId: String(input.requestId), state: 'accepted', reason: null },
          };
          body = {
            workspaceId: ws,
            threadId: thread.id,
            turnId: turn.id,
            inputItemId: value.id,
            delivery: 'accepted',
          };
        } else if (name === 'turn.interrupt') {
          state.status = 'interrupted' as typeof state.status;
          body = apiTurn();
        } else {
          const itemView =
            input.cursor === 'p6-older' || input.cursor === 'p6-newer'
              ? false
              : input.view === 'items';
          if (input.cursor === 'p6-older') state.earlier = true;
          if (input.cursor === 'p6-newer') state.later = true;
          body = ThreadTimelineResponseSchema.parse({
            workspaceId: ws,
            threadId: thread.id,
            view: itemView ? 'items' : 'runs',
            runs: itemView
              ? []
              : [
                  ...(state.earlier ? [older] : []),
                  ...padding,
                  mainRun(),
                  ...(state.later ? [newer] : []),
                ],
            items: itemView ? [detail(step)] : [],
            beforeCursor: options.paging && !itemView ? 'p6-older' : null,
            afterCursor: options.paging && !itemView ? 'p6-newer' : null,
            itemWindow: null,
            anchor: { turnId: turn.id },
            catchUpAnchor: null,
            earlierUnread: null,
            digest: { lines: [], coverage: 'complete' },
            restrictedReferences: false,
          });
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(definition.outputSchema.parse(body)),
        });
      } catch (error) {
        faults.push(`${name}: ${String(error)}`);
        await route.abort();
      }
    });
  }
  await page.route('**/api/workspaces/**/events**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ': controlled acceptance read\n\n',
    })
  );
  return {
    range: { firstItemId: human.id, lastItemId: claim.id, itemCount: 2 },
    humanText,
    url: `${stack.webUrl}/tasks/${ws}/${thread.id}?turn=${turn.id}`,
    turnId: turn.id,
    questionId: question?.id,
    calls,
    faults,
  };
}

async function open(page: Page, options: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(page, options);
  await page.goto(f.url);
  await expect(page.getByText(CLAIM, { exact: true })).toBeVisible({ timeout: 20_000 });
  return f;
}
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
}

// Read actual painted text, not hidden descendants of a closed disclosure.
async function renderedCopy(root: Locator, omitSummaries = false) {
  return root.evaluate((node, omit) => {
    const excluded =
      '[data-p6fix-user-content], [aria-label="Complete exact effect"], textarea, input, script, style, [hidden], [aria-hidden="true"]';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const values: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest(excluded) || (omit && parent.closest('summary'))) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility !== 'visible') continue;
      const closed = parent.closest('details:not([open])');
      if (closed && !closed.querySelector('summary')?.contains(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      if (!Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0))
        continue;
      values.push(walker.currentNode.textContent ?? '');
    }
    const links = Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter(
        (link) =>
          link.getClientRects().length > 0 &&
          getComputedStyle(link).visibility === 'visible' &&
          !link.closest(excluded) &&
          !(omit && link.closest('summary'))
      )
      .map((link) => ({
        href: link.getAttribute('href') ?? '',
        label: link.getAttribute('aria-label') ?? link.textContent ?? '',
      }));
    return { text: values.join(' ').replace(/\s+/g, ' ').trim(), links };
  }, omitSummaries);
}

test('P6FIX F1 keeps a subsequent keyboard focus choice after the earlier response', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 740 });
  const f = await open(page, { paging: true, needs: true, padding: true });
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let armed = false;
  await page.route('**/api/app/operations/thread.timeline', async (route) => {
    const cursor = route.request().postDataJSON().cursor;
    if (armed && (cursor === 'p6-older' || cursor === 'p6-newer')) {
      if (cursor === 'p6-older') observed();
      // Hold concurrent sentinel prefetches too: none may settle the paging flag before the choice.
      await held;
    }
    await route.fallback();
  });
  try {
    const earlier = page.getByRole('button', { name: 'Load earlier', exact: true });
    await expect(earlier).toBeEnabled();
    await earlier.evaluate((node) => node.focus({ preventScroll: true }));
    await expect(earlier).toBeFocused();
    armed = true;
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith('/api/app/operations/thread.timeline') &&
        reply.request().postDataJSON()?.cursor === 'p6-older'
    );
    await page.keyboard.press('Enter');
    await requested;
    const feed = page.getByRole('feed');
    await expect(feed).toHaveAttribute('aria-busy', 'true');
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await tabTo(page, message);
    await expect(message).toBeFocused();
    await expect(feed).toHaveAttribute('aria-busy', 'true');
    console.log('P6FIX F1 chosen focus before response: Message');
    release();
    await response;
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    await expect(
      page.getByText('Earlier recorded release context', { exact: true })
    ).toBeAttached();
    // Sample after the admitted render has painted, including queued query notifications/layout effects.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const focus = await message.evaluate((node) => ({
      kept: node === document.activeElement,
      actual: document.activeElement?.textContent?.trim() ?? '',
    }));
    console.log('P6FIX F1 settled focus', JSON.stringify(focus));
    // The read and its layout effects have settled: fail the contract directly, not a retry timeout.
    expect(focus.kept, 'The reader chose Message while the earlier HTTP response was pending').toBe(
      true
    );
    expect(f.faults).toEqual([]);
  } finally {
    release();
  }
});

test('P6FIX F2 Work is identifier-safe and every offered history disclosure is meaningful', async ({
  page,
}) => {
  const f = await open(page);
  const user = page.getByText(f.humanText, { exact: true });
  await expect(user).toBeVisible();
  await user.evaluate((node) => {
    (node as HTMLElement).dataset.p6fixUserContent = 'true';
  });
  for (const lens of ['Work', 'Full']) {
    await page.getByRole('button', { name: `${lens} lens`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${lens} lens`, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const generated = page.locator('[data-voice="derived"]').filter({ hasText: GENERATED }).first();
    const disclosures = generated.locator('details');
    const count = await disclosures.count();
    for (let index = 0; index < count; index += 1) {
      const disclosure = disclosures.nth(index);
      if (!(await disclosure.isVisible())) continue;
      if (!(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)))
        await disclosure.locator(':scope > summary').click();
      const body = await renderedCopy(disclosure, true);
      const boundaries =
        body.text.includes(f.range.firstItemId) && body.text.includes(f.range.lastItemId);
      const coverageCount =
        new RegExp(`\\b${f.range.itemCount}\\b`).test(body.text) &&
        /\b(messages?|records?|entries|replies|history)\b/i.test(body.text);
      const summary =
        (await disclosure.locator(':scope > summary').textContent())
          ?.replace(/\s+/g, ' ')
          .trim()
          .toLowerCase() ?? '';
      const rangeProse =
        body.text.toLowerCase() !== summary &&
        body.text.split(/\s+/).length >= 3 &&
        /\b(earlier|covered|history|range|messages?|replies|through|from)\b/i.test(body.text);
      const usefulLink = body.links.some(
        (link) =>
          link.href.trim() !== '' &&
          link.href.trim() !== '#' &&
          !/^javascript:/i.test(link.href) &&
          /\b(history|range|messages?|earlier|covered)\b/i.test(link.label)
      );
      const meaningful = boundaries || coverageCount || rangeProse || usefulLink;
      console.log(
        'P6FIX F2 disclosure',
        JSON.stringify({ lens, offered: true, text: body.text, meaningful })
      );
      expect
        .soft(
          meaningful,
          `${lens}: an offered covered-history disclosure needs useful range content or navigation`
        )
        .toBe(true);
    }
    // A view may simply omit the control. No existence/count assertion forces one implementation.
    if (lens === 'Work') {
      const product = await renderedCopy(page.getByRole('main'));
      const raw =
        product.text.match(
          /\b(?:ws|th|tu|it|usr|as|agent|apr|mat|art|rev|cap)_[a-z0-9_-]{8,}|\bsha256:[a-f0-9]{64}\b/gi
        ) ?? [];
      console.log('P6FIX F2 Work raw identifiers', JSON.stringify(raw));
      expect.soft(raw).toEqual([]);
      expect.soft(product.text).not.toContain(f.range.firstItemId);
      expect.soft(product.text).not.toContain(f.range.lastItemId);
    }
  }
  expect(f.faults).toEqual([]);
});
