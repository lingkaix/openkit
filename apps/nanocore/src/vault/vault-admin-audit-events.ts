import { randomUUID } from 'node:crypto';
import { recordServerAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import type { CoreDb } from '../storage/db.js';
import type { VaultBackendKind } from './vault-backend.js';

/** Input for recording one server-owned vault admin audit event. */
export interface RecordVaultAdminAuditEventInput {
  /** Server-scope database that owns the event. */
  readonly coreDb: CoreDb;
  /** Stable audit event id for deterministic tests. */
  readonly auditEventId?: string;
  /** Actor that requested the admin operation. */
  readonly actor?: Actor;
  /** Stable admin action name. */
  readonly action:
    | 'vault.unlock'
    | 'vault.lock'
    | 'vault.bootstrap_codex_auth_json'
    | 'vault.rebind_workspace_reference';
  /** Event outcome. */
  readonly outcome: 'succeeded' | 'failed' | 'denied';
  /** Event severity. */
  readonly severity?: 'info' | 'warning' | 'error';
  /** Redacted event summary. */
  readonly summary: string;
  /** Stable error code when applicable. */
  readonly errorCode?: string | null;
  /** Backend kind administered by the action. */
  readonly backendKind: VaultBackendKind;
  /** Event creation time. */
  readonly now?: Date;
}

/**
 * Records one durable server-scope vault admin audit event.
 *
 * @param input Vault admin audit event input.
 */
export function recordVaultAdminAuditEvent(input: RecordVaultAdminAuditEventInput): void {
  const auditEventId = input.auditEventId ?? `aud_${randomUUID()}`;
  const severity = input.severity ?? (input.outcome === 'succeeded' ? 'info' : 'warning');
  const now = input.now ?? new Date();

  input.coreDb.sqlite
    .prepare(
      `INSERT INTO vault_admin_audit_events (
        audit_event_id,
        actor_user_id,
        actor_kind,
        action,
        outcome,
        severity,
        summary,
        error_code,
        backend_kind,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      auditEventId,
      input.actor?.userId ?? null,
      input.actor?.kind ?? null,
      input.action,
      input.outcome,
      severity,
      input.summary,
      input.errorCode ?? null,
      input.backendKind,
      now.toISOString()
    );

  recordServerAuditEvent({
    action: input.action,
    auditEventId,
    category: 'system',
    coreDb: input.coreDb,
    errorCode: input.errorCode ?? null,
    now,
    outcome: input.outcome,
    resource: `vault:${input.backendKind}`,
    severity,
    summary: input.summary,
  });
}
