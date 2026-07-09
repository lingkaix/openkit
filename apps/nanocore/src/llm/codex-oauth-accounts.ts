import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID,
  validateCodexOAuthAccountSlotId,
} from '../providers/codex-oauth-profile.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  type CodexAccountClientFactory,
  type CodexOAuthLoginMode,
  type CodexOAuthStatus,
  type CodexOAuthStatusPayload,
  CodexOAuthStore,
} from './codex-oauth.js';

export { CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID, validateCodexOAuthAccountSlotId };

/**
 * Persisted server-owned Codex OAuth account slot metadata.
 */
export interface CodexOAuthAccountMetadata {
  /** Metadata schema version. */
  readonly schemaVersion: 1;
  /** Server-owned account slot id. */
  readonly accountSlotId: string;
  /** Human-readable slot label. */
  readonly displayName?: string;
  /** Last known sanitized auth status. */
  readonly status: CodexOAuthStatus;
  /** Last known ChatGPT account label. */
  readonly accountLabel?: string;
  /** Last known ChatGPT plan label. */
  readonly planType?: string;
  /** ISO timestamp for the last metadata update. */
  readonly lastUpdatedAt: string;
  /** Last public error message. */
  readonly lastError?: string;
  /** Last login mode used for this slot. */
  readonly lastLoginMode?: CodexOAuthLoginMode;
}

/**
 * Public account slot summary returned to app API callers.
 */
export interface CodexOAuthAccountSummary extends CodexOAuthStatusPayload {
  /** Server-owned account slot id. */
  readonly accountSlotId: string;
  /** Whether this account slot is the default unscoped slot. */
  readonly isDefault: boolean;
  /** Runtime provider ids bound to this account slot. */
  readonly boundProviderIds: string[];
}

/**
 * Public account list payload returned by the app API.
 */
export interface CodexOAuthAccountsPayload {
  /** Account slot summaries. */
  readonly accounts: CodexOAuthAccountSummary[];
  /** Account slot id marked as the default account. */
  readonly defaultAccountSlotId: string;
}

/**
 * Input used to create one account slot.
 */
export interface CodexOAuthAccountCreateInput {
  /** Server-owned account slot id. */
  readonly accountSlotId: string;
  /** Optional human-readable account slot label. */
  readonly displayName?: string;
}

/**
 * Input used to rename one account slot.
 */
export interface CodexOAuthAccountUpdateInput {
  /** Human-readable account slot label. */
  readonly displayName: string;
}

/**
 * Options for CodexOAuthAccountManager.
 */
export interface CodexOAuthAccountManagerOptions {
  /** NanoCore data root that owns server/files/oauth. */
  readonly dataRoot: string | null;
  /** Optional fake or alternate Codex app-server client factory. */
  readonly clientFactory?: CodexAccountClientFactory;
  /** Clock used for deterministic metadata tests. */
  readonly now?: () => string;
  /** Resolves the account slot marked as default in account lists. */
  readonly resolveDefaultAccountSlotId?: () => string | null;
  /** Resolves runtime provider ids bound to one account slot. */
  readonly resolveBoundProviderIds?: (accountSlotId: string) => string[];
}

const ACCOUNT_METADATA_FILE = 'account.json';

/**
 * Data-root backed metadata store for one server-owned Codex OAuth account slot.
 */
export class CodexOAuthAccountStore {
  private metadata: CodexOAuthAccountMetadata | null = null;

  /**
   * Creates one account slot metadata store.
   *
   * @param dataRoot NanoCore data root, or null for in-memory tests.
   * @param accountSlotId Account slot id.
   * @param now Clock used for metadata timestamps.
   */
  public constructor(
    private readonly dataRoot: string | null,
    private readonly accountSlotId: string,
    private readonly now: () => string
  ) {
    validateCodexOAuthAccountSlotId(accountSlotId);
  }

  /**
   * Ensures the account slot exists.
   *
   * @param displayName Optional display name used only when the slot is first created.
   * @returns Current metadata.
   */
  public ensure(displayName?: string): CodexOAuthAccountMetadata {
    if (this.dataRoot) {
      mkdirSync(this.accountRoot(), { recursive: true });
      mkdirSync(this.codexHome(), { recursive: true });

      if (!existsSync(this.metadataPath())) {
        this.writeMetadata(this.defaultMetadata(displayName));
      }

      return this.readMetadata();
    }

    this.metadata ??= this.defaultMetadata(displayName);
    return this.metadata;
  }

  /**
   * Reads account metadata, creating a logged-out record when absent.
   *
   * @returns Current metadata.
   */
  public readMetadata(): CodexOAuthAccountMetadata {
    if (!this.dataRoot) {
      return this.ensure();
    }

    if (!existsSync(this.metadataPath())) {
      return this.ensure();
    }

    return sanitizeMetadata(
      JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as Record<string, unknown>,
      this.accountSlotId,
      this.now
    );
  }

  /**
   * Persists a display name change.
   *
   * @param displayName New display name.
   * @returns Updated metadata.
   */
  public updateDisplayName(displayName: string): CodexOAuthAccountMetadata {
    return this.writeMetadata({
      ...this.readMetadata(),
      displayName,
      lastUpdatedAt: this.now(),
    });
  }

  /**
   * Persists sanitized status changes from CodexOAuthStore.
   *
   * @param status Public status payload.
   * @returns Updated metadata.
   */
  public updateFromStatus(status: CodexOAuthStatusPayload): CodexOAuthAccountMetadata {
    const previous = this.readMetadata();

    return this.writeMetadata({
      schemaVersion: 1,
      accountSlotId: this.accountSlotId,
      ...(previous.displayName ? { displayName: previous.displayName } : {}),
      status: status.status,
      ...(status.accountLabel ? { accountLabel: status.accountLabel } : {}),
      ...(status.planType ? { planType: status.planType } : {}),
      lastUpdatedAt: this.now(),
      ...(status.message ? { lastError: status.message } : {}),
      ...(status.mode ? { lastLoginMode: status.mode } : {}),
    });
  }

  /**
   * Returns the slot-specific Codex home path.
   *
   * @returns Codex home path.
   */
  public codexHome(): string {
    return this.dataRoot ? join(this.accountRoot(), 'codex-home') : '';
  }

  /**
   * Deletes the account slot directory or in-memory metadata.
   */
  public delete(): void {
    if (this.dataRoot && existsSync(this.accountRoot())) {
      rmSync(this.accountRoot(), { recursive: true, force: true });
    }

    this.metadata = null;
  }

  private writeMetadata(metadata: CodexOAuthAccountMetadata): CodexOAuthAccountMetadata {
    const sanitized = sanitizeMetadata(
      metadata as unknown as Record<string, unknown>,
      this.accountSlotId,
      this.now
    );

    if (this.dataRoot) {
      mkdirSync(this.accountRoot(), { recursive: true });
      writeFileSync(this.metadataPath(), `${JSON.stringify(sanitized, null, 2)}\n`);
    }

    this.metadata = sanitized;
    return sanitized;
  }

  private defaultMetadata(displayName?: string): CodexOAuthAccountMetadata {
    return {
      schemaVersion: 1,
      accountSlotId: this.accountSlotId,
      ...(displayName ? { displayName } : {}),
      status: 'logged_out',
      lastUpdatedAt: this.now(),
    };
  }

  private accountRoot(): string {
    if (!this.dataRoot) {
      throw new Error('Codex OAuth account storage has no data root.');
    }

    return resolveDataRootPath(
      this.dataRoot,
      'server',
      'files',
      'oauth',
      'openai-codex',
      'accounts',
      this.accountSlotId
    );
  }

  private metadataPath(): string {
    return join(this.accountRoot(), ACCOUNT_METADATA_FILE);
  }
}

/**
 * Coordinates server-owned Codex OAuth account slots.
 */
export class CodexOAuthAccountManager {
  private readonly accountStores = new Map<string, CodexOAuthAccountStore>();
  private readonly oauthStores = new Map<string, CodexOAuthStore>();
  private readonly clientFactory: CodexAccountClientFactory | undefined;
  private readonly now: () => string;
  private readonly resolveDefaultAccountSlotId: () => string | null;
  private readonly resolveBoundProviderIds: (accountSlotId: string) => string[];

  /**
   * Creates one account manager.
   *
   * @param options Account manager dependencies.
   */
  public constructor(private readonly options: CodexOAuthAccountManagerOptions) {
    this.clientFactory = options.clientFactory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.resolveDefaultAccountSlotId =
      options.resolveDefaultAccountSlotId ?? (() => CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID);
    this.resolveBoundProviderIds = options.resolveBoundProviderIds ?? (() => []);
  }

  /**
   * Lists all known server-owned account slots.
   *
   * @returns Public account list payload.
   */
  public async listAccounts(): Promise<CodexOAuthAccountsPayload> {
    const defaultAccountSlotId = this.defaultAccountSlotId();
    const accountSlotIds = new Set([
      defaultAccountSlotId,
      ...this.accountStores.keys(),
      ...this.readFilesystemSlotIds(),
    ]);
    const accounts = [...accountSlotIds]
      .sort()
      .map((accountSlotId) =>
        this.summaryFromMetadata(
          this.accountStore(accountSlotId).readMetadata(),
          defaultAccountSlotId
        )
      );

    return { accounts, defaultAccountSlotId };
  }

  /**
   * Creates a new server-owned account slot.
   *
   * @param input Account creation input.
   * @returns Created public account summary.
   */
  public async createAccount(
    input: CodexOAuthAccountCreateInput
  ): Promise<CodexOAuthAccountSummary> {
    const accountSlotId = validateCodexOAuthAccountSlotId(input.accountSlotId);
    const existing = this.slotExists(accountSlotId);

    if (existing) {
      throw new Error(`Codex OAuth account slot already exists: ${accountSlotId}`);
    }

    const store = this.accountStore(accountSlotId);
    return this.summaryFromMetadata(store.ensure(input.displayName), this.defaultAccountSlotId());
  }

  /**
   * Renames an account slot.
   *
   * @param accountSlotId Account slot id.
   * @param input Account update input.
   * @returns Updated public account summary.
   */
  public async updateAccount(
    accountSlotId: string,
    input: CodexOAuthAccountUpdateInput
  ): Promise<CodexOAuthAccountSummary> {
    const metadata = this.accountStore(accountSlotId).updateDisplayName(input.displayName);

    this.oauthStores.delete(accountSlotId);
    return this.summaryFromMetadata(metadata, this.defaultAccountSlotId());
  }

  /**
   * Deletes one account slot when it is not pending or bound.
   *
   * @param accountSlotId Account slot id.
   */
  public async deleteAccount(accountSlotId: string): Promise<void> {
    const store = this.accountStore(accountSlotId);
    const metadata = store.readMetadata();
    const liveStatus = this.oauthStores.get(accountSlotId)?.getLastStatus();

    if (metadata.status === 'pending' || liveStatus?.status === 'pending') {
      throw new Error(
        `Cannot delete Codex OAuth account slot with a pending login: ${accountSlotId}`
      );
    }

    if (this.resolveBoundProviderIds(accountSlotId).length > 0) {
      throw new Error(
        `Cannot delete Codex OAuth account slot bound to a provider: ${accountSlotId}`
      );
    }

    await this.oauthStores
      .get(accountSlotId)
      ?.logout()
      .catch(() => undefined);
    this.oauthStores.delete(accountSlotId);
    store.delete();
    this.accountStores.delete(accountSlotId);
  }

  /**
   * Reads the current status for one account slot.
   *
   * @param accountSlotId Account slot id.
   * @returns Public OAuth status.
   */
  public async getStatus(accountSlotId: string): Promise<CodexOAuthStatusPayload> {
    return this.oauthStore(this.validateSlot(accountSlotId)).getStatus();
  }

  /**
   * Reads the cached status for one account slot without probing Codex.
   *
   * @param accountSlotId Account slot id.
   * @returns Cached public OAuth status.
   */
  public getLastStatus(accountSlotId: string): CodexOAuthStatusPayload {
    return this.oauthStore(this.validateSlot(accountSlotId)).getLastStatus();
  }

  /**
   * Starts login for one account slot.
   *
   * @param accountSlotId Account slot id.
   * @param mode Login mode.
   * @returns Pending public status.
   */
  public async start(
    accountSlotId: string,
    mode: CodexOAuthLoginMode = 'browser'
  ): Promise<CodexOAuthStatusPayload> {
    return this.oauthStore(this.validateSlot(accountSlotId)).start(mode);
  }

  /**
   * Cancels login for one account slot.
   *
   * @param accountSlotId Account slot id.
   * @param loginId Optional Codex login id.
   * @returns Public status after cancellation.
   */
  public async cancel(accountSlotId: string, loginId?: string): Promise<CodexOAuthStatusPayload> {
    return this.oauthStore(this.validateSlot(accountSlotId)).cancel(loginId);
  }

  /**
   * Logs out one account slot.
   *
   * @param accountSlotId Account slot id.
   * @returns Public status after logout.
   */
  public async logout(accountSlotId: string): Promise<CodexOAuthStatusPayload> {
    return this.oauthStore(this.validateSlot(accountSlotId)).logout();
  }

  /**
   * Refreshes and reads the account state for token resolution.
   *
   * @param accountSlotId Account slot id.
   * @returns Codex app-server account response.
   */
  public async readAccountForTokenRefresh(
    accountSlotId: string
  ): ReturnType<CodexOAuthStore['readAccountForTokenRefresh']> {
    return this.oauthStore(this.validateSlot(accountSlotId)).readAccountForTokenRefresh();
  }

  /**
   * Returns the Codex home for one account slot.
   *
   * @param accountSlotId Account slot id.
   * @returns Codex home path.
   */
  public async getCodexHome(accountSlotId: string): Promise<string | null> {
    return this.accountStore(this.validateSlot(accountSlotId)).codexHome();
  }

  /**
   * Returns the account-store surface required by CodexAuthTokenResolver.
   *
   * @param accountSlotId Account slot id.
   * @returns Token-resolution account store.
   */
  public tokenResolutionStore(accountSlotId: string): {
    getCodexHome: () => Promise<string | null>;
    readAccountForTokenRefresh: () => ReturnType<CodexOAuthStore['readAccountForTokenRefresh']>;
  } {
    const slotId = this.validateSlot(accountSlotId);

    return {
      getCodexHome: () => this.getCodexHome(slotId),
      readAccountForTokenRefresh: () => this.readAccountForTokenRefresh(slotId),
    };
  }

  private defaultAccountSlotId(): string {
    return validateCodexOAuthAccountSlotId(
      this.resolveDefaultAccountSlotId() ?? CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID
    );
  }

  private validateSlot(accountSlotId: string): string {
    return validateCodexOAuthAccountSlotId(accountSlotId);
  }

  private accountStore(accountSlotId: string): CodexOAuthAccountStore {
    const slotId = validateCodexOAuthAccountSlotId(accountSlotId);
    const cached = this.accountStores.get(slotId);

    if (cached) {
      return cached;
    }

    const store = new CodexOAuthAccountStore(this.options.dataRoot, slotId, this.now);
    this.accountStores.set(slotId, store);
    return store;
  }

  private oauthStore(accountSlotId: string): CodexOAuthStore {
    const slotId = validateCodexOAuthAccountSlotId(accountSlotId);
    const cached = this.oauthStores.get(slotId);

    if (cached) {
      return cached;
    }

    const accountStore = this.accountStore(slotId);
    const metadata = accountStore.ensure();
    const oauthStore = new CodexOAuthStore({
      accountSlotId: slotId,
      boundProviderIds: this.resolveBoundProviderIds(slotId),
      codexHome: accountStore.codexHome(),
      isDefault: slotId === this.defaultAccountSlotId(),
      onStatusChange: (status) => {
        accountStore.updateFromStatus(status);
      },
      ...(this.clientFactory ? { clientFactory: this.clientFactory } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    });

    this.oauthStores.set(slotId, oauthStore);
    return oauthStore;
  }

  private slotExists(accountSlotId: string): boolean {
    if (this.accountStores.has(accountSlotId)) {
      return true;
    }

    if (!this.options.dataRoot) {
      return false;
    }

    return existsSync(
      resolveDataRootPath(
        this.options.dataRoot,
        'server',
        'files',
        'oauth',
        'openai-codex',
        'accounts',
        accountSlotId,
        ACCOUNT_METADATA_FILE
      )
    );
  }

  private readFilesystemSlotIds(): string[] {
    if (!this.options.dataRoot) {
      return [];
    }

    const accountsRoot = resolveDataRootPath(
      this.options.dataRoot,
      'server',
      'files',
      'oauth',
      'openai-codex',
      'accounts'
    );

    if (!existsSync(accountsRoot)) {
      return [];
    }

    return readdirSync(accountsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((accountSlotId) => isSafeAccountSlotId(accountSlotId));
  }

  private summaryFromMetadata(
    metadata: CodexOAuthAccountMetadata,
    defaultAccountSlotId: string
  ): CodexOAuthAccountSummary {
    const boundProviderIds = this.resolveBoundProviderIds(metadata.accountSlotId);

    return {
      providerId: 'openai_codex',
      accountSlotId: metadata.accountSlotId,
      status: metadata.status,
      boundProviderIds,
      isDefault: metadata.accountSlotId === defaultAccountSlotId,
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.accountLabel ? { accountLabel: metadata.accountLabel } : {}),
      ...(metadata.planType ? { planType: metadata.planType } : {}),
      ...(metadata.lastError ? { message: metadata.lastError } : {}),
      ...(metadata.lastLoginMode ? { mode: metadata.lastLoginMode } : {}),
    };
  }
}

/**
 * Sanitizes persisted account metadata and drops any unknown or token-shaped fields.
 *
 * @param raw Raw metadata loaded from storage.
 * @param accountSlotId Account slot id owning the metadata.
 * @param now Clock used when timestamps are missing.
 * @returns Sanitized account metadata.
 */
function sanitizeMetadata(
  raw: Record<string, unknown>,
  accountSlotId: string,
  now: () => string
): CodexOAuthAccountMetadata {
  return {
    schemaVersion: 1,
    accountSlotId,
    ...(typeof raw.displayName === 'string' && raw.displayName.length > 0
      ? { displayName: raw.displayName }
      : {}),
    status: readStatus(raw.status),
    ...(typeof raw.accountLabel === 'string' ? { accountLabel: raw.accountLabel } : {}),
    ...(typeof raw.planType === 'string' ? { planType: raw.planType } : {}),
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'string' ? raw.lastUpdatedAt : now(),
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    ...(raw.lastLoginMode === 'browser' || raw.lastLoginMode === 'device_code'
      ? { lastLoginMode: raw.lastLoginMode }
      : {}),
  };
}

/**
 * Reads a valid public OAuth status from unknown input.
 *
 * @param value Unknown status value.
 * @returns Valid OAuth status.
 */
function readStatus(value: unknown): CodexOAuthStatus {
  return value === 'logged_out' ||
    value === 'pending' ||
    value === 'logged_in' ||
    value === 'unavailable' ||
    value === 'error'
    ? value
    : 'logged_out';
}

/**
 * Checks whether one filesystem entry is a safe account slot id.
 *
 * @param accountSlotId Candidate account slot id.
 * @returns True when the slot id is valid.
 */
function isSafeAccountSlotId(accountSlotId: string): boolean {
  try {
    validateCodexOAuthAccountSlotId(accountSlotId);
    return true;
  } catch {
    return false;
  }
}
