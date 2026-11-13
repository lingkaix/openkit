import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

test('phone retains a stable layout through a simulator run', async ({ page }) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  try {
    const client = createCoreClient({ baseUrl: stack.coreUrl });
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspaceId = workspaces[0]?.workspace.id;
    if (!workspaceId) throw new Error('The simulator must provide an accessible workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Phone layout lifecycle',
      visibility: 'workspace',
    });
    const selector = { workspaceId, threadId: thread.id };
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript(() => {
      const shifts: number[] = [];
      Object.assign(window, { p7LayoutShifts: shifts });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput?: boolean };
          if (shift.hadRecentInput !== true) shifts.push(shift.value);
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const turn = await client.operations['turn.start']({
      ...selector,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Prepare a deterministic plan.',
    });
    const turnId = turn.id;
    await expect
      .poll(
        async () => {
          const { items } = await client.operations['thread.items'](selector);
          return items.some(
            (item) =>
              item.turnId === turnId &&
              item.type === 'assistant-message' &&
              item.status === 'completed' &&
              item.text.trim().length > 0
          );
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const { items } = await client.operations['thread.items'](selector);
    const message = items.find(
      (item) =>
        item.turnId === turnId && item.type === 'assistant-message' && item.status === 'completed'
    );
    if (message?.type !== 'assistant-message') {
      throw new Error('The simulator must complete the submitted run with an assistant body.');
    }
    expect(message.text).toBe('Reviewing workspace context. Preparing a deterministic plan.');
    await page.getByRole('button', { name: 'Full lens', exact: true }).click();
    await expect(page.getByRole('article').getByText(message.text, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Let the completion paint and observer delivery finish without excluding any shifts.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
    const score = await page.evaluate(() => {
      const shifts = (window as unknown as { p7LayoutShifts: number[] }).p7LayoutShifts;
      return shifts.reduce((total, value) => total + value, 0);
    });
    expect(score).toBeLessThanOrEqual(0.05);
  } finally {
    await stack.stop();
  }
});
