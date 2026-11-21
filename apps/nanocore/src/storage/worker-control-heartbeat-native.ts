import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonText } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import {
  acceptNanoHostAttemptHeartbeatByBinding,
  adoptNanoHostAttemptReconnectHash,
  NanoHostAttemptHeartbeatRejectedError,
  resolveNanoHostAttemptTokenBinding,
} from '../runtime/nanohost-attempt-records.js';
import { acceptWorkerControlSequence } from '../runtime/worker-control-sequences.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  type ControlWorkerHeartbeatCommand,
  type ControlWorkerHeartbeatInput,
  ControlWorkerHeartbeatPayloadSchema,
  type ControlWorkerHeartbeatResult,
  WorkerHeartbeatRefusal,
} from './worker-control-heartbeat-codecs.js';

/** Repeats the original binding refusal inside the current Core deciding section. */
function refuseBinding(
  reason: 'binding-not-found' | 'lineage-mismatch' | 'attempt-not-live' | 'reconnect-required'
): never {
  if (reason === 'binding-not-found')
    throw new WorkerHeartbeatRefusal(
      'worker_control_unauthorized',
      'Worker control request is missing a valid sandbox token.',
      401
    );
  if (reason === 'lineage-mismatch')
    throw new WorkerHeartbeatRefusal(
      'worker_control_lineage_mismatch',
      'Worker control request lineage does not match the durable lease binding.',
      403
    );
  if (reason === 'reconnect-required')
    throw new WorkerHeartbeatRefusal(
      'worker_control_reconnect_required',
      'Worker control session must reconnect after NanoCore restart.',
      503
    );
  throw new WorkerHeartbeatRefusal(
    'worker_control_lease_not_live',
    'Worker control request lease is not live.',
    403
  );
}

/** Applies reconnect adoption, the original fingerprint and attempt liveness in one existing savepoint. */
export function applyControlWorkerHeartbeat(
  db: CoreDb,
  input: ControlWorkerHeartbeatInput,
  content?: ArrayBuffer
): ControlWorkerHeartbeatResult {
  assertControlProductWriter(db.sqlite);
  if (!content) throw new ControlProductPreconditionError();
  const payload = ControlWorkerHeartbeatPayloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  );
  if (!isDeepStrictEqual(payload.request.lineage, input.lineage))
    throw new ControlProductPreconditionError();
  const acceptedAt = payload.acceptedAt ?? new Date().toISOString();
  assertWorkerControlHash(db, input);
  const fingerprint = canonicalJsonText(payload.request);
  try {
    if (payload.reconnectProcessKeyHash)
      adoptNanoHostAttemptReconnectHash(db, {
        acceptedAt,
        lineage: input.lineage,
        sandboxBindingRef: input.sandboxBindingRef,
        workerSequence: payload.request.sequence,
        processKeyHash: payload.reconnectProcessKeyHash,
        heartbeatFingerprint: fingerprint,
      });
    const resolution = resolveNanoHostAttemptTokenBinding(db, {
      lineage: input.lineage,
      sandboxBindingRef: input.sandboxBindingRef,
      now: () => acceptedAt,
    });
    if (resolution.status === 'rejected') refuseBinding(resolution.reason);
    return settleNanoHostWorkerHeartbeat(
      db.sqlite,
      { lineage: input.lineage, payload },
      acceptedAt,
      () =>
        acceptNanoHostAttemptHeartbeatByBinding(db, {
          acceptedAt,
          lineage: input.lineage,
          sandboxBindingRef: input.sandboxBindingRef,
          workerSequence: payload.request.sequence,
          ...(payload.request.body.processKeyHash
            ? { workerProcessKeyHash: payload.request.body.processKeyHash }
            : {}),
        })
    );
  } catch (error) {
    if (!(error instanceof NanoHostAttemptHeartbeatRejectedError)) throw error;
    if (error.reason === 'heartbeat-already-accepted')
      throw new WorkerHeartbeatRefusal(
        'worker_control_heartbeat_already_accepted',
        error.message,
        409
      );
    if (error.reason === 'sequence-stale')
      throw new WorkerHeartbeatRefusal(
        'worker_control_sequence_stale',
        'Worker control heartbeat sequence is stale.',
        409
      );
    if (error.reason === 'attempt-changed')
      throw new WorkerHeartbeatRefusal(
        'worker_control_identity_conflict',
        'Worker control heartbeat identity conflicts with the durable lease binding.',
        409
      );
    if (error.reason === 'reconnect-required') refuseBinding('reconnect-required');
    refuseBinding('attempt-not-live');
  }
}

/** Commits the admitted Native heartbeat fingerprint and liveness CAS in one writer savepoint. */
function settleNanoHostWorkerHeartbeat(
  sqlite: Database.Database,
  input: Pick<ControlWorkerHeartbeatCommand, 'lineage' | 'payload'>,
  acceptedAt: string,
  applyLiveness: () => void
): ControlWorkerHeartbeatResult {
  assertControlProductWriter(sqlite);
  const { request } = input.payload;
  if (!isDeepStrictEqual(request.lineage, input.lineage))
    throw new ControlProductPreconditionError();
  const sequence = acceptWorkerControlSequence(
    { sqlite },
    {
      lineage: input.lineage,
      operation: 'heartbeat',
      sequence: request.sequence,
      fingerprint: canonicalJsonText(request),
    }
  );
  if (sequence.status !== 'accepted')
    throw new WorkerHeartbeatRefusal(sequence.code, sequence.message, 409);
  if (!sequence.duplicate) applyLiveness();
  return {
    duplicate: sequence.duplicate,
    nextExpectedSequence: sequence.nextExpectedSequence,
    acceptedAt,
  };
}

/** Requires the current exact route-token family hashes on the deciding Core connection. */
function assertWorkerControlHash(db: CoreDb, input: ControlWorkerHeartbeatInput): void {
  // Credential proof remains valid only against the current exact attempt, not Main's earlier view.
  const hashes = db.sqlite
    .prepare(`SELECT worker_control_token_hash AS control, worker_inference_token_hash AS inference,
    worker_capability_token_hash AS capability FROM scheduler_execution_attempts WHERE binding_ref = ?`)
    .get(input.sandboxBindingRef) as
    | { control: string | null; inference: string | null; capability: string | null }
    | undefined;
  if (
    !hashes?.control ||
    !hashes.inference ||
    !hashes.capability ||
    !/^[0-9a-f]{64}$/.test(hashes.control) ||
    !timingSafeEqual(Buffer.from(input.tokenHash), Buffer.from(hashes.control))
  )
    refuseBinding('binding-not-found');
}

/** Revalidates live authority after FIFO wait for a nonterminal publication stage. */
export function requireWorkerControlBinding(
  db: CoreDb,
  input: ControlWorkerHeartbeatInput,
  acceptedAt: string
): void {
  assertWorkerControlHash(db, input);
  const resolution = resolveNanoHostAttemptTokenBinding(db, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    now: () => acceptedAt,
  });
  if (resolution.status === 'rejected') refuseBinding(resolution.reason);
}
