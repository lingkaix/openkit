import {
  type KnowledgeManagerAnswerRequest,
  type KnowledgeManagerDraftProposalRequest,
  type KnowledgeManagerHealthCheckRequest,
  type KnowledgeManagerPrepareContextRequest,
  type KnowledgeManagerSuggestRepairRequest,
  type RecordKnowledgeClaimRequest,
  type RecordKnowledgeConflictRequest,
  type RecordKnowledgeObservationRequest,
  type RegisterKnowledgeSourceRequest,
  type ResolveKnowledgeConflictRequest,
  type RetrieveKnowledgeRequest,
  type ReverseKnowledgeProposalRequest,
  type SubmitKnowledgeProposalDecisionRequest,
  type VaultAdminBootstrapCodexAuthJsonRequest,
  type VaultAdminUnlockRequest,
  type WorkspaceImportDryRunResponse,
  WorkspaceImportDryRunResponseSchema,
  type WorkspaceImportResponse,
  WorkspaceImportResponseSchema,
  type WorkspaceSharingError,
  WorkspaceSharingErrorSchema,
} from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { ApiCallError } from './errors.js';
import { createRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Knowledge Manager answer request input. */
export type KnowledgeManagerAnswerInput = KnowledgeManagerAnswerRequest;
/** Knowledge Manager context-material request input. */
export type KnowledgeManagerPrepareContextInput = KnowledgeManagerPrepareContextRequest;
/** Knowledge Manager proposal draft request input. */
export type KnowledgeManagerDraftProposalInput = KnowledgeManagerDraftProposalRequest;
/** Knowledge Manager repair suggestion request input. */
export type KnowledgeManagerSuggestRepairInput = KnowledgeManagerSuggestRepairRequest;
/** Knowledge Manager health-check request input. */
export type KnowledgeManagerHealthCheckInput = KnowledgeManagerHealthCheckRequest;
/** Knowledge Source registration request input. */
export type RegisterKnowledgeSourceInput = RegisterKnowledgeSourceRequest;
/** Knowledge Observation append request input. */
export type RecordKnowledgeObservationInput = RecordKnowledgeObservationRequest;
/** Knowledge Claim append request input. */
export type RecordKnowledgeClaimInput = RecordKnowledgeClaimRequest;
/** Knowledge Conflict append request input. */
export type RecordKnowledgeConflictInput = RecordKnowledgeConflictRequest;
/** Knowledge Conflict resolution request input. */
export type ResolveKnowledgeConflictInput = ResolveKnowledgeConflictRequest;
/** Deterministic Knowledge Store retrieval request input. */
export type RetrieveKnowledgeInput = RetrieveKnowledgeRequest;
/** Knowledge proposal decision input with its required caller-provided request id. */
export type SubmitKnowledgeProposalDecisionInput = SubmitKnowledgeProposalDecisionRequest;
/** Bounded Knowledge proposal reversal input. */
export type ReverseKnowledgeProposalInput = ReverseKnowledgeProposalRequest;
/** Vault admin unlock input. */
export type VaultAdminUnlockInput = VaultAdminUnlockRequest;
/** Vault admin Codex auth JSON bootstrap input. */
export type VaultAdminBootstrapCodexAuthJsonInput = VaultAdminBootstrapCodexAuthJsonRequest;

/**
 * Narrows one generic API failure to the exact-release Workspace sharing error family.
 *
 * @param error Unknown failure raised by a Core Client request.
 * @returns Parsed Workspace sharing error, or null for another or malformed error family.
 */
export function parseWorkspaceSharingError(error: unknown): WorkspaceSharingError | null {
  if (!(error instanceof ApiCallError) || !error.code) {
    return null;
  }

  const parsed = WorkspaceSharingErrorSchema.safeParse({
    code: error.code,
    ...(error.details === undefined ? {} : { details: error.details }),
    message: error.message,
    ...(error.path === undefined ? {} : { path: [...error.path] }),
    protocolVersion: PROTOCOL_VERSION,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  });

  return parsed.success ? parsed.data : null;
}

/** NanoCore App API client for read models and app-local commands. */
export interface AppApiClient {
  /** Downloads one verified Workspace export as a raw archive stream. */
  downloadWorkspaceExportArchive(
    workspaceId: string,
    exportId: string
  ): Promise<ReadableStream<Uint8Array>>;
  /** Verifies one raw Workspace archive stream without importing it. */
  dryRunWorkspaceArchiveImport(body: BodyInit): Promise<WorkspaceImportDryRunResponse>;
  /** Imports one raw Workspace archive stream with a caller-selected or generated request id. */
  importWorkspaceArchive(body: BodyInit, requestId?: string): Promise<WorkspaceImportResponse>;
}

/** Creates the NanoCore App API client. */
export function createAppApiClient(transport: ClientTransport): AppApiClient {
  return {
    downloadWorkspaceExportArchive: (workspaceId, exportId) =>
      transport.getStream(
        `/api/app/workspaces/${workspaceId}/exports/${exportId}/archive`,
        'application/vnd.openkit.workspace-export+tar.zstd'
      ),
    dryRunWorkspaceArchiveImport: (body) =>
      transport.postStream(
        '/api/app/workspace-archives/import-dry-run',
        body,
        { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
        WorkspaceImportDryRunResponseSchema
      ),
    importWorkspaceArchive: (body, requestId) =>
      transport.postStream(
        '/api/app/workspace-archives/import',
        body,
        {
          'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
          'x-openkit-request-id': requestId ?? createRequestId(),
        },
        WorkspaceImportResponseSchema
      ),
  };
}
