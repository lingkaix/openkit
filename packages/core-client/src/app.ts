import {
  type AcceptWorkspaceInvitationRequest,
  AcceptWorkspaceInvitationRequestSchema,
  type AppDiagnosticsResponse,
  AppDiagnosticsResponseSchema,
  type ApproveThreadGoalPlanRequest,
  ApproveThreadGoalPlanRequestSchema,
  type ApproveThreadGoalPlanResponse,
  ApproveThreadGoalPlanResponseSchema,
  type AppSearchResponse,
  AppSearchResponseSchema,
  type AutomationRecord,
  AutomationRecordSchema,
  type BindThreadMaterialRequest,
  BindThreadMaterialRequestSchema,
  type BindThreadMaterialResponse,
  BindThreadMaterialResponseSchema,
  type CancelGoalSteeringRequest,
  CancelGoalSteeringRequestSchema,
  type CancelGoalSteeringResponse,
  CancelGoalSteeringResponseSchema,
  type CancelSchedulerAdmissionResponse,
  CancelSchedulerAdmissionResponseSchema,
  type CapabilityUsageResponse,
  CapabilityUsageResponseSchema,
  type ChangeWorkspaceMemberAccessRequest,
  ChangeWorkspaceMemberAccessRequestSchema,
  type ConsumeOpenKitBootstrapTokenRequest,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  type ConsumeOpenKitBootstrapTokenResponse,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  type ConvertGoalSteeringToFollowUpRequest,
  ConvertGoalSteeringToFollowUpRequestSchema,
  type ConvertGoalSteeringToFollowUpResponse,
  ConvertGoalSteeringToFollowUpResponseSchema,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type CreateOpenKitAccessTokenRequest,
  CreateOpenKitAccessTokenRequestSchema,
  type CreateOpenKitAccessTokenResponse,
  CreateOpenKitAccessTokenResponseSchema,
  type CreateThreadGoalPlanRequest,
  CreateThreadGoalPlanRequestSchema,
  type CreateThreadGoalPlanResponse,
  CreateThreadGoalPlanResponseSchema,
  type CreateWorkspaceInvitationRequest,
  CreateWorkspaceInvitationRequestSchema,
  type CreateWorkspaceMaterialRequest,
  CreateWorkspaceMaterialRequestSchema,
  type CreateWorkspaceMaterialResponse,
  CreateWorkspaceMaterialResponseSchema,
  type DataRootBackupCreateResponse,
  DataRootBackupCreateResponseSchema,
  type DataRootBackupVerifyResponse,
  DataRootBackupVerifyResponseSchema,
  type DeclineWorkspaceInvitationRequest,
  DeclineWorkspaceInvitationRequestSchema,
  type DisableUserRequest,
  DisableUserRequestSchema,
  type DisableUserResponse,
  DisableUserResponseSchema,
  type ExcludeThreadMaterialRequest,
  ExcludeThreadMaterialRequestSchema,
  type ExcludeThreadMaterialResponse,
  ExcludeThreadMaterialResponseSchema,
  type GetAgentEnvironmentPackageSnapshotResponse,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  type GetThreadMaterialResponse,
  GetThreadMaterialResponseSchema,
  type GetWorkspaceApplyResultResponse,
  GetWorkspaceApplyResultResponseSchema,
  type GetWorkspaceMaterialResponse,
  GetWorkspaceMaterialResponseSchema,
  type GetWorkspaceMaterialRevisionResponse,
  GetWorkspaceMaterialRevisionResponseSchema,
  type GetWorkspaceSyncReviewResponse,
  GetWorkspaceSyncReviewResponseSchema,
  type ImportWorkspaceArtifactRequest,
  ImportWorkspaceArtifactRequestSchema,
  type ImportWorkspaceArtifactResponse,
  ImportWorkspaceArtifactResponseSchema,
  type IntroduceWorkspaceArtifactRequest,
  IntroduceWorkspaceArtifactRequestSchema,
  type IntroduceWorkspaceArtifactResponse,
  IntroduceWorkspaceArtifactResponseSchema,
  type KnowledgeDerivedIndexesResponse,
  KnowledgeDerivedIndexesResponseSchema,
  type KnowledgeManagerAnswerRequest,
  KnowledgeManagerAnswerRequestSchema,
  type KnowledgeManagerAnswerResponse,
  KnowledgeManagerAnswerResponseSchema,
  type KnowledgeManagerDraftProposalRequest,
  KnowledgeManagerDraftProposalRequestSchema,
  type KnowledgeManagerDraftProposalResponse,
  KnowledgeManagerDraftProposalResponseSchema,
  type KnowledgeManagerHealthCheckRequest,
  KnowledgeManagerHealthCheckRequestSchema,
  type KnowledgeManagerHealthCheckResponse,
  KnowledgeManagerHealthCheckResponseSchema,
  type KnowledgeManagerPrepareContextRequest,
  KnowledgeManagerPrepareContextRequestSchema,
  type KnowledgeManagerPrepareContextResponse,
  KnowledgeManagerPrepareContextResponseSchema,
  type KnowledgeManagerSuggestRepairRequest,
  KnowledgeManagerSuggestRepairRequestSchema,
  type KnowledgeManagerSuggestRepairResponse,
  KnowledgeManagerSuggestRepairResponseSchema,
  type KnowledgeRetrievalResponse,
  KnowledgeRetrievalResponseSchema,
  type LeaveWorkspaceRequest,
  LeaveWorkspaceRequestSchema,
  type ListAgentEnvironmentPackageSnapshotsResponse,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  type ListArtifactReviewsResponse,
  ListArtifactReviewsResponseSchema,
  type ListAuthorizedWorkspacesResponse,
  ListAuthorizedWorkspacesResponseSchema,
  type ListAutomationsResponse,
  ListAutomationsResponseSchema,
  type ListBackendWorkspaceHandlesResponse,
  ListBackendWorkspaceHandlesResponseSchema,
  type ListInterruptedWorkerStatesResponse,
  ListInterruptedWorkerStatesResponseSchema,
  type ListKnowledgeClaimsResponse,
  ListKnowledgeClaimsResponseSchema,
  type ListKnowledgeConflictsResponse,
  ListKnowledgeConflictsResponseSchema,
  type ListKnowledgeObservationsResponse,
  ListKnowledgeObservationsResponseSchema,
  type ListKnowledgeSourcesResponse,
  ListKnowledgeSourcesResponseSchema,
  type ListOpenKitAccessTokensResponse,
  ListOpenKitAccessTokensResponseSchema,
  type ListSchedulerAdmissionsResponse,
  ListSchedulerAdmissionsResponseSchema,
  type ListServerAuditEventsResponse,
  ListServerAuditEventsResponseSchema,
  type ListServerPermissionDecisionsResponse,
  ListServerPermissionDecisionsResponseSchema,
  type ListServerVaultUseRecordsResponse,
  ListServerVaultUseRecordsResponseSchema,
  type ListStagedWorkspaceReviewsResponse,
  ListStagedWorkspaceReviewsResponseSchema,
  type ListWorkerOutputManifestsResponse,
  ListWorkerOutputManifestsResponseSchema,
  type ListWorkspaceApplyPlansResponse,
  ListWorkspaceApplyPlansResponseSchema,
  type ListWorkspaceApplyResultsResponse,
  ListWorkspaceApplyResultsResponseSchema,
  type ListWorkspaceAuditEventsResponse,
  ListWorkspaceAuditEventsResponseSchema,
  type ListWorkspaceChangeSetsResponse,
  ListWorkspaceChangeSetsResponseSchema,
  type ListWorkspaceEvidenceBundlesResponse,
  ListWorkspaceEvidenceBundlesResponseSchema,
  type ListWorkspaceInjectionPlansResponse,
  ListWorkspaceInjectionPlansResponseSchema,
  type ListWorkspaceInjectionReceiptsResponse,
  ListWorkspaceInjectionReceiptsResponseSchema,
  type ListWorkspaceInputSnapshotsResponse,
  ListWorkspaceInputSnapshotsResponseSchema,
  type ListWorkspaceInvitationsResponse,
  ListWorkspaceInvitationsResponseSchema,
  type ListWorkspaceMaterializationRecordsResponse,
  ListWorkspaceMaterializationRecordsResponseSchema,
  type ListWorkspaceMaterialRevisionsResponse,
  ListWorkspaceMaterialRevisionsResponseSchema,
  type ListWorkspaceMaterialsResponse,
  ListWorkspaceMaterialsResponseSchema,
  type ListWorkspaceMembersResponse,
  ListWorkspaceMembersResponseSchema,
  type ListWorkspacePermissionDecisionsResponse,
  ListWorkspacePermissionDecisionsResponseSchema,
  type ListWorkspaceQuarantineRecordsResponse,
  ListWorkspaceQuarantineRecordsResponseSchema,
  type ListWorkspaceReconciliationRecordsResponse,
  ListWorkspaceReconciliationRecordsResponseSchema,
  type ListWorkspaceRuntimeEvidenceResponse,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  type ListWorkspaceSyncReviewsResponse,
  ListWorkspaceSyncReviewsResponseSchema,
  type ListWorkspaceVaultGrantsResponse,
  ListWorkspaceVaultGrantsResponseSchema,
  type ListWorkspaceVaultUseRecordsResponse,
  ListWorkspaceVaultUseRecordsResponseSchema,
  type PauseThreadGoalRequest,
  PauseThreadGoalRequestSchema,
  type PauseThreadGoalResponse,
  PauseThreadGoalResponseSchema,
  type QuickChatRequest,
  QuickChatRequestSchema,
  type QuickChatResponse,
  QuickChatResponseSchema,
  type ReadKnowledgeSourceResponse,
  ReadKnowledgeSourceResponseSchema,
  type RecordKnowledgeClaimRequest,
  RecordKnowledgeClaimRequestSchema,
  type RecordKnowledgeClaimResponse,
  RecordKnowledgeClaimResponseSchema,
  type RecordKnowledgeConflictRequest,
  RecordKnowledgeConflictRequestSchema,
  type RecordKnowledgeConflictResponse,
  RecordKnowledgeConflictResponseSchema,
  type RecordKnowledgeObservationRequest,
  RecordKnowledgeObservationRequestSchema,
  type RecordKnowledgeObservationResponse,
  RecordKnowledgeObservationResponseSchema,
  type RecoverWorkspaceAccessRequest,
  RecoverWorkspaceAccessRequestSchema,
  type RegisterKnowledgeSourceRequest,
  RegisterKnowledgeSourceRequestSchema,
  type RegisterKnowledgeSourceResponse,
  RegisterKnowledgeSourceResponseSchema,
  type RemoveWorkspaceMemberRequest,
  RemoveWorkspaceMemberRequestSchema,
  type ResolveKnowledgeConflictRequest,
  ResolveKnowledgeConflictRequestSchema,
  type ResolveKnowledgeConflictResponse,
  ResolveKnowledgeConflictResponseSchema,
  type RestoreThreadMaterialRequest,
  RestoreThreadMaterialRequestSchema,
  type RestoreThreadMaterialResponse,
  RestoreThreadMaterialResponseSchema,
  type ResumeThreadGoalRequest,
  ResumeThreadGoalRequestSchema,
  type ResumeThreadGoalResponse,
  ResumeThreadGoalResponseSchema,
  type RetrieveKnowledgeRequest,
  RetrieveKnowledgeRequestSchema,
  type RetryInterruptedWorkerCheckpointRequest,
  RetryInterruptedWorkerCheckpointRequestSchema,
  type RetryInterruptedWorkerCheckpointResponse,
  RetryInterruptedWorkerCheckpointResponseSchema,
  type RetrySchedulerAdmissionResponse,
  RetrySchedulerAdmissionResponseSchema,
  type ReverseKnowledgeProposalRequest,
  ReverseKnowledgeProposalRequestSchema,
  type ReverseKnowledgeProposalResponse,
  ReverseKnowledgeProposalResponseSchema,
  type ReviseThreadGoalPlanRequest,
  ReviseThreadGoalPlanRequestSchema,
  type ReviseThreadGoalPlanResponse,
  ReviseThreadGoalPlanResponseSchema,
  type RevokeOpenKitAccessTokenResponse,
  RevokeOpenKitAccessTokenResponseSchema,
  type RevokeWorkspaceInvitationRequest,
  RevokeWorkspaceInvitationRequestSchema,
  type RotateOpenKitAccessTokenRequest,
  RotateOpenKitAccessTokenRequestSchema,
  type RotateOpenKitAccessTokenResponse,
  RotateOpenKitAccessTokenResponseSchema,
  type RunThreadGoalStepRequest,
  RunThreadGoalStepRequestSchema,
  type RunThreadGoalStepResponse,
  RunThreadGoalStepResponseSchema,
  type SaveWorkspaceMaterialRevisionRequest,
  SaveWorkspaceMaterialRevisionRequestSchema,
  type SaveWorkspaceMaterialRevisionResponse,
  SaveWorkspaceMaterialRevisionResponseSchema,
  type SetupDiagnosticsResponse,
  SetupDiagnosticsResponseSchema,
  type StartChatModeRequest,
  StartChatModeRequestSchema,
  type StartChatModeResponse,
  StartChatModeResponseSchema,
  type StartTaskModeRequest,
  StartTaskModeRequestSchema,
  type StartTaskModeResponse,
  StartTaskModeResponseSchema,
  type StartThreadGoalRequest,
  StartThreadGoalRequestSchema,
  type StartThreadGoalResponse,
  StartThreadGoalResponseSchema,
  type StorageLayoutReportResponse,
  StorageLayoutReportResponseSchema,
  type SubmitArtifactReviewDecisionRequest,
  SubmitArtifactReviewDecisionRequestSchema,
  type SubmitArtifactReviewDecisionResponse,
  SubmitArtifactReviewDecisionResponseSchema,
  type SubmitGoalReviewDecisionRequest,
  SubmitGoalReviewDecisionRequestSchema,
  type SubmitGoalReviewDecisionResponse,
  SubmitGoalReviewDecisionResponseSchema,
  type SubmitKnowledgeProposalDecisionRequest,
  SubmitKnowledgeProposalDecisionRequestSchema,
  type SubmitKnowledgeProposalDecisionResponse,
  SubmitKnowledgeProposalDecisionResponseSchema,
  type SubmitThreadGoalSteeringRequest,
  SubmitThreadGoalSteeringRequestSchema,
  type SubmitThreadGoalSteeringResponse,
  SubmitThreadGoalSteeringResponseSchema,
  type SubmitTurnFeedbackRequest,
  SubmitTurnFeedbackRequestSchema,
  type SubmitWorkspaceRecoveryDecisionRequest,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  type SubmitWorkspaceRecoveryDecisionResponse,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  type SubmitWorkspaceSyncReviewDecisionRequest,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  type SubmitWorkspaceSyncReviewDecisionResponse,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  type ThreadDashboardResponse,
  ThreadDashboardResponseSchema,
  type ThreadGoalSummaryResponse,
  ThreadGoalSummaryResponseSchema,
  type TransferWorkspaceOwnershipRequest,
  TransferWorkspaceOwnershipRequestSchema,
  type TurnFeedbackResponse,
  TurnFeedbackResponseSchema,
  type UnbindThreadMaterialRequest,
  UnbindThreadMaterialRequestSchema,
  type UnbindThreadMaterialResponse,
  UnbindThreadMaterialResponseSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
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
  type WorkspaceAccessRecoveryResponse,
  WorkspaceAccessRecoveryResponseSchema,
  type WorkspaceDashboardResponse,
  WorkspaceDashboardResponseSchema,
  type WorkspaceExportResponse,
  WorkspaceExportResponseSchema,
  type WorkspaceImportDryRunRequest,
  WorkspaceImportDryRunRequestSchema,
  type WorkspaceImportDryRunResponse,
  WorkspaceImportDryRunResponseSchema,
  type WorkspaceImportRequest,
  WorkspaceImportRequestSchema,
  type WorkspaceImportResponse,
  WorkspaceImportResponseSchema,
  type WorkspaceInvitationMutationResponse,
  WorkspaceInvitationMutationResponseSchema,
  type WorkspaceMemberMutationResponse,
  WorkspaceMemberMutationResponseSchema,
  type WorkspaceOwnershipMutationResponse,
  WorkspaceOwnershipMutationResponseSchema,
  type WorkspaceSharingError,
  WorkspaceSharingErrorSchema,
} from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { ApiCallError } from './errors.js';
import { createRequestId, type OptionalRequestId, withRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Goal Mode steering input with optional caller-provided request id. */
export type SubmitThreadGoalSteeringInput = OptionalRequestId<SubmitThreadGoalSteeringRequest>;
/** Goal steering follow-up conversion input with optional caller-provided request id. */
export type ConvertGoalSteeringToFollowUpInput =
  OptionalRequestId<ConvertGoalSteeringToFollowUpRequest>;
/** Goal steering cancellation input with optional caller-provided request id. */
export type CancelGoalSteeringInput = OptionalRequestId<CancelGoalSteeringRequest>;

/** Workspace invitation creation input with an optional caller-provided request id. */
export type CreateWorkspaceInvitationInput = OptionalRequestId<CreateWorkspaceInvitationRequest>;
/** Workspace invitation acceptance input with an optional caller-provided request id. */
export type AcceptWorkspaceInvitationInput = OptionalRequestId<AcceptWorkspaceInvitationRequest>;
/** Workspace invitation decline input with an optional caller-provided request id. */
export type DeclineWorkspaceInvitationInput = OptionalRequestId<DeclineWorkspaceInvitationRequest>;
/** Workspace invitation revocation input with an optional caller-provided request id. */
export type RevokeWorkspaceInvitationInput = OptionalRequestId<RevokeWorkspaceInvitationRequest>;
/** Workspace membership access-change input with an optional caller-provided request id. */
export type ChangeWorkspaceMemberAccessInput =
  OptionalRequestId<ChangeWorkspaceMemberAccessRequest>;
/** Workspace membership removal input with an optional caller-provided request id. */
export type RemoveWorkspaceMemberInput = OptionalRequestId<RemoveWorkspaceMemberRequest>;
/** Workspace leave input with an optional caller-provided request id. */
export type LeaveWorkspaceInput = OptionalRequestId<LeaveWorkspaceRequest>;
/** Workspace ownership-transfer input with an optional caller-provided request id. */
export type TransferWorkspaceOwnershipInput = OptionalRequestId<TransferWorkspaceOwnershipRequest>;
/** Workspace access-recovery input with an optional caller-provided request id. */
export type RecoverWorkspaceAccessInput = OptionalRequestId<RecoverWorkspaceAccessRequest>;
/** Canonical user-disable input with an optional caller-provided request id. */
export type DisableUserInput = OptionalRequestId<DisableUserRequest>;

/** Goal Mode real worker step input with optional caller-provided request id. */
export type RunThreadGoalStepInput = OptionalRequestId<RunThreadGoalStepRequest>;
/** Goal Mode pause input with optional caller-provided request id. */
export type PauseThreadGoalInput = OptionalRequestId<PauseThreadGoalRequest>;
/** Goal Mode resume input with optional caller-provided request id. */
export type ResumeThreadGoalInput = OptionalRequestId<ResumeThreadGoalRequest>;
/** Interrupted-worker retry input with optional caller-provided request id. */
export type RetryInterruptedWorkerCheckpointInput =
  OptionalRequestId<RetryInterruptedWorkerCheckpointRequest>;
/** Task Mode start input with optional caller-provided request id. */
export type StartTaskModeInput = OptionalRequestId<StartTaskModeRequest>;
/** Chat Mode start input with optional caller-provided request id. */
export type StartChatModeInput = OptionalRequestId<StartChatModeRequest>;
/** Goal Mode start input with optional caller-provided request id. */
export type StartThreadGoalInput = OptionalRequestId<StartThreadGoalRequest>;
/** Workspace Artifact import input with optional caller-provided request id. */
export type ImportWorkspaceArtifactInput = OptionalRequestId<ImportWorkspaceArtifactRequest>;
/** Workspace Artifact introduction input with optional caller-provided request id. */
export type IntroduceWorkspaceArtifactInput = OptionalRequestId<IntroduceWorkspaceArtifactRequest>;
/** Artifact Review decision input with optional caller-provided request id. */
export type SubmitArtifactReviewDecisionInput =
  OptionalRequestId<SubmitArtifactReviewDecisionRequest>;
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
/** Goal Review decision input with optional caller-provided request id. */
export type SubmitGoalReviewDecisionInput = Omit<SubmitGoalReviewDecisionRequest, 'requestId'> & {
  /** Optional caller-provided request id; the client generates one when omitted. */
  requestId?: SubmitGoalReviewDecisionRequest['requestId'];
};
/** Knowledge proposal decision input with its required caller-provided request id. */
export type SubmitKnowledgeProposalDecisionInput = SubmitKnowledgeProposalDecisionRequest;
/** Bounded Knowledge proposal reversal input. */
export type ReverseKnowledgeProposalInput = ReverseKnowledgeProposalRequest;
/** Durable workspace synchronization review decision input with optional caller-provided request id. */
export type SubmitWorkspaceSyncReviewDecisionInput = SubmitWorkspaceSyncReviewDecisionRequest;
/** Workspace recovery decision input with optional caller-provided request id. */
export type SubmitWorkspaceRecoveryDecisionInput = SubmitWorkspaceRecoveryDecisionRequest;
/** OpenKit server bootstrap token consumption input. */
export type ConsumeOpenKitBootstrapTokenInput = ConsumeOpenKitBootstrapTokenRequest;
/** OpenKit access-token issue input. */
export type CreateOpenKitAccessTokenInput = CreateOpenKitAccessTokenRequest;
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
  /** Lists workspaces authorized for the current principal. */
  listAuthorizedWorkspaces(): Promise<ListAuthorizedWorkspacesResponse>;
  /** Lists memberships for one workspace. */
  listWorkspaceMembers(workspaceId: string): Promise<ListWorkspaceMembersResponse>;
  /** Lists invitations issued for one workspace. */
  listWorkspaceInvitations(workspaceId: string): Promise<ListWorkspaceInvitationsResponse>;
  /** Creates one invitation for a workspace. */
  createWorkspaceInvitation(
    workspaceId: string,
    input: CreateWorkspaceInvitationInput
  ): Promise<WorkspaceInvitationMutationResponse>;
  /** Lists invitations addressed to the current principal. */
  listMyWorkspaceInvitations(): Promise<ListWorkspaceInvitationsResponse>;
  /** Accepts one invitation addressed to the current principal. */
  acceptWorkspaceInvitation(
    invitationId: string,
    input: AcceptWorkspaceInvitationInput
  ): Promise<WorkspaceInvitationMutationResponse>;
  /** Declines one invitation addressed to the current principal. */
  declineWorkspaceInvitation(
    invitationId: string,
    input: DeclineWorkspaceInvitationInput
  ): Promise<WorkspaceInvitationMutationResponse>;
  /** Revokes one invitation issued for a workspace. */
  revokeWorkspaceInvitation(
    workspaceId: string,
    invitationId: string,
    input: RevokeWorkspaceInvitationInput
  ): Promise<WorkspaceInvitationMutationResponse>;
  /** Changes one workspace member's access level. */
  changeWorkspaceMemberAccess(
    workspaceId: string,
    userId: string,
    input: ChangeWorkspaceMemberAccessInput
  ): Promise<WorkspaceMemberMutationResponse>;
  /** Removes one member from a workspace. */
  removeWorkspaceMember(
    workspaceId: string,
    userId: string,
    input: RemoveWorkspaceMemberInput
  ): Promise<WorkspaceMemberMutationResponse>;
  /** Removes the current principal from one workspace. */
  leaveWorkspace(
    workspaceId: string,
    input: LeaveWorkspaceInput
  ): Promise<WorkspaceMemberMutationResponse>;
  /** Transfers ownership of one workspace. */
  transferWorkspaceOwnership(
    workspaceId: string,
    input: TransferWorkspaceOwnershipInput
  ): Promise<WorkspaceOwnershipMutationResponse>;
  /** Reads the bounded access-recovery state for one workspace. */
  getWorkspaceAccessRecoveryState(workspaceId: string): Promise<WorkspaceAccessRecoveryResponse>;
  /** Applies one bounded access-recovery action for a workspace. */
  recoverWorkspaceAccess(
    workspaceId: string,
    input: RecoverWorkspaceAccessInput
  ): Promise<WorkspaceAccessRecoveryResponse>;
  /** Disables one canonical user. */
  disableUser(userId: string, input: DisableUserInput): Promise<DisableUserResponse>;
  /** Imports one immutable Workspace Artifact version. */
  importWorkspaceArtifact(
    workspaceId: string,
    input: ImportWorkspaceArtifactInput
  ): Promise<ImportWorkspaceArtifactResponse>;
  /** Introduces one exact Workspace Artifact version into a Thread. */
  introduceWorkspaceArtifact(
    workspaceId: string,
    threadId: string,
    artifactId: string,
    input: IntroduceWorkspaceArtifactInput
  ): Promise<IntroduceWorkspaceArtifactResponse>;
  /** Lists version-keyed Reviews for one Artifact. */
  listArtifactReviews(
    workspaceId: string,
    artifactId: string
  ): Promise<ListArtifactReviewsResponse>;
  /** Decides one exact version-keyed Artifact Review. */
  submitArtifactReviewDecision(
    workspaceId: string,
    artifactId: string,
    artifactVersion: number,
    input: SubmitArtifactReviewDecisionInput
  ): Promise<SubmitArtifactReviewDecisionResponse>;
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
  /** Reads one workspace dashboard read model. */
  getWorkspaceDashboard(workspaceId: string): Promise<WorkspaceDashboardResponse>;
  /** Reads one thread dashboard read model. */
  getThreadDashboard(workspaceId: string, threadId: string): Promise<ThreadDashboardResponse>;
  /** Reads one thread Goal Mode summary read model. */
  getThreadGoalSummary(workspaceId: string, threadId: string): Promise<ThreadGoalSummaryResponse>;
  /** Starts Goal Mode for one thread. */
  startThreadGoal(
    workspaceId: string,
    threadId: string,
    input: StartThreadGoalInput
  ): Promise<StartThreadGoalResponse>;
  /** Creates a deterministic Goal Mode plan for one planning goal. */
  createThreadGoalPlan(
    workspaceId: string,
    threadId: string,
    input: CreateThreadGoalPlanRequest
  ): Promise<CreateThreadGoalPlanResponse>;
  /** Approves one Goal Mode plan and persists its ready tasks. */
  approveThreadGoalPlan(
    workspaceId: string,
    threadId: string,
    input: ApproveThreadGoalPlanRequest
  ): Promise<ApproveThreadGoalPlanResponse>;
  /** Requests Goal Mode plan revisions and returns the goal to planning. */
  reviseThreadGoalPlan(
    workspaceId: string,
    threadId: string,
    input: ReviseThreadGoalPlanRequest
  ): Promise<ReviseThreadGoalPlanResponse>;
  /** Pauses the active Goal Mode workflow for one thread. */
  pauseThreadGoal(
    workspaceId: string,
    threadId: string,
    input?: PauseThreadGoalInput
  ): Promise<PauseThreadGoalResponse>;
  /** Resumes a paused Goal Mode workflow for one thread. */
  resumeThreadGoal(
    workspaceId: string,
    threadId: string,
    input?: ResumeThreadGoalInput
  ): Promise<ResumeThreadGoalResponse>;
  /** Runs one real bounded Goal Mode worker step. */
  runThreadGoalStep(
    workspaceId: string,
    threadId: string,
    input?: RunThreadGoalStepInput
  ): Promise<RunThreadGoalStepResponse>;
  /** Starts one bounded Task Mode worker delegation. */
  startTaskMode(
    workspaceId: string,
    threadId: string,
    input: StartTaskModeInput
  ): Promise<StartTaskModeResponse>;
  /** Starts one thread-scoped Chat Mode Assistant turn. */
  startChatMode(
    workspaceId: string,
    threadId: string,
    input: StartChatModeInput
  ): Promise<StartChatModeResponse>;
  /** Runs one bounded Knowledge Manager answer operation. */
  answerKnowledgeManager(
    workspaceId: string,
    input: KnowledgeManagerAnswerInput
  ): Promise<KnowledgeManagerAnswerResponse>;
  /** Prepares source-traceable context material without assembling the final prompt. */
  prepareKnowledgeContext(
    workspaceId: string,
    input: KnowledgeManagerPrepareContextInput
  ): Promise<KnowledgeManagerPrepareContextResponse>;
  /** Drafts one pending Knowledge Proposal for explicit review. */
  draftKnowledgeProposal(
    workspaceId: string,
    input: KnowledgeManagerDraftProposalInput
  ): Promise<KnowledgeManagerDraftProposalResponse>;
  /** Suggests review-required knowledge repairs without applying them. */
  suggestKnowledgeRepairs(
    workspaceId: string,
    input: KnowledgeManagerSuggestRepairInput
  ): Promise<KnowledgeManagerSuggestRepairResponse>;
  /** Produces one bounded Knowledge Manager health report. */
  checkKnowledgeHealth(
    workspaceId: string,
    input: KnowledgeManagerHealthCheckInput
  ): Promise<KnowledgeManagerHealthCheckResponse>;
  /** Registers one workspace Knowledge Source identity from explicit source content. */
  registerKnowledgeSource(
    workspaceId: string,
    input: RegisterKnowledgeSourceInput
  ): Promise<RegisterKnowledgeSourceResponse>;
  /** Lists workspace Knowledge Source identities. */
  listKnowledgeSources(workspaceId: string): Promise<ListKnowledgeSourcesResponse>;
  /** Reads one workspace Knowledge Source identity. */
  readKnowledgeSource(workspaceId: string, sourceId: string): Promise<ReadKnowledgeSourceResponse>;
  /** Reads fresh derived Knowledge Store indexes. */
  readKnowledgeIndexes(workspaceId: string): Promise<KnowledgeDerivedIndexesResponse>;
  /** Retrieves ranked Knowledge Store candidates and persists the trace. */
  retrieveKnowledge(
    workspaceId: string,
    input: RetrieveKnowledgeInput
  ): Promise<KnowledgeRetrievalResponse>;
  /** Appends one workspace Knowledge Store observation. */
  recordKnowledgeObservation(
    workspaceId: string,
    input: RecordKnowledgeObservationInput
  ): Promise<RecordKnowledgeObservationResponse>;
  /** Lists workspace Knowledge Store observations. */
  listKnowledgeObservations(workspaceId: string): Promise<ListKnowledgeObservationsResponse>;
  /** Appends one workspace Knowledge Store claim. */
  recordKnowledgeClaim(
    workspaceId: string,
    input: RecordKnowledgeClaimInput
  ): Promise<RecordKnowledgeClaimResponse>;
  /** Lists workspace Knowledge Store claims. */
  listKnowledgeClaims(workspaceId: string): Promise<ListKnowledgeClaimsResponse>;
  /** Appends one workspace Knowledge Store conflict. */
  recordKnowledgeConflict(
    workspaceId: string,
    input: RecordKnowledgeConflictInput
  ): Promise<RecordKnowledgeConflictResponse>;
  /** Resolves one workspace Knowledge Store conflict. */
  resolveKnowledgeConflict(
    workspaceId: string,
    conflictId: string,
    input: ResolveKnowledgeConflictInput
  ): Promise<ResolveKnowledgeConflictResponse>;
  /** Lists workspace Knowledge Store conflicts. */
  listKnowledgeConflicts(workspaceId: string): Promise<ListKnowledgeConflictsResponse>;
  /** Submits user steering to the active Goal Mode queue. */
  submitThreadGoalSteering(
    workspaceId: string,
    threadId: string,
    input: SubmitThreadGoalSteeringInput
  ): Promise<SubmitThreadGoalSteeringResponse>;
  /** Converts one terminal Goal steering input into completed Thread follow-up history. */
  convertGoalSteeringToFollowUp(
    workspaceId: string,
    threadId: string,
    pendingTurnId: string,
    input: ConvertGoalSteeringToFollowUpInput
  ): Promise<ConvertGoalSteeringToFollowUpResponse>;
  /** Cancels one terminal Goal steering input. */
  cancelGoalSteering(
    workspaceId: string,
    threadId: string,
    pendingTurnId: string,
    input: CancelGoalSteeringInput
  ): Promise<CancelGoalSteeringResponse>;
  /** Resolves one app-local Goal Review attention row. */
  submitGoalReviewDecision(
    workspaceId: string,
    threadId: string,
    goalId: string,
    reviewId: string,
    input: SubmitGoalReviewDecisionInput
  ): Promise<SubmitGoalReviewDecisionResponse>;
  /** Records one app-local knowledge proposal decision. */
  submitKnowledgeProposalDecision(
    workspaceId: string,
    proposalId: string,
    input: SubmitKnowledgeProposalDecisionInput
  ): Promise<SubmitKnowledgeProposalDecisionResponse>;
  /** Removes one unchanged page created by an accepted Knowledge Proposal. */
  reverseKnowledgeProposal(
    workspaceId: string,
    proposalId: string,
    input: ReverseKnowledgeProposalInput
  ): Promise<ReverseKnowledgeProposalResponse>;
  /** Lists workspace synchronization reviews for one workspace. */
  listWorkspaceSyncReviews(workspaceId: string): Promise<ListWorkspaceSyncReviewsResponse>;
  /** Reads one workspace synchronization review by id. */
  getWorkspaceSyncReview(
    workspaceId: string,
    reviewId: string
  ): Promise<GetWorkspaceSyncReviewResponse>;
  /** Records one durable workspace synchronization review decision. */
  submitWorkspaceSyncReviewDecision(
    workspaceId: string,
    reviewId: string,
    input: SubmitWorkspaceSyncReviewDecisionInput
  ): Promise<SubmitWorkspaceSyncReviewDecisionResponse>;
  /** Records one workspace recovery decision. */
  submitWorkspaceRecoveryDecision(
    workspaceId: string,
    reconciliationRecordId: string,
    input: SubmitWorkspaceRecoveryDecisionInput
  ): Promise<SubmitWorkspaceRecoveryDecisionResponse>;
  /** Lists durable workspace input snapshots for one workspace. */
  listWorkspaceInputSnapshots(workspaceId: string): Promise<ListWorkspaceInputSnapshotsResponse>;
  /** Lists durable workspace materialization records for one workspace. */
  listWorkspaceMaterializationRecords(
    workspaceId: string
  ): Promise<ListWorkspaceMaterializationRecordsResponse>;
  /** Lists durable backend workspace handles for one workspace. */
  listBackendWorkspaceHandles(workspaceId: string): Promise<ListBackendWorkspaceHandlesResponse>;
  /** Lists durable worker output manifests for one workspace. */
  listWorkerOutputManifests(workspaceId: string): Promise<ListWorkerOutputManifestsResponse>;
  /** Lists durable workspace change sets for one workspace. */
  listWorkspaceChangeSets(workspaceId: string): Promise<ListWorkspaceChangeSetsResponse>;
  /** Lists durable staged workspace reviews for one workspace. */
  listStagedWorkspaceReviews(workspaceId: string): Promise<ListStagedWorkspaceReviewsResponse>;
  /** Lists durable workspace apply plans for one workspace. */
  listWorkspaceApplyPlans(workspaceId: string): Promise<ListWorkspaceApplyPlansResponse>;
  /** Lists durable workspace reconciliation records for one workspace. */
  listWorkspaceReconciliationRecords(
    workspaceId: string
  ): Promise<ListWorkspaceReconciliationRecordsResponse>;
  /** Lists durable workspace quarantine records for one workspace. */
  listWorkspaceQuarantineRecords(
    workspaceId: string
  ): Promise<ListWorkspaceQuarantineRecordsResponse>;
  /** Lists durable workspace apply results for one workspace. */
  listWorkspaceApplyResults(workspaceId: string): Promise<ListWorkspaceApplyResultsResponse>;
  /** Reads one durable workspace apply result by id. */
  getWorkspaceApplyResult(
    workspaceId: string,
    applyResultId: string
  ): Promise<GetWorkspaceApplyResultResponse>;
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
  /** Reads setup diagnostics. */
  getSetupDiagnostics(): Promise<SetupDiagnosticsResponse>;
  /** Reads the NanoCore storage layout report. */
  getStorageLayoutReport(): Promise<StorageLayoutReportResponse>;
  /** Creates and verifies one server-managed hot data-root backup. */
  createDataRootBackup(): Promise<DataRootBackupCreateResponse>;
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
  /** Verifies one server-managed data-root backup by id. */
  verifyDataRootBackup(backupId: string): Promise<DataRootBackupVerifyResponse>;
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
  /** Creates and verifies one workspace export tree. */
  exportWorkspace(workspaceId: string): Promise<WorkspaceExportResponse>;
  /** Verifies a server-managed workspace export without importing it. */
  dryRunWorkspaceImport(
    input: WorkspaceImportDryRunRequest
  ): Promise<WorkspaceImportDryRunResponse>;
  /** Imports one server-managed workspace export. */
  importWorkspace(input: WorkspaceImportRequest): Promise<WorkspaceImportResponse>;
  /** Lists redacted workspace vault references. */
  listWorkspaceVaultReferences(
    workspaceId: string
  ): Promise<VaultAdminListWorkspaceReferencesResponse>;
  /** Lists non-secret workspace vault grants. */
  listWorkspaceVaultGrants(workspaceId: string): Promise<ListWorkspaceVaultGrantsResponse>;
  /** Lists non-secret workspace injection plans. */
  listWorkspaceInjectionPlans(workspaceId: string): Promise<ListWorkspaceInjectionPlansResponse>;
  /** Lists non-secret workspace injection receipts. */
  listWorkspaceInjectionReceipts(
    workspaceId: string
  ): Promise<ListWorkspaceInjectionReceiptsResponse>;
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
  /** Lists automations. */
  listAutomations(): Promise<ListAutomationsResponse>;
  /** Creates one automation. */
  createAutomation(input: CreateAutomationRequest): Promise<AutomationRecord>;
  /** Updates one automation. */
  updateAutomation(automationId: string, input: UpdateAutomationRequest): Promise<AutomationRecord>;
  /** Deletes one automation. */
  deleteAutomation(automationId: string): Promise<void>;
  /** Runs one completed quick chat request. */
  quickChat(input: QuickChatRequest): Promise<QuickChatResponse>;
  /** Lists interrupted worker recovery states. */
  listInterruptedWorkers(): Promise<ListInterruptedWorkerStatesResponse>;
  /** Queues one interrupted worker checkpoint for retry through the owning task. */
  retryInterruptedWorkerCheckpoint(
    workspaceId: string,
    threadId: string,
    turnId: string,
    input?: RetryInterruptedWorkerCheckpointInput
  ): Promise<RetryInterruptedWorkerCheckpointResponse>;
  /** Requeues one denied scheduler admission. */
  retrySchedulerAdmission(
    workspaceId: string,
    queueEntryId: string
  ): Promise<RetrySchedulerAdmissionResponse>;
  /** Cancels one queued or denied scheduler admission. */
  cancelSchedulerAdmission(
    workspaceId: string,
    queueEntryId: string
  ): Promise<CancelSchedulerAdmissionResponse>;
  /** Lists workspace-filtered scheduler admissions. */
  listSchedulerAdmissions(workspaceId: string): Promise<ListSchedulerAdmissionsResponse>;
  /** Searches App API read models. */
  search(query: string): Promise<AppSearchResponse>;
  /** Submits per-turn feedback. */
  submitTurnFeedback(
    turnId: string,
    input: SubmitTurnFeedbackRequest
  ): Promise<TurnFeedbackResponse>;
}

/** Creates the NanoCore App API client. */
export function createAppApiClient(transport: ClientTransport): AppApiClient {
  return {
    listAuthorizedWorkspaces: () =>
      transport.getJson('/api/app/workspaces', ListAuthorizedWorkspacesResponseSchema),
    listWorkspaceMembers: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/members`,
        ListWorkspaceMembersResponseSchema
      ),
    listWorkspaceInvitations: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/invitations`,
        ListWorkspaceInvitationsResponseSchema
      ),
    createWorkspaceInvitation: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/invitations`,
        CreateWorkspaceInvitationRequestSchema.parse(request),
        WorkspaceInvitationMutationResponseSchema
      );
    },
    listMyWorkspaceInvitations: () =>
      transport.getJson('/api/app/workspace-invitations', ListWorkspaceInvitationsResponseSchema),
    acceptWorkspaceInvitation: (invitationId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspace-invitations/${invitationId}/accept`,
        AcceptWorkspaceInvitationRequestSchema.parse(request),
        WorkspaceInvitationMutationResponseSchema
      );
    },
    declineWorkspaceInvitation: (invitationId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspace-invitations/${invitationId}/decline`,
        DeclineWorkspaceInvitationRequestSchema.parse(request),
        WorkspaceInvitationMutationResponseSchema
      );
    },
    revokeWorkspaceInvitation: (workspaceId, invitationId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/invitations/${invitationId}/revoke`,
        RevokeWorkspaceInvitationRequestSchema.parse(request),
        WorkspaceInvitationMutationResponseSchema
      );
    },
    changeWorkspaceMemberAccess: (workspaceId, userId, input) => {
      const request = withRequestId(input);

      return transport.patchJson(
        `/api/app/workspaces/${workspaceId}/members/${userId}`,
        ChangeWorkspaceMemberAccessRequestSchema.parse(request),
        WorkspaceMemberMutationResponseSchema
      );
    },
    removeWorkspaceMember: (workspaceId, userId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/members/${userId}/remove`,
        RemoveWorkspaceMemberRequestSchema.parse(request),
        WorkspaceMemberMutationResponseSchema
      );
    },
    leaveWorkspace: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/leave`,
        LeaveWorkspaceRequestSchema.parse(request),
        WorkspaceMemberMutationResponseSchema
      );
    },
    transferWorkspaceOwnership: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/ownership/transfer`,
        TransferWorkspaceOwnershipRequestSchema.parse(request),
        WorkspaceOwnershipMutationResponseSchema
      );
    },
    getWorkspaceAccessRecoveryState: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/access-recovery`,
        WorkspaceAccessRecoveryResponseSchema
      ),
    recoverWorkspaceAccess: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/access-recovery`,
        RecoverWorkspaceAccessRequestSchema.parse(request),
        WorkspaceAccessRecoveryResponseSchema
      );
    },
    disableUser: (userId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/users/${userId}/disable`,
        DisableUserRequestSchema.parse(request),
        DisableUserResponseSchema
      );
    },
    importWorkspaceArtifact: (workspaceId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/artifacts/imports`,
        ImportWorkspaceArtifactRequestSchema.parse(request),
        ImportWorkspaceArtifactResponseSchema
      );
    },
    introduceWorkspaceArtifact: (workspaceId, threadId, artifactId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/artifacts/${artifactId}/introductions`,
        IntroduceWorkspaceArtifactRequestSchema.parse(request),
        IntroduceWorkspaceArtifactResponseSchema
      );
    },
    listArtifactReviews: (workspaceId, artifactId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/artifacts/${artifactId}/reviews`,
        ListArtifactReviewsResponseSchema
      ),
    submitArtifactReviewDecision: (workspaceId, artifactId, artifactVersion, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/artifacts/${artifactId}/versions/${artifactVersion}/review/decision`,
        SubmitArtifactReviewDecisionRequestSchema.parse(request),
        SubmitArtifactReviewDecisionResponseSchema
      );
    },
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
    getWorkspaceDashboard: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/dashboard`,
        WorkspaceDashboardResponseSchema
      ),
    getThreadDashboard: (workspaceId, threadId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/dashboard`,
        ThreadDashboardResponseSchema
      ),
    getThreadGoalSummary: (workspaceId, threadId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal`,
        ThreadGoalSummaryResponseSchema
      ),
    startThreadGoal: (workspaceId, threadId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal`,
        StartThreadGoalRequestSchema.parse(request),
        StartThreadGoalResponseSchema
      );
    },
    createThreadGoalPlan: (workspaceId, threadId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/plan`,
        CreateThreadGoalPlanRequestSchema.parse(input),
        CreateThreadGoalPlanResponseSchema
      ),
    approveThreadGoalPlan: (workspaceId, threadId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/plan/approve`,
        ApproveThreadGoalPlanRequestSchema.parse(input),
        ApproveThreadGoalPlanResponseSchema
      ),
    reviseThreadGoalPlan: (workspaceId, threadId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/plan/revise`,
        ReviseThreadGoalPlanRequestSchema.parse(input),
        ReviseThreadGoalPlanResponseSchema
      ),
    pauseThreadGoal: (workspaceId, threadId, input = {}) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/pause`,
        PauseThreadGoalRequestSchema.parse(request),
        PauseThreadGoalResponseSchema
      );
    },
    resumeThreadGoal: (workspaceId, threadId, input = {}) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/resume`,
        ResumeThreadGoalRequestSchema.parse(request),
        ResumeThreadGoalResponseSchema
      );
    },
    runThreadGoalStep: (workspaceId, threadId, input = {}) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/step`,
        RunThreadGoalStepRequestSchema.parse(request),
        RunThreadGoalStepResponseSchema
      );
    },
    startTaskMode: (workspaceId, threadId, input) => {
      const request = { ...input, requestId: input.requestId ?? createRequestId() };

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/task`,
        StartTaskModeRequestSchema.parse(request),
        StartTaskModeResponseSchema
      );
    },
    startChatMode: (workspaceId, threadId, input) => {
      const request = { ...input, requestId: input.requestId ?? createRequestId() };

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/chat`,
        StartChatModeRequestSchema.parse(request),
        StartChatModeResponseSchema
      );
    },
    answerKnowledgeManager: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/manager/answer`,
        KnowledgeManagerAnswerRequestSchema.parse(input),
        KnowledgeManagerAnswerResponseSchema
      ),
    prepareKnowledgeContext: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/manager/context`,
        KnowledgeManagerPrepareContextRequestSchema.parse(input),
        KnowledgeManagerPrepareContextResponseSchema
      ),
    draftKnowledgeProposal: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/manager/proposals`,
        KnowledgeManagerDraftProposalRequestSchema.parse(input),
        KnowledgeManagerDraftProposalResponseSchema
      ),
    suggestKnowledgeRepairs: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/manager/repairs`,
        KnowledgeManagerSuggestRepairRequestSchema.parse(input),
        KnowledgeManagerSuggestRepairResponseSchema
      ),
    checkKnowledgeHealth: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/manager/health`,
        KnowledgeManagerHealthCheckRequestSchema.parse(input),
        KnowledgeManagerHealthCheckResponseSchema
      ),
    registerKnowledgeSource: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/sources`,
        RegisterKnowledgeSourceRequestSchema.parse(input),
        RegisterKnowledgeSourceResponseSchema
      ),
    listKnowledgeSources: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/sources`,
        ListKnowledgeSourcesResponseSchema
      ),
    readKnowledgeSource: (workspaceId, sourceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/sources/${sourceId}`,
        ReadKnowledgeSourceResponseSchema
      ),
    readKnowledgeIndexes: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/indexes`,
        KnowledgeDerivedIndexesResponseSchema
      ),
    retrieveKnowledge: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/retrievals`,
        RetrieveKnowledgeRequestSchema.parse(input),
        KnowledgeRetrievalResponseSchema
      ),
    recordKnowledgeObservation: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/observations`,
        RecordKnowledgeObservationRequestSchema.parse(input),
        RecordKnowledgeObservationResponseSchema
      ),
    listKnowledgeObservations: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/observations`,
        ListKnowledgeObservationsResponseSchema
      ),
    recordKnowledgeClaim: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/claims`,
        RecordKnowledgeClaimRequestSchema.parse(input),
        RecordKnowledgeClaimResponseSchema
      ),
    listKnowledgeClaims: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/claims`,
        ListKnowledgeClaimsResponseSchema
      ),
    recordKnowledgeConflict: (workspaceId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/conflicts`,
        RecordKnowledgeConflictRequestSchema.parse(input),
        RecordKnowledgeConflictResponseSchema
      ),
    resolveKnowledgeConflict: (workspaceId, conflictId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/conflicts/${conflictId}/resolution`,
        ResolveKnowledgeConflictRequestSchema.parse(input),
        ResolveKnowledgeConflictResponseSchema
      ),
    listKnowledgeConflicts: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/knowledge/conflicts`,
        ListKnowledgeConflictsResponseSchema
      ),
    submitThreadGoalSteering: (workspaceId, threadId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/steering`,
        SubmitThreadGoalSteeringRequestSchema.parse(request),
        SubmitThreadGoalSteeringResponseSchema
      );
    },
    convertGoalSteeringToFollowUp: (workspaceId, threadId, pendingTurnId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/steering/${pendingTurnId}/follow-up`,
        ConvertGoalSteeringToFollowUpRequestSchema.parse(request),
        ConvertGoalSteeringToFollowUpResponseSchema
      );
    },
    cancelGoalSteering: (workspaceId, threadId, pendingTurnId, input) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goal/steering/${pendingTurnId}/cancel`,
        CancelGoalSteeringRequestSchema.parse(request),
        CancelGoalSteeringResponseSchema
      );
    },
    submitGoalReviewDecision: (workspaceId, threadId, goalId, reviewId, input) => {
      const request = { ...input, requestId: input.requestId ?? createRequestId() };

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/goals/${goalId}/reviews/${reviewId}/decision`,
        SubmitGoalReviewDecisionRequestSchema.parse(request),
        SubmitGoalReviewDecisionResponseSchema
      );
    },
    submitKnowledgeProposalDecision: (workspaceId, proposalId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposalId}/decision`,
        SubmitKnowledgeProposalDecisionRequestSchema.parse(input),
        SubmitKnowledgeProposalDecisionResponseSchema
      ),
    reverseKnowledgeProposal: (workspaceId, proposalId, input) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/knowledge/proposals/${proposalId}/reversal`,
        ReverseKnowledgeProposalRequestSchema.parse(input),
        ReverseKnowledgeProposalResponseSchema
      ),
    listWorkspaceSyncReviews: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/reviews`,
        ListWorkspaceSyncReviewsResponseSchema
      ),
    getWorkspaceSyncReview: (workspaceId, reviewId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/reviews/${reviewId}`,
        GetWorkspaceSyncReviewResponseSchema
      ),
    submitWorkspaceSyncReviewDecision: (workspaceId, reviewId, input) => {
      const request = { ...input, requestId: input.requestId ?? createRequestId() };

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/reviews/${reviewId}/decision`,
        SubmitWorkspaceSyncReviewDecisionRequestSchema.parse(request),
        SubmitWorkspaceSyncReviewDecisionResponseSchema
      );
    },
    submitWorkspaceRecoveryDecision: (workspaceId, reconciliationRecordId, input) => {
      const request = { ...input, requestId: input.requestId ?? createRequestId() };

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/reconciliation-records/${reconciliationRecordId}/decision`,
        SubmitWorkspaceRecoveryDecisionRequestSchema.parse(request),
        SubmitWorkspaceRecoveryDecisionResponseSchema
      );
    },
    listWorkspaceInputSnapshots: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/input-snapshots`,
        ListWorkspaceInputSnapshotsResponseSchema
      ),
    listWorkspaceMaterializationRecords: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/materialization-records`,
        ListWorkspaceMaterializationRecordsResponseSchema
      ),
    listBackendWorkspaceHandles: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/backend-handles`,
        ListBackendWorkspaceHandlesResponseSchema
      ),
    listWorkerOutputManifests: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/output-manifests`,
        ListWorkerOutputManifestsResponseSchema
      ),
    listWorkspaceChangeSets: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/change-sets`,
        ListWorkspaceChangeSetsResponseSchema
      ),
    listStagedWorkspaceReviews: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/staged-reviews`,
        ListStagedWorkspaceReviewsResponseSchema
      ),
    listWorkspaceApplyPlans: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/apply-plans`,
        ListWorkspaceApplyPlansResponseSchema
      ),
    listWorkspaceReconciliationRecords: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/reconciliation-records`,
        ListWorkspaceReconciliationRecordsResponseSchema
      ),
    listWorkspaceQuarantineRecords: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/quarantine-records`,
        ListWorkspaceQuarantineRecordsResponseSchema
      ),
    listWorkspaceApplyResults: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/apply-results`,
        ListWorkspaceApplyResultsResponseSchema
      ),
    getWorkspaceApplyResult: (workspaceId, applyResultId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/workspace-sync/apply-results/${applyResultId}`,
        GetWorkspaceApplyResultResponseSchema
      ),
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
    getSetupDiagnostics: () =>
      transport.getJson('/api/setup/diagnostics', SetupDiagnosticsResponseSchema),
    getStorageLayoutReport: () =>
      transport.getJson('/api/app/storage/layout-report', StorageLayoutReportResponseSchema),
    createDataRootBackup: () =>
      transport.postJson('/api/app/data-root/backups', {}, DataRootBackupCreateResponseSchema),
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
    verifyDataRootBackup: (backupId) =>
      transport.postJson(
        `/api/app/data-root/backups/${backupId}/verify`,
        { backupId },
        DataRootBackupVerifyResponseSchema
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
    exportWorkspace: (workspaceId) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/export`,
        {},
        WorkspaceExportResponseSchema
      ),
    dryRunWorkspaceImport: (input) =>
      transport.postJson(
        '/api/app/workspace-imports/dry-run',
        WorkspaceImportDryRunRequestSchema.parse(input),
        WorkspaceImportDryRunResponseSchema
      ),
    importWorkspace: (input) =>
      transport.postJson(
        '/api/app/workspace-imports',
        WorkspaceImportRequestSchema.parse(input),
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
    listWorkspaceInjectionPlans: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/injection-plans`,
        ListWorkspaceInjectionPlansResponseSchema
      ),
    listWorkspaceInjectionReceipts: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/vault/injection-receipts`,
        ListWorkspaceInjectionReceiptsResponseSchema
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
    listAutomations: () => transport.getJson('/api/app/automations', ListAutomationsResponseSchema),
    createAutomation: (input) =>
      transport.postJson(
        '/api/app/automations',
        CreateAutomationRequestSchema.parse(input),
        AutomationRecordSchema
      ),
    updateAutomation: (automationId, input) =>
      transport.patchJson(
        `/api/app/automations/${automationId}`,
        UpdateAutomationRequestSchema.parse(input),
        AutomationRecordSchema
      ),
    deleteAutomation: (automationId) =>
      transport.deleteEmpty(`/api/app/automations/${automationId}`),
    quickChat: (input) =>
      transport.postJson(
        '/api/app/quick-chat',
        QuickChatRequestSchema.parse(input),
        QuickChatResponseSchema
      ),
    listInterruptedWorkers: () =>
      transport.getJson(
        '/api/app/recovery/interrupted-workers',
        ListInterruptedWorkerStatesResponseSchema
      ),
    retryInterruptedWorkerCheckpoint: (workspaceId, threadId, turnId, input = {}) => {
      const request = withRequestId(input);

      return transport.postJson(
        `/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/interrupted-worker/${turnId}/retry`,
        RetryInterruptedWorkerCheckpointRequestSchema.parse(request),
        RetryInterruptedWorkerCheckpointResponseSchema
      );
    },
    retrySchedulerAdmission: (workspaceId, queueEntryId) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/scheduler/admissions/${queueEntryId}/retry`,
        {},
        RetrySchedulerAdmissionResponseSchema
      ),
    cancelSchedulerAdmission: (workspaceId, queueEntryId) =>
      transport.postJson(
        `/api/app/workspaces/${workspaceId}/scheduler/admissions/${queueEntryId}/cancel`,
        {},
        CancelSchedulerAdmissionResponseSchema
      ),
    listSchedulerAdmissions: (workspaceId) =>
      transport.getJson(
        `/api/app/workspaces/${workspaceId}/scheduler/admissions`,
        ListSchedulerAdmissionsResponseSchema
      ),
    search: (query) =>
      transport.getJson(`/api/app/search?q=${encodeURIComponent(query)}`, AppSearchResponseSchema),
    submitTurnFeedback: (turnId, input) =>
      transport.postJson(
        `/api/turns/${turnId}/feedback`,
        SubmitTurnFeedbackRequestSchema.parse(input),
        TurnFeedbackResponseSchema
      ),
  };
}
