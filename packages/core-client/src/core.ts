import {
  ApprovalRequestSchema,
  type ArchiveThreadRequestSchema,
  type ArtifactSchema,
  type CreateKnowledgeEntryRequestSchema,
  type CreateThreadRequestSchema,
  type CreateWorkspaceRequestSchema,
  type DeleteKnowledgeEntryRequestSchema,
  GetArtifactResponseSchema,
  type InterruptTurnRequestSchema,
  KnowledgeEntrySchema,
  ListArtifactsResponseSchema,
  ListKnowledgeEntriesResponseSchema,
  ListThreadItemsResponseSchema,
  ListThreadsResponseSchema,
  ListWorkspacesResponseSchema,
  MetaResponseSchema,
  type RespondToApprovalRequestSchema,
  type SubmitTurnInputRequestSchema,
  ThreadSchema,
  TurnSchema,
  type UpdateArtifactMetadataRequestSchema,
  type UpdateKnowledgeEntryRequestSchema,
  type UpdateThreadRequestSchema,
  type UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesResponseSchema,
  type WorkspaceResourcesSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { type SseEventEnvelope, subscribeTurnEvents } from './events.js';
import { type OptionalRequestId, withRequestId } from './request-id.js';
import type { EventSourceConstructor } from './sse.js';
import type { ClientTransport } from './transport.js';

/** Metadata response used for discovery and capability flags. */
export type MetaResponse = z.infer<typeof MetaResponseSchema>;
/** Workspace list response. */
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;
/** Workspace record returned by Core routes. */
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
/** Workspace resources response. */
export type WorkspaceResources = z.infer<typeof WorkspaceResourcesSchema>;
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
/** Thread create input. */
export type CreateThreadInput = OptionalRequestId<z.infer<typeof CreateThreadRequestSchema>>;
/** Thread update input. */
export type UpdateThreadInput = OptionalRequestId<z.infer<typeof UpdateThreadRequestSchema>>;
/** Thread archive input. */
export type ArchiveThreadInput = OptionalRequestId<z.infer<typeof ArchiveThreadRequestSchema>>;
/** Turn record. */
export type Turn = z.infer<typeof TurnSchema>;
/** Turn start input. */
export type StartTurnInput = OptionalRequestId<z.infer<typeof SubmitTurnInputRequestSchema>>;
/** Turn interrupt input. */
export type InterruptTurnInput = OptionalRequestId<z.infer<typeof InterruptTurnRequestSchema>>;
/** Approval request record. */
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
/** Approval response input. */
export type RespondApprovalInput = OptionalRequestId<
  z.infer<typeof RespondToApprovalRequestSchema>
>;
/** Approval response body passed with the approval id in the URL. */
export type RespondApprovalRequestBody = Omit<RespondApprovalInput, 'approvalRequestId'>;
/** Artifact list response. */
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;
/** Artifact response. */
export type Artifact = z.infer<typeof ArtifactSchema>;
/** Artifact detail response. */
export type GetArtifactResponse = z.infer<typeof GetArtifactResponseSchema>;
/** Artifact metadata update input. */
export type UpdateArtifactMetadataInput = OptionalRequestId<
  z.infer<typeof UpdateArtifactMetadataRequestSchema>
>;
/** Thread item replay response. */
export type ListThreadItemsResponse = z.infer<typeof ListThreadItemsResponseSchema>;

/** Options for listing durable thread items. */
export interface ListThreadItemsOptions {
  /** Optional sequence cursor. */
  since?: number;
  /** Optional result limit. */
  limit?: number;
}

/** Core protocol HTTP and SSE projection client. */
export interface CoreProjectionClient {
  /** Reads server metadata and protocol capability flags. */
  meta(): Promise<MetaResponse>;
  /** Lists workspaces. */
  listWorkspaces(): Promise<ListWorkspacesResponse>;
  /** Creates one workspace. */
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  /** Reads one workspace. */
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord>;
  /** Reads one workspace resource bundle. */
  getWorkspaceResources(workspaceId: string): Promise<WorkspaceResources>;
  /** Updates one workspace. */
  updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<WorkspaceRecord>;
  /** Lists workspace knowledge entries. */
  listKnowledge(workspaceId: string): Promise<ListKnowledgeEntriesResponse>;
  /** Creates one knowledge entry. */
  createKnowledge(workspaceId: string, input: CreateKnowledgeInput): Promise<KnowledgeEntry>;
  /** Updates one knowledge entry. */
  updateKnowledge(
    workspaceId: string,
    knowledgeEntryId: string,
    input: UpdateKnowledgeInput
  ): Promise<KnowledgeEntry>;
  /** Deletes one knowledge entry. */
  deleteKnowledge(
    workspaceId: string,
    knowledgeEntryId: string,
    input?: DeleteKnowledgeInput
  ): Promise<void>;
  /** Lists workspace threads. */
  listThreads(workspaceId: string): Promise<ListThreadsResponse>;
  /** Creates one thread. */
  createThread(input: CreateThreadInput): Promise<Thread>;
  /** Reads one thread. */
  getThread(workspaceId: string, threadId: string): Promise<Thread>;
  /** Updates one thread. */
  updateThread(input: UpdateThreadInput): Promise<Thread>;
  /** Archives one thread. */
  archiveThread(input: ArchiveThreadInput): Promise<Thread>;
  /** Starts or resumes a turn. */
  startTurn(input: StartTurnInput): Promise<Turn>;
  /** Reads one turn. */
  getTurn(workspaceId: string, threadId: string, turnId: string): Promise<Turn>;
  /** Interrupts one turn. */
  interruptTurn(input: InterruptTurnInput): Promise<Turn>;
  /** Responds to one approval request. */
  respondApproval(
    approvalRequestId: string,
    input: RespondApprovalRequestBody
  ): Promise<ApprovalRequest>;
  /** Lists workspace artifacts. */
  listArtifacts(workspaceId: string): Promise<ListArtifactsResponse>;
  /** Reads one artifact. */
  getArtifact(workspaceId: string, artifactId: string): Promise<GetArtifactResponse>;
  /** Updates one artifact metadata record. */
  updateArtifactMetadata(input: UpdateArtifactMetadataInput): Promise<GetArtifactResponse>;
  /** Lists durable items for one thread. */
  listThreadItems(
    workspaceId: string,
    threadId: string,
    options?: ListThreadItemsOptions
  ): Promise<ListThreadItemsResponse>;
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
  const listThreadItemsPath = (
    workspaceId: string,
    threadId: string,
    options?: ListThreadItemsOptions
  ): string => {
    const path = `/api/app/workspaces/${workspaceId}/threads/${threadId}/items`;
    const params = new URLSearchParams();

    if (options?.since !== undefined) {
      params.set('since', String(options.since));
    }

    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }

    const query = params.toString();
    return query ? `${path}?${query}` : path;
  };

  return {
    meta: () => transport.getJson('/api/meta', MetaResponseSchema),
    listWorkspaces: () => transport.getJson('/api/workspaces', ListWorkspacesResponseSchema),
    createWorkspace: (input) =>
      transport.postJson('/api/workspaces', withRequestId(input), WorkspaceRecordSchema),
    getWorkspace: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}`, WorkspaceRecordSchema),
    getWorkspaceResources: (workspaceId) =>
      transport.getJson(
        `/api/workspaces/${workspaceId}/resources`,
        WorkspaceResourcesResponseSchema
      ),
    updateWorkspace: (workspaceId, input) =>
      transport.patchJson(
        `/api/workspaces/${workspaceId}`,
        withRequestId(input),
        WorkspaceRecordSchema
      ),
    listKnowledge: (workspaceId) =>
      transport.getJson(
        `/api/workspaces/${workspaceId}/knowledge`,
        ListKnowledgeEntriesResponseSchema
      ),
    createKnowledge: (workspaceId, input) =>
      transport.postJson(
        `/api/workspaces/${workspaceId}/knowledge`,
        withRequestId(input),
        KnowledgeEntrySchema
      ),
    updateKnowledge: (workspaceId, knowledgeEntryId, input) =>
      transport.patchJson(
        `/api/workspaces/${workspaceId}/knowledge/${knowledgeEntryId}`,
        withRequestId(input),
        KnowledgeEntrySchema
      ),
    deleteKnowledge: (workspaceId, knowledgeEntryId, input = {}) =>
      transport.deleteJson(
        `/api/workspaces/${workspaceId}/knowledge/${knowledgeEntryId}`,
        withRequestId(input)
      ),
    listThreads: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}/threads`, ListThreadsResponseSchema),
    createThread: (input) => {
      const request = withRequestId(input);
      return transport.postJson(
        `/api/workspaces/${request.workspaceId}/threads`,
        request,
        ThreadSchema
      );
    },
    getThread: (workspaceId, threadId) =>
      transport.getJson(`/api/workspaces/${workspaceId}/threads/${threadId}`, ThreadSchema),
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
    startTurn: (input) => transport.postJson('/api/turns', withRequestId(input), TurnSchema),
    getTurn: (workspaceId, threadId, turnId) =>
      transport.getJson(
        `/api/workspaces/${workspaceId}/threads/${threadId}/turns/${turnId}`,
        TurnSchema
      ),
    interruptTurn: (input) => {
      const request = withRequestId(input);
      return transport.postJson(
        `/api/workspaces/${request.workspaceId}/threads/${request.threadId}/turns/${request.turnId}/interrupt`,
        request,
        TurnSchema
      );
    },
    respondApproval: (approvalRequestId, input) =>
      transport.postJson(
        `/api/approvals/${approvalRequestId}/respond`,
        withRequestId({ ...input, approvalRequestId }),
        ApprovalRequestSchema
      ),
    listArtifacts: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}/artifacts`, ListArtifactsResponseSchema),
    getArtifact: (workspaceId, artifactId) =>
      transport.getJson(
        `/api/workspaces/${workspaceId}/artifacts/${artifactId}`,
        GetArtifactResponseSchema
      ),
    updateArtifactMetadata: (input) => {
      const request = withRequestId(input);
      return transport.patchJson(
        `/api/workspaces/${request.workspaceId}/artifacts/${request.artifactId}`,
        request,
        GetArtifactResponseSchema
      );
    },
    listThreadItems: (workspaceId, threadId, options) =>
      transport.getJson(
        listThreadItemsPath(workspaceId, threadId, options),
        ListThreadItemsResponseSchema
      ),
    subscribeTurnEvents: (subscribeOptions) =>
      subscribeTurnEvents({
        ...subscribeOptions,
        baseUrl: transport.baseUrl,
        fetch: transport.fetch,
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
        ...(eventSource === undefined ? {} : { eventSource }),
      }),
  };
}
