import { isDeepStrictEqual } from 'node:util';
import {
  AuditAuthenticationSchema,
  type AuditEvent,
  AuditEventSchema,
  allocateEntityId,
  type KnowledgeOwnerScope,
  PolicyInvocationV1Schema,
  PolicyWriteOutcomeV1Schema,
  RequestIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { readAuditEventRowV1 } from './policy/retained-records-v1.js';
import type { CoreDb, UserDb, WorkspaceDb } from './storage/db.js';

/** Input for recording one server-owned audit event. */
export interface RecordServerAuditEventInput {
  /** Server-scoped database handle. */
  coreDb: CoreDb;
  /** Stable audit event id for deterministic tests. */
  auditEventId?: string;
  /** Workspace affected by one Core-owned lifecycle event. */
  workspaceId?: string | null;
  /** Protocol version when the producer records one. */
  protocolVersion?: string;
  /** Thread lineage when available. */
  threadId?: string | null;
  /** Turn lineage when available. */
  turnId?: string | null;
  /** Item lineage when available. */
  itemId?: string | null;
  /** Capability call lineage when available. */
  capabilityCallId?: string | null;
  /** Permission decision lineage when available. */
  permissionDecisionId?: string | null;
  /** Vault grant lineage when available. */
  vaultGrantId?: string | null;
  /** Request id when available. */
  requestId?: string | null;
  /** Exact authenticated actor reference when available. */
  actor?: AuditEvent['actor'];
  /** Allowlisted non-secret authentication method and credential record id. */
  authentication?: AuditEvent['authentication'];
  /** Exact affected subject reference when available. */
  subject?: AuditEvent['subject'];
  /** Agent lineage when available. */
  agentId?: string | null;
  /** AgentSession lineage when available. */
  agentSessionId?: string | null;
  /** Audit category. */
  category?: AuditEvent['category'];
  /** Stable action name. */
  action: string;
  /** Redacted resource reference. */
  resource?: string | null;
  /** Positive authority revision after the mutation when applicable. */
  resourceRevision?: number | null;
  /** Exact notebook admission facts, never page bodies or a reusable permission. */
  notebookAdmission?: AuditEvent['notebookAdmission'];
  /** Exact non-secret participant evidence. */
  policyInvocation?: AuditEvent['policyInvocation'];
  /** Exact Policy write persistence and activation outcome. */
  policyWriteOutcome?: AuditEvent['policyWriteOutcome'];
  /** Event outcome. */
  outcome: AuditEvent['outcome'];
  /** Event severity. */
  severity?: AuditEvent['severity'];
  /** Redacted summary. */
  summary: string;
  /** Stable error code when applicable. */
  errorCode?: string | null;
  /** Event occurrence timestamp. */
  occurredAt?: Date;
  /** Storage creation time. */
  now?: Date;
}

/** Input for recording one workspace-owned audit event. */
export interface RecordWorkspaceAuditEventInput {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Stable audit event id for deterministic tests. */
  auditEventId?: string;
  /** Workspace that owns the event. */
  workspaceId: string;
  /** Protocol version when the producer records one. */
  protocolVersion?: string;
  /** Thread lineage when available. */
  threadId?: string | null;
  /** Turn lineage when available. */
  turnId?: string | null;
  /** Item lineage when available. */
  itemId?: string | null;
  /** Capability call lineage when available. */
  capabilityCallId?: string | null;
  /** Permission decision lineage when available. */
  permissionDecisionId?: string | null;
  /** Vault grant lineage when available. */
  vaultGrantId?: string | null;
  /** Request id when available. */
  requestId?: string | null;
  /** Exact authenticated actor reference when available. */
  actor?: AuditEvent['actor'];
  /** Allowlisted non-secret authentication method and credential record id. */
  authentication?: AuditEvent['authentication'];
  /** Exact affected subject reference when available. */
  subject?: AuditEvent['subject'];
  /** Agent lineage when available. */
  agentId?: string | null;
  /** AgentSession lineage when available. */
  agentSessionId?: string | null;
  /** Audit category. */
  category?: AuditEvent['category'];
  /** Stable action name. */
  action: string;
  /** Redacted resource reference. */
  resource?: string | null;
  /** Positive authority revision after the mutation when applicable. */
  resourceRevision?: number | null;
  /** Exact notebook admission facts, never page bodies or a reusable permission. */
  notebookAdmission?: AuditEvent['notebookAdmission'];
  /** Exact non-secret participant evidence. */
  policyInvocation?: AuditEvent['policyInvocation'];
  /** Exact Policy write persistence and activation outcome. */
  policyWriteOutcome?: AuditEvent['policyWriteOutcome'];
  /** Event outcome. */
  outcome: AuditEvent['outcome'];
  /** Event severity. */
  severity?: AuditEvent['severity'];
  /** Redacted summary. */
  summary: string;
  /** Stable error code when applicable. */
  errorCode?: string | null;
  /** Event occurrence timestamp. */
  occurredAt?: Date;
  /** Storage creation time. */
  now?: Date;
}

/**
 * Records one protocol-valid workspace audit event.
 *
 * @param input Workspace event context and database handle.
 * @returns Protocol audit event stored in SQLite.
 */
export function recordWorkspaceAuditEvent(input: RecordWorkspaceAuditEventInput): AuditEvent {
  const { workspaceDb: _workspaceDb, now: _now, occurredAt: _occurredAt, ...safeInput } = input;
  assertNoUnsafeAuditValue(safeInput);
  assertNotebookAuditScope(input.notebookAdmission, {
    kind: 'workspace',
    workspaceId: input.workspaceDb.workspaceId,
  });
  if (input.notebookAdmission && input.workspaceId !== input.workspaceDb.workspaceId)
    throw new Error('Notebook Audit owner does not match its Workspace database.');

  return recordAuditEvent(input.workspaceDb.sqlite, {
    ...input,
    workspaceId: input.workspaceId,
  });
}

/** Records existing-Audit facts in the original User database without changing Memory ownership. */
export function recordUserAuditEvent(
  input: Omit<RecordServerAuditEventInput, 'coreDb' | 'workspaceId'> & { readonly userDb: UserDb }
): AuditEvent {
  const { userDb, now: _now, occurredAt: _occurredAt, ...safeInput } = input;
  assertNoUnsafeAuditValue(safeInput);
  assertNotebookAuditScope(input.notebookAdmission, { kind: 'user', userId: userDb.userId });
  return recordAuditEvent(userDb.sqlite, { ...input, workspaceId: null });
}

/**
 * Records one protocol-valid audit event in an app-scoped database.
 *
 * @param input App event context and SQLite handle.
 * @returns Protocol audit event stored in SQLite.
 */
export function recordAppAuditEvent(
  input: Omit<RecordWorkspaceAuditEventInput, 'workspaceDb'> & { sqlite: CoreDb['sqlite'] }
): AuditEvent {
  const { sqlite: _sqlite, now: _now, occurredAt: _occurredAt, ...safeInput } = input;
  assertNoUnsafeAuditValue(safeInput);
  assertNotebookAuditScope(input.notebookAdmission, null);

  return recordAuditEvent(input.sqlite, {
    ...input,
    workspaceId: input.workspaceId,
  });
}

/**
 * Records one protocol-valid server audit event.
 *
 * @param input Server event context and database handle.
 * @returns Protocol audit event stored in SQLite.
 */
export function recordServerAuditEvent(input: RecordServerAuditEventInput): AuditEvent {
  const { coreDb: _coreDb, now: _now, occurredAt: _occurredAt, ...safeInput } = input;
  assertNoUnsafeAuditValue(safeInput);
  assertNotebookAuditScope(input.notebookAdmission, { kind: 'server' });

  return recordAuditEvent(input.coreDb.sqlite, {
    ...input,
    workspaceId: input.workspaceId ?? null,
  });
}

/** Keeps new notebook admission evidence in its existing exact database owner; facts confer no permission. */
function assertNotebookAuditScope(
  admission: AuditEvent['notebookAdmission'],
  ownerScope: KnowledgeOwnerScope | null
): void {
  if (admission && !isDeepStrictEqual(admission.ownerScope, ownerScope))
    throw new Error('Notebook Audit owner does not match its database.');
}

/**
 * Lists workspace audit events as protocol records for export.
 *
 * @param workspaceDb Workspace database that owns the events.
 * @param workspaceId Workspace id to export.
 * @param coreDb Optional transactional home of Workspace-attributed lifecycle Audit.
 * @returns Protocol audit events in stable storage order.
 */
export function listWorkspaceAuditEvents(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  coreDb?: CoreDb
): AuditEvent[] {
  const events = listSqliteAuditEvents(workspaceDb.sqlite, workspaceId);
  if (coreDb) events.push(...listSqliteAuditEvents(coreDb.sqlite, workspaceId));
  return events.sort(
    (left, right) =>
      (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id)
  );
}

/**
 * Selects the accepted portable Workspace Audit sources without exporting deployment access history.
 *
 * @param workspaceDb Workspace-local Audit authority.
 * @param workspaceId Exact selected Workspace.
 * @param coreDb Optional home of the recurring transaction exception.
 * @returns Portable Audit events in stable export order.
 */
export function listPortableWorkspaceAuditEvents(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  coreDb?: CoreDb
): AuditEvent[] {
  const events = listSqliteAuditEvents(workspaceDb.sqlite, workspaceId);
  if (coreDb) events.push(...listSqliteAuditEvents(coreDb.sqlite, workspaceId, true));
  return events.sort(
    (left, right) =>
      (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id)
  );
}

/**
 * Lists every audit event stored in one SQLite handle.
 *
 * @param sqlite Core, User, Workspace, or App database handle.
 * @param workspaceId Selects one Workspace in SQL before decoding any event content.
 * @param portableRecurringOnly Restricts Core rows to accepted recurring actions and retained subject identity before decoding.
 * @returns Protocol audit events in stable storage order.
 */
export function listSqliteAuditEvents(
  sqlite: CoreDb['sqlite'],
  workspaceId?: string,
  portableRecurringOnly = false
): AuditEvent[] {
  if (portableRecurringOnly && workspaceId === undefined)
    throw new Error('Portable recurring Audit requires a Workspace selector.');
  return sqlite
    .prepare(
      `SELECT
        audit_event_id,
        schema_version,
        workspace_id,
        protocol_version,
        thread_id,
        turn_id,
        item_id,
        capability_call_id,
        permission_decision_id,
        vault_grant_id,
        request_id,
        actor_json,
        authentication_json,
        subject_json,
        agent_id,
        agent_session_id,
        category,
        action,
        resource,
        resource_revision,
        notebook_admission_json,
        policy_invocation_json,
        policy_write_outcome_json,
        outcome,
        severity,
        summary,
        error_code,
        created_at,
        occurred_at
      FROM audit_events event
      ${workspaceId === undefined ? '' : 'WHERE workspace_id = ?'}
      ${
        portableRecurringOnly
          ? `AND (
        (action IN ('recurring.schedule.create', 'recurring.schedule.edit',
          'recurring.schedule.pause', 'recurring.schedule.resume', 'recurring.schedule.delete')
          AND EXISTS (SELECT 1 FROM recurring_schedules source
            WHERE source.workspace_id = event.workspace_id AND source.id = event.resource))
        OR (action = 'recurring.occurrence.terminal'
          AND EXISTS (SELECT 1 FROM recurring_occurrences source
            WHERE source.workspace_id = event.workspace_id AND source.id = event.resource))
        OR (action = 'recurring.expired-range.record'
          AND EXISTS (SELECT 1 FROM recurring_expired_ranges source
            WHERE source.workspace_id = event.workspace_id AND source.id = event.resource))
      )`
          : ''
      }
      ORDER BY created_at, audit_event_id`
    )
    .all(...(workspaceId === undefined ? [] : [workspaceId]))
    .map(auditEventFromRow);
}

/**
 * Lists server audit events as protocol records.
 *
 * @param coreDb Server database that owns the events.
 * @returns Protocol audit events in stable storage order.
 */
export function listServerAuditEvents(coreDb: CoreDb): AuditEvent[] {
  return coreDb.sqlite
    .prepare(
      `SELECT
        audit_event_id,
        schema_version,
        workspace_id,
        protocol_version,
        thread_id,
        turn_id,
        item_id,
        capability_call_id,
        permission_decision_id,
        vault_grant_id,
        request_id,
        actor_json,
        authentication_json,
        subject_json,
        agent_id,
        agent_session_id,
        category,
        action,
        resource,
        resource_revision,
        notebook_admission_json,
        policy_invocation_json,
        policy_write_outcome_json,
        outcome,
        severity,
        summary,
        error_code,
        created_at,
        occurred_at
      FROM audit_events
      ORDER BY created_at, audit_event_id`
    )
    .all()
    .map(auditEventFromRow);
}

/**
 * Imports exported workspace audit events into the target workspace database.
 *
 * @param input Target database, source workspace id, target workspace id, and events.
 */
export function importWorkspaceAuditEvents(input: {
  workspaceDb: WorkspaceDb;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  events: readonly AuditEvent[];
}): void {
  for (const event of input.events) {
    insertAuditEvent(
      input.workspaceDb.sqlite,
      AuditEventSchema.parse({
        ...event,
        workspaceId: input.targetWorkspaceId,
        resource:
          event.resource === `workspace:${input.sourceWorkspaceId}`
            ? `workspace:${input.targetWorkspaceId}`
            : event.resource,
      })
    );
  }
}

/**
 * Stores one validated audit event in the provided database handle.
 *
 * @param sqlite SQLite handle that owns an `audit_events` table.
 * @param input Audit event fields.
 * @returns Protocol audit event stored in SQLite.
 */
function recordAuditEvent(
  sqlite: CoreDb['sqlite'],
  input: Omit<RecordWorkspaceAuditEventInput, 'workspaceDb' | 'workspaceId'> & {
    workspaceId: string | null;
  }
): AuditEvent {
  const createdAt = (input.now ?? new Date()).toISOString();
  const occurredAt = (input.occurredAt ?? input.now ?? new Date()).toISOString();
  const event = AuditEventSchema.parse({
    id: input.auditEventId ?? allocateEntityId('aud'),
    workspaceId: input.workspaceId,
    protocolVersion: input.protocolVersion,
    threadId: input.threadId ?? null,
    turnId: input.turnId ?? null,
    itemId: input.itemId ?? null,
    capabilityCallId: input.capabilityCallId ?? null,
    permissionDecisionId: input.permissionDecisionId ?? null,
    vaultGrantId: input.vaultGrantId ?? null,
    requestId: protocolRequestIdOrNull(input.requestId),
    actor: input.actor ?? null,
    ...(input.authentication ? { authentication: input.authentication } : {}),
    subject: input.subject ?? null,
    agentId: input.agentId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    category: input.category ?? 'system',
    action: input.action,
    resource: input.resource ?? null,
    resourceRevision: input.resourceRevision ?? null,
    ...(input.notebookAdmission ? { notebookAdmission: input.notebookAdmission } : {}),
    ...(input.policyInvocation === undefined ? {} : { policyInvocation: input.policyInvocation }),
    ...(input.policyWriteOutcome === undefined
      ? {}
      : { policyWriteOutcome: input.policyWriteOutcome }),
    outcome: input.outcome,
    severity: input.severity ?? 'info',
    summary: input.summary,
    errorCode: input.errorCode ?? null,
    createdAt,
    occurredAt,
  });

  insertAuditEvent(sqlite, event);

  return event;
}

/**
 * Stores one already validated protocol audit event.
 *
 * @param sqlite SQLite handle that owns an `audit_events` table.
 * @param event Protocol audit event to insert.
 */
function insertAuditEvent(sqlite: CoreDb['sqlite'], event: AuditEvent): void {
  // Omit unknown optional authentication so snapshot rollback keeps its captured native format.
  const values = {
    audit_event_id: event.id,
    schema_version: writeRetainedV1(event).schemaVersion,
    workspace_id: event.workspaceId,
    protocol_version: event.protocolVersion ?? null,
    thread_id: event.threadId,
    turn_id: event.turnId,
    item_id: event.itemId,
    capability_call_id: event.capabilityCallId,
    permission_decision_id: event.permissionDecisionId,
    vault_grant_id: event.vaultGrantId,
    request_id: event.requestId,
    actor_json: event.actor === null ? null : JSON.stringify(event.actor),
    ...(event.authentication === undefined
      ? {}
      : { authentication_json: JSON.stringify(event.authentication) }),
    subject_json: event.subject === null ? null : JSON.stringify(event.subject),
    agent_id: event.agentId,
    agent_session_id: event.agentSessionId,
    category: event.category,
    action: event.action,
    resource: event.resource,
    resource_revision: event.resourceRevision,
    policy_invocation_json:
      event.policyInvocation === undefined ? null : JSON.stringify(event.policyInvocation),
    policy_write_outcome_json:
      event.policyWriteOutcome === undefined ? null : JSON.stringify(event.policyWriteOutcome),
    notebook_admission_json:
      event.notebookAdmission === undefined ? null : JSON.stringify(event.notebookAdmission),
    outcome: event.outcome,
    severity: event.severity,
    summary: event.summary,
    error_code: event.errorCode,
    created_at: event.createdAt,
    occurred_at: event.occurredAt,
  };
  const columns = Object.keys(values);
  sqlite
    .prepare(
      `INSERT INTO audit_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(values));
}

/** Projects the frozen retained Audit core after validating its independent format marker. */
function auditEventFromRow(row: unknown): AuditEvent {
  return readAuditEventRowV1(row);
}

/**
 * Fails closed when an attempted audit value contains obvious raw sensitive or payload fields.
 *
 * @param value Value to inspect recursively.
 */
function assertNoUnsafeAuditValue(value: unknown): void {
  const { policyInvocation, policyWriteOutcome, authentication, ...ordinary } = value as Record<
    string,
    unknown
  >;
  // The closed typed payload admits credential kind, never credential material or arbitrary bodies.
  if (policyInvocation !== undefined) PolicyInvocationV1Schema.parse(policyInvocation);
  if (policyWriteOutcome !== undefined) PolicyWriteOutcomeV1Schema.parse(policyWriteOutcome);
  if (authentication !== undefined) AuditAuthenticationSchema.parse(authentication);
  if (findUnsafeAuditKey(ordinary)) {
    throw new Error('Audit event values must be redacted before recording.');
  }
}

/**
 * Keeps only protocol-valid request ids for audit rows.
 *
 * @param requestId Candidate request id.
 * @returns UUID request id, otherwise null.
 */
function protocolRequestIdOrNull(requestId: string | null | undefined): string | null {
  return RequestIdSchema.safeParse(requestId).data ?? null;
}

/**
 * Finds an unsafe field name in a would-be audit value.
 *
 * @param value Value to inspect recursively.
 * @returns Unsafe key when present.
 */
function findUnsafeAuditKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (/(prompt|argument|result|secret|token|credential|password|cache[_-]?key)/i.test(key)) {
      return key;
    }

    const nestedKey = findUnsafeAuditKey(nested);

    if (nestedKey) {
      return nestedKey;
    }
  }

  return null;
}
