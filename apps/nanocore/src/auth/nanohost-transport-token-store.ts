import { generateUuidV7 } from '../runtime/session-id.js';
import type { CoreDb } from '../storage/db.js';
import {
  createOpenKitAccessTokenSecret,
  evaluateNanoHostTransportTokenUsability,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  NANOHOST_TRANSPORT_TOKEN_SCOPE,
  NANOHOST_TRANSPORT_TOKEN_TYPE,
  type NanoHostTransportTokenStatus,
  verifyOpenKitAccessTokenSecret,
} from './nanohost-transport-token.js';

/** Input for creating one durable NanoHost transport Token record. */
export interface CreateNanoHostTransportTokenRecordInput {
  /** Configured NanoHost IntegrationIdentity id that owns the token. */
  ownerNanoHostIdentityId: string;
  /** Declared deployment binding. */
  deploymentId: string;
  /** Server-admin actor that authorized issuance. */
  responsibleServerAdminActorId: string;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Current time. */
  now?: Date;
  /** Optional deterministic token id for tests. */
  tokenId?: string;
  /** Optional deterministic token secret for tests. */
  secret?: string;
  /** Previous token id when this token replaces an older token. */
  predecessorTokenId?: string | null;
}

/** Input for atomically persisting the configured identity and its delivered first Token. */
export interface EnrollNanoHostTransportIdentityInput
  extends CreateNanoHostTransportTokenRecordInput {
  /** Pre-generated token id whose secret was delivered to the configured sink. */
  tokenId: string;
  /** Pre-generated token secret whose configured sink write was proved. */
  secret: string;
}

/** Newly issued NanoHost transport Token. */
export interface NanoHostTransportTokenIssueResult {
  /** Durable token id. */
  tokenId: string;
  /** Plaintext token secret returned exactly once by the caller. */
  secret: string;
  /** Redacted durable record created for the token. */
  record: NanoHostTransportTokenRecord;
}

/** Input for rotating one durable NanoHost transport Token record. */
export interface RotateNanoHostTransportTokenRecordInput {
  /** Overlap window in seconds for the predecessor token. */
  overlapSeconds: number;
  /** Current time. */
  now?: Date;
}

/** Newly issued token plus the rotated predecessor record. */
export interface NanoHostTransportTokenRotationResult extends NanoHostTransportTokenIssueResult {
  /** Redacted predecessor record after rotation. */
  rotatedRecord: NanoHostTransportTokenRecord;
}

/** Redacted durable NanoHost transport Token record. */
export interface NanoHostTransportTokenRecord {
  /** Durable token id. */
  tokenId: string;
  /** Configured NanoHost IntegrationIdentity id that owns the token. */
  ownerNanoHostIdentityId: string;
  /** Closed token type. */
  tokenType: typeof NANOHOST_TRANSPORT_TOKEN_TYPE;
  /** Closed token scope. */
  scope: typeof NANOHOST_TRANSPORT_TOKEN_SCOPE;
  /** Declared deployment binding. */
  deploymentId: string;
  /** Token lifecycle status. */
  status: NanoHostTransportTokenStatus;
  /** Issue timestamp. */
  issuedAt: string;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Revocation timestamp. */
  revokedAt: string | null;
  /** Previous token id for rotated tokens. */
  predecessorTokenId: string | null;
  /** Rotation overlap expiry. */
  rotationOverlapExpiresAt: string | null;
  /** Server-admin actor that authorized issuance. */
  responsibleServerAdminActorId: string;
  /** Last successful use timestamp. */
  lastUsedAt: string | null;
  /** Last successful use channel. */
  lastUsedChannel: string | null;
  /** Last successful use source summary. */
  lastUsedSource: string | null;
}

/** Verified durable NanoHost transport Token record. */
export type VerifiedNanoHostTransportTokenRecord = NanoHostTransportTokenRecord;

interface NanoHostTransportTokenRow {
  token_id: string;
  token_hash: string;
  owner_nanohost_identity_id: string;
  token_type: typeof NANOHOST_TRANSPORT_TOKEN_TYPE;
  scope: typeof NANOHOST_TRANSPORT_TOKEN_SCOPE;
  deployment_id: string;
  status: NanoHostTransportTokenStatus;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  predecessor_token_id: string | null;
  rotation_overlap_expires_at: string | null;
  responsible_server_admin_actor_id: string;
  last_used_at: string | null;
  last_used_channel: string | null;
  last_used_source: string | null;
}

/**
 * Creates one durable NanoHost transport Token record in the server Core database.
 *
 * @param coreDb Open Core database handles.
 * @param input Token issue input.
 * @returns Token id and plaintext secret for one-time return.
 */
export function createNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  input: CreateNanoHostTransportTokenRecordInput
): NanoHostTransportTokenIssueResult {
  const tokenId = input.tokenId ?? generateUuidV7();
  const secret = input.secret ?? createOpenKitAccessTokenSecret();
  const now = (input.now ?? new Date()).toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_transport_tokens (
        token_id,
        token_hash,
        owner_nanohost_identity_id,
        token_type,
        scope,
        deployment_id,
        status,
        issued_at,
        expires_at,
        predecessor_token_id,
        responsible_server_admin_actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(
      tokenId,
      hashOpenKitAccessTokenSecret(secret),
      input.ownerNanoHostIdentityId,
      NANOHOST_TRANSPORT_TOKEN_TYPE,
      NANOHOST_TRANSPORT_TOKEN_SCOPE,
      input.deploymentId,
      now,
      input.expiresAt,
      input.predecessorTokenId ?? null,
      input.responsibleServerAdminActorId
    );

  const record = getNanoHostTransportTokenRecord(coreDb, tokenId);
  if (!record) {
    throw new Error(`NanoHost transport token record was not created: ${tokenId}`);
  }

  return { record, secret, tokenId };
}

/**
 * Persists one configured NanoHost IntegrationIdentity and its delivered first Token atomically.
 *
 * Inserts only when neither identity nor deployment exists and no retained
 * token history exists for that identity or deployment. Reactivates only the exact
 * decommissioned identity/deployment pair, preserving `created_at` and clearing
 * `decommissioned_at`. Active, cross-bound, duplicate, or conflicting rows fail closed
 * without mutation. The caller proves the configured safe-sink write before this
 * transaction; Core does not claim cross-domain atomicity.
 *
 * @param coreDb Open Core database handles.
 * @param input Configured identity plus the already-delivered first Token material.
 * @returns Redacted Token record and the caller-owned one-time secret.
 */
export function enrollNanoHostTransportIdentity(
  coreDb: CoreDb,
  input: EnrollNanoHostTransportIdentityInput
): NanoHostTransportTokenIssueResult {
  return coreDb.sqlite.transaction(() => {
    const now = (input.now ?? new Date()).toISOString();
    const rows = coreDb.sqlite
      .prepare(
        `SELECT identity_id, deployment_id, status
         FROM nanohost_integration_identities
         WHERE identity_id = ? OR deployment_id = ?`
      )
      .all(input.ownerNanoHostIdentityId, input.deploymentId) as Array<{
      deployment_id: string;
      identity_id: string;
      status: string;
    }>;
    const retainedTokenHistory = coreDb.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM nanohost_transport_tokens
         WHERE owner_nanohost_identity_id = ? OR deployment_id = ?`
      )
      .get(input.ownerNanoHostIdentityId, input.deploymentId) as { count: number };
    if (rows.length === 0 && Number(retainedTokenHistory.count) > 0) {
      throw new Error(
        'NanoHost enrollment conflicts with an existing identity or deployment binding.'
      );
    }

    if (rows.length === 0) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_integration_identities (
            identity_id, deployment_id, status, created_at
          ) VALUES (?, ?, 'active', ?)`
        )
        .run(input.ownerNanoHostIdentityId, input.deploymentId, now);
      return createNanoHostTransportTokenRecord(coreDb, input);
    }

    const exact = rows[0];
    if (
      rows.length !== 1 ||
      !exact ||
      exact.identity_id !== input.ownerNanoHostIdentityId ||
      exact.deployment_id !== input.deploymentId
    ) {
      throw new Error(
        'NanoHost enrollment conflicts with an existing identity or deployment binding.'
      );
    }
    if (exact.status === 'active') {
      throw new Error('Configured NanoHost identity is already enrolled.');
    }
    if (exact.status !== 'decommissioned') {
      throw new Error(
        'NanoHost enrollment requires the exact decommissioned identity and deployment pair.'
      );
    }

    const reactivated = coreDb.sqlite
      .prepare(
        `UPDATE nanohost_integration_identities
         SET status = 'active', decommissioned_at = NULL
         WHERE identity_id = ? AND deployment_id = ? AND status = 'decommissioned'`
      )
      .run(input.ownerNanoHostIdentityId, input.deploymentId);
    if (reactivated.changes !== 1) {
      throw new Error(
        'NanoHost enrollment could not reactivate the exact decommissioned identity.'
      );
    }

    return createNanoHostTransportTokenRecord(coreDb, input);
  })();
}

/**
 * Returns whether the configured NanoHost IntegrationIdentity is durably active.
 *
 * @param coreDb Open Core database handles.
 * @param identityId Configured NanoHost identity id.
 * @param deploymentId Configured deployment id.
 * @returns True only for the exact active identity and deployment binding.
 */
export function isNanoHostTransportIdentityActive(
  coreDb: CoreDb,
  identityId: string,
  deploymentId: string
): boolean {
  return Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1 FROM nanohost_integration_identities
         WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
      )
      .get(identityId, deploymentId)
  );
}

/**
 * Verifies one presented NanoHost transport Token against durable server records.
 *
 * @param coreDb Open Core database handles.
 * @param secret Presented bearer token secret.
 * @param options Optional verification clock and redacted source summary.
 * @returns Verified non-secret token identity or null.
 */
export function verifyNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  secret: string,
  options: { channel?: string; now?: Date; source?: string } = {}
): VerifiedNanoHostTransportTokenRecord | null {
  if (!isOpenKitAccessTokenSecret(secret)) {
    return null;
  }

  const expectedHash = hashOpenKitAccessTokenSecret(secret);
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_hash = ?')
    .get(expectedHash) as NanoHostTransportTokenRow | undefined;

  if (!row || !verifyOpenKitAccessTokenSecret(secret, row.token_hash)) {
    return null;
  }

  if (
    row.token_type !== NANOHOST_TRANSPORT_TOKEN_TYPE ||
    row.scope !== NANOHOST_TRANSPORT_TOKEN_SCOPE
  ) {
    return null;
  }

  const usability = evaluateNanoHostTransportTokenUsability(
    {
      expiresAt: row.expires_at,
      rotationOverlapExpiresAt: row.rotation_overlap_expires_at,
      status: row.status,
    },
    options.now
  );

  if (!usability.usable) {
    return null;
  }

  const lastUsedAt = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET last_used_at = ?, last_used_channel = ?, last_used_source = ?
       WHERE token_id = ?`
    )
    .run(lastUsedAt, options.channel ?? null, options.source ?? null, row.token_id);

  return getNanoHostTransportTokenRecord(coreDb, row.token_id);
}

/**
 * Lists durable NanoHost transport Token records without token hashes or plaintext secrets.
 *
 * @param coreDb Open Core database handles.
 * @returns Redacted token records.
 */
export function listNanoHostTransportTokenRecords(coreDb: CoreDb): NanoHostTransportTokenRecord[] {
  const rows = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens ORDER BY issued_at DESC, token_id DESC')
    .all() as NanoHostTransportTokenRow[];

  return rows.map(readNanoHostTransportTokenRecord);
}

/**
 * Revokes one NanoHost transport Token immediately.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id.
 * @param options Optional revocation clock.
 * @returns Revoked redacted token record, or null when missing.
 */
export function revokeNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  options: { now?: Date } = {}
): NanoHostTransportTokenRecord | null {
  const now = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, tokenId);

  return getNanoHostTransportTokenRecord(coreDb, tokenId);
}

/**
 * Rotates one active NanoHost transport Token.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id to rotate.
 * @param input Rotation input.
 * @returns Newly issued token and rotated predecessor record, or null when missing or unusable.
 */
export function rotateNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  input: RotateNanoHostTransportTokenRecordInput
): NanoHostTransportTokenRotationResult | null {
  const current = getNanoHostTransportTokenRecord(coreDb, tokenId);
  const now = input.now ?? new Date();

  if (
    !current ||
    current.status !== 'active' ||
    !evaluateNanoHostTransportTokenUsability(
      {
        expiresAt: current.expiresAt,
        rotationOverlapExpiresAt: current.rotationOverlapExpiresAt,
        status: current.status,
      },
      now
    ).usable
  ) {
    return null;
  }

  const overlapExpiresAt = new Date(now.getTime() + input.overlapSeconds * 1000).toISOString();
  const rotate = coreDb.sqlite.transaction(() => {
    coreDb.sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'rotated', rotation_overlap_expires_at = ?
         WHERE token_id = ?`
      )
      .run(overlapExpiresAt, tokenId);

    const issued = createNanoHostTransportTokenRecord(coreDb, {
      deploymentId: current.deploymentId,
      expiresAt: current.expiresAt,
      now,
      ownerNanoHostIdentityId: current.ownerNanoHostIdentityId,
      predecessorTokenId: current.tokenId,
      responsibleServerAdminActorId: current.responsibleServerAdminActorId,
    });
    const rotatedRecord = getNanoHostTransportTokenRecord(coreDb, tokenId);

    if (!rotatedRecord) {
      throw new Error(`NanoHost transport token record was not rotated: ${tokenId}`);
    }

    return { ...issued, rotatedRecord };
  });

  return rotate();
}

/**
 * Revokes every NanoHost transport Token owned by one configured identity.
 *
 * @param coreDb Open Core database handles.
 * @param ownerNanoHostIdentityId Configured NanoHost IntegrationIdentity id.
 * @param options Optional decommission clock.
 * @returns Redacted records that were revoked by this call.
 */
export function decommissionNanoHostTransportTokens(
  coreDb: CoreDb,
  ownerNanoHostIdentityId: string,
  options: { now?: Date } = {}
): NanoHostTransportTokenRecord[] {
  const now = (options.now ?? new Date()).toISOString();
  const rows = coreDb.sqlite
    .prepare(
      `SELECT token_id FROM nanohost_transport_tokens
       WHERE owner_nanohost_identity_id = ? AND status != 'revoked'`
    )
    .all(ownerNanoHostIdentityId) as Array<{ token_id: string }>;

  const revoked: NanoHostTransportTokenRecord[] = [];
  for (const row of rows) {
    const record = revokeNanoHostTransportTokenRecord(coreDb, row.token_id, {
      now: new Date(now),
    });
    if (record) {
      revoked.push(record);
    }
  }

  return revoked;
}

/**
 * Marks the configured NanoHost IntegrationIdentity decommissioned when it exists.
 *
 * @param coreDb Open Core database handles.
 * @param identityId Configured NanoHost identity id.
 * @param options Optional decommission clock.
 */
export function decommissionNanoHostIntegrationIdentity(
  coreDb: CoreDb,
  identityId: string,
  options: { now?: Date } = {}
): void {
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_integration_identities
       SET status = 'decommissioned', decommissioned_at = ?
       WHERE identity_id = ? AND status = 'active'`
    )
    .run((options.now ?? new Date()).toISOString(), identityId);
}

/**
 * Reads one redacted NanoHost transport Token record.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id.
 * @returns Redacted token record, or null when missing.
 */
export function getNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string
): NanoHostTransportTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_id = ?')
    .get(tokenId) as NanoHostTransportTokenRow | undefined;

  return row ? readNanoHostTransportTokenRecord(row) : null;
}

/**
 * Completes a winning rotation cutover for one predecessor Token.
 *
 * After the successor connection generation fences the predecessor, the
 * predecessor Token must no longer authenticate. Sets status to `rotated` with
 * an expired overlap deadline so verification fails closed.
 *
 * @param coreDb Open Core database handles.
 * @param predecessorTokenId Predecessor Token id to retire.
 * @param options Optional cutover clock.
 * @returns Updated predecessor record, or null when missing.
 */
export function completeNanoHostTransportTokenCutover(
  coreDb: CoreDb,
  predecessorTokenId: string,
  options: { now?: Date } = {}
): NanoHostTransportTokenRecord | null {
  const current = getNanoHostTransportTokenRecord(coreDb, predecessorTokenId);
  if (!current) {
    return null;
  }

  const now = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'rotated', rotation_overlap_expires_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, predecessorTokenId);

  return getNanoHostTransportTokenRecord(coreDb, predecessorTokenId);
}

/**
 * Aborts an in-flight NanoHost transport Token rotation.
 *
 * Revokes the successor and restores the predecessor to `active` with a cleared
 * overlap deadline so the predecessor remains the sole usable credential.
 *
 * @param coreDb Open Core database handles.
 * @param input Predecessor and successor Token ids.
 * @returns Updated predecessor and successor records, or null when either is missing.
 */
export function abortNanoHostTransportTokenRotation(
  coreDb: CoreDb,
  input: {
    predecessorTokenId: string;
    successorTokenId: string;
    now?: Date;
  }
): {
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null {
  const predecessor = getNanoHostTransportTokenRecord(coreDb, input.predecessorTokenId);
  const successor = getNanoHostTransportTokenRecord(coreDb, input.successorTokenId);
  if (!predecessor || !successor) {
    return null;
  }

  const now = input.now ?? new Date();
  const abort = coreDb.sqlite.transaction(() => {
    revokeNanoHostTransportTokenRecord(coreDb, input.successorTokenId, { now });
    coreDb.sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'active', rotation_overlap_expires_at = NULL, revoked_at = NULL
         WHERE token_id = ?`
      )
      .run(input.predecessorTokenId);

    const restored = getNanoHostTransportTokenRecord(coreDb, input.predecessorTokenId);
    const revokedSuccessor = getNanoHostTransportTokenRecord(coreDb, input.successorTokenId);
    if (!restored || !revokedSuccessor) {
      throw new Error('NanoHost transport rotation abort failed to update token records.');
    }
    return { predecessor: restored, successor: revokedSuccessor };
  });

  return abort();
}

/**
 * Converts a storage row to a redacted read model.
 *
 * @param row Storage row.
 * @returns Redacted token record.
 */
function readNanoHostTransportTokenRecord(
  row: NanoHostTransportTokenRow
): NanoHostTransportTokenRecord {
  return {
    deploymentId: row.deployment_id,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    lastUsedChannel: row.last_used_channel,
    lastUsedSource: row.last_used_source,
    ownerNanoHostIdentityId: row.owner_nanohost_identity_id,
    predecessorTokenId: row.predecessor_token_id,
    responsibleServerAdminActorId: row.responsible_server_admin_actor_id,
    revokedAt: row.revoked_at,
    rotationOverlapExpiresAt: row.rotation_overlap_expires_at,
    scope: row.scope,
    status: row.status,
    tokenId: row.token_id,
    tokenType: row.token_type,
  };
}
