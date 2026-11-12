import type { ThreadTimelineInput } from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { type TimelineRead, timelineFixture } from '../src/screens/chat/timeline/tw4fix2-fixture';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

// Owner: conversation_timeline, Loading And Performance and U12. Browser-only
// checks here decide viewport/focus; the other rows use the real renderer in Vitest.
let stack: IsolatedWebStack;
let workspaceId: string;
let threadId: string;
test.beforeAll(async () => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const workspace = (await client.operations['workspace.list']({})).items[0]?.workspace;
  if (!workspace) throw new Error('Isolated fixture has no Workspace.');
  workspaceId = workspace.id;
  threadId = (
    await client.operations['thread.create']({
      workspaceId,
      name: 'Independent window regressions',
      visibility: 'workspace',
    })
  ).id;
});
test.afterAll(async () => {
  await stack?.stop();
});

async function routeTimeline(page: Page, read: TimelineRead) {
  await page.route('**/api/app/operations/thread.timeline', async (route) => {
    await route.fulfill({ json: read(route.request().postDataJSON() as ThreadTimelineInput) });
  });
}
function url(search = '') {
  return `${stack.webUrl}/chat/${workspaceId}/${threadId}${search}`;
}

test('R1 an unpaged reader keeps the visible entry when latest advances', async ({ page }) => {
  test.setTimeout(60_000);
  const f = timelineFixture(workspaceId, threadId);
  const runs = Array.from({ length: 32 }, (_, index) => {
    const turn = allocateEntityId('tu');
    return f.run(index + 1, turn, [
      f.detail(f.message(turn, `Reader entry ${index + 1}: ${'retained context '.repeat(8)}`)),
    ]);
  });
  let advanced = false;
  let releaseEarlier = () => {};
  const earlier = new Promise<void>((resolve) => {
    releaseEarlier = resolve;
  });
  await page.route('**/api/app/operations/thread.timeline', async (route) => {
    const input = route.request().postDataJSON() as ThreadTimelineInput;
    if (input.cursor) {
      // A normal slow earlier read must not be needed to keep content already read.
      await earlier;
      await route.fulfill({ json: f.page([runs[0]!]) });
      return;
    }
    await route.fulfill({
      json: f.page(advanced ? runs.slice(1) : runs.slice(0, 31), {
        beforeCursor: advanced ? 'before-2' : null,
      }),
    });
  });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url());
    const reader = page.getByText(/^Reader entry 1:/);
    await expect(reader).toBeVisible();
    await page.locator('[data-timeline-scroll]').evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect(reader).toBeInViewport();
    const before = (await reader.boundingBox())!.y;
    advanced = true;
    await page.waitForResponse(
      async (response) => {
        if (!response.url().endsWith('/thread.timeline') || !response.ok()) return false;
        const payload = await response.json();
        return payload.runs?.[0]?.admissionOrder === 2;
      },
      { timeout: 25_000 }
    );
    await expect(reader).toBeInViewport({ timeout: 1000 });
    expect(Math.abs((await reader.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  } finally {
    releaseEarlier();
  }
});

test('R4a an anchored running step on phone opens Steps and focuses its content', async ({
  page,
}) => {
  const f = timelineFixture(workspaceId, threadId),
    turn = allocateEntityId('tu');
  const step = f.command(turn, 'Phone anchored inspection');
  const run = f.run(1, turn, [f.detail(f.message(turn, 'Inspect this running step'))], 1, {
    status: 'running',
    completedAt: null,
  });
  await routeTimeline(page, () =>
    f.page([run], {
      anchor: { turnId: turn, itemId: step.id },
      itemWindow: { turnId: turn, items: [f.detail(step)], beforeCursor: null, afterCursor: null },
    })
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(url(`?item=${step.id}`));
  const sheet = page.getByRole('dialog', { name: 'Steps' });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  const content = sheet.getByText('Phone anchored inspection', { exact: true });
  await expect(content).toBeInViewport();
  await expect
    .poll(() =>
      content.evaluate((node) => {
        const active = document.activeElement;
        return active !== document.body && active?.contains(node);
      })
    )
    .toBe(true);
});

test('R4b an anchored progress note is in view and receives focus', async ({ page }) => {
  const f = timelineFixture(workspaceId, threadId),
    turn = allocateEntityId('tu');
  const note = f.item(turn, { type: 'assistant-message', text: 'Anchored progress note' });
  const run = f.run(
    1,
    turn,
    [f.detail(f.message(turn, 'Request before note')), f.detail(note)],
    0,
    { long: true, noteItemIds: [note.id] }
  );
  await routeTimeline(page, () =>
    f.page([run], {
      anchor: { turnId: turn, itemId: note.id },
      itemWindow: { turnId: turn, items: [f.detail(note)], beforeCursor: null, afterCursor: null },
    })
  );
  await page.goto(url(`?item=${note.id}`));
  const content = page.getByText('Anchored progress note', { exact: true }).first();
  await expect(content).toBeInViewport({ timeout: 10_000 });
  await expect
    .poll(
      () =>
        content.evaluate((node) => {
          const active = document.activeElement;
          return active !== document.body && active?.contains(node);
        }),
      { message: 'The addressed note, not the page body, must own keyboard focus' }
    )
    .toBe(true);
});
