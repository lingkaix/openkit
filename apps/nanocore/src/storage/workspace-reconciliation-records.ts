import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type WorkspaceReconciliationRecord,
  WorkspaceReconciliationRecordSchema,
} from '@openkit/app-api-schemas';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import type { WorkerBackendSessionRecord } from '../runtime/worker-backend-session-records.js';
import { workerStorageScopeDigest } from '../runtime/worker-storage-binding-records.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import {
  type RawWorkspaceCapture,
  readWorkspaceCollection,
  type WorkspaceCollectionIdentity,
  WorkspaceCollectionIdentitySchema,
} from '../runtime/workspace-snapshot-chain.js';
import { StoredWorkspaceReconciliationRecordV1Schema } from '../runtime/workspace-sync-outcomes-v1.js';
import { listWorkspaceMaterializationRecords } from '../runtime/workspace-sync-records.js';
import type { WorkspaceDb } from './db.js';
import { recordWorkspaceEvidenceBundle } from './evidence-bundle-records.js';

interface WorkspaceReconciliationRecordRow {
  readonly schemaVersion: unknown;
  readonly payload_json: string;
}
/** Only original backend facts used by this Workspace reconciliation tuple; no current-authority boolean. */
export type WorkspaceCaptureAnchor = Pick<
  WorkerBackendSessionRecord,
  | 'attemptId'
  | 'workspaceId'
  | 'threadId'
  | 'turnId'
  | 'agentSessionId'
  | 'packageSnapshotId'
  | 'backendKind'
  | 'backendSessionId'
  | 'sandboxBindingRef'
  | 'state'
>;

/**
 * Persists known reconciliation facts while preserving owned annotations and unchanged payload bytes.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Reconciliation record to persist.
 * @returns Stored public workspace reconciliation record.
 */
export function recordWorkspaceReconciliationRecord(
  workspaceDb: WorkspaceDb,
  record: WorkspaceReconciliationRecord
): WorkspaceReconciliationRecord {
  return persistWorkspaceReconciliationRecordV1(
    workspaceDb,
    WorkspaceReconciliationRecordSchema.parse(record)
  );
}

/** Persists validated current or imported v1 facts with the existing annotation-preserving update. */
export function persistWorkspaceReconciliationRecordV1(
  workspaceDb: WorkspaceDb,
  record: WorkspaceReconciliationRecord
): WorkspaceReconciliationRecord {
  const parsed = StoredWorkspaceReconciliationRecordV1Schema.parse(record);
  const existing = workspaceDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,payload_json FROM workspace_reconciliation_records WHERE workspace_id = ? AND reconciliation_record_id = ?'
    )
    .get(parsed.workspaceId, parsed.id) as WorkspaceReconciliationRecordRow | undefined;
  const retained = existing
    ? readRetainedV1(existing, () => JSON.parse(existing.payload_json))
    : null;
  const retainedCore = existing
    ? StoredWorkspaceReconciliationRecordV1Schema.parse(retained)
    : null;
  // Only fixed known facts change; retained root and reachability additions stay with this owner.
  const payload = existing
    ? {
        ...retained,
        ...parsed,
        backendReachability: { ...retained.backendReachability, ...parsed.backendReachability },
      }
    : parsed;
  const payloadJson =
    existing && isDeepStrictEqual(retainedCore, parsed)
      ? existing.payload_json
      : JSON.stringify(payload);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_reconciliation_records (
        reconciliation_record_id,
        workspace_id,
        trigger_reason,
        state_after,
        payload_json,
        started_at,
        finished_at,
        updated_at,
        schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, reconciliation_record_id) DO UPDATE SET
        trigger_reason = excluded.trigger_reason,
        state_after = excluded.state_after,
        payload_json = excluded.payload_json,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at,
        schema_version = excluded.schema_version`
    )
    .run(
      parsed.id,
      parsed.workspaceId,
      parsed.triggerReason,
      parsed.stateAfter,
      payloadJson,
      parsed.startedAt,
      parsed.finishedAt,
      parsed.finishedAt ?? parsed.startedAt,
      writeRetainedV1({}).schemaVersion
    );

  return parsed;
}

/**
 * Links arrived source to existing restricted evidence and recovery authority, without accepting capture.
 * @param db Admitted owning Workspace connection.
 * @param anchor Exact original durable backend anchor.
 * @param value Original attachment identity, derived by its caller from owned lineage.
 * @param source Verified immutable raw source, or null when publication remains incomplete.
 * @returns Existing recovery decision or a requires-human record that retains the backend.
 * @throws For conflicting source, original lineage, materialization, or retained recovery authority.
 */
export function recordWorkspaceCaptureRecovery(
  db: WorkspaceDb,
  anchor: WorkspaceCaptureAnchor,
  value: WorkspaceCollectionIdentity,
  source: RawWorkspaceCapture | null
): WorkspaceReconciliationRecord {
  const identity = WorkspaceCollectionIdentitySchema.parse(value);
  const hash = createHash('sha256').update(anchor.packageSnapshotId).digest('hex');
  if (
    db.workspaceId !== anchor.workspaceId ||
    identity.workspaceId !== anchor.workspaceId ||
    identity.threadId !== anchor.threadId ||
    identity.turnId !== anchor.turnId ||
    identity.agentSessionId !== anchor.agentSessionId ||
    identity.packageSnapshotId !== anchor.packageSnapshotId ||
    identity.scopeDigest !== workerStorageScopeDigest(anchor.workspaceId) ||
    identity.sandboxId !== nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId) ||
    !['turn-end', 'release', 'successor'].some(
      (boundary) => identity.collectionId === `${boundary}-${hash}`
    ) ||
    (source &&
      (!isDeepStrictEqual(source.identity, identity) ||
        source.result.byteLength !== source.candidate.length ||
        source.result.sha256 !==
          `sha256:${createHash('sha256').update(source.candidate).digest('hex')}`))
  )
    throw new Error('Workspace capture recovery source or owner conflicts.');
  const id = `wrr_capture_${identity.collectionId}`;
  const prior = listWorkspaceReconciliationRecords(db, identity.workspaceId).find(
    (row) => row.id === id
  );
  const summary = {
    attemptId: anchor.attemptId,
    backendSessionId: anchor.backendSessionId,
    sandboxBindingRef: anchor.sandboxBindingRef,
    identity,
    candidateDigest: source?.result.sha256 ?? null,
  };
  if (prior) {
    const old = prior.backendHandleSummary;
    if (
      prior.workspaceId !== identity.workspaceId ||
      ![anchor.attemptId, anchor.agentSessionId, anchor.packageSnapshotId].every((id) =>
        prior.affectedRecordIds.includes(id)
      ) ||
      old.attemptId !== summary.attemptId ||
      old.backendSessionId !== summary.backendSessionId ||
      old.sandboxBindingRef !== summary.sandboxBindingRef ||
      !isDeepStrictEqual(WorkspaceCollectionIdentitySchema.parse(old.identity), identity) ||
      (old.candidateDigest !== null && source && old.candidateDigest !== source.result.sha256)
    )
      throw new Error('Workspace capture recovery retained lineage conflicts.');
    if (source && old.candidateDigest === null && prior.stateAfter !== 'requires-human')
      throw new Error(
        'Terminal Workspace capture disposition lacks the newly available source proof.'
      );
    if (!source || old.candidateDigest !== null) return prior;
  }
  const timestamp = source?.result.collectedAt ?? prior?.startedAt ?? new Date().toISOString();
  const bundleId = `evb_capture_${identity.collectionId}`;
  const materializations = listWorkspaceMaterializationRecords(db, identity.workspaceId).filter(
    (record) => record.packageSnapshotId === anchor.packageSnapshotId
  );
  if (
    materializations.some(
      (record) =>
        record.workerSessionId !== anchor.backendSessionId ||
        record.backendKind !== anchor.backendKind
    )
  )
    throw new Error('Workspace capture materialization lineage conflicts.');
  return db.sqlite.transaction(() => {
    if (source)
      recordWorkspaceEvidenceBundle(db, {
        id: bundleId,
        workspaceId: identity.workspaceId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        agentSessionId: identity.agentSessionId,
        goalId: null,
        backendType: anchor.backendKind,
        sourceKind: 'workspace-capture-raw',
        summary: 'Original capture source; only its SQL receipt establishes collection acceptance.',
        rawEvidenceRefs: ['complete', 'collection.json'].map((name) => ({
          kind: 'workspace-capture-raw',
          ref: `evidence/backend/workspace-capture/${identity.collectionId}/${name}`,
        })),
        redactedEvidenceRefs: [],
        contentDigests: [source.result.sha256],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: [],
        createdAt: timestamp,
      });
    return recordWorkspaceReconciliationRecord(db, {
      ...prior,
      id,
      workspaceId: identity.workspaceId,
      triggerReason: 'backend_takeover',
      affectedRecordIds: [
        anchor.attemptId,
        anchor.agentSessionId,
        anchor.packageSnapshotId,
        ...materializations.map((record) => record.id),
      ],
      backendHandleSummary: summary,
      backendReachability: { status: 'unknown', checkedAt: timestamp, detail: null },
      collectedOutputManifestIds: [],
      evidenceBundleIds: source ? [bundleId] : [],
      stateBefore: prior?.stateBefore ?? anchor.state,
      stateAfter: 'requires-human',
      quarantineRefs: [],
      requiredHumanDecision: 'inspect_recovery',
      retentionDecision: 'retain-backend',
      startedAt: prior?.startedAt ?? timestamp,
      finishedAt: null,
    });
  })();
}

/** Resolves only from the exact accepted receipt; caller may include this in capture's transaction. */
export function completeWorkspaceCaptureRecovery(
  db: WorkspaceDb,
  anchor: WorkspaceCaptureAnchor,
  identity: WorkspaceCollectionIdentity,
  source: RawWorkspaceCapture | null
): WorkspaceReconciliationRecord {
  const receipt = readWorkspaceCollection(db, identity);
  if (
    !receipt ||
    (source &&
      (!receipt.candidate?.equals(source.candidate) ||
        ['head', 'previousHead', 'acceptedBase', 'unstable', 'sha256', 'byteLength'].some(
          (key) =>
            !isDeepStrictEqual(
              receipt.result[key],
              source.result[key as keyof typeof source.result]
            )
        )))
  )
    throw new Error('Workspace recovery requires its exact accepted capture receipt.');
  return db.sqlite.transaction(() => {
    const record = recordWorkspaceCaptureRecovery(db, anchor, identity, source);
    if (
      record.backendHandleSummary.candidateDigest !== null &&
      (!receipt.candidate || record.backendHandleSummary.candidateDigest !== receipt.result.sha256)
    )
      throw new Error('Accepted Workspace capture contradicts its recorded original digest.');
    if (
      record.stateAfter === 'recovered' &&
      record.stateBefore === 'requires-human' &&
      record.requiredHumanDecision === null &&
      record.retentionDecision === 'teardown-backend' &&
      record.finishedAt === receipt.result.collectedAt
    )
      return record;
    if (record.stateAfter !== 'requires-human')
      throw new Error('Workspace capture disposition changed before receipt resolution.');
    return recordWorkspaceReconciliationRecord(db, {
      ...record,
      stateBefore: 'requires-human',
      stateAfter: 'recovered',
      requiredHumanDecision: null,
      retentionDecision: 'teardown-backend',
      finishedAt: String(receipt.result.collectedAt),
    });
  })();
}
