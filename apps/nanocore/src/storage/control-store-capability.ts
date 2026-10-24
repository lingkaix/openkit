import {
  AgentEnvironmentAgentSchema,
  AgentEnvironmentMcpServerSchema,
  AgentEnvironmentScopeSchema,
} from '@openkit/config-schema';
import {
  ActorRefSchema,
  AuditAuthenticationSchema,
  AuditEventIdSchema,
  CapabilityCallIdSchema,
  CapabilityCallSchema,
  PermissionDecisionIdSchema,
  PolicyDecisionV1Schema,
  PolicyInvocationV1Schema,
  PolicyStatementReferenceV1Schema,
  RequestIdSchema,
  readRetainedV1,
  SystemPromptDigestSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UsageRecordIdSchema,
  UsageRecordSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  finishCapabilityCall,
  recordUsage,
  stampCapabilityCallSchemaSnapshot,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { persistLlmCapabilityCallSystemPromptDigest } from '../llm/system-prompt-digest.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { PermissionDecisionRetainedV1Schema } from '../policy/retained-records-v1.js';
import {
  readTurnMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
  WorkerCapabilityMcpToolSchema,
} from '../runtime/mcp-tool-schema-snapshots.js';
import {
  initializeWorkerRawOutput,
  invalidateWorkerRawOutputProof,
  observeWorkerRawOutput,
  settleWorkerRawOutput,
  WorkerRawOutputAuthorityError,
} from '../runtime/worker-raw-output.js';
import {
  applyControlCheckpointCommand,
  ControlCheckpointCommandInputSchema,
  ControlCheckpointCommandResultSchema,
} from './control-store-checkpoints.js';
import {
  ControlScalarTextSchema,
  frameControlScalarText,
  presentControlFacts,
  readControlScalarText,
} from './control-store-input.js';
import type { WorkspaceDb } from './db.js';

const scope = {
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  callId: CapabilityCallIdSchema,
};
const ordinal = z.number().int().nonnegative().safe();
const position = z
  .object({
    attemptId: z.string().min(1).max(4096),
    partId: ordinal,
    field: z.enum(['text', 'tool-arguments', 'reasoning']),
    fromBytePosition: ordinal,
    bytePosition: ordinal,
  })
  .strict()
  .refine((value) => value.bytePosition >= value.fromBytePosition, {
    message: 'Raw output position precedes its source prefix.',
  });

const callFields = CapabilityCallSchema.shape;
const callContext = z
  .object({
    workspaceId: WorkspaceIdSchema,
    authorityActor: ActorRefSchema.nullable(),
    authentication: AuditAuthenticationSchema.optional(),
    threadId: callFields.threadId.optional(),
    turnId: callFields.turnId.optional(),
    itemId: callFields.itemId.optional(),
    agentId: callFields.agentId.optional(),
    agentSessionId: callFields.agentSessionId.optional(),
    packageSnapshotId: callFields.packageSnapshotId.optional(),
    schemaSnapshotId: callFields.schemaSnapshotId.optional(),
    runtimeOriginRef: callFields.runtimeOriginRef.optional(),
    runtimeCacheLineageRef: callFields.runtimeCacheLineageRef.optional(),
    requestId: callFields.requestId.optional(),
    sourceIds: callFields.sourceIds.readonly().optional(),
    family: z.enum(['llm', 'mcp', 'knowledge', 'network', 'runtime', 'storage', 'workspace']),
    operation: z.string().min(1),
    capabilityId: callFields.capabilityId,
    summary: callFields.summary.optional(),
    providerRef: z.string().min(1).nullable().optional(),
    serviceRef: z.string().min(1).nullable().optional(),
    redactionClass: z.string().min(1),
  })
  .strict();
const startedCall = z
  .object({ id: CapabilityCallIdSchema, inserted: z.boolean(), context: callContext })
  .strict();
const auditLineage = z.object({ commandRequestId: RequestIdSchema }).strict();
const timestamp = z.string().datetime({ offset: true });
// Summaries retain descriptive JSON only; mediation, invocation and use limits carry authority.
const permissionDecision = z
  .object({
    decisionId: PermissionDecisionIdSchema,
    policyEngineVersion: z.string().min(1),
    policySnapshotId: z.string().min(1),
    subjectSummary: z.json(),
    action: z.string().min(1),
    resourceSummary: z.json(),
    contextSummary: z.record(z.string(), z.json()),
    result: PermissionDecisionRetainedV1Schema.shape.result,
    reasonCode: z.string().min(1),
    enforcementPoint: z.string().min(1),
    mediation: PolicyDecisionV1Schema.optional(),
    policyInvocation: PolicyInvocationV1Schema.optional(),
    uses: z
      .array(
        z
          .object({
            statement: PolicyStatementReferenceV1Schema,
            limit: z.number().int().positive(),
          })
          .strict()
      )
      .min(1)
      .optional(),
    requiredApprovalKind: z.string().min(1).nullable().optional(),
    approvalId: z.string().min(1).nullable().optional(),
    auditEventId: AuditEventIdSchema.nullable().optional(),
    auditActor: ActorRefSchema.nullable().optional(),
    now: timestamp,
  })
  .strict();
const measurement = z
  .object({
    usageId: UsageRecordIdSchema.optional(),
    category: UsageRecordSchema.shape.category,
    unit: UsageRecordSchema.shape.unit,
    quantity: UsageRecordSchema.shape.quantity,
    modelId: UsageRecordSchema.shape.modelId.optional(),
    providerRef: UsageRecordSchema.shape.providerRef.optional(),
    source: UsageRecordSchema.shape.source.optional(),
  })
  .strict();
const finish = z
  .object({
    status: z.enum([
      'succeeded',
      'failed',
      'denied',
      'aborted',
      'timed-out',
      'interrupted',
      'unknown',
    ]),
    errorCode: callFields.errorCode.optional(),
    deliveredKnowledgeAnswer: z.string().min(1).optional(),
    auditLineage: auditLineage.optional(),
    now: timestamp,
  })
  .strict();
const admitCommand = z
  .object({
    kind: z.literal('admit'),
    workspaceId: WorkspaceIdSchema,
    context: callContext.omit({ workspaceId: true }),
    callId: CapabilityCallIdSchema.optional(),
    auditLineage: auditLineage.optional(),
    now: timestamp,
    initializeRaw: z.boolean().optional(),
    freshSystemPromptDigest: SystemPromptDigestSchema.optional(),
    decision: permissionDecision.optional(),
  })
  .strict();
const permissionCommand = z
  .object({
    kind: z.literal('permission'),
    workspaceId: WorkspaceIdSchema,
    decision: permissionDecision,
  })
  .strict();
const usageFinishCommand = z
  .object({
    kind: z.literal('usage-finish'),
    workspaceId: WorkspaceIdSchema,
    call: startedCall,
    usage: z
      .object({
        records: z.array(measurement).min(1),
        auditLineage: auditLineage.optional(),
        now: timestamp,
      })
      .strict()
      .optional(),
    finish: finish.optional(),
  })
  .strict()
  .refine((input) => input.usage !== undefined || input.finish !== undefined, {
    message: 'A usage/finish command requires an owned mutation.',
  });

const mcpServer = AgentEnvironmentMcpServerSchema.pick({
  id: true,
  schemaPolicy: true,
  pinnedSchemaSnapshotId: true,
}).strict();
const mcpFrame = z
  .object({
    snapshotId: z.string().min(1),
    scope: AgentEnvironmentScopeSchema.pick({
      workspaceId: true,
      threadId: true,
      turnId: true,
      agentSessionId: true,
      triggerActor: true,
    }).strict(),
    agent: AgentEnvironmentAgentSchema.pick({ agentId: true }).strict(),
    supply: z.object({ mcpServers: z.array(mcpServer).length(1) }).strict(),
  })
  .strict();
const mcpCaptureCommand = z
  .object({
    kind: z.literal('mcp-schema'),
    workspaceId: WorkspaceIdSchema,
    callId: CapabilityCallIdSchema,
    environmentPackage: mcpFrame,
    schemaSnapshotId: z.string().min(1),
    serverVersion: z.string().nullable().optional(),
    tools: z.array(WorkerCapabilityMcpToolSchema),
  })
  .strict();

/** Dormant native commands; all prepared facts share the existing native savepoint. */
export const ControlCapabilityCommandInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkpoint'), input: ControlCheckpointCommandInputSchema }).strict(),
  admitCommand,
  permissionCommand,
  usageFinishCommand,
  z
    .object({ kind: z.literal('raw-observe'), ...scope, positions: z.array(position).min(1) })
    .strict(),
  z.object({ kind: z.literal('raw-settle'), ...scope, complete: z.boolean() }).strict(),
  z.object({ kind: z.literal('raw-invalidate'), ...scope }).strict(),
  mcpCaptureCommand,
]);
/** Exact prepared command admitted by the existing bounded native envelope. */
export type ControlCapabilityCommandInput = z.infer<typeof ControlCapabilityCommandInputSchema>;

/** Only the concrete delivered answer leaves JSON; other commands retain their closed framing. */
export const ControlCapabilityWireInputSchema = z.discriminatedUnion('kind', [
  ControlCapabilityCommandInputSchema.options[0],
  admitCommand,
  permissionCommand,
  z
    .object({
      ...usageFinishCommand.shape,
      finish: finish
        .extend({ deliveredKnowledgeAnswer: ControlScalarTextSchema.optional() })
        .optional(),
    })
    .strict()
    .refine((input) => input.usage !== undefined || input.finish !== undefined),
  ControlCapabilityCommandInputSchema.options[4],
  ControlCapabilityCommandInputSchema.options[5],
  ControlCapabilityCommandInputSchema.options[6],
  mcpCaptureCommand.extend({ serverVersion: ControlScalarTextSchema.nullable().optional() }),
]);
/** Transient binary binding for the current answer field, never retained data. */
export type ControlCapabilityWireInput = z.infer<typeof ControlCapabilityWireInputSchema>;

/** Selects only the concrete answer binding from the closed wire input. */
export function controlCapabilityTextSpan(input: ControlCapabilityWireInput) {
  return input.kind === 'usage-finish'
    ? input.finish?.deliveredKnowledgeAnswer
    : input.kind === 'mcp-schema'
      ? (input.serverVersion ?? undefined)
      : undefined;
}

/** Selects the one concrete scalar before shared binary admission and UTF-8 encoding. */
export function controlCapabilityTransferText(
  input: ControlCapabilityCommandInput
): string | undefined {
  return input.kind === 'usage-finish'
    ? input.finish?.deliveredKnowledgeAnswer
    : input.kind === 'mcp-schema'
      ? (input.serverVersion ?? undefined)
      : undefined;
}

/** Replaces only the concrete answer or observed server version after binary capacity admission. */
export function prepareControlCapabilityTransfer(value: ControlCapabilityCommandInput) {
  const input = ControlCapabilityCommandInputSchema.parse(value);
  const text = controlCapabilityTransferText(input);
  if (text === undefined)
    return { input: ControlCapabilityWireInputSchema.parse(input), parts: [] };
  const span = frameControlScalarText(text);
  const wire =
    input.kind === 'usage-finish'
      ? { ...input, finish: { ...input.finish, deliveredKnowledgeAnswer: span } }
      : { ...input, serverVersion: span };
  return { input: ControlCapabilityWireInputSchema.parse(wire), parts: [text] };
}

/** Rebuilds the exact owner scalar outside SQL after length, digest and UTF-8 verification. */
export function prepareControlCapabilityCommand(
  value: ControlCapabilityWireInput,
  content?: ArrayBuffer
) {
  const input = ControlCapabilityWireInputSchema.parse(value);
  const span = controlCapabilityTextSpan(input);
  if (span !== undefined) {
    const text = readControlScalarText(span, content);
    return ControlCapabilityCommandInputSchema.parse(
      input.kind === 'usage-finish'
        ? { ...input, finish: { ...input.finish, deliveredKnowledgeAnswer: text } }
        : { ...input, serverVersion: text }
    );
  }
  if (content !== undefined) throw new TypeError('Unexpected native scalar binary content.');
  return ControlCapabilityCommandInputSchema.parse(input);
}

/** Closed raw aggregate, actual StartedCapabilityCall or retained usage identifiers. */
export const ControlCapabilityCommandResultSchema = z.union([
  z.object({ schemaSnapshotId: z.string().min(1), liveSnapshotId: z.string().min(1) }).strict(),
  ControlCheckpointCommandResultSchema,
  z.object({ rawOutputBytes: ordinal, exhausted: z.boolean(), chargedBytes: ordinal }).strict(),
  startedCall,
  z.array(UsageRecordIdSchema),
  z.null(),
]);
/** Prepared results become visible only after the existing outer durable acknowledgement. */
export type ControlCapabilityCommandResult = z.infer<typeof ControlCapabilityCommandResultSchema>;

/** Records only prepared Workspace facts; the existing owner checks finite uses and linked Audit. */
function recordControlPermissionDecision(
  db: WorkspaceDb,
  decision: z.infer<typeof permissionDecision>
): void {
  recordProductPermissionDecision(
    presentControlFacts({
      ...decision,
      workspaceDb: db,
      workspaceId: db.workspaceId,
      ownerScope: 'workspace',
      now: new Date(decision.now),
    })
  );
}

/** Applies prepared ledger facts and raw proof on the supplied native transaction. */
export function applyControlCapabilityCommand(
  db: WorkspaceDb,
  input: ControlCapabilityCommandInput
): ControlCapabilityCommandResult {
  if (input.kind === 'checkpoint') return applyControlCheckpointCommand(db, input.input);
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new WorkerRawOutputAuthorityError();
  if (input.kind === 'mcp-schema') {
    if (input.environmentPackage.scope.workspaceId !== db.workspaceId)
      throw new WorkerRawOutputAuthorityError();
    const selected = input.environmentPackage.supply.mcpServers[0]!;
    const frame = input.environmentPackage;
    const actual = db.sqlite
      .prepare(`SELECT schema_version, workspace_id, thread_id, turn_id,
      agent_session_id, package_snapshot_id, agent_id, provider_ref, family, operation, capability_id,
      status, completed_at FROM capability_calls WHERE call_id = ?`)
      .get(input.callId) as Record<string, unknown> | undefined;
    if (actual) readRetainedV1({ schemaVersion: actual.schema_version }, () => undefined);
    const facts = {
      workspace_id: db.workspaceId,
      thread_id: frame.scope.threadId,
      turn_id: frame.scope.turnId,
      agent_session_id: frame.scope.agentSessionId,
      package_snapshot_id: frame.snapshotId,
      agent_id: frame.agent.agentId,
      provider_ref: selected.id,
      family: 'mcp',
      status: 'running',
      completed_at: null,
    };
    if (
      !actual ||
      Object.entries(facts).some(([key, fact]) => actual[key] !== fact) ||
      !['mcp.list-tools', 'mcp.call-tool'].includes(String(actual.operation)) ||
      actual.capability_id !== actual.operation
    )
      throw new WorkerRawOutputAuthorityError();
    const bound = readTurnMcpToolSchemaSnapshot({ ...input, selected, workspaceDb: db });
    const liveSnapshotId = recordMcpToolSchemaSnapshot({
      ...input,
      capabilityCallId: input.callId,
      serverId: selected.id,
      source: 'live',
      workspaceDb: db,
      onRecorded: (liveId) => {
        if (selected.schemaPolicy === 'pinned' && selected.pinnedSchemaSnapshotId !== liveId)
          return;
        stampCapabilityCallSchemaSnapshot({
          callId: input.callId,
          schemaSnapshotId: bound?.schemaSnapshotId ?? liveId,
          workspaceDb: db,
        });
      },
    });
    return { schemaSnapshotId: bound?.schemaSnapshotId ?? liveSnapshotId, liveSnapshotId };
  }
  if (input.kind === 'admit') {
    const call = startCapabilityCall(
      presentControlFacts({
        ...input.context,
        workspaceDb: db,
        workspaceId: db.workspaceId,
        callId: input.callId,
        auditLineage: input.auditLineage,
        now: new Date(input.now),
      })
    );
    if (call.inserted) {
      if (input.freshSystemPromptDigest !== undefined)
        persistLlmCapabilityCallSystemPromptDigest({
          workspaceDb: db,
          callId: call.id,
          systemPromptDigest: input.freshSystemPromptDigest,
        });
      if (input.initializeRaw) {
        const { threadId, turnId } = call.context;
        if (!threadId || !turnId) throw new WorkerRawOutputAuthorityError();
        initializeWorkerRawOutput(db, call, { workspaceId: db.workspaceId, threadId, turnId });
      }
    }
    if (call.inserted && input.decision) {
      if (input.decision.contextSummary.capabilityCallId !== call.id)
        throw new WorkerRawOutputAuthorityError();
      recordControlPermissionDecision(db, input.decision);
    }
    return call;
  }
  if (input.kind === 'permission') {
    recordControlPermissionDecision(db, input.decision);
    return null;
  }
  if (input.kind === 'usage-finish') {
    if (input.call.context.workspaceId !== db.workspaceId)
      throw new WorkerRawOutputAuthorityError();
    const ids = input.usage
      ? recordUsage(
          presentControlFacts({
            ...input.usage,
            workspaceDb: db,
            call: { ...input.call, context: presentControlFacts(input.call.context) },
            records: input.usage.records.map(presentControlFacts),
            now: new Date(input.usage.now),
          })
        )
      : null;
    if (input.finish)
      finishCapabilityCall(
        presentControlFacts({
          ...input.finish,
          workspaceDb: db,
          callId: input.call.id,
          now: new Date(input.finish.now),
        })
      );
    return ids;
  }
  if (input.kind === 'raw-settle') {
    settleWorkerRawOutput(db, input, input.callId, input.complete);
    return null;
  }
  if (input.kind === 'raw-invalidate') {
    invalidateWorkerRawOutputProof(db, input, input.callId);
    return null;
  }
  let chargedBytes = 0;
  let final: ReturnType<typeof observeWorkerRawOutput> | undefined;
  for (const watermark of input.positions) {
    final = observeWorkerRawOutput(db, { ...input, ...watermark });
    chargedBytes += final.chargedBytes;
  }
  if (!final) throw new WorkerRawOutputAuthorityError();
  return { ...final, chargedBytes };
}
