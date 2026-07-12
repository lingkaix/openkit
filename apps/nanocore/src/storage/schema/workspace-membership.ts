import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './better-auth/index.js';

/**
 * Minimal workspace lifecycle states.
 */
export type WorkspaceRegistryStatus = 'active';

/**
 * Minimal workspace membership lifecycle states.
 */
export type WorkspaceMemberStatus = 'active' | 'removed';

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
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Workspace registry status. */
    status: text('status', { enum: ['active'] })
      .$type<WorkspaceRegistryStatus>()
      .notNull(),
    /** ISO timestamp for workspace registration. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest registry update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('workspace_registry_owner_user_id_idx').on(table.ownerUserId)]
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
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Workspace membership status. */
    status: text('status', { enum: ['active', 'removed'] })
      .$type<WorkspaceMemberStatus>()
      .notNull(),
    /** ISO timestamp for membership creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest membership update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('workspace_members_user_id_idx').on(table.userId),
  ]
);
