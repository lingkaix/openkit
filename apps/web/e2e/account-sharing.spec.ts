import { expect, type Page, test } from '@playwright/test';
import {
  completeServerBootstrap,
  type IsolatedWebStack,
  startIsolatedWebStack,
} from './_lib/servers.js';

const password = 'OpenKit-browser-password-2026!';
const bootstrapAdministrator = {
  email: 'bootstrap-admin@example.test',
  name: 'Bootstrap Administrator',
};
const owner = { email: 'owner@example.test', name: 'Owner User' };
const accepting = { email: 'accepting@example.test', name: 'Accepting User' };
const declining = { email: 'declining@example.test', name: 'Declining User' };
const leaving = { email: 'leaving@example.test', name: 'Leaving User' };
const workspaceName = 'Browser sharing workspace';
const admissionConsoleError =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
const deniedConsoleError =
  'Failed to load resource: the server responded with a status of 403 (Forbidden)';
const frozenConsoleError =
  'Failed to load resource: the server responded with a status of 409 (Conflict)';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

/** Captures browser errors and the request identity of each protected-read denial. */
async function watchRuntimeErrors(page: Page) {
  const observation = {
    admission401Ids: new Set<string>(),
    logged401Ids: new Set<string>(),
    frozen409Ids: new Set<string>(),
    logged409Ids: new Set<string>(),
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') observation.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => observation.pageErrors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  cdp.on('Log.entryAdded', (event: unknown) => {
    const entry = (event as { entry?: { text?: string; networkRequestId?: string } }).entry;
    const text = entry?.text;
    const target =
      text === admissionConsoleError
        ? observation.logged401Ids
        : text === frozenConsoleError
          ? observation.logged409Ids
          : null;
    if (!target) return;
    target.add(entry?.networkRequestId ?? `unattached-${target.size}`);
  });
  cdp.on('Network.responseReceived', (event: unknown) => {
    const received = event as {
      requestId?: string;
      response?: { status?: number; url?: string; headers?: Record<string, string> };
    };
    const response = received.response;
    if (!response?.url) return;
    if (!new URL(response.url).pathname.startsWith('/api/')) return;
    const requestId = received.requestId ?? `unattached-${observation.admission401Ids.size}`;
    if (response.status === 401) {
      observation.admission401Ids.add(requestId);
      return;
    }
    if (response.status !== 409) return;
    const retryAfter = headerValue(response.headers, 'retry-after');
    const context = headerValue(response.headers, 'x-openkit-retry-context');
    // The client resends only this capture freeze. Any other 409 stays unexplained.
    if (retryAfter !== '1' || !context || !/^[a-f0-9]{64}$/.test(context)) return;
    observation.frozen409Ids.add(requestId);
  });
  return observation;
}

/** Stable request-identity list for an admission assertion. */
function admissionRequestIds(ids: ReadonlySet<string>): string[] {
  return [...ids].sort();
}

/** Reads one response header from either CDP shape. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (Array.isArray(headers)) {
    const found = headers.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        String((entry as { name?: string }).name).toLowerCase() === name
    ) as { value?: string } | undefined;
    return found?.value;
  }
  if (typeof headers === 'object' && headers !== null) {
    const record = headers as Record<string, string>;
    return record[name] ?? record[name.toLowerCase()];
  }
  return undefined;
}

/** Allowed UI-only localStorage keys. Theme plus the explicit Workspace switcher envelope. */
const UI_LOCAL_STORAGE_KEYS = new Set(['openkit-theme', 'openkit-workspace']);

/** True when the persisted switcher record is the exact Zustand envelope. */
function isWorkspaceSelectionEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'state' && key !== 'version') return false;
  }
  if ('version' in record && typeof record.version !== 'number') return false;
  if (typeof record.state !== 'object' || record.state === null) return false;
  const state = record.state as Record<string, unknown>;
  for (const key of Object.keys(state)) {
    if (key !== 'currentWorkspaceId' && key !== 'selectionUserKey') return false;
  }
  const currentWorkspaceId = state.currentWorkspaceId;
  const selectionUserKey = state.selectionUserKey;
  return (
    (currentWorkspaceId === null || typeof currentWorkspaceId === 'string') &&
    (selectionUserKey === null || typeof selectionUserKey === 'string')
  );
}

/**
 * Proves browser storage holds only UI presentation keys. `openkit-workspace` may
 * retain an explicit authorized switcher selection; passwords, names, emails, and
 * other server or auth secrets stay forbidden. After leave or logout the departed
 * Workspace id must be absent; a still-authorized selected id after ownership transfer
 * may remain as currentWorkspaceId.
 */
async function expectUiOnlyBrowserStorage(
  page: Page,
  forbiddenValues: string[],
  options: { allowSelectedWorkspaceId?: string } = {}
): Promise<void> {
  const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(storage.session).toEqual([]);
  expect(storage.local.every(([key]) => UI_LOCAL_STORAGE_KEYS.has(key))).toBe(true);
  const workspaceEntry = storage.local.find(([key]) => key === 'openkit-workspace');
  if (workspaceEntry) {
    const parsed: unknown = JSON.parse(workspaceEntry[1]);
    expect(isWorkspaceSelectionEnvelope(parsed)).toBe(true);
    const selectedId = (parsed as { state: { currentWorkspaceId: string | null } }).state
      .currentWorkspaceId;
    if (options.allowSelectedWorkspaceId) {
      expect(selectedId === null || selectedId === options.allowSelectedWorkspaceId).toBe(true);
    }
  }
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
      new URL(candidate.url()).pathname === '/api/auth/sign-up/email' &&
      candidate.request().method() === 'POST'
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

/**
 * Selects one authorized Workspace through the sidebar (B2): its group ⋯ menu's Workspace
 * settings place, which opens Settings with that Workspace in the picker.
 */
async function selectWorkspace(page: Page, name: string): Promise<void> {
  const primary = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  const settings = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(primary.or(settings)).toBeVisible();
  if (await settings.isVisible()) {
    await settings.getByRole('button', { name: 'Back to app', exact: true }).click();
  }
  await primary.getByRole('button', { name: `${name} options`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings', exact: true }).click();
  await expect(settings.getByRole('button', { name, exact: true })).toBeVisible();
}

/** Signs out through the live shell, then waits for auth and protected admission to settle. */
async function signOut(page: Page): Promise<void> {
  // Reloading for every actor discards admission caches and consumes the journey's shared budget.
  await openSelectedWorkspaceAccount(page);
  const signedOut = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/sign-out' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await signedOut).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
}

/** Creates one selected Workspace through the live product surface. */
async function createWorkspace(page: Page, webUrl: string): Promise<string> {
  await page.goto(`${webUrl}/settings/workspaces/new`);
  await page.getByRole('textbox', { name: 'Name' }).fill(workspaceName);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/app/operations/workspace.create' &&
      candidate.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const body = (await (await response).json()) as { id: string };
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByText(workspaceName, { exact: true })).toBeVisible();
  return body.id;
}

/** Creates one member-authorized invitation and proves its exact email leaves the rendered surface. */
async function invite(page: Page, email: string): Promise<void> {
  const invitations = page.getByRole('region', { name: 'Workspace invitations' });
  await invitations.getByRole('textbox', { name: 'Invitee email' }).fill(email);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/app/operations/workspace.invitation-create'
  );
  await invitations.getByRole('button', { name: 'Create invitation' }).click();
  const response = await responsePromise;
  expect(response.ok(), `Invitation response ${response.status()}: ${await response.text()}`).toBe(
    true
  );
  await expect(invitations.getByRole('textbox', { name: 'Invitee email' })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(email);
}

/** Opens Account through the live shell without discarding the in-memory Workspace selection. */
async function openSelectedWorkspaceAccount(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Account' });
  if (!(await heading.isVisible())) {
    // B2: Settings pages list Account themselves; app pages have the Settings gear.
    const settings = page.getByRole('navigation', { name: 'Settings sections' });
    if (await settings.isVisible()) {
      await settings.getByRole('button', { name: 'Account', exact: true }).click();
    } else {
      await page.getByRole('button', { name: /^Settings$/ }).click();
    }
  }
  await expect(heading).toBeVisible();
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
  // Snapshot maintenance can refuse this mutation with retryable workspace_frozen until the capture fence releases. The screen keeps the same decision in flight for that refusal.
  await expect(
    invitations.getByRole('row', {
      name: new RegExp(operation === 'Accept' ? 'accepted' : 'declined', 'i'),
    })
  ).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('button', { name: /accept|decline/i })).toHaveCount(0);
}

test('proves server accounts, cross-actor isolation, sharing boundaries, and safe failures', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  stack = await startIsolatedWebStack({ mode: 'server', useSimulator: true });
  await page.setViewportSize({ width: 800, height: 600 });
  const runtimeErrors = await watchRuntimeErrors(page);
  await page.goto(stack.webUrl);

  // Bootstrap creates only the deployment administrator. The sharing owner signs up afterwards.
  await completeServerBootstrap(stack, { ...bootstrapAdministrator, password });
  const ownerId = await signUp(page, owner);
  const workspaceId = await createWorkspace(page, stack.webUrl);
  await signOut(page);

  const acceptingId = await signUp(page, accepting);
  await expect(page.locator('body')).not.toContainText(workspaceName);
  await expect(page.locator('body')).not.toContainText(workspaceId);
  await signOut(page);
  const decliningId = await signUp(page, declining);
  await signOut(page);
  const leavingId = await signUp(page, leaving);
  await signOut(page);

  await signIn(page, owner);
  await selectWorkspace(page, workspaceName);
  await openSelectedWorkspaceAccount(page);
  await expect(page.getByRole('region', { name: 'Workspace members' })).toBeVisible();
  await invite(page, accepting.email);
  await invite(page, declining.email);
  await invite(page, leaving.email);
  await signOut(page);

  await signIn(page, accepting);
  await decideInvitation(page, stack.webUrl, 'Accept');
  await signOut(page);
  await signIn(page, declining);
  await decideInvitation(page, stack.webUrl, 'Decline');
  await signOut(page);
  await signIn(page, leaving);
  await decideInvitation(page, stack.webUrl, 'Accept');
  await signOut(page);

  await signIn(page, owner);
  await selectWorkspace(page, workspaceName);
  await openSelectedWorkspaceAccount(page);
  const members = page.getByRole('region', { name: 'Workspace members' });
  const acceptingRow = members.getByRole('row', { name: new RegExp(acceptingId) });
  await expect(acceptingRow).toContainText('Active member');
  await expect(acceptingRow.getByLabel('Access level')).toHaveCount(0);

  const staleOwnerContext = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const staleOwnerPage = await staleOwnerContext.newPage();
  const staleRuntimeErrors = await watchRuntimeErrors(staleOwnerPage);
  const deniedEmail = 'must-not-leak@example.test';
  try {
    await staleOwnerPage.goto(stack.webUrl);
    await signIn(staleOwnerPage, owner);
    await selectWorkspace(staleOwnerPage, workspaceName);
    await openSelectedWorkspaceAccount(staleOwnerPage);
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

    // Ownership transfer keeps ordinary member controls. Actual removal revokes the stale session.
    await expect(page.getByRole('region', { name: 'Workspace members' })).toBeVisible();
    await signOut(page);
    await signIn(page, accepting);
    await selectWorkspace(page, workspaceName);
    await openSelectedWorkspaceAccount(page);
    const currentMembers = page.getByRole('region', { name: 'Workspace members' });
    const formerOwner = currentMembers.getByRole('row', { name: new RegExp(ownerId) });
    await formerOwner.getByRole('button', { name: 'Remove member' }).click();
    await page
      .getByRole('dialog', { name: /confirm remove member/i })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect(formerOwner).toContainText('removed');

    const staleInvitations = staleOwnerPage.getByRole('region', { name: 'Workspace invitations' });
    await staleInvitations.getByRole('textbox', { name: 'Invitee email' }).fill(deniedEmail);
    const deniedResponsePromise = staleOwnerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/workspace.invitation-create' &&
        response.request().method() === 'POST'
    );
    await staleInvitations.getByRole('button', { name: 'Create invitation' }).click();
    const deniedResponse = await deniedResponsePromise;
    expect(deniedResponse.status()).toBe(403);
    await expect(deniedResponse.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    await expect(staleOwnerPage.getByRole('alert')).toContainText('Workspace access denied.');
    await expect(staleInvitations.getByRole('textbox', { name: 'Invitee email' })).toHaveValue('');
    await expect(staleOwnerPage.locator('body')).not.toContainText(deniedEmail);
    await expectUiOnlyBrowserStorage(
      staleOwnerPage,
      [
        password,
        workspaceName,
        owner.email,
        accepting.email,
        declining.email,
        leaving.email,
        deniedEmail,
      ],
      { allowSelectedWorkspaceId: workspaceId }
    );
    expect(staleRuntimeErrors.pageErrors).toEqual([]);
    expect(
      staleRuntimeErrors.consoleErrors.filter((message) => message === deniedConsoleError)
    ).toHaveLength(1);
    expect(admissionRequestIds(staleRuntimeErrors.logged401Ids)).toEqual(
      admissionRequestIds(staleRuntimeErrors.admission401Ids)
    );
    expect(admissionRequestIds(staleRuntimeErrors.logged409Ids)).toEqual(
      admissionRequestIds(staleRuntimeErrors.frozen409Ids)
    );
    expect(
      staleRuntimeErrors.consoleErrors.filter(
        (message) =>
          message !== admissionConsoleError &&
          message !== deniedConsoleError &&
          message !== frozenConsoleError
      )
    ).toEqual([]);
  } finally {
    await staleOwnerContext.close();
  }

  await signOut(page);
  await signIn(page, accepting);
  await selectWorkspace(page, workspaceName);
  await openSelectedWorkspaceAccount(page);
  const newOwnerMembers = page.getByRole('region', { name: 'Workspace members' });
  const formerOwnerRow = newOwnerMembers.getByRole('row', { name: new RegExp(ownerId) });
  await expect(formerOwnerRow.getByRole('button', { name: 'Remove member' })).toHaveCount(0);
  await expect(formerOwnerRow).toContainText('removed');
  await expect(newOwnerMembers.getByRole('row', { name: new RegExp(decliningId) })).toHaveCount(0);
  await signOut(page);

  await signIn(page, leaving);
  await selectWorkspace(page, workspaceName);
  await openSelectedWorkspaceAccount(page);
  const role = page.getByRole('region', { name: 'Current Workspace access' });
  await role.getByRole('button', { name: 'Leave Workspace' }).click();
  await page
    .getByRole('dialog', { name: /confirm leave workspace/i })
    .getByRole('button', { name: 'Confirm leave' })
    .click();
  await expect(role.getByRole('button', { name: 'Leave Workspace' })).toHaveCount(0);
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
  expect(admissionRequestIds(runtimeErrors.logged401Ids)).toEqual(
    admissionRequestIds(runtimeErrors.admission401Ids)
  );
  expect(admissionRequestIds(runtimeErrors.logged409Ids)).toEqual(
    admissionRequestIds(runtimeErrors.frozen409Ids)
  );
  expect(
    runtimeErrors.consoleErrors.every(
      (message) => message === admissionConsoleError || message === frozenConsoleError
    )
  ).toBe(true);

  const viewport = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.viewportWidth);
});
