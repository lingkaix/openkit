import type { OperationOutput } from '@openkit/app-api-schemas';
import {
  type ArchiveThreadRequestSchema,
  type CreateKnowledgeEntryRequestSchema,
  type CreateWorkspaceRequestSchema,
  type DeleteKnowledgeEntryRequestSchema,
  type InterruptTurnRequestSchema,
  type KnowledgeEntrySchema,
  type ListKnowledgeEntriesResponseSchema,
  ListThreadsResponseSchema,
  MetaResponseSchema,
  ProductTurnSchema,
  type SubmitTurnInputRequestSchema,
  ThreadSchema,
  type UpdateKnowledgeEntryRequestSchema,
  type UpdateThreadRequestSchema,
  type UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { type SseEventEnvelope, subscribeTurnEvents } from './events.js';
import { type OptionalRequestId, withRequestId } from './request-id.js';
import type { EventSourceConstructor } from './sse.js';
import type { ClientTransport } from './transport.js';

/** Metadata response used for discovery and capability flags. */
export type MetaResponse = z.infer<typeof MetaResponseSchema>;
/** Workspace record returned by Core routes. */
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
/** Workspace create input. */
export type CreateWorkspaceInput = OptionalRequestId<z.infer<typeof CreateWorkspaceRequestSchema>>;
/** Workspace update input. */
export type UpdateWorkspaceInput = OptionalRequestId<z.infer<typeof UpdateWorkspaceRequestSchema>>;
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
/** Thread list response. */
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;
/** Thread record. */
export type Thread = z.infer<typeof ThreadSchema>;
/** Thread update input. */
export type UpdateThreadInput = OptionalRequestId<z.infer<typeof UpdateThreadRequestSchema>>;
/** Thread archive input. */
export type ArchiveThreadInput = OptionalRequestId<z.infer<typeof ArchiveThreadRequestSchema>>;
/** Turn record. */
export type Turn = z.infer<typeof ProductTurnSchema>;
/** Turn start input. */
export type StartTurnInput = OptionalRequestId<z.infer<typeof SubmitTurnInputRequestSchema>>;
/** Turn interrupt input. */
export type InterruptTurnInput = OptionalRequestId<z.infer<typeof InterruptTurnRequestSchema>>;
/** Definition-derived Artifact inventory result. */
export type ListArtifactsResponse = OperationOutput<'artifact.list'>;
/** Definition-derived exact Artifact read result. */
export type GetArtifactResponse = OperationOutput<'artifact.read'>;
/** Exact Artifact record projected by its definition-derived read. */
export type Artifact = GetArtifactResponse;
/** Core protocol HTTP and SSE projection client. */
export interface CoreProjectionClient {
  /** Reads server metadata and protocol capability flags. */
  meta(): Promise<MetaResponse>;
  /** Creates one workspace. */
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  /** Reads one workspace. */
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord>;
  /** Updates one workspace. */
  updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceRecord>;
  /** Lists workspace threads. */
  listThreads(workspaceId: string): Promise<ListThreadsResponse>;
  /** Updates one thread. */
  updateThread(input: UpdateThreadInput): Promise<Thread>;
  /** Archives one thread. */
  archiveThread(input: ArchiveThreadInput): Promise<Thread>;
  /** Starts or resumes a turn. */
  startTurn(input: StartTurnInput): Promise<Turn>;
  /** Interrupts one turn. */
  interruptTurn(input: InterruptTurnInput): Promise<Turn>;
  /** Subscribes to one validated turn event stream. */
  subscribeTurnEvents(options: {
    workspaceId: string;
    threadId: string;
    turnId: string;
    since?: number;
  }): AsyncIterable<SseEventEnvelope>;
}

/** Creates the Core protocol HTTP and SSE projection client. */
export function createCoreProjectionClient(
  transport: ClientTransport,
  eventSource?: EventSourceConstructor
): CoreProjectionClient {
  return {
    meta: () => transport.getJson('/api/meta', MetaResponseSchema),
    createWorkspace: (input) =>
      transport.postJson('/api/workspaces', withRequestId(input), WorkspaceRecordSchema),
    getWorkspace: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}`, WorkspaceRecordSchema),
    updateWorkspace: (workspaceId, input) =>
      transport.patchJson(
        `/api/workspaces/${workspaceId}`,
        withRequestId(input),
        WorkspaceRecordSchema
      ),
    listThreads: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}/threads`, ListThreadsResponseSchema),
    updateThread: (input) => {
      const request = withRequestId(input);
      return transport.patchJson(
        `/api/workspaces/${request.workspaceId}/threads/${request.threadId}`,
        request,
        ThreadSchema
      );
    },
    archiveThread: (input) => {
      const request = withRequestId(input);
      return transport.postJson(
        `/api/workspaces/${request.workspaceId}/threads/${request.threadId}/archive`,
        request,
        ThreadSchema
      );
    },
    startTurn: (input) => transport.postJson('/api/turns', withRequestId(input), ProductTurnSchema),
    interruptTurn: (input) => {
      const request = withRequestId(input);
      return transport.postJson(
        `/api/workspaces/${request.workspaceId}/threads/${request.threadId}/turns/${request.turnId}/interrupt`,
        request,
        ProductTurnSchema
      );
    },
    subscribeTurnEvents: (subscribeOptions) =>
      subscribeTurnEvents({
        ...subscribeOptions,
        baseUrl: transport.baseUrl,
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
        ...(eventSource === undefined ? { fetch: transport.fetch } : { eventSource }),
      }),
  };
}
