import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type WorkerOutputManifest,
  type WorkspaceReconciliationRecord,
  WorkspaceReconciliationRecordSchema,
  type WorkspaceRecoveryDecision,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import {
  listStoredWorkspaceEvidenceBundles,
  recordWorkspaceEvidenceBundle,
} from '../evidence-bundles.js';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { readProduct } from '../storage/control-store-products.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { AgentSessionRecordSchema } from '../storage/workspace-file-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { nanoHostSandboxIdFromBackendSessionId } from './nanohost-effect-identity.js';
import {
  getWorkerBackendSession,
  type WorkerBackendSessionRecord,
} from './worker-backend-sessions.js';
import { workerStorageScopeDigest } from './worker-storage-bindings.js';
import {
  type RawWorkspaceCapture,
  readRawWorkspaceCapture,
  readWorkspaceCollection,
  type WorkspaceCollectionIdentity,
  WorkspaceCollectionIdentitySchema,
} from './workspace-snapshot-chain.js';
import { StoredWorkspaceReconciliationRecordV1Schema } from './workspace-sync-outcomes-v1.js';
import { listWorkspaceMaterializationRecords } from './workspace-sync-records.js';

interface WorkspaceReconciliationRecordRow {
  readonly schemaVersion: unknown;
  readonly payload_json: string;
}

interface ResumeWorkspaceRecoveryCollectionInput {
  /** Durable worker output manifests currently available for the workspace. */
  readonly workerOutputManifests?: readonly WorkerOutputManifest[];
}

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
function persistWorkspaceReconciliationRecordV1(
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
 * Lists durable workspace reconciliation records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored reconciliation records in newest-first order.
 */
export function listWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceReconciliationRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT schema_version AS schemaVersion,payload_json
         FROM workspace_reconciliation_records
         WHERE workspace_id = ?
         ORDER BY started_at ASC, reconciliation_record_id ASC`
      )
      .all(workspaceId) as WorkspaceReconciliationRecordRow[]
  )
    .map((row) =>
      readRetainedV1(row, () =>
        StoredWorkspaceReconciliationRecordV1Schema.parse(JSON.parse(row.payload_json))
      )
    )
    .reverse();
}

/**
 * Resolves one human-required workspace reconciliation record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Recovery decision input.
 * @returns Updated reconciliation record.
 * @throws StoreRecordNotFoundError for a missing record or OperationError for a known decision refusal.
 */
export function resolveWorkspaceReconciliationRecord(
  input: {
    /** Open workspace-scope database handle. */
    readonly workspaceDb: WorkspaceDb;
    /** Workspace id. */
    readonly workspaceId: string;
    /** Reconciliation record id. */
    readonly reconciliationRecordId: string;
    /** Human recovery decision. */
    readonly decision: WorkspaceRecoveryDecision;
    /** Decision timestamp. */
    readonly decidedAt: string;
  } & ResumeWorkspaceRecoveryCollectionInput
): WorkspaceReconciliationRecord {
  const record = listWorkspaceReconciliationRecords(input.workspaceDb, input.workspaceId).find(
    (candidate) => candidate.id === input.reconciliationRecordId
  );

  if (!record) {
    throw new StoreRecordNotFoundError(
      `Workspace reconciliation record not found: ${input.reconciliationRecordId}`
    );
  }
  if (record.stateAfter !== 'requires-human') {
    throw new OperationError(
      'workspace_recovery_decision_failed',
      `Workspace reconciliation record is already terminal: ${input.reconciliationRecordId}`,
      404
    );
  }

  if (record.id.startsWith('wrr_capture_') && input.decision !== 'abandon') {
    throw new OperationError(
      'workspace_recovery_decision_failed',
      'Unaccepted capture source supports only abandon with evidence retained.',
      409
    );
  }

  const resumeCollection =
    input.decision === 'resume_collection'
      ? resolveResumeCollection({
          decidedAt: input.decidedAt,
          record,
          workerOutputManifests: input.workerOutputManifests ?? [],
        })
      : null;
  const updated = StoredWorkspaceReconciliationRecordV1Schema.parse({
    ...record,
    ...(resumeCollection ?? {}),
    stateBefore: 'requires-human',
    stateAfter: recoveryDecisionState(input.decision),
    requiredHumanDecision: null,
    retentionDecision: 'teardown-backend',
    finishedAt: input.decidedAt,
  });

  return persistWorkspaceReconciliationRecordV1(input.workspaceDb, updated);
}

/**
 * Resolves the durable portion of automatic recovery collection.
 *
 * @param input Resume collection candidates and target record.
 * @returns Reconciliation fields collected from durable workspace sync rows.
 */
function resolveResumeCollection(input: {
  /** Decision timestamp. */
  readonly decidedAt: string;
  /** Reconciliation record being resumed. */
  readonly record: WorkspaceReconciliationRecord;
  /** Durable worker output manifests currently available for the workspace. */
  readonly workerOutputManifests: readonly WorkerOutputManifest[];
}): Pick<
  WorkspaceReconciliationRecord,
  'backendReachability' | 'collectedOutputManifestIds' | 'evidenceBundleIds'
> {
  const affectedRecordIds = new Set(input.record.affectedRecordIds);
  const existingManifestIds = new Set(input.record.collectedOutputManifestIds);
  const matchingOutputManifestIds = input.workerOutputManifests
    .filter(
      (manifest) =>
        affectedRecordIds.has(manifest.materializationRecordId) ||
        existingManifestIds.has(manifest.id)
    )
    .map((manifest) => manifest.id);
  const collectedOutputManifestIds = uniqueStrings([
    ...input.record.collectedOutputManifestIds,
    ...matchingOutputManifestIds,
  ]);

  if (matchingOutputManifestIds.length === 0) {
    throw new OperationError(
      'workspace_recovery_decision_failed',
      `Workspace recovery collection has no durable output manifest: ${input.record.id}`,
      404
    );
  }

  return {
    backendReachability: {
      checkedAt: input.decidedAt,
      detail:
        'Recovered from durable worker output manifests; live backend reachability was not required.',
      status: 'unknown',
    },
    collectedOutputManifestIds,
    evidenceBundleIds: input.record.evidenceBundleIds,
  };
}

/**
 * Deduplicates strings while preserving first-seen order.
 *
 * @param values Candidate string values.
 * @returns Unique values in stable order.
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Maps a recovery decision to the terminal reconciliation state.
 *
 * @param decision Human recovery decision.
 * @returns Terminal reconciliation state.
 */
function recoveryDecisionState(
  decision: WorkspaceRecoveryDecision
): WorkspaceReconciliationRecord['stateAfter'] {
  if (decision === 'stage_verified') {
    return 'recovered';
  }
  if (decision === 'resume_collection') {
    return 'recovered';
  }
  if (decision === 'quarantine') {
    return 'quarantined';
  }

  return 'unrecoverable';
}

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

/**
 * Replays imported workspace reconciliation records.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Exported reconciliation records to replay.
 */
export function importWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  records: readonly WorkspaceReconciliationRecord[]
): void {
  for (const record of records) {
    persistWorkspaceReconciliationRecordV1(
      workspaceDb,
      StoredWorkspaceReconciliationRecordV1Schema.parse(record)
    );
  }
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
  anchor: WorkerBackendSessionRecord,
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
  anchor: WorkerBackendSessionRecord,
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
      const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
        `workspace:${db.sqlite.name}`
      );
      try {
        completeWorkspaceCaptureRecovery(db, fullOwner!, identity, source);
      } finally {
        resume();
      }
      continue;
    }
    const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
      `workspace:${db.sqlite.name}`
    );
    let record: WorkspaceReconciliationRecord;
    try {
      record = recordWorkspaceCaptureRecovery(db, fullOwner!, identity, source);
    } finally {
      resume();
    }
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
