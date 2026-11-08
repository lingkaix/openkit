import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/**
 * U7: expanding a run's step fold keeps the control in place.
 * U3: the timeline does not widen the page at 360 px.
 */
test('keeps the step fold in place on desktop and at 360px', async ({ page }) => {
  test.setTimeout(120_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Fold check',
      visibility: 'workspace',
    });
    const selector = { workspaceId, threadId: thread.id };
    const turn = await client.operations['turn.start']({
      ...selector,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Prepare a short simulator reply so the fold check has a run.',
    });
    await expect
      .poll(
        async () => {
          const { items } = await client.operations['thread.items'](selector);
          return items.some((item) => item.turnId === turn.id && item.type === 'assistant-message');
        },
        { timeout: 20_000 }
      )
      .toBe(true);

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 360, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
      const control = page.getByRole('button', { name: /^\d+ steps$/ });
      await expect(control).toBeVisible({ timeout: 15_000 });
      let seen = '';
      await expect
        .poll(
          async () => {
            const text = (await control.textContent()) ?? '';
            const stable = text.length > 0 && text === seen;
            seen = text;
            return stable;
          },
          { timeout: 20_000 }
        )
        .toBe(true);
      const place = (element: HTMLElement) => {
        const scroller = element.closest('.overflow-y-auto') ?? document.documentElement;
        return (
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        );
      };
      const before = await control.evaluate(place);
      await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'true');
      const after = await control.evaluate(place);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
      if (viewport.width === 360) {
        const pageWidth = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
      }
    }
  } finally {
    await stack.stop();
  }
});
