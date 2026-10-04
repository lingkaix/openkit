import {
  type AppDiagnosticsResponse,
  AppDiagnosticsResponseSchema,
  type ConsumeOpenKitBootstrapTokenRequest,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  type ConsumeOpenKitBootstrapTokenResponse,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  type CreateOpenKitAccessTokenRequest,
  CreateOpenKitAccessTokenRequestSchema,
  type CreateOpenKitAccessTokenResponse,
  CreateOpenKitAccessTokenResponseSchema,
  type KnowledgeManagerAnswerRequest,
  type KnowledgeManagerDraftProposalRequest,
  type KnowledgeManagerHealthCheckRequest,
  type KnowledgeManagerPrepareContextRequest,
  type KnowledgeManagerSuggestRepairRequest,
  type ListMyAdminAccessTokensResponse,
  ListMyAdminAccessTokensResponseSchema,
  type ListOpenKitAccessTokensResponse,
  ListOpenKitAccessTokensResponseSchema,
  type RecordKnowledgeClaimRequest,
  type RecordKnowledgeConflictRequest,
  type RecordKnowledgeObservationRequest,
  type RegisterKnowledgeSourceRequest,
  type ResolveKnowledgeConflictRequest,
  type RetrieveKnowledgeRequest,
  type ReverseKnowledgeProposalRequest,
  type RevokeOpenKitAccessTokenResponse,
  RevokeOpenKitAccessTokenResponseSchema,
  type RotateOpenKitAccessTokenRequest,
  RotateOpenKitAccessTokenRequestSchema,
  type RotateOpenKitAccessTokenResponse,
  RotateOpenKitAccessTokenResponseSchema,
  type SetMyAdminAccessTokenDefaultRequest,
  SetMyAdminAccessTokenDefaultRequestSchema,
  type SetMyAdminAccessTokenDefaultResponse,
  SetMyAdminAccessTokenDefaultResponseSchema,
  type SetupDiagnosticsResponse,
  SetupDiagnosticsResponseSchema,
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
/** OpenKit server bootstrap token consumption input. */
export type ConsumeOpenKitBootstrapTokenInput = ConsumeOpenKitBootstrapTokenRequest;
/** OpenKit access-token issue input. */
export type CreateOpenKitAccessTokenInput = CreateOpenKitAccessTokenRequest;
/** Signed-in user's default server-admin token selection input. */
export type SetMyAdminAccessTokenDefaultInput = SetMyAdminAccessTokenDefaultRequest;
/** OpenKit access-token rotation input. */
export interface RotateOpenKitAccessTokenInput {
  /** Optional grace period before the rotated token fully expires. */
  graceSeconds?: RotateOpenKitAccessTokenRequest['graceSeconds'];
}
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
  /** Reads Settings diagnostics. */
  getDiagnostics(): Promise<AppDiagnosticsResponse>;
  /** Reads setup diagnostics. */
  getSetupDiagnostics(): Promise<SetupDiagnosticsResponse>;
  /** Consumes the one-time server bootstrap token and returns the first server-admin token. */
  consumeBootstrapToken(
    input: ConsumeOpenKitBootstrapTokenInput
  ): Promise<ConsumeOpenKitBootstrapTokenResponse>;
  /** Lists redacted OpenKit access-token records. */
  listOpenKitAccessTokens(): Promise<ListOpenKitAccessTokensResponse>;
  /** Issues one OpenKit access token and returns the secret once. */
  createOpenKitAccessToken(
    input: CreateOpenKitAccessTokenInput
  ): Promise<CreateOpenKitAccessTokenResponse>;
  /** Revokes one OpenKit access token. */
  revokeOpenKitAccessToken(tokenId: string): Promise<RevokeOpenKitAccessTokenResponse>;
  /** Rotates one OpenKit access token and returns the replacement secret once. */
  rotateOpenKitAccessToken(
    tokenId: string,
    input?: RotateOpenKitAccessTokenInput
  ): Promise<RotateOpenKitAccessTokenResponse>;
  /** Lists the signed-in user's redacted server-admin tokens and effective default. */
  listMyAdminAccessTokens(): Promise<ListMyAdminAccessTokensResponse>;
  /** Selects one owned usable server-admin token as the signed-in user default. */
  setMyAdminAccessTokenDefault(
    input: SetMyAdminAccessTokenDefaultInput
  ): Promise<SetMyAdminAccessTokenDefaultResponse>;
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
    getDiagnostics: () => transport.getJson('/api/app/diagnostics', AppDiagnosticsResponseSchema),
    getSetupDiagnostics: () =>
      transport.getJson('/api/setup/diagnostics', SetupDiagnosticsResponseSchema),
    consumeBootstrapToken: (input) =>
      transport.postJson(
        '/api/app/auth/bootstrap/consume',
        ConsumeOpenKitBootstrapTokenRequestSchema.parse(input),
        ConsumeOpenKitBootstrapTokenResponseSchema
      ),
    listOpenKitAccessTokens: () =>
      transport.getJson('/api/app/auth/tokens', ListOpenKitAccessTokensResponseSchema),
    createOpenKitAccessToken: (input) =>
      transport.postJson(
        '/api/app/auth/tokens',
        CreateOpenKitAccessTokenRequestSchema.parse(input),
        CreateOpenKitAccessTokenResponseSchema
      ),
    revokeOpenKitAccessToken: (tokenId) =>
      transport.postJson(
        `/api/app/auth/tokens/${tokenId}/revoke`,
        {},
        RevokeOpenKitAccessTokenResponseSchema
      ),
    rotateOpenKitAccessToken: (tokenId, input = {}) =>
      transport.postJson(
        `/api/app/auth/tokens/${tokenId}/rotate`,
        RotateOpenKitAccessTokenRequestSchema.parse(input),
        RotateOpenKitAccessTokenResponseSchema
      ),
    listMyAdminAccessTokens: () =>
      transport.getJson('/api/app/auth/my-admin-tokens', ListMyAdminAccessTokensResponseSchema),
    setMyAdminAccessTokenDefault: (input) =>
      transport.putJson(
        '/api/app/auth/my-admin-tokens/default',
        SetMyAdminAccessTokenDefaultRequestSchema.parse(input),
        SetMyAdminAccessTokenDefaultResponseSchema
      ),
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
