import { expect, test } from '@playwright/test';

test('completes the local workspace and knowledge flow', async ({ page }) => {
  const suffix = Date.now().toString();
  const workspaceName = `E2E Workspace ${suffix}`;
  const threadName = `E2E thread ${suffix}`;

  await page.goto('/');

  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('New workspace').fill(workspaceName);
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('button', { name: workspaceName })).toBeVisible();

  await page.getByLabel(`New thread for ${workspaceName}`).fill(threadName);
  await page.getByRole('button', { name: /^New thread$/ }).click();
  await expect(page.getByRole('heading', { name: `${threadName} Dashboard` })).toBeVisible();

  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^Knowledge$/ }).click();
  await page.getByLabel('Knowledge title').fill('E2E knowledge');
  await page.getByLabel('Knowledge content').fill('Remember the local browser workspace path.');
  await page.getByRole('button', { name: /^Add knowledge$/ }).click();
  await expect(page.getByText(/E2E knowledge/)).toBeVisible();
  await page.getByLabel('Edit E2E knowledge').click();
  await page.getByLabel('Knowledge content').fill('Remember the edited browser workspace path.');
  await page.getByRole('button', { name: /^Save knowledge$/ }).click();
  await expect(page.getByRole('button', { name: /^Add knowledge$/ })).toBeVisible();
  await expect(page.getByText(/Remember the edited browser workspace path\./)).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(workspaceName) })).toBeVisible();
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await expect(page.getByRole('heading', { name: /^Workspace Settings$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Knowledge$/ }).click();
  await expect(page.getByText(/Remember the edited browser workspace path\./)).toBeVisible();
});
