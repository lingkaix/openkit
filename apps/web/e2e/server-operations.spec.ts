import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

/** Real local API wiring, read-only refresh, narrow layout and loss of current administrator authority. */
test('inspects server operations through the supported local APIs', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const operationIds: string[] = [];
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/^\/api\/app\/operations\/(.+)$/);
    if (match) operationIds.push(match[1]!);
  });
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto(`${stack.webUrl}/settings/account`);
  await page.getByRole('button', { name: 'Server operations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server operations', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Boot readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Policy', exact: true })).toContainText('Ready');
  await expect(
    page.getByRole('heading', { name: 'Cleanup observations', exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Telemetry configuration does not prove delivery.', { exact: false })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh health', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Boot readiness', exact: true })).toBeVisible();
  expect(operationIds.filter((id) => id === 'diagnostics.app').length).toBeGreaterThanOrEqual(2);
  expect(operationIds).toContain('administration.cleanup-read');
  expect(operationIds).not.toContain('worker-environment.purge');
  expect(operationIds).not.toContain('app-update.start');
  await expect(
    page.getByRole('link', { name: 'Workspace access recovery', exact: true })
  ).toHaveAttribute('href', '/settings/workspace-access-recovery');
  await expect(
    page.getByRole('link', { name: 'Deployment data-root backup', exact: true })
  ).toHaveAttribute('href', '/settings/data-root-backup');
  for (const width of [800, 600]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(
      () => document.body.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  }
  await page.route('**/api/app/operations/diagnostics.app', (route) =>
    route.fulfill({ status: 403, json: { error: 'forbidden', message: 'Access denied.' } })
  );
  await page.getByRole('button', { name: 'Refresh health', exact: true }).click();
  await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Boot readiness', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Cleanup observations', exact: true })
  ).toBeVisible();
  expect(errors).toEqual([]);
});
