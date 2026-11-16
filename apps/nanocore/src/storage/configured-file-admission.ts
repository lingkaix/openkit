import { loadOpenKitConfig } from '../config/openkit-config.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { DEFAULT_FILE_RESERVE_BYTES } from './file-reserve.js';

/** Snapshots validated configuration for a stopped or standalone root; absent configuration keeps the server default. */
export function configuredFileStorageAdmission(dataRoot: string): FileStorageAdmission {
  const reserveBytes = BigInt(
    loadOpenKitConfig(dataRoot).server?.fileReserveBytes ?? DEFAULT_FILE_RESERVE_BYTES
  );
  return new FileStorageAdmission(dataRoot, () => reserveBytes);
}
