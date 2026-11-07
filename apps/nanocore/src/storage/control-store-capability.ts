import { isDeepStrictEqual } from 'node:util';
import {
  AgentEnvironmentAgentSchema,
  AgentEnvironmentMcpServerSchema,
  AgentEnvironmentScopeSchema,
} from '@openkit/config-schema';
import {
  ActorRefSchema,
  AuditAuthenticationSchema,
  AuditEventIdSchema,
  AuditEventSchema,
  CapabilityCallIdSchema,
  CapabilityCallSchema,
  GatewayRouteLineageEntrySchema,
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
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { recordUserAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import {
  hasCapabilityCallRequestId,
  normalizeCapabilityRequestId,
  recordUsageInDb,
  startCapabilityCallInDb,
} from '../capability/usage-ledger.js';
import {
  clearCapabilityCallItemInDb,
  finishCapabilityCallInDb,
  persistLlmCapabilityCallSystemPromptDigestInDb,
  stampCapabilityCallSchemaSnapshotInDb,
  writeCapabilityCallCacheInDb,
  writeGatewayRouteLineageInDb,
} from '../capability/usage-ledger-native.js';
import { OperationError, projectControlCapabilityFailure } from '../operation-error.js';
import {
  prepareCapturedCapabilityAdmission,
  recordBootPolicySelfCheckDecisionsInDb,
  recordProductPermissionDecisionInDb,
} from '../policy/permission-decisions.js';
import { PermissionDecisionRetainedV1Schema } from '../policy/retained-records-v1.js';
import {
  prepareMcpToolSchemaSnapshot,
  readTurnMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshotInDb,
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
  WorkerCapabilityMcpToolSchema,
} from './control-store-input.js';
import type { CoreDb, UserDb, WorkspaceDb } from './db.js';

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
    providerModel: UsageRecordSchema.shape.providerModel.optional(),
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
    clearItem: z.literal(true).optional(),
    goalEscalationId: z.string().min(1).optional(),
    auditLineage: auditLineage.optional(),
    now: timestamp,
  })
  .strict();
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

const capturedRefusal = z.enum([
  'membership-revoked',
  'agent-authority-revoked',
  'tool-left-supply',
  'schema-changed',
  'policy-changed',
  'credential-changed',
  'approval_preview_unavailable',
]);

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
    warmMcpSchema: mcpFrame.optional(),
    retainMcpAdmissionFailure: z.literal(true).optional(),
    singleUseRequestId: z.literal(true).optional(),
    capturedSource: z
      .object({
        requestId: z.string().min(1),
        sourceDecisionId: permissionDecision.shape.decisionId.nullable(),
        reviewedDecisionId: permissionDecision.shape.decisionId.nullable(),
        failure: capturedRefusal.optional(),
      })
      .strict()
      .optional(),
    finish: finish
      .pick({ status: true, errorCode: true, now: true })
      .extend({ status: z.literal('failed') })
      .optional(),
  })
  .strict()
  .refine((input) => input.finish === undefined || input.capturedSource !== undefined, {
    message: 'Admission finish belongs to the captured refusal tuple.',
  });
const permissionCommand = z
  .object({
    kind: z.literal('permission'),
    workspaceId: WorkspaceIdSchema,
    decision: permissionDecision,
  })
  .strict();
const hasUsageOrFinish = (input: { usage?: object | undefined; finish?: object | undefined }) =>
  input.usage !== undefined || input.finish !== undefined;
const usageFinishCommand = z
  .object({
    kind: z.literal('usage-finish'),
    workspaceId: WorkspaceIdSchema,
    call: startedCall,
    decision: permissionDecision.optional(),
    usage: z
      .object({
        records: z.array(measurement),
        auditLineage: auditLineage.optional(),
        now: timestamp,
      })
      .strict()
      .optional(),
    finish: finish.optional(),
  })
  .strict()
  .refine(hasUsageOrFinish, {
    message: 'A usage/finish command requires an owned mutation.',
  })
  .refine(
    (input) =>
      !input.decision ||
      (input.finish?.status === 'failed' &&
        input.usage === undefined &&
        input.decision.result === 'deny' &&
        input.decision.reasonCode === 'mcp_approval_submission_refused' &&
        input.decision.contextSummary.upstreamContacted === false &&
        input.decision.contextSummary.capabilityCallId === input.call.id),
    {
      message: 'A terminal decision belongs to the same failed, uncontacted captured Call.',
    }
  );

const mcpCaptureCommand = z
  .object({
    kind: z.literal('mcp-schema'),
    workspaceId: WorkspaceIdSchema,
    callId: CapabilityCallIdSchema.optional(),
    environmentPackage: mcpFrame,
    schemaSnapshotId: z.string().min(1),
    serverVersion: z.string().nullable().optional(),
    // The public schema facade imports the client; defer this schema read across that module cycle.
    tools: z.array(z.lazy(() => WorkerCapabilityMcpToolSchema)),
  })
  .strict();

const finishCommand = z
  .object({
    kind: z.literal('finish'),
    workspaceId: WorkspaceIdSchema,
    callId: CapabilityCallIdSchema,
    finish,
  })
  .strict();

const attributionCommand = z
  .object({
    kind: z.literal('attribution'),
    workspaceId: WorkspaceIdSchema,
    callId: CapabilityCallIdSchema,
    workerCache: z
      .object({
        runtimeCacheLineageRef: callFields.runtimeCacheLineageRef,
        summary: z.string(),
      })
      .strict()
      .optional(),
    systemPromptDigest: SystemPromptDigestSchema.optional(),
    routeLineage: z
      .object({
        logicalModelId: z.string().min(1),
        entry: GatewayRouteLineageEntrySchema,
        entryIndex: ordinal.optional(),
      })
      .strict()
      .optional(),
    schemaSnapshotId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.workerCache,
        input.systemPromptDigest,
        input.routeLineage,
        input.schemaSnapshotId,
      ].filter((value) => value !== undefined).length === 1,
    { message: 'Call attribution requires exactly one owned mutation.' }
  );
const participantAuditCommand = z
  .object({
    kind: z.literal('participant-audit'),
    workspaceId: WorkspaceIdSchema,
    event: AuditEventSchema.strict().extend({
      action: z.literal('policy.participant'),
      createdAt: timestamp,
      occurredAt: timestamp,
    }),
  })
  .strict();

const userPermissionCommand = z
  .object({
    kind: z.literal('user-permission'),
    userId: UserIdSchema,
    decision: permissionDecision,
  })
  .strict();
const userParticipantAuditCommand = z
  .object({
    kind: z.literal('user-participant-audit'),
    userId: UserIdSchema,
    event: participantAuditCommand.shape.event.extend({ workspaceId: z.null() }),
  })
  .strict();

const userAuditCommand = z
  .object({
    kind: z.literal('user-audit'),
    userId: UserIdSchema,
    event: AuditEventSchema.strict().extend({
      workspaceId: z.null(),
      createdAt: timestamp,
      occurredAt: timestamp,
    }),
  })
  .strict();

// Checkpoint owners share a value cycle; resolve their strict schemas only when parsing.
const checkpointCommand = z
  .object({
    kind: z.literal('checkpoint'),
    input: z.lazy(() => ControlCheckpointCommandInputSchema),
  })
  .strict();
const rawObserveCommand = z
  .object({
    kind: z.literal('raw-observe'),
    ...scope,
    positions: z.array(position).min(1),
  })
  .strict();
const rawSettleCommand = z
  .object({
    kind: z.literal('raw-settle'),
    ...scope,
    complete: z.boolean(),
  })
  .strict();
const rawInvalidateCommand = z.object({ kind: z.literal('raw-invalidate'), ...scope }).strict();

const serverContext = callContext.omit({ workspaceId: true }).extend({
  owner: z.object({ kind: z.literal('server') }).strict(),
});
const serverStartedCall = startedCall.extend({ context: serverContext });
const serverAdmitCommand = z
  .object({
    kind: z.literal('server-admit'),
    context: serverContext,
    callId: CapabilityCallIdSchema.optional(),
    auditLineage: auditLineage.optional(),
    now: timestamp.optional(),
  })
  .strict();
const serverUsageCommand = z
  .object({
    kind: z.literal('server-usage'),
    call: serverStartedCall,
    measurement,
    auditLineage: auditLineage.optional(),
    now: timestamp.optional(),
  })
  .strict();
const serverFinishCommand = z
  .object({
    kind: z.literal('server-finish'),
    callId: CapabilityCallIdSchema,
    finish: finish
      .pick({
        status: true,
        errorCode: true,
        auditLineage: true,
        now: true,
        deliveredKnowledgeAnswer: true,
      })
      .partial({ now: true }),
  })
  .strict();
const serverAttributionCommand = z
  .object({
    kind: z.literal('server-attribution'),
    callId: CapabilityCallIdSchema,
    systemPromptDigest: attributionCommand.shape.systemPromptDigest,
    schemaSnapshotId: attributionCommand.shape.schemaSnapshotId,
    routeLineage: attributionCommand.shape.routeLineage,
  })
  .strict()
  .refine(
    (input) =>
      [input.systemPromptDigest, input.schemaSnapshotId, input.routeLineage].filter(
        (value) => value !== undefined
      ).length === 1,
    { message: 'Call attribution requires exactly one owned mutation.' }
  );
/** Only the finite Kernel fields retained by each fixed boot decision cross the envelope. */
const bootKernelDecision = z
  .object({
    result: z.enum(['allow', 'deny']),
    reasonCode: z.string(),
    kernelTrace: z
      .object({
        matchedAssociations: z.array(z.string()),
        matchedProhibitions: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
/** The two original Server Policy SQL units share one closed family and existing prepared codec. */
const serverPermissionCommand = z
  .object({
    kind: z.literal('server-permission'),
    stage: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('record'),
          decision: permissionDecision,
          workspaceId: WorkspaceIdSchema.nullable().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('boot'),
          bootId: z.string(),
          policySnapshotId: z.string(),
          decisions: z.tuple([bootKernelDecision, bootKernelDecision]),
          now: timestamp.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
/** Names only the Server ledger cases of the existing capability owner. */
export function isServerCapabilityCommand(input: ControlCapabilityCommandInput): input is Extract<
  ControlCapabilityCommandInput,
  {
    kind:
      | 'server-admit'
      | 'server-usage'
      | 'server-finish'
      | 'server-attribution'
      | 'server-permission';
  }
> {
  return (
    input.kind === 'server-admit' ||
    input.kind === 'server-usage' ||
    input.kind === 'server-finish' ||
    input.kind === 'server-attribution' ||
    input.kind === 'server-permission'
  );
}
/** User Policy shares the existing capability Unit, without Workspace or Server ledger authority. */
export function isUserPolicyCommand(
  input: ControlCapabilityCommandInput | ControlCapabilityWireInput
): input is Extract<
  ControlCapabilityCommandInput,
  { kind: 'user-permission' | 'user-participant-audit' | 'user-audit' }
> {
  return (
    input.kind === 'user-permission' ||
    input.kind === 'user-participant-audit' ||
    input.kind === 'user-audit'
  );
}

/** Applies only the existing decision/Audit family under the native User savepoint. */
export function applyControlUserPolicyCommand(
  db: UserDb,
  input: ControlCapabilityCommandInput
): null {
  if (!db.sqlite.inTransaction || !isUserPolicyCommand(input) || input.userId !== db.userId)
    throw new WorkerRawOutputAuthorityError();
  if (input.kind === 'user-permission') {
    recordControlPermissionDecision(db, input.decision);
  } else {
    const { event } = input;
    recordUserAuditEvent(
      presentControlFacts({
        ...event,
        userDb: db,
        auditEventId: event.id,
        now: new Date(event.createdAt),
        occurredAt: new Date(event.occurredAt),
      })
    );
  }
  return null;
}

/** Known original ledger refusals, never native SQL diagnostics. */
export class CoreCapabilityRefusal extends Error {}
/** Restricts the private projection to original controlled domain messages. */
function isCoreCapabilityRefusal(error: unknown): error is Error {
  if (!(error instanceof Error) || error.name !== 'Error') return false;
  if (
    [
      'Capability call database owner mismatch.',
      'Usage record database owner mismatch.',
      'Capability call was not stored.',
      'Capability call attribution conflicts with the existing request.',
      'Capability usage ledger values must be redacted before recording.',
      'Gateway lineage requires its running CapabilityCall.',
      'Gateway lineage logical model conflicts.',
      'Gateway lineage entry is missing.',
      'Boot policy self-check record is contradictory.',
      'require_approval permission decisions require requiredApprovalKind.',
      'PermissionDecision enforcement point projection is inconsistent.',
      'Gate Policy invocation must match its decision and atomic linked Audit.',
      'Finite Policy uses require a final owner-scoped allow and atomic linked Audit.',
      'Consumed Policy statements must exactly match requested finite-use limits.',
    ].includes(error.message)
  )
    return true;
  return [
    'Capability call changed concurrently: ',
    'Capability call schema snapshot conflicts: ',
    'LLM capability call system-prompt digest was not recorded: ',
  ].some(
    (prefix) =>
      error.message.startsWith(prefix) &&
      CapabilityCallIdSchema.safeParse(error.message.slice(prefix.length)).success
  );
}
/** Runs one original Server commit stage on the Core savepoint; it adds no Workspace authority. */
export function applyControlCoreCapabilityCommand(
  db: CoreDb,
  input: ControlCapabilityCommandInput
): ControlCapabilityCommandResult {
  if (!db.sqlite.inTransaction || !isServerCapabilityCommand(input))
    throw new WorkerRawOutputAuthorityError();
  try {
    if (input.kind === 'server-permission') {
      if (input.stage.kind === 'record') {
        recordControlPermissionDecision(db, input.stage.decision, input.stage.workspaceId);
      } else {
        recordBootPolicySelfCheckDecisionsInDb({ ...input.stage, coreDb: db });
      }
      return null;
    }
    if (input.kind === 'server-admit')
      return startCapabilityCallInDb(
        presentControlFacts({
          ...input.context,
          workspaceDb: db,
          ...(input.callId === undefined ? {} : { callId: input.callId }),
          ...(input.auditLineage === undefined ? {} : { auditLineage: input.auditLineage }),
          ...(input.now === undefined ? {} : { now: new Date(input.now) }),
        })
      );
    if (input.kind === 'server-usage') {
      const records = [presentControlFacts(input.measurement)];
      return recordUsageInDb(
        presentControlFacts({
          workspaceDb: db,
          call: { ...input.call, context: presentControlFacts(input.call.context) },
          records,
          ...(input.auditLineage === undefined ? {} : { auditLineage: input.auditLineage }),
          ...(input.now === undefined ? {} : { now: new Date(input.now) }),
        })
      );
    }
    if (input.kind === 'server-finish') {
      const { now, ...facts } = input.finish;
      finishCapabilityCallInDb(
        presentControlFacts({
          ...facts,
          callId: input.callId,
          workspaceDb: db,
          ...(now === undefined ? {} : { now: new Date(now) }),
        })
      );
      return null;
    }
    if (input.systemPromptDigest)
      persistLlmCapabilityCallSystemPromptDigestInDb({
        workspaceDb: db,
        callId: input.callId,
        systemPromptDigest: input.systemPromptDigest,
      });
    if (input.schemaSnapshotId)
      stampCapabilityCallSchemaSnapshotInDb({
        workspaceDb: db,
        callId: input.callId,
        schemaSnapshotId: input.schemaSnapshotId,
      });
    return input.routeLineage
      ? writeGatewayRouteLineageInDb(
          presentControlFacts({
            ...input.routeLineage,
            workspaceDb: db,
            call: { id: input.callId },
          })
        )
      : null;
  } catch (error) {
    if (isCoreCapabilityRefusal(error)) throw new CoreCapabilityRefusal(error.message);
    throw error;
  }
}

/** Native commands; all prepared facts share the existing native savepoint. */
export const ControlCapabilityCommandInputSchema = z.discriminatedUnion('kind', [
  checkpointCommand,
  admitCommand,
  permissionCommand,
  usageFinishCommand,
  rawObserveCommand,
  rawSettleCommand,
  rawInvalidateCommand,
  mcpCaptureCommand,
  finishCommand,
  attributionCommand,
  participantAuditCommand,
  userPermissionCommand,
  userParticipantAuditCommand,
  userAuditCommand,
  serverAdmitCommand,
  serverUsageCommand,
  serverFinishCommand,
  serverAttributionCommand,
  serverPermissionCommand,
]);
/** Exact prepared command admitted by the existing bounded native envelope. */
export type ControlCapabilityCommandInput = z.infer<typeof ControlCapabilityCommandInputSchema>;

/** Only the concrete delivered answer leaves JSON; other commands retain their closed framing. */
export const ControlCapabilityWireInputSchema = z.discriminatedUnion('kind', [
  checkpointCommand,
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
    .refine(hasUsageOrFinish, {
      message: 'A usage/finish command requires an owned mutation.',
    }),
  rawObserveCommand,
  rawSettleCommand,
  rawInvalidateCommand,
  mcpCaptureCommand.extend({ serverVersion: ControlScalarTextSchema.nullable().optional() }),
  finishCommand.extend({
    finish: finish.extend({ deliveredKnowledgeAnswer: ControlScalarTextSchema.optional() }),
  }),
  attributionCommand,
  participantAuditCommand,
  userPermissionCommand,
  userParticipantAuditCommand,
  userAuditCommand,
  serverAdmitCommand,
  serverUsageCommand,
  serverFinishCommand.extend({
    finish: finish
      .pick({
        status: true,
        errorCode: true,
        auditLineage: true,
        now: true,
        deliveredKnowledgeAnswer: true,
      })
      .partial({ now: true })
      .extend({ deliveredKnowledgeAnswer: ControlScalarTextSchema.optional() }),
  }),
  serverAttributionCommand,
  serverPermissionCommand,
]);
/** Transient binary binding for the current answer field, never retained data. */
export type ControlCapabilityWireInput = z.infer<typeof ControlCapabilityWireInputSchema>;

/** Selects the same concrete scalar before framing and after verified wire admission. */
export function controlCapabilityText(
  input: ControlCapabilityWireInput
): z.infer<typeof ControlScalarTextSchema> | undefined;
export function controlCapabilityText(input: ControlCapabilityCommandInput): string | undefined;
export function controlCapabilityText(
  input: ControlCapabilityWireInput | ControlCapabilityCommandInput
) {
  return input.kind === 'usage-finish' || input.kind === 'finish' || input.kind === 'server-finish'
    ? input.finish?.deliveredKnowledgeAnswer
    : input.kind === 'mcp-schema'
      ? (input.serverVersion ?? undefined)
      : undefined;
}

/** Replaces only the concrete answer or observed server version after binary capacity admission. */
export function prepareControlCapabilityTransfer(value: ControlCapabilityCommandInput) {
  const input = ControlCapabilityCommandInputSchema.parse(value);
  const text = controlCapabilityText(input);
  if (text === undefined)
    return { input: ControlCapabilityWireInputSchema.parse(input), parts: [] };
  const span = frameControlScalarText(text);
  const wire =
    input.kind === 'usage-finish' || input.kind === 'finish' || input.kind === 'server-finish'
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
  const span = controlCapabilityText(input);
  if (span !== undefined) {
    const text = readControlScalarText(span, content);
    return ControlCapabilityCommandInputSchema.parse(
      input.kind === 'usage-finish' || input.kind === 'finish' || input.kind === 'server-finish'
        ? { ...input, finish: { ...input.finish, deliveredKnowledgeAnswer: text } }
        : { ...input, serverVersion: text }
    );
  }
  if (content !== undefined) throw new TypeError('Unexpected native scalar binary content.');
  return ControlCapabilityCommandInputSchema.parse(input);
}

/** Only classified owner failures cross native transport; unknown exceptions keep no text. */
export const ControlCapabilityAdmissionFailureSchema = z.union([
  z.object({ kind: z.literal('unknown') }).strict(),
  z
    .object({
      kind: z.enum(['operation', 'mcp', 'turn']),
      code: z.string().min(1).max(128),
      message: z.string(),
      status: z.number().int().min(400).max(599),
    })
    .strict(),
]);
/** The admitted Call retains its original classified failure without inventing success. */
export type ControlCapabilityAdmissionFailure = z.infer<
  typeof ControlCapabilityAdmissionFailureSchema
>;

/** Closed raw aggregate, actual StartedCapabilityCall or retained usage identifiers. */
export const ControlWorkspaceCapabilityCommandResultSchema = z.union([
  z.object({ schemaSnapshotId: z.string().min(1), liveSnapshotId: z.string().min(1) }).strict(),
  z.lazy(() => ControlCheckpointCommandResultSchema),
  z.object({ rawOutputBytes: ordinal, exhausted: z.boolean(), chargedBytes: ordinal }).strict(),
  startedCall.extend({
    admissionFailure: ControlCapabilityAdmissionFailureSchema.optional(),
    refusal: capturedRefusal.optional(),
  }),
  z.array(UsageRecordIdSchema),
  ordinal,
  z.null(),
]);
/** Workspace projections cannot acquire Server ownership through the expanded private reply union. */
export type ControlWorkspaceCapabilityCommandResult = z.infer<
  typeof ControlWorkspaceCapabilityCommandResultSchema
>;
/** The exact opened database selects which closed result family is admissible. */
export const ControlCapabilityCommandResultSchema = z.union([
  ControlWorkspaceCapabilityCommandResultSchema,
  serverStartedCall,
]);
/** Prepared results become visible only after the existing outer durable acknowledgement. */
export type ControlCapabilityCommandResult = z.infer<typeof ControlCapabilityCommandResultSchema>;

/** Records the exact prepared facts on their native owner, with the original linked-Audit checks. */
function recordControlPermissionDecision(
  db: WorkspaceDb | UserDb | CoreDb,
  decision: z.infer<typeof permissionDecision>,
  workspaceId: string | null = null
): void {
  recordProductPermissionDecisionInDb(
    presentControlFacts({
      ...decision,
      ...(db.scope === 'core'
        ? { coreDb: db, ownerScope: 'server' as const, workspaceId }
        : db.scope === 'user'
          ? { userDb: db, workspaceId: null, ownerScope: 'user' as const }
          : { workspaceDb: db, workspaceId: db.workspaceId, ownerScope: 'workspace' as const }),
      now: new Date(decision.now),
    })
  );
}

/** One Workspace/frame predicate, plus actual Call authority when the observation binds a Call. */
function readControlMcpContext(
  db: WorkspaceDb,
  callId: string | undefined,
  environmentPackage: z.infer<typeof mcpFrame>
) {
  if (environmentPackage.scope.workspaceId !== db.workspaceId)
    throw new WorkerRawOutputAuthorityError();
  const selected = environmentPackage.supply.mcpServers[0]!;
  if (callId === undefined) return { actual: undefined, selected, bound: null };
  const frame = environmentPackage;
  const actual = db.sqlite
    .prepare(`SELECT schema_version, workspace_id, thread_id, turn_id,
      agent_session_id, package_snapshot_id, agent_id, provider_ref, family, operation, capability_id,
      status, completed_at, schema_snapshot_id FROM capability_calls WHERE call_id = ?`)
    .get(callId) as Record<string, unknown> | undefined;
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
  const bound = readTurnMcpToolSchemaSnapshot({ environmentPackage, selected, workspaceDb: db });
  return { actual, selected, bound };
}

/** Exact durable reuse only; the existing drain calls this for its leading ready prefix. */
export function tryControlCapabilityReuse(
  db: WorkspaceDb,
  input: ControlCapabilityCommandInput
): { schemaSnapshotId: string; liveSnapshotId: string } | undefined {
  if (input.kind !== 'mcp-schema') return undefined;
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId)
    throw new WorkerRawOutputAuthorityError();
  const { actual, selected, bound } = readControlMcpContext(
    db,
    input.callId,
    input.environmentPackage
  );
  const { reusedSnapshotId } = prepareMcpToolSchemaSnapshot({
    ...input,
    capabilityCallId: input.callId,
    serverId: selected.id,
    source: 'live',
    workspaceDb: db,
  });
  if (reusedSnapshotId === null) return undefined;
  const schemaSnapshotId = bound?.schemaSnapshotId ?? reusedSnapshotId;
  if (actual && actual.schema_snapshot_id !== schemaSnapshotId) return undefined;
  return { schemaSnapshotId, liveSnapshotId: reusedSnapshotId };
}

/**
 * Applies complete ledger tuples on the supplied native transaction.
 * The native dispatcher supplies its existing synchronous Goal owner on this same connection;
 * no Main callback or function crosses the wire.
 */
export function applyControlCapabilityCommand(
  db: WorkspaceDb,
  input: ControlCapabilityCommandInput,
  advanceGoalRevision: (goalId: string) => void
): ControlCapabilityCommandResult {
  if (isServerCapabilityCommand(input) || isUserPolicyCommand(input))
    throw new WorkerRawOutputAuthorityError();
  if (input.kind === 'checkpoint') return applyControlCheckpointCommand(db, input.input);
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new WorkerRawOutputAuthorityError();
  if (input.kind === 'mcp-schema') {
    const callId = input.callId;
    const { selected, bound } = readControlMcpContext(db, callId, input.environmentPackage);
    const liveSnapshotId = recordMcpToolSchemaSnapshotInDb({
      ...input,
      capabilityCallId: callId,
      serverId: selected.id,
      source: 'live',
      workspaceDb: db,
      ...(callId === undefined
        ? {}
        : {
            onRecorded: (liveId: string) => {
              if (selected.schemaPolicy === 'pinned' && selected.pinnedSchemaSnapshotId !== liveId)
                return;
              stampCapabilityCallSchemaSnapshotInDb({
                callId,
                schemaSnapshotId: bound?.schemaSnapshotId ?? liveId,
                workspaceDb: db,
              });
            },
          }),
    });
    return { schemaSnapshotId: bound?.schemaSnapshotId ?? liveSnapshotId, liveSnapshotId };
  }
  if (input.kind === 'admit') {
    const captured =
      input.capturedSource &&
      prepareCapturedCapabilityAdmission(
        db,
        input.capturedSource,
        input.context.requestId,
        new Date(input.now)
      );
    // Apply the wire defaults to retained facts before comparing the complete context.
    if (
      captured &&
      (input.callId !== captured.callId ||
        !isDeepStrictEqual(input.context, admitCommand.shape.context.parse(captured.context)))
    )
      throw new WorkerRawOutputAuthorityError();
    const requestId = normalizeCapabilityRequestId(input.context.requestId);
    if (
      input.singleUseRequestId &&
      requestId &&
      hasCapabilityCallRequestId(db, db.workspaceId, requestId)
    )
      throw new OperationError(
        'capability_request_reused',
        'Capability request identity was already used.',
        400
      );
    let call = startCapabilityCallInDb(
      presentControlFacts({
        ...input.context,
        workspaceDb: db,
        workspaceId: db.workspaceId,
        callId: input.callId,
        auditLineage: input.auditLineage,
        now: new Date(input.now),
      })
    );
    if (!call.inserted) return call;
    if (input.freshSystemPromptDigest !== undefined)
      persistLlmCapabilityCallSystemPromptDigestInDb({
        workspaceDb: db,
        callId: call.id,
        systemPromptDigest: input.freshSystemPromptDigest,
      });
    if (input.initializeRaw) {
      const { threadId, turnId } = call.context;
      if (!threadId || !turnId) throw new WorkerRawOutputAuthorityError();
      initializeWorkerRawOutput(db, call, { workspaceId: db.workspaceId, threadId, turnId });
    }
    // Only the original post-admission callback is caught. Start/proof/ACK failures stay refusals.
    try {
      const decision = captured?.decision ?? input.decision;
      if (decision) {
        if (decision.contextSummary.capabilityCallId !== call.id)
          throw new WorkerRawOutputAuthorityError();
        recordControlPermissionDecision(db, decision);
      }
      if (input.warmMcpSchema) {
        if (decision?.result !== 'allow') throw new WorkerRawOutputAuthorityError();
        const { bound } = readControlMcpContext(db, call.id, input.warmMcpSchema);
        if (bound) {
          stampCapabilityCallSchemaSnapshotInDb({
            workspaceDb: db,
            callId: call.id,
            schemaSnapshotId: bound.schemaSnapshotId,
          });
          // Return the actual stamp proved by this admission, not its pre-stamp context.
          call = {
            ...call,
            context: { ...call.context, schemaSnapshotId: bound.schemaSnapshotId },
          };
        }
      }
    } catch (error) {
      // Integrity failures must reach the native handle fence, even after actual admission.
      if (
        error instanceof Database.SqliteError &&
        (error.code === 'SQLITE_NOTADB' || error.code.startsWith('SQLITE_CORRUPT'))
      )
        throw error;
      if (!input.retainMcpAdmissionFailure) throw error;
      return {
        ...call,
        admissionFailure: projectControlCapabilityFailure(error) ?? { kind: 'unknown' },
      };
    }
    const terminal = captured?.refusal
      ? {
          status: 'failed' as const,
          errorCode: captured.refusal,
          now: input.finish?.now ?? input.now,
        }
      : undefined;
    if (terminal)
      finishCapabilityCallInDb(
        presentControlFacts({
          ...terminal,
          workspaceDb: db,
          callId: call.id,
          now: new Date(terminal.now),
        })
      );
    return captured?.refusal ? { ...call, refusal: captured.refusal } : call;
  }
  if (input.kind === 'participant-audit') {
    const { event } = input;
    if (event.workspaceId !== db.workspaceId) throw new WorkerRawOutputAuthorityError();
    recordWorkspaceAuditEvent(
      presentControlFacts({
        ...event,
        workspaceDb: db,
        workspaceId: db.workspaceId,
        auditEventId: event.id,
        now: new Date(event.createdAt),
        occurredAt: new Date(event.occurredAt),
      })
    );
    return null;
  }
  if (input.kind === 'attribution') {
    if (input.workerCache)
      writeCapabilityCallCacheInDb({
        ...input.workerCache,
        workspaceDb: db,
        callId: input.callId,
      });
    if (input.systemPromptDigest)
      persistLlmCapabilityCallSystemPromptDigestInDb({
        workspaceDb: db,
        callId: input.callId,
        systemPromptDigest: input.systemPromptDigest,
      });
    if (input.schemaSnapshotId)
      stampCapabilityCallSchemaSnapshotInDb({
        workspaceDb: db,
        callId: input.callId,
        schemaSnapshotId: input.schemaSnapshotId,
      });
    return input.routeLineage
      ? writeGatewayRouteLineageInDb(
          presentControlFacts({
            ...input.routeLineage,
            workspaceDb: db,
            call: { id: input.callId },
          })
        )
      : null;
  }
  if (input.kind === 'permission') {
    recordControlPermissionDecision(db, input.decision);
    return null;
  }
  if (input.kind === 'finish' || input.kind === 'usage-finish') {
    if (input.kind === 'usage-finish' && input.call.context.workspaceId !== db.workspaceId)
      throw new WorkerRawOutputAuthorityError();
    if (input.kind === 'usage-finish' && input.decision) {
      const actual = db.sqlite
        .prepare(
          'SELECT schema_version, workspace_id, family, operation, completed_at FROM capability_calls WHERE call_id = ?'
        )
        .get(input.call.id) as Record<string, unknown> | undefined;
      if (
        !actual ||
        actual.workspace_id !== db.workspaceId ||
        actual.family !== 'mcp' ||
        actual.operation !== 'mcp.call-tool'
      )
        throw new WorkerRawOutputAuthorityError();
      readRetainedV1({ schemaVersion: actual.schema_version }, () => undefined);
      // A repeated finish cannot append new refusal evidence to an already settled Call.
      if (actual.completed_at !== null) return null;
      recordControlPermissionDecision(db, input.decision);
    }
    let ids: string[] | null = null;
    if (input.kind === 'usage-finish' && input.usage) {
      try {
        ids = recordUsageInDb(
          presentControlFacts({
            ...input.usage,
            workspaceDb: db,
            call: { ...input.call, context: presentControlFacts(input.call.context) },
            records: input.usage.records.map(presentControlFacts),
            now: new Date(input.usage.now),
          })
        );
      } catch (cause) {
        // Preserve the shared retained owner refusal before the generic usage failure projection.
        if (cause instanceof TypeError && cause.message === 'Unsupported retained record format.')
          throw cause;
        // The command savepoint rolls back the entire tuple; transport preserves lost-ACK uncertainty.
        throw new OperationError(
          'usage_record_failed',
          'Capability usage could not be recorded.',
          500,
          { cause }
        );
      }
    }
    if (
      input.finish?.goalEscalationId &&
      (input.finish.status !== 'denied' || input.finish.errorCode !== 'policy_requires_escalation')
    )
      throw new WorkerRawOutputAuthorityError();
    const callId = input.kind === 'finish' ? input.callId : input.call.id;
    if (input.finish?.clearItem) clearCapabilityCallItemInDb(db, callId);
    if (input.finish)
      finishCapabilityCallInDb(
        presentControlFacts({
          ...input.finish,
          workspaceDb: db,
          callId,
          now: new Date(input.finish.now),
        })
      );
    if (input.finish?.goalEscalationId) advanceGoalRevision(input.finish.goalEscalationId);
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
