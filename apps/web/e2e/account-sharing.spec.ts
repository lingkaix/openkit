import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

const password = 'OpenKit-browser-password-2026!';
const owner = { email: 'owner@example.test', name: 'Owner User' };
const accepting = { email: 'accepting@example.test', name: 'Accepting User' };
const declining = { email: 'declining@example.test', name: 'Declining User' };
const leaving = { email: 'leaving@example.test', name: 'Leaving User' };
const workspaceName = 'Browser sharing workspace';
const admissionConsoleError =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
const deniedConsoleError =
  'Failed to load resource: the server responded with a status of 403 (Forbidden)';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

/** Captures browser errors and exact protected-read denials without retaining payloads. */
function watchRuntimeErrors(page: Page) {
  const observation = {
    admission401Count: 0,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') observation.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => observation.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/app/workspaces' && response.status() === 401) {
      observation.admission401Count += 1;
    }
  });
  return observation;
}

/** Proves browser storage contains only the existing persisted UI theme and no scoped values. */
async function expectUiOnlyBrowserStorage(page: Page, forbiddenValues: string[]): Promise<void> {
  const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(storage.local.every(([key]) => key === 'openkit-theme')).toBe(true);
  expect(storage.session).toEqual([]);
  const retained = JSON.stringify(storage);
  for (const value of forbiddenValues) expect(retained).not.toContain(value);
}

/** Opens the account gate and creates one real server-mode account through the UI. */
async function signUp(page: Page, account: { email: string; name: string }): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(account.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(account.email);
  await page.getByLabel('Password').fill(password);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/auth/sign-up/email') && candidate.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Sign up' }).last().click();
  const body = (await (await response).json()) as { user: { id: string } };
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(account.email);
  await expect(page.locator('body')).not.toContainText(password);
  return body.user.id;
}

/** Enters an existing account and waits for protected product admission. */
async function signIn(page: Page, account: { email: string }): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(account.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(account.email);
  await expect(page.locator('body')).not.toContainText(password);
}

/** Leaves the authenticated product and waits for the protected read to reopen the gate. */
async function signOut(page: Page, webUrl: string): Promise<void> {
  await page.goto(`${webUrl}/settings/account`);
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
}

/** Creates one selected Workspace through the live product surface. */
async function createWorkspace(page: Page, webUrl: string): Promise<string> {
  await page.goto(`${webUrl}/settings/workspaces/new`);
  await page.getByRole('textbox', { name: 'Name' }).fill(workspaceName);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/workspaces') && candidate.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const body = (await (await response).json()) as { id: string };
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(workspaceName, { exact: true })).toBeVisible();
  return body.id;
}

/** Creates one owner invitation and proves its exact email leaves the rendered surface. */
async function invite(page: Page, email: string): Promise<void> {
  const invitations = page.getByRole('region', { name: 'Workspace invitations' });
  await invitations.getByRole('textbox', { name: 'Invitee email' }).fill(email);
  await invitations.getByRole('button', { name: 'Create invitation' }).click();
  await expect(invitations.getByRole('textbox', { name: 'Invitee email' })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(email);
}

/** Settles one current-user invitation from the account-level collection. */
async function decideInvitation(
  page: Page,
  webUrl: string,
  operation: 'Accept' | 'Decline'
): Promise<void> {
  await page.goto(`${webUrl}/settings/account`);
  const invitations = page.getByRole('region', { name: 'My invitations' });
  const row = invitations.getByRole('row', { name: /pending/i }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: operation }).click();
  await expect(
    invitations.getByRole('row', {
      name: new RegExp(operation === 'Accept' ? 'accepted' : 'declined', 'i'),
    })
  ).toBeVisible();
  await expect(row.getByRole('button', { name: /accept|decline/i })).toHaveCount(0);
}

test('proves server accounts, cross-actor isolation, sharing boundaries, and safe failures', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  stack = await startIsolatedWebStack({ mode: 'server', useSimulator: true });
  await page.setViewportSize({ width: 800, height: 600 });
  const runtimeErrors = watchRuntimeErrors(page);
  await page.goto(stack.webUrl);

  const ownerId = await signUp(page, owner);
  const workspaceId = await createWorkspace(page, stack.webUrl);
  await signOut(page, stack.webUrl);

  const acceptingId = await signUp(page, accepting);
  await expect(page.locator('body')).not.toContainText(workspaceName);
  await expect(page.locator('body')).not.toContainText(workspaceId);
  await signOut(page, stack.webUrl);
  const decliningId = await signUp(page, declining);
  await signOut(page, stack.webUrl);
  const leavingId = await signUp(page, leaving);
  await signOut(page, stack.webUrl);

  await signIn(page, owner);
  await page.goto(`${stack.webUrl}/settings/account`);
  await expect(page.getByRole('region', { name: 'Workspace members' })).toBeVisible();
  await invite(page, accepting.email);
  await invite(page, declining.email);
  await invite(page, leaving.email);
  await signOut(page, stack.webUrl);

  await signIn(page, accepting);
  await decideInvitation(page, stack.webUrl, 'Accept');
  await signOut(page, stack.webUrl);
  await signIn(page, declining);
  await decideInvitation(page, stack.webUrl, 'Decline');
  await signOut(page, stack.webUrl);
  await signIn(page, leaving);
  await decideInvitation(page, stack.webUrl, 'Accept');
  await signOut(page, stack.webUrl);

  await signIn(page, owner);
  await page.goto(`${stack.webUrl}/settings/account`);
  const members = page.getByRole('region', { name: 'Workspace members' });
  const acceptingRow = members.getByRole('row', { name: new RegExp(acceptingId) });
  await acceptingRow.getByLabel('Access level').click();
  await page.getByRole('option', { name: 'Viewer' }).click();
  await acceptingRow.getByRole('button', { name: 'Save access' }).click();
  await expect(acceptingRow).toContainText('Read only');

  const staleOwnerContext = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const staleOwnerPage = await staleOwnerContext.newPage();
  const staleRuntimeErrors = watchRuntimeErrors(staleOwnerPage);
  const deniedEmail = 'must-not-leak@example.test';
  try {
    await staleOwnerPage.goto(stack.webUrl);
    await signIn(staleOwnerPage, owner);
    await staleOwnerPage.goto(`${stack.webUrl}/settings/account`);
    const staleMembers = staleOwnerPage.getByRole('region', { name: 'Workspace members' });
    await expect(staleMembers).toBeVisible();

    await acceptingRow.getByRole('button', { name: 'Transfer ownership' }).click();
    await page
      .getByRole('dialog', { name: /confirm transfer ownership/i })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect(page.getByRole('status', { name: 'Workspace ownership transfer' })).toContainText(
      acceptingId
    );

    const staleInvitations = staleOwnerPage.getByRole('region', { name: 'Workspace invitations' });
    await staleInvitations.getByRole('textbox', { name: 'Invitee email' }).fill(deniedEmail);
    const deniedResponsePromise = staleOwnerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/app/workspaces/${workspaceId}/invitations` &&
        response.request().method() === 'POST'
    );
    await staleInvitations.getByRole('button', { name: 'Create invitation' }).click();
    const deniedResponse = await deniedResponsePromise;
    expect(deniedResponse.status()).toBe(403);
    await expect(deniedResponse.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    await expect(staleOwnerPage.getByRole('alert')).toContainText('Workspace access denied.');
    await expect(staleInvitations.getByRole('textbox', { name: 'Invitee email' })).toHaveValue('');
    await expect(staleOwnerPage.locator('body')).not.toContainText(deniedEmail);
    await expectUiOnlyBrowserStorage(staleOwnerPage, [
      password,
      workspaceId,
      workspaceName,
      owner.email,
      accepting.email,
      declining.email,
      leaving.email,
      deniedEmail,
    ]);
    expect(staleRuntimeErrors.pageErrors).toEqual([]);
    expect(
      staleRuntimeErrors.consoleErrors.filter((message) => message === deniedConsoleError)
    ).toHaveLength(1);
    expect(
      staleRuntimeErrors.consoleErrors.filter((message) => message === admissionConsoleError)
    ).toHaveLength(staleRuntimeErrors.admission401Count);
    expect(
      staleRuntimeErrors.consoleErrors.filter(
        (message) => message !== admissionConsoleError && message !== deniedConsoleError
      )
    ).toEqual([]);
  } finally {
    await staleOwnerContext.close();
  }

  await signOut(page, stack.webUrl);
  await signIn(page, accepting);
  await page.goto(`${stack.webUrl}/settings/account`);
  const newOwnerMembers = page.getByRole('region', { name: 'Workspace members' });
  const formerOwnerRow = newOwnerMembers.getByRole('row', { name: new RegExp(ownerId) });
  await formerOwnerRow.getByRole('button', { name: 'Remove member' }).click();
  await page
    .getByRole('dialog', { name: /confirm remove member/i })
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(formerOwnerRow).toContainText('removed');
  await expect(newOwnerMembers.getByRole('row', { name: new RegExp(decliningId) })).toHaveCount(0);
  await signOut(page, stack.webUrl);

  await signIn(page, leaving);
  await page.goto(`${stack.webUrl}/settings/account`);
  const membership = page.getByRole('region', { name: 'Workspace membership' });
  await membership.getByRole('button', { name: 'Leave Workspace' }).click();
  await page
    .getByRole('dialog', { name: /confirm leave workspace/i })
    .getByRole('button', { name: 'Confirm leave' })
    .click();
  await expect(page.getByRole('region', { name: 'Workspace membership' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(leavingId);

  await expectUiOnlyBrowserStorage(page, [
    password,
    workspaceId,
    workspaceName,
    owner.email,
    accepting.email,
    declining.email,
    leaving.email,
    deniedEmail,
  ]);
  expect(runtimeErrors.consoleErrors.join('\n')).not.toContain(password);
  expect(staleRuntimeErrors.consoleErrors.join('\n')).not.toContain(password);
  for (const email of [owner.email, accepting.email, declining.email, leaving.email, deniedEmail]) {
    expect(runtimeErrors.consoleErrors.join('\n')).not.toContain(email);
    expect(staleRuntimeErrors.consoleErrors.join('\n')).not.toContain(email);
  }
  expect(runtimeErrors.pageErrors).toEqual([]);
  expect(runtimeErrors.consoleErrors).toHaveLength(runtimeErrors.admission401Count);
  expect(runtimeErrors.consoleErrors.every((message) => message === admissionConsoleError)).toBe(
    true
  );

  const viewport = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.viewportWidth);
});
