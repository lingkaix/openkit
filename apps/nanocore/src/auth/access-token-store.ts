import { allocateEntityId, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import type { CoreDb } from '../storage/db.js';
import {
  createOpenKitAccessTokenSecret,
  evaluateOpenKitAccessTokenUsability,
  hashOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
  type OpenKitAccessTokenScope,
  type OpenKitAccessTokenStatus,
} from './access-token.js';
import type { Actor } from './identity.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/** Stable server_settings key prefix for one user's default server-admin token id. */
const DEFAULT_SERVER_ADMIN_TOKEN_SETTING_KEY_PREFIX = 'auth.default_server_admin_token.';

/** Fixed v1 default-pointer payload; unusable or malformed supported payloads retain null fallback. */
const DefaultServerAdminTokenV1Schema = z.object({ tokenId: z.string().min(1) }).strip();

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

/** Hash-only successor material prepared outside the native deciding section. */
export interface PreparedOpenKitAccessTokenRotationInput
  extends RotateOpenKitAccessTokenRecordInput {
  readonly successor: {
    readonly tokenId: string;
    readonly tokenHash: string;
  };
}

/** Original mutation-time snapshots, without a plaintext credential. */
export type PreparedOpenKitAccessTokenRotationResult = Omit<
  OpenKitAccessTokenRotationResult,
  'secret'
>;

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
  schemaVersion: unknown;
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
 * Reports whether a caller-supplied access-token expiry is strictly after the server clock.
 *
 * A current or past instant is not a usable server-admin credential. Bootstrap must refuse it
 * before any write so consumption cannot close the ceremony and leave no administrator token.
 *
 * @param expiresAt Caller-supplied expiration timestamp.
 * @param now Server clock used for the refusal.
 * @returns True only when the instant parses and is later than `now`.
 */
export function isAccessTokenExpiryStrictlyFuture(expiresAt: string, now: Date): boolean {
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
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
  const tokenId = input.tokenId ?? allocateEntityId('tok');
  const secret = input.secret ?? createOpenKitAccessTokenSecret();
  const now = (input.now ?? new Date()).toISOString();
  const record = insertOpenKitAccessTokenRecord(coreDb, {
    ...input,
    scope: binding.scope,
    workspaceIds: binding.workspaceIds,
    tokenId,
    tokenHash: hashOpenKitAccessTokenSecret(secret),
    issuedAt: now,
  });
  return { record, secret, tokenId };
}

/** Exact existing hash-only insertion tuple, shared by issuance and native stopped recovery. */
export interface InsertOpenKitAccessTokenRecordInput {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly ownerUserId: string;
  readonly scope: OpenKitAccessTokenScope;
  readonly workspaceIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly predecessorTokenId?: string | null;
}

/** Inserts and reads back one record without generating or transporting its plaintext material. */
export function insertOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  input: InsertOpenKitAccessTokenRecordInput
): OpenKitAccessTokenRecord {
  const binding = normalizeOpenKitAccessTokenScope(input.scope, input.workspaceIds);
  coreDb.sqlite
    .prepare(
      `INSERT INTO openkit_access_tokens (
        token_id,
        token_hash,
        owner_user_id,
        scope,
        schema_version,
        workspace_ids_json,
        status,
        issued_at,
        expires_at,
        predecessor_token_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(
      input.tokenId,
      input.tokenHash,
      input.ownerUserId,
      binding.scope,
      writeRetainedV1({}).schemaVersion,
      JSON.stringify(binding.workspaceIds),
      input.issuedAt,
      input.expiresAt,
      input.predecessorTokenId ?? null
    );
  const record = getOpenKitAccessTokenRecord(coreDb, input.tokenId);
  if (!record) {
    throw new Error(`OpenKit access token record was not created: ${input.tokenId}`);
  }
  return record;
}

/** Revalidates the current hash proof and authority, then records use in the native deciding section. */
export function recordVerifiedOpenKitAccessTokenUse(
  coreDb: CoreDb,
  input: import('../storage/access-token-verification-codecs.js').ControlAccessTokenVerification
): VerifiedOpenKitAccessTokenRecord | null {
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, * FROM openkit_access_tokens WHERE token_id = ?'
    )
    .get(input.tokenId) as OpenKitAccessTokenRow | undefined;
  if (!row || row.token_hash !== input.expectedHash) return null;
  return readRetainedV1(row, () => {
    if (!isCanonicalUserActive(coreDb, row.owner_user_id)) return null;
    const now = input.now ? new Date(input.now) : new Date();
    if (
      !evaluateOpenKitAccessTokenUsability(
        {
          expiresAt: row.expires_at,
          rotatedGraceExpiresAt: row.rotated_grace_expires_at,
          status: row.status,
        },
        now
      ).usable
    )
      return null;
    coreDb.sqlite
      .prepare(`UPDATE openkit_access_tokens
      SET last_used_at = ?, last_used_channel = ?, last_used_source = ? WHERE token_id = ?`)
      .run(now.toISOString(), input.channel ?? null, input.source ?? null, row.token_id);
    return getOpenKitAccessTokenRecord(coreDb, row.token_id);
  });
}

/**
 * Lists durable OpenKit access-token records without token hashes or plaintext secrets.
 *
 * @param coreDb Open Core database handles.
 * @returns Redacted token records.
 */
export function listOpenKitAccessTokenRecords(coreDb: CoreDb): OpenKitAccessTokenRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, * FROM openkit_access_tokens ORDER BY issued_at DESC, token_id DESC'
    )
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
 * @throws When a retained token format or its workspace-binding JSON is invalid.
 */
export function revokeOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  now = new Date()
): OpenKitAccessTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT schema_version AS schemaVersion FROM openkit_access_tokens WHERE token_id = ?')
    .get(tokenId);
  if (!row) return null;

  return readRetainedV1(row, () => {
    coreDb.sqlite
      .prepare(
        `UPDATE openkit_access_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE token_id = ? AND status != 'revoked'`
      )
      .run(now.toISOString(), tokenId);

    return getOpenKitAccessTokenRecord(coreDb, tokenId);
  });
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
  input: PreparedOpenKitAccessTokenRotationInput
): PreparedOpenKitAccessTokenRotationResult | null;
export function rotateOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  input: RotateOpenKitAccessTokenRecordInput
): OpenKitAccessTokenRotationResult | null;
export function rotateOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  input: RotateOpenKitAccessTokenRecordInput | PreparedOpenKitAccessTokenRotationInput
): OpenKitAccessTokenRotationResult | PreparedOpenKitAccessTokenRotationResult | null {
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

    // Both paths share this original predecessor-update/successor-insert transaction.
    // The legacy path still generates its secret here; native callers supply only id/hash.
    const issued =
      'successor' in input
        ? {
            tokenId: input.successor.tokenId,
            record: insertOpenKitAccessTokenRecord(coreDb, {
              ...input.successor,
              issuedAt: now.toISOString(),
              expiresAt: current.expiresAt,
              ownerUserId: current.ownerUserId,
              predecessorTokenId: current.tokenId,
              scope: current.scope,
              workspaceIds: current.workspaceIds,
            }),
          }
        : createOpenKitAccessTokenRecord(coreDb, {
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
export function getOpenKitAccessTokenRecord(
  coreDb: CoreDb,
  tokenId: string
): OpenKitAccessTokenRecord | null {
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, * FROM openkit_access_tokens WHERE token_id = ?'
    )
    .get(tokenId) as OpenKitAccessTokenRow | undefined;

  return row ? readOpenKitAccessTokenRecord(row) : null;
}

/**
 * Builds the server_settings key that stores one user's default server-admin token id.
 *
 * @param ownerUserId Canonical user id.
 * @returns Stable per-user setting key.
 */
function defaultServerAdminTokenSettingKey(ownerUserId: string): string {
  return `${DEFAULT_SERVER_ADMIN_TOKEN_SETTING_KEY_PREFIX}${ownerUserId}`;
}

/**
 * Resolves the non-secret server-admin token id that currently grants a session derived deployment-admin authority.
 *
 * The stored default is used only when it is owned, server-admin, and currently usable. Otherwise the first usable owned server-admin token in issued-at then token-id descending order is selected, so a sole token is automatically effective.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @param now Current time.
 * @returns Selected token id, or null when the user is inactive or has no usable server-admin token.
 */
export function resolveSessionDeploymentAdminTokenId(
  coreDb: CoreDb,
  ownerUserId: string,
  now = new Date()
): string | null {
  if (!isCanonicalUserActive(coreDb, ownerUserId)) {
    return null;
  }

  const usable = listOwnedUsableServerAdminTokens(coreDb, ownerUserId, now);
  if (usable.length === 0) {
    return null;
  }

  const stored = readDefaultServerAdminTokenId(coreDb, ownerUserId);
  if (stored && usable.some((token) => token.tokenId === stored)) {
    return stored;
  }

  return usable[0]?.tokenId ?? null;
}

/**
 * Persists one owned usable server-admin token as the user's explicit default.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @param tokenId Candidate default token id.
 * @param now Current time.
 * @returns True when the default was stored.
 * @throws When a retained token or existing default setting has an unsupported format.
 */
export function setDefaultServerAdminTokenId(
  coreDb: CoreDb,
  ownerUserId: string,
  tokenId: string,
  now = new Date()
): boolean {
  const token = getOpenKitAccessTokenRecord(coreDb, tokenId);
  if (
    !token ||
    token.ownerUserId !== ownerUserId ||
    token.scope !== 'server-admin' ||
    !evaluateOpenKitAccessTokenUsability(token, now).usable
  ) {
    return false;
  }

  // An explicit selection cannot overwrite an unsupported retained setting format.
  readDefaultServerAdminTokenId(coreDb, ownerUserId);
  coreDb.sqlite
    .prepare(
      `INSERT INTO server_settings (key, value, updated_at, schema_version)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, schema_version = excluded.schema_version`
    )
    .run(
      defaultServerAdminTokenSettingKey(ownerUserId),
      JSON.stringify({ tokenId }),
      now.toISOString(),
      writeRetainedV1({}).schemaVersion
    );
  return true;
}

/**
 * Lists the signed-in user's redacted server-admin tokens plus the effective default token id.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @param now Current time.
 * @returns Redacted owned server-admin tokens and the resolved default.
 */
export function listOwnedServerAdminAccessTokens(
  coreDb: CoreDb,
  ownerUserId: string,
  now = new Date()
): { defaultTokenId: string | null; items: OpenKitAccessTokenRecord[] } {
  return {
    defaultTokenId: resolveSessionDeploymentAdminTokenId(coreDb, ownerUserId, now),
    items: listOwnedServerAdminTokenRecords(coreDb, ownerUserId),
  };
}

/**
 * Lists currently usable server-admin tokens owned by one user, newest first.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @param now Current time.
 * @returns Usable owned server-admin records in deterministic order.
 */
function listOwnedUsableServerAdminTokens(
  coreDb: CoreDb,
  ownerUserId: string,
  now: Date
): OpenKitAccessTokenRecord[] {
  return listOwnedServerAdminTokenRecords(coreDb, ownerUserId).filter(
    (token) => evaluateOpenKitAccessTokenUsability(token, now).usable
  );
}

/**
 * Lists server-admin tokens owned by one user, newest first.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @returns Owned server-admin records in issued-at then token-id descending order.
 */
function listOwnedServerAdminTokenRecords(
  coreDb: CoreDb,
  ownerUserId: string
): OpenKitAccessTokenRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `SELECT schema_version AS schemaVersion, * FROM openkit_access_tokens
       WHERE owner_user_id = ? AND scope = 'server-admin'
       ORDER BY issued_at DESC, token_id DESC`
    )
    .all(ownerUserId) as OpenKitAccessTokenRow[];

  return rows.map(readOpenKitAccessTokenRecord);
}

/**
 * Reads the stored per-user default server-admin token id when present.
 *
 * @param coreDb Open Core database handles.
 * @param ownerUserId Canonical user id.
 * @returns Stored token id, or null when missing or malformed.
 * @throws When the retained setting has an unsupported format.
 */
function readDefaultServerAdminTokenId(coreDb: CoreDb, ownerUserId: string): string | null {
  const row = coreDb.sqlite
    .prepare('SELECT schema_version AS schemaVersion, value FROM server_settings WHERE key = ?')
    .get(defaultServerAdminTokenSettingKey(ownerUserId)) as
    | { schemaVersion: unknown; value: string }
    | undefined;
  if (!row) {
    return null;
  }

  return readRetainedV1(row, () => {
    try {
      const parsed = DefaultServerAdminTokenV1Schema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data.tokenId : null;
    } catch {
      return null;
    }
  });
}

/**
 * Converts a storage row to a redacted read model.
 *
 * @param row Storage row.
 * @returns Redacted token record.
 */
function readOpenKitAccessTokenRecord(row: OpenKitAccessTokenRow): OpenKitAccessTokenRecord {
  return readRetainedV1(row, () => ({
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
    workspaceIds: parseWorkspaceIdsV1(row.workspace_ids_json),
  }));
}

/**
 * Parses frozen v1 workspace bindings: retain string entries in order, or no entries for a non-array.
 *
 * @param value Stored JSON value.
 * @returns Workspace id list.
 */
function parseWorkspaceIdsV1(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Current non-secret deployment-administrator authority proved from durable Token state. */
export interface CurrentDeploymentAdminAuthority {
  /** Token id that currently grants server administration, absent only in local mode. */
  readonly tokenId: string | null;
  /** Canonical user that owns the authority. */
  readonly userId: string;
}

/** Raised when an operation has no current usable deployment-administrator authority. */
export class DeploymentAdminRequiredError extends Error {
  public constructor() {
    super('Current deployment administrator authority is required.');
    this.name = 'DeploymentAdminRequiredError';
  }
}

/**
 * Rechecks current deployment-administrator authority from durable user and Token owners.
 *
 * @param coreDb Core identity and Token authority.
 * @param actor Authenticated request actor whose authority must still be usable.
 * @param now Current time for Token expiration and rotation-grace evaluation.
 * @returns Current non-secret administrator authority.
 * @throws DeploymentAdminRequiredError when the actor or its current Token authority is unusable.
 */
export function requireCurrentDeploymentAdmin(
  coreDb: CoreDb,
  actor: Actor | undefined,
  now = new Date()
): CurrentDeploymentAdminAuthority {
  if (!actor || !isCanonicalUserActive(coreDb, actor.userId)) {
    throw new DeploymentAdminRequiredError();
  }
  if (actor.kind === 'local') {
    return { tokenId: null, userId: actor.userId };
  }
  if (actor.kind === 'session') {
    // Only actual session authentication projects this eligibility; channel pairing does not.
    const tokenId = actor.adminTokenId
      ? resolveSessionDeploymentAdminTokenId(coreDb, actor.userId, now)
      : null;
    if (tokenId) {
      return { tokenId, userId: actor.userId };
    }
    throw new DeploymentAdminRequiredError();
  }
  const token = actor.tokenId ? getOpenKitAccessTokenRecord(coreDb, actor.tokenId) : undefined;
  if (
    token?.ownerUserId === actor.userId &&
    token.scope === 'server-admin' &&
    actor.tokenScope === 'server-admin' &&
    evaluateOpenKitAccessTokenUsability(token, now).usable
  ) {
    return { tokenId: token.tokenId, userId: actor.userId };
  }
  throw new DeploymentAdminRequiredError();
}
