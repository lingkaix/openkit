import type Database from 'better-sqlite3';
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
  sandboxId: string,
  owner: { readonly sqlite: Database.Database }
): Array<{ attemptId: string; deadline: string | null }> {
  const sessions = owner.sqlite
    .prepare(`SELECT attempt_id AS attemptId, agent_session_id AS agentSessionId, backend_session_id AS backendSessionId
      FROM worker_backend_sessions WHERE runtime_target_id=? AND origin_physical_epoch=?`)
    .all(runtimeTargetId, originPhysicalEpoch) as Array<{
    attemptId: string;
    agentSessionId: string;
    backendSessionId: string;
  }>;
  const active = coreDb.sqlite.prepare(`
    SELECT a.attempt_id AS attemptId, a.agent_session_id AS agentSessionId, a.deadline, q.backend_id AS backendId,
      (a.phase <> 'closed' AND NOT (a.phase = 'open' AND a.operation_id IS NULL
        AND a.deadline IS NULL AND a.workspace_id = ? AND a.thread_id = ?
        AND a.turn_id = ? AND a.input_ref IS ?)) AS blocksCleanup
    FROM scheduler_execution_attempts a JOIN scheduler_admission_entries q
      ON q.queue_entry_id=a.queue_entry_id AND q.workspace_id=a.workspace_id
      AND q.thread_id=a.thread_id AND q.turn_id=a.turn_id
    WHERE a.attempt_id=?
  `);
  return sessions
    .filter((row) => nanoHostSandboxIdFromBackendSessionId(row.backendSessionId) === sandboxId)
    .flatMap(({ attemptId, agentSessionId }) => {
      const attempt = active.get(
        environmentPackage.scope.workspaceId,
        environmentPackage.scope.threadId,
        environmentPackage.scope.turnId,
        environmentPackage.snapshotId,
        attemptId
      ) as
        | {
            attemptId: string;
            agentSessionId: string | null;
            deadline: string | null;
            backendId: string;
            blocksCleanup: 0 | 1;
          }
        | undefined;
      if (!attempt || attempt.backendId !== backendId || attempt.agentSessionId !== agentSessionId)
        throw new Error('NanoHost cleanup lacks the original Core backend admission.');
      return attempt.blocksCleanup ? [{ attemptId, deadline: attempt.deadline }] : [];
    });
}
