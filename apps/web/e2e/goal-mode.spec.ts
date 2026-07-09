import { expect, test } from '@playwright/test';

const coreUrl = 'http://127.0.0.1:3100';

test('drives the deterministic Goal Mode loop through the browser', async ({ page, request }) => {
  const suffix = Date.now().toString();
  const threadName = `Goal Mode e2e ${suffix}`;

  await page.goto('/');

  await expect(page.getByRole('button', { name: /Demo Workspace/ })).toBeVisible();
  await page.getByLabel('New thread for Demo Workspace').fill(threadName);
  await page.getByRole('button', { name: /^New thread$/ }).click();
  await expect(page.getByRole('heading', { name: `${threadName} Dashboard` })).toBeVisible();

  const goalMode = page.getByRole('region', { name: /Goal Mode/i });
  await goalMode.getByRole('textbox', { name: /Goal objective/i }).fill('Ship v0.0.6 safely.');
  await goalMode.getByRole('button', { name: /^Start goal$/ }).click();
  await expect(goalMode).toContainText(/Planning/i);

  const planReview = page.getByRole('region', { name: /Goal plan review/i });
  await planReview.getByRole('button', { name: /^Draft plan$/ }).click();
  await expect(planReview).toContainText(/Ship v0.0.6 safely/i);
  await planReview.getByRole('button', { name: /^Approve plan$/ }).click();
  await expect(goalMode).toContainText(/Running/i);
  await expect(goalMode).toContainText(/1 ready/i);

  const threadsResponse = await request.get(`${coreUrl}/api/workspaces/ws_demo/threads`);
  expect(threadsResponse.status()).toBe(200);
  const threadsPayload = (await threadsResponse.json()) as {
    items: Array<{ id: string; name: string }>;
  };
  const thread = threadsPayload.items.find((item) => item.name === threadName);
  expect(thread, `Created thread ${threadName} should be listed`).toBeTruthy();
  if (!thread) {
    throw new Error(`Created thread ${threadName} was not listed by NanoCore`);
  }

  const superviseResponse = await request.post(
    `${coreUrl}/api/app/workspaces/ws_demo/threads/${thread.id}/goal/test/supervise/step`,
    { data: {} }
  );
  expect(superviseResponse.status()).toBe(200);

  await page.reload();
  await page.getByRole('button', { name: new RegExp(threadName) }).click();
  await expect(goalMode).toContainText(/Finished with Completed/i);
});
