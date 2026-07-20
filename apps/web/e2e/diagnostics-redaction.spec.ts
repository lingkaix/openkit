import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;

  if (current) {
    await current.stop();
  }
});

test('keeps configured provider secrets out of visible diagnostics', async ({ page }) => {
  const secret = 'sk-openkit-web-e2e-secret';
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-web-redaction-'));
  const providerRoot = join(dataRoot, 'config', 'providers');

  mkdirSync(providerRoot, { recursive: true });
  writeFileSync(
    join(providerRoot, 'redacted.provider.jsonc'),
    JSON.stringify({
      id: 'provider_web_redaction',
      displayName: 'Web Redaction Provider',
      kind: 'custom',
      baseUrl: 'https://provider.example.com/v1',
      models: ['redaction-model'],
      defaultModel: 'redaction-model',
      secretRef: 'env:OPENKIT_WEB_REDACTION_SECRET',
      extensions: {
        optional: {
          diagnosticProbe: secret,
        },
      },
      readiness: { status: 'ready' },
    })
  );

  stack = await startIsolatedWebStack({ dataRoot, mode: 'local', useSimulator: true });
  await page.goto(stack.webUrl);

  await expect(page.getByRole('button', { name: /Demo Workspace/ })).toBeVisible();
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^Diagnostics$/ }).click();
  await expect(page.getByRole('heading', { name: /^Diagnostics$/ })).toBeVisible();
  await expect(page.getByText(/Setup readiness/)).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: /Setup provider instances/i })
      .getByText(/provider_web_redaction - custom - secret ref configured/)
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: /Agent setup readiness/i })
      .getByText(/agent_codex_host - no deployment - openai/)
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secret);
});
