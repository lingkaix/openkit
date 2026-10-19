import {
  AutomationIdSchema,
  ContentReferenceSchema,
  ItemIdSchema,
  PageReferenceSchema,
  RetrievalTraceIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

// These fixed payloads select retained trace meaning, independently of current retrieval responses.
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const actor = z.union([
  z.object({ kind: z.literal('user'), id: UserIdSchema }),
  z.object({
    kind: z.enum(['agent', 'integration', 'system']),
    id: z.string().min(1),
    responsibleUserId: UserIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('automation'),
    id: AutomationIdSchema,
    responsibleUserId: UserIdSchema.nullable(),
  }),
]);
const queryContext = z.object({
  serverId: z.string().min(1),
  workspaceId: WorkspaceIdSchema,
  actor,
  threadId: ThreadIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
});
const pageObjectId = z
  .string()
  .max(240)
  .regex(/^(?!(?:.*\/)?(?:index|log)$)[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/)
  .refine((value) => !value.endsWith('.md') && new TextEncoder().encode(value).length <= 240);
const pageReference = PageReferenceSchema.safeExtend({ objectId: pageObjectId }).strip();
const selectedPage = z.object({
  reference: pageReference,
  revision: z.string().min(1),
  contentDigest: digest,
  sourceReferences: z.array(z.string().min(1)),
  contentRef: ContentReferenceSchema.optional(),
});
const excludedPage = z.object({
  reference: pageReference,
  revision: z.string().min(1).nullable(),
  contentDigest: digest.nullable(),
  sourceReferences: z.array(z.string().min(1)),
  reason: z.enum([
    'sensitive_content',
    'lower_conformance',
    'policy_excluded',
    'freshness_expired',
    'budget_exceeded',
    'source_unavailable',
  ]),
});
const selectionValues = z.array(z.string().min(1).regex(/\S/)).min(1);
const knowledge = z.object({
  sourceKind: z.never().optional(),
  traceId: RetrievalTraceIdSchema,
  queryContext,
  sourceScope: PageReferenceSchema.shape.scopeId,
  notebookRevision: z.string().min(1).nullable(),
  caller: z.enum(['assistant', 'task-mode', 'app-api']),
  requestDigest: digest,
  retrievalParameters: z.object({
    limit: z.number().int().positive().max(20),
    pinnedReferences: z.array(pageReference),
    states: z.array(z.enum(['active', 'draft', 'archived', 'superseded'])).min(1),
    sourceScope: z.enum(['workspace', 'server', 'user']),
    types: selectionValues.optional(),
    appliesTo: selectionValues.optional(),
  }),
  selected: z.array(selectedPage),
  excluded: z.array(excludedPage),
  createdAt: z.string().min(1),
});
const range = z.object({
  threadId: ThreadIdSchema,
  firstItemId: ItemIdSchema,
  lastItemId: ItemIdSchema,
  sourceDigest: digest,
});
const cursor = z.object({ itemId: ItemIdSchema, offset: z.number().int().nonnegative() });
const conversation = z.object({
  sourceKind: z.literal('conversation'),
  traceId: RetrievalTraceIdSchema,
  queryContext: queryContext.extend({ threadId: ThreadIdSchema, turnId: TurnIdSchema }),
  requestDigest: digest,
  retrievalParameters: z.union([
    z.object({
      mode: z.enum(['lexical', 'exact', 'regex']).default('lexical'),
      limit: z.number().int().positive().max(20).default(5),
    }),
    z.object({
      mode: z.literal('range'),
      range,
      cursor: cursor.optional(),
      limit: z.number().int().positive().max(20).default(5),
    }),
  ]),
  selected: z
    .array(
      z.object({
        reference: z.object({
          workspaceId: WorkspaceIdSchema,
          threadId: ThreadIdSchema,
          turnId: TurnIdSchema,
          itemId: ItemIdSchema,
        }),
        revision: digest,
        digest,
      })
    )
    .max(20),
  complete: z.boolean(),
  createdAt: TimestampSchema,
});

/** Header-free v1 trace payload; native file boundaries check the shared marker first. */
export const StoredProductRetrievalTraceV1Schema = z.union([knowledge, conversation]);
