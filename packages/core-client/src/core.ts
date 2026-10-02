import {
  type AnswerUserInputRequestSchema,
  ApprovalRequestSchema,
  type ArchiveThreadRequestSchema,
  type ArtifactSchema,
  type CreateKnowledgeEntryRequestSchema,
  type CreateWorkspaceRequestSchema,
  type DeleteKnowledgeEntryRequestSchema,
  GetArtifactResponseSchema,
  type InterruptTurnRequestSchema,
  KnowledgeEntrySchema,
  ListArtifactsResponseSchema,
  ListKnowledgeEntriesResponseSchema,
  ListThreadsResponseSchema,
  MetaResponseSchema,
  PendingRequestOutcomeSchema,
  ProductTurnSchema,
  type RespondToApprovalRequestSchema,
  type SubmitTurnInputRequestSchema,
  ThreadSchema,
  type UpdateKnowledgeEntryRequestSchema,
  type UpdateThreadRequestSchema,
  type UpdateWorkspaceRequestSchema,
  type WithdrawPendingRequestSchema,
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
/** Approval request record. */
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
/** Approval response input. */
export type RespondApprovalInput = OptionalRequestId<
  z.infer<typeof RespondToApprovalRequestSchema>
>;
/** Approval response body passed with the approval id in the URL. */
export type RespondApprovalRequestBody = Omit<RespondApprovalInput, 'approvalRequestId'>;
/** User-input answer input. */
export type AnswerUserInputInput = OptionalRequestId<z.infer<typeof AnswerUserInputRequestSchema>>;
/** User-input answer body passed with the request id in the URL. */
export type AnswerUserInputRequestBody = Omit<AnswerUserInputInput, 'userInputRequestId'>;
/** Pending-request withdrawal input. */
export type WithdrawPendingRequestInput = OptionalRequestId<
  z.infer<typeof WithdrawPendingRequestSchema>
>;
/** Pending-request withdrawal body passed with the request id in the URL. */
export type WithdrawPendingRequestBody = Omit<WithdrawPendingRequestInput, 'pendingRequestId'>;
/** Pending-request command outcome. */
export type PendingRequestOutcome = z.infer<typeof PendingRequestOutcomeSchema>;
/** Artifact list response. */
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;
/** Artifact response. */
export type Artifact = z.infer<typeof ArtifactSchema>;
/** Artifact detail response. */
export type GetArtifactResponse = z.infer<typeof GetArtifactResponseSchema>;
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
  /** Updates one thread. */
  updateThread(input: UpdateThreadInput): Promise<Thread>;
  /** Archives one thread. */
  archiveThread(input: ArchiveThreadInput): Promise<Thread>;
  /** Starts or resumes a turn. */
  startTurn(input: StartTurnInput): Promise<Turn>;
  /** Interrupts one turn. */
  interruptTurn(input: InterruptTurnInput): Promise<Turn>;
  /** Responds to one approval request. */
  respondApproval(
    approvalRequestId: string,
    input: RespondApprovalRequestBody
  ): Promise<ApprovalRequest>;
  /** Answers one pending user-input request. */
  answerUserInput(
    userInputRequestId: string,
    input: AnswerUserInputRequestBody
  ): Promise<PendingRequestOutcome>;
  /** Withdraws one pending request. */
  withdrawPendingRequest(
    pendingRequestId: string,
    input: WithdrawPendingRequestBody
  ): Promise<PendingRequestOutcome>;
  /** Lists workspace artifacts. */
  listArtifacts(workspaceId: string): Promise<ListArtifactsResponse>;
  /** Reads one artifact. */
  getArtifact(workspaceId: string, artifactId: string): Promise<GetArtifactResponse>;
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
    respondApproval: (approvalRequestId, input) =>
      transport.postJson(
        `/api/approvals/${approvalRequestId}/respond`,
        withRequestId({ ...input, approvalRequestId }),
        ApprovalRequestSchema
      ),
    answerUserInput: (userInputRequestId, input) =>
      transport.postJson(
        `/api/user-input-requests/${userInputRequestId}/answer`,
        withRequestId({ ...input, userInputRequestId }),
        PendingRequestOutcomeSchema
      ),
    withdrawPendingRequest: (pendingRequestId, input) =>
      transport.postJson(
        `/api/pending-requests/${pendingRequestId}/withdraw`,
        withRequestId({ ...input, pendingRequestId }),
        PendingRequestOutcomeSchema
      ),
    listArtifacts: (workspaceId) =>
      transport.getJson(`/api/workspaces/${workspaceId}/artifacts`, ListArtifactsResponseSchema),
    getArtifact: (workspaceId, artifactId) =>
      transport.getJson(
        `/api/workspaces/${workspaceId}/artifacts/${artifactId}`,
        GetArtifactResponseSchema
      ),
    subscribeTurnEvents: (subscribeOptions) =>
      subscribeTurnEvents({
        ...subscribeOptions,
        baseUrl: transport.baseUrl,
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
        ...(eventSource === undefined ? { fetch: transport.fetch } : { eventSource }),
      }),
  };
}
