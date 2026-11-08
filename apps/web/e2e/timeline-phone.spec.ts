import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createCoreClient } from '@openkit/core-client';
import { expect, type Page, test } from '@playwright/test';
import { whenCaptureFenceReleases } from './_lib/capture-fence.js';
import { startIsolatedWebStack } from './_lib/servers.js';

const SHOTS = '/home/simonx/AI/temp/backlog-20261015/evidence/timeline-design/tw7-shots';

test.use({ viewport: { width: 360, height: 740 } });

test('fits S1–S3 on a phone: bar, decision sheet, steps, inspector, composer', async ({ page }) => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;

    const thread = await whenCaptureFenceReleases(() =>
      client.operations['thread.create']({
        workspaceId,
        name: 'Phone timeline',
        visibility: 'workspace',
        requestId: randomUUID(),
      })
    );
    const content = '# Release\n\nExact worker input.\n';
    const { materialId } = await client.operations['material.create']({
      workspaceId,
      title: 'Release Material',
      kind: 'markdown',
      sensitivity: 'internal',
      requestId: randomUUID(),
    });
    await client.operations['material.revision-save']({
      workspaceId,
      materialId,
      expectedRevisionId: null,
      content,
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      requestId: randomUUID(),
    });
    await client.operations['material.bind']({
      workspaceId,
      threadId: thread.id,
      materialId,
      expectedBindingState: 'not_bound',
      requestId: randomUUID(),
    });
    const requestId = randomUUID();
    const started = await page.request.post(`${stack.coreUrl}/api/app/operations/task.start`, {
      headers: { 'x-openkit-request-id': requestId },
      data: {
        workspaceId,
        threadId: thread.id,
        input: 'Create a summary from the exact first release revision.',
        requestId,
      },
    });
    expect(started.status(), await started.text()).toBe(202);
    const taskUrl = `${stack.webUrl}/tasks/${workspaceId}/${thread.id}`;
    await page.goto(taskUrl);
    await expect(page.getByText('Which summary tone should the simulator use?')).toBeVisible({
      timeout: 30_000,
    });
    const bar = page.locator('[data-phone-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('needs you');
    await page.screenshot({ path: `${SHOTS}/phone-bar.png` });

    await bar.click();
    const decision = page.getByRole('dialog', { name: 'Decision' });
    await expect(decision).toBeVisible();
    await expect(
      decision.getByText('The agent receives your answer on its next run.')
    ).toBeVisible();
    await expect(decision.getByText(/Work (is waiting|continues meanwhile)/)).toBeVisible();
    const primary = decision.getByRole('button', { name: 'Submit answers' });
    await expect(primary).toBeVisible();
    const primaryBox = await primary.boundingBox();
    expect(primaryBox).toBeTruthy();
    expect(primaryBox!.y).toBeGreaterThanOrEqual(740 * 0.6);
    await expect(page.getByRole('button', { name: 'Next decision (1 more) ›' })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/decision-sheet.png` });
    await assertTargets(page);
    await assertNoHorizontalScroll(page);

    await page.goBack();
    await expect(decision).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/tasks/${workspaceId}/${thread.id}`));
    await expect(bar).toBeFocused();

    const fold = page.getByRole('button', { name: /^\d+ steps/ }).first();
    await expect(fold).toBeVisible();
    await fold.click();
    const steps = page.getByRole('dialog', { name: 'Steps' });
    await expect(steps).toBeVisible();
    const stepsBox = await steps.boundingBox();
    expect(stepsBox).toBeTruthy();
    expect(stepsBox!.height).toBeGreaterThanOrEqual(740 * 0.55);
    expect(stepsBox!.height).toBeLessThanOrEqual(740 * 0.7);
    const stepsClose = steps.getByRole('button', { name: 'Close' });
    const closeBox = await stepsClose.boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${SHOTS}/steps-sheet.png` });
    await steps.getByRole('button', { name: 'Expand' }).click();
    await expect(steps).toHaveAttribute('data-expanded', 'true');
    await page.goBack();
    await expect(steps).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/tasks/${workspaceId}/${thread.id}`));

    await page.getByRole('button', { name: 'Inspect' }).first().click();
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/inspector-sheet.png` });
    await page.goBack();
    await expect(inspector).toBeHidden();

    await assertChips(page);
    await page.screenshot({ path: `${SHOTS}/composer.png` });

    const runThread = await whenCaptureFenceReleases(() =>
      client.operations['thread.create']({
        workspaceId,
        name: 'Phone run',
        visibility: 'workspace',
        requestId: randomUUID(),
      })
    );
    const runUrl = `${stack.webUrl}/tasks/${workspaceId}/${runThread.id}`;
    await page.goto(runUrl);
    await page.getByRole('textbox', { name: 'Message' }).fill('Keep this run on screen.');
    const stop = page.getByRole('button', { name: 'Stop run' });
    await page.getByRole('button', { name: 'Send message' }).click();
    const sawStop = await stop
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    await page.screenshot({ path: `${SHOTS}/composer-running.png` });
    if (sawStop) {
      const stopBox = await stop.boundingBox();
      expect(stopBox!.y).toBeGreaterThanOrEqual(740 * 0.6);
    }
    await expect(page.getByRole('button', { name: 'Steer' })).toBeDisabled();
    await expect(page.getByText("Steering isn't available yet.")).toBeVisible();

    const goalRequestId = randomUUID();
    let goalThreadId = '';
    try {
      const goalResponse = await page.request.post(
        `${stack.coreUrl}/api/app/operations/goal.create`,
        {
          timeout: 8_000,
          headers: { 'x-openkit-request-id': goalRequestId },
          data: { workspaceId, intent: 'Phone goal', requestId: goalRequestId },
        }
      );
      if (goalResponse.ok()) {
        const goal = (await goalResponse.json()) as { goal?: { threadId?: string } | null };
        goalThreadId = goal.goal?.threadId ?? '';
      }
    } catch {
      // The coordinator run can hold the response open. The Thread is already addressable.
    }
    if (!goalThreadId) {
      const listed = await client.operations['thread.list']({ workspaceId });
      const match = listed.items.find((entry) => entry.name === 'Phone goal');
      goalThreadId = match?.id ?? '';
    }
    expect(goalThreadId.length).toBeGreaterThan(0);
    await page.goto(`${stack.webUrl}/goals/${workspaceId}/${goalThreadId}`);
    await expect(page.getByRole('heading', { name: 'Phone goal' })).toBeVisible({
      timeout: 20_000,
    });
    const card = page.locator('[id^="goal-card-"]').first();
    if ((await card.count()) > 0) {
      const cardBox = await card.boundingBox();
      const navBox = await page.getByRole('navigation', { name: 'Sections' }).boundingBox();
      if (cardBox && navBox) {
        const overlaps = cardBox.y < navBox.y && cardBox.y + cardBox.height > navBox.y + 1;
        expect(overlaps).toBe(false);
      }
    }
    await page.screenshot({ path: `${SHOTS}/goal.png`, fullPage: true });
    await assertNoHorizontalScroll(page);
  } finally {
    await stack.stop();
  }
});

async function assertNoHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
}

async function assertTargets(page: Page) {
  const tooSmall = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll('button, a, input, textarea, [role="button"]'),
    ].filter((node) => {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return box.width < 44 || box.height < 44;
    });
    return nodes.slice(0, 8).map((node) => {
      const box = node.getBoundingClientRect();
      return `${node.tagName} ${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 40)} ${Math.round(box.width)}x${Math.round(box.height)}`;
    });
  });
  expect(tooSmall, tooSmall.join('\n')).toEqual([]);
}

async function assertChips(page: Page) {
  const chips = page.locator('[data-composer-chip]');
  const count = await chips.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const chip = chips.nth(index);
    const text = ((await chip.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(text.length, `chip ${index}`).toBeGreaterThan(1);
    const clipped = await chip.evaluate((node) => {
      const label = node.querySelector('.whitespace-nowrap') ?? node;
      return label.scrollWidth > label.clientWidth + 1;
    });
    expect(clipped, text).toBe(false);
  }
}
