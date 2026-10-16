import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import type { FsStore } from './lib/store.js';
import type { CoreDb } from './storage/db.js';

/** Raised when owner provisioning encounters retained removal rather than first-use absence. */
export class WorkspaceOwnerMembershipRemovedError extends Error {
  public constructor() {
    super('Workspace owner membership has been removed.');
    this.name = 'WorkspaceOwnerMembershipRemovedError';
  }
}

/** Current ownership identity among active Workspace members; neither value limits operation eligibility. */
export type WorkspaceMembershipRelation = 'owner' | 'member';

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
 * @throws WorkspaceOwnerMembershipRemovedError when the retained owner membership is removed.
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
 * @throws WorkspaceOwnerMembershipRemovedError when the retained owner membership is removed.
 * @throws Error when the owner identity or active membership is contradictory.
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
          invitation_id,
          joined_at,
          removed_at,
          revision,
          created_at,
          updated_at
        )
         VALUES (?, ?, 'active', NULL, ?, NULL, 1, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO NOTHING`
      )
      .run(input.workspaceId, input.ownerUserId, now, now, now);

    const ownerMembership = input.coreDb.sqlite
      .prepare(
        `SELECT status
         FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`
      )
      .get(input.workspaceId, input.ownerUserId) as { status: string } | undefined;
    if (ownerMembership?.status === 'removed') throw new WorkspaceOwnerMembershipRemovedError();
    if (ownerMembership?.status !== 'active') {
      throw new Error('Workspace owner requires an active membership.');
    }
  })();
}

/**
 * Resolves one actor's ownership relationship from the active Workspace registry and membership rows.
 *
 * @param coreDb Core database containing Workspace identity facts.
 * @param workspaceId Canonical Workspace identifier.
 * @param userId Canonical actor user identifier.
 * @returns Ownership relationship, or null when the facts are missing, inactive, or contradictory.
 */
export function resolveWorkspaceMembershipRelation(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string
): WorkspaceMembershipRelation | null {
  const row = coreDb.sqlite
    .prepare(
      `SELECT
         registry.owner_user_id,
         registry.status AS registry_status,
         actor_user.status AS actor_status,
         member.status AS member_status,
         owner_member.status AS owner_member_status
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
        actor_status: string;
        member_status: string | null;
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
    row.owner_member_status !== 'active'
  ) {
    return null;
  }
  return row.owner_user_id === userId ? 'owner' : 'member';
}

/**
 * Lists every active Workspace registry id in stable identifier order.
 *
 * @param coreDb Core database containing Workspace identity facts.
 * @returns Sorted active Workspace identifiers without consulting membership edges.
 */
export function listActiveWorkspaceIds(coreDb: CoreDb): string[] {
  const rows = coreDb.sqlite
    .prepare(
      `SELECT workspace_id
       FROM workspace_registry
       WHERE status = 'active'
       ORDER BY workspace_id`
    )
    .all() as Array<{ workspace_id: string }>;

  return rows.map((row) => row.workspace_id);
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
    .filter(
      (workspaceId) => resolveWorkspaceMembershipRelation(coreDb, workspaceId, userId) !== null
    );
}
