import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';

const configuredProviderId = process.env.OPENKIT_APP_E2E_PROVIDER_ID ?? 'provider_app_redaction';
const forbiddenSecret = process.env.OPENKIT_APP_E2E_SECRET ?? 'sk-openkit-app-e2e-secret';

/**
 * Parses one successful JSON response.
 *
 * @param response Playwright API response.
 * @param label Diagnostic label for assertion failures.
 * @returns Parsed JSON body.
 */
async function readJson(response: APIResponse, label: string): Promise<unknown> {
  expect(response.ok(), `${label} should return an ok response`).toBe(true);
  return await response.json();
}

/**
 * Gets a named object property from an unknown JSON object.
 *
 * @param value JSON value to inspect.
 * @param key Property key to read.
 * @returns Property value.
 */
function getProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value)) {
    throw new Error(`Expected object property: ${key}`);
  }

  return (value as Record<string, unknown>)[key];
}

/**
 * Reads the JSON body for one request path.
 *
 * @param request Playwright request context.
 * @param path Route path to fetch through the packaged app public route.
 * @returns Parsed JSON body.
 */
async function getJson(request: APIRequestContext, path: string): Promise<unknown> {
  return await readJson(await request.get(path), path);
}

test.describe('app packaged route', () => {
  test('proves the public Caddy route exposes UI, diagnostics, and local turn execution', async ({
    baseURL,
    page,
    request,
  }) => {
    const route = new URL(baseURL ?? 'http://127.0.0.1:18081');

    expect(route.port).not.toBe('4173');
    expect(route.port).not.toBe('5173');

    const health = await getJson(request, '/api/health');
    expect(getProperty(health, 'service')).toBe('nanocore');
    expect(getProperty(health, 'status')).toBe('ok');

    const diagnostics = await getJson(request, '/api/app/diagnostics');
    expect(JSON.stringify(diagnostics)).not.toContain(forbiddenSecret);
    expect(diagnostics).not.toHaveProperty('defaultProvider');
    const defaultProviders = getProperty(diagnostics, 'defaultProviders');
    expect(getProperty(defaultProviders, 'core')).toMatchObject({
      configured: true,
      providerId: configuredProviderId,
    });
    expect(getProperty(defaultProviders, 'gateway')).toMatchObject({
      configured: true,
      providerId: configuredProviderId,
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: /Demo Workspace/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Settings$/ })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(forbiddenSecret);

    await page.getByRole('button', { name: /Demo Workspace/ }).click();
    await expect(page.getByRole('heading', { name: /Demo Workspace Dashboard/i })).toBeVisible();
    await expect(page.getByLabel('Agent health')).toContainText('agent_opencode_server');
    await expect(page.getByLabel('Agent health')).toContainText(/unknown|ready|degraded|blocked/i);

    await page.getByRole('button', { name: /^Settings$/ }).click();
    await page.getByRole('button', { name: /^Diagnostics$/ }).click();
    await expect(page.getByRole('heading', { name: /^Diagnostics$/ })).toBeVisible();
    const coreDefaultProviderTile = page
      .locator('.metric-tile')
      .filter({ hasText: 'Core default provider' });
    await expect(coreDefaultProviderTile).toContainText(configuredProviderId);
    await expect(coreDefaultProviderTile).toContainText('Ready');
    const gatewayDefaultProviderTile = page
      .locator('.metric-tile')
      .filter({ hasText: 'Gateway default provider' });
    await expect(gatewayDefaultProviderTile).toContainText(configuredProviderId);
    await expect(gatewayDefaultProviderTile).toContainText('Ready');
    await expect(page.locator('body')).not.toContainText(forbiddenSecret);

    const suffix = Date.now().toString();
    const workspaceName = `Packaged app ${suffix}`;
    const threadName = `Run packaged app simulator flow ${suffix}`;

    await page.getByRole('button', { name: /^Back to app$/ }).click();
    await page.getByRole('button', { name: /^New workspace$/ }).click();
    await page.getByLabel('New workspace').fill(workspaceName);
    await page.getByRole('button', { name: /^Create workspace$/ }).click();
    await expect(page.getByRole('button', { name: workspaceName })).toBeVisible();

    await page.getByLabel(`New thread for ${workspaceName}`).fill(threadName);
    await page.getByRole('button', { name: /^New thread$/ }).click();
    await expect(page.getByRole('heading', { name: `${threadName} Dashboard` })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Stop turn$/ })).toBeDisabled({
      timeout: 15_000,
    });

    await page.getByLabel('Turn prompt').fill('Run the packaged app simulator flow.');
    await expect(page.getByRole('button', { name: /^Send turn$/ })).toBeEnabled();
    await page.getByRole('button', { name: /^Send turn$/ }).click();
    await expect(page.getByText(/Run the packaged app simulator flow\./)).toBeVisible();
    await expect(page.getByText(/simulator: ok/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
