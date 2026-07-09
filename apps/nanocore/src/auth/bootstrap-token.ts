import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
  verifyOpenKitAccessTokenSecret,
} from './access-token.js';
import {
  createOpenKitAccessTokenRecord,
  type OpenKitAccessTokenIssueResult,
} from './access-token-store.js';

const BOOTSTRAP_SETTING_KEY = 'auth.bootstrap_token';
const BOOTSTRAP_TTL_MS = 86_400_000;

/** One-time server bootstrap token emission. */
export interface ServerBootstrapTokenIssue {
  /** Plaintext bootstrap token shown exactly once through the operator channel. */
  token: string;
  /** Issue timestamp. */
  issuedAt: string;
  /** Expiration timestamp. */
  expiresAt: string;
}

/** Server bootstrap emission file summary. */
export interface ServerBootstrapTokenEmission {
  /** File path that received the one-time operator emission. */
  path: string;
}

/** Input for consuming one server bootstrap token. */
export interface ConsumeServerBootstrapTokenInput {
  /** Plaintext bootstrap token. */
  token: string;
  /** Owner user id to create. */
  ownerUserId: string;
  /** Owner display name. */
  displayName: string;
  /** Expiration timestamp for the returned server-admin token. */
  tokenExpiresAt: string;
  /** Current time. */
  now?: Date;
}

/** Server bootstrap consume result. */
export type ConsumeServerBootstrapTokenResult =
  | ({ status: 'consumed' } & OpenKitAccessTokenIssueResult)
  | { status: 'invalid' | 'unavailable' };

interface BootstrapSetting {
  consumedAt: string | null;
  expiresAt: string;
  issuedAt: string;
  tokenHash: string;
}

/**
 * Ensures a fresh server-mode deployment has one unconsumed bootstrap token.
 *
 * @param coreDb Open Core database handles.
 * @param options Optional clock and TTL.
 * @returns One-time plaintext token when newly emitted.
 */
export function ensureServerBootstrapToken(
  coreDb: CoreDb,
  options: { now?: Date; ttlMs?: number } = {}
): ServerBootstrapTokenIssue | null {
  const now = options.now ?? new Date();
  if (countUsers(coreDb) > 0) {
    return null;
  }

  const current = readBootstrapSetting(coreDb);
  if (current && !current.consumedAt && Date.parse(current.expiresAt) > now.getTime()) {
    return null;
  }

  const token = createOpenKitAccessTokenSecret();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? BOOTSTRAP_TTL_MS)).toISOString();
  writeBootstrapSetting(coreDb, {
    consumedAt: null,
    expiresAt,
    issuedAt,
    tokenHash: hashOpenKitAccessTokenSecret(token),
  });

  return { expiresAt, issuedAt, token };
}

/**
 * Writes the one-time bootstrap token to an owner-only operator file.
 *
 * @param dataRoot NanoCore data root.
 * @param issue Token issue payload.
 * @returns Emission file summary without secret material.
 */
export function writeServerBootstrapTokenEmission(
  dataRoot: string,
  issue: ServerBootstrapTokenIssue
): ServerBootstrapTokenEmission {
  const root = resolveDataRootPath(dataRoot, 'server', 'files', 'auth');
  const path = join(root, 'bootstrap-token.txt');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path,
    [
      'OpenKit server bootstrap token. This value is shown once and never stored in plaintext.',
      `Expires at: ${issue.expiresAt}`,
      `Token: ${issue.token}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);

  return { path };
}

/**
 * Consumes a server bootstrap token and returns the first server-admin token.
 *
 * @param coreDb Open Core database handles.
 * @param input Consume input.
 * @returns Consumption result without echoing the bootstrap token.
 */
export function consumeServerBootstrapToken(
  coreDb: CoreDb,
  input: ConsumeServerBootstrapTokenInput
): ConsumeServerBootstrapTokenResult {
  const now = input.now ?? new Date();
  const setting = readBootstrapSetting(coreDb);
  if (countUsers(coreDb) > 0) {
    return { status: 'unavailable' };
  }

  if (
    !setting ||
    setting.consumedAt ||
    Date.parse(setting.expiresAt) <= now.getTime() ||
    !verifyOpenKitAccessTokenSecret(input.token, setting.tokenHash)
  ) {
    return { status: 'invalid' };
  }

  const consume = coreDb.sqlite.transaction(() => {
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id,
          display_name,
          email,
          email_verified,
          image,
          created_at,
          updated_at,
          kind,
          last_seen_at
        )
         VALUES (?, ?, ?, false, NULL, ?, ?, 'human', ?)`
      )
      .run(
        input.ownerUserId,
        input.displayName,
        bootstrapOwnerEmail(input.ownerUserId),
        now.getTime(),
        now.getTime(),
        now.toISOString()
      );
    writeBootstrapSetting(coreDb, { ...setting, consumedAt: now.toISOString() });

    return createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: input.tokenExpiresAt,
      now,
      ownerUserId: input.ownerUserId,
      scope: 'server-admin',
      workspaceIds: [],
    });
  });

  return { ...consume(), status: 'consumed' };
}

/**
 * Derives a non-deliverable bootstrap owner email for the canonical users table.
 *
 * @param ownerUserId Owner user id.
 * @returns Synthetic bootstrap owner email.
 */
function bootstrapOwnerEmail(ownerUserId: string): string {
  const localPart = ownerUserId.toLowerCase().replace(/[^a-z0-9._+-]/g, '-') || 'owner';
  return `${localPart}@bootstrap.openkit.invalid`;
}

/**
 * Counts OpenKit user records.
 *
 * @param coreDb Open Core database handles.
 * @returns User count.
 */
function countUsers(coreDb: CoreDb): number {
  return (coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
    .count;
}

/**
 * Reads the current bootstrap setting.
 *
 * @param coreDb Open Core database handles.
 * @returns Stored bootstrap setting when present.
 */
function readBootstrapSetting(coreDb: CoreDb): BootstrapSetting | null {
  const row = coreDb.sqlite
    .prepare('SELECT value FROM server_settings WHERE key = ?')
    .get(BOOTSTRAP_SETTING_KEY) as { value: string } | undefined;

  return row ? (JSON.parse(row.value) as BootstrapSetting) : null;
}

/**
 * Writes the bootstrap setting payload.
 *
 * @param coreDb Open Core database handles.
 * @param setting Bootstrap setting.
 */
function writeBootstrapSetting(coreDb: CoreDb, setting: BootstrapSetting): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO server_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(BOOTSTRAP_SETTING_KEY, JSON.stringify(setting), new Date().toISOString());
}
