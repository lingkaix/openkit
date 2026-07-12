import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';

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
  if (!existsSync(input.storeDir)) {
    mkdirSync(input.storeDir, { mode: REQUIRED_STORE_DIRECTORY_MODE, recursive: true });
    chmodSync(input.storeDir, REQUIRED_STORE_DIRECTORY_MODE);
  }

  const stats = lstatSync(input.storeDir);

  if (!stats.isDirectory()) {
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

  return {
    mode: REQUIRED_STORE_DIRECTORY_MODE,
    storeDir: input.storeDir,
  };
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
