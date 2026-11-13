import type { FsStore } from '../lib/store.js';
import { TurnStartValidationError } from '../operation-error.js';
import type { WorkspaceDb } from '../storage/db.js';
import { AgentSessionRetainedStorageSchema } from '../storage/workspace-file-records.js';
import { findNamedAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';

/**
 * Selects the nearest accepted resume pair within the selected Agent and runtime segment.
 * A switch starts a fresh native conversation; a failed preparation without a package or proof
 * does not establish a runtime. Within one segment, predecessors without proof remain skippable.
 * Creation order defines predecessor order and equal creation times fail closed.
 *
 * @param agentSessions Every AgentSession of the Thread.
 * @param successorId AgentSession excluded from the walk.
 * @param selected Current Agent and runtime selection.
 * @param workspaceDb Owner of the retained packages that identify predecessor runtimes.
 * @throws TurnStartValidationError when order, runtime identity or accepted storage is unproved.
 */
export function selectThreadNativeResumeSource(
  agentSessions: readonly ReturnType<FsStore['getAgentSession']>[],
  successorId: string,
  selected: { readonly agentId: string; readonly runtimeKind: string; readonly adapter: string },
  workspaceDb: WorkspaceDb | null
): ReturnType<FsStore['getAgentSession']> | null {
  const ordered = agentSessions
    .filter((candidate) => candidate.id !== successorId)
    .sort((left, right) =>
      left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? 1 : -1
    );
  for (const [index, candidate] of ordered.entries()) {
    if (ordered[index + 1]?.createdAt === candidate.createdAt) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The Thread AgentSession order is ambiguous, so its resume predecessor is unproved.',
        409
      );
    }
    if (candidate.agentId !== selected.agentId) return null;
    if (candidate.environmentPackageSnapshotId !== null) {
      let snapshot: ReturnType<typeof findNamedAgentEnvironmentPackageSnapshot>;
      try {
        snapshot = workspaceDb
          ? findNamedAgentEnvironmentPackageSnapshot(
              workspaceDb,
              candidate.workspaceId,
              candidate.id,
              candidate.environmentPackageSnapshotId
            )
          : null;
      } catch {
        throw new TurnStartValidationError(
          'recovery_required',
          'The native resume predecessor runtime cannot be read.',
          409
        );
      }
      if (
        !snapshot ||
        snapshot.agentId !== candidate.agentId ||
        snapshot.threadId !== candidate.threadId
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The native resume predecessor runtime is unproved.',
          409
        );
      }
      if (
        snapshot.runtimeKind !== selected.runtimeKind ||
        snapshot.snapshot.control.adapter.targetRuntime !== selected.adapter
      )
        return null;
    } else if (candidate.nativeHandleDigest !== null) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The native resume predecessor runtime is unproved.',
        409
      );
    }
    if (candidate.nativeHandleDigest !== null) {
      if (!AgentSessionRetainedStorageSchema.safeParse(candidate.retainedStorage).success) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The native resume predecessor has no proven retained-storage attachment.',
          409
        );
      }
      return candidate;
    }
  }
  return null;
}
