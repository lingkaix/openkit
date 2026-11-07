import {
  type AuditEvent,
  CapabilityCallExtensionsSchema,
  CapabilityCallSchema,
  RequestIdSchema,
  readRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import { WorkerRawOutputStateSchema } from '../runtime/worker-raw-output.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { CapabilityCallFamily } from '../storage/schema/index.js';
import type { CapabilityCallLedgerRecord, FinishCapabilityCallInput } from './usage-ledger.js';

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
