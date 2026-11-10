import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable vault reference ownership scopes. */
export type VaultReferenceOwnerScope = 'server' | 'user' | 'workspace';

/** Durable vault reference backend kinds. */
export type VaultReferenceBackendKind = 'encrypted-file';

/** Durable vault reference lifecycle statuses. */
export type VaultReferenceStatus = 'active' | 'revoked' | 'unbound';

/**
 * Non-secret vault reference metadata.
 */
export const vaultReferences = sqliteTable(
  'vault_references',
  {
    /** Stable vault reference id. */
    referenceId: text('reference_id').primaryKey().notNull(),
    /** Scope that owns this reference metadata. */
    ownerScope: text('owner_scope').$type<VaultReferenceOwnerScope>().notNull(),
    /** Workspace id when the owner scope is workspace. */
    workspaceId: text('workspace_id'),
    /** User id when the owner scope is user. */
    userId: text('user_id'),
    /** Non-secret display label. */
    displayName: text('display_name').notNull(),
    /** Non-secret secret kind, such as provider-api-key or repository-token. */
    secretKind: text('secret_kind').notNull(),
    /** Backend that owns the secret material. */
    backendKind: text('backend_kind').$type<VaultReferenceBackendKind>().notNull(),
    /** Redacted backend locator, when a backend needs one. */
    backendLocator: text('backend_locator'),
    /** Reference lifecycle status. */
    status: text('status').$type<VaultReferenceStatus>().notNull(),
    /** Current secret material version known to metadata. */
    currentVersion: integer('current_version').notNull(),
    /** Explicit harness provider; all three Login fields are null for ordinary references. */
    loginProvider: text('login_provider').$type<'codex'>(),
    /** Trusted non-secret provider account equality key, never a public account selector. */
    loginAccountId: text('login_account_id'),
    /** Selection restriction on this User-owned refresh family; not revocation or health. */
    loginQuarantined: integer('login_quarantined', { mode: 'boolean' }),
    /** Bounded correlated native quota evidence; NULL means unknown, never permission. */
    loginObservationsJson: text('login_observations_json'),
    /** ISO timestamp for reference creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for latest metadata update. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('vault_references_owner_idx').on(
      table.ownerScope,
      table.workspaceId,
      table.userId,
      table.status
    ),
    index('vault_references_backend_idx').on(table.backendKind, table.status),
  ]
);
