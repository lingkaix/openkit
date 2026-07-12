import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  assertVaultEntryMetadata,
  type VaultBackend,
  VaultBackendError,
  type VaultEntryMetadata,
  type VaultListReferencesInput,
  type VaultReferenceInventoryEntry,
  type VaultResolveInput,
  type VaultRevokeInput,
  type VaultRotateInput,
  type VaultSecretMaterial,
  type VaultStoreInput,
} from './vault-backend.js';
import {
  initializeOrVerifyEncryptedFileVaultStore,
  openEncryptedFileVaultEntry,
  readEncryptedFileVaultEntry,
  sealEncryptedFileVaultEntry,
} from './vault-encrypted-file-store.js';

/** Required mode for encrypted-file backend state files. */
const REQUIRED_STATE_FILE_MODE = 0o600;

/** Required mode for encrypted-file backend reference directories. */
const REQUIRED_REFERENCE_DIRECTORY_MODE = 0o700;

/** Safe reference id characters for encrypted-file backend paths. */
const SAFE_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Input used to create an unlocked encrypted-file vault backend. */
interface CreateEncryptedFileVaultBackendInput {
  /** Absolute encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Owned mutable 32-byte master key shared with the caller's unlock state. */
  readonly masterKey: Uint8Array;
  /** Optional lifecycle check used to invalidate retained backend references. */
  readonly isKeyActive?: () => boolean;
  /** Milliseconds prior versions remain resolvable after rotation. */
  readonly rotationGraceMs?: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Durable encrypted-file reference state. */
interface EncryptedFileReferenceState {
  /** Current material version. */
  readonly currentVersion: number;
  /** True when every material version is revoked. */
  readonly revoked: boolean;
  /** Non-secret entry metadata preserved for inventory after material destruction. */
  readonly metadata?: VaultEntryMetadata;
  /** Explicit prior-version expiry timestamps by material version. */
  readonly versionExpirations?: Record<string, string>;
  /** Number of material versions known for this reference. */
  readonly versionCount?: number;
  /** ISO timestamp for latest state change. */
  readonly updatedAt: string;
}

/**
 * Creates an unlocked encrypted-file vault backend.
 *
 * @param input Store directory, master key, and optional clock.
 * @returns Vault backend backed by encrypted entry files.
 */
export function createEncryptedFileVaultBackend(
  input: CreateEncryptedFileVaultBackendInput
): VaultBackend {
  try {
    return new EncryptedFileVaultBackend(input);
  } catch (error) {
    input.masterKey.fill(0);

    if (error instanceof VaultBackendError) {
      throw error;
    }

    throw new VaultBackendError(
      'backend-unavailable',
      'Encrypted-file vault backend could not be initialized.'
    );
  }
}

/** Unlocked encrypted-file vault backend. */
class EncryptedFileVaultBackend implements VaultBackend {
  public readonly kind = 'encrypted-file' as const;

  private readonly storeDir: string;

  private readonly masterKey: Uint8Array;

  private readonly isKeyActive: () => boolean;

  private readonly rotationGraceMs: number;

  private readonly now: () => string;

  /**
   * Creates an unlocked encrypted-file vault backend.
   *
   * @param input Store directory, master key, and optional clock.
   */
  public constructor(input: CreateEncryptedFileVaultBackendInput) {
    this.storeDir = input.storeDir;
    this.masterKey = input.masterKey;
    this.isKeyActive = input.isKeyActive ?? (() => true);
    this.rotationGraceMs = input.rotationGraceMs ?? 0;
    this.now = input.now ?? (() => new Date().toISOString());
    initializeOrVerifyEncryptedFileVaultStore({
      masterKey: this.masterKey,
      storeDir: this.storeDir,
    });
  }

  /**
   * Returns the available health projection.
   *
   * @returns Redacted backend health.
   */
  public health(): ReturnType<VaultBackend['health']> {
    if (!this.isKeyActive()) {
      return {
        diagnostic: 'encrypted-file vault backend is locked',
        kind: this.kind,
        state: 'locked',
      };
    }

    return {
      diagnostic: 'encrypted-file vault backend is unlocked',
      kind: this.kind,
      state: 'available',
    };
  }

  /**
   * Resolves one encrypted-file secret material version.
   *
   * @param input Reference and optional version to resolve.
   * @returns Secret material bytes.
   * @throws VaultBackendError when the reference/version is missing or authentication fails.
   */
  public resolve(input: VaultResolveInput): VaultSecretMaterial {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);

    const state = this.referenceState(input.referenceId);

    if (state?.revoked) {
      throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
    }

    const version =
      input.version ?? state?.currentVersion ?? this.currentVersion(input.referenceId);

    if (!version) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    if (this.isExpiredVersion(state, version)) {
      this.destroyVersion(input.referenceId, version);
      throw new VaultBackendError('version-expired', 'Vault reference material version expired.');
    }

    try {
      return openEncryptedFileVaultEntry({
        masterKey: this.masterKey,
        referenceId: input.referenceId,
        storeDir: this.storeDir,
        version,
      });
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }

      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }
  }

  /**
   * Stores version 1 material for a new encrypted-file reference.
   *
   * @param input Reference, material, and non-secret metadata.
   * @returns Non-secret inventory metadata for the stored reference.
   * @throws VaultBackendError when the reference already has material.
   */
  public store(input: VaultStoreInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);
    assertVaultEntryMetadata(input.metadata);

    if (this.currentVersion(input.referenceId) !== undefined) {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault reference material already exists.'
      );
    }

    const createdAt = this.now();

    sealEncryptedFileVaultEntry({
      createdAt,
      masterKey: this.masterKey,
      material: input.material,
      metadata: input.metadata,
      referenceId: input.referenceId,
      storeDir: this.storeDir,
      version: 1,
    });
    this.writeReferenceState(input.referenceId, {
      currentVersion: 1,
      metadata: metadataFields(input.metadata),
      revoked: false,
      versionExpirations: {},
      versionCount: 1,
      updatedAt: createdAt,
    });

    return this.requireInventory(input.referenceId);
  }

  /**
   * Rotates one encrypted-file reference.
   *
   * @param input Reference and replacement material.
   * @returns Non-secret inventory metadata after rotation.
   * @throws VaultBackendError when the reference is missing or revoked.
   */
  public rotate(input: VaultRotateInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);

    const currentState = this.requireActiveState(input.referenceId);
    const nextVersion = currentState.currentVersion + 1;
    const currentInventory = this.requireInventory(input.referenceId);
    const updatedAt = this.now();

    sealEncryptedFileVaultEntry({
      createdAt: updatedAt,
      masterKey: this.masterKey,
      material: input.material,
      metadata: metadataFields(currentInventory),
      referenceId: input.referenceId,
      storeDir: this.storeDir,
      version: nextVersion,
    });
    this.writeReferenceState(input.referenceId, {
      currentVersion: nextVersion,
      metadata: metadataFields(currentInventory),
      revoked: false,
      versionExpirations: this.rotatedVersionExpirations(currentState, nextVersion, updatedAt),
      versionCount: nextVersion,
      updatedAt,
    });

    return this.requireInventory(input.referenceId);
  }

  /**
   * Revokes one encrypted-file reference.
   *
   * @param input Reference to revoke.
   * @returns Non-secret inventory metadata after revocation.
   * @throws VaultBackendError when the reference is missing.
   */
  public revoke(input: VaultRevokeInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);

    const currentState = this.requireExistingState(input.referenceId);
    const currentInventory = this.requireInventory(input.referenceId);
    const updatedAt = this.now();

    this.writeReferenceState(input.referenceId, {
      currentVersion: currentState.currentVersion,
      metadata: metadataFields(currentInventory),
      revoked: true,
      versionExpirations: currentState.versionExpirations ?? {},
      versionCount: currentInventory.versionCount,
      updatedAt,
    });
    this.destroyVersions(input.referenceId, currentInventory.versionCount);

    return this.requireInventory(input.referenceId);
  }

  /**
   * Lists non-secret encrypted-file inventory metadata.
   *
   * @param input Optional owner-scope filters.
   * @returns Non-secret reference inventory rows.
   */
  public listReferences(input: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    this.assertKeyActive();
    return this.referenceIds()
      .map((referenceId) => this.requireInventory(referenceId))
      .filter((entry) => matchesFilter(entry, input))
      .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  }

  /**
   * Reads current inventory for one reference.
   *
   * @param referenceId Vault reference id.
   * @returns Non-secret inventory metadata.
   * @throws VaultBackendError when the reference has no readable material.
   */
  private requireInventory(referenceId: string): VaultReferenceInventoryEntry {
    this.assertReferenceId(referenceId);

    const versions = this.versions(referenceId);
    const state = this.referenceState(referenceId);
    const currentVersion = state?.currentVersion ?? versions.at(-1);
    const currentEntry = this.entryInventoryMetadata(referenceId, currentVersion);
    const metadata = currentEntry?.metadata ?? state?.metadata;
    const updatedAt = state?.updatedAt ?? currentEntry?.createdAt;

    if (!currentVersion || !metadata || !updatedAt) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    return {
      ...metadataFields(metadata),
      backendKind: this.kind,
      currentVersion,
      referenceId,
      revoked: state?.revoked ?? false,
      updatedAt,
      versionCount: state?.versionCount ?? versions.length,
    };
  }

  /**
   * Returns the current version for one reference.
   *
   * @param referenceId Vault reference id.
   * @returns Current version, or undefined.
   */
  private currentVersion(referenceId: string): number | undefined {
    this.assertReferenceId(referenceId);

    return this.referenceState(referenceId)?.currentVersion ?? this.versions(referenceId).at(-1);
  }

  /**
   * Checks whether one material version is beyond rotation grace.
   *
   * @param state Current reference state, when present.
   * @param version Material version being resolved.
   * @returns True when the requested version is expired.
   */
  private isExpiredVersion(
    state: EncryptedFileReferenceState | undefined,
    version: number
  ): boolean {
    if (!state || version === state.currentVersion) {
      return false;
    }

    const expiresAt = state.versionExpirations?.[String(version)];

    return expiresAt ? Date.parse(this.now()) > Date.parse(expiresAt) : false;
  }

  /**
   * Builds expiry metadata after a rotation.
   *
   * @param state Current reference state before rotation.
   * @param nextVersion New current version.
   * @param rotatedAt Timestamp when rotation happened.
   * @returns Expiry timestamps for prior versions.
   */
  private rotatedVersionExpirations(
    state: EncryptedFileReferenceState,
    nextVersion: number,
    rotatedAt: string
  ): Record<string, string> {
    const expiresAt = new Date(Date.parse(rotatedAt) + this.rotationGraceMs).toISOString();
    const expirations: Record<string, string> = { ...(state.versionExpirations ?? {}) };

    for (let version = 1; version < nextVersion; version += 1) {
      expirations[String(version)] ??= expiresAt;
    }

    return expirations;
  }

  /**
   * Destroys one expired material version if it still exists.
   *
   * @param referenceId Vault reference id.
   * @param version Material version to destroy.
   */
  private destroyVersion(referenceId: string, version: number): void {
    rmSync(entryPath(this.storeDir, referenceId, version), { force: true });
  }

  /**
   * Destroys every material version up to the known version count.
   *
   * @param referenceId Vault reference id.
   * @param versionCount Number of versions to destroy.
   */
  private destroyVersions(referenceId: string, versionCount: number): void {
    for (let version = 1; version <= versionCount; version += 1) {
      this.destroyVersion(referenceId, version);
    }
  }

  /**
   * Reads non-secret metadata from one material entry when present.
   *
   * @param referenceId Vault reference id.
   * @param version Material version to inspect.
   * @returns Entry metadata and timestamp, or null.
   */
  private entryInventoryMetadata(
    referenceId: string,
    version: number | undefined
  ): { readonly metadata: VaultEntryMetadata; readonly createdAt: string } | null {
    if (!version || !existsSync(entryPath(this.storeDir, referenceId, version))) {
      return null;
    }

    const entry = readEncryptedFileVaultEntry({
      referenceId,
      storeDir: this.storeDir,
      version,
    });

    return {
      createdAt: entry.createdAt,
      metadata: entry.metadata,
    };
  }

  /**
   * Lists material versions for one reference.
   *
   * @param referenceId Vault reference id.
   * @returns Sorted material versions.
   */
  private versions(referenceId: string): number[] {
    this.assertReferenceId(referenceId);

    const referenceDir = join(this.storeDir, 'entries', referenceId);

    if (!existsSync(referenceDir)) {
      return [];
    }

    return readdirSync(referenceDir)
      .filter((name) => name.endsWith('.enc'))
      .map((name) => Number.parseInt(name.slice(0, -4), 10))
      .filter((version) => Number.isInteger(version) && version > 0)
      .sort((left, right) => left - right);
  }

  /**
   * Lists reference ids with material entries.
   *
   * @returns Sorted reference ids.
   */
  private referenceIds(): string[] {
    const entriesDir = join(this.storeDir, 'entries');

    if (!existsSync(entriesDir)) {
      return [];
    }

    return readdirSync(entriesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Reads durable reference state when it exists.
   *
   * @param referenceId Vault reference id.
   * @returns Stored reference state, or undefined.
   */
  private referenceState(referenceId: string): EncryptedFileReferenceState | undefined {
    const path = statePath(this.storeDir, referenceId);

    if (!existsSync(path)) {
      return undefined;
    }

    const state = JSON.parse(readFileSync(path, 'utf8')) as EncryptedFileReferenceState;

    if (
      !Number.isInteger(state.currentVersion) ||
      state.currentVersion < 1 ||
      typeof state.revoked !== 'boolean' ||
      !isStateMetadata(state.metadata) ||
      !isVersionExpirations(state.versionExpirations) ||
      !isVersionCount(state.versionCount) ||
      typeof state.updatedAt !== 'string'
    ) {
      throw new VaultBackendError('backend-unavailable', 'Encrypted-file vault state is invalid.');
    }

    return state;
  }

  /**
   * Reads existing durable reference state or derives the initial state.
   *
   * @param referenceId Vault reference id.
   * @returns Reference state.
   * @throws VaultBackendError when no material exists.
   */
  private requireExistingState(referenceId: string): EncryptedFileReferenceState {
    const state = this.referenceState(referenceId);

    if (state) {
      return state;
    }

    const currentVersion = this.versions(referenceId).at(-1);

    if (!currentVersion) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    const entry = readEncryptedFileVaultEntry({
      referenceId,
      storeDir: this.storeDir,
      version: currentVersion,
    });

    return {
      currentVersion,
      metadata: metadataFields(entry.metadata),
      revoked: false,
      versionExpirations: {},
      versionCount: currentVersion,
      updatedAt: entry.createdAt,
    };
  }

  /**
   * Reads durable active state for one reference.
   *
   * @param referenceId Vault reference id.
   * @returns Active reference state.
   * @throws VaultBackendError when the reference is missing or revoked.
   */
  private requireActiveState(referenceId: string): EncryptedFileReferenceState {
    const state = this.requireExistingState(referenceId);

    if (state.revoked) {
      throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
    }

    return state;
  }

  /**
   * Writes durable reference state atomically.
   *
   * @param referenceId Vault reference id.
   * @param state Reference state.
   */
  private writeReferenceState(referenceId: string, state: EncryptedFileReferenceState): void {
    const path = statePath(this.storeDir, referenceId);

    mkdirSync(dirname(path), { mode: REQUIRED_REFERENCE_DIRECTORY_MODE, recursive: true });
    chmodSync(dirname(path), REQUIRED_REFERENCE_DIRECTORY_MODE);
    writeJsonFileAtomically(path, state);
  }

  /**
   * Validates a reference id before path use.
   *
   * @param referenceId Vault reference id.
   * @throws VaultBackendError when the reference id is unsafe.
   */
  private assertReferenceId(referenceId: string): void {
    if (!SAFE_REFERENCE_ID_PATTERN.test(referenceId)) {
      throw new VaultBackendError(
        'backend-unavailable',
        'Vault reference id is not safe for encrypted-file backend paths.'
      );
    }
  }

  /**
   * Rejects operations through a retained backend after key replacement or lock.
   *
   * @throws VaultBackendError when this backend no longer owns the active key.
   */
  private assertKeyActive(): void {
    if (!this.isKeyActive()) {
      throw new VaultBackendError('vault-locked', 'Vault backend is locked.');
    }
  }
}

/**
 * Returns inventory metadata fields without undefined optional keys.
 *
 * @param metadata Stored entry metadata.
 * @returns Inventory metadata fields.
 */
function metadataFields(metadata: VaultEntryMetadata): VaultEntryMetadata {
  return {
    ownerScope: metadata.ownerScope,
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.userId ? { userId: metadata.userId } : {}),
  };
}

/**
 * Validates stored non-secret entry metadata.
 *
 * @param value Parsed metadata value.
 * @returns True when the metadata is absent or valid.
 */
function isStateMetadata(value: unknown): value is VaultEntryMetadata | undefined {
  if (value === undefined) {
    return true;
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !['server', 'user', 'workspace'].includes(
      (value as Partial<VaultEntryMetadata>).ownerScope ?? ''
    ) ||
    !optionalString((value as Partial<VaultEntryMetadata>).workspaceId) ||
    !optionalString((value as Partial<VaultEntryMetadata>).userId)
  ) {
    return false;
  }

  try {
    assertVaultEntryMetadata(value as VaultEntryMetadata);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether one inventory row matches a list filter.
 *
 * @param entry Inventory row.
 * @param input Optional filter.
 * @returns True when the row should be returned.
 */
function matchesFilter(
  entry: VaultReferenceInventoryEntry,
  input: VaultListReferencesInput
): boolean {
  if (input.ownerScope && entry.ownerScope !== input.ownerScope) {
    return false;
  }

  if (input.workspaceId && entry.workspaceId !== input.workspaceId) {
    return false;
  }

  if (input.userId && entry.userId !== input.userId) {
    return false;
  }

  return true;
}

/**
 * Validates stored version-expiry metadata.
 *
 * @param value Parsed version expiration value.
 * @returns True when the metadata is absent or a string map.
 */
function isVersionExpirations(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      Object.entries(value).every(
        ([version, expiresAt]) =>
          Number.isInteger(Number(version)) &&
          typeof expiresAt === 'string' &&
          Number.isFinite(Date.parse(expiresAt))
      ))
  );
}

/**
 * Validates stored version-count metadata.
 *
 * @param value Parsed version count value.
 * @returns True when the version count is absent or a positive integer.
 */
function isVersionCount(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

/**
 * Checks whether an optional value is a string when present.
 *
 * @param value Optional value to check.
 * @returns True when absent or a string.
 */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Returns one reference state path.
 *
 * @param storeDir Encrypted-file store directory.
 * @param referenceId Vault reference id.
 * @returns State file path.
 */
function statePath(storeDir: string, referenceId: string): string {
  return join(storeDir, 'entries', referenceId, 'state.json');
}

/**
 * Returns one encrypted material entry path.
 *
 * @param storeDir Encrypted-file store directory.
 * @param referenceId Vault reference id.
 * @param version Material version.
 * @returns Entry file path.
 */
function entryPath(storeDir: string, referenceId: string, version: number): string {
  return join(storeDir, 'entries', referenceId, `${version}.enc`);
}

/**
 * Writes one JSON file through a same-directory temp file and atomic rename.
 *
 * @param path Target path.
 * @param value JSON-serializable value.
 */
function writeJsonFileAtomically(path: string, value: unknown): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);

  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: REQUIRED_STATE_FILE_MODE,
  });
  chmodSync(tempPath, REQUIRED_STATE_FILE_MODE);
  renameSync(tempPath, path);
}
