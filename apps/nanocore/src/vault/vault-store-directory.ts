import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { VaultBackendError } from './vault-backend.js';

/** Required permission bits for encrypted-file vault store directories. */
const REQUIRED_STORE_DIRECTORY_MODE = 0o700;

/** Input used to ensure the encrypted-file vault store directory. */
export interface EnsureEncryptedFileVaultStoreDirectoryInput {
  /** Absolute path to the encrypted-file vault store directory. */
  readonly storeDir: string;
}

/** Result returned after ensuring the encrypted-file vault store directory. */
export interface EnsuredEncryptedFileVaultStoreDirectory {
  /** Absolute path to the encrypted-file vault store directory. */
  readonly storeDir: string;
  /** Permission mode required by the encrypted-file store. */
  readonly mode: typeof REQUIRED_STORE_DIRECTORY_MODE;
}

/**
 * Ensures the encrypted-file vault store directory exists with owner-only permissions.
 *
 * @param input Configured store directory path.
 * @returns Store directory path and required permission mode.
 * @throws VaultBackendError when the existing path is not a 0700 directory.
 */
export function ensureEncryptedFileVaultStoreDirectory(
  input: EnsureEncryptedFileVaultStoreDirectoryInput
): EnsuredEncryptedFileVaultStoreDirectory {
  try {
    if (!isAbsolute(input.storeDir)) {
      throw invalidStoreDirectoryError('Vault store path must be absolute.');
    }
    if (!existsSync(input.storeDir)) {
      mkdirSync(input.storeDir, { mode: REQUIRED_STORE_DIRECTORY_MODE, recursive: true });
      chmodSync(input.storeDir, REQUIRED_STORE_DIRECTORY_MODE);
    }

    const stats = lstatSync(input.storeDir);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw invalidStoreDirectoryError('Vault store path must be a directory.');
    }

    if (
      (stats.mode & 0o777) !== REQUIRED_STORE_DIRECTORY_MODE &&
      readdirSync(input.storeDir).length === 0
    ) {
      chmodSync(input.storeDir, REQUIRED_STORE_DIRECTORY_MODE);
    } else if ((stats.mode & 0o777) !== REQUIRED_STORE_DIRECTORY_MODE) {
      throw invalidStoreDirectoryError('Vault store directory must use 0700 permissions.');
    }

    assertEncryptedFileVaultDirectory(input.storeDir);

    return {
      mode: REQUIRED_STORE_DIRECTORY_MODE,
      storeDir: input.storeDir,
    };
  } catch (error) {
    if (error instanceof VaultBackendError) {
      throw error;
    }
    throw invalidStoreDirectoryError('Vault store directory could not be validated securely.');
  }
}

/**
 * Validates one existing owner-only encrypted-file Vault directory.
 *
 * @param directoryPath Existing directory path.
 * @returns Canonical directory path.
 * @throws VaultBackendError when the path is a symlink, wrong node type, or not mode 0700.
 */
export function assertEncryptedFileVaultDirectory(directoryPath: string): string {
  try {
    const stats = lstatSync(directoryPath);

    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (stats.mode & 0o777) !== REQUIRED_STORE_DIRECTORY_MODE
    ) {
      throw invalidStoreDirectoryError('Vault directory is not an owner-only regular directory.');
    }

    return realpathSync(directoryPath);
  } catch (error) {
    if (error instanceof VaultBackendError) {
      throw error;
    }
    throw invalidStoreDirectoryError('Vault directory could not be validated securely.');
  }
}

/**
 * Ensures one direct child directory without recursive creation or symlink traversal.
 *
 * @param input Canonical parent directory and one safe child name.
 * @returns Canonical child directory path.
 * @throws VaultBackendError when the parent or child is unsafe.
 */
export function ensureEncryptedFileVaultChildDirectory(input: {
  readonly childName: string;
  readonly parentDir: string;
}): string {
  try {
    const canonicalParent = assertEncryptedFileVaultDirectory(input.parentDir);
    const childPath = join(canonicalParent, input.childName);

    if (!existsSync(childPath)) {
      mkdirSync(childPath, { mode: REQUIRED_STORE_DIRECTORY_MODE });
      chmodSync(childPath, REQUIRED_STORE_DIRECTORY_MODE);
    }

    return assertEncryptedFileVaultDirectory(childPath);
  } catch (error) {
    if (error instanceof VaultBackendError) {
      throw error;
    }
    throw invalidStoreDirectoryError('Vault child directory could not be created securely.');
  }
}

/**
 * Creates a redacted backend error for invalid store directories.
 *
 * @param message Redacted diagnostic message.
 * @returns Typed vault backend error.
 */
function invalidStoreDirectoryError(message: string): VaultBackendError {
  return new VaultBackendError('backend-unavailable', message);
}
