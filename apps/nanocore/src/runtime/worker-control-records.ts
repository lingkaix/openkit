import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { type StopReason, StopReasonSchema, type TurnStatus } from '@openkit/protocol';
import {
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataSchema,
  WorkerObservationDataSchema,
} from '@openkit/worker-protocol';
import { stageWorkObservationChunk, workObservationBodyBundleId } from '../evidence-bundles.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  appendWorkObservation,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import { resolveNanoHostAttemptTokenBinding } from './nanohost-attempt-records.js';
import type {
  WorkerControlAcceptedRecordRecorder,
  WorkerControlAcceptedRecordRecorderInput,
  WorkerControlFinalStatus,
  WorkerControlFinalStatusTokenBindingResolution,
  WorkerControlLineage,
  WorkerControlTokenBindingInput,
} from './worker-control-gateway.js';
import { workerControlEventReceipt } from './worker-control-gateway.js';

/** Default interval for observing one scheduler-owned durable final status. */
const WORKER_FINAL_STATUS_POLL_INTERVAL_MS = 100;

/** Inputs for waiting until one exact scheduler-owned worker has durably completed. */
export interface WaitForWorkerControlFinalStatusInput {
  /** execution attempt that owns the worker. */
  readonly attemptId: string;
  /** Complete worker-control lineage that the final status must match. */
  readonly lineage: WorkerControlLineage;
}

/** Durable final-status fields required by online and restart closeout. */
export type AcceptedWorkerFinalStatus = Pick<
  WorkerControlFinalStatus,
  'acceptedAt' | 'diagnostics' | 'status' | 'stopReason'
>;

/**
 * Validates one accepted worker status against the closed Core stop-reason mapping.
 *
 * @param accepted Durable worker-control terminal facts.
 * @returns Canonical Core stop reason.
 * @throws Error when the raw stop reason is unknown or incompatible with the worker status.
 */
export function canonicalStopReasonForAcceptedWorkerFinalStatus(
  accepted: AcceptedWorkerFinalStatus
): StopReason {
  if (accepted.stopReason === 'ask_user') {
    throw new Error('recovery_required');
  }
  const parsed = StopReasonSchema.safeParse(accepted.stopReason);
  if (!parsed.success) {
    throw new Error('Accepted worker final status has no canonical Core StopReason.');
  }

  const stopReason = parsed.data;
  const compatible =
    (accepted.status === 'completed' && stopReason === 'completed') ||
    (accepted.status === 'blocked' &&
      (stopReason === 'length' || stopReason === 'budget_exhausted')) ||
    ((accepted.status === 'cancelled' || accepted.status === 'interrupted') &&
      stopReason === 'aborted') ||
    ((accepted.status === 'failed' ||
      accepted.status === 'degraded' ||
      accepted.status === 'lost') &&
      stopReason === 'error');

  if (!compatible) {
    throw new Error('Accepted worker final status has no canonical Core StopReason.');
  }
  return stopReason;
}

/**
 * Maps one canonical worker stop reason to its product Turn status.
 *
 * @param stopReason Canonical Core stop reason.
 * @returns Product Turn status required by that reason.
 */
export function turnStatusForCanonicalWorkerStopReason(stopReason: 'aborted'): 'interrupted';
export function turnStatusForCanonicalWorkerStopReason(
  stopReason: StopReason
): Extract<TurnStatus, 'interrupted' | 'completed' | 'failed'>;
export function turnStatusForCanonicalWorkerStopReason(
  stopReason: StopReason
): Extract<TurnStatus, 'interrupted' | 'completed' | 'failed'> {
  if (stopReason === 'completed' || stopReason === 'length' || stopReason === 'budget_exhausted') {
    return 'completed';
  }
  return stopReason === 'aborted' ? 'interrupted' : 'failed';
}

/**
 * Creates a server-scope SQLite recorder for accepted worker-control records.
 *
 * @param coreDb Server-scope Core database.
 * @returns Durable accepted-record recorder.
 */
export function createWorkerControlAcceptedRecordRecorder(
  coreDb: CoreDb
): WorkerControlAcceptedRecordRecorder {
  return {
    record(input) {
      recordWorkerControlAcceptedRecord(coreDb, input);
    },
  };
}

/**
 * Stores one product-safe accepted worker-control record.
 *
 * @param coreDb Server-scope Core database.
 * @param input Accepted worker-control record.
 */
export function recordWorkerControlAcceptedRecord(
  coreDb: CoreDb,
  input: WorkerControlAcceptedRecordRecorderInput
): void {
  const event =
    input.operation === 'event_append'
      ? WorkerCanonicalEventRecordSchema.parse(input.record)
      : null;
  const receipt = event ? workerControlEventReceipt(event) : input.record;
  const existing = coreDb.sqlite
    .prepare(`SELECT record_json AS recordJson FROM worker_control_records
    WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = ? AND record_key = ?`)
    .get(
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.operation,
      input.recordKey
    ) as { recordJson: string } | undefined;
  if (existing && !isDeepStrictEqual(JSON.parse(existing.recordJson), receipt))
    throw new Error('recovery_required: worker receipt identity conflict');
  if (event) recordWorkerObservation(coreDb, event, existing !== undefined);
  coreDb.sqlite
    .prepare(
      `
      INSERT OR IGNORE INTO worker_control_records (
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        request_id,
        operation,
        record_key,
        sequence,
        record_json,
        accepted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.lineage.requestId ?? null,
      input.operation,
      input.recordKey,
      input.sequence ?? null,
      JSON.stringify(receipt),
      input.acceptedAt
    );
}

/** Retains one observation under verified outer lineage before a sanitized control receipt can be acknowledged. */
function recordWorkerObservation(
  coreDb: CoreDb,
  event: WorkerCanonicalEventRecord,
  replay: boolean
): void {
  if (
    event.event.type !== 'observation.recorded' &&
    event.event.type !== 'observation.content.chunk'
  )
    return;
  const { lineage } = event;
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
  const owner = { threadId: lineage.threadId, turnId: lineage.turnId };
  const recordId = (observationId: string) =>
    `obs_runtime_${createHash('sha256')
      .update(JSON.stringify([lineage.packageSnapshotId, observationId]))
      .digest('hex')}`;
  const id = recordId(event.event.data.observationId);
  try {
    applyScopedMigrations(workspaceDb);
    const binding = readWorkObservationTurnBinding(workspaceDb, owner);
    if (!binding.coverage)
      throw new Error('recovery_required: observation capture binding is missing');
    if (binding.turn.agentSessionId !== lineage.agentSessionId)
      throw new Error('recovery_required: observation AgentSession mismatch');
    if (event.event.type === 'observation.recorded') {
      const data = event.event.data;
      if (data.content.state === 'expected' && binding.coverage.value !== 'on')
        throw new Error('Observation content is not admitted by this Turn');
      let parent: string | undefined;
      if (data.content.state === 'unavailable' && data.content.expectedObservationId) {
        parent = recordId(data.content.expectedObservationId);
        const rows = readWorkObservations(workspaceDb, owner);
        const expected = rows.find((row) => row.id === parent);
        const current = rows.find((row) => row.id === id);
        if (
          !expected ||
          expected.type !== 'runtime.observed' ||
          (current && expected.seq >= current.seq) ||
          !expected.refs?.some(
            (ref) =>
              ref.kind === 'aep-snapshot' &&
              ref.edge === 'association' &&
              ref.locator === lineage.packageSnapshotId &&
              ref.scope.workspaceId === lineage.workspaceId
          )
        )
          throw new Error('Observation unavailability lacks earlier same-package metadata');
        const declaration = WorkerObservationDataSchema.parse(expected.payload);
        if (
          declaration.observationId !== data.content.expectedObservationId ||
          declaration.content.state !== 'expected' ||
          declaration.sourceRef !== data.sourceRef ||
          declaration.sourceSequence >= data.sourceSequence ||
          declaration.fact.kind !== data.fact.kind ||
          declaration.fact.runtimeOriginRef !== data.fact.runtimeOriginRef ||
          declaration.fact.callRef !== data.fact.callRef ||
          declaration.fact.messageRef !== data.fact.messageRef
        )
          throw new Error('Observation unavailability lacks earlier expected content');
      }
      const observation: WorkObservationDraft = {
        id,
        type: 'runtime.observed',
        ts: data.observedAt,
        obs: 'sidecar',
        ...(parent ? { parent } : {}),
        ret: 'turn-evidence',
        refs: [
          {
            kind: 'aep-snapshot',
            scope: { workspaceId: lineage.workspaceId },
            locator: lineage.packageSnapshotId,
            edge: 'association',
          },
        ],
        payload: data,
      };
      appendWorkObservation(workspaceDb, {
        ...owner,
        observation,
        bodies:
          data.content.state === 'expected' && data.content.bytes === 0
            ? [
                {
                  id: 'content',
                  bytes: new Uint8Array(),
                  mediaType: data.content.mediaType,
                  boundary: data.content.boundary,
                },
              ]
            : [],
      });
      return;
    }
    if (binding.coverage.value !== 'on')
      throw new Error('Observation content is not admitted by this Turn');
    const initial = readWorkObservations(workspaceDb, owner).find((row) => row.id === id);
    if (!initial) throw new Error('Observation content arrived without durable metadata');
    const declaration = WorkerObservationDataSchema.parse(initial.payload);
    if (declaration.content.state !== 'expected')
      throw new Error('Observation has no expected content');
    const expected = declaration.content;
    const chunk = event.event.data;
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.toString('base64') !== chunk.data)
      throw new Error('Observation chunk encoding is not canonical');
    const staged = stageWorkObservationChunk(workspaceDb, {
      ...owner,
      bundleId: workObservationBodyBundleId(
        lineage.workspaceId,
        owner.threadId,
        owner.turnId,
        id,
        'content'
      ),
      createdAt: initial.ts,
      sha256: expected.sha256.replace(/^sha256:/, ''),
      totalBytes: expected.bytes,
      chunkCount: expected.chunkCount,
      chunkIndex: chunk.chunkIndex,
      byteOffset: chunk.byteOffset,
      bytes,
    });
    if (staged.state === 'expired' && !replay)
      throw new Error('Expired observation evidence cannot accept new content');
    if (staged.state === 'complete') {
      const { v: _v, seq: _seq, turnId: _turnId, ...observation } = initial;
      appendWorkObservation(workspaceDb, {
        ...owner,
        observation,
        bodies: [
          {
            id: 'content',
            bytes: staged.bytes,
            mediaType: expected.mediaType,
            boundary: expected.boundary,
          },
        ],
      });
    }
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Reads canonical events durably accepted for one complete worker package lineage.
 *
 * @param coreDb Server-scope Core database.
 * @param lineage Exact package lineage selector.
 * @returns Canonical accepted events ordered by worker sequence.
 * @throws Error when durable event JSON is invalid or contradicts the selected lineage.
 */
export function listWorkerControlAcceptedEvents(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): WorkerCanonicalEventRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `
      SELECT record_json AS recordJson
      FROM worker_control_records
      WHERE workspace_id = ?
        AND thread_id = ?
        AND turn_id = ?
        AND agent_session_id = ?
        AND package_snapshot_id = ?
        AND request_id IS ?
        AND operation = 'event_append'
      ORDER BY sequence ASC
      `
    )
    .all(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as Array<{ readonly recordJson: string }>;

  return rows.flatMap((row) => {
    const value = JSON.parse(row.recordJson) as { event?: { type?: string } };
    if (value.event?.type === 'observation.content.chunk') return [];
    const record = WorkerCanonicalEventRecordSchema.parse(value);

    if (!sameWorkerControlLineage(record.lineage, lineage)) {
      throw new Error('Durable worker event record contradicts its indexed package lineage.');
    }

    return [record];
  });
}

/** Reads the accepted final status for one exact worker lineage. */
export function getWorkerControlAcceptedFinalStatus(
  coreDb: CoreDb,
  lineage: WorkerControlLineage
): AcceptedWorkerFinalStatus | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT record_json AS recordJson, accepted_at AS acceptedAt
       FROM worker_control_records
       WHERE workspace_id = ?
         AND thread_id = ?
         AND turn_id = ?
         AND agent_session_id = ?
         AND package_snapshot_id = ?
         AND request_id IS ?
         AND operation = 'final_status'
       LIMIT 1`
    )
    .get(
      lineage.workspaceId,
      lineage.threadId,
      lineage.turnId,
      lineage.agentSessionId,
      lineage.packageSnapshotId,
      lineage.requestId ?? null
    ) as { readonly acceptedAt: string; readonly recordJson: string } | undefined;
  if (!row) {
    return null;
  }
  const raw = JSON.parse(row.recordJson) as Record<string, unknown>;
  // Reuse terminal admission's schema while leaving unrelated durable record fields alone.
  const record = WorkerCanonicalTerminalEventDataSchema.parse({
    ...(raw.diagnostics !== undefined ? { diagnostics: raw.diagnostics } : {}),
    status: raw.status,
    stopReason: raw.stopReason,
  });
  return {
    acceptedAt: row.acceptedAt,
    ...(record.diagnostics ? { diagnostics: record.diagnostics } : {}),
    status: record.status,
    stopReason: record.stopReason,
  };
}

/**
 * Waits until one exact worker final status is durable or its lease can no longer complete.
 *
 * Accepted evidence remains authoritative after expiry. Cancellation revokes effects but leaves
 * the exact terminal stream available until liveness or the absolute deadline expires.
 *
 * @param coreDb Server-scope Core database.
 * @param input Exact attempt identity and worker lineage.
 * @throws Error when lineage is absent, the lease expires, or its state becomes non-waitable.
 */
export async function waitForWorkerControlFinalStatus(
  coreDb: CoreDb,
  input: WaitForWorkerControlFinalStatusInput
): Promise<AcceptedWorkerFinalStatus> {
  for (;;) {
    const lease = coreDb.sqlite
      .prepare(
        `SELECT phase, deadline, terminal_cause AS terminalCause,
                recovery_state AS recoveryState,
                CASE WHEN last_accepted_heartbeat_at IS NULL THEN startup_deadline
                     ELSE heartbeat_deadline END AS workerDeadline
         FROM scheduler_execution_attempts
         WHERE attempt_id = ?
           AND workspace_id = ?
           AND thread_id = ?
           AND turn_id = ?
           AND agent_session_id = ?
           AND input_ref = ?`
      )
      .get(
        input.attemptId,
        input.lineage.workspaceId,
        input.lineage.threadId,
        input.lineage.turnId,
        input.lineage.agentSessionId,
        input.lineage.packageSnapshotId
      ) as
      | {
          readonly deadline: string | null;
          readonly phase: string;
          readonly terminalCause: string | null;
          readonly recoveryState: string | null;
          readonly workerDeadline: string | null;
        }
      | undefined;

    if (!lease) {
      throw new Error('Worker completion lease does not match the exact durable lineage.');
    }
    const accepted = getWorkerControlAcceptedFinalStatus(coreDb, input.lineage);
    if (accepted) {
      return accepted;
    }
    const cancelled =
      lease.phase === 'closing' &&
      lease.terminalCause === 'turn-cancelled' &&
      lease.recoveryState === null &&
      lease.workerDeadline !== null &&
      lease.workerDeadline > new Date().toISOString();
    if (lease.phase !== 'open' && !cancelled) {
      throw new Error(`Worker lease became ${lease.phase} before durable final status.`);
    }
    if (lease.deadline === null || lease.deadline <= new Date().toISOString()) {
      throw new Error('Worker lease expired before durable final status.');
    }

    await delay(WORKER_FINAL_STATUS_POLL_INTERVAL_MS);
  }
}

/**
 * Checks complete worker package lineage equality, including nullable request identity.
 *
 * @param left First worker lineage.
 * @param right Second worker lineage.
 * @returns True only when all package scope fields are equal.
 */
function sameWorkerControlLineage(
  left: WorkerControlLineage,
  right: WorkerControlLineage
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.agentSessionId === right.agentSessionId &&
    left.packageSnapshotId === right.packageSnapshotId &&
    (left.requestId ?? null) === (right.requestId ?? null)
  );
}

/**
 * Resolves live or cancellation-owned terminal evidence, or exact replay during release grace.
 *
 * @param coreDb Server-scope Core database.
 * @param input Sandbox binding and worker lineage.
 * @returns First terminal evidence, replay-only acceptance, or a stable rejection.
 */
export function resolveWorkerControlFinalStatusTokenBinding(
  coreDb: CoreDb,
  input: WorkerControlTokenBindingInput
): WorkerControlFinalStatusTokenBindingResolution {
  const live = resolveNanoHostAttemptTokenBinding(coreDb, input);

  if (live.status === 'accepted') {
    const admission = requireSchedulerExecutionAttemptAdmissionContext(
      coreDb,
      live.attempt.attemptId
    );

    if ((admission.requestId ?? null) !== (input.lineage.requestId ?? null)) {
      return { reason: 'lineage-mismatch', status: 'rejected' };
    }

    return { replayOnly: false, status: 'accepted' };
  }

  if (live.reason !== 'attempt-not-live') {
    return live;
  }

  const row = coreDb.sqlite
    .prepare(
      `SELECT attempt_id AS attemptId, deadline AS expiresAt, phase,
              terminal_cause AS terminalCause,
              EXISTS (
                SELECT 1 FROM worker_control_records
                 WHERE worker_control_records.workspace_id = scheduler_execution_attempts.workspace_id
                   AND worker_control_records.thread_id = scheduler_execution_attempts.thread_id
                   AND worker_control_records.turn_id = scheduler_execution_attempts.turn_id
                   AND worker_control_records.agent_session_id = scheduler_execution_attempts.agent_session_id
                   AND worker_control_records.package_snapshot_id = scheduler_execution_attempts.input_ref
                   AND worker_control_records.request_id IS ?
                   AND worker_control_records.operation = 'final_status'
              ) AS finalStatusRecorded
         FROM scheduler_execution_attempts
        WHERE binding_ref = ?
          AND workspace_id = ?
          AND thread_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND input_ref = ?
          AND phase IN ('closing', 'closed')`
    )
    .get(
      input.lineage.requestId ?? null,
      input.sandboxBindingRef,
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId
    ) as
    | {
        expiresAt: string | null;
        attemptId: string;
        phase: string;
        terminalCause: string | null;
        finalStatusRecorded: number;
      }
    | undefined;

  const timestamp = new Date().toISOString();
  if (!row || !row.expiresAt || row.expiresAt <= timestamp) {
    return live;
  }

  const admission = requireSchedulerExecutionAttemptAdmissionContext(coreDb, row.attemptId);

  if ((admission.requestId ?? null) !== (input.lineage.requestId ?? null)) {
    return { reason: 'lineage-mismatch', status: 'rejected' };
  }

  if (row.finalStatusRecorded) return { replayOnly: true, status: 'accepted' };
  // The live resolver already authenticated the exact token and binding before refusing effects.
  // Only cancellation retains a first terminal report; cleanup and closed attempts permit replay.
  if (row.phase === 'closing' && row.terminalCause === 'turn-cancelled')
    return { replayOnly: false, status: 'accepted' };
  return live;
}
