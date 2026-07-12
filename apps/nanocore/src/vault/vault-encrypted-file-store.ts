import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { VaultBackendError, type VaultOwnerScope } from './vault-backend.js';
import { ensureEncryptedFileVaultStoreDirectory } from './vault-store-directory.js';

/** Current encrypted-file vault store format version. */
const ENCRYPTED_FILE_STORE_FORMAT_VERSION = 1;

/** Required mode for encrypted-file vault store files. */
const REQUIRED_STORE_FILE_MODE = 0o600;

/** Required mode for encrypted-file vault entry directories. */
const REQUIRED_ENTRY_DIRECTORY_MODE = 0o700;

/** AEAD algorithm used by the first encrypted-file implementation. */
const ENCRYPTED_FILE_AEAD_ALGORITHM = 'aes-256-gcm';

/** Required raw master and data key byte length. */
const REQUIRED_KEY_BYTES = 32;

/** AES-GCM nonce byte length. */
const REQUIRED_NONCE_BYTES = 12;

/** AES-GCM authentication tag byte length. */
const REQUIRED_TAG_BYTES = 16;

/** Safe reference id characters for encrypted-file store paths. */
const SAFE_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Random byte source used by encrypted-file seal operations. */
type RandomBytes = (size: number) => Buffer;

/** Durable encrypted-file vault store header. */
interface EncryptedFileVaultStoreHeader {
  /** Store format version. */
  readonly formatVersion: typeof ENCRYPTED_FILE_STORE_FORMAT_VERSION;
  /** KDF metadata. */
  readonly kdf: { readonly kind: 'raw-key-file' };
  /** Master-key verification metadata. */
  readonly masterKeyVerification: {
    readonly algorithm: typeof ENCRYPTED_FILE_AEAD_ALGORITHM;
    readonly nonce: string;
    readonly tag: string;
  };
  /** ISO timestamp for header creation. */
  readonly createdAt: string;
}

/** Wrapped data-key metadata stored beside one encrypted entry version. */
export interface EncryptedFileVaultEntryDataKey {
  /** Data-key wrap algorithm. */
  readonly algorithm: typeof ENCRYPTED_FILE_AEAD_ALGORITHM;
  /** Data-key wrap nonce. */
  readonly nonce: string;
  /** Wrapped data key. */
  readonly wrapped: string;
  /** Data-key wrap authentication tag. */
  readonly tag: string;
}

/** Non-secret metadata stored beside one encrypted entry version. */
export interface EncryptedFileVaultEntryMetadata {
  /** Scope that owns the vault reference. */
  readonly ownerScope: VaultOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string;
  /** User id when ownerScope is user. */
  readonly userId?: string;
}

/** Associated data bound into one encrypted entry version. */
export interface EncryptedFileVaultEntryAssociatedData {
  /** Vault reference id bound into AEAD associated data. */
  readonly referenceId: string;
  /** Material version bound into AEAD associated data. */
  readonly version: number;
}

/** Durable encrypted-file vault entry envelope. */
export interface EncryptedFileVaultEntry {
  /** Store format version. */
  readonly formatVersion: typeof ENCRYPTED_FILE_STORE_FORMAT_VERSION;
  /** Vault reference id. */
  readonly referenceId: string;
  /** Material version. */
  readonly version: number;
  /** AEAD associated data. */
  readonly associatedData: EncryptedFileVaultEntryAssociatedData;
  /** Non-secret ownership metadata. */
  readonly metadata: EncryptedFileVaultEntryMetadata;
  /** Entry AEAD algorithm. */
  readonly algorithm: typeof ENCRYPTED_FILE_AEAD_ALGORITHM;
  /** Entry nonce. */
  readonly nonce: string;
  /** Entry ciphertext. */
  readonly ciphertext: string;
  /** Entry authentication tag. */
  readonly tag: string;
  /** Wrapped data-key metadata. */
  readonly dataKey: EncryptedFileVaultEntryDataKey;
  /** ISO timestamp for entry creation. */
  readonly createdAt: string;
}

/** Input used to write one encrypted-file vault entry envelope. */
export interface WriteEncryptedFileVaultEntryInput {
  /** Absolute encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Vault reference id. */
  readonly referenceId: string;
  /** Material version. */
  readonly version: number;
  /** Non-secret ownership metadata. */
  readonly metadata: EncryptedFileVaultEntryMetadata;
  /** Entry nonce. */
  readonly nonce: string;
  /** Entry ciphertext. */
  readonly ciphertext: string;
  /** Entry authentication tag. */
  readonly tag: string;
  /** Wrapped data-key metadata. */
  readonly dataKey: EncryptedFileVaultEntryDataKey;
  /** ISO timestamp for entry creation. */
  readonly createdAt: string;
}

/** Input used to read one encrypted-file vault entry envelope. */
export interface ReadEncryptedFileVaultEntryInput {
  /** Absolute encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Vault reference id. */
  readonly referenceId: string;
  /** Material version. */
  readonly version: number;
}

/** Input used to seal one encrypted-file vault entry. */
export interface SealEncryptedFileVaultEntryInput {
  /** Absolute encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Vault reference id. */
  readonly referenceId: string;
  /** Material version. */
  readonly version: number;
  /** Non-secret ownership metadata. */
  readonly metadata: EncryptedFileVaultEntryMetadata;
  /** Secret material to seal. */
  readonly material: string | Uint8Array;
  /** Raw 32-byte master key used to wrap the per-entry data key. */
  readonly masterKey: Uint8Array;
  /** ISO timestamp for entry creation. */
  readonly createdAt: string;
  /** Optional deterministic byte source for tests. */
  readonly randomBytes?: RandomBytes;
}

/** Input used to open one encrypted-file vault entry. */
export interface OpenEncryptedFileVaultEntryInput {
  /** Absolute encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Vault reference id. */
  readonly referenceId: string;
  /** Material version. */
  readonly version: number;
  /** Raw 32-byte master key used to unwrap the per-entry data key. */
  readonly masterKey: Uint8Array;
}

/**
 * Initializes or verifies the encrypted-file store master-key header.
 *
 * @param input Store directory and owned master key.
 * @throws VaultBackendError when the store is unsafe, malformed, or authenticated by another key.
 */
export function initializeOrVerifyEncryptedFileVaultStore(input: {
  readonly masterKey: Uint8Array;
  readonly storeDir: string;
}): void {
  assertMasterKey(input.masterKey);
  ensureEncryptedFileVaultStoreDirectory({ storeDir: input.storeDir });
  const path = headerPath(input.storeDir);

  if (!existsSync(path)) {
    if (readdirSync(input.storeDir).length > 0) {
      throw invalidStoreFormatError(
        'Encrypted-file vault header is missing from a non-empty store.'
      );
    }

    const createdAt = new Date().toISOString();
    const nonce = nodeRandomBytes(REQUIRED_NONCE_BYTES);

    try {
      const verification = encryptAesGcm(
        Buffer.alloc(0),
        input.masterKey,
        nonce,
        headerAssociatedDataBuffer(createdAt)
      );
      const header: EncryptedFileVaultStoreHeader = {
        createdAt,
        formatVersion: ENCRYPTED_FILE_STORE_FORMAT_VERSION,
        kdf: { kind: 'raw-key-file' },
        masterKeyVerification: {
          algorithm: ENCRYPTED_FILE_AEAD_ALGORITHM,
          nonce: nonce.toString('base64'),
          tag: verification.tag,
        },
      };

      writeJsonFileAtomically(path, header);
    } catch (error) {
      if (error instanceof VaultBackendError) {
        throw error;
      }

      throw invalidStoreFormatError('Encrypted-file vault header could not be initialized.');
    } finally {
      nonce.fill(0);
    }
    return;
  }

  const header = readEncryptedFileVaultStoreHeader(path);

  try {
    const verification = decryptAesGcm({
      associatedData: headerAssociatedDataBuffer(header.createdAt),
      ciphertext: '',
      key: input.masterKey,
      nonce: header.masterKeyVerification.nonce,
      tag: header.masterKeyVerification.tag,
    });

    verification.fill(0);
  } catch {
    throw invalidStoreFormatError('Encrypted-file vault master key failed authentication.');
  }
}

/**
 * Writes one encrypted-file vault entry envelope.
 *
 * @param input Entry envelope fields and store directory.
 * @returns Written entry envelope.
 */
export function writeEncryptedFileVaultEntry(
  input: WriteEncryptedFileVaultEntryInput
): EncryptedFileVaultEntry {
  ensureEncryptedFileVaultStoreDirectory({ storeDir: input.storeDir });
  assertSafeReferenceId(input.referenceId);
  assertPositiveVersion(input.version);

  const entry: EncryptedFileVaultEntry = {
    algorithm: ENCRYPTED_FILE_AEAD_ALGORITHM,
    associatedData: {
      referenceId: input.referenceId,
      version: input.version,
    },
    ciphertext: input.ciphertext,
    createdAt: input.createdAt,
    dataKey: input.dataKey,
    formatVersion: ENCRYPTED_FILE_STORE_FORMAT_VERSION,
    metadata: input.metadata,
    nonce: input.nonce,
    referenceId: input.referenceId,
    tag: input.tag,
    version: input.version,
  };
  const path = entryPath(input.storeDir, input.referenceId, input.version);

  mkdirSync(dirname(path), { mode: REQUIRED_ENTRY_DIRECTORY_MODE, recursive: true });
  chmodSync(dirname(path), REQUIRED_ENTRY_DIRECTORY_MODE);
  writeJsonFileAtomically(path, entry);
  return entry;
}

/**
 * Reads one encrypted-file vault entry envelope.
 *
 * @param input Entry identity and store directory.
 * @returns Parsed entry envelope.
 * @throws VaultBackendError when the envelope is invalid or not bound to the requested identity.
 */
export function readEncryptedFileVaultEntry(
  input: ReadEncryptedFileVaultEntryInput
): EncryptedFileVaultEntry {
  assertSafeReferenceId(input.referenceId);
  assertPositiveVersion(input.version);

  const entry = JSON.parse(
    readFileSync(entryPath(input.storeDir, input.referenceId, input.version), 'utf8')
  ) as EncryptedFileVaultEntry;

  if (
    entry.formatVersion !== ENCRYPTED_FILE_STORE_FORMAT_VERSION ||
    entry.referenceId !== input.referenceId ||
    entry.version !== input.version ||
    !entry.associatedData ||
    entry.associatedData?.referenceId !== input.referenceId ||
    entry.associatedData.version !== input.version
  ) {
    throw invalidStoreFormatError('Encrypted-file vault entry identity does not match its path.');
  }

  if (
    entry.algorithm !== ENCRYPTED_FILE_AEAD_ALGORITHM ||
    entry.dataKey.algorithm !== ENCRYPTED_FILE_AEAD_ALGORITHM
  ) {
    throw invalidStoreFormatError('Unsupported encrypted-file vault entry algorithm.');
  }

  return entry;
}

/**
 * Seals one secret material value into an encrypted-file vault entry.
 *
 * @param input Secret material, master key, metadata, and target identity.
 * @returns Written encrypted entry envelope.
 * @throws VaultBackendError when key material or entry identity is invalid.
 */
export function sealEncryptedFileVaultEntry(
  input: SealEncryptedFileVaultEntryInput
): EncryptedFileVaultEntry {
  assertMasterKey(input.masterKey);

  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const dataKey = randomBytes(REQUIRED_KEY_BYTES);
  const material = Buffer.from(input.material);
  let entryNonce: Buffer | undefined;
  let wrapNonce: Buffer | undefined;

  try {
    entryNonce = randomBytes(REQUIRED_NONCE_BYTES);
    wrapNonce = randomBytes(REQUIRED_NONCE_BYTES);
    const associatedData = entryAssociatedDataBuffer({
      referenceId: input.referenceId,
      version: input.version,
    });
    const sealed = encryptAesGcm(material, dataKey, entryNonce, associatedData);
    const wrapped = encryptAesGcm(
      dataKey,
      input.masterKey,
      wrapNonce,
      dataKeyAssociatedDataBuffer(input.referenceId, input.version)
    );

    return writeEncryptedFileVaultEntry({
      ciphertext: sealed.ciphertext,
      createdAt: input.createdAt,
      dataKey: {
        algorithm: ENCRYPTED_FILE_AEAD_ALGORITHM,
        nonce: wrapNonce.toString('base64'),
        tag: wrapped.tag,
        wrapped: wrapped.ciphertext,
      },
      metadata: input.metadata,
      nonce: entryNonce.toString('base64'),
      referenceId: input.referenceId,
      storeDir: input.storeDir,
      tag: sealed.tag,
      version: input.version,
    });
  } finally {
    dataKey.fill(0);
    material.fill(0);
    entryNonce?.fill(0);
    wrapNonce?.fill(0);
  }
}

/**
 * Opens one encrypted-file vault entry into secret material bytes.
 *
 * @param input Entry identity, store directory, and master key.
 * @returns Secret material bytes.
 * @throws VaultBackendError when authentication fails or key material is invalid.
 */
export function openEncryptedFileVaultEntry(input: OpenEncryptedFileVaultEntryInput): Uint8Array {
  assertMasterKey(input.masterKey);
  let dataKey: Buffer | undefined;

  try {
    const entry = readEncryptedFileVaultEntry(input);
    dataKey = decryptAesGcm({
      ciphertext: entry.dataKey.wrapped,
      key: input.masterKey,
      nonce: entry.dataKey.nonce,
      associatedData: dataKeyAssociatedDataBuffer(entry.referenceId, entry.version),
      tag: entry.dataKey.tag,
    });

    return decryptAesGcm({
      ciphertext: entry.ciphertext,
      key: dataKey,
      nonce: entry.nonce,
      associatedData: entryAssociatedDataBuffer(entry.associatedData),
      tag: entry.tag,
    });
  } catch (error) {
    if (error instanceof VaultBackendError) {
      throw error;
    }

    throw invalidStoreFormatError('Encrypted-file vault entry failed authentication.');
  } finally {
    dataKey?.fill(0);
  }
}

/**
 * Reads and validates one encrypted-file store header.
 *
 * @param path Header file path.
 * @returns Validated raw-key-file header.
 * @throws VaultBackendError when the header is unreadable or unsupported.
 */
function readEncryptedFileVaultStoreHeader(path: string): EncryptedFileVaultStoreHeader {
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw invalidStoreFormatError('Encrypted-file vault header is invalid.');
  }

  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['createdAt', 'formatVersion', 'kdf', 'masterKeyVerification'])
  ) {
    throw invalidStoreFormatError('Encrypted-file vault header is invalid.');
  }

  const kdf = value.kdf;
  const verification = value.masterKeyVerification;

  if (
    value.formatVersion !== ENCRYPTED_FILE_STORE_FORMAT_VERSION ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(kdf) ||
    !hasExactKeys(kdf, ['kind']) ||
    kdf.kind !== 'raw-key-file' ||
    !isRecord(verification) ||
    !hasExactKeys(verification, ['algorithm', 'nonce', 'tag']) ||
    verification.algorithm !== ENCRYPTED_FILE_AEAD_ALGORITHM ||
    !isBase64Bytes(verification.nonce, REQUIRED_NONCE_BYTES) ||
    !isBase64Bytes(verification.tag, REQUIRED_TAG_BYTES)
  ) {
    throw invalidStoreFormatError('Unsupported encrypted-file vault header format.');
  }

  return value as unknown as EncryptedFileVaultStoreHeader;
}

/**
 * Returns the store header path.
 *
 * @param storeDir Store directory.
 * @returns Header file path.
 */
function headerPath(storeDir: string): string {
  return join(storeDir, 'header.json');
}

/**
 * Builds fixed associated data for master-key verification.
 *
 * @param createdAt Authenticated header creation timestamp.
 * @returns Stable non-secret header metadata bytes.
 */
function headerAssociatedDataBuffer(createdAt: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      createdAt,
      formatVersion: ENCRYPTED_FILE_STORE_FORMAT_VERSION,
      kdf: { kind: 'raw-key-file' },
      purpose: 'openkit.encrypted-file.master-key-verification',
    }),
    'utf8'
  );
}

/**
 * Returns one entry envelope path.
 *
 * @param storeDir Store directory.
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
    mode: REQUIRED_STORE_FILE_MODE,
  });
  chmodSync(tempPath, REQUIRED_STORE_FILE_MODE);
  renameSync(tempPath, path);
}

/**
 * Encrypts one value with AES-256-GCM.
 *
 * @param plaintext Plaintext bytes.
 * @param key Raw 32-byte key.
 * @param nonce Raw nonce bytes.
 * @param associatedData AEAD associated data.
 * @returns Base64 ciphertext and tag.
 */
function encryptAesGcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array
): { ciphertext: string; tag: string } {
  const cipher = createCipheriv(ENCRYPTED_FILE_AEAD_ALGORITHM, key, nonce);
  cipher.setAAD(associatedData);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts one AES-256-GCM value.
 *
 * @param input Base64 ciphertext, key, nonce, associated data, and tag.
 * @returns Plaintext bytes.
 */
function decryptAesGcm(input: {
  readonly ciphertext: string;
  readonly key: Uint8Array;
  readonly nonce: string;
  readonly associatedData: Uint8Array;
  readonly tag: string;
}): Buffer {
  const decipher = createDecipheriv(
    ENCRYPTED_FILE_AEAD_ALGORITHM,
    input.key,
    Buffer.from(input.nonce, 'base64')
  );
  decipher.setAAD(input.associatedData);
  decipher.setAuthTag(Buffer.from(input.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

/**
 * Builds AEAD associated data for one entry payload.
 *
 * @param associatedData Entry associated data.
 * @returns Stable associated data bytes.
 */
function entryAssociatedDataBuffer(associatedData: EncryptedFileVaultEntryAssociatedData): Buffer {
  return Buffer.from(
    JSON.stringify({
      referenceId: associatedData.referenceId,
      version: associatedData.version,
    }),
    'utf8'
  );
}

/**
 * Builds AEAD associated data for one wrapped data key.
 *
 * @param referenceId Vault reference id.
 * @param version Material version.
 * @returns Stable associated data bytes.
 */
function dataKeyAssociatedDataBuffer(referenceId: string, version: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: 'openkit.encrypted-file.data-key',
      referenceId,
      version,
    }),
    'utf8'
  );
}

/**
 * Checks whether a value is a plain record.
 *
 * @param value Candidate value.
 * @returns True when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a record has exactly the allowed keys.
 *
 * @param value Record to inspect.
 * @param keys Expected keys.
 * @returns True when no key is absent or extra.
 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Checks one canonical base64 value for an exact decoded byte length.
 *
 * @param value Candidate base64 value.
 * @param byteLength Required decoded length.
 * @returns True when the value is canonical base64 with the requested length.
 */
function isBase64Bytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const decoded = Buffer.from(value, 'base64');

  return decoded.byteLength === byteLength && decoded.toString('base64') === value;
}

/**
 * Validates raw encrypted-file master key length.
 *
 * @param masterKey Raw master key bytes.
 * @throws VaultBackendError when the key is not exactly 32 bytes.
 */
function assertMasterKey(masterKey: Uint8Array): void {
  if (masterKey.byteLength !== REQUIRED_KEY_BYTES) {
    throw invalidStoreFormatError('Encrypted-file vault master key must be 32 bytes.');
  }
}

/**
 * Validates a vault reference id for path use.
 *
 * @param referenceId Vault reference id.
 * @throws VaultBackendError when the reference id is unsafe.
 */
function assertSafeReferenceId(referenceId: string): void {
  if (!SAFE_REFERENCE_ID_PATTERN.test(referenceId)) {
    throw invalidStoreFormatError('Vault reference id is not safe for encrypted-file store paths.');
  }
}

/**
 * Validates an entry version.
 *
 * @param version Entry version.
 * @throws VaultBackendError when the version is invalid.
 */
function assertPositiveVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw invalidStoreFormatError('Vault entry version must be a positive integer.');
  }
}

/**
 * Creates a redacted backend error for invalid encrypted-file store formats.
 *
 * @param message Redacted diagnostic message.
 * @returns Typed vault backend error.
 */
function invalidStoreFormatError(message: string): VaultBackendError {
  return new VaultBackendError('backend-unavailable', message);
}
