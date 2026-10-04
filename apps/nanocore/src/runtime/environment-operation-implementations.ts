import type { ENVIRONMENT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { z } from 'zod';
import type { FamilyImplementations } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import type { WorkspaceDb } from '../storage/db.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';

/** Reads the existing redacted snapshot ledger only after selected-Workspace admission. */
export function createEnvironmentOperationImplementations(dependencies: {
  readonly repositoryWorkspaceDb?: (workspaceId: string) => WorkspaceDb;
}) {
  /** Keeps the owner's storage lifetime and classified decoder errors local. */
  function list(workspaceId: string) {
    const db = dependencies.repositoryWorkspaceDb!(workspaceId);
    try {
      return listExportableAgentEnvironmentPackageSnapshots(db, workspaceId);
    } finally {
      db.sqlite.close();
    }
  }
  return {
    'environment.snapshot-list': (input) => {
      try {
        return { items: list(input.workspaceId) };
      } catch (error) {
        snapshotFailure(error);
      }
    },
    'environment.snapshot-read': (input) => {
      try {
        const record = list(input.workspaceId).find(
          (candidate) => candidate.snapshotId === input.snapshotId
        );
        if (!record || record.workspaceId !== input.workspaceId)
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        return record;
      } catch (error) {
        snapshotFailure(error);
      }
    },
  } satisfies FamilyImplementations<typeof ENVIRONMENT_OPERATION_DEFINITIONS>;
}

/** Preserves decoder redaction without treating unexpected exceptions as missing snapshots. */
function snapshotFailure(error: unknown): never {
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw new OperationError('not_found', 'The retained record could not be read.', 404, {
      cause: error,
    });
  throw error;
}
