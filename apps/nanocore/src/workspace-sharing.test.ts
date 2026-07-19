import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreDb } from './storage/db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import {
  acceptWorkspaceInvitation,
  changeWorkspaceMemberAccess,
  createWorkspaceInvitation,
  declineWorkspaceInvitation,
  getWorkspaceAccessRecoveryState,
  getWorkspaceMember,
  leaveWorkspace,
  listAuthorizedWorkspaceRegistryFacts,
  listMyWorkspaceInvitations,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  recoverWorkspaceAccess,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  transferWorkspaceOwnership,
} from './workspace-sharing.js';

const openDatabases: CoreDb[] = [];

/** Opens one migrated Core database and records it for cleanup. */
function openTestDb(): CoreDb {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-workspace-sharing-')));
  applyMigrations(coreDb);
  openDatabases.push(coreDb);
  return coreDb;
}

/** Inserts one canonical user with a deterministic lifecycle state. */
function insertUser(
  coreDb: CoreDb,
  userId: string,
  email: string,
  status: 'active' | 'disabled' = 'active'
): void {
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
      ) VALUES (?, ?, ?, false, ?, ?, 'human', ?, ?)`
    )
    .run(
      userId,
      userId,
      email,
      now,
      now,
      status,
      status === 'disabled' ? new Date(now).toISOString() : null
    );
}

/** Inserts one active or removed non-owner membership. */
function insertMember(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string,
  accessLevel: 'editor' | 'viewer',
  status: 'active' | 'removed' = 'active'
): void {
  const now = new Date('2026-07-19T00:00:00.000Z').toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`
    )
    .run(
      workspaceId,
      userId,
      status,
      accessLevel,
      now,
      status === 'removed' ? now : null,
      now,
      now
    );
}

/** Creates one registered Workspace with its active owner membership. */
function insertWorkspace(coreDb: CoreDb, workspaceId: string, ownerUserId = 'user_owner'): void {
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId,
    workspaceId,
    now: new Date('2026-07-19T00:00:00.000Z'),
  });
}

/** Runs one sharing mutation inside the Core transaction required by its contract. */
function mutate<T>(coreDb: CoreDb, operation: () => T): T {
  return coreDb.sqlite.transaction(operation)();
}

afterEach(() => {
  for (const coreDb of openDatabases.splice(0)) {
    coreDb.sqlite.close();
  }
});

describe('Workspace sharing lifecycle', () => {
  it('projects only active canonical-user access, member facts, and safe recovery facts', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_editor', 'editor@example.com');
    insertUser(coreDb, 'user_viewer', 'viewer@example.com');
    insertUser(coreDb, 'user_removed', 'removed@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_editor', 'editor');
    insertMember(coreDb, 'ws_shared', 'user_viewer', 'viewer');
    insertMember(coreDb, 'ws_shared', 'user_removed', 'editor', 'removed');

    expect(listAuthorizedWorkspaceRegistryFacts(coreDb, 'user_editor')).toEqual([
      {
        effectiveRole: 'editor',
        membershipRevision: 1,
        ownerUserId: 'user_owner',
        registryRevision: 1,
        workspaceId: 'ws_shared',
      },
    ]);
    expect(listWorkspaceMembers(coreDb, 'ws_shared')).toMatchObject([
      { effectiveRole: 'editor', status: 'active', userId: 'user_editor' },
      { effectiveRole: 'owner', status: 'active', userId: 'user_owner' },
      { effectiveRole: null, status: 'removed', userId: 'user_removed' },
      { effectiveRole: 'viewer', status: 'active', userId: 'user_viewer' },
    ]);
    expect(getWorkspaceAccessRecoveryState(coreDb, 'ws_shared', 'user_viewer')).toEqual({
      administratorRole: 'viewer',
      ownerUserId: 'user_owner',
      registryRevision: 1,
      workspaceId: 'ws_shared',
    });

    coreDb.sqlite
      .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
      .run('2026-07-19T01:00:00.000Z', 'user_editor');

    expect(listAuthorizedWorkspaceRegistryFacts(coreDb, 'user_editor')).toEqual([]);
    expect(getWorkspaceAccessRecoveryState(coreDb, 'ws_shared', 'user_editor')).toBeNull();
    expect(getWorkspaceAccessRecoveryState(coreDb, 'ws_missing', 'user_viewer')).toBeNull();
  });

  it('creates fixed-expiry invitations and atomically revokes an earlier pending invitation', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_invitee', 'Invitee@Example.com');
    insertUser(coreDb, 'user_member', 'member@example.com');
    insertUser(coreDb, 'user_disabled', 'disabled@example.com', 'disabled');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_member', 'viewer');
    const now = new Date('2026-07-19T12:00:00.000Z');

    const first = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: ' invitee@example.com ',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    const second = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'INVITEE@example.com',
        now: new Date('2026-07-19T13:00:00.000Z'),
        proposedAccessLevel: 'editor',
        workspaceId: 'ws_shared',
      })
    );

    expect(first).toMatchObject({
      kind: 'created',
      invitation: {
        effectiveStatus: 'pending',
        expiresAt: '2026-07-26T12:00:00.000Z',
        inviteeUserId: 'user_invitee',
      },
    });
    expect(second).toMatchObject({ kind: 'created', invitation: { effectiveStatus: 'pending' } });
    expect(listWorkspaceInvitations(coreDb, 'ws_shared', now)).toMatchObject([
      { effectiveStatus: 'pending', proposedAccessLevel: 'editor' },
      { effectiveStatus: 'revoked', proposedAccessLevel: 'viewer', revision: 2 },
    ]);
    expect(listMyWorkspaceInvitations(coreDb, 'user_invitee', now)).toHaveLength(2);
    expect(
      mutate(coreDb, () =>
        createWorkspaceInvitation({
          coreDb,
          inviterUserId: 'user_owner',
          inviteeEmail: 'member@example.com',
          now,
          proposedAccessLevel: 'viewer',
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({ kind: 'invitee_unavailable' });
    expect(
      mutate(coreDb, () =>
        createWorkspaceInvitation({
          coreDb,
          inviterUserId: 'user_owner',
          inviteeEmail: 'disabled@example.com',
          now,
          proposedAccessLevel: 'viewer',
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({ kind: 'invitee_unavailable' });
  });

  it('accepts once, reactivates a tombstone, and classifies terminal, expired, and stale invitations', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_invitee', 'invitee@example.com');
    insertUser(coreDb, 'user_stale', 'stale@example.com');
    insertUser(coreDb, 'user_expired', 'expired@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_invitee', 'viewer', 'removed');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const acceptedInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'invitee@example.com',
        now,
        proposedAccessLevel: 'editor',
        workspaceId: 'ws_shared',
      })
    );
    const staleInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'stale@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    const expiredInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'expired@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    if (
      acceptedInvitation.kind !== 'created' ||
      staleInvitation.kind !== 'created' ||
      expiredInvitation.kind !== 'created'
    ) {
      throw new Error('Expected invitation fixtures to be created.');
    }
    coreDb.sqlite
      .prepare('UPDATE workspace_invitations SET revision = 2 WHERE invitation_id = ?')
      .run(staleInvitation.invitation.invitationId);

    const accepted = mutate(coreDb, () =>
      acceptWorkspaceInvitation({
        coreDb,
        expectedRevision: 1,
        invitationId: acceptedInvitation.invitation.invitationId,
        inviteeUserId: 'user_invitee',
        now,
      })
    );

    expect(accepted).toMatchObject({
      kind: 'accepted',
      invitation: { effectiveStatus: 'accepted', revision: 2 },
      member: { accessLevel: 'editor', revision: 2, status: 'active' },
    });
    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: acceptedInvitation.invitation.invitationId,
          inviteeUserId: 'user_invitee',
          now,
        })
      )
    ).toMatchObject({
      kind: 'invitation_not_pending',
      invitation: { effectiveStatus: 'accepted' },
    });
    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: staleInvitation.invitation.invitationId,
          inviteeUserId: 'user_stale',
          now,
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', invitation: { revision: 2 } });
    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: expiredInvitation.invitation.invitationId,
          inviteeUserId: 'user_expired',
          now: new Date('2026-07-27T12:00:00.000Z'),
        })
      )
    ).toMatchObject({ kind: 'invitation_not_pending', invitation: { effectiveStatus: 'expired' } });
  });

  it.each([
    {
      boundary: 'wrong invitee',
      callerUserId: 'user_other',
      disableInvitee: false,
      deactivateWorkspace: false,
    },
    {
      boundary: 'disabled invitee',
      callerUserId: 'user_invitee',
      disableInvitee: true,
      deactivateWorkspace: false,
    },
    {
      boundary: 'inactive Workspace',
      callerUserId: 'user_invitee',
      disableInvitee: false,
      deactivateWorkspace: true,
    },
  ])('denies invitation acceptance at the $boundary boundary without mutation', ({
    callerUserId,
    deactivateWorkspace,
    disableInvitee,
  }) => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_invitee', 'invitee@example.com');
    insertUser(coreDb, 'user_other', 'other@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const created = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'invitee@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    if (created.kind !== 'created') {
      throw new Error('Expected invitation fixture to be created.');
    }
    if (disableInvitee) {
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run(now.toISOString(), 'user_invitee');
    }
    if (deactivateWorkspace) {
      coreDb.sqlite
        .prepare("UPDATE workspace_registry SET status = 'deleting' WHERE workspace_id = ?")
        .run('ws_shared');
    }

    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: created.invitation.invitationId,
          inviteeUserId: callerUserId,
          now,
        })
      )
    ).toEqual({ kind: 'workspace_access_denied' });
    expect(
      coreDb.sqlite
        .prepare('SELECT status, revision FROM workspace_invitations WHERE invitation_id = ?')
        .get(created.invitation.invitationId)
    ).toEqual({ revision: 1, status: 'pending' });
    expect(
      coreDb.sqlite
        .prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id <> ?')
        .all('ws_shared', 'user_owner')
    ).toEqual([]);
  });

  it('declines and revokes only one pending invitation revision', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_first', 'first@example.com');
    insertUser(coreDb, 'user_second', 'second@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const first = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'first@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    const second = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'second@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    if (first.kind !== 'created' || second.kind !== 'created') {
      throw new Error('Expected invitation fixtures to be created.');
    }

    expect(
      mutate(coreDb, () =>
        declineWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: first.invitation.invitationId,
          inviteeUserId: 'user_first',
          now,
        })
      )
    ).toMatchObject({ kind: 'declined', invitation: { effectiveStatus: 'declined' } });
    expect(
      mutate(coreDb, () =>
        revokeWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: second.invitation.invitationId,
          ownerUserId: 'user_owner',
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'revoked', invitation: { effectiveStatus: 'revoked' } });
    expect(
      mutate(coreDb, () =>
        revokeWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: second.invitation.invitationId,
          ownerUserId: 'user_owner',
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'invitation_not_pending' });
  });

  it('changes, removes, and leaves memberships with owner and revision safeguards', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_editor', 'editor@example.com');
    insertUser(coreDb, 'user_viewer', 'viewer@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_editor', 'editor');
    insertMember(coreDb, 'ws_shared', 'user_viewer', 'viewer');
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'editor',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'user_editor',
          now,
          ownerUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'unchanged', member: { accessLevel: 'editor', revision: 1 } });
    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'editor',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'user_viewer',
          now,
          ownerUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'changed', member: { accessLevel: 'editor', revision: 2 } });
    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'viewer',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'user_viewer',
          now,
          ownerUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 2 } });
    expect(
      mutate(coreDb, () =>
        removeWorkspaceMember({
          coreDb,
          expectedRevision: 1,
          memberUserId: 'user_editor',
          now,
          ownerUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'removed', member: { status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        removeWorkspaceMember({
          coreDb,
          expectedRevision: 2,
          memberUserId: 'user_editor',
          now,
          ownerUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 2, status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 2,
          memberUserId: 'user_viewer',
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'removed', member: { status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 3,
          memberUserId: 'user_viewer',
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 3, status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 1,
          memberUserId: 'user_owner',
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({ kind: 'owner_transfer_required' });
  });

  it('transfers ownership to an active member and promotes a viewer without removing the former owner', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_viewer', 'viewer@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_viewer', 'viewer');
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'user_owner',
          expectedRegistryRevision: 99,
          now,
          targetUserId: 'user_missing',
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({ kind: 'workspace_access_denied' });
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'user_owner',
          expectedRegistryRevision: 1,
          now,
          targetUserId: 'user_viewer',
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({
      kind: 'transferred',
      registry: {
        ownerUserId: 'user_viewer',
        registryRevision: 2,
        workspaceId: 'ws_shared',
      },
    });
    expect(listWorkspaceMembers(coreDb, 'ws_shared')).toMatchObject([
      { accessLevel: 'editor', effectiveRole: 'editor', userId: 'user_owner' },
      { accessLevel: 'editor', effectiveRole: 'owner', revision: 2, userId: 'user_viewer' },
    ]);
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'user_viewer',
          expectedRegistryRevision: 2,
          now,
          targetUserId: 'user_viewer',
          workspaceId: 'ws_shared',
        })
      )
    ).toEqual({
      kind: 'unchanged',
      registry: {
        ownerUserId: 'user_viewer',
        registryRevision: 2,
        workspaceId: 'ws_shared',
      },
    });
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'user_viewer',
          expectedRegistryRevision: 1,
          now,
          targetUserId: 'user_owner',
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', registry: { registryRevision: 2 } });
  });

  it('performs only the two bounded administrator recovery actions with registry CAS', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_admin', 'admin@example.com');
    insertWorkspace(coreDb, 'ws_add');
    insertWorkspace(coreDb, 'ws_transfer');
    insertMember(coreDb, 'ws_transfer', 'user_admin', 'viewer');
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_add',
        })
      )
    ).toEqual({
      kind: 'recovered',
      recovery: {
        administratorRole: 'editor',
        ownerUserId: 'user_owner',
        registryRevision: 2,
        workspaceId: 'ws_add',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 2,
          now,
          workspaceId: 'ws_add',
        })
      )
    ).toEqual({
      kind: 'unchanged',
      recovery: {
        administratorRole: 'editor',
        ownerUserId: 'user_owner',
        registryRevision: 2,
        workspaceId: 'ws_add',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_add',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', recovery: { registryRevision: 2 } });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'transfer-ownership-to-self',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_transfer',
        })
      )
    ).toEqual({
      kind: 'recovered',
      recovery: {
        administratorRole: 'owner',
        ownerUserId: 'user_admin',
        registryRevision: 2,
        workspaceId: 'ws_transfer',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'transfer-ownership-to-self',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 2,
          now,
          workspaceId: 'ws_transfer',
        })
      )
    ).toMatchObject({ kind: 'unchanged', recovery: { registryRevision: 2 } });
  });

  it('revokes a pending invitation before recovery reactivates its administrator membership', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'user_owner', 'owner@example.com');
    insertUser(coreDb, 'user_admin', 'admin@example.com');
    insertWorkspace(coreDb, 'ws_shared');
    insertMember(coreDb, 'ws_shared', 'user_admin', 'viewer', 'removed');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const created = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'user_owner',
        inviteeEmail: 'admin@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_shared',
      })
    );
    if (created.kind !== 'created') {
      throw new Error('Expected invitation fixture to be created.');
    }

    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'user_admin',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_shared',
        })
      )
    ).toMatchObject({ kind: 'recovered', recovery: { administratorRole: 'editor' } });
    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: created.invitation.invitationId,
          inviteeUserId: 'user_admin',
          now,
        })
      )
    ).toMatchObject({
      kind: 'invitation_not_pending',
      invitation: { effectiveStatus: 'revoked', revision: 2 },
    });
    expect(getWorkspaceMember(coreDb, 'ws_shared', 'user_admin')).toMatchObject({
      accessLevel: 'editor',
      invitationId: null,
      revision: 2,
      status: 'active',
    });
  });
});
