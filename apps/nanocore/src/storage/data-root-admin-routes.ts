import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  StorageLayoutReportResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { isDeploymentAdminActor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerAppApiRoute } from '../openapi.js';
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

/**
 * Registers storage layout and data-root backup administration routes.
 *
 * @param dependencies Hono app and optional live data root.
 */
export function registerDataRootAdminRoutes({
  app,
  dataRoot,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly dataRoot: string | null;
}): void {
  /**
   * Requires deployment-admin authority for a server-wide data-root operation.
   *
   * @param c Hono context carrying the authenticated actor.
   * @returns Error response when the actor lacks deployment-admin authority.
   */
  function requireDataRootAdminActor(c: Context<{ Variables: AuthVariables }>): Response | null {
    if (isDeploymentAdminActor(c.get('actor'))) {
      return null;
    }

    return asApiError('Server-admin authority is required.', 'data_root_admin_forbidden', 403);
  }

  registerAppApiRoute(app, 'getStorageLayoutReport', (c) => {
    const adminError = requireDataRootAdminActor(c);
    if (adminError) {
      return adminError;
    }

    if (!dataRoot) {
      return asApiError('Storage layout report is unavailable.', 'storage_layout_unavailable', 503);
    }

    return c.json(StorageLayoutReportResponseSchema.parse(createStorageLayoutReport(dataRoot)));
  });

  registerAppApiRoute(app, 'createDataRootBackup', async (c) => {
    const adminError = requireDataRootAdminActor(c);
    if (adminError) {
      return adminError;
    }

    if (!dataRoot) {
      return asApiError('Data-root backup is unavailable.', 'data_root_backup_unavailable', 503);
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

      return c.json(DataRootBackupCreateResponseSchema.parse(dataRootBackupResponse(verified)));
    } catch (error) {
      return asApiError(
        error instanceof Error ? error.message : String(error),
        'data_root_backup_failed',
        400
      );
    }
  });

  registerAppApiRoute(app, 'verifyDataRootBackup', (c) => {
    const adminError = requireDataRootAdminActor(c);
    if (adminError) {
      return adminError;
    }

    if (!dataRoot) {
      return asApiError(
        'Data-root backup verification is unavailable.',
        'data_root_backup_unavailable',
        503
      );
    }

    const parsed = DataRootBackupVerifyRequestSchema.safeParse({
      backupId: c.req.param('backupId'),
    });
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const verified = verifyDataRootBackupManifest({
        backupRoot: dataRootBackupRoot(dataRoot, parsed.data.backupId),
      });

      return c.json(DataRootBackupVerifyResponseSchema.parse(dataRootBackupResponse(verified)));
    } catch (error) {
      return asApiError(
        error instanceof Error ? error.message : String(error),
        'data_root_backup_verify_failed',
        400
      );
    }
  });
}
