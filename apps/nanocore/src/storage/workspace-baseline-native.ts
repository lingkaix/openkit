import { isDeepStrictEqual } from 'node:util';
import { readRetainedV1 } from '@openkit/protocol';
import {
  readReleasedSandboxRefusalPredecessor,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { getWorkerStorageBindingForSandbox } from '../runtime/worker-storage-binding-records.js';
import {
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
  WorkspaceCollectionIdentitySchema,
} from '../runtime/workspace-snapshot-chain.js';
import { openCoreReadDb, type WorkspaceDb } from './db.js';
import type { ControlWorkspaceBaseline } from './workspace-baseline-codecs.js';

/** Runs one original baseline stage inside the existing physical owner's savepoint. */
export function applyWorkspaceBaselineInDb(db: WorkspaceDb, input: ControlWorkspaceBaseline): void {
  if (input.action === 'initialize') {
    authorizeWorkspaceBaselineInitialization(db, input.identity);
    continueUnfinishedBaseline(db, input.identity);
  } else
    acceptWorkspaceBaseline(
      db,
      input.identity,
      input.head,
      input.expectedTree,
      input.acceptedCommit
    );
}

/** Moves the unused source-scan permission only after exact predecessor release and successor attach. */
function continueUnfinishedBaseline(
  db: WorkspaceDb,
  identity: ControlWorkspaceBaseline['identity']
): void {
  const entry = db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, baseline_identity_json AS original
    FROM workspace_snapshot_cursors WHERE workspace_id=? AND storage_ref=? AND work_slot=?
      AND accepted_base_json IS NULL AND head_json IS NULL`)
    .get(db.workspaceId, identity.storageRef, identity.workSlot) as
    | {
        schemaVersion: unknown;
        original: string;
      }
    | undefined;
  if (!entry) return;
  const original = readRetainedV1(entry, () =>
    WorkspaceCollectionIdentitySchema.parse(JSON.parse(entry.original))
  );
  if (isDeepStrictEqual(original, identity)) return;
  const next = {
    ...original,
    packageSnapshotId: identity.packageSnapshotId,
    sandboxId: identity.sandboxId,
    attachmentGeneration: original.attachmentGeneration + 1,
  };
  if (!isDeepStrictEqual(next, identity) || original.collectionId !== 'baseline') return;
  const core = openCoreReadDb(db.dataRoot);
  try {
    const selected = core.sqlite
      .prepare('SELECT attempt_id AS id FROM worker_backend_sessions WHERE package_snapshot_id=?')
      .get(identity.packageSnapshotId) as { id: string } | undefined;
    if (!selected) return;
    const attempt = requireSchedulerExecutionAttempt(core, selected.id);
    const predecessor = readReleasedSandboxRefusalPredecessor(core, attempt, selected.id);
    const anchor = getWorkerBackendSession(core, selected.id);
    if (
      !predecessor ||
      predecessor.inputRef !== original.packageSnapshotId ||
      predecessor.agentSessionId !== original.agentSessionId ||
      attempt.phase !== 'open' ||
      attempt.deadline !== null ||
      attempt.workspaceId !== identity.workspaceId ||
      attempt.threadId !== identity.threadId ||
      attempt.turnId !== identity.turnId ||
      attempt.agentSessionId !== identity.agentSessionId ||
      attempt.inputRef !== identity.packageSnapshotId ||
      !anchor ||
      anchor.sandboxBindingRef !== attempt.bindingRef ||
      nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId) !== identity.sandboxId
    )
      return;
    const hold = getWorkerStorageBindingForSandbox(core, anchor);
    const target = getNanoHostRuntimeTarget(core, anchor.runtimeTargetId);
    if (
      !target?.ready ||
      target.deploymentId !== anchor.deploymentId ||
      target.physicalEpoch !== anchor.originPhysicalEpoch ||
      hold?.state !== 'attached' ||
      hold.storageRef !== identity.storageRef ||
      hold.scopeDigest !== identity.scopeDigest ||
      hold.runtimeTargetId !== anchor.runtimeTargetId ||
      hold.deploymentId !== anchor.deploymentId ||
      hold.currentAgentSessionId !== identity.agentSessionId ||
      hold.currentThreadId !== identity.threadId ||
      hold.currentWorkSlotRef !== identity.workSlot ||
      hold.attachmentGeneration !== identity.attachmentGeneration
    )
      return;
    db.sqlite
      .prepare(`UPDATE workspace_snapshot_cursors SET baseline_identity_json=?
      WHERE workspace_id=? AND storage_ref=? AND work_slot=?
        AND accepted_base_json IS NULL AND head_json IS NULL AND baseline_identity_json=?`)
      .run(
        JSON.stringify(identity),
        db.workspaceId,
        identity.storageRef,
        identity.workSlot,
        entry.original
      );
  } finally {
    core.sqlite.close();
  }
}
