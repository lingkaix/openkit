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
import { operationRequest } from './test-support/operation-request.js';

const ACCOUNT_STATUS: ProviderSubscriptionAccountSnapshot = {
  accountSlotId: 'default',
  createdAt: '2026-07-24T00:00:00.000Z',
  status: 'logged_out',
  subscriptionProviderId: 'xai',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const ADMIN_ROUTE_CASES = [
  { code: 'diagnostics_admin_forbidden', method: 'GET', path: '/api/diagnostics' },
  {
    code: 'deployment_admin_required',
    method: 'POST',
    path: '/api/app/operations/diagnostics.app',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    method: 'POST',
    path: '/api/app/operations/diagnostics.setup',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.reload',
    method: 'POST',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.file-list',
    method: 'POST',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.file-read',
    method: 'POST',
    body: { id: 'server' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.file-create',
    method: 'POST',
    body: { id: 'server', kind: 'server', content: '{}' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.file-update',
    method: 'POST',
    body: { id: 'server', kind: 'server', content: '{}' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.schemas',
    method: 'POST',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/runtime.validate',
    method: 'POST',
    body: { files: [] },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.provider-list',
    method: 'POST',
    body: {},
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-list',
    method: 'POST',
    body: { ...{}, ...{ subscriptionProviderId: 'xai' } },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-create',
    method: 'POST',
    body: { subscriptionProviderId: 'xai', accountSlotId: 'default' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-update',
    method: 'POST',
    body: { subscriptionProviderId: 'xai', accountSlotId: 'default', displayName: 'Renamed' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-delete',
    method: 'POST',
    body: { ...{}, ...{ subscriptionProviderId: 'xai', accountSlotId: 'default' } },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-status',
    method: 'POST',
    body: { ...{}, ...{ subscriptionProviderId: 'xai', accountSlotId: 'default' } },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-login-start',
    method: 'POST',
    body: { subscriptionProviderId: 'xai', accountSlotId: 'default', mode: 'device_code' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-login-cancel',
    method: 'POST',
    body: { subscriptionProviderId: 'xai', accountSlotId: 'default', interactionId: 'interaction' },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-logout',
    method: 'POST',
    body: { ...{}, ...{ subscriptionProviderId: 'xai', accountSlotId: 'default' } },
  },
  {
    code: 'deployment_admin_required',
    path: '/api/app/operations/provider-subscription.account-quota',
    method: 'POST',
    body: { ...{}, ...{ subscriptionProviderId: 'xai', accountSlotId: 'default' } },
  },
  {
    code: 'deployment_admin_required',
    method: 'POST',
    path: '/api/app/operations/audit.server-list',
  },
  {
    code: 'deployment_admin_required',
    method: 'POST',
    path: '/api/app/operations/permission.server-list',
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
            body:
              route.method === 'GET'
                ? undefined
                : JSON.stringify('body' in route ? route.body : {}),
          });

          expect(response.status, `${route.method} ${route.path}`).toBe(403);
          await expect(response.json()).resolves.toMatchObject({
            code: route.code,
            ...(route.code === 'deployment_admin_required'
              ? { message: 'Current deployment administrator authority is required.' }
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
          app.request(...operationRequest('diagnostics.app', {}, { headers })),
          app.request(...operationRequest('diagnostics.setup', {}, { headers })),
          app.request(...operationRequest('runtime.file-list', {}, { headers })),
          app.request(...operationRequest('provider-subscription.provider-list', {}, { headers })),
          app.request(
            ...operationRequest(
              'provider-subscription.account-list',
              { subscriptionProviderId: 'xai' },
              { headers }
            )
          ),
          app.request(...operationRequest('audit.server-list', {}, { headers })),
          app.request(...operationRequest('permission.server-list', {}, { headers })),
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
