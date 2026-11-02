/** Composes original native credential tuples with separately owned file/process/readiness effects. */
import { recordNanoHostRuntimeTargetConnectionClose } from '../runtime/nanohost-runtime-target.js';
import type { CoreDb } from '../storage/db.js';
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
  prepareNanoHostTransportWriter,
  recordNanoHostTransportAudit,
  submitNanoHostTransportDecommission,
  submitNanoHostTransportRevocation,
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

/** Input for revoking one Token and fencing live authoritative work. */
export interface RevokeNanoHostTransportTokenAndFenceInput {
  /** Durable Token id to revoke. */
  readonly tokenId: string;
  /** Optional revocation clock. */
  readonly now?: Date;
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

/** Input for decommissioning one NanoHost identity's transport Tokens. */
export interface DecommissionNanoHostTransportAndFenceInput {
  /** Configured NanoHost identity id. */
  readonly identityId: string;
  /** Exact deployment bound to the configured NanoHost identity. */
  readonly deploymentId: string;
  /** Optional decommission clock. */
  readonly now?: Date;
}

/** Fences process authority before attempting the existing durable readiness close. */
export async function fenceNanoHostTransportAuthority(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  identityId: string,
  observedAt: string
): Promise<void> {
  // Process authority must stop even when reading or updating its durable readiness witness fails.
  authority.fenceAuthoritative(identityId);
  const target = coreDb.sqlite
    .prepare(
      `SELECT target_id AS targetId, connection_generation AS connectionGeneration
       FROM nanohost_runtime_targets WHERE identity_id = ?`
    )
    .get(identityId) as
    | { readonly connectionGeneration: number; readonly targetId: string }
    | undefined;
  if (!target) return;
  await recordNanoHostRuntimeTargetConnectionClose(coreDb, {
    authoritativeGeneration: null,
    closedGeneration: target.connectionGeneration,
    observedAt,
    targetId: target.targetId,
  });
}

/** Preserves the original uncertain write when the separately attempted readiness close also fails. */
async function fenceUncertainNanoHostCredential(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  identityId: string,
  observedAt: string
): Promise<void> {
  try {
    await fenceNanoHostTransportAuthority(coreDb, authority, identityId, observedAt);
  } catch {
    /* Process fencing ran first; secondary readiness refusal cannot prove this credential's rollback. */
  }
}

/** Evaluates the existing retained Token without introducing another writer or lifecycle. */
export async function fenceNanoHostTransportOnTokenUnusable(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: FenceNanoHostTransportOnTokenUnusableInput
): Promise<FenceNanoHostTransportOnTokenUnusableResult> {
  const record = getNanoHostTransportTokenRecord(coreDb, input.tokenId);
  if (!record) {
    await fenceNanoHostTransportAuthority(
      coreDb,
      authority,
      input.identityId,
      (input.now ?? new Date()).toISOString()
    );
    return { usable: false, fenced: true };
  }

  const usability = evaluateNanoHostTransportTokenUsability(
    {
      expiresAt: record.expiresAt,
      rotationOverlapExpiresAt: record.rotationOverlapExpiresAt,
      status: record.status,
    },
    input.now
  );

  if (usability.usable) {
    return { usable: true, fenced: false };
  }

  const hadAuthority = authority.authoritativeGeneration(input.identityId) !== null;
  await fenceNanoHostTransportAuthority(
    coreDb,
    authority,
    input.identityId,
    (input.now ?? new Date()).toISOString()
  );
  return { usable: false, fenced: hadAuthority };
}

/** Awaits the abort tuple before slot clear/discard; unknown submission never authorizes file deletion. */
export async function abortNanoHostTransportRotation(
  coreDb: CoreDb,
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
  const predecessor = getNanoHostTransportTokenRecord(coreDb, snapshot.predecessorTokenId);
  const writer = await prepareNanoHostTransportWriter(coreDb);
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
      await recordNanoHostTransportAudit(coreDb, {
        kind: 'lifecycle-audit',
        action: 'nanohost.transport.rotate',
        record: aborted.successor,
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

/** Awaits revocation before its original process fence and readiness stage. */
export async function revokeNanoHostTransportTokenAndFence(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: RevokeNanoHostTransportTokenAndFenceInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRecord | null> {
  const tokenId = input.tokenId;
  const now = input.now ? new Date(input.now.getTime()) : undefined;
  const admin = actor ? { ...actor } : undefined;
  const prior = getNanoHostTransportTokenRecord(coreDb, tokenId);
  const writer = await prepareNanoHostTransportWriter(coreDb);
  await beforeSubmit?.();
  let record: NanoHostTransportTokenRecord | null;
  try {
    record = await submitNanoHostTransportRevocation(writer, tokenId, now ? { now } : {}, admin);
  } catch (error) {
    if (nanoHostTransportCommitState(error) === 'unknown' && prior)
      await fenceUncertainNanoHostCredential(
        coreDb,
        authority,
        prior.ownerNanoHostIdentityId,
        (now ?? new Date()).toISOString()
      );
    throw error;
  }
  if (!record) return null;
  await fenceNanoHostTransportAuthority(
    coreDb,
    authority,
    record.ownerNanoHostIdentityId,
    (now ?? new Date()).toISOString()
  );
  return record;
}

/** Keeps all Token revocations and the exact active identity transition in one native SQL stage. */
export async function decommissionNanoHostTransportAndFence(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: DecommissionNanoHostTransportAndFenceInput,
  actor?: Actor,
  beforeSubmit?: () => Promise<void>
): Promise<NanoHostTransportTokenRecord[]> {
  const snapshot = { ...input, ...(input.now ? { now: new Date(input.now.getTime()) } : {}) };
  const admin = actor ? { ...actor } : undefined;
  const writer = await prepareNanoHostTransportWriter(coreDb);
  await beforeSubmit?.();
  let revoked: NanoHostTransportTokenRecord[];
  try {
    revoked = await submitNanoHostTransportDecommission(writer, snapshot, admin);
  } catch (error) {
    if (nanoHostTransportCommitState(error) === 'unknown')
      await fenceUncertainNanoHostCredential(
        coreDb,
        authority,
        snapshot.identityId,
        (snapshot.now ?? new Date()).toISOString()
      );
    throw error;
  }
  await fenceNanoHostTransportAuthority(
    coreDb,
    authority,
    snapshot.identityId,
    (snapshot.now ?? new Date()).toISOString()
  );
  return revoked;
}
