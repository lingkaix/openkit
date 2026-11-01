import {
  type KnowledgeManagerAnswerRequest,
  type KnowledgeManagerDraftProposalRequest,
  type KnowledgeManagerHealthCheckRequest,
  type KnowledgeManagerPrepareContextRequest,
  type KnowledgeManagerSuggestRepairRequest,
  type RegisterKnowledgeSourceRequest,
  type RetrieveKnowledgeRequest,
  type ReverseKnowledgeProposalRequest,
  type SubmitKnowledgeProposalDecisionRequest,
  type VaultAdminBootstrapCodexAuthJsonRequest,
  type VaultAdminUnlockRequest,
  type WorkspaceSharingError,
  WorkspaceSharingErrorSchema,
} from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { ApiCallError } from './errors.js';
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
}

/** Creates the NanoCore App API client. */
export function createAppApiClient(transport: ClientTransport): AppApiClient {
  return {
    downloadWorkspaceExportArchive: (workspaceId, exportId) =>
      transport.getStream(
        `/api/app/workspaces/${workspaceId}/exports/${exportId}/archive`,
        'application/vnd.openkit.workspace-export+tar.zstd'
      ),
  };
}
