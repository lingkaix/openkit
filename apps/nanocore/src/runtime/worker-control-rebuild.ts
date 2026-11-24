import { isDeepStrictEqual } from 'node:util';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { readRetainedV1 } from '@openkit/protocol';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import type Database from 'better-sqlite3';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { type CoreDb, openAdmittedWorkspaceReadDb } from '../storage/db.js';
import { readNanoHostObservation } from '../storage/nanohost-observation-reader.js';
import { readNanoHostRecoveryLease } from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';
import type { StorageResult } from '../storage/storage-owner.js';
import { AgentEnvironmentSnapshotReadError } from '../storage/workspace-file-records.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import type { NanoHostExecutionAttemptRecord } from './nanohost-attempt-records.js';
import {
  listWorkerBackendSessions,
  readNanoHostWorkerRouteBinding,
} from './worker-backend-session-records.js';
import {
  assertWorkerControlRestoreRecords,
  type WorkerControlArtifactNotice,
  type WorkerControlGateway,
  type WorkerControlLineage,
  type WorkerControlSessionRestoreInput,
  type WorkerControlSupplyRefreshAck,
} from './worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  hasPendingWorkerCancellationFinal,
} from './worker-control-records.js';

interface WorkerControlRecordRow {
  readonly schemaVersion: unknown;
  readonly acceptedAt: string;
  readonly operation: string;
  readonly recordJson: string;
}

/** A closed predecessor whose own Workspace cannot prove its replay; it holds only that replay. */
interface WorkerControlRestoreHold {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly causeCode: 'workspace-not-admitted' | 'package-unreadable';
}

/**
 * Restores live control, cancellation-only first-final serving state and exact final replay.
 * The acknowledged NanoHost reader must cover the entire plan before any session is published.
 * A closed predecessor's own Workspace fault holds only its replay. Any other fault holds all.
 */
export function rebuildWorkerControlGatewaySessions(
  coreDb: CoreDb,
  gateway: WorkerControlGateway,
  readNanoHost?: <Value>(
    query: (sqlite: Database.Database) => Value
  ) => StorageResult<'nanohost', Value>
): StorageResult<'nanohost', void> {
  const held: WorkerControlRestoreHold[] = [];
  const plan = (sqlite: Database.Database) => {
    held.length = 0;
    return planWorkerControlRestore(coreDb, { sqlite }, held);
  };
  try {
    const observed = readNanoHost
      ? readNanoHost(plan)
      : readNanoHostObservation(coreDb.dataRoot, plan);
    if (observed.state !== 'ready') return observed;
    gateway.restoreSessions(observed.value);
  } catch {
    return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
  }
  for (const hold of held) reportWorkerControlRestoreHold(hold);
  return { state: 'ready', value: undefined };
}

/** Makes one per-owner replay hold inspectable with finite fields: no paths or exception text. */
function reportWorkerControlRestoreHold(hold: WorkerControlRestoreHold): void {
  try {
    console.error(
      JSON.stringify({
        event: 'worker.control.restore-held',
        errorCode: 'recovery_required',
        causeCode: hold.causeCode,
        attemptId: hold.attemptId,
        workspaceId: hold.workspaceId,
      })
    );
  } catch {
    // Diagnostics must not change the owning operation.
  }
}

function planWorkerControlRestore(
  coreDb: CoreDb,
  owner: { readonly sqlite: Database.Database },
  held: WorkerControlRestoreHold[]
): WorkerControlSessionRestoreInput[] {
  const now = new Date().toISOString();
  const leases = listAdmittedWorkerControlLeases(coreDb, owner);
  const planned: WorkerControlSessionRestoreInput[] = [];
  for (const lease of leases) {
    if (
      !lease.bindingRef ||
      !lease.workerControlTokenHash ||
      !lease.workerInferenceTokenHash ||
      !lease.workerCapabilityTokenHash
    ) {
      continue;
    }

    const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, lease.attemptId);
    const lineage: WorkerControlLineage = {
      agentSessionId: lease.agentSessionId,
      packageSnapshotId: lease.inputRef,
      requestId: admission.requestId,
      threadId: lease.threadId,
      turnId: lease.turnId,
      workspaceId: lease.workspaceId,
    };
    if (
      lease.phase !== 'open' &&
      !getWorkerControlAcceptedFinalStatus(owner, lineage) &&
      !hasPendingWorkerCancellationFinal(lease, now) &&
      !(
        lease.phase === 'closing' &&
        lease.terminalCause === 'worker-final-status' &&
        lease.fenceRef === null &&
        lease.recoveryState === null &&
        lease.heartbeatDeadline > now &&
        lease.deadline &&
        lease.deadline > now
      )
    )
      continue;
    // Native accepted records are shared authority. Read and validate them before either
    // owner-local skip so an unreadable or schema-invalid record holds the whole restore plan.
    const records = readAcceptedRecords(owner, lineage);
    assertWorkerControlRestoreRecords(records);
    // Closed exact-replay branch only (a closed lease qualifies only through its accepted final). A
    // closing first-final candidate keeps the shared hold. The replay's own Workspace is checked
    // before executable admission: a quarantined or retired owner holds only this replay; its exit
    // is that owner's repair and re-admission at the next hydration, or its proved retirement.
    const closed = lease.phase === 'closed';
    if (closed && !isScopeAdmitted(coreDb.dataRoot, 'workspace', lease.workspaceId)) {
      held.push({ ...ownerOf(lease), causeCode: 'workspace-not-admitted' });
      continue;
    }
    const workspaceDb = openAdmittedWorkspaceReadDb(coreDb.dataRoot, lease.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;

    try {
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        lease.workspaceId,
        lease.inputRef
      ).snapshot;
    } catch (error) {
      // Only the retained package decoder's own refusal is owner-local. A missing, duplicate or
      // contradicting package, and every Core or NanoHost fault, still holds the whole plan.
      if (!closed || !(error instanceof AgentEnvironmentSnapshotReadError)) throw error;
      held.push({ ...ownerOf(lease), causeCode: 'package-unreadable' });
      continue;
    } finally {
      workspaceDb.sqlite.close();
    }
    assertRestoredPackageLineage(environmentPackage, lease, admission);

    planned.push({
      ...records,
      environmentPackage,
      lineage,
      registeredAt: lease.createdAt,
      sandboxBindingRef: lease.bindingRef,
      workerControlTokenHash: lease.workerControlTokenHash,
      workerInferenceTokenHash: lease.workerInferenceTokenHash,
      workerCapabilityTokenHash: lease.workerCapabilityTokenHash,
    });
  }
  return planned;
}

function ownerOf(lease: NanoHostExecutionAttemptRecord) {
  return { attemptId: lease.attemptId, workspaceId: lease.workspaceId };
}

/** Native supplies the candidate tuples; the retained Core submission and phase still decide. */
function listAdmittedWorkerControlLeases(
  coreDb: CoreDb,
  owner: { readonly sqlite: Database.Database }
): NanoHostExecutionAttemptRecord[] {
  const live: NanoHostExecutionAttemptRecord[] = [];
  const terminal: NanoHostExecutionAttemptRecord[] = [];
  for (const session of listWorkerBackendSessions(owner)) {
    const original = readRetainedNanoHostSubmission(coreDb, session.attemptId);
    if (!original || !readNanoHostWorkerRouteBinding(owner, original.lease.grant)) {
      if (session.state === 'launching')
        throw new Error('Native Worker Gateway restore lacks its original submission.');
      continue;
    }
    const { attempt } = readNanoHostRecoveryLease(owner.sqlite, original.lease);
    (attempt.phase === 'open' ? live : terminal).push(attempt);
  }
  return [...live, ...terminal];
}

/**
 * Verifies that a durable AEP belongs to the execution attempt and admission actor being restored.
 *
 * @param environmentPackage Durable redacted AEP snapshot.
 * @param lease Restorable execution attempt.
 * @param admission Admission authority resolved through the scheduler chain.
 * @throws Error when any authority-bearing lineage field disagrees.
 */
function assertRestoredPackageLineage(
  environmentPackage: AgentEnvironmentPackage,
  lease: NanoHostExecutionAttemptRecord,
  admission: ReturnType<typeof requireSchedulerExecutionAttemptAdmissionContext>
): void {
  const scope = environmentPackage.scope;

  if (
    environmentPackage.snapshotId !== lease.inputRef ||
    scope.agentSessionId !== lease.agentSessionId ||
    scope.workspaceId !== lease.workspaceId ||
    scope.threadId !== lease.threadId ||
    scope.turnId !== lease.turnId ||
    !isDeepStrictEqual(scope.triggerActor, admission.triggerActor) ||
    scope.requestId !== admission.requestId
  ) {
    throw new Error(`Restored worker-control package lineage mismatch: ${lease.attemptId}`);
  }
}

/**
 * Reads product-safe accepted worker-control records without authorizing session restoration.
 *
 * @param owner Admitted SQLite owner of the accepted records.
 * @param lineage Worker-control lineage selector.
 * @returns Accepted records grouped by snapshot field.
 */
export function readAcceptedRecords(
  owner: { readonly sqlite: Database.Database },
  lineage: WorkerControlLineage
): {
  artifacts: WorkerControlArtifactNotice[];
  capabilitySummaries: WorkerCapabilityCallSummary[];
  events: WorkerCanonicalEventRecord[];
  supplyRefreshAcks: WorkerControlSupplyRefreshAck[];
} {
  const rows = owner.sqlite
    .prepare(
      `
      SELECT schema_version AS schemaVersion, operation, record_json AS recordJson, accepted_at AS acceptedAt
      FROM worker_control_records
      WHERE workspace_id = ?
        AND thread_id = ?
        AND turn_id = ?
        AND agent_session_id = ?
        AND package_snapshot_id = ?
        AND request_id IS ?
        AND operation <> 'heartbeat'
      ORDER BY accepted_at ASC, operation ASC
      `
    )
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as WorkerControlRecordRow[];
  const result = {
    artifacts: [] as WorkerControlArtifactNotice[],
    capabilitySummaries: [] as WorkerCapabilityCallSummary[],
    supplyRefreshAcks: [] as WorkerControlSupplyRefreshAck[],
  };

  const eventsByAcceptedAt = new Map<string, WorkerCanonicalEventRecord[]>();

  for (const row of rows) {
    const record = readRetainedV1(row, () => JSON.parse(row.recordJson) as unknown);

    // Historical heartbeat snapshots are inert; only the attempt and sequence owners survive restart.
    if (row.operation === 'artifact_notice') {
      result.artifacts.push(record as WorkerControlArtifactNotice);
    } else if (row.operation === 'supply_refresh_ack') {
      result.supplyRefreshAcks.push(record as WorkerControlSupplyRefreshAck);
    } else if (row.operation === 'capability_summary') {
      result.capabilitySummaries.push(record as WorkerCapabilityCallSummary);
    } else if (row.operation === 'event_append') {
      const eventType = (record as { event?: { type?: string } }).event?.type;
      // Observation transport receipts are not canonical transcript or public session events.
      // Their existing durable sequence fingerprints remain the replay authority.
      if (eventType !== 'observation.recorded' && eventType !== 'observation.content.chunk') {
        const event = record as WorkerCanonicalEventRecord;
        const events = eventsByAcceptedAt.get(row.acceptedAt);
        if (events) events.push(event);
        else eventsByAcceptedAt.set(row.acceptedAt, [event]);
      }
    }
  }

  return {
    ...result,
    // Buckets retain SQL timestamp order. Only events accepted in the same instant can swap.
    events: [...eventsByAcceptedAt.values()].flatMap((events) =>
      events.sort((left, right) => left.sequence - right.sequence)
    ),
  };
}
