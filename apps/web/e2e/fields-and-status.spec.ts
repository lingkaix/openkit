import { type Browser, expect, type Page, test } from '@playwright/test';
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

async function newPage(browser: Browser, touch: boolean): Promise<Page> {
  const context = await browser.newContext({
    viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  return context.newPage();
}

async function openGallery(page: Page) {
  await page.goto(`${stack!.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
}

const box = async (locator: ReturnType<Page['locator']>) => {
  const rect = await locator.boundingBox();
  return { width: Math.round(rect?.width ?? 0), height: Math.round(rect?.height ?? 0) };
};

/** S2 desktop (medium) and mobile (large) scale values (DESIGN.md §6, §8.1). */
const SCALE = {
  desktop: { field: 32, icons: [16, 20, 22], track: [26, 16], dot: 10 },
  touch: { field: 40, icons: [18, 24, 28], track: [34, 20], dot: 12 },
} as const;

/**
 * WEB-UX A4 (P7, F23): in one form row TextField, Picker and an M Button share one height,
 * and icons, the Switch track and the StatusLight dot sit on the S2 scale, at both scales.
 */
for (const touch of [false, true]) {
  const scale = SCALE[touch ? 'touch' : 'desktop'];
  test(`keeps fields, icons and status on the S2 ${touch ? 'touch' : 'desktop'} scale`, async ({
    browser,
  }) => {
    const page = await newPage(browser, touch);
    await openGallery(page);
    const row = page.getByRole('group', { name: 'Field row' });
    await row.scrollIntoViewIfNeeded();
    const heights = [
      (await box(row.getByRole('textbox', { name: 'Workspace name' }))).height,
      (await box(row.getByRole('button', { name: /Model/ }))).height,
      (await box(row.getByRole('button', { name: 'Save' }))).height,
    ];
    expect(heights).toEqual([scale.field, scale.field, scale.field]);

    const icons = page.getByRole('group', { name: 'Icon sizes' });
    const sizes = [];
    for (const name of ['Search, small', 'Search, medium', 'Search, large']) {
      sizes.push((await box(icons.getByRole('img', { name }))).width);
    }
    expect(sizes).toEqual([...scale.icons]);

    const track = page
      .getByRole('switch', { name: 'Ask before spending' })
      .locator('xpath=ancestor::label[1]')
      .locator('.ok-switch-track');
    const trackBox = await box(track);
    expect([trackBox.width, trackBox.height]).toEqual([...scale.track]);

    const light = page.locator('.ok-status-light', { hasText: 'Running' }).first();
    const dot = await box(light.locator('.ok-status-dot'));
    expect([dot.width, dot.height]).toEqual([scale.dot, scale.dot]);
    // A StatusLight has no fill: the word stays default text on the surface.
    expect(await light.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)'
    );
  });
}

/** S2 Tooltip: React Aria on hover and focus, 160px wide at most on desktop. */
test('shows the S2 tooltip on keyboard focus within its maximum width', async ({ browser }) => {
  const page = await newPage(browser, false);
  await openGallery(page);
  const trigger = page.getByRole('button', { name: 'What is a Turn?' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('One request and everything the Assistant did to answer it.');
  expect((await box(tooltip)).width).toBeLessThanOrEqual(160);
});

/**
 * Focus sweep (design-system.md §9 States and focus): every control reached by Tab in the
 * Fields, Feedback and Actions specimens draws the S2 focus outline: 2px solid in the focus
 * color, offset 2px. Switch and radio draw it on their control, not on the hidden input.
 */
test('draws the S2 focus outline on every control reached by Tab', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await newPage(browser, false);
  await openGallery(page);
  const focusColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-focus)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await page.getByRole('heading', { level: 3, name: 'Actions' }).scrollIntoViewIfNeeded();
  await page.getByRole('heading', { level: 3, name: 'Actions' }).click();
  const misses: string[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate(async (color) => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      const inGallery = active.closest(
        '[aria-labelledby="gallery-actions-heading"], [aria-labelledby="gallery-fields-heading"], [aria-labelledby="gallery-feedback-heading"]'
      );
      if (!inGallery) return { done: true } as const;
      // A visually hidden input (Switch, Radio) shows focus on its drawn control.
      const label = active.closest('label');
      const drawn =
        active.tagName === 'INPUT' && label
          ? (label.querySelector<HTMLElement>('.ok-switch-track, .ok-radio-control') ?? label)
          : active;
      // transition-colors animates outline-color too: read the settled value.
      await Promise.all(drawn.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(drawn);
      const name = `${active.tagName} ${(active.getAttribute('aria-label') ?? active.textContent ?? '').trim().slice(0, 30)}`;
      const ok =
        style.outlineStyle === 'solid' &&
        Number.parseFloat(style.outlineWidth) >= 2 &&
        Number.parseFloat(style.outlineOffset) >= 2 &&
        style.outlineColor === color;
      return {
        done: false,
        name,
        ok,
        detail: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`,
      } as const;
    }, focusColor);
    if (!result) continue;
    if (result.done) break;
    if (seen.has(result.name)) continue;
    seen.add(result.name);
    if (!result.ok) misses.push(`${result.name}: ${result.detail}`);
  }
  expect(seen.size).toBeGreaterThanOrEqual(12);
  expect(misses).toEqual([]);
});

/** axe on a form route and on the Fields and Feedback specimens. */
test('passes axe on a settings form and the field specimens', async ({ browser }) => {
  const page = await newPage(browser, false);
  await page.goto(`${stack!.webUrl}/settings/general`);
  await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'A4 settings form');
  await openGallery(page);
  await page.getByRole('group', { name: 'Field row' }).scrollIntoViewIfNeeded();
  await expectNoSeriousAxeViolations(page, 'A4 gallery fields and status');
});
