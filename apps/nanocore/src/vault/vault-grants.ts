import { isEntityId, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import type { CoreDb } from '../storage/db.js';
import type {
  VaultGrantLifetime,
  VaultGrantOwnerScope,
  VaultGrantStatus,
} from '../storage/schema/index.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { revokeVaultInjectionReceipts } from './vault-receipt-revocation.js';
import { getVaultReference } from './vault-references.js';

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
interface VaultGrantRow {
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
 * Replaces a current grant with a strictly narrower grant in one Core transaction.
 *
 * Bindings stay on the revoked original until their owner explicitly changes them.
 *
 * @param coreDb Open Core database handle.
 * @param input Original identity, fresh replacement identity, reduced constraints and clock.
 * @returns Original revoked grant and its active replacement.
 * @throws VaultGrantNarrowingError for inactive authority or widening, empty or unchanged constraints.
 */
export function narrowVaultGrant(
  coreDb: CoreDb,
  input: {
    readonly grantId: string;
    readonly replacementGrantId: string;
    readonly constraints: NarrowVaultGrantConstraints;
    readonly now?: () => string;
  }
): { revokedGrant: VaultGrantRecord; grant: VaultGrantRecord } {
  return coreDb.sqlite.transaction(() => {
    const original = getVaultGrant(coreDb, input.grantId);
    const timestamp = input.now?.() ?? new Date().toISOString();
    const currentTime = Date.parse(timestamp);
    const reference = original ? getVaultReference(coreDb, original.vaultReferenceId) : null;
    if (
      !original ||
      original.issuance !== 'target' ||
      (original.approvalId !== null &&
        (!isTargetIssuedEffectAuthority(original.approvalId) ||
          original.policyDecisionId === null)) ||
      original.status !== 'active' ||
      !reference ||
      reference.status !== 'active' ||
      !Number.isFinite(currentTime) ||
      (original.expiresAt !== null &&
        (!Number.isFinite(Date.parse(original.expiresAt)) ||
          Date.parse(original.expiresAt) <= currentTime ||
          new Date(original.expiresAt).toISOString() !== original.expiresAt))
    ) {
      throw new VaultGrantNarrowingError(409);
    }
    if (
      !isTargetIssuedEffectAuthority(input.replacementGrantId) ||
      getVaultGrant(coreDb, input.replacementGrantId)
    ) {
      throw new VaultGrantNarrowingError(409);
    }
    const constraints = input.constraints;
    let reduced = false;
    for (const field of ['targetAgentId', 'targetAgentSessionId', 'targetCapabilityId'] as const) {
      const next = constraints[field];
      if (next === undefined) continue;
      if (
        typeof next !== 'string' ||
        next.trim().length === 0 ||
        (original[field] !== null && next !== original[field])
      )
        throw new VaultGrantNarrowingError(400);
      if (original[field] === null) reduced = true;
    }
    const paths = constraints.allowedInjectionPaths ?? original.allowedInjectionPaths;
    if (
      paths.length === 0 ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !original.allowedInjectionPaths.includes(path))
    ) {
      throw new VaultGrantNarrowingError(400);
    }
    if (paths.length < new Set(original.allowedInjectionPaths).size) reduced = true;
    if (constraints.expiresAt !== undefined) {
      const expiry = Date.parse(constraints.expiresAt);
      if (
        !Number.isFinite(expiry) ||
        expiry <= currentTime ||
        new Date(expiry).toISOString() !== constraints.expiresAt ||
        (original.expiresAt !== null && expiry > Date.parse(original.expiresAt))
      )
        throw new VaultGrantNarrowingError(400);
      if (original.expiresAt === null || expiry < Date.parse(original.expiresAt)) reduced = true;
    }
    if (!reduced) throw new VaultGrantNarrowingError(400);
    const grant = createVaultGrant(coreDb, {
      ...original,
      grantId: input.replacementGrantId,
      targetAgentId: constraints.targetAgentId ?? original.targetAgentId,
      targetAgentSessionId: constraints.targetAgentSessionId ?? original.targetAgentSessionId,
      targetCapabilityId: constraints.targetCapabilityId ?? original.targetCapabilityId,
      allowedInjectionPaths: paths,
      expiresAt: constraints.expiresAt ?? original.expiresAt,
      now: () => timestamp,
    });
    const revokedGrant = revokeVaultGrant(coreDb, { grantId: original.grantId });
    return { revokedGrant, grant };
  })();
}

/**
 * Creates one non-secret vault grant idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant metadata to store.
 * @returns Stored vault grant record.
 * @throws Error when the id is malformed, a retained grant is imported, or reference and scope fields are invalid.
 */
export function createVaultGrant(coreDb: CoreDb, input: CreateVaultGrantInput): VaultGrantRecord {
  if (!isEntityId('grant', input.grantId))
    throw new Error('Vault grant identifier is not canonical.');
  const existing = getVaultGrant(coreDb, input.grantId);
  if (existing && existing.issuance !== 'target')
    throw new Error('Imported VaultGrant cannot become target-issued.');

  assertVaultGrantScope(input);
  assertAllowedInjectionPaths(input.allowedInjectionPaths);

  if (!getVaultReference(coreDb, input.vaultReferenceId)) {
    throw new Error(`Vault reference not found: ${input.vaultReferenceId}`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_grants (
        schema_version,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      input.grantId,
      'target',
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
 * Revokes one vault grant and projects dependent receipt reachability.
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
    assertIssuance(grant.issuance);
    const existing = getVaultGrant(coreDb, grant.grantId);
    if (existing && existing.issuance !== 'imported-history')
      throw new Error('Imported grant collides with target authority.');
  }
  for (const grant of grants) {
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO vault_grants (
          schema_version,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        writeRetainedV1({}).schemaVersion,
        grant.grantId,
        'imported-history',
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
      "UPDATE vault_injection_plans SET status = 'revoked' WHERE grant_id = ? AND status = 'active'"
    )
    .run(grantId);
  revokeVaultInjectionReceipts(coreDb, { grantId });
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
function mapVaultGrantRow(row: VaultGrantRow): VaultGrantRecord {
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
function parseAllowedInjectionPathsV1(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error('Invalid stored vault grant injection paths.');
  }

  return parsed;
}

/** Fails closed rather than assigning target authority to missing or unknown retained provenance. */
function assertIssuance(value: unknown): asserts value is VaultGrantRecord['issuance'] {
  if (value !== 'target' && value !== 'imported-history')
    throw new Error('Invalid canonical VaultGrant issuance.');
}
