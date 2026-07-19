import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { CodexOAuthAccountManager } from './llm/codex-oauth-accounts.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

const ACCOUNT_STATUS = {
  accountSlotId: 'default',
  boundProviderIds: [],
  isDefault: true,
  providerId: 'openai_codex',
  status: 'logged_out',
} as const;

const ADMIN_ROUTE_CASES = [
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/diagnostics' },
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/app/diagnostics' },
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/setup/diagnostics' },
  {
    code: 'runtime_config_admin_forbidden',
    method: 'POST',
    path: '/api/admin/config/reload',
  },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/files' },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'POST', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'PUT', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/schemas' },
  { code: 'runtime_config_admin_forbidden', method: 'POST', path: '/api/admin/config/validate' },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'GET',
    path: '/api/app/oauth/openai-codex/accounts',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'POST',
    path: '/api/app/oauth/openai-codex/accounts',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'PATCH',
    path: '/api/app/oauth/openai-codex/accounts/default',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'DELETE',
    path: '/api/app/oauth/openai-codex/accounts/default',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'GET',
    path: '/api/app/oauth/openai-codex/accounts/default/status',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'POST',
    path: '/api/app/oauth/openai-codex/accounts/default/start',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'POST',
    path: '/api/app/oauth/openai-codex/accounts/default/cancel',
  },
  {
    code: 'codex_oauth_admin_forbidden',
    method: 'POST',
    path: '/api/app/oauth/openai-codex/accounts/default/logout',
  },
  {
    code: 'server_audit_admin_forbidden',
    method: 'GET',
    path: '/api/app/audit/events',
  },
  {
    code: 'server_permission_decisions_admin_forbidden',
    method: 'GET',
    path: '/api/app/permission-decisions',
  },
] as const;

/**
 * Creates a deterministic signed-in Better Auth facade.
 *
 * @returns Signed-in Better Auth test double.
 */
function createSignedInAuth(): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({
        session: { id: 'session_deployment_admin_test' },
        user: { id: 'user_session' },
      }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/**
 * Creates a Codex OAuth manager whose public methods can be observed without starting Codex.
 *
 * @returns Manager and its observed public methods.
 */
function createObservedCodexOAuthManager(): {
  manager: CodexOAuthAccountManager;
  observed: Array<ReturnType<typeof vi.spyOn>>;
} {
  const manager = new CodexOAuthAccountManager({ dataRoot: null });
  const observed = [
    vi
      .spyOn(manager, 'listAccounts')
      .mockResolvedValue({ accounts: [ACCOUNT_STATUS], defaultAccountSlotId: 'default' }),
    vi.spyOn(manager, 'createAccount').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'updateAccount').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'deleteAccount').mockResolvedValue(undefined),
    vi.spyOn(manager, 'getStatus').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'start').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'cancel').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'logout').mockResolvedValue(ACCOUNT_STATUS),
  ];

  return { manager, observed };
}

describe('deployment-admin routes', () => {
  it('rejects sessions and workspace-scoped tokens before route work begins', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deployment-admin-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, created_at, updated_at, kind)
         VALUES ('user_session', 'Session User', 'session@example.com', false, ?, ?, 'human')`
      )
      .run(Date.now(), Date.now());
    const workspace = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    const readonly = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
    });
    const { manager, observed } = createObservedCodexOAuthManager();
    const app = createApp({
      auth: createSignedInAuth(),
      codexOAuthAccountManager: manager,
      coreDb,
      dataRoot,
      mode: 'server',
    });

    try {
      for (const authorization of [
        undefined,
        `Bearer ${workspace.secret}`,
        `Bearer ${readonly.secret}`,
      ]) {
        for (const route of ADMIN_ROUTE_CASES) {
          const response = await app.request(route.path, {
            method: route.method,
            headers: {
              'content-type': 'application/json',
              ...(authorization ? { authorization } : {}),
            },
            body: route.method === 'GET' ? undefined : '{',
          });

          expect(response.status, `${route.method} ${route.path}`).toBe(403);
          if (!authorization || route.method === 'GET') {
            await expect(response.json()).resolves.toMatchObject({ code: route.code });
          }
        }
      }

      for (const method of observed) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows local actors and server-admin tokens to read each deployment-admin surface', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deployment-admin-allowed-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const { manager } = createObservedCodexOAuthManager();
    const localApp = createApp({ codexOAuthAccountManager: manager, coreDb, dataRoot });
    const serverApp = createApp({
      auth: createSignedInAuth(),
      codexOAuthAccountManager: manager,
      coreDb,
      dataRoot,
      mode: 'server',
    });

    try {
      for (const app of [localApp, serverApp]) {
        const headers =
          app === serverApp ? { authorization: `Bearer ${serverAdmin.secret}` } : undefined;
        const responses = await Promise.all([
          app.request('/api/diagnostics', { headers }),
          app.request('/api/app/diagnostics', { headers }),
          app.request('/api/setup/diagnostics', { headers }),
          app.request('/api/admin/config/files', { headers }),
          app.request('/api/app/oauth/openai-codex/accounts', { headers }),
          app.request('/api/app/audit/events', { headers }),
          app.request('/api/app/permission-decisions', { headers }),
        ]);

        for (const response of responses) {
          expect(response.status).toBe(200);
        }
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
