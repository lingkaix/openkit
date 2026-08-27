import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { type CreateAppOptions, createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import {
  ProviderSubscriptionAccountManager,
  type ProviderSubscriptionAccountSnapshot,
} from './llm/provider-subscription-accounts.js';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

const ACCOUNT_STATUS: ProviderSubscriptionAccountSnapshot = {
  accountSlotId: 'default',
  createdAt: '2026-07-24T00:00:00.000Z',
  status: 'logged_out',
  subscriptionProviderId: 'xai',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const ADMIN_ROUTE_CASES = [
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/diagnostics' },
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/app/diagnostics' },
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/setup/diagnostics' },
  { code: 'runtime_config_admin_forbidden', method: 'POST', path: '/api/admin/config/reload' },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/files' },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'POST', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'PUT', path: '/api/admin/config/file' },
  { code: 'runtime_config_admin_forbidden', method: 'GET', path: '/api/admin/config/schemas' },
  { code: 'runtime_config_admin_forbidden', method: 'POST', path: '/api/admin/config/validate' },
  { code: 'forbidden', method: 'GET', path: '/api/app/provider-subscriptions' },
  { code: 'forbidden', method: 'GET', path: '/api/app/provider-subscriptions/xai/accounts' },
  { code: 'forbidden', method: 'POST', path: '/api/app/provider-subscriptions/xai/accounts' },
  {
    code: 'forbidden',
    method: 'PATCH',
    path: '/api/app/provider-subscriptions/xai/accounts/default',
  },
  {
    code: 'forbidden',
    method: 'DELETE',
    path: '/api/app/provider-subscriptions/xai/accounts/default',
  },
  {
    code: 'forbidden',
    method: 'GET',
    path: '/api/app/provider-subscriptions/xai/accounts/default/status',
  },
  {
    code: 'forbidden',
    method: 'POST',
    path: '/api/app/provider-subscriptions/xai/accounts/default/login',
  },
  {
    code: 'forbidden',
    method: 'POST',
    path: '/api/app/provider-subscriptions/xai/accounts/default/login/cancel',
  },
  {
    code: 'forbidden',
    method: 'POST',
    path: '/api/app/provider-subscriptions/xai/accounts/default/logout',
  },
  {
    code: 'forbidden',
    method: 'GET',
    path: '/api/app/provider-subscriptions/xai/accounts/default/quota',
  },
  { code: 'server_audit_admin_forbidden', method: 'GET', path: '/api/app/audit/events' },
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
 * Creates an observed provider-subscription manager without touching Vault or pi-ai.
 *
 * @param coreDb Open Core database for the manager boundary.
 * @returns Manager, observed public methods, and Vault access spy.
 */
function createObservedProviderSubscriptionManager(coreDb: CoreDb) {
  const vaultBackendAccess = vi.fn(() => {
    throw new Error('Vault backend access was not expected.');
  });
  const manager = new ProviderSubscriptionAccountManager({
    coreDb,
    vaultBackend: vaultBackendAccess,
  });
  const observed = [
    vi.spyOn(manager, 'listAccounts').mockResolvedValue([ACCOUNT_STATUS]),
    vi.spyOn(manager, 'createAccount').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'updateAccount').mockResolvedValue(ACCOUNT_STATUS),
    vi.spyOn(manager, 'deleteAccount').mockResolvedValue(undefined),
    vi.spyOn(manager, 'reconcileAccount').mockResolvedValue(ACCOUNT_STATUS),
    vi
      .spyOn(manager, 'getPairHandle')
      .mockRejectedValue(new Error('Provider I/O was not expected.')),
  ];

  return { manager, observed, vaultBackendAccess };
}

/**
 * Injects the same-release provider-subscription manager into app composition.
 *
 * @param input Ordinary app options.
 * @param manager Provider-subscription manager under observation.
 * @returns NanoCore app using the supplied manager.
 */
function createProviderSubscriptionApp(
  input: CreateAppOptions,
  manager: ProviderSubscriptionAccountManager
) {
  return createApp({ ...input, providerSubscriptionAccountManager: manager } as CreateAppOptions);
}

describe('deployment-admin routes', () => {
  it('denies authenticated non-admin actors before provider-subscription state or provider I/O', async () => {
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
    const { manager, observed, vaultBackendAccess } =
      createObservedProviderSubscriptionManager(coreDb);
    const app = createProviderSubscriptionApp(
      {
        auth: createSignedInAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      },
      manager
    );

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
          await expect(response.json()).resolves.toMatchObject({
            code: route.code,
            ...(route.code === 'forbidden'
              ? { message: 'Deployment-admin authority is required.' }
              : {}),
          });
        }
      }

      for (const method of observed) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(vaultBackendAccess).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows local actors and server-admin tokens to read provider-subscription surfaces', async () => {
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
    const { manager } = createObservedProviderSubscriptionManager(coreDb);
    const localApp = createProviderSubscriptionApp({ coreDb, dataRoot }, manager);
    const serverApp = createProviderSubscriptionApp(
      {
        auth: createSignedInAuth(),
        coreDb,
        dataRoot,
        mode: 'server',
      },
      manager
    );

    try {
      for (const app of [localApp, serverApp]) {
        const headers =
          app === serverApp ? { authorization: `Bearer ${serverAdmin.secret}` } : undefined;
        const responses = await Promise.all([
          app.request('/api/diagnostics', { headers }),
          app.request('/api/app/diagnostics', { headers }),
          app.request('/api/setup/diagnostics', { headers }),
          app.request('/api/admin/config/files', { headers }),
          app.request('/api/app/provider-subscriptions', { headers }),
          app.request('/api/app/provider-subscriptions/xai/accounts', { headers }),
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
