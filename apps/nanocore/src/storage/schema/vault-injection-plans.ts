import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable injection visibility classes. */
export type InjectionVisibility =
  | 'gateway-only'
  | 'backend-provider'
  | 'runtime-file'
  | 'runtime-env'
  | 'runtime-token'
  | 'external-handle';

/** Durable injection plan lifecycle statuses. */
export type VaultInjectionPlanStatus = 'active' | 'revoked' | 'expired';

/**
 * Non-secret injection plan metadata.
 */
export const vaultInjectionPlans = sqliteTable(
  'vault_injection_plans',
  {
    /** Stable injection plan id. */
    planId: text('plan_id').primaryKey().notNull(),
    /** Vault grant authorized by this plan. */
    grantId: text('grant_id').notNull(),
    /** Agent Environment Package snapshot id when applicable. */
    packageSnapshotId: text('package_snapshot_id'),
    /** Capability id when applicable. */
    capabilityId: text('capability_id'),
    /** Non-secret injection visibility class. */
    injectionVisibility: text('injection_visibility').$type<InjectionVisibility>().notNull(),
    /** Runtime target path when visible as a file. */
    targetPath: text('target_path'),
    /** Runtime environment variable name when visible as env. */
    targetEnvVarName: text('target_env_var_name'),
    /** Expiration behavior summary. */
    expirationBehavior: text('expiration_behavior').notNull(),
    /** Revocation behavior summary. */
    revocationBehavior: text('revocation_behavior').notNull(),
    /** Redaction rule summary. */
    redactionRule: text('redaction_rule').notNull(),
    /** Backend capability requirement summary. */
    backendCapabilityRequirement: text('backend_capability_requirement').notNull(),
    /** Injection plan lifecycle status. */
    status: text('status').$type<VaultInjectionPlanStatus>().notNull(),
    /** ISO timestamp for plan creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('vault_injection_plans_grant_idx').on(table.grantId, table.status),
    index('vault_injection_plans_capability_idx').on(table.capabilityId, table.status),
  ]
);
