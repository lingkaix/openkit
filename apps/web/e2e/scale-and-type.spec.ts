import { type Browser, expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
test.beforeAll(async () => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
});
test.afterAll(async () => {
  await stack?.stop();
  stack = null;
});

/** Drawn heights of the measured controls in the gallery. */
async function controlHeights(page: Page): Promise<Record<string, number>> {
  const height = async (locator: ReturnType<Page['locator']>) =>
    Math.round((await locator.first().boundingBox())?.height ?? 0);
  const buttons = page
    .getByRole('heading', { level: 4, name: 'Buttons', exact: true })
    .locator('..');
  const fields = page.getByRole('heading', { level: 4, name: 'Fields' }).locator('..');
  const navRows = page.getByRole('heading', { level: 4, name: 'Nav rows' }).locator('..');
  return {
    button: await height(buttons.getByRole('button', { name: 'Approve plan' })),
    smallButton: await height(buttons.getByRole('button', { name: 'Small' })),
    largeButton: await height(buttons.getByRole('button', { name: 'Large' })),
    picker: await height(fields.getByRole('button', { name: /Model/ })),
    textField: await height(fields.getByRole('textbox', { name: 'Workspace name' })),
    navRow: await height(navRows.getByRole('button', { name: /Overview/ })),
  };
}

/** Width, height and side padding of the gallery's pill buttons. */
async function pillShapes(page: Page) {
  const buttons = page
    .getByRole('heading', { level: 4, name: 'Buttons', exact: true })
    .locator('..');
  return buttons.getByRole('button').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        label: element.textContent ?? '',
        ratio: rect.width / rect.height,
        padding: Number.parseFloat(style.paddingLeft),
        height: Math.round(rect.height),
      };
    })
  );
}

/** S2 pill edge-to-text per height: S / M / L on desktop and touch. */
const PILL_PADDING: Record<number, number> = { 24: 12, 32: 16, 40: 20, 30: 15, 50: 25 };

async function expectSlimPills(page: Page, touch: boolean) {
  for (const pill of await pillShapes(page)) {
    // On touch, M (40) shares its height with desktop L; S2 gives M 20px there too.
    const expected = touch && pill.height === 40 ? 20 : PILL_PADDING[pill.height];
    expect(pill.padding, pill.label).toBe(expected);
    expect(pill.ratio, pill.label).toBeGreaterThanOrEqual(3);
  }
}

const DESKTOP = {
  button: 32,
  smallButton: 24,
  largeButton: 40,
  picker: 32,
  textField: 32,
  navRow: 32,
};
const TOUCH = {
  button: 40,
  smallButton: 30,
  largeButton: 50,
  picker: 40,
  textField: 40,
  navRow: 40,
};

/** Opens the gallery in a fresh context with the given pointer. */
async function openGallery(browser: Browser, touch: boolean): Promise<Page> {
  const context = await browser.newContext({
    viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${stack!.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
  return page;
}

/**
 * WEB-UX A2 (principles P7, P11): Spectrum 2 desktop and mobile scales from the
 * token package. Controls draw at the token height for the current pointer; the
 * gallery's Touch scale option previews the mobile scale on a desktop; the UI font
 * is the self-hosted Source Sans 3.
 */
test('draws controls at the Spectrum desktop scale and previews the touch scale', async ({
  browser,
}) => {
  const page = await openGallery(browser, false);
  expect(await controlHeights(page)).toEqual(DESKTOP);
  await expectSlimPills(page, false);
  expect(
    await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize))
  ).toBe(14);

  await page.getByText('Touch scale', { exact: true }).click();
  expect(await controlHeights(page)).toEqual(TOUCH);
  await expectSlimPills(page, true);
  // The page chrome outside the gallery keeps the device scale.
  const sectionLink = page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: /^Appearance$/ });
  expect(Math.round((await sectionLink.boundingBox())?.height ?? 0)).toBe(32);

  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('14px "Source Sans 3 Variable"'))).toBe(
    true
  );
  expect(
    await page.evaluate(() =>
      [...document.fonts].some(
        (face) => face.family.includes('Source Sans 3') && face.status === 'loaded'
      )
    )
  ).toBe(true);
});

test('uses the mobile scale and a 44px hit area on a coarse pointer', async ({ browser }) => {
  const page = await openGallery(browser, true);
  expect(await controlHeights(page)).toEqual(TOUCH);
  await expectSlimPills(page, true);
  expect(
    await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize))
  ).toBe(17);
  const small = page
    .getByRole('heading', { level: 4, name: 'Buttons', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Small' });
  const hitArea = await small.evaluate((element) => {
    const after = getComputedStyle(element, '::after');
    return { width: Number.parseFloat(after.width), height: Number.parseFloat(after.height) };
  });
  expect(hitArea.height).toBeGreaterThanOrEqual(44);
  expect(hitArea.width).toBeGreaterThanOrEqual(44);
});
