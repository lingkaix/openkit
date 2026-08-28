// openkit-test-platform: posix
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthInteraction, OAuthCredential } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreDb } from '../storage/db.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { type VaultBackend, VaultBackendError } from '../vault/vault-backend.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  revokeVaultReference,
} from '../vault/vault-references.js';
import type { VaultUnlockState } from '../vault/vault-unlock-state.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import { createVaultInjectionReceipt } from '../vault-injection-receipts.js';
import {
  ProviderSubscriptionAccountError,
  ProviderSubscriptionAccountManager,
  type ProviderSubscriptionAccountPair,
  type ProviderSubscriptionAccountSnapshot,
  type ProviderSubscriptionPairHandle,
} from './provider-subscription-accounts.js';

const DEFAULT_TIME = '2026-07-23T00:00:00.000Z';
const PERSISTENCE_ERROR = {
  code: 'provider_subscription_persistence_failed',
  message: 'Provider subscription persistence failed.',
} as const;
const PROJECTION_ERROR = {
  code: 'provider_subscription_projection_failed',
  message: 'Provider subscription projection failed.',
} as const;
const SLOT_ERROR = {
  code: 'provider_subscription_account_slot_invalid',
  message: 'Account slot id is invalid.',
} as const;
const PROVIDER_ERROR = {
  code: 'provider_subscription_provider_not_found',
  message: 'Subscription provider not found.',
} as const;
const LOCKED_ERROR = {
  code: 'provider_subscription_vault_locked',
  message: 'Provider subscription Vault is locked.',
} as const;
const ACCOUNT_EXISTS_ERROR = {
  code: 'provider_subscription_account_exists',
  message: 'Provider subscription account already exists.',
} as const;
const ACCOUNT_NOT_FOUND_ERROR = {
  code: 'provider_subscription_account_not_found',
  message: 'Provider subscription account not found.',
} as const;
const ACCOUNT_BOUND_ERROR = {
  code: 'provider_subscription_account_bound',
  message: 'Provider subscription account is bound to a provider profile.',
} as const;
const LOGIN_ACTIVE_ERROR = {
  code: 'provider_subscription_login_active',
  message: 'A login interaction is already active for this account.',
} as const;
const PROVIDER_UNAVAILABLE_ERROR = {
  code: 'provider_subscription_provider_unavailable',
  message: 'Subscription provider is unavailable.',
} as const;
const VAULT_UNAVAILABLE_ERROR = {
  code: 'provider_subscription_vault_unavailable',
  message: 'Provider subscription Vault is unavailable.',
} as const;
const LOGIN_ERROR_MESSAGE = 'Provider subscription login failed.';

/** One strict durable account record used by direct authority fixtures. */
interface AccountRecord {
  /** Durable schema discriminator. */
  readonly schemaVersion: 1;
  /** Subscription provider that owns the account. */
  readonly subscriptionProviderId: ProviderSubscriptionAccountPair['subscriptionProviderId'];
  /** Provider-scoped account slot id. */
  readonly accountSlotId: string;
  /** Immutable creation timestamp. */
  readonly createdAt: string;
  /** Monotonic last-update timestamp. */
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
  readonly status: 'logged_out' | 'pending' | 'logged_in' | 'unavailable' | 'error';
  /** Required only for unavailable and error projections. */
  readonly message?: string;
}

/** Mutable deterministic clock queue owned by one test fixture. */
interface TestClock {
  /** Returns the next queued timestamp or the most recently selected timestamp. */
  readonly now: () => string;
  /** Replaces the queue and fallback timestamp for the next operation. */
  readonly use: (...timestamps: string[]) => void;
}

/** Real Core, Vault, filesystem, and manager fixture used by every manager test. */
interface ProviderSubscriptionFixture {
  /** Temporary NanoCore data root. */
  readonly dataRoot: string;
  /** Migrated Core database under the data root. */
  readonly coreDb: CoreDb;
  /** Real encrypted-file Vault unlock state. */
  readonly vaultState: VaultUnlockState;
  /** Manager under test. */
  readonly manager: ProviderSubscriptionAccountManager;
  /** Creates a fresh process-local manager generation over the same durable authorities. */
  readonly createManager: () => ProviderSubscriptionAccountManager;
  /** Deterministic operation clock. */
  readonly clock: TestClock;
  /** Queues deterministic fresh Vault reference ids. */
  readonly queueReferenceIds: (...referenceIds: string[]) => void;
  /** Returns the dynamically selected backend. */
  readonly backend: () => VaultBackend;
  /** Returns how many times the manager requested the dynamic backend. */
  readonly backendGetterCalls: () => number;
  /** Clears the manager backend-getter call counter. */
  readonly resetBackendGetterCalls: () => void;
  /** Replaces or clears the test-only dynamic backend projection. */
  readonly replaceBackend: (backend?: VaultBackend) => void;
  /** Closes the database and removes the temporary data root. */
  readonly close: () => void;
}

/** Exact raw authority snapshot used to prove failed reads do not repair state. */
interface AuthoritySnapshot {
  /** Raw provider-subscription filesystem tree. */
  readonly accountTree: readonly [string, string][];
  /** Generic Core Vault reference rows. */
  readonly coreReferences: readonly Record<string, unknown>[];
  /** Non-secret encrypted-file Vault inventory. */
  readonly vaultInventory: ReturnType<VaultBackend['listReferences']>;
}

/** One externally released promise gate for deterministic concurrency tests. */
interface DeferredGate {
  /** Promise awaited by gated work. */
  readonly promise: Promise<void>;
  /** Releases the waiting promise. */
  readonly resolve: () => void;
}

/** Public device-code state owned by one manager login interaction. */
interface ManagerLoginInteraction {
  /** OpenKit-owned process-local identifier. */
  readonly interactionId: string;
  /** Only accepted login mode. */
  readonly mode: 'device_code';
  /** Provider-owned device user code. */
  readonly userCode: string;
  /** Sanitized absolute provider verification URL. */
  readonly verificationUrl: string;
  /** Optional provider-derived expiry timestamp. */
  readonly expiresAt?: string;
}

/** Sanitized manager status with one optional process-local interaction. */
type ManagerLifecycleSnapshot = ProviderSubscriptionAccountSnapshot & {
  /** Present only while the exact login interaction is active. */
  readonly interaction?: ManagerLoginInteraction;
};

/** Focused lifecycle surface moving interaction state into the existing manager pair owner. */
interface ManagerLifecycleOperations {
  /** Starts one pair-scoped stock-provider device-code login. */
  readonly startLogin: (pair: ProviderSubscriptionAccountPair) => Promise<ManagerLifecycleSnapshot>;
  /** Cancels and settles the exact active interaction. */
  readonly cancelLogin: (
    pair: ProviderSubscriptionAccountPair,
    interactionId: string
  ) => Promise<ManagerLifecycleSnapshot>;
  /** Returns durable status plus manager-owned process-local state. */
  readonly getStatus: (pair: ProviderSubscriptionAccountPair) => Promise<ManagerLifecycleSnapshot>;
  /** Settles active login and removes the latest credential. */
  readonly logout: (pair: ProviderSubscriptionAccountPair) => Promise<ManagerLifecycleSnapshot>;
}

const fixtures = new Set<ProviderSubscriptionFixture>();
const extraTemporaryRoots = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const fixture of fixtures) {
    fixture.close();
  }
  fixtures.clear();

  for (const root of extraTemporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  extraTemporaryRoots.clear();
});

/**
 * Creates one provider-slot pair.
 *
 * @param accountSlotId Provider-scoped slot id.
 * @param subscriptionProviderId Subscription provider id.
 * @returns Exact pair input for manager operations.
 */
function accountPair(
  accountSlotId: string,
  subscriptionProviderId: ProviderSubscriptionAccountPair['subscriptionProviderId'] = 'openai-codex'
): ProviderSubscriptionAccountPair {
  return { accountSlotId, subscriptionProviderId };
}

/**
 * Creates one deterministic timestamp queue.
 *
 * @returns Mutable queue-backed test clock.
 */
function createTestClock(): TestClock {
  let fallback = DEFAULT_TIME;
  let queue: string[] = [];

  return {
    now: () => queue.shift() ?? fallback,
    use: (...timestamps) => {
      if (timestamps.length === 0) {
        throw new Error('A deterministic fixture timestamp is required.');
      }
      queue = [...timestamps];
      fallback = timestamps.at(-1) ?? fallback;
    },
  };
}

/**
 * Creates one migrated Core database and unlocked encrypted-file Vault fixture.
 *
 * @returns Real provider-subscription manager fixture.
 */
function createFixture(): ProviderSubscriptionFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-subscription-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const clock = createTestClock();
  const vaultState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    now: clock.now,
    storeDir: join(dataRoot, 'server', 'vault'),
  });
  vaultState.unlock({ masterKey: Buffer.alloc(32, 23) });
  const referenceIds: string[] = [];
  let replacementBackend: VaultBackend | undefined;
  let backendGetterCallCount = 0;
  const backend = (): VaultBackend => replacementBackend ?? vaultState.backend();
  const managerBackend = (): VaultBackend => {
    backendGetterCallCount += 1;
    return backend();
  };
  /** Creates one uncached manager generation over the fixture authorities. */
  const createManager = (): ProviderSubscriptionAccountManager =>
    new ProviderSubscriptionAccountManager({
      coreDb,
      createReferenceId: () => {
        const referenceId = referenceIds.shift();
        if (!referenceId) {
          throw new Error('A deterministic fixture reference id is required.');
        }
        return referenceId;
      },
      now: clock.now,
      vaultBackend: managerBackend,
    });
  const manager = createManager();
  const fixture: ProviderSubscriptionFixture = {
    backend,
    backendGetterCalls: () => backendGetterCallCount,
    clock,
    close: () => {
      if (coreDb.sqlite.open) {
        coreDb.sqlite.close();
      }
      rmSync(dataRoot, { force: true, recursive: true });
    },
    coreDb,
    createManager,
    dataRoot,
    manager,
    queueReferenceIds: (...ids) => referenceIds.push(...ids),
    replaceBackend: (next) => {
      replacementBackend = next;
    },
    resetBackendGetterCalls: () => {
      backendGetterCallCount = 0;
    },
    vaultState,
  };

  assertFrozenManagerSurface(manager);
  fixtures.add(fixture);
  return fixture;
}

/**
 * Freezes the manager methods and typed pair-handle surface required by WP2.
 *
 * @param manager Manager instance whose public methods must remain present.
 */
function assertFrozenManagerSurface(manager: ProviderSubscriptionAccountManager): void {
  const methods = [
    manager.createAccount,
    manager.updateAccount,
    manager.deleteAccount,
    manager.listAccounts,
    manager.getPairHandle,
    manager.reconcileAccount,
    manager.reconcileAll,
  ];
  const handleType: ProviderSubscriptionPairHandle | undefined = undefined;

  expect(methods).toHaveLength(7);
  void handleType;
}

/**
 * Returns the exact durable account directory.
 *
 * @param dataRoot NanoCore data root.
 * @param pair Provider-slot pair.
 * @returns Exact provider account directory path.
 */
function accountDirectory(dataRoot: string, pair: ProviderSubscriptionAccountPair): string {
  return join(
    dataRoot,
    'server',
    'files',
    'provider-subscriptions',
    pair.subscriptionProviderId,
    'accounts',
    pair.accountSlotId
  );
}

/**
 * Returns the exact durable account record path.
 *
 * @param dataRoot NanoCore data root.
 * @param pair Provider-slot pair.
 * @returns Exact account.json path.
 */
function accountPath(dataRoot: string, pair: ProviderSubscriptionAccountPair): string {
  return join(accountDirectory(dataRoot, pair), 'account.json');
}

/**
 * Creates a strict unbound account record for direct authority fixtures.
 *
 * @param pair Provider-slot pair.
 * @param overrides Explicit record overrides.
 * @returns Strict version-1 account record.
 */
function validAccountRecord(
  pair: ProviderSubscriptionAccountPair,
  overrides: Partial<AccountRecord> = {}
): AccountRecord {
  return {
    accountSlotId: pair.accountSlotId,
    createdAt: DEFAULT_TIME,
    schemaVersion: 1,
    status: 'logged_out',
    subscriptionProviderId: pair.subscriptionProviderId,
    updatedAt: DEFAULT_TIME,
    ...overrides,
  };
}

/**
 * Writes raw bytes to one direct account authority path.
 *
 * @param dataRoot NanoCore data root.
 * @param pair Provider-slot pair.
 * @param bytes Exact bytes to write.
 */
function writeRawAccount(
  dataRoot: string,
  pair: ProviderSubscriptionAccountPair,
  bytes: string | Uint8Array
): void {
  mkdirSync(accountDirectory(dataRoot, pair), { recursive: true });
  writeFileSync(accountPath(dataRoot, pair), bytes);
}

/**
 * Writes one JSON account authority record.
 *
 * @param dataRoot NanoCore data root.
 * @param pair Provider-slot pair.
 * @param record JSON value to serialize.
 */
function writeAccountJson(
  dataRoot: string,
  pair: ProviderSubscriptionAccountPair,
  record: unknown
): void {
  writeRawAccount(dataRoot, pair, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Reads one account authority as parsed JSON.
 *
 * @param dataRoot NanoCore data root.
 * @param pair Provider-slot pair.
 * @returns Parsed account record.
 */
function readAccountJson(
  dataRoot: string,
  pair: ProviderSubscriptionAccountPair
): Record<string, unknown> {
  return JSON.parse(readFileSync(accountPath(dataRoot, pair), 'utf8')) as Record<string, unknown>;
}

/**
 * Reads the account subtree as stable relative-path and base64-byte pairs.
 *
 * @param dataRoot NanoCore data root.
 * @returns Stable raw account subtree snapshot.
 */
function readAccountTree(dataRoot: string): readonly [string, string][] {
  const root = join(dataRoot, 'server', 'files', 'provider-subscriptions');
  const rows: Array<[string, string]> = [];

  /**
   * Walks one non-symlink directory without following external targets.
   *
   * @param directory Directory to inspect.
   * @param relativeDirectory Relative directory used in snapshot keys.
   */
  function walk(directory: string, relativeDirectory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = join(relativeDirectory, name);
      const stat = lstatSync(path);

      if (stat.isSymbolicLink()) {
        rows.push([relativePath, `symlink:${readFileSync(path, 'utf8')}`]);
      } else if (stat.isDirectory()) {
        rows.push([`${relativePath}/`, 'directory']);
        walk(path, relativePath);
      } else {
        rows.push([relativePath, readFileSync(path).toString('base64')]);
      }
    }
  }

  if (existsSync(root)) {
    walk(root, '.');
  }
  return rows;
}

/**
 * Reads all three durable authorities except append-only audit evidence.
 *
 * @param fixture Real manager fixture.
 * @returns Stable account, Core-reference, and Vault inventory snapshot.
 */
function authoritySnapshot(fixture: ProviderSubscriptionFixture): AuthoritySnapshot {
  const coreReferences = fixture.coreDb.sqlite
    .prepare('SELECT * FROM vault_references ORDER BY reference_id ASC')
    .all() as Record<string, unknown>[];

  return {
    accountTree: readAccountTree(fixture.dataRoot),
    coreReferences,
    vaultInventory: fixture.backend().listReferences(),
  };
}

/**
 * Captures and verifies one typed fixed-message manager error.
 *
 * @param operation Operation expected to reject.
 * @param expected Stable error code and fixed message.
 * @returns Captured typed error.
 */
async function expectAccountError(
  operation: () => Promise<unknown>,
  expected: { readonly code: string; readonly message: string }
): Promise<ProviderSubscriptionAccountError> {
  let failure: unknown;

  try {
    await operation();
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(ProviderSubscriptionAccountError);
  expect(failure).toMatchObject(expected);
  expect((failure as Error).message).toBe(expected.message);
  return failure as ProviderSubscriptionAccountError;
}

/**
 * Creates a complete OAuth credential with provider-private extra fields.
 *
 * @param suffix Stable value suffix.
 * @returns Complete OAuth credential fixture.
 */
function oauthCredential(suffix: string): OAuthCredential {
  return {
    access: `access-${suffix}`,
    accountId: `account-${suffix}`,
    expires: Date.parse('2027-08-23T00:00:00.000Z'),
    refresh: `refresh-${suffix}`,
    scope: ['openid', 'profile'],
    type: 'oauth',
  };
}

/**
 * Creates the exact generic Core row required by one provider-subscription reference.
 *
 * @param fixture Real manager fixture.
 * @param referenceId Vault reference id.
 */
function createExactCoreReference(fixture: ProviderSubscriptionFixture, referenceId: string): void {
  createVaultReference(fixture.coreDb, {
    backendKind: 'encrypted-file',
    backendLocator: `encrypted-file://server/vault/${referenceId}`,
    displayName: 'Provider subscription credential',
    now: fixture.clock.now,
    ownerScope: 'server',
    referenceId,
    secretKind: 'provider-subscription-oauth',
  });
}

/**
 * Creates one exact live account, Core row, and encrypted-file credential.
 *
 * @param fixture Real manager fixture.
 * @param pair Provider-slot pair.
 * @param referenceId Vault reference id.
 * @param credential OAuth credential material.
 */
function createLivePair(
  fixture: ProviderSubscriptionFixture,
  pair: ProviderSubscriptionAccountPair,
  referenceId: string,
  credential: OAuthCredential = oauthCredential(referenceId)
): void {
  writeAccountJson(
    fixture.dataRoot,
    pair,
    validAccountRecord(pair, {
      status: 'logged_in',
      vaultReferenceId: referenceId,
    })
  );
  createExactCoreReference(fixture, referenceId);
  fixture.backend().store({
    material: JSON.stringify(credential),
    metadata: {
      ownerScope: 'server',
      providerSubscriptionAccount: pair,
    },
    referenceId,
  });
}

/**
 * Creates one exact live authority triple with caller-selected stored material.
 *
 * @param fixture Real manager fixture.
 * @param pair Provider-slot pair.
 * @param referenceId Vault reference id.
 * @param material Exact material string stored only by the encrypted-file backend.
 */
function createLiveMaterialPair(
  fixture: ProviderSubscriptionFixture,
  pair: ProviderSubscriptionAccountPair,
  referenceId: string,
  material: string
): void {
  writeAccountJson(
    fixture.dataRoot,
    pair,
    validAccountRecord(pair, { status: 'logged_in', vaultReferenceId: referenceId })
  );
  createExactCoreReference(fixture, referenceId);
  fixture.backend().store({
    material,
    metadata: { ownerScope: 'server', providerSubscriptionAccount: pair },
    referenceId,
  });
}

/**
 * Converts one live pair into immutable completed tombstone history.
 *
 * @param fixture Real manager fixture.
 * @param pair Provider-slot pair.
 * @param referenceId Vault reference id.
 */
function createCompletedHistory(
  fixture: ProviderSubscriptionFixture,
  pair: ProviderSubscriptionAccountPair,
  referenceId: string
): void {
  createLivePair(fixture, pair, referenceId);
  fixture.backend().revoke({ referenceId });
  revokeVaultReference(fixture.coreDb, { now: fixture.clock.now, referenceId });
  rmSync(accountDirectory(fixture.dataRoot, pair), { force: true, recursive: true });
}

/**
 * Replaces selected generic Core reference fields for a failed-closed fixture.
 *
 * @param fixture Real manager fixture.
 * @param referenceId Vault reference id.
 * @param assignments SQL assignment fragment containing test-owned literals only.
 */
function mutateCoreReference(
  fixture: ProviderSubscriptionFixture,
  referenceId: string,
  assignments: string
): void {
  fixture.coreDb.sqlite
    .prepare(`UPDATE vault_references SET ${assignments} WHERE reference_id = ?`)
    .run(referenceId);
}

/**
 * Deletes one generic Core reference row for a missing-authority fixture.
 *
 * @param fixture Real manager fixture.
 * @param referenceId Vault reference id.
 */
function deleteCoreReference(fixture: ProviderSubscriptionFixture, referenceId: string): void {
  fixture.coreDb.sqlite
    .prepare('DELETE FROM vault_references WHERE reference_id = ?')
    .run(referenceId);
}

/**
 * Creates an account and stores its first OAuth credential through the real manager handle.
 *
 * @param fixture Real manager fixture.
 * @param pair Provider-slot pair.
 * @param referenceId Deterministic fresh Vault reference id.
 * @param credential OAuth credential to persist.
 * @returns Cached pair handle used for the store.
 */
async function createStoredPair(
  fixture: ProviderSubscriptionFixture,
  pair: ProviderSubscriptionAccountPair,
  referenceId: string,
  credential: OAuthCredential = oauthCredential(referenceId)
): Promise<ProviderSubscriptionPairHandle> {
  fixture.queueReferenceIds(referenceId);
  await fixture.manager.createAccount(pair);
  const handle = await fixture.manager.getPairHandle(pair);
  await handle.credentials.modify(pair.subscriptionProviderId, async () => credential);
  return handle;
}

/**
 * Creates generic Vault grant, injection-plan, and receipt dependents for one reference.
 *
 * @param fixture Real manager fixture.
 * @param referenceId Vault reference id.
 * @param suffix Stable dependent-record suffix.
 */
function createReferenceCascade(
  fixture: ProviderSubscriptionFixture,
  referenceId: string,
  suffix: string
): void {
  const grantId = `grant_${suffix}`;
  const planId = `plan_${suffix}`;

  createVaultGrant(fixture.coreDb, {
    allowedInjectionPaths: ['runtime-file'],
    grantId,
    lifetime: 'turn',
    ownerScope: 'workspace',
    vaultReferenceId: referenceId,
    workspaceId: 'ws_1',
  });
  createVaultInjectionPlan(fixture.coreDb, {
    backendCapabilityRequirement: 'encrypted-file:resolve',
    expirationBehavior: 'delete-on-turn-end',
    grantId,
    injectionVisibility: 'runtime-file',
    planId,
    redactionRule: 'path-only',
    revocationBehavior: 'mark-session-stale',
    targetPath: `/openkit/secrets/${suffix}`,
  });
  createVaultInjectionReceipt(fixture.coreDb, {
    agentSessionId: `session_${suffix}`,
    backendSummary: `encrypted-file:${referenceId}:v1`,
    grantId,
    injectedAt: DEFAULT_TIME,
    planId,
    receiptId: `receipt_${suffix}`,
    revocationStatus: 'active',
  });
}

/**
 * Reads the exact cascade statuses for one test-owned dependent set.
 *
 * @param fixture Real manager fixture.
 * @param suffix Stable dependent-record suffix.
 * @returns Grant, plan, and receipt status projection.
 */
function readCascadeStatuses(
  fixture: ProviderSubscriptionFixture,
  suffix: string
): { readonly grant: string; readonly plan: string; readonly receipt: string } {
  const grantId = `grant_${suffix}`;
  const planId = `plan_${suffix}`;
  const receiptId = `receipt_${suffix}`;
  const grant = fixture.coreDb.sqlite
    .prepare('SELECT status FROM vault_grants WHERE grant_id = ?')
    .get(grantId) as { readonly status: string };
  const plan = fixture.coreDb.sqlite
    .prepare('SELECT status FROM vault_injection_plans WHERE plan_id = ?')
    .get(planId) as { readonly status: string };
  const receipt = fixture.coreDb.sqlite
    .prepare('SELECT revocation_status FROM vault_injection_receipts WHERE receipt_id = ?')
    .get(receiptId) as { readonly revocation_status: string };

  return {
    grant: grant.status,
    plan: plan.status,
    receipt: receipt.revocation_status,
  };
}

/**
 * Creates one manually released promise gate.
 *
 * @returns Deferred gate for deterministic mutation ordering.
 */
function deferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    promise,
    resolve: () => release?.(),
  };
}

/**
 * Views the manager through the focused lifecycle methods required by the accepted repair.
 *
 * @param manager Provider-subscription manager under test.
 * @returns Expected manager-owned login, status, cancellation, and logout surface.
 */
function lifecycleOperations(
  manager: ProviderSubscriptionAccountManager
): ManagerLifecycleOperations {
  return manager as unknown as ManagerLifecycleOperations;
}

/**
 * Returns the pair's stock provider-owned OAuth implementation.
 *
 * @param handle Existing pair-scoped Models handle.
 * @param pair Provider-slot identity selecting the stock provider.
 * @returns Provider OAuth implementation used directly by manager login.
 */
function requireProviderOAuth(
  handle: ProviderSubscriptionPairHandle,
  pair: ProviderSubscriptionAccountPair
) {
  const oauth = handle.models.getProvider(pair.subscriptionProviderId)?.auth.oauth;
  if (!oauth) {
    throw new Error(`Fixture provider has no OAuth login: ${pair.subscriptionProviderId}`);
  }
  return oauth;
}

/**
 * Captures console arguments without serializing or emitting them.
 *
 * @param captured Destination rows for intercepted console arguments.
 * @returns Console-compatible capture callback.
 */
function captureConsole(captured: unknown[][]): (...args: unknown[]) => void {
  return (...args) => captured.push(args);
}

/**
 * Projects every own Error property, including non-enumerable fields and nested causes.
 *
 * @param error Arbitrary thrown value to serialize as redaction evidence.
 * @returns Complete recursively serializable error projection.
 */
function completeErrorProjection(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const projection: Record<string, unknown> = {};
  const record = error as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(error)) {
    projection[name] = record[name];
  }
  for (const [name, value] of Object.entries(error)) {
    projection[name] = value;
  }
  if ('cause' in error) {
    projection.cause = completeErrorProjection(error.cause);
  }
  return projection;
}

/**
 * Finds literal UTF-8 canary byte sequences in regular files without decoding ciphertext.
 *
 * @param dataRoot Data root to scan recursively.
 * @param canaries Literal canary strings that must not be present.
 * @returns Relative file and canary pairs for every literal byte match.
 */
function findLiteralCanaryBytes(dataRoot: string, canaries: readonly string[]): string[] {
  const matches: string[] = [];

  /**
   * Scans one directory without following symbolic links.
   *
   * @param directory Absolute directory to inspect.
   * @param relativeDirectory Relative directory used in findings.
   */
  function scan(directory: string, relativeDirectory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = join(relativeDirectory, name);
      const stat = lstatSync(path);

      if (stat.isDirectory()) {
        scan(path, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const bytes = readFileSync(path);
      for (const canary of canaries) {
        if (bytes.includes(Buffer.from(canary, 'utf8'))) {
          matches.push(`${relativePath}:${canary}`);
        }
      }
    }
  }

  scan(dataRoot, '.');
  return matches;
}

describe('ProviderSubscriptionAccountManager', () => {
  it('strictly creates and updates safe account metadata through monotonic atomic replacement', async () => {
    const fixture = createFixture();
    const pair = accountPair('team_a');
    fixture.clock.use('2026-07-23T01:00:00.000Z');

    const created: ProviderSubscriptionAccountSnapshot = await fixture.manager.createAccount({
      ...pair,
      displayName: 'Team A',
    });
    const exactPath = join(
      fixture.dataRoot,
      'server',
      'files',
      'provider-subscriptions',
      'openai-codex',
      'accounts',
      'team_a',
      'account.json'
    );
    const createdBytes = readFileSync(exactPath, 'utf8');
    const createdRecord = readAccountJson(fixture.dataRoot, pair);

    expect(accountPath(fixture.dataRoot, pair)).toBe(exactPath);
    expect(created).toEqual({
      accountSlotId: 'team_a',
      createdAt: '2026-07-23T01:00:00.000Z',
      displayName: 'Team A',
      status: 'logged_out',
      subscriptionProviderId: 'openai-codex',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });
    expect(createdRecord).toEqual({
      accountSlotId: 'team_a',
      createdAt: '2026-07-23T01:00:00.000Z',
      displayName: 'Team A',
      schemaVersion: 1,
      status: 'logged_out',
      subscriptionProviderId: 'openai-codex',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });
    expect(JSON.stringify(created)).not.toMatch(
      /vaultReferenceId|vault_reference|encrypted-file:\/\//
    );

    const oldDescriptor = openSync(exactPath, 'r');
    fixture.clock.use('2026-07-22T23:00:00.000Z');
    const regressedClockUpdate = await fixture.manager.updateAccount(pair, {
      displayName: 'Team A renamed',
    });

    try {
      expect(readFileSync(oldDescriptor, 'utf8')).toBe(createdBytes);
    } finally {
      closeSync(oldDescriptor);
    }
    expect(readFileSync(exactPath, 'utf8')).not.toBe(createdBytes);
    expect(regressedClockUpdate).toMatchObject({
      createdAt: '2026-07-23T01:00:00.000Z',
      displayName: 'Team A renamed',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });

    fixture.clock.use('2026-07-23T02:00:00.000Z');
    const advanced = await fixture.manager.updateAccount(pair, { displayName: 'Team A final' });
    const listed = await fixture.manager.listAccounts('openai-codex');

    expect(advanced).toMatchObject({
      createdAt: '2026-07-23T01:00:00.000Z',
      displayName: 'Team A final',
      updatedAt: '2026-07-23T02:00:00.000Z',
    });
    expect(listed).toEqual([advanced]);
    expect(JSON.stringify([created, regressedClockUpdate, advanced, listed])).not.toMatch(
      /vaultReferenceId|vault_reference|encrypted-file:\/\//
    );
  });

  it('rejects invalid records, raw bytes, paths, symlinks, and residue without repair', async () => {
    const invalidRecords: Array<{
      readonly name: string;
      readonly pair: ProviderSubscriptionAccountPair;
      readonly record: unknown;
    }> = [
      {
        name: 'unknown field',
        pair: accountPair('unknown_field'),
        record: { ...validAccountRecord(accountPair('unknown_field')), unknown: true },
      },
      {
        name: 'schema scalar',
        pair: accountPair('bad_schema'),
        record: { ...validAccountRecord(accountPair('bad_schema')), schemaVersion: 2 },
      },
      {
        name: 'timestamp scalar',
        pair: accountPair('bad_time'),
        record: { ...validAccountRecord(accountPair('bad_time')), createdAt: '2026-07-23' },
      },
      {
        name: 'invalid status',
        pair: accountPair('bad_status'),
        record: { ...validAccountRecord(accountPair('bad_status')), status: 'signed_in' },
      },
      {
        name: 'null optional scalar',
        pair: accountPair('null_label'),
        record: { ...validAccountRecord(accountPair('null_label')), displayName: null },
      },
      {
        name: 'wrong optional scalar',
        pair: accountPair('wrong_label'),
        record: { ...validAccountRecord(accountPair('wrong_label')), displayName: 42 },
      },
      {
        name: 'empty display name',
        pair: accountPair('empty_label'),
        record: { ...validAccountRecord(accountPair('empty_label')), displayName: '' },
      },
      {
        name: 'oversized Unicode display name',
        pair: accountPair('wide_label'),
        record: { ...validAccountRecord(accountPair('wide_label')), displayName: 'é'.repeat(129) },
      },
      {
        name: 'invalid Unicode scalar',
        pair: accountPair('invalid_unicode'),
        record: {
          ...validAccountRecord(accountPair('invalid_unicode')),
          displayName: '\ud800',
        },
      },
      {
        name: 'invalid account label',
        pair: accountPair('bad_account_label'),
        record: {
          ...validAccountRecord(accountPair('bad_account_label')),
          accountLabel: '',
        },
      },
      {
        name: 'wrong account label scalar',
        pair: accountPair('wrong_account_label'),
        record: {
          ...validAccountRecord(accountPair('wrong_account_label')),
          accountLabel: 7,
        },
      },
      {
        name: 'invalid plan label',
        pair: accountPair('bad_plan_label'),
        record: {
          ...validAccountRecord(accountPair('bad_plan_label')),
          planLabel: '\udfff',
        },
      },
      {
        name: 'oversized plan label',
        pair: accountPair('wide_plan_label'),
        record: {
          ...validAccountRecord(accountPair('wide_plan_label')),
          planLabel: 'p'.repeat(257),
        },
      },
      {
        name: 'unsafe reference scalar',
        pair: accountPair('bad_reference'),
        record: {
          ...validAccountRecord(accountPair('bad_reference')),
          vaultReferenceId: '../vault-secret',
        },
      },
      {
        name: 'null reference scalar',
        pair: accountPair('null_reference'),
        record: {
          ...validAccountRecord(accountPair('null_reference')),
          vaultReferenceId: null,
        },
      },
      {
        name: 'forbidden status message',
        pair: accountPair('forbidden_message'),
        record: {
          ...validAccountRecord(accountPair('forbidden_message')),
          message: 'not allowed',
        },
      },
      {
        name: 'missing status message',
        pair: accountPair('missing_message'),
        record: { ...validAccountRecord(accountPair('missing_message')), status: 'error' },
      },
      {
        name: 'oversized status message',
        pair: accountPair('wide_message'),
        record: {
          ...validAccountRecord(accountPair('wide_message')),
          message: 'x'.repeat(1_025),
          status: 'unavailable',
        },
      },
      {
        name: 'wrong message scalar',
        pair: accountPair('wrong_message'),
        record: {
          ...validAccountRecord(accountPair('wrong_message')),
          message: 12,
          status: 'error',
        },
      },
      {
        name: 'provider path mismatch',
        pair: accountPair('provider_mismatch'),
        record: {
          ...validAccountRecord(accountPair('provider_mismatch')),
          subscriptionProviderId: 'xai',
        },
      },
      {
        name: 'slot path mismatch',
        pair: accountPair('slot_mismatch'),
        record: {
          ...validAccountRecord(accountPair('slot_mismatch')),
          accountSlotId: 'another_slot',
        },
      },
    ];

    for (const invalid of invalidRecords) {
      const fixture = createFixture();
      writeAccountJson(fixture.dataRoot, invalid.pair, invalid.record);
      const before = authoritySnapshot(fixture);

      await expectAccountError(
        () => fixture.manager.listAccounts('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(fixture), invalid.name).toEqual(before);
    }

    const malformedUtf8Pair = accountPair('bad_utf8');
    const malformedUtf8Prefix = Buffer.from(
      `{"schemaVersion":1,"subscriptionProviderId":"openai-codex","accountSlotId":"bad_utf8","createdAt":"${DEFAULT_TIME}","updatedAt":"${DEFAULT_TIME}","displayName":"`
    );
    const malformedUtf8Suffix = Buffer.from('","status":"logged_out"}');
    const oversizedPair = accountPair('oversized_file');
    const otherwiseValidJson = JSON.stringify(validAccountRecord(oversizedPair));
    const rawCases: Array<{
      readonly bytes: Uint8Array;
      readonly name: string;
      readonly pair: ProviderSubscriptionAccountPair;
    }> = [
      {
        bytes: Buffer.concat([malformedUtf8Prefix, Buffer.from([0xc3, 0x28]), malformedUtf8Suffix]),
        name: 'malformed UTF-8 inside valid JSON structure',
        pair: malformedUtf8Pair,
      },
      {
        bytes: Buffer.from(`${otherwiseValidJson}${' '.repeat(16_385)}`),
        name: 'otherwise-valid oversized JSON',
        pair: oversizedPair,
      },
    ];

    for (const rawCase of rawCases) {
      const fixture = createFixture();
      writeRawAccount(fixture.dataRoot, rawCase.pair, rawCase.bytes);
      const before = authoritySnapshot(fixture);

      await expectAccountError(
        () => fixture.manager.listAccounts('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(fixture), rawCase.name).toEqual(before);
    }

    const symlinkFixture = createFixture();
    const symlinkPair = accountPair('symlink_record');
    const externalRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-subscription-external-'));
    extraTemporaryRoots.add(externalRoot);
    const externalPath = join(externalRoot, 'account.json');
    const externalBytes = `${JSON.stringify(validAccountRecord(symlinkPair))}\n`;
    mkdirSync(accountDirectory(symlinkFixture.dataRoot, symlinkPair), { recursive: true });
    writeFileSync(externalPath, externalBytes);
    symlinkSync(externalPath, accountPath(symlinkFixture.dataRoot, symlinkPair));
    const symlinkBefore = authoritySnapshot(symlinkFixture);

    await expectAccountError(
      () => symlinkFixture.manager.listAccounts('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(lstatSync(accountPath(symlinkFixture.dataRoot, symlinkPair)).isSymbolicLink()).toBe(
      true
    );
    expect(readFileSync(externalPath, 'utf8')).toBe(externalBytes);
    expect(authoritySnapshot(symlinkFixture)).toEqual(symlinkBefore);

    const slotSymlinkFixture = createFixture();
    const slotSymlinkPair = accountPair('symlink_slot');
    const slotSymlinkExternalRoot = mkdtempSync(
      join(tmpdir(), 'openkit-provider-subscription-slot-external-')
    );
    extraTemporaryRoots.add(slotSymlinkExternalRoot);
    const slotSymlinkExternalPath = join(slotSymlinkExternalRoot, 'account.json');
    const slotSymlinkExternalBytes = `${JSON.stringify(validAccountRecord(slotSymlinkPair))}\n`;
    mkdirSync(join(accountDirectory(slotSymlinkFixture.dataRoot, slotSymlinkPair), '..'), {
      recursive: true,
    });
    writeFileSync(slotSymlinkExternalPath, slotSymlinkExternalBytes);
    symlinkSync(
      slotSymlinkExternalRoot,
      accountDirectory(slotSymlinkFixture.dataRoot, slotSymlinkPair)
    );
    const slotSymlinkCoreBefore = slotSymlinkFixture.coreDb.sqlite
      .prepare('SELECT * FROM vault_references ORDER BY reference_id ASC')
      .all();
    const slotSymlinkVaultBefore = slotSymlinkFixture.backend().listReferences();

    await expectAccountError(
      () => slotSymlinkFixture.manager.listAccounts('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(
      lstatSync(accountDirectory(slotSymlinkFixture.dataRoot, slotSymlinkPair)).isSymbolicLink()
    ).toBe(true);
    expect(readFileSync(slotSymlinkExternalPath, 'utf8')).toBe(slotSymlinkExternalBytes);
    expect(
      slotSymlinkFixture.coreDb.sqlite
        .prepare('SELECT * FROM vault_references ORDER BY reference_id ASC')
        .all()
    ).toEqual(slotSymlinkCoreBefore);
    expect(slotSymlinkFixture.backend().listReferences()).toEqual(slotSymlinkVaultBefore);

    const residueFixture = createFixture();
    const residuePair = accountPair('directory_residue');
    mkdirSync(accountDirectory(residueFixture.dataRoot, residuePair), { recursive: true });
    writeFileSync(
      join(accountDirectory(residueFixture.dataRoot, residuePair), 'residue.txt'),
      'keep'
    );
    const residueBefore = authoritySnapshot(residueFixture);

    await expectAccountError(
      () => residueFixture.manager.listAccounts('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(authoritySnapshot(residueFixture)).toEqual(residueBefore);

    const pathFixture = createFixture();
    const pathBefore = authoritySnapshot(pathFixture);

    await expectAccountError(
      () =>
        pathFixture.manager.createAccount({
          accountSlotId: '../escape',
          subscriptionProviderId: 'openai-codex',
        }),
      SLOT_ERROR
    );
    await expectAccountError(
      () =>
        pathFixture.manager.createAccount({
          accountSlotId: '/tmp/escape',
          subscriptionProviderId: 'openai-codex',
        }),
      SLOT_ERROR
    );
    expect(authoritySnapshot(pathFixture)).toEqual(pathBefore);
  });

  it('classifies pair authority and rejects an invalid provider list without partial results', async () => {
    const validCases: Array<{
      readonly name: string;
      readonly pair: ProviderSubscriptionAccountPair;
      readonly prepare: (
        fixture: ProviderSubscriptionFixture,
        pair: ProviderSubscriptionAccountPair
      ) => void;
      readonly expected: readonly Partial<ProviderSubscriptionAccountSnapshot>[];
    }> = [
      {
        expected: [],
        name: 'clean absence',
        pair: accountPair('clean_absence'),
        prepare: () => {},
      },
      {
        expected: [],
        name: 'completed histories',
        pair: accountPair('completed_histories'),
        prepare: (fixture, pair) => {
          createCompletedHistory(fixture, pair, 'history_r1');
          createCompletedHistory(fixture, pair, 'history_r2');
        },
      },
      {
        expected: [{ accountSlotId: 'unbound', status: 'logged_out' }],
        name: 'unbound account',
        pair: accountPair('unbound'),
        prepare: (fixture, pair) => {
          writeAccountJson(fixture.dataRoot, pair, validAccountRecord(pair));
        },
      },
      {
        expected: [{ accountSlotId: 'live', status: 'logged_in' }],
        name: 'live account',
        pair: accountPair('live'),
        prepare: (fixture, pair) => {
          createLivePair(fixture, pair, 'live_r1');
        },
      },
    ];

    for (const validCase of validCases) {
      const fixture = createFixture();
      validCase.prepare(fixture, validCase.pair);
      const before = authoritySnapshot(fixture);
      const accounts = await fixture.manager.listAccounts('openai-codex');

      expect(accounts, validCase.name).toEqual(
        validCase.expected.map((expected) =>
          expect.objectContaining({
            subscriptionProviderId: 'openai-codex',
            ...expected,
          })
        )
      );
      expect(authoritySnapshot(fixture), validCase.name).toEqual(before);
    }

    const invalidCases: Array<{
      readonly name: string;
      readonly pair: ProviderSubscriptionAccountPair;
      readonly prepare: (
        fixture: ProviderSubscriptionFixture,
        pair: ProviderSubscriptionAccountPair
      ) => void;
    }> = [
      {
        name: 'ambiguous bound plus zero',
        pair: accountPair('ambiguous'),
        prepare: (fixture, pair) => {
          writeAccountJson(
            fixture.dataRoot,
            pair,
            validAccountRecord(pair, { vaultReferenceId: 'ambiguous_r1' })
          );
          createExactCoreReference(fixture, 'ambiguous_r1');
        },
      },
      {
        name: 'current tombstone',
        pair: accountPair('current_tombstone'),
        prepare: (fixture, pair) => {
          createLivePair(fixture, pair, 'current_tombstone_r1');
          fixture.backend().revoke({ referenceId: 'current_tombstone_r1' });
        },
      },
      {
        name: 'invalid completed history',
        pair: accountPair('invalid_history'),
        prepare: (fixture, pair) => {
          createCompletedHistory(fixture, pair, 'invalid_history_r1');
          mutateCoreReference(fixture, 'invalid_history_r1', "status = 'active'");
        },
      },
      {
        name: 'extra live reference',
        pair: accountPair('extra_live'),
        prepare: (fixture, pair) => {
          createLivePair(fixture, pair, 'extra_live_r1');
          createExactCoreReference(fixture, 'extra_live_r2');
          fixture.backend().store({
            material: JSON.stringify(oauthCredential('extra-live-r2')),
            metadata: { ownerScope: 'server', providerSubscriptionAccount: pair },
            referenceId: 'extra_live_r2',
          });
        },
      },
      {
        name: 'live orphan',
        pair: accountPair('orphan'),
        prepare: (fixture, pair) => {
          createLivePair(fixture, pair, 'orphan_r1');
          rmSync(accountDirectory(fixture.dataRoot, pair), { force: true, recursive: true });
        },
      },
      {
        name: 'corrupt record',
        pair: accountPair('corrupt'),
        prepare: (fixture, pair) => {
          writeAccountJson(fixture.dataRoot, pair, {
            ...validAccountRecord(pair),
            residue: true,
          });
        },
      },
    ];

    for (const invalidCase of invalidCases) {
      const fixture = createFixture();
      invalidCase.prepare(fixture, invalidCase.pair);
      const before = authoritySnapshot(fixture);

      await expectAccountError(
        () => fixture.manager.listAccounts('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(fixture), invalidCase.name).toEqual(before);
    }

    const coreViolations: Array<{
      readonly name: string;
      readonly mutate: (fixture: ProviderSubscriptionFixture, referenceId: string) => void;
    }> = [
      { name: 'missing row', mutate: deleteCoreReference },
      {
        name: 'wrong version',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, 'current_version = 2'),
      },
      {
        name: 'wrong status',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "status = 'revoked'"),
      },
      {
        name: 'wrong reference identity',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, `reference_id = '${referenceId}_other'`),
      },
      {
        name: 'wrong owner scope',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "owner_scope = 'workspace'"),
      },
      {
        name: 'wrong workspace scope identity',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "workspace_id = 'ws_wrong'"),
      },
      {
        name: 'wrong user scope identity',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "user_id = 'user_wrong'"),
      },
      {
        name: 'wrong display label',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "display_name = 'Wrong label'"),
      },
      {
        name: 'wrong secret kind',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "secret_kind = 'provider-api-key'"),
      },
      {
        name: 'wrong backend kind',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "backend_kind = 'wrong-backend'"),
      },
      {
        name: 'wrong backend locator',
        mutate: (fixture, referenceId) =>
          mutateCoreReference(fixture, referenceId, "backend_locator = 'encrypted-file:wrong'"),
      },
    ];

    for (const [index, violation] of coreViolations.entries()) {
      const liveFixture = createFixture();
      const livePair = accountPair(`live_core_${index}`);
      const liveReferenceId = `live_core_r${index}`;
      createLivePair(liveFixture, livePair, liveReferenceId);
      violation.mutate(liveFixture, liveReferenceId);
      const liveBefore = authoritySnapshot(liveFixture);

      await expectAccountError(
        () => liveFixture.manager.listAccounts('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(liveFixture), `live ${violation.name}`).toEqual(liveBefore);

      const historyFixture = createFixture();
      const historyPair = accountPair(`history_core_${index}`);
      const historyReferenceId = `history_core_r${index}`;
      createCompletedHistory(historyFixture, historyPair, historyReferenceId);
      if (violation.name === 'wrong status') {
        mutateCoreReference(historyFixture, historyReferenceId, "status = 'active'");
      } else {
        violation.mutate(historyFixture, historyReferenceId);
      }
      const historyBefore = authoritySnapshot(historyFixture);

      await expectAccountError(
        () => historyFixture.manager.listAccounts('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(historyFixture), `history ${violation.name}`).toEqual(historyBefore);
    }

    const allOrNothing = createFixture();
    const goodPair = accountPair('a_good');
    const badPair = accountPair('z_bad');
    writeAccountJson(allOrNothing.dataRoot, goodPair, validAccountRecord(goodPair));
    writeAccountJson(
      allOrNothing.dataRoot,
      badPair,
      validAccountRecord(badPair, { vaultReferenceId: 'bad_r1' })
    );
    createExactCoreReference(allOrNothing, 'bad_r1');
    const allOrNothingBefore = authoritySnapshot(allOrNothing);

    await expectAccountError(
      () => allOrNothing.manager.listAccounts('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(authoritySnapshot(allOrNothing)).toEqual(allOrNothingBefore);
  });

  it('commits an initial OAuth credential in binding-Core-Vault order and rejects reused Core rows', async () => {
    const fixture = createFixture();
    const pair = accountPair('initial_store');
    fixture.queueReferenceIds('initial_r1');
    await fixture.manager.createAccount({ ...pair, displayName: 'Initial Store' });
    const backend = fixture.backend();
    const realStore = backend.store.bind(backend);
    const observedOrder: string[] = [];

    expect(getVaultReference(fixture.coreDb, 'initial_r1')).toBeNull();
    fixture.coreDb.sqlite.function('observe_initial_binding', () => {
      expect(readAccountJson(fixture.dataRoot, pair)).toMatchObject({
        vaultReferenceId: 'initial_r1',
      });
      observedOrder.push('binding-before-core');
      return 1;
    });
    fixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER observe_initial_core_insert
      BEFORE INSERT ON vault_references
      FOR EACH ROW
      WHEN NEW.reference_id = 'initial_r1'
      BEGIN
        SELECT observe_initial_binding();
      END`);

    vi.spyOn(backend, 'store').mockImplementation((input) => {
      const coreAtStore = getVaultReference(fixture.coreDb, input.referenceId);

      expect(coreAtStore).toMatchObject({
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file://server/vault/initial_r1',
        currentVersion: 1,
        displayName: 'Provider subscription credential',
        ownerScope: 'server',
        referenceId: 'initial_r1',
        secretKind: 'provider-subscription-oauth',
        status: 'active',
        userId: null,
        workspaceId: null,
      });
      observedOrder.push('vault-after-core');
      return realStore(input);
    });

    const handle: ProviderSubscriptionPairHandle = await fixture.manager.getPairHandle(pair);
    const credential = oauthCredential('initial');
    const stored = await handle.credentials.modify('openai-codex', async (current) => {
      expect(current).toBeUndefined();
      return credential;
    });

    expect(stored).toEqual(credential);
    expect(observedOrder).toEqual(['binding-before-core', 'vault-after-core']);
    expect(readAccountJson(fixture.dataRoot, pair)).toMatchObject({
      status: 'logged_in',
      vaultReferenceId: 'initial_r1',
    });
    expect(getVaultReference(fixture.coreDb, 'initial_r1')).toMatchObject({
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/initial_r1',
      currentVersion: 1,
      displayName: 'Provider subscription credential',
      ownerScope: 'server',
      referenceId: 'initial_r1',
      secretKind: 'provider-subscription-oauth',
      status: 'active',
      userId: null,
      workspaceId: null,
    });
    expect(backend.listReferences()).toEqual([
      expect.objectContaining({
        backendKind: 'encrypted-file',
        currentVersion: 1,
        ownerScope: 'server',
        providerSubscriptionAccount: pair,
        referenceId: 'initial_r1',
        revoked: false,
        versionCount: 1,
      }),
    ]);
    expect(JSON.stringify(await fixture.manager.listAccounts('openai-codex'))).not.toContain(
      'initial_r1'
    );

    const reusedFixture = createFixture();
    const reusedPair = accountPair('reused_core');
    reusedFixture.queueReferenceIds('reused_r1');
    await reusedFixture.manager.createAccount(reusedPair);
    createExactCoreReference(reusedFixture, 'reused_r1');
    const reusedCoreBefore = getVaultReference(reusedFixture.coreDb, 'reused_r1');
    const reusedBackend = reusedFixture.backend();
    const reusedStore = vi.spyOn(reusedBackend, 'store');
    const reusedHandle = await reusedFixture.manager.getPairHandle(reusedPair);

    await expectAccountError(
      () =>
        reusedHandle.credentials.modify('openai-codex', async (current) => {
          expect(current).toBeUndefined();
          return oauthCredential('must-not-store');
        }),
      PERSISTENCE_ERROR
    );
    expect(readAccountJson(reusedFixture.dataRoot, reusedPair)).toMatchObject({
      vaultReferenceId: 'reused_r1',
    });
    expect(getVaultReference(reusedFixture.coreDb, 'reused_r1')).toEqual(reusedCoreBefore);
    expect(reusedStore).not.toHaveBeenCalled();
    expect(reusedBackend.listReferences()).toEqual([]);

    const failedStoreFixture = createFixture();
    const failedStorePair = accountPair('failed_initial_store');
    failedStoreFixture.queueReferenceIds('failed_initial_r1');
    await failedStoreFixture.manager.createAccount(failedStorePair);
    const failedStoreHandle = await failedStoreFixture.manager.getPairHandle(failedStorePair);
    const failedStoreBackend = failedStoreFixture.backend();
    const persistenceFailureCanary = 'raw-backend-persistence-canary';
    const rawPersistenceFailure = Object.assign(
      new Error(`${persistenceFailureCanary}-message`, {
        cause: new Error(`${persistenceFailureCanary}-cause`),
      }),
      { providerBody: `${persistenceFailureCanary}-enumerable` }
    );
    const failedStoreSpy = vi.spyOn(failedStoreBackend, 'store').mockImplementationOnce(() => {
      throw rawPersistenceFailure;
    });

    const failedStoreError = await expectAccountError(
      () =>
        failedStoreHandle.credentials.modify('openai-codex', async () =>
          oauthCredential('failed-initial')
        ),
      PERSISTENCE_ERROR
    );
    expect(JSON.stringify(completeErrorProjection(failedStoreError))).not.toContain(
      persistenceFailureCanary
    );
    expect(readAccountJson(failedStoreFixture.dataRoot, failedStorePair)).toMatchObject({
      status: 'logged_out',
      vaultReferenceId: 'failed_initial_r1',
    });
    expect(getVaultReference(failedStoreFixture.coreDb, 'failed_initial_r1')).toMatchObject({
      currentVersion: 1,
      status: 'active',
    });
    expect(failedStoreBackend.listReferences()).toEqual([]);

    const failedStoreManager = failedStoreFixture.createManager();
    const failedStoreFreshHandle = await failedStoreManager.getPairHandle(failedStorePair);
    const ambiguousBefore = authoritySnapshot(failedStoreFixture);
    failedStoreFixture.queueReferenceIds('failed_initial_r1');

    for (const operation of [
      () =>
        failedStoreFreshHandle.credentials.modify('openai-codex', async () =>
          oauthCredential('must-not-reuse')
        ),
      () => failedStoreFreshHandle.credentials.delete('openai-codex'),
      () => failedStoreManager.reconcileAccount(failedStorePair),
      () => failedStoreManager.createAccount(failedStorePair),
    ]) {
      await expectAccountError(operation, PERSISTENCE_ERROR);
      expect(authoritySnapshot(failedStoreFixture)).toEqual(ambiguousBefore);
    }
    expect(failedStoreSpy).toHaveBeenCalledTimes(1);

    const committedStoreFixture = createFixture();
    const committedStorePair = accountPair('committed_initial_store');
    committedStoreFixture.queueReferenceIds('committed_initial_r1');
    await committedStoreFixture.manager.createAccount(committedStorePair);
    const committedStoreHandle =
      await committedStoreFixture.manager.getPairHandle(committedStorePair);
    const committedStoreBackend = committedStoreFixture.backend();
    const realCommittedStore = committedStoreBackend.store.bind(committedStoreBackend);
    const committedStoreSpy = vi
      .spyOn(committedStoreBackend, 'store')
      .mockImplementationOnce((input) => {
        realCommittedStore(input);
        throw new Error('injected post-commit store failure');
      });
    const committedCredential = oauthCredential('committed-initial');

    await expectAccountError(
      () =>
        committedStoreHandle.credentials.modify('openai-codex', async () => committedCredential),
      PERSISTENCE_ERROR
    );
    expect(readAccountJson(committedStoreFixture.dataRoot, committedStorePair)).toMatchObject({
      status: 'logged_out',
      vaultReferenceId: 'committed_initial_r1',
    });
    expect(committedStoreBackend.listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 1,
        referenceId: 'committed_initial_r1',
        revoked: false,
      }),
    ]);

    const committedStoreManager = committedStoreFixture.createManager();
    const committedFreshHandle = await committedStoreManager.getPairHandle(committedStorePair);
    const reconciled = await committedStoreManager.reconcileAccount(committedStorePair);

    expect(reconciled).toMatchObject({ status: 'logged_in' });
    expect(JSON.stringify(reconciled)).not.toContain('committed_initial_r1');
    expect(committedStoreSpy).toHaveBeenCalledTimes(1);
    await expect(committedFreshHandle.credentials.read('openai-codex')).resolves.toEqual(
      committedCredential
    );

    const projectionFixture = createFixture();
    const projectionPair = accountPair('post_store_projection');
    projectionFixture.queueReferenceIds('post_store_projection_r1');
    await projectionFixture.manager.createAccount(projectionPair);
    const projectionHandle = await projectionFixture.manager.getPairHandle(projectionPair);
    const projectionBackend = projectionFixture.backend();
    const realProjectionStore = projectionBackend.store.bind(projectionBackend);
    const projectionAccountDirectory = accountDirectory(projectionFixture.dataRoot, projectionPair);
    const parkedProjectionAccountDirectory = `${projectionAccountDirectory}.parked`;

    vi.spyOn(projectionBackend, 'store').mockImplementationOnce((input) => {
      const entry = realProjectionStore(input);
      renameSync(projectionAccountDirectory, parkedProjectionAccountDirectory);
      writeFileSync(projectionAccountDirectory, 'projection blocker', { mode: 0o600 });
      return entry;
    });

    await expectAccountError(
      () =>
        projectionHandle.credentials.modify('openai-codex', async () =>
          oauthCredential('post-store-projection')
        ),
      PROJECTION_ERROR
    );
    unlinkSync(projectionAccountDirectory);
    renameSync(parkedProjectionAccountDirectory, projectionAccountDirectory);
    expect(await projectionFixture.manager.reconcileAccount(projectionPair)).toMatchObject({
      status: 'logged_in',
    });
  });

  it('repairs lower positive Core versions stepwise and fails closed on ahead or mismatched reconciliation', async () => {
    const repairFixture = createFixture();
    const repairPair = accountPair('repair_one');
    await createStoredPair(repairFixture, repairPair, 'repair_r1');
    repairFixture.backend().rotate({
      material: JSON.stringify(oauthCredential('repair-v2')),
      referenceId: 'repair_r1',
    });
    writeAccountJson(
      repairFixture.dataRoot,
      repairPair,
      validAccountRecord(repairPair, {
        message: 'Safe stale projection.',
        status: 'unavailable',
        vaultReferenceId: 'repair_r1',
      })
    );

    const repaired = await repairFixture.manager.reconcileAccount(repairPair);

    expect(repaired).toEqual({
      accountSlotId: 'repair_one',
      createdAt: DEFAULT_TIME,
      status: 'logged_in',
      subscriptionProviderId: 'openai-codex',
      updatedAt: DEFAULT_TIME,
    });
    expect(getVaultReference(repairFixture.coreDb, 'repair_r1')).toMatchObject({
      currentVersion: 2,
      status: 'active',
    });
    expect(readAccountJson(repairFixture.dataRoot, repairPair)).toEqual({
      accountSlotId: 'repair_one',
      createdAt: DEFAULT_TIME,
      schemaVersion: 1,
      status: 'logged_in',
      subscriptionProviderId: 'openai-codex',
      updatedAt: DEFAULT_TIME,
      vaultReferenceId: 'repair_r1',
    });
    expect(JSON.stringify(repaired)).not.toContain('repair_r1');

    const equalBefore = authoritySnapshot(repairFixture);
    const equal = await repairFixture.manager.reconcileAll();

    expect(equal).toEqual([repaired]);
    expect(authoritySnapshot(repairFixture)).toEqual(equalBefore);

    const catchupFixture = createFixture();
    const catchupPair = accountPair('repair_two_steps');
    await createStoredPair(catchupFixture, catchupPair, 'repair_two_steps_r1');
    catchupFixture.backend().rotate({
      material: JSON.stringify(oauthCredential('repair-two-steps-v2')),
      referenceId: 'repair_two_steps_r1',
    });
    catchupFixture.backend().rotate({
      material: JSON.stringify(oauthCredential('repair-two-steps-v3')),
      referenceId: 'repair_two_steps_r1',
    });
    writeAccountJson(
      catchupFixture.dataRoot,
      catchupPair,
      validAccountRecord(catchupPair, {
        message: 'Safe stale projection.',
        status: 'unavailable',
        vaultReferenceId: 'repair_two_steps_r1',
      })
    );
    catchupFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER reject_direct_version_jump
      BEFORE UPDATE OF current_version ON vault_references
      FOR EACH ROW
      WHEN OLD.reference_id = 'repair_two_steps_r1'
        AND OLD.current_version = 1
        AND NEW.current_version = 3
      BEGIN
        SELECT RAISE(FAIL, 'direct version jump rejected');
      END`);

    const caughtUp = await catchupFixture.manager.reconcileAccount(catchupPair);

    expect(caughtUp).toMatchObject({ status: 'logged_in' });
    expect(getVaultReference(catchupFixture.coreDb, 'repair_two_steps_r1')).toMatchObject({
      currentVersion: 3,
      status: 'active',
    });
    expect(catchupFixture.backend().listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 3,
        referenceId: 'repair_two_steps_r1',
        versionCount: 3,
      }),
    ]);

    const projectionFixture = createFixture();
    const projectionPair = accountPair('post_rotate_projection');
    const projectionHandle = await createStoredPair(
      projectionFixture,
      projectionPair,
      'post_rotate_projection_r1'
    );
    const rotatedProjectionCredential = oauthCredential('post-rotate-projection-v2');
    projectionFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER fail_post_rotate_core_projection
      BEFORE UPDATE OF current_version ON vault_references
      FOR EACH ROW
      WHEN OLD.reference_id = 'post_rotate_projection_r1'
        AND OLD.current_version = 1
        AND NEW.current_version = 2
      BEGIN
        SELECT RAISE(FAIL, 'injected post-rotate Core projection failure');
      END`);

    await expectAccountError(
      () =>
        projectionHandle.credentials.modify(
          'openai-codex',
          async () => rotatedProjectionCredential
        ),
      PROJECTION_ERROR
    );
    expect(getVaultReference(projectionFixture.coreDb, 'post_rotate_projection_r1')).toMatchObject({
      currentVersion: 1,
      status: 'active',
    });
    expect(projectionFixture.backend().listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 2,
        referenceId: 'post_rotate_projection_r1',
        revoked: false,
      }),
    ]);
    projectionFixture.coreDb.sqlite.exec('DROP TRIGGER fail_post_rotate_core_projection');
    expect(await projectionFixture.manager.reconcileAccount(projectionPair)).toMatchObject({
      status: 'logged_in',
    });
    expect(getVaultReference(projectionFixture.coreDb, 'post_rotate_projection_r1')).toMatchObject({
      currentVersion: 2,
      status: 'active',
    });
    await expect(projectionHandle.credentials.read('openai-codex')).resolves.toEqual(
      rotatedProjectionCredential
    );

    const invalidCases: Array<{
      readonly name: string;
      readonly prepare: (
        fixture: ProviderSubscriptionFixture,
        pair: ProviderSubscriptionAccountPair,
        referenceId: string
      ) => void;
    }> = [
      {
        name: 'Core is N+1',
        prepare: (fixture, _pair, referenceId) => {
          mutateCoreReference(fixture, referenceId, 'current_version = 2');
        },
      },
      {
        name: 'Core identity mismatch',
        prepare: (fixture, _pair, referenceId) => {
          mutateCoreReference(fixture, referenceId, "display_name = 'Wrong credential label'");
        },
      },
    ];

    for (const [index, invalidCase] of invalidCases.entries()) {
      const fixture = createFixture();
      const pair = accountPair(`reconcile_invalid_${index}`);
      const referenceId = `reconcile_invalid_r${index}`;
      await createStoredPair(fixture, pair, referenceId);
      invalidCase.prepare(fixture, pair, referenceId);
      const before = authoritySnapshot(fixture);

      await expectAccountError(() => fixture.manager.reconcileAccount(pair), PERSISTENCE_ERROR);
      expect(authoritySnapshot(fixture), invalidCase.name).toEqual(before);
    }
  });

  it('continues tombstoned credential and account removal and recreates only with a fresh reference', async () => {
    const credentialFixture = createFixture();
    const pair = accountPair('delete_and_recreate');
    const originalHandle = await createStoredPair(
      credentialFixture,
      pair,
      'delete_r1',
      oauthCredential('delete-r1')
    );
    createReferenceCascade(credentialFixture, 'delete_r1', 'credential_delete');
    const backend = credentialFixture.backend();
    const realRevoke = backend.revoke.bind(backend);
    const revokeCalls: string[] = [];

    vi.spyOn(backend, 'revoke').mockImplementation((input) => {
      revokeCalls.push(input.referenceId);
      expect(readAccountJson(credentialFixture.dataRoot, pair)).toMatchObject({
        vaultReferenceId: input.referenceId,
      });
      expect(getVaultReference(credentialFixture.coreDb, input.referenceId)).toMatchObject({
        status: 'active',
      });
      return realRevoke(input);
    });
    credentialFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER fail_credential_delete_cascade
      BEFORE UPDATE OF status ON vault_grants
      FOR EACH ROW
      WHEN OLD.grant_id = 'grant_credential_delete'
        AND OLD.status = 'active'
        AND NEW.status = 'revoked'
      BEGIN
        SELECT RAISE(FAIL, 'injected credential delete cascade failure');
      END`);

    await expectAccountError(
      () => originalHandle.credentials.delete('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(revokeCalls).toEqual(['delete_r1']);
    expect(backend.listReferences()).toEqual([
      expect.objectContaining({ referenceId: 'delete_r1', revoked: true }),
    ]);
    expect(getVaultReference(credentialFixture.coreDb, 'delete_r1')).toMatchObject({
      currentVersion: 1,
      status: 'active',
    });
    expect(readCascadeStatuses(credentialFixture, 'credential_delete')).toEqual({
      grant: 'active',
      plan: 'active',
      receipt: 'active',
    });
    expect(readAccountJson(credentialFixture.dataRoot, pair)).toMatchObject({
      vaultReferenceId: 'delete_r1',
    });

    credentialFixture.coreDb.sqlite.exec('DROP TRIGGER fail_credential_delete_cascade');
    await originalHandle.credentials.delete('openai-codex');

    expect(revokeCalls).toEqual(['delete_r1']);
    expect(getVaultReference(credentialFixture.coreDb, 'delete_r1')).toMatchObject({
      currentVersion: 1,
      status: 'revoked',
    });
    expect(readCascadeStatuses(credentialFixture, 'credential_delete')).toEqual({
      grant: 'revoked',
      plan: 'revoked',
      receipt: 'stale-session',
    });
    expect(readAccountJson(credentialFixture.dataRoot, pair)).toEqual({
      accountSlotId: 'delete_and_recreate',
      createdAt: DEFAULT_TIME,
      schemaVersion: 1,
      status: 'logged_out',
      subscriptionProviderId: 'openai-codex',
      updatedAt: DEFAULT_TIME,
    });

    await credentialFixture.manager.deleteAccount(pair, () => false);
    expect(existsSync(accountDirectory(credentialFixture.dataRoot, pair))).toBe(false);
    const historicalCore = getVaultReference(credentialFixture.coreDb, 'delete_r1');
    const historicalVault = backend
      .listReferences()
      .find((entry) => entry.referenceId === 'delete_r1');

    credentialFixture.queueReferenceIds('delete_r2');
    await credentialFixture.manager.createAccount(pair);
    const freshHandle = await credentialFixture.manager.getPairHandle(pair);
    await freshHandle.credentials.modify('openai-codex', async () => oauthCredential('delete-r2'));

    expect(readAccountJson(credentialFixture.dataRoot, pair)).toMatchObject({
      status: 'logged_in',
      vaultReferenceId: 'delete_r2',
    });
    expect(getVaultReference(credentialFixture.coreDb, 'delete_r1')).toEqual(historicalCore);
    expect(backend.listReferences().find((entry) => entry.referenceId === 'delete_r1')).toEqual(
      historicalVault
    );
    expect(getVaultReference(credentialFixture.coreDb, 'delete_r2')).toMatchObject({
      currentVersion: 1,
      status: 'active',
    });
    expect(backend.listReferences()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceId: 'delete_r1', revoked: true }),
        expect.objectContaining({ referenceId: 'delete_r2', revoked: false }),
      ])
    );

    const revokedCredentialFixture = createFixture();
    const revokedCredentialPair = accountPair('credential_revoked_prefix');
    const revokedCredentialHandle = await createStoredPair(
      revokedCredentialFixture,
      revokedCredentialPair,
      'credential_revoked_r1'
    );
    createReferenceCascade(revokedCredentialFixture, 'credential_revoked_r1', 'credential_revoked');
    revokedCredentialFixture.backend().revoke({ referenceId: 'credential_revoked_r1' });
    revokeVaultReference(revokedCredentialFixture.coreDb, {
      referenceId: 'credential_revoked_r1',
    });
    const credentialRetryWrites = [
      vi.spyOn(revokedCredentialFixture.backend(), 'store'),
      vi.spyOn(revokedCredentialFixture.backend(), 'rotate'),
      vi.spyOn(revokedCredentialFixture.backend(), 'revoke'),
    ];

    await revokedCredentialHandle.credentials.delete('openai-codex');

    for (const write of credentialRetryWrites) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(readAccountJson(revokedCredentialFixture.dataRoot, revokedCredentialPair)).toEqual({
      accountSlotId: 'credential_revoked_prefix',
      createdAt: DEFAULT_TIME,
      schemaVersion: 1,
      status: 'logged_out',
      subscriptionProviderId: 'openai-codex',
      updatedAt: DEFAULT_TIME,
    });
    expect(readCascadeStatuses(revokedCredentialFixture, 'credential_revoked')).toEqual({
      grant: 'revoked',
      plan: 'revoked',
      receipt: 'stale-session',
    });

    const accountDeleteFixture = createFixture();
    const accountDeletePair = accountPair('account_delete_tombstone');
    await createStoredPair(accountDeleteFixture, accountDeletePair, 'account_delete_r1');
    createReferenceCascade(accountDeleteFixture, 'account_delete_r1', 'account_delete');
    accountDeleteFixture.backend().revoke({ referenceId: 'account_delete_r1' });
    revokeVaultReference(accountDeleteFixture.coreDb, { referenceId: 'account_delete_r1' });
    const accountRetryWrites = [
      vi.spyOn(accountDeleteFixture.backend(), 'store'),
      vi.spyOn(accountDeleteFixture.backend(), 'rotate'),
      vi.spyOn(accountDeleteFixture.backend(), 'revoke'),
    ];

    await accountDeleteFixture.manager.deleteAccount(accountDeletePair, () => false);

    for (const write of accountRetryWrites) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(existsSync(accountDirectory(accountDeleteFixture.dataRoot, accountDeletePair))).toBe(
      false
    );
    expect(getVaultReference(accountDeleteFixture.coreDb, 'account_delete_r1')).toMatchObject({
      currentVersion: 1,
      status: 'revoked',
    });
    expect(readCascadeStatuses(accountDeleteFixture, 'account_delete')).toEqual({
      grant: 'revoked',
      plan: 'revoked',
      receipt: 'stale-session',
    });
    expect(accountDeleteFixture.backend().listReferences()).toEqual([
      expect.objectContaining({ referenceId: 'account_delete_r1', revoked: true }),
    ]);

    const laggedCredentialFixture = createFixture();
    const laggedCredentialPair = accountPair('lagged_credential_delete');
    const laggedCredentialHandle = await createStoredPair(
      laggedCredentialFixture,
      laggedCredentialPair,
      'lagged_credential_r1'
    );
    const laggedCredentialBackend = laggedCredentialFixture.backend();
    laggedCredentialBackend.rotate({
      material: JSON.stringify(oauthCredential('lagged-credential-v2')),
      referenceId: 'lagged_credential_r1',
    });
    laggedCredentialBackend.rotate({
      material: JSON.stringify(oauthCredential('lagged-credential-v3')),
      referenceId: 'lagged_credential_r1',
    });
    laggedCredentialFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER reject_lagged_direct_jump
      BEFORE UPDATE OF current_version ON vault_references
      FOR EACH ROW
      WHEN OLD.reference_id = 'lagged_credential_r1'
        AND OLD.current_version = 1
        AND NEW.current_version = 3
      BEGIN
        SELECT RAISE(FAIL, 'direct lagged credential version jump rejected');
      END`);
    const realLaggedCredentialRevoke = laggedCredentialBackend.revoke.bind(laggedCredentialBackend);
    const laggedCredentialRevoke = vi
      .spyOn(laggedCredentialBackend, 'revoke')
      .mockImplementation((input) => {
        expect(getVaultReference(laggedCredentialFixture.coreDb, input.referenceId)).toMatchObject({
          currentVersion: 3,
          status: 'active',
        });
        return realLaggedCredentialRevoke(input);
      });

    try {
      await laggedCredentialHandle.credentials.delete('openai-codex');
    } finally {
      laggedCredentialFixture.coreDb.sqlite.exec('DROP TRIGGER reject_lagged_direct_jump');
    }
    expect(laggedCredentialRevoke).toHaveBeenCalledTimes(1);
    expect(getVaultReference(laggedCredentialFixture.coreDb, 'lagged_credential_r1')).toMatchObject(
      {
        currentVersion: 3,
        status: 'revoked',
      }
    );
    expect(laggedCredentialBackend.listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 3,
        referenceId: 'lagged_credential_r1',
        revoked: true,
      }),
    ]);
    expect(readAccountJson(laggedCredentialFixture.dataRoot, laggedCredentialPair)).toMatchObject({
      status: 'logged_out',
    });

    const laggedAccountFixture = createFixture();
    const laggedAccountPair = accountPair('lagged_account_delete');
    await createStoredPair(laggedAccountFixture, laggedAccountPair, 'lagged_account_r1');
    const laggedAccountBackend = laggedAccountFixture.backend();
    laggedAccountBackend.rotate({
      material: JSON.stringify(oauthCredential('lagged-account-v2')),
      referenceId: 'lagged_account_r1',
    });
    const realLaggedAccountRevoke = laggedAccountBackend.revoke.bind(laggedAccountBackend);
    const laggedAccountRevoke = vi
      .spyOn(laggedAccountBackend, 'revoke')
      .mockImplementation((input) => {
        expect(getVaultReference(laggedAccountFixture.coreDb, input.referenceId)).toMatchObject({
          currentVersion: 2,
          status: 'active',
        });
        return realLaggedAccountRevoke(input);
      });

    await laggedAccountFixture.manager.deleteAccount(laggedAccountPair, () => false);
    expect(laggedAccountRevoke).toHaveBeenCalledTimes(1);
    expect(existsSync(accountDirectory(laggedAccountFixture.dataRoot, laggedAccountPair))).toBe(
      false
    );
    expect(getVaultReference(laggedAccountFixture.coreDb, 'lagged_account_r1')).toMatchObject({
      currentVersion: 2,
      status: 'revoked',
    });
    expect(laggedAccountBackend.listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 2,
        referenceId: 'lagged_account_r1',
        revoked: true,
      }),
    ]);

    const failedCatchupFixture = createFixture();
    const failedCatchupPair = accountPair('failed_delete_catchup');
    const failedCatchupHandle = await createStoredPair(
      failedCatchupFixture,
      failedCatchupPair,
      'failed_delete_catchup_r1'
    );
    failedCatchupFixture.backend().rotate({
      material: JSON.stringify(oauthCredential('failed-delete-catchup-v2')),
      referenceId: 'failed_delete_catchup_r1',
    });
    failedCatchupFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER fail_delete_core_catchup
      BEFORE UPDATE OF current_version ON vault_references
      FOR EACH ROW
      WHEN OLD.reference_id = 'failed_delete_catchup_r1'
      BEGIN
        SELECT RAISE(FAIL, 'injected delete catch-up failure');
      END`);
    const failedCatchupRevoke = vi.spyOn(failedCatchupFixture.backend(), 'revoke');
    const failedCatchupBefore = authoritySnapshot(failedCatchupFixture);

    await expectAccountError(
      () => failedCatchupHandle.credentials.delete('openai-codex'),
      PERSISTENCE_ERROR
    );
    expect(failedCatchupRevoke).not.toHaveBeenCalled();
    expect(authoritySnapshot(failedCatchupFixture)).toEqual(failedCatchupBefore);
  });

  it('implements the exact pair-scoped stock CredentialStore contract without hidden resolution', async () => {
    const foreignFixture = createFixture();
    const foreignPair = accountPair('foreign_guard');
    await foreignFixture.manager.createAccount(foreignPair);
    const foreignHandle = await foreignFixture.manager.getPairHandle(foreignPair);
    writeAccountJson(foreignFixture.dataRoot, foreignPair, {
      ...validAccountRecord(foreignPair),
      corrupt: true,
    });
    const corruptAccountBytes = readFileSync(accountPath(foreignFixture.dataRoot, foreignPair));
    const poisonedBackend = foreignFixture.backend();
    const backendSpies = [
      vi.spyOn(poisonedBackend, 'health').mockImplementation(() => {
        throw new Error('foreign provider reached backend health');
      }),
      vi.spyOn(poisonedBackend, 'listReferences').mockImplementation(() => {
        throw new Error('foreign provider reached backend inventory');
      }),
      vi.spyOn(poisonedBackend, 'resolve').mockImplementation(() => {
        throw new Error('foreign provider reached backend resolve');
      }),
      vi.spyOn(poisonedBackend, 'store').mockImplementation(() => {
        throw new Error('foreign provider reached backend store');
      }),
      vi.spyOn(poisonedBackend, 'rotate').mockImplementation(() => {
        throw new Error('foreign provider reached backend rotate');
      }),
      vi.spyOn(poisonedBackend, 'revoke').mockImplementation(() => {
        throw new Error('foreign provider reached backend revoke');
      }),
    ];
    foreignFixture.replaceBackend(poisonedBackend);
    foreignFixture.coreDb.sqlite.close();
    foreignFixture.resetBackendGetterCalls();
    let foreignCallbackCalled = false;

    for (const operation of [
      () => foreignHandle.credentials.read('xai'),
      () =>
        foreignHandle.credentials.modify('xai', async () => {
          foreignCallbackCalled = true;
          return oauthCredential('foreign');
        }),
      () => foreignHandle.credentials.delete('xai'),
    ]) {
      await expectAccountError(operation, PROVIDER_ERROR);
    }
    expect(foreignCallbackCalled).toBe(false);
    expect(foreignFixture.backendGetterCalls()).toBe(0);
    expect(readFileSync(accountPath(foreignFixture.dataRoot, foreignPair))).toEqual(
      corruptAccountBytes
    );
    for (const backendSpy of backendSpies) {
      expect(backendSpy).not.toHaveBeenCalled();
    }

    const missingFixture = createFixture();
    const missingPair = accountPair('missing_credential');
    await missingFixture.manager.createAccount(missingPair);
    const missingHandle = await missingFixture.manager.getPairHandle(missingPair);
    const missingBefore = authoritySnapshot(missingFixture);

    await expect(missingHandle.credentials.read('openai-codex')).resolves.toBeUndefined();
    await expect(missingHandle.credentials.delete('openai-codex')).resolves.toBeUndefined();
    expect(authoritySnapshot(missingFixture)).toEqual(missingBefore);

    const fixture = createFixture();
    const pair = accountPair('credential_contract');
    fixture.queueReferenceIds('credential_contract_r1');
    await fixture.manager.createAccount(pair);
    const handle = await fixture.manager.getPairHandle(pair);
    const backend = fixture.backend();
    const realResolve = backend.resolve.bind(backend);
    const resolve = vi.spyOn(backend, 'resolve');
    const resolvedMaterialBuffers: Uint8Array[] = [];
    resolve.mockImplementation((input) => {
      const material = realResolve(input);

      expect(material).toBeInstanceOf(Uint8Array);
      resolvedMaterialBuffers.push(material as Uint8Array);
      return material;
    });

    await expect(handle.credentials.list()).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();

    const completeCredential = oauthCredential('complete-extra-fields');
    await expect(
      handle.credentials.modify('openai-codex', async (current) => {
        expect(current).toBeUndefined();
        return completeCredential;
      })
    ).resolves.toEqual(completeCredential);
    await expect(handle.credentials.list()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
    ]);
    expect(resolve).not.toHaveBeenCalled();
    await expect(handle.credentials.read('openai-codex')).resolves.toEqual(completeCredential);
    expect(resolvedMaterialBuffers).toHaveLength(1);
    expect.soft(resolvedMaterialBuffers[0]?.every((byte) => byte === 0)).toBe(true);

    const undefinedBefore = authoritySnapshot(fixture);
    await expect(
      handle.credentials.modify('openai-codex', async (current) => {
        expect(current).toEqual(completeCredential);
        return undefined;
      })
    ).resolves.toEqual(completeCredential);
    expect(resolvedMaterialBuffers).toHaveLength(2);
    expect.soft(resolvedMaterialBuffers[1]?.every((byte) => byte === 0)).toBe(true);
    expect(authoritySnapshot(fixture)).toEqual(undefinedBefore);

    const replacementCredential = oauthCredential('complete-replacement');
    await expect(
      handle.credentials.modify('openai-codex', async (current) => {
        expect(current).toEqual(completeCredential);
        return replacementCredential;
      })
    ).resolves.toEqual(replacementCredential);
    expect(getVaultReference(fixture.coreDb, 'credential_contract_r1')).toMatchObject({
      currentVersion: 2,
      status: 'active',
    });
    expect(backend.listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 2,
        referenceId: 'credential_contract_r1',
        revoked: false,
      }),
    ]);
    expect(resolvedMaterialBuffers).toHaveLength(3);
    expect(resolvedMaterialBuffers[2]?.every((byte) => byte === 0)).toBe(true);

    const updaterFailure = new Error('updater rejection must propagate unchanged');
    const updaterFailureBefore = authoritySnapshot(fixture);
    await expect(
      handle.credentials.modify('openai-codex', async () => {
        throw updaterFailure;
      })
    ).rejects.toBe(updaterFailure);
    expect(authoritySnapshot(fixture)).toEqual(updaterFailureBefore);

    const apiKeyBefore = authoritySnapshot(fixture);
    await expectAccountError(
      () =>
        handle.credentials.modify(
          'openai-codex',
          async () => ({ key: 'api-key-write-must-fail', type: 'api_key' }) as never
        ),
      PERSISTENCE_ERROR
    );
    expect(authoritySnapshot(fixture)).toEqual(apiKeyBefore);

    const siblingFixture = createFixture();
    const siblingTargetPair = accountPair('sibling_target');
    const siblingTargetHandle = await createStoredPair(
      siblingFixture,
      siblingTargetPair,
      'sibling_target_r1'
    );
    const corruptSiblingPair = accountPair('corrupt_sibling');
    await siblingFixture.manager.createAccount(corruptSiblingPair);
    writeAccountJson(siblingFixture.dataRoot, corruptSiblingPair, {
      ...validAccountRecord(corruptSiblingPair),
      corrupt: true,
    });
    const siblingResolve = vi.spyOn(siblingFixture.backend(), 'resolve');
    const siblingBefore = authoritySnapshot(siblingFixture);

    await expect(siblingTargetHandle.credentials.list()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
    ]);
    expect(siblingResolve).not.toHaveBeenCalled();
    expect(authoritySnapshot(siblingFixture)).toEqual(siblingBefore);

    const inventoryFixture = createFixture();
    const inventoryPair = accountPair('inventory_owner');
    const inventoryHandle = await createStoredPair(
      inventoryFixture,
      inventoryPair,
      'inventory_owner_r1'
    );
    const orphanPair = accountPair('inventory_orphan');
    createExactCoreReference(inventoryFixture, 'inventory_orphan_r1');
    inventoryFixture.backend().store({
      material: JSON.stringify(oauthCredential('inventory-orphan')),
      metadata: { ownerScope: 'server', providerSubscriptionAccount: orphanPair },
      referenceId: 'inventory_orphan_r1',
    });
    const inventoryResolve = vi.spyOn(inventoryFixture.backend(), 'resolve');
    const inventoryBefore = authoritySnapshot(inventoryFixture);

    await expectAccountError(() => inventoryHandle.credentials.list(), PERSISTENCE_ERROR);
    expect(inventoryResolve).not.toHaveBeenCalled();
    expect(authoritySnapshot(inventoryFixture)).toEqual(inventoryBefore);

    const malformedCases = [
      {
        material: JSON.stringify({ key: 'api-key-must-not-be-accepted', type: 'api_key' }),
        name: 'api_key material',
      },
      {
        material: JSON.stringify({ access: 'missing-refresh', expires: 1, type: 'oauth' }),
        name: 'malformed OAuth material',
      },
    ];

    for (const [index, malformedCase] of malformedCases.entries()) {
      const malformedFixture = createFixture();
      const malformedPair = accountPair(`malformed_material_${index}`);
      createLiveMaterialPair(
        malformedFixture,
        malformedPair,
        `malformed_material_r${index}`,
        malformedCase.material
      );
      const malformedHandle = await malformedFixture.manager.getPairHandle(malformedPair);
      const before = authoritySnapshot(malformedFixture);

      await expectAccountError(
        () => malformedHandle.credentials.read('openai-codex'),
        PERSISTENCE_ERROR
      );
      expect(authoritySnapshot(malformedFixture), malformedCase.name).toEqual(before);
    }

    const deepEqualReplacement: OAuthCredential = {
      ...replacementCredential,
      scope: [...(replacementCredential.scope ?? [])],
    };
    expect(deepEqualReplacement).toEqual(replacementCredential);
    expect(deepEqualReplacement).not.toBe(replacementCredential);
    await expect(
      handle.credentials.modify('openai-codex', async (current) => {
        expect(current).toEqual(replacementCredential);
        return deepEqualReplacement;
      })
    ).resolves.toEqual(deepEqualReplacement);
    expect(getVaultReference(fixture.coreDb, 'credential_contract_r1')).toMatchObject({
      currentVersion: 3,
      status: 'active',
    });
  });

  it('serializes same-pair refresh and delete while allowing cross-pair progress and fresh generations', async () => {
    const fixture = createFixture();
    const firstPair = accountPair('shared_slot', 'openai-codex');
    const secondPair = accountPair('shared_slot', 'xai');
    const firstHandle = await createStoredPair(
      fixture,
      firstPair,
      'shared_openai_r1',
      oauthCredential('serialized-a-v1')
    );
    const secondHandle = await createStoredPair(
      fixture,
      secondPair,
      'shared_xai_r1',
      oauthCredential('concurrent-b-v1')
    );
    const refreshEntered = deferredGate();
    const releaseRefresh = deferredGate();
    const events: string[] = [];
    const firstBackend = fixture.backend();
    const realRevoke = firstBackend.revoke.bind(firstBackend);

    vi.spyOn(firstBackend, 'revoke').mockImplementation((input) => {
      events.push(`revoke:${input.referenceId}`);
      expect(firstBackend.listReferences()).toContainEqual(
        expect.objectContaining({
          currentVersion: 3,
          referenceId: 'shared_openai_r1',
          revoked: false,
          versionCount: 3,
        })
      );
      expect(getVaultReference(fixture.coreDb, 'shared_openai_r1')).toMatchObject({
        currentVersion: 3,
        status: 'active',
      });
      return realRevoke(input);
    });

    const refresh = firstHandle.credentials.modify('openai-codex', async (current) => {
      events.push('refresh:start');
      expect(current).toEqual(oauthCredential('serialized-a-v1'));
      refreshEntered.resolve();
      await releaseRefresh.promise;
      events.push('refresh:end');
      return oauthCredential('serialized-a-v2');
    });
    await refreshEntered.promise;

    let secondModifyCallbackCalled = false;
    const secondSamePairModify = firstHandle.credentials.modify('openai-codex', async (current) => {
      secondModifyCallbackCalled = true;
      events.push('second-modify');
      expect(current).toEqual(oauthCredential('serialized-a-v2'));
      return oauthCredential('serialized-a-v3');
    });
    let deleteSettled = false;
    const deletion = firstHandle.credentials.delete('openai-codex').finally(() => {
      deleteSettled = true;
    });
    let resurrectionCallbackCalled = false;
    const queuedResurrection = firstHandle.credentials.modify('openai-codex', async () => {
      resurrectionCallbackCalled = true;
      return oauthCredential('must-not-resurrect');
    });
    const crossPair = secondHandle.credentials.modify('xai', async (current) => {
      events.push('cross-pair');
      expect(current).toEqual(oauthCredential('concurrent-b-v1'));
      return oauthCredential('concurrent-b-v2');
    });

    await expect(crossPair).resolves.toEqual(oauthCredential('concurrent-b-v2'));
    expect(events).toEqual(['refresh:start', 'cross-pair']);
    expect(deleteSettled).toBe(false);
    expect(secondModifyCallbackCalled).toBe(false);
    expect(resurrectionCallbackCalled).toBe(false);

    releaseRefresh.resolve();
    await expect(refresh).resolves.toEqual(oauthCredential('serialized-a-v2'));
    await expect(secondSamePairModify).resolves.toEqual(oauthCredential('serialized-a-v3'));
    await deletion;
    await expectAccountError(() => queuedResurrection, PERSISTENCE_ERROR);

    expect(resurrectionCallbackCalled).toBe(false);
    expect(events).toEqual([
      'refresh:start',
      'cross-pair',
      'refresh:end',
      'second-modify',
      'revoke:shared_openai_r1',
    ]);
    expect(firstBackend.listReferences()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentVersion: 3,
          referenceId: 'shared_openai_r1',
          revoked: true,
          versionCount: 3,
        }),
        expect.objectContaining({
          currentVersion: 2,
          referenceId: 'shared_xai_r1',
          revoked: false,
          versionCount: 2,
        }),
      ])
    );
    expect(getVaultReference(fixture.coreDb, 'shared_openai_r1')).toMatchObject({
      currentVersion: 3,
      status: 'revoked',
    });

    await fixture.manager.deleteAccount(firstPair, () => false);
    fixture.queueReferenceIds('shared_openai_r2');
    await fixture.manager.createAccount(firstPair);
    const freshHandle = await fixture.manager.getPairHandle(firstPair);

    expect(freshHandle).not.toBe(firstHandle);
    expect(freshHandle.credentials).not.toBe(firstHandle.credentials);
    expect(freshHandle.models).not.toBe(firstHandle.models);
    await expect(
      freshHandle.credentials.modify('openai-codex', async () => oauthCredential('fresh-r2'))
    ).resolves.toEqual(oauthCredential('fresh-r2'));
    await expect(freshHandle.credentials.read('openai-codex')).resolves.toEqual(
      oauthCredential('fresh-r2')
    );
    const staleBefore = authoritySnapshot(fixture);
    let staleCallbackCalled = false;

    for (const staleOperation of [
      () => firstHandle.credentials.read('openai-codex'),
      () =>
        firstHandle.credentials.modify('openai-codex', async () => {
          staleCallbackCalled = true;
          return oauthCredential('stale-write');
        }),
      () => firstHandle.credentials.delete('openai-codex'),
    ]) {
      await expectAccountError(staleOperation, PERSISTENCE_ERROR);
      expect(authoritySnapshot(fixture)).toEqual(staleBefore);
    }
    await expect(firstHandle.models.checkAuth('openai-codex')).rejects.toThrow();
    expect(staleCallbackCalled).toBe(false);
    expect(authoritySnapshot(fixture)).toEqual(staleBefore);
    expect(readAccountJson(fixture.dataRoot, firstPair)).toMatchObject({
      status: 'logged_in',
      vaultReferenceId: 'shared_openai_r2',
    });

    const boundFixture = createFixture();
    const boundPair = accountPair('queued_bound_delete');
    const boundHandle = await createStoredPair(
      boundFixture,
      boundPair,
      'queued_bound_delete_r1',
      oauthCredential('queued-bound-v1')
    );
    const boundRefreshEntered = deferredGate();
    const releaseBoundRefresh = deferredGate();
    const boundRevoke = vi.spyOn(boundFixture.backend(), 'revoke');
    const rotatedBoundCredential = oauthCredential('queued-bound-v2');
    const boundRefresh = boundHandle.credentials.modify(
      boundPair.subscriptionProviderId,
      async (current) => {
        expect(current).toEqual(oauthCredential('queued-bound-v1'));
        boundRefreshEntered.resolve();
        await releaseBoundRefresh.promise;
        return rotatedBoundCredential;
      }
    );
    await boundRefreshEntered.promise;
    let bound = false;
    let boundAuthority: AuthoritySnapshot | undefined;
    const isBound = vi.fn(() => {
      boundAuthority = authoritySnapshot(boundFixture);
      return bound;
    });
    const boundDeletion = boundFixture.manager.deleteAccount(boundPair, isBound);
    bound = true;
    releaseBoundRefresh.resolve();

    await boundRefresh;
    await expectAccountError(() => boundDeletion, ACCOUNT_BOUND_ERROR);
    expect(isBound.mock.calls).toEqual([[]]);
    expect(authoritySnapshot(boundFixture)).toEqual(boundAuthority);
    expect(boundRevoke).not.toHaveBeenCalled();
    expect(
      boundFixture.coreDb.sqlite
        .prepare(
          `SELECT action, error_code, outcome, resource, severity, summary
           FROM audit_events
           WHERE action = 'provider_subscription.account.delete'
           ORDER BY rowid DESC
           LIMIT 1`
        )
        .get()
    ).toMatchObject({
      action: 'provider_subscription.account.delete',
      error_code: ACCOUNT_BOUND_ERROR.code,
      outcome: 'failed',
      resource: 'provider-subscription:openai-codex:queued_bound_delete',
      severity: 'error',
      summary: 'Provider subscription account deletion failed.',
    });
  });

  it('caches one provider-only stock Models generation per pair and follows dynamic Vault replacement', async () => {
    const fixture = createFixture();
    const legacyRoot = mkdtempSync(join(tmpdir(), 'openkit-legacy-codex-home-'));
    extraTemporaryRoots.add(legacyRoot);
    writeFileSync(
      join(legacyRoot, 'auth.json'),
      JSON.stringify({
        'openai-codex': oauthCredential('legacy-file-must-be-ignored'),
      })
    );
    vi.stubEnv('CODEX_HOME', legacyRoot);
    vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key-must-be-ignored');
    vi.stubEnv('XAI_API_KEY', 'ambient-xai-key-must-be-ignored');

    const xaiPair = accountPair('xai_primary', 'xai');
    const secondXaiPair = accountPair('xai_secondary', 'xai');
    const codexPair = accountPair('codex_primary');
    await fixture.manager.createAccount(xaiPair);
    await fixture.manager.createAccount(secondXaiPair);
    await fixture.manager.createAccount(codexPair);

    const xaiHandle = await fixture.manager.getPairHandle(xaiPair);
    const cachedXaiHandle = await fixture.manager.getPairHandle(xaiPair);
    const secondXaiHandle = await fixture.manager.getPairHandle(secondXaiPair);
    const codexHandle = await fixture.manager.getPairHandle(codexPair);

    expect(cachedXaiHandle).toBe(xaiHandle);
    expect(cachedXaiHandle.credentials).toBe(xaiHandle.credentials);
    expect(cachedXaiHandle.models).toBe(xaiHandle.models);
    expect(xaiHandle.models.getProviders().map((provider) => provider.id)).toEqual(['xai']);
    expect(codexHandle.models.getProviders().map((provider) => provider.id)).toEqual([
      'openai-codex',
    ]);
    expect(secondXaiHandle).not.toBe(xaiHandle);
    expect(secondXaiHandle.credentials).not.toBe(xaiHandle.credentials);
    expect(secondXaiHandle.models).not.toBe(xaiHandle.models);
    expect(codexHandle.models).not.toBe(xaiHandle.models);
    await expect(xaiHandle.models.checkAuth('xai')).resolves.toBeUndefined();
    await expect(codexHandle.models.checkAuth('openai-codex')).resolves.toBeUndefined();

    fixture.queueReferenceIds('dynamic_backend_codex_r1');
    const codexCredential = oauthCredential('dynamic-backend-codex');
    await codexHandle.credentials.modify('openai-codex', async (current) => {
      expect(current).toBeUndefined();
      return codexCredential;
    });
    await expect(codexHandle.models.checkAuth('openai-codex')).resolves.toEqual({
      source: 'OAuth',
      type: 'oauth',
    });
    const codexAuth = await codexHandle.models.getAuth('openai-codex');
    expect(codexAuth).toMatchObject({ source: 'OAuth' });
    expect(JSON.stringify(codexAuth)).toContain(codexCredential.access);

    const dynamicBackend = fixture.vaultState.backend();
    const listReferenceInputs: unknown[] = [];
    const listReplacementBackend: VaultBackend = {
      health: () => dynamicBackend.health(),
      kind: dynamicBackend.kind,
      listReferences: (input) => {
        listReferenceInputs.push(input);
        return dynamicBackend.listReferences(input);
      },
      resolve: (input) => dynamicBackend.resolve(input),
      revoke: (input) => dynamicBackend.revoke(input),
      rotate: (input) => dynamicBackend.rotate(input),
      store: (input) => dynamicBackend.store(input),
    };

    fixture.resetBackendGetterCalls();
    fixture.replaceBackend(listReplacementBackend);
    await expect(xaiHandle.credentials.list()).resolves.toEqual([]);
    expect(listReferenceInputs).not.toEqual([]);
    const afterList = fixture.backendGetterCalls();
    expect(afterList).toBeGreaterThan(0);

    fixture.queueReferenceIds('dynamic_backend_r1');
    const credential = oauthCredential('dynamic-backend');
    const initialStoreInputs: unknown[] = [];
    const storeReplacementBackend: VaultBackend = {
      health: () => dynamicBackend.health(),
      kind: dynamicBackend.kind,
      listReferences: (input) => dynamicBackend.listReferences(input),
      resolve: (input) => dynamicBackend.resolve(input),
      revoke: (input) => dynamicBackend.revoke(input),
      rotate: (input) => dynamicBackend.rotate(input),
      store: (input) => {
        initialStoreInputs.push(input);
        return dynamicBackend.store(input);
      },
    };

    fixture.replaceBackend(storeReplacementBackend);
    await xaiHandle.credentials.modify('xai', async () => credential);
    expect(initialStoreInputs).toEqual([
      expect.objectContaining({ referenceId: 'dynamic_backend_r1' }),
    ]);
    const afterInitialStore = fixture.backendGetterCalls();
    expect(afterInitialStore).toBeGreaterThan(afterList);

    await expect(xaiHandle.models.checkAuth('xai')).resolves.toEqual({
      source: 'OAuth',
      type: 'oauth',
    });
    const afterCheckAuth = fixture.backendGetterCalls();
    expect(afterCheckAuth).toBeGreaterThan(afterInitialStore);
    const auth = await xaiHandle.models.getAuth('xai');

    expect(auth).toMatchObject({ source: 'OAuth' });
    expect(JSON.stringify(auth)).toContain(credential.access);
    await expect(secondXaiHandle.models.checkAuth('xai')).resolves.toBeUndefined();
    await expect(secondXaiHandle.models.getAuth('xai')).resolves.toBeUndefined();
    const afterGetAuth = fixture.backendGetterCalls();
    expect(afterGetAuth).toBeGreaterThan(afterCheckAuth);

    const rotatedCredential = oauthCredential('dynamic-backend-v2');
    const rotationInputs: unknown[] = [];
    const rotationReplacementBackend: VaultBackend = {
      health: () => dynamicBackend.health(),
      kind: dynamicBackend.kind,
      listReferences: (input) => dynamicBackend.listReferences(input),
      resolve: (input) => dynamicBackend.resolve(input),
      revoke: (input) => dynamicBackend.revoke(input),
      rotate: (input) => {
        rotationInputs.push(input);
        return dynamicBackend.rotate(input);
      },
      store: (input) => dynamicBackend.store(input),
    };

    fixture.replaceBackend(rotationReplacementBackend);
    await xaiHandle.credentials.modify('xai', async (current) => {
      expect(current).toEqual(credential);
      return rotatedCredential;
    });
    expect(rotationInputs).toEqual([
      expect.objectContaining({ referenceId: 'dynamic_backend_r1' }),
    ]);
    const afterRotation = fixture.backendGetterCalls();
    expect(afterRotation).toBeGreaterThan(afterGetAuth);
    await expect(xaiHandle.credentials.read('xai')).resolves.toEqual(rotatedCredential);
    const afterRead = fixture.backendGetterCalls();
    expect(afterRead).toBeGreaterThan(afterRotation);

    fixture.replaceBackend();
    fixture.vaultState.lock();
    await expectAccountError(() => xaiHandle.credentials.read('xai'), LOCKED_ERROR);
    const afterLockedRead = fixture.backendGetterCalls();
    expect(afterLockedRead).toBeGreaterThan(afterRead);
    fixture.vaultState.unlock({ masterKey: Buffer.alloc(32, 23) });
    const unlockedBackend = fixture.vaultState.backend();
    const replacementResolve = vi.spyOn(unlockedBackend, 'resolve');
    const replacementRevoke = vi.spyOn(unlockedBackend, 'revoke');
    const replacementBackend: VaultBackend = {
      health: unlockedBackend.health.bind(unlockedBackend),
      kind: unlockedBackend.kind,
      listReferences: unlockedBackend.listReferences.bind(unlockedBackend),
      resolve: (input) => unlockedBackend.resolve(input),
      revoke: (input) => unlockedBackend.revoke(input),
      rotate: unlockedBackend.rotate.bind(unlockedBackend),
      store: unlockedBackend.store.bind(unlockedBackend),
    };
    fixture.replaceBackend(replacementBackend);

    expect(await fixture.manager.getPairHandle(xaiPair)).toBe(xaiHandle);
    await expect(xaiHandle.credentials.read('xai')).resolves.toEqual(rotatedCredential);
    expect(replacementResolve).toHaveBeenCalled();
    const afterReplacementRead = fixture.backendGetterCalls();
    expect(afterReplacementRead).toBeGreaterThan(afterLockedRead);
    await xaiHandle.credentials.delete('xai');
    expect(replacementRevoke).toHaveBeenCalledTimes(1);
    expect(fixture.backendGetterCalls()).toBeGreaterThan(afterReplacementRead);
    await expect(xaiHandle.models.checkAuth('xai')).resolves.toBeUndefined();
    await expect(secondXaiHandle.models.checkAuth('xai')).resolves.toBeUndefined();
    expect(codexHandle.models.getProviders().map((provider) => provider.id)).toEqual([
      'openai-codex',
    ]);
  });

  it('emits exact lifecycle success and failure evidence while plaintext canaries stay encrypted', async () => {
    const fixture = createFixture();
    const pair = accountPair('audit_lifecycle');
    const accessCanary = 'access-canary-never-plaintext';
    const refreshCanary = 'refresh-canary-never-plaintext';
    const accountCanary = 'acct_raw_canary_never_plaintext';
    const emailCanary = 'raw-email-canary@example.invalid';
    const upstreamCanary = 'upstream-body-canary-never-plaintext';
    const logCanary = 'log-canary-never-plaintext';
    const pathCanary = fixture.dataRoot;
    const canaries = [
      accessCanary,
      refreshCanary,
      accountCanary,
      emailCanary,
      upstreamCanary,
      pathCanary,
      logCanary,
    ];
    const capturedConsole: unknown[][] = [];
    const consoleCapture = captureConsole(capturedConsole);
    vi.spyOn(console, 'debug').mockImplementation(consoleCapture);
    vi.spyOn(console, 'error').mockImplementation(consoleCapture);
    vi.spyOn(console, 'info').mockImplementation(consoleCapture);
    vi.spyOn(console, 'log').mockImplementation(consoleCapture);
    vi.spyOn(console, 'warn').mockImplementation(consoleCapture);
    fixture.queueReferenceIds('audit_r1');

    const created = await fixture.manager.createAccount({ ...pair, displayName: 'Audit Slot' });
    const updated = await fixture.manager.updateAccount(pair, {
      displayName: 'Audit Slot Renamed',
    });
    const handle = await fixture.manager.getPairHandle(pair);
    const firstCredential: OAuthCredential = {
      access: accessCanary,
      accountId: accountCanary,
      email: emailCanary,
      expires: Date.parse('2026-08-23T00:00:00.000Z'),
      logHint: logCanary,
      pathHint: pathCanary,
      refresh: refreshCanary,
      type: 'oauth',
      upstreamBody: upstreamCanary,
    };
    await handle.credentials.modify('openai-codex', async () => firstCredential);
    const firstEntry = join(fixture.dataRoot, 'server', 'vault', 'entries', 'audit_r1', '1.enc');

    expect(existsSync(firstEntry)).toBe(true);
    expect(findLiteralCanaryBytes(fixture.dataRoot, canaries)).toEqual([]);

    const rotatedCredential: OAuthCredential = {
      ...firstCredential,
      access: `${accessCanary}-rotated`,
      expires: Date.parse('2026-09-23T00:00:00.000Z'),
      refresh: `${refreshCanary}-rotated`,
    };
    await handle.credentials.modify('openai-codex', async (current) => {
      expect(current).toEqual(firstCredential);
      return rotatedCredential;
    });
    expect(fixture.backend().listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 2,
        referenceId: 'audit_r1',
        revoked: false,
        versionCount: 2,
      }),
    ]);
    expect(findLiteralCanaryBytes(fixture.dataRoot, canaries)).toEqual([]);

    const duplicateError = await expectAccountError(
      () => fixture.manager.createAccount(pair),
      ACCOUNT_EXISTS_ERROR
    );
    fixture.vaultState.lock();
    const lockedError = await expectAccountError(
      () => fixture.manager.reconcileAccount(pair),
      LOCKED_ERROR
    );
    fixture.vaultState.unlock({ masterKey: Buffer.alloc(32, 23) });
    await expect(handle.credentials.read('openai-codex')).resolves.toEqual(rotatedCredential);
    const reconciled = await fixture.manager.reconcileAccount(pair);
    const listed = await fixture.manager.listAccounts('openai-codex');
    const safeError = await expectAccountError(
      () => handle.credentials.read(`foreign-${upstreamCanary}`),
      PROVIDER_ERROR
    );
    await handle.credentials.delete('openai-codex');
    expect(findLiteralCanaryBytes(fixture.dataRoot, canaries)).toEqual([]);
    await fixture.manager.deleteAccount(pair, () => false);

    const expectedActions = [
      'provider_subscription.account.create',
      'provider_subscription.account.update',
      'provider_subscription.account.delete',
      'provider_subscription.credential.store',
      'provider_subscription.credential.rotate',
      'provider_subscription.credential.revoke',
      'provider_subscription.reconcile',
    ];
    const expectedSummaries: Record<string, string> = {
      'provider_subscription.account.create': 'Provider subscription account created.',
      'provider_subscription.account.delete': 'Provider subscription account deleted.',
      'provider_subscription.account.update': 'Provider subscription account updated.',
      'provider_subscription.credential.revoke': 'Provider subscription credential revoked.',
      'provider_subscription.credential.rotate': 'Provider subscription credential rotated.',
      'provider_subscription.credential.store': 'Provider subscription credential stored.',
      'provider_subscription.reconcile': 'Provider subscription account reconciled.',
    };
    const allAuditRows = fixture.coreDb.sqlite
      .prepare('SELECT rowid, * FROM audit_events ORDER BY rowid ASC')
      .all() as Array<{
      readonly action: string;
      readonly error_code: string | null;
      readonly outcome: string;
      readonly resource: string | null;
      readonly rowid: number;
      readonly summary: string;
      readonly [key: string]: unknown;
    }>;
    expect(
      allAuditRows.every(
        (row) => row.action === 'vault.resolve' || expectedActions.includes(row.action)
      )
    ).toBe(true);
    const providerAuditRows = allAuditRows.filter((row) => row.action !== 'vault.resolve');
    for (const row of providerAuditRows) {
      expect(row).toMatchObject({
        actor_json: null,
        agent_id: null,
        agent_session_id: null,
        capability_call_id: null,
        category: 'system',
        item_id: null,
        permission_decision_id: null,
        protocol_version: null,
        request_id: null,
        resource_revision: null,
        severity: row.outcome === 'succeeded' ? 'info' : 'error',
        subject_json: null,
        thread_id: null,
        turn_id: null,
        vault_grant_id: null,
        workspace_id: null,
      });
    }
    const lifecycleProjection = providerAuditRows.map((row) => ({
      action: row.action,
      error_code: row.error_code,
      outcome: row.outcome,
      resource: row.resource,
      summary: row.summary,
    }));

    expect([...new Set(providerAuditRows.map((row) => row.action))].sort()).toEqual(
      [...expectedActions].sort()
    );
    expect(lifecycleProjection).toEqual([
      {
        action: 'provider_subscription.account.create',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.account.create'],
      },
      {
        action: 'provider_subscription.account.update',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.account.update'],
      },
      {
        action: 'provider_subscription.credential.store',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.credential.store'],
      },
      {
        action: 'provider_subscription.credential.rotate',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.credential.rotate'],
      },
      {
        action: 'provider_subscription.account.create',
        error_code: ACCOUNT_EXISTS_ERROR.code,
        outcome: 'failed',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: 'Provider subscription account creation failed.',
      },
      {
        action: 'provider_subscription.reconcile',
        error_code: LOCKED_ERROR.code,
        outcome: 'failed',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: 'Provider subscription account reconciliation failed.',
      },
      {
        action: 'provider_subscription.reconcile',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.reconcile'],
      },
      {
        action: 'provider_subscription.credential.revoke',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.credential.revoke'],
      },
      {
        action: 'provider_subscription.account.delete',
        error_code: null,
        outcome: 'succeeded',
        resource: 'provider-subscription:openai-codex:audit_lifecycle',
        summary: expectedSummaries['provider_subscription.account.delete'],
      },
    ]);
    const forbiddenLifecycleValues = [...canaries, 'audit_r1', 'encrypted-file://'];
    for (const forbidden of forbiddenLifecycleValues) {
      expect(JSON.stringify(providerAuditRows)).not.toContain(forbidden);
    }
    for (const canary of canaries) {
      expect(JSON.stringify(allAuditRows)).not.toContain(canary);
    }

    const vaultResolveRows = allAuditRows.filter((row) => row.action === 'vault.resolve');
    const vaultUseRows = listVaultUseRecords(fixture.coreDb);

    expect(vaultResolveRows).toHaveLength(3);
    expect(vaultUseRows).toHaveLength(3);
    expect(vaultUseRows.map((row) => row.materialVersion).sort()).toEqual([1, 2, 2]);
    expect(new Set(vaultUseRows.map((row) => row.auditEventId))).toEqual(
      new Set(vaultResolveRows.map((row) => row.audit_event_id))
    );
    for (const use of vaultUseRows) {
      expect(use).toEqual({
        agentSessionId: null,
        auditEventId: expect.stringMatching(/^aud_/),
        backendKind: 'encrypted-file',
        capabilityCallId: null,
        failureCode: null,
        grantId: null,
        materialVersion: expect.any(Number),
        outcome: 'succeeded',
        ownerScope: 'server',
        planId: null,
        receiptId: null,
        resolvingPath: 'provider',
        usedAt: DEFAULT_TIME,
        useId: expect.any(String),
        vaultReferenceId: 'audit_r1',
        workspaceId: null,
      });
      expect(vaultResolveRows.find((row) => row.audit_event_id === use.auditEventId)).toMatchObject(
        {
          action: 'vault.resolve',
          audit_event_id: use.auditEventId,
          category: 'system',
          error_code: null,
          outcome: 'succeeded',
          resource: 'vault:audit_r1',
          severity: 'info',
          summary: 'Vault reference resolved.',
        }
      );
    }
    expect(fixture.backend().listReferences()).toEqual([
      expect.objectContaining({
        currentVersion: 2,
        referenceId: 'audit_r1',
        revoked: true,
        versionCount: 2,
      }),
    ]);

    const safeProjection = JSON.stringify({
      created,
      duplicateError: completeErrorProjection(duplicateError),
      error: completeErrorProjection(safeError),
      listed,
      lockedError: completeErrorProjection(lockedError),
      reconciled,
      updated,
    });
    const evidenceProjection = JSON.stringify({
      capturedConsole,
      providerAuditRows,
      vaultResolveRows,
      vaultUseRows,
    });

    for (const canary of [...canaries, 'audit_r1']) {
      expect(safeProjection).not.toContain(canary);
    }
    for (const canary of canaries) {
      expect(evidenceProjection).not.toContain(canary);
    }
    expect(capturedConsole).toEqual([]);
    expect(findLiteralCanaryBytes(fixture.dataRoot, canaries)).toEqual([]);

    const revokeFailureFixture = createFixture();
    const revokeFailurePair = accountPair('revoke_resolve_failure');
    const revokeFailureHandle = await createStoredPair(
      revokeFailureFixture,
      revokeFailurePair,
      'revoke_resolve_failure_r1'
    );
    const revokeFailureBackend = revokeFailureFixture.backend();
    const revokeFailureCanary = 'raw-revoke-resolve-failure-canary';
    const revokeFailureResolve = vi
      .spyOn(revokeFailureBackend, 'resolve')
      .mockImplementationOnce(() => {
        throw new Error(revokeFailureCanary);
      });
    const revokeFailureRevoke = vi.spyOn(revokeFailureBackend, 'revoke');
    const revokeFailureBefore = authoritySnapshot(revokeFailureFixture);
    const revokeFailureError = await expectAccountError(
      () => revokeFailureHandle.credentials.delete('openai-codex'),
      PERSISTENCE_ERROR
    );

    expect(revokeFailureResolve).toHaveBeenCalledTimes(1);
    expect(revokeFailureRevoke).not.toHaveBeenCalled();
    expect(authoritySnapshot(revokeFailureFixture)).toEqual(revokeFailureBefore);
    const revokeFailureAudit = revokeFailureFixture.coreDb.sqlite
      .prepare(
        `SELECT rowid, *
         FROM audit_events
         WHERE action = 'provider_subscription.credential.revoke'
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get();
    expect.soft(revokeFailureAudit).toMatchObject({
      action: 'provider_subscription.credential.revoke',
      error_code: PERSISTENCE_ERROR.code,
      outcome: 'failed',
      resource: 'provider-subscription:openai-codex:revoke_resolve_failure',
      severity: 'error',
      summary: 'Provider subscription credential revocation failed.',
    });
    expect(
      JSON.stringify({
        audit: revokeFailureAudit,
        error: completeErrorProjection(revokeFailureError),
      })
    ).not.toContain(revokeFailureCanary);

    const rawAuditFixture = createFixture();
    const rawAuditPair = accountPair('raw_audit_insert');
    await rawAuditFixture.manager.createAccount(rawAuditPair);
    const rawAuditCanary = 'raw-audit-insert-failure-canary';
    rawAuditFixture.coreDb.sqlite.exec(`CREATE TEMP TRIGGER fail_raw_audit_insert
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(FAIL, '${rawAuditCanary}');
      END`);

    let rawAuditError: unknown;
    try {
      await rawAuditFixture.manager.updateAccount(rawAuditPair, { displayName: 'Still Safe' });
    } catch (error) {
      rawAuditError = error;
    }
    expect.soft(rawAuditError).toBeInstanceOf(ProviderSubscriptionAccountError);
    expect.soft(rawAuditError).toMatchObject(PERSISTENCE_ERROR);
    expect.soft((rawAuditError as Error | undefined)?.message).toBe(PERSISTENCE_ERROR.message);
    rawAuditFixture.coreDb.sqlite.exec('DROP TRIGGER fail_raw_audit_insert');
    const injectedFailureCanaries = [revokeFailureCanary, rawAuditCanary];
    const injectedFailureEvidence = JSON.stringify({
      capturedConsole,
      rawAuditError: completeErrorProjection(rawAuditError),
      revokeFailureAudit,
      revokeFailureError: completeErrorProjection(revokeFailureError),
    });
    for (const canary of injectedFailureCanaries) {
      expect.soft(injectedFailureEvidence).not.toContain(canary);
    }
    expect.soft(capturedConsole).toEqual([]);
    for (const root of [revokeFailureFixture.dataRoot, rawAuditFixture.dataRoot]) {
      expect.soft(findLiteralCanaryBytes(root, injectedFailureCanaries)).toEqual([]);
    }
  });

  it('fails both pre-accept provider terminal outcomes without credential or authority writes', async () => {
    for (const outcome of ['reject', 'resolve'] as const) {
      const fixture = createFixture();
      const pair = accountPair(`pre_accept_${outcome}`);
      await fixture.manager.createAccount(pair);
      const handle = await fixture.manager.getPairHandle(pair);
      const oauth = requireProviderOAuth(handle, pair);
      const modify = vi.spyOn(handle.credentials, 'modify');
      const canary = `raw-pre-accept-${outcome}-canary`;
      const before = authoritySnapshot(fixture);

      vi.spyOn(oauth, 'login').mockImplementation(async () => {
        if (outcome === 'reject') {
          throw new Error(canary);
        }
        return oauthCredential(canary);
      });

      const failure = await expectAccountError(
        () => lifecycleOperations(fixture.manager).startLogin(pair),
        PROVIDER_UNAVAILABLE_ERROR
      );

      expect(modify).not.toHaveBeenCalled();
      expect(authoritySnapshot(fixture)).toEqual(before);
      expect(JSON.stringify(completeErrorProjection(failure))).not.toContain(canary);
    }
  });

  it('admits one simultaneous start and projects accepted success or failure through manager state', async () => {
    const fixture = createFixture();
    const pair = accountPair('simultaneous_start');
    fixture.queueReferenceIds('simultaneous_start_r1');
    await fixture.manager.createAccount(pair);
    const handle = await fixture.manager.getPairHandle(pair);
    const oauth = requireProviderOAuth(handle, pair);
    const modelsLogin = vi.spyOn(handle.models, 'login');
    const releaseLogin = deferredGate();
    const credentialStored = deferredGate();
    const credential = oauthCredential('simultaneous-success');
    const realModify = handle.credentials.modify.bind(handle.credentials);
    const modify = vi
      .spyOn(handle.credentials, 'modify')
      .mockImplementation(async (providerId, update) => {
        const result = await realModify(providerId, update);
        credentialStored.resolve();
        return result;
      });

    vi.spyOn(oauth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'SIMULTANEOUS',
        verificationUri: 'https://login.example.test/simultaneous',
      });
      await releaseLogin.promise;
      return credential;
    });

    const lifecycle = lifecycleOperations(fixture.manager);
    const starts = await Promise.allSettled([
      lifecycle.startLogin(pair),
      lifecycle.startLogin(pair),
    ]);
    const accepted = starts.filter(
      (result): result is PromiseFulfilledResult<ManagerLifecycleSnapshot> =>
        result.status === 'fulfilled'
    );
    const rejected = starts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.value).toMatchObject({
      interaction: {
        mode: 'device_code',
        userCode: 'SIMULTANEOUS',
        verificationUrl: 'https://login.example.test/simultaneous',
      },
      status: 'pending',
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ProviderSubscriptionAccountError);
    expect(rejected[0]?.reason).toMatchObject(LOGIN_ACTIVE_ERROR);

    releaseLogin.resolve();
    await credentialStored.promise;
    await expect(handle.credentials.read(pair.subscriptionProviderId)).resolves.toEqual(credential);
    await expect(lifecycle.getStatus(pair)).resolves.toMatchObject({ status: 'logged_in' });
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modelsLogin).not.toHaveBeenCalled();

    const failureFixture = createFixture();
    const failurePair = accountPair('accepted_failure');
    await failureFixture.manager.createAccount(failurePair);
    const failureHandle = await failureFixture.manager.getPairHandle(failurePair);
    const failureOAuth = requireProviderOAuth(failureHandle, failurePair);
    const failureModify = vi.spyOn(failureHandle.credentials, 'modify');
    const canary = 'raw-accepted-provider-failure-canary';
    const failureBefore = authoritySnapshot(failureFixture);

    vi.spyOn(failureOAuth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'FAIL-LATER',
        verificationUri: 'https://login.example.test/fail-later',
      });
      throw new Error(canary);
    });

    const failureLifecycle = lifecycleOperations(failureFixture.manager);
    await expect(failureLifecycle.startLogin(failurePair)).resolves.toMatchObject({
      status: 'pending',
    });
    const failureStatus = await failureLifecycle.getStatus(failurePair);

    expect(failureStatus).toMatchObject({
      message: LOGIN_ERROR_MESSAGE,
      status: 'error',
    });
    expect(JSON.stringify(failureStatus)).not.toContain(canary);
    expect(failureModify).not.toHaveBeenCalled();
    expect(authoritySnapshot(failureFixture)).toEqual(failureBefore);
  });

  it('linearizes delete against start and keeps cancellation settling until stale completion is inert', async () => {
    const deleteFirstFixture = createFixture();
    const deleteFirstPair = accountPair('delete_first');
    await deleteFirstFixture.manager.createAccount(deleteFirstPair);
    const deleteFirstLifecycle = lifecycleOperations(deleteFirstFixture.manager);
    const deletion = deleteFirstFixture.manager.deleteAccount(deleteFirstPair, () => false);
    const lateStart = deleteFirstLifecycle.startLogin(deleteFirstPair);

    await expect(deletion).resolves.toBeUndefined();
    await expectAccountError(() => lateStart, ACCOUNT_NOT_FOUND_ERROR);

    const fixture = createFixture();
    const pair = accountPair('start_first', 'xai');
    await fixture.manager.createAccount(pair);
    const handle = await fixture.manager.getPairHandle(pair);
    const oauth = requireProviderOAuth(handle, pair);
    const modelsLogin = vi.spyOn(handle.models, 'login');
    const releaseProvider = deferredGate();
    const modifyEntered = deferredGate();
    const releaseModify = deferredGate();
    const updaterResults = vi.fn();
    const aborted = deferredGate();
    const realModify = handle.credentials.modify.bind(handle.credentials);
    const modify = vi
      .spyOn(handle.credentials, 'modify')
      .mockImplementation(async (providerId, update) => {
        modifyEntered.resolve();
        await releaseModify.promise;
        return realModify(providerId, async () => {
          const result = await update(oauthCredential('cancelled-existing'));
          updaterResults(result);
          return result;
        });
      });
    const before = authoritySnapshot(fixture);

    vi.spyOn(oauth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.signal?.addEventListener('abort', aborted.resolve, { once: true });
      interaction.notify({
        type: 'device_code',
        userCode: 'CANCEL-LATE',
        verificationUri: 'https://login.example.test/cancel-late',
      });
      await releaseProvider.promise;
      return oauthCredential('cancelled-late-success');
    });

    const lifecycle = lifecycleOperations(fixture.manager);
    const pending = await lifecycle.startLogin(pair);
    expect(pending).toMatchObject({ status: 'pending' });
    await expectAccountError(
      () => fixture.manager.deleteAccount(pair, () => false),
      LOGIN_ACTIVE_ERROR
    );

    releaseProvider.resolve();
    await modifyEntered.promise;
    const cancellation = lifecycle.cancelLogin(pair, pending.interaction?.interactionId ?? '');
    await aborted.promise;
    await expectAccountError(() => lifecycle.startLogin(pair), LOGIN_ACTIVE_ERROR);
    await expectAccountError(
      () => fixture.manager.deleteAccount(pair, () => false),
      LOGIN_ACTIVE_ERROR
    );
    releaseModify.resolve();

    await expect(cancellation).resolves.toMatchObject({ status: 'logged_out' });
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modelsLogin).not.toHaveBeenCalled();
    await expect(handle.credentials.read(pair.subscriptionProviderId)).resolves.toBeUndefined();
    expect(authoritySnapshot(fixture)).toEqual(before);
    expect(updaterResults.mock.calls).toEqual([[undefined]]);
  });

  it('rejects invalid account authority before login conflict or binding evaluation', async () => {
    const fixture = createFixture();
    const pair = accountPair('login_invalid_delete');
    await fixture.manager.createAccount(pair);
    const handle = await fixture.manager.getPairHandle(pair);
    const oauth = requireProviderOAuth(handle, pair);
    const aborted = vi.fn();
    vi.spyOn(oauth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'INVALID-DELETE',
        verificationUri: 'https://login.example.test/invalid-delete',
      });
      return new Promise<OAuthCredential>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(aborted()), { once: true });
      });
    });
    await expect(lifecycleOperations(fixture.manager).startLogin(pair)).resolves.toMatchObject({
      status: 'pending',
    });
    writeAccountJson(
      fixture.dataRoot,
      pair,
      validAccountRecord(pair, { vaultReferenceId: 'login_invalid_delete_r1' })
    );
    createExactCoreReference(fixture, 'login_invalid_delete_r1');
    const isBound = vi.fn(() => true);

    await expectAccountError(() => fixture.manager.deleteAccount(pair, isBound), PERSISTENCE_ERROR);
    expect(isBound).not.toHaveBeenCalled();
    expect(aborted).not.toHaveBeenCalled();
  });

  it('rejects invalid account authority before cancelling an accepted login', async () => {
    const fixture = createFixture();
    const pair = accountPair('login_invalid_cancel');
    await fixture.manager.createAccount(pair);
    const handle = await fixture.manager.getPairHandle(pair);
    const oauth = requireProviderOAuth(handle, pair);
    const aborted = vi.fn();
    vi.spyOn(oauth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'INVALID-CANCEL',
        verificationUri: 'https://login.example.test/invalid-cancel',
      });
      return new Promise<OAuthCredential>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(aborted()), { once: true });
      });
    });
    const lifecycle = lifecycleOperations(fixture.manager);
    const pending = await lifecycle.startLogin(pair);
    writeAccountJson(
      fixture.dataRoot,
      pair,
      validAccountRecord(pair, { vaultReferenceId: 'login_invalid_cancel_r1' })
    );
    createExactCoreReference(fixture, 'login_invalid_cancel_r1');

    await expectAccountError(
      () => lifecycle.cancelLogin(pair, pending.interaction?.interactionId ?? ''),
      PERSISTENCE_ERROR
    );
    expect(aborted).not.toHaveBeenCalled();
  });

  it('lets admitted refresh finish before logout and blocks starts until logout settlement', async () => {
    const refreshFixture = createFixture();
    const refreshPair = accountPair('refresh_then_logout');
    const refreshHandle = await createStoredPair(
      refreshFixture,
      refreshPair,
      'refresh_then_logout_r1',
      oauthCredential('refresh-v1')
    );
    const refreshEntered = deferredGate();
    const releaseRefresh = deferredGate();
    const events: string[] = [];
    const backend = refreshFixture.backend();
    const realRevoke = backend.revoke.bind(backend);

    vi.spyOn(backend, 'revoke').mockImplementation((input) => {
      events.push('logout:revoke');
      expect(backend.listReferences()).toContainEqual(
        expect.objectContaining({
          currentVersion: 2,
          referenceId: 'refresh_then_logout_r1',
          revoked: false,
        })
      );
      return realRevoke(input);
    });

    const refresh = refreshHandle.credentials.modify(
      refreshPair.subscriptionProviderId,
      async (current) => {
        events.push('refresh:start');
        expect(current).toEqual(oauthCredential('refresh-v1'));
        refreshEntered.resolve();
        await releaseRefresh.promise;
        events.push('refresh:end');
        return oauthCredential('refresh-v2');
      }
    );
    await refreshEntered.promise;
    let logoutSettled = false;
    const logout = lifecycleOperations(refreshFixture.manager)
      .logout(refreshPair)
      .finally(() => {
        logoutSettled = true;
      });

    expect(logoutSettled).toBe(false);
    expect(events).toEqual(['refresh:start']);
    releaseRefresh.resolve();
    await expect(refresh).resolves.toEqual(oauthCredential('refresh-v2'));
    await expect(logout).resolves.toMatchObject({ status: 'logged_out' });
    expect(events).toEqual(['refresh:start', 'refresh:end', 'logout:revoke']);
    await expect(
      refreshHandle.credentials.read(refreshPair.subscriptionProviderId)
    ).resolves.toBeUndefined();

    const settlingFixture = createFixture();
    const settlingPair = accountPair('logout_settling');
    await settlingFixture.manager.createAccount(settlingPair);
    const settlingHandle = await settlingFixture.manager.getPairHandle(settlingPair);
    const settlingOAuth = requireProviderOAuth(settlingHandle, settlingPair);
    const releaseProvider = deferredGate();
    const aborted = deferredGate();
    const settlingBefore = authoritySnapshot(settlingFixture);

    vi.spyOn(settlingOAuth, 'login').mockImplementation(async (interaction: AuthInteraction) => {
      interaction.signal?.addEventListener('abort', aborted.resolve, { once: true });
      interaction.notify({
        type: 'device_code',
        userCode: 'LOGOUT-LATE',
        verificationUri: 'https://login.example.test/logout-late',
      });
      await releaseProvider.promise;
      return oauthCredential('logout-late-success');
    });

    const settlingLifecycle = lifecycleOperations(settlingFixture.manager);
    await expect(settlingLifecycle.startLogin(settlingPair)).resolves.toMatchObject({
      status: 'pending',
    });
    const settlingLogout = settlingLifecycle.logout(settlingPair);
    await aborted.promise;
    await expectAccountError(() => settlingLifecycle.startLogin(settlingPair), LOGIN_ACTIVE_ERROR);
    releaseProvider.resolve();

    await expect(settlingLogout).resolves.toMatchObject({ status: 'logged_out' });
    await expect(
      settlingHandle.credentials.read(settlingPair.subscriptionProviderId)
    ).resolves.toBeUndefined();
    expect(authoritySnapshot(settlingFixture)).toEqual(settlingBefore);
  });

  it('rejects invalid account authority before aborting login or invoking Models logout', async () => {
    const invalidLogoutFixture = createFixture();
    const invalidLogoutPair = accountPair('login_invalid_logout');
    await invalidLogoutFixture.manager.createAccount(invalidLogoutPair);
    const invalidLogoutHandle = await invalidLogoutFixture.manager.getPairHandle(invalidLogoutPair);
    const invalidLogoutOAuth = requireProviderOAuth(invalidLogoutHandle, invalidLogoutPair);
    const invalidLogoutAbort = vi.fn();
    const invalidModelsLogout = vi.spyOn(invalidLogoutHandle.models, 'logout');
    vi.spyOn(invalidLogoutOAuth, 'login').mockImplementation(
      async (interaction: AuthInteraction) => {
        interaction.notify({
          type: 'device_code',
          userCode: 'INVALID-LOGOUT',
          verificationUri: 'https://login.example.test/invalid-logout',
        });
        return new Promise<OAuthCredential>((_resolve, reject) => {
          interaction.signal?.addEventListener('abort', () => reject(invalidLogoutAbort()), {
            once: true,
          });
        });
      }
    );
    await expect(
      lifecycleOperations(invalidLogoutFixture.manager).startLogin(invalidLogoutPair)
    ).resolves.toMatchObject({ status: 'pending' });
    writeAccountJson(
      invalidLogoutFixture.dataRoot,
      invalidLogoutPair,
      validAccountRecord(invalidLogoutPair, {
        vaultReferenceId: 'login_invalid_logout_r1',
      })
    );
    createExactCoreReference(invalidLogoutFixture, 'login_invalid_logout_r1');

    await expectAccountError(
      () => lifecycleOperations(invalidLogoutFixture.manager).logout(invalidLogoutPair),
      PERSISTENCE_ERROR
    );
    expect(invalidLogoutAbort).not.toHaveBeenCalled();
    expect(invalidModelsLogout).not.toHaveBeenCalled();
  });

  it.each([
    {
      backendCode: 'vault-locked',
      expected: LOCKED_ERROR,
      slot: 'logout_locked',
    },
    {
      backendCode: 'backend-unavailable',
      expected: VAULT_UNAVAILABLE_ERROR,
      slot: 'logout_unavailable',
    },
  ] as const)('maps stock Models logout $backendCode failures without changing authority', async (failure) => {
    const fixture = createFixture();
    const pair = accountPair(failure.slot);
    await createStoredPair(fixture, pair, `${failure.slot}_r1`);
    const revoke = vi.spyOn(fixture.backend(), 'revoke').mockImplementation(() => {
      throw new VaultBackendError(failure.backendCode, 'Private backend failure.');
    });
    const before = authoritySnapshot(fixture);

    await expectAccountError(
      () => lifecycleOperations(fixture.manager).logout(pair),
      failure.expected
    );
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(authoritySnapshot(fixture)).toEqual(before);
  });

  it('continues logout from a current credential tombstone without retrying Vault writes', async () => {
    const tombstoneFixture = createFixture();
    const tombstonePair = accountPair('logout_current_tombstone');
    const tombstoneHandle = await createStoredPair(
      tombstoneFixture,
      tombstonePair,
      'logout_current_tombstone_r1'
    );
    tombstoneFixture.backend().revoke({ referenceId: 'logout_current_tombstone_r1' });
    const tombstoneRetryWrites = [
      vi.spyOn(tombstoneFixture.backend(), 'store'),
      vi.spyOn(tombstoneFixture.backend(), 'rotate'),
      vi.spyOn(tombstoneFixture.backend(), 'revoke'),
    ];

    await expect(
      lifecycleOperations(tombstoneFixture.manager).logout(tombstonePair)
    ).resolves.toMatchObject({ status: 'logged_out' });
    for (const write of tombstoneRetryWrites) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(readAccountJson(tombstoneFixture.dataRoot, tombstonePair)).toEqual({
      accountSlotId: 'logout_current_tombstone',
      createdAt: DEFAULT_TIME,
      schemaVersion: 1,
      status: 'logged_out',
      subscriptionProviderId: 'openai-codex',
      updatedAt: DEFAULT_TIME,
    });
    expect(getVaultReference(tombstoneFixture.coreDb, 'logout_current_tombstone_r1')).toMatchObject(
      {
        currentVersion: 1,
        status: 'revoked',
      }
    );
    await expect(
      tombstoneHandle.credentials.read(tombstonePair.subscriptionProviderId)
    ).resolves.toBeUndefined();
  });
});
