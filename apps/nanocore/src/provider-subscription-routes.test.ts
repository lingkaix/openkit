import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProviderSubscriptionAccountSchema,
  ProviderSubscriptionAccountsResponseSchema,
  ProviderSubscriptionQuotaSchema,
  ProviderSubscriptionsResponseSchema,
} from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderSubscriptionAccountError,
  ProviderSubscriptionAccountManager,
  type ProviderSubscriptionAccountPair,
  type ProviderSubscriptionAccountSnapshot,
} from './llm/provider-subscription-accounts.js';
import {
  APP_OPENAPI_ROUTE_METHODS,
  createAppOpenApiDocument,
  getRegisteredAppApiOperationIds,
} from './openapi.js';
import { ProviderRegistry } from './providers/registry.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { type CreateAppOptions, createApp } from './test-support/app.js';

const NOW = '2026-07-24T00:00:00.000Z';
const MAX_CODEX_QUOTA_BODY_BYTES = 65_536;
const CODEX_ACCESS_CANARY = 'codex-access-canary';
const CODEX_ACCOUNT_CANARY = 'codex-account-canary';
const CODEX_CREDENTIAL = {
  access: CODEX_ACCESS_CANARY,
  accountId: CODEX_ACCOUNT_CANARY,
  expires: 'ignored-expiry-shape',
  refresh: { ignored: true },
  scope: null,
  type: 'oauth',
} as const;
const CODEX_USAGE = {
  additional_rate_limits: [
    {
      limit_name: 'codex-other',
      metered_feature: 'codex_other',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          limit_window_seconds: 900,
          reset_after_seconds: 450,
          reset_at: Date.parse('2026-07-30T00:00:00.000Z') / 1_000,
          used_percent: 17,
        },
        secondary_window: null,
      },
    },
  ],
  credits: {
    balance: '17.25',
    has_credits: true,
    unlimited: false,
  },
  plan_type: 'pro',
  provider_private: 'raw-quota-canary',
  rate_limit_reached_type: {
    type: 'rate_limit_reached',
  },
  rate_limit: {
    allowed: true,
    limit_reached: false,
    provider_private: 'raw-rate-limit-canary',
    primary_window: {
      limit_window_seconds: 18_000,
      provider_private: 'raw-primary-canary',
      reset_after_seconds: 10_800,
      reset_at: Date.parse('2026-08-01T00:00:00.000Z') / 1_000,
      used_percent: 31,
    },
    secondary_window: {
      limit_window_seconds: 604_800,
      provider_private: 'raw-secondary-canary',
      reset_after_seconds: 604_800,
      reset_at: Date.parse('2026-08-08T00:00:00.000Z') / 1_000,
      used_percent: 100,
    },
  },
  spend_control: {
    individual_limit: null,
    reached: false,
  },
} as const;
const PRIMARY_QUOTA_WINDOW = {
  id: 'primary',
  remainingPercent: 69,
  resetsAt: '2026-08-01T00:00:00.000Z',
  usedPercent: 31,
} as const;
const SECONDARY_QUOTA_WINDOW = {
  id: 'secondary',
  remainingPercent: 0,
  resetsAt: '2026-08-08T00:00:00.000Z',
  usedPercent: 100,
} as const;
const OPERATION_ROUTES = [
  {
    method: 'GET',
    operationId: 'listSubscriptionProviders',
    path: '/api/app/provider-subscriptions',
  },
  {
    method: 'GET',
    operationId: 'listProviderSubscriptionAccounts',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts',
  },
  {
    method: 'POST',
    operationId: 'createProviderSubscriptionAccount',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts',
  },
  {
    method: 'PATCH',
    operationId: 'updateProviderSubscriptionAccount',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}',
  },
  {
    method: 'DELETE',
    operationId: 'deleteProviderSubscriptionAccount',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}',
  },
  {
    method: 'GET',
    operationId: 'getProviderSubscriptionAccountStatus',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/status',
  },
  {
    method: 'POST',
    operationId: 'startProviderSubscriptionAccountLogin',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login',
  },
  {
    method: 'POST',
    operationId: 'cancelProviderSubscriptionAccountLogin',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login/cancel',
  },
  {
    method: 'POST',
    operationId: 'logoutProviderSubscriptionAccount',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/logout',
  },
  {
    method: 'GET',
    operationId: 'getProviderSubscriptionAccountQuota',
    path: '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/quota',
  },
] as const;
const LEGACY_CODEX_OPERATION_IDS = [
  'listOpenAICodexOAuthAccounts',
  'createOpenAICodexOAuthAccount',
  'updateOpenAICodexOAuthAccount',
  'deleteOpenAICodexOAuthAccount',
  'getOpenAICodexOAuthAccountStatus',
  'startOpenAICodexOAuthAccountLogin',
  'cancelOpenAICodexOAuthAccountLogin',
  'logoutOpenAICodexOAuthAccount',
] as const;

/**
 * Adds one ignored field so valid JSON has an exact UTF-8 byte length.
 *
 * @param value Otherwise-valid quota response.
 * @param byteLength Required encoded body length.
 * @returns Valid JSON at the requested UTF-8 byte boundary.
 */
function jsonBodyAtUtf8ByteLength(
  value: Readonly<Record<string, unknown>>,
  byteLength: number
): string {
  const encoder = new TextEncoder();
  const emptyBody = JSON.stringify({ ...value, ignored_padding: '' });
  const remaining = byteLength - encoder.encode(emptyBody).byteLength;
  if (remaining < 0) {
    throw new Error('Quota fixture exceeds the requested UTF-8 byte length.');
  }
  const padding = `${'é'.repeat(Math.floor(remaining / 2))}${'x'.repeat(remaining % 2)}`;
  const body = JSON.stringify({ ...value, ignored_padding: padding });
  if (encoder.encode(body).byteLength !== byteLength) {
    throw new Error('Quota fixture did not reach the requested UTF-8 byte length.');
  }
  return body;
}

/**
 * Creates one sanitized manager snapshot.
 *
 * @param pair Provider-slot identity.
 * @param status Sanitized account state.
 * @returns Provider-neutral account snapshot.
 */
function snapshot(
  pair: ProviderSubscriptionAccountPair,
  status: ProviderSubscriptionAccountSnapshot['status'] = 'logged_out'
): ProviderSubscriptionAccountSnapshot {
  return {
    ...pair,
    createdAt: NOW,
    displayName: `${pair.subscriptionProviderId} ${pair.accountSlotId}`,
    status,
    updatedAt: NOW,
  };
}

/**
 * Creates one observed manager and deterministic app fixture.
 *
 * @returns Manager spies, app dependencies, and cleanup handle.
 */
function createFixture(providerRegistry = new ProviderRegistry([])) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-subscription-routes-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const vaultBackendAccess = vi.fn(() => {
    throw new Error('Vault backend access was not expected.');
  });
  const manager = new ProviderSubscriptionAccountManager({
    coreDb,
    vaultBackend: vaultBackendAccess,
  });
  const credentialRead = vi.fn(async () => CODEX_CREDENTIAL).mockName('credentialRead');
  const credentialModify = vi.fn().mockName('credentialModify');
  const credentialDelete = vi.fn().mockName('credentialDelete');
  const credentialList = vi.fn().mockName('credentialList');
  const modelsGetProvider = vi.fn().mockName('modelsGetProvider');
  const spies = {
    cancelLogin: vi
      .fn(async (pair: ProviderSubscriptionAccountPair, _interactionId: string) => snapshot(pair))
      .mockName('cancelLogin'),
    createAccount: vi
      .spyOn(manager, 'createAccount')
      .mockImplementation(async (input) => snapshot(input)),
    deleteAccount: vi
      .fn(
        async (_pair: ProviderSubscriptionAccountPair, _isBound: () => boolean): Promise<void> =>
          undefined
      )
      .mockName('deleteAccount'),
    getPairHandle: vi.spyOn(manager, 'getPairHandle').mockResolvedValue({
      credentials: {
        delete: credentialDelete,
        list: credentialList,
        modify: credentialModify,
        read: credentialRead,
      } as never,
      models: { getProvider: modelsGetProvider } as never,
    }),
    getStatus: vi
      .fn(async (pair: ProviderSubscriptionAccountPair) => snapshot(pair))
      .mockName('getStatus'),
    listAccounts: vi
      .spyOn(manager, 'listAccounts')
      .mockImplementation(async (subscriptionProviderId) => [
        snapshot({ accountSlotId: 'default', subscriptionProviderId }),
      ]),
    logout: vi
      .fn(async (pair: ProviderSubscriptionAccountPair) => snapshot(pair))
      .mockName('logout'),
    reconcileAccount: vi
      .spyOn(manager, 'reconcileAccount')
      .mockImplementation(async (pair) => snapshot(pair)),
    startLogin: vi
      .fn(async (pair: ProviderSubscriptionAccountPair) => ({
        ...snapshot(pair, 'pending'),
        interaction: {
          interactionId: 'interaction-test',
          mode: 'device_code' as const,
          userCode: 'OPEN-KIT',
          verificationUrl: 'https://login.example.test/device',
        },
      }))
      .mockName('startLogin'),
    updateAccount: vi
      .spyOn(manager, 'updateAccount')
      .mockImplementation(async (pair, input) => ({ ...snapshot(pair), ...input })),
    credentialDelete,
    credentialList,
    credentialModify,
    credentialRead,
    modelsGetProvider,
  };
  Object.assign(manager, {
    cancelLogin: spies.cancelLogin,
    deleteAccount: spies.deleteAccount,
    getStatus: spies.getStatus,
    logout: spies.logout,
    startLogin: spies.startLogin,
  });

  return {
    app: createApp({
      coreDb,
      dataRoot,
      providerRegistry,
      providerSubscriptionAccountManager: manager,
    } as CreateAppOptions),
    close: () => coreDb.sqlite.close(),
    coreDb,
    dataRoot,
    manager,
    spies,
    vaultBackendAccess,
  };
}

/**
 * Returns a JSON request initializer.
 *
 * @param method HTTP method.
 * @param body Optional JSON-compatible body.
 * @returns Request initializer with strict JSON headers when a body is present.
 */
function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  };
}

/**
 * Requires that no provider-subscription state or provider seam was touched.
 *
 * @param fixture Observed route fixture.
 */
function expectNoProviderStateIo(fixture: ReturnType<typeof createFixture>): void {
  for (const spy of Object.values(fixture.spies)) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(fixture.vaultBackendAccess).not.toHaveBeenCalled();
}

describe('provider-subscription app API', () => {
  it('registers the ten provider-neutral operations and returns fixed inventory without state I/O', async () => {
    const fixture = createFixture();

    try {
      const operationIds = new Set<string>(OPERATION_ROUTES.map(({ operationId }) => operationId));
      const legacyOperationIds = new Set<string>(LEGACY_CODEX_OPERATION_IDS);
      const document = createAppOpenApiDocument();
      const catalogOperations = Object.entries(document.paths).flatMap(([path, pathItem]) =>
        APP_OPENAPI_ROUTE_METHODS.flatMap((method) => {
          const operation = (pathItem as Readonly<Record<string, unknown>>)[method];
          const operationId =
            operation && typeof operation === 'object' && !Array.isArray(operation)
              ? (operation as Readonly<Record<string, unknown>>).operationId
              : null;
          return typeof operationId === 'string'
            ? [{ method: method.toUpperCase(), operationId, path }]
            : [];
        })
      );
      const providerCatalogOperations = catalogOperations.filter(
        ({ operationId, path }) =>
          operationIds.has(operationId) ||
          legacyOperationIds.has(operationId) ||
          path.startsWith('/api/app/provider-subscriptions') ||
          path.startsWith('/api/app/oauth/openai-codex')
      );
      const providerRuntimeRoutes = fixture.app.routes
        .filter(
          ({ path }) =>
            path.startsWith('/api/app/provider-subscriptions') ||
            path.startsWith('/api/app/oauth/openai-codex')
        )
        .map(({ method, path }) => ({ method, path }));
      const relevantRegisteredOperationIds = getRegisteredAppApiOperationIds(fixture.app).filter(
        (operationId) => operationIds.has(operationId) || legacyOperationIds.has(operationId)
      );
      const appSource = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');

      expect(providerCatalogOperations).toEqual(OPERATION_ROUTES);
      expect(providerRuntimeRoutes).toEqual(
        OPERATION_ROUTES.map(({ method, path }) => ({
          method,
          path: path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'),
        }))
      );
      expect(relevantRegisteredOperationIds).toEqual(
        OPERATION_ROUTES.map(({ operationId }) => operationId)
      );
      expect(appSource).not.toMatch(/\b(?:CodexOAuthAccountManager|codexOAuthAccountManager)\b/);

      const response = await fixture.app.request('/api/app/provider-subscriptions');
      const body = ProviderSubscriptionsResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body).toEqual({
        providers: [
          {
            displayName: 'OpenAI Codex',
            loginModes: ['device_code'],
            quotaCapability: 'available',
            subscriptionProviderId: 'openai-codex',
          },
          {
            displayName: 'xAI',
            loginModes: ['device_code'],
            quotaCapability: 'unsupported',
            subscriptionProviderId: 'xai',
          },
        ],
      });
      expectNoProviderStateIo(fixture);
    } finally {
      fixture.close();
    }
  });

  // biome-ignore format: Keep the table-driven provider matrix body vertically scannable.
  it.each(['openai-codex', 'xai'] as const)(
    'routes %s list, create, update, status, and delete through the exact provider-slot pair',
    async (subscriptionProviderId) => {
      const fixture = createFixture();
      const slot = subscriptionProviderId === 'openai-codex' ? 'codex_team' : 'xai_team';
      const basePath = `/api/app/provider-subscriptions/${subscriptionProviderId}/accounts`;

      try {
        const listResponse = await fixture.app.request(basePath);
        expect(listResponse.status).toBe(200);
        ProviderSubscriptionAccountsResponseSchema.parse(await listResponse.json());
        expect(fixture.spies.listAccounts).toHaveBeenLastCalledWith(subscriptionProviderId);

        const createResponse = await fixture.app.request(
          basePath,
          jsonRequest('POST', { accountSlotId: slot, displayName: 'Team' })
        );
        expect(createResponse.status).toBe(200);
        ProviderSubscriptionAccountSchema.parse(await createResponse.json());
        expect(fixture.spies.createAccount).toHaveBeenLastCalledWith({
          accountSlotId: slot,
          displayName: 'Team',
          subscriptionProviderId,
        });

        const updateResponse = await fixture.app.request(
          `${basePath}/${slot}`,
          jsonRequest('PATCH', { displayName: 'Team Updated' })
        );
        expect(updateResponse.status).toBe(200);
        ProviderSubscriptionAccountSchema.parse(await updateResponse.json());
        expect(fixture.spies.updateAccount).toHaveBeenLastCalledWith(
          { accountSlotId: slot, subscriptionProviderId },
          { displayName: 'Team Updated' }
        );

        const statusResponse = await fixture.app.request(`${basePath}/${slot}/status`);
        expect(statusResponse.status).toBe(200);
        ProviderSubscriptionAccountSchema.parse(await statusResponse.json());
        expect(fixture.spies.getStatus).toHaveBeenLastCalledWith({
          accountSlotId: slot,
          subscriptionProviderId,
        });
        expect(fixture.spies.reconcileAccount).not.toHaveBeenCalled();

        const deleteResponse = await fixture.app.request(`${basePath}/${slot}`, {
          method: 'DELETE',
        });
        expect(deleteResponse.status).toBe(204);
        expect(await deleteResponse.text()).toBe('');
        expect(deleteResponse.headers.get('content-type')).toBeNull();
        const deleteCall = fixture.spies.deleteAccount.mock.lastCall;
        expect(deleteCall?.[0]).toEqual({
          accountSlotId: slot,
          subscriptionProviderId,
        });
        expect(deleteCall?.[1]()).toBe(false);
      } finally {
        fixture.close();
      }
    }
  );

  it('rejects xAI account deletion through a live configured-profile binding predicate', async () => {
    const fixture = createFixture(
      new ProviderRegistry([
        {
          displayName: 'Bound xAI profile',
          extensions: {
            openkit: {
              subscriptionAccount: { accountSlotId: 'bound_slot' },
            },
          },
          id: 'xai-bound-private-profile',
          kind: 'oauth',
          models: ['xai/grok-4'],
          vendor: 'xai',
        },
      ])
    );
    fixture.spies.deleteAccount.mockImplementationOnce(async (pair, isBound) => {
      expect(pair).toEqual({
        accountSlotId: 'bound_slot',
        subscriptionProviderId: 'xai',
      });
      expect(isBound()).toBe(true);
      throw new ProviderSubscriptionAccountError(
        'provider_subscription_account_bound' as never,
        'Private configured provider binding.'
      );
    });

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/xai/accounts/bound_slot',
        { method: 'DELETE' }
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        code: 'provider_subscription_account_bound',
        message: 'Provider subscription account is bound to a provider profile.',
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(fixture.spies.deleteAccount).toHaveBeenCalledTimes(1);
    } finally {
      fixture.close();
    }
  });

  it('rejects invalid providers, slots, and strict bodies before account, Vault, or provider I/O', async () => {
    const fixture = createFixture();
    const cases = [
      {
        body: undefined,
        code: 'provider_subscription_provider_not_found',
        method: 'GET',
        path: '/api/app/provider-subscriptions/anthropic/accounts',
        status: 404,
      },
      {
        body: undefined,
        code: 'provider_subscription_account_slot_invalid',
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts/Bad%20Slot/status',
        status: 400,
      },
      {
        body: { accountSlotId: 'default', unexpected: true },
        code: 'invalid_request',
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts',
        status: 400,
      },
      {
        body: { displayName: 'Updated', unexpected: true },
        code: 'invalid_request',
        method: 'PATCH',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
        status: 400,
      },
      {
        body: {},
        code: 'invalid_request',
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login',
        status: 400,
      },
      {
        body: { mode: 'browser' },
        code: 'invalid_request',
        method: 'POST',
        path: '/api/app/provider-subscriptions/openai-codex/accounts/default/login',
        status: 400,
      },
      {
        body: { loginId: 'legacy-login-id' },
        code: 'invalid_request',
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login/cancel',
        status: 400,
      },
      {
        body: { unexpected: true },
        code: 'invalid_request',
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/logout',
        status: 400,
      },
    ] as const;

    try {
      for (const testCase of cases) {
        const response = await fixture.app.request(
          testCase.path,
          jsonRequest(testCase.method, testCase.body)
        );
        expect(response.status, `${testCase.method} ${testCase.path}`).toBe(testCase.status);
        await expect(response.json()).resolves.toMatchObject({
          code: testCase.code,
          message:
            testCase.code === 'provider_subscription_provider_not_found'
              ? 'Subscription provider not found.'
              : testCase.code === 'provider_subscription_account_slot_invalid'
                ? 'Account slot id is invalid.'
                : 'Invalid provider subscription request.',
        });
      }
      expectNoProviderStateIo(fixture);
    } finally {
      fixture.close();
    }
  });

  // biome-ignore format: Keep the table-driven interaction matrix body vertically scannable.
  it.each(['openai-codex', 'xai'] as const)(
    'projects delegated %s device-code login, cancellation, and local logout without private fields',
    async (subscriptionProviderId) => {
      const fixture = createFixture();
      const path = `/api/app/provider-subscriptions/${subscriptionProviderId}/accounts/default`;

      try {
        const startResponse = await fixture.app.request(
          `${path}/login`,
          jsonRequest('POST', { mode: 'device_code' })
        );
        const pending = ProviderSubscriptionAccountSchema.parse(await startResponse.json());

        expect(startResponse.status).toBe(200);
        expect(pending).toMatchObject({
          accountSlotId: 'default',
          interaction: {
            mode: 'device_code',
            userCode: 'OPEN-KIT',
            verificationUrl: 'https://login.example.test/device',
          },
          status: 'pending',
          subscriptionProviderId,
        });
        expect(fixture.spies.startLogin).toHaveBeenLastCalledWith({
          accountSlotId: 'default',
          subscriptionProviderId,
        });

        const interactionId =
          pending.status === 'pending' ? pending.interaction.interactionId : 'unreachable';
        const cancelResponse = await fixture.app.request(
          `${path}/login/cancel`,
          jsonRequest('POST', { interactionId })
        );
        const cancelled = ProviderSubscriptionAccountSchema.parse(await cancelResponse.json());
        expect(cancelResponse.status).toBe(200);
        expect(cancelled).toMatchObject({ status: 'logged_out', subscriptionProviderId });
        expect(fixture.spies.cancelLogin).toHaveBeenLastCalledWith(
          { accountSlotId: 'default', subscriptionProviderId },
          interactionId
        );

        const logoutResponse = await fixture.app.request(`${path}/logout`, { method: 'POST' });
        const loggedOut = ProviderSubscriptionAccountSchema.parse(await logoutResponse.json());
        expect(logoutResponse.status).toBe(200);
        expect(loggedOut).toMatchObject({ status: 'logged_out', subscriptionProviderId });
        expect(fixture.spies.logout).toHaveBeenLastCalledWith({
          accountSlotId: 'default',
          subscriptionProviderId,
        });
        expect(fixture.spies.getPairHandle).not.toHaveBeenCalled();
        expect(fixture.spies.reconcileAccount).not.toHaveBeenCalled();

        for (const body of [pending, cancelled, loggedOut]) {
          expect(JSON.stringify(body)).not.toMatch(
            /credential|vaultReference|authorization|cookie|refresh|access_token|rawProvider/i
          );
        }
      } finally {
        fixture.close();
      }
    }
  );

  it('maps manager failures to fixed route errors without exposing caught messages', async () => {
    const cases = [
      {
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_provider_not_found',
            'Bearer private provider failure'
          ),
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts',
        spy: 'listAccounts',
        status: 404,
        message: 'Subscription provider not found.',
      },
      {
        body: { accountSlotId: 'default' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_account_slot_invalid',
            'Bearer private slot failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts',
        spy: 'createAccount',
        status: 400,
        message: 'Account slot id is invalid.',
      },
      {
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_account_not_found',
            'Bearer private account failure'
          ),
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts/default/status',
        spy: 'getStatus',
        status: 404,
        message: 'Provider subscription account not found.',
      },
      {
        body: { accountSlotId: 'default' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_account_exists',
            'Bearer private duplicate failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts',
        spy: 'createAccount',
        status: 409,
        message: 'Provider subscription account already exists.',
      },
      {
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_account_bound' as never,
            'Bearer private binding failure'
          ),
        method: 'DELETE',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
        spy: 'deleteAccount',
        status: 409,
        message: 'Provider subscription account is bound to a provider profile.',
      },
      {
        body: { mode: 'device_code' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_login_active' as never,
            'Bearer private active-login failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login',
        spy: 'startLogin',
        status: 409,
        message: 'A login interaction is already active for this account.',
      },
      {
        body: { interactionId: 'missing-interaction' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_login_not_active' as never,
            'Bearer private inactive-login failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login/cancel',
        spy: 'cancelLogin',
        status: 409,
        message: 'No login interaction is active for this account.',
      },
      {
        body: { interactionId: 'different-interaction' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_login_interaction_mismatch' as never,
            'Bearer private interaction failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login/cancel',
        spy: 'cancelLogin',
        status: 409,
        message: 'Login interaction does not match the active interaction.',
      },
      {
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_vault_locked',
            'Bearer private locked failure'
          ),
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts/default/status',
        spy: 'getStatus',
        status: 503,
        message: 'Provider subscription Vault is locked.',
      },
      {
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_vault_unavailable',
            'Bearer private unavailable failure'
          ),
        method: 'DELETE',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
        spy: 'deleteAccount',
        status: 503,
        message: 'Provider subscription Vault is unavailable.',
      },
      {
        body: { mode: 'device_code' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_provider_unavailable' as never,
            'Bearer private provider availability failure'
          ),
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login',
        spy: 'startLogin',
        status: 503,
        message: 'Subscription provider is unavailable.',
      },
      {
        body: { displayName: 'Updated' },
        error: () =>
          new ProviderSubscriptionAccountError(
            'provider_subscription_projection_failed',
            'Bearer private projection failure'
          ),
        method: 'PATCH',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
        spy: 'updateAccount',
        status: 500,
        message: 'Provider subscription projection failed.',
      },
      {
        body: { displayName: 'Updated' },
        error: () => new Error('Bearer private unknown failure'),
        method: 'PATCH',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
        spy: 'updateAccount',
        status: 500,
        message: 'Provider subscription request failed.',
      },
    ] as const;

    const fixture = createFixture();
    try {
      for (const testCase of cases) {
        fixture.spies[testCase.spy].mockRejectedValueOnce(testCase.error() as never);
        const response = await fixture.app.request(
          testCase.path,
          jsonRequest(testCase.method, 'body' in testCase ? testCase.body : undefined)
        );
        const body = await response.json();

        expect(response.status, `${testCase.method} ${testCase.path}`).toBe(testCase.status);
        expect(body).toMatchObject({
          code:
            testCase.message === 'Provider subscription request failed.'
              ? 'internal_error'
              : testCase.error() instanceof ProviderSubscriptionAccountError
                ? (testCase.error() as ProviderSubscriptionAccountError).code
                : 'internal_error',
          message: testCase.message,
        });
        expect(JSON.stringify(body)).not.toContain('Bearer private');
      }
    } finally {
      fixture.close();
    }
  });

  it('gives whole-operation persistence failure precedence across all nine account operations', async () => {
    const fixture = createFixture();
    const persistence = new ProviderSubscriptionAccountError(
      'provider_subscription_persistence_failed',
      'Bearer private persistence detail'
    );
    const operations = [
      {
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts',
      },
      {
        body: { accountSlotId: 'default' },
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts',
      },
      {
        body: { displayName: 'Updated' },
        method: 'PATCH',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
      },
      {
        method: 'DELETE',
        path: '/api/app/provider-subscriptions/xai/accounts/default',
      },
      {
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts/default/status',
      },
      {
        body: { mode: 'device_code' },
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login',
      },
      {
        body: { interactionId: 'missing-interaction' },
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/login/cancel',
      },
      {
        method: 'POST',
        path: '/api/app/provider-subscriptions/xai/accounts/default/logout',
      },
      {
        method: 'GET',
        path: '/api/app/provider-subscriptions/xai/accounts/default/quota',
      },
    ] as const;

    try {
      for (const spy of Object.values(fixture.spies)) {
        spy.mockRejectedValue(persistence as never);
      }
      for (const operation of operations) {
        const response = await fixture.app.request(
          operation.path,
          jsonRequest(operation.method, 'body' in operation ? operation.body : undefined)
        );
        const body = await response.json();

        expect(response.status, `${operation.method} ${operation.path}`).toBe(500);
        expect(body).toMatchObject({
          code: 'provider_subscription_persistence_failed',
          message: 'Provider subscription persistence failed.',
        });
        expect(body).not.toHaveProperty('accounts');
        expect(body).not.toHaveProperty('availability');
        expect(JSON.stringify(body)).not.toContain('Bearer private');
      }
    } finally {
      fixture.close();
    }
  });

  it('keeps overlapping and post-completion backup-slot Codex quota reads independent', async () => {
    const fixture = createFixture();
    const backupPair = {
      accountSlotId: 'backup',
      subscriptionProviderId: 'openai-codex',
    } as const;
    const credentials = [
      {
        ...CODEX_CREDENTIAL,
        access: 'backup-access-one',
        accountId: 'backup-account-one',
      },
      {
        ...CODEX_CREDENTIAL,
        access: 'backup-access-two',
        accountId: 'backup-account-two',
      },
      {
        ...CODEX_CREDENTIAL,
        access: 'backup-access-three',
        accountId: 'backup-account-three',
      },
    ] as const;
    fixture.spies.credentialRead
      .mockResolvedValueOnce(credentials[0])
      .mockResolvedValueOnce(credentials[1])
      .mockResolvedValueOnce(credentials[2]);
    const fetchResolvers: Array<(response: Response) => void> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          fetchResolvers.push(resolve);
        })
    );

    try {
      const firstQuotaPromise = fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/backup/quota'
      );
      const secondQuotaPromise = fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/backup/quota'
      );

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalled();
      });
      expect(fixture.spies.reconcileAccount).toHaveBeenNthCalledWith(1, backupPair);
      expect(fixture.spies.getPairHandle).toHaveBeenNthCalledWith(1, backupPair);
      expect(fixture.spies.credentialRead).toHaveBeenNthCalledWith(1, 'openai-codex');
      const firstRequest = new Request(
        ...(fetchSpy.mock.calls[0] as ConstructorParameters<typeof Request>)
      );
      expect(firstRequest.method).toBe('GET');
      expect(firstRequest.url).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(Object.fromEntries(firstRequest.headers)).toEqual({
        authorization: `Bearer ${credentials[0].access}`,
        'chatgpt-account-id': credentials[0].accountId,
        'user-agent': 'codex-cli',
      });
      expect(firstRequest.body).toBeNull();
      fetchResolvers[0]?.(new Response(JSON.stringify(CODEX_USAGE)));
      const firstResponse = await firstQuotaPromise;
      expect(firstResponse.status).toBe(200);
      expect(ProviderSubscriptionQuotaSchema.parse(await firstResponse.json())).toEqual({
        ...backupPair,
        availability: 'available',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        planType: 'pro',
        windows: [PRIMARY_QUOTA_WINDOW, SECONDARY_QUOTA_WINDOW],
      });

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      });
      expect(fetchResolvers).toHaveLength(2);
      expect(fixture.spies.reconcileAccount.mock.calls).toEqual([[backupPair], [backupPair]]);
      expect(fixture.spies.getPairHandle.mock.calls).toEqual([[backupPair], [backupPair]]);
      expect(fixture.spies.credentialRead.mock.calls).toEqual([['openai-codex'], ['openai-codex']]);
      const secondRequest = new Request(
        ...(fetchSpy.mock.calls[1] as ConstructorParameters<typeof Request>)
      );
      expect(secondRequest.method).toBe('GET');
      expect(secondRequest.url).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(Object.fromEntries(secondRequest.headers)).toEqual({
        authorization: `Bearer ${credentials[1].access}`,
        'chatgpt-account-id': credentials[1].accountId,
        'user-agent': 'codex-cli',
      });
      expect(secondRequest.body).toBeNull();
      fetchResolvers[1]?.(new Response(JSON.stringify(CODEX_USAGE)));
      const secondResponse = await secondQuotaPromise;
      expect(secondResponse.status).toBe(200);
      expect(ProviderSubscriptionQuotaSchema.parse(await secondResponse.json())).toEqual({
        ...backupPair,
        availability: 'available',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        planType: 'pro',
        windows: [PRIMARY_QUOTA_WINDOW, SECONDARY_QUOTA_WINDOW],
      });

      const thirdQuotaPromise = fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/backup/quota'
      );
      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      });
      expect(fetchResolvers).toHaveLength(3);
      expect(fixture.spies.reconcileAccount.mock.calls).toEqual([
        [backupPair],
        [backupPair],
        [backupPair],
      ]);
      expect(fixture.spies.getPairHandle.mock.calls).toEqual([
        [backupPair],
        [backupPair],
        [backupPair],
      ]);
      expect(fixture.spies.credentialRead.mock.calls).toEqual([
        ['openai-codex'],
        ['openai-codex'],
        ['openai-codex'],
      ]);
      const thirdRequest = new Request(
        ...(fetchSpy.mock.calls[2] as ConstructorParameters<typeof Request>)
      );
      expect(thirdRequest.method).toBe('GET');
      expect(thirdRequest.url).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(Object.fromEntries(thirdRequest.headers)).toEqual({
        authorization: `Bearer ${credentials[2].access}`,
        'chatgpt-account-id': credentials[2].accountId,
        'user-agent': 'codex-cli',
      });
      expect(thirdRequest.body).toBeNull();

      fetchResolvers[2]?.(new Response(JSON.stringify(CODEX_USAGE)));
      const thirdResponse = await thirdQuotaPromise;
      expect(thirdResponse.status).toBe(200);
      expect(ProviderSubscriptionQuotaSchema.parse(await thirdResponse.json())).toEqual({
        ...backupPair,
        availability: 'available',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        planType: 'pro',
        windows: [PRIMARY_QUOTA_WINDOW, SECONDARY_QUOTA_WINDOW],
      });

      for (const spy of [
        fixture.spies.credentialDelete,
        fixture.spies.credentialList,
        fixture.spies.credentialModify,
        fixture.spies.modelsGetProvider,
        fixture.spies.cancelLogin,
        fixture.spies.createAccount,
        fixture.spies.deleteAccount,
        fixture.spies.getStatus,
        fixture.spies.listAccounts,
        fixture.spies.logout,
        fixture.spies.startLogin,
        fixture.spies.updateAccount,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it.each([
    {
      body: { plan_type: '   ' },
      name: 'whitespace-only plan type with absent rate limit',
      windows: [],
    },
    {
      body: { plan_type: 'pro', rate_limit: null },
      name: 'null rate limit',
      windows: [],
    },
    {
      body: {
        plan_type: 'pro',
        rate_limit: { allowed: true, limit_reached: false, secondary_window: null },
      },
      name: 'absent primary and null secondary windows',
      windows: [],
    },
    {
      body: {
        plan_type: 'pro',
        rate_limit: { allowed: true, limit_reached: false, primary_window: null },
      },
      name: 'null primary and absent secondary windows',
      windows: [],
    },
    {
      body: {
        plan_type: 'team-special',
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: {
            ...CODEX_USAGE.rate_limit.primary_window,
            limit_window_seconds: -1,
            reset_after_seconds: -2,
            reset_at: -1,
            used_percent: 0,
          },
          secondary_window: null,
        },
      },
      name: 'present primary and null secondary window',
      windows: [
        {
          id: 'primary',
          remainingPercent: 100,
          resetsAt: '1969-12-31T23:59:59.000Z',
          usedPercent: 0,
        },
      ],
    },
    {
      body: {
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: null,
          secondary_window: CODEX_USAGE.rate_limit.secondary_window,
        },
      },
      name: 'null primary and present secondary window',
      windows: [SECONDARY_QUOTA_WINDOW],
    },
  ])('projects Codex quota with $name', async ({ body, windows }) => {
    const fixture = createFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body)));

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toEqual({
        accountSlotId: 'default',
        availability: 'available',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        planType: body.plan_type,
        subscriptionProviderId: 'openai-codex',
        windows,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it('keeps xAI quota network- and credential-free after reconciliation', async () => {
    const fixture = createFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('xAI quota must not perform a network request.'));

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/xai/accounts/default/quota'
      );
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toEqual({
        accountSlotId: 'default',
        availability: 'unsupported',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        subscriptionProviderId: 'xai',
      });
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.reconcileAccount).toHaveBeenLastCalledWith({
        accountSlotId: 'default',
        subscriptionProviderId: 'xai',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fixture.spies.getPairHandle).not.toHaveBeenCalled();
      expect(fixture.spies.credentialRead).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it('accepts an otherwise-valid quota body at the exact UTF-8 byte limit', async () => {
    const fixture = createFixture();
    const body = jsonBodyAtUtf8ByteLength(CODEX_USAGE, MAX_CODEX_QUOTA_BODY_BYTES);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));

    try {
      expect(body.length).toBeLessThan(MAX_CODEX_QUOTA_BODY_BYTES);
      expect(new TextEncoder().encode(body)).toHaveLength(MAX_CODEX_QUOTA_BODY_BYTES);

      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toMatchObject({
        availability: 'available',
        windows: [PRIMARY_QUOTA_WINDOW, SECONDARY_QUOTA_WINDOW],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.getPairHandle).toHaveBeenCalledTimes(1);
      expect(fixture.spies.credentialRead).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it('stops pulling a streamed valid JSON body immediately after it crosses the byte limit', async () => {
    const fixture = createFixture();
    const bytes = new TextEncoder().encode(
      jsonBodyAtUtf8ByteLength(CODEX_USAGE, MAX_CODEX_QUOTA_BODY_BYTES + 1)
    );
    const pulls = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls();
          if (pulls.mock.calls.length === 1) {
            controller.enqueue(bytes.subarray(0, MAX_CODEX_QUOTA_BODY_BYTES));
            return;
          }
          if (pulls.mock.calls.length === 2) {
            controller.enqueue(bytes.subarray(MAX_CODEX_QUOTA_BODY_BYTES));
            return;
          }
          throw new Error('Bearer forbidden-extra-pull-canary');
        },
      },
      { highWaterMark: 0 }
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toEqual({
        accountSlotId: 'default',
        availability: 'temporarily_unavailable',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        subscriptionProviderId: 'openai-codex',
      });
      expect(pulls).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.getPairHandle).toHaveBeenCalledTimes(1);
      expect(fixture.spies.credentialRead).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(quota)).not.toContain('forbidden-extra-pull-canary');
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it.each([
    {
      credential: undefined,
      expectedFetches: 0,
      name: 'missing credential',
      upstream: async () => new Response('{}'),
    },
    {
      credential: Object.assign([], CODEX_CREDENTIAL),
      expectedFetches: 0,
      name: 'array credential',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, type: undefined },
      expectedFetches: 0,
      name: 'missing credential type',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, type: 'api_key' },
      expectedFetches: 0,
      name: 'wrong credential type',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, access: '' },
      expectedFetches: 0,
      name: 'missing access token',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, access: 7 },
      expectedFetches: 0,
      name: 'numeric access token',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, access: {} },
      expectedFetches: 0,
      name: 'object access token',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, accountId: '' },
      expectedFetches: 0,
      name: 'missing scoped account id',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, accountId: 7 },
      expectedFetches: 0,
      name: 'numeric scoped account id',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, accountId: {} },
      expectedFetches: 0,
      name: 'object scoped account id',
      upstream: async () => new Response('{}'),
    },
    {
      credential: { ...CODEX_CREDENTIAL, access: '   ', accountId: '\t ' },
      expectedFetches: 1,
      name: 'whitespace-only credential strings',
      upstream: async () =>
        new Response('Bearer whitespace-credential-canary', {
          status: 401,
        }),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'authentication failure',
      upstream: async () =>
        new Response('Bearer upstream-auth-canary', {
          headers: { 'retry-after': 'Bearer retry-canary' },
          status: 401,
        }),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'timeout',
      timeout: true,
      upstream: async (input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          new Request(input, init).signal.addEventListener(
            'abort',
            () => reject(new DOMException('Bearer timeout-canary', 'AbortError')),
            { once: true }
          );
        }),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'raw body timeout',
      timeout: true,
      upstream: () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  new ReadableStream({
                    pull: () => new Promise<void>(() => undefined),
                  })
                )
              ),
            9_999
          );
        }),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'invalid UTF-8',
      upstream: async () => {
        const marker = 'invalid-utf8-marker';
        const body = JSON.stringify({
          ...CODEX_USAGE,
          ignored_utf8: marker,
        });
        const markerIndex = body.indexOf(marker);
        return new Response(
          new Blob([
            body.slice(0, markerIndex),
            Uint8Array.of(0xc3, 0x28),
            body.slice(markerIndex + marker.length),
          ])
        );
      },
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'invalid JSON',
      upstream: async () => new Response('{"plan_type":'),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'rate-limit subtree mismatch',
      upstream: async () => new Response(JSON.stringify({ ...CODEX_USAGE, rate_limit: [] })),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'primary-window subtree mismatch',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, primary_window: [] },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'secondary-window subtree mismatch',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, secondary_window: [] },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'missing plan type',
      upstream: async () => new Response(JSON.stringify({ ...CODEX_USAGE, plan_type: undefined })),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'empty plan type',
      upstream: async () => new Response(JSON.stringify({ ...CODEX_USAGE, plan_type: '' })),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'plan-type mismatch',
      upstream: async () => new Response(JSON.stringify({ ...CODEX_USAGE, plan_type: 7 })),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'missing allowed',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, allowed: undefined },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'allowed mismatch',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, allowed: 'yes' },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'missing limit reached',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, limit_reached: undefined },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'limit-reached mismatch',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: { ...CODEX_USAGE.rate_limit, limit_reached: 0 },
          })
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'non-finite reset-after seconds',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: {
              ...CODEX_USAGE.rate_limit,
              secondary_window: {
                ...CODEX_USAGE.rate_limit.secondary_window,
                reset_after_seconds: 'non-finite-marker',
              },
            },
          }).replace('"non-finite-marker"', '1e309')
        ),
    },
    {
      credential: CODEX_CREDENTIAL,
      expectedFetches: 1,
      name: 'non-finite percentage',
      upstream: async () =>
        new Response(
          JSON.stringify({
            ...CODEX_USAGE,
            rate_limit: {
              ...CODEX_USAGE.rate_limit,
              secondary_window: {
                ...CODEX_USAGE.rate_limit.secondary_window,
                used_percent: 'non-finite-marker',
              },
            },
          }).replace('"non-finite-marker"', '1e309')
        ),
    },
    ...(['primary_window', 'secondary_window'] as const).flatMap((windowName) =>
      (
        ['used_percent', 'limit_window_seconds', 'reset_after_seconds', 'reset_at'] as const
      ).flatMap((fieldName) =>
        (['31', null, 1.5] as const).map((value) => ({
          credential: CODEX_CREDENTIAL,
          expectedFetches: 1,
          name: `${windowName} ${fieldName} invalid ${JSON.stringify(value)}`,
          upstream: async () =>
            new Response(
              JSON.stringify({
                ...CODEX_USAGE,
                rate_limit: {
                  ...CODEX_USAGE.rate_limit,
                  [windowName]: {
                    ...CODEX_USAGE.rate_limit[windowName],
                    [fieldName]: value,
                  },
                },
              })
            ),
        }))
      )
    ),
    ...(['primary_window', 'secondary_window'] as const).flatMap((windowName) =>
      ([-1, 101] as const).map((value) => ({
        credential: CODEX_CREDENTIAL,
        expectedFetches: 1,
        name: `${windowName} used_percent ${value}`,
        upstream: async () =>
          new Response(
            JSON.stringify({
              ...CODEX_USAGE,
              rate_limit: {
                ...CODEX_USAGE.rate_limit,
                [windowName]: {
                  ...CODEX_USAGE.rate_limit[windowName],
                  used_percent: value,
                },
              },
            })
          ),
      }))
    ),
    ...(['primary_window', 'secondary_window'] as const).flatMap((windowName) =>
      (['limit_window_seconds', 'reset_after_seconds', 'reset_at'] as const).flatMap((fieldName) =>
        ([2_147_483_648, -2_147_483_649] as const).map((value) => ({
          credential: CODEX_CREDENTIAL,
          expectedFetches: 1,
          name: `${windowName} ${fieldName} signed 32-bit ${value > 0 ? 'overflow' : 'underflow'}`,
          upstream: async () =>
            new Response(
              JSON.stringify({
                ...CODEX_USAGE,
                rate_limit: {
                  ...CODEX_USAGE.rate_limit,
                  [windowName]: {
                    ...CODEX_USAGE.rate_limit[windowName],
                    [fieldName]: value,
                  },
                },
              })
            ),
        }))
      )
    ),
    ...(['primary_window', 'secondary_window'] as const).flatMap((windowName) =>
      (['used_percent', 'limit_window_seconds', 'reset_after_seconds', 'reset_at'] as const).map(
        (fieldName) => ({
          credential: CODEX_CREDENTIAL,
          expectedFetches: 1,
          name: `missing ${windowName} ${fieldName}`,
          upstream: async () => {
            const body = structuredClone(CODEX_USAGE) as unknown as {
              rate_limit: Record<'primary_window' | 'secondary_window', Record<string, unknown>>;
            };
            delete body.rate_limit[windowName][fieldName];
            return new Response(JSON.stringify(body));
          },
        })
      )
    ),
  ])('redacts Codex quota $name as temporarily unavailable without mutation', async (testCase) => {
    const fixture = createFixture();
    fixture.spies.credentialRead.mockResolvedValue(testCase.credential as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(testCase.upstream);
    if ('timeout' in testCase) {
      vi.useFakeTimers();
    }

    try {
      const responsePromise = fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      if ('timeout' in testCase) {
        let settled = false;
        void responsePromise.finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const request = new Request(
          ...(fetchSpy.mock.calls[0] as ConstructorParameters<typeof Request>)
        );
        await vi.advanceTimersByTimeAsync(9_999);
        expect(request.signal.aborted).toBe(false);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(request.signal.aborted).toBe(true);
        expect(settled).toBe(true);
      }
      const response = await responsePromise;
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toEqual({
        accountSlotId: 'default',
        availability: 'temporarily_unavailable',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        subscriptionProviderId: 'openai-codex',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(testCase.expectedFetches);
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.getPairHandle).toHaveBeenCalledTimes(1);
      expect(fixture.spies.credentialRead).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(quota)).not.toMatch(
        /Bearer|canary|credential|accountId|access|authorization|cookie|raw|retryAfter/i
      );
      for (const spy of [
        fixture.spies.credentialDelete,
        fixture.spies.credentialList,
        fixture.spies.credentialModify,
        fixture.spies.modelsGetProvider,
        fixture.spies.cancelLogin,
        fixture.spies.createAccount,
        fixture.spies.deleteAccount,
        fixture.spies.getStatus,
        fixture.spies.listAccounts,
        fixture.spies.logout,
        fixture.spies.startLogin,
        fixture.spies.updateAccount,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it('redacts credential-read rejection as temporary quota unavailability', async () => {
    const fixture = createFixture();
    fixture.spies.credentialRead.mockRejectedValue(
      new Error('Bearer credential-read-error-canary')
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Provider fetch must not run after credential-read failure.'));

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      const quota = ProviderSubscriptionQuotaSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(quota).toEqual({
        accountSlotId: 'default',
        availability: 'temporarily_unavailable',
        observedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        subscriptionProviderId: 'openai-codex',
      });
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.getPairHandle).toHaveBeenCalledTimes(1);
      expect(fixture.spies.credentialRead).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fixture.spies.credentialModify).not.toHaveBeenCalled();
      expect(fixture.spies.credentialDelete).not.toHaveBeenCalled();
      expect(fixture.spies.credentialList).not.toHaveBeenCalled();
      expect(fixture.spies.modelsGetProvider).not.toHaveBeenCalled();
      expect(JSON.stringify(quota)).not.toMatch(/Bearer|credential-read-error-canary/i);
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });

  it.each([
    {
      code: 'provider_subscription_account_not_found',
      expectedGetPairHandleCalls: 0,
      failureAt: 'reconcile',
      message: 'Provider subscription account not found.',
      name: 'reconciliation account-not-found error',
      status: 404,
    },
    {
      code: 'provider_subscription_vault_locked',
      expectedGetPairHandleCalls: 1,
      failureAt: 'pairHandle',
      message: 'Provider subscription Vault is locked.',
      name: 'pair-handle Vault-locked error',
      status: 503,
    },
  ] as const)('preserves the fixed $name before quota fallback', async (testCase) => {
    const fixture = createFixture();
    const error = new ProviderSubscriptionAccountError(
      testCase.code,
      `Bearer ${testCase.failureAt}-error-canary`
    );
    if (testCase.failureAt === 'reconcile') {
      fixture.spies.reconcileAccount.mockRejectedValueOnce(error);
    } else {
      fixture.spies.getPairHandle.mockRejectedValueOnce(error);
    }
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('Provider fetch must not run after account precedence failure.')
      );

    try {
      const response = await fixture.app.request(
        '/api/app/provider-subscriptions/openai-codex/accounts/default/quota'
      );
      const body = await response.json();

      expect(response.status).toBe(testCase.status);
      expect(body).toEqual({
        code: testCase.code,
        message: testCase.message,
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(fixture.spies.reconcileAccount).toHaveBeenCalledTimes(1);
      expect(fixture.spies.getPairHandle).toHaveBeenCalledTimes(
        testCase.expectedGetPairHandleCalls
      );
      expect(fixture.spies.credentialRead).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fixture.spies.credentialModify).not.toHaveBeenCalled();
      expect(fixture.spies.credentialDelete).not.toHaveBeenCalled();
      expect(fixture.spies.credentialList).not.toHaveBeenCalled();
      expect(fixture.spies.modelsGetProvider).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toMatch(/Bearer|error-canary/i);
    } finally {
      fetchSpy.mockRestore();
      fixture.close();
    }
  });
});
