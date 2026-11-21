import {
  type AutomationRecord,
  AutomationRecordSchema,
  CreateAutomationRequestSchema,
  MaterializedWorkspaceRootSchema,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import {
  AccessTokenIdSchema,
  ActorRefSchema,
  ApprovalRequestIdSchema,
  ArtifactIdSchema,
  AuditEventIdSchema,
  AuditEventSchema,
  AuthenticationSessionIdSchema,
  canonicalIdentifierName,
  KnowledgeOwnerScopeSchema,
  ReasoningEffortSchema,
  RequestIdSchema,
  ResourceCandidateIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  UserInputRequestIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { CommandRequestName, CommandRequestResponse } from '../lib/store.js';
import {
  StoredGoalCardV1Schema,
  StoredGoalPlanVersionV1Schema,
  StoredGoalV1Schema,
} from '../runtime/goal-retained-v1.js';
import { ControlPendingCommandInputSchema } from '../runtime/pending-request-codecs.js';
import type { CoreSchedulerQueueEntry } from '../scheduler-records.js';
import {
  CONTROL_PRODUCT_LIMITS,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
} from './control-store-product-records.js';
import type { RecurringOccurrence } from './recurring-records.js';
import {
  StoredRecurringAttemptCodeV1Schema,
  StoredRecurringOccurrenceV1Schema,
} from './recurring-retained-v1.js';
import type { SchedulerAdmissionDenialReason } from './schema/index.js';

const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const channelEventCoordinate = z.string().min(1).max(256);
const channelEventTuple = z.tuple([
  channelEventCoordinate,
  channelEventCoordinate,
  channelEventCoordinate,
]);

/** Permanent event identity has no actor or selected target. */
export const ChannelInboundKeySchema = z.strictObject({
  deploymentId: z.string().min(1).max(128),
  sourceOwner: z.literal('communication'),
  verb: z.literal('channel.inbound'),
  occurrenceKey: z
    .string()
    .max(2048)
    .refine((key) => {
      try {
        return canonicalIdentifierName(channelEventTuple.parse(JSON.parse(key))) === key;
      } catch {
        return false;
      }
    }),
});

export const ChannelInboundEnvelopeSchema = ChannelInboundKeySchema.extend({
  requestId: z.uuid(),
  inputDigest: contentDigest,
});

export const ChannelInboundOriginSchema = z.strictObject({
  envelope: ChannelInboundEnvelopeSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  pendingRequestId: z.union([ApprovalRequestIdSchema, UserInputRequestIdSchema]),
  userId: UserIdSchema,
  bindingRevision: RequestIdSchema,
  disclosureDigest: contentDigest,
  operation: z.enum(['question.answer', 'approval.respond']),
});

export const ChannelInboundOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('handled') }),
  z.strictObject({ kind: z.literal('pending-decision'), decisionRef: contentDigest }),
]);

/** Native relay intent from the admitted communication owner. */
export const PairingAuditIntentSchema = z.strictObject({
  deploymentId: z.string().min(1),
  sourceOwner: z.literal('communication'),
  verb: z.literal('relay-pairing-audit'),
  occurrenceKey: AuditEventIdSchema,
  requestId: z.uuid(),
  target: z.strictObject({ eventId: AuditEventIdSchema }),
  expectedGeneration: RequestIdSchema,
  inputDigest: contentDigest,
});

/** The original pairing producer's redacted event attributes, independent of current authority. */
export const PairingAuditFactsSchema = z.strictObject({
  channelKind: channelEventCoordinate,
  userId: UserIdSchema,
  bindingRevision: RequestIdSchema,
  administratorAtEvent: z.boolean(),
});

/** Five noncredential Server MCP commands retain their original Core receipt partition. */
export const SERVER_MCP_CORE_COMMAND_RECEIPTS = [
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
] as const;
/** These three original standalone Catalog receipts have separate record and maintenance commits. */
export const CATALOG_COMMAND_RECEIPTS = [
  'catalog.skill-candidate-submit',
  'catalog.skill-candidate-decide',
  'catalog.skill-candidate-withdraw',
] as const;

/** Current scoped producers only; declared but inactive Notebook operations are not activated here. */
export const SCOPED_NOTEBOOK_USER_RECEIPTS = [
  'knowledge.notebook.create',
  'knowledge.notebook.update',
  'knowledge.notebook.restore',
  'knowledge.notebook.delete',
  'knowledge.proposal.decide',
  'knowledge.source.register',
  'knowledge.maintain',
  'knowledge.tell',
] as const satisfies readonly CommandRequestName[];
/** Server has no current scoped restore/delete producer. */
export const SCOPED_NOTEBOOK_SERVER_RECEIPTS = [
  'knowledge.notebook.update',
  'knowledge.proposal.decide',
  'knowledge.source.register',
] as const satisfies readonly CommandRequestName[];

/** These newly moved User producers originally committed the receipt before separate maintenance. */
export const SCOPED_NOTEBOOK_SEPARATE_USER_RECEIPTS = [
  'knowledge.notebook.create',
  'knowledge.source.register',
  'knowledge.maintain',
  'knowledge.tell',
] as const satisfies readonly CommandRequestName[];
/** Server Source capture retains the same original two-autocommit receipt boundary. */
export const SCOPED_NOTEBOOK_SEPARATE_SERVER_RECEIPTS = ['knowledge.source.register'] as const;

/** Selects only original standalone receipt producers; older native Notebook tuples remain atomic. */
export function isSeparateScopedNotebookReceipt(scope: 'core' | 'user', command: string): boolean {
  return (
    scope === 'user'
      ? SCOPED_NOTEBOOK_SEPARATE_USER_RECEIPTS
      : SCOPED_NOTEBOOK_SEPARATE_SERVER_RECEIPTS
  ).some((name) => name === command);
}

/** Exact prepared operation families; B2 must exclude these from legacy receipt insert/prune paths before activation. */
export const CONTROL_ADMISSION_COMMANDS = [
  'thread.create',
  'thread.update',
  'thread.archive',
  'turn.start',
  'task.start',
  'task.steer',
  'turn.input.submit',
  'conversation.submit',
  'turn.interrupt',
] as const;

/** Original receipt facts; expiry policy remains with the existing command producer, not another ledger. */
const ReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum(CONTROL_ADMISSION_COMMANDS),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        conversationMetadata: z.unknown().optional(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Original Coordinator citation; its six predicates are decided only inside the active reservation. */
export const GoalTaskCitationSchema = z
  .object({
    goalId: StoredGoalV1Schema.shape.goalId,
    cardId: StoredGoalCardV1Schema.shape.cardId,
    planVersionId: StoredGoalPlanVersionV1Schema.shape.planVersionId,
    cardRevision: StoredGoalCardV1Schema.shape.revision,
    intentRevision: StoredGoalV1Schema.shape.intentRevision,
    withinCurrentIntent: z.boolean(),
    withinPermittedAdjustments: z.boolean(),
    rationale: z.string(),
  })
  .strict();
export type GoalTaskCitation = Readonly<z.infer<typeof GoalTaskCitationSchema>>;

/** Closed native tuple; large Item/event bodies have synchronized immutable references instead of inline SQL payloads. */
export const ControlAdmissionSchema = z
  .object({
    receipt: ReceiptSchema,
    products: z.lazy(() =>
      z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries)
    ),
    entries: z.lazy(() => z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries)),
    pending: z
      .lazy(() => z.array(ControlPendingCommandInputSchema).max(CONTROL_PRODUCT_LIMITS.entries))
      .optional(),
    audit: AuditEventSchema.extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .strict()
  .refine((input) => input.products.length + input.entries.length > 0, {
    message: 'Admission requires an original product or Item/event mutation.',
  });

export type ControlAdmission = z.infer<typeof ControlAdmissionSchema>;

/** Original request facts from runIdempotentCommand, not a second request or receipt owner. */
const MaintenanceReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'knowledge.maintain',
      'knowledge.tell',
      'knowledge.server.maintain',
      'knowledge.server.tell',
    ]),
    requestId: RequestIdSchema,
    scope: z.union([
      z.object({ actorId: z.string().min(1), workspaceId: z.string().min(1) }).strict(),
      z.object({ actorId: z.string().min(1), coreId: z.literal('server') }).strict(),
    ]),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('turn'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Closed native admission; model content cannot select a database, execution callback, or immutable byte body. */
export const ControlKnowledgeAdmissionInputSchema = z
  .object({
    purpose: z.enum(['maintenance', 'query']),
    ownerScope: KnowledgeOwnerScopeSchema,
    actor: ActorRefSchema,
    requestId: RequestIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    startedAt: z.string().datetime(),
    trigger: z.enum(['request', 'schedule']),
    instructions: z.string().max(64 * 1024),
    captureCoverage: z
      .object({ scope: z.enum(['server', 'workspace', 'task']), value: z.enum(['off', 'on']) })
      .strict(),
    outputThreadId: ThreadIdSchema.optional(),
    receipt: MaintenanceReceiptSchema.optional(),
  })
  .strict();

/** Structured-clone input to the existing control worker; authority is admitted before dispatch. */
export type ControlKnowledgeAdmissionInput = z.infer<typeof ControlKnowledgeAdmissionInputSchema>;

/** Only acknowledged product identities leave SQL; busy admission has no permission to invoke a model. */
export const ControlKnowledgeAdmissionResultSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  busy: z.boolean(),
  replayed: z.boolean(),
});

/** A complete acknowledged admission result; consumers ignore additive descriptive fields. */
export type ControlKnowledgeAdmissionResult = z.infer<typeof ControlKnowledgeAdmissionResultSchema>;

const receiptBase = {
  key: z.string().min(1),
  requestId: RequestIdSchema,
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  response: z.strictObject({ kind: z.literal('workspace'), id: WorkspaceIdSchema }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
const createReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('workspace.create'),
  scope: z.strictObject({ userId: UserIdSchema }),
});
const updateReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('workspace.update'),
  scope: z.strictObject({ workspaceId: WorkspaceIdSchema }),
});

/** Catalog effects retain their original non-secret entry pointer and exact physical scope. */
const serverMcpReceipt = z.strictObject({
  ...receiptBase,
  command: z.enum(SERVER_MCP_CORE_COMMAND_RECEIPTS),
  scope: z.strictObject({ actorId: UserIdSchema, coreId: z.literal('server') }),
  response: z.strictObject({ kind: z.literal('catalog_mcp'), id: z.string().min(1) }),
});
const sharedMcpReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('catalog.shared-mcp-set-disabled'),
  scope: z.strictObject({ actorId: UserIdSchema, workspaceId: WorkspaceIdSchema }),
  response: z.strictObject({ kind: z.literal('catalog_mcp'), id: z.string().min(1) }),
});

/** Original outcome Artifacts and synchronization Reviews keep their exact distinct scopes and pointers. */
const configurationReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('administration.configuration.apply'),
  scope: z.strictObject({
    actorId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
  }),
  response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
});
const syncReviewReceipt = z.strictObject({
  ...receiptBase,
  command: z.literal('workspace_sync.review.decide'),
  // Synchronization retains its original opaque request and Review identities.
  requestId: z.string().min(1),
  scope: z.strictObject({ workspaceId: WorkspaceIdSchema, reviewId: z.string().min(1) }),
  response: z.strictObject({ kind: z.literal('workspace_sync_review'), id: z.string().min(1) }),
});

/** The three original environment commands keep their exact Thread or storage-reference provenance. */
const environmentReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    command: z.enum(['worker_environment.prepare', 'worker_environment.activate']),
    scope: z.strictObject({
      actorId: UserIdSchema,
      threadId: ThreadIdSchema,
      workspaceId: WorkspaceIdSchema,
    }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    command: z.literal('worker_environment.purge'),
    scope: z.strictObject({
      actorId: UserIdSchema,
      storageRef: WorkerStorageTargetIdSchema,
      workspaceId: WorkspaceIdSchema,
    }),
    response: z.strictObject({
      kind: z.literal('worker_environment'),
      id: WorkerStorageTargetIdSchema,
    }),
  }),
]);

/** Existing Skill management receipts retain their original import tuple or Workspace pointer. */
const skillReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    command: z.literal('catalog.skill-import'),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: UserIdSchema }),
    response: z.strictObject({
      kind: z.literal('skill_version'),
      id: z
        .string()
        .min(1)
        .refine((value) => {
          try {
            const tuple: unknown = JSON.parse(value);
            return (
              Array.isArray(tuple) &&
              tuple.length === 2 &&
              typeof tuple[0] === 'string' &&
              tuple[0].length > 0 &&
              typeof tuple[1] === 'string' &&
              /^sha256:[a-f0-9]{64}$/.test(tuple[1]) &&
              JSON.stringify(tuple) === value
            );
          } catch {
            return false;
          }
        }),
    }),
  }),
  z.strictObject({
    ...receiptBase,
    command: z.enum([
      'catalog.skill-select',
      'catalog.skill-pin',
      'catalog.skill-remove',
      'catalog.skill-purge',
    ]),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: UserIdSchema }),
    response: z.strictObject({ kind: z.literal('skill_catalog'), id: WorkspaceIdSchema }),
  }),
]);

/** Declarative Light App catalog receipts retain the exact definition digest or Workspace pointer and original acting ActorRef identity. */
const lightAppReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    command: z.literal('catalog.light-app-import'),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: z.string().min(1) }),
    response: z.strictObject({
      kind: z.literal('light_app_definition'),
      id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
  }),
  z.strictObject({
    ...receiptBase,
    command: z.enum([
      'catalog.light-app-history-import',
      'catalog.light-app-select',
      'catalog.light-app-pin',
    ]),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, actorId: z.string().min(1) }),
    response: z.strictObject({ kind: z.literal('light_app_catalog'), id: WorkspaceIdSchema }),
  }),
]);

/** Four original Artifact receipt producers preserve their exact actor, Thread and target selectors. */
const artifactReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.literal('artifact.import'),
    scope: z.strictObject({ actorId: UserIdSchema, workspaceId: WorkspaceIdSchema }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.enum(['artifact.version-commit', 'artifact.version-file-commit']),
    scope: z.strictObject({
      actorId: UserIdSchema,
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      artifactId: ArtifactIdSchema,
    }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
  z.strictObject({
    ...receiptBase,
    // App Artifact commands retain opaque public identities, including non-UUID values.
    requestId: z.string().min(1),
    command: z.literal('artifact.introduce'),
    scope: z.strictObject({ workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema }),
    response: z.strictObject({ kind: z.literal('artifact'), id: ArtifactIdSchema }),
  }),
]);

const catalogReceipt = z.strictObject({
  key: z.string().min(1),
  command: z.enum(CATALOG_COMMAND_RECEIPTS),
  requestId: RequestIdSchema,
  scope: z.strictObject({
    workspaceId: WorkspaceIdSchema,
    actorId: UserIdSchema,
    candidateId: ResourceCandidateIdSchema.optional(),
  }),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  response: z.strictObject({ kind: z.literal('skill_candidate'), id: ResourceCandidateIdSchema }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const notebookReceiptBase = {
  key: z.string().min(1),
  requestId: RequestIdSchema,
  scope: z.record(z.string(), z.string()),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
const notebookReceipt = z.discriminatedUnion('command', [
  z.strictObject({
    ...notebookReceiptBase,
    command: z.enum([
      'knowledge.notebook.create',
      'knowledge.notebook.update',
      'knowledge.notebook.restore',
      'knowledge.notebook.delete',
      'knowledge.proposal.decide',
    ]),
    response: z.strictObject({
      kind: z.literal('knowledge_notebook_revision'),
      id: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...notebookReceiptBase,
    command: z.literal('knowledge.source.register'),
    response: z.strictObject({ kind: z.literal('knowledge_source'), id: z.string().min(1) }),
  }),
  z.strictObject({
    ...notebookReceiptBase,
    command: z.enum(['knowledge.maintain', 'knowledge.tell']),
    response: z.strictObject({ kind: z.literal('turn'), id: z.string().min(1) }),
  }),
]);

/** Closed existing post-effect pointers, never an arbitrary command-log write. */
export const CommandReceiptSchema = z.union([
  createReceipt,
  updateReceipt,
  serverMcpReceipt,
  sharedMcpReceipt,
  configurationReceipt,
  syncReviewReceipt,
  environmentReceipt,
  skillReceipt,
  lightAppReceipt,
  artifactReceipt,
  catalogReceipt,
  notebookReceipt,
]);
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
/** The record ACK precedes a separately sampled and committed maintenance stage. */
export const ControlCommandReceiptAdmissionSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    kind: z.literal('command-receipt'),
    stage: z.literal('record'),
    receipt: CommandReceiptSchema,
  }),
  z.strictObject({
    kind: z.literal('command-receipt'),
    stage: z.literal('maintenance'),
    scope: z.union([
      z.strictObject({ coreId: z.literal('server') }),
      z.strictObject({ workspaceId: WorkspaceIdSchema }),
      z.strictObject({ userId: UserIdSchema }),
    ]),
    referenceTime: z.string().datetime(),
  }),
]);
export type ControlCommandReceiptAdmission = z.infer<typeof ControlCommandReceiptAdmissionSchema>;

/** Exact original authentication credential, never a replacement principal or secret. */
export const SchedulerCredentialRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), id: AccessTokenIdSchema }).strict(),
  z.object({ kind: z.literal('session'), id: AuthenticationSessionIdSchema }).strict(),
]);
/** Original scheduler transition failure, shared without importing a publisher. */
export class SchedulerAdmissionTransitionError extends Error {
  /** Preserves the original definite admission refusal reason. */
  constructor(
    message: string,
    readonly reason: SchedulerAdmissionDenialReason = 'invalid-request'
  ) {
    super(message);
  }
}
/** Original recurring record absence. */
export class AutomationRecordNotFoundError extends Error {}
/** Original recurring revision or lifecycle refusal. */
export class AutomationMutationError extends Error {}
/** The Workspace identity and exact owned input digest are the queue's only input facts. */
export const WorkspaceQueueInputRefSchema = z.strictObject({
  owner: z.strictObject({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }),
  inputId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Original text crosses only the owning Workspace's stage operation. */
export const WorkspaceQueueInputWriteSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  originalInvocationId: z.string().min(1),
  input: WorkspaceQueueInputRefSchema,
  text: z.string(),
});
export type WorkspaceQueueInputWrite = z.infer<typeof WorkspaceQueueInputWriteSchema>;

/** Existing prepared selections; no effect or callback crosses this carrier. */
export const RecurringAdmissionPayloadSchema = z.object({
  backendId: z.string().min(1),
  requestedAgentId: z.string().min(1),
  profileRef: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  workspaceCwd: z.string().min(1).nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  reasoningEffort: ReasoningEffortSchema.optional(),
  requiredFeatures: z.array(z.never()).optional(),
});
const preparation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), payload: RecurringAdmissionPayloadSchema }).strict(),
  z
    .object({
      kind: z.literal('failure'),
      code: StoredRecurringAttemptCodeV1Schema.exclude(['accepted']),
      payload: RecurringAdmissionPayloadSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('recovery_required') }).strict(),
]);
const storageChoice = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fresh'),
      goalId: z.string().nullable(),
      taskId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('selected'),
      expectedRevision: z.number().int().positive().safe(),
      goalId: z.string().nullable(),
      taskId: z.string().nullable(),
      purpose: z.enum(['work', 'independent-review']),
      storageRef: z.string(),
      reuseWorkSlotRef: z.string().optional(),
      adjudicatedThreadIds: z.array(z.string()).readonly().optional(),
    })
    .strict(),
]);
/** Exact queue facts; the retained domain parser still owns identity and input hashing. */
const SchedulerCreateSchema = z
  .object({
    backendId: z.string().min(1),
    queueEntryId: z.string().min(1),
    requestId: z.string().nullable().optional(),
    triggerActor: ActorRefSchema,
    serverAdminTokenId: z.string().nullable().optional(),
    credentialRef: SchedulerCredentialRefSchema.nullable().optional(),
    workspaceCwd: z.string().nullable().optional(),
    workspaceRoots: z.array(MaterializedWorkspaceRootSchema).optional(),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    inputRef: WorkspaceQueueInputRefSchema,
    workerStorageChoice: storageChoice.nullable().optional(),
    requestedAgentId: z.string().min(1),
    profileRef: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    timestamp: z.string().datetime().optional(),
  })
  .strict();
const actor = z
  .object({
    userId: z.string().min(1),
    kind: z.enum(['local', 'session', 'token']),
    sessionId: z.string().optional(),
    tokenId: z.string().optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(z.string()).optional(),
    adminTokenId: z.string().optional(),
  })
  .strict();
const lineage = z
  .object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    agentSessionId: z.string().min(1),
    packageSnapshotId: z.string().min(1),
  })
  .strict();
/** The authenticated source facts already held by an external poll operation. */
export const ExternalSourceSchema = z
  .object({
    scheduleId: z.string().min(1),
    eventKey: z.string().min(1).max(1024),
    source: z
      .object({
        workspaceId: z.string().min(1),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        agentSessionId: z.string().min(1),
        packageSnapshotId: z.string().min(1),
        triggerActor: ActorRefSchema,
      })
      .strict(),
  })
  .strict();
/** Only the exact existing definition mutation crosses the private family boundary. */
const AutomationDefinitionMutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      id: z.string().min(1),
      input: CreateAutomationRequestSchema.strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      id: z.string().min(1),
      input: UpdateAutomationRequestSchema.strict(),
    })
    .strict(),
  z.object({ action: z.literal('delete'), id: z.string().min(1) }).strict(),
]);
/** Typed existing create, edit, lifecycle and tombstone input; no SQL or callback. */
export type AutomationDefinitionMutation = z.infer<typeof AutomationDefinitionMutationSchema>;
/** One closed Core queue/conditional-source family; each member commits only its original tuple. */
export const CoreSchedulerInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('definition'),
      actor: actor.optional(),
      workspaceId: z.string().min(1),
      userId: z.string().min(1),
      mutation: AutomationDefinitionMutationSchema,
      timestamp: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('create'),
      entry: SchedulerCreateSchema,
      external: ExternalSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('deny'),
      queueEntryId: z.string().min(1),
      denialReason: z.enum(['queue-full', 'authority-denied', 'invalid-request']),
    })
    .strict(),
  z
    .object({
      mode: z.literal('retry'),
      queueEntryId: z.string().min(1),
      workspaceId: z.string().min(1),
      actor: z.union([actor, ActorRefSchema]),
      lineage: lineage.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('cancel'),
      queueEntryId: z.string().min(1),
      workspaceId: z.string().min(1),
      actor: z.union([actor, ActorRefSchema]).optional(),
      lineage: lineage.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('recurring-publication'),
      queueEntryId: z.string().min(1),
      action: z.enum(['defer-busy', 'consume-busy']),
    })
    .strict(),
  z
    .object({
      mode: z.literal('recurring-attempt'),
      occurrenceId: z.string().min(1),
      definitionRevision: z.number().int().positive(),
      preparation,
      current: preparation.optional(),
      inputRef: WorkspaceQueueInputRefSchema.optional(),
      timestamp: z.string().datetime(),
    })
    .strict(),
]);
/** Existing binary byte account carries uncapped domain text without enlarging the metadata envelope. */
export const CoreSchedulerWireSchema = z
  .object({ byteLength: z.number().int().positive().safe(), turnId: z.string().min(1).nullable() })
  .strict();
/** Exact scheduler binary header; decoding still uses the one domain schema. */
export type CoreSchedulerWire = z.infer<typeof CoreSchedulerWireSchema>;
/** Typed request on the existing FIFO. */
export type CoreSchedulerInput = z.infer<typeof CoreSchedulerInputSchema>;
/** Main finishes the existing injected clock only after native open. */
export type CoreSchedulerDraft =
  | CoreSchedulerInput
  | Omit<Extract<CoreSchedulerInput, { mode: 'recurring-attempt' | 'definition' }>, 'timestamp'>;
const entry = SchedulerCreateSchema.omit({ timestamp: true }).extend({
  requestId: z.string().nullable(),
  serverAdminTokenId: z.string().nullable(),
  credentialRef: SchedulerCredentialRefSchema.nullable(),
  workspaceCwd: z.string().nullable(),
  workspaceRoots: z.array(MaterializedWorkspaceRootSchema),
  workerStorageChoice: storageChoice.nullable(),
  profileRef: z.string().nullable(),
  modelId: z.string().nullable(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  enqueuedAt: z.string(),
  status: z.enum(['queued', 'admitted', 'denied', 'cancelled', 'expired']),
  denialReason: z.enum(['queue-full', 'authority-denied', 'invalid-request']).nullable(),
});
const external = z
  .object({
    scheduleId: z.string(),
    eventKey: z.string(),
    sourceTurnId: z.string(),
    queueEntryId: z.string(),
  })
  .strict();
/** Complete native results; no post-ACK result reread or reply reservation. */
export const CoreSchedulerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('definition'), record: AutomationRecordSchema.nullable() }).strict(),
  z.object({ kind: z.literal('queue'), entry, external: external.optional() }).strict(),
  z
    .object({
      kind: z.literal('occurrence'),
      occurrence: StoredRecurringOccurrenceV1Schema.nullable(),
    })
    .strict(),
]);
/** Complete success after the covering FULL commit. */
export type CoreSchedulerResult =
  | {
      kind: 'queue';
      entry: CoreSchedulerQueueEntry;
      external?: {
        scheduleId: string;
        eventKey: string;
        sourceTurnId: string;
        queueEntryId: string;
      };
    }
  | { kind: 'occurrence'; occurrence: RecurringOccurrence | null }
  | { kind: 'definition'; record: AutomationRecord | null };

/** Original transition metadata, never SQLite diagnostics or statement bindings. */
export const CoreSchedulerRefusalSchema = z.union([
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('turn'),
      code: z.literal('automation_conflict'),
      message: z.string(),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('turn'),
      code: z.enum(['automation_update_failed', 'automation_delete_failed']),
      message: z.string(),
      status: z.literal(404),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('decoder'),
      code: z.literal('invalid_request'),
      message: z.literal('The record could not be processed.'),
      status: z.literal(400),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('turn'),
      code: z.literal('thread_busy'),
      message: z.literal('Thread already has a nonterminal Turn.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('authority'),
      code: z.literal('workspace_access_denied'),
      message: z.literal('Workspace access denied.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('transition'),
      code: z.enum(['queue-full', 'authority-denied', 'invalid-request']),
      status: z.literal(400),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('turn'),
      code: z.literal('external_event_denied'),
      message: z.literal('Scheduled poll admission was denied.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      kind: z.literal('turn'),
      code: z.literal('recovery_required'),
      message: z.enum([
        'Accepted external event work requires inspection.',
        'Original Workspace input is unavailable.',
      ]),
      status: z.literal(409),
    })
    .strict(),
]);
/** Only declared scheduler owner refusals cross the private boundary. */
export type CoreSchedulerRefusal = z.infer<typeof CoreSchedulerRefusalSchema>;

/** Complete native inputs share the same physical admission owner. */
export const ControlAdmissionInputSchema = z.union([
  z.strictObject({ kind: z.literal('scheduler-work'), input: CoreSchedulerInputSchema }),
  ControlCommandReceiptAdmissionSchema,
  ControlAdmissionSchema,
  z.strictObject({
    kind: z.literal('knowledge-work'),
    input: ControlKnowledgeAdmissionInputSchema,
  }),
]);
export type ControlAdmissionInput = z.infer<typeof ControlAdmissionInputSchema>;

/** Original response only; callbacks and caches cannot publish before the worker's outer COMMIT. */
export interface ControlAdmissionResult {
  readonly replayed: boolean;
  readonly response: CommandRequestResponse;
}
