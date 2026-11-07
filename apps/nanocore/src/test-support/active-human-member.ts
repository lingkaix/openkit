import type { CoreDb } from '../storage/db.js';

/**
 * Records one active human and a non-owner Workspace membership for a private-thread fixture.
 * Product admission still reads that membership row. This does not change Workspace ownership.
 */
export function recordActiveHumanWorkspaceMember(
  coreDb: CoreDb,
  input: {
    readonly userId: string;
    readonly email: string;
    readonly workspaceId: string;
    readonly joinedAt: string;
    readonly nowMs: number;
  }
): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at)
       VALUES (?, 'Other', ?, 0, ?, ?, 'human', 'active', NULL)`
    )
    .run(input.userId, input.email, input.nowMs, input.nowMs);
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members
        (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
       VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(input.workspaceId, input.userId, input.joinedAt, input.joinedAt, input.joinedAt);
}
