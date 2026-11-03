import { listSqliteAuditEvents, recordServerAuditEvent } from '../audit-events.js';
import {
  hasWorkspaceDeletionRetryAuthorityForRequest,
  isWorkspaceOperationAuthorized,
} from '../auth/operation-authorizer.js';
import { beginWorkspaceDeletion, completeWorkspaceDeletion } from '../workspace-sharing.js';
import {
  commandRequestExpiresAt,
  commandRequestKey,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  type ControlWorkspaceDeletionInput,
  ControlWorkspaceDeletionInputSchema,
  type ControlWorkspaceDeletionResult,
} from './workspace-deletion-codecs.js';

/** Applies one original deletion tuple inside the existing Core savepoint and covering FULL commit. */
export function applyControlWorkspaceDeletion(
  db: CoreDb,
  value: ControlWorkspaceDeletionInput
): ControlWorkspaceDeletionResult {
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
  const input = ControlWorkspaceDeletionInputSchema.parse(value);
  if (input.stage === 'begin') {
    if (
      !isWorkspaceOperationAuthorized(db, presentControlFacts(input.actor), input.workspaceId, {
        mutating: true,
        policyOperation: 'workspace.lifecycle',
      })
    )
      throw new ControlProductPreconditionError();
    beginWorkspaceDeletion({
      coreDb: db,
      workspaceId: input.workspaceId,
      originalOwnerUserId: input.originalOwnerUserId,
      expectedRegistryRevision: input.expectedRegistryRevision,
    });
    return { stage: 'begin' };
  }
  if (
    !hasWorkspaceDeletionRetryAuthorityForRequest(
      db,
      presentControlFacts(input.actor),
      input.workspaceId,
      { originalOwnerUserId: input.originalOwnerUserId, initiatingUserId: input.initiatingUserId }
    )
  )
    throw new ControlProductPreconditionError();
  const recurringAudit = listSqliteAuditEvents(db.sqlite, input.workspaceId, true);
  const registry = completeWorkspaceDeletion({
    coreDb: db,
    workspaceId: input.workspaceId,
    originalOwnerUserId: input.originalOwnerUserId,
    expectedRegistryRevision: input.expectedRegistryRevision,
  });
  // The already verified closure and recovery export retain this exact Core-homed graph.
  // Remove children first; a failure rolls back the terminal registry transition too.
  db.sqlite
    .prepare(`DELETE FROM external_trigger_admissions
        WHERE schedule_id IN (SELECT id FROM recurring_schedules WHERE workspace_id = ?)`)
    .run(input.workspaceId);
  for (const table of ['recurring_occurrences', 'recurring_expired_ranges', 'recurring_schedules'])
    db.sqlite.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(input.workspaceId);
  for (const event of recurringAudit)
    db.sqlite
      .prepare('DELETE FROM audit_events WHERE workspace_id = ? AND audit_event_id = ?')
      .run(input.workspaceId, event.id);
  const audit = recordServerAuditEvent({
    action: 'workspace.delete',
    actor: { id: input.actor.userId, kind: 'user' },
    category: 'command',
    coreDb: db,
    outcome: 'succeeded',
    requestId: input.request.requestId,
    resource: `workspace:${input.workspaceId}`,
    resourceRevision: registry.registryRevision,
    summary: 'Workspace permanently deleted with verified recovery artifacts.',
    workspaceId: input.workspaceId,
  });
  const createdAt = new Date().toISOString();
  const scope = {
    coreId: 'server',
    actorId: input.actor.userId,
    targetWorkspaceId: input.workspaceId,
  };
  const key = commandRequestKey('workspace.delete', input.request.requestId, scope);
  recordControlCommandRequestRecordInDb(db, {
    key,
    command: 'workspace.delete',
    requestId: input.request.requestId,
    scope,
    inputHash: commandInputHash(input.request),
    response: { kind: 'workspace_deletion', id: input.request.requestId },
    createdAt,
    expiresAt: commandRequestExpiresAt(createdAt),
  });
  return { stage: 'complete', auditEventId: audit.id, commandReceiptKey: key };
}
