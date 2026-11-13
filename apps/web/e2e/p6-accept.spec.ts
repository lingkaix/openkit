import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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

// P6 / U1,U3,U10–U12: assembled product acceptance, never query-result seeds.
// The simulator owns bootstrap/records; controlled HTTP projections keep UI cases deterministic.
const HUMAN = 'Please prepare the release note. User content may say Turn';
const CLAIM = 'The release note is ready for review.';
const GENERATED = 'A generated continuation summary.';
const STEER = 'Keep the release note concise.';
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
  options: { needs?: boolean; live?: boolean; paging?: boolean; interrupted?: boolean } = {}
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
  const older = neighbour(9, 'Earlier recorded release context');
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
              : [...(state.earlier ? [older] : []), mainRun(), ...(state.later ? [newer] : [])],
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
async function thumb(locator: Locator) {
  const box = await locator.boundingBox();
  console.log('P6 thumb', await locator.textContent(), JSON.stringify(box));
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(740 * 0.6);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}
async function axe(page: Page) {
  const require = createRequire(import.meta.url);
  const path = createRequire(require.resolve('vitest-axe')).resolve('axe-core/axe.min.js');
  await page.addScriptTag({ path });
  const violations = await page.evaluate(async () => {
    const engine = (
      window as unknown as {
        axe: {
          run: (context: Element) => Promise<{
            violations: { id: string; impact: string | null; nodes: { target: unknown }[] }[];
          }>;
        };
      }
    ).axe;
    const result = await engine.run(document.body);
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
  });
  console.log('P6 axe', JSON.stringify(violations));
  expect(violations).toEqual([]);
}

test('P6 two-deep Steps to Inspector Back and focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const f = await open(page);
  const fold = page.getByRole('button', { name: /^1 steps/ }).first();
  await fold.click();
  const steps = page.getByRole('dialog', { name: 'Steps', exact: true });
  await expect(steps).toBeVisible();
  const inspect = steps.getByRole('button', { name: 'Inspect', exact: true });
  await expect(inspect).toBeVisible();
  await inspect.click();
  await expect(page.getByRole('dialog', { name: 'Inspector', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Inspector', exact: true })).toBeHidden();
  await expect(steps).toBeVisible();
  await expect(inspect).toBeFocused();
  await page.goBack();
  await expect(steps).toBeHidden();
  await expect(fold).toBeFocused();
  expect(f.faults).toEqual([]);
});

test('P6 unconditional live phone Steer in the thumb zone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const f = await open(page, { live: true });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill(STEER);
  const steer = page.getByRole('button', { name: 'Steer', exact: true });
  const stop = page.getByRole('button', { name: 'Stop run', exact: true });
  await expect(steer).toBeVisible();
  await expect(stop).toBeVisible();
  await thumb(steer);
  await thumb(stop);
  await expect(steer).toBeEnabled();
  console.log(
    'P6 Steer form owner',
    await steer.evaluate((node) => Boolean((node as HTMLButtonElement).form))
  );
  await steer.click();
  await expect
    .poll(() =>
      f.calls.some(
        (c) => c.name === 'task.steer' && c.input.input === STEER && c.input.turnId === f.turnId
      )
    )
    .toBe(true);
  await expect(page.getByText('Accepted by the running worker', { exact: true })).toBeVisible();
  expect(
    f.calls.some(
      (c) => c.name === 'task.steer' && c.input.input === STEER && c.input.turnId === f.turnId
    )
  ).toBe(true);
  expect(f.faults).toEqual([]);
});

test('P6 unconditional live phone Stop in the thumb zone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const f = await open(page, { live: true });
  const stop = page.getByRole('button', { name: 'Stop run', exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  await thumb(stop);
  page.on('dialog', (dialog) => dialog.accept());
  await stop.click();
  // Accommodate the existing DOM or native confirmation; never branch on live-control presence.
  const confirm = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: /Stop/ }).click();
  await expect
    .poll(() => f.calls.some((c) => c.name === 'turn.interrupt' && c.input.turnId === f.turnId))
    .toBe(true);
  await expect(stop).toBeHidden();
  expect(f.faults).toEqual([]);
});

test('P6 assembled S1 feed articles and axe', async ({ page }) => {
  const f = await open(page);
  const feed = page.getByRole('feed');
  expect.soft(await feed.count()).toBe(1);
  expect
    .soft(await feed.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-busy'))))
    .toEqual(['false']);
  expect.soft(await feed.getByRole('article').count()).toBeGreaterThan(0);
  await axe(page);
  expect(f.faults).toEqual([]);
});

test('P6 assembled S2 Needs you decision sheet axe and keyboard trap', async ({ page }) => {
  const f = await open(page, { needs: true });
  await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator('[data-phone-bar]').click();
  const decision = page.getByRole('dialog', { name: 'Decision', exact: true });
  await expect(decision).toBeVisible();
  for (let count = 0; count < 12; count += 1) {
    await page.keyboard.press('Tab');
    expect(await decision.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await axe(page);
  expect(f.faults).toEqual([]);
});

test('P6 keyboard paging keeps focus and reaches Needs you', async ({ page }) => {
  const f = await open(page, { needs: true, paging: true });
  const earlier = page.getByRole('button', { name: 'Load earlier', exact: true });
  const later = page.getByRole('button', { name: 'Load later', exact: true });
  await expect(earlier).toBeAttached();
  await expect(later).toBeAttached();
  await tabTo(page, earlier);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Earlier recorded release context', { exact: true })).toBeAttached();
  await expect(earlier).toBeEnabled();
  await expect.soft(earlier).toBeFocused();
  await tabTo(page, later);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Later recorded release context', { exact: true })).toBeAttached();
  await expect(later).toBeEnabled();
  await expect.soft(later).toBeFocused();
  const need = page
    .getByRole('region', { name: 'Needs you', exact: true })
    .getByRole('button')
    .first();
  await tabTo(page, need);
  await page.keyboard.press('Enter');
  await expect(page.locator(`#timeline-item-${f.questionId}`)).toBeFocused();
  expect(f.faults).toEqual([]);
});

for (const theme of ['spectrum', 'paper', 'noir']) {
  test(`P6 computed voices and typography in ${theme}`, async ({ page }) => {
    await page.addInitScript(
      (value) =>
        localStorage.setItem(
          'openkit-theme',
          JSON.stringify({ state: { theme: value }, version: 0 })
        ),
      theme
    );
    const f = await open(page, { interrupted: true });
    await page.getByRole('button', { name: /^Full/ }).first().click();
    await expect(page.getByText(GENERATED, { exact: true })).toBeVisible();
    const human = page.getByText(f.humanText, { exact: true });
    const claim = page.getByText(CLAIM, { exact: true });
    const fact = page
      .locator('p[data-voice="fact"]')
      .filter({ hasText: 'counted from records' })
      .first();
    const generated = page.locator('[data-voice="derived"]').filter({ hasText: GENERATED }).first();
    const outcome = page
      .locator('p[data-invariant="true"]')
      .filter({ hasText: /^Stopped$/ })
      .first();
    const measure = async (node: Locator) =>
      node.evaluate((element) => {
        const s = getComputedStyle(element);
        let surface = s.backgroundColor;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (surface !== 'rgba(0, 0, 0, 0)') break;
          surface = getComputedStyle(parent).backgroundColor;
          if (parent.tagName === 'ARTICLE') break;
        }
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;width:72ch';
        probe.style.fontFamily = s.fontFamily;
        probe.style.fontSize = s.fontSize;
        probe.style.fontWeight = s.fontWeight;
        probe.style.fontStyle = s.fontStyle;
        probe.style.fontStretch = s.fontStretch;
        probe.style.fontVariantNumeric = s.fontVariantNumeric;
        document.body.append(probe);
        const measure72 = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          width: element.getBoundingClientRect().width,
          measure72,
          surface,
          font: Number.parseFloat(s.fontSize),
          line: Number.parseFloat(s.lineHeight),
          weight: Number(s.fontWeight),
          background: s.backgroundColor,
          border: s.borderLeftStyle,
          borderWidth: Number.parseFloat(s.borderLeftWidth),
          numeric: s.fontVariantNumeric,
          max: s.maxWidth,
        };
      });
    const styles = {
      human: await measure(human),
      claim: await measure(claim),
      fact: await measure(fact),
      generated: await measure(generated),
    };
    const raised = await page.evaluate(() => {
      const sample = document.createElement('span');
      sample.style.backgroundColor = 'var(--surface-card)';
      document.body.append(sample);
      const value = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return value;
    });
    console.log('P6 computed', theme, JSON.stringify(styles));
    expect.soft(styles.human.font).toBe(16);
    expect.soft(styles.human.line).toBe(24);
    expect.soft(styles.human.width).toBeLessThanOrEqual(styles.human.measure72 + 1);
    expect.soft(styles.claim.width).toBeLessThanOrEqual(styles.claim.measure72 + 1);
    expect
      .soft(styles.human.surface, 'Human voice uses the existing raised card surface')
      .toBe(raised);
    expect.soft(styles.claim.font).toBe(16);
    expect.soft(styles.claim.line).toBe(24);
    expect.soft(styles.claim.surface).toBe('rgba(0, 0, 0, 0)');
    expect.soft(styles.fact.font).toBe(14);
    expect.soft(styles.fact.numeric).toContain('tabular-nums');
    expect.soft(styles.fact.border).toBe('solid');
    expect.soft(styles.fact.borderWidth).toBeGreaterThan(0);
    expect.soft(styles.generated.border).toBe('dotted');
    await expect(generated.getByText('Generated', { exact: true })).toBeVisible();
    await expect(outcome).toBeVisible();
    const outcomeStyle = await measure(outcome);
    console.log('P6 outcome', theme, JSON.stringify(outcomeStyle));
    expect.soft(outcomeStyle.font).toBe(16);
    expect.soft(outcomeStyle.weight).toBe(500);
    expect(f.faults).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
  });
}

test('P6 rendered Work copy excludes identifiers enums digests and internal words', async ({
  page,
}) => {
  const f = await open(page, { needs: true });
  await expect(page.getByRole('button', { name: 'Work lens', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // This disclosure is genuinely available in Work. Scan its rendered content, not hidden text.
  const history = page.getByText('Covered history range', { exact: true });
  if (await history.isVisible()) await history.click();
  const user = page.getByText(f.humanText, { exact: true });
  await expect(user).toBeVisible();
  // Exempt only the actual user-authored body, not its product-authored author metadata.
  await user.evaluate((node) => {
    (node as HTMLElement).dataset.p6UserContent = 'true';
  });
  const text = await page.getByRole('main').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const values: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (
        !parent ||
        parent.closest(
          '[data-p6-user-content], [aria-label="Complete exact effect"], textarea, input, script, style, [hidden], [aria-hidden="true"]'
        )
      )
        continue;
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
    return values.join(' ');
  });
  const forbidden =
    /(?:^|·)\s*(?:running|completed|interrupted)\b|\b(?:Turn|Item|AgentSession|Harness|AEP|Provider\s+route|CapabilityCall|Shard|Policy\s+revision)\b|\b(?:ws|th|tu|it|usr|as|agent|apr|mat|art|rev|cap)_[a-z0-9_-]{8,}|sha256:[a-f0-9]{16,}|\b[a-f0-9]{64}\b|\b(?:command-execution|assistant-message|user-message|context-summary|approval-request|user-input-request|provider_unavailable)\b/gi;
  const leaks = text.match(forbidden) ?? [];
  console.log('P6 Work copy leaks', JSON.stringify(leaks));
  expect(leaks).toEqual([]);
  expect(f.faults).toEqual([]);
});
