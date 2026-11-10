import {
  type ActorRef,
  type AuditEvent,
  type CapabilityCall,
  CapabilityCallStatusSchema,
  type GatewayRouteLineageEntry,
  readRetainedV1,
  type ServerUsageRecord,
  ServerUsageRecordSchema,
  type UsageRecord,
  UsageRecordSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import type { z } from 'zod';
import { OperationError } from '../operation-error.js';
import { listExportableWorkspacePermissionDecisions } from '../policy/permission-decisions.js';
import {
  type ControlCapabilityAdmissionFailure,
  type ControlCapabilityCommandInput,
  ControlCapabilityCommandInputSchema,
  type ControlCapabilityCommandResult,
  mcpToolContactUsage,
} from '../storage/control-store-capability.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import type { CapabilityCallFamily } from '../storage/schema/index.js';

import {
  assertWorkspaceCapabilityActor,
  CanonicalCapabilityCallExtensionsSchema,
  type CapabilityCallRow,
  capabilityCallFromRow,
  finishCapabilityCallInDb,
  parseSourceIdsJson,
  sourceIdsJson,
} from './usage-ledger-native.js';

/** Exportable capability call ledger record. */
export interface CapabilityCallLedgerRecord extends CapabilityCall {
  /** Proved no-contact refusal from a retained submission decision; absence means unknown here. */
  upstreamContacted?: false;
  /** Canonical optional content for storage and archives, never a live protocol projection. */
  extensions?: z.infer<typeof CanonicalCapabilityCallExtensionsSchema> | undefined;
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
  /** Available native credential attribution; never secret material or permission. */
  authentication?: AuditEvent['authentication'];
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
  /** Schema snapshot used to validate a schema-bound call. */
  schemaSnapshotId?: string | null;
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

/** Server attribution has no Workspace identity; its database supplies the unique owner. */
export interface ServerGatewayCallContext extends Omit<GatewayCallContext, 'workspaceId'> {
  readonly owner: { readonly kind: 'server' };
  readonly workspaceId?: never;
}

/** Server input for the shared capability-call writer. */
export interface StartServerCapabilityCallInput extends ServerGatewayCallContext {
  /** Existing command lineage for Audit only; it never changes call idempotency. */
  readonly auditLineage?: CapabilityAuditLineage;
  readonly workspaceDb: CoreDb;
  readonly callId?: string;
  readonly now?: Date;
}

/** Input for starting one capability call. */
export interface StartCapabilityCallInput extends GatewayCallContext {
  /** Existing command lineage for Audit only; it never changes call idempotency. */
  readonly auditLineage?: CapabilityAuditLineage;
  /** Database handle for the immutable call owner. */
  workspaceDb: WorkspaceDb;
  /** Stable call id for deterministic tests. */
  callId?: string;
  /** Start time. */
  now?: Date;
}

/** Started capability call summary returned to producers. */
export interface StartedCapabilityCall<
  C extends GatewayCallContext | ServerGatewayCallContext = GatewayCallContext,
> {
  /** Durable call id. */
  id: string;
  /** Whether this invocation created the durable call row. */
  inserted: boolean;
  /** Gateway call context copied from the stored row. */
  context: C;
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
  /** Resolved provider-native model actually measured, when known. */
  providerModel?: string | null;
  /** Provider reference when applicable. */
  providerRef?: string | null;
  /** Measurement source. */
  source?: string | null;
}

/** Trusted command lineage for audit only, separate from capability-call idempotency. */
export interface CapabilityAuditLineage {
  /** Admitted command request ID retained when the call has no per-invocation request ID. */
  readonly commandRequestId: string;
}

/** Input for recording usage rows for one capability call. */
export interface RecordUsageInput {
  /** Database handle for the immutable call owner. */
  workspaceDb: WorkspaceDb | CoreDb;
  /** Started call returned by startCapabilityCall. */
  call: StartedCapabilityCall<GatewayCallContext | ServerGatewayCallContext>;
  /** Usage rows to record. */
  records: UsageMeasurementInput[];
  /** Trusted command lineage for the audit event if usage recording fails. */
  auditLineage?: CapabilityAuditLineage | undefined;
  /** Recording time. */
  now?: Date;
}

/** Input for finishing one capability call. */
export interface FinishCapabilityCallInput {
  /** Actual upstream HTTP status, retained as numeric context in the terminal Audit summary. */
  upstreamHttpStatus?: number;
  /** Exact serialized byte size of a complete semantic result refused by its bound. */
  refusedResultBytes?: number;
  /** Existing call retains the exact delivered Knowledge answer; no parallel delivery record. */
  deliveredKnowledgeAnswer?: string;
  /** Database handle for the immutable call owner. */
  workspaceDb: WorkspaceDb | CoreDb;
  /** Durable call id. */
  callId: string;
  /** Terminal status. */
  status: Exclude<CapabilityCall['status'], 'queued' | 'running'>;
  /** Stable error code for non-success terminal calls. */
  errorCode?: string | null;
  /** Trusted command lineage for audit only; never copied into the call row. */
  auditLineage?: CapabilityAuditLineage | undefined;
  /** Completion time. */
  now?: Date;
}

/** Input for binding a running call to its observed schema snapshot. */
export interface StampCapabilityCallSchemaSnapshotInput {
  /** Database handle for the immutable call owner. */
  readonly workspaceDb: WorkspaceDb | CoreDb;
  /** Durable running capability call id. */
  readonly callId: string;
  /** Stable schema snapshot id used for validation. */
  readonly schemaSnapshotId: string;
}

/** Input for recovering non-terminal capability calls after restart. */
export interface RecoverRunningCapabilityCallsInput {
  /** Database handle for the immutable call owner. */
  workspaceDb: WorkspaceDb | CoreDb;
  /** Recovery time. */
  now?: Date;
}

/** Existing native admission constituents; no extra command or durable fact is introduced. */
type NativeCapabilityAdmissionFacts = Pick<
  Extract<ControlCapabilityCommandInput, { kind: 'admit' }>,
  | 'initializeRaw'
  | 'freshSystemPromptDigest'
  | 'singleUseRequestId'
  | 'decision'
  | 'warmMcpSchema'
  | 'retainMcpAdmissionFailure'
>;
/** Starts a call through its exact database owner before any dependent upstream contact. */
export function startCapabilityCall(
  input: StartServerCapabilityCallInput
): Promise<StartedCapabilityCall<ServerGatewayCallContext>>;
export function startCapabilityCall(
  input: StartCapabilityCallInput & NativeCapabilityAdmissionFacts
): Promise<
  StartedCapabilityCall & { readonly admissionFailure?: ControlCapabilityAdmissionFailure }
>;
export function startCapabilityCall(
  input:
    | (StartCapabilityCallInput & NativeCapabilityAdmissionFacts)
    | StartServerCapabilityCallInput
): Promise<
  | StartedCapabilityCall<ServerGatewayCallContext>
  | (StartedCapabilityCall & { readonly admissionFailure?: ControlCapabilityAdmissionFailure })
> {
  assertWorkspaceCapabilityActor(input);
  if (input.workspaceDb.scope === 'core') {
    const { workspaceDb, callId, auditLineage, now, ...context } =
      input as StartServerCapabilityCallInput;
    if (input.workspaceId !== undefined || context.owner?.kind !== 'server')
      throw new Error('Capability call database owner mismatch.');
    return getControlStoreWorkerClient()
      .coreCapability(
        workspaceDb,
        ControlCapabilityCommandInputSchema.parse({
          kind: 'server-admit',
          context,
          callId,
          auditLineage,
          now: now?.toISOString(),
        })
      )
      .then((result) => {
        if (
          result === null ||
          typeof result !== 'object' ||
          !('inserted' in result) ||
          !('owner' in result.context) ||
          result.context.owner.kind !== 'server'
        )
          throw new TypeError('Invalid native Server capability admission result.');
        return presentControlFacts(result) as StartedCapabilityCall<ServerGatewayCallContext>;
      });
  }
  const {
    workspaceDb,
    workspaceId,
    callId,
    auditLineage,
    now,
    initializeRaw,
    freshSystemPromptDigest,
    singleUseRequestId,
    decision,
    warmMcpSchema,
    retainMcpAdmissionFailure,
    ...context
  } = input as StartCapabilityCallInput & NativeCapabilityAdmissionFacts;
  if (workspaceId !== workspaceDb.workspaceId)
    throw new Error('Capability call database owner mismatch.');
  return getControlStoreWorkerClient()
    .workspaceCapability(
      workspaceDb,
      ControlCapabilityCommandInputSchema.parse({
        kind: 'admit',
        workspaceId,
        context: { ...context, authorityActor: context.authorityActor ?? null },
        callId,
        auditLineage,
        initializeRaw,
        freshSystemPromptDigest,
        singleUseRequestId,
        decision,
        warmMcpSchema,
        retainMcpAdmissionFailure,
        now: (now ?? new Date()).toISOString(),
      })
    )
    .then((result) => {
      if (result === null || typeof result !== 'object' || !('inserted' in result))
        throw new TypeError('Invalid native capability admission result.');
      return presentControlFacts({ ...result, context: presentControlFacts(result.context) });
    });
}

/**
 * Settles one MCP call with contacted usage and its complete terminal mutation in one native transaction.
 * A definite usage refusal needs a separate best-effort diagnostic because its savepoint rolled back.
 * @param call Original admitted call and immutable attribution.
 * @param workspaceDb Existing Workspace owner.
 * @param finish Original terminal outcome, numeric failure diagnostics, optional Item clear, Goal escalation and no-contact decision.
 * @param contacted Whether contact is not disproved and this invocation still needs usage accounting.
 */
export async function finishMcpToolCall(
  call: StartedCapabilityCall,
  workspaceDb: WorkspaceDb,
  finish: Pick<
    FinishCapabilityCallInput,
    'status' | 'errorCode' | 'upstreamHttpStatus' | 'refusedResultBytes'
  > & {
    readonly clearItem?: boolean;
    readonly goalEscalationId?: string;
    readonly decision?: Extract<
      ControlCapabilityCommandInput,
      { kind: 'usage-finish' }
    >['decision'];
  },
  contacted = true
): Promise<void> {
  const now = new Date().toISOString();
  const { decision, ...terminal } = finish;
  try {
    await getControlStoreWorkerClient().workspaceCapability(workspaceDb, {
      kind: 'usage-finish',
      workspaceId: workspaceDb.workspaceId,
      call: { id: call.id, inserted: call.inserted, context: call.context },
      ...(decision ? { decision } : {}),
      ...(contacted ? { usage: mcpToolContactUsage(now) } : {}),
      finish: presentControlFacts({ ...terminal, clearItem: terminal.clearItem || undefined, now }),
    });
  } catch (error) {
    if (error instanceof ControlStoreWorkerError && error.commit === 'unknown') throw error;
    if (
      contacted &&
      ((error instanceof OperationError && error.code === 'usage_record_failed') ||
        (error instanceof TypeError && error.message === 'Unsupported retained record format.'))
    ) {
      try {
        await finishCapabilityCall({
          workspaceDb,
          callId: call.id,
          status: 'failed',
          errorCode: 'usage_record_failed',
        });
      } catch {}
    }
    throw error;
  }
}

/** Preserves each original Core measurement commit and its separate failure closeout. */
async function recordCoreUsage(
  input: RecordUsageInput & { workspaceDb: CoreDb }
): Promise<string[]> {
  const context = input.call.context;
  if (context.workspaceId !== undefined || !('owner' in context) || context.owner.kind !== 'server')
    throw new Error('Usage record database owner mismatch.');
  const ids: string[] = [];
  const now = (input.now ?? new Date()).toISOString();
  try {
    for (const measurement of input.records) {
      const result = await getControlStoreWorkerClient().coreCapability(
        input.workspaceDb,
        ControlCapabilityCommandInputSchema.parse({
          kind: 'server-usage',
          call: input.call,
          measurement,
          auditLineage: input.auditLineage,
          now,
        })
      );
      if (!Array.isArray(result)) throw new TypeError('Invalid native usage result.');
      ids.push(...result);
    }
  } catch (error) {
    // A lost acknowledgement is unknown, never authority to diagnose and rewrite the Call.
    if (!(error instanceof ControlStoreWorkerError && error.commit === 'unknown')) {
      try {
        await finishCapabilityCall({
          workspaceDb: input.workspaceDb,
          callId: input.call.id,
          auditLineage: input.auditLineage,
          status: 'failed',
          errorCode: 'usage_record_failed',
        });
      } catch {}
    }
    throw error;
  }
  return ids;
}

/** Records measurements through the same bounded owner for either canonical database scope. */
export function recordUsage(input: RecordUsageInput & { workspaceDb: CoreDb }): Promise<string[]>;
export function recordUsage(
  input: RecordUsageInput & { workspaceDb: WorkspaceDb }
): Promise<string[]>;
export function recordUsage(input: RecordUsageInput): Promise<string[]>;
export function recordUsage(input: RecordUsageInput): Promise<string[]> {
  const db = input.workspaceDb;
  if (db.scope === 'core') return recordCoreUsage({ ...input, workspaceDb: db });
  return (async () => {
    if (input.call.context.workspaceId !== db.workspaceId)
      throw new Error('Usage record database owner mismatch.');
    const callId = input.call.id;
    const auditLineage = input.auditLineage && {
      commandRequestId: input.auditLineage.commandRequestId,
    };
    const recordedAt = (input.now ?? new Date()).toISOString();
    let result: ControlCapabilityCommandResult;
    try {
      result = await getControlStoreWorkerClient().workspaceCapability(
        db,
        ControlCapabilityCommandInputSchema.parse({
          kind: 'usage-finish',
          workspaceId: db.workspaceId,
          call: input.call,
          usage: {
            records: input.records,
            auditLineage,
            now: recordedAt,
          },
        })
      );
    } catch (error) {
      // A lost ACK cannot authorize a new failure diagnosis for the original command.
      if (!(error instanceof ControlStoreWorkerError && error.commit === 'unknown')) {
        try {
          await finishCapabilityCall({
            workspaceDb: db,
            callId,
            auditLineage,
            status: 'failed',
            errorCode: 'usage_record_failed',
          });
        } catch {}
      }
      throw error;
    }
    if (!Array.isArray(result)) throw new TypeError('Invalid native usage result.');
    return result;
  })();
}

/** Finishes the actual Call and linked Audit through its canonical database owner. */
export function finishCapabilityCall(
  input: FinishCapabilityCallInput & { workspaceDb: CoreDb }
): Promise<void>;
export function finishCapabilityCall(
  input: FinishCapabilityCallInput & { workspaceDb: WorkspaceDb }
): Promise<void>;
export function finishCapabilityCall(input: FinishCapabilityCallInput): Promise<void>;
export function finishCapabilityCall(input: FinishCapabilityCallInput): Promise<void> {
  if (input.workspaceDb.scope === 'core') {
    const { workspaceDb, now, callId, ...facts } = input;
    return getControlStoreWorkerClient()
      .coreCapability(
        workspaceDb,
        ControlCapabilityCommandInputSchema.parse({
          kind: 'server-finish',
          callId,
          finish: { ...facts, now: now?.toISOString() },
        })
      )
      .then((result) => {
        if (result !== null) throw new TypeError('Invalid native capability finish result.');
      });
  }
  const { workspaceDb, now, callId, ...finish } = input;
  return getControlStoreWorkerClient()
    .workspaceCapability(
      workspaceDb,
      ControlCapabilityCommandInputSchema.parse({
        kind: 'finish',
        workspaceId: workspaceDb.workspaceId,
        callId,
        finish: { ...finish, now: (now ?? new Date()).toISOString() },
      })
    )
    .then((result) => {
      if (result !== null) throw new TypeError('Invalid native capability finish result.');
    });
}

/** Schema attribution uses the exact existing Call owner in both scopes. */
export function stampCapabilityCallSchemaSnapshot(
  input: StampCapabilityCallSchemaSnapshotInput
): Promise<void> {
  if (input.workspaceDb.scope === 'core')
    return getControlStoreWorkerClient()
      .coreCapability(input.workspaceDb, {
        kind: 'server-attribution',
        callId: input.callId,
        schemaSnapshotId: input.schemaSnapshotId,
      })
      .then((result) => {
        if (result !== null) throw new TypeError('Invalid native schema stamp result.');
      });
  return getControlStoreWorkerClient()
    .workspaceCapability(input.workspaceDb, {
      kind: 'attribution',
      workspaceId: input.workspaceDb.workspaceId,
      callId: input.callId,
      schemaSnapshotId: input.schemaSnapshotId,
    })
    .then((result) => {
      if (result !== null) throw new TypeError('Invalid native schema stamp result.');
    });
}

/**
 * Terminates non-terminal capability calls left behind by a prior process.
 *
 * @param input Workspace database and recovery time.
 * @returns Number of recovered calls.
 */
export function recoverRunningCapabilityCalls(
  input: RecoverRunningCapabilityCallsInput & { workspaceDb: WorkspaceDb }
): number;
export function recoverRunningCapabilityCalls(
  input: RecoverRunningCapabilityCallsInput & { workspaceDb: CoreDb }
): Promise<number>;
export function recoverRunningCapabilityCalls(
  input: RecoverRunningCapabilityCallsInput
): number | Promise<number>;
export function recoverRunningCapabilityCalls(
  input: RecoverRunningCapabilityCallsInput
): number | Promise<number> {
  const now = input.now ?? new Date();
  const calls = input.workspaceDb.sqlite
    .prepare('SELECT * FROM capability_calls WHERE status = ?')
    .all('running') as CapabilityCallRow[];
  if (input.workspaceDb.scope === 'core')
    return (async () => {
      for (const call of calls)
        await finishCapabilityCall({
          callId: call.call_id,
          errorCode: 'capability_call_recovered_after_restart',
          now,
          status: 'unknown',
          workspaceDb: input.workspaceDb,
        });
      return calls.length;
    })();

  for (const call of calls) {
    finishCapabilityCallInDb({
      callId: call.call_id,
      errorCode: 'capability_call_recovered_after_restart',
      now,
      status: 'unknown',
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
 * @param selection Optional unsettled-only read without full-export contact annotations.
 * @returns Capability call records in stable storage order.
 */
export function listWorkspaceCapabilityCalls(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  selection?: 'unsettled'
): CapabilityCallLedgerRecord[] {
  const noContact = new Set<string>();
  for (const decision of selection
    ? []
    : listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)) {
    const context = decision.contextSummary;
    if (
      decision.result === 'deny' &&
      decision.reasonCode === 'mcp_approval_submission_refused' &&
      context !== null &&
      typeof context === 'object' &&
      !Array.isArray(context)
    ) {
      const facts = context as Record<string, unknown>;
      if (facts.upstreamContacted === false && typeof facts.capabilityCallId === 'string')
        noContact.add(facts.capabilityCallId);
    }
  }
  return workspaceDb.sqlite
    .prepare(
      `SELECT * FROM capability_calls
       WHERE workspace_id = ? ${selection ? `AND (status IN ('running','unknown') OR status NOT IN (${CapabilityCallStatusSchema.options.map(() => '?').join(',')}))` : ''}
       ORDER BY started_at, call_id`
    )
    .all(workspaceId, ...(selection ? CapabilityCallStatusSchema.options : []))
    .map((row) => {
      const call = capabilityCallFromRow(row);
      return noContact.has(call.id) ? { ...call, upstreamContacted: false as const } : call;
    });
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
    .map((row) => usageRecordFromRow(row));
}

/** Reads Server calls from the same ledger family after Server audience authorization. */
export function listServerCapabilityCalls(coreDb: CoreDb): CapabilityCallLedgerRecord[] {
  return coreDb.sqlite
    .prepare('SELECT * FROM capability_calls ORDER BY started_at, call_id')
    .all()
    .map((row) => capabilityCallFromRow(row, true));
}

/** Reads Server measurements after Server audience authorization. */
export function listServerUsageRecords(coreDb: CoreDb): ServerUsageRecord[] {
  return coreDb.sqlite
    .prepare('SELECT * FROM usage_records ORDER BY recorded_at, usage_id')
    .all()
    .map((row) => usageRecordFromRow(row, true) as ServerUsageRecord);
}

/** Latest current-session LLM usage joined to a family=llm capability call. */
export interface CurrentAgentSessionLlmUsage {
  /** Capability call that attributed the usage. */
  readonly capabilityCallId: string;
  /** Last attributed logical model id. */
  readonly modelId: string;
  /** Usage recording timestamp. */
  readonly recordedAt: string;
  /** Exact Turn id recorded on the usage and capability call. */
  readonly turnId: string;
}

/**
 * Reads the most recent category=llm usage for one current AgentSession joined to a family=llm call.
 *
 * @param workspaceDb Workspace database that owns the ledger rows.
 * @param input Exact Workspace, Thread, and current AgentSession lineage.
 * @returns Latest matching usage, or null when attribution is absent.
 */
export function readLatestCurrentAgentSessionLlmUsage(
  workspaceDb: WorkspaceDb,
  input: {
    readonly agentSessionId: string;
    readonly threadId: string;
    readonly workspaceId: string;
  }
): CurrentAgentSessionLlmUsage | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
         usage.schema_version AS usage_schema_version,
         call.schema_version AS call_schema_version,
         usage.capability_call_id AS capability_call_id,
         usage.model_id AS model_id,
         usage.recorded_at AS recorded_at,
         usage.turn_id AS turn_id
       FROM usage_records usage
       INNER JOIN capability_calls call ON call.call_id = usage.capability_call_id
       WHERE usage.workspace_id = ?
         AND usage.thread_id = ?
         AND usage.agent_session_id = ?
         AND usage.category = 'llm'
         AND usage.model_id IS NOT NULL
         AND usage.model_id != ''
         AND usage.turn_id IS NOT NULL
         AND call.family = 'llm'
         AND call.workspace_id = usage.workspace_id
         AND call.thread_id = usage.thread_id
         AND call.turn_id = usage.turn_id
         AND call.agent_session_id = usage.agent_session_id
       ORDER BY usage.recorded_at DESC, usage.usage_id DESC
       LIMIT 1`
    )
    .get(input.workspaceId, input.threadId, input.agentSessionId) as
    | {
        readonly usage_schema_version: number;
        readonly call_schema_version: number;
        readonly capability_call_id: string;
        readonly model_id: string;
        readonly recorded_at: string;
        readonly turn_id: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  readRetainedV1({ schemaVersion: row.usage_schema_version }, () => undefined);
  readRetainedV1({ schemaVersion: row.call_schema_version }, () => undefined);
  return {
    capabilityCallId: row.capability_call_id,
    modelId: row.model_id,
    recordedAt: row.recorded_at,
    turnId: row.turn_id,
  };
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
    if (call.owner.kind !== 'workspace' || call.owner.workspaceId !== input.workspaceDb.workspaceId)
      throw new Error('Imported capability call owner does not match the target Workspace.');
  }
  for (const call of input.capabilityCalls) {
    insertCapabilityCall(input.workspaceDb, call);
  }
  for (const usage of input.usageRecords) {
    insertUsageRecord(input.workspaceDb, usage);
  }
}

/** Inserts one exportable capability call record. */
function insertCapabilityCall(workspaceDb: WorkspaceDb, call: CapabilityCallLedgerRecord): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO capability_calls (
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
        runtime_cache_lineage_ref,
        system_prompt_digest,
        extensions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1(call).schemaVersion,
      call.id,
      workspaceIdForOwner(call.owner),
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
      call.schemaSnapshotId,
      call.runtimeOriginRef,
      call.runtimeCacheLineageRef,
      call.systemPromptDigest ?? null,
      call.extensions === undefined
        ? null
        : JSON.stringify(CanonicalCapabilityCallExtensionsSchema.parse(call.extensions))
    );
}

/** Inserts one protocol usage record. */
function insertUsageRecord(workspaceDb: WorkspaceDb, usage: UsageRecord): void {
  workspaceDb.sqlite
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
      usage.providerModel ?? null,
      usage.providerRef,
      usage.source,
      usage.recordedAt
    );
}

/** Converts one stored usage row into a protocol usage record. */
function usageRecordFromRow(row: unknown): UsageRecord;
function usageRecordFromRow(row: unknown, server: boolean): UsageRecord | ServerUsageRecord;
function usageRecordFromRow(row: unknown, server = false): UsageRecord | ServerUsageRecord {
  const usage = row as Record<string, unknown>;
  readRetainedV1({ schemaVersion: usage.schema_version }, () => undefined);

  return (server ? ServerUsageRecordSchema : UsageRecordSchema).parse({
    id: usage.usage_id,
    ...(server ? { owner: { kind: 'server' } } : { workspaceId: usage.workspace_id }),
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
    providerModel: usage.provider_model ?? null,
    providerRef: usage.provider_ref,
    source: usage.source,
    recordedAt: usage.recorded_at,
  });
}

/** Existing call and admitted owner supplied to the shared Gateway dispatcher. */
export interface GatewayCallLedgerBinding {
  readonly workspaceDb: WorkspaceDb | CoreDb;
  readonly call: StartedCapabilityCall<GatewayCallContext | ServerGatewayCallContext>;
}

/** Appends or settles one entry atomically; the open logical call remains the sole owner. */
/** Commits lineage through the exact Call owner before dependent observations. */
export function writeGatewayRouteLineage(
  input: GatewayCallLedgerBinding & {
    readonly logicalModelId: string;
    readonly entry: GatewayRouteLineageEntry;
    readonly entryIndex?: number;
  }
): Promise<number> {
  if (input.workspaceDb.scope === 'core')
    return getControlStoreWorkerClient()
      .coreCapability(
        input.workspaceDb,
        ControlCapabilityCommandInputSchema.parse({
          kind: 'server-attribution',
          callId: input.call.id,
          routeLineage: {
            logicalModelId: input.logicalModelId,
            entry: input.entry,
            entryIndex: input.entryIndex,
          },
        })
      )
      .then((result) => {
        if (typeof result !== 'number') throw new TypeError('Invalid native lineage result.');
        return result;
      });
  return getControlStoreWorkerClient()
    .workspaceCapability(
      input.workspaceDb,
      ControlCapabilityCommandInputSchema.parse({
        kind: 'attribution',
        workspaceId: input.workspaceDb.workspaceId,
        callId: input.call.id,
        routeLineage: {
          logicalModelId: input.logicalModelId,
          entry: input.entry,
          entryIndex: input.entryIndex,
        },
      })
    )
    .then((result) => {
      if (typeof result !== 'number') throw new TypeError('Invalid native lineage result.');
      return result;
    });
}
