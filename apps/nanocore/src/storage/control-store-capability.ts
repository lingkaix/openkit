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
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { persistLlmCapabilityCallSystemPromptDigest } from '../llm/system-prompt-digest.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { PermissionDecisionRetainedV1Schema } from '../policy/retained-records-v1.js';
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
]);
/** Transient binary binding for the current answer field, never retained data. */
export type ControlCapabilityWireInput = z.infer<typeof ControlCapabilityWireInputSchema>;

/** Selects only the concrete answer binding from the closed wire input. */
export function controlCapabilityTextSpan(input: ControlCapabilityWireInput) {
  return input.kind === 'usage-finish' ? input.finish?.deliveredKnowledgeAnswer : undefined;
}

/** Replaces the actual answer after binary capacity admission; no escaped JSON body is created. */
export function prepareControlCapabilityTransfer(value: ControlCapabilityCommandInput) {
  const input = ControlCapabilityCommandInputSchema.parse(value);
  if (input.kind !== 'usage-finish' || input.finish?.deliveredKnowledgeAnswer === undefined)
    return { input: ControlCapabilityWireInputSchema.parse(input), parts: [] };
  const text = input.finish.deliveredKnowledgeAnswer;
  return {
    input: ControlCapabilityWireInputSchema.parse({
      ...input,
      finish: { ...input.finish, deliveredKnowledgeAnswer: frameControlScalarText(text) },
    }),
    parts: [text],
  };
}

/** Rebuilds the concrete owner input outside SQL after exact scalar verification. */
export function prepareControlCapabilityCommand(
  value: ControlCapabilityWireInput,
  content?: ArrayBuffer
) {
  const input = ControlCapabilityWireInputSchema.parse(value);
  if (input.kind === 'usage-finish' && input.finish?.deliveredKnowledgeAnswer !== undefined)
    return ControlCapabilityCommandInputSchema.parse({
      ...input,
      finish: {
        ...input.finish,
        deliveredKnowledgeAnswer: readControlScalarText(
          input.finish.deliveredKnowledgeAnswer,
          content
        ),
      },
    });
  if (content !== undefined) throw new TypeError('Unexpected native scalar binary content.');
  return ControlCapabilityCommandInputSchema.parse(input);
}

/** Closed raw aggregate, actual StartedCapabilityCall or retained usage identifiers. */
export const ControlCapabilityCommandResultSchema = z.union([
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
  value: ControlCapabilityCommandInput
): ControlCapabilityCommandResult {
  const input = ControlCapabilityCommandInputSchema.parse(value);
  if (input.kind === 'checkpoint') return applyControlCheckpointCommand(db, input.input);
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new WorkerRawOutputAuthorityError();
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
  if (!final || !Number.isSafeInteger(chargedBytes)) throw new WorkerRawOutputAuthorityError();
  return { ...final, chargedBytes };
}
