import type { CoreDb } from './storage/db.js';
import type { InjectionVisibility, VaultInjectionPlanStatus } from './storage/schema/index.js';
import { isTargetIssuedEffectAuthority } from './storage/workspace-import-authority.js';
import { getVaultGrant } from './vault/vault-grants.js';

/** Durable non-secret injection plan record. */
export interface VaultInjectionPlanRecord {
  /** Stable injection plan id. */
  readonly planId: string;
  /** Vault grant authorized by this plan. */
  readonly grantId: string;
  /** Agent Environment Package snapshot id when applicable. */
  readonly packageSnapshotId: string | null;
  /** Capability id when applicable. */
  readonly capabilityId: string | null;
  /** Non-secret injection visibility class. */
  readonly injectionVisibility: InjectionVisibility;
  /** Runtime target path when visible as a file. */
  readonly targetPath: string | null;
  /** Runtime environment variable name when visible as env. */
  readonly targetEnvVarName: string | null;
  /** Expiration behavior summary. */
  readonly expirationBehavior: string;
  /** Revocation behavior summary. */
  readonly revocationBehavior: string;
  /** Redaction rule summary. */
  readonly redactionRule: string;
  /** Backend capability requirement summary. */
  readonly backendCapabilityRequirement: string;
  /** Injection plan lifecycle status. */
  readonly status: VaultInjectionPlanStatus;
  /** ISO timestamp for plan creation. */
  readonly createdAt: string;
}

/** Raw SQLite row for one injection plan. */
interface VaultInjectionPlanRow {
  readonly plan_id: string;
  readonly grant_id: string;
  readonly package_snapshot_id: string | null;
  readonly capability_id: string | null;
  readonly injection_visibility: InjectionVisibility;
  readonly target_path: string | null;
  readonly target_env_var_name: string | null;
  readonly expiration_behavior: string;
  readonly revocation_behavior: string;
  readonly redaction_rule: string;
  readonly backend_capability_requirement: string;
  readonly status: VaultInjectionPlanStatus;
  readonly created_at: string;
}

/** Input used to create one non-secret injection plan. */
export interface CreateVaultInjectionPlanInput {
  /** Stable injection plan id. */
  readonly planId: string;
  /** Vault grant authorized by this plan. */
  readonly grantId: string;
  /** Agent Environment Package snapshot id when applicable. */
  readonly packageSnapshotId?: string | null;
  /** Capability id when applicable. */
  readonly capabilityId?: string | null;
  /** Non-secret injection visibility class. */
  readonly injectionVisibility: InjectionVisibility;
  /** Runtime target path when visible as a file. */
  readonly targetPath?: string | null;
  /** Runtime environment variable name when visible as env. */
  readonly targetEnvVarName?: string | null;
  /** Expiration behavior summary. */
  readonly expirationBehavior: string;
  /** Revocation behavior summary. */
  readonly revocationBehavior: string;
  /** Redaction rule summary. */
  readonly redactionRule: string;
  /** Backend capability requirement summary. */
  readonly backendCapabilityRequirement: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/**
 * Creates one non-secret injection plan idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Plan metadata to store.
 * @returns Stored injection plan record.
 * @throws Error when the referenced grant is imported, missing, or has inconsistent target fields.
 */
export function createVaultInjectionPlan(
  coreDb: CoreDb,
  input: CreateVaultInjectionPlanInput
): VaultInjectionPlanRecord {
  assertVaultInjectionPlanTargets(input);

  if (!isTargetIssuedEffectAuthority(input.grantId)) {
    throw new Error('Vault grant is portable-import history and cannot authorize effects.');
  }

  if (!getVaultGrant(coreDb, input.grantId)) {
    throw new Error(`Vault grant not found: ${input.grantId}`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_injection_plans (
        plan_id,
        grant_id,
        package_snapshot_id,
        capability_id,
        injection_visibility,
        target_path,
        target_env_var_name,
        expiration_behavior,
        revocation_behavior,
        redaction_rule,
        backend_capability_requirement,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.planId,
      input.grantId,
      input.packageSnapshotId ?? null,
      input.capabilityId ?? null,
      input.injectionVisibility,
      input.targetPath ?? null,
      input.targetEnvVarName ?? null,
      input.expirationBehavior,
      input.revocationBehavior,
      input.redactionRule,
      input.backendCapabilityRequirement,
      'active',
      timestamp
    );

  return requireVaultInjectionPlan(coreDb, input.planId);
}

/**
 * Reads one injection plan by id.
 *
 * @param coreDb Open Core database handle.
 * @param planId Injection plan id.
 * @returns Injection plan record, or null.
 */
export function getVaultInjectionPlan(
  coreDb: CoreDb,
  planId: string
): VaultInjectionPlanRecord | null {
  const row = coreDb.sqlite
    .prepare(`${vaultInjectionPlanSelectSql()} WHERE plan_id = ?`)
    .get(planId) as VaultInjectionPlanRow | undefined;

  return row ? mapVaultInjectionPlanRow(row) : null;
}

/**
 * Lists injection plans in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @returns Stored injection plan records.
 */
export function listVaultInjectionPlans(coreDb: CoreDb): VaultInjectionPlanRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${vaultInjectionPlanSelectSql()} ORDER BY created_at ASC, plan_id ASC`)
      .all() as VaultInjectionPlanRow[]
  ).map(mapVaultInjectionPlanRow);
}

/**
 * Lists injection plans linked to exported workspace vault grants.
 *
 * @param coreDb Open Core database handle.
 * @param grantIds Exported grant ids.
 * @returns Exportable non-secret injection plan records.
 */
export function listExportableVaultInjectionPlans(
  coreDb: CoreDb,
  grantIds: readonly string[]
): VaultInjectionPlanRecord[] {
  const grantIdSet = new Set(grantIds);

  return listVaultInjectionPlans(coreDb).filter((plan) => grantIdSet.has(plan.grantId));
}

/**
 * Imports non-secret injection plan records.
 *
 * @param coreDb Open Core database handle.
 * @param plans Imported injection plan records.
 */
export function importVaultInjectionPlans(
  coreDb: CoreDb,
  plans: readonly VaultInjectionPlanRecord[]
): void {
  for (const plan of plans) {
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO vault_injection_plans (
          plan_id,
          grant_id,
          package_snapshot_id,
          capability_id,
          injection_visibility,
          target_path,
          target_env_var_name,
          expiration_behavior,
          revocation_behavior,
          redaction_rule,
          backend_capability_requirement,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.planId,
        plan.grantId,
        plan.packageSnapshotId,
        plan.capabilityId,
        plan.injectionVisibility,
        plan.targetPath,
        plan.targetEnvVarName,
        plan.expirationBehavior,
        plan.revocationBehavior,
        plan.redactionRule,
        plan.backendCapabilityRequirement,
        plan.status,
        plan.createdAt
      );
  }
}

/**
 * Reads one injection plan or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param planId Injection plan id.
 * @returns Injection plan record.
 * @throws Error when the plan does not exist.
 */
function requireVaultInjectionPlan(coreDb: CoreDb, planId: string): VaultInjectionPlanRecord {
  const plan = getVaultInjectionPlan(coreDb, planId);

  if (!plan) {
    throw new Error(`Injection plan not found: ${planId}`);
  }

  return plan;
}

/**
 * Validates injection visibility target fields.
 *
 * @param input Injection plan creation input.
 * @throws Error when target fields are inconsistent.
 */
function assertVaultInjectionPlanTargets(input: CreateVaultInjectionPlanInput): void {
  if (input.injectionVisibility === 'runtime-file' && !input.targetPath) {
    throw new Error('Runtime-file injection plans require targetPath.');
  }

  if (input.injectionVisibility === 'runtime-env' && !input.targetEnvVarName) {
    throw new Error('Runtime-env injection plans require targetEnvVarName.');
  }

  if (
    input.injectionVisibility === 'gateway-only' &&
    (input.targetPath || input.targetEnvVarName)
  ) {
    throw new Error('Gateway-only injection plans cannot include runtime targets.');
  }
}

/**
 * Returns the common injection plan SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
function vaultInjectionPlanSelectSql(): string {
  return `SELECT
    plan_id,
    grant_id,
    package_snapshot_id,
    capability_id,
    injection_visibility,
    target_path,
    target_env_var_name,
    expiration_behavior,
    revocation_behavior,
    redaction_rule,
    backend_capability_requirement,
    status,
    created_at
    FROM vault_injection_plans`;
}

/**
 * Maps one storage row into an injection plan record.
 *
 * @param row SQLite injection plan row.
 * @returns Injection plan record.
 */
function mapVaultInjectionPlanRow(row: VaultInjectionPlanRow): VaultInjectionPlanRecord {
  return {
    backendCapabilityRequirement: row.backend_capability_requirement,
    capabilityId: row.capability_id,
    createdAt: row.created_at,
    expirationBehavior: row.expiration_behavior,
    grantId: row.grant_id,
    injectionVisibility: row.injection_visibility,
    packageSnapshotId: row.package_snapshot_id,
    planId: row.plan_id,
    redactionRule: row.redaction_rule,
    revocationBehavior: row.revocation_behavior,
    status: row.status,
    targetEnvVarName: row.target_env_var_name,
    targetPath: row.target_path,
  };
}
