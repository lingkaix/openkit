import { randomUUID } from 'node:crypto';
import {
  type ActorRef,
  type CapabilityCall,
  CapabilityCallSchema,
  RequestIdSchema,
  responsibleUserIdForActor,
  type UsageRecord,
  UsageRecordSchema,
} from '@openkit/protocol';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { CapabilityCallFamily } from '../storage/schema/index.js';

type CapabilityCallRow = {
  call_id: string;
  workspace_id: string;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  agent_id: string | null;
  agent_session_id: string | null;
  package_snapshot_id: string | null;
  runtime_origin_ref: string | null;
  runtime_cache_lineage_ref: string | null;
  request_id: string | null;
  source_ids_json: string;
  capability_id: string;
  family: string;
  operation: string;
  summary: string | null;
  provider_ref: string | null;
  service_ref: string | null;
  redaction_class: string;
  status: string;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
};

/** Exportable capability call ledger record. */
export interface CapabilityCallLedgerRecord extends CapabilityCall {
  /** Capability family used by gateway dispatch and idempotency. */
  family: CapabilityCallFamily;
  /** Gateway operation used by idempotency. */
  operation: string;
  /** Redacted provider reference. */
  providerRef: string | null;
  /** Redacted service reference. */
  serviceRef: string | null;
  /** Redaction class applied by the producer. */
  redactionClass: string;
}

/** Gateway call context accepted by the shared capability usage ledger. */
export interface GatewayCallContext {
  /** Workspace that owns the call. */
  workspaceId: string;
  /** Process-local authority actor for linked usage attribution. */
  authorityActor: ActorRef | null;
  /** Thread lineage when available. */
  threadId?: string | null;
  /** Turn lineage when available. */
  turnId?: string | null;
  /** Item lineage when available. */
  itemId?: string | null;
  /** Agent lineage when available. */
  agentId?: string | null;
  /** AgentSession lineage when available. */
  agentSessionId?: string | null;
  /** Agent Environment Package snapshot that authorized the call. */
  packageSnapshotId?: string | null;
  /** Product-safe runtime origin correlation reference. */
  runtimeOriginRef?: string | null;
  /** Product-safe runtime cache-lineage correlation reference. */
  runtimeCacheLineageRef?: string | null;
  /** Request id used for idempotency when available. */
  requestId?: string | null;
  /** Workspace data source ids touched by this call. */
  sourceIds?: readonly string[];
  /** Capability family. */
  family: CapabilityCallFamily;
  /** Gateway operation. */
  operation: string;
  /** Product capability id. */
  capabilityId: string;
  /** Redacted summary. */
  summary?: string | null;
  /** Redacted provider reference. */
  providerRef?: string | null;
  /** Redacted service reference. */
  serviceRef?: string | null;
  /** Redaction class applied by the producer. */
  redactionClass: string;
}

/** Input for starting one capability call. */
export interface StartCapabilityCallInput extends GatewayCallContext {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Stable call id for deterministic tests. */
  callId?: string;
  /** Start time. */
  now?: Date;
}

/** Started capability call summary returned to producers. */
export interface StartedCapabilityCall {
  /** Durable call id. */
  id: string;
  /** Gateway call context copied from the stored row. */
  context: GatewayCallContext;
}

/** Usage measurement input linked to one call. */
export interface UsageMeasurementInput {
  /** Stable usage record id for deterministic tests. */
  usageId?: string;
  /** Usage category. */
  category: UsageRecord['category'];
  /** Usage unit. */
  unit: UsageRecord['unit'];
  /** Measured quantity. */
  quantity: number;
  /** LLM model id when applicable. */
  modelId?: string | null;
  /** Provider reference when applicable. */
  providerRef?: string | null;
  /** Measurement source. */
  source?: string | null;
}

/** Input for recording usage rows for one capability call. */
export interface RecordUsageInput {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Started call returned by startCapabilityCall. */
  call: StartedCapabilityCall;
  /** Usage rows to record. */
  records: UsageMeasurementInput[];
  /** Recording time. */
  now?: Date;
}

/** Input for finishing one capability call. */
export interface FinishCapabilityCallInput {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Durable call id. */
  callId: string;
  /** Terminal status. */
  status: Extract<CapabilityCall['status'], 'succeeded' | 'failed' | 'cancelled'>;
  /** Stable error code for failed or cancelled calls. */
  errorCode?: string | null;
  /** Completion time. */
  now?: Date;
}

/** Input for recovering non-terminal capability calls after restart. */
export interface RecoverRunningCapabilityCallsInput {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Recovery time. */
  now?: Date;
}

/**
 * Returns a capability-ledger-safe request id.
 *
 * @param requestId Caller-supplied request id.
 * @returns UUID request id accepted by protocol capability schemas, or null.
 */
export function normalizeCapabilityRequestId(requestId: string | null | undefined): string | null {
  const parsed = RequestIdSchema.safeParse(requestId);

  return parsed.success ? parsed.data : null;
}

/**
 * Starts one durable capability call before upstream contact.
 *
 * @param input Gateway call context and database handle.
 * @returns Durable call summary.
 */
export function startCapabilityCall(input: StartCapabilityCallInput): StartedCapabilityCall {
  const {
    workspaceDb: _workspaceDb,
    now: _now,
    callId: _callId,
    authorityActor: _authorityActor,
    ...safeInput
  } = input;
  assertNoUnsafeLedgerValue(safeInput);

  const startedAt = (input.now ?? new Date()).toISOString();
  const callId = input.callId ?? `cap_${randomUUID()}`;
  const protocolCall = CapabilityCallSchema.parse({
    id: callId,
    workspaceId: input.workspaceId,
    threadId: input.threadId ?? null,
    turnId: input.turnId ?? null,
    itemId: input.itemId ?? null,
    agentId: input.agentId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    packageSnapshotId: input.packageSnapshotId ?? null,
    runtimeOriginRef: input.runtimeOriginRef ?? null,
    runtimeCacheLineageRef: input.runtimeCacheLineageRef ?? null,
    requestId: input.requestId ?? null,
    sourceIds: normalizeSourceIds(input.sourceIds),
    capabilityId: input.capabilityId,
    status: 'running',
    summary: input.summary ?? null,
    errorCode: null,
    startedAt,
    completedAt: null,
  });

  input.workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO capability_calls (
        call_id,
        workspace_id,
        thread_id,
        turn_id,
        item_id,
        agent_id,
        agent_session_id,
        request_id,
        source_ids_json,
        capability_id,
        family,
        operation,
        status,
        summary,
        provider_ref,
        service_ref,
        redaction_class,
        error_code,
        started_at,
        completed_at,
        package_snapshot_id,
        runtime_origin_ref,
        runtime_cache_lineage_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      protocolCall.id,
      protocolCall.workspaceId,
      protocolCall.threadId,
      protocolCall.turnId,
      protocolCall.itemId,
      protocolCall.agentId,
      protocolCall.agentSessionId,
      protocolCall.requestId,
      sourceIdsJson(protocolCall.sourceIds),
      protocolCall.capabilityId,
      input.family,
      input.operation,
      protocolCall.status,
      protocolCall.summary,
      input.providerRef ?? null,
      input.serviceRef ?? null,
      input.redactionClass,
      protocolCall.errorCode,
      protocolCall.startedAt,
      protocolCall.completedAt,
      protocolCall.packageSnapshotId,
      protocolCall.runtimeOriginRef,
      protocolCall.runtimeCacheLineageRef
    );

  const stored = findCapabilityCallByIdOrIdempotency(input.workspaceDb, input);
  assertMatchingCapabilityCallAttribution(stored, protocolCall, input);

  return {
    id: stored.call_id,
    context: {
      agentId: stored.agent_id,
      agentSessionId: stored.agent_session_id,
      authorityActor: input.authorityActor,
      capabilityId: stored.capability_id,
      family: stored.family as CapabilityCallFamily,
      itemId: stored.item_id,
      operation: stored.operation,
      packageSnapshotId: stored.package_snapshot_id,
      providerRef: stored.provider_ref,
      redactionClass: stored.redaction_class,
      requestId: stored.request_id,
      runtimeCacheLineageRef: stored.runtime_cache_lineage_ref,
      runtimeOriginRef: stored.runtime_origin_ref,
      serviceRef: stored.service_ref,
      sourceIds: parseSourceIdsJson(stored.source_ids_json),
      summary: stored.summary,
      threadId: stored.thread_id,
      turnId: stored.turn_id,
      workspaceId: stored.workspace_id,
    },
  };
}

/**
 * Records measured usage linked to a started capability call.
 *
 * @param input Usage rows and durable call summary.
 */
export function recordUsage(input: RecordUsageInput): void {
  const recordedAt = (input.now ?? new Date()).toISOString();

  try {
    for (const record of input.records) {
      assertNoUnsafeLedgerValue(record);

      const usage = UsageRecordSchema.parse({
        id: record.usageId ?? `use_${randomUUID()}`,
        workspaceId: input.call.context.workspaceId,
        responsibleUserId: input.call.context.authorityActor
          ? responsibleUserIdForActor(input.call.context.authorityActor)
          : null,
        threadId: input.call.context.threadId ?? null,
        turnId: input.call.context.turnId ?? null,
        itemId: input.call.context.itemId ?? null,
        capabilityCallId: input.call.id,
        requestId: input.call.context.requestId ?? null,
        agentId: input.call.context.agentId ?? null,
        agentSessionId: input.call.context.agentSessionId ?? null,
        sourceIds: normalizeSourceIds(input.call.context.sourceIds),
        category: record.category,
        unit: record.unit,
        quantity: record.quantity,
        modelId: record.modelId ?? null,
        providerRef: record.providerRef ?? input.call.context.providerRef ?? null,
        source: record.source ?? null,
        recordedAt,
      });

      if (hasEquivalentUsageRecord(input.workspaceDb, usage)) {
        continue;
      }

      input.workspaceDb.sqlite
        .prepare(
          `INSERT INTO usage_records (
            usage_id,
            workspace_id,
            thread_id,
            turn_id,
            item_id,
            capability_call_id,
            request_id,
            agent_id,
            agent_session_id,
            responsible_user_id,
            source_ids_json,
            category,
            unit,
            quantity,
            model_id,
            provider_ref,
            source,
            recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          usage.id,
          usage.workspaceId,
          usage.threadId,
          usage.turnId,
          usage.itemId,
          usage.capabilityCallId,
          usage.requestId,
          usage.agentId,
          usage.agentSessionId,
          usage.responsibleUserId,
          sourceIdsJson(usage.sourceIds),
          usage.category,
          usage.unit,
          usage.quantity,
          usage.modelId,
          usage.providerRef,
          usage.source,
          usage.recordedAt
        );
    }
  } catch (error) {
    try {
      finishCapabilityCall({
        workspaceDb: input.workspaceDb,
        callId: input.call.id,
        errorCode: 'usage_record_failed',
        status: 'failed',
      });
    } catch {}
    throw error;
  }
}

/**
 * Checks whether a retry already recorded the same usage measurement for a call.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param usage Protocol-validated usage row.
 * @returns True when an equivalent measurement is already stored.
 */
function hasEquivalentUsageRecord(workspaceDb: WorkspaceDb, usage: UsageRecord): boolean {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT usage_id FROM usage_records
       WHERE capability_call_id IS ?
         AND category = ?
         AND unit = ?
         AND quantity = ?
         AND model_id IS ?
         AND provider_ref IS ?
         AND source IS ?
         AND source_ids_json = ?
       LIMIT 1`
    )
    .get(
      usage.capabilityCallId,
      usage.category,
      usage.unit,
      usage.quantity,
      usage.modelId,
      usage.providerRef,
      usage.source,
      sourceIdsJson(usage.sourceIds)
    ) as { usage_id: string } | undefined;

  return Boolean(row);
}

/**
 * Marks one capability call terminal.
 *
 * @param input Terminal status input.
 */
export function finishCapabilityCall(input: FinishCapabilityCallInput): void {
  const now = input.now ?? new Date();
  const completedAt = now.toISOString();
  const call = findCapabilityCallById(input.workspaceDb, input.callId);

  if (!call || call.completed_at) {
    return;
  }

  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE capability_calls
       SET status = ?, error_code = ?, completed_at = ?
       WHERE call_id = ? AND completed_at IS NULL`
    )
    .run(input.status, input.errorCode ?? null, completedAt, input.callId);

  if (result.changes === 0) {
    return;
  }

  recordWorkspaceAuditEvent({
    action: 'capability.finish',
    agentId: call.agent_id,
    agentSessionId: call.agent_session_id,
    capabilityCallId: call.call_id,
    category: 'capability',
    errorCode: input.errorCode ?? null,
    itemId: call.item_id,
    now,
    outcome: input.status,
    requestId: call.request_id,
    resource: `capability:${call.capability_id}`,
    severity: capabilityAuditSeverity(input.status),
    summary: capabilityAuditSummary(input.status, call, input.errorCode ?? null),
    threadId: call.thread_id,
    turnId: call.turn_id,
    workspaceDb: input.workspaceDb,
    workspaceId: call.workspace_id,
  });
}

/**
 * Terminates non-terminal capability calls left behind by a prior process.
 *
 * @param input Workspace database and recovery time.
 * @returns Number of recovered calls.
 */
export function recoverRunningCapabilityCalls(input: RecoverRunningCapabilityCallsInput): number {
  const now = input.now ?? new Date();
  const calls = input.workspaceDb.sqlite
    .prepare('SELECT * FROM capability_calls WHERE status = ?')
    .all('running') as CapabilityCallRow[];

  for (const call of calls) {
    finishCapabilityCall({
      callId: call.call_id,
      errorCode: 'capability_call_recovered_after_restart',
      now,
      status: 'cancelled',
      workspaceDb: input.workspaceDb,
    });
  }

  return calls.length;
}

/**
 * Lists workspace capability calls as exportable records.
 *
 * @param workspaceDb Workspace database that owns the ledger rows.
 * @param workspaceId Workspace id to export.
 * @returns Capability call records in stable storage order.
 */
export function listWorkspaceCapabilityCalls(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): CapabilityCallLedgerRecord[] {
  return workspaceDb.sqlite
    .prepare(
      `SELECT * FROM capability_calls
       WHERE workspace_id = ?
       ORDER BY started_at, call_id`
    )
    .all(workspaceId)
    .map(capabilityCallFromRow);
}

/**
 * Lists workspace usage records as protocol records.
 *
 * @param workspaceDb Workspace database that owns the usage rows.
 * @param workspaceId Workspace id to export.
 * @returns Usage records in stable storage order.
 */
export function listWorkspaceUsageRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): UsageRecord[] {
  return workspaceDb.sqlite
    .prepare(
      `SELECT * FROM usage_records
       WHERE workspace_id = ?
       ORDER BY recorded_at, usage_id`
    )
    .all(workspaceId)
    .map(usageRecordFromRow);
}

/**
 * Imports exported workspace capability usage rows into the target workspace database.
 *
 * @param input Target database and already remapped ledger records.
 */
export function importWorkspaceCapabilityUsageLedger(input: {
  workspaceDb: WorkspaceDb;
  capabilityCalls: readonly CapabilityCallLedgerRecord[];
  usageRecords: readonly UsageRecord[];
}): void {
  for (const call of input.capabilityCalls) {
    insertCapabilityCall(input.workspaceDb, call);
  }
  for (const usage of input.usageRecords) {
    insertUsageRecord(input.workspaceDb, usage);
  }
}

/**
 * Reads one capability call row by id.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param callId Capability call id.
 * @returns Stored row when present.
 */
function findCapabilityCallById(
  workspaceDb: WorkspaceDb,
  callId: string
): CapabilityCallRow | undefined {
  return workspaceDb.sqlite
    .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
    .get(callId) as CapabilityCallRow | undefined;
}

/** Inserts one exportable capability call record. */
function insertCapabilityCall(workspaceDb: WorkspaceDb, call: CapabilityCallLedgerRecord): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO capability_calls (
        call_id,
        workspace_id,
        thread_id,
        turn_id,
        item_id,
        agent_id,
        agent_session_id,
        request_id,
        source_ids_json,
        capability_id,
        family,
        operation,
        status,
        summary,
        provider_ref,
        service_ref,
        redaction_class,
        error_code,
        started_at,
        completed_at,
        package_snapshot_id,
        runtime_origin_ref,
        runtime_cache_lineage_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      call.id,
      call.workspaceId,
      call.threadId,
      call.turnId,
      call.itemId,
      call.agentId,
      call.agentSessionId,
      call.requestId,
      sourceIdsJson(call.sourceIds),
      call.capabilityId,
      call.family,
      call.operation,
      call.status,
      call.summary,
      call.providerRef,
      call.serviceRef,
      call.redactionClass,
      call.errorCode,
      call.startedAt,
      call.completedAt,
      call.packageSnapshotId,
      call.runtimeOriginRef,
      call.runtimeCacheLineageRef
    );
}

/** Inserts one protocol usage record. */
function insertUsageRecord(workspaceDb: WorkspaceDb, usage: UsageRecord): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO usage_records (
        usage_id,
        workspace_id,
        thread_id,
        turn_id,
        item_id,
        capability_call_id,
        request_id,
        agent_id,
        agent_session_id,
        responsible_user_id,
        source_ids_json,
        category,
        unit,
        quantity,
        model_id,
        provider_ref,
        source,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      usage.id,
      usage.workspaceId,
      usage.threadId,
      usage.turnId,
      usage.itemId,
      usage.capabilityCallId,
      usage.requestId,
      usage.agentId,
      usage.agentSessionId,
      usage.responsibleUserId,
      sourceIdsJson(usage.sourceIds),
      usage.category,
      usage.unit,
      usage.quantity,
      usage.modelId,
      usage.providerRef,
      usage.source,
      usage.recordedAt
    );
}

/** Converts one stored capability call row into an exportable record. */
function capabilityCallFromRow(row: unknown): CapabilityCallLedgerRecord {
  const call = row as CapabilityCallRow;
  const protocolCall = CapabilityCallSchema.parse({
    id: call.call_id,
    workspaceId: call.workspace_id,
    threadId: call.thread_id,
    turnId: call.turn_id,
    itemId: call.item_id,
    agentId: call.agent_id,
    agentSessionId: call.agent_session_id,
    packageSnapshotId: call.package_snapshot_id,
    runtimeOriginRef: call.runtime_origin_ref,
    runtimeCacheLineageRef: call.runtime_cache_lineage_ref,
    requestId: call.request_id,
    sourceIds: parseSourceIdsJson(call.source_ids_json),
    capabilityId: call.capability_id,
    status: call.status,
    summary: call.summary,
    errorCode: call.error_code,
    startedAt: call.started_at,
    completedAt: call.completed_at,
  });

  return {
    ...protocolCall,
    family: call.family as CapabilityCallFamily,
    operation: call.operation,
    providerRef: call.provider_ref,
    serviceRef: call.service_ref,
    redactionClass: call.redaction_class,
  };
}

/** Converts one stored usage row into a protocol usage record. */
function usageRecordFromRow(row: unknown): UsageRecord {
  const usage = row as Record<string, unknown>;

  return UsageRecordSchema.parse({
    id: usage.usage_id,
    workspaceId: usage.workspace_id,
    threadId: usage.thread_id,
    turnId: usage.turn_id,
    itemId: usage.item_id,
    capabilityCallId: usage.capability_call_id,
    requestId: usage.request_id,
    agentId: usage.agent_id,
    agentSessionId: usage.agent_session_id,
    responsibleUserId: usage.responsible_user_id,
    sourceIds: parseSourceIdsJson(String(usage.source_ids_json ?? '[]')),
    category: usage.category,
    unit: usage.unit,
    quantity: usage.quantity,
    modelId: usage.model_id,
    providerRef: usage.provider_ref,
    source: usage.source,
    recordedAt: usage.recorded_at,
  });
}

/**
 * Produces a stable source id list.
 *
 * @param sourceIds Candidate source ids.
 * @returns Deduplicated sorted source ids.
 */
function normalizeSourceIds(sourceIds: readonly string[] | null | undefined): string[] {
  return [...new Set(sourceIds ?? [])].filter((sourceId) => sourceId.length > 0).sort();
}

/**
 * Serializes source ids for SQLite storage.
 *
 * @param sourceIds Source ids to serialize.
 * @returns Stable JSON string.
 */
function sourceIdsJson(sourceIds: readonly string[] | null | undefined): string {
  return JSON.stringify(normalizeSourceIds(sourceIds));
}

/**
 * Parses stored source ids.
 *
 * @param value Stored JSON value.
 * @returns Source id list.
 */
function parseSourceIdsJson(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeSourceIds(
          parsed.filter((sourceId): sourceId is string => typeof sourceId === 'string')
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Maps a terminal capability status to audit severity.
 *
 * @param status Terminal capability status.
 * @returns Audit severity.
 */
function capabilityAuditSeverity(
  status: FinishCapabilityCallInput['status']
): 'info' | 'warning' | 'error' {
  if (status === 'succeeded') {
    return 'info';
  }

  return status === 'cancelled' ? 'warning' : 'error';
}

/**
 * Builds a redacted terminal capability audit summary.
 *
 * @param status Terminal capability status.
 * @param call Stored capability call row.
 * @param errorCode Stable error code when present.
 * @returns Redacted audit summary.
 */
function capabilityAuditSummary(
  status: FinishCapabilityCallInput['status'],
  call: CapabilityCallRow,
  errorCode: string | null
): string {
  if (status === 'succeeded') {
    return `Capability call succeeded: ${call.summary ?? call.capability_id}`;
  }

  if (status === 'cancelled') {
    return `Capability call cancelled: ${errorCode ?? call.capability_id}`;
  }

  return `Capability call failed: ${errorCode ?? call.capability_id}`;
}

/**
 * Reads one started call by explicit id or idempotency tuple.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param input Original start input.
 * @returns Stored capability call row.
 */
function findCapabilityCallByIdOrIdempotency(
  workspaceDb: WorkspaceDb,
  input: StartCapabilityCallInput
): CapabilityCallRow {
  if (input.requestId) {
    const storedByRequest = workspaceDb.sqlite
      .prepare(
        `SELECT * FROM capability_calls
         WHERE workspace_id = ?
           AND request_id = ?
           AND family = ?
           AND operation = ?
         ORDER BY started_at
         LIMIT 1`
      )
      .get(input.workspaceId, input.requestId, input.family, input.operation) as
      | CapabilityCallRow
      | undefined;

    if (storedByRequest) {
      return storedByRequest;
    }
  }

  if (input.callId) {
    const storedById = findCapabilityCallById(workspaceDb, input.callId);

    if (
      storedById &&
      storedById.workspace_id === input.workspaceId &&
      storedById.request_id === (input.requestId ?? null) &&
      storedById.family === input.family &&
      storedById.operation === input.operation
    ) {
      return storedById;
    }
  }

  throw new Error('Capability call was not stored.');
}

/**
 * Rejects replay when immutable effect attribution differs from the stored call.
 *
 * @param stored Existing capability-call row selected by the idempotency key.
 * @param incoming Protocol-validated incoming capability call.
 * @param input Ledger-only attribution supplied by the producer.
 */
function assertMatchingCapabilityCallAttribution(
  stored: CapabilityCallRow,
  incoming: CapabilityCall,
  input: StartCapabilityCallInput
): void {
  if (
    stored.capability_id !== incoming.capabilityId ||
    stored.thread_id !== incoming.threadId ||
    stored.turn_id !== incoming.turnId ||
    stored.item_id !== incoming.itemId ||
    stored.agent_id !== incoming.agentId ||
    stored.agent_session_id !== incoming.agentSessionId ||
    stored.package_snapshot_id !== incoming.packageSnapshotId ||
    stored.runtime_origin_ref !== incoming.runtimeOriginRef ||
    stored.runtime_cache_lineage_ref !== incoming.runtimeCacheLineageRef ||
    sourceIdsJson(parseSourceIdsJson(stored.source_ids_json)) !==
      sourceIdsJson(incoming.sourceIds) ||
    stored.provider_ref !== (input.providerRef ?? null) ||
    stored.service_ref !== (input.serviceRef ?? null) ||
    stored.redaction_class !== input.redactionClass
  ) {
    throw new Error('Capability call attribution conflicts with the existing request.');
  }
}

/**
 * Fails closed when an attempted ledger payload contains obvious raw sensitive or payload fields.
 *
 * @param value Value to inspect recursively.
 */
function assertNoUnsafeLedgerValue(value: unknown): void {
  const unsafeKey = findUnsafeLedgerKey(value);

  if (unsafeKey) {
    throw new Error('Capability usage ledger values must be redacted before recording.');
  }
}

/**
 * Finds an unsafe field name in a would-be ledger value.
 *
 * @param value Value to inspect recursively.
 * @returns Unsafe key when present.
 */
function findUnsafeLedgerKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (/(prompt|argument|result|secret|token|credential|password|cache[_-]?key)/i.test(key)) {
      return key;
    }

    const nestedKey = findUnsafeLedgerKey(nested);

    if (nestedKey) {
      return nestedKey;
    }
  }

  return null;
}
