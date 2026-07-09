import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { VaultReferenceBackendKind } from './vault-references.js';

/** Durable vault use ownership scopes. */
export type VaultUseOwnerScope = 'server' | 'workspace';

/** Durable vault use backend kinds. */
export type VaultUseBackendKind = VaultReferenceBackendKind;

/** Durable vault use resolution paths. */
export type VaultUseResolvingPath = 'grant' | 'plan' | 'admin' | 'provider';

/** Durable vault use outcomes. */
export type VaultUseOutcome = 'succeeded' | 'failed' | 'denied';

/**
 * Non-secret vault use metadata.
 */
export const vaultUseRecords = sqliteTable(
  'vault_use_records',
  {
    /** Stable vault use id. */
    useId: text('use_id').primaryKey().notNull(),
    /** Scope that owns this use record. */
    ownerScope: text('owner_scope').$type<VaultUseOwnerScope>().notNull(),
    /** Workspace id when the owner scope is workspace. */
    workspaceId: text('workspace_id'),
    /** Vault reference used or attempted. */
    vaultReferenceId: text('vault_reference_id').notNull(),
    /** Secret material version resolved when known. */
    materialVersion: integer('material_version'),
    /** Backend that resolved or attempted the use. */
    backendKind: text('backend_kind').$type<VaultUseBackendKind>().notNull(),
    /** Path that triggered resolution. */
    resolvingPath: text('resolving_path').$type<VaultUseResolvingPath>().notNull(),
    /** Vault grant id when grant-based. */
    grantId: text('grant_id'),
    /** Injection plan id when plan-based. */
    planId: text('plan_id'),
    /** Injection receipt id when receipt-linked. */
    receiptId: text('receipt_id'),
    /** Agent session id when available. */
    agentSessionId: text('agent_session_id'),
    /** Capability call id when available. */
    capabilityCallId: text('capability_call_id'),
    /** Resolution outcome. */
    outcome: text('outcome').$type<VaultUseOutcome>().notNull(),
    /** Failure code for failed or denied use. */
    failureCode: text('failure_code'),
    /** Linked audit event id when available. */
    auditEventId: text('audit_event_id'),
    /** ISO timestamp when use was attempted. */
    usedAt: text('used_at').notNull(),
  },
  (table) => [
    index('vault_use_records_owner_idx').on(table.ownerScope, table.workspaceId, table.outcome),
    index('vault_use_records_reference_idx').on(
      table.vaultReferenceId,
      table.materialVersion,
      table.outcome
    ),
    index('vault_use_records_resolution_idx').on(table.grantId, table.planId, table.receiptId),
    index('vault_use_records_actor_idx').on(table.agentSessionId, table.capabilityCallId),
  ]
);
