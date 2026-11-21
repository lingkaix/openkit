import {
  type AuditEvent,
  allocateEntityId,
  type CapabilityCall,
  CapabilityCallExtensionsSchema,
  CapabilityCallSchema,
  type GatewayRouteLineageEntry,
  GatewayRouteLineageEntrySchema,
  RequestIdSchema,
  readRetainedV1,
  responsibleUserIdForActor,
  type ServerUsageRecord,
  ServerUsageRecordSchema,
  SystemPromptDigestSchema,
  type UsageRecord,
  UsageRecordSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { OperationError } from '../operation-error.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import { WorkerRawOutputStateSchema } from '../runtime/worker-raw-output.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { CapabilityCallFamily } from '../storage/schema/index.js';
import { serverWorkUnavailable } from '../storage/server-work-command.js';
import type {
  CapabilityCallLedgerRecord,
  FinishCapabilityCallInput,
  GatewayCallContext,
  GatewayCallLedgerBinding,
  RecordUsageInput,
  ServerGatewayCallContext,
  StampCapabilityCallSchemaSnapshotInput,
  StartCapabilityCallInput,
  StartedCapabilityCall,
  StartServerCapabilityCallInput,
  UsageMeasurementInput,
} from './usage-ledger.js';

export type CapabilityCallRow = {
  schema_version: number;
  call_id: string;
  workspace_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  agent_id: string | null;
  agent_session_id: string | null;
  package_snapshot_id: string | null;
  schema_snapshot_id: string | null;
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
  system_prompt_digest: string | null;
  extensions_json: string | null;
};

/** Storage/export-only validation preserves other canonical namespaces; live protocol projections still strip them. */
export const CanonicalCapabilityCallExtensionsSchema = CapabilityCallExtensionsSchema.extend({
  'openkit.worker/rawOutput': WorkerRawOutputStateSchema.optional(),
}).catchall(z.unknown());

/** Reads paired attribution captured before effect contact, including after process restart. */
export function readCapabilityAdmissionAttribution(
  db: Pick<WorkspaceDb, 'sqlite'>,
  callId: string
): Pick<AuditEvent, 'actor' | 'authentication' | 'requestId'> {
  const row = db.sqlite
    .prepare(
      "SELECT * FROM audit_events WHERE capability_call_id = ? AND action = 'capability.admit' ORDER BY created_at, audit_event_id LIMIT 1"
    )
    .get(callId);
  const event = row ? readAuditEventRowV1(row) : undefined;
  return {
    requestId: event?.requestId ?? null,
    actor: event?.actor ?? null,
    ...(event?.authentication ? { authentication: event.authentication } : {}),
  };
}

export type NativeServerWorkDb = {
  readonly scope: 'server-work';
  readonly sqlite: CoreDb['sqlite'];
};
type ServerWorkCallFinish = Omit<FinishCapabilityCallInput, 'workspaceDb' | 'now'> & {
  readonly workspaceDb: NativeServerWorkDb;
  readonly now: Date;
};

/**
 * Marks one capability call terminal.
 *
 * @param input Terminal status and optional trusted command lineage for audit.
 */
export function finishCapabilityCallInDb(
  input: FinishCapabilityCallInput | ServerWorkCallFinish
): void {
  const db = input.workspaceDb;
  if (db.scope === 'core') throw serverWorkUnavailable();
  const now = input.now ?? new Date();
  const completedAt = now.toISOString();

  db.sqlite
    .transaction(() => {
      const call = findCapabilityCallById(db, input.callId);
      if (!call || call.completed_at) {
        return;
      }
      const extensions =
        input.deliveredKnowledgeAnswer === undefined
          ? call.extensions_json
          : JSON.stringify(
              CanonicalCapabilityCallExtensionsSchema.parse({
                ...(call.extensions_json ? JSON.parse(call.extensions_json) : {}),
                'openkit.knowledge/delivery': { answer: input.deliveredKnowledgeAnswer },
              })
            );
      capabilityCallFromRow(
        {
          ...call,
          completed_at: completedAt,
          error_code: input.errorCode ?? null,
          status: input.status,
          extensions_json: extensions,
        },
        db.scope !== 'workspace'
      );
      const result = db.sqlite
        .prepare(
          `UPDATE capability_calls
           SET status = ?, error_code = ?, completed_at = ?, extensions_json = ?
           WHERE call_id = ? AND completed_at IS NULL`
        )
        .run(input.status, input.errorCode ?? null, completedAt, extensions, input.callId);
      if (result.changes !== 1) {
        throw new Error(`Capability call changed concurrently: ${input.callId}`);
      }

      if (db.scope === 'server-work') return;
      const admittedAttribution = readCapabilityAdmissionAttribution(db, call.call_id);
      const auditRequestId =
        call.request_id ??
        admittedAttribution.requestId ??
        (input.auditLineage === undefined
          ? null
          : RequestIdSchema.parse(input.auditLineage.commandRequestId));
      const audit: Omit<
        Parameters<typeof recordWorkspaceAuditEvent>[0],
        'workspaceDb' | 'workspaceId'
      > = {
        action: 'capability.finish',
        ...admittedAttribution,
        agentId: call.agent_id,
        agentSessionId: call.agent_session_id,
        capabilityCallId: call.call_id,
        category: 'capability',
        errorCode: input.errorCode ?? null,
        itemId: call.item_id,
        now,
        occurredAt: now,
        outcome: capabilityAuditOutcome(input.status),
        requestId: auditRequestId,
        resource: `capability:${call.capability_id}`,
        severity: capabilityAuditSeverity(input.status),
        summary: capabilityAuditSummary(input.status, call, input.errorCode ?? null, input),
        threadId: call.thread_id,
        turnId: call.turn_id,
      };
      recordWorkspaceAuditEvent({
        ...audit,
        workspaceDb: db,
        workspaceId: call.workspace_id!,
      });
    })
    .immediate();
}

/**
 * Reads one capability call row by id.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param callId Capability call id.
 * @returns Stored row when present.
 */
export function findCapabilityCallById(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  callId: string
): CapabilityCallRow | undefined {
  const row = workspaceDb.sqlite
    .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
    .get(callId) as CapabilityCallRow | undefined;
  if (row) readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
  return row;
}

/** Converts one stored capability call row into an exportable record. */

export function capabilityCallFromRow(row: unknown, server = false): CapabilityCallLedgerRecord {
  const call = row as CapabilityCallRow;
  if (server && call.workspace_id !== null)
    throw new Error('Server capability call database owner mismatch.');
  readRetainedV1({ schemaVersion: call.schema_version }, () => undefined);
  const extensions =
    call.extensions_json === null
      ? undefined
      : CanonicalCapabilityCallExtensionsSchema.parse(JSON.parse(call.extensions_json));
  const protocolCall = CapabilityCallSchema.parse({
    id: call.call_id,
    owner: server ? { kind: 'server' } : { kind: 'workspace', workspaceId: call.workspace_id },
    threadId: call.thread_id,
    turnId: call.turn_id,
    itemId: call.item_id,
    agentId: call.agent_id,
    agentSessionId: call.agent_session_id,
    packageSnapshotId: call.package_snapshot_id,
    schemaSnapshotId: call.schema_snapshot_id,
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
    ...(call.system_prompt_digest === null
      ? {}
      : { systemPromptDigest: call.system_prompt_digest }),
    ...(extensions === undefined ? {} : { extensions }),
  });

  return {
    ...protocolCall,
    ...(extensions === undefined ? {} : { extensions }),
    family: call.family as CapabilityCallFamily,
    operation: call.operation,
    providerRef: call.provider_ref,
    serviceRef: call.service_ref,
    redactionClass: call.redaction_class,
  };
}

/**
 * Produces a stable source id list.
 *
 * @param sourceIds Candidate source ids.
 * @returns Deduplicated sorted source ids.
 */
export function normalizeSourceIds(sourceIds: readonly string[] | null | undefined): string[] {
  return [...new Set(sourceIds ?? [])].filter((sourceId) => sourceId.length > 0).sort();
}

/**
 * Parses stored source ids.
 *
 * @param value Stored JSON value.
 * @returns Source id list.
 */
export function parseSourceIdsJson(value: string | null | undefined): string[] {
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

  return status === 'failed' || status === 'timed-out' ? 'error' : 'warning';
}

/** Maps the Core terminal status into the independently owned audit outcome. */
function capabilityAuditOutcome(
  status: FinishCapabilityCallInput['status']
): Parameters<typeof recordWorkspaceAuditEvent>[0]['outcome'] {
  if (status === 'succeeded' || status === 'denied' || status === 'unknown') {
    return status;
  }
  if (status === 'failed' || status === 'timed-out') {
    return 'failed';
  }
  return 'cancelled';
}

/**
 * Builds a redacted terminal capability audit summary.
 *
 * @param status Terminal capability status.
 * @param call Stored capability call row.
 * @param errorCode Stable error code when present.
 * @param diagnostics Numeric failure facts, without upstream payloads.
 * @returns Redacted audit summary.
 */
function capabilityAuditSummary(
  status: FinishCapabilityCallInput['status'],
  call: CapabilityCallRow,
  errorCode: string | null,
  diagnostics: Pick<FinishCapabilityCallInput, 'upstreamHttpStatus' | 'refusedResultBytes'>
): string {
  if (status === 'succeeded') {
    return `Capability call succeeded: ${call.summary ?? call.capability_id}`;
  }

  return (
    `Capability call ${status}: ${errorCode ?? call.capability_id}` +
    (diagnostics.upstreamHttpStatus === undefined
      ? ''
      : ` Upstream HTTP status: ${diagnostics.upstreamHttpStatus}.`) +
    (diagnostics.refusedResultBytes === undefined
      ? ''
      : ` Refused result size: ${diagnostics.refusedResultBytes} bytes.`)
  );
}

/** Binds one running call to exactly one schema snapshot before its effect. */
export function stampCapabilityCallSchemaSnapshotInDb(
  input: Omit<StampCapabilityCallSchemaSnapshotInput, 'workspaceDb'> & {
    workspaceDb: Pick<WorkspaceDb, 'sqlite'>;
  }
): void {
  const call = findCapabilityCallById(input.workspaceDb, input.callId);
  const parsed = CapabilityCallSchema.shape.schemaSnapshotId.unwrap().parse(input.schemaSnapshotId);
  if (call?.schema_snapshot_id === parsed) return;
  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE capability_calls
       SET schema_snapshot_id = ?
       WHERE call_id = ? AND status = 'running' AND schema_snapshot_id IS NULL`
    )
    .run(parsed, input.callId);
  if (result.changes === 1) return;
  const stored = findCapabilityCallById(input.workspaceDb, input.callId);
  if (stored?.schema_snapshot_id !== parsed) {
    throw new Error(`Capability call schema snapshot conflicts: ${input.callId}`);
  }
}

/**
 * Records the system-prompt digest on an already-opened gateway-entry family llm CapabilityCall row.
 *
 * @param input Owning database, durable call id, and digest.
 * @throws When the row is missing, is not a gateway-entry llm call, or the digest is not recorded.
 */
export function persistLlmCapabilityCallSystemPromptDigestInDb(input: {
  /** Workspace database that owns the opened CapabilityCall. */
  readonly workspaceDb: WorkspaceDb | CoreDb | NativeServerWorkDb;
  /** Durable capability call id. */
  readonly callId: string;
  /** Pre-adapter system-prompt digest. */
  readonly systemPromptDigest: string;
}): void {
  if (input.workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const systemPromptDigest = SystemPromptDigestSchema.parse(input.systemPromptDigest);
  const retainedCall = input.workspaceDb.sqlite
    .prepare(`SELECT schema_version FROM capability_calls
      WHERE call_id = ? AND family = 'llm'
        AND capability_id IN ('llm.chat_completions', 'llm.responses')`)
    .get(input.callId) as { schema_version: number } | undefined;
  if (retainedCall) readRetainedV1({ schemaVersion: retainedCall.schema_version }, () => undefined);
  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE capability_calls
       SET system_prompt_digest = ?
       WHERE call_id = ?
         AND family = 'llm'
         AND capability_id IN ('llm.chat_completions', 'llm.responses')`
    )
    .run(systemPromptDigest, input.callId);

  if (result.changes !== 1) {
    throw new Error(`LLM capability call system-prompt digest was not recorded: ${input.callId}`);
  }
}

export function writeGatewayRouteLineageInDb(input: {
  readonly workspaceDb: GatewayCallLedgerBinding['workspaceDb'] | NativeServerWorkDb;
  readonly call: Pick<StartedCapabilityCall, 'id'>;
  readonly logicalModelId: string;
  readonly entry: GatewayRouteLineageEntry;
  readonly entryIndex?: number;
}): number {
  if (input.workspaceDb.scope === 'core') throw serverWorkUnavailable();
  return input.workspaceDb.sqlite.transaction(() => {
    const row = findCapabilityCallById(input.workspaceDb, input.call.id);
    if (!row || row.status !== 'running')
      throw new Error('Gateway lineage requires its running CapabilityCall.');
    const extensions = CanonicalCapabilityCallExtensionsSchema.parse(
      row.extensions_json === null ? {} : JSON.parse(row.extensions_json)
    );
    const lineage = extensions['openkit.gateway/routeLineage'] ?? {
      logicalModelId: input.logicalModelId,
      entries: [],
    };
    if (lineage.logicalModelId !== input.logicalModelId)
      throw new Error('Gateway lineage logical model conflicts.');
    const index = input.entryIndex ?? lineage.entries.length;
    if (index > lineage.entries.length || index < 0)
      throw new Error('Gateway lineage entry is missing.');
    lineage.entries[index] = GatewayRouteLineageEntrySchema.parse(input.entry);
    extensions['openkit.gateway/routeLineage'] = lineage;
    input.workspaceDb.sqlite
      .prepare('UPDATE capability_calls SET extensions_json = ? WHERE call_id = ?')
      .run(JSON.stringify(extensions), input.call.id);
    return index;
  })();
}

/** Updates the original worker cache fields on the same retained Call. */
export function writeCapabilityCallCacheInDb(input: {
  readonly workspaceDb: WorkspaceDb;
  readonly callId: string;
  readonly runtimeCacheLineageRef: string | null;
  readonly summary: string;
}): void {
  const retainedCall = input.workspaceDb.sqlite
    .prepare('SELECT schema_version FROM capability_calls WHERE call_id = ?')
    .get(input.callId) as { schema_version: number } | undefined;
  if (retainedCall) readRetainedV1({ schemaVersion: retainedCall.schema_version }, () => undefined);
  input.workspaceDb.sqlite
    .prepare(
      'UPDATE capability_calls SET runtime_cache_lineage_ref = ?, summary = ? WHERE call_id = ?'
    )
    .run(input.runtimeCacheLineageRef, input.summary, input.callId);
}

/** Preserves the original running-only Item clear before the Call terminal mutation. */
export function clearCapabilityCallItemInDb(workspaceDb: WorkspaceDb, callId: string): void {
  const retainedCall = workspaceDb.sqlite
    .prepare("SELECT schema_version FROM capability_calls WHERE call_id = ? AND status = 'running'")
    .get(callId) as { schema_version: number } | undefined;
  if (retainedCall) readRetainedV1({ schemaVersion: retainedCall.schema_version }, () => undefined);
  workspaceDb.sqlite
    .prepare(`UPDATE capability_calls
             SET item_id = NULL
             WHERE call_id = ? AND status = 'running'`)
    .run(callId);
}

/**
 * Records measured usage linked to a started capability call.
 *
 * @param input Usage rows, durable call summary and optional command audit lineage.
 * @returns Retained IDs, including existing equivalent measurements, in input order.
 */
type ServerUsageInput = Omit<RecordUsageInput, 'workspaceDb' | 'call'> & {
  readonly workspaceDb: NativeServerWorkDb;
  readonly call: StartedCapabilityCall<ServerGatewayCallContext>;
};

function projectUsageRecord(
  call: RecordUsageInput['call'],
  record: UsageMeasurementInput,
  recordedAt: string
): UsageRecord | ServerUsageRecord {
  assertNoUnsafeLedgerValue(record);
  const fields = {
    id: record.usageId ?? allocateEntityId('use'),
    responsibleUserId: call.context.authorityActor
      ? responsibleUserIdForActor(call.context.authorityActor)
      : null,
    threadId: call.context.threadId ?? null,
    turnId: call.context.turnId ?? null,
    itemId: call.context.itemId ?? null,
    capabilityCallId: call.id,
    requestId: call.context.requestId ?? null,
    agentId: call.context.agentId ?? null,
    agentSessionId: call.context.agentSessionId ?? null,
    sourceIds: normalizeSourceIds(call.context.sourceIds),
    category: record.category,
    unit: record.unit,
    quantity: record.quantity,
    modelId: record.modelId ?? null,
    providerModel: record.providerModel ?? null,
    providerRef: record.providerRef ?? call.context.providerRef ?? null,
    source: record.source ?? null,
    recordedAt,
  };
  return 'owner' in call.context
    ? ServerUsageRecordSchema.parse({ ...fields, owner: call.context.owner })
    : UsageRecordSchema.parse({ ...fields, workspaceId: call.context.workspaceId });
}

/** Reads the recorded identity from the Server owner using its exact measurement equivalence. */
export function readEquivalentServerUsageId(
  db: NativeServerWorkDb,
  call: ServerUsageInput['call'],
  record: UsageMeasurementInput,
  recordedAt: string
): string | undefined {
  return hasEquivalentUsageRecord(db, projectUsageRecord(call, record, recordedAt));
}

export function recordUsageInDb(input: RecordUsageInput | ServerUsageInput): string[] {
  const db = input.workspaceDb;
  if (db.scope === 'core') throw serverWorkUnavailable();
  if (
    db.scope === 'workspace'
      ? input.call.context.workspaceId !== db.workspaceId
      : !('owner' in input.call.context) || input.call.context.owner.kind !== 'server'
  )
    throw new Error('Usage record database owner mismatch.');
  const ids: string[] = [];
  const recordedAt = (input.now ?? new Date()).toISOString();
  try {
    for (const record of input.records) {
      const usage = projectUsageRecord(input.call, record, recordedAt);
      const equivalent = hasEquivalentUsageRecord(input.workspaceDb, usage);
      ids.push(equivalent ?? usage.id);
      if (equivalent) continue;

      input.workspaceDb.sqlite
        .prepare(
          `INSERT INTO usage_records (
            schema_version,
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
            provider_model,
            provider_ref,
            source,
            recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          writeRetainedV1(usage).schemaVersion,
          usage.id,
          usage.workspaceId ?? null,
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
          usage.providerModel ?? null,
          usage.providerRef,
          usage.source,
          usage.recordedAt
        );
    }
  } catch (error) {
    if (db.scope === 'workspace')
      try {
        finishCapabilityCallInDb({
          auditLineage: input.auditLineage,
          workspaceDb: db,
          callId: input.call.id,
          errorCode: 'usage_record_failed',
          status: 'failed',
        });
      } catch {}
    throw error;
  }
  return ids;
}

/**
 * Checks whether a retry already recorded the same usage measurement for a call.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param usage Protocol-validated usage row.
 * @returns The retained measurement ID when an equivalent record is already stored.
 */
function hasEquivalentUsageRecord(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  usage: UsageRecord | ServerUsageRecord
): string | undefined {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT usage_id, schema_version FROM usage_records
       WHERE capability_call_id IS ?
         AND category = ?
         AND unit = ?
         AND quantity = ?
         AND model_id IS ?
         AND provider_model IS ?
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
      usage.providerModel ?? null,
      usage.providerRef,
      usage.source,
      sourceIdsJson(usage.sourceIds)
    ) as { usage_id: string; schema_version: number } | undefined;

  if (row) readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
  return row?.usage_id;
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

type ServerWorkCallInput = Omit<
  StartServerCapabilityCallInput,
  'workspaceDb' | 'callId' | 'now'
> & {
  readonly workspaceDb: NativeServerWorkDb;
  readonly callId: string;
  readonly now: Date;
};

type NativeCallInput =
  | StartCapabilityCallInput
  | StartServerCapabilityCallInput
  | ServerWorkCallInput;

/** Requires existing Workspace LLM/MCP attribution before either admission path writes or dispatches. */
function assertWorkspaceCapabilityActor(input: NativeCallInput): void {
  if (
    input.workspaceDb.scope === 'workspace' &&
    (input.family === 'llm' || input.family === 'mcp') &&
    input.authorityActor == null
  ) {
    throw new TypeError('Workspace LLM/MCP admission requires an authority actor.');
  }
}

/**
 * Starts one durable capability call before upstream contact.
 *
 * @param input Gateway call context and database handle.
 * @returns Durable call summary.
 */
export function startCapabilityCallInDb(
  input: StartServerCapabilityCallInput
): StartedCapabilityCall<ServerGatewayCallContext>;
export function startCapabilityCallInDb(input: StartCapabilityCallInput): StartedCapabilityCall;
export function startCapabilityCallInDb(
  input: ServerWorkCallInput
): StartedCapabilityCall<ServerGatewayCallContext>;
export function startCapabilityCallInDb(
  input: NativeCallInput
): StartedCapabilityCall<GatewayCallContext | ServerGatewayCallContext> {
  const db = input.workspaceDb;
  if (db.scope === 'core') throw serverWorkUnavailable();
  assertWorkspaceCapabilityActor(input);
  return db.sqlite
    .transaction(() => {
      const {
        workspaceDb: _workspaceDb,
        now: _now,
        callId: _callId,
        authorityActor: _authorityActor,
        authentication: _authentication,
        auditLineage: _auditLineage,
        ...safeInput
      } = input;
      assertNoUnsafeLedgerValue(safeInput);

      const startedAt = (input.now ?? new Date()).toISOString();
      const callId = input.callId ?? allocateEntityId('cap');
      const decisionBudget =
        input.workspaceDb.scope === 'workspace' &&
        input.family === 'llm' &&
        input.operation === 'decision' &&
        input.capabilityId === 'llm.decision';
      const dayStart = `${startedAt.slice(0, 10)}T00:00:00.000Z`;
      const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
      if (
        input.workspaceDb.scope === 'workspace'
          ? input.workspaceId !== input.workspaceDb.workspaceId
          : input.workspaceId !== undefined || !('owner' in input) || input.owner.kind !== 'server'
      ) {
        throw new Error('Capability call database owner mismatch.');
      }
      const protocolCall = CapabilityCallSchema.parse({
        id: callId,
        ...(input.workspaceDb.scope === 'workspace'
          ? { owner: { kind: 'workspace', workspaceId: input.workspaceId } }
          : { owner: { kind: 'server' } }),
        threadId: input.threadId ?? null,
        turnId: input.turnId ?? null,
        itemId: input.itemId ?? null,
        agentId: input.agentId ?? null,
        agentSessionId: input.agentSessionId ?? null,
        packageSnapshotId: input.packageSnapshotId ?? null,
        schemaSnapshotId: input.schemaSnapshotId ?? null,
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

      // The existing native INSERT owns the UTC-day reservation and idempotent replay.
      // No extra counter row, query site or admission race precedes Provider contact.
      const insertion = input.workspaceDb.sqlite
        .prepare(
          `INSERT OR IGNORE INTO capability_calls (
        schema_version,
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
        schema_snapshot_id,
        runtime_origin_ref,
        runtime_cache_lineage_ref
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE CASE WHEN ? THEN (
        SELECT count(*) FROM capability_calls
        WHERE workspace_id = ? AND family = 'llm' AND operation = 'decision'
          AND capability_id = 'llm.decision' AND started_at >= ? AND started_at < ?
      ) < 2000 ELSE 1 END`
        )
        .run(
          writeRetainedV1(protocolCall).schemaVersion,
          protocolCall.id,
          protocolCall.owner.kind === 'workspace' ? protocolCall.owner.workspaceId : null,
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
          protocolCall.schemaSnapshotId,
          protocolCall.runtimeOriginRef,
          protocolCall.runtimeCacheLineageRef,
          decisionBudget ? 1 : 0,
          protocolCall.owner.kind === 'workspace' ? protocolCall.owner.workspaceId : null,
          dayStart,
          dayEnd
        );

      if (
        insertion.changes === 1 &&
        input.authorityActor &&
        input.workspaceDb.scope !== 'server-work'
      ) {
        const audit = {
          action: 'capability.admit',
          actor: input.authorityActor,
          ...(input.authentication ? { authentication: input.authentication } : {}),
          agentId: protocolCall.agentId,
          agentSessionId: protocolCall.agentSessionId,
          capabilityCallId: protocolCall.id,
          category: 'capability' as const,
          itemId: protocolCall.itemId,
          now: new Date(startedAt),
          occurredAt: new Date(startedAt),
          outcome: 'unknown' as const,
          requestId:
            protocolCall.requestId ??
            (input.auditLineage
              ? RequestIdSchema.parse(input.auditLineage.commandRequestId)
              : null),
          resource: `capability:${protocolCall.capabilityId}`,
          summary: 'Capability call admitted; effect outcome is not yet known.',
          threadId: protocolCall.threadId,
          turnId: protocolCall.turnId,
        };
        if (db.scope === 'workspace')
          recordWorkspaceAuditEvent({
            ...audit,
            workspaceDb: db,
            workspaceId: db.workspaceId,
          });
      }

      const stored = findCapabilityCallByIdOrIdempotency(
        input.workspaceDb,
        { ...input, callId },
        decisionBudget ? 'Security Review daily invocation budget is exhausted.' : undefined
      );
      assertMatchingCapabilityCallAttribution(stored, protocolCall, input);
      if (input.workspaceDb.scope === 'server-work' && stored.call_id !== callId)
        throw new Error('Server capability call identity conflicts with the original admission.');

      return {
        id: stored.call_id,
        inserted: insertion.changes === 1,
        context: {
          agentId: stored.agent_id,
          agentSessionId: stored.agent_session_id,
          authorityActor:
            input.workspaceDb.scope === 'server-work'
              ? (input.authorityActor ?? null)
              : (readCapabilityAdmissionAttribution(input.workspaceDb, stored.call_id).actor ??
                null),
          capabilityId: stored.capability_id,
          family: stored.family as CapabilityCallFamily,
          itemId: stored.item_id,
          operation: stored.operation,
          packageSnapshotId: stored.package_snapshot_id,
          schemaSnapshotId: stored.schema_snapshot_id,
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
          ...(input.workspaceDb.scope === 'workspace'
            ? { workspaceId: input.workspaceDb.workspaceId }
            : { owner: { kind: 'server' as const } }),
        },
      };
    })
    .immediate();
}

/**
 * Reads one started call by explicit id or idempotency tuple.
 *
 * @param workspaceDb Workspace-scoped database handle.
 * @param input Original start input.
 * @param missingMessage Fixed refusal when no call was admitted or replayed.
 * @returns Stored capability call row.
 */
function findCapabilityCallByIdOrIdempotency(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  input: NativeCallInput,
  missingMessage = 'Capability call was not stored.'
): CapabilityCallRow {
  if (input.requestId) {
    const storedByRequest = workspaceDb.sqlite
      .prepare(
        `SELECT * FROM capability_calls
         WHERE workspace_id IS ?
           AND request_id = ?
           AND family = ?
           AND operation = ?
         ORDER BY started_at
         LIMIT 1`
      )
      .get(input.workspaceId ?? null, input.requestId, input.family, input.operation) as
      | CapabilityCallRow
      | undefined;

    if (storedByRequest) {
      readRetainedV1({ schemaVersion: storedByRequest.schema_version }, () => undefined);
      return storedByRequest;
    }
  }

  if (input.callId) {
    const storedById = findCapabilityCallById(workspaceDb, input.callId);

    if (
      storedById &&
      storedById.workspace_id === (input.workspaceId ?? null) &&
      storedById.request_id === (input.requestId ?? null) &&
      storedById.family === input.family &&
      storedById.operation === input.operation
    ) {
      return storedById;
    }
  }

  if (missingMessage === 'Security Review daily invocation budget is exhausted.')
    throw new OperationError('security_review_budget_exhausted', missingMessage, 429);
  throw new Error(missingMessage);
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
  input: NativeCallInput
): void {
  if (
    stored.capability_id !== incoming.capabilityId ||
    stored.thread_id !== incoming.threadId ||
    stored.turn_id !== incoming.turnId ||
    stored.item_id !== incoming.itemId ||
    stored.agent_id !== incoming.agentId ||
    stored.agent_session_id !== incoming.agentSessionId ||
    stored.package_snapshot_id !== incoming.packageSnapshotId ||
    stored.schema_snapshot_id !== incoming.schemaSnapshotId ||
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

/** Caller request identities are single-use across running and terminal Gateway calls. */
export function hasCapabilityCallRequestId(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  requestId: string
): boolean {
  const row = workspaceDb.sqlite
    .prepare(
      'SELECT schema_version FROM capability_calls WHERE workspace_id = ? AND request_id = ? LIMIT 1'
    )
    .get(workspaceId, requestId) as { schema_version: number } | undefined;
  if (row) readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
  return row !== undefined;
}

export { assertWorkspaceCapabilityActor, sourceIdsJson };
