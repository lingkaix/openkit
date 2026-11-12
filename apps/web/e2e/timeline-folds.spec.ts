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
      await control.scrollIntoViewIfNeeded();
      const before = await control.evaluate(place);
      const screenBefore = await control.evaluate((element) => element.getBoundingClientRect().top);
      await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'true');
      const after = await control.evaluate(place);
      const screenAfter = await control.evaluate((element) => element.getBoundingClientRect().top);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
      if (viewport.width === 360) {
        const pageWidth = await page.evaluate(() => {
          const timeline = document.querySelector('.ok-timeline');
          const scrollport =
            timeline instanceof HTMLElement ? timeline.closest('[data-timeline-scroll]') : null;
          const column = timeline instanceof HTMLElement ? timeline.closest('.px-6') : null;
          const columnPad =
            column instanceof HTMLElement
              ? Number.parseFloat(getComputedStyle(column).paddingLeft) +
                Number.parseFloat(getComputedStyle(column).paddingRight)
              : null;
          return {
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            scrollportClient: scrollport instanceof HTMLElement ? scrollport.clientWidth : null,
            scrollportScroll: scrollport instanceof HTMLElement ? scrollport.scrollWidth : null,
            timelineClient: timeline instanceof HTMLElement ? timeline.clientWidth : null,
            timelineScroll: timeline instanceof HTMLElement ? timeline.scrollWidth : null,
            columnPad,
          };
        });
        // The document and the timeline scrollport are the 360 px viewport.
        // .ok-timeline sits inside the thread column's px-6, so its content box
        // is that viewport minus the column padding, with no horizontal scroll.
        expect(pageWidth.client).toBe(360);
        expect(pageWidth.scroll).toBeLessThanOrEqual(360);
        expect(pageWidth.scrollportClient).toBe(360);
        expect(pageWidth.scrollportScroll).toBeLessThanOrEqual(360);
        expect(pageWidth.columnPad).toBe(48);
        expect(pageWidth.timelineClient).toBe(360 - 48);
        expect(pageWidth.timelineScroll).toBeLessThanOrEqual(pageWidth.timelineClient ?? 0);
        console.log(
          `width360 document=${pageWidth.client}/${pageWidth.scroll} scrollport=${pageWidth.scrollportClient}/${pageWidth.scrollportScroll} timeline=${pageWidth.timelineClient}/${pageWidth.timelineScroll} pad=${pageWidth.columnPad}`
        );
      } else {
        expect(Math.abs(screenAfter - screenBefore)).toBeLessThanOrEqual(2);
      }
    }
  } finally {
    await stack.stop();
  }
});
