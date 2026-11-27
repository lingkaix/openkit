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
import {
  acceptWorkerControlSequence,
  matchesAcceptedWorkerControlSequence,
} from '../runtime/worker-control-sequences.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import { recordNanoHostRecoveryHeartbeat } from './nanohost-recovery-native.js';
import type { NanoHostWorkerCoordinates } from './nanohost-submitted-lease.js';
import {
  inspectNanoHostWorkerBinding,
  matchesNanoHostWorkerLineage,
  nanoHostWorkerBindingLiveness,
  readOriginalNanoHostWorkerCoordinates,
} from './nanohost-worker-binding.js';
import {
  type ControlWorkerHeartbeatCommand,
  type ControlWorkerHeartbeatInput,
  ControlWorkerHeartbeatPayloadSchema,
  type ControlWorkerHeartbeatResult,
  WorkerHeartbeatRefusal,
} from './worker-control-heartbeat-codecs.js';

/** Accepts an original heartbeat and advances liveness only on a newly retained sequence. */
function applyAdmittedNanoHostWorkerHeartbeat(
  sqlite: Database.Database,
  original: NanoHostWorkerCoordinates,
  input: ControlWorkerHeartbeatCommand
): ControlWorkerHeartbeatResult {
  if (typeof input.tokenHash !== 'string') refuseBinding('binding-not-found');
  const payload = ControlWorkerHeartbeatPayloadSchema.parse(input.payload);
  const acceptedAt = payload.acceptedAt ?? new Date().toISOString();
  const native = inspectNanoHostWorkerBinding(sqlite, original, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    tokenHash: input.tokenHash,
    tokenFamily: 'worker-control',
  });
  if (native.status === 'rejected') refuseBinding(native.reason);
  const live = nanoHostWorkerBindingLiveness(native, acceptedAt);
  const reconnect = live.status === 'rejected' && live.reason === 'reconnect-required';
  if (live.status === 'rejected' && !(reconnect && payload.reconnectProcessKeyHash))
    refuseBinding(live.reason);
  if (reconnect && payload.request.sequence === native.proof.lastWorkerSequence)
    refuseReconnectReadback(sqlite, input, payload, native.proof.workerProcessKeyHash);
  if (reconnect && payload.request.sequence !== native.proof.lastWorkerSequence! + 1)
    throw new WorkerHeartbeatRefusal(
      'worker_control_sequence_stale',
      'Worker reconnect must use the exact next heartbeat sequence.',
      409
    );
  // Roll back the fingerprint too if the Native liveness CAS refuses the new observation.
  return sqlite.transaction(() =>
    settleNanoHostWorkerHeartbeat(sqlite, { lineage: input.lineage, payload }, acceptedAt, () =>
      recordNanoHostRecoveryHeartbeat(sqlite, original.lease, {
        acceptedAt,
        sequence: payload.request.sequence,
        ...(payload.request.body.processKeyHash !== undefined
          ? { processKeyHash: payload.request.body.processKeyHash }
          : {}),
        ...(payload.reconnectProcessKeyHash !== undefined
          ? { reconnectProcessKeyHash: payload.reconnectProcessKeyHash }
          : {}),
      })
    )
  )();
}

/**
 * A Worker whose last committed heartbeat lost its ACK retries that exact sequence after restart.
 * Only the retained process key learns the outcome: an exact retained fingerprint is already
 * accepted, and any other body at that sequence is stale. This commits nothing.
 */
function refuseReconnectReadback(
  sqlite: Database.Database,
  input: Pick<ControlWorkerHeartbeatCommand, 'lineage'>,
  payload: ReturnType<typeof ControlWorkerHeartbeatPayloadSchema.parse>,
  retainedProcessKeyHash: string | null
): never {
  const presented = Buffer.from(payload.reconnectProcessKeyHash ?? '');
  const retained = Buffer.from(retainedProcessKeyHash ?? '');
  if (presented.length !== retained.length || !timingSafeEqual(presented, retained))
    throw new WorkerHeartbeatRefusal(
      'worker_control_identity_conflict',
      'Worker control heartbeat identity conflicts with the durable lease binding.',
      409
    );
  if (
    matchesAcceptedWorkerControlSequence(
      { sqlite },
      {
        lineage: input.lineage,
        operation: 'heartbeat',
        sequence: payload.request.sequence,
        fingerprint: canonicalJsonText(payload.request),
      }
    ) === true
  )
    throw new WorkerHeartbeatRefusal(
      'worker_control_heartbeat_already_accepted',
      'Worker reconnect heartbeat was already accepted.',
      409
    );
  throw new WorkerHeartbeatRefusal(
    'worker_control_sequence_stale',
    'Worker reconnect must use the exact next heartbeat sequence.',
    409
  );
}

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

function requireOriginalWorkerControlCoordinates(
  db: CoreDb,
  sqlite: Database.Database,
  input: Pick<ControlWorkerHeartbeatInput, 'lineage' | 'sandboxBindingRef' | 'tokenHash'>
): NanoHostWorkerCoordinates {
  if (typeof input.tokenHash !== 'string') refuseBinding('binding-not-found');
  const original = readOriginalNanoHostWorkerCoordinates(db, sqlite, input);
  if (!original) refuseBinding('binding-not-found');
  return original;
}

/** Applies reconnect adoption, the original fingerprint and attempt liveness in one existing savepoint. */
export function applyControlWorkerHeartbeat(
  ...args:
    | [db: CoreDb, input: ControlWorkerHeartbeatInput, content?: ArrayBuffer | undefined]
    | [
        admitted: {
          readonly sqlite: Database.Database;
          readonly original: NanoHostWorkerCoordinates;
          readonly input: ControlWorkerHeartbeatCommand;
        },
      ]
    | [
        admitted: {
          readonly sqlite: Database.Database;
          readonly coreDb: CoreDb;
          readonly input: ControlWorkerHeartbeatCommand;
        },
      ]
): ControlWorkerHeartbeatResult {
  if (args.length === 1) {
    const admission = args[0];
    const { sqlite, input } = admission;
    assertControlProductWriter(sqlite);
    const original =
      'coreDb' in admission
        ? requireOriginalWorkerControlCoordinates(admission.coreDb, sqlite, input)
        : admission.original;
    return applyAdmittedNanoHostWorkerHeartbeat(sqlite, original, input);
  }
  const [db, input, content] = args;
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
function assertWorkerControlHash(
  db: CoreDb,
  input: Pick<ControlWorkerHeartbeatInput, 'sandboxBindingRef' | 'tokenHash'>
): void {
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

/** Revalidates the original live worker-control authority for every nonterminal stage. */
export function requireWorkerControlBinding(
  db: CoreDb,
  input: Pick<ControlWorkerHeartbeatInput, 'lineage' | 'sandboxBindingRef' | 'tokenHash'>,
  observedAt: string,
  admitted?: {
    readonly sqlite: Database.Database;
    readonly recordLineage?: ControlWorkerHeartbeatInput['lineage'];
  }
): void {
  if (admitted) {
    const { sqlite, recordLineage } = admitted;
    const original = requireOriginalWorkerControlCoordinates(db, sqlite, input);
    const native = inspectNanoHostWorkerBinding(sqlite, original, {
      ...input,
      tokenFamily: 'worker-control',
    });
    if (native.status === 'rejected') refuseBinding(native.reason);
    if (recordLineage && !matchesNanoHostWorkerLineage(original, recordLineage))
      refuseBinding('lineage-mismatch');
    const live = nanoHostWorkerBindingLiveness(native, observedAt);
    if (live.status === 'rejected') refuseBinding(live.reason);
    return;
  }
  assertWorkerControlHash(db, input);
  const resolution = resolveNanoHostAttemptTokenBinding(db, {
    lineage: input.lineage,
    sandboxBindingRef: input.sandboxBindingRef,
    now: () => observedAt,
  });
  if (resolution.status === 'rejected') refuseBinding(resolution.reason);
}
