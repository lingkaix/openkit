import {
  ActorRefSchema,
  ItemIdSchema,
  RetrievalTraceIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import {
  KnowledgeQueryContextSchema,
  KnowledgeRetrievalTraceReaderSchema,
  KnowledgeRetrievalTraceSchema,
} from './knowledge-manager.js';

/** Exact canonical source coordinates for an ordinary visible conversation Item. */
export const ConversationItemReferenceSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    itemId: ItemIdSchema,
  })
  .strict();

/** Bounded model input; trusted assembly supplies source and querying lineage. */
export const AssistantHistorySearchSchema = z
  .object({
    query: z.string().min(1).max(4096),
    mode: z.enum(['lexical', 'exact', 'regex']).default('lexical'),
    limit: z.number().int().positive().max(20).default(5),
  })
  .strict();

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Exact source range supplied by a summary; it conveys no Workspace or actor authority. */
export const AssistantHistoryRangeSchema = z
  .object({
    threadId: ThreadIdSchema,
    firstItemId: ItemIdSchema,
    lastItemId: ItemIdSchema,
    sourceDigest: digest,
  })
  .strict();

const cursor = z.object({ itemId: ItemIdSchema, offset: z.number().int().nonnegative() }).strict();

/** Bounded exact history projection with a byte cursor for a large original Item. */
export const AssistantHistoryReadSchema = z
  .object({
    range: AssistantHistoryRangeSchema,
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(20).default(5),
  })
  .strict();

/** Search or exact source-bound read through the same current-audience history Tool. */
export const AssistantHistoryQuerySchema = z.union([
  AssistantHistorySearchSchema,
  AssistantHistoryReadSchema,
]);

const retrievalParameters = z.union([
  AssistantHistorySearchSchema.omit({ query: true }),
  AssistantHistoryReadSchema.extend({ mode: z.literal('range') }),
]);

/** Content-free source selection retained by the existing query-owned trace. */
export const ConversationHistorySelectionSchema = z
  .object({
    reference: ConversationItemReferenceSchema,
    revision: digest,
    digest,
  })
  .strict();

/** Conversation source variant of the existing immutable retrieval trace. */
export const ConversationRetrievalTraceSchema = z
  .object({
    sourceKind: z.literal('conversation'),
    traceId: RetrievalTraceIdSchema,
    queryContext: KnowledgeQueryContextSchema.safeExtend({
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
    }),
    requestDigest: digest,
    retrievalParameters,
    selected: z.array(ConversationHistorySelectionSchema).max(20),
    complete: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();

/** Retained descriptions ignore additions without widening source or lifecycle values. */
export const ConversationRetrievalTraceReaderSchema = ConversationRetrievalTraceSchema.extend({
  queryContext: ConversationRetrievalTraceSchema.shape.queryContext
    .extend({ actor: z.union(ActorRefSchema.options.map((schema) => schema.strip())) })
    .strip(),
  retrievalParameters: z.union([
    retrievalParameters.options[0].strip(),
    retrievalParameters.options[1]
      .extend({ range: AssistantHistoryRangeSchema.strip(), cursor: cursor.strip().optional() })
      .strip(),
  ]),
  selected: z
    .array(
      ConversationHistorySelectionSchema.extend({
        reference: ConversationItemReferenceSchema.strip(),
      }).strip()
    )
    .max(20),
}).strip();

/** The source variants share one query-owned persistence and portability boundary. */
export const ProductRetrievalTraceSchema = z.union([
  KnowledgeRetrievalTraceSchema,
  ConversationRetrievalTraceSchema,
]);

/** Known-field projection of either retained source variant. */
export const ProductRetrievalTraceReaderSchema = z.union([
  KnowledgeRetrievalTraceReaderSchema.extend({ sourceKind: z.never().optional() }),
  ConversationRetrievalTraceReaderSchema,
]);

/** Immutable evidence body accepted by the existing retrieval trace publisher. */
export type ProductRetrievalTrace = z.infer<typeof ProductRetrievalTraceSchema>;

/** Immutable conversation selection without query text or snippets. */
export type ConversationRetrievalTrace = z.infer<typeof ConversationRetrievalTraceSchema>;
