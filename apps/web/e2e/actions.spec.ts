import { randomUUID } from 'node:crypto';
import { createCoreClient } from '@openkit/core-client';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { expectNoSeriousAxeViolations } from './_lib/axe.js';
import { postWhenCaptureAllows } from './_lib/capture-fence.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
let taskPath = '';

test.beforeAll(async ({ request }) => {
  test.setTimeout(180_000);
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const { items } = await client.operations['workspace.list']({});
  const workspaceId = items[0]?.workspace.id;
  if (!workspaceId) throw new Error('The isolated simulator has no accessible Workspace.');
  const thread = await client.operations['thread.create']({
    workspaceId,
    name: 'Actions check',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  const requestId = randomUUID();
  const started = await postWhenCaptureAllows(
    request,
    `${stack.coreUrl}/api/app/operations/task.start`,
    {
      headers: { 'x-openkit-request-id': requestId },
      data: { workspaceId, threadId: thread.id, input: 'Summarize the release.', requestId },
    }
  );
  expect(started.status(), await started.text()).toBe(202);
  taskPath = `/tasks/${workspaceId}/${thread.id}`;
});
test.afterAll(async () => {
  await stack?.stop();
  stack = null;
});

const MAIN_ROUTES = ['/attention', '/assistant', '/knowledge', '/artifacts', '/automations'];

async function newPage(browser: Browser, touch: boolean): Promise<Page> {
  const context = await browser.newContext({
    viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  return context.newPage();
}

/** Visible accent Buttons, and visible Buttons that span their container (P8, F22). */
async function audit(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const label = (element: Element) => (element.textContent ?? '').trim().slice(0, 40);
    const accents = [...document.querySelectorAll('[data-variant="accent"]')]
      .filter(visible)
      .map(label);
    const phone = window.innerWidth < 800;
    const fullWidth = [...document.querySelectorAll('.ok-button')]
      .filter(visible)
      .filter((element) => !(phone && element.closest('[role="dialog"]')))
      .filter((element) => {
        const parent = element.parentElement;
        if (!parent) return false;
        const style = getComputedStyle(parent);
        const inner =
          parent.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        const width = element.getBoundingClientRect().width;
        return width > 200 && width >= inner - 1;
      })
      .map(label);
    return { accents, fullWidth };
  });
}

/**
 * WEB-UX A3 (P8, F22): at most one accent Button per view on the main routes, and no
 * Button stretched across its container (phone dialog footers excepted).
 */
for (const touch of [false, true]) {
  test(`keeps one accent and no full-width Button per view (${touch ? 'phone' : 'desktop'})`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await newPage(browser, touch);
    for (const route of [...MAIN_ROUTES, taskPath]) {
      await page.goto(`${stack!.webUrl}${route}`);
      await expect(page.locator('main').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const { accents, fullWidth } = await audit(page);
      expect(accents.length, `${route}: ${accents.join(', ')}`).toBeLessThanOrEqual(1);
      expect(fullWidth, route).toEqual([]);
    }
  });
}

async function openGallery(page: Page) {
  await page.goto(`${stack!.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
}

const height = async (locator: ReturnType<Page['locator']>) =>
  Math.round((await locator.boundingBox())?.height ?? 0);

/**
 * Gallery Actions specimen (design-system.md §4): Button roles, ActionButton sizes
 * (icon-only square), ToggleButton by keyboard, Disclosure; axe clean.
 */
test('shows the Actions specimen with S2 action sizes and keyboard toggles', async ({
  browser,
}) => {
  const page = await newPage(browser, false);
  await openGallery(page);
  const buttons = page
    .getByRole('heading', { level: 4, name: 'Buttons', exact: true })
    .locator('..');
  const variants = await buttons
    .locator('[data-variant]')
    .evaluateAll((elements) => elements.map((e) => e.getAttribute('data-variant')));
  expect(new Set(variants)).toEqual(new Set(['accent', 'primary', 'secondary', 'negative']));

  const reply = page.getByRole('group', { name: 'Reply actions' });
  expect(await height(reply.getByRole('button', { name: 'Retry' }))).toBe(32);
  const more = reply.getByRole('button', { name: 'More' });
  const box = await more.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(Math.round(box?.height ?? -1));
  const row = page.getByRole('group', { name: 'Row actions' });
  expect(await height(row.getByRole('button', { name: 'Open' }))).toBe(24);

  const lens = page.getByRole('group', { name: 'Timeline lens' });
  const summary = lens.getByRole('button', { name: 'Summary' });
  const all = lens.getByRole('button', { name: 'All activity' });
  await expect(summary).toHaveAttribute('aria-pressed', 'true');
  await summary.focus();
  await page.keyboard.press('Tab');
  await expect(all).toBeFocused();
  await page.keyboard.press('Space');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(summary).toHaveAttribute('aria-pressed', 'false');

  const disclosure = page
    .getByRole('heading', { level: 4, name: 'Disclosure' })
    .locator('..')
    .locator('[aria-expanded]')
    .first();
  const expanded = await disclosure.getAttribute('aria-expanded');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');

  await expectNoSeriousAxeViolations(page, 'A3 gallery actions');
});

/**
 * COORD A3 ruling 3: on touch, small ActionButtons in an ActionGroup sit at least 8px
 * apart and their 44px hit areas do not overlap.
 */
test('keeps S action controls apart on touch so hit areas do not overlap', async ({ browser }) => {
  const page = await newPage(browser, true);
  await openGallery(page);
  const row = page.getByRole('group', { name: 'Row actions' });
  await row.scrollIntoViewIfNeeded();
  const controls = await row.getByRole('button').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const after = getComputedStyle(element, '::after');
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        height: rect.height,
        hitWidth: Math.max(rect.width, Number.parseFloat(after.width) || 0),
      };
    })
  );
  expect(controls.length).toBeGreaterThanOrEqual(3);
  for (const control of controls) expect(Math.round(control.height)).toBe(30);
  for (let i = 1; i < controls.length; i += 1) {
    const [a, b] = [controls[i - 1]!, controls[i]!];
    if (Math.abs(a.top - b.top) > 1) continue; // wrapped onto a new line
    expect(b.left - a.right).toBeGreaterThanOrEqual(8);
    const centers = (b.left + b.right) / 2 - (a.left + a.right) / 2;
    expect(centers).toBeGreaterThanOrEqual((a.hitWidth + b.hitWidth) / 2 - 0.5);
  }
});
