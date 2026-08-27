import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import { VaultBackendError } from './vault-backend.js';

/** Required byte length for raw encrypted-file vault master keys. */
const RAW_KEY_BYTE_LENGTH = 32;

/** Required permission bits for encrypted-file vault key files. */
const REQUIRED_KEY_FILE_MODE = 0o600;

/**
 * Loads a raw encrypted-file vault master key from an owner-only key file.
 *
 * @param input Absolute Data Root path and absolute external key-file path.
 * @returns Raw 32-byte master key.
 * @throws VaultBackendError when either configured path is not absolute or the canonical key is not external to the canonical Data Root.
 * @throws VaultBackendError when descriptor and canonical identities differ or the key source is not a current-owner regular exact-0600 file containing exactly 32 bytes.
 */
export function loadEncryptedFileVaultKeyFile(input: {
  readonly dataRoot: string;
  readonly keyFilePath: string;
}): Buffer {
  if (
    !isAbsolute(input.dataRoot) ||
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
    const stats = fstatSync(fileDescriptor, { bigint: true });

    if (!stats.isFile()) {
      throw invalidKeyFileError('Vault key source must be a regular file.');
    }
    if ((stats.mode & 0o777n) !== BigInt(REQUIRED_KEY_FILE_MODE)) {
      throw invalidKeyFileError('Vault key file must use 0600 permissions.');
    }
    if (stats.uid !== BigInt(process.geteuid())) {
      throw invalidKeyFileError('Vault key file must be owned by the current user.');
    }

    const canonicalDataRoot = realpathSync(input.dataRoot);
    const canonicalKeyFile = realpathSync(input.keyFilePath);
    const canonicalKeyStats = statSync(canonicalKeyFile, { bigint: true });
    const relativeKeyPath = relative(canonicalDataRoot, canonicalKeyFile);

    if (canonicalKeyStats.dev !== stats.dev || canonicalKeyStats.ino !== stats.ino) {
      throw invalidKeyFileError('Vault key file identity changed during validation.');
    }
    if (
      relativeKeyPath === '' ||
      (relativeKeyPath !== '..' &&
        !relativeKeyPath.startsWith(`..${sep}`) &&
        !isAbsolute(relativeKeyPath))
    ) {
      throw invalidKeyFileError('Vault key file must remain outside the Data Root.');
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
