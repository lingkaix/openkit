import type { CoreDb, WorkspaceDb } from './storage/db.js';
import type {
  VaultUseBackendKind,
  VaultUseOutcome,
  VaultUseOwnerScope,
  VaultUseResolvingPath,
} from './storage/schema/index.js';

/** Database handle that can store vault use records. */
type VaultUseDb = CoreDb | WorkspaceDb;

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
  /** Agent session id when available. */
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
interface VaultUseRow {
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
  /** Agent session id when available. */
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
 * Creates one non-secret vault use record idempotently.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param input Vault use metadata to store.
 * @returns Stored vault use record.
 * @throws Error when scope or resolution metadata is inconsistent.
 */
export function createVaultUseRecord(
  db: VaultUseDb,
  input: CreateVaultUseRecordInput
): VaultUseRecord {
  assertVaultUseScope(db, input);
  assertVaultUseResolution(input);

  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_use_records (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.useId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.vaultReferenceId,
      input.materialVersion ?? null,
      input.backendKind,
      input.resolvingPath,
      input.grantId ?? null,
      input.planId ?? null,
      input.receiptId ?? null,
      input.agentSessionId ?? null,
      input.capabilityCallId ?? null,
      input.outcome,
      input.failureCode ?? null,
      input.auditEventId ?? null,
      input.usedAt
    );

  return requireVaultUseRecord(db, input.useId);
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
 * Imports workspace-scoped vault use records into a staged workspace database.
 *
 * @param db Workspace database handle.
 * @param records Imported non-secret vault use records.
 */
export function importWorkspaceVaultUseRecords(
  db: WorkspaceDb,
  records: readonly VaultUseRecord[]
): void {
  for (const record of records) {
    createVaultUseRecord(db, record);
  }
}

/**
 * Reads one vault use record or throws a readable error.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param useId Vault use id.
 * @returns Vault use record.
 * @throws Error when the record does not exist.
 */
function requireVaultUseRecord(db: VaultUseDb, useId: string): VaultUseRecord {
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
function assertVaultUseScope(db: VaultUseDb, input: CreateVaultUseRecordInput): void {
  if (input.ownerScope === 'server' && input.workspaceId) {
    throw new Error('Server-scoped vault use records cannot include workspaceId.');
  }

  if (input.ownerScope === 'workspace' && !input.workspaceId) {
    throw new Error('Workspace-scoped vault use records require workspaceId.');
  }

  if ('scope' in db && input.ownerScope !== db.scope) {
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
function assertVaultUseResolution(input: CreateVaultUseRecordInput): void {
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
function vaultUseSelectSql(): string {
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
function mapVaultUseRow(row: VaultUseRow): VaultUseRecord {
  return {
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
}
