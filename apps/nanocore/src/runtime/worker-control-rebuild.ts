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
import type { StorageResult } from '../storage/storage-owner.js';
import {
  AgentEnvironmentSnapshotReadError,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  listRestorableNanoHostExecutionAttempts,
  type NanoHostExecutionAttemptRecord,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
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

/**
 * Restores live control, cancellation-only first-final serving state and exact final replay.
 * The acknowledged NanoHost reader must cover the entire plan before any session is published.
 */
export function rebuildWorkerControlGatewaySessions(
  coreDb: CoreDb,
  gateway: WorkerControlGateway,
  readNanoHost?: <Value>(
    query: (sqlite: Database.Database) => Value
  ) => StorageResult<'nanohost', Value>
): StorageResult<'nanohost', void> {
  const plan = (sqlite: Database.Database) => planWorkerControlRestore(coreDb, { sqlite });
  if (!readNanoHost) {
    gateway.restoreSessions(plan(coreDb.sqlite));
    return { state: 'ready', value: undefined };
  }
  try {
    const observed = readNanoHost(plan);
    if (observed.state !== 'ready') return observed;
    gateway.restoreSessions(observed.value);
    return { state: 'ready', value: undefined };
  } catch {
    return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
  }
}

function planWorkerControlRestore(
  coreDb: CoreDb,
  owner: { readonly sqlite: Database.Database }
): WorkerControlSessionRestoreInput[] {
  const now = new Date().toISOString();
  const leases = [
    ...listRestorableNanoHostExecutionAttempts(coreDb),
    ...listTerminalControlLeases(coreDb, owner, now),
  ];
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
      !hasPendingWorkerCancellationFinal(lease, now)
    )
      continue;
    // Accepted records are shared Core authority: an unreadable or schema-invalid one holds the
    // whole plan, so it is read and validated before any owner-local hold can skip this lease.
    const records = readAcceptedRecords(owner, lineage);
    assertWorkerControlRestoreRecords(records);
    // Closed exact-replay branch only. A closing first-final candidate and an open lease keep the
    // shared hold. A closed predecessor whose own Workspace is not admitted, or whose retained AEP
    // its own decoder refuses, holds only this replay: its old routes stay unrestored (401) and its
    // exit is that owner's repair or proved retirement at the next boot.
    const closed = lease.phase === 'closed';
    if (closed && !isScopeAdmitted(coreDb.dataRoot, 'workspace', lease.workspaceId)) continue;
    const workspaceDb = openAdmittedWorkspaceReadDb(coreDb.dataRoot, lease.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;

    try {
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        lease.workspaceId,
        lease.inputRef
      ).snapshot;
    } catch (error) {
      if (closed && error instanceof AgentEnvironmentSnapshotReadError) continue;
      throw error;
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

/** Core supplies candidate placement. Only the admitted record owner can show final acceptance. */
function listTerminalControlLeases(
  coreDb: CoreDb,
  owner: { readonly sqlite: Database.Database },
  now: string
): NanoHostExecutionAttemptRecord[] {
  const table = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('scheduler_execution_attempts');
  if (!table) return [];

  const rows = coreDb.sqlite
    .prepare(
      `SELECT attempt_id AS attemptId, workspace_id AS workspaceId, thread_id AS threadId,
         turn_id AS turnId, agent_session_id AS agentSessionId, input_ref AS packageSnapshotId,
         phase, terminal_cause AS terminalCause
       FROM scheduler_execution_attempts
       WHERE phase IN ('closing', 'closed') AND binding_ref IS NOT NULL
         AND worker_control_token_hash IS NOT NULL AND worker_inference_token_hash IS NOT NULL
         AND deadline > ?
       ORDER BY created_at ASC, attempt_id ASC`
    )
    .all(now) as Array<
    Omit<WorkerControlLineage, 'requestId'> & {
      attemptId: string;
      phase: 'closing' | 'closed';
      terminalCause: string | null;
    }
  >;
  if (rows.length === 0) return [];

  const hasFinal = owner.sqlite.prepare(
    `SELECT 1 FROM worker_control_records
     WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? AND agent_session_id = ?
       AND package_snapshot_id = ? AND operation = 'final_status' LIMIT 1`
  );
  return rows
    .filter(
      (lease) =>
        (lease.phase === 'closing' &&
          [
            'turn-cancelled',
            'raw-output-exhausted',
            'raw-output-unavailable',
            'observation_limit_reached',
          ].includes(lease.terminalCause ?? '')) ||
        hasFinal.get(
          lease.workspaceId,
          lease.threadId,
          lease.turnId,
          lease.agentSessionId,
          lease.packageSnapshotId
        )
    )
    .map((lease) => requireNanoHostExecutionAttempt(coreDb, lease.attemptId));
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
