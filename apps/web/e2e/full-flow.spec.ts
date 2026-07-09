import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';

const coreUrl = 'http://127.0.0.1:3100';

/**
 * Finds a workspace id by its visible name.
 *
 * @param request Playwright request context for direct NanoCore calls.
 * @param workspaceName Visible workspace name created through the browser.
 * @returns Matching workspace id.
 * @throws Error when the workspace is not listed by NanoCore.
 */
async function workspaceIdForName(
  request: APIRequestContext,
  workspaceName: string
): Promise<string> {
  const response = await request.get(`${coreUrl}/api/workspaces`);
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { items: Array<{ id: string; name: string }> };
  const workspace = payload.items.find((item) => item.name === workspaceName);

  if (!workspace) {
    throw new Error(`Created workspace ${workspaceName} was not listed by NanoCore`);
  }

  return workspace.id;
}

/**
 * Links a temporary git repository resource for a workspace.
 *
 * @param request Playwright request context for direct NanoCore calls.
 * @param workspaceId Workspace id that should own the repository link.
 * @returns Nothing after the repository has been linked.
 */
async function linkTemporaryRepository(
  request: APIRequestContext,
  workspaceId: string
): Promise<void> {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-web-full-flow-repo-'));
  mkdirSync(join(repositoryPath, '.git'));

  const response = await request.post(
    `${coreUrl}/api/app/workspaces/${workspaceId}/repositories/default`,
    {
      data: {
        displayName: 'E2E repository',
        localPath: repositoryPath,
      },
    }
  );
  expect(response.status()).toBe(200);
}

test('completes the internal self-check workspace flow', async ({ page, request }) => {
  const suffix = Date.now().toString();
  const workspaceName = `E2E Workspace ${suffix}`;
  const threadName = `E2E thread ${suffix}`;

  await page.goto('/');

  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('New workspace').fill(workspaceName);
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('button', { name: workspaceName })).toBeVisible();
  const workspaceId = await workspaceIdForName(request, workspaceName);
  await linkTemporaryRepository(request, workspaceId);

  await page.getByLabel(`New thread for ${workspaceName}`).fill(threadName);
  await page.getByRole('button', { name: /^New thread$/ }).click();
  await expect(page.getByRole('heading', { name: `${threadName} Dashboard` })).toBeVisible();

  await page.getByLabel('Turn prompt').fill('Run the simulator full flow.');
  await page.getByRole('button', { name: /^Send turn$/ }).click();
  await expect(page.getByText(/Run the simulator full flow\./)).toBeVisible();
  await expect(page.getByText(/simulator: ok/i).first()).toBeVisible();
  await expect(page.getByText(/Approve simulated workspace update/).first()).toBeVisible();

  await page.getByRole('button', { name: /^Approve$/ }).click();
  await expect(
    page.getByLabel('Attention needed').getByText(/Which summary tone should the simulator use/i)
  ).toBeVisible();
  await expect(page.getByText(/^Granted$/)).toBeVisible();

  await page.getByLabel('Answer').fill('Concise');
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await expect(page.getByText(/Concise/)).toBeVisible();
  await expect(page.getByLabel('Agent session')).toContainText(/session_sim_/i);
  await page.getByRole('button', { name: /^Refresh agent health$/ }).click();
  await expect(page.getByRole('button', { name: /^Refresh agent health$/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^View artifact$/ }).first()).toBeVisible();

  await page
    .getByRole('button', { name: /^View artifact$/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /Simulated protocol summary/i })).toBeVisible();
  await expect(page.getByText(/Simulator answer: Concise/i)).toBeVisible();

  await page.getByRole('button', { name: /^Back$/ }).click();
  await page.getByRole('button', { name: new RegExp(threadName) }).click();
  await page.getByLabel('Turn prompt').fill('Interrupt this self-check turn.');
  await page.getByRole('button', { name: /^Send turn$/ }).click();
  await expect(page.getByRole('button', { name: /^Stop turn$/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Stop turn$/ }).click();
  await expect(page.getByRole('button', { name: /^Stop turn$/ })).toBeDisabled();

  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^Knowledge$/ }).click();
  await page.getByLabel('Knowledge title').fill('E2E knowledge');
  await page.getByLabel('Knowledge content').fill('Remember the simulator browser smoke path.');
  await page.getByRole('button', { name: /^Add knowledge$/ }).click();
  await expect(page.getByText(/E2E knowledge/)).toBeVisible();
  await page.getByLabel('Edit E2E knowledge').click();
  await page.getByLabel('Knowledge content').fill('Remember the edited simulator smoke path.');
  await page.getByRole('button', { name: /^Save knowledge$/ }).click();
  await expect(page.getByText(/Remember the edited simulator smoke path\./)).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(workspaceName) })).toBeVisible();
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await expect(page.getByRole('heading', { name: /^Workspace Settings$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Knowledge$/ }).click();
  await expect(page.getByText(/Remember the edited simulator smoke path\./)).toBeVisible();
});
