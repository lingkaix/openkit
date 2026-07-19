import { randomUUID } from 'node:crypto';
import { type AuditEvent, AuditEventSchema } from '@openkit/protocol';

import type { CoreDb, WorkspaceDb } from './storage/db.js';

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
  /** Exact affected subject reference when available. */
  subject?: AuditEvent['subject'];
  /** Agent lineage when available. */
  agentId?: string | null;
  /** Agent session lineage when available. */
  agentSessionId?: string | null;
  /** Audit category. */
  category?: AuditEvent['category'];
  /** Stable action name. */
  action: string;
  /** Redacted resource reference. */
  resource?: string | null;
  /** Positive authority revision after the mutation when applicable. */
  resourceRevision?: number | null;
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
  /** Exact affected subject reference when available. */
  subject?: AuditEvent['subject'];
  /** Agent lineage when available. */
  agentId?: string | null;
  /** Agent session lineage when available. */
  agentSessionId?: string | null;
  /** Audit category. */
  category?: AuditEvent['category'];
  /** Stable action name. */
  action: string;
  /** Redacted resource reference. */
  resource?: string | null;
  /** Positive authority revision after the mutation when applicable. */
  resourceRevision?: number | null;
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

  return recordAuditEvent(input.workspaceDb.sqlite, {
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

  return recordAuditEvent(input.coreDb.sqlite, {
    ...input,
    workspaceId: input.workspaceId ?? null,
  });
}

/**
 * Lists workspace audit events as protocol records for export.
 *
 * @param workspaceDb Workspace database that owns the events.
 * @param workspaceId Workspace id to export.
 * @returns Protocol audit events in stable storage order.
 */
export function listWorkspaceAuditEvents(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): AuditEvent[] {
  return workspaceDb.sqlite
    .prepare(
      `SELECT
        audit_event_id,
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
        subject_json,
        agent_id,
        agent_session_id,
        category,
        action,
        resource,
        resource_revision,
        outcome,
        severity,
        summary,
        error_code,
        created_at,
        occurred_at
      FROM audit_events
      WHERE workspace_id = ?
      ORDER BY created_at, audit_event_id`
    )
    .all(workspaceId)
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
        subject_json,
        agent_id,
        agent_session_id,
        category,
        action,
        resource,
        resource_revision,
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
    id: input.auditEventId ?? `aud_${randomUUID()}`,
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
    subject: input.subject ?? null,
    agentId: input.agentId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    category: input.category ?? 'system',
    action: input.action,
    resource: input.resource ?? null,
    resourceRevision: input.resourceRevision ?? null,
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
  sqlite
    .prepare(
      `INSERT INTO audit_events (
        audit_event_id,
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
        subject_json,
        agent_id,
        agent_session_id,
        category,
        action,
        resource,
        resource_revision,
        outcome,
        severity,
        summary,
        error_code,
        created_at,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id,
      event.workspaceId,
      event.protocolVersion ?? null,
      event.threadId,
      event.turnId,
      event.itemId,
      event.capabilityCallId,
      event.permissionDecisionId,
      event.vaultGrantId,
      event.requestId,
      event.actor === null ? null : JSON.stringify(event.actor),
      event.subject === null ? null : JSON.stringify(event.subject),
      event.agentId,
      event.agentSessionId,
      event.category,
      event.action,
      event.resource,
      event.resourceRevision,
      event.outcome,
      event.severity,
      event.summary,
      event.errorCode,
      event.createdAt,
      event.occurredAt
    );
}

/** Converts one SQLite audit row into a protocol audit event. */
function auditEventFromRow(row: unknown): AuditEvent {
  const event = row as Record<string, unknown>;

  return AuditEventSchema.parse({
    id: event.audit_event_id,
    workspaceId: event.workspace_id,
    protocolVersion: event.protocol_version ?? undefined,
    threadId: event.thread_id,
    turnId: event.turn_id,
    itemId: event.item_id,
    capabilityCallId: event.capability_call_id,
    permissionDecisionId: event.permission_decision_id,
    vaultGrantId: event.vault_grant_id,
    requestId: event.request_id,
    actor: event.actor_json ? JSON.parse(String(event.actor_json)) : null,
    subject: event.subject_json ? JSON.parse(String(event.subject_json)) : null,
    agentId: event.agent_id,
    agentSessionId: event.agent_session_id,
    category: event.category,
    action: event.action,
    resource: event.resource,
    resourceRevision: event.resource_revision ?? null,
    outcome: event.outcome,
    severity: event.severity,
    summary: event.summary,
    errorCode: event.error_code,
    createdAt: event.created_at,
    occurredAt: event.occurred_at,
  });
}

/**
 * Fails closed when an attempted audit value contains obvious raw sensitive or payload fields.
 *
 * @param value Value to inspect recursively.
 */
function assertNoUnsafeAuditValue(value: unknown): void {
  if (findUnsafeAuditKey(value)) {
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
  return requestId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    ? requestId
    : null;
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
