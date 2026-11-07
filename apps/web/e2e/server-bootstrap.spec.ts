import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

const password = 'OpenKit-browser-password-2026!';
const owner = { email: 'bootstrap-owner@example.test', name: 'Bootstrap Owner' };

test('completes first-owner bootstrap from the sign-up screen before signing in', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let stack: IsolatedWebStack | null = null;
  try {
    stack = await startIsolatedWebStack({ mode: 'server', useSimulator: true });
    const emission = await readFile(
      join(stack.dataRoot, 'server', 'files', 'auth', 'bootstrap-token.txt'),
      'utf8'
    );
    const bootstrap = /^Token: (\S+)$/m.exec(emission)?.[1];
    expect(bootstrap).toBeTruthy();
    await page.goto(stack.webUrl);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill(owner.name);
    await page.getByRole('textbox', { name: 'Email' }).fill(owner.email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).last().click();
    await expect(page.getByLabel('Bootstrap token')).toBeVisible();

    await page.getByLabel('Bootstrap token').fill(bootstrap ?? '');
    await page.getByLabel('Password').fill(password);
    const consumeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/bootstrap.consume' &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Sign up' }).last().click();
    expect((await consumeResponse).status()).toBe(201);

    const sheet = page.getByRole('region', { name: 'One-time administrator token' });
    const tokenField = sheet.getByLabel('Administrator token');
    await expect(tokenField).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(page.getByRole('main', { name: 'Workspace' })).toHaveCount(0);
    const adminToken = await tokenField.inputValue();
    expect(adminToken.startsWith('okt_')).toBe(true);

    await sheet.getByLabel('Password').fill(password);
    await sheet.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();

    const storage = await page.evaluate(() => ({
      local: Object.values(localStorage).join('\n'),
      session: Object.values(sessionStorage).join('\n'),
    }));
    expect(storage.local).not.toContain(bootstrap ?? '');
    expect(storage.local).not.toContain(adminToken);
    expect(storage.local).not.toContain(password);
    expect(storage.session).not.toContain(adminToken);
    expect(storage.session).not.toContain(password);
    await expect(page.locator('body')).not.toContainText(adminToken);
    await expect(page.locator('body')).not.toContainText(password);
  } finally {
    await stack?.stop();
  }
});
