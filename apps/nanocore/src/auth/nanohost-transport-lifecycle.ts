/** Composes original native credential tuples with separately owned file/process/readiness effects. */
import { recordNanoHostRuntimeTargetConnectionClose } from '../runtime/nanohost-runtime-target.js';
import type { CoreDb } from '../storage/db.js';
import { requireNanoHostObservation } from '../storage/nanohost-observation.js';
import {
  type AdmittedNanoHostTransportStorage,
  transitionAdmittedNanoHostRuntimeTarget,
} from '../storage/nanohost-transport-owner.js';
import type { Actor } from './identity.js';
import type { NanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  clearNanoHostCredentialSlot,
  type NanoHostCredentialSinkPaths,
  readNanoHostCredentialSlotTokenId,
} from './nanohost-transport-sink.js';
import { evaluateNanoHostTransportTokenUsability } from './nanohost-transport-token.js';
import {
  getNanoHostTransportTokenRecord,
  type NanoHostTransportTokenRecord,
  nanoHostTransportCommitState,
  type PreparedNanoHostTransportWriter,
  prepareNanoHostTransportWriter,
  recordNanoHostTransportAudit,
  submitNanoHostTransportRotationAbort,
} from './nanohost-transport-token-store.js';

/** Input for aborting an in-flight rotation. */
export interface AbortNanoHostTransportRotationInput {
  /** Predecessor Token id to keep usable. */
  readonly predecessorTokenId: string;
  /** Successor Token id to revoke. */
  readonly successorTokenId: string;
  /** Declared successor slot paths to clear. */
  readonly successorSink: NanoHostCredentialSinkPaths;
  /** Existing responsible request actor for the approved failed-abort Audit; never an authorization bypass. */
  readonly auditActorUserId?: string;
  /** Admitted deciding Token and Audit stages for the public administrator operation. */
  readonly administratorTransport?: PreparedNanoHostTransportWriter;
  /** Optional abort clock. */
  readonly now?: Date;
}

/** Result of an aborted rotation. */
export interface AbortNanoHostTransportRotationResult {
  /** Restored predecessor Token record. */
  readonly predecessor: NanoHostTransportTokenRecord;
  /** Revoked successor Token record. */
  readonly successor: NanoHostTransportTokenRecord;
}

/** Input for fencing when a known Token is no longer usable. */
export interface FenceNanoHostTransportOnTokenUnusableInput {
  /** Configured NanoHost identity id whose live session may need fencing. */
  readonly identityId: string;
  /** Durable Token id to evaluate. */
  readonly tokenId: string;
  /** Evaluation clock. */
  readonly now?: Date;
}

/** Result of an expiry/unusable fencing check. */
export interface FenceNanoHostTransportOnTokenUnusableResult {
  /** Whether the Token remains usable for authentication. */
  readonly usable: boolean;
  /** Whether an authoritative session was fenced by this call. */
  readonly fenced: boolean;
}

type NanoHostFencingStorage = CoreDb | AdmittedNanoHostTransportStorage;

function readFencingStorage<Value>(
  storage: NanoHostFencingStorage,
  read: (owner: { readonly sqlite: CoreDb['sqlite'] }) => Value
): Value {
  if (!('owner' in storage))
    return requireNanoHostObservation(storage, (sqlite) => read({ sqlite }));
  const result = storage.owner.read((sqlite) => read({ sqlite }));
  if (result.state !== 'ready') throw new Error('NanoHost transport storage is unavailable.');
  return result.value;
}

/** Fences process authority before attempting the exact durable readiness close. */
export async function fenceNanoHostTransportAuthority(
  storage: NanoHostFencingStorage,
  authority: NanoHostTransportSessionAuthority,
  identityId: string,
  observedAt: string
): Promise<void> {
  // Process authority must stop even when reading or updating its durable readiness witness fails.
  authority.fenceAuthoritative(identityId);
  const target = readFencingStorage(
    storage,
    ({ sqlite }) =>
      sqlite
        .prepare(
          `SELECT target_id AS targetId, connection_generation AS connectionGeneration
         FROM nanohost_runtime_targets WHERE identity_id = ?`
        )
        .get(identityId) as
        | { readonly connectionGeneration: number; readonly targetId: string }
        | undefined
  );
  if (!target) return;
  const close = {
    authoritativeGeneration: null,
    closedGeneration: target.connectionGeneration,
    observedAt,
    targetId: target.targetId,
  };
  if ('owner' in storage) {
    const outcome = await transitionAdmittedNanoHostRuntimeTarget(storage, {
      kind: 'close',
      ...close,
    });
    if (outcome.state !== 'ready') throw new Error('NanoHost transport storage is unavailable.');
  } else {
    await recordNanoHostRuntimeTargetConnectionClose(storage, close);
  }
}

/** Evaluates the existing retained Token at the same owner as its readiness record. */
export async function fenceNanoHostTransportOnTokenUnusable(
  storage: NanoHostFencingStorage,
  authority: NanoHostTransportSessionAuthority,
  input: FenceNanoHostTransportOnTokenUnusableInput
): Promise<FenceNanoHostTransportOnTokenUnusableResult> {
  const record = readFencingStorage(storage, (owner) =>
    getNanoHostTransportTokenRecord(owner, input.tokenId)
  );
  if (record && evaluateNanoHostTransportTokenUsability(record, input.now).usable) {
    return { usable: true, fenced: false };
  }
  const hadAuthority = authority.authoritativeGeneration(input.identityId) !== null;
  await fenceNanoHostTransportAuthority(
    storage,
    authority,
    input.identityId,
    (input.now ?? new Date()).toISOString()
  );
  return { usable: false, fenced: !record || hadAuthority };
}

/** Awaits the abort tuple before slot clear/discard; unknown submission never authorizes file deletion. */
export async function abortNanoHostTransportRotation(
  storage: NanoHostFencingStorage,
  authority: NanoHostTransportSessionAuthority,
  input: AbortNanoHostTransportRotationInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<AbortNanoHostTransportRotationResult> {
  const snapshot = {
    ...input,
    successorSink: { ...input.successorSink },
    ...(input.now ? { now: new Date(input.now.getTime()) } : {}),
  };
  const admin = actor ? { ...actor } : undefined;
  const predecessor = readFencingStorage(storage, (owner) =>
    getNanoHostTransportTokenRecord(owner, snapshot.predecessorTokenId)
  );
  const writer =
    admin && snapshot.administratorTransport
      ? snapshot.administratorTransport
      : await prepareNanoHostTransportWriter(storage);
  await beforeSubmit?.();
  let aborted: AbortNanoHostTransportRotationResult | null;
  try {
    aborted = await submitNanoHostTransportRotationAbort(
      writer,
      {
        predecessorTokenId: snapshot.predecessorTokenId,
        successorTokenId: snapshot.successorTokenId,
        ...(snapshot.now ? { now: snapshot.now } : {}),
      },
      admin
    );
  } catch (error) {
    if (nanoHostTransportCommitState(error) === 'unknown' && predecessor)
      authority.discardPendingSuccessor(predecessor.ownerNanoHostIdentityId);
    throw error;
  }
  if (!aborted)
    throw new Error('NanoHost transport rotation abort requires known predecessor and successor.');
  let cleanupFailure: unknown;
  try {
    const currentSlot = readNanoHostCredentialSlotTokenId(snapshot.successorSink);
    if (currentSlot !== null && currentSlot !== aborted.successor.tokenId)
      throw new Error('NanoHost successor slot changed before rotation cleanup.');
    clearNanoHostCredentialSlot(snapshot.successorSink);
    authority.discardPendingSuccessor(aborted.predecessor.ownerNanoHostIdentityId);
  } catch (error) {
    cleanupFailure = error;
  }
  // Terminal revocation is not undone by abort; report the proved pair after attempting mandatory cleanup.
  if (aborted.predecessor.status !== 'active') {
    try {
      const audit = snapshot.administratorTransport ?? ('owner' in storage ? undefined : storage);
      if (!audit) throw new Error('NanoHost administrator Audit is unavailable.');
      await recordNanoHostTransportAudit(audit, {
        kind: 'lifecycle-audit',
        action: 'nanohost.transport.rotate',
        record: aborted.successor,
        predecessor: aborted.predecessor,
        actorUserId:
          snapshot.auditActorUserId ??
          admin?.userId ??
          aborted.successor.responsibleServerAdminActorId,
      });
    } catch (error) {
      if (cleanupFailure === undefined) throw error;
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return aborted;
}
