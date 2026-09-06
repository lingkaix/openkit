/**
 * NanoHost transport rotation cutover, abort, revoke/expiry fencing, and
 * decommission helpers.
 *
 * Composes the existing Token store, named-slot sink, and process-local session
 * authority. Does not invent a parallel credential framework or durable session
 * store. Live epoch/Session topology evidence remains WP-6.
 */

import type { CoreDb } from '../storage/db.js';
import type { NanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import {
  clearNanoHostCredentialSlot,
  type NanoHostCredentialSinkPaths,
} from './nanohost-transport-sink.js';
import { evaluateNanoHostTransportTokenUsability } from './nanohost-transport-token.js';
import {
  abortNanoHostTransportTokenRotation,
  decommissionNanoHostIntegrationIdentity,
  decommissionNanoHostTransportTokens,
  getNanoHostTransportTokenRecord,
  type NanoHostTransportTokenRecord,
  revokeNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Input for aborting an in-flight rotation. */
export interface AbortNanoHostTransportRotationInput {
  /** Predecessor Token id to keep usable. */
  readonly predecessorTokenId: string;
  /** Successor Token id to revoke. */
  readonly successorTokenId: string;
  /** Declared successor slot paths to clear. */
  readonly successorSink: NanoHostCredentialSinkPaths;
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

/**
 * Aborts rotation by revoking the successor, clearing its slot, and restoring
 * the predecessor as the sole usable authoritative credential.
 *
 * @param coreDb Open Core database handles.
 * @param authority Process-local NanoHost transport session authority.
 * @param input Predecessor/successor Token ids and successor sink.
 * @returns Updated predecessor and successor records.
 */
export function abortNanoHostTransportRotation(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: AbortNanoHostTransportRotationInput
): AbortNanoHostTransportRotationResult {
  const aborted = abortNanoHostTransportTokenRotation(coreDb, {
    predecessorTokenId: input.predecessorTokenId,
    successorTokenId: input.successorTokenId,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!aborted) {
    throw new Error('NanoHost transport rotation abort requires known predecessor and successor.');
  }

  clearNanoHostCredentialSlot(input.successorSink);
  authority.discardPendingSuccessor(aborted.predecessor.ownerNanoHostIdentityId);
  return aborted;
}

/**
 * Revokes one NanoHost transport Token and fences any live authoritative session.
 *
 * @param coreDb Open Core database handles.
 * @param authority Process-local NanoHost transport session authority.
 * @param input Token id and optional clock.
 * @returns Revoked Token record, or null when missing.
 */
export function revokeNanoHostTransportTokenAndFence(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: RevokeNanoHostTransportTokenAndFenceInput
): NanoHostTransportTokenRecord | null {
  const record = revokeNanoHostTransportTokenRecord(coreDb, input.tokenId, {
    ...(input.now ? { now: input.now } : {}),
  });
  if (!record) {
    return null;
  }
  authority.fenceAuthoritative(record.ownerNanoHostIdentityId);
  return record;
}

/**
 * Fences the live authoritative session when a known Token is no longer usable.
 *
 * Covers expiry and overlap-deadline failure without inventing cross-restart
 * durable session state: process-local authority is fenced; recovery requires
 * explicit re-issuance and re-admit.
 *
 * @param coreDb Open Core database handles.
 * @param authority Process-local NanoHost transport session authority.
 * @param input Identity, Token id, and evaluation clock.
 * @returns Usability and whether fencing occurred.
 */
export function fenceNanoHostTransportOnTokenUnusable(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: FenceNanoHostTransportOnTokenUnusableInput
): FenceNanoHostTransportOnTokenUnusableResult {
  const record = getNanoHostTransportTokenRecord(coreDb, input.tokenId);
  if (!record) {
    authority.fenceAuthoritative(input.identityId);
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
  authority.fenceAuthoritative(input.identityId);
  return { usable: false, fenced: hadAuthority };
}

/**
 * Revokes every Token for one NanoHost identity and fences live authoritative work.
 *
 * @param coreDb Open Core database handles.
 * @param authority Process-local NanoHost transport session authority.
 * @param input Identity and optional clock.
 * @returns Token records revoked by this call.
 */
export function decommissionNanoHostTransportAndFence(
  coreDb: CoreDb,
  authority: NanoHostTransportSessionAuthority,
  input: DecommissionNanoHostTransportAndFenceInput
): NanoHostTransportTokenRecord[] {
  const revoked = coreDb.sqlite.transaction(() => {
    const options = input.now ? { now: input.now } : {};
    const records = decommissionNanoHostTransportTokens(coreDb, input.identityId, options);
    decommissionNanoHostIntegrationIdentity(coreDb, input.identityId, input.deploymentId, options);
    return records;
  })();
  authority.fenceAuthoritative(input.identityId);
  return revoked;
}
