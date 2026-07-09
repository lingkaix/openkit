import { lstatSync, readFileSync } from 'node:fs';

import { VaultBackendError } from './vault-backend.js';

/** Required byte length for raw encrypted-file vault master keys. */
const RAW_KEY_BYTE_LENGTH = 32;

/** Required permission bits for encrypted-file vault key files. */
const REQUIRED_KEY_FILE_MODE = 0o600;

/** Input used to load a raw encrypted-file vault key file. */
export interface LoadEncryptedFileVaultKeyFileInput {
  /** Absolute path to the configured raw key file. */
  readonly keyFilePath: string;
}

/**
 * Loads a raw encrypted-file vault master key from an owner-only key file.
 *
 * @param input Configured key file path.
 * @returns Raw 32-byte master key.
 * @throws VaultBackendError when the file is not a regular 0600 file with exactly 32 bytes.
 */
export function loadEncryptedFileVaultKeyFile(input: LoadEncryptedFileVaultKeyFileInput): Buffer {
  const stats = lstatSync(input.keyFilePath);

  if (!stats.isFile()) {
    throw invalidKeyFileError('Vault key source must be a regular file.');
  }

  if ((stats.mode & 0o777) !== REQUIRED_KEY_FILE_MODE) {
    throw invalidKeyFileError('Vault key file must use 0600 permissions.');
  }

  const key = readFileSync(input.keyFilePath);

  if (key.byteLength !== RAW_KEY_BYTE_LENGTH) {
    throw invalidKeyFileError('Vault key file must contain exactly 32 bytes.');
  }

  return key;
}

/**
 * Creates a redacted backend error for invalid key file sources.
 *
 * @param message Redacted diagnostic message.
 * @returns Typed vault backend error.
 */
function invalidKeyFileError(message: string): VaultBackendError {
  return new VaultBackendError('backend-unavailable', message);
}
