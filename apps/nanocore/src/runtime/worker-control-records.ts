import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { type AgentEnvironmentPackage, NativeLogMaxBytesSchema } from '@openkit/config-schema';
import {
  readRetainedV1,
  type StopReason,
  StopReasonSchema,
  type TurnStatus,
  writeRetainedV1,
} from '@openkit/protocol';
import {
  WORKER_CONTROL_EVENT_APPEND_MAX_BYTES,
  WORKER_OBSERVATION_SOURCE_MAX_BYTES,
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordReaderSchema,
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataSchema,
  type WorkerObservationData,
  WorkerObservationDataSchema,
} from '@openkit/worker-protocol';
import { stageWorkObservationChunk, workObservationBodyBundleId } from '../evidence-bundles.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  appendWorkObservation,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  type NanoHostExecutionAttemptRecord,
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import { getWorkerBackendSession, workerBackendImageIdentity } from './worker-backend-sessions.js';
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
 * @param terminalCause Durable native-stop cause from the exact execution attempt, when present.
 * @returns Canonical Core stop reason.
 * @throws Error when the raw stop reason is unknown or incompatible with the worker status.
 */
export function canonicalStopReasonForAcceptedWorkerFinalStatus(
  accepted: AcceptedWorkerFinalStatus,
  terminalCause?: string | null
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
  return terminalCause === 'turn-cancelled'
    ? 'aborted'
    : terminalCause === 'raw-output-exhausted'
      ? 'budget_exhausted'
      : terminalCause === 'raw-output-unavailable'
        ? 'error'
        : stopReason;
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
    prepareObservation(record) {
      return prepareWorkerControlObservation(coreDb, record);
    },
    record(input) {
      writeWorkerControlAcceptedRecord(coreDb, input);
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
): void | Promise<void> {
  if (input.operation === 'event_append') {
    const event = WorkerCanonicalEventRecordSchema.parse(input.record);
    if (
      event.event.type === 'observation.recorded' ||
      event.event.type === 'observation.content.chunk'
    )
      return prepareWorkerControlObservation(coreDb, event).then(() => {
        writeWorkerControlAcceptedRecord(coreDb, input);
      });
  }
  writeWorkerControlAcceptedRecord(coreDb, input);
}

/** Returns the original native observation identity shared by live capture and source recovery. */
export function workerObservationRecordId(
  packageSnapshotId: string,
  observationId: string
): string {
  return `obs_runtime_${createHash('sha256')
    .update(JSON.stringify([packageSnapshotId, observationId]))
    .digest('hex')}`;
}

/**
 * Recovers restricted bytes for already accepted metadata without creating live control acceptance.
 * @param coreDb Original Core receipt owner.
 * @param input Historical AEP, original metadata and backend-private verified source file; caller checks current publication authority.
 * @throws When source, lineage or original acceptance is missing or conflicting.
 */
export async function recoverWorkerObservationSource(
  coreDb: CoreDb,
  input: {
    environmentPackage: AgentEnvironmentPackage;
    metadata: WorkerCanonicalEventRecord;
    sourcePath: string;
    assertPublicationAuthority: () => void;
  }
): Promise<void> {
  if (coreDb.sqlite.inTransaction)
    throw new Error('Observation recovery must precede the Core transaction');
  const metadata = WorkerCanonicalEventRecordReaderSchema.parse(input.metadata);
  const pkg = input.environmentPackage;
  if (
    metadata.event.type !== 'observation.recorded' ||
    !sameWorkerControlLineage(metadata.lineage, {
      ...pkg.scope,
      packageSnapshotId: pkg.snapshotId,
    })
  )
    throw new Error('recovery_required: observation source lineage mismatch');
  const content = metadata.event.data.content;
  if (content.state !== 'expected') throw new Error('Observation source has no admitted body');
  const checkReceipt = (record: WorkerCanonicalEventRecord, required = false): void => {
    const fingerprint = coreDb.sqlite
      .prepare(`SELECT fingerprint FROM worker_control_sequence_fingerprints
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append' AND sequence=?`)
      .get(record.lineage.agentSessionId, record.lineage.packageSnapshotId, record.sequence) as
      | { fingerprint: string }
      | undefined;
    if (
      fingerprint &&
      !isDeepStrictEqual(JSON.parse(fingerprint.fingerprint), workerControlEventReceipt(record))
    )
      throw new Error('recovery_required: observation source sequence conflict');
    const row = coreDb.sqlite
      .prepare(`SELECT schema_version AS schemaVersion, record_json AS recordJson
      FROM worker_control_records WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append' AND record_key=?`)
      .get(
        record.lineage.agentSessionId,
        record.lineage.packageSnapshotId,
        String(record.sequence)
      ) as { schemaVersion: unknown; recordJson: string } | undefined;
    if (
      (!row && required) ||
      (row &&
        !readRetainedV1(row, () =>
          isDeepStrictEqual(JSON.parse(row.recordJson), workerControlEventReceipt(record))
        ))
    )
      throw new Error('recovery_required: original observation acceptance missing or conflicting');
  };
  checkReceipt(metadata, true);
  const source = await open(
    input.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const chunks: WorkerCanonicalEventRecord[] = [];
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > WORKER_OBSERVATION_SOURCE_MAX_BYTES)
      throw new Error('Observation source file exceeds its bounded representation');
    const hash = createHash('sha256');
    let count = 0;
    let bytes = 0;
    const buffer = Buffer.alloc(WORKER_CONTROL_EVENT_APPEND_MAX_BYTES);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end < 0)
        throw new Error('Observation source line is torn or exceeds its transport bound');
      position += end + 1;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const record = WorkerCanonicalEventRecordReaderSchema.parse(JSON.parse(line));
        if (count++ === 0) {
          if (!isDeepStrictEqual(record, metadata))
            throw new Error('Observation source metadata conflict');
          continue;
        }
        if (
          record.event.type !== 'observation.content.chunk' ||
          !sameWorkerControlLineage(record.lineage, metadata.lineage) ||
          record.sequence !== metadata.sequence + count - 1 ||
          chunks.length >= content.chunkCount
        )
          throw new Error('Observation source chunk identity conflict');
        const chunk = record.event.data;
        const decoded = Buffer.from(chunk.data, 'base64');
        if (
          chunk.observationId !== metadata.event.data.observationId ||
          chunk.chunkIndex !== chunks.length ||
          chunk.byteOffset !== bytes ||
          decoded.toString('base64') !== chunk.data ||
          bytes + decoded.length > content.bytes
        )
          throw new Error('Observation source chunk coordinates conflict');
        checkReceipt(record);
        hash.update(decoded);
        bytes += decoded.length;
        chunks.push(record);
      }
    }
    if (
      chunks.length !== content.chunkCount ||
      bytes !== content.bytes ||
      `sha256:${hash.digest('hex')}` !== content.sha256
    )
      throw new Error('Observation source digest or length conflict');
  } finally {
    await source.close();
  }
  // Source collection restores evidence only. It never fills stale live sequences or receipts.
  for (const chunk of chunks) {
    input.assertPublicationAuthority();
    await recordWorkerObservation(coreDb, chunk, false);
  }
}

/** Writes only the original Core receipt; native observation work finishes before this synchronous step. */
function writeWorkerControlAcceptedRecord(
  coreDb: CoreDb,
  input: WorkerControlAcceptedRecordRecorderInput
): void {
  const event =
    input.operation === 'event_append'
      ? WorkerCanonicalEventRecordSchema.parse(input.record)
      : null;
  const receipt = event ? workerControlEventReceipt(event) : input.record;
  const existing = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, record_json AS recordJson FROM worker_control_records
    WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = ? AND record_key = ?`)
    .get(
      input.lineage.agentSessionId,
      input.lineage.packageSnapshotId,
      input.operation,
      input.recordKey
    ) as { schemaVersion: unknown; recordJson: string } | undefined;
  if (
    existing &&
    !readRetainedV1(existing, () => isDeepStrictEqual(JSON.parse(existing.recordJson), receipt))
  )
    throw new Error('recovery_required: worker receipt identity conflict');
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
        accepted_at,
        schema_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.acceptedAt,
      writeRetainedV1({}).schemaVersion
    );
}

/** Verifies original Core identity, then awaits native observation publication before any Core receipt. */
function prepareWorkerControlObservation(
  coreDb: CoreDb,
  event: WorkerCanonicalEventRecord
): Promise<void> {
  if (coreDb.sqlite.inTransaction)
    throw new Error('Observation preparation must precede the Core transaction');
  const existing = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, record_json AS recordJson
    FROM worker_control_records WHERE agent_session_id=? AND package_snapshot_id=? AND operation='event_append' AND record_key=?`)
    .get(event.lineage.agentSessionId, event.lineage.packageSnapshotId, String(event.sequence)) as
    | { schemaVersion: unknown; recordJson: string }
    | undefined;
  if (
    existing &&
    !readRetainedV1(existing, () =>
      isDeepStrictEqual(JSON.parse(existing.recordJson), workerControlEventReceipt(event))
    )
  )
    throw new Error('recovery_required: worker receipt identity conflict');
  return recordWorkerObservation(coreDb, event, existing !== undefined);
}

/** Retains one observation under verified outer lineage before a sanitized control receipt can be acknowledged. */
async function recordWorkerObservation(
  coreDb: CoreDb,
  event: WorkerCanonicalEventRecord,
  replay: boolean
): Promise<void> {
  if (
    event.event.type !== 'observation.recorded' &&
    event.event.type !== 'observation.content.chunk'
  )
    return;
  const { lineage } = event;
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, lineage.workspaceId);
  const owner = { threadId: lineage.threadId, turnId: lineage.turnId };
  const id = workerObservationRecordId(lineage.packageSnapshotId, event.event.data.observationId);
  /** Validate native source evidence and reserve expected unit bytes through existing records. */
  const admitNative = (data: WorkerObservationData): void => {
    if (data.fact.kind !== 'native-transcript' && data.fact.kind !== 'runtime-log') return;
    const native = data.fact.native;
    const current = requireAgentEnvironmentPackageSnapshot(
      workspaceDb,
      lineage.workspaceId,
      lineage.packageSnapshotId
    ).snapshot;
    if (
      !native ||
      current.scope.threadId !== lineage.threadId ||
      current.scope.turnId !== lineage.turnId ||
      current.scope.agentSessionId !== lineage.agentSessionId ||
      current.agent.runtimeKind !== native.harness ||
      current.agent.runtimeVersion !== native.authoredVersion
    )
      throw new Error('Native observation does not match its named AEP.');
    if (native.imageDigest !== null) {
      // This owner binds physical NanoHost Epochs; backendKind names the logical backend.
      // Only its unique same-package physical binding can verify a Worker image claim.
      const bindings = coreDb.sqlite
        .prepare(
          `SELECT attempt_id AS attemptId FROM worker_backend_sessions
           WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
             AND agent_session_id = ? AND package_snapshot_id = ? LIMIT 2`
        )
        .all(
          lineage.workspaceId,
          lineage.threadId,
          lineage.turnId,
          lineage.agentSessionId,
          lineage.packageSnapshotId
        ) as { attemptId: string }[];
      const backend =
        bindings.length === 1 ? getWorkerBackendSession(coreDb, bindings[0]!.attemptId) : null;
      const identity = backend ? workerBackendImageIdentity(backend.backendLineage) : null;
      const digest = identity?.match(/(?:^|@)(sha256:[a-f0-9]{64})$/)?.[1];
      // Without a bound digest the claim stays descriptive, never admission authority.
      if (digest && native.imageDigest !== digest)
        throw new Error('Native image claim conflicts with its physical backend binding.');
    }
    const rows = readWorkObservations(workspaceDb, owner);
    let used = 0;
    let firstLogPackage: string | undefined;
    for (const row of rows) {
      if (row.type !== 'runtime.observed') continue;
      const prior = WorkerObservationDataSchema.parse(row.payload);
      if (prior.fact.kind !== 'native-transcript' && prior.fact.kind !== 'runtime-log') continue;
      const associations = row.refs?.filter(
        (ref) =>
          ref.kind === 'aep-snapshot' &&
          ref.edge === 'association' &&
          ref.scope.workspaceId === lineage.workspaceId
      );
      if (associations?.length !== 1)
        throw new Error('recovery_required: native observation AEP association is missing');
      const packageId = associations[0]!.locator;
      if (packageId === lineage.packageSnapshotId && prior.sourceRef === data.sourceRef) {
        if (prior.sourceSequence === data.sourceSequence && row.id !== id)
          throw new Error('Native source sequence conflicts with an existing observation.');
        if (
          prior.fact.kind !== data.fact.kind ||
          (prior.fact.runtimeOriginRef !== null &&
            data.fact.runtimeOriginRef !== null &&
            prior.fact.runtimeOriginRef !== data.fact.runtimeOriginRef)
        )
          throw new Error('Native source association conflicts with existing evidence.');
        for (const key of [
          'harness',
          'authoredVersion',
          'measuredVersion',
          'format',
          'preLaunchWatermark',
          'logSource',
        ] as const) {
          const value = prior.fact.native?.[key];
          if (value != null && native[key] != null && value !== native[key])
            throw new Error('Native source identity conflicts with existing evidence.');
        }
      }
      if (prior.fact.kind !== 'runtime-log' || prior.content.state !== 'expected') continue;
      firstLogPackage ??= packageId;
      if (row.id !== id) {
        if (used > Number.MAX_SAFE_INTEGER - prior.content.bytes)
          throw new Error('recovery_required: native log byte count is invalid');
        used += prior.content.bytes;
      }
    }
    if (data.content.state !== 'expected') return;
    const selected = NativeLogMaxBytesSchema.safeParse(
      current.observability.evidence?.nativeLogMaxBytes
    );
    if (!selected.success)
      throw new Error('Native content requires an immutable selected AEP log bound.');
    if (current.observability.captureCoverage.value !== 'on')
      throw new Error('Native content is not admitted by its named AEP.');
    if (data.fact.kind !== 'runtime-log') return;
    if (firstLogPackage && firstLogPackage !== lineage.packageSnapshotId) {
      const original = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        lineage.workspaceId,
        firstLogPackage
      ).snapshot;
      const originalBound = NativeLogMaxBytesSchema.safeParse(
        original.observability.evidence?.nativeLogMaxBytes
      );
      if (
        original.scope.threadId !== lineage.threadId ||
        original.scope.turnId !== lineage.turnId ||
        !originalBound.success ||
        originalBound.data !== selected.data
      )
        throw new Error('A different package cannot renew the native Turn log bound.');
    }
    // Expected units already own potential bytes, even before complete publication or after loss.
    if (used > selected.data || data.content.bytes > selected.data - used)
      throw new Error('Native Turn log collection bound exceeded.');
  };
  try {
    applyScopedMigrations(workspaceDb);
    const binding = readWorkObservationTurnBinding(workspaceDb, owner);
    if (!binding.coverage)
      throw new Error('recovery_required: observation capture binding is missing');
    if (binding.turn.agentSessionId !== lineage.agentSessionId)
      throw new Error('recovery_required: observation AgentSession mismatch');
    if (event.event.type === 'observation.recorded') {
      const data = event.event.data;
      admitNative(data);
      if (data.content.state === 'expected' && binding.coverage.value !== 'on')
        throw new Error('Observation content is not admitted by this Turn');
      let parent: string | undefined;
      if (data.content.state === 'unavailable' && data.content.expectedObservationId) {
        parent = workerObservationRecordId(
          lineage.packageSnapshotId,
          data.content.expectedObservationId
        );
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
        obs: 'worker-shim',
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
      await appendWorkObservation(workspaceDb, {
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
    admitNative(declaration);
    if (declaration.content.state !== 'expected')
      throw new Error('Observation has no expected content');
    const expected = declaration.content;
    const chunk = event.event.data;
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.toString('base64') !== chunk.data)
      throw new Error('Observation chunk encoding is not canonical');
    const resume = await getControlStoreWorkerClient().pauseForDataRootBackup(
      `workspace:${workspaceDb.sqlite.name}`
    );
    let staged: ReturnType<typeof stageWorkObservationChunk>;
    try {
      staged = stageWorkObservationChunk(workspaceDb, {
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
    } finally {
      resume();
    }

    if (staged.state === 'expired' && !replay)
      throw new Error('Expired observation evidence cannot accept new content');
    if (staged.state === 'complete') {
      const { v: _v, seq: _seq, turnId: _turnId, ...observation } = initial;
      await appendWorkObservation(workspaceDb, {
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
      SELECT schema_version AS schemaVersion, record_json AS recordJson
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
    ) as Array<{ readonly schemaVersion: unknown; readonly recordJson: string }>;

  return rows.flatMap((row) => {
    const value = readRetainedV1(row, () => JSON.parse(row.recordJson)) as {
      event?: { type?: string };
    };
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
      `SELECT schema_version AS schemaVersion, record_json AS recordJson, accepted_at AS acceptedAt
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
    ) as
    | { readonly schemaVersion: unknown; readonly acceptedAt: string; readonly recordJson: string }
    | undefined;
  if (!row) {
    return null;
  }
  const raw = readRetainedV1(row, () => JSON.parse(row.recordJson)) as Record<string, unknown>;
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
      ['turn-cancelled', 'raw-output-exhausted', 'raw-output-unavailable'].includes(
        lease.terminalCause ?? ''
      ) &&
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
 * Checks current cancellation and native authority for a first final without restoring effect authority.
 *
 * @param attempt Exact native attempt whose token and lineage are checked by the caller.
 * @param timestamp Current time for the unchanged submission and native liveness deadlines.
 * @returns Whether the cancellation-owned first-final opportunity remains available.
 */
export function hasPendingWorkerCancellationFinal(
  attempt: NanoHostExecutionAttemptRecord,
  timestamp: string
): boolean {
  const workerDeadline = attempt.lastAcceptedHeartbeatAt
    ? attempt.heartbeatDeadline
    : attempt.startupDeadline;
  const now = Date.parse(timestamp);
  return (
    attempt.phase === 'closing' &&
    ['turn-cancelled', 'raw-output-exhausted', 'raw-output-unavailable'].includes(
      attempt.terminalCause ?? ''
    ) &&
    attempt.recoveryState === null &&
    attempt.fenceRef === null &&
    Boolean(attempt.workerControlTokenHash) &&
    Date.parse(attempt.deadline ?? '') > now &&
    Date.parse(workerDeadline) > now
  );
}

/**
 * Resolves live or cancellation-only first terminal evidence, or exact replay during release grace.
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
      `SELECT attempt_id AS attemptId, deadline AS expiresAt,
              EXISTS (
                SELECT 1 FROM worker_control_records
                 WHERE worker_control_records.workspace_id = scheduler_execution_attempts.workspace_id
                   AND worker_control_records.thread_id = scheduler_execution_attempts.thread_id
                   AND worker_control_records.turn_id = scheduler_execution_attempts.turn_id
                   AND worker_control_records.agent_session_id = scheduler_execution_attempts.agent_session_id
                   AND worker_control_records.package_snapshot_id = scheduler_execution_attempts.input_ref
                   AND worker_control_records.request_id IS ?
                   AND worker_control_records.operation = 'final_status'
              ) AS finalStatusRecorded,
              (
                SELECT schema_version FROM worker_control_records
                 WHERE worker_control_records.workspace_id = scheduler_execution_attempts.workspace_id
                   AND worker_control_records.thread_id = scheduler_execution_attempts.thread_id
                   AND worker_control_records.turn_id = scheduler_execution_attempts.turn_id
                   AND worker_control_records.agent_session_id = scheduler_execution_attempts.agent_session_id
                   AND worker_control_records.package_snapshot_id = scheduler_execution_attempts.input_ref
                   AND worker_control_records.request_id IS ?
                   AND worker_control_records.operation = 'final_status'
                 LIMIT 1
              ) AS finalStatusSchemaVersion
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
        finalStatusRecorded: number;
        finalStatusSchemaVersion: unknown;
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

  if (row.finalStatusRecorded)
    return readRetainedV1(
      { schemaVersion: row.finalStatusSchemaVersion },
      () => ({ replayOnly: true, status: 'accepted' }) as const
    );
  // The live resolver authenticated the token and binding before refusing effects; the first-final exception still requires current native authority.
  if (
    hasPendingWorkerCancellationFinal(
      requireNanoHostExecutionAttempt(coreDb, row.attemptId),
      timestamp
    )
  )
    return { cancellationOnly: true, replayOnly: false, status: 'accepted' };
  return live;
}
