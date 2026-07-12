import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { VaultBackendError } from './vault-backend.js';

/** Required byte length for raw encrypted-file vault master keys. */
const RAW_KEY_BYTE_LENGTH = 32;

/** Required permission bits for encrypted-file vault key files. */
const REQUIRED_KEY_FILE_MODE = 0o600;

/**
 * Loads a raw encrypted-file vault master key from an owner-only key file.
 *
 * @param input Configured key file path.
 * @returns Raw 32-byte master key.
 * @throws VaultBackendError when the file is not a regular 0600 file with exactly 32 bytes.
 */
export function loadEncryptedFileVaultKeyFile(input: { readonly keyFilePath: string }): Buffer {
  if (
    !isAbsolute(input.keyFilePath) ||
    typeof process.geteuid !== 'function' ||
    typeof constants.O_NOFOLLOW !== 'number' ||
    constants.O_NOFOLLOW === 0
  ) {
    throw invalidKeyFileError('Vault key file cannot be loaded securely on this platform.');
  }

  const readBuffer = Buffer.alloc(RAW_KEY_BYTE_LENGTH + 1);
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(input.keyFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fileDescriptor);

    if (!stats.isFile()) {
      throw invalidKeyFileError('Vault key source must be a regular file.');
    }
    if ((stats.mode & 0o777) !== REQUIRED_KEY_FILE_MODE) {
      throw invalidKeyFileError('Vault key file must use 0600 permissions.');
    }
    if (stats.uid !== process.geteuid()) {
      throw invalidKeyFileError('Vault key file must be owned by the current user.');
    }

    let bytesRead = 0;

    while (bytesRead < readBuffer.byteLength) {
      const count = readSync(
        fileDescriptor,
        readBuffer,
        bytesRead,
        readBuffer.byteLength - bytesRead,
        bytesRead
      );

      if (count === 0) {
        break;
      }
      bytesRead += count;
    }

    if (bytesRead !== RAW_KEY_BYTE_LENGTH) {
      throw invalidKeyFileError('Vault key file must contain exactly 32 bytes.');
    }

    return Buffer.from(readBuffer.subarray(0, RAW_KEY_BYTE_LENGTH));
  } catch (error) {
    if (error instanceof VaultBackendError) {
      throw error;
    }

    throw invalidKeyFileError('Vault key file could not be loaded securely.');
  } finally {
    readBuffer.fill(0);

    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The descriptor is process-local and every exposed failure remains redacted.
      }
    }
  }
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
