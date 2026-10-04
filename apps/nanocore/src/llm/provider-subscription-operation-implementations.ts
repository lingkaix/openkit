import type {
  PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
  ProviderSubscriptionAccount,
} from '@openkit/app-api-schemas';
import { ProviderSubscriptionsResponseSchema } from '@openkit/app-api-schemas';
import {
  ProviderSubscriptionAccountSlotIdSchema,
  type SubscriptionProviderId,
  SubscriptionProviderIdSchema,
} from '@openkit/config-schema/provider-subscription';
import type { FamilyImplementations } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { readCodexQuota } from './codex-quota.js';
import {
  ProviderSubscriptionAccountError,
  type ProviderSubscriptionAccountLifecycleSnapshot,
  type ProviderSubscriptionAccountManager,
  type ProviderSubscriptionAccountPair,
} from './provider-subscription-accounts.js';
import { readXaiAutoTopup, readXaiQuota } from './xai-quota.js';

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
      quotaCapability: 'available',
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
  provider_subscription_vault_locked: [503, 'Provider subscription Vault is locked.'],
  provider_subscription_vault_unavailable: [503, 'Provider subscription Vault is unavailable.'],
  provider_subscription_provider_unavailable: [503, 'Subscription provider is unavailable.'],
  provider_subscription_persistence_failed: [500, 'Provider subscription persistence failed.'],
  provider_subscription_projection_failed: [500, 'Provider subscription projection failed.'],
} as const;

/** Native account and quota dependencies; provider identity remains data in the exact pair. */
interface ProviderSubscriptionOperationServices {
  readonly accountManager: ProviderSubscriptionAccountManager | null;
  readonly boundProviderIds: (pair: ProviderSubscriptionAccountPair) => string[];
  readonly now?: () => string;
}

/** Joins generic account operations to the existing pair-scoped account and quota owners. */
export function createProviderSubscriptionOperationImplementations(
  services?: ProviderSubscriptionOperationServices
): FamilyImplementations<typeof PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS> {
  const now = services?.now ?? (() => new Date().toISOString());
  const manager = () => {
    if (!services?.accountManager)
      throw new Error('Provider subscription account manager is unavailable.');
    return services.accountManager;
  };
  const project = (account: ProviderSubscriptionAccountLifecycleSnapshot) =>
    projectAccount(account, services!.boundProviderIds);
  return {
    'provider-subscription.provider-list': () => PROVIDERS,
    'provider-subscription.account-list': (input) =>
      runAccountOperation(async () => ({
        accounts: (await manager().listAccounts(requireProvider(input.subscriptionProviderId))).map(
          project
        ),
      })),
    'provider-subscription.account-create': (input) =>
      runAccountOperation(async () =>
        project(
          await manager().createAccount({
            accountSlotId: input.accountSlotId,
            ...(input.displayName ? { displayName: input.displayName } : {}),
            subscriptionProviderId: requireProvider(input.subscriptionProviderId),
          })
        )
      ),
    'provider-subscription.account-update': (input) =>
      runAccountOperation(async () =>
        project(
          await manager().updateAccount(requirePair(input), { displayName: input.displayName })
        )
      ),
    'provider-subscription.account-delete': (input) =>
      runAccountOperation(async () => {
        await manager().deleteAccount(requirePair(input));
        return null;
      }),
    'provider-subscription.account-status': (input) =>
      runAccountOperation(async () => project(await manager().getStatus(requirePair(input)))),
    'provider-subscription.account-login-start': (input) =>
      runAccountOperation(async () => project(await manager().startLogin(requirePair(input)))),
    'provider-subscription.account-login-cancel': (input) =>
      runAccountOperation(async () =>
        project(await manager().cancelLogin(requirePair(input), input.interactionId))
      ),
    'provider-subscription.account-logout': (input) =>
      runAccountOperation(async () => project(await manager().logout(requirePair(input)))),
    'provider-subscription.account-quota': (input, context) =>
      runAccountOperation(async () => {
        const pair = requirePair(input);
        await manager().reconcileAccount(pair);
        const handle = await manager().getPairHandle(pair);
        const version = await handle.getCredentialVersion();
        const verifyVersion = async () =>
          version !== undefined && (await handle.getCredentialVersion()) === version;
        if (pair.subscriptionProviderId === 'xai') {
          const quota = await readXaiQuota(handle.models, now, verifyVersion);
          if (version !== undefined && quota && quota.availability !== 'authentication_required') {
            await handle.observeQuota(version, quota.availability, true, context.signal);
          }
          return {
            accountSlotId: pair.accountSlotId,
            observedAt: now(),
            subscriptionProviderId: pair.subscriptionProviderId,
            ...(quota ?? { availability: 'temporarily_unavailable' as const }),
          };
        }
        const quota = await readCodexQuota(handle.credentials, verifyVersion);
        if (version !== undefined && quota?.availability === 'available') {
          await handle.observeQuota(version, quota.availability, true, context.signal);
        }
        return {
          accountSlotId: pair.accountSlotId,
          observedAt: now(),
          ...(quota ?? { availability: 'temporarily_unavailable' as const }),
          subscriptionProviderId: pair.subscriptionProviderId,
        };
      }),
    'provider-subscription.account-auto-topup': (input) =>
      runAccountOperation(async () => {
        const pair = requirePair(input);
        if (pair.subscriptionProviderId !== 'xai')
          throw new OperationError(
            'invalid_request',
            'Invalid provider subscription request.',
            400
          );
        await manager().reconcileAccount(pair);
        const handle = await manager().getPairHandle(pair);
        const observation = await readXaiAutoTopup(handle.models);
        return {
          accountSlotId: pair.accountSlotId,
          observedAt: now(),
          subscriptionProviderId: 'xai' as const,
          ...(observation ?? { availability: 'temporarily_unavailable' as const }),
        };
      }),
  } satisfies FamilyImplementations<typeof PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS>;
}

/** Keeps unsupported provider selectors at the account owner's not-found boundary before any state I/O. */
function requireProvider(value: string): SubscriptionProviderId {
  const parsed = SubscriptionProviderIdSchema.safeParse(value);
  if (!parsed.success)
    throw new OperationError(
      'provider_subscription_provider_not_found',
      'Subscription provider not found.',
      404
    );
  return parsed.data;
}

/** Admits only an exact valid provider-slot pair before account, Vault or provider effects. */
function requirePair(input: {
  subscriptionProviderId: string;
  accountSlotId: string;
}): ProviderSubscriptionAccountPair {
  const provider = requireProvider(input.subscriptionProviderId);
  const slot = ProviderSubscriptionAccountSlotIdSchema.safeParse(input.accountSlotId);
  if (!slot.success)
    throw new OperationError(
      'provider_subscription_account_slot_invalid',
      'Account slot id is invalid.',
      400
    );
  return { accountSlotId: slot.data, subscriptionProviderId: provider };
}

/**
 * Adds only family-owned binding projections to a sanitized manager snapshot.
 *
 * @param account Sanitized manager snapshot.
 * @param boundProviderIds Resolver for configured profile bindings.
 * @returns Strict public provider-subscription account.
 */
function projectAccount(
  account: ProviderSubscriptionAccountLifecycleSnapshot,
  boundProviderIds: (pair: ProviderSubscriptionAccountPair) => string[]
): ProviderSubscriptionAccount {
  // The native snapshot type has a broad status; the engine validates the complete discriminated public result once.
  return {
    ...account,
    boundProviderIds: [...new Set(boundProviderIds(account))].sort(),
  } as ProviderSubscriptionAccount;
}

/** Preserves known account refusals with safe fixed text; unknown exceptions escape unchanged. */
async function runAccountOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const managerError =
      error instanceof ProviderSubscriptionAccountError
        ? error
        : error instanceof Error && error.cause instanceof ProviderSubscriptionAccountError
          ? error.cause
          : null;
    if (managerError) {
      const [status, message] = ERROR_RESPONSES[managerError.code];
      throw new OperationError(managerError.code, message, status, { cause: error });
    }
    throw error;
  }
}
