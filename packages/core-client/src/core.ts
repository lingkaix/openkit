import type { OperationOutput } from '@openkit/app-api-schemas';
import {
  type CreateKnowledgeEntryRequestSchema,
  type DeleteKnowledgeEntryRequestSchema,
  type KnowledgeEntrySchema,
  type ListKnowledgeEntriesResponseSchema,
  MetaResponseSchema,
  type ProductTurnSchema,
  type ThreadSchema,
  type UpdateKnowledgeEntryRequestSchema,
  type WorkspaceRecordSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { type SseEventEnvelope, subscribeTurnEvents } from './events.js';
import type { OptionalRequestId } from './request-id.js';
import type { EventSourceConstructor } from './sse.js';
import type { ClientTransport } from './transport.js';

/** Metadata response used for discovery and capability flags. */
export type MetaResponse = z.infer<typeof MetaResponseSchema>;
/** Workspace record returned by the definition-derived read. */
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
/** Knowledge list response. */
export type ListKnowledgeEntriesResponse = z.infer<typeof ListKnowledgeEntriesResponseSchema>;
/** Knowledge entry record. */
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
/** Knowledge create input. */
export type CreateKnowledgeInput = OptionalRequestId<
  z.infer<typeof CreateKnowledgeEntryRequestSchema>
>;
/** Knowledge update input. */
export type UpdateKnowledgeInput = OptionalRequestId<
  z.infer<typeof UpdateKnowledgeEntryRequestSchema>
>;
/** Knowledge delete input. */
export type DeleteKnowledgeInput = OptionalRequestId<
  z.infer<typeof DeleteKnowledgeEntryRequestSchema>
>;
/** Thread record. */
export type Thread = z.infer<typeof ThreadSchema>;
/** Turn record. */
export type Turn = z.infer<typeof ProductTurnSchema>;
/** Definition-derived Artifact inventory result. */
export type ListArtifactsResponse = OperationOutput<'artifact.list'>;
/** Definition-derived exact Artifact read result. */
export type GetArtifactResponse = OperationOutput<'artifact.read'>;
/** Exact Artifact record projected by its definition-derived read. */
export type Artifact = GetArtifactResponse;
/** Core metadata and Thread SSE projection client. */
export interface CoreProjectionClient {
  /** Reads server metadata and protocol capability flags. */
  meta(): Promise<MetaResponse>;
  /** Subscribes to one validated turn event stream. */
  subscribeTurnEvents(options: {
    workspaceId: string;
    threadId: string;
    turnId: string;
    since?: number;
  }): AsyncIterable<SseEventEnvelope>;
}

/** Creates the Core metadata and Thread SSE projection client. */
export function createCoreProjectionClient(
  transport: ClientTransport,
  eventSource?: EventSourceConstructor
): CoreProjectionClient {
  return {
    meta: () => transport.getJson('/api/meta', MetaResponseSchema),
    subscribeTurnEvents: (subscribeOptions) =>
      subscribeTurnEvents({
        ...subscribeOptions,
        baseUrl: transport.baseUrl,
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
        ...(eventSource === undefined ? { fetch: transport.fetch } : { eventSource }),
      }),
  };
}
