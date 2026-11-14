import { isDeepStrictEqual } from 'node:util';
import { deriveEntityId, responsibleUserIdForActor } from '@openkit/protocol';
import { auditEventFromRow, recordServerAuditEvent } from '../audit-events.js';
import { findNamedAgentEnvironmentPackageSnapshotAtDataRoot } from '../runtime/aep-snapshot-ledger.js';
import {
  listRestorableNanoHostExecutionAttempts,
  resolveLiveNanoHostAttemptLease,
} from '../runtime/nanohost-attempt-records.js';
import {
  classifySecurityCanaryRequest,
  createSecurityCanaryMcpSupply,
  SECURITY_CANARY_TOOLS,
} from '../security/canaries.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { SECURITY_CONTAINMENT_LIMITS, SECURITY_OBSERVATION_LIMITS } from './core-journal-codecs.js';
import type { CoreDb } from './db.js';
import { applySecurityTriggerInDb } from './security-trigger-native.js';
import {
  type ControlStandaloneAuditInput,
  ControlStandaloneAuditInputSchema,
  SECURITY_CANARY_AUDIT_FACT,
} from './standalone-audit-codecs.js';

/**
 * Original immutable AEP evidence is read through its file owner, without opening
 * a Workspace connection or pretending cross-host database handles can be borrowed.
 * Live lease, checked E4 and original Server Audit publication share Core's savepoint;
 * the immutable Workspace file read is not claimed atomic with another database.
 */
export function prepareSecurityCanaryAuditInDb(
  coreDb: CoreDb,
  input: ControlStandaloneAuditInput
): 'new' | 'existing' | 'inactive' | 'excess' {
  const refuse = (): never => {
    throw new ControlProductPreconditionError();
  };
  const lineage = input.canaryLineage;
  if (
    coreDb.scope !== 'core' ||
    !coreDb.sqlite.inTransaction ||
    input.stage !== 'security.canary' ||
    !lineage
  )
    return refuse();

  // Claimed ids are only selectors. Resolve the existing retained owner and exact
  // live lease before reading the original package named by that actual attempt.
  const attempts = listRestorableNanoHostExecutionAttempts(coreDb).filter(
    (attempt) =>
      attempt.inputRef === lineage.packageSnapshotId &&
      attempt.workspaceId === lineage.workspaceId &&
      attempt.threadId === lineage.threadId &&
      attempt.turnId === lineage.turnId &&
      attempt.agentSessionId === lineage.agentSessionId
  );
  if (attempts.length !== 1) return refuse();
  const live = resolveLiveNanoHostAttemptLease(coreDb, {
    attemptId: attempts[0]!.attemptId,
    lineage,
  });
  if (live.status !== 'accepted') return refuse();
  const nativeWorkspaceId = live.attempt.workspaceId;
  if (!nativeWorkspaceId) return refuse();

  const original = findNamedAgentEnvironmentPackageSnapshotAtDataRoot(
    coreDb.dataRoot,
    nativeWorkspaceId,
    live.attempt.agentSessionId,
    live.attempt.inputRef
  )?.snapshot;
  if (!original) return refuse();
  const scope = original.scope;
  if (
    original.snapshotId !== lineage.packageSnapshotId ||
    scope.workspaceId !== lineage.workspaceId ||
    scope.threadId !== lineage.threadId ||
    scope.turnId !== lineage.turnId ||
    scope.agentSessionId !== lineage.agentSessionId ||
    (scope.requestId ?? null) !== (lineage.requestId ?? null)
  )
    return refuse();
  const originalAgentActor = {
    kind: 'agent',
    id: original.agent.agentId,
    responsibleUserId: responsibleUserIdForActor(scope.triggerActor),
  };
  // The triggering AEP owns responsibility, not the caller or E4's administrator.
  const isOriginalAgentEvent = (
    event: Pick<ControlStandaloneAuditInput['event'], 'agentId' | 'itemId' | 'actor' | 'subject'>
  ): boolean =>
    event.agentId === original.agent.agentId &&
    event.itemId === (scope.itemId ?? null) &&
    isDeepStrictEqual(event.actor, originalAgentActor) &&
    isDeepStrictEqual(event.subject, originalAgentActor);
  if (!isOriginalAgentEvent(input.event)) return refuse();

  // CURRENT remains the E4 owner's checked operation and may own R8 maintenance.
  // An inactive result ACKs without Audit rather than rolling that maintenance back.
  const current = applySecurityTriggerInDb(coreDb, {
    action: 'current',
    timestamp: input.event.occurredAt,
  });
  if (current.kind !== 'state') return refuse();
  if (current.snapshot.state !== 'on' || !current.snapshot.delegationCurrent) return 'inactive';
  const source = createSecurityCanaryMcpSupply();
  if (
    !classifySecurityCanaryRequest(
      original,
      {
        method: 'tools/call',
        serverId: source.id,
        toolName: SECURITY_CANARY_TOOLS[0]!.name,
      },
      current.snapshot.state
    ).observe
  )
    return refuse();

  // Keep the first original Audit id: one fact per execution/source descriptor,
  // no UUID derivation, caller-request expansion, new table, counter or writer.
  const rows = coreDb.sqlite
    .prepare(`SELECT * FROM audit_events
    WHERE action=? AND workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=?
      AND resource=? AND resource_revision IS NULL LIMIT 2`)
    .all(
      SECURITY_CANARY_AUDIT_FACT.action,
      scope.workspaceId,
      scope.threadId,
      scope.turnId,
      scope.agentSessionId,
      SECURITY_CANARY_AUDIT_FACT.resource
    );
  if (rows.length > 1) return refuse();
  if (rows.length === 1) {
    const originalEvent = auditEventFromRow(rows[0]);
    if (
      !ControlStandaloneAuditInputSchema.safeParse({ ...input, event: originalEvent }).success ||
      !isOriginalAgentEvent(originalEvent)
    )
      return refuse();
    return 'existing';
  }
  const windowStart = containmentWindowStart();
  const admitted = coreDb.sqlite
    .prepare(`SELECT workspace_id AS workspaceId FROM audit_events
    WHERE action='security.canary' AND created_at>=? LIMIT ?`)
    .all(windowStart, SECURITY_OBSERVATION_LIMITS.serverWindow + 1) as {
    workspaceId: string | null;
  }[];
  if (
    admitted.length >= SECURITY_OBSERVATION_LIMITS.serverWindow ||
    admitted.filter((row) => row.workspaceId === scope.workspaceId).length >=
      SECURITY_OBSERVATION_LIMITS.workspaceWindow
  ) {
    recordContainmentGapInDb(
      coreDb,
      'observation-bound',
      lineage.workspaceId,
      null,
      current.snapshot.enablingUserId
    );
    return 'excess';
  }
  return 'new';
}

/** The fixed UTC window never comes from a sensor or a caller clock. */
function containmentWindowStart(): string {
  const width = SECURITY_CONTAINMENT_LIMITS.windowSeconds * 1000;
  return new Date(Math.floor(Date.now() / width) * width).toISOString();
}

/**
 * Append-only bounded excess evidence. The sixteenth observation explicitly saturates the count;
 * later loss is unknown, never described as contained. No mutable Audit or counter owner is added.
 */
export function recordContainmentGapInDb(
  db: CoreDb,
  reason:
    | 'observation-bound'
    | 'capacity'
    | 'review-overdue'
    | 'shared-resource'
    | 'control-unknown',
  workspaceId: string | null,
  sourceAuditEventId: string | null,
  responsibleUserId: string | null
): string | null {
  const windowStart = containmentWindowStart();
  const resource = `containment-gap:${windowStart}`;
  const rows = db.sqlite
    .prepare(`SELECT audit_event_id AS id FROM audit_events
    WHERE action='security.containment.gap' AND resource=? AND created_at>=? LIMIT ?`)
    .all(resource, windowStart, SECURITY_OBSERVATION_LIMITS.gapWindow + 1) as { id: string }[];
  if (rows.length > SECURITY_OBSERVATION_LIMITS.gapWindow)
    throw new ControlProductPreconditionError();
  if (rows.length === SECURITY_OBSERVATION_LIMITS.gapWindow) return null;
  const count = rows.length + 1;
  const id = deriveEntityId('aud', ['containment-gap', windowStart, count]);
  recordServerAuditEvent({
    coreDb: db,
    auditEventId: id,
    workspaceId,
    actor: { kind: 'system', id: 'security.containment', responsibleUserId },
    action: 'security.containment.gap',
    category: 'system',
    outcome: 'denied',
    severity: 'warning',
    resource,
    summary: JSON.stringify({
      reason,
      sourceAuditEventId,
      windowStart,
      observedExcess: count,
      saturated: count === SECURITY_OBSERVATION_LIMITS.gapWindow,
      gap:
        count === SECURITY_OBSERVATION_LIMITS.gapWindow
          ? 'Additional excess observations are uncounted.'
          : 'No additional restriction is proved.',
    }),
  });
  return id;
}
