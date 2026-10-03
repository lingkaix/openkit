import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  DATA_ROOT_ADMIN_OPERATION_DEFINITIONS,
  OperationInput,
  OperationOutput,
} from '@openkit/app-api-schemas';
import {
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyResponseSchema,
  StorageLayoutReportResponseSchema,
} from '@openkit/app-api-schemas';

import { publishedErrorMessage } from '../api-errors.js';
import {
  type VerifiedDataRootBackupManifest,
  verifyDataRootBackupManifest,
  writeHotDataRootBackup,
} from './data-root-backup.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { createStorageLayoutReport } from './layout-report.js';

/**
 * Returns the server-managed backup root for one data-root backup id.
 *
 * @param dataRoot Live NanoCore data root.
 * @param backupId Server-managed backup id.
 * @returns Backup root outside the live data root.
 */
function dataRootBackupRoot(dataRoot: string, backupId: string): string {
  return join(`${dataRoot}.backups`, backupId);
}

/**
 * Projects a verified data-root backup manifest into the public App API response shape.
 *
 * @param verified Parsed manifest plus checked inventory paths.
 * @returns Public backup response without filesystem paths.
 */
function dataRootBackupResponse(verified: VerifiedDataRootBackupManifest): unknown {
  return {
    backupId: verified.manifest.id,
    manifest: verified.manifest,
    fileCount: verified.checkedFiles.length,
    totalBytes: verified.manifest.contentInventory.reduce((total, entry) => total + entry.bytes, 0),
    checkedFiles: verified.checkedFiles,
  };
}

/** Exact native data-root joins; backup coverage and filesystem effects remain with the storage owners. */
type DataRootImplementations = {
  [K in keyof typeof DATA_ROOT_ADMIN_OPERATION_DEFINITIONS]: (
    input: OperationInput<K>
  ) => OperationOutput<K> | Promise<OperationOutput<K>>;
};

/** Joins the admitted deployment administration operations to existing storage and backup mechanics. */
export function createDataRootAdminOperationImplementations(
  dataRoot: string | null
): DataRootImplementations {
  return {
    'storage.layout-report': () => {
      if (!dataRoot) {
        return failure('Storage layout report is unavailable.', 'storage_layout_unavailable', 503);
      }

      return StorageLayoutReportResponseSchema.parse(createStorageLayoutReport(dataRoot));
    },

    'backup.create': async () => {
      if (!dataRoot) {
        return failure('Data-root backup is unavailable.', 'data_root_backup_unavailable', 503);
      }

      const backupId = `drb_${randomUUID()}`;

      try {
        const verified = await writeHotDataRootBackup({
          dataRoot,
          backupRoot: dataRootBackupRoot(dataRoot, backupId),
          backupId,
          sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });

        return DataRootBackupCreateResponseSchema.parse(dataRootBackupResponse(verified));
      } catch (error) {
        return failure(
          publishedErrorMessage(error, error instanceof Error ? undefined : String(error)),
          'data_root_backup_failed',
          400
        );
      }
    },

    'backup.verify': (input) => {
      if (!dataRoot) {
        return failure(
          'Data-root backup verification is unavailable.',
          'data_root_backup_unavailable',
          503
        );
      }

      try {
        const verified = verifyDataRootBackupManifest({
          backupRoot: dataRootBackupRoot(dataRoot, input.backupId),
        });

        return DataRootBackupVerifyResponseSchema.parse(dataRootBackupResponse(verified));
      } catch (error) {
        return failure(
          publishedErrorMessage(error, error instanceof Error ? undefined : String(error)),
          'data_root_backup_verify_failed',
          400
        );
      }
    },
  };
}

/** Storage owner's published error code and status. */
export class DataRootAdminOperationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'DataRootAdminOperationError';
  }
}

/** Retains storage failures without constructing an HTTP response. */
function failure(message: string, code: string, status: number): never {
  throw new DataRootAdminOperationError(code, message, status);
}
