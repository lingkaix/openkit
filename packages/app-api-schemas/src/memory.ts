import {
  KnowledgeSourceIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  KnowledgeSourceSchema,
  RegisterKnowledgeSourceRequestSchema,
} from './knowledge-manager.js';
import {
  KnowledgeNotebookPathSchema,
  UpdateKnowledgeNotebookRequestSchema,
} from './knowledge-notebook.js';
import {
  KnowledgeNotebookDiffRequestSchema,
  KnowledgeNotebookDiffResponseSchema,
  KnowledgeNotebookHistoryRequestSchema,
  KnowledgeNotebookHistoryResponseSchema,
  RestoreKnowledgeNotebookRequestSchema,
} from './knowledge-notebook-history.js';
import type { OperationDefinition } from './operation-contract.js';

/** User ownership is resolved by current authentication, never selected by a Memory request. */
export const MemoryOwnerSchema = z
  .object({ kind: z.literal('user'), userId: UserIdSchema })
  .strict();
const PageIdSchema = z
  .string()
  .refine((id) => KnowledgeNotebookPathSchema.safeParse(`${id}.md`).success);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const PageFactsSchema = z.object({
  id: PageIdSchema,
  path: KnowledgeNotebookPathSchema,
  title: z.string().nullable(),
  sensitivity: z.enum(['public', 'normal', 'internal', 'confidential']),
  digest: DigestSchema,
});

/** Exact existing User notebook publication and scoped receipt, shared by explicit editing and restoration. */
export const MemoryPublicationSchema = z.object({
  outcome: z.literal('published'),
  ownerScope: MemoryOwnerSchema,
  baseRevision: z.string().min(1).nullable(),
  notebookRevision: z.string().min(1),
  changedPageIds: z.array(PageIdSchema).max(256),
  receiptRef: z
    .object({
      operation: z.enum([
        'knowledge.create',
        'knowledge.notebook.update',
        'knowledge.notebook.restore',
        'knowledge.delete',
      ]),
      requestId: RequestIdSchema,
      ownerScope: MemoryOwnerSchema,
    })
    .strict(),
});

/** Exact personally authored OKF bytes at one immutable published base. */
export const ChangeMemoryPageRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    baseRevision: z.string().min(1),
    pageId: PageIdSchema,
    content: z.string().refine((text) => new TextEncoder().encode(text).length <= 2 * 1024 * 1024),
    summary: UpdateKnowledgeNotebookRequestSchema.shape.summary,
  })
  .strict();

/** Null base is an explicit first save into a new User scope, never a missing-store recovery request. */
export const CreateMemoryPageRequestSchema = ChangeMemoryPageRequestSchema.extend({
  baseRevision: ChangeMemoryPageRequestSchema.shape.baseRevision.nullable(),
});

/** Server-captured Item confirmation binds exact target bytes to a private person command. */
export const PrepareMemoryForgetRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    workspaceId: WorkspaceIdSchema,
    pageId: PageIdSchema,
    notebookRevision: z.string().min(1),
    digest: DigestSchema,
  })
  .strict();

/** User-owned literal Source metadata uses the existing Source projection without a Workspace owner. */
export const UserMemorySourceSchema = KnowledgeSourceSchema.omit({ workspaceId: true }).extend({
  ownerScope: MemoryOwnerSchema,
  kind: z.literal('document'),
});

/** Explicit literal document intake grants no conversation, URL or file provenance. */
export const RegisterUserMemorySourceRequestSchema = RegisterKnowledgeSourceRequestSchema.pick({
  requestId: true,
  kind: true,
  title: true,
  content: true,
}).extend({ requestId: RequestIdSchema, kind: z.literal('document') });

const credentials = ['local-user', 'user-session', 'deployment-administrator'] as const;
const self = {
  credentials,
  scope: { kind: 'user' },
  target: { kind: 'user' },
  policyOperation: 'api.call',
  binding: 'json',
  returnsOneTimeSecret: false,
  successStatus: 200,
} as const;

/** Explicit self Memory and literal Source management; no Worker, automatic capture or caller-selected owner is admitted. */
export const MEMORY_OPERATION_DEFINITIONS = {
  'memory.source.register': {
    ...self,
    description: 'Capture one exact literal document in the authenticated User Source scope.',
    inputSchema: RegisterUserMemorySourceRequestSchema,
    outputSchema: z.object({ source: UserMemorySourceSchema }),
    mutating: true,
  },
  'memory.source.list': {
    ...self,
    description: 'List explicit User Source metadata under current self authority.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ items: z.array(UserMemorySourceSchema) }),
    mutating: false,
  },
  'memory.source.read': {
    ...self,
    description: 'Read the exact captured bytes of one currently authorized User Source.',
    inputSchema: z.object({ sourceId: KnowledgeSourceIdSchema }).strict(),
    outputSchema: z.object({
      source: UserMemorySourceSchema.extend({ content: z.string() }).nullable(),
    }),
    mutating: false,
  },
  'memory.list': {
    ...self,
    description: 'List current personally authored Memory without disclosing suppressed entries.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      notebookRevision: z.string().min(1),
      pages: z.array(PageFactsSchema),
    }),
    mutating: false,
  },
  'memory.read': {
    ...self,
    description: 'Read one current personally authored Memory page.',
    inputSchema: z.object({ pageId: PageIdSchema }).strict(),
    outputSchema: z.object({
      page: PageFactsSchema.extend({
        notebookRevision: z.string().min(1),
        content: z.string(),
      }).nullable(),
    }),
    mutating: false,
  },
  'memory.create': {
    ...self,
    description: 'Save exact personally authored Memory under a new page identity.',
    inputSchema: CreateMemoryPageRequestSchema,
    outputSchema: MemoryPublicationSchema,
    mutating: true,
  },
  'memory.update': {
    ...self,
    description: 'Edit exact personally authored Memory at its current notebook base.',
    inputSchema: ChangeMemoryPageRequestSchema,
    outputSchema: MemoryPublicationSchema,
    mutating: true,
  },
  'memory.notebook.history': {
    ...self,
    description: 'Inspect currently authorized Memory history with forgotten details unavailable.',
    inputSchema: KnowledgeNotebookHistoryRequestSchema,
    outputSchema: KnowledgeNotebookHistoryResponseSchema,
    mutating: false,
  },
  'memory.notebook.diff': {
    ...self,
    description: 'Compare admitted Memory revisions without exposing suppressed content.',
    inputSchema: KnowledgeNotebookDiffRequestSchema,
    outputSchema: KnowledgeNotebookDiffResponseSchema,
    mutating: false,
  },
  'memory.notebook.restore': {
    ...self,
    description:
      'Restore admitted Memory content as a new fixed-base revision without deleting pages.',
    inputSchema: RestoreKnowledgeNotebookRequestSchema.omit({ confirmRemoval: true }),
    outputSchema: MemoryPublicationSchema,
    mutating: true,
  },
  'memory.forget.prepare': {
    ...self,
    mutationTarget: { kind: 'body-workspace', field: 'workspaceId' },
    description:
      'Request exact human confirmation of Memory removal, suppression and retained evidence.',
    inputSchema: PrepareMemoryForgetRequestSchema,
    outputSchema: z.object({
      pendingRequestId: RequestIdSchema,
      workspaceId: WorkspaceIdSchema,
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
      itemId: z.string().min(1),
      ownerScope: MemoryOwnerSchema,
      pageId: PageIdSchema,
      notebookRevision: z.string().min(1),
      digest: DigestSchema,
    }),
    mutating: true,
  },
  'memory.forget': {
    ...self,
    mutationTarget: { kind: 'body-workspace', field: 'workspaceId' },
    description:
      'Consume an exact human Memory forget grant and retain its original outcome on replay.',
    inputSchema: z
      .object({
        requestId: RequestIdSchema,
        pendingRequestId: RequestIdSchema,
        workspaceId: WorkspaceIdSchema,
        threadId: ThreadIdSchema,
      })
      .strict(),
    outputSchema: MemoryPublicationSchema,
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
