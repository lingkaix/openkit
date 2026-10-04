import {
  type ActivateWorkerEnvironmentRequest,
  ActivateWorkerEnvironmentRequestSchema,
  type ActivateWorkerEnvironmentResponse,
  ActivateWorkerEnvironmentResponseSchema,
  type AppDiagnosticsResponse,
  AppDiagnosticsResponseSchema,
  type ApplyAdministrationConfigurationRequest,
  ApplyAdministrationConfigurationRequestSchema,
  type ApplyAdministrationConfigurationResponse,
  ApplyAdministrationConfigurationResponseSchema,
  type AppSearchResponse,
  AppSearchResponseSchema,
  type AppUpdateStatusResponse,
  AppUpdateStatusResponseSchema,
  type BindThreadMaterialRequest,
  BindThreadMaterialRequestSchema,
  type BindThreadMaterialResponse,
  BindThreadMaterialResponseSchema,
  type CapabilityUsageResponse,
  CapabilityUsageResponseSchema,
  type ConsumeOpenKitBootstrapTokenRequest,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  type ConsumeOpenKitBootstrapTokenResponse,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  type CreateOpenKitAccessTokenRequest,
  CreateOpenKitAccessTokenRequestSchema,
  type CreateOpenKitAccessTokenResponse,
  CreateOpenKitAccessTokenResponseSchema,
  type CreateWorkspaceMaterialRequest,
  CreateWorkspaceMaterialRequestSchema,
  type CreateWorkspaceMaterialResponse,
  CreateWorkspaceMaterialResponseSchema,
  type CreateWorkspaceVaultGrantRequest,
  CreateWorkspaceVaultGrantRequestSchema,
  type CreateWorkspaceVaultSecretRequest,
  CreateWorkspaceVaultSecretRequestSchema,
  type ExcludeThreadMaterialRequest,
  ExcludeThreadMaterialRequestSchema,
  type ExcludeThreadMaterialResponse,
  ExcludeThreadMaterialResponseSchema,
  type GetAgentEnvironmentPackageSnapshotResponse,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  type GetThreadMaterialResponse,
  GetThreadMaterialResponseSchema,
  type GetWorkerEnvironmentStatusResponse,
  GetWorkerEnvironmentStatusResponseSchema,
  type GetWorkspaceMaterialResponse,
  GetWorkspaceMaterialResponseSchema,
  type GetWorkspaceMaterialRevisionResponse,
  GetWorkspaceMaterialRevisionResponseSchema,
  type KnowledgeManagerAnswerRequest,
  type KnowledgeManagerDraftProposalRequest,
  type KnowledgeManagerHealthCheckRequest,
  type KnowledgeManagerPrepareContextRequest,
  type KnowledgeManagerSuggestRepairRequest,
  type ListAgentEnvironmentPackageSnapshotsResponse,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  type ListMyAdminAccessTokensResponse,
  ListMyAdminAccessTokensResponseSchema,
  type ListOpenKitAccessTokensResponse,
  ListOpenKitAccessTokensResponseSchema,
  type ListServerAuditEventsResponse,
  ListServerAuditEventsResponseSchema,
  type ListServerPermissionDecisionsResponse,
  ListServerPermissionDecisionsResponseSchema,
  type ListServerVaultUseRecordsResponse,
  ListServerVaultUseRecordsResponseSchema,
  type ListWorkerEnvironmentsQuery,
  ListWorkerEnvironmentsQuerySchema,
  type ListWorkerEnvironmentsResponse,
  ListWorkerEnvironmentsResponseSchema,
  type ListWorkspaceAuditEventsResponse,
  ListWorkspaceAuditEventsResponseSchema,
  type ListWorkspaceEvidenceBundlesResponse,
  ListWorkspaceEvidenceBundlesResponseSchema,
  type ListWorkspaceMaterialRevisionsResponse,
  ListWorkspaceMaterialRevisionsResponseSchema,
  type ListWorkspaceMaterialsResponse,
  ListWorkspaceMaterialsResponseSchema,
  type ListWorkspacePermissionDecisionsResponse,
  ListWorkspacePermissionDecisionsResponseSchema,
  type ListWorkspaceRuntimeEvidenceResponse,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  type ListWorkspaceVaultGrantsResponse,
  ListWorkspaceVaultGrantsResponseSchema,
  type ListWorkspaceVaultInjectionPlansResponse,
  ListWorkspaceVaultInjectionPlansResponseSchema,
  type ListWorkspaceVaultInjectionReceiptsResponse,
  ListWorkspaceVaultInjectionReceiptsResponseSchema,
  type ListWorkspaceVaultUseRecordsResponse,
  ListWorkspaceVaultUseRecordsResponseSchema,
  type PrepareAppUpdateRequest,
  PrepareAppUpdateRequestSchema,
  type PrepareAppUpdateResponse,
  PrepareAppUpdateResponseSchema,
  type PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentRequestSchema,
  type PrepareWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentResponseSchema,
  type PurgeWorkerEnvironmentRequest,
  PurgeWorkerEnvironmentRequestSchema,
  type PurgeWorkerEnvironmentResponse,
  PurgeWorkerEnvironmentResponseSchema,
  type RecordKnowledgeClaimRequest,
  type RecordKnowledgeConflictRequest,
  type RecordKnowledgeObservationRequest,
  type RegisterKnowledgeSourceRequest,
  type ResolveKnowledgeConflictRequest,
  type RestoreThreadMaterialRequest,
  RestoreThreadMaterialRequestSchema,
  type RestoreThreadMaterialResponse,
  RestoreThreadMaterialResponseSchema,
  type RetrieveKnowledgeRequest,
  type ReverseKnowledgeProposalRequest,
  type RevokeOpenKitAccessTokenResponse,
  RevokeOpenKitAccessTokenResponseSchema,
  type RotateOpenKitAccessTokenRequest,
  RotateOpenKitAccessTokenRequestSchema,
  type RotateOpenKitAccessTokenResponse,
  RotateOpenKitAccessTokenResponseSchema,
  type RotateWorkspaceVaultSecretRequest,
  RotateWorkspaceVaultSecretRequestSchema,
  type SaveWorkspaceMaterialRevisionRequest,
  SaveWorkspaceMaterialRevisionRequestSchema,
  type SaveWorkspaceMaterialRevisionResponse,
  SaveWorkspaceMaterialRevisionResponseSchema,
  type SelectWorkerEnvironmentRequest,
  SelectWorkerEnvironmentRequestSchema,
  type SelectWorkerEnvironmentResponse,
  SelectWorkerEnvironmentResponseSchema,
  type SetMyAdminAccessTokenDefaultRequest,
  SetMyAdminAccessTokenDefaultRequestSchema,
  type SetMyAdminAccessTokenDefaultResponse,
  SetMyAdminAccessTokenDefaultResponseSchema,
  type SetProviderApiKeyRequest,
  SetProviderApiKeyRequestSchema,
  type SetProviderApiKeyResponse,
  SetProviderApiKeyResponseSchema,
  type SetupDiagnosticsResponse,
  SetupDiagnosticsResponseSchema,
  type StartAppUpdateRequest,
  StartAppUpdateRequestSchema,
  type SubmitAdministrationConversationRequest,
  SubmitAdministrationConversationRequestSchema,
  type SubmitAdministrationConversationResponse,
  SubmitAdministrationConversationResponseSchema,
  type SubmitKnowledgeProposalDecisionRequest,
  type UnbindThreadMaterialRequest,
  UnbindThreadMaterialRequestSchema,
  type UnbindThreadMaterialResponse,
  UnbindThreadMaterialResponseSchema,
  type VaultAdminBootstrapCodexAuthJsonRequest,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  type VaultAdminBootstrapCodexAuthJsonResponse,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  type VaultAdminListWorkspaceReferencesResponse,
  VaultAdminListWorkspaceReferencesResponseSchema,
  type VaultAdminLockResponse,
  VaultAdminLockResponseSchema,
  type VaultAdminRebindWorkspaceReferenceRequest,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  type VaultAdminRebindWorkspaceReferenceResponse,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  type VaultAdminStatusResponse,
  VaultAdminStatusResponseSchema,
  type VaultAdminUnlockRequest,
  VaultAdminUnlockRequestSchema,
  type VaultAdminUnlockResponse,
  VaultAdminUnlockResponseSchema,
  type VaultAdminWorkspaceReference,
  VaultAdminWorkspaceReferenceSchema,
  type WorkspaceImportDryRunResponse,
  WorkspaceImportDryRunResponseSchema,
  type WorkspaceImportResponse,
  WorkspaceImportResponseSchema,
  type WorkspaceSharingError,
  WorkspaceSharingErrorSchema,
  type WorkspaceVaultGrant,
  WorkspaceVaultGrantSchema,
} from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { ApiCallError } from './errors.js';
import { createRequestId, type OptionalRequestId, withRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Workspace Material create input with optional caller-provided request id. */
export type CreateWorkspaceMaterialInput = OptionalRequestId<CreateWorkspaceMaterialRequest>;
/** Workspace Material revision save input with optional caller-provided request id. */
export type SaveWorkspaceMaterialRevisionInput =
  OptionalRequestId<SaveWorkspaceMaterialRevisionRequest>;
/** Thread Material bind input with optional caller-provided request id. */
export type BindThreadMaterialInput = OptionalRequestId<BindThreadMaterialRequest>;
/** Thread Material unbind input with optional caller-provided request id. */
export type UnbindThreadMaterialInput = OptionalRequestId<UnbindThreadMaterialRequest>;
/** Thread Material exclusion input with optional caller-provided request id. */
export type ExcludeThreadMaterialInput = OptionalRequestId<ExcludeThreadMaterialRequest>;
/** Thread Material restore input with optional caller-provided request id. */
export type RestoreThreadMaterialInput = OptionalRequestId<RestoreThreadMaterialRequest>;
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
  /** Lists one bounded page of currently authorized retained Worker environments. */
  listWorkerEnvironments(
    workspaceId: string,
    query?: Partial<ListWorkerEnvironmentsQuery>
  ): Promise<ListWorkerEnvironmentsResponse>;
  /** Rechecks one explicit retained Worker environment selection. */
  selectWorkerEnvironment(
    workspaceId: string,
    input: SelectWorkerEnvironmentRequest
  ): Promise<SelectWorkerEnvironmentResponse>;
  /** Prepares one immutable Worker environment candidate without interrupting work. */
  prepareWorkerEnvironment(
    input: PrepareWorkerEnvironmentRequest
  ): Promise<PrepareWorkerEnvironmentResponse>;
  /** Activates one exact human-confirmed prepared Worker environment candidate. */
  activateWorkerEnvironment(
    input: ActivateWorkerEnvironmentRequest
  ): Promise<ActivateWorkerEnvironmentResponse>;
  /** Reads current Core and host facts for one exact retained Worker environment. */
  getWorkerEnvironmentStatus(
    workspaceId: string,
    storageRef: string
  ): Promise<GetWorkerEnvironmentStatusResponse>;
  /** Purges one exact idle retained Worker environment. */
  purgeWorkerEnvironment(
    workspaceId: string,
    storageRef: string,
    input: PurgeWorkerEnvironmentRequest
  ): Promise<PurgeWorkerEnvironmentResponse>;
  /** Applies an exact human-confirmed catalog candidate after current server authorization. */
  applyAdministrationConfiguration(
    input: ApplyAdministrationConfigurationRequest
  ): Promise<ApplyAdministrationConfigurationResponse>;
  /** Submits one private system-administration conversation turn. */
  submitAdministrationConversation(
    input: SubmitAdministrationConversationRequest
  ): Promise<SubmitAdministrationConversationResponse>;
  /** Lists Workspace Materials. */
  listWorkspaceMaterials(workspaceId: string): Promise<ListWorkspaceMaterialsResponse>;
  /** Creates one Workspace Material. */
  createWorkspaceMaterial(
    workspaceId: string,
    input: CreateWorkspaceMaterialInput
  ): Promise<CreateWorkspaceMaterialResponse>;
  /** Reads one Workspace Material. */
  getWorkspaceMaterial(
    workspaceId: string,
    materialId: string
  ): Promise<GetWorkspaceMaterialResponse>;
  /** Lists immutable revisions for one Workspace Material. */
  listWorkspaceMaterialRevisions(
    workspaceId: string,
    materialId: string
  ): Promise<ListWorkspaceMaterialRevisionsResponse>;
  /** Saves one immutable Workspace Material revision. */
  saveWorkspaceMaterialRevision(
    workspaceId: string,
    materialId: string,
    input: SaveWorkspaceMaterialRevisionInput
  ): Promise<SaveWorkspaceMaterialRevisionResponse>;
  /** Reads one exact Workspace Material revision. */
  getWorkspaceMaterialRevision(
    workspaceId: string,
    materialId: string,
    revisionId: string
  ): Promise<GetWorkspaceMaterialRevisionResponse>;
  /** Reads the singular Material projection for one Thread. */
  getThreadMaterial(workspaceId: string, threadId: string): Promise<GetThreadMaterialResponse>;
  /** Binds one Workspace Material to a Thread. */
  bindThreadMaterial(
    workspaceId: string,
    threadId: string,
    materialId: string,
    input: BindThreadMaterialInput
  ): Promise<BindThreadMaterialResponse>;
  /** Unbinds one Workspace Material from a Thread. */
  unbindThreadMaterial(
    workspaceId: string,
    threadId: string,
    materialId: string,
    input: UnbindThreadMaterialInput
  ): Promise<UnbindThreadMaterialResponse>;
  /** Excludes one bound Workspace Material from worker context. */
  excludeThreadMaterial(
    workspaceId: string,
    threadId: string,
    materialId: string,
    input: ExcludeThreadMaterialInput
  ): Promise<ExcludeThreadMaterialResponse>;
  /** Restores one bound Workspace Material to worker context. */
  restoreThreadMaterial(
    workspaceId: string,
    threadId: string,
    materialId: string,
    input: RestoreThreadMaterialInput
  ): Promise<RestoreThreadMaterialResponse>;
  /** Lists durable Agent Environment Package snapshots for one workspace. */
  listAgentEnvironmentPackageSnapshots(
    workspaceId: string
  ): Promise<ListAgentEnvironmentPackageSnapshotsResponse>;
  /** Reads one durable Agent Environment Package snapshot by id. */
  getAgentEnvironmentPackageSnapshot(
    workspaceId: string,
    snapshotId: string
  ): Promise<GetAgentEnvironmentPackageSnapshotResponse>;
  /** Reads Settings diagnostics. */
  getDiagnostics(): Promise<AppDiagnosticsResponse>;
  /** Stores or replaces one authored provider profile's Vault-backed API key. */
  setProviderApiKey(
    providerId: string,
    input: SetProviderApiKeyRequest
  ): Promise<SetProviderApiKeyResponse>;
  /** Reads setup diagnostics. */
  getSetupDiagnostics(): Promise<SetupDiagnosticsResponse>;
  /** Prepares one closed App-update source without replacing the running App. */
  prepareAppUpdate(input: PrepareAppUpdateRequest): Promise<PrepareAppUpdateResponse>;
  /** Starts one prepared App-update receipt after explicit maintenance consent. */
  startAppUpdate(input: StartAppUpdateRequest): Promise<AppUpdateStatusResponse>;
  /** Reads one host-owned App-update receipt by id. */
  getAppUpdateStatus(requestId: string): Promise<AppUpdateStatusResponse>;
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
  /** Creates a workspace secret using request-only material. */
  createWorkspaceVaultSecret(
    workspaceId: string,
    input: CreateWorkspaceVaultSecretRequest
  ): Promise<VaultAdminWorkspaceReference>;
  /** Rotates material without changing reference or grant identity. */
  rotateWorkspaceVaultSecret(
    workspaceId: string,
    referenceId: string,
    input: RotateWorkspaceVaultSecretRequest
  ): Promise<VaultAdminWorkspaceReference>;
  /** Destroys material and revokes dependent grants. */
  revokeWorkspaceVaultSecret(
    workspaceId: string,
    referenceId: string
  ): Promise<VaultAdminWorkspaceReference>;
  /** Creates a workspace grant for approved host-side Git push. */
  createWorkspaceVaultGrant(
    workspaceId: string,
    input: CreateWorkspaceVaultGrantRequest
  ): Promise<WorkspaceVaultGrant>;
  /** Revokes a workspace grant and dependent injection state. */
  revokeWorkspaceVaultGrant(workspaceId: string, grantId: string): Promise<WorkspaceVaultGrant>;
  /** Reads redacted vault admin status. */
  getVaultAdminStatus(): Promise<VaultAdminStatusResponse>;
  /** Unlocks the configured vault backend. */
  unlockVaultAdminBackend(input: VaultAdminUnlockInput): Promise<VaultAdminUnlockResponse>;
  /** Locks the configured vault backend. */
  lockVaultAdminBackend(): Promise<VaultAdminLockResponse>;
  /** Bootstraps Codex auth JSON into the unlocked vault. */
  bootstrapCodexAuthJsonVaultReference(
    input: VaultAdminBootstrapCodexAuthJsonInput
  ): Promise<VaultAdminBootstrapCodexAuthJsonResponse>;
  /** Reads workspace capability-call and usage evidence. */
  getCapabilityUsage(workspaceId: string): Promise<CapabilityUsageResponse>;
  /** Lists workspace evidence bundles. */
  listWorkspaceEvidenceBundles(workspaceId: string): Promise<ListWorkspaceEvidenceBundlesResponse>;
  /** Lists workspace runtime evidence. */
  listWorkspaceRuntimeEvidence(workspaceId: string): Promise<ListWorkspaceRuntimeEvidenceResponse>;
  /** Lists workspace audit events. */
  listWorkspaceAuditEvents(workspaceId: string): Promise<ListWorkspaceAuditEventsResponse>;
  /** Lists server audit events. */
  listServerAuditEvents(): Promise<ListServerAuditEventsResponse>;
  /** Lists workspace permission decisions. */
  listWorkspacePermissionDecisions(
    workspaceId: string
  ): Promise<ListWorkspacePermissionDecisionsResponse>;
  /** Lists server permission decisions. */
  listServerPermissionDecisions(): Promise<ListServerPermissionDecisionsResponse>;
  /** Downloads one verified Workspace export as a raw archive stream. */
  downloadWorkspaceExportArchive(
    workspaceId: string,
    exportId: string
  ): Promise<ReadableStream<Uint8Array>>;
  /** Verifies one raw Workspace archive stream without importing it. */
  dryRunWorkspaceArchiveImport(body: BodyInit): Promise<WorkspaceImportDryRunResponse>;
  /** Imports one raw Workspace archive stream with a caller-selected or generated request id. */
  importWorkspaceArchive(body: BodyInit, requestId?: string): Promise<WorkspaceImportResponse>;
  /** Lists redacted workspace vault references. */
  listWorkspaceVaultReferences(
    workspaceId: string
  ): Promise<VaultAdminListWorkspaceReferencesResponse>;
  /** Lists non-secret workspace vault grants. */
  listWorkspaceVaultGrants(workspaceId: string): Promise<ListWorkspaceVaultGrantsResponse>;
  /** Lists non-secret workspace injection plans. */
  listWorkspaceVaultInjectionPlans(
    workspaceId: string
  ): Promise<ListWorkspaceVaultInjectionPlansResponse>;
  /** Lists non-secret workspace injection receipts. */
  listWorkspaceVaultInjectionReceipts(
    workspaceId: string
  ): Promise<ListWorkspaceVaultInjectionReceiptsResponse>;
  /** Lists redacted workspace vault use records. */
  listWorkspaceVaultUseRecords(workspaceId: string): Promise<ListWorkspaceVaultUseRecordsResponse>;
  /** Lists redacted server vault use records. */
  listServerVaultUseRecords(): Promise<ListServerVaultUseRecordsResponse>;
  /** Rebinds one imported workspace vault reference to local vault material. */
  rebindWorkspaceVaultReference(
    workspaceId: string,
    referenceId: string,
    input: VaultAdminRebindWorkspaceReferenceRequest
  ): Promise<VaultAdminRebindWorkspaceReferenceResponse>;
  /** Searches App API read models. */
  search(query: string): Promise<AppSearchResponse>;
}

/** Creates the NanoCore App API client. */
export function createAppApiClient(transport: ClientTransport): AppApiClient {
  return {
    listWorkerEnvironments: (workspaceId, query = {}) => {
      const parsed = ListWorkerEnvironmentsQuerySchema.parse(query);
      const parameters = new URLSearchParams({ limit: String(parsed.limit) });
      if (parsed.after) parameters.set('after', parsed.after);
      return transport.getJson(
        `/api/app/workspaces/${workspaceId}/worker-environments?${parameters.toString()}`,
        ListWorkerEnvironmentsResponseSchema
      );
    },
    selectWorkerEnvironment: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/worker-environments/select`,
        SelectWorkerEnvironmentRequestSchema.parse(input),
        SelectWorkerEnvironmentResponseSchema
      ),
    prepareWorkerEnvironment: (input) =>
      transport.postJson(
        '/api/app/worker-environments/prepare',
        PrepareWorkerEnvironmentRequestSchema.parse(input),
        PrepareWorkerEnvironmentResponseSchema
      ),
    activateWorkerEnvironment: (input) =>
      transport.postJson(
        '/api/app/worker-environments/activate',
        ActivateWorkerEnvironmentRequestSchema.parse(input),
        ActivateWorkerEnvironmentResponseSchema
      ),
    getWorkerEnvironmentStatus: (workspaceId, storageRef) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/worker-environments/${storageRef}/status`,
        GetWorkerEnvironmentStatusResponseSchema
      ),
    purgeWorkerEnvironment: (workspaceId, storageRef, input) => {
      const parsed = PurgeWorkerEnvironmentRequestSchema.parse(input);
      if (parsed.storageRef !== storageRef) {
        throw new TypeError('Worker environment purge path and body references must match.');
      }
      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/worker-environments/${storageRef}/purge`,
        parsed,
        PurgeWorkerEnvironmentResponseSchema
      );
    },
    applyAdministrationConfiguration: (input) =>
      transport.postJson(
        '/api/app/administration/configuration/apply',
        ApplyAdministrationConfigurationRequestSchema.parse(input),
        ApplyAdministrationConfigurationResponseSchema
      ),
    submitAdministrationConversation: (input) =>
      transport.postJson(
        '/api/app/administration/conversation-turns',
        SubmitAdministrationConversationRequestSchema.parse(input),
        SubmitAdministrationConversationResponseSchema
      ),
    listWorkspaceMaterials: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/materials`,
        ListWorkspaceMaterialsResponseSchema
      ),
    createWorkspaceMaterial: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/materials`,
        CreateWorkspaceMaterialRequestSchema.parse(request),
        CreateWorkspaceMaterialResponseSchema
      );
    },
    getWorkspaceMaterial: (workspaceId, materialId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/materials/${materialId}`,
        GetWorkspaceMaterialResponseSchema
      ),
    listWorkspaceMaterialRevisions: (workspaceId, materialId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/materials/${materialId}/revisions`,
        ListWorkspaceMaterialRevisionsResponseSchema
      ),
    saveWorkspaceMaterialRevision: (workspaceId, materialId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/materials/${materialId}/revisions`,
        SaveWorkspaceMaterialRevisionRequestSchema.parse(request),
        SaveWorkspaceMaterialRevisionResponseSchema
      );
    },
    getWorkspaceMaterialRevision: (workspaceId, materialId, revisionId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/materials/${materialId}/revisions/${revisionId}`,
        GetWorkspaceMaterialRevisionResponseSchema
      ),
    getThreadMaterial: (workspaceId, threadId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/material`,
        GetThreadMaterialResponseSchema
      ),
    bindThreadMaterial: (workspaceId, threadId, materialId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/materials/${materialId}/bind`,
        BindThreadMaterialRequestSchema.parse(request),
        BindThreadMaterialResponseSchema
      );
    },
    unbindThreadMaterial: (workspaceId, threadId, materialId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/materials/${materialId}/unbind`,
        UnbindThreadMaterialRequestSchema.parse(request),
        UnbindThreadMaterialResponseSchema
      );
    },
    excludeThreadMaterial: (workspaceId, threadId, materialId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/materials/${materialId}/exclude`,
        ExcludeThreadMaterialRequestSchema.parse(request),
        ExcludeThreadMaterialResponseSchema
      );
    },
    restoreThreadMaterial: (workspaceId, threadId, materialId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/materials/${materialId}/restore`,
        RestoreThreadMaterialRequestSchema.parse(request),
        RestoreThreadMaterialResponseSchema
      );
    },
    listAgentEnvironmentPackageSnapshots: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/agent-environment/snapshots`,
        ListAgentEnvironmentPackageSnapshotsResponseSchema
      ),
    getAgentEnvironmentPackageSnapshot: (workspaceId, snapshotId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/agent-environment/snapshots/${snapshotId}`,
        GetAgentEnvironmentPackageSnapshotResponseSchema
      ),
    getDiagnostics: () => transport.getJson('/api/app/diagnostics', AppDiagnosticsResponseSchema),
    setProviderApiKey: (providerId, input) =>
      transport.putJson(
        `/api/app/providers/${encodeURIComponent(providerId)}/api-key`,
        SetProviderApiKeyRequestSchema.parse(input),
        SetProviderApiKeyResponseSchema
      ),
    getSetupDiagnostics: () =>
      transport.getJson('/api/setup/diagnostics', SetupDiagnosticsResponseSchema),
    prepareAppUpdate: (input) =>
      transport.postJson(
        '/api/app/app-update/prepare',
        PrepareAppUpdateRequestSchema.parse(input),
        PrepareAppUpdateResponseSchema
      ),
    startAppUpdate: (input) =>
      transport.postJson(
        '/api/app/app-update/start',
        StartAppUpdateRequestSchema.parse(input),
        AppUpdateStatusResponseSchema
      ),
    getAppUpdateStatus: (requestId) =>
      transport.getJson(
        `/api/app/app-update/${encodeURIComponent(requestId)}`,
        AppUpdateStatusResponseSchema
      ),
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
    createWorkspaceVaultSecret: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${encodeURIComponent(workspaceId)}/vault/secrets`,
        CreateWorkspaceVaultSecretRequestSchema.parse(input),
        VaultAdminWorkspaceReferenceSchema
      ),
    rotateWorkspaceVaultSecret: (workspaceId, referenceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${encodeURIComponent(workspaceId)}/vault/secrets/${encodeURIComponent(referenceId)}/rotate`,
        RotateWorkspaceVaultSecretRequestSchema.parse(input),
        VaultAdminWorkspaceReferenceSchema
      ),
    revokeWorkspaceVaultSecret: (workspaceId, referenceId) =>
      transport.postJson(
        `/api/app/workspaces/${encodeURIComponent(workspaceId)}/vault/secrets/${encodeURIComponent(referenceId)}/revoke`,
        {},
        VaultAdminWorkspaceReferenceSchema
      ),
    createWorkspaceVaultGrant: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${encodeURIComponent(workspaceId)}/vault/grants`,
        CreateWorkspaceVaultGrantRequestSchema.parse(input),
        WorkspaceVaultGrantSchema
      ),
    revokeWorkspaceVaultGrant: (workspaceId, grantId) =>
      transport.postJson(
        `/api/app/workspaces/${encodeURIComponent(workspaceId)}/vault/grants/${encodeURIComponent(grantId)}/revoke`,
        {},
        WorkspaceVaultGrantSchema
      ),
    getVaultAdminStatus: () =>
      transport.getJson('/api/app/vault/status', VaultAdminStatusResponseSchema),
    unlockVaultAdminBackend: (input) =>
      transport.postJson(
        '/api/app/vault/unlock',
        VaultAdminUnlockRequestSchema.parse(input),
        VaultAdminUnlockResponseSchema
      ),
    lockVaultAdminBackend: () =>
      transport.postJson('/api/app/vault/lock', {}, VaultAdminLockResponseSchema),
    bootstrapCodexAuthJsonVaultReference: (input) =>
      transport.postJson(
        '/api/app/vault/bootstrap/codex-auth-json',
        VaultAdminBootstrapCodexAuthJsonRequestSchema.parse(input),
        VaultAdminBootstrapCodexAuthJsonResponseSchema
      ),
    getCapabilityUsage: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/capability-usage`,
        CapabilityUsageResponseSchema
      ),
    listWorkspaceEvidenceBundles: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/evidence-bundles`,
        ListWorkspaceEvidenceBundlesResponseSchema
      ),
    listWorkspaceRuntimeEvidence: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/runtime-evidence`,
        ListWorkspaceRuntimeEvidenceResponseSchema
      ),
    listWorkspaceAuditEvents: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/audit/events`,
        ListWorkspaceAuditEventsResponseSchema
      ),
    listServerAuditEvents: () =>
      transport.getJson('/api/app/audit/events', ListServerAuditEventsResponseSchema),
    listWorkspacePermissionDecisions: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/permission-decisions`,
        ListWorkspacePermissionDecisionsResponseSchema
      ),
    listServerPermissionDecisions: () =>
      transport.getJson(
        '/api/app/permission-decisions',
        ListServerPermissionDecisionsResponseSchema
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
    listWorkspaceVaultReferences: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/references`,
        VaultAdminListWorkspaceReferencesResponseSchema
      ),
    listWorkspaceVaultGrants: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/grants`,
        ListWorkspaceVaultGrantsResponseSchema
      ),
    listWorkspaceVaultInjectionPlans: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/injection-plans`,
        ListWorkspaceVaultInjectionPlansResponseSchema
      ),
    listWorkspaceVaultInjectionReceipts: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/injection-receipts`,
        ListWorkspaceVaultInjectionReceiptsResponseSchema
      ),
    listWorkspaceVaultUseRecords: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/use-records`,
        ListWorkspaceVaultUseRecordsResponseSchema
      ),
    listServerVaultUseRecords: () =>
      transport.getJson('/api/app/vault/use-records', ListServerVaultUseRecordsResponseSchema),
    rebindWorkspaceVaultReference: (workspaceId, referenceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/vault/references/${referenceId}/rebind`,
        VaultAdminRebindWorkspaceReferenceRequestSchema.parse(input),
        VaultAdminRebindWorkspaceReferenceResponseSchema
      ),
    search: (query) =>
      transport.getJson(`/api/app/search?q=${encodeURIComponent(query)}`, AppSearchResponseSchema),
  };
}
