import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
  assertEncryptedFileVaultRegularFile,
  type EncryptedFileVaultEntry,
  initializeOrVerifyEncryptedFileVaultStore,
  openEncryptedFileVaultEntry,
  readEncryptedFileVaultEntry,
  readEncryptedFileVaultText,
  sealEncryptedFileVaultEntry,
  writeEncryptedFileVaultJsonAtomically,
} from './vault-encrypted-file-store.js';
import { assertEncryptedFileVaultDirectory } from './vault-store-directory.js';

const SAFE_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENTRY_FILE_PATTERN = /^([1-9][0-9]*)\.enc$/;
const ENTRY_TEMP_FILE_PATTERN = /^\.([1-9][0-9]*)\.enc\.([1-9][0-9]*)\.tmp$/;
const STATE_TEMP_FILE_PATTERN = /^\.state\.json\.([1-9][0-9]*)\.tmp$/;

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

/** Exact durable encrypted-file reference state. */
interface EncryptedFileReferenceState {
  /** Current material version. */
  readonly currentVersion: number;
  /** Exact non-secret owner metadata. */
  readonly metadata: VaultEntryMetadata;
  /** Reference id bound to this state file path. */
  readonly referenceId: string;
  /** True after material destruction commits. */
  readonly revoked: boolean;
  /** Prior-version expiration timestamps. */
  readonly versionExpirations: Record<string, string>;
  /** Number of material versions created for the reference. */
  readonly versionCount: number;
  /** Canonical timestamp for the latest state change. */
  readonly updatedAt: string;
}

/** Authenticated ordinary-operation snapshot. */
interface ReferenceSnapshot {
  /** Exact durable state. */
  readonly state: EncryptedFileReferenceState;
  /** Authenticated entries by version. */
  readonly entries: ReadonlyMap<number, EncryptedFileVaultEntry>;
}

/** One exact canonical or interrupted-write encrypted material artifact. */
interface RevocationEntryArtifact {
  /** Exact source filename within the reference directory. */
  readonly fileName: string;
  /** Canonical source path. */
  readonly path: string;
  /** Path-bound material version. */
  readonly version: number;
}

/** Files admitted only for explicit revocation preflight and cleanup. */
interface RevocationArtifactInventory {
  /** Canonical and exact interrupted-write material files. */
  readonly entries: readonly RevocationEntryArtifact[];
  /** Exact interrupted-write state files. */
  readonly stateTemps: readonly string[];
}

/**
 * Creates an unlocked encrypted-file Vault backend.
 *
 * @param input Store directory, master key, and optional lifecycle settings.
 * @returns Authenticated encrypted-file backend.
 * @throws VaultBackendError when the store cannot be initialized or authenticated.
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
    throw unavailable('Encrypted-file vault backend could not be initialized.');
  }
}

/** Unlocked encrypted-file Vault backend. */
class EncryptedFileVaultBackend implements VaultBackend {
  public readonly kind = 'encrypted-file' as const;
  private readonly storeDir: string;
  private readonly masterKey: Uint8Array;
  private readonly isKeyActive: () => boolean;
  private readonly rotationGraceMs: number;
  private readonly now: () => string;

  /**
   * Creates an unlocked backend and verifies its store header.
   *
   * @param input Store directory, master key, and optional lifecycle settings.
   * @throws VaultBackendError when the store header cannot be verified.
   */
  public constructor(input: CreateEncryptedFileVaultBackendInput) {
    this.masterKey = input.masterKey;
    this.isKeyActive = input.isKeyActive ?? (() => true);
    this.rotationGraceMs = input.rotationGraceMs ?? 0;
    this.now = input.now ?? (() => new Date().toISOString());
    this.storeDir = initializeOrVerifyEncryptedFileVaultStore({
      masterKey: this.masterKey,
      storeDir: input.storeDir,
    });
  }

  /**
   * Returns redacted backend health.
   *
   * @returns Current available or locked health projection.
   */
  public health(): ReturnType<VaultBackend['health']> {
    return this.isKeyActive()
      ? {
          diagnostic: 'encrypted-file vault backend is unlocked',
          kind: this.kind,
          state: 'available',
        }
      : { diagnostic: 'encrypted-file vault backend is locked', kind: this.kind, state: 'locked' };
  }

  /**
   * Resolves one authenticated material version.
   *
   * @param input Reference id and optional version.
   * @returns Decrypted secret material.
   * @throws VaultBackendError when state, attribution, authentication, or expiry checks fail.
   */
  public resolve(input: VaultResolveInput): VaultSecretMaterial {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);
    if (input.version !== undefined) {
      assertSafeMaterialVersion(input.version);
    }
    const snapshot = this.requireSnapshot(input.referenceId);

    if (snapshot.state.revoked) {
      throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
    }

    const version = input.version ?? snapshot.state.currentVersion;
    if (this.isExpired(snapshot.state, version)) {
      if (snapshot.entries.has(version)) {
        this.destroyVersion(input.referenceId, version);
      }
      throw new VaultBackendError('version-expired', 'Vault reference material version expired.');
    }
    if (!snapshot.entries.has(version)) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }

    return openEncryptedFileVaultEntry({
      masterKey: this.masterKey,
      referenceId: input.referenceId,
      storeDir: this.storeDir,
      version,
    });
  }

  /**
   * Stores version one for a new reference.
   *
   * @param input Reference id, secret material, and exact owner metadata.
   * @returns Authenticated non-secret inventory.
   * @throws VaultBackendError when the reference exists or material cannot be stored.
   */
  public store(input: VaultStoreInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);
    assertVaultEntryMetadata(input.metadata);

    if (pathExistsWithoutFollowing(referenceDir(this.storeDir, input.referenceId))) {
      throw unavailable('Vault reference material already exists.');
    }

    const createdAt = this.now();
    const metadata = metadataFields(input.metadata);
    try {
      sealEncryptedFileVaultEntry({
        createdAt,
        masterKey: this.masterKey,
        material: input.material,
        metadata,
        referenceId: input.referenceId,
        storeDir: this.storeDir,
        version: 1,
        versionExpirations: {},
      });
      this.writeReferenceState(input.referenceId, {
        currentVersion: 1,
        metadata,
        referenceId: input.referenceId,
        revoked: false,
        updatedAt: createdAt,
        versionCount: 1,
        versionExpirations: {},
      });
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault material could not be stored.');
    }
    return this.inventory(input.referenceId, this.requireSnapshot(input.referenceId));
  }

  /**
   * Rotates a live reference to a new version.
   *
   * @param input Reference id and replacement material.
   * @returns Authenticated inventory for the new current version.
   * @throws VaultBackendError when the current reference is not strictly valid and active.
   */
  public rotate(input: VaultRotateInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);
    const snapshot = this.requireSnapshot(input.referenceId);
    if (snapshot.state.revoked) {
      throw new VaultBackendError('reference-revoked', 'Vault reference material is revoked.');
    }

    const updatedAt = this.now();
    if (snapshot.state.currentVersion === Number.MAX_SAFE_INTEGER) {
      throw unavailable('Encrypted-file vault material version cannot be rotated further.');
    }
    const nextVersion = snapshot.state.currentVersion + 1;
    const versionExpirations = this.rotatedExpirations(snapshot.state, updatedAt);
    try {
      sealEncryptedFileVaultEntry({
        createdAt: updatedAt,
        masterKey: this.masterKey,
        material: input.material,
        metadata: snapshot.state.metadata,
        referenceId: input.referenceId,
        storeDir: this.storeDir,
        version: nextVersion,
        versionExpirations,
      });
      this.writeReferenceState(input.referenceId, {
        currentVersion: nextVersion,
        metadata: snapshot.state.metadata,
        referenceId: input.referenceId,
        revoked: false,
        updatedAt,
        versionCount: nextVersion,
        versionExpirations,
      });
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault material could not be rotated.');
    }
    return this.inventory(input.referenceId, this.requireSnapshot(input.referenceId));
  }

  /**
   * Revokes a reference after authenticating every discovered material file.
   *
   * @param input Reference id to revoke.
   * @returns Revoked tombstone inventory after verified material destruction.
   * @throws VaultBackendError when any discovered material cannot be safely attributed.
   */
  public revoke(input: VaultRevokeInput): VaultReferenceInventoryEntry {
    this.assertKeyActive();
    this.assertReferenceId(input.referenceId);
    const artifacts = this.revocationArtifacts(input.referenceId);
    let state: EncryptedFileReferenceState | undefined;
    try {
      state = this.readReferenceState(input.referenceId);
    } catch (error) {
      if (!(error instanceof VaultBackendError) || artifacts.entries.length === 0) {
        throw error;
      }
    }

    if (!state && artifacts.entries.length === 0) {
      throw new VaultBackendError('reference-not-found', 'Vault reference material was not found.');
    }
    if (state && !state.revoked && artifacts.entries.length === 0) {
      throw unavailable('Encrypted-file vault material is missing.');
    }
    if (state?.revoked && artifacts.entries.length === 0 && artifacts.stateTemps.length === 0) {
      return this.inventory(input.referenceId, { entries: new Map(), state });
    }

    let metadata = state?.metadata;
    let currentVersion = state?.currentVersion ?? 1;
    const knownExpirations: Record<string, string> = {
      ...(state?.versionExpirations ?? {}),
    };

    for (const artifact of artifacts.entries) {
      const entry = this.authenticateEntry(input.referenceId, artifact.version, artifact.fileName);
      metadata ??= metadataFields(entry.metadata);
      if (!sameMetadata(metadata, entry.metadata)) {
        throw unavailable('Encrypted-file vault material attribution is inconsistent.');
      }
      if (
        !hasExpirationVersionsWithinRange(entry.associatedData.versionExpirations, entry.version)
      ) {
        throw unavailable('Encrypted-file vault material attribution is inconsistent.');
      }
      mergeExpirations(knownExpirations, entry.associatedData.versionExpirations);
      currentVersion = Math.max(currentVersion, artifact.version);
    }
    if (!metadata) {
      throw unavailable('Encrypted-file vault material attribution is unavailable.');
    }

    const updatedAt = this.now();
    const versionExpirations = normalizeRevokedExpirations(
      currentVersion,
      knownExpirations,
      updatedAt,
      artifacts.entries.length
    );
    const tombstone: EncryptedFileReferenceState = {
      currentVersion,
      metadata,
      referenceId: input.referenceId,
      revoked: true,
      updatedAt,
      versionCount: currentVersion,
      versionExpirations,
    };
    this.writeReferenceState(input.referenceId, tombstone);
    for (const artifact of artifacts.entries) {
      this.destroyArtifact(artifact.path);
    }
    for (const stateTempPath of artifacts.stateTemps) {
      this.destroyArtifact(stateTempPath);
    }
    const residue = this.revocationArtifacts(input.referenceId);
    if (residue.entries.length !== 0 || residue.stateTemps.length !== 0) {
      throw unavailable('Encrypted-file vault material destruction could not be verified.');
    }
    return this.inventory(input.referenceId, { entries: new Map(), state: tombstone });
  }

  /**
   * Lists authenticated non-secret reference inventory.
   *
   * @param input Optional owner filters.
   * @returns Sorted inventory rows that match the filters.
   * @throws VaultBackendError when any reference is inconsistent.
   */
  public listReferences(input: VaultListReferencesInput = {}): VaultReferenceInventoryEntry[] {
    this.assertKeyActive();
    return this.referenceIds()
      .map((referenceId) => this.inventory(referenceId, this.requireSnapshot(referenceId)))
      .filter((entry) => matchesFilter(entry, input));
  }

  /**
   * Builds inventory from a validated snapshot.
   *
   * @param referenceId Stable reference id.
   * @param snapshot Validated state and authenticated entries.
   * @returns Non-secret inventory row.
   */
  private inventory(
    referenceId: string,
    snapshot: ReferenceSnapshot
  ): VaultReferenceInventoryEntry {
    return {
      ...metadataFields(snapshot.state.metadata),
      backendKind: this.kind,
      currentVersion: snapshot.state.currentVersion,
      referenceId,
      revoked: snapshot.state.revoked,
      updatedAt: snapshot.state.updatedAt,
      versionCount: snapshot.state.versionCount,
    };
  }

  /**
   * Loads and authenticates one strict ordinary-operation snapshot.
   *
   * @param referenceId Stable reference id.
   * @returns Validated state and authenticated present entries.
   * @throws VaultBackendError when state and material disagree.
   */
  private requireSnapshot(referenceId: string): ReferenceSnapshot {
    const versions = this.referenceVersions(referenceId);
    const state = this.readReferenceState(referenceId);
    if (!state) {
      if (
        versions.length === 0 &&
        !pathExistsWithoutFollowing(referenceDir(this.storeDir, referenceId))
      ) {
        throw new VaultBackendError(
          'reference-not-found',
          'Vault reference material was not found.'
        );
      }
      throw unavailable('Encrypted-file vault reference state is missing.');
    }
    if (state.revoked) {
      if (versions.length !== 0) {
        throw unavailable('Encrypted-file vault revoked reference retains material.');
      }
      return { entries: new Map(), state };
    }
    if (state.versionCount !== state.currentVersion || !versions.includes(state.currentVersion)) {
      throw unavailable('Encrypted-file vault current material is missing.');
    }
    if (versions.some((version) => version > state.currentVersion)) {
      throw unavailable('Encrypted-file vault contains material absent from state.');
    }

    const versionSet = new Set(versions);
    for (const [versionText, expiresAt] of Object.entries(state.versionExpirations)) {
      const version = Number(versionText);
      if (!versionSet.has(version) && Date.parse(this.now()) <= Date.parse(expiresAt)) {
        throw unavailable('Encrypted-file vault material is missing.');
      }
    }

    const entries = new Map<number, EncryptedFileVaultEntry>();
    for (const version of versions) {
      const entry = this.authenticateEntry(referenceId, version);
      if (!sameMetadata(state.metadata, entry.metadata)) {
        throw unavailable('Encrypted-file vault entry metadata contradicts state.');
      }
      if (
        !isExactExpirationPrefix(
          entry.associatedData.versionExpirations,
          state.versionExpirations,
          version
        )
      ) {
        throw unavailable('Encrypted-file vault expiry metadata contradicts state.');
      }
      entries.set(version, entry);
    }

    const current = entries.get(state.currentVersion);
    if (
      !current ||
      current.createdAt !== state.updatedAt ||
      !sameExpirations(current.associatedData.versionExpirations, state.versionExpirations)
    ) {
      throw unavailable('Encrypted-file vault current entry contradicts state.');
    }
    return { entries, state };
  }

  /**
   * Reads and authenticates one entry without retaining plaintext.
   *
   * @param referenceId Stable reference id.
   * @param version Material version.
   * @param sourceFileName Optional exact canonical or interrupted-write source filename.
   * @returns Validated encrypted entry envelope.
   * @throws VaultBackendError when parsing or authentication fails.
   */
  private authenticateEntry(
    referenceId: string,
    version: number,
    sourceFileName?: string
  ): EncryptedFileVaultEntry {
    const source = sourceFileName ? { sourceFileName } : {};
    const entry = readEncryptedFileVaultEntry({
      referenceId,
      storeDir: this.storeDir,
      version,
      ...source,
    });
    const material = openEncryptedFileVaultEntry({
      masterKey: this.masterKey,
      referenceId,
      storeDir: this.storeDir,
      version,
      ...source,
    });
    material.fill(0);
    return entry;
  }

  /**
   * Reads exact path-bound durable state.
   *
   * @param referenceId Stable reference id.
   * @returns Validated state, or undefined when no state file exists.
   * @throws VaultBackendError when the state is malformed or contradicts its path.
   */
  private readReferenceState(referenceId: string): EncryptedFileReferenceState | undefined {
    const path = statePath(this.storeDir, referenceId);
    if (!pathExistsWithoutFollowing(path)) {
      return undefined;
    }

    let value: unknown;
    try {
      assertReferenceDirectory(this.storeDir, referenceId);
      value = JSON.parse(readEncryptedFileVaultText(path));
    } catch {
      throw unavailable('Encrypted-file vault state is invalid.');
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'currentVersion',
        'metadata',
        'referenceId',
        'revoked',
        'updatedAt',
        'versionCount',
        'versionExpirations',
      ])
    ) {
      throw unavailable('Encrypted-file vault state is invalid.');
    }
    try {
      assertVaultEntryMetadata(value.metadata as VaultEntryMetadata);
    } catch {
      throw unavailable('Encrypted-file vault state is invalid.');
    }
    if (
      !Number.isSafeInteger(value.currentVersion) ||
      (value.currentVersion as number) < 1 ||
      value.currentVersion !== value.versionCount ||
      value.referenceId !== referenceId ||
      typeof value.revoked !== 'boolean' ||
      !isCanonicalTimestamp(value.updatedAt) ||
      !isExpirations(value.versionExpirations) ||
      !hasExactExpirationVersions(
        value.versionExpirations as Record<string, string>,
        value.currentVersion as number
      )
    ) {
      throw unavailable('Encrypted-file vault state is invalid.');
    }
    return value as unknown as EncryptedFileReferenceState;
  }

  /**
   * Lists exact version files and rejects every unknown reference artifact.
   *
   * @param referenceId Stable reference id.
   * @returns Sorted material versions.
   * @throws VaultBackendError when the reference directory is unreadable or contains unknown files.
   */
  private referenceVersions(referenceId: string): number[] {
    const entriesDir = join(this.storeDir, 'entries');
    const dir = referenceDir(this.storeDir, referenceId);
    assertEncryptedFileVaultDirectory(this.storeDir);
    if (!pathExistsWithoutFollowing(entriesDir)) {
      return [];
    }
    assertEncryptedFileVaultDirectory(entriesDir);
    if (!pathExistsWithoutFollowing(dir)) {
      return [];
    }
    try {
      assertReferenceDirectory(this.storeDir, referenceId);
      const versions: number[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'state.json' && entry.isFile()) {
          assertEncryptedFileVaultRegularFile(join(dir, entry.name));
          continue;
        }
        const match = entry.isFile() ? ENTRY_FILE_PATTERN.exec(entry.name) : null;
        if (!match) {
          throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
        }
        const versionText = match[1];
        const version = versionText ? parseCanonicalPositiveInteger(versionText) : undefined;
        if (version === undefined) {
          throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
        }
        assertEncryptedFileVaultRegularFile(join(dir, entry.name));
        versions.push(version);
      }
      return versions.sort((left, right) => left - right);
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault reference could not be inspected.');
    }
  }

  /**
   * Lists exact reference directories.
   *
   * @returns Sorted safe reference ids.
   * @throws VaultBackendError when the entries directory contains unknown artifacts.
   */
  private referenceIds(): string[] {
    const dir = join(this.storeDir, 'entries');
    assertEncryptedFileVaultDirectory(this.storeDir);
    if (!pathExistsWithoutFollowing(dir)) {
      return [];
    }
    try {
      assertEncryptedFileVaultDirectory(dir);
      return readdirSync(dir, { withFileTypes: true })
        .map((entry) => {
          if (!entry.isDirectory() || !SAFE_REFERENCE_ID_PATTERN.test(entry.name)) {
            throw unavailable('Encrypted-file vault entries contain an unknown artifact.');
          }
          assertEncryptedFileVaultDirectory(join(dir, entry.name));
          return entry.name;
        })
        .sort();
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault entries could not be inspected.');
    }
  }

  /**
   * Enumerates only exact canonical and interrupted-write files admitted for explicit revoke.
   *
   * @param referenceId Stable reference id.
   * @returns Fully validated cleanup inventory.
   * @throws VaultBackendError when any node, filename, or mode is outside the cleanup grammar.
   */
  private revocationArtifacts(referenceId: string): RevocationArtifactInventory {
    const entriesDir = join(this.storeDir, 'entries');
    const dir = referenceDir(this.storeDir, referenceId);
    assertEncryptedFileVaultDirectory(this.storeDir);
    if (!pathExistsWithoutFollowing(entriesDir)) {
      return { entries: [], stateTemps: [] };
    }
    assertEncryptedFileVaultDirectory(entriesDir);
    if (!pathExistsWithoutFollowing(dir)) {
      return { entries: [], stateTemps: [] };
    }

    try {
      assertReferenceDirectory(this.storeDir, referenceId);
      const entries: RevocationEntryArtifact[] = [];
      const stateTemps: string[] = [];

      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (!entry.isFile()) {
          throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
        }
        assertEncryptedFileVaultRegularFile(path);

        if (entry.name === 'state.json') {
          continue;
        }

        const canonicalMatch = ENTRY_FILE_PATTERN.exec(entry.name);
        if (canonicalMatch) {
          const versionText = canonicalMatch[1];
          const version = versionText ? parseCanonicalPositiveInteger(versionText) : undefined;
          if (version === undefined) {
            throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
          }
          entries.push({ fileName: entry.name, path, version });
          continue;
        }

        const entryTempMatch = ENTRY_TEMP_FILE_PATTERN.exec(entry.name);
        if (entryTempMatch) {
          const versionText = entryTempMatch[1];
          const pidText = entryTempMatch[2];
          const version = versionText ? parseCanonicalPositiveInteger(versionText) : undefined;
          const pid = pidText ? parseCanonicalPositiveInteger(pidText) : undefined;
          if (version === undefined || pid === undefined) {
            throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
          }
          entries.push({ fileName: entry.name, path, version });
          continue;
        }

        const stateTempMatch = STATE_TEMP_FILE_PATTERN.exec(entry.name);
        const stateTempPid = stateTempMatch?.[1];
        if (stateTempPid && parseCanonicalPositiveInteger(stateTempPid) !== undefined) {
          stateTemps.push(path);
          continue;
        }

        throw unavailable('Encrypted-file vault reference contains an unknown artifact.');
      }

      entries.sort(
        (left, right) => left.version - right.version || left.fileName.localeCompare(right.fileName)
      );
      stateTemps.sort();
      return { entries, stateTemps };
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault reference could not be inspected.');
    }
  }

  /**
   * Checks whether a prior version is past its authenticated deadline.
   *
   * @param state Authenticated reference state.
   * @param version Version to check.
   * @returns True only after the recorded deadline.
   */
  private isExpired(state: EncryptedFileReferenceState, version: number): boolean {
    if (version === state.currentVersion) {
      return false;
    }
    const expiresAt = state.versionExpirations[String(version)];
    return expiresAt !== undefined && Date.parse(this.now()) > Date.parse(expiresAt);
  }

  /**
   * Creates the complete prior-version expiration map for a rotation.
   *
   * @param state Authenticated current state.
   * @param rotatedAt Canonical rotation timestamp.
   * @returns Complete expiration map for every prior version.
   */
  private rotatedExpirations(
    state: EncryptedFileReferenceState,
    rotatedAt: string
  ): Record<string, string> {
    const expiresAt = new Date(Date.parse(rotatedAt) + this.rotationGraceMs).toISOString();
    return {
      ...state.versionExpirations,
      [String(state.currentVersion)]: expiresAt,
    };
  }

  /**
   * Removes one already authenticated material version.
   *
   * @param referenceId Stable reference id.
   * @param version Material version to remove.
   * @throws VaultBackendError when deletion fails.
   */
  private destroyVersion(referenceId: string, version: number): void {
    this.destroyArtifact(entryPath(this.storeDir, referenceId, version));
  }

  /**
   * Removes one exact file that already passed no-follow preflight.
   *
   * @param path Exact artifact path.
   * @throws VaultBackendError when deletion fails.
   */
  private destroyArtifact(path: string): void {
    try {
      rmSync(path);
    } catch {
      throw unavailable('Encrypted-file vault material could not be destroyed.');
    }
  }

  /**
   * Writes exact durable state atomically.
   *
   * @param referenceId Stable reference id.
   * @param state Exact path-bound state.
   * @throws VaultBackendError when the state cannot be written.
   */
  private writeReferenceState(referenceId: string, state: EncryptedFileReferenceState): void {
    const path = statePath(this.storeDir, referenceId);
    try {
      assertReferenceDirectory(this.storeDir, referenceId);
      writeEncryptedFileVaultJsonAtomically(path, state);
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }
      throw unavailable('Encrypted-file vault state could not be written.');
    }
  }

  /**
   * Validates a reference id before path use.
   *
   * @param referenceId Candidate reference id.
   * @throws VaultBackendError when the id is unsafe.
   */
  private assertReferenceId(referenceId: string): void {
    if (!SAFE_REFERENCE_ID_PATTERN.test(referenceId)) {
      throw unavailable('Vault reference id is not safe for encrypted-file backend paths.');
    }
  }

  /**
   * Rejects operations through a retained backend after lock or replacement.
   *
   * @throws VaultBackendError when this instance no longer owns the active key.
   */
  private assertKeyActive(): void {
    if (!this.isKeyActive()) {
      throw new VaultBackendError('vault-locked', 'Vault backend is locked.');
    }
  }
}

/**
 * Returns exact metadata without undefined optional keys.
 *
 * @param metadata Validated owner metadata.
 * @returns Canonical metadata object.
 */
function metadataFields(metadata: VaultEntryMetadata): VaultEntryMetadata {
  return {
    ownerScope: metadata.ownerScope,
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.userId ? { userId: metadata.userId } : {}),
    ...(metadata.providerSubscriptionAccount
      ? { providerSubscriptionAccount: { ...metadata.providerSubscriptionAccount } }
      : {}),
  };
}

/**
 * Checks one inventory row against an optional scope filter.
 *
 * @param entry Inventory row to inspect.
 * @param input Optional owner filters.
 * @returns True when every supplied filter matches.
 */
function matchesFilter(
  entry: VaultReferenceInventoryEntry,
  input: VaultListReferencesInput
): boolean {
  return (
    (!input.ownerScope || entry.ownerScope === input.ownerScope) &&
    (!input.workspaceId || entry.workspaceId === input.workspaceId) &&
    (!input.userId || entry.userId === input.userId)
  );
}

/**
 * Checks exact metadata equality.
 *
 * @param left First canonical metadata object.
 * @param right Second canonical metadata object.
 * @returns True when every exact field agrees.
 */
function sameMetadata(left: VaultEntryMetadata, right: VaultEntryMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Checks exact expiration-map equality.
 *
 * @param left First canonical expiration map.
 * @param right Second canonical expiration map.
 * @returns True when keys and values agree exactly.
 */
function sameExpirations(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Checks whether one authenticated snapshot is the exact prefix required for its version.
 *
 * @param prefix Entry-local expiration snapshot.
 * @param current Current state expiration map.
 * @param version Entry version whose prior versions form the required prefix.
 * @returns True when the snapshot contains exactly versions one through version minus one.
 */
function isExactExpirationPrefix(
  prefix: Record<string, string>,
  current: Record<string, string>,
  version: number
): boolean {
  return (
    hasExactExpirationVersions(prefix, version) &&
    Object.entries(prefix).every(([priorVersion, expiresAt]) => current[priorVersion] === expiresAt)
  );
}

/**
 * Checks whether an expiration map contains exactly every prior version.
 *
 * @param expirations Expiration map to inspect.
 * @param currentVersion Current material version.
 * @returns True when keys are exactly one through currentVersion minus one.
 */
function hasExactExpirationVersions(
  expirations: Record<string, string>,
  currentVersion: number
): boolean {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    return false;
  }

  const actual = Object.keys(expirations);
  if (actual.length !== currentVersion - 1) {
    return false;
  }

  return actual.every((key) => {
    const version = parseCanonicalPositiveInteger(key);
    return version !== undefined && version < currentVersion;
  });
}

/**
 * Produces a complete revoked-tombstone expiration map without adding durable lifecycle state.
 *
 * @param currentVersion Highest attributable material version.
 * @param known Authenticated or state-backed expiration values.
 * @param revokedAt Revocation timestamp used only for missing destroyed-version deadlines.
 * @param artifactCount Authenticated material-artifact count that bounds missing-version synthesis.
 * @returns Exact prior-version map for the tombstone.
 */
function normalizeRevokedExpirations(
  currentVersion: number,
  known: Record<string, string>,
  revokedAt: string,
  artifactCount: number
): Record<string, string> {
  assertSafeMaterialVersion(currentVersion);
  const knownEntries = Object.entries(known);
  if (
    knownEntries.some(([version]) => {
      const parsed = parseCanonicalPositiveInteger(version);
      return parsed === undefined || parsed >= currentVersion;
    }) ||
    currentVersion - 1 > knownEntries.length + artifactCount
  ) {
    throw unavailable('Encrypted-file vault material attribution is incomplete.');
  }

  const result: Record<string, string> = {};
  for (let version = 1; version < currentVersion; version += 1) {
    result[String(version)] = known[String(version)] ?? revokedAt;
  }
  return result;
}

/**
 * Checks an exact expiration map.
 *
 * @param value Candidate map.
 * @returns True when every key and timestamp is canonical.
 */
function isExpirations(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([version, expiresAt]) =>
        parseCanonicalPositiveInteger(version) !== undefined && isCanonicalTimestamp(expiresAt)
    )
  );
}

/**
 * Checks whether every expiration key is a safe prior version for one entry.
 *
 * @param expirations Authenticated entry-local expiration map.
 * @param version Entry version that bounds prior keys.
 * @returns True when every key is a canonical safe integer below the entry version.
 */
function hasExpirationVersionsWithinRange(
  expirations: Record<string, string>,
  version: number
): boolean {
  return Object.keys(expirations).every((key) => {
    const priorVersion = parseCanonicalPositiveInteger(key);
    return priorVersion !== undefined && priorVersion < version;
  });
}

/**
 * Merges authenticated expiration values while rejecting contradictions.
 *
 * @param target Mutable collected expiration map.
 * @param source Authenticated expiration values to merge.
 * @throws VaultBackendError when one version has conflicting timestamps.
 */
function mergeExpirations(target: Record<string, string>, source: Record<string, string>): void {
  for (const [version, expiresAt] of Object.entries(source)) {
    if (target[version] !== undefined && target[version] !== expiresAt) {
      throw unavailable('Encrypted-file vault material attribution is inconsistent.');
    }
    target[version] = expiresAt;
  }
}

/**
 * Parses one canonical positive safe integer without accepting rounded decimal text.
 *
 * @param value Candidate decimal text.
 * @returns Parsed integer, or undefined when unsafe or non-canonical.
 */
function parseCanonicalPositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value
    ? parsed
    : undefined;
}

/**
 * Validates one requested or derived material version.
 *
 * @param version Candidate material version.
 * @throws VaultBackendError when the version is not a positive safe integer.
 */
function assertSafeMaterialVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw unavailable('Encrypted-file vault material version is invalid.');
  }
}

/**
 * Checks one canonical UTC ISO timestamp.
 *
 * @param value Candidate timestamp.
 * @returns True when the value is the canonical UTC ISO representation.
 */
function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/**
 * Checks whether a value is a non-array record.
 *
 * @param value Candidate value.
 * @returns True when the value is an object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a record has exactly the requested keys.
 *
 * @param value Record to inspect.
 * @param keys Required exact keys.
 * @returns True when no key is missing or extra.
 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Returns one reference directory path.
 *
 * @param storeDir Vault store directory.
 * @param referenceId Stable reference id.
 * @returns Reference directory path.
 */
function referenceDir(storeDir: string, referenceId: string): string {
  return join(storeDir, 'entries', referenceId);
}

/**
 * Returns one reference state path.
 *
 * @param storeDir Vault store directory.
 * @param referenceId Stable reference id.
 * @returns State file path.
 */
function statePath(storeDir: string, referenceId: string): string {
  return join(referenceDir(storeDir, referenceId), 'state.json');
}

/**
 * Returns one encrypted material entry path.
 *
 * @param storeDir Vault store directory.
 * @param referenceId Stable reference id.
 * @param version Material version.
 * @returns Encrypted entry path.
 */
function entryPath(storeDir: string, referenceId: string, version: number): string {
  return join(referenceDir(storeDir, referenceId), `${version}.enc`);
}

/**
 * Validates the store root, entries directory, and exact reference directory.
 *
 * @param storeDir Canonical Vault store root.
 * @param referenceId Stable safe reference id.
 * @returns Canonical reference directory path.
 * @throws VaultBackendError when any directory is a symlink, wrong node, or wrong mode.
 */
function assertReferenceDirectory(storeDir: string, referenceId: string): string {
  const canonicalStoreDir = assertEncryptedFileVaultDirectory(storeDir);
  const entriesDir = assertEncryptedFileVaultDirectory(join(canonicalStoreDir, 'entries'));
  return assertEncryptedFileVaultDirectory(join(entriesDir, referenceId));
}

/**
 * Checks path existence without following a leaf symlink.
 *
 * @param path Candidate path.
 * @returns True when any filesystem node occupies the path.
 */
function pathExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw unavailable('Encrypted-file vault path could not be inspected.');
  }
}

/**
 * Builds a stable redacted backend-unavailable error.
 *
 * @param message Fixed non-secret diagnostic.
 * @returns Typed backend error.
 */
function unavailable(message: string): VaultBackendError {
  return new VaultBackendError('backend-unavailable', message);
}
