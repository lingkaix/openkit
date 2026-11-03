import {
  publishWorkspaceCaptureCompletion,
  publishWorkspaceCaptureRecovery,
} from './workspace-capture-publication.js';

export {
  completeWorkspaceCaptureRecovery,
  recordWorkspaceCaptureRecovery,
  recordWorkspaceReconciliationRecord,
} from '../storage/workspace-reconciliation-records.js';
export { listWorkspaceReconciliationRecords } from './workspace-reconciliation-read.js';

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceReconciliationRecord } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import type { FsStore } from '../lib/store.js';
import { readProduct } from '../storage/control-store-product-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { AgentSessionRecordSchema } from '../storage/workspace-file-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { nanoHostSandboxIdFromBackendSessionId } from './nanohost-effect-identity.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from './worker-backend-session-records.js';
import { workerStorageScopeDigest } from './worker-storage-bindings.js';
import { listWorkspaceReconciliationRecords } from './workspace-reconciliation-read.js';
import {
  readRawWorkspaceCapture,
  readWorkspaceCollection,
  type WorkspaceCollectionIdentity,
  WorkspaceCollectionIdentitySchema,
} from './workspace-snapshot-chain.js';

export { resolveWorkspaceReconciliationRecord } from '../storage/workspace-reconciliation-decision.js';

/**
 * Lists durable workspace reconciliation records for export in stable order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable reconciliation records in oldest-first order.
 */
export function listExportableWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceReconciliationRecord[] {
  return [...listWorkspaceReconciliationRecords(workspaceDb, workspaceId)].reverse();
}

/** Derives original capture lineage from admitted records, never replacement attachment state. */
function originalCaptureIdentity(
  db: WorkspaceDb,
  anchor: WorkerBackendSessionRecord,
  retained: AgentEnvironmentPackage,
  store?: FsStore
): Omit<WorkspaceCollectionIdentity, 'collectionId'> {
  // Callers supply the exact snapshot and anchor from their validated owning readers.
  if (
    retained.snapshotId !== anchor.packageSnapshotId ||
    retained.scope.workspaceId !== anchor.workspaceId ||
    retained.scope.threadId !== anchor.threadId ||
    retained.scope.turnId !== anchor.turnId ||
    retained.scope.agentSessionId !== anchor.agentSessionId ||
    retained.backend.preferred !== anchor.backendKind
  )
    throw new Error('Workspace capture original package or backend lineage conflicts.');
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const session = AgentSessionRecordSchema.parse(
    store
      ? store.getAgentSession(anchor.agentSessionId)
      : readProduct(db.sqlite, owner, 'agent-session', anchor.agentSessionId)?.record
  );
  const turn = readProduct(db.sqlite, owner, 'turn', anchor.turnId)?.record;
  const slot = (retained.extensions.openkit as { workerStorage?: { workSlotRef?: string } })
    .workerStorage?.workSlotRef;
  const original = session.retainedStorage;
  if (
    !turn ||
    turn.threadId !== anchor.threadId ||
    turn.agentSessionId !== anchor.agentSessionId ||
    turn.agentId !== retained.agent.agentId ||
    session.id !== anchor.agentSessionId ||
    session.workspaceId !== anchor.workspaceId ||
    session.threadId !== anchor.threadId ||
    session.agentId !== retained.agent.agentId ||
    !original ||
    original.workSlotRef !== slot ||
    !Number.isSafeInteger(original.attachmentGeneration) ||
    (original.attachmentGeneration ?? 0) <= 0
  )
    throw new Error('Workspace capture original AgentSession attachment is unavailable.');
  return {
    workspaceId: anchor.workspaceId,
    threadId: anchor.threadId,
    turnId: anchor.turnId,
    agentSessionId: anchor.agentSessionId,
    packageSnapshotId: anchor.packageSnapshotId,
    storageRef: original.storageRef,
    workSlot: original.workSlotRef,
    attachmentGeneration: original.attachmentGeneration!,
    scopeDigest: workerStorageScopeDigest(anchor.workspaceId),
    sandboxId: nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId),
  };
}

/**
 * Normalizes exact original sources; false proves no pending source, not completed invocation.
 * @param coreDb Existing Core connection owning the exact backend anchor.
 * @param db Caller-admitted and migrated Workspace connection.
 * @param anchor Original backend identity or Core identity projection; full owner proof is required only when capture is present.
 * @param environmentPackage Already verified original snapshot; absent callers defer its owning read until a source or preclaim exists.
 * @param store Optional current Store; absent callers read the same admitted native database.
 * @returns Whether any of the three original boundaries lacks its exact durable abandon.
 * @throws For unavailable or contradictory original proof, source, evidence, or recovery authority.
 */
export async function hasPendingWorkspaceCapture(
  coreDb: CoreDb,
  db: WorkspaceDb,
  anchor: (
    | WorkerBackendSessionRecord
    | Pick<WorkerBackendSessionRecord, 'attemptId' | 'workspaceId' | 'packageSnapshotId'>
  ) &
    Partial<
      Pick<
        WorkerBackendSessionRecord,
        | 'backendSessionId'
        | 'runtimeTargetId'
        | 'originPhysicalEpoch'
        | 'agentSessionId'
        | 'sandboxBindingRef'
      >
    >,
  environmentPackage?: AgentEnvironmentPackage,
  store?: FsStore
): Promise<boolean> {
  if (
    coreDb.dataRoot !== db.dataRoot ||
    db.workspaceId !== anchor.workspaceId ||
    (environmentPackage && environmentPackage.snapshotId !== anchor.packageSnapshotId)
  )
    throw new Error('Workspace capture recovery scope conflicts.');
  const hash = createHash('sha256').update(anchor.packageSnapshotId).digest('hex');
  const records = listWorkspaceReconciliationRecords(db, db.workspaceId);
  let original: Omit<WorkspaceCollectionIdentity, 'collectionId'> | undefined;
  let fullOwner: WorkerBackendSessionRecord | undefined =
    'backendLineage' in anchor ? anchor : undefined;
  let blocked = false;
  for (const boundary of ['turn-end', 'release', 'successor']) {
    const collectionId = `${boundary}-${hash}`;
    const prior = records.find((row) => row.id === `wrr_capture_${collectionId}`);
    // The exact package key is safe to probe before requiring optional historical attachment proof.
    const metadata = await lstat(
      join(
        db.dataRoot,
        'workspaces',
        db.workspaceId,
        'evidence',
        'backend',
        'workspace-capture',
        collectionId
      )
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata && !prior) continue;
    fullOwner ??= getWorkerBackendSession(coreDb, anchor.attemptId) ?? undefined;
    const owner = fullOwner;
    if (
      !owner ||
      (
        [
          'attemptId',
          'workspaceId',
          'packageSnapshotId',
          'backendSessionId',
          'runtimeTargetId',
          'originPhysicalEpoch',
          'agentSessionId',
          'sandboxBindingRef',
        ] as const
      ).some((key) => anchor[key] !== undefined && owner[key] !== anchor[key])
    )
      throw new Error('Workspace capture original backend owner is unavailable or changed.');
    if (!original) {
      environmentPackage ??= requireAgentEnvironmentPackageSnapshot(
        db,
        anchor.workspaceId,
        anchor.packageSnapshotId
      ).snapshot;
      original = originalCaptureIdentity(db, fullOwner!, environmentPackage, store);
    }
    const identity = WorkspaceCollectionIdentitySchema.parse({ ...original, collectionId });
    const source = await readRawWorkspaceCapture(db.dataRoot, identity);
    const receipt = readWorkspaceCollection(db, identity);
    if (
      source &&
      receipt &&
      (!receipt.candidate?.equals(source.candidate) ||
        ['head', 'previousHead', 'acceptedBase', 'unstable', 'sha256', 'byteLength'].some(
          (key) =>
            !isDeepStrictEqual(
              receipt.result[key],
              source.result[key as keyof typeof source.result]
            )
        ))
    )
      throw new Error('Accepted Workspace capture conflicts with its original source.');
    if (receipt && !prior) continue;
    if (
      receipt &&
      prior &&
      (prior.stateAfter === 'requires-human' || prior.stateAfter === 'recovered')
    ) {
      await publishWorkspaceCaptureCompletion(db, fullOwner!, identity, source);
      continue;
    }
    const record = await publishWorkspaceCaptureRecovery(db, fullOwner!, identity, source);
    const digest = record.backendHandleSummary.candidateDigest;
    if (digest !== null) {
      const bundle = listStoredWorkspaceEvidenceBundles(db, db.workspaceId).find(
        (row) => row.id === `evb_capture_${collectionId}`
      );
      if (
        !source ||
        digest !== source.result.sha256 ||
        !bundle ||
        !record.evidenceBundleIds.includes(bundle.id) ||
        bundle.workspaceId !== identity.workspaceId ||
        bundle.threadId !== identity.threadId ||
        bundle.turnId !== identity.turnId ||
        bundle.agentSessionId !== identity.agentSessionId ||
        bundle.backendType !== fullOwner!.backendKind ||
        bundle.sourceKind !== 'workspace-capture-raw' ||
        !['collected', 'verified'].includes(bundle.importStatus) ||
        bundle.retentionClass !== 'restricted-raw' ||
        bundle.sensitivityClass !== 'restricted' ||
        !isDeepStrictEqual(bundle.contentDigests, [digest]) ||
        !isDeepStrictEqual(
          bundle.rawEvidenceRefs,
          ['complete', 'collection.json'].map((name) => ({
            kind: 'workspace-capture-raw',
            ref: `evidence/backend/workspace-capture/${collectionId}/${name}`,
          }))
        )
      )
        throw new Error('Workspace capture recovery has no retained original evidence index.');
    }
    blocked ||= !(
      record.stateBefore === 'requires-human' &&
      record.stateAfter === 'unrecoverable' &&
      record.retentionDecision === 'teardown-backend' &&
      record.requiredHumanDecision === null &&
      record.finishedAt !== null
    );
  }
  return blocked;
}
