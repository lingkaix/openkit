import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { CodexAccountClient } from './llm/codex-oauth.js';
import { CodexOAuthAccountManager } from './llm/codex-oauth-accounts.js';
import type { GetAccountResponse, JsonRpcNotification } from './runtime/codex/protocol.js';
import { createApp } from './test-support/app.js';

class FakeCodexAccountClient implements CodexAccountClient {
  public readonly requests: Array<{ method: string; params: unknown }> = [];
  public readonly requestErrors = new Map<string, Error>();
  public account: GetAccountResponse = { account: null, requiresOpenaiAuth: true };
  private readonly listeners = new Set<(message: JsonRpcNotification) => void>();

  /**
   * Records one JSON-RPC request and returns the fixture response for the method.
   *
   * @param method Codex app-server request method.
   * @param params Request parameters sent by nanocore.
   * @returns Fixture response for the requested method.
   */
  public async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push({ method, params });

    const requestError = this.requestErrors.get(method);
    if (requestError) {
      throw requestError;
    }

    if (method === 'account/read') {
      return this.account as TResult;
    }

    if (method === 'account/login/start') {
      if ((params as { type?: string }).type === 'chatgptDeviceCode') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login_device',
          verificationUrl: 'https://chatgpt.com/activate',
          userCode: 'OPEN-KIT',
        } as TResult;
      }

      return {
        type: 'chatgpt',
        loginId: 'login_browser',
        authUrl: 'https://chatgpt.com/auth/codex/login',
      } as TResult;
    }

    if (method === 'account/login/cancel') {
      return { status: 'canceled' } as TResult;
    }

    if (method === 'account/logout') {
      this.account = { account: null, requiresOpenaiAuth: true };
      return {} as TResult;
    }

    throw new Error(`Unexpected request: ${method}`);
  }

  /**
   * Subscribes to fake Codex notifications.
   *
   * @param listener Notification listener to register.
   * @returns Unsubscribe callback.
   */
  public onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Closes the fake client.
   *
   * @returns Resolved close operation.
   */
  public async close(): Promise<void> {}

  /**
   * Emits one fake Codex notification.
   *
   * @param message Notification to deliver to subscribers.
   */
  public emit(message: JsonRpcNotification): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

/**
 * Creates an app wired to a deterministic fake Codex account client.
 *
 * @param client Fake client used by the OAuth store.
 * @returns Hono app with Codex OAuth routes.
 */
function createOAuthApp(client: FakeCodexAccountClient) {
  return createApp({
    codexOAuthAccountManager: new CodexOAuthAccountManager({
      clientFactory: async () => client,
      dataRoot: null,
    }),
  });
}

describe('OpenAI Codex OAuth app API', () => {
  it('keeps Codex OAuth action route definitions account-scoped', () => {
    const source = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(
      /app\.(get|post)\(\s*['"]\/api\/app\/oauth\/openai-codex\/(?:status|start|cancel|logout)['"]/
    );
  });

  it('does not expose account-unscoped OAuth action routes', async () => {
    const client = new FakeCodexAccountClient();
    const app = createOAuthApp(client);

    for (const [method, path] of [
      ['GET', '/api/app/oauth/openai-codex/status'],
      ['POST', '/api/app/oauth/openai-codex/start'],
      ['POST', '/api/app/oauth/openai-codex/cancel'],
      ['POST', '/api/app/oauth/openai-codex/logout'],
    ] as const) {
      const response = await app.request(path, { method });

      expect(response.status).toBe(404);
    }
  });

  it('reports logged-out status by default', async () => {
    const client = new FakeCodexAccountClient();
    const app = createOAuthApp(client);
    const res = await app.request('/api/app/oauth/openai-codex/accounts/default/status');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'logged_out',
    });
  });

  it('starts and cancels a Codex browser login flow', async () => {
    const client = new FakeCodexAccountClient();
    const app = createOAuthApp(client);

    const startRes = await app.request('/api/app/oauth/openai-codex/accounts/default/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'browser' }),
    });

    expect(startRes.status).toBe(200);
    await expect(startRes.json()).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'pending',
      mode: 'browser',
      loginId: 'login_browser',
      authUrl: 'https://chatgpt.com/auth/codex/login',
    });
    expect(client.requests).toContainEqual({
      method: 'account/login/start',
      params: { type: 'chatgpt' },
    });

    const cancelRes = await app.request('/api/app/oauth/openai-codex/accounts/default/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 'login_browser' }),
    });

    expect(cancelRes.status).toBe(200);
    await expect(cancelRes.json()).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'logged_out',
    });
    expect(client.requests).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'login_browser' },
    });
  });

  it('starts a Codex device-code login flow', async () => {
    const client = new FakeCodexAccountClient();
    const app = createOAuthApp(client);

    const startRes = await app.request('/api/app/oauth/openai-codex/accounts/default/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'device_code' }),
    });

    expect(startRes.status).toBe(200);
    await expect(startRes.json()).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'pending',
      mode: 'device_code',
      loginId: 'login_device',
      verificationUrl: 'https://chatgpt.com/activate',
      userCode: 'OPEN-KIT',
    });
    expect(client.requests).toContainEqual({
      method: 'account/login/start',
      params: { type: 'chatgptDeviceCode' },
    });
  });

  it('maps completed Codex login notifications to logged-in status', async () => {
    const client = new FakeCodexAccountClient();
    const app = createOAuthApp(client);

    await app.request('/api/app/oauth/openai-codex/accounts/default/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'browser' }),
    });
    client.account = {
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    };
    client.emit({
      method: 'account/login/completed',
      params: { loginId: 'login_browser', success: true, error: null },
    });

    const res = await app.request('/api/app/oauth/openai-codex/accounts/default/status');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      providerId: 'openai_codex',
      status: 'logged_in',
      accountLabel: 'user@example.com',
      planType: 'plus',
    });
  });

  it('redacts failed login notification detail from status, lists, and account metadata', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-login-failure-'));
    const client = new FakeCodexAccountClient();
    const manager = new CodexOAuthAccountManager({
      clientFactory: async () => client,
      dataRoot,
    });
    const app = createApp({ codexOAuthAccountManager: manager });
    const canaries = [
      'Bearer oauth-notification-canary',
      'acct_notification_canary',
      '/private/oauth-notification-canary/auth.json',
    ];

    await app.request('/api/app/oauth/openai-codex/accounts/default/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'browser' }),
    });
    client.emit({
      method: 'account/login/completed',
      params: {
        loginId: 'login_browser',
        success: false,
        error: canaries.join(' '),
      },
    });

    const status = manager.getLastStatus('default');
    const listRes = await app.request('/api/app/oauth/openai-codex/accounts');
    const list = await listRes.json();
    const accountMetadata = JSON.parse(
      readFileSync(
        join(
          dataRoot,
          'server',
          'files',
          'oauth',
          'openai-codex',
          'accounts',
          'default',
          'account.json'
        ),
        'utf8'
      )
    );

    expect(listRes.status).toBe(200);
    expect(status).toMatchObject({
      status: 'error',
      mode: 'browser',
      message: 'Codex ChatGPT account operation failed.',
    });
    expect(list).toMatchObject({
      accounts: [
        {
          accountSlotId: 'default',
          status: 'error',
          mode: 'browser',
          message: 'Codex ChatGPT account operation failed.',
        },
      ],
    });
    expect(accountMetadata).toMatchObject({
      status: 'error',
      lastLoginMode: 'browser',
      lastError: 'Codex ChatGPT account operation failed.',
    });
    for (const projection of [status, list, accountMetadata]) {
      for (const canary of canaries) {
        expect(JSON.stringify(projection)).not.toContain(canary);
      }
    }
  });

  it('logs out without exposing token material', async () => {
    const client = new FakeCodexAccountClient();
    client.account = {
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    };
    const app = createOAuthApp(client);
    const res = await app.request('/api/app/oauth/openai-codex/accounts/default/logout', {
      method: 'POST',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      providerId: 'openai_codex',
      status: 'logged_out',
    });
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('redacts app-server errors from HTTP status, account lists, and account metadata', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-app-server-failure-'));
    const client = new FakeCodexAccountClient();
    const canaries = [
      'Bearer oauth-request-canary',
      'acct_request_canary',
      '/private/oauth-request-canary/auth.json',
    ];
    client.requestErrors.set('account/read', new Error(canaries.join(' ')));
    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        clientFactory: async () => client,
        dataRoot,
      }),
    });

    const res = await app.request('/api/app/oauth/openai-codex/accounts/default/status');
    const status = await res.json();
    const listRes = await app.request('/api/app/oauth/openai-codex/accounts');
    const list = await listRes.json();
    const accountMetadata = JSON.parse(
      readFileSync(
        join(
          dataRoot,
          'server',
          'files',
          'oauth',
          'openai-codex',
          'accounts',
          'default',
          'account.json'
        ),
        'utf8'
      )
    );

    expect(res.status).toBe(200);
    expect(listRes.status).toBe(200);
    expect(status).toMatchObject({
      providerId: 'openai_codex',
      status: 'unavailable',
      message: 'Codex app-server is unavailable.',
    });
    expect(list).toMatchObject({
      accounts: [
        {
          accountSlotId: 'default',
          status: 'unavailable',
          message: 'Codex app-server is unavailable.',
        },
      ],
    });
    expect(accountMetadata).toMatchObject({
      status: 'unavailable',
      lastError: 'Codex app-server is unavailable.',
    });
    for (const projection of [status, list, accountMetadata]) {
      for (const canary of canaries) {
        expect(JSON.stringify(projection)).not.toContain(canary);
      }
    }
  });

  it('lists, creates, renames, and deletes server-owned account slots', async () => {
    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        dataRoot: null,
        resolveDefaultAccountSlotId: () => 'default',
      }),
    });

    const createRes = await app.request('/api/app/oauth/openai-codex/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountSlotId: 'team_a', displayName: 'Team A' }),
    });

    expect(createRes.status).toBe(200);
    await expect(createRes.json()).resolves.toMatchObject({
      accountSlotId: 'team_a',
      displayName: 'Team A',
      status: 'logged_out',
    });

    const patchRes = await app.request('/api/app/oauth/openai-codex/accounts/team_a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Team Alpha' }),
    });

    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toMatchObject({
      accountSlotId: 'team_a',
      displayName: 'Team Alpha',
    });

    const listRes = await app.request('/api/app/oauth/openai-codex/accounts');

    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toMatchObject({
      accounts: [
        { accountSlotId: 'default', isDefault: true },
        { accountSlotId: 'team_a', displayName: 'Team Alpha', isDefault: false },
      ],
      defaultAccountSlotId: 'default',
    });

    const deleteRes = await app.request('/api/app/oauth/openai-codex/accounts/team_a', {
      method: 'DELETE',
    });

    expect(deleteRes.status).toBe(204);
  });

  it('returns a typed conflict when creating a duplicate account slot', async () => {
    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        dataRoot: null,
        resolveDefaultAccountSlotId: () => 'default',
      }),
    });

    await app.request('/api/app/oauth/openai-codex/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountSlotId: 'team_a', displayName: 'Team A' }),
    });
    const duplicateRes = await app.request('/api/app/oauth/openai-codex/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountSlotId: 'team_a', displayName: 'Team Again' }),
    });

    expect(duplicateRes.status).toBe(409);
    await expect(duplicateRes.json()).resolves.toMatchObject({
      code: 'codex_oauth_account_exists',
      message: 'Codex OAuth account slot already exists: team_a',
    });
  });

  it('mirrors the default account summary in diagnostics OAuth status', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-diagnostics-'));
    const accountRoot = join(
      dataRoot,
      'server',
      'files',
      'oauth',
      'openai-codex',
      'accounts',
      'default'
    );

    mkdirSync(accountRoot, { recursive: true });
    writeFileSync(
      join(accountRoot, 'account.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          accountSlotId: 'default',
          displayName: 'hi-codex',
          status: 'logged_in',
          accountLabel: 'user@example.com',
          planType: 'prolite',
          lastUpdatedAt: '2026-05-26T13:22:55.511Z',
        },
        null,
        2
      )}\n`
    );

    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        dataRoot,
        resolveDefaultAccountSlotId: () => 'default',
      }),
    });
    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();
    const defaultAccount = body.oauth.openaiCodexAccounts.accounts.find(
      (account: { accountSlotId: string }) => account.accountSlotId === 'default'
    );

    expect(res.status).toBe(200);
    expect(defaultAccount).toMatchObject({
      accountLabel: 'user@example.com',
      accountSlotId: 'default',
      displayName: 'hi-codex',
      isDefault: true,
      planType: 'prolite',
      status: 'logged_in',
    });
  });

  it('includes the default account row in fresh diagnostics', async () => {
    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        dataRoot: mkdtempSync(join(tmpdir(), 'openkit-codex-fresh-diagnostics-')),
        resolveDefaultAccountSlotId: () => 'default',
      }),
    });
    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();
    const defaultAccount = body.oauth.openaiCodexAccounts.accounts[0];

    expect(res.status).toBe(200);
    expect(defaultAccount).toMatchObject({
      accountSlotId: 'default',
      isDefault: true,
      status: 'logged_out',
    });
  });

  it('runs scoped OAuth routes independently from the default-slot routes', async () => {
    const clients = new Map<string, FakeCodexAccountClient>();
    const app = createApp({
      codexOAuthAccountManager: new CodexOAuthAccountManager({
        clientFactory: async ({ accountSlotId }) => {
          const client = new FakeCodexAccountClient();
          clients.set(accountSlotId, client);
          return client;
        },
        dataRoot: null,
        resolveDefaultAccountSlotId: () => 'default',
      }),
    });

    await app.request('/api/app/oauth/openai-codex/accounts/team_a/status');
    const scopedStart = await app.request('/api/app/oauth/openai-codex/accounts/team_a/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'device_code' }),
    });

    expect(scopedStart.status).toBe(200);
    await expect(scopedStart.json()).resolves.toMatchObject({
      accountSlotId: 'team_a',
      mode: 'device_code',
      status: 'pending',
    });
    expect(clients.get('team_a')?.requests).toContainEqual({
      method: 'account/login/start',
      params: { type: 'chatgptDeviceCode' },
    });

    const defaultSlotStatus = await app.request(
      '/api/app/oauth/openai-codex/accounts/default/status'
    );

    expect(defaultSlotStatus.status).toBe(200);
    await expect(defaultSlotStatus.json()).resolves.toMatchObject({
      accountSlotId: 'default',
      status: 'logged_out',
    });
  });
});
