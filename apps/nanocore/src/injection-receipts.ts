import { getInjectionPlan } from './injection-plans.js';
import type { CoreDb } from './storage/db.js';
import type { InjectionReceiptRevocationStatus } from './storage/schema/index.js';

/** Durable non-secret injection receipt record. */
export interface InjectionReceiptRecord {
  /** Stable injection receipt id. */
  readonly receiptId: string;
  /** Injection plan used by this receipt. */
  readonly planId: string;
  /** Vault grant used by this receipt. */
  readonly grantId: string;
  /** Agent session id when the receipt belongs to a session. */
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
  readonly revocationStatus: InjectionReceiptRevocationStatus;
  /** Linked audit event id when available. */
  readonly auditEventId: string | null;
}

/** Raw SQLite row for one injection receipt. */
interface InjectionReceiptRow {
  readonly receipt_id: string;
  readonly plan_id: string;
  readonly grant_id: string;
  readonly agent_session_id: string | null;
  readonly capability_call_id: string | null;
  readonly backend_summary: string;
  readonly injected_at: string;
  readonly expires_at: string | null;
  readonly revocation_status: InjectionReceiptRevocationStatus;
  readonly audit_event_id: string | null;
}

/** Input used to create one non-secret injection receipt. */
export interface CreateInjectionReceiptInput {
  /** Stable injection receipt id. */
  readonly receiptId: string;
  /** Injection plan used by this receipt. */
  readonly planId: string;
  /** Vault grant used by this receipt. */
  readonly grantId: string;
  /** Agent session id when the receipt belongs to a session. */
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
  readonly revocationStatus: InjectionReceiptRevocationStatus;
  /** Linked audit event id when available. */
  readonly auditEventId?: string | null;
}

/**
 * Creates one non-secret injection receipt idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Receipt metadata to store.
 * @returns Stored injection receipt record.
 * @throws Error when the referenced plan is missing or receipt linkage is invalid.
 */
export function createInjectionReceipt(
  coreDb: CoreDb,
  input: CreateInjectionReceiptInput
): InjectionReceiptRecord {
  assertReceiptActor(input);

  const plan = getInjectionPlan(coreDb, input.planId);

  if (!plan) {
    throw new Error(`Injection plan not found: ${input.planId}`);
  }

  if (plan.grantId !== input.grantId) {
    throw new Error('Injection receipt grant id must match the injection plan grant id.');
  }

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO injection_receipts (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.receiptId,
      input.planId,
      input.grantId,
      input.agentSessionId ?? null,
      input.capabilityCallId ?? null,
      input.backendSummary,
      input.injectedAt,
      input.expiresAt ?? null,
      input.revocationStatus,
      input.auditEventId ?? null
    );

  return requireInjectionReceipt(coreDb, input.receiptId);
}

/**
 * Reads one injection receipt by id.
 *
 * @param coreDb Open Core database handle.
 * @param receiptId Injection receipt id.
 * @returns Injection receipt record, or null.
 */
export function getInjectionReceipt(
  coreDb: CoreDb,
  receiptId: string
): InjectionReceiptRecord | null {
  const row = coreDb.sqlite
    .prepare(`${injectionReceiptSelectSql()} WHERE receipt_id = ?`)
    .get(receiptId) as InjectionReceiptRow | undefined;

  return row ? mapInjectionReceiptRow(row) : null;
}

/**
 * Lists injection receipts in deterministic order.
 *
 * @param coreDb Open Core database handle.
 * @returns Stored injection receipt records.
 */
export function listInjectionReceipts(coreDb: CoreDb): InjectionReceiptRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${injectionReceiptSelectSql()} ORDER BY injected_at ASC, receipt_id ASC`)
      .all() as InjectionReceiptRow[]
  ).map(mapInjectionReceiptRow);
}

/**
 * Lists injection receipts linked to exported injection plans.
 *
 * @param coreDb Open Core database handle.
 * @param planIds Exported injection plan ids.
 * @returns Exportable non-secret injection receipt records.
 */
export function listExportableInjectionReceipts(
  coreDb: CoreDb,
  planIds: readonly string[]
): InjectionReceiptRecord[] {
  const planIdSet = new Set(planIds);

  return listInjectionReceipts(coreDb).filter((receipt) => planIdSet.has(receipt.planId));
}

/**
 * Imports non-secret injection receipt records.
 *
 * @param coreDb Open Core database handle.
 * @param receipts Imported injection receipt records.
 */
export function importInjectionReceipts(
  coreDb: CoreDb,
  receipts: readonly InjectionReceiptRecord[]
): void {
  for (const receipt of receipts) {
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO injection_receipts (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.receiptId,
        receipt.planId,
        receipt.grantId,
        receipt.agentSessionId,
        receipt.capabilityCallId,
        receipt.backendSummary,
        receipt.injectedAt,
        receipt.expiresAt,
        receipt.revocationStatus,
        receipt.auditEventId
      );
  }
}

/**
 * Reads one injection receipt or throws a readable error.
 *
 * @param coreDb Open Core database handle.
 * @param receiptId Injection receipt id.
 * @returns Injection receipt record.
 * @throws Error when the receipt does not exist.
 */
function requireInjectionReceipt(coreDb: CoreDb, receiptId: string): InjectionReceiptRecord {
  const receipt = getInjectionReceipt(coreDb, receiptId);

  if (!receipt) {
    throw new Error(`Injection receipt not found: ${receiptId}`);
  }

  return receipt;
}

/**
 * Validates receipt actor linkage fields.
 *
 * @param input Injection receipt creation input.
 * @throws Error when neither session nor capability call is present.
 */
function assertReceiptActor(input: CreateInjectionReceiptInput): void {
  if (!input.agentSessionId && !input.capabilityCallId) {
    throw new Error('Injection receipts require agentSessionId or capabilityCallId.');
  }
}

/**
 * Returns the common injection receipt SELECT clause.
 *
 * @returns SQL SELECT fragment.
 */
function injectionReceiptSelectSql(): string {
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
    FROM injection_receipts`;
}

/**
 * Maps one storage row into an injection receipt record.
 *
 * @param row SQLite injection receipt row.
 * @returns Injection receipt record.
 */
function mapInjectionReceiptRow(row: InjectionReceiptRow): InjectionReceiptRecord {
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
