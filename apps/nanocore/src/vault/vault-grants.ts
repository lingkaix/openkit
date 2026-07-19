import type { CoreDb } from '../storage/db.js';
import type {
  VaultGrantLifetime,
  VaultGrantOwnerScope,
  VaultGrantStatus,
} from '../storage/schema/index.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { getVaultReference } from './vault-references.js';

/** Durable non-secret vault grant record. */
export interface VaultGrantRecord {
  /** Stable vault grant id. */
  readonly grantId: string;
  /** Vault reference authorized by this grant. */
  readonly vaultReferenceId: string;
  /** Scope that owns this grant metadata. */
  readonly ownerScope: VaultGrantOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId: string | null;
  /** User id when ownerScope is user. */
  readonly userId: string | null;
  /** Non-secret subject summary. */
  readonly subjectSummary: string | null;
  /** Target agent id when applicable. */
  readonly targetAgentId: string | null;
  /** Target agent session id when applicable. */
  readonly targetAgentSessionId: string | null;
  /** Target capability id when applicable. */
  readonly targetCapabilityId: string | null;
  /** Allowed non-secret injection path classes. */
  readonly allowedInjectionPaths: string[];
  /** Grant lifetime. */
  readonly lifetime: VaultGrantLifetime;
  /** Policy decision id that authorized the grant. */
  readonly policyDecisionId: string | null;
  /** Approval id when human approval authorized the grant. */
  readonly approvalId: string | null;
  /** Grant lifecycle status. */
  readonly status: VaultGrantStatus;
  /** ISO timestamp for grant creation. */
  readonly createdAt: string;
  /** ISO timestamp when the grant expires. */
  readonly expiresAt: string | null;
}

/** Raw SQLite row for one vault grant. */
interface VaultGrantRow {
  readonly grant_id: string;
  readonly vault_reference_id: string;
  readonly owner_scope: VaultGrantOwnerScope;
  readonly workspace_id: string | null;
  readonly user_id: string | null;
  readonly subject_summary: string | null;
  readonly target_agent_id: string | null;
  readonly target_agent_session_id: string | null;
  readonly target_capability_id: string | null;
  readonly allowed_injection_paths: string;
  readonly lifetime: VaultGrantLifetime;
  readonly policy_decision_id: string | null;
  readonly approval_id: string | null;
  readonly status: VaultGrantStatus;
  readonly created_at: string;
  readonly expires_at: string | null;
}

/** Input used to create one non-secret vault grant. */
export interface CreateVaultGrantInput {
  /** Stable vault grant id. */
  readonly grantId: string;
  /** Vault reference authorized by this grant. */
  readonly vaultReferenceId: string;
  /** Scope that owns this grant. */
  readonly ownerScope: VaultGrantOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string | null;
  /** User id when ownerScope is user. */
  readonly userId?: string | null;
  /** Non-secret subject summary. */
  readonly subjectSummary?: string | null;
  /** Target agent id when applicable. */
  readonly targetAgentId?: string | null;
  /** Target agent session id when applicable. */
  readonly targetAgentSessionId?: string | null;
  /** Target capability id when applicable. */
  readonly targetCapabilityId?: string | null;
  /** Allowed non-secret injection path classes. */
  readonly allowedInjectionPaths: readonly string[];
  /** Grant lifetime. */
  readonly lifetime: VaultGrantLifetime;
  /** Policy decision id that authorized the grant. */
  readonly policyDecisionId?: string | null;
  /** Approval id when human approval authorized the grant. */
  readonly approvalId?: string | null;
  /** ISO timestamp when the grant expires. */
  readonly expiresAt?: string | null;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to revoke one grant and dependent injection state. */
export interface RevokeVaultGrantInput {
  /** Grant to revoke. */
  readonly grantId: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/**
 * Creates one non-secret vault grant idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant metadata to store.
 * @returns Stored vault grant record.
 * @throws Error when the grant id is reserved for imported history or referenced Vault and scope fields are invalid.
 */
export function createVaultGrant(coreDb: CoreDb, input: CreateVaultGrantInput): VaultGrantRecord {
  if (!isTargetIssuedEffectAuthority(input.grantId)) {
    throw new Error('Vault grant id uses the reserved portable-import authority namespace.');
  }

  assertVaultGrantScope(input);
  assertAllowedInjectionPaths(input.allowedInjectionPaths);

  if (!getVaultReference(coreDb, input.vaultReferenceId)) {
    throw new Error(`Vault reference not found: ${input.vaultReferenceId}`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_grants (
        grant_id,
        vault_reference_id,
        owner_scope,
        workspace_id,
        user_id,
        subject_summary,
        target_agent_id,
        target_agent_session_id,
        target_capability_id,
        allowed_injection_paths,
        lifetime,
        policy_decision_id,
        approval_id,
        status,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.grantId,
      input.vaultReferenceId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.userId ?? null,
      input.subjectSummary ?? null,
      input.targetAgentId ?? null,
      input.targetAgentSessionId ?? null,
      input.targetCapabilityId ?? null,
      JSON.stringify([...input.allowedInjectionPaths]),
      input.lifetime,
      input.policyDecisionId ?? null,
      input.approvalId ?? null,
      'active',
      timestamp,
      input.expiresAt ?? null
    );

  return requireVaultGrant(coreDb, input.grantId);
}

/**
 * Revokes one vault grant and marks dependent injection receipts stale.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant revocation input.
 * @returns Revoked grant record.
 * @throws Error when the grant does not exist.
 */
export function revokeVaultGrant(coreDb: CoreDb, input: RevokeVaultGrantInput): VaultGrantRecord {
  requireVaultGrant(coreDb, input.grantId);
  cascadeGrantRevocation(coreDb, input.grantId);

  return requireVaultGrant(coreDb, input.grantId);
}

/**
 * Reads one vault grant by id.
 *
 * @param coreDb Open Core database handle.
 * @param grantId Vault grant id.
 * @returns Vault grant record, or null.
 */
export function getVaultGrant(coreDb: CoreDb, grantId: string): VaultGrantRecord | null {
  const row = coreDb.sqlite.prepare(`${vaultGrantSelectSql()} WHERE grant_id = ?`).get(grantId) as
    | VaultGrantRow
    | undefined;

  return row ? mapVaultGrantRow(row) : null;
}

/**
 * Lists vault grants in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @returns Stored vault grant records.
 */
export function listVaultGrants(coreDb: CoreDb): VaultGrantRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${vaultGrantSelectSql()} ORDER BY created_at ASC, grant_id ASC`)
      .all() as VaultGrantRow[]
  ).map(mapVaultGrantRow);
}

/**
 * Lists workspace-scoped vault grants for portable workspace export.
 *
 * @param coreDb Open Core database handle.
 * @param workspaceId Workspace id to export.
 * @returns Exportable non-secret vault grant records.
 */
export function listExportableWorkspaceVaultGrants(
  coreDb: CoreDb,
  workspaceId: string
): VaultGrantRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `${vaultGrantSelectSql()} WHERE owner_scope = 'workspace' AND workspace_id = ? ORDER BY created_at ASC, grant_id ASC`
      )
      .all(workspaceId) as VaultGrantRow[]
  ).map(mapVaultGrantRow);
}

/**
 * Imports workspace-scoped vault grant records without secret material.
 *
 * @param coreDb Open Core database handle.
 * @param grants Imported grant records.
 */
export function importWorkspaceVaultGrants(
  coreDb: CoreDb,
  grants: readonly VaultGrantRecord[]
): void {
  for (const grant of grants) {
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO vault_grants (
          grant_id,
          vault_reference_id,
          owner_scope,
          workspace_id,
          user_id,
          subject_summary,
          target_agent_id,
          target_agent_session_id,
          target_capability_id,
          allowed_injection_paths,
          lifetime,
          policy_decision_id,
          approval_id,
          status,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        grant.grantId,
        grant.vaultReferenceId,
        grant.ownerScope,
        grant.workspaceId,
        grant.userId,
        grant.subjectSummary,
        grant.targetAgentId,
        grant.targetAgentSessionId,
        grant.targetCapabilityId,
        JSON.stringify(grant.allowedInjectionPaths),
        grant.lifetime,
        grant.policyDecisionId,
        grant.approvalId,
        grant.status,
        grant.createdAt,
        grant.expiresAt
      );
  }
}

/**
 * Reads one vault grant or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param grantId Vault grant id.
 * @returns Vault grant record.
 * @throws Error when the grant does not exist.
 */
function requireVaultGrant(coreDb: CoreDb, grantId: string): VaultGrantRecord {
  const grant = getVaultGrant(coreDb, grantId);

  if (!grant) {
    throw new Error(`Vault grant not found: ${grantId}`);
  }

  return grant;
}

/**
 * Revokes one grant and dependent non-secret injection records.
 *
 * @param coreDb Open Core database handle.
 * @param grantId Grant to revoke.
 */
function cascadeGrantRevocation(coreDb: CoreDb, grantId: string): void {
  coreDb.sqlite
    .prepare("UPDATE vault_grants SET status = 'revoked' WHERE grant_id = ?")
    .run(grantId);
  coreDb.sqlite
    .prepare(
      "UPDATE injection_plans SET status = 'revoked' WHERE grant_id = ? AND status = 'active'"
    )
    .run(grantId);
  coreDb.sqlite
    .prepare(
      "UPDATE injection_receipts SET revocation_status = 'stale-session' WHERE grant_id = ? AND revocation_status = 'active'"
    )
    .run(grantId);
}

/**
 * Validates owner-scope identity fields.
 *
 * @param input Vault grant creation input.
 * @throws Error when scope identity fields are inconsistent.
 */
function assertVaultGrantScope(input: CreateVaultGrantInput): void {
  if (input.ownerScope === 'server' && (input.workspaceId || input.userId)) {
    throw new Error('Server-scoped vault grants cannot include workspaceId or userId.');
  }

  if (input.ownerScope === 'workspace' && !input.workspaceId) {
    throw new Error('Workspace-scoped vault grants require workspaceId.');
  }

  if (input.ownerScope === 'workspace' && input.userId) {
    throw new Error('Workspace-scoped vault grants cannot include userId.');
  }

  if (input.ownerScope === 'user' && !input.userId) {
    throw new Error('User-scoped vault grants require userId.');
  }

  if (input.ownerScope === 'user' && input.workspaceId) {
    throw new Error('User-scoped vault grants cannot include workspaceId.');
  }
}

/**
 * Validates grant injection paths.
 *
 * @param allowedInjectionPaths Injection path classes.
 * @throws Error when no path class is allowed.
 */
function assertAllowedInjectionPaths(allowedInjectionPaths: readonly string[]): void {
  if (allowedInjectionPaths.length === 0) {
    throw new Error('Vault grants require at least one allowed injection path.');
  }
}

/**
 * Returns the common vault grant SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
function vaultGrantSelectSql(): string {
  return `SELECT
    grant_id,
    vault_reference_id,
    owner_scope,
    workspace_id,
    user_id,
    subject_summary,
    target_agent_id,
    target_agent_session_id,
    target_capability_id,
    allowed_injection_paths,
    lifetime,
    policy_decision_id,
    approval_id,
    status,
    created_at,
    expires_at
    FROM vault_grants`;
}

/**
 * Maps one storage row into a vault grant record.
 *
 * @param row SQLite vault grant row.
 * @returns Vault grant record.
 */
function mapVaultGrantRow(row: VaultGrantRow): VaultGrantRecord {
  return {
    allowedInjectionPaths: parseAllowedInjectionPaths(row.allowed_injection_paths),
    approvalId: row.approval_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    grantId: row.grant_id,
    lifetime: row.lifetime,
    ownerScope: row.owner_scope,
    policyDecisionId: row.policy_decision_id,
    status: row.status,
    subjectSummary: row.subject_summary,
    targetAgentId: row.target_agent_id,
    targetAgentSessionId: row.target_agent_session_id,
    targetCapabilityId: row.target_capability_id,
    userId: row.user_id,
    vaultReferenceId: row.vault_reference_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * Parses the stored injection path class list.
 *
 * @param value Stored JSON array.
 * @returns Injection path classes.
 * @throws Error when the stored value is invalid.
 */
function parseAllowedInjectionPaths(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error('Invalid stored vault grant injection paths.');
  }

  return parsed;
}
