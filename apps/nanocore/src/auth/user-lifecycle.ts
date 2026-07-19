import type { CoreDb } from '../storage/db.js';

/** Disabled canonical-user projection returned by the lifecycle mutation. */
export interface DisabledCanonicalUser {
  /** Stable canonical user id. */
  userId: string;
  /** Terminal v1 user status. */
  status: 'disabled';
  /** First successful disable timestamp. */
  disabledAt: string;
}

/** Result of one idempotent canonical-user disable mutation. */
export interface DisableCanonicalUserResult {
  /** Whether this call performed the active-to-disabled transition. */
  changed: boolean;
  /** Current disabled user projection. */
  user: DisabledCanonicalUser;
}

/**
 * Checks the single canonical user-status authority.
 *
 * @param coreDb Open Core database handles.
 * @param userId Canonical user id.
 * @returns True only when the canonical user exists and is active.
 */
export function isCanonicalUserActive(coreDb: CoreDb, userId: string): boolean {
  const row = coreDb.sqlite.prepare('SELECT status FROM users WHERE id = ?').get(userId) as
    | { status: 'active' | 'disabled' }
    | undefined;

  return row?.status === 'active';
}

/**
 * Disables one canonical user inside the caller-owned Core transaction.
 *
 * The mutation preserves the user and historical records while deleting live Better Auth
 * sessions and revoking every active or rotation-grace OpenKit token.
 *
 * @param coreDb Open Core database participating in the outer transaction.
 * @param userId Canonical user id to disable.
 * @param now Disable and revocation timestamp.
 * @returns Current disabled projection and whether this call changed it, or null when missing.
 * @throws Error when called outside a caller-owned Core transaction or storage is inconsistent.
 */
export function disableCanonicalUser(
  coreDb: CoreDb,
  userId: string,
  now = new Date()
): DisableCanonicalUserResult | null {
  if (!coreDb.sqlite.inTransaction) {
    throw new Error('Canonical user disable requires a caller-owned Core transaction.');
  }

  const disabledAt = now.toISOString();
  const changed =
    coreDb.sqlite
      .prepare(
        `UPDATE users
         SET status = 'disabled', disabled_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(disabledAt, now.getTime(), userId).changes === 1;
  const row = coreDb.sqlite
    .prepare(
      `SELECT id AS userId, status, disabled_at AS disabledAt
       FROM users
       WHERE id = ?`
    )
    .get(userId) as
    | {
        userId: string;
        status: 'active' | 'disabled';
        disabledAt: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }
  if (row.status !== 'disabled' || !row.disabledAt) {
    throw new Error('Canonical user disable did not produce a disabled user projection.');
  }

  coreDb.sqlite.prepare('DELETE FROM session WHERE user_id = ?').run(userId);
  coreDb.sqlite
    .prepare(
      `UPDATE openkit_access_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE owner_user_id = ? AND status IN ('active', 'rotated')`
    )
    .run(disabledAt, userId);

  return {
    changed,
    user: {
      disabledAt: row.disabledAt,
      status: 'disabled',
      userId: row.userId,
    },
  };
}
