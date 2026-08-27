import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual, TextDecoder, toUSVString } from 'node:util';

import {
  type CredentialStore,
  createModels,
  type Models,
  type OAuthCredential,
  type ProviderAuthInteraction,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import {
  ProviderSubscriptionAccountSlotIdSchema,
  type SubscriptionProviderId,
  SubscriptionProviderIdSchema,
} from '@openkit/config-schema';

import { recordServerAuditEvent } from '../audit-events.js';
import type { CoreDb } from '../storage/db.js';
import {
  type VaultBackend,
  VaultBackendError,
  type VaultReferenceInventoryEntry,
} from '../vault/vault-backend.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  revokeVaultReference,
  type VaultReferenceRecord,
} from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';

/** Maximum accepted durable account record size in bytes. */
const MAX_ACCOUNT_RECORD_BYTES = 16_384;

/** Maximum accepted operator and provider label size in UTF-8 bytes. */
const MAX_LABEL_BYTES = 256;

/** Maximum accepted sanitized status message size in UTF-8 bytes. */
const MAX_MESSAGE_BYTES = 1_024;

/** Safe internal Vault reference identifier syntax. */
const VAULT_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Exact provider-subscription Core reference label. */
const VAULT_REFERENCE_DISPLAY_NAME = 'Provider subscription credential';

/** Exact provider-subscription Core secret kind. */
const VAULT_REFERENCE_SECRET_KIND = 'provider-subscription-oauth';

/** Durable account lifecycle states. */
type ProviderSubscriptionAccountStatus =
  | 'logged_out'
  | 'pending'
  | 'logged_in'
  | 'unavailable'
  | 'error';

/** Stable manager error codes used by the internal provider-subscription boundary. */
type ProviderSubscriptionAccountErrorCode =
  | 'provider_subscription_provider_not_found'
  | 'provider_subscription_account_slot_invalid'
  | 'provider_subscription_account_not_found'
  | 'provider_subscription_account_exists'
  | 'provider_subscription_account_bound'
  | 'provider_subscription_login_active'
  | 'provider_subscription_login_not_active'
  | 'provider_subscription_login_interaction_mismatch'
  | 'provider_subscription_provider_unavailable'
  | 'provider_subscription_vault_locked'
  | 'provider_subscription_vault_unavailable'
  | 'provider_subscription_persistence_failed'
  | 'provider_subscription_projection_failed';

/** Stable provider and account-slot identity. */
export interface ProviderSubscriptionAccountPair {
  /** Internally supported subscription provider. */
  readonly subscriptionProviderId: SubscriptionProviderId;
  /** Provider-scoped account slot identifier. */
  readonly accountSlotId: string;
}

/** Sanitized provider-subscription account projection. */
export interface ProviderSubscriptionAccountSnapshot extends ProviderSubscriptionAccountPair {
  /** Immutable account creation timestamp. */
  readonly createdAt: string;
  /** Monotonic latest account projection timestamp. */
  readonly updatedAt: string;
  /** Optional operator-supplied display name. */
  readonly displayName?: string;
  /** Optional safe provider-derived account label. */
  readonly accountLabel?: string;
  /** Optional safe provider-derived plan label. */
  readonly planLabel?: string;
  /** Sanitized current account state. */
  readonly status: ProviderSubscriptionAccountStatus;
  /** Stable redacted message for unavailable or error states. */
  readonly message?: string;
}

/** Sanitized process-local device-code login interaction. */
export interface ProviderSubscriptionLoginInteraction {
  /** OpenKit-owned process-local interaction identifier. */
  readonly interactionId: string;
  /** Only supported provider login mode. */
  readonly mode: 'device_code';
  /** Provider-owned device user code. */
  readonly userCode: string;
  /** Sanitized provider verification URL. */
  readonly verificationUrl: string;
  /** Optional provider-derived expiry timestamp. */
  readonly expiresAt?: string;
}

/** Durable account status plus optional manager-owned process-local interaction. */
export type ProviderSubscriptionAccountLifecycleSnapshot = ProviderSubscriptionAccountSnapshot & {
  /** Present only after the active login publishes its first device code. */
  readonly interaction?: ProviderSubscriptionLoginInteraction;
};

/** Pair-scoped stock pi-ai runtime and credential-store view. */
export interface ProviderSubscriptionPairHandle {
  /** Credential store constrained to this handle's provider-slot pair. */
  readonly credentials: CredentialStore;
  /** Provider-only stock pi-ai runtime using the constrained credential store. */
  readonly models: Models;
}

/** Constructor input for the provider-subscription account manager. */
interface ProviderSubscriptionAccountManagerInput {
  /** Open server Core database that identifies the owning data root. */
  readonly coreDb: CoreDb;
  /** Dynamic Vault backend getter resolved independently for every backend operation. */
  readonly vaultBackend: () => VaultBackend;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Optional deterministic fresh-reference factory. */
  readonly createReferenceId?: () => string;
}

/** Input accepted when creating one unbound account slot. */
interface CreateProviderSubscriptionAccountInput extends ProviderSubscriptionAccountPair {
  /** Optional operator-supplied display name. */
  readonly displayName?: string;
}

/** Input accepted when changing one account's operator label. */
interface UpdateProviderSubscriptionAccountInput {
  /** Replacement operator-supplied display name. */
  readonly displayName: string;
}

/** Exact strict version-1 durable account authority. */
interface ProviderSubscriptionAccountRecord extends ProviderSubscriptionAccountPair {
  /** Durable format discriminator. */
  readonly schemaVersion: 1;
  /** Immutable account creation timestamp. */
  readonly createdAt: string;
  /** Monotonic latest account projection timestamp. */
  readonly updatedAt: string;
  /** Optional operator-supplied display name. */
  readonly displayName?: string;
  /** Optional internal Vault reference binding. */
  readonly vaultReferenceId?: string;
  /** Optional safe provider-derived account label. */
  readonly accountLabel?: string;
  /** Optional safe provider-derived plan label. */
  readonly planLabel?: string;
  /** Sanitized lifecycle projection. */
  readonly status: ProviderSubscriptionAccountStatus;
  /** Required only for unavailable and error projections. */
  readonly message?: string;
}

/** Valid account authority classification. */
type PairInspection =
  | {
      /** Cleanly absent pair with only completed history. */
      readonly kind: 'absent';
    }
  | {
      /** Existing unbound account with only completed history. */
      readonly kind: 'unbound';
      /** Durable account authority. */
      readonly record: ProviderSubscriptionAccountRecord;
    }
  | {
      /** Existing account with one exact live credential. */
      readonly kind: 'live';
      /** Durable account authority. */
      readonly record: ProviderSubscriptionAccountRecord;
      /** Exact live backend inventory row. */
      readonly entry: VaultReferenceInventoryEntry;
      /** Exact active Core reference row. */
      readonly coreReference: VaultReferenceRecord;
    }
  | {
      /** Existing account in the exact already-started removal prefix. */
      readonly kind: 'current-tombstone';
      /** Durable account authority. */
      readonly record: ProviderSubscriptionAccountRecord;
      /** Exact backend-recognized current tombstone. */
      readonly entry: VaultReferenceInventoryEntry;
      /** Exact active-or-revoked Core reference row. */
      readonly coreReference: VaultReferenceRecord;
    };

/** Cached pair runtime generation used to invalidate released handles. */
interface PairHandleState {
  /** True while this manager generation still owns the handle. */
  active: boolean;
  /** Number of admitted credential removals that have not settled. */
  removalPending: number;
  /** Public pair-scoped handle. */
  handle: ProviderSubscriptionPairHandle;
  /** Exact active or settling process-local login. */
  login: PairLoginState | null;
  /** Fixed process-local terminal login failure. */
  loginError: string | null;
}

/** One process-local login owned by an existing cached pair handle. */
interface PairLoginState {
  /** Cancellation owner passed directly to the stock provider. */
  readonly controller: AbortController;
  /** OpenKit-owned interaction identifier. */
  readonly interactionId: string;
  /** First accepted device-code projection. */
  interaction: ProviderSubscriptionLoginInteraction | null;
  /** Rejects start when the provider terminates before publishing a device code. */
  readonly rejectAccepted: (error: ProviderSubscriptionAccountError) => void;
  /** Resolves start with the first accepted device-code projection. */
  readonly resolveAccepted: (snapshot: ProviderSubscriptionAccountLifecycleSnapshot) => void;
  /** True after cancellation or logout owns terminal settlement. */
  settling: boolean;
  /** Provider login, guarded credential persistence, and terminal projection task. */
  task: Promise<void>;
}

/** Internal wrapper that preserves a credential updater's exact rejection identity. */
class CredentialUpdaterFailure {
  /**
   * Wraps one updater rejection without exposing it to persistence or audit projections.
   *
   * @param error Exact updater rejection.
   */
  public constructor(public readonly error: unknown) {}
}

/** Exact lifecycle audit actions emitted by this manager. */
type LifecycleAuditAction =
  | 'provider_subscription.account.create'
  | 'provider_subscription.account.update'
  | 'provider_subscription.account.delete'
  | 'provider_subscription.credential.store'
  | 'provider_subscription.credential.rotate'
  | 'provider_subscription.credential.revoke'
  | 'provider_subscription.reconcile';

/** Exact redacted lifecycle summaries keyed by action and outcome. */
const LIFECYCLE_SUMMARIES: Record<
  LifecycleAuditAction,
  Readonly<Record<'succeeded' | 'failed', string>>
> = {
  'provider_subscription.account.create': {
    failed: 'Provider subscription account creation failed.',
    succeeded: 'Provider subscription account created.',
  },
  'provider_subscription.account.delete': {
    failed: 'Provider subscription account deletion failed.',
    succeeded: 'Provider subscription account deleted.',
  },
  'provider_subscription.account.update': {
    failed: 'Provider subscription account updating failed.',
    succeeded: 'Provider subscription account updated.',
  },
  'provider_subscription.credential.revoke': {
    failed: 'Provider subscription credential revocation failed.',
    succeeded: 'Provider subscription credential revoked.',
  },
  'provider_subscription.credential.rotate': {
    failed: 'Provider subscription credential rotating failed.',
    succeeded: 'Provider subscription credential rotated.',
  },
  'provider_subscription.credential.store': {
    failed: 'Provider subscription credential storing failed.',
    succeeded: 'Provider subscription credential stored.',
  },
  'provider_subscription.reconcile': {
    failed: 'Provider subscription account reconciliation failed.',
    succeeded: 'Provider subscription account reconciled.',
  },
};

/** Typed redacted provider-subscription manager failure. */
export class ProviderSubscriptionAccountError extends Error {
  /** Stable manager error code. */
  public readonly code: ProviderSubscriptionAccountErrorCode;

  /**
   * Creates one redacted manager failure.
   *
   * @param code Stable manager error code.
   * @param message Fixed non-secret error message.
   */
  public constructor(code: ProviderSubscriptionAccountErrorCode, message: string) {
    super(message);
    this.name = 'ProviderSubscriptionAccountError';
    this.code = code;
  }
}

/** Direct provider-subscription account, Vault credential, and pi-ai runtime owner. */
export class ProviderSubscriptionAccountManager {
  private readonly coreDb: CoreDb;

  private readonly vaultBackend: () => VaultBackend;

  private readonly now: () => string;

  private readonly createReferenceId: () => string;

  private readonly fences = new Map<string, Promise<void>>();

  private readonly handles = new Map<string, PairHandleState>();

  /**
   * Creates one manager over a Core database and dynamic Vault projection.
   *
   * @param input Core database, backend getter, and optional deterministic seams.
   */
  public constructor(input: ProviderSubscriptionAccountManagerInput) {
    this.coreDb = input.coreDb;
    this.vaultBackend = input.vaultBackend;
    this.now = input.now ?? (() => new Date().toISOString());
    this.createReferenceId = input.createReferenceId ?? randomUUID;
  }

  /**
   * Creates one strict unbound account slot.
   *
   * @param input Provider-slot identity and optional display name.
   * @returns Sanitized created account snapshot.
   * @throws ProviderSubscriptionAccountError when the pair is invalid, occupied, or inconsistent.
   */
  public async createAccount(
    input: CreateProviderSubscriptionAccountInput
  ): Promise<ProviderSubscriptionAccountSnapshot> {
    const pair = this.requirePair(input);

    return this.withLifecycleAudit('provider_subscription.account.create', pair, () =>
      this.withPairFence(pair, async () => {
        const inspection = this.inspectPair(pair);
        if (inspection.kind !== 'absent') {
          throw accountExistsError();
        }

        const timestamp = this.canonicalNow();
        const displayName = validateOptionalLabel(input.displayName);
        const record: ProviderSubscriptionAccountRecord = {
          accountSlotId: pair.accountSlotId,
          createdAt: timestamp,
          ...(displayName === undefined ? {} : { displayName }),
          schemaVersion: 1,
          status: 'logged_out',
          subscriptionProviderId: pair.subscriptionProviderId,
          updatedAt: timestamp,
        };

        this.writeAccount(record);
        return snapshot(record, 'logged_out');
      })
    );
  }

  /**
   * Updates only one account's operator-supplied display name.
   *
   * @param pair Provider-slot identity.
   * @param input Replacement display name.
   * @returns Sanitized updated account snapshot.
   * @throws ProviderSubscriptionAccountError when the pair is absent or inconsistent.
   */
  public async updateAccount(
    pair: ProviderSubscriptionAccountPair,
    input: UpdateProviderSubscriptionAccountInput
  ): Promise<ProviderSubscriptionAccountSnapshot> {
    const exactPair = this.requirePair(pair);

    return this.withLifecycleAudit('provider_subscription.account.update', exactPair, () =>
      this.withPairFence(exactPair, async () => {
        const inspection = this.requireExistingOrdinaryInspection(this.inspectPair(exactPair));
        const record = inspection.record;
        const updated: ProviderSubscriptionAccountRecord = {
          ...record,
          displayName: validateLabel(input.displayName, MAX_LABEL_BYTES),
          updatedAt: this.monotonicTimestamp(record.updatedAt),
        };

        this.writeAccount(updated);
        return snapshot(updated, inspection.kind === 'live' ? 'logged_in' : 'logged_out');
      })
    );
  }

  /**
   * Deletes one account after completing any exact credential-removal prefix.
   *
   * @param pair Provider-slot identity.
   * @param isBoundToProviderProfile Reads the live configured-profile binding predicate.
   * @returns Promise settled after account metadata is absent.
   * @throws ProviderSubscriptionAccountError when the pair is absent or inconsistent.
   */
  public async deleteAccount(
    pair: ProviderSubscriptionAccountPair,
    isBoundToProviderProfile: () => boolean
  ): Promise<void> {
    const exactPair = this.requirePair(pair);

    await this.withLifecycleAudit('provider_subscription.account.delete', exactPair, () =>
      this.withPairFence(exactPair, async () => {
        let inspection = this.inspectPair(exactPair, true);
        if (inspection.kind === 'absent') {
          throw accountNotFoundError();
        }
        if (this.handles.get(pairKey(exactPair))?.login) {
          throw loginActiveError();
        }
        if (isBoundToProviderProfile()) {
          throw new ProviderSubscriptionAccountError(
            'provider_subscription_account_bound',
            'Provider subscription account is bound to a provider profile.'
          );
        }
        if (inspection.kind === 'live' || inspection.kind === 'current-tombstone') {
          await this.removeCredential(exactPair, inspection, true);
          inspection = this.inspectPair(exactPair);
        }
        if (inspection.kind !== 'unbound') {
          throw persistenceError();
        }

        this.removeAccount(inspection.record);
        this.invalidateHandle(exactPair);
      })
    );
  }

  /**
   * Lists all valid accounts for one provider without resolving credential material.
   *
   * @param subscriptionProviderId Supported subscription provider.
   * @returns Account snapshots ordered by account slot id.
   * @throws ProviderSubscriptionAccountError when any provider pair is inconsistent.
   */
  public async listAccounts(
    subscriptionProviderId: SubscriptionProviderId
  ): Promise<ProviderSubscriptionAccountSnapshot[]> {
    try {
      const providerId = requireProvider(subscriptionProviderId);
      const inventory = this.listInventory();
      const records = this.readProviderRecords(providerId);
      const recordsBySlot = new Map(records.map((record) => [record.accountSlotId, record]));
      const slots = new Set(recordsBySlot.keys());

      for (const entry of inventory) {
        const pair = entry.providerSubscriptionAccount;
        if (!pair || pair.subscriptionProviderId !== providerId) {
          continue;
        }
        if (!ProviderSubscriptionAccountSlotIdSchema.safeParse(pair.accountSlotId).success) {
          throw persistenceError();
        }
        slots.add(pair.accountSlotId);
      }

      const accounts: ProviderSubscriptionAccountSnapshot[] = [];
      for (const accountSlotId of [...slots].sort()) {
        const pair = { accountSlotId, subscriptionProviderId: providerId };
        const inspection = this.classifyPair(
          pair,
          recordsBySlot.get(accountSlotId) ?? null,
          inventory
        );
        if (inspection.kind === 'unbound') {
          accounts.push(snapshot(inspection.record, 'logged_out'));
        } else if (inspection.kind === 'live') {
          accounts.push(snapshot(inspection.record, 'logged_in'));
        } else if (inspection.kind === 'current-tombstone') {
          throw persistenceError();
        }
      }

      return accounts;
    } catch (error) {
      throw normalizeAccountError(error);
    }
  }

  /**
   * Returns the cached provider-only pi-ai runtime for one valid account pair.
   *
   * @param pair Provider-slot identity.
   * @returns Pair-scoped credential store and stock Models runtime.
   * @throws ProviderSubscriptionAccountError when the account is absent or inconsistent.
   */
  public async getPairHandle(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionPairHandle> {
    const exactPair = this.requirePair(pair);

    return this.withPairFence(exactPair, async () => this.pairHandleInsideFence(exactPair))
      .then((state) => state.handle)
      .catch((error) => {
        throw normalizeAccountError(error);
      });
  }

  /**
   * Starts one stock-provider device-code login for an exact account pair.
   *
   * @param pair Provider-slot identity.
   * @returns Pending account snapshot after the first accepted device code.
   * @throws ProviderSubscriptionAccountError when the account, provider, or login is unavailable.
   */
  public async startLogin(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionAccountLifecycleSnapshot> {
    const exactPair = this.requirePair(pair);

    const admitted = await this.withPairFence(exactPair, async () => {
      const account = await this.reconcileAccountInsideFence(exactPair);
      const state = this.pairHandleInsideFence(exactPair);
      if (state.login) {
        throw loginActiveError();
      }
      const oauth = state.handle.models.getProvider(exactPair.subscriptionProviderId)?.auth.oauth;
      if (!oauth) {
        throw providerUnavailableError();
      }

      let resolveAccepted!: (snapshot: ProviderSubscriptionAccountLifecycleSnapshot) => void;
      let rejectAccepted!: (error: ProviderSubscriptionAccountError) => void;
      const accepted = new Promise<ProviderSubscriptionAccountLifecycleSnapshot>(
        (resolve, reject) => {
          resolveAccepted = resolve;
          rejectAccepted = reject;
        }
      );
      const login: PairLoginState = {
        controller: new AbortController(),
        interaction: null,
        interactionId: randomUUID(),
        rejectAccepted,
        resolveAccepted,
        settling: false,
        task: Promise.resolve(),
      };
      state.login = login;
      state.loginError = null;

      const interaction: ProviderAuthInteraction = {
        notify: (event) => {
          if (
            event.type !== 'device_code' ||
            state.login !== login ||
            login.settling ||
            login.interaction
          ) {
            return;
          }
          login.interaction = {
            interactionId: login.interactionId,
            mode: 'device_code',
            userCode: event.userCode,
            verificationUrl: event.verificationUri,
            ...(event.expiresInSeconds === undefined
              ? {}
              : {
                  expiresAt: new Date(
                    new Date(this.canonicalNow()).getTime() + event.expiresInSeconds * 1_000
                  ).toISOString(),
                }),
          };
          login.resolveAccepted({
            ...account,
            interaction: login.interaction,
            status: 'pending',
          });
        },
        prompt: async (prompt) => {
          if (prompt.type === 'select') {
            return 'device_code';
          }
          throw new Error('Unsupported provider login prompt.');
        },
        signal: login.controller.signal,
      };

      login.task = Promise.resolve()
        .then(() => oauth.login(interaction))
        .then(async (credential) => {
          if (!login.interaction) {
            await this.clearPreAcceptLogin(exactPair, state, login);
            return;
          }
          await state.handle.credentials.modify(exactPair.subscriptionProviderId, async () =>
            state.active && state.login === login && !login.settling ? credential : undefined
          );
          await this.withPairFence(exactPair, async () => {
            if (state.login === login && !login.settling) {
              state.login = null;
              state.loginError = null;
            }
          });
        })
        .catch(async () => {
          if (!login.interaction) {
            await this.clearPreAcceptLogin(exactPair, state, login);
            return;
          }
          await this.withPairFence(exactPair, async () => {
            if (state.login === login && !login.settling) {
              state.login = null;
              state.loginError = 'Provider subscription login failed.';
            }
          });
        });

      return { accepted };
    }).catch((error) => {
      throw normalizeAccountError(error);
    });

    return admitted.accepted.catch((error) => {
      throw normalizeAccountError(error);
    });
  }

  /**
   * Cancels and settles the exact active login interaction.
   *
   * @param pair Provider-slot identity.
   * @param interactionId Exact active process-local interaction identifier.
   * @returns Sanitized account status after provider settlement.
   * @throws ProviderSubscriptionAccountError when no matching interaction is active.
   */
  public async cancelLogin(
    pair: ProviderSubscriptionAccountPair,
    interactionId: string
  ): Promise<ProviderSubscriptionAccountLifecycleSnapshot> {
    const exactPair = this.requirePair(pair);
    const admitted = await this.withPairFence(exactPair, async () => {
      this.requireExistingOrdinaryInspection(this.inspectPair(exactPair));
      const state = this.pairHandleInsideFence(exactPair);
      const login = state.login;
      if (!login) {
        throw loginNotActiveError();
      }
      if (login.interactionId !== interactionId) {
        throw loginInteractionMismatchError();
      }
      login.settling = true;
      return { login, state };
    }).catch((error) => {
      throw normalizeAccountError(error);
    });

    admitted.login.controller.abort();
    await admitted.login.task;
    return this.withPairFence(exactPair, async () => {
      if (admitted.state.login === admitted.login) {
        admitted.state.login = null;
        admitted.state.loginError = null;
      }
      return this.reconcileAccountInsideFence(exactPair);
    }).catch((error) => {
      throw normalizeAccountError(error);
    });
  }

  /**
   * Returns durable account status plus manager-owned process-local login state.
   *
   * @param pair Provider-slot identity.
   * @returns Sanitized account and optional interaction snapshot.
   * @throws ProviderSubscriptionAccountError when the pair is absent or inconsistent.
   */
  public async getStatus(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionAccountLifecycleSnapshot> {
    const exactPair = this.requirePair(pair);

    return this.withLifecycleAudit('provider_subscription.reconcile', exactPair, () =>
      this.withPairFence(exactPair, async () => {
        const account = await this.reconcileAccountInsideFence(exactPair);
        const state = this.pairHandleInsideFence(exactPair);
        if (state.login?.interaction) {
          const { message: _message, ...pending } = account;
          return {
            ...pending,
            interaction: state.login.interaction,
            status: 'pending' as const,
          };
        }
        if (state.loginError) {
          return {
            ...account,
            message: state.loginError,
            status: 'error' as const,
          };
        }
        return account;
      })
    );
  }

  /**
   * Settles any active login and delegates credential revocation to stock Models logout.
   *
   * @param pair Provider-slot identity.
   * @returns Sanitized logged-out account status.
   * @throws ProviderSubscriptionAccountError when the pair is absent or logout fails.
   */
  public async logout(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionAccountLifecycleSnapshot> {
    const exactPair = this.requirePair(pair);
    const admitted = await this.withPairFence(exactPair, async () => {
      const inspection = this.inspectPair(exactPair, true);
      if (inspection.kind === 'absent') {
        throw accountNotFoundError();
      }
      const state = this.pairHandleInsideFence(exactPair);
      if (state.login) {
        state.login.settling = true;
      }
      return { login: state.login, state };
    }).catch((error) => {
      throw normalizeAccountError(error);
    });

    admitted.login?.controller.abort();
    if (admitted.login) {
      await admitted.login.task;
    }
    try {
      await admitted.state.handle.models.logout(exactPair.subscriptionProviderId);
    } catch (error) {
      throw normalizeAccountError(error);
    }
    return this.withPairFence(exactPair, async () => {
      if (admitted.state.login === admitted.login) {
        admitted.state.login = null;
      }
      admitted.state.loginError = null;
      return this.reconcileAccountInsideFence(exactPair);
    }).catch((error) => {
      throw normalizeAccountError(error);
    });
  }

  /**
   * Reconciles one account's permitted Core version and sanitized status projections.
   *
   * @param pair Provider-slot identity.
   * @returns Sanitized reconciled account snapshot.
   * @throws ProviderSubscriptionAccountError when the account is absent or inconsistent.
   */
  public async reconcileAccount(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionAccountSnapshot> {
    const exactPair = this.requirePair(pair);

    return this.withLifecycleAudit('provider_subscription.reconcile', exactPair, () =>
      this.withPairFence(exactPair, async () => this.reconcileAccountInsideFence(exactPair))
    );
  }

  /**
   * Reconciles every valid account after a whole-inventory failed-closed preflight.
   *
   * @returns Sanitized snapshots ordered by provider and slot.
   * @throws ProviderSubscriptionAccountError when any account authority is inconsistent.
   */
  public async reconcileAll(): Promise<ProviderSubscriptionAccountSnapshot[]> {
    const pairs: ProviderSubscriptionAccountPair[] = [];

    for (const providerId of SubscriptionProviderIdSchema.options) {
      const accounts = await this.listAccounts(providerId);
      pairs.push(
        ...accounts.map(({ accountSlotId, subscriptionProviderId }) => ({
          accountSlotId,
          subscriptionProviderId,
        }))
      );
    }

    const reconciled: ProviderSubscriptionAccountSnapshot[] = [];
    for (const pair of pairs) {
      reconciled.push(await this.reconcileAccount(pair));
    }
    return reconciled;
  }

  /**
   * Returns or creates the one pair handle while its mutation fence is held.
   *
   * @param pair Exact provider-slot identity.
   * @returns Existing active handle state.
   * @throws ProviderSubscriptionAccountError when the account is absent.
   */
  private pairHandleInsideFence(pair: ProviderSubscriptionAccountPair): PairHandleState {
    if (!this.readAccount(pair)) {
      throw accountNotFoundError();
    }
    const key = pairKey(pair);
    const cached = this.handles.get(key);
    if (cached?.active) {
      return cached;
    }

    const state = this.createPairHandle(pair);
    this.handles.set(key, state);
    return state;
  }

  /**
   * Clears one provider login that terminated before publishing a device code.
   *
   * @param pair Exact provider-slot identity.
   * @param state Existing pair handle state.
   * @param login Exact pre-accept login.
   */
  private async clearPreAcceptLogin(
    pair: ProviderSubscriptionAccountPair,
    state: PairHandleState,
    login: PairLoginState
  ): Promise<void> {
    await this.withPairFence(pair, async () => {
      if (state.login === login && !login.settling) {
        state.login = null;
      }
    });
    login.rejectAccepted(providerUnavailableError());
  }

  /**
   * Creates one cached handle state with a constrained store and no ambient auth.
   *
   * @param pair Provider-slot identity.
   * @returns Mutable internal handle state.
   */
  private createPairHandle(pair: ProviderSubscriptionAccountPair): PairHandleState {
    const state = {
      active: true,
      login: null,
      loginError: null,
      removalPending: 0,
    } as PairHandleState;
    const credentials: CredentialStore = {
      delete: (providerId) => {
        this.requireHandleProvider(state, pair, providerId);
        state.removalPending += 1;
        return this.withPairFence(pair, async () => {
          this.requireActiveHandle(state);
          const inspection = this.inspectPair(pair, true);
          if (inspection.kind === 'absent') {
            throw persistenceError();
          }
          if (inspection.kind === 'unbound') {
            return;
          }
          await this.withLifecycleAudit(
            'provider_subscription.credential.revoke',
            pair,
            async () => {
              this.readLiveCredentialForRemoval(inspection);
              await this.removeCredential(pair, inspection, false);
            }
          );
        })
          .catch((error) => {
            throw normalizeCredentialOperationError(error);
          })
          .finally(() => {
            state.removalPending -= 1;
          });
      },
      list: async () => {
        try {
          this.requireActiveHandle(state);
          const inspection = this.inspectPair(pair);
          const inventory = this.listInventory();
          for (const entry of inventory) {
            const candidate = entry.providerSubscriptionAccount;
            if (candidate && !samePair(candidate, pair)) {
              const candidateInspection = this.classifyPair(
                candidate,
                this.readAccount(candidate),
                inventory
              );
              if (candidateInspection.kind === 'current-tombstone') {
                throw persistenceError();
              }
            }
          }
          if (inspection.kind === 'absent') {
            throw persistenceError();
          }
          return inspection.kind === 'live'
            ? [{ providerId: pair.subscriptionProviderId, type: 'oauth' as const }]
            : [];
        } catch (error) {
          throw normalizeCredentialOperationError(error);
        }
      },
      modify: (providerId, update) => {
        this.requireHandleProvider(state, pair, providerId);
        const blockedByRemoval = state.removalPending > 0;
        return this.withPairFence(pair, async () => {
          this.requireActiveHandle(state);
          if (blockedByRemoval) {
            throw persistenceError();
          }

          const inspection = this.requireExistingOrdinaryInspection(this.inspectPair(pair));
          const current =
            inspection.kind === 'live'
              ? this.resolveCredential(inspection.entry.referenceId)
              : undefined;
          let replacement: Awaited<ReturnType<typeof update>>;
          try {
            replacement = await update(current);
          } catch (error) {
            throw new CredentialUpdaterFailure(error);
          }
          if (replacement === undefined) {
            return current;
          }
          const credential = requireOAuthCredential(replacement);

          if (inspection.kind === 'live') {
            return this.withLifecycleAudit(
              'provider_subscription.credential.rotate',
              pair,
              async () => {
                const entry = this.currentBackend().rotate({
                  material: serializeOAuthCredential(credential),
                  referenceId: inspection.entry.referenceId,
                });
                if (
                  entry.referenceId !== inspection.entry.referenceId ||
                  entry.currentVersion !== inspection.entry.currentVersion + 1 ||
                  entry.revoked ||
                  !samePair(entry.providerSubscriptionAccount, pair)
                ) {
                  throw persistenceError();
                }
                try {
                  this.advanceCoreVersion(inspection.coreReference, entry.currentVersion);
                  this.writeLoggedInProjection(inspection.record);
                } catch {
                  throw new ProviderSubscriptionAccountError(
                    'provider_subscription_projection_failed',
                    'Provider subscription projection failed.'
                  );
                }
                return credential;
              }
            );
          }

          return this.withLifecycleAudit(
            'provider_subscription.credential.store',
            pair,
            async () => {
              const referenceId = this.createReferenceId();
              if (!VAULT_REFERENCE_ID_PATTERN.test(referenceId)) {
                throw persistenceError();
              }

              const boundRecord: ProviderSubscriptionAccountRecord = {
                ...inspection.record,
                updatedAt: this.monotonicTimestamp(inspection.record.updatedAt),
                vaultReferenceId: referenceId,
              };
              this.writeAccount(boundRecord);
              const created = createVaultReferenceWithInsertEvidence(this.coreDb, {
                backendKind: 'encrypted-file',
                backendLocator: `encrypted-file://server/vault/${referenceId}`,
                displayName: VAULT_REFERENCE_DISPLAY_NAME,
                now: this.now,
                ownerScope: 'server',
                referenceId,
                secretKind: VAULT_REFERENCE_SECRET_KIND,
              });
              if (!created.inserted || !isExactCoreReference(created.reference, referenceId)) {
                throw persistenceError();
              }
              if (this.listInventory().some((candidate) => candidate.referenceId === referenceId)) {
                throw persistenceError();
              }

              const entry = this.currentBackend().store({
                material: serializeOAuthCredential(credential),
                metadata: {
                  ownerScope: 'server',
                  providerSubscriptionAccount: pair,
                },
                referenceId,
              });
              if (
                entry.referenceId !== referenceId ||
                entry.currentVersion !== 1 ||
                entry.revoked ||
                !samePair(entry.providerSubscriptionAccount, pair)
              ) {
                throw persistenceError();
              }
              try {
                this.writeLoggedInProjection(boundRecord);
              } catch {
                throw new ProviderSubscriptionAccountError(
                  'provider_subscription_projection_failed',
                  'Provider subscription projection failed.'
                );
              }
              return credential;
            }
          );
        }).catch((error) => {
          throw normalizeCredentialOperationError(error);
        });
      },
      read: (providerId) => {
        this.requireHandleProvider(state, pair, providerId);
        return this.withPairFence(pair, async () => {
          this.requireActiveHandle(state);
          const inspection = this.requireExistingOrdinaryInspection(this.inspectPair(pair));
          return inspection.kind === 'live'
            ? this.resolveCredential(inspection.entry.referenceId)
            : undefined;
        }).catch((error) => {
          throw normalizeCredentialOperationError(error);
        });
      },
    };
    const models = createModels({
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
      credentials,
    });

    models.setProvider(
      pair.subscriptionProviderId === 'openai-codex' ? openaiCodexProvider() : xaiProvider()
    );
    state.handle = { credentials, models };
    return state;
  }

  /**
   * Reconciles one account while its pair fence is held.
   *
   * @param pair Provider-slot identity.
   * @returns Sanitized reconciled snapshot.
   */
  private async reconcileAccountInsideFence(
    pair: ProviderSubscriptionAccountPair
  ): Promise<ProviderSubscriptionAccountSnapshot> {
    const inspection = this.requireExistingOrdinaryInspection(this.inspectPair(pair));
    if (inspection.kind === 'live') {
      this.advanceCoreVersion(inspection.coreReference, inspection.entry.currentVersion);
      const record = this.loggedInRecord(inspection.record);
      if (!isDeepStrictEqual(record, inspection.record)) {
        this.writeAccount(record);
      }
      return snapshot(record, 'logged_in');
    }

    const record = this.loggedOutRecord(inspection.record);
    if (!isDeepStrictEqual(record, inspection.record)) {
      this.writeAccount(record);
    }
    return snapshot(record, 'logged_out');
  }

  /**
   * Resolves and validates the latest credential before destructive removal.
   *
   * @param inspection Live or current-tombstone inspection.
   */
  private readLiveCredentialForRemoval(
    inspection: Extract<PairInspection, { kind: 'live' | 'current-tombstone' }>
  ): void {
    if (inspection.kind === 'live') {
      this.resolveCredential(inspection.entry.referenceId);
    }
  }

  /**
   * Completes backend, Core, and account credential removal in fixed order.
   *
   * @param pair Provider-slot identity.
   * @param inspection Live or current-tombstone inspection.
   * @param audit Whether this direct account delete should emit credential-revoke evidence.
   */
  private async removeCredential(
    pair: ProviderSubscriptionAccountPair,
    inspection: Extract<PairInspection, { kind: 'live' | 'current-tombstone' }>,
    audit: boolean
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      let coreReference = inspection.coreReference;
      if (inspection.kind === 'live') {
        coreReference = this.advanceCoreVersion(coreReference, inspection.entry.currentVersion);
        const tombstone = this.currentBackend().revoke({
          referenceId: inspection.entry.referenceId,
        });
        if (
          !tombstone.revoked ||
          tombstone.currentVersion !== inspection.entry.currentVersion ||
          !samePair(tombstone.providerSubscriptionAccount, pair)
        ) {
          throw persistenceError();
        }
      }
      if (coreReference.status === 'active') {
        coreReference = revokeVaultReference(this.coreDb, {
          now: this.now,
          referenceId: coreReference.referenceId,
        });
      }
      if (
        coreReference.status !== 'revoked' ||
        coreReference.currentVersion !== inspection.entry.currentVersion ||
        !isExactCoreReference(coreReference, inspection.entry.referenceId)
      ) {
        throw persistenceError();
      }

      this.writeAccount(this.loggedOutRecord(inspection.record));
    };

    if (audit) {
      await this.withLifecycleAudit('provider_subscription.credential.revoke', pair, operation);
    } else {
      await operation();
    }
  }

  /**
   * Reads, inventories, and classifies one exact provider-slot pair.
   *
   * @param pair Provider-slot identity.
   * @param allowCurrentTombstone Whether the caller may continue exact removal.
   * @returns Valid pair classification.
   */
  private inspectPair(
    pair: ProviderSubscriptionAccountPair,
    allowCurrentTombstone = false
  ): PairInspection {
    const inspection = this.classifyPair(pair, this.readAccount(pair), this.listInventory());
    if (inspection.kind === 'current-tombstone' && !allowCurrentTombstone) {
      throw persistenceError();
    }
    return inspection;
  }

  /**
   * Classifies one pair from strict account metadata and whole backend inventory.
   *
   * @param pair Provider-slot identity.
   * @param record Strict account record, or null when cleanly absent.
   * @param inventory Whole backend non-secret inventory.
   * @returns Valid pair classification.
   */
  private classifyPair(
    pair: ProviderSubscriptionAccountPair,
    record: ProviderSubscriptionAccountRecord | null,
    inventory: readonly VaultReferenceInventoryEntry[]
  ): PairInspection {
    const entries = inventory.filter((entry) => samePair(entry.providerSubscriptionAccount, pair));
    const live = entries.filter((entry) => !entry.revoked);
    const revoked = entries.filter((entry) => entry.revoked);

    if (!record) {
      if (live.length > 0) {
        throw persistenceError();
      }
      this.assertCompletedHistory(revoked);
      return { kind: 'absent' };
    }

    if (!record.vaultReferenceId) {
      if (live.length > 0) {
        throw persistenceError();
      }
      this.assertCompletedHistory(revoked);
      return { kind: 'unbound', record };
    }

    const currentLive = live.filter((entry) => entry.referenceId === record.vaultReferenceId);
    const currentRevoked = revoked.filter((entry) => entry.referenceId === record.vaultReferenceId);
    const history = revoked.filter((entry) => entry.referenceId !== record.vaultReferenceId);
    this.assertCompletedHistory(history);

    if (currentLive.length === 1 && live.length === 1 && currentRevoked.length === 0) {
      const entry = currentLive[0];
      if (!entry) {
        throw persistenceError();
      }
      const coreReference = this.requireExactCoreReference(entry.referenceId);
      if (
        coreReference.status !== 'active' ||
        coreReference.currentVersion < 1 ||
        coreReference.currentVersion > entry.currentVersion
      ) {
        throw persistenceError();
      }
      return { coreReference, entry, kind: 'live', record };
    }

    if (currentRevoked.length === 1 && live.length === 0 && revoked.length === history.length + 1) {
      const entry = currentRevoked[0];
      if (!entry) {
        throw persistenceError();
      }
      const coreReference = this.requireExactCoreReference(entry.referenceId);
      if (
        !['active', 'revoked'].includes(coreReference.status) ||
        coreReference.currentVersion !== entry.currentVersion
      ) {
        throw persistenceError();
      }
      return {
        coreReference,
        entry,
        kind: 'current-tombstone',
        record,
      };
    }

    throw persistenceError();
  }

  /**
   * Validates immutable completed-history rows against exact revoked Core state.
   *
   * @param entries Completed backend tombstone candidates.
   */
  private assertCompletedHistory(entries: readonly VaultReferenceInventoryEntry[]): void {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.referenceId)) {
        throw persistenceError();
      }
      ids.add(entry.referenceId);
      const coreReference = this.requireExactCoreReference(entry.referenceId);
      if (
        coreReference.status !== 'revoked' ||
        coreReference.currentVersion !== entry.currentVersion
      ) {
        throw persistenceError();
      }
    }
  }

  /**
   * Reads the exact Core reference and validates all provider-subscription fields.
   *
   * @param referenceId Internal Vault reference id.
   * @returns Exact Core reference row.
   */
  private requireExactCoreReference(referenceId: string): VaultReferenceRecord {
    const reference = getVaultReference(this.coreDb, referenceId);
    if (!reference || !isExactCoreReference(reference, referenceId)) {
      throw persistenceError();
    }
    return reference;
  }

  /**
   * Advances one exact active Core reference monotonically one version at a time.
   *
   * @param reference Initial exact Core reference row.
   * @param targetVersion Backend current material version.
   * @returns Exact active Core reference at the target version.
   */
  private advanceCoreVersion(
    reference: VaultReferenceRecord,
    targetVersion: number
  ): VaultReferenceRecord {
    let current = reference;
    while (current.currentVersion < targetVersion) {
      current = advanceActiveVaultReferenceVersion(this.coreDb, {
        currentVersion: current.currentVersion + 1,
        now: this.now,
        referenceId: current.referenceId,
      });
      if (!isExactCoreReference(current, reference.referenceId)) {
        throw persistenceError();
      }
    }
    if (current.currentVersion !== targetVersion || current.status !== 'active') {
      throw persistenceError();
    }
    return current;
  }

  /**
   * Resolves one credential through the existing audited provider Vault path.
   *
   * @param referenceId Bound internal Vault reference id.
   * @returns Complete validated OAuth credential.
   */
  private resolveCredential(referenceId: string): OAuthCredential {
    const backend = createVaultUseAuditedBackend({
      backend: this.currentBackend(),
      db: this.coreDb,
      now: this.now,
      ownerScope: 'server',
      resolvingPath: 'provider',
    });
    const material = backend.resolve({ referenceId });
    if (typeof material === 'string') {
      try {
        return requireOAuthCredential(JSON.parse(material));
      } catch {
        throw persistenceError();
      }
    }
    try {
      return requireOAuthCredential(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(material))
      );
    } catch {
      throw persistenceError();
    } finally {
      material.fill(0);
    }
  }

  /**
   * Lists backend inventory through the current dynamic backend.
   *
   * @returns Whole non-secret backend inventory.
   */
  private listInventory(): VaultReferenceInventoryEntry[] {
    return this.currentBackend().listReferences();
  }

  /**
   * Returns the current backend after verifying its supported concrete kind.
   *
   * @returns Current dynamic encrypted-file backend.
   */
  private currentBackend(): VaultBackend {
    const backend = this.vaultBackend();
    if (backend.kind !== 'encrypted-file') {
      throw persistenceError();
    }
    return backend;
  }

  /**
   * Reads every strict account record for one provider in slot order.
   *
   * @param providerId Supported subscription provider.
   * @returns Strict durable account records.
   */
  private readProviderRecords(
    providerId: SubscriptionProviderId
  ): ProviderSubscriptionAccountRecord[] {
    const accountsDirectory = this.accountsDirectory(providerId);
    this.assertSafeAncestors(accountsDirectory);
    const stat = lstatOrNull(accountsDirectory);
    if (!stat) {
      return [];
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw persistenceError();
    }

    return readdirSync(accountsDirectory)
      .sort()
      .map((accountSlotId) => {
        if (!ProviderSubscriptionAccountSlotIdSchema.safeParse(accountSlotId).success) {
          throw persistenceError();
        }
        const record = this.readAccount({
          accountSlotId,
          subscriptionProviderId: providerId,
        });
        if (!record) {
          throw persistenceError();
        }
        return record;
      });
  }

  /**
   * Reads one strict account record or returns null for clean absence.
   *
   * @param pair Provider-slot identity.
   * @returns Strict record or null when the exact account directory is absent.
   */
  private readAccount(
    pair: ProviderSubscriptionAccountPair
  ): ProviderSubscriptionAccountRecord | null {
    const directory = this.accountDirectory(pair);
    this.assertSafeAncestors(directory);
    const stat = lstatOrNull(directory);
    if (!stat) {
      return null;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw persistenceError();
    }
    return this.requireAccountRecord(pair);
  }

  /**
   * Reads and strictly parses one present account directory.
   *
   * @param pair Provider-slot identity encoded by the path.
   * @returns Strict version-1 account record.
   */
  private requireAccountRecord(
    pair: ProviderSubscriptionAccountPair
  ): ProviderSubscriptionAccountRecord {
    const directory = this.accountDirectory(pair);
    const names = readdirSync(directory).sort();
    if (names.length !== 1 || names[0] !== 'account.json') {
      throw persistenceError();
    }

    const path = join(directory, 'account.json');
    const stat = lstatOrNull(path);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_ACCOUNT_RECORD_BYTES) {
      throw persistenceError();
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_ACCOUNT_RECORD_BYTES) {
      throw persistenceError();
    }

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw persistenceError();
    }
    return parseAccountRecord(value, pair);
  }

  /**
   * Atomically replaces one strict account record through a same-directory temp file.
   *
   * @param record Strict durable account authority.
   */
  private writeAccount(record: ProviderSubscriptionAccountRecord): void {
    const pair = this.requirePair(record);
    const validated = parseAccountRecord(record, pair);
    const directory = this.accountDirectory(pair);
    this.ensureAccountDirectory(pair);
    const path = join(directory, 'account.json');
    const temporaryPath = join(directory, `.account.${randomUUID()}.tmp`);

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporaryPath, path);
    } catch {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
      throw persistenceError();
    }
  }

  /**
   * Removes one already validated account file and its now-empty exact directory.
   *
   * @param record Strict durable account authority.
   */
  private removeAccount(record: ProviderSubscriptionAccountRecord): void {
    const directory = this.accountDirectory(record);
    const names = readdirSync(directory).sort();
    if (names.length !== 1 || names[0] !== 'account.json') {
      throw persistenceError();
    }
    try {
      unlinkSync(join(directory, 'account.json'));
      rmdirSync(directory);
    } catch {
      throw persistenceError();
    }
  }

  /**
   * Ensures one account directory and every managed ancestor are real directories.
   *
   * @param pair Provider-slot identity.
   */
  private ensureAccountDirectory(pair: ProviderSubscriptionAccountPair): void {
    const root = join(this.coreDb.dataRoot, 'server', 'files', 'provider-subscriptions');
    const providerDirectory = join(root, pair.subscriptionProviderId);
    const managed = [
      root,
      providerDirectory,
      join(providerDirectory, 'accounts'),
      this.accountDirectory(pair),
    ];

    for (const directory of managed) {
      const stat = lstatOrNull(directory);
      if (!stat) {
        mkdirSync(directory);
      } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw persistenceError();
      }
    }
  }

  /**
   * Rejects a symbolic-link or non-directory component in any present managed ancestor.
   *
   * @param target Exact managed account or accounts directory.
   */
  private assertSafeAncestors(target: string): void {
    const relative = target.slice(this.coreDb.dataRoot.length + 1).split('/');
    let current = this.coreDb.dataRoot;
    for (const component of relative.slice(0, -1)) {
      current = join(current, component);
      const stat = lstatOrNull(current);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw persistenceError();
      }
    }
  }

  /**
   * Returns the exact managed accounts directory for one provider.
   *
   * @param providerId Supported subscription provider.
   * @returns Absolute accounts directory.
   */
  private accountsDirectory(providerId: SubscriptionProviderId): string {
    return join(
      this.coreDb.dataRoot,
      'server',
      'files',
      'provider-subscriptions',
      providerId,
      'accounts'
    );
  }

  /**
   * Returns the exact managed account directory for one pair.
   *
   * @param pair Provider-slot identity.
   * @returns Absolute account directory.
   */
  private accountDirectory(pair: ProviderSubscriptionAccountPair): string {
    return join(this.accountsDirectory(pair.subscriptionProviderId), pair.accountSlotId);
  }

  /**
   * Serializes one mutation behind the exact provider-slot fence.
   *
   * @param pair Provider-slot identity.
   * @param operation Work admitted to the pair fence.
   * @returns Operation result.
   */
  private withPairFence<T>(
    pair: ProviderSubscriptionAccountPair,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = pairKey(pair);
    const prior = this.fences.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.fences.set(key, tail);
    void tail.finally(() => {
      if (this.fences.get(key) === tail) {
        this.fences.delete(key);
      }
    });
    return result;
  }

  /**
   * Emits one exact lifecycle success or fixed redacted failure event.
   *
   * @param action Exact lifecycle action.
   * @param pair Provider-slot resource identity.
   * @param operation Lifecycle work.
   * @returns Lifecycle result.
   */
  private async withLifecycleAudit<T>(
    action: LifecycleAuditAction,
    pair: ProviderSubscriptionAccountPair,
    operation: () => Promise<T>
  ): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const normalized = normalizeAccountError(error);
      try {
        this.recordLifecycleAudit(action, pair, 'failed', normalized.code);
      } catch {
        throw persistenceError();
      }
      throw normalized;
    }
    try {
      this.recordLifecycleAudit(action, pair, 'succeeded', null);
    } catch {
      throw persistenceError();
    }
    return result;
  }

  /**
   * Stores one server-owned provider-subscription lifecycle audit event.
   *
   * @param action Exact lifecycle action.
   * @param pair Provider-slot resource identity.
   * @param outcome Stable event outcome.
   * @param errorCode Stable error code for failures.
   */
  private recordLifecycleAudit(
    action: LifecycleAuditAction,
    pair: ProviderSubscriptionAccountPair,
    outcome: 'succeeded' | 'failed',
    errorCode: ProviderSubscriptionAccountErrorCode | null
  ): void {
    const timestamp = new Date(this.canonicalNow());
    recordServerAuditEvent({
      action,
      category: 'system',
      coreDb: this.coreDb,
      errorCode,
      now: timestamp,
      occurredAt: timestamp,
      outcome,
      resource: `provider-subscription:${pair.subscriptionProviderId}:${pair.accountSlotId}`,
      severity: outcome === 'succeeded' ? 'info' : 'error',
      summary: LIFECYCLE_SUMMARIES[action][outcome],
    });
  }

  /**
   * Requires an existing ordinary unbound or live account classification.
   *
   * @param inspection Pair classification.
   * @returns Existing ordinary classification.
   */
  private requireExistingOrdinaryInspection(
    inspection: PairInspection
  ): Extract<PairInspection, { kind: 'unbound' | 'live' }> {
    if (inspection.kind === 'absent') {
      throw accountNotFoundError();
    }
    if (inspection.kind === 'current-tombstone') {
      throw persistenceError();
    }
    return inspection;
  }

  /**
   * Requires a handle to remain owned by this manager generation.
   *
   * @param state Cached handle state.
   */
  private requireActiveHandle(state: PairHandleState): void {
    if (!state.active) {
      throw persistenceError();
    }
  }

  /**
   * Rejects cross-provider handle access before any authority or backend I/O.
   *
   * @param state Cached handle state.
   * @param pair Handle-owned pair.
   * @param providerId Requested pi-ai provider id.
   */
  private requireHandleProvider(
    state: PairHandleState,
    pair: ProviderSubscriptionAccountPair,
    providerId: string
  ): void {
    this.requireActiveHandle(state);
    if (providerId !== pair.subscriptionProviderId) {
      throw providerNotFoundError();
    }
  }

  /**
   * Invalidates and removes one cached pair handle after account deletion.
   *
   * @param pair Deleted provider-slot pair.
   */
  private invalidateHandle(pair: ProviderSubscriptionAccountPair): void {
    const key = pairKey(pair);
    const state = this.handles.get(key);
    if (state) {
      state.active = false;
      this.handles.delete(key);
    }
  }

  /**
   * Validates and canonicalizes one externally supplied pair before storage access.
   *
   * @param pair Candidate provider-slot identity.
   * @returns Valid exact pair.
   */
  private requirePair(pair: ProviderSubscriptionAccountPair): ProviderSubscriptionAccountPair {
    return {
      accountSlotId: requireAccountSlotId(pair.accountSlotId),
      subscriptionProviderId: requireProvider(pair.subscriptionProviderId),
    };
  }

  /**
   * Returns a canonical deterministic timestamp from the manager clock.
   *
   * @returns Canonical UTC ISO timestamp.
   */
  private canonicalNow(): string {
    const value = this.now();
    if (!isCanonicalTimestamp(value)) {
      throw persistenceError();
    }
    return value;
  }

  /**
   * Preserves monotonic account timestamps when the injected clock regresses.
   *
   * @param previous Previous durable account timestamp.
   * @returns Previous or current canonical timestamp, whichever is later.
   */
  private monotonicTimestamp(previous: string): string {
    const current = this.canonicalNow();
    return current < previous ? previous : current;
  }

  /**
   * Builds a logged-in projection while preserving non-secret account fields.
   *
   * @param record Existing durable account record.
   * @returns Strict logged-in record.
   */
  private loggedInRecord(
    record: ProviderSubscriptionAccountRecord
  ): ProviderSubscriptionAccountRecord {
    const { message: _message, status: _status, updatedAt: _updatedAt, ...fields } = record;
    return {
      ...fields,
      status: 'logged_in',
      updatedAt: this.monotonicTimestamp(record.updatedAt),
    };
  }

  /**
   * Builds a logged-out projection with no binding or provider-derived labels.
   *
   * @param record Existing durable account record.
   * @returns Strict unbound logged-out record.
   */
  private loggedOutRecord(
    record: ProviderSubscriptionAccountRecord
  ): ProviderSubscriptionAccountRecord {
    const {
      accountLabel: _accountLabel,
      message: _message,
      planLabel: _planLabel,
      status: _status,
      updatedAt: _updatedAt,
      vaultReferenceId: _vaultReferenceId,
      ...fields
    } = record;
    return {
      ...fields,
      status: 'logged_out',
      updatedAt: this.monotonicTimestamp(record.updatedAt),
    };
  }

  /**
   * Persists logged-in status after one backend material commit.
   *
   * @param record Bound durable account record.
   */
  private writeLoggedInProjection(record: ProviderSubscriptionAccountRecord): void {
    this.writeAccount(this.loggedInRecord(record));
  }
}

/**
 * Parses one strict durable account record and binds it to its directory pair.
 *
 * @param value Unknown decoded JSON value.
 * @param pair Provider-slot identity encoded by the directory path.
 * @returns Strict version-1 durable record.
 */
function parseAccountRecord(
  value: unknown,
  pair: ProviderSubscriptionAccountPair
): ProviderSubscriptionAccountRecord {
  if (!isRecord(value)) {
    throw persistenceError();
  }

  const status = value.status;
  if (
    !['logged_out', 'pending', 'logged_in', 'unavailable', 'error'].includes(
      typeof status === 'string' ? status : ''
    )
  ) {
    throw persistenceError();
  }
  const requiresMessage = status === 'unavailable' || status === 'error';
  const allowed = [
    'accountLabel',
    'accountSlotId',
    'createdAt',
    'displayName',
    'planLabel',
    'schemaVersion',
    'status',
    'subscriptionProviderId',
    'updatedAt',
    'vaultReferenceId',
    ...(requiresMessage ? ['message'] : []),
  ];
  const required = [
    'accountSlotId',
    'createdAt',
    'schemaVersion',
    'status',
    'subscriptionProviderId',
    'updatedAt',
    ...(requiresMessage ? ['message'] : []),
  ];
  if (!hasOnlyKeys(value, allowed) || !required.every((key) => key in value)) {
    throw persistenceError();
  }
  if (
    value.schemaVersion !== 1 ||
    value.subscriptionProviderId !== pair.subscriptionProviderId ||
    value.accountSlotId !== pair.accountSlotId ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw persistenceError();
  }

  validateOptionalLabel(value.displayName);
  validateOptionalLabel(value.accountLabel);
  validateOptionalLabel(value.planLabel);
  if (
    value.vaultReferenceId !== undefined &&
    (typeof value.vaultReferenceId !== 'string' ||
      !VAULT_REFERENCE_ID_PATTERN.test(value.vaultReferenceId))
  ) {
    throw persistenceError();
  }
  if (
    requiresMessage &&
    (typeof value.message !== 'string' ||
      validateLabel(value.message, MAX_MESSAGE_BYTES) !== value.message)
  ) {
    throw persistenceError();
  }

  return value as unknown as ProviderSubscriptionAccountRecord;
}

/**
 * Builds a sanitized snapshot without the internal Vault binding.
 *
 * @param record Strict durable account record.
 * @param status Reconciled ordinary account state.
 * @returns Sanitized account snapshot.
 */
function snapshot(
  record: ProviderSubscriptionAccountRecord,
  status: 'logged_out' | 'logged_in'
): ProviderSubscriptionAccountSnapshot {
  return {
    accountSlotId: record.accountSlotId,
    ...(record.accountLabel === undefined ? {} : { accountLabel: record.accountLabel }),
    createdAt: record.createdAt,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.planLabel === undefined ? {} : { planLabel: record.planLabel }),
    status,
    subscriptionProviderId: record.subscriptionProviderId,
    updatedAt: record.updatedAt,
  };
}

/**
 * Validates one provider id without authority or filesystem access.
 *
 * @param providerId Candidate provider id.
 * @returns Supported provider id.
 */
function requireProvider(providerId: unknown): SubscriptionProviderId {
  const parsed = SubscriptionProviderIdSchema.safeParse(providerId);
  if (!parsed.success) {
    throw providerNotFoundError();
  }
  return parsed.data;
}

/**
 * Validates one account slot id without authority or filesystem access.
 *
 * @param accountSlotId Candidate slot id.
 * @returns Valid slot id.
 */
function requireAccountSlotId(accountSlotId: unknown): string {
  const parsed = ProviderSubscriptionAccountSlotIdSchema.safeParse(accountSlotId);
  if (!parsed.success) {
    throw accountSlotInvalidError();
  }
  return parsed.data;
}

/**
 * Validates one optional non-empty bounded Unicode label.
 *
 * @param value Candidate optional label.
 * @returns Valid label or undefined.
 */
function validateOptionalLabel(value: unknown): string | undefined {
  return value === undefined ? undefined : validateLabel(value, MAX_LABEL_BYTES);
}

/**
 * Validates one non-empty bounded well-formed Unicode string.
 *
 * @param value Candidate string.
 * @param maximumBytes Maximum accepted UTF-8 byte length.
 * @returns Valid string.
 */
function validateLabel(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    toUSVString(value) !== value ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw persistenceError();
  }
  return value;
}

/**
 * Checks one canonical UTC Date.toISOString timestamp.
 *
 * @param value Candidate timestamp.
 * @returns True only for the canonical ISO representation.
 */
function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value && value.endsWith('Z');
  } catch {
    return false;
  }
}

/**
 * Validates and preserves one complete OAuth credential.
 *
 * @param value Candidate credential.
 * @returns Complete OAuth credential.
 */
function requireOAuthCredential(value: unknown): OAuthCredential {
  if (
    !isRecord(value) ||
    value.type !== 'oauth' ||
    typeof value.access !== 'string' ||
    value.access.length === 0 ||
    typeof value.refresh !== 'string' ||
    value.refresh.length === 0 ||
    typeof value.expires !== 'number' ||
    !Number.isFinite(value.expires)
  ) {
    throw persistenceError();
  }
  return value as OAuthCredential;
}

/**
 * Serializes one validated OAuth credential for encrypted Vault storage.
 *
 * @param credential Complete OAuth credential.
 * @returns JSON credential material.
 */
function serializeOAuthCredential(credential: OAuthCredential): string {
  try {
    const material = JSON.stringify(credential);
    requireOAuthCredential(JSON.parse(material));
    return material;
  } catch {
    throw persistenceError();
  }
}

/**
 * Checks an exact provider-subscription Core reference projection.
 *
 * @param reference Core reference row.
 * @param referenceId Expected reference id.
 * @returns True when every provider-subscription field is exact.
 */
function isExactCoreReference(reference: VaultReferenceRecord, referenceId: string): boolean {
  return (
    reference.referenceId === referenceId &&
    reference.ownerScope === 'server' &&
    reference.workspaceId === null &&
    reference.userId === null &&
    reference.displayName === VAULT_REFERENCE_DISPLAY_NAME &&
    reference.secretKind === VAULT_REFERENCE_SECRET_KIND &&
    reference.backendKind === 'encrypted-file' &&
    reference.backendLocator === `encrypted-file://server/vault/${referenceId}`
  );
}

/**
 * Checks whether optional inventory pair metadata equals one exact pair.
 *
 * @param candidate Optional inventory pair metadata.
 * @param pair Expected provider-slot pair.
 * @returns True for an exact pair match.
 */
function samePair(
  candidate: VaultReferenceInventoryEntry['providerSubscriptionAccount'],
  pair: ProviderSubscriptionAccountPair
): boolean {
  return (
    candidate?.subscriptionProviderId === pair.subscriptionProviderId &&
    candidate.accountSlotId === pair.accountSlotId
  );
}

/**
 * Returns the in-process fence and cache key for one pair.
 *
 * @param pair Provider-slot identity.
 * @returns Collision-free pair key.
 */
function pairKey(pair: ProviderSubscriptionAccountPair): string {
  return `${pair.subscriptionProviderId}\0${pair.accountSlotId}`;
}

/**
 * Returns a filesystem stat or null for exact absence.
 *
 * @param path Exact path to inspect without following symbolic links.
 * @returns Path stat or null.
 */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw persistenceError();
  }
}

/**
 * Checks whether an unknown value is a plain JSON object candidate.
 *
 * @param value Candidate value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks exact object keys against one allowlist.
 *
 * @param value Object to inspect.
 * @param allowed Allowed property names.
 * @returns True when no unknown key exists.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Converts a caught dependency failure into a fixed redacted manager error.
 *
 * @param error Caught failure.
 * @returns Existing or mapped provider-subscription error.
 */
function normalizeAccountError(error: unknown): ProviderSubscriptionAccountError {
  if (error instanceof ProviderSubscriptionAccountError) {
    return error;
  }
  if (error instanceof Error && error.cause instanceof ProviderSubscriptionAccountError) {
    return error.cause;
  }
  if (error instanceof VaultBackendError) {
    if (error.code === 'vault-locked') {
      return vaultLockedError();
    }
    if (error.code === 'backend-unavailable') {
      return vaultUnavailableError();
    }
  }
  return persistenceError();
}

/**
 * Normalizes manager and Vault failures while preserving an updater's exact rejection.
 *
 * @param error Credential-store failure.
 * @returns Fixed manager failure, or the original updater rejection.
 */
function normalizeCredentialOperationError(error: unknown): unknown {
  return error instanceof CredentialUpdaterFailure ? error.error : normalizeAccountError(error);
}

/**
 * Creates the fixed unknown-provider failure.
 *
 * @returns Typed provider-not-found error.
 */
function providerNotFoundError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_provider_not_found',
    'Subscription provider not found.'
  );
}

/**
 * Creates the fixed invalid-slot failure.
 *
 * @returns Typed invalid-slot error.
 */
function accountSlotInvalidError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_account_slot_invalid',
    'Account slot id is invalid.'
  );
}

/**
 * Creates the fixed absent-account failure.
 *
 * @returns Typed account-not-found error.
 */
function accountNotFoundError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_account_not_found',
    'Provider subscription account not found.'
  );
}

/**
 * Creates the fixed duplicate-account failure.
 *
 * @returns Typed account-exists error.
 */
function accountExistsError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_account_exists',
    'Provider subscription account already exists.'
  );
}

/**
 * Creates the fixed active-login conflict.
 *
 * @returns Typed active-login error.
 */
function loginActiveError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_login_active',
    'A login interaction is already active for this account.'
  );
}

/**
 * Creates the fixed absent-login conflict.
 *
 * @returns Typed inactive-login error.
 */
function loginNotActiveError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_login_not_active',
    'No login interaction is active for this account.'
  );
}

/**
 * Creates the fixed interaction-mismatch conflict.
 *
 * @returns Typed interaction-mismatch error.
 */
function loginInteractionMismatchError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_login_interaction_mismatch',
    'Login interaction does not match the active interaction.'
  );
}

/**
 * Creates the fixed unavailable-provider failure.
 *
 * @returns Typed provider-unavailable error.
 */
function providerUnavailableError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_provider_unavailable',
    'Subscription provider is unavailable.'
  );
}

/**
 * Creates the fixed locked-Vault failure.
 *
 * @returns Typed locked-Vault error.
 */
function vaultLockedError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_vault_locked',
    'Provider subscription Vault is locked.'
  );
}

/**
 * Creates the fixed unavailable-Vault failure.
 *
 * @returns Typed unavailable-Vault error.
 */
function vaultUnavailableError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_vault_unavailable',
    'Provider subscription Vault is unavailable.'
  );
}

/**
 * Creates the fixed failed-closed persistence failure.
 *
 * @returns Typed persistence error.
 */
function persistenceError(): ProviderSubscriptionAccountError {
  return new ProviderSubscriptionAccountError(
    'provider_subscription_persistence_failed',
    'Provider subscription persistence failed.'
  );
}
