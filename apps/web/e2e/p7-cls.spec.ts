import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

type Rect = { x: number; y: number; width: number; height: number };
type ShiftSource = { node: string; previousRect: Rect; currentRect: Rect };
type ShiftRecord = { value: number; timeMs: number; fonts: string; sources: ShiftSource[] };

function formatRect(rect: Rect): string {
  return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatShifts(score: number, turnMarkMs: number, shifts: ShiftRecord[]): string {
  const lines = [`cls=${score} shifts=${shifts.length} turnMarkMs=${turnMarkMs}`];
  for (const shift of shifts) {
    lines.push(`t=${shift.timeMs}ms value=${shift.value} fonts=${shift.fonts}`);
    for (const source of shift.sources) {
      lines.push(
        `  ${source.node} previous=${formatRect(source.previousRect)} current=${formatRect(source.currentRect)}`
      );
    }
  }
  return lines.join('\n');
}

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
    const cpuRate = Number(process.env.P7_CLS_CPU_RATE);
    if (Number.isFinite(cpuRate) && cpuRate > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    }
    await page.addInitScript(() => {
      const shifts: ShiftRecord[] = [];
      Object.assign(window, { p7LayoutShifts: shifts });
      const rectOf = (rect: DOMRectReadOnly): Rect => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      const describe = (node: Node | undefined) => {
        if (!node) return '(no node)';
        if (node.nodeType !== Node.ELEMENT_NODE) return node.nodeName;
        const element = node as Element;
        const id = element.id ? `#${element.id}` : '';
        const className =
          typeof element.className === 'string'
            ? element.className
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 4)
                .map((name) => `.${name}`)
                .join('')
            : '';
        const role = element.getAttribute('role');
        const name = element.getAttribute('aria-label');
        const testId = element.getAttribute('data-testid');
        return [
          element.tagName.toLowerCase(),
          id,
          className,
          role ? `[role=${role}]` : '',
          name ? `[name=${name}]` : '',
          testId ? `[data-testid=${testId}]` : '',
        ].join('');
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput?: boolean;
            sources?: Array<{
              node?: Node;
              previousRect: DOMRectReadOnly;
              currentRect: DOMRectReadOnly;
            }>;
          };
          if (shift.hadRecentInput === true) continue;
          shifts.push({
            value: shift.value,
            timeMs: entry.startTime,
            fonts: document.fonts.status,
            sources: (shift.sources ?? []).map((source) => ({
              node: describe(source.node),
              previousRect: rectOf(source.previousRect),
              currentRect: rectOf(source.currentRect),
            })),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const turnMarkMs = await page.evaluate(() => performance.now());
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
    const shifts = await page.evaluate(
      () => (window as unknown as { p7LayoutShifts: ShiftRecord[] }).p7LayoutShifts
    );
    const score = shifts.reduce((total, shift) => total + shift.value, 0);
    const attribution = formatShifts(score, turnMarkMs, shifts);
    console.log(attribution);
    expect(score, attribution).toBeLessThanOrEqual(0.05);
  } finally {
    await stack.stop();
  }
});
