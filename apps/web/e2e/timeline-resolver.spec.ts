import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadTimelineResponseSchema, type TimelineRunEntry } from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

const shotsDir =
  process.env.OPENKIT_E2E_SHOTS_DIR ?? join(tmpdir(), 'openkit-e2e-shots', 'timeline-resolver');

const ORIGINAL = '# Exact original\n\nKeep the first exact version.\n';
const REVISED = '# Head revision\n\nThis is a different version.\n';
const THREAD_NAME = 'TW8 origin notes';

/**
 * One approval row the attention read can return.
 * Five of these in one thread merge. One per thread overflows the cap.
 */
function approvalRow(workspaceId: string, threadId: string, title: string) {
  const turnId = allocateEntityId('tu');
  const itemId = allocateEntityId('it');
  const approvalRequestId = `tw8-${allocateEntityId('tu').slice(3)}`;
  return {
    id: `approval:${approvalRequestId}`,
    kind: 'approval' as const,
    workspaceId,
    threadId,
    turnId,
    itemId,
    title,
    summary: 'The draft is waiting.',
    severity: 'needs_input' as const,
    createdAt: '2026-11-08T12:00:00.000Z',
    ageSeconds: 30,
    blocking: true,
    source: {
      type: 'approval' as const,
      approvalRequestId,
      workspaceId,
      threadId,
      turnId,
      itemId,
    },
    actions: [
      { kind: 'grant_approval' as const, label: 'Approve', method: 'POST' as const },
      { kind: 'deny_approval' as const, label: 'Deny', method: 'POST' as const },
    ],
  };
}

/**
 * Attention reads stay empty until `prime` has seen the new page's baseline.
 * The following poll, about five seconds later, returns the rows under test.
 */
async function armAttention(page: Page, rows: () => unknown[]) {
  let live = false;
  await page.route('**/api/app/operations/attention.list', async (route) => {
    await route.fulfill({ json: { items: live ? rows() : [] } });
  });
  return {
    async prime(url: string) {
      live = false;
      await page.goto(url, { waitUntil: 'commit' });
      await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/app/operations/attention.list' && response.ok()
      );
      await page.waitForTimeout(1_000);
      live = true;
    },
  };
}

/** Eighteen completed runs, enough for the thread scroller to leave the bottom. */
function tallTimeline(workspaceId: string, threadId: string) {
  const userId = allocateEntityId('usr');
  const runs: TimelineRunEntry[] = Array.from({ length: 18 }, (_, index) => {
    const turnId = allocateEntityId('tu');
    const itemId = allocateEntityId('it');
    const value = ItemSchema.parse({
      id: itemId,
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: userId },
      text: `Restore note ${index + 1}`,
      createdAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:00.000Z',
    });
    return {
      id: turnId,
      admissionOrder: index + 1,
      status: 'completed',
      triggerActor: { kind: 'user', id: userId },
      agentId: null,
      triggerSource: null,
      startedAt: '2026-11-08T12:00:00.000Z',
      completedAt: '2026-11-08T12:00:01.000Z',
      durationMs: 1000,
      error: null,
      long: false,
      narrative: [
        {
          id: itemId,
          turnId,
          type: 'user-message',
          placement: 'narrative',
          status: 'completed',
          createdAt: value.createdAt,
          completedAt: value.completedAt,
          actor: { kind: 'user', id: userId },
          detail: { kind: 'complete', value },
          steer: null,
        },
      ],
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps: 0,
        filesChanged: 0,
        messages: 1,
        itemCounts: {},
        coverage: 'complete',
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
    };
  });
  return ThreadTimelineResponseSchema.parse({
    workspaceId,
    threadId,
    view: 'runs',
    runs,
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: null,
    restrictedReferences: false,
  });
}

test('resolves an exact output, hides a private source, and toasts within the cap', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  let attentionRows: unknown[] = [];
  const attention = await armAttention(page, () => attentionRows);
  try {
    const workspace = (await client.operations['workspace.list']({})).items.find(
      ({ workspace }) => workspace.kind === 'code'
    )?.workspace;
    if (!workspace) throw new Error('The isolated stack has no code Workspace.');
    const workspaceId = workspace.id;
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: THREAD_NAME,
      visibility: 'workspace',
    });
    const siblings = await Promise.all(
      ['North notes', 'East notes', 'South notes'].map((name) =>
        client.operations['thread.create']({
          workspaceId,
          name,
          visibility: 'workspace',
        })
      )
    );
    const bytes = new Blob([ORIGINAL]);
    const imported = await client.artifactFiles.import(
      {
        workspaceId,
        requestId: createRequestId(),
        title: 'Exact report',
        mediaType: 'text/markdown',
        byteLength: bytes.size,
        contentDigest: `sha256:${createHash('sha256').update(ORIGINAL).digest('hex')}`,
      },
      bytes
    );
    const committed = await client.operations['artifact.version-commit']({
      workspaceId,
      artifactId: imported.artifactId,
      threadId: thread.id,
      expectedArtifactVersion: 1,
      title: 'Exact report',
      summary: null,
      content: { format: 'markdown', body: REVISED },
      requestId: createRequestId(),
    });
    expect(committed.artifact.version).toBe(2);
    expect(committed.version.threadId).toBe(thread.id);
    await mkdir(shotsDir, { recursive: true });

    const artifactUrl = (version: number | null) => {
      const params = new URLSearchParams({
        workspaceId,
        artifact: imported.artifactId,
      });
      if (version !== null) params.set('version', String(version));
      return `${stack.webUrl}/artifacts?${params.toString()}`;
    };

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(artifactUrl(1));
    const history = page.getByRole('region', { name: 'Artifact version history' });
    await expect(history.getByText('Viewing version 1', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(history.getByText('Current head: version 2', { exact: true })).toBeVisible();
    await expect(history.getByText(REVISED, { exact: true })).toHaveCount(0);
    const downloadUrl = await history
      .getByRole('link', { name: 'Download original' })
      .getAttribute('href');
    if (!downloadUrl) throw new Error('The exact original download is unavailable.');
    expect(new URL(downloadUrl, stack.webUrl).searchParams.get('artifactVersion')).toBe('1');
    await page.screenshot({ path: join(shotsDir, 'desktop-exact-version.png'), fullPage: false });

    await page.goto(artifactUrl(3));
    await expect(history.getByText('Version 3 unavailable', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      history.getByRole('link', { name: "Open the output's version list" })
    ).toBeVisible();
    await expect(history.getByText(REVISED, { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: join(shotsDir, 'desktop-version-unavailable.png'),
      fullPage: false,
    });

    await page.goto(artifactUrl(2));
    const fromOutput = history.getByRole('link', { name: new RegExp(`From: ${THREAD_NAME}`) });
    await expect(fromOutput).toBeVisible({ timeout: 20_000 });
    const fromHref = await fromOutput.getAttribute('href');
    expect(fromHref).toContain('turn=');
    expect(fromHref).toContain(committed.version.turnId);
    await page.screenshot({ path: join(shotsDir, 'desktop-output-backlink.png'), fullPage: false });

    await page.route('**/api/app/operations/audit.workspace-list', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { auditEvents?: Record<string, unknown>[] };
      const events = Array.isArray(body.auditEvents) ? body.auditEvents : [];
      if (!events.some((event) => event.threadId === thread.id)) {
        events.unshift({
          id: 'aud_11111111-2222-5333-8444-555555555555',
          workspaceId,
          threadId: thread.id,
          turnId: committed.version.turnId,
          category: 'artifact',
          action: 'artifact.version-commit',
          outcome: 'succeeded',
          summary: 'Saved a new output version.',
          severity: 'info',
          createdAt: '2026-11-08T10:02:00.000Z',
        });
      }
      await route.fulfill({ json: { ...body, auditEvents: events } });
    });
    await page.goto(`${stack.webUrl}/workspace/usage`);
    await page.getByRole('button', { name: 'Records', exact: true }).click();
    const fromAudit = page.getByRole('link', { name: new RegExp(`From: ${THREAD_NAME}`) });
    await expect(fromAudit.first()).toBeVisible({ timeout: 20_000 });
    await fromAudit.first().scrollIntoViewIfNeeded();
    await expect(fromAudit.first()).toBeInViewport();
    await page.screenshot({ path: join(shotsDir, 'desktop-audit-backlink.png'), fullPage: false });

    attentionRows = Array.from({ length: 5 }, (_, index) =>
      approvalRow(workspaceId, thread.id, `Review draft ${index + 1}`)
    );
    await attention.prime(artifactUrl(2));
    const merged = page.getByRole('alertdialog').filter({
      hasText: `5 decisions need you in ${THREAD_NAME}`,
    });
    await expect(merged).toBeVisible({ timeout: 15_000 });
    await expect(merged.getByRole('button', { name: 'View', exact: true })).toBeVisible();
    await expect(merged.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(merged.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(shotsDir, 'desktop-merged-toast.png'), fullPage: false });

    attentionRows = [thread, ...siblings].map((item, index) =>
      approvalRow(workspaceId, item.id, `Review lane ${index + 1}`)
    );
    await attention.prime(`${stack.webUrl}/artifacts?workspaceId=${workspaceId}`);
    const overflow = page
      .getByRole('alertdialog')
      .filter({ hasText: '+2 more · Open Action Center' });
    await expect(overflow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(3);
    await page.screenshot({ path: join(shotsDir, 'desktop-toast-overflow.png'), fullPage: false });

    await page.route('**/api/app/operations/conversation.navigation', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items?: { thread?: { id?: string } }[] };
      const items = (body.items ?? []).filter((item) => item.thread?.id !== thread.id);
      await route.fulfill({ json: { ...body, items } });
    });
    await page.goto(artifactUrl(2));
    await expect(history.getByText('Source not available to you', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(history.getByRole('link', { name: new RegExp(THREAD_NAME) })).toHaveCount(0);
    await page.screenshot({ path: join(shotsDir, 'desktop-private-source.png'), fullPage: false });

    await page.unroute('**/api/app/operations/conversation.navigation');
    await page.setViewportSize({ width: 1280, height: 800 });
    const tall = tallTimeline(workspaceId, thread.id);
    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      await route.fulfill({ json: tall });
    });
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await expect(page.locator('[data-timeline-entry]').nth(10)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Full lens' }).click();
    await expect(page.locator('[data-timeline-lens="full"]')).toBeVisible();
    const savedTop = await page.locator('[data-timeline-scroll]').evaluate((node) => {
      const scroller = node as HTMLElement;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 240);
      scroller.scrollTop = target;
      scroller.dispatchEvent(new Event('scroll'));
      return scroller.scrollTop;
    });
    expect(savedTop).toBeGreaterThan(40);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const state = window.history.state as {
            usr?: { timeline?: { scrollTop?: number } };
          } | null;
          return state?.usr?.timeline?.scrollTop ?? -1;
        })
      )
      .toBeGreaterThan(40);
    await page.screenshot({ path: join(shotsDir, 'desktop-scrolled-thread.png'), fullPage: false });
    await page.goto(`${stack.webUrl}/artifacts?workspaceId=${workspaceId}`);
    await page.goBack();
    await expect(page.locator('[data-timeline-lens="full"]')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const top = await page
            .locator('[data-timeline-scroll]')
            .evaluate((node) => (node as HTMLElement).scrollTop);
          return Math.abs(top - savedTop);
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(2);
    await page.screenshot({ path: join(shotsDir, 'desktop-back-scroll.png'), fullPage: false });
    await page.unroute('**/api/app/operations/thread.timeline');
    await page.setViewportSize({ width: 360, height: 740 });
    attentionRows = [thread, ...siblings].map((item, index) =>
      approvalRow(workspaceId, item.id, `Review phone ${index + 1}`)
    );
    await attention.prime(`${stack.webUrl}/artifacts?workspaceId=${workspaceId}`);
    const phoneMore = page
      .getByRole('alertdialog')
      .filter({ hasText: '+4 more · Open Action Center' });
    await expect(phoneMore).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await page.screenshot({ path: join(shotsDir, 'phone-toast-overflow.png'), fullPage: false });

    const turnId = allocateEntityId('tu');
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}?steps=${turnId}`);
    const sheet = page.getByRole('dialog', { name: 'Steps' });
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(shotsDir, 'phone-sheet.png'), fullPage: false });
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    expect(page.url()).toContain(`/chat/${workspaceId}/${thread.id}`);
    expect(page.url()).not.toContain('steps=');
    await page.screenshot({ path: join(shotsDir, 'phone-sheet-closed.png'), fullPage: false });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(artifactUrl(1));
    await expect(history.getByText('Viewing version 1', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: join(shotsDir, 'phone-exact-version.png'), fullPage: false });

    expect(runtimeErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
