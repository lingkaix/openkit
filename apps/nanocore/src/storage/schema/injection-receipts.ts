import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable injection receipt revocation statuses. */
export type InjectionReceiptRevocationStatus = 'active' | 'revoked' | 'expired' | 'stale-session';

/**
 * Non-secret injection receipt metadata.
 */
export const injectionReceipts = sqliteTable(
  'injection_receipts',
  {
    /** Stable injection receipt id. */
    receiptId: text('receipt_id').primaryKey().notNull(),
    /** Injection plan used by this receipt. */
    planId: text('plan_id').notNull(),
    /** Vault grant used by this receipt. */
    grantId: text('grant_id').notNull(),
    /** Agent session id when the receipt belongs to a session. */
    agentSessionId: text('agent_session_id'),
    /** Capability call id when the receipt belongs to one capability call. */
    capabilityCallId: text('capability_call_id'),
    /** Redacted backend summary. */
    backendSummary: text('backend_summary').notNull(),
    /** ISO timestamp when injection happened. */
    injectedAt: text('injected_at').notNull(),
    /** ISO timestamp when injected material expires. */
    expiresAt: text('expires_at'),
    /** Revocation status projection. */
    revocationStatus: text('revocation_status').$type<InjectionReceiptRevocationStatus>().notNull(),
    /** Linked audit event id when available. */
    auditEventId: text('audit_event_id'),
  },
  (table) => [
    index('injection_receipts_plan_idx').on(table.planId, table.revocationStatus),
    index('injection_receipts_grant_idx').on(table.grantId, table.revocationStatus),
    index('injection_receipts_session_idx').on(table.agentSessionId, table.revocationStatus),
  ]
);
