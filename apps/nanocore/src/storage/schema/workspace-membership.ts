import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { users } from './better-auth/index.js';

/**
 * Minimal workspace lifecycle states.
 */
export type WorkspaceRegistryStatus = 'active' | 'deleting' | 'deleted';

/**
 * Minimal workspace membership lifecycle states.
 */
export type WorkspaceMemberStatus = 'active' | 'removed';

/** Stored access levels for active and removed Workspace memberships. */
export type WorkspaceAccessLevel = 'editor' | 'viewer';

/** Durable invitation lifecycle states. */
export type WorkspaceInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

/**
 * Registers each workspace and its canonical owner user.
 */
export const workspaceRegistry = sqliteTable(
  'workspace_registry',
  {
    /** Stable workspace id. */
    workspaceId: text('workspace_id').primaryKey(),
    /** Canonical user id that owns the workspace. */
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Workspace registry status. */
    status: text('status', { enum: ['active', 'deleting', 'deleted'] })
      .$type<WorkspaceRegistryStatus>()
      .notNull(),
    /** Positive monotonic compare-and-set revision. */
    revision: integer('revision').default(1).notNull(),
    /** ISO timestamp for workspace registration. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest registry update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('workspace_registry_owner_user_id_idx').on(table.ownerUserId),
    check(
      'workspace_registry_status_check',
      sql`${table.status} IN ('active', 'deleting', 'deleted')`
    ),
    check(
      'workspace_registry_revision_check',
      sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0`
    ),
  ]
);

/** Records authenticated invitations to existing users. */
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    /** Stable invitation id. */
    invitationId: text('invitation_id').primaryKey(),
    /** Workspace receiving the invited member. */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaceRegistry.workspaceId, { onDelete: 'cascade' }),
    /** Existing canonical user invited to the Workspace. */
    inviteeUserId: text('invitee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Access proposed by the inviter. */
    proposedAccessLevel: text('proposed_access_level', { enum: ['editor', 'viewer'] })
      .$type<WorkspaceAccessLevel>()
      .notNull(),
    /** Existing canonical user who created the invitation. */
    inviterUserId: text('inviter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Durable invitation lifecycle state. */
    status: text('status', { enum: ['pending', 'accepted', 'declined', 'revoked'] })
      .$type<WorkspaceInvitationStatus>()
      .notNull(),
    /** ISO deadline used to project effective expiry. */
    expiresAt: text('expires_at').notNull(),
    /** ISO acceptance timestamp. */
    acceptedAt: text('accepted_at'),
    /** ISO decline timestamp. */
    declinedAt: text('declined_at'),
    /** ISO revocation timestamp. */
    revokedAt: text('revoked_at'),
    /** Positive monotonic compare-and-set revision. */
    revision: integer('revision').default(1).notNull(),
    /** ISO timestamp for invitation creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest invitation update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('workspace_invitations_workspace_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt
    ),
    index('workspace_invitations_invitee_idx').on(
      table.inviteeUserId,
      table.status,
      table.expiresAt
    ),
    uniqueIndex('workspace_invitations_pending_idx')
      .on(table.workspaceId, table.inviteeUserId)
      .where(sql`${table.status} = 'pending'`),
    check(
      'workspace_invitations_access_check',
      sql`${table.proposedAccessLevel} IN ('editor', 'viewer')`
    ),
    check(
      'workspace_invitations_status_check',
      sql`${table.status} IN ('pending', 'accepted', 'declined', 'revoked')`
    ),
    check(
      'workspace_invitations_revision_check',
      sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0`
    ),
    check(
      'workspace_invitations_terminal_check',
      sql`(
        ${table.status} = 'pending'
        AND ${table.acceptedAt} IS NULL
        AND ${table.declinedAt} IS NULL
        AND ${table.revokedAt} IS NULL
      ) OR (
        ${table.status} = 'accepted'
        AND ${table.acceptedAt} IS NOT NULL
        AND ${table.declinedAt} IS NULL
        AND ${table.revokedAt} IS NULL
      ) OR (
        ${table.status} = 'declined'
        AND ${table.acceptedAt} IS NULL
        AND ${table.declinedAt} IS NOT NULL
        AND ${table.revokedAt} IS NULL
      ) OR (
        ${table.status} = 'revoked'
        AND ${table.acceptedAt} IS NULL
        AND ${table.declinedAt} IS NULL
        AND ${table.revokedAt} IS NOT NULL
      )`
    ),
  ]
);

/**
 * Records the canonical users attached to each workspace.
 */
export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    /** Workspace id for the membership edge. */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaceRegistry.workspaceId, { onDelete: 'cascade' }),
    /** Canonical user id attached to the workspace. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Workspace membership status. */
    status: text('status', { enum: ['active', 'removed'] })
      .$type<WorkspaceMemberStatus>()
      .notNull(),
    /** Stored non-owner access level; owners retain editor. */
    accessLevel: text('access_level', { enum: ['editor', 'viewer'] })
      .$type<WorkspaceAccessLevel>()
      .notNull(),
    /** Invitation that most recently admitted this member. */
    invitationId: text('invitation_id').references(() => workspaceInvitations.invitationId, {
      onDelete: 'no action',
    }),
    /** ISO timestamp for the first successful membership admission. */
    joinedAt: text('joined_at').notNull(),
    /** ISO timestamp for membership removal. */
    removedAt: text('removed_at'),
    /** Positive monotonic compare-and-set revision. */
    revision: integer('revision').default(1).notNull(),
    /** ISO timestamp for membership creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest membership update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_members_user_id_idx').on(table.userId, table.status, table.workspaceId),
    check('workspace_members_status_check', sql`${table.status} IN ('active', 'removed')`),
    check('workspace_members_access_check', sql`${table.accessLevel} IN ('editor', 'viewer')`),
    check(
      'workspace_members_revision_check',
      sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0`
    ),
    check(
      'workspace_members_lifecycle_check',
      sql`(${table.status} = 'active' AND ${table.removedAt} IS NULL) OR (${table.status} = 'removed' AND ${table.removedAt} IS NOT NULL)`
    ),
  ]
);
