import {
  ActorRefSchema,
  ArtifactIdSchema,
  AuditEventSchema,
  KnowledgeOwnerScopeSchema,
  RequestIdSchema,
  ResourceCandidateIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { CommandRequestName, CommandRequestResponse } from '../lib/store.js';
import { ControlPendingCommandInputSchema } from '../runtime/pending-request-codecs.js';
import { TaskSteerReceiptMetadataSchema } from '../runtime/task-steer-receipt.js';
import {
  CONTROL_PRODUCT_LIMITS,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
} from './control-store-product-records.js';
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
        steerMetadata: z.lazy(() => TaskSteerReceiptMetadataSchema).optional(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

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
  .superRefine((input, context) => {
    const steer = input.receipt.command === 'task.steer';
    if (
      steer
        ? input.products.length !== 0 ||
          input.entries.length !== 0 ||
          (input.pending?.length ?? 0) !== 0 ||
          !input.receipt.response.steerMetadata ||
          input.receipt.response.conversationMetadata !== undefined
        : input.products.length === 0 || input.receipt.response.steerMetadata !== undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Only task.steer publishes a receipt without a product mutation.',
      });
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

/** Complete native inputs share the same physical admission owner. */
export const ControlAdmissionInputSchema = z.union([
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
