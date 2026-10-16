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
function insertWorkspace(
  coreDb: CoreDb,
  workspaceId: string,
  ownerUserId = 'usr_00000000-0000-7011-88df-c2b1e8466b6f'
): void {
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
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7609-aed5-db4b5c95e76c', 'editor@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'viewer@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7171-af76-f9d024000442', 'removed@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7609-aed5-db4b5c95e76c',
      'editor'
    );
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
      'viewer'
    );
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7171-af76-f9d024000442',
      'editor',
      'removed'
    );

    expect(
      listAuthorizedWorkspaceRegistryFacts(coreDb, 'usr_00000000-0000-7609-aed5-db4b5c95e76c')
    ).toEqual([
      {
        effectiveRole: 'editor',
        membershipRevision: 1,
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        registryRevision: 1,
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      },
    ]);
    expect(listWorkspaceMembers(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d')).toMatchObject([
      {
        effectiveRole: 'editor',
        status: 'active',
        userId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
      },
      {
        effectiveRole: 'owner',
        status: 'active',
        userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      },
      {
        effectiveRole: null,
        status: 'removed',
        userId: 'usr_00000000-0000-7171-af76-f9d024000442',
      },
      {
        effectiveRole: 'viewer',
        status: 'active',
        userId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
      },
    ]);
    expect(
      getWorkspaceAccessRecoveryState(
        coreDb,
        'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8'
      )
    ).toEqual({
      administratorRole: 'viewer',
      ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      registryRevision: 1,
      workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
    });

    coreDb.sqlite
      .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
      .run('2026-07-19T01:00:00.000Z', 'usr_00000000-0000-7609-aed5-db4b5c95e76c');

    expect(
      listAuthorizedWorkspaceRegistryFacts(coreDb, 'usr_00000000-0000-7609-aed5-db4b5c95e76c')
    ).toEqual([]);
    expect(
      getWorkspaceAccessRecoveryState(
        coreDb,
        'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        'usr_00000000-0000-7609-aed5-db4b5c95e76c'
      )
    ).toBeNull();
    expect(
      getWorkspaceAccessRecoveryState(
        coreDb,
        'ws_00000000-0000-7490-845b-dcfa3ee49925',
        'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8'
      )
    ).toBeNull();
  });

  it('creates fixed-expiry invitations and atomically revokes an earlier pending invitation', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'Invitee@Example.com');
    insertUser(coreDb, 'usr_00000000-0000-7d56-82f8-ec994b63859b', 'member@example.com');
    insertUser(
      coreDb,
      'usr_00000000-0000-7e63-b85a-c188de8ee1c3',
      'disabled@example.com',
      'disabled'
    );
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7d56-82f8-ec994b63859b',
      'viewer'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');

    const first = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: ' invitee@example.com ',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    const second = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'INVITEE@example.com',
        now: new Date('2026-07-19T13:00:00.000Z'),
        proposedAccessLevel: 'editor',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );

    expect(first).toMatchObject({
      kind: 'created',
      invitation: {
        effectiveStatus: 'pending',
        expiresAt: '2026-07-26T12:00:00.000Z',
        inviteeUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
      },
    });
    expect(second).toMatchObject({ kind: 'created', invitation: { effectiveStatus: 'pending' } });
    expect(
      listWorkspaceInvitations(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d', now)
    ).toMatchObject([
      { effectiveStatus: 'pending', proposedAccessLevel: 'editor' },
      { effectiveStatus: 'revoked', proposedAccessLevel: 'viewer', revision: 2 },
    ]);
    expect(
      listMyWorkspaceInvitations(coreDb, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', now)
    ).toHaveLength(2);
    expect(
      mutate(coreDb, () =>
        createWorkspaceInvitation({
          coreDb,
          inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          inviteeEmail: 'member@example.com',
          now,
          proposedAccessLevel: 'viewer',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({ kind: 'invitee_unavailable' });
    expect(
      mutate(coreDb, () =>
        createWorkspaceInvitation({
          coreDb,
          inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          inviteeEmail: 'disabled@example.com',
          now,
          proposedAccessLevel: 'viewer',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({ kind: 'invitee_unavailable' });
  });

  it('accepts once, reactivates a tombstone, and classifies terminal, expired, and stale invitations', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'invitee@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7a46-93a0-6f3fc1a9be33', 'stale@example.com');
    insertUser(coreDb, 'usr_00000000-0000-796f-8f66-052d57328c92', 'expired@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
      'viewer',
      'removed'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');
    const acceptedInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'invitee@example.com',
        now,
        proposedAccessLevel: 'editor',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    const staleInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'stale@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    const expiredInvitation = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'expired@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
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
        inviteeUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
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
          inviteeUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
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
          inviteeUserId: 'usr_00000000-0000-7a46-93a0-6f3fc1a9be33',
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
          inviteeUserId: 'usr_00000000-0000-796f-8f66-052d57328c92',
          now: new Date('2026-07-27T12:00:00.000Z'),
        })
      )
    ).toMatchObject({ kind: 'invitation_not_pending', invitation: { effectiveStatus: 'expired' } });
  });

  it.each([
    {
      boundary: 'wrong invitee',
      callerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      disableInvitee: false,
      deactivateWorkspace: false,
    },
    {
      boundary: 'disabled invitee',
      callerUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
      disableInvitee: true,
      deactivateWorkspace: false,
    },
    {
      boundary: 'inactive Workspace',
      callerUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
      disableInvitee: false,
      deactivateWorkspace: true,
    },
  ])('denies invitation acceptance at the $boundary boundary without mutation', ({
    callerUserId,
    deactivateWorkspace,
    disableInvitee,
  }) => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7a9e-8345-2bce44a3dce0', 'invitee@example.com');
    insertUser(coreDb, 'usr_00000000-0000-73d4-904a-d4c4b905df7c', 'other@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const created = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'invitee@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    if (created.kind !== 'created') {
      throw new Error('Expected invitation fixture to be created.');
    }
    if (disableInvitee) {
      coreDb.sqlite
        .prepare("UPDATE users SET status = 'disabled', disabled_at = ? WHERE id = ?")
        .run(now.toISOString(), 'usr_00000000-0000-7a9e-8345-2bce44a3dce0');
    }
    if (deactivateWorkspace) {
      coreDb.sqlite
        .prepare("UPDATE workspace_registry SET status = 'deleting' WHERE workspace_id = ?")
        .run('ws_00000000-0000-7978-8378-5b5c5e93f76d');
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
        .all('ws_00000000-0000-7978-8378-5b5c5e93f76d', 'usr_00000000-0000-7011-88df-c2b1e8466b6f')
    ).toEqual([]);
  });

  it('declines and revokes only one pending invitation revision', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7036-b7d6-6d53799d5d56', 'first@example.com');
    insertUser(coreDb, 'usr_00000000-0000-750e-951f-bebbf278d045', 'second@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const first = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'first@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    const second = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'second@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
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
          inviteeUserId: 'usr_00000000-0000-7036-b7d6-6d53799d5d56',
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
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'revoked', invitation: { effectiveStatus: 'revoked' } });
    expect(
      mutate(coreDb, () =>
        revokeWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: second.invitation.invitationId,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'invitation_not_pending' });
  });

  it('changes, removes, and leaves memberships with owner and revision safeguards', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7609-aed5-db4b5c95e76c', 'editor@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'viewer@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7609-aed5-db4b5c95e76c',
      'editor'
    );
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
      'viewer'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'editor',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
          now,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'unchanged', member: { accessLevel: 'editor', revision: 1 } });
    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'editor',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          now,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'changed', member: { accessLevel: 'editor', revision: 2 } });
    expect(
      mutate(coreDb, () =>
        changeWorkspaceMemberAccess({
          accessLevel: 'viewer',
          coreDb,
          expectedRevision: 1,
          memberUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          now,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 2 } });
    expect(
      mutate(coreDb, () =>
        removeWorkspaceMember({
          coreDb,
          expectedRevision: 1,
          memberUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
          now,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'removed', member: { status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        removeWorkspaceMember({
          coreDb,
          expectedRevision: 2,
          memberUserId: 'usr_00000000-0000-7609-aed5-db4b5c95e76c',
          now,
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 2, status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 2,
          memberUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'removed', member: { status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 3,
          memberUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', member: { revision: 3, status: 'removed' } });
    expect(
      mutate(coreDb, () =>
        leaveWorkspace({
          coreDb,
          expectedRevision: 1,
          memberUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({ kind: 'owner_transfer_required' });
  });

  it('transfers ownership to an active member and promotes a viewer without removing the former owner', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'viewer@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
      'viewer'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          expectedRegistryRevision: 99,
          now,
          targetUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({ kind: 'workspace_access_denied' });
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          expectedRegistryRevision: 1,
          now,
          targetUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({
      kind: 'transferred',
      registry: {
        ownerUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
        registryRevision: 2,
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      },
    });
    expect(listWorkspaceMembers(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d')).toMatchObject([
      {
        accessLevel: 'editor',
        effectiveRole: 'editor',
        userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      },
      {
        accessLevel: 'editor',
        effectiveRole: 'owner',
        revision: 2,
        userId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
      },
    ]);
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          expectedRegistryRevision: 2,
          now,
          targetUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toEqual({
      kind: 'unchanged',
      registry: {
        ownerUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
        registryRevision: 2,
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      },
    });
    expect(
      mutate(coreDb, () =>
        transferWorkspaceOwnership({
          coreDb,
          currentOwnerUserId: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
          expectedRegistryRevision: 1,
          now,
          targetUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', registry: { registryRevision: 2 } });
  });

  it('performs only the two bounded administrator recovery actions with registry CAS', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-768a-8658-44c33d82c1f5', 'admin@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144');
    insertWorkspace(coreDb, 'ws_00000000-0000-7b70-9226-5a63046ecd09');
    insertMember(
      coreDb,
      'ws_00000000-0000-7b70-9226-5a63046ecd09',
      'usr_00000000-0000-768a-8658-44c33d82c1f5',
      'viewer'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144',
        })
      )
    ).toEqual({
      kind: 'recovered',
      recovery: {
        administratorRole: 'editor',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        registryRevision: 2,
        workspaceId: 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 2,
          now,
          workspaceId: 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144',
        })
      )
    ).toEqual({
      kind: 'unchanged',
      recovery: {
        administratorRole: 'editor',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        registryRevision: 2,
        workspaceId: 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_00000000-0000-7b7f-bc69-8dfda4d7e144',
        })
      )
    ).toMatchObject({ kind: 'revision_conflict', recovery: { registryRevision: 2 } });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'transfer-ownership-to-self',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_00000000-0000-7b70-9226-5a63046ecd09',
        })
      )
    ).toEqual({
      kind: 'recovered',
      recovery: {
        administratorRole: 'owner',
        ownerUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
        registryRevision: 2,
        workspaceId: 'ws_00000000-0000-7b70-9226-5a63046ecd09',
      },
    });
    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'transfer-ownership-to-self',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 2,
          now,
          workspaceId: 'ws_00000000-0000-7b70-9226-5a63046ecd09',
        })
      )
    ).toMatchObject({ kind: 'unchanged', recovery: { registryRevision: 2 } });
  });

  it('revokes a pending invitation before recovery reactivates its administrator membership', () => {
    const coreDb = openTestDb();
    insertUser(coreDb, 'usr_00000000-0000-7011-88df-c2b1e8466b6f', 'owner@example.com');
    insertUser(coreDb, 'usr_00000000-0000-768a-8658-44c33d82c1f5', 'admin@example.com');
    insertWorkspace(coreDb, 'ws_00000000-0000-7978-8378-5b5c5e93f76d');
    insertMember(
      coreDb,
      'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      'usr_00000000-0000-768a-8658-44c33d82c1f5',
      'viewer',
      'removed'
    );
    const now = new Date('2026-07-19T12:00:00.000Z');
    const created = mutate(coreDb, () =>
      createWorkspaceInvitation({
        coreDb,
        inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        inviteeEmail: 'admin@example.com',
        now,
        proposedAccessLevel: 'viewer',
        workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
      })
    );
    if (created.kind !== 'created') {
      throw new Error('Expected invitation fixture to be created.');
    }

    expect(
      mutate(coreDb, () =>
        recoverWorkspaceAccess({
          action: 'add-self-as-editor',
          administratorUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          coreDb,
          expectedRegistryRevision: 1,
          now,
          workspaceId: 'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        })
      )
    ).toMatchObject({ kind: 'recovered', recovery: { administratorRole: 'editor' } });
    expect(
      mutate(coreDb, () =>
        acceptWorkspaceInvitation({
          coreDb,
          expectedRevision: 1,
          invitationId: created.invitation.invitationId,
          inviteeUserId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
          now,
        })
      )
    ).toMatchObject({
      kind: 'invitation_not_pending',
      invitation: { effectiveStatus: 'revoked', revision: 2 },
    });
    expect(
      getWorkspaceMember(
        coreDb,
        'ws_00000000-0000-7978-8378-5b5c5e93f76d',
        'usr_00000000-0000-768a-8658-44c33d82c1f5'
      )
    ).toMatchObject({
      accessLevel: 'editor',
      invitationId: null,
      revision: 2,
      status: 'active',
    });
  });
});
