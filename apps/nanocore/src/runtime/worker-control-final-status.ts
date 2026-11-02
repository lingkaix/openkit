import { readRetainedV1 } from '@openkit/protocol';
import { WorkerControlGatewayError } from '../operation-error.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlWorkerFinalStatusCommand } from '../storage/worker-control-final-status-codecs.js';
import type { ControlWorkerHeartbeatCommand } from '../storage/worker-control-heartbeat-codecs.js';
import type {
  ControlWorkerOperationCommand,
  ControlWorkerOperationResult,
} from '../storage/worker-control-record-codecs.js';
import {
  ControlWorkerArtifactNoticeReaderSchema,
  ControlWorkerSupplyAckReaderSchema,
} from '../storage/worker-control-record-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

/** Publishes only the original complete Core final tuple after Main's read-only raw-output check. */
export async function publishWorkerControlFinalStatus(
  db: CoreDb,
  input: ControlWorkerFinalStatusCommand
) {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  try {
    return await client.workerControlFinalStatus(database, snapshot);
  } catch (error) {
    if (
      error instanceof ControlStoreWorkerError &&
      error.domain?.operation === 'worker-control-final-status'
    )
      throw new WorkerControlGatewayError(
        error.domain.code,
        error.domain.message,
        error.domain.status
      );
    throw error;
  }
}

/** Publishes the original complete heartbeat tuple; no raw route token or process key leaves Main. */
export async function publishWorkerControlHeartbeat(
  db: CoreDb,
  input: ControlWorkerHeartbeatCommand
) {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  try {
    return await client.workerControlHeartbeat(database, snapshot);
  } catch (error) {
    if (
      error instanceof ControlStoreWorkerError &&
      error.domain?.operation === 'worker-control-heartbeat'
    )
      throw new WorkerControlGatewayError(
        error.domain.code,
        error.domain.message,
        error.domain.status
      );
    throw error;
  }
}

/** Preserves the original independent sequence and receipt commits with current authority at each stage. */
export async function publishWorkerControlOperation(
  db: CoreDb,
  input: ControlWorkerOperationCommand
): Promise<ControlWorkerOperationResult> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const { payload, fingerprint, ...coordinates } = snapshot;
  try {
    const result = await client.workerControlRecord(database, {
      ...coordinates,
      payload: {
        kind: 'sequence',
        operation: payload.operation,
        sequence: payload.sequence,
        fingerprint,
      },
    });
    if (result.kind !== 'sequence')
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    if (!result.duplicate || payload.operation === 'event_append')
      await client.workerControlRecord(database, { ...coordinates, payload });
    // A duplicate after lost ACK must read the original descriptive receipt, never fabricate its timestamp.
    let record: ControlWorkerOperationCommand['payload']['record'] | undefined;
    if (
      result.duplicate &&
      (payload.operation === 'artifact_notice' || payload.operation === 'supply_refresh_ack')
    ) {
      const row = db.sqlite
        .prepare(`SELECT schema_version AS schemaVersion, record_json AS recordJson FROM worker_control_records
        WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = ? AND record_key = ?`)
        .get(
          coordinates.lineage.agentSessionId,
          coordinates.lineage.packageSnapshotId,
          payload.operation,
          payload.recordKey
        ) as { schemaVersion: unknown; recordJson: string } | undefined;
      if (row)
        record = readRetainedV1(row, () => {
          const value: unknown = JSON.parse(row.recordJson);
          return payload.operation === 'artifact_notice'
            ? ControlWorkerArtifactNoticeReaderSchema.parse(value)
            : ControlWorkerSupplyAckReaderSchema.parse(value);
        });
    }
    return {
      duplicate: result.duplicate,
      nextExpectedSequence: result.nextExpectedSequence,
      ...(record ? { record } : {}),
    };
  } catch (error) {
    if (
      error instanceof ControlStoreWorkerError &&
      error.domain?.operation === 'worker-control-record'
    )
      throw new WorkerControlGatewayError(
        error.domain.code,
        error.domain.message,
        error.domain.status
      );
    throw error;
  }
}
