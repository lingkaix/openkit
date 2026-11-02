import type { AuditEvent } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import {
  prepareAuditEvent,
  type RecordServerAuditEventInput,
  type RecordWorkspaceAuditEventInput,
} from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb, UserDb } from '../storage/db.js';
import type { VAULT_ADMIN_ACTIONS } from '../storage/vault-native-codecs.js';
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
  readonly action: (typeof VAULT_ADMIN_ACTIONS)[number];
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
  /** Exact affected Workspace when the administrative effect is Workspace-scoped. */
  readonly workspaceId?: string;
  /** Grant created by the administrative effect, when applicable. */
  readonly vaultGrantId?: string;
  /** Exact redacted source resource, including a replaced grant when applicable. */
  readonly resource?: string;
  /** Exact initiating non-secret request identity when the mutation consumes a request. */
  readonly requestId?: string;
  /** Event creation time. */
  readonly now?: Date;
}

/**
 * Records one durable server-scope vault admin audit event.
 *
 * @param input Vault admin audit event input.
 */
export async function recordVaultAdminAuditEvent(
  input: RecordVaultAdminAuditEventInput
): Promise<void> {
  const evidence = prepareVaultAdminAudit(input);
  const client = getControlStoreWorkerClient();
  await client.vault(input.coreDb, 'admin-event-insert', evidence.admin);
  await client.vault(input.coreDb, 'audit-insert', evidence.audit);
}

/** Prepares the same admin and general Audit facts for either their original separate commits or an existing outer tuple. */
export function prepareVaultAdminAudit(input: Omit<RecordVaultAdminAuditEventInput, 'coreDb'>) {
  const auditEventId = input.auditEventId ?? allocateEntityId('aud');
  const severity = input.severity ?? (input.outcome === 'succeeded' ? 'info' : 'warning');
  const now = input.now ?? new Date();
  const admin = {
    auditEventId,
    actorUserId: input.actor?.userId ?? null,
    actorKind: input.actor?.kind ?? null,
    action: input.action,
    outcome: input.outcome,
    severity,
    summary: input.summary,
    errorCode: input.errorCode ?? null,
    backendKind: input.backendKind,
    createdAt: now.toISOString(),
  };
  const audit = prepareAuditEvent({
    actor: input.actor ? { kind: 'user', id: input.actor.userId } : null,
    action: input.action,
    auditEventId,
    category: 'system',
    errorCode: input.errorCode ?? null,
    now,
    outcome: input.outcome,
    resource: input.resource ?? `vault:${input.backendKind}`,
    workspaceId: input.workspaceId ?? null,
    vaultGrantId: input.vaultGrantId ?? null,
    requestId: input.requestId ?? null,
    severity,
    summary: input.summary,
  });
  return { admin, audit };
}

/** Prepares the original Vault event on Main, then awaits its actual Core, Workspace or User evidence owner. */
export async function recordVaultAuditEvent(
  input:
    | RecordServerAuditEventInput
    | RecordWorkspaceAuditEventInput
    | (Omit<RecordServerAuditEventInput, 'coreDb' | 'workspaceId'> & { userDb: UserDb })
): Promise<AuditEvent> {
  if ('userDb' in input) {
    const event = prepareAuditEvent({ ...input, workspaceId: null });
    await getControlStoreWorkerClient().userCapability(input.userDb, {
      kind: 'user-audit',
      userId: input.userDb.userId,
      event: { ...event, workspaceId: null },
    });
    return event;
  }
  const db = 'coreDb' in input ? input.coreDb : input.workspaceDb;
  const event = prepareAuditEvent({ ...input, workspaceId: input.workspaceId ?? null });
  return getControlStoreWorkerClient().vault(db, 'audit-insert', event);
}
