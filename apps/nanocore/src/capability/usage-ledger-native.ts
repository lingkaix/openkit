import {
  type AuditEvent,
  allocateEntityId,
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
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import { WorkerRawOutputStateSchema } from '../runtime/worker-raw-output.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { CapabilityCallFamily } from '../storage/schema/index.js';
import type {
  CapabilityCallLedgerRecord,
  FinishCapabilityCallInput,
  GatewayCallLedgerBinding,
  RecordUsageInput,
  StampCapabilityCallSchemaSnapshotInput,
  StartedCapabilityCall,
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

/**
 * Marks one capability call terminal.
 *
 * @param input Terminal status and optional trusted command lineage for audit.
 */
export function finishCapabilityCallInDb(input: FinishCapabilityCallInput): void {
  const now = input.now ?? new Date();
  const completedAt = now.toISOString();

  input.workspaceDb.sqlite
    .transaction(() => {
      const call = findCapabilityCallById(input.workspaceDb, input.callId);
      if (!call || call.completed_at) {
        return;
      }
      const admittedAttribution = readCapabilityAdmissionAttribution(
        input.workspaceDb,
        call.call_id
      );
      const auditRequestId =
        call.request_id ??
        admittedAttribution.requestId ??
        (input.auditLineage === undefined
          ? null
          : RequestIdSchema.parse(input.auditLineage.commandRequestId));
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
        input.workspaceDb.scope === 'core'
      );
      const result = input.workspaceDb.sqlite
        .prepare(
          `UPDATE capability_calls
           SET status = ?, error_code = ?, completed_at = ?, extensions_json = ?
           WHERE call_id = ? AND completed_at IS NULL`
        )
        .run(input.status, input.errorCode ?? null, completedAt, extensions, input.callId);
      if (result.changes !== 1) {
        throw new Error(`Capability call changed concurrently: ${input.callId}`);
      }

      const audit: Omit<Parameters<typeof recordServerAuditEvent>[0], 'coreDb'> = {
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
        summary: capabilityAuditSummary(input.status, call, input.errorCode ?? null),
        threadId: call.thread_id,
        turnId: call.turn_id,
      };
      if (input.workspaceDb.scope === 'core')
        recordServerAuditEvent({ ...audit, coreDb: input.workspaceDb });
      else
        recordWorkspaceAuditEvent({
          ...audit,
          workspaceDb: input.workspaceDb,
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

  return `Capability call ${status}: ${errorCode ?? call.capability_id}`;
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
  readonly workspaceDb: WorkspaceDb | CoreDb;
  /** Durable capability call id. */
  readonly callId: string;
  /** Pre-adapter system-prompt digest. */
  readonly systemPromptDigest: string;
}): void {
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

export function writeGatewayRouteLineageInDb(
  input: Omit<GatewayCallLedgerBinding, 'call'> & {
    readonly call: Pick<StartedCapabilityCall, 'id'>;
    readonly logicalModelId: string;
    readonly entry: GatewayRouteLineageEntry;
    readonly entryIndex?: number;
  }
): number {
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
export function recordUsageInDb(input: RecordUsageInput): string[] {
  const context = input.call.context;
  if (
    input.workspaceDb.scope === 'core'
      ? context.workspaceId !== undefined ||
        !('owner' in context) ||
        context.owner.kind !== 'server'
      : context.workspaceId !== input.workspaceDb.workspaceId
  )
    throw new Error('Usage record database owner mismatch.');
  const ids: string[] = [];
  const recordedAt = (input.now ?? new Date()).toISOString();

  try {
    for (const record of input.records) {
      assertNoUnsafeLedgerValue(record);

      const usage = (
        input.workspaceDb.scope === 'core' ? ServerUsageRecordSchema : UsageRecordSchema
      ).parse({
        id: record.usageId ?? allocateEntityId('use'),
        ...(input.workspaceDb.scope === 'core'
          ? { owner: { kind: 'server' } }
          : { workspaceId: input.call.context.workspaceId }),
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
        providerModel: record.providerModel ?? null,
        providerRef: record.providerRef ?? input.call.context.providerRef ?? null,
        source: record.source ?? null,
        recordedAt,
      });

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
    try {
      finishCapabilityCallInDb({
        auditLineage: input.auditLineage,
        workspaceDb: input.workspaceDb,
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

export { assertNoUnsafeLedgerValue, sourceIdsJson };
