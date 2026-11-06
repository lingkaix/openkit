import { writeCanonicalFileAtomic } from '@openkit/storage';
import type { FileStorageAdmission, FileStorageReservation } from './artifacts/file-admission.js';

let activeAdmission: FileStorageAdmission | undefined;

/** Uses the existing disk-capacity owner during one synchronous canonical mutation, including compensation and event appends. No asynchronous work may escape this scope. */
export function withCanonicalFileWriteAdmission<T>(
  admission: FileStorageAdmission,
  write: () => T
): T {
  const previous = activeAdmission;
  activeAdmission = admission;
  try {
    const result = write();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Canonical write admission requires a synchronous mutation.');
    }
    return result;
  } finally {
    activeAdmission = previous;
  }
}

/** Reserves the exact pending serialized bytes and bounded filesystem overhead before creating a temporary file or appending. Other requests keep their existing reservations. */
export function reserveCanonicalFileWrite(byteLength: number): FileStorageReservation | undefined {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new Error('Canonical write length is invalid.');
  return activeAdmission?.reserve({
    stagingBytes: BigInt(byteLength),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 65_536n,
  });
}

/**
 * Writes complete bytes durably through a same-directory temporary file.
 *
 * @param path Target file path.
 * @param content Complete file content.
 * @param mode Exact replacement mode when supplied; otherwise the private writer default.
 * @param publication Replace by rename, or create by link without clobbering an existing file.
 */
export function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  mode?: number,
  publication: 'replace' | 'create' = 'replace'
): void {
  const byteLength = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  const reservation = reserveCanonicalFileWrite(byteLength);
  writeCanonicalFileAtomic(path, content, byteLength, reservation, mode, publication);
}
