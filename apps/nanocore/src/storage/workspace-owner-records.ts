import { allocateEntityId, deriveEntityId, WorkspaceIdSchema } from '@openkit/protocol';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import type { CoreDb } from './db.js';

/** Raised when owner provisioning encounters retained removal rather than first-use absence. */
export class WorkspaceOwnerMembershipRemovedError extends Error {
  public constructor() {
    super('Workspace owner membership has been removed.');
    this.name = 'WorkspaceOwnerMembershipRemovedError';
  }
}

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

/** Reads the original derived-or-bound personal identity on the caller's actual Core connection. */
export function resolvePersonalWorkspaceIdInDb(
  core: Pick<CoreDb, 'sqlite'>,
  userId: string
): string {
  const row = core.sqlite
    .prepare('SELECT personal_workspace_id FROM users WHERE id = ?')
    .get(userId) as { personal_workspace_id: string | null } | undefined;
  return WorkspaceIdSchema.parse(
    row?.personal_workspace_id ?? deriveEntityId('ws', ['quick_chat', userId])
  );
}

/** Reserves the original successor before physical publication, on the deciding Core connection. */
export function reservePersonalWorkspaceInDb(core: CoreDb, userId: string): string {
  return core.sqlite
    .transaction(() => {
      if (!isCanonicalUserActive(core, userId))
        throw new Error('Personal workspace requires an active canonical user.');
      const currentId = resolvePersonalWorkspaceIdInDb(core, userId);
      const registry = core.sqlite
        .prepare(
          'SELECT status, owner_user_id AS ownerUserId FROM workspace_registry WHERE workspace_id = ?'
        )
        .get(currentId) as { status: string; ownerUserId: string } | undefined;
      if (registry && registry.ownerUserId !== userId)
        throw new Error('Personal Workspace ownership is contradictory.');
      const membership = core.sqlite
        .prepare('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(currentId, userId) as { status: string } | undefined;
      if (membership?.status === 'removed') throw new WorkspaceOwnerMembershipRemovedError();
      if (registry && membership?.status !== 'active')
        throw new Error('Personal Workspace requires active owner membership.');
      if (registry?.status === 'retired') {
        const successor = allocateEntityId('ws');
        core.sqlite
          .prepare('UPDATE users SET personal_workspace_id = ? WHERE id = ?')
          .run(successor, userId);
        return successor;
      }
      if (registry && registry.status !== 'active')
        throw new Error('Personal Workspace requires an active registry.');
      return currentId;
    })
    .immediate();
}

/** Binds only the still-selected physical home and joins its original registration tuple. */
export function bindPersonalWorkspaceInDb(
  core: CoreDb,
  userId: string,
  expectedWorkspaceId: string,
  workspaceId: string,
  now: Date
): void {
  core.sqlite
    .transaction(() => {
      if (
        resolvePersonalWorkspaceIdInDb(core, userId) !== workspaceId ||
        workspaceId !== expectedWorkspaceId
      )
        throw new Error('Current personal Workspace binding changed.');
      recordWorkspaceOwnerMembership({ coreDb: core, ownerUserId: userId, workspaceId, now });
    })
    .immediate();
}

/**
 * Records the initial workspace registry and adds owner membership without reviving removed access.
 * Write intent precedes current-fact reads so concurrent native writes use the bounded Core wait.
 * Membership removal must retain its row with `status = 'removed'`; deleting the row discards the tombstone.
 *
 * @param input Workspace owner membership input.
 * @throws WorkspaceOwnerMembershipRemovedError when the retained owner membership is removed.
 * @throws Error when the owner identity or active membership is contradictory.
 */
export function recordWorkspaceOwnerMembership(input: RecordWorkspaceOwnerMembershipInput): void {
  const now = (input.now ?? new Date()).toISOString();

  input.coreDb.sqlite
    .transaction(() => {
      if (!isCanonicalUserActive(input.coreDb, input.ownerUserId)) {
        throw new Error('Workspace owner requires an active canonical user.');
      }

      const existing = input.coreDb.sqlite
        .prepare('SELECT owner_user_id, status FROM workspace_registry WHERE workspace_id = ?')
        .get(input.workspaceId) as { owner_user_id: string; status: string } | undefined;

      if (existing && existing.owner_user_id !== input.ownerUserId) {
        throw new Error('Workspace is already owned by another user.');
      }
      if (existing && existing.status !== 'active')
        throw new Error('Workspace owner requires an active registry.');

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
    })
    .immediate();
}
