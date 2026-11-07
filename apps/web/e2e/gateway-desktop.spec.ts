import { expect, type Page, type Response, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Desktop initial navigation for Gateway.
 * The viewport is set before the first document load. Width stays at or above the
 * 800px persistent sidebar. The 360px initial opening belongs to the phone acceptance.
 * Request checks use operation names, statuses, and a few public field flags.
 * They do not print headers, revisions, or file bodies.
 */

const LOCAL_PROFILE_ID = 'desk-local';
const LOCAL_PROFILE_NAME = 'Desktop local profile';
const LOCAL_MODEL = 'desktop-local-model';
const SEEDED_ROUTE = `[
  {
    "id": "simulator",
    "providerProfileId": "agent-openrouter",
    "providerModel": "openai/gpt-5.2"
  }
]
`;

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

test('opens Gateway from desktop Settings and edits the seeded route', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const counts = { validate: 0, update: 0, reload: 0, vault: 0, login: 0, usage: 0 };
  trackOperations(page, counts);

  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections', exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/account$/);

  const settings = page.getByRole('navigation', { name: 'Settings sections' });
  await settings.getByRole('button', { name: 'Gateway', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/gateway$/);
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeVisible();
  await expect(page.getByText('Access denied', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Server admin token')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /Tool/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Usage & audit', exact: true })).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'In use', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not set up', exact: true })).toBeVisible();
  await expect(page.getByText('Default: reasoning', { exact: true })).toBeVisible();

  const reasoning = page.getByRole('region', { name: 'Reasoning' });
  await expect(reasoning.getByText('1 Primary', { exact: true })).toBeVisible();
  await expect(
    reasoning.getByText('Agent OpenRouter test local · openai/gpt-5.2', { exact: true })
  ).toBeVisible();
  await expect(reasoning.getByText('available', { exact: true }).first()).toBeVisible();
  await expect(reasoning.getByText('Failover on', { exact: true })).toBeVisible();
  await expect(
    reasoning.getByText('If the primary fails, the next available member is used.', { exact: true })
  ).toBeVisible();
  await expect(reasoning.getByText('Primary: simulator', { exact: true })).toBeHidden();
  await expect(reasoning.getByRole('button', { name: 'Edit route', exact: true })).toBeVisible();

  const seeded = page.getByRole('region', { name: 'Agent OpenRouter test local' });
  await expect(seeded.getByText('Used by: Reasoning (primary)', { exact: true })).toBeVisible();
  await expect(seeded.getByText('agent-openrouter · local', { exact: true })).toBeVisible();
  await expect(seeded.getByRole('textbox', { name: 'Provider API key' })).toHaveCount(0);
  await expect(seeded.getByRole('button', { name: 'Remove Provider', exact: true })).toBeVisible();

  const direct = page.getByRole('region', { name: 'OpenAI', exact: true });
  await expect(direct.getByRole('textbox', { name: 'Provider API key' })).toBeVisible();
  await expect(direct.getByRole('button', { name: 'Save or Replace API key' })).toBeDisabled();
  await expect(page.getByText('Vault is locked.', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Vault', exact: true })).toHaveCount(2);
  await expect(page.getByText('Nothing waiting to be set up', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Add subscription Provider', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add subscription Provider', exact: true })
  ).toBeDisabled();

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible();
  await expect(reasoning.getByText('Failover on', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  await reasoning.getByRole('button', { name: 'Edit route', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit route' });
  const failover = dialog.getByRole('switch', { name: 'Automatic failover', exact: true });
  await expect(failover).toBeChecked();
  await dialog.getByText('Route source', { exact: true }).click();
  const draft = dialog.getByRole('textbox', { name: 'Ordered routes JSON', exact: true });
  await draft.fill('{');
  await expect(
    dialog.getByText(
      'Route list is not an ordered array. Correct the route source, then the member chain can move.',
      {
        exact: true,
      }
    )
  ).toBeVisible();
  const validateBefore = counts.validate;
  const updateBefore = counts.update;
  await dialog.getByRole('button', { name: 'Save routes', exact: true }).click();
  await expect(
    dialog.getByText(
      'Configuration save failed. Inspect the owning configuration or account and retry explicitly.',
      { exact: true }
    )
  ).toBeVisible();
  expect(counts.validate).toBe(validateBefore);
  expect(counts.update).toBe(updateBefore);
  expect(counts.reload).toBe(0);

  await draft.fill(SEEDED_ROUTE);
  // The switch track covers the input. A person clicks the labeled control.
  await dialog.locator('label').filter({ hasText: 'Automatic failover' }).click();
  await expect(failover).not.toBeChecked();
  const validated = page.waitForResponse(operation('runtime.validate'));
  const updated = page.waitForResponse(operation('runtime.file-update'));
  await dialog.getByRole('button', { name: 'Save routes', exact: true }).click();
  const validateResponse = await validated;
  const updateResponse = await updated;
  expect(validateResponse.status()).toBe(200);
  expect(updateResponse.status()).toBe(200);
  expect(fileIds(validateResponse)).toEqual(['gateway.jsonc']);
  expect(wroteFailoverOff(updateResponse)).toBe(true);
  await expect(dialog.getByRole('status').filter({ hasText: 'Persisted revision:' })).toBeVisible();
  await expect(
    dialog.getByText(
      'Persisting routes does not apply them. Use Reload configuration to apply them.',
      { exact: true }
    )
  ).toBeVisible();
  await expect(reasoning.getByText('Failover on', { exact: true })).toBeVisible();
  expect(counts.reload).toBe(0);

  const reloaded = page.waitForResponse(operation('runtime.reload'));
  await dialog.getByRole('button', { name: 'Reload configuration', exact: true }).click();
  expect((await reloaded).status()).toBe(200);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reasoning.getByText('Failover off', { exact: true })).toBeVisible();
  await expect(
    reasoning.getByText('Only the primary is used. Backups stay dormant.', { exact: true })
  ).toBeVisible();
  await expect(reasoning.getByText('Failover on', { exact: true })).toHaveCount(0);

  await page.getByText('Add a Provider profile manually', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Provider id', exact: true }).fill(LOCAL_PROFILE_ID);
  await page
    .getByRole('textbox', { name: 'Provider display name', exact: true })
    .fill(LOCAL_PROFILE_NAME);
  await page.getByRole('button', { name: /Provider kind/ }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'local', exact: true }).click();
  await page.getByRole('textbox', { name: 'Provider models', exact: true }).fill(LOCAL_MODEL);
  await page.getByRole('textbox', { name: 'Default model', exact: true }).fill(LOCAL_MODEL);
  const created = page.waitForResponse(operation('runtime.file-create'));
  await page.getByRole('button', { name: 'Create provider profile', exact: true }).click();
  const createResponse = await created;
  expect(createResponse.status()).toBe(200);
  expect(createdLocalProfile(createResponse)).toBe(true);
  await expect(page.getByText(/Provider persisted revision:/)).toBeVisible();
  await expect(page.getByText(/Provider activation: restart required/)).toBeVisible();

  let removalConfirmed = false;
  page.once('dialog', (dialogEvent) => {
    removalConfirmed = dialogEvent
      .message()
      .startsWith('Remove Provider Agent OpenRouter test local?');
    void dialogEvent.accept();
  });
  const removed = page.waitForResponse(operation('runtime.file-delete'));
  await seeded.getByRole('button', { name: 'Remove Provider', exact: true }).click();
  const removeResponse = await removed;
  expect(removeResponse.status()).toBe(204);
  expect(removalConfirmed).toBe(true);
  expect(removedSeededProfile(removeResponse)).toBe(true);
  await expect(
    page.getByText(
      'Profile removed from persisted configuration; restart required. Active registry retained until restart.',
      { exact: true }
    )
  ).toBeVisible();
  await expect(reasoning.getByText('Failover off', { exact: true })).toBeVisible();
  await expect(seeded.getByText('Used by: Reasoning (primary)', { exact: true })).toBeVisible();

  expect(counts.validate).toBe(1);
  expect(counts.update).toBe(1);
  expect(counts.reload).toBe(1);
  expect(counts.vault).toBe(0);
  expect(counts.login).toBe(0);
  expect(counts.usage).toBe(0);

  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections', exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Primary workspace navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Gateway', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/gateway$/);
  await expect(
    page.getByRole('region', { name: 'Reasoning' }).getByText('Failover off', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('Access denied', { exact: true })).toHaveCount(0);
  expect(counts.vault).toBe(0);
  expect(counts.login).toBe(0);
  expect(counts.usage).toBe(0);
});

function trackOperations(
  page: Page,
  counts: {
    validate: number;
    update: number;
    reload: number;
    vault: number;
    login: number;
    usage: number;
  }
): void {
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const name = operationName(request.url());
    if (name === 'vault.provider-api-key-set') counts.vault += 1;
    if (name === 'provider-subscription.login-start') counts.login += 1;
    if (name === 'usage.read') counts.usage += 1;
  });
  page.on('response', (response) => {
    if (response.request().method() !== 'POST' || response.status() !== 200) return;
    const name = operationName(response.url());
    if (name === 'runtime.validate') counts.validate += 1;
    if (name === 'runtime.file-update') counts.update += 1;
    if (name === 'runtime.reload') counts.reload += 1;
  });
}

function operation(name: string): (response: Response) => boolean {
  return (response) =>
    response.request().method() === 'POST' && operationName(response.url()) === name;
}

function operationName(url: string): string {
  return new URL(url).pathname.split('/').pop() ?? '';
}

function fileIds(response: Response): string[] {
  const body = response.request().postDataJSON() as { files?: Array<{ id?: string }> };
  return (body.files ?? []).map((file) => file.id ?? '');
}

function wroteFailoverOff(response: Response): boolean {
  const body = response.request().postDataJSON() as {
    id?: string;
    kind?: string;
    content?: string;
  };
  return (
    body.id === 'gateway.jsonc' &&
    body.kind === 'gateway' &&
    typeof body.content === 'string' &&
    /"autoFailover"\s*:\s*false/.test(body.content) &&
    !body.content.includes('secretRef') &&
    !body.content.includes('vault://')
  );
}

function createdLocalProfile(response: Response): boolean {
  const body = response.request().postDataJSON() as {
    id?: string;
    kind?: string;
    content?: string;
  };
  return (
    body.id === `providers/${LOCAL_PROFILE_ID}.provider.jsonc` &&
    body.kind === 'provider' &&
    typeof body.content === 'string' &&
    body.content.includes('"schemaVersion": 1') &&
    body.content.includes('"kind": "local"') &&
    !body.content.includes('secretRef') &&
    !body.content.includes('vault://')
  );
}

function removedSeededProfile(response: Response): boolean {
  const body = response.request().postDataJSON() as {
    id?: string;
    kind?: string;
    expectedRevision?: string;
  };
  return (
    body.id === 'providers/agent-openrouter.provider.jsonc' &&
    body.kind === 'provider' &&
    typeof body.expectedRevision === 'string' &&
    body.expectedRevision.length > 0
  );
}
