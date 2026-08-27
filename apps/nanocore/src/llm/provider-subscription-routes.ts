import {
  CancelProviderSubscriptionAccountLoginRequestSchema,
  CreateProviderSubscriptionAccountRequestSchema,
  type ProviderSubscriptionAccount,
  ProviderSubscriptionAccountSchema,
  ProviderSubscriptionAccountsResponseSchema,
  ProviderSubscriptionQuotaSchema,
  ProviderSubscriptionsResponseSchema,
  StartProviderSubscriptionAccountLoginRequestSchema,
  UpdateProviderSubscriptionAccountRequestSchema,
} from '@openkit/app-api-schemas';
import {
  ProviderSubscriptionAccountSlotIdSchema,
  type SubscriptionProviderId,
  SubscriptionProviderIdSchema,
} from '@openkit/config-schema';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
import { readCodexQuota } from './codex-quota.js';
import {
  ProviderSubscriptionAccountError,
  type ProviderSubscriptionAccountLifecycleSnapshot,
  type ProviderSubscriptionAccountManager,
  type ProviderSubscriptionAccountPair,
} from './provider-subscription-accounts.js';

const PROVIDERS = ProviderSubscriptionsResponseSchema.parse({
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

const ERROR_RESPONSES = {
  provider_subscription_provider_not_found: [404, 'Subscription provider not found.'],
  provider_subscription_account_slot_invalid: [400, 'Account slot id is invalid.'],
  provider_subscription_account_not_found: [404, 'Provider subscription account not found.'],
  provider_subscription_account_exists: [409, 'Provider subscription account already exists.'],
  provider_subscription_login_active: [
    409,
    'A login interaction is already active for this account.',
  ],
  provider_subscription_login_not_active: [409, 'No login interaction is active for this account.'],
  provider_subscription_login_interaction_mismatch: [
    409,
    'Login interaction does not match the active interaction.',
  ],
  provider_subscription_account_bound: [
    409,
    'Provider subscription account is bound to a provider profile.',
  ],
  provider_subscription_vault_locked: [503, 'Provider subscription Vault is locked.'],
  provider_subscription_vault_unavailable: [503, 'Provider subscription Vault is unavailable.'],
  provider_subscription_provider_unavailable: [503, 'Subscription provider is unavailable.'],
  provider_subscription_persistence_failed: [500, 'Provider subscription persistence failed.'],
  provider_subscription_projection_failed: [500, 'Provider subscription projection failed.'],
} as const;

/** Dependencies for the provider-subscription App API route family. */
export interface RegisterProviderSubscriptionRoutesInput {
  /** NanoCore Hono app receiving the ten exact routes. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Existing account, Vault, and pair-scoped pi-ai owner. */
  readonly accountManager: ProviderSubscriptionAccountManager | null;
  /** Resolves configured provider profiles bound to one account pair. */
  readonly boundProviderIds: (pair: ProviderSubscriptionAccountPair) => string[];
  /** Optional deterministic clock used by quota projections. */
  readonly now?: () => string;
}

/**
 * Requires deployment-admin authority for server-owned subscription accounts.
 *
 * @param c Hono context carrying the authenticated actor.
 * @returns Error response when the actor lacks deployment-admin authority.
 */
function requireProviderSubscriptionAdminActor(
  c: Context<{ Variables: AuthVariables }>
): Response | null {
  return isDeploymentAdminActor(c.get('actor'))
    ? null
    : asApiError('Deployment-admin authority is required.', 'forbidden', 403);
}

/**
 * Registers the ten exact provider-subscription App API routes.
 *
 * @param input Existing app, account manager, binding resolver, and optional clock.
 */
export function registerProviderSubscriptionRoutes(
  input: RegisterProviderSubscriptionRoutesInput
): void {
  const { accountManager, app, boundProviderIds } = input;
  const now = input.now ?? (() => new Date().toISOString());

  /** Returns the composed account owner or fails through the fixed internal error boundary. */
  function manager(): ProviderSubscriptionAccountManager {
    if (!accountManager) {
      throw new Error('Provider subscription account manager is unavailable.');
    }
    return accountManager;
  }

  registerAppApiRoute(app, 'listSubscriptionProviders', (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    return adminError ?? c.json(PROVIDERS);
  });

  registerAppApiRoute(app, 'listProviderSubscriptionAccounts', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const provider = requireProvider(c.req.param('subscriptionProviderId'));
    if (provider instanceof Response) {
      return provider;
    }
    return runAccountOperation(c, async () =>
      ProviderSubscriptionAccountsResponseSchema.parse({
        accounts: (await manager().listAccounts(provider)).map((account) =>
          projectAccount(account, boundProviderIds)
        ),
      })
    );
  });

  registerAppApiRoute(app, 'createProviderSubscriptionAccount', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const provider = requireProvider(c.req.param('subscriptionProviderId'));
    if (provider instanceof Response) {
      return provider;
    }
    const parsed = CreateProviderSubscriptionAccountRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return invalidRequest();
    }
    return runAccountOperation(c, async () =>
      projectAccount(
        await manager().createAccount({
          accountSlotId: parsed.data.accountSlotId,
          ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
          subscriptionProviderId: provider,
        }),
        boundProviderIds
      )
    );
  });

  registerAppApiRoute(app, 'updateProviderSubscriptionAccount', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    const parsed = UpdateProviderSubscriptionAccountRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return invalidRequest();
    }
    return runAccountOperation(c, async () =>
      projectAccount(await manager().updateAccount(pair, parsed.data), boundProviderIds)
    );
  });

  registerAppApiRoute(app, 'deleteProviderSubscriptionAccount', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    try {
      await manager().deleteAccount(pair, () => boundProviderIds(pair).length > 0);
      return c.body(null, 204);
    } catch (error) {
      return accountError(error);
    }
  });

  registerAppApiRoute(app, 'getProviderSubscriptionAccountStatus', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    return runAccountOperation(c, async () =>
      projectAccount(await manager().getStatus(pair), boundProviderIds)
    );
  });

  registerAppApiRoute(app, 'startProviderSubscriptionAccountLogin', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    const parsed = StartProviderSubscriptionAccountLoginRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return invalidRequest();
    }
    return runAccountOperation(c, async () =>
      projectAccount(await manager().startLogin(pair), boundProviderIds)
    );
  });

  registerAppApiRoute(app, 'cancelProviderSubscriptionAccountLogin', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    const parsed = CancelProviderSubscriptionAccountLoginRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return invalidRequest();
    }
    return runAccountOperation(c, async () =>
      projectAccount(await manager().cancelLogin(pair, parsed.data.interactionId), boundProviderIds)
    );
  });

  registerAppApiRoute(app, 'logoutProviderSubscriptionAccount', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    if ((await c.req.text()).length > 0) {
      return invalidRequest();
    }
    return runAccountOperation(c, async () =>
      projectAccount(await manager().logout(pair), boundProviderIds)
    );
  });

  registerAppApiRoute(app, 'getProviderSubscriptionAccountQuota', async (c) => {
    const adminError = requireProviderSubscriptionAdminActor(c);
    if (adminError) {
      return adminError;
    }
    const pair = requirePair(c);
    if (pair instanceof Response) {
      return pair;
    }
    return runAccountOperation(c, async () => {
      await manager().reconcileAccount(pair);
      if (pair.subscriptionProviderId === 'xai') {
        return ProviderSubscriptionQuotaSchema.parse({
          accountSlotId: pair.accountSlotId,
          availability: 'unsupported',
          observedAt: now(),
          subscriptionProviderId: pair.subscriptionProviderId,
        });
      }
      const handle = await manager().getPairHandle(pair);
      const quota = await readCodexQuota(handle.credentials);
      return ProviderSubscriptionQuotaSchema.parse({
        accountSlotId: pair.accountSlotId,
        availability: quota ? 'available' : 'temporarily_unavailable',
        observedAt: now(),
        ...(quota ?? {}),
        subscriptionProviderId: pair.subscriptionProviderId,
      });
    });
  });
}

/** Returns the fixed invalid-request response. */
function invalidRequest(): Response {
  return asApiError('Invalid provider subscription request.', 'invalid_request', 400);
}

/**
 * Validates one provider path segment without account or Vault I/O.
 *
 * @param value Raw provider path segment.
 * @returns Supported provider id or fixed error response.
 */
function requireProvider(value: string | undefined): SubscriptionProviderId | Response {
  const parsed = SubscriptionProviderIdSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : asApiError(
        'Subscription provider not found.',
        'provider_subscription_provider_not_found',
        404
      );
}

/**
 * Validates the exact provider-slot pair carried by one route context.
 *
 * @param c Provider-subscription route context.
 * @returns Valid pair or fixed provider/slot error response.
 */
function requirePair(
  c: Context<{ Variables: AuthVariables }>
): ProviderSubscriptionAccountPair | Response {
  const provider = requireProvider(c.req.param('subscriptionProviderId'));
  if (provider instanceof Response) {
    return provider;
  }
  const slot = ProviderSubscriptionAccountSlotIdSchema.safeParse(c.req.param('accountSlotId'));
  return slot.success
    ? { accountSlotId: slot.data, subscriptionProviderId: provider }
    : asApiError('Account slot id is invalid.', 'provider_subscription_account_slot_invalid', 400);
}

/**
 * Adds only route-owned binding projections to a sanitized manager snapshot.
 *
 * @param account Sanitized manager snapshot.
 * @param boundProviderIds Resolver for configured profile bindings.
 * @returns Strict public provider-subscription account.
 */
function projectAccount(
  account: ProviderSubscriptionAccountLifecycleSnapshot,
  boundProviderIds: (pair: ProviderSubscriptionAccountPair) => string[]
): ProviderSubscriptionAccount {
  return ProviderSubscriptionAccountSchema.parse({
    ...account,
    boundProviderIds: [...new Set(boundProviderIds(account))].sort(),
  });
}

/**
 * Runs one JSON account operation through the fixed sanitized error boundary.
 *
 * @param c Hono response context.
 * @param operation Account operation returning a strict response payload.
 * @returns JSON success or fixed error response.
 */
async function runAccountOperation(
  c: Context<{ Variables: AuthVariables }>,
  operation: () => Promise<unknown>
): Promise<Response> {
  try {
    return c.json(await operation());
  } catch (error) {
    return accountError(error);
  }
}

/**
 * Maps manager and unknown failures to fixed non-secret responses.
 *
 * @param error Caught operation failure.
 * @returns Fixed App API error response.
 */
function accountError(error: unknown): Response {
  const managerError =
    error instanceof ProviderSubscriptionAccountError
      ? error
      : error instanceof Error && error.cause instanceof ProviderSubscriptionAccountError
        ? error.cause
        : null;
  const code = managerError?.code;
  if (code && code in ERROR_RESPONSES) {
    const [status, message] = ERROR_RESPONSES[code as keyof typeof ERROR_RESPONSES];
    return asApiError(message, code, status);
  }
  return asApiError('Provider subscription request failed.', 'internal_error', 500);
}
