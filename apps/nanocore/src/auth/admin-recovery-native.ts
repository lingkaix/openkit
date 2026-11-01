import { recordServerAuditEvent } from '../audit-events.js';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import type { CoreDb } from '../storage/db.js';
import { insertOpenKitAccessTokenRecord } from './access-token-store.js';
import {
  type ControlAdminRecoveryInput,
  recoveryAuditSummary,
  recoveryRequired,
} from './admin-recovery-codecs.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/** Applies only the original stopped-operator Token and Audit tuple inside its native savepoint. */
export function applyControlAdminRecovery(
  coreDb: CoreDb,
  input: ControlAdminRecoveryInput
): string {
  assertControlProductWriter(coreDb.sqlite);
  if (
    !isCanonicalUserActive(coreDb, input.ownerUserId) ||
    coreDb.sqlite
      .prepare('SELECT 1 FROM openkit_access_tokens WHERE token_id = ?')
      .get(input.tokenId) ||
    coreDb.sqlite.prepare('SELECT 1 FROM audit_events WHERE request_id = ?').get(input.requestId)
  ) {
    throw recoveryRequired();
  }
  insertOpenKitAccessTokenRecord(coreDb, {
    tokenId: input.tokenId,
    tokenHash: input.tokenHash,
    ownerUserId: input.ownerUserId,
    scope: 'server-admin',
    workspaceIds: [],
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
  return recordServerAuditEvent({
    action: 'auth.admin-recovery.issue',
    actor: { id: 'openkit-operator', kind: 'system', responsibleUserId: null },
    category: 'system',
    coreDb,
    occurredAt: new Date(input.issuedAt),
    outcome: 'succeeded',
    requestId: input.requestId,
    resource: `auth-token:${input.tokenId}`,
    severity: 'info',
    subject: { id: input.ownerUserId, kind: 'user' },
    summary: recoveryAuditSummary(input.expiresAt),
    now: new Date(input.issuedAt),
  }).id;
}
