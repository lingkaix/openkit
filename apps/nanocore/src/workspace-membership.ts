import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import type { FsStore } from './lib/store.js';
import type { CoreDb } from './storage/db.js';

/** Effective fixed role derived from active Core Workspace membership facts. */
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

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

/** Input for ensuring one active user's built-in Quick Chat Workspace. */
export interface EnsureUserQuickChatWorkspaceInput {
  /** Core database that owns canonical user and Workspace relationships. */
  coreDb: CoreDb;
  /** Shared process-level Workspace store. */
  store: FsStore;
  /** Active canonical user that owns the private Workspace. */
  userId: string;
}

/**
 * Ensures one active user's built-in Quick Chat Workspace and owner relationship.
 *
 * @param input Canonical user, Core relationship store, and shared Workspace store.
 * @throws Error when the user is inactive or the reserved Workspace identity is contradictory.
 */
export function ensureUserQuickChatWorkspace(input: EnsureUserQuickChatWorkspaceInput): void {
  if (!isCanonicalUserActive(input.coreDb, input.userId)) {
    throw new Error('Quick Chat workspace requires an active canonical user.');
  }
  const workspace = input.store.ensureQuickChatWorkspace(input.userId);
  recordWorkspaceOwnerMembership({
    coreDb: input.coreDb,
    ownerUserId: input.userId,
    workspaceId: workspace.id,
  });
}

/**
 * Records the initial workspace registry and adds owner membership without reviving removed access.
 * Membership removal must retain its row with `status = 'removed'`; deleting the row discards the tombstone.
 *
 * @param input Workspace owner membership input.
 * @throws Error when another user already owns the workspace id.
 */
export function recordWorkspaceOwnerMembership(input: RecordWorkspaceOwnerMembershipInput): void {
  const now = (input.now ?? new Date()).toISOString();

  input.coreDb.sqlite.transaction(() => {
    if (!isCanonicalUserActive(input.coreDb, input.ownerUserId)) {
      throw new Error('Workspace owner requires an active canonical user.');
    }

    const existing = input.coreDb.sqlite
      .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
      .get(input.workspaceId) as { owner_user_id: string } | undefined;

    if (existing && existing.owner_user_id !== input.ownerUserId) {
      throw new Error('Workspace is already owned by another user.');
    }

    input.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_registry (
          workspace_id,
          owner_user_id,
          status,
          revision,
          created_at,
          updated_at
        )
         VALUES (?, ?, 'active', 1, ?, ?)
         ON CONFLICT(workspace_id) DO NOTHING`
      )
      .run(input.workspaceId, input.ownerUserId, now, now);

    input.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id,
          user_id,
          status,
          access_level,
          invitation_id,
          joined_at,
          removed_at,
          revision,
          created_at,
          updated_at
        )
         VALUES (?, ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO NOTHING`
      )
      .run(input.workspaceId, input.ownerUserId, now, now, now);

    const ownerMembership = input.coreDb.sqlite
      .prepare(
        `SELECT status, access_level
         FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`
      )
      .get(input.workspaceId, input.ownerUserId) as
      | { access_level: string; status: string }
      | undefined;
    if (ownerMembership?.status !== 'active' || ownerMembership.access_level !== 'editor') {
      throw new Error('Workspace owner requires an active editor membership.');
    }
  })();
}

/**
 * Resolves one actor's effective fixed role from the active Workspace registry and membership rows.
 *
 * @param coreDb Core database containing Workspace identity facts.
 * @param workspaceId Canonical Workspace identifier.
 * @param userId Canonical actor user identifier.
 * @returns Effective role, or null when the facts are missing, inactive, or contradictory.
 */
export function resolveWorkspaceRole(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string
): WorkspaceRole | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT
         registry.owner_user_id,
         registry.status AS registry_status,
         actor_user.status AS actor_status,
         member.status AS member_status,
         member.access_level,
         owner_member.status AS owner_member_status,
         owner_member.access_level AS owner_access_level
       FROM workspace_registry AS registry
       INNER JOIN users AS actor_user
         ON actor_user.id = ?
       LEFT JOIN workspace_members AS member
         ON member.workspace_id = registry.workspace_id
        AND member.user_id = actor_user.id
       LEFT JOIN workspace_members AS owner_member
         ON owner_member.workspace_id = registry.workspace_id
        AND owner_member.user_id = registry.owner_user_id
       WHERE registry.workspace_id = ?`
    )
    .get(userId, workspaceId) as
    | {
        access_level: string | null;
        actor_status: string;
        member_status: string | null;
        owner_access_level: string | null;
        owner_member_status: string | null;
        owner_user_id: string;
        registry_status: string;
      }
    | undefined;

  if (
    !row ||
    row.actor_status !== 'active' ||
    row.registry_status !== 'active' ||
    row.member_status !== 'active' ||
    row.owner_member_status !== 'active' ||
    row.owner_access_level !== 'editor'
  ) {
    return null;
  }
  if (row.owner_user_id === userId) {
    return row.access_level === 'editor' ? 'owner' : null;
  }
  if (row.access_level === 'editor' || row.access_level === 'viewer') {
    return row.access_level;
  }
  return null;
}

/**
 * Lists active, internally consistent Workspace candidates for one actor in stable identifier order.
 *
 * @param coreDb Core database containing Workspace identity facts.
 * @param userId Canonical actor user identifier.
 * @returns Sorted active Workspace identifiers without consulting Workspace storage.
 */
export function listActiveWorkspaceIdsForActor(coreDb: CoreDb, userId: string): string[] {
  const rows = coreDb.sqlite
    .prepare(
      `SELECT registry.workspace_id
       FROM workspace_registry AS registry
       INNER JOIN users AS actor_user
         ON actor_user.id = ?
        AND actor_user.status = 'active'
       INNER JOIN workspace_members AS member
         ON member.workspace_id = registry.workspace_id
        AND member.user_id = actor_user.id
       WHERE registry.status = 'active'
         AND member.status = 'active'
       ORDER BY registry.workspace_id`
    )
    .all(userId) as Array<{ workspace_id: string }>;

  return rows
    .map((row) => row.workspace_id)
    .filter((workspaceId) => resolveWorkspaceRole(coreDb, workspaceId, userId) !== null);
}
