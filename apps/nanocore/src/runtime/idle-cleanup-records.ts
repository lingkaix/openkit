import type { CoreDb } from '../storage/db.js';
import { nanoHostSandboxIdFromBackendSessionId } from './nanohost-effect-identity.js';
/** Reads current attempts for one original physical Sandbox, excluding only the exact unused admission. */
export function nonClosedSandboxAttempts(
  coreDb: CoreDb,
  backendId: string,
  environmentPackage: {
    readonly scope: {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly turnId: string;
    };
    readonly snapshotId: string;
  },
  runtimeTargetId: string,
  originPhysicalEpoch: string,
  sandboxId: string
): Array<{ attemptId: string; deadline: string | null }> {
  return (
    coreDb.sqlite
      .prepare(`
      SELECT a.attempt_id AS attemptId, w.backend_session_id AS backendSessionId, a.deadline
      FROM scheduler_execution_attempts a JOIN worker_backend_sessions w ON w.attempt_id = a.attempt_id
      WHERE a.backend_id = ? AND w.runtime_target_id = ? AND w.origin_physical_epoch = ? AND a.phase <> 'closed'
        AND NOT (a.phase = 'open' AND a.operation_id IS NULL AND a.deadline IS NULL
          AND a.workspace_id = ? AND a.thread_id = ? AND a.turn_id = ? AND a.input_ref = ?)
    `)
      .all(
        backendId,
        runtimeTargetId,
        originPhysicalEpoch,
        environmentPackage.scope.workspaceId,
        environmentPackage.scope.threadId,
        environmentPackage.scope.turnId,
        environmentPackage.snapshotId
      ) as Array<{
      attemptId: string;
      backendSessionId: string;
      deadline: string | null;
    }>
  ).filter(
    (attempt) => nanoHostSandboxIdFromBackendSessionId(attempt.backendSessionId) === sandboxId
  );
}
