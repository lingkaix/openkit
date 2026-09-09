import { ActorRefSchema, RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Native OpenKit A2UI catalog identity. */
export const GENERATIVE_UI_NATIVE_CATALOG_ID = 'urn:openkit:a2ui:catalog:native:v1' as const;

/** A2UI protocol version retained by the initial native contract. */
export const GENERATIVE_UI_PROTOCOL_VERSION = 'v0.9' as const;

/** Kernel list query retained with one kernel-records source. */
export const GenerativeUiKernelQuerySchema = z
  .object({
    page: z.number().int().positive().max(100).optional(),
    perPage: z.number().int().positive().max(100).optional(),
    filter: z.string().max(2048).optional(),
    sort: z.string().max(256).optional(),
    fields: z.string().max(2048).optional(),
  })
  .strict();

/** Source bound to one Kernel collection query. */
export const GenerativeUiKernelRecordsSourceSchema = z
  .object({
    kind: z.literal('kernel-records'),
    appId: z.string().uuid(),
    collectionId: z.string().uuid(),
    schemaRevision: z.number().int().positive(),
    query: GenerativeUiKernelQuerySchema,
  })
  .strict();

/** Source bound to one completed assistant-message Item. */
export const GenerativeUiItemSourceSchema = z
  .object({
    kind: z.literal('item'),
    itemId: z.string().min(1),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

/** Closed initial source bindings. */
export const GenerativeUiSourceSchema = z.discriminatedUnion('kind', [
  GenerativeUiKernelRecordsSourceSchema,
  GenerativeUiItemSourceSchema,
]);

/** Explicit refresh action with no extra fields. */
export const GenerativeUiRefreshActionSchema = z
  .object({
    name: z.string().min(1).max(64),
    componentId: z.string().min(1).max(128),
    kind: z.literal('refresh'),
  })
  .strict();

/** Exact-record Kernel update action. */
export const GenerativeUiKernelRecordUpdateActionSchema = z
  .object({
    name: z.string().min(1).max(64),
    componentId: z.string().min(1).max(128),
    kind: z.literal('kernel-record-update'),
    recordId: z.string().uuid(),
    writableFieldIds: z.array(z.string().uuid()).min(1).max(16),
  })
  .strict();

/** Closed initial action bindings. */
export const GenerativeUiActionSchema = z.discriminatedUnion('kind', [
  GenerativeUiRefreshActionSchema,
  GenerativeUiKernelRecordUpdateActionSchema,
]);

/** Native A2UI client action event. */
export const GenerativeUiA2uiActionSchema = z
  .object({
    version: z.literal(GENERATIVE_UI_PROTOCOL_VERSION),
    action: z
      .object({
        name: z.string().min(1),
        surfaceId: z.string().min(1),
        sourceComponentId: z.string().min(1),
        timestamp: z.string().min(1),
        context: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

/** Publish input: producer messages plus source and static actions. */
export const PublishGenerativePresentationRequestSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    title: z.string().min(1).max(256),
    fallbackText: z.string().min(1).max(8192),
    messages: z.array(z.unknown()).min(2).max(2),
    source: GenerativeUiSourceSchema,
    actions: z.array(GenerativeUiActionSchema).max(8),
  })
  .strict();

/** Derived Item publication condition. */
export const GenerativePresentationPublicationSchema = z.enum([
  'published',
  'unpublished',
  'inconsistent',
]);

/** Immutable retained presentation. */
export const GenerativePresentationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
    createdAt: TimestampSchema,
    actor: ActorRefSchema,
    requestId: RequestIdSchema.nullable(),
    originRequestId: RequestIdSchema.nullable(),
    semanticInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    title: z.string().min(1),
    fallbackText: z.string().min(1),
    protocolVersion: z.literal(GENERATIVE_UI_PROTOCOL_VERSION),
    catalogId: z.literal(GENERATIVE_UI_NATIVE_CATALOG_ID),
    messages: z.array(z.unknown()).min(3).max(3),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source: GenerativeUiSourceSchema,
    actions: z.array(GenerativeUiActionSchema).max(8),
    observedAt: TimestampSchema,
    publication: GenerativePresentationPublicationSchema,
  })
  .strict();

/** Publish result. */
export const PublishGenerativePresentationResponseSchema = GenerativePresentationSchema;

/** Get result. */
export const GetGenerativePresentationResponseSchema = GenerativePresentationSchema;

/** Standard A2UI-over-MCP resource body. */
export const GenerativePresentationResourceResponseSchema = z
  .object({
    uri: z.string().min(1),
    mimeType: z.literal('application/a2ui+json'),
    text: z.string().min(1),
  })
  .strict();

/** Refresh request: native refresh event. */
export const RefreshGenerativePresentationRequestSchema = GenerativeUiA2uiActionSchema;

/** Refresh/action data-model result. */
export const GenerativePresentationDataModelResponseSchema = z
  .object({
    presentationId: z.string().uuid(),
    observedAt: TimestampSchema,
    messages: z.array(z.unknown()).min(1),
    refreshUnavailable: z.boolean().optional(),
    record: z.unknown().optional(),
  })
  .strict();

/** Mutating action request: native update event. */
export const SubmitGenerativePresentationActionRequestSchema = GenerativeUiA2uiActionSchema;

/** Publish result type. */
export type PublishGenerativePresentationRequest = z.infer<
  typeof PublishGenerativePresentationRequestSchema
>;
/** Publish response. */
export type PublishGenerativePresentationResponse = z.infer<
  typeof PublishGenerativePresentationResponseSchema
>;
/** Get-presentation response. */
export type GetGenerativePresentationResponse = z.infer<
  typeof GetGenerativePresentationResponseSchema
>;
/** Refresh request. */
export type RefreshGenerativePresentationRequest = z.infer<
  typeof RefreshGenerativePresentationRequestSchema
>;
/** Mutating action request. */
export type SubmitGenerativePresentationActionRequest = z.infer<
  typeof SubmitGenerativePresentationActionRequestSchema
>;
/** Retained presentation. */
export type GenerativePresentation = z.infer<typeof GenerativePresentationSchema>;
/** Kernel-records source. */
export type GenerativeUiKernelRecordsSource = z.infer<typeof GenerativeUiKernelRecordsSourceSchema>;
/** Item source. */
export type GenerativeUiItemSource = z.infer<typeof GenerativeUiItemSourceSchema>;
/** Source union. */
export type GenerativeUiSource = z.infer<typeof GenerativeUiSourceSchema>;
/** Action union. */
export type GenerativeUiAction = z.infer<typeof GenerativeUiActionSchema>;
/** Native A2UI action. */
export type GenerativeUiA2uiAction = z.infer<typeof GenerativeUiA2uiActionSchema>;
/** Data-model response. */
export type GenerativePresentationDataModelResponse = z.infer<
  typeof GenerativePresentationDataModelResponseSchema
>;
/** Resource response. */
export type GenerativePresentationResourceResponse = z.infer<
  typeof GenerativePresentationResourceResponseSchema
>;
