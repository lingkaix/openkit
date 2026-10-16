import { expect, type Route, test } from '@playwright/test';
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

/** Cached admission never enables an effect while a later mount checks current access. */
test('rechecks backup and update access before offering effects', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const effects: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const operation = new URL(request.url()).pathname.split('/api/app/operations/')[1];
    if (operation && /^(backup\.(create|verify)|app-update\.(prepare|start))$/.test(operation)) {
      effects.push(operation);
    }
  });
  // The local stack has no server token administration; supply only that admission read.
  const tokenListUrl = '**/api/app/operations/token.list';
  await page.route(tokenListUrl, (route) => route.fulfill({ json: { items: [] } }));
  await page.goto(`${stack.webUrl}/settings/server-operations`);

  for (const surface of [
    {
      link: 'Deployment data-root backup',
      heading: 'Create and verify backups',
      action: 'Create backup',
    },
    { link: 'App update', heading: 'App update', action: 'Prepare' },
  ]) {
    await page.getByRole('link', { name: surface.link, exact: true }).click();
    await expect(page.getByRole('heading', { name: surface.heading, exact: true })).toBeVisible();
    if (surface.action === 'Prepare') {
      await page.getByRole('textbox', { name: 'Release tag', exact: true }).fill('v0.0.0-test');
      await page
        .getByRole('textbox', { name: 'Published App digest', exact: true })
        .fill(`sha256:${'a'.repeat(64)}`);
      await page
        .getByRole('textbox', { name: 'Release source commit', exact: true })
        .fill('b'.repeat(40));
      await page
        .getByRole('textbox', { name: 'Expected current image', exact: true })
        .fill(`sha256:${'c'.repeat(64)}`);
    }
    await expect(page.getByRole('button', { name: surface.action, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Server operations', exact: true }).click();

    let release = () => {};
    let requested = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const denyCurrentAccess = async (route: Route) => {
      requested = true;
      await pending;
      await route.fulfill({ status: 403, json: { error: 'forbidden', message: 'Access denied.' } });
    };
    await page.route(tokenListUrl, denyCurrentAccess);
    try {
      await page.getByRole('link', { name: surface.link, exact: true }).click();
      await expect.poll(() => requested).toBe(true);
      await expect(
        page
          .getByRole('button', { name: surface.action, exact: true })
          .and(page.locator(':enabled'))
      ).toHaveCount(0);
      release();
      await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
      await expect(
        page
          .getByRole('button', { name: surface.action, exact: true })
          .and(page.locator(':enabled'))
      ).toHaveCount(0);
      expect(effects).toEqual([]);
    } finally {
      release();
      await page.unroute(tokenListUrl, denyCurrentAccess);
    }
    await page.getByRole('button', { name: 'Server operations', exact: true }).click();
  }
  expect(errors).toEqual([]);
});
