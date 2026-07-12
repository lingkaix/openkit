import type { CoreDb } from './storage/db.js';

/**
 * Input for recording the owner membership edge of a workspace.
 */
export interface RecordWorkspaceOwnerMembershipInput {
  /** Core database used for server-scope identity records. */
  coreDb: CoreDb;
  /** Workspace id created by the workspace store. */
  workspaceId: string;
  /** Canonical owner user id. */
  ownerUserId: string;
  /** Current time override for deterministic tests. */
  now?: Date;
}

/**
 * Records the initial workspace registry and adds owner membership without reviving removed access.
 * Membership removal must retain its row with `status = 'removed'`; deleting the row discards the tombstone.
 *
 * @param input Workspace owner membership input.
 */
export function recordWorkspaceOwnerMembership(input: RecordWorkspaceOwnerMembershipInput): void {
  const now = (input.now ?? new Date()).toISOString();

  input.coreDb.sqlite.transaction(() => {
    input.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_registry (
          workspace_id,
          owner_user_id,
          status,
          created_at,
          updated_at
        )
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_id) DO NOTHING`
      )
      .run(input.workspaceId, input.ownerUserId, now, now);

    input.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id,
          user_id,
          status,
          created_at,
          updated_at
        )
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_id, user_id) DO NOTHING`
      )
      .run(input.workspaceId, input.ownerUserId, now, now);
  })();
}
