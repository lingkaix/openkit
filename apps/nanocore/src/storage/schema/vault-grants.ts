import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { VaultReferenceOwnerScope } from './vault-references.js';

/** Durable vault grant owner scopes. */
export type VaultGrantOwnerScope = VaultReferenceOwnerScope;

/** Durable vault grant lifetimes. */
export type VaultGrantLifetime =
  | 'capability-call'
  | 'turn'
  | 'agent-session'
  | 'workspace'
  | 'server';

/** Durable vault grant lifecycle statuses. */
export type VaultGrantStatus = 'active' | 'revoked' | 'expired';

/**
 * Non-secret vault grant metadata.
 */
export const vaultGrants = sqliteTable(
  'vault_grants',
  {
    /** Stable vault grant id. */
    grantId: text('grant_id').primaryKey().notNull(),
    /** Vault reference authorized by this grant. */
    vaultReferenceId: text('vault_reference_id').notNull(),
    /** Scope that owns this grant metadata. */
    ownerScope: text('owner_scope').$type<VaultGrantOwnerScope>().notNull(),
    /** Workspace id when the owner scope is workspace. */
    workspaceId: text('workspace_id'),
    /** User id when the owner scope is user. */
    userId: text('user_id'),
    /** Non-secret subject summary. */
    subjectSummary: text('subject_summary'),
    /** Target agent id when applicable. */
    targetAgentId: text('target_agent_id'),
    /** Target AgentSession id when applicable. */
    targetAgentSessionId: text('target_agent_session_id'),
    /** Target capability id when applicable. */
    targetCapabilityId: text('target_capability_id'),
    /** JSON array of allowed non-secret injection path classes. */
    allowedInjectionPaths: text('allowed_injection_paths').notNull(),
    /** Grant lifetime. */
    lifetime: text('lifetime').$type<VaultGrantLifetime>().notNull(),
    /** Policy decision id that authorized the grant. */
    policyDecisionId: text('policy_decision_id'),
    /** Approval id when human approval authorized the grant. */
    approvalId: text('approval_id'),
    /** Grant lifecycle status. */
    status: text('status').$type<VaultGrantStatus>().notNull(),
    /** ISO timestamp for grant creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp when the grant expires. */
    expiresAt: text('expires_at'),
  },
  (table) => [
    index('vault_grants_reference_idx').on(table.vaultReferenceId, table.status),
    index('vault_grants_owner_idx').on(
      table.ownerScope,
      table.workspaceId,
      table.userId,
      table.status
    ),
    index('vault_grants_lifetime_idx').on(table.lifetime, table.status),
  ]
);
