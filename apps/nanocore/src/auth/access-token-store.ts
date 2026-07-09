import { generateUuidV7 } from '../runtime/session-id.js';
import type { CoreDb } from '../storage/db.js';
import {
  createOpenKitAccessTokenSecret,
  evaluateOpenKitAccessTokenUsability,
  hashOpenKitAccessTokenSecret,
  isOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
  type OpenKitAccessTokenScope,
  type OpenKitAccessTokenStatus,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';

/** Input for creating one durable OpenKit access-token record. */
export interface CreateOpenKitAccessTokenRecordInput {
  /** User id that owns the token. */
  ownerUserId: string;
  /** Token scope. */
  scope: OpenKitAccessTokenScope;
  /** Workspace ids bound to workspace-scoped tokens. */
  workspaceIds: readonly string[];
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

/** Newly issued OpenKit access token. */
export interface OpenKitAccessTokenIssueResult {
  /** Durable token id. */
  tokenId: string;
  /** Plaintext token secret returned exactly once by the caller. */
  secret: string;
  /** Redacted durable record created for the token. */
  record: OpenKitAccessTokenRecord;
}

/** Input for rotating one durable OpenKit access-token record. */
export interface RotateOpenKitAccessTokenRecordInput {
  /** Grace window in seconds for the predecessor token. */
  graceSeconds: number;
  /** Current time. */
  now?: Date;
}

/** Newly issued token plus the rotated predecessor record. */
export interface OpenKitAccessTokenRotationResult extends OpenKitAccessTokenIssueResult {
  /** Redacted predecessor record after rotation. */
  rotatedRecord: OpenKitAccessTokenRecord;
}

/** Redacted durable OpenKit access-token record. */
export interface OpenKitAccessTokenRecord {
  /** Durable token id. */
  tokenId: string;
  /** User id that owns the token. */
  ownerUserId: string;
  /** Token scope. */
  scope: OpenKitAccessTokenScope;
  /** Workspace ids bound to workspace-scoped tokens. */
  workspaceIds: string[];
  /** Token lifecycle status. */
  status: OpenKitAccessTokenStatus;
  /** Issue timestamp. */
  issuedAt: string;
  /** Expiration timestamp. */
  expiresAt: string;
  /** Revocation timestamp. */
  revokedAt: string | null;
  /** Previous token id for rotated tokens. */
  predecessorTokenId: string | null;
  /** Rotation grace expiry. */
  rotatedGraceExpiresAt: string | null;
  /** Last successful use timestamp. */
  lastUsedAt: string | null;
  /** Last successful use channel. */
  lastUsedChannel: string | null;
  /** Last successful use source summary. */
  lastUsedSource: string | null;
}

/** Verified durable OpenKit access-token record. */
export type VerifiedOpenKitAccessTokenRecord = OpenKitAccessTokenRecord;

interface OpenKitAccessTokenRow {
  token_id: string;
  token_hash: string;
  owner_user_id: string;
  scope: OpenKitAccessTokenScope;
  workspace_ids_json: string;
  status: OpenKitAccessTokenStatus;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  predecessor_token_id: string | null;
  rotated_grace_expires_at: string | null;
  last_used_at: string | null;
  last_used_channel: string | null;
  last_used_source: string | null;
}

/**
 * Creates one durable OpenKit access-token record in the server Core database.
 *
 * @param coreDb Open Core database handles.
 * @param input Token issue input.
 * @returns Token id and plaintext secret for one-time return.
 */
export function createOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  input: CreateOpenKitAccessTokenRecordInput
): OpenKitAccessTokenIssueResult {
  const binding = normalizeOpenKitAccessTokenScope(input.scope, input.workspaceIds);
  const tokenId = input.tokenId ?? generateUuidV7();
  const secret = input.secret ?? createOpenKitAccessTokenSecret();
  const now = (input.now ?? new Date()).toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT INTO openkit_access_tokens (
        token_id,
        token_hash,
        owner_user_id,
        scope,
        workspace_ids_json,
        status,
        issued_at,
        expires_at,
        predecessor_token_id
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(
      tokenId,
      hashOpenKitAccessTokenSecret(secret),
      input.ownerUserId,
      binding.scope,
      JSON.stringify(binding.workspaceIds),
      now,
      input.expiresAt,
      input.predecessorTokenId ?? null
    );

  const record = getOpenKitAccessTokenRecord(coreDb, tokenId);
  if (!record) {
    throw new Error(`OpenKit access token record was not created: ${tokenId}`);
  }

  return { record, secret, tokenId };
}

/**
 * Verifies one presented OpenKit access token against durable server records.
 *
 * @param coreDb Open Core database handles.
 * @param secret Presented bearer token secret.
 * @param options Optional verification clock and redacted source summary.
 * @returns Verified non-secret token identity or null.
 */
export function verifyOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  secret: string,
  options: { channel?: string; now?: Date; source?: string } = {}
): VerifiedOpenKitAccessTokenRecord | null {
  if (!isOpenKitAccessTokenSecret(secret)) {
    return null;
  }

  const expectedHash = hashOpenKitAccessTokenSecret(secret);
  const row = coreDb.sqlite
    .prepare('SELECT * FROM openkit_access_tokens WHERE token_hash = ?')
    .get(expectedHash) as OpenKitAccessTokenRow | undefined;

  if (!row || !verifyOpenKitAccessTokenSecret(secret, row.token_hash)) {
    return null;
  }

  const usability = evaluateOpenKitAccessTokenUsability(
    {
      expiresAt: row.expires_at,
      rotatedGraceExpiresAt: row.rotated_grace_expires_at,
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
      `UPDATE openkit_access_tokens
       SET last_used_at = ?, last_used_channel = ?, last_used_source = ?
       WHERE token_id = ?`
    )
    .run(lastUsedAt, options.channel ?? null, options.source ?? null, row.token_id);

  return getOpenKitAccessTokenRecord(coreDb, row.token_id);
}

/**
 * Lists durable OpenKit access-token records without token hashes or plaintext secrets.
 *
 * @param coreDb Open Core database handles.
 * @returns Redacted token records.
 */
export function listOpenKitAccessTokenRecords(coreDb: CoreDb): OpenKitAccessTokenRecord[] {
  const rows = coreDb.sqlite
    .prepare('SELECT * FROM openkit_access_tokens ORDER BY issued_at DESC, token_id DESC')
    .all() as OpenKitAccessTokenRow[];

  return rows.map(readOpenKitAccessTokenRecord);
}

/**
 * Revokes one OpenKit access token immediately.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id.
 * @param now Current time.
 * @returns Revoked redacted token record, or null when missing.
 */
export function revokeOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  now = new Date()
): OpenKitAccessTokenRecord | null {
  coreDb.sqlite
    .prepare(
      `UPDATE openkit_access_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now.toISOString(), tokenId);

  return getOpenKitAccessTokenRecord(coreDb, tokenId);
}

/**
 * Rotates one active OpenKit access token.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id to rotate.
 * @param input Rotation input.
 * @returns Newly issued token and rotated predecessor record, or null when missing or unusable.
 */
export function rotateOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  input: RotateOpenKitAccessTokenRecordInput
): OpenKitAccessTokenRotationResult | null {
  const current = getOpenKitAccessTokenRecord(coreDb, tokenId);
  const now = input.now ?? new Date();

  if (
    !current ||
    current.status !== 'active' ||
    !evaluateOpenKitAccessTokenUsability(
      {
        expiresAt: current.expiresAt,
        rotatedGraceExpiresAt: current.rotatedGraceExpiresAt,
        status: current.status,
      },
      now
    ).usable
  ) {
    return null;
  }

  const graceExpiresAt = new Date(now.getTime() + input.graceSeconds * 1000).toISOString();
  const rotate = coreDb.sqlite.transaction(() => {
    coreDb.sqlite
      .prepare(
        `UPDATE openkit_access_tokens
         SET status = 'rotated', rotated_grace_expires_at = ?
         WHERE token_id = ?`
      )
      .run(graceExpiresAt, tokenId);

    const issued = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: current.expiresAt,
      now,
      ownerUserId: current.ownerUserId,
      predecessorTokenId: current.tokenId,
      scope: current.scope,
      workspaceIds: current.workspaceIds,
    });
    const rotatedRecord = getOpenKitAccessTokenRecord(coreDb, tokenId);

    if (!rotatedRecord) {
      throw new Error(`OpenKit access token record was not rotated: ${tokenId}`);
    }

    return { ...issued, rotatedRecord };
  });

  return rotate();
}

/**
 * Reads one redacted OpenKit access-token record.
 *
 * @param coreDb Open Core database handles.
 * @param tokenId Durable token id.
 * @returns Redacted token record, or null when missing.
 */
function getOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string
): OpenKitAccessTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM openkit_access_tokens WHERE token_id = ?')
    .get(tokenId) as OpenKitAccessTokenRow | undefined;

  return row ? readOpenKitAccessTokenRecord(row) : null;
}

/**
 * Converts a storage row to a redacted read model.
 *
 * @param row Storage row.
 * @returns Redacted token record.
 */
function readOpenKitAccessTokenRecord(row: OpenKitAccessTokenRow): OpenKitAccessTokenRecord {
  return {
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    lastUsedChannel: row.last_used_channel,
    lastUsedSource: row.last_used_source,
    ownerUserId: row.owner_user_id,
    predecessorTokenId: row.predecessor_token_id,
    revokedAt: row.revoked_at,
    rotatedGraceExpiresAt: row.rotated_grace_expires_at,
    scope: row.scope,
    status: row.status,
    tokenId: row.token_id,
    workspaceIds: parseWorkspaceIds(row.workspace_ids_json),
  };
}

/**
 * Parses workspace id bindings from one token row.
 *
 * @param value Stored JSON value.
 * @returns Workspace id list.
 */
function parseWorkspaceIds(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}
