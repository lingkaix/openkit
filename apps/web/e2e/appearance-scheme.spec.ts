import { expect, type Page, test } from '@playwright/test';
import { expectNoSeriousAxeViolations } from './_lib/axe.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
});

/** The rendered canvas color of the page body. */
function canvas(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

const LIGHT_CANVAS = 'rgb(255, 255, 255)';
const DARK_CANVAS = 'rgb(17, 17, 17)';

/**
 * WEB-UX A1 (principle P11): one Spectrum 2 theme from `@adobe/spectrum-tokens` in
 * two color schemes. With no stored choice the app follows the OS; Light and Dark
 * persist; the gallery passes axe, including real color contrast, in both schemes.
 */
test('follows the OS scheme and persists a Light or Dark choice', async ({ browser }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const context = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(`${stack.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Foundations' })).toBeVisible();
  expect(await canvas(page)).toBe(DARK_CANVAS);
  await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light dark');
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
  await expectNoSeriousAxeViolations(page, 'A1 gallery, system dark');

  // The radio input is visually hidden; the user presses the sample card.
  await page.getByRole('radiogroup', { name: 'Mode' }).getByText('Light', { exact: true }).click();
  expect(await canvas(page)).toBe(LIGHT_CANVAS);
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
  await page.getByText('Light and dark side by side', { exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Light and dark side by side' })).toBeChecked();
  await expect(page.locator('.ok-scheme-dark').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked();
  await expectNoSeriousAxeViolations(page, 'A1 gallery, light with side by side');

  await page.reload();
  await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked();
  expect(await canvas(page)).toBe(LIGHT_CANVAS);
  await context.close();
});

const PAPER_CANVAS = 'rgb(239, 232, 222)';
const NOIR_CANVAS = 'rgb(20, 16, 11)';

test('migrates a stored pre-A1 Noir theme to Classic in Dark mode', async ({ browser }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const context = await browser.newContext({ colorScheme: 'light' });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(
        'openkit-theme',
        JSON.stringify({ state: { theme: 'noir' }, version: 0 })
      );
      sessionStorage.setItem('seeded', '1');
    }
  });
  const page = await context.newPage();
  await page.goto(`${stack.webUrl}/settings/appearance`);
  await expect(page.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Classic/ })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-style', 'classic');
  expect(await canvas(page)).toBe(NOIR_CANVAS);
  await expectNoSeriousAxeViolations(page, 'A3b Appearance, Noir');
  await context.close();
});

/**
 * WEB-UX A3b (engineer decision 2026-11-18): Mode × Style. Classic follows the OS
 * under System (Paper light, Noir dark), persists, and the whole gallery passes axe,
 * including real color contrast, with Paper and Noir side by side.
 */
test('Classic follows the OS under System and passes axe in Paper and Noir', async ({
  browser,
}) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const context = await browser.newContext({
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${stack.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Style' })
    .getByText('Classic', { exact: true })
    .click();
  await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
  expect(await canvas(page)).toBe(PAPER_CANVAS);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await canvas(page)).toBe(NOIR_CANVAS);
  await page.getByText('Light and dark side by side', { exact: true }).click();
  await expectNoSeriousAxeViolations(page, 'A3b gallery, Paper and Noir side by side');

  await page.reload();
  await expect(page.getByRole('radio', { name: /^Classic/ })).toBeChecked();
  expect(await canvas(page)).toBe(NOIR_CANVAS);
  await page
    .getByRole('radiogroup', { name: 'Style' })
    .getByText('Spectrum', { exact: true })
    .click();
  expect(await canvas(page)).toBe(DARK_CANVAS);
  await context.close();
});
