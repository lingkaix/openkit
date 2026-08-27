import type { CoreDb } from '../storage/db.js';
import type {
  VaultReferenceBackendKind,
  VaultReferenceOwnerScope,
  VaultReferenceStatus,
} from '../storage/schema/index.js';

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
  /** ISO timestamp for reference creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest metadata update. */
  readonly updatedAt: string;
}

/** Raw SQLite row for one vault reference. */
interface VaultReferenceRow {
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
 * Creates one non-secret vault reference idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference metadata to store.
 * @returns Stored vault reference record.
 * @throws Error when scope identity fields are inconsistent.
 */
export function createVaultReference(
  coreDb: CoreDb,
  input: CreateVaultReferenceInput
): VaultReferenceRecord {
  return createVaultReferenceWithInsertEvidence(coreDb, input).reference;
}

/**
 * Creates one non-secret vault reference and reports whether this call inserted it.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference metadata to store.
 * @returns Insert evidence and the exact stored vault reference record.
 * @throws Error when scope identity fields are inconsistent or the stored row cannot be read.
 */
export function createVaultReferenceWithInsertEvidence(
  coreDb: CoreDb,
  input: CreateVaultReferenceInput
): CreateVaultReferenceResult {
  assertVaultReferenceScope(input);
  const timestamp = input.now?.() ?? new Date().toISOString();

  const result = coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_references (
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.referenceId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.userId ?? null,
      input.displayName,
      input.secretKind,
      input.backendKind,
      input.backendLocator ?? null,
      'active',
      1,
      timestamp,
      timestamp
    );

  return {
    inserted: result.changes === 1,
    reference: requireVaultReference(coreDb, input.referenceId),
  };
}

/**
 * Advances an active vault reference by exactly one material version.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference id, exact backend material version, and optional clock.
 * @returns The unchanged record for an equal version or the exact advanced record.
 * @throws Error when the reference is missing, revoked, rolled back, skipped, or concurrently changed.
 */
export function advanceActiveVaultReferenceVersion(
  coreDb: CoreDb,
  input: AdvanceActiveVaultReferenceVersionInput
): VaultReferenceRecord {
  const reference = requireVaultReference(coreDb, input.referenceId);

  if (reference.status !== 'active') {
    throw new Error(`Vault reference is not active: ${input.referenceId}`);
  }
  if (input.currentVersion === reference.currentVersion) {
    return reference;
  }
  if (input.currentVersion !== reference.currentVersion + 1) {
    throw new Error(`Vault reference version must advance by exactly one: ${input.referenceId}`);
  }

  const result = coreDb.sqlite
    .prepare(
      `UPDATE vault_references
        SET current_version = ?, updated_at = ?
        WHERE reference_id = ? AND status = 'active' AND current_version = ?`
    )
    .run(
      input.currentVersion,
      input.now?.() ?? new Date().toISOString(),
      input.referenceId,
      reference.currentVersion
    );

  if (result.changes !== 1) {
    throw new Error(`Vault reference version changed concurrently: ${input.referenceId}`);
  }

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Revokes one vault reference and marks dependent grants and sessions stale.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference revocation input.
 * @returns Revoked reference record.
 * @throws Error when the reference does not exist.
 */
export function revokeVaultReference(
  coreDb: CoreDb,
  input: RevokeVaultReferenceInput
): VaultReferenceRecord {
  return coreDb.sqlite.transaction(() => {
    requireVaultReference(coreDb, input.referenceId);
    const timestamp = input.now?.() ?? new Date().toISOString();

    coreDb.sqlite
      .prepare(
        "UPDATE vault_references SET status = 'revoked', updated_at = ? WHERE reference_id = ?"
      )
      .run(timestamp, input.referenceId);
    coreDb.sqlite
      .prepare(
        `UPDATE vault_injection_receipts
          SET revocation_status = 'stale-session'
          WHERE revocation_status = 'active'
            AND grant_id IN (
              SELECT grant_id FROM vault_grants WHERE vault_reference_id = ?
            )`
      )
      .run(input.referenceId);
    coreDb.sqlite
      .prepare(
        `UPDATE vault_injection_plans
          SET status = 'revoked'
          WHERE status = 'active'
            AND grant_id IN (
              SELECT grant_id FROM vault_grants WHERE vault_reference_id = ?
            )`
      )
      .run(input.referenceId);
    coreDb.sqlite
      .prepare("UPDATE vault_grants SET status = 'revoked' WHERE vault_reference_id = ?")
      .run(input.referenceId);

    return requireVaultReference(coreDb, input.referenceId);
  })();
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
 * Imports one workspace-scoped vault reference without binding secret material.
 *
 * @param coreDb Open Core database handle.
 * @param input Imported non-secret reference metadata.
 * @returns Stored unbound vault reference record.
 */
export function importUnboundWorkspaceVaultReference(
  coreDb: CoreDb,
  input: ImportUnboundWorkspaceVaultReferenceInput
): VaultReferenceRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT INTO vault_references (
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
        created_at,
        updated_at
      ) VALUES (?, 'workspace', ?, NULL, ?, ?, ?, NULL, 'unbound', 0, ?, ?)`
    )
    .run(
      input.referenceId,
      input.workspaceId,
      input.displayName,
      input.secretKind,
      input.backendKind,
      timestamp,
      timestamp
    );

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Marks one imported workspace vault reference as rebound to local secret material.
 *
 * @param coreDb Open Core database handle.
 * @param input Local rebind metadata.
 * @returns Active vault reference record.
 * @throws Error when the reference is missing, not workspace-scoped, not owned by the workspace, or not unbound.
 */
export function rebindWorkspaceVaultReference(
  coreDb: CoreDb,
  input: RebindWorkspaceVaultReferenceInput
): VaultReferenceRecord {
  const reference = requireVaultReference(coreDb, input.referenceId);

  if (reference.ownerScope !== 'workspace' || reference.workspaceId !== input.workspaceId) {
    throw new Error(`Workspace vault reference not found: ${input.referenceId}`);
  }
  if (reference.status !== 'unbound') {
    throw new Error(`Workspace vault reference is not unbound: ${input.referenceId}`);
  }
  if (input.currentVersion < 1) {
    throw new Error('Rebound vault reference version must be positive.');
  }

  coreDb.sqlite
    .prepare(
      `UPDATE vault_references
        SET backend_kind = ?,
          backend_locator = ?,
          status = 'active',
          current_version = ?,
          updated_at = ?
        WHERE reference_id = ?`
    )
    .run(
      input.backendKind,
      input.backendLocator,
      input.currentVersion,
      input.now?.() ?? new Date().toISOString(),
      input.referenceId
    );

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Reads one vault reference or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param referenceId Vault reference id.
 * @returns Vault reference record.
 * @throws Error when the reference does not exist.
 */
function requireVaultReference(coreDb: CoreDb, referenceId: string): VaultReferenceRecord {
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
function assertVaultReferenceScope(input: CreateVaultReferenceInput): void {
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
}

/**
 * Returns the common vault reference SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
function vaultReferenceSelectSql(): string {
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
function mapVaultReferenceRow(row: VaultReferenceRow): VaultReferenceRecord {
  return {
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
