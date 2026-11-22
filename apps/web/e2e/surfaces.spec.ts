import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';
import { expectNoSeriousAxeViolations } from './_lib/axe.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
});
test.afterAll(async () => {
  await stack?.stop();
  stack = null;
});

async function newPage(
  browser: Browser,
  touch: boolean,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference'
): Promise<Page> {
  const context = await browser.newContext({
    reducedMotion,
    viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  return context.newPage();
}

async function openGallery(page: Page) {
  await page.goto(`${stack!.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
}

const style = (locator: Locator, property: string) =>
  locator.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);

const height = async (locator: Locator) => Math.round((await locator.boundingBox())?.height ?? 0);

/** S2 desktop (medium) and mobile (large) surface values (DESIGN.md §9.4-§9.6). */
const SCALE = {
  desktop: { title: '22px', menuItem: 32, row: 40, tab: 32, track: 6 },
  touch: { title: '27px', menuItem: 40, row: 50, tab: 40, track: 8 },
} as const;

/**
 * WEB-UX A5 (F16, P9): Dialog, Menu, Table, Tabs, Progress, the decision card and Kanban
 * columns on the S2 look, at both scales.
 */
for (const touch of [false, true]) {
  const scale = SCALE[touch ? 'touch' : 'desktop'];
  test(`draws the S2 surfaces at the ${touch ? 'touch' : 'desktop'} scale`, async ({ browser }) => {
    const page = await newPage(browser, touch);
    await openGallery(page);

    // Dialog: S2 widths on desktop, a full-height sheet below 800px; 22/27 title at 800.
    await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
    const small = page.getByRole('dialog', { name: 'Confirm change' });
    const surface = page.locator('.ok-dialog');
    const title = small.getByRole('heading', { name: 'Confirm change' });
    expect(await style(title, 'font-size')).toBe(scale.title);
    expect(await style(title, 'font-weight')).toBe('800');
    const box = await surface.boundingBox();
    if (touch) {
      expect([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)]).toEqual([390, 844]);
      // Phone footer: full-width Buttons, the main action on top.
      const done = await small.getByRole('button', { name: 'Done' }).boundingBox();
      const cancel = await small.getByRole('button', { name: 'Cancel' }).boundingBox();
      expect(Math.round(done?.width ?? 0)).toBe(Math.round(cancel?.width ?? 0));
      expect(done?.y ?? 0).toBeLessThan(cancel?.y ?? 0);
    } else {
      expect(Math.round(box?.width ?? 0)).toBe(400);
      expect(await style(surface, 'border-top-left-radius')).toBe('10px');
      expect(await style(surface, 'box-shadow')).not.toBe('none');
    }
    await small.getByRole('button', { name: 'Cancel' }).click();
    await expect(small).toBeHidden();
    if (!touch) {
      await page.getByRole('button', { name: 'Open large dialog' }).click();
      const large = await page.locator('.ok-dialog').boundingBox();
      expect(Math.round(large?.width ?? 0)).toBe(640);
      await page.keyboard.press('Escape');
      await expect(page.locator('.ok-dialog')).toHaveCount(0);
    }

    // Menu: M rows, a titled section after a divider, a shortcut slot.
    await page.getByRole('button', { name: 'Goal actions' }).click();
    const menu = page.getByRole('menu', { name: 'Goal actions' });
    expect(await height(menu.getByRole('menuitem', { name: 'Prioritize' }))).toBe(scale.menuItem);
    await expect(menu.getByText('Share', { exact: true })).toBeVisible();
    await expect(menu.locator('kbd').first()).toHaveText('P');
    // The name is the label; the description and the shortcut are the description.
    await expect(
      menu.getByRole('menuitem', { name: 'Prioritize', exact: true })
    ).toHaveAccessibleDescription('P');
    await expect(
      menu.getByRole('menuitem', { name: 'Copy link', exact: true })
    ).toHaveAccessibleDescription('Members of this Workspace');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Table: no outer box, 40/50 rows, a ⋯ menu per row.
    const grid = page.getByRole('grid', { name: 'Worker readiness' });
    await grid.scrollIntoViewIfNeeded();
    expect(await style(grid.locator('xpath=..'), 'border-top-width')).toBe('0px');
    expect(await height(grid.getByRole('row').nth(1))).toBe(scale.row);
    await expect(grid.getByRole('button', { name: 'Actions for Quill' })).toBeVisible();

    // Tabs: no box behind the list; the selected tab shows a 2px indicator.
    const tablist = page.getByRole('tablist', { name: 'Goal lens' });
    expect(await style(tablist, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    const selected = tablist.getByRole('tab', { name: 'Thread' });
    expect(await height(selected)).toBe(scale.tab);
    expect(await height(selected.locator('.ok-tab-indicator'))).toBe(2);

    // Progress: S2 M track.
    const progress = page.getByRole('progressbar', { name: 'Material upload' });
    expect(await height(progress.locator('.ok-progress-track'))).toBe(scale.track);

    // Decision card: the one boxed timeline item, layer-1 and no shadow; others are rows.
    const decision = page.locator('[data-item-look="decision"]', {
      hasText: 'Awaiting plan approval',
    });
    expect(await style(decision, 'box-shadow')).toBe('none');
    expect(await style(decision, 'border-top-width')).toBe('0px');
    const row = page.locator('[data-item-look="row"]', { hasText: 'Plan updated' });
    expect(await style(row, 'background-color')).toBe('rgba(0, 0, 0, 0)');

    // Kanban: borderless columns, shadowless cards.
    const column = page.getByRole('region', { name: 'In progress' });
    expect(await style(column, 'border-top-width')).toBe('0px');
    expect(await style(column.getByRole('button'), 'box-shadow')).toBe('none');
  });
}

/** Main routes from the surface registry, plus Home and the phone Work tab. */
function mainRoutes(): string[] {
  const registry = readFileSync(resolve(import.meta.dirname, '../src/app/surfaces.ts'), 'utf8');
  const paths = [...registry.matchAll(/path: '([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((path) => path && !path.includes(':'));
  return [...new Set(['/', '/work', ...paths])];
}

/** P9: cards never nest. Counts `.ok-card .ok-card` on every main route. */
test('nests no card inside another card on the main routes', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await newPage(browser, false);
  const nested: string[] = [];
  for (const route of mainRoutes()) {
    await page.goto(`${stack!.webUrl}${route}`);
    await page.waitForLoadState('networkidle');
    const count = await page.locator('.ok-card .ok-card').count();
    if (count) nested.push(`${route}: ${count}`);
  }
  expect(nested).toEqual([]);
});

/** Motion guard: with reduced motion, transitions and animations end at once. */
test('ends every transition at once with reduced motion', async ({ browser }) => {
  const page = await newPage(browser, false, 'reduce');
  await openGallery(page);
  const durations = await page.evaluate(() =>
    [...document.querySelectorAll('.ok-button, .ok-switch-handle, .ok-tab, .ok-item-card')]
      .slice(0, 40)
      .map((node) => {
        const computed = getComputedStyle(node);
        return Math.max(
          Number.parseFloat(computed.transitionDuration),
          Number.parseFloat(computed.animationDuration)
        );
      })
  );
  expect(durations.length).toBeGreaterThan(10);
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.001);
});

/** axe on the Overlays, Data and Work specimens, with the dialog and the menu open. */
test('passes axe on the surface specimens and an open dialog and menu', async ({ browser }) => {
  const page = await newPage(browser, false);
  await openGallery(page);
  await page.getByRole('grid', { name: 'Worker readiness' }).scrollIntoViewIfNeeded();
  await expectNoSeriousAxeViolations(page, 'A5 gallery surfaces');
  await page.getByRole('button', { name: 'Open large dialog' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit route' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'A5 dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Goal actions' }).click();
  await expect(page.getByRole('menu', { name: 'Goal actions' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'A5 menu');
});
