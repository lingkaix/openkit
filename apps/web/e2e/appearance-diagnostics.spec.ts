import { expect, test } from '@playwright/test';
import { expectNoSeriousAxeViolations } from './_lib/axe.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
});

/** Operations only Diagnostics may call; Appearance must never read them. */
const DIAGNOSTICS_READS = [
  'evidence.bundle-list',
  'evidence.runtime-list',
  'environment.snapshot-list',
];

/**
 * WEB-UX A0 (principle P14): the component gallery lives in Settings → Appearance as a
 * collapsed, lazily rendered "All components" disclosure that renders fixtures only,
 * including the native Generative UI catalog. Diagnostics is an Administration page with
 * server inspection reads and no specimens; the retired Debug address redirects to it.
 */
test('keeps the gallery in Appearance and Diagnostics under Administration', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const operations: string[] = [];
  page.on('request', (request) => {
    const match = /\/api\/app\/operations\/([^/?]+)/.exec(request.url());
    if (match) operations.push(match[1]!);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(stack.webUrl);
  await page.getByRole('button', { name: /^Settings$/ }).click();
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections).toBeVisible();
  for (const retired of [/^Debug$/, /^Components$/]) {
    await expect(sections.getByRole('button', { name: retired })).toHaveCount(0);
  }

  await sections.getByRole('button', { name: /^Appearance$/ }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Mode' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  const allComponents = page.getByRole('button', { name: 'All components' });
  await expect(allComponents).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'Generative UI' })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page, 'A0 Appearance');

  await allComponents.click();
  for (const group of ['Actions', 'Fields', 'Overlays', 'Feedback', 'Work', 'Generative UI']) {
    await expect(page.getByRole('heading', { level: 3, name: group })).toBeVisible();
  }
  const generative = page.getByRole('region', { name: 'Generative UI' });
  await expect(generative.getByRole('textbox', { name: 'Run at' })).toHaveValue('09:00');
  await expect(generative.getByRole('button', { name: 'Save schedule' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence bundles' })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page, 'A0 All components');
  expect(operations.filter((operation) => DIAGNOSTICS_READS.includes(operation))).toEqual([]);

  await page.goto(`${stack.webUrl}/settings/appearance/components`);
  await expect(page.getByRole('button', { name: 'All components' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();

  await sections.getByRole('button', { name: /^Diagnostics$/ }).click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence bundles' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Package snapshots' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
  await expect
    .poll(() => DIAGNOSTICS_READS.every((operation) => operations.includes(operation)))
    .toBe(true);
  await expectNoSeriousAxeViolations(page, 'A0 Diagnostics');

  await page.goto(`${stack.webUrl}/settings/debug?selection=fixture#anchor`);
  await expect(page).toHaveURL(/\/settings\/diagnostics\?selection=fixture#anchor$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByText('The component gallery moved to')).toBeVisible();
  await expect(page.getByText('Debug is now Diagnostics')).toHaveCount(0);
  await page.getByRole('link', { name: 'Appearance → All components' }).click();
  await expect(page).toHaveURL(/\/settings\/appearance\/components$/);
  await expect(page.getByRole('heading', { level: 3, name: 'Generative UI' })).toBeVisible();
});
