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

test('signs in through the UI and returns to auth after sign-out', async ({ page }) => {
  const suffix = Date.now().toString();
  const email = `web-e2e-${suffix}@example.com`;
  const password = 'password123456';
  const workspaceName = `Server Mode Workspace ${suffix}`;

  stack = await startIsolatedWebStack({ mode: 'server' });
  await page.goto(stack.webUrl);

  await expect(page.getByRole('heading', { name: /^Sign in$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Create an account$/ }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill('Web E2E User');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Create account$/ }).click();
  await expect(page.getByRole('button', { name: /^New workspace$/ })).toBeVisible();

  await page.getByRole('button', { name: /^Sign out$/ }).click();
  await expect(page.getByRole('heading', { name: /^Sign in$/ })).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('button', { name: /^New workspace$/ })).toBeVisible();

  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('New workspace').fill(workspaceName);
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('button', { name: workspaceName })).toBeVisible();

  await page.getByRole('button', { name: /^Sign out$/ }).click();
  await expect(page.getByRole('heading', { name: /^Sign in$/ })).toBeVisible();
});
