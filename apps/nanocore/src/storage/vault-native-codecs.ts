import { InjectionVisibilitySchema, VAULT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  AgentEnvironmentCredentialDeclarationSchema,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import {
  ActorRefSchema,
  AuditEventSchema,
  isEntityId,
  PolicyDigestV1Schema,
  PolicyDocumentV1Schema,
  PolicyResourceV1Schema,
  PolicySubjectV1Schema,
  RequestIdSchema,
  readRetainedV1,
} from '@openkit/protocol';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import type {
  InjectionVisibility,
  VaultGrantLifetime,
  VaultGrantOwnerScope,
  VaultGrantStatus,
  VaultInjectionPlanStatus,
  VaultInjectionReceiptRevocationStatus,
  VaultReferenceBackendKind,
  VaultReferenceOwnerScope,
  VaultReferenceStatus,
  VaultUseBackendKind,
  VaultUseOutcome,
  VaultUseOwnerScope,
  VaultUseResolvingPath,
} from './schema/index.js';

/** Explicit metadata on one User-owned harness refresh family; no material or use authority. */
export interface HarnessLoginMetadata {
  /** Harness-own subscription provider; Gateway accounts retain their separate contract. */
  readonly provider: 'codex';
  /** Trusted provider-scoped non-secret equality identity, never a public account hint. */
  readonly accountId: string;
  /** Selection restriction only, independent of lifecycle status and material version. */
  readonly quarantined: boolean;
  /** Bounded native evidence; absent/null is unknown and never a grant. */
  readonly observations?: HarnessLoginObservations | null | undefined;
}

/** Canonical private quota facts, stamped by the existing native reference owner. */
export type HarnessLoginObservations = z.infer<typeof HarnessLoginObservationsSchema>;

/** Durable non-secret vault reference record. */
export interface VaultReferenceRecord {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Scope that owns this vault reference metadata. */
  readonly ownerScope: VaultReferenceOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId: string | null;
  /** User id when ownerScope is user. */
  readonly userId: string | null;
  /** Non-secret display label. */
  readonly displayName: string;
  /** Non-secret secret kind. */
  readonly secretKind: string;
  /** Backend that owns secret material. */
  readonly backendKind: VaultReferenceBackendKind;
  /** Redacted backend locator. */
  readonly backendLocator: string | null;
  /** Reference lifecycle status. */
  readonly status: VaultReferenceStatus;
  /** Current material version known to metadata. */
  readonly currentVersion: number;
  /** Explicit harness Login subtype; ordinary references omit it. */
  readonly login?: HarnessLoginMetadata | undefined;
  /** ISO timestamp for reference creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest metadata update. */
  readonly updatedAt: string;
}

/** Raw SQLite row for one vault reference. */
export interface VaultReferenceRow {
  readonly reference_id: string;
  readonly owner_scope: VaultReferenceOwnerScope;
  readonly workspace_id: string | null;
  readonly user_id: string | null;
  readonly display_name: string;
  readonly secret_kind: string;
  readonly backend_kind: VaultReferenceBackendKind;
  readonly backend_locator: string | null;
  readonly status: VaultReferenceStatus;
  readonly current_version: number;
  readonly login_provider: string | null;
  readonly login_account_id: string | null;
  readonly login_quarantined: number | null;
  readonly login_observations_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Input used to create one non-secret vault reference. */
export interface CreateVaultReferenceInput {
  /** Stable vault reference id. */
  readonly referenceId: string;
  /** Scope that owns this reference. */
  readonly ownerScope: VaultReferenceOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string | null;
  /** User id when ownerScope is user. */
  readonly userId?: string | null;
  /** Non-secret display label. */
  readonly displayName: string;
  /** Non-secret secret kind. */
  readonly secretKind: string;
  /** Backend that owns secret material. */
  readonly backendKind: VaultReferenceBackendKind;
  /** Redacted backend locator. */
  readonly backendLocator?: string | null;
  /** Trusted explicit User harness subtype; no public metadata setter initializes it. */
  readonly login?: HarnessLoginMetadata;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Result of idempotently creating one non-secret vault reference. */
export interface CreateVaultReferenceResult {
  /** True only when this call inserted the stored reference. */
  readonly inserted: boolean;
  /** Exact stored vault reference record. */
  readonly reference: VaultReferenceRecord;
}

/** Input used to advance one active vault reference's material version. */
export interface AdvanceActiveVaultReferenceVersionInput {
  /** Reference whose material version should advance. */
  readonly referenceId: string;
  /** Exact stored or next material version reported by the backend. */
  readonly currentVersion: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to import one workspace-scoped unbound vault reference. */
export interface ImportUnboundWorkspaceVaultReferenceInput {
  /** Stable imported vault reference id. */
  readonly referenceId: string;
  /** Target workspace that owns this reference. */
  readonly workspaceId: string;
  /** Non-secret display label. */
  readonly displayName: string;
  /** Non-secret secret kind. */
  readonly secretKind: string;
  /** Source backend kind retained only as non-secret metadata. */
  readonly backendKind: VaultReferenceBackendKind;
  /** Optional deterministic timestamp. */
  readonly now?: () => string;
}

/** Input used to revoke one vault reference and dependent grant state. */
export interface RevokeVaultReferenceInput {
  /** Reference to revoke. */
  readonly referenceId: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to bind local material to one imported workspace vault reference. */
export interface RebindWorkspaceVaultReferenceInput {
  /** Workspace that owns the reference. */
  readonly workspaceId: string;
  /** Reference to bind. */
  readonly referenceId: string;
  /** Backend that now owns local secret material. */
  readonly backendKind: VaultReferenceBackendKind;
  /** Redacted backend locator. */
  readonly backendLocator: string;
  /** Current material version returned by the backend. */
  readonly currentVersion: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/**
 * Reads one vault reference by id.
 *
 * @param coreDb Open Core database handle.
 * @param referenceId Vault reference id.
 * @returns Vault reference record, or null.
 */
export function getVaultReference(
  coreDb: CoreDb,
  referenceId: string
): VaultReferenceRecord | null {
  const row = coreDb.sqlite
    .prepare(`${vaultReferenceSelectSql()} WHERE reference_id = ?`)
    .get(referenceId) as VaultReferenceRow | undefined;

  return row ? mapVaultReferenceRow(row) : null;
}

/**
 * Lists vault references in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @returns Stored vault reference records.
 */
export function listVaultReferences(coreDb: CoreDb): VaultReferenceRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${vaultReferenceSelectSql()} ORDER BY created_at ASC, reference_id ASC`)
      .all() as VaultReferenceRow[]
  ).map(mapVaultReferenceRow);
}

/**
 * Lists workspace-owned vault references in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @param workspaceId Workspace id whose references should be listed.
 * @returns Stored workspace vault reference records.
 */
export function listWorkspaceVaultReferences(
  coreDb: CoreDb,
  workspaceId: string
): VaultReferenceRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `${vaultReferenceSelectSql()}
        WHERE owner_scope = 'workspace' AND workspace_id = ?
        ORDER BY created_at ASC, reference_id ASC`
      )
      .all(workspaceId) as VaultReferenceRow[]
  ).map(mapVaultReferenceRow);
}

/**
 * Lists only the named User's references in the existing deterministic inventory order.
 *
 * @param coreDb Open Core database handle.
 * @param userId Exact canonical User owner.
 * @returns That User's non-secret reference metadata.
 */
export function listUserVaultReferences(coreDb: CoreDb, userId: string): VaultReferenceRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${vaultReferenceSelectSql()}
    WHERE owner_scope = 'user' AND user_id = ? ORDER BY created_at ASC, reference_id ASC`)
      .all(userId) as VaultReferenceRow[]
  ).map(mapVaultReferenceRow);
}

/**
 * Reads one vault reference or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param referenceId Vault reference id.
 * @returns Vault reference record.
 * @throws Error when the reference does not exist.
 */
export function requireVaultReference(coreDb: CoreDb, referenceId: string): VaultReferenceRecord {
  const reference = getVaultReference(coreDb, referenceId);

  if (!reference) {
    throw new Error(`Vault reference not found: ${referenceId}`);
  }

  return reference;
}

/**
 * Validates owner-scope identity fields.
 *
 * @param input Vault reference creation input.
 * @throws Error when scope identity fields are inconsistent.
 */
export function assertVaultReferenceScope(input: CreateVaultReferenceInput): void {
  if (!isEntityId('vault', input.referenceId))
    throw new Error('Vault reference identity must use the canonical vault kind.');
  if (input.ownerScope === 'server' && (input.workspaceId || input.userId)) {
    throw new Error('Server-scoped vault references cannot include workspaceId or userId.');
  }

  if (input.ownerScope === 'workspace' && !input.workspaceId) {
    throw new Error('Workspace-scoped vault references require workspaceId.');
  }

  if (input.ownerScope === 'workspace' && input.userId) {
    throw new Error('Workspace-scoped vault references cannot include userId.');
  }

  if (input.ownerScope === 'user' && !input.userId) {
    throw new Error('User-scoped vault references require userId.');
  }

  if (input.ownerScope === 'user' && input.workspaceId) {
    throw new Error('User-scoped vault references cannot include workspaceId.');
  }
  if (input.login) {
    HarnessLoginMetadataSchema.parse(input.login);
    if (input.ownerScope !== 'user' || !isEntityId('usr', input.userId))
      throw new Error('Harness Logins require a canonical User-owned reference.');
  }
}

/**
 * Returns the common vault reference SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
export function vaultReferenceSelectSql(): string {
  return `SELECT
    reference_id,
    owner_scope,
    workspace_id,
    user_id,
    display_name,
    secret_kind,
    backend_kind,
    backend_locator,
    status,
    current_version,
    login_provider,
    login_account_id,
    login_quarantined,
    login_observations_json,
    created_at,
    updated_at
    FROM vault_references`;
}

/**
 * Maps one storage row into a vault reference record.
 *
 * @param row SQLite vault reference row.
 * @returns Vault reference record.
 */
export function mapVaultReferenceRow(row: VaultReferenceRow): VaultReferenceRecord {
  if (!isEntityId('vault', row.reference_id))
    throw new Error('Invalid canonical Vault reference identity.');
  const ordinary =
    row.login_provider === null && row.login_account_id === null && row.login_quarantined === null;
  if (ordinary && row.login_observations_json != null)
    throw new Error('Ordinary Vault references cannot carry Login observations.');
  if (!ordinary && row.login_quarantined !== 0 && row.login_quarantined !== 1)
    throw new Error('Invalid retained harness Login metadata.');
  const login = ordinary
    ? undefined
    : HarnessLoginMetadataSchema.parse({
        provider: row.login_provider,
        accountId: row.login_account_id,
        quarantined: row.login_quarantined === 1,
        ...(row.login_observations_json == null
          ? {}
          : {
              observations: readRetainedV1(JSON.parse(row.login_observations_json), (record) => {
                const { schemaVersion: _schemaVersion, ...observations } = record as Record<
                  string,
                  unknown
                >;
                return HarnessLoginObservationsSchema.parse(observations);
              }),
            }),
      });
  if (
    login &&
    (row.owner_scope !== 'user' || row.workspace_id !== null || !isEntityId('usr', row.user_id))
  )
    throw new Error('Harness Logins require a canonical User-owned reference.');
  return {
    ...(login ? { login } : {}),
    backendKind: row.backend_kind,
    backendLocator: row.backend_locator,
    createdAt: row.created_at,
    currentVersion: row.current_version,
    displayName: row.display_name,
    ownerScope: row.owner_scope,
    referenceId: row.reference_id,
    secretKind: row.secret_kind,
    status: row.status,
    updatedAt: row.updated_at,
    userId: row.user_id,
    workspaceId: row.workspace_id,
  };
}

/** Durable non-secret vault grant record. */
export interface VaultGrantRecord {
  /** Stable vault grant id. */
  readonly grantId: string;
  /** Immutable issuance provenance; imported history never authorizes target effects. */
  readonly issuance: 'target' | 'imported-history';
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
  /** Target AgentSession id when applicable. */
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
export interface VaultGrantRow {
  readonly schemaVersion: unknown;
  readonly grant_id: string;
  readonly issuance: 'target' | 'imported-history';
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
  /** Target AgentSession id when applicable. */
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

/** Constraints that can only reduce an existing grant's authority. */
export interface NarrowVaultGrantConstraints {
  /** Exact Agent restriction, added only when previously unconstrained. */
  readonly targetAgentId?: string | undefined;
  /** Exact AgentSession restriction, added only when previously unconstrained. */
  readonly targetAgentSessionId?: string | undefined;
  /** Exact capability restriction, added only when previously unconstrained. */
  readonly targetCapabilityId?: string | undefined;
  /** Non-empty subset of the original visibility classes. */
  readonly allowedInjectionPaths?: readonly string[] | undefined;
  /** Canonical future timestamp no later than the original bound. */
  readonly expiresAt?: string | undefined;
}

/** A redacted grant-narrowing refusal that the public owner can classify. */
export class VaultGrantNarrowingError extends Error {
  /** Classifies invalid constraints separately from unavailable current authority. */
  constructor(readonly status: 400 | 409) {
    super(
      status === 400
        ? 'Grant constraints do not strictly reduce authority.'
        : 'Grant authority is not current.'
    );
    this.name = 'VaultGrantNarrowingError';
  }
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
 * Reads one vault grant or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param grantId Vault grant id.
 * @returns Vault grant record.
 * @throws Error when the grant does not exist.
 */
export function requireVaultGrant(coreDb: CoreDb, grantId: string): VaultGrantRecord {
  const grant = getVaultGrant(coreDb, grantId);

  if (!grant) {
    throw new Error(`Vault grant not found: ${grantId}`);
  }

  return grant;
}

/**
 * Validates owner-scope identity fields.
 *
 * @param input Vault grant creation input.
 * @throws Error when scope identity fields are inconsistent.
 */
export function assertVaultGrantScope(input: CreateVaultGrantInput): void {
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
export function assertAllowedInjectionPaths(allowedInjectionPaths: readonly string[]): void {
  if (allowedInjectionPaths.length === 0) {
    throw new Error('Vault grants require at least one allowed injection path.');
  }
}

/**
 * Returns the common vault grant SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
export function vaultGrantSelectSql(): string {
  return `SELECT schema_version AS schemaVersion,
    grant_id,
    issuance,
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
export function mapVaultGrantRow(row: VaultGrantRow): VaultGrantRecord {
  readRetainedV1(row, () => undefined);
  if (!isEntityId('grant', row.grant_id) || !isEntityId('vault', row.vault_reference_id))
    throw new Error('Invalid canonical VaultGrant identity.');
  assertIssuance(row.issuance);
  return {
    issuance: row.issuance,
    allowedInjectionPaths: parseAllowedInjectionPathsV1(row.allowed_injection_paths),
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
 * Parses the fixed v1 injection-path payload independently from current request schemas.
 *
 * @param value Stored JSON array.
 * @returns Injection path classes.
 * @throws Error when the stored value is invalid.
 */
export function parseAllowedInjectionPathsV1(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error('Invalid stored vault grant injection paths.');
  }

  return parsed;
}

/** Fails closed rather than assigning target authority to missing or unknown retained provenance. */
export function assertIssuance(value: unknown): asserts value is VaultGrantRecord['issuance'] {
  if (value !== 'target' && value !== 'imported-history')
    throw new Error('Invalid canonical VaultGrant issuance.');
}

/** Database handle that can store vault use records. */
export type VaultUseDb = CoreDb | WorkspaceDb;

/** Durable non-secret vault use record. */
export interface VaultUseRecord {
  /** Stable vault use id. */
  readonly useId: string;
  /** Scope that owns this use record. */
  readonly ownerScope: VaultUseOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId: string | null;
  /** Vault reference used or attempted. */
  readonly vaultReferenceId: string;
  /** Secret material version resolved when known. */
  readonly materialVersion: number | null;
  /** Backend that resolved or attempted the use. */
  readonly backendKind: VaultUseBackendKind;
  /** Path that triggered resolution. */
  readonly resolvingPath: VaultUseResolvingPath;
  /** Vault grant id when grant-based. */
  readonly grantId: string | null;
  /** Injection plan id when plan-based. */
  readonly planId: string | null;
  /** Injection receipt id when receipt-linked. */
  readonly receiptId: string | null;
  /** AgentSession id when available. */
  readonly agentSessionId: string | null;
  /** Capability call id when available. */
  readonly capabilityCallId: string | null;
  /** Resolution outcome. */
  readonly outcome: VaultUseOutcome;
  /** Failure code for failed or denied use. */
  readonly failureCode: string | null;
  /** Linked audit event id when available. */
  readonly auditEventId: string | null;
  /** ISO timestamp when use was attempted. */
  readonly usedAt: string;
}

/** Raw SQLite row for one vault use. */
export interface VaultUseRow {
  readonly use_id: string;
  readonly owner_scope: VaultUseOwnerScope;
  readonly workspace_id: string | null;
  readonly vault_reference_id: string;
  readonly material_version: number | null;
  readonly backend_kind: VaultUseBackendKind;
  readonly resolving_path: VaultUseResolvingPath;
  readonly grant_id: string | null;
  readonly plan_id: string | null;
  readonly receipt_id: string | null;
  readonly agent_session_id: string | null;
  readonly capability_call_id: string | null;
  readonly outcome: VaultUseOutcome;
  readonly failure_code: string | null;
  readonly audit_event_id: string | null;
  readonly used_at: string;
}

/** Input used to create one non-secret vault use record. */
export interface CreateVaultUseRecordInput {
  /** Stable vault use id. */
  readonly useId: string;
  /** Scope that owns this use record. */
  readonly ownerScope: VaultUseOwnerScope;
  /** Workspace id when ownerScope is workspace. */
  readonly workspaceId?: string | null;
  /** Vault reference used or attempted. */
  readonly vaultReferenceId: string;
  /** Secret material version resolved when known. */
  readonly materialVersion?: number | null;
  /** Backend that resolved or attempted the use. */
  readonly backendKind: VaultUseBackendKind;
  /** Path that triggered resolution. */
  readonly resolvingPath: VaultUseResolvingPath;
  /** Vault grant id when grant-based. */
  readonly grantId?: string | null;
  /** Injection plan id when plan-based. */
  readonly planId?: string | null;
  /** Injection receipt id when receipt-linked. */
  readonly receiptId?: string | null;
  /** AgentSession id when available. */
  readonly agentSessionId?: string | null;
  /** Capability call id when available. */
  readonly capabilityCallId?: string | null;
  /** Resolution outcome. */
  readonly outcome: VaultUseOutcome;
  /** Failure code for failed or denied use. */
  readonly failureCode?: string | null;
  /** Linked audit event id when available. */
  readonly auditEventId?: string | null;
  /** ISO timestamp when use was attempted. */
  readonly usedAt: string;
}

/**
 * Reads one vault use record by id.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param useId Vault use id.
 * @returns Vault use record, or null.
 */
export function getVaultUseRecord(db: VaultUseDb, useId: string): VaultUseRecord | null {
  const row = db.sqlite.prepare(`${vaultUseSelectSql()} WHERE use_id = ?`).get(useId) as
    | VaultUseRow
    | undefined;

  return row ? mapVaultUseRow(row) : null;
}

/**
 * Lists vault use records in deterministic order.
 *
 * @param db Server- or workspace-scoped database handle.
 * @returns Stored vault use records.
 */
export function listVaultUseRecords(db: VaultUseDb): VaultUseRecord[] {
  return (
    db.sqlite
      .prepare(`${vaultUseSelectSql()} ORDER BY used_at ASC, use_id ASC`)
      .all() as VaultUseRow[]
  ).map(mapVaultUseRow);
}

/**
 * Lists workspace-scoped vault use records for portable workspace export.
 *
 * @param db Workspace database handle.
 * @param workspaceId Workspace id to export.
 * @returns Exportable non-secret vault use records.
 */
export function listExportableWorkspaceVaultUseRecords(
  db: WorkspaceDb,
  workspaceId: string
): VaultUseRecord[] {
  return (
    db.sqlite
      .prepare(
        `${vaultUseSelectSql()} WHERE owner_scope = 'workspace' AND workspace_id = ? ORDER BY used_at ASC, use_id ASC`
      )
      .all(workspaceId) as VaultUseRow[]
  ).map(mapVaultUseRow);
}

/**
 * Reads one vault use record or throws a readable error.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param useId Vault use id.
 * @returns Vault use record.
 * @throws Error when the record does not exist.
 */
export function requireVaultUseRecord(db: VaultUseDb, useId: string): VaultUseRecord {
  const record = getVaultUseRecord(db, useId);

  if (!record) {
    throw new Error(`Vault use record not found: ${useId}`);
  }

  return record;
}

/**
 * Validates vault use owner-scope identity fields.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param input Vault use creation input.
 * @throws Error when scope identity fields are inconsistent.
 */
export function assertVaultUseScope(db: VaultUseDb, input: CreateVaultUseRecordInput): void {
  if (input.ownerScope === 'server' && input.workspaceId) {
    throw new Error('Server-scoped vault use records cannot include workspaceId.');
  }

  if (input.ownerScope === 'workspace' && !input.workspaceId) {
    throw new Error('Workspace-scoped vault use records require workspaceId.');
  }

  if (db.scope === 'workspace' && input.ownerScope !== db.scope) {
    throw new Error('Workspace database can only store workspace-scoped vault use records.');
  }

  if ('workspaceId' in db && input.workspaceId && input.workspaceId !== db.workspaceId) {
    throw new Error('Workspace-scoped vault use records must match the database workspaceId.');
  }
}

/**
 * Validates vault use resolution fields.
 *
 * @param input Vault use creation input.
 * @throws Error when resolution fields are inconsistent.
 */
export function assertVaultUseResolution(input: CreateVaultUseRecordInput): void {
  if (input.outcome === 'succeeded' && input.materialVersion == null) {
    throw new Error('Successful vault use records require materialVersion.');
  }

  if (input.outcome !== 'succeeded' && !input.failureCode) {
    throw new Error('Failed or denied vault use records require failureCode.');
  }

  if (input.resolvingPath === 'grant' && !input.grantId) {
    throw new Error('Grant-based vault use records require grantId.');
  }

  if (input.resolvingPath === 'plan' && !input.planId) {
    throw new Error('Plan-based vault use records require planId.');
  }
}

/**
 * Returns the common vault use SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
export function vaultUseSelectSql(): string {
  return `SELECT
    use_id,
    owner_scope,
    workspace_id,
    vault_reference_id,
    material_version,
    backend_kind,
    resolving_path,
    grant_id,
    plan_id,
    receipt_id,
    agent_session_id,
    capability_call_id,
    outcome,
    failure_code,
    audit_event_id,
    used_at
    FROM vault_use_records`;
}

/**
 * Maps one storage row into a vault use record.
 *
 * @param row SQLite vault use row.
 * @returns Vault use record.
 */
export function mapVaultUseRow(row: VaultUseRow): VaultUseRecord {
  const record: VaultUseRecord = {
    agentSessionId: row.agent_session_id,
    auditEventId: row.audit_event_id,
    backendKind: row.backend_kind,
    capabilityCallId: row.capability_call_id,
    failureCode: row.failure_code,
    grantId: row.grant_id,
    materialVersion: row.material_version,
    outcome: row.outcome,
    ownerScope: row.owner_scope,
    planId: row.plan_id,
    receiptId: row.receipt_id,
    resolvingPath: row.resolving_path,
    usedAt: row.used_at,
    useId: row.use_id,
    vaultReferenceId: row.vault_reference_id,
    workspaceId: row.workspace_id,
  };
  assertVaultUseIdentifiers(record);
  return record;
}

/** Checks only the named entity links; plan and receipt selectors retain their owners. */
export function assertVaultUseIdentifiers(record: CreateVaultUseRecordInput): void {
  if (
    !isEntityId('vu', record.useId) ||
    !isEntityId('vault', record.vaultReferenceId) ||
    (
      [
        ['ws', record.workspaceId],
        ['grant', record.grantId],
        ['as', record.agentSessionId],
        ['cap', record.capabilityCallId],
        ['aud', record.auditEventId],
      ] as const
    ).some(([kind, id]) => id != null && !isEntityId(kind, id))
  ) {
    throw new Error('VaultUse identifiers are not canonical.');
  }
}

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
export interface VaultInjectionPlanRow {
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
 * Reads one injection plan or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param planId Injection plan id.
 * @returns Injection plan record.
 * @throws Error when the plan does not exist.
 */
export function requireVaultInjectionPlan(
  coreDb: CoreDb,
  planId: string
): VaultInjectionPlanRecord {
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
export function assertVaultInjectionPlanTargets(input: CreateVaultInjectionPlanInput): void {
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
export function vaultInjectionPlanSelectSql(): string {
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
export function mapVaultInjectionPlanRow(row: VaultInjectionPlanRow): VaultInjectionPlanRecord {
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

/** Durable non-secret injection receipt record. */
export interface VaultInjectionReceiptRecord {
  /** Stable injection receipt id. */
  readonly receiptId: string;
  /** Injection plan used by this receipt. */
  readonly planId: string;
  /** Vault grant used by this receipt. */
  readonly grantId: string;
  /** AgentSession id when the receipt belongs to an AgentSession. */
  readonly agentSessionId: string | null;
  /** Capability call id when the receipt belongs to one capability call. */
  readonly capabilityCallId: string | null;
  /** Redacted backend summary. */
  readonly backendSummary: string;
  /** ISO timestamp when injection happened. */
  readonly injectedAt: string;
  /** ISO timestamp when injected material expires. */
  readonly expiresAt: string | null;
  /** Revocation status projection. */
  readonly revocationStatus: VaultInjectionReceiptRevocationStatus;
  /** Linked audit event id when available. */
  readonly auditEventId: string | null;
}

/** Raw SQLite row for one injection receipt. */
export interface VaultInjectionReceiptRow {
  readonly receipt_id: string;
  readonly plan_id: string;
  readonly grant_id: string;
  readonly agent_session_id: string | null;
  readonly capability_call_id: string | null;
  readonly backend_summary: string;
  readonly injected_at: string;
  readonly expires_at: string | null;
  readonly revocation_status: VaultInjectionReceiptRevocationStatus;
  readonly audit_event_id: string | null;
}

/** Input used to create one non-secret injection receipt. */
export interface CreateVaultInjectionReceiptInput {
  /** Stable injection receipt id. */
  readonly receiptId: string;
  /** Injection plan used by this receipt. */
  readonly planId: string;
  /** Vault grant used by this receipt. */
  readonly grantId: string;
  /** AgentSession id when the receipt belongs to an AgentSession. */
  readonly agentSessionId?: string | null;
  /** Capability call id when the receipt belongs to one capability call. */
  readonly capabilityCallId?: string | null;
  /** Redacted backend summary. */
  readonly backendSummary: string;
  /** ISO timestamp when injection happened. */
  readonly injectedAt: string;
  /** ISO timestamp when injected material expires. */
  readonly expiresAt?: string | null;
  /** Revocation status projection. */
  readonly revocationStatus: VaultInjectionReceiptRevocationStatus;
  /** Linked audit event id when available. */
  readonly auditEventId?: string | null;
}

/**
 * Reads one injection receipt by id.
 *
 * @param coreDb Open Core database handle.
 * @param receiptId Injection receipt id.
 * @returns Injection receipt record, or null.
 */
export function getVaultInjectionReceipt(
  coreDb: CoreDb,
  receiptId: string
): VaultInjectionReceiptRecord | null {
  const row = coreDb.sqlite
    .prepare(`${vaultInjectionReceiptSelectSql()} WHERE receipt_id = ?`)
    .get(receiptId) as VaultInjectionReceiptRow | undefined;

  return row ? mapVaultInjectionReceiptRow(row) : null;
}

/**
 * Lists injection receipts in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @returns Stored injection receipt records.
 */
export function listVaultInjectionReceipts(coreDb: CoreDb): VaultInjectionReceiptRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${vaultInjectionReceiptSelectSql()} ORDER BY injected_at ASC, receipt_id ASC`)
      .all() as VaultInjectionReceiptRow[]
  ).map(mapVaultInjectionReceiptRow);
}

/**
 * Lists injection receipts linked to exported injection plans.
 *
 * @param coreDb Open Core database handle.
 * @param planIds Exported injection plan ids.
 * @returns Exportable non-secret injection receipt records.
 */
export function listExportableVaultInjectionReceipts(
  coreDb: CoreDb,
  planIds: readonly string[]
): VaultInjectionReceiptRecord[] {
  const planIdSet = new Set(planIds);

  return listVaultInjectionReceipts(coreDb).filter((receipt) => planIdSet.has(receipt.planId));
}

/**
 * Reads one injection receipt or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param receiptId Injection receipt id.
 * @returns Injection receipt record.
 * @throws Error when the receipt does not exist.
 */
export function requireVaultInjectionReceipt(
  coreDb: CoreDb,
  receiptId: string
): VaultInjectionReceiptRecord {
  const receipt = getVaultInjectionReceipt(coreDb, receiptId);

  if (!receipt) {
    throw new Error(`Injection receipt not found: ${receiptId}`);
  }

  return receipt;
}

/**
 * Validates receipt actor linkage fields.
 *
 * @param coreDb Core Audit owner for an administrator preview delivery.
 * @param input Injection receipt creation input.
 * @param plan Existing injection intent.
 * @throws Error when neither Worker lineage nor exact human-preview delivery Audit is present.
 */
export function assertReceiptActor(
  coreDb: CoreDb,
  input: CreateVaultInjectionReceiptInput,
  plan: VaultInjectionPlanRecord
): void {
  if (input.agentSessionId || input.capabilityCallId) return;
  // Human tools/list has no Worker lineage. Its existing immutable Audit link must prove this exact delivery.
  if (
    input.auditEventId &&
    plan.packageSnapshotId === null &&
    plan.capabilityId === 'mcp.list-tools' &&
    plan.injectionVisibility === 'gateway-only' &&
    ['mcp-gateway:http', 'mcp-gateway:stdio'].includes(plan.backendCapabilityRequirement)
  ) {
    const event = coreDb.sqlite
      .prepare(`SELECT * FROM audit_events
      WHERE audit_event_id = ? AND action = 'administration.mcp-discovery-preview.delivery'
      AND outcome = 'succeeded' AND vault_grant_id = ? AND resource = ?
      AND request_id IS NOT NULL`)
      .get(input.auditEventId, input.grantId, `vault-injection-plan:${input.planId}`) as
      | { actor_json: string }
      | undefined;
    if (event) {
      const actor = readAuditEventRowV1(event).actor;
      if (actor?.kind === 'user') return;
    }
  }
  throw new Error('Injection receipts require agentSessionId or capabilityCallId.');
}

/**
 * Returns the common injection receipt SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
export function vaultInjectionReceiptSelectSql(): string {
  return `SELECT
    receipt_id,
    plan_id,
    grant_id,
    agent_session_id,
    capability_call_id,
    backend_summary,
    injected_at,
    expires_at,
    revocation_status,
    audit_event_id
    FROM vault_injection_receipts`;
}

/**
 * Maps one storage row into an injection receipt record.
 *
 * @param row SQLite injection receipt row.
 * @returns Injection receipt record.
 */
export function mapVaultInjectionReceiptRow(
  row: VaultInjectionReceiptRow
): VaultInjectionReceiptRecord {
  return {
    agentSessionId: row.agent_session_id,
    auditEventId: row.audit_event_id,
    backendSummary: row.backend_summary,
    capabilityCallId: row.capability_call_id,
    expiresAt: row.expires_at,
    grantId: row.grant_id,
    injectedAt: row.injected_at,
    planId: row.plan_id,
    receiptId: row.receipt_id,
    revocationStatus: row.revocation_status,
  };
}

/** Exact grant set already admitted by the grant or reference revocation owner. */
export type ReceiptRevocationTarget = { grantId: string } | { referenceId: string };

import { z } from 'zod';

export const nullableString = z.string().nullable();
export const optionalString = nullableString.optional();
export const clock = z.string().optional();
export const ownerScope = z.enum(['server', 'workspace', 'user']);
const canonicalLoginTime = z.iso
  .datetime({ precision: 3 })
  .refine(
    (value) =>
      value.length === 24 &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
const boundedLoginIdentity = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'));

/** Exact non-material quota fields; no provider payload, account duplicate or notification authority. */
export const HarnessLoginObservationsSchema = z
  .object({
    state: z.enum(['unknown', 'available', 'exhausted']),
    windows: z
      .array(
        z
          .object({
            kind: z.enum(['primary', 'secondary']),
            usedPercent: z.number().int().min(0).max(2_147_483_647),
            durationMinutes: z.number().int().min(1).max(525_600).nullable(),
            resetsAt: canonicalLoginTime.nullable(),
          })
          .strict()
      )
      .max(2)
      .refine((windows) => new Set(windows.map((window) => window.kind)).size === windows.length),
    source: z.literal('native-read'),
    observedAt: canonicalLoginTime,
    bindingId: boundedLoginIdentity(512),
    materialGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Creation admits identity only; neither creation nor public quarantine authors quota evidence. */
export const HarnessLoginIdentitySchema = z
  .object({
    provider: z.literal('codex'),
    accountId: boundedLoginIdentity(256),
    quarantined: z.boolean(),
  })
  .strict();

/** Canonical retained Login metadata; public mutations may carry it only as exact previous evidence. */
export const HarnessLoginMetadataSchema = HarnessLoginIdentitySchema.extend({
  observations: HarnessLoginObservationsSchema.nullable().optional(),
}).strict();
export const referenceFields = {
  referenceId: z.string(),
  ownerScope,
  workspaceId: optionalString,
  userId: optionalString,
  displayName: z.string(),
  secretKind: z.string(),
  backendKind: z.literal('encrypted-file'),
  backendLocator: optionalString,
  login: HarnessLoginIdentitySchema.optional(),
  now: clock,
};
export const grantFields = {
  grantId: z.string(),
  vaultReferenceId: z.string(),
  ownerScope,
  workspaceId: optionalString,
  userId: optionalString,
  subjectSummary: optionalString,
  targetAgentId: optionalString,
  targetAgentSessionId: optionalString,
  targetCapabilityId: optionalString,
  allowedInjectionPaths: z.array(z.string()),
  lifetime: z.enum(['capability-call', 'turn', 'agent-session', 'workspace', 'server']),
  policyDecisionId: optionalString,
  approvalId: optionalString,
  expiresAt: optionalString,
  now: clock,
};
export const narrowingFields = {
  grantId: z.string(),
  replacementGrantId: z.string(),
  now: clock,
  constraints: z
    .object({
      targetAgentId: z.string().optional(),
      targetAgentSessionId: z.string().optional(),
      targetCapabilityId: z.string().optional(),
      allowedInjectionPaths: z.array(z.string()).optional(),
      expiresAt: z.string().optional(),
    })
    .strict(),
};
export const planFields = {
  planId: z.string(),
  grantId: z.string(),
  packageSnapshotId: optionalString,
  capabilityId: optionalString,
  injectionVisibility: InjectionVisibilitySchema,
  targetPath: optionalString,
  targetEnvVarName: optionalString,
  expirationBehavior: z.string(),
  revocationBehavior: z.string(),
  redactionRule: z.string(),
  backendCapabilityRequirement: z.string(),
  now: clock,
};
export const receiptFields = {
  receiptId: z.string(),
  planId: z.string(),
  grantId: z.string(),
  agentSessionId: optionalString,
  capabilityCallId: optionalString,
  backendSummary: z.string(),
  injectedAt: z.string(),
  expiresAt: optionalString,
  revocationStatus: z.enum(['active', 'revoked', 'expired', 'stale-session']),
  auditEventId: optionalString,
};
export const useFields = {
  useId: z.string(),
  ownerScope: z.enum(['server', 'workspace']),
  workspaceId: optionalString,
  vaultReferenceId: z.string(),
  materialVersion: z.number().nullable().optional(),
  backendKind: z.literal('encrypted-file'),
  resolvingPath: z.enum(['grant', 'plan', 'admin', 'provider']),
  grantId: optionalString,
  planId: optionalString,
  receiptId: optionalString,
  agentSessionId: optionalString,
  capabilityCallId: optionalString,
  outcome: z.enum(['succeeded', 'failed', 'denied']),
  failureCode: optionalString,
  auditEventId: optionalString,
  usedAt: z.string(),
};

/** The original complete reference row, with no material or backend lookup. */
export const VaultReferenceRecordSchema = z
  .object({
    ...referenceFields,
    login: HarnessLoginMetadataSchema.optional(),
    workspaceId: nullableString,
    userId: nullableString,
    backendLocator: nullableString,
    status: z.enum(['active', 'revoked', 'unbound']),
    currentVersion: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .omit({ now: true })
  .superRefine((value, ctx) => {
    if (
      value.login &&
      (value.ownerScope !== 'user' ||
        value.workspaceId !== null ||
        !isEntityId('usr', value.userId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Harness Logins require a canonical User-owned reference.',
      });
  }) satisfies z.ZodType<VaultReferenceRecord>;
/** Complete retained grant facts; imported history remains descriptive only. */
export const VaultGrantRecordSchema = z
  .object({
    ...grantFields,
    workspaceId: nullableString,
    userId: nullableString,
    subjectSummary: nullableString,
    targetAgentId: nullableString,
    targetAgentSessionId: nullableString,
    targetCapabilityId: nullableString,
    policyDecisionId: nullableString,
    approvalId: nullableString,
    expiresAt: nullableString,
    issuance: z.enum(['target', 'imported-history']),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string(),
  })
  .omit({ now: true }) satisfies z.ZodType<VaultGrantRecord>;
/** Complete original Use row, including the consuming lineage. */
export const VaultUseRecordSchema = z.object({
  ...useFields,
  workspaceId: nullableString,
  materialVersion: z.number().nullable(),
  grantId: nullableString,
  planId: nullableString,
  receiptId: nullableString,
  agentSessionId: nullableString,
  capabilityCallId: nullableString,
  failureCode: nullableString,
  auditEventId: nullableString,
}) satisfies z.ZodType<VaultUseRecord>;
/** Complete retained plan, preserving the original lifecycle and clock on replay. */
export const VaultInjectionPlanRecordSchema = z
  .object({
    ...planFields,
    packageSnapshotId: nullableString,
    capabilityId: nullableString,
    targetPath: nullableString,
    targetEnvVarName: nullableString,
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string(),
  })
  .omit({ now: true }) satisfies z.ZodType<VaultInjectionPlanRecord>;
/** Complete original delivery lineage, including later revocation on replay. */
export const VaultInjectionReceiptRecordSchema = z.object({
  ...receiptFields,
  agentSessionId: nullableString,
  capabilityCallId: nullableString,
  expiresAt: nullableString,
  auditEventId: nullableString,
}) satisfies z.ZodType<VaultInjectionReceiptRecord>;

/** Existing administrator action names; neither arbitrary Audit nor a new operation family. */
export const VAULT_ADMIN_ACTIONS = [
  'vault.workspace_create',
  'vault.workspace_rotate',
  'vault.workspace_revoke',
  'vault.workspace_grant',
  'vault.workspace_revoke-grant',
  'vault.workspace_narrow-grant',
  'vault.grant-issue',
  'vault.unlock',
  'vault.lock',
  'vault.bootstrap_codex_auth_json',
  'vault.set_provider_api_key',
  'vault.rebind_workspace_reference',
] as const;
/** Existing six Server-MCP mutations whose original receipt remains a separate final stage. */
export const VAULT_SERVER_MCP_COMMANDS = [
  'vault.server-mcp-secret-create',
  'vault.server-mcp-secret-rotate',
  'vault.server-mcp-secret-revoke',
  'vault.server-mcp-grant-create',
  'vault.server-mcp-grant-revoke',
  'vault.server-mcp-grant-narrow',
] as const;
const vaultAuditActions = new Set<string>([
  ...Object.keys(VAULT_OPERATION_DEFINITIONS),
  ...VAULT_ADMIN_ACTIONS,
  ...VAULT_SERVER_MCP_COMMANDS,
  'vault.resolve',
  'administration.mcp-discovery-preview',
  'administration.mcp-discovery-preview.delivery',
]);
/** One original prepared general Audit, admitted only for its existing Vault producers. */
export const VaultAuditEventSchema = AuditEventSchema.extend({
  createdAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
}).refine((event) => vaultAuditActions.has(event.action));
/** One original admin-table row; its general Audit is a distinct stage except in existing outer tuples. */
export const VaultAdminAuditRecordSchema = z
  .object({
    auditEventId: z.string(),
    actorUserId: z.string().nullable(),
    actorKind: z.enum(['local', 'session', 'token']).nullable(),
    action: z.enum(VAULT_ADMIN_ACTIONS),
    outcome: z.enum(['succeeded', 'failed', 'denied']),
    severity: z.enum(['info', 'warning', 'error']),
    summary: z.string(),
    errorCode: z.string().nullable(),
    backendKind: z.literal('encrypted-file'),
    createdAt: z.string(),
  })
  .strict();
/** Complete original admin-row facts without a database capability. */
export type VaultAdminAuditRecord = z.infer<typeof VaultAdminAuditRecordSchema>;
/** Complete original general Audit with prepared clocks and identity. */
export type VaultAuditEvent = z.infer<typeof VaultAuditEventSchema>;

/** Original authentication projection only, never a Token value or replacement administrator selection. */
const vaultActor = z
  .object({
    kind: z.enum(['local', 'session', 'token']),
    userId: z.string(),
    sessionId: z.string().optional(),
    tokenId: z.string().optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(z.string()).optional(),
    adminTokenId: z.string().optional(),
  })
  .strict();
/** Existing requester facts whose Core authority can change ahead of this request in the FIFO. */
const vaultRequester = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public'), actor: vaultActor }).strict(),
  z
    .object({
      kind: z.literal('worker'),
      actor: z
        .object({
          kind: z.enum(['user', 'agent', 'system']),
          id: z.string(),
          responsibleUserId: z.string().nullable().optional(),
        })
        .strict(),
      lineage: z
        .object({
          workspaceId: z.string(),
          threadId: z.string(),
          turnId: z.string(),
          agentSessionId: z.string(),
          packageSnapshotId: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
/** Only existing deciding facts; cross-database and material checks remain with the Main operation. */
const reviewedGrantAuthority = z
  .object({
    workspaceId: z.string(),
    issuer: vaultActor,
    decider: vaultActor,
    requester: vaultRequester,
    reference: VaultReferenceRecordSchema,
  })
  .strict();

/** Server-MCP effect authority is re-evaluated after queued predecessors, without material or saved allow decisions. */
const serverMcpAuthority = z
  .object({ actor: vaultActor, reference: VaultReferenceRecordSchema.optional() })
  .strict();
type ServerMcpAuthorityInput = { readonly serverMcp?: z.infer<typeof serverMcpAuthority> };
/** Actual public mutation requester and selected Core facts, never an earlier allow decision. */
const publicMutationAuthority = z
  .object({
    actor: vaultActor,
    workspaceId: z.string().optional(),
    reference: VaultReferenceRecordSchema.optional(),
  })
  .strict();
type PublicMutationAuthorityInput = {
  readonly publicMutation?: z.infer<typeof publicMutationAuthority>;
};
/** Original separate Core command receipt, after the effect and its successful Audit. */
const serverMcpReceipt = z
  .object({
    key: z.string(),
    command: z.enum(VAULT_SERVER_MCP_COMMANDS),
    requestId: RequestIdSchema,
    scope: z.object({ actorId: z.string(), coreId: z.literal('server') }).strict(),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: z
      .object({ kind: z.enum(['vault_reference', 'vault_grant']), id: z.string() })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Exact consumer facts used by the shared current predicate; unrelated AEP bytes stay off the wire. */
const credentialConsumer = z
  .object({
    scope: AgentEnvironmentPackageSchema.shape.scope,
    snapshotId: AgentEnvironmentPackageSchema.shape.snapshotId,
    agent: AgentEnvironmentPackageSchema.shape.agent.pick({ agentId: true }),
  })
  .strict();
const bindingAuthority = z
  .object({
    consumer: credentialConsumer,
    declaration: AgentEnvironmentCredentialDeclarationSchema,
    materialVersion: z.number(),
  })
  .strict();
/** Actual invocation facts, never a carried permission decision. */
export const VaultBindingRequesterSchema = z.discriminatedUnion('kind', [
  vaultRequester.options[0].extend({ actorRef: ActorRefSchema }),
  vaultRequester.options[1].extend({ actor: ActorRefSchema }),
]);
export type VaultBindingRequester = z.infer<typeof VaultBindingRequesterSchema>;
export const VaultBindingCoreAuthoritySchema = z
  .object({ workspaceId: z.string(), requester: VaultBindingRequesterSchema, revision: z.string() })
  .strict();
export type VaultBindingCoreAuthority = z.infer<typeof VaultBindingCoreAuthoritySchema>;
/** Original governed facts for same-effect native readback; no carried allow or material. */
export const VaultBindingPolicyProofSchema = z
  .object({
    proposal: z
      .object({
        operation: z.string().min(1),
        workspaceId: z.string().nullable(),
        resource: PolicyResourceV1Schema,
        inputReferences: z.record(z.string(), z.string().nullable()),
        inputAttributes: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()])
        ),
        capabilityCallId: z.string().nullable(),
        subject: PolicySubjectV1Schema,
      })
      .strict(),
    decision: z
      .object({
        decisionId: z.string().min(1),
        proposalDigest: PolicyDigestV1Schema,
        policyRevision: PolicyDigestV1Schema,
        authorizationRevision: PolicyDigestV1Schema,
      })
      .strict(),
    document: PolicyDocumentV1Schema,
    workspaceDocument: PolicyDocumentV1Schema,
    caller: z.discriminatedUnion('kind', [
      VaultBindingRequesterSchema.options[0],
      VaultBindingRequesterSchema.options[1].extend({ goalLinked: z.boolean() }),
      z
        .object({
          kind: z.literal('coordinator'),
          actor: vaultActor,
          actorRef: ActorRefSchema,
          workspaceId: z.string(),
          goalId: z.string(),
          threadId: z.string(),
          turnId: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();
/** References the original decision and documents; native current owners still decide. */
export type VaultBindingPolicyProof = z.infer<typeof VaultBindingPolicyProofSchema>;
/** Transient deciding facts for one initial access-only delivery; never retained or Worker-authored. */
const loginBindingAuthority = z
  .object({
    binding: bindingAuthority,
    requester: VaultBindingCoreAuthoritySchema,
    attemptId: z.string().min(1),
    planId: z.string().min(1),
    receiptId: z.string().min(1),
    reference: VaultReferenceRecordSchema,
    policyProof: VaultBindingPolicyProofSchema.optional(),
  })
  .strict();

/** Core-only failure correlation and separate User decision; neither carries an allow result. */
const coreConfirmedQuarantineAuthority = z
  .object({
    binding: loginBindingAuthority.extend({ policyProof: VaultBindingPolicyProofSchema }),
    failureClass: z.literal('invalid-grant'),
    quarantine: VaultBindingPolicyProofSchema.pick({
      proposal: true,
      decision: true,
      document: true,
    }),
  })
  .strict();

/** Original canonical execution coordinates; no header, token, material or carried allow decision. */
export const HarnessLoginContextSchema = z
  .object({
    workspaceId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
    agentSessionId: z.string().min(1).max(512),
    agentSessionRuntimeBindingId: z.string().min(1).max(512),
    packageSnapshotId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
    leaseId: z.string().min(1).max(512),
    turnSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    runtimeTargetId: z.string().min(1).max(512),
    physicalEpoch: z.string().regex(/^[0-9a-f]{64}$/),
    connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
/** Exact original access delivery lineage, repeated by the deciding native owner. */
export const HarnessLoginNativeEffectSchema = z
  .object({
    context: HarnessLoginContextSchema,
    referenceId: z.string().refine((value) => isEntityId('vault', value)),
    grantId: z.string().min(1).max(512),
    planId: z.string().min(1).max(512),
    receiptId: z.string().min(1).max(512),
    materialGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    accountId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/.test(value)),
    now: z.iso
      .datetime({ precision: 3 })
      .refine((value) => value.length === 24 && new Date(value).toISOString() === value),
  })
  .strict();
/** Original consumed native close coordinates and the Core close-ACK clock captured by that lifecycle callback. */
export const HarnessLoginRemovalSchema = z
  .object({
    workspaceId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
    agentSessionId: z.string().min(1).max(512),
    agentSessionRuntimeBindingId: z.string().min(1).max(512),
    harnessInstanceId: z.string().min(1).max(512),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    completedAt: z.iso
      .datetime({ precision: 3 })
      .refine((value) => value.length === 24 && new Date(value).toISOString() === value),
    expectedReferenceId: z
      .string()
      .refine((value) => isEntityId('vault', value))
      .nullable(),
  })
  .strict();
/** Closed original Vault stages. Clock callbacks and material never cross this private wire. */
export const ControlVaultInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread-login-remove'), record: HarnessLoginRemovalSchema }).strict(),
  z
    .object({
      kind: z.literal('reference-login-observe'),
      record: HarnessLoginNativeEffectSchema.extend({
        observations: HarnessLoginObservationsSchema,
      }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('thread-login-activate'),
      record: HarnessLoginNativeEffectSchema.extend({
        expectedReferenceId: z
          .string()
          .refine((value) => isEntityId('vault', value))
          .nullable(),
      }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp-receipts-complete'),
      record: z.object({ receipts: z.array(z.object(receiptFields).strict()) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('binding-revoke-withdraw'),
      record: z
        .object({
          receiptId: z.string(),
          planId: z.string(),
          agentSessionId: z.string(),
          plan: VaultInjectionPlanRecordSchema,
          coreAuthority: VaultBindingCoreAuthoritySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('binding-revoke-receipts-complete'),
      record: z.object({ planId: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('binding-revoke-plan-complete'),
      record: z.object({ planId: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('binding-replace-complete'),
      record: z
        .object({
          previousReceiptId: z.string(),
          receipt: z.object(receiptFields).strict(),
          authority: bindingAuthority,
          coreAuthority: VaultBindingCoreAuthoritySchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('server-mcp-command-receipt'), record: serverMcpReceipt }).strict(),
  z
    .object({
      kind: z.literal('preview-receipt-create'),
      record: z
        .object({
          referenceId: z.string(),
          receipt: z.object(receiptFields).omit({ revocationStatus: true }).strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reviewed-grant-issue'),
      record: z
        .object({
          grant: z.object(grantFields).strict(),
          admin: VaultAdminAuditRecordSchema,
          audit: VaultAuditEventSchema,
          authority: reviewedGrantAuthority,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workspace-grant-narrow'),
      record: z
        .object({
          grant: z.object(narrowingFields).strict(),
          publicMutation: publicMutationAuthority,
          admin: VaultAdminAuditRecordSchema,
          audit: VaultAuditEventSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('server-mcp-grant-narrow'),
      record: z
        .object({
          grant: z.object(narrowingFields).strict(),
          audit: VaultAuditEventSchema,
          serverMcp: serverMcpAuthority,
        })
        .strict(),
    })
    .strict(),

  z.object({ kind: z.literal('admin-event-insert'), record: VaultAdminAuditRecordSchema }).strict(),
  z.object({ kind: z.literal('audit-insert'), record: VaultAuditEventSchema }).strict(),
  z
    .object({
      kind: z.literal('reference-create'),
      record: z
        .object({
          ...referenceFields,
          serverMcp: serverMcpAuthority.optional(),
          publicMutation: publicMutationAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reference-advance'),
      record: z
        .object({
          referenceId: z.string(),
          currentVersion: z.number(),
          now: clock,
          serverMcp: serverMcpAuthority.optional(),
          publicMutation: publicMutationAuthority.optional(),
          loginBinding: loginBindingAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reference-revoke'),
      record: z
        .object({
          referenceId: z.string(),
          now: clock,
          serverMcp: serverMcpAuthority.optional(),
          publicMutation: publicMutationAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reference-login-state'),
      record: z.union([
        z
          .object({
            referenceId: z.string(),
            quarantined: z.boolean(),
            now: clock,
            publicMutation: publicMutationAuthority.extend({
              reference: VaultReferenceRecordSchema,
              workspaceId: z.never().optional(),
            }),
          })
          .strict(),
        z
          .object({
            referenceId: z.string(),
            quarantined: z.literal(true),
            now: clock,
            coreConfirmedQuarantine: coreConfirmedQuarantineAuthority,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reference-rebind'),
      record: z
        .object({
          workspaceId: z.string(),
          referenceId: z.string(),
          backendKind: z.literal('encrypted-file'),
          backendLocator: z.string(),
          currentVersion: z.number(),
          now: clock,
          publicMutation: publicMutationAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('grant-create'),
      record: z
        .object({
          ...grantFields,
          serverMcp: serverMcpAuthority.optional(),
          publicMutation: publicMutationAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('grant-revoke'),
      record: z
        .object({
          grantId: z.string(),
          now: clock,
          serverMcp: serverMcpAuthority.optional(),
          publicMutation: publicMutationAuthority.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal('grant-narrow'), record: z.object(narrowingFields).strict() })
    .strict(),
  z.object({ kind: z.literal('use-create'), record: z.object(useFields).strict() }).strict(),
  z.object({ kind: z.literal('plan-create'), record: z.object(planFields).strict() }).strict(),
  z
    .object({
      kind: z.literal('receipt-create'),
      record: z
        .object({
          ...receiptFields,
          loginBinding: loginBindingAuthority.optional(),
          workerAuthority: z
            .object({
              consumer: credentialConsumer,
              declarations: z.array(AgentEnvironmentCredentialDeclarationSchema),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
]);
/** One existing stage's closed typed facts; no SQL, callbacks or material. */
export type ControlVaultInput = z.infer<typeof ControlVaultInputSchema>;
/** Full original rows only after the covering native FULL acknowledgement. */
export const ControlVaultResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread-login-remove'), value: z.null() }).strict(),
  z
    .object({ kind: z.literal('reference-login-observe'), value: VaultReferenceRecordSchema })
    .strict(),
  z.object({ kind: z.literal('thread-login-activate'), value: z.null() }).strict(),
  z.object({ kind: z.literal('mcp-receipts-complete'), value: z.null() }).strict(),
  z.object({ kind: z.literal('binding-revoke-withdraw'), value: z.null() }).strict(),
  z.object({ kind: z.literal('binding-revoke-receipts-complete'), value: z.null() }).strict(),
  z.object({ kind: z.literal('binding-revoke-plan-complete'), value: z.null() }).strict(),
  z.object({ kind: z.literal('binding-replace-complete'), value: z.null() }).strict(),
  z.object({ kind: z.literal('server-mcp-command-receipt'), value: z.null() }).strict(),
  z
    .object({ kind: z.literal('preview-receipt-create'), value: VaultInjectionReceiptRecordSchema })
    .strict(),
  z.object({ kind: z.literal('reviewed-grant-issue'), value: VaultGrantRecordSchema }).strict(),
  z
    .object({
      kind: z.literal('workspace-grant-narrow'),
      value: z
        .object({ revokedGrant: VaultGrantRecordSchema, grant: VaultGrantRecordSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('server-mcp-grant-narrow'),
      value: z
        .object({ revokedGrant: VaultGrantRecordSchema, grant: VaultGrantRecordSchema })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('admin-event-insert'), value: z.null() }).strict(),
  z.object({ kind: z.literal('audit-insert'), value: VaultAuditEventSchema }).strict(),
  z
    .object({
      kind: z.literal('reference-create'),
      value: z.object({ inserted: z.boolean(), reference: VaultReferenceRecordSchema }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal('reference-advance'), value: VaultReferenceRecordSchema }).strict(),
  z.object({ kind: z.literal('reference-revoke'), value: VaultReferenceRecordSchema }).strict(),
  z
    .object({ kind: z.literal('reference-login-state'), value: VaultReferenceRecordSchema })
    .strict(),
  z.object({ kind: z.literal('reference-rebind'), value: VaultReferenceRecordSchema }).strict(),
  z.object({ kind: z.literal('grant-create'), value: VaultGrantRecordSchema }).strict(),
  z.object({ kind: z.literal('grant-revoke'), value: VaultGrantRecordSchema }).strict(),
  z
    .object({
      kind: z.literal('grant-narrow'),
      value: z
        .object({ revokedGrant: VaultGrantRecordSchema, grant: VaultGrantRecordSchema })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('use-create'), value: VaultUseRecordSchema }).strict(),
  z.object({ kind: z.literal('plan-create'), value: VaultInjectionPlanRecordSchema }).strict(),
  z
    .object({ kind: z.literal('receipt-create'), value: VaultInjectionReceiptRecordSchema })
    .strict(),
]);
/** Complete, validated native result. */
export type ControlVaultResult = z.infer<typeof ControlVaultResultSchema>;
/** The original result selected by each closed stage. */
export interface ControlVaultResultMap {
  'thread-login-remove': null;
  'reference-login-observe': VaultReferenceRecord;
  'thread-login-activate': null;
  'mcp-receipts-complete': null;
  'binding-revoke-withdraw': null;
  'binding-revoke-receipts-complete': null;
  'binding-revoke-plan-complete': null;
  'binding-replace-complete': null;
  'server-mcp-command-receipt': null;
  'preview-receipt-create': VaultInjectionReceiptRecord;
  'reviewed-grant-issue': VaultGrantRecord;
  'workspace-grant-narrow': { revokedGrant: VaultGrantRecord; grant: VaultGrantRecord };
  'server-mcp-grant-narrow': { revokedGrant: VaultGrantRecord; grant: VaultGrantRecord };
  'admin-event-insert': null;
  'audit-insert': VaultAuditEvent;
  'reference-create': CreateVaultReferenceResult;
  'reference-advance': VaultReferenceRecord;
  'reference-revoke': VaultReferenceRecord;
  'reference-login-state': VaultReferenceRecord;
  'reference-rebind': VaultReferenceRecord;
  'grant-create': VaultGrantRecord;
  'grant-revoke': VaultGrantRecord;
  'grant-narrow': { revokedGrant: VaultGrantRecord; grant: VaultGrantRecord };
  'use-create': VaultUseRecord;
  'plan-create': VaultInjectionPlanRecord;
  'receipt-create': VaultInjectionReceiptRecord;
}

/** Replaces the wire clock without collapsing closed authority alternatives. */
type MainVaultClock<Record> = Record extends unknown
  ? Omit<Record, 'now'> & { readonly now?: () => string }
  : never;

/** Existing Main call inputs; their optional clock callbacks are evaluated before private-wire admission. */
export interface ControlVaultMainInputMap {
  'thread-login-remove': Extract<ControlVaultInput, { kind: 'thread-login-remove' }>['record'];
  'reference-login-observe': Omit<
    Extract<ControlVaultInput, { kind: 'reference-login-observe' }>['record'],
    'now'
  > & { readonly now: () => string };
  'thread-login-activate': Omit<
    Extract<ControlVaultInput, { kind: 'thread-login-activate' }>['record'],
    'now'
  > & { readonly now: () => string };
  'mcp-receipts-complete': Extract<ControlVaultInput, { kind: 'mcp-receipts-complete' }>['record'];
  'binding-revoke-withdraw': Extract<
    ControlVaultInput,
    { kind: 'binding-revoke-withdraw' }
  >['record'];
  'binding-revoke-receipts-complete': Extract<
    ControlVaultInput,
    { kind: 'binding-revoke-receipts-complete' }
  >['record'];
  'binding-revoke-plan-complete': Extract<
    ControlVaultInput,
    { kind: 'binding-revoke-plan-complete' }
  >['record'];
  'binding-replace-complete': Extract<
    ControlVaultInput,
    { kind: 'binding-replace-complete' }
  >['record'];
  'server-mcp-command-receipt': z.infer<typeof serverMcpReceipt>;
  'preview-receipt-create': Extract<
    ControlVaultInput,
    { kind: 'preview-receipt-create' }
  >['record'];
  'reviewed-grant-issue': Extract<ControlVaultInput, { kind: 'reviewed-grant-issue' }>['record'];
  'workspace-grant-narrow': Extract<
    ControlVaultInput,
    { kind: 'workspace-grant-narrow' }
  >['record'];
  'server-mcp-grant-narrow': Extract<
    ControlVaultInput,
    { kind: 'server-mcp-grant-narrow' }
  >['record'];
  'admin-event-insert': VaultAdminAuditRecord;
  'audit-insert': VaultAuditEvent;
  'reference-create': CreateVaultReferenceInput &
    ServerMcpAuthorityInput &
    PublicMutationAuthorityInput;
  'reference-advance': AdvanceActiveVaultReferenceVersionInput &
    ServerMcpAuthorityInput &
    PublicMutationAuthorityInput & {
      readonly loginBinding?: z.infer<typeof loginBindingAuthority>;
    };
  'reference-revoke': RevokeVaultReferenceInput &
    ServerMcpAuthorityInput &
    PublicMutationAuthorityInput;
  'reference-login-state': MainVaultClock<
    Extract<ControlVaultInput, { kind: 'reference-login-state' }>['record']
  >;
  'reference-rebind': RebindWorkspaceVaultReferenceInput & PublicMutationAuthorityInput;
  'grant-create': CreateVaultGrantInput & ServerMcpAuthorityInput & PublicMutationAuthorityInput;
  'grant-revoke': RevokeVaultGrantInput & ServerMcpAuthorityInput & PublicMutationAuthorityInput;
  'grant-narrow': {
    readonly grantId: string;
    readonly replacementGrantId: string;
    readonly constraints: NarrowVaultGrantConstraints;
    readonly now?: () => string;
  };
  'use-create': CreateVaultUseRecordInput;
  'plan-create': CreateVaultInjectionPlanInput;
  'receipt-create': CreateVaultInjectionReceiptInput & {
    readonly loginBinding?: z.infer<typeof loginBindingAuthority>;
    readonly workerAuthority?: {
      readonly consumer: import('../runtime/worker-credential-authority.js').WorkerCredentialConsumer;
      readonly declarations: readonly import('@openkit/config-schema').AgentEnvironmentCredentialDeclaration[];
    };
  };
}

/** Original metadata validation errors only; no SQLite diagnostics or material may enter a domain reply. */
const vaultRecordRefusals = new Set([
  'Vault reference identity must use the canonical vault kind.',
  'Server-scoped vault references cannot include workspaceId or userId.',
  'Workspace-scoped vault references require workspaceId.',
  'Workspace-scoped vault references cannot include userId.',
  'User-scoped vault references require userId.',
  'User-scoped vault references cannot include workspaceId.',
  'Invalid canonical Vault reference identity.',
  'Harness Logins require a canonical User-owned reference.',
  'Invalid retained harness Login metadata.',
  'Server-scoped vault grants cannot include workspaceId or userId.',
  'Workspace-scoped vault grants require workspaceId.',
  'Workspace-scoped vault grants cannot include userId.',
  'User-scoped vault grants require userId.',
  'User-scoped vault grants cannot include workspaceId.',
  'Vault grants require at least one allowed injection path.',
  'Invalid canonical VaultGrant identity.',
  'Invalid stored vault grant injection paths.',
  'Invalid canonical VaultGrant issuance.',
  'Server-scoped vault use records cannot include workspaceId.',
  'Workspace-scoped vault use records require workspaceId.',
  'Workspace database can only store workspace-scoped vault use records.',
  'Workspace-scoped vault use records must match the database workspaceId.',
  'Successful vault use records require materialVersion.',
  'Failed or denied vault use records require failureCode.',
  'Grant-based vault use records require grantId.',
  'Plan-based vault use records require planId.',
  'VaultUse identifiers are not canonical.',
  'Runtime-file injection plans require targetPath.',
  'Runtime-env injection plans require targetEnvVarName.',
  'Gateway-only injection plans cannot include runtime targets.',
  'Injection receipts require agentSessionId or capabilityCallId.',
  'Rebound vault reference version must be positive.',
  'Vault grant identifier is not canonical.',
  'Imported VaultGrant cannot become target-issued.',
  'Vault grant is portable-import history and cannot authorize effects.',
  'Vault injection plan identity conflict.',
  'Injection receipt grant id must match the injection plan grant id.',
  'Vault injection receipt identity conflict.',
  'Credential binding changed before revocation.',
  'Credential replacement lost its original receipt.',
  'Credential material generation changed during replacement.',
]);
const vaultRecordRefusalPatterns = [
  '^Vault reference not found: [a-zA-Z0-9_-]+$',
  '^Vault grant not found: [a-zA-Z0-9_-]+$',
  '^Vault use record not found: [a-zA-Z0-9_-]+$',
  '^Injection plan not found: [a-zA-Z0-9_-]+$',
  '^Injection receipt not found: [a-zA-Z0-9_-]+$',
  '^Vault reference is not active: [a-zA-Z0-9_-]+$',
  '^Vault reference version must advance by exactly one: [a-zA-Z0-9_-]+$',
  '^Vault reference version changed concurrently: [a-zA-Z0-9_-]+$',
  '^Workspace vault reference not found: [a-zA-Z0-9_-]+$',
  '^Workspace vault reference is not unbound: [a-zA-Z0-9_-]+$',
].map((pattern) => new RegExp(pattern, 'u'));

/** Only existing Server-MCP public refusal constants may cross the private domain boundary. */
const serverMcpRefusals = [
  ['vault_reference_not_found', 'Server MCP reference not found.', 404],
  ['vault_grant_not_found', 'Server MCP grant not found.', 404],
  ['invalid_request', 'Grant expiry must be in the future.', 400],
  [
    'recovery_required',
    'Server MCP operation could not complete. Inspect current resources before another request.',
    409,
  ],
] as const;
function isServerMcpRefusal(code: unknown, message: unknown, status: unknown): boolean {
  return serverMcpRefusals.some(([c, m, s]) => c === code && m === message && s === status);
}

/** Recognizes only the existing redacted grant refusal or finite metadata validation messages. */
export function controlVaultRefusal(
  error: unknown
): { operation: 'vault'; code: string; message: string; status: number } | undefined {
  if (
    error instanceof Error &&
    'code' in error &&
    'status' in error &&
    isServerMcpRefusal(error.code, error.message, error.status)
  )
    return {
      operation: 'vault',
      code: error.code as string,
      message: error.message,
      status: error.status as number,
    };
  if (error instanceof TypeError && error.message === 'Unsupported retained record format.')
    return {
      operation: 'vault',
      code: 'vault_record_format',
      message: error.message,
      status: 409,
    };
  if (error instanceof VaultGrantNarrowingError)
    return {
      operation: 'vault',
      code: 'vault_grant_narrowing',
      message: error.message,
      status: error.status,
    };
  if (
    error instanceof Error &&
    !('code' in error) &&
    (vaultRecordRefusals.has(error.message) ||
      vaultRecordRefusalPatterns.some((pattern) => pattern.test(error.message)))
  )
    return {
      operation: 'vault',
      code: 'vault_record_invalid',
      message: error.message,
      status: 409,
    };
  return undefined;
}
/** Validates the same finite messages on Main before reconstructing an original public error. */
export function isControlVaultRefusal(code: unknown, message: unknown, status: unknown): boolean {
  return (
    typeof message === 'string' &&
    (isServerMcpRefusal(code, message, status) ||
      (code === 'vault_grant_narrowing'
        ? (status === 400 && message === new VaultGrantNarrowingError(400).message) ||
          (status === 409 && message === new VaultGrantNarrowingError(409).message)
        : code === 'vault_record_format'
          ? status === 409 && message === 'Unsupported retained record format.'
          : code === 'vault_record_invalid' &&
            status === 409 &&
            (vaultRecordRefusals.has(message) ||
              vaultRecordRefusalPatterns.some((pattern) => pattern.test(message)))))
  );
}

/** Reads the existing personal-reference/Workspace-grant tuple without granting withdrawal authority. */
export function getWithdrawableUserVaultGrant(
  coreDb: CoreDb,
  workspaceId: string,
  grantId: string
): { grant: VaultGrantRecord; reference: VaultReferenceRecord & { userId: string } } | null {
  const grant = getVaultGrant(coreDb, grantId);
  const reference = grant ? getVaultReference(coreDb, grant.vaultReferenceId) : null;
  if (
    !grant ||
    grant.ownerScope !== 'workspace' ||
    grant.workspaceId !== workspaceId ||
    grant.lifetime !== 'workspace' ||
    grant.userId !== null ||
    grant.issuance !== 'target' ||
    !reference ||
    reference.ownerScope !== 'user' ||
    reference.workspaceId !== null ||
    !reference.userId
  )
    return null;
  return { grant, reference: reference as VaultReferenceRecord & { userId: string } };
}
