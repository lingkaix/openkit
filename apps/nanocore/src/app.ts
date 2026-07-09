import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import {
  AgentHealthRefreshResponseSchema,
  AgentSessionReadModelSchema,
  AppDiagnosticsResponseSchema,
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  AppSearchResponseSchema,
  AutomationRecordSchema,
  type BootReadinessSnapshot,
  CancelRecoveryPendingUserTurnResponseSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ClearInterruptedWorkerCheckpointRequestSchema,
  ClearInterruptedWorkerCheckpointResponseSchema,
  CreateOpenAICodexOAuthAccountRequestSchema as CodexOAuthAccountCreateRequestSchema,
  CodexOAuthAccountSummarySchema,
  CodexOAuthAccountsPayloadSchema,
  UpdateOpenAICodexOAuthAccountRequestSchema as CodexOAuthAccountUpdateRequestSchema,
  CancelOpenAICodexOAuthRequestSchema as CodexOAuthCancelRequestSchema,
  StartOpenAICodexOAuthRequestSchema as CodexOAuthStartRequestSchema,
  CodexOAuthStatusPayloadSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  ConvertRecoveryPendingUserTurnToFollowUpResponseSchema,
  CreateAutomationRequestSchema,
  type CreateEvidenceBundleRequest,
  CreateEvidenceBundleRequestSchema,
  CreateEvidenceBundleResponseSchema,
  CreateInterruptedRecoveryStateResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateThreadGoalPlanResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  EditRecoveryPendingUserTurnRequestSchema,
  EditRecoveryPendingUserTurnResponseSchema,
  type EvidenceBundleRef,
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GetAgentCatalogEntryResponseSchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetGitPushRecordResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceSyncReviewResponseSchema,
  type GitPushRecord,
  type GoalPendingHumanAttention,
  type GoalTaskCounts,
  type GoalTerminalState,
  type GoalTerminalSummary,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerRequestSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckRequestSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextRequestSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairRequestSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListAgentCatalogResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  ListAutomationsResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListGitPushRecordsResponseSchema,
  ListHumanAttentionResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  ListRecoveryPendingUserTurnsResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListServerVaultUseRecordsResponseSchema,
  ListStagedWorkspaceReviewsResponseSchema,
  ListThreadItemsResponseSchema,
  ListWorkerOutputManifestsResponseSchema,
  ListWorkspaceApplyPlansResponseSchema,
  ListWorkspaceApplyResultsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInjectionPlansResponseSchema,
  ListWorkspaceInjectionReceiptsResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncEvidenceBundlesResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  MaterializeKnowledgeContextPackageResponseSchema,
  PauseThreadGoalResponseSchema,
  PromoteKnowledgeClaimRequestSchema,
  PromoteKnowledgeClaimResponseSchema,
  PromoteRecoveryPendingUserTurnToInterruptResponseSchema,
  QueueAgentSessionTerminalCommandRequestSchema,
  QueueAgentSessionTerminalCommandResponseSchema,
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  ReadKnowledgeManagerContextPackageTraceResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimRequestSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictRequestSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationRequestSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceRequestSchema,
  RegisterKnowledgeSourceResponseSchema,
  RequestGitPushApprovalRequestSchema,
  RequestGitPushApprovalResponseSchema,
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RestartRuntimeConfigStaleSessionResponseSchema,
  ResumeThreadGoalResponseSchema,
  RetrieveKnowledgeRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  ReviseThreadGoalPlanRequestSchema,
  ReviseThreadGoalPlanResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
  RunThreadGoalStepRequestSchema,
  RunThreadGoalStepResponseSchema,
  RunThreadGoalTestSuperviseStepRequestSchema,
  RunThreadGoalTestSuperviseStepResponseSchema,
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigReloadRequestSchema,
  type RuntimeConfigStaleSession,
  RuntimeConfigValidationRequestSchema,
  SetupDiagnosticsResponseSchema,
  SetWorkspaceRepositoryRequestSchema,
  SetWorkspaceRepositoryResponseSchema,
  StartChatModeRequestSchema,
  StartChatModeResponseSchema,
  StartTaskModeRequestSchema,
  StartTaskModeResponseSchema,
  StartThreadGoalRequestSchema,
  StartThreadGoalResponseSchema,
  StorageLayoutReportResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
  SubmitGoalReviewDecisionRequestSchema,
  SubmitGoalReviewDecisionResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
  SubmitThreadGoalSteeringRequestSchema,
  SubmitThreadGoalSteeringResponseSchema,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  type TaskDelegationDecision,
  type TaskModeEvidence,
  ThreadDashboardResponseSchema,
  type ThreadGoalCurrentTask,
  type ThreadGoalSummary,
  ThreadGoalSummaryResponseSchema,
  UpdateAutomationRequestSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminLockResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  VaultAdminStatusResponseSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminUnlockResponseSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceApplyResultSchema,
  WorkspaceDashboardResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
  WorkspaceRepositoryDiagnosticsResponseSchema,
  WorkspaceRepositoryResourceSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  type MaterializedWorkspaceRoot as ConfigMaterializedWorkspaceRoot,
  materializeWorkspaceRoots,
  parseWorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import {
  ApiErrorSchema,
  ApprovalRequestSchema,
  ArchiveThreadRequestSchema,
  ArtifactSchema,
  CreateKnowledgeEntryRequestSchema,
  CreateThreadRequestSchema,
  CreateWorkspaceRequestSchema,
  DeleteKnowledgeEntryRequestSchema,
  InterruptTurnRequestSchema,
  KnowledgeEntrySchema,
  ListWorkspacesResponseSchema,
  MetaResponseSchema,
  PROTOCOL_VERSION,
  RequestIdSchema,
  RespondToApprovalRequestSchema,
  SubmitTurnInputRequestSchema,
  ThreadSchema,
  TurnSchema,
  UpdateArtifactMetadataRequestSchema,
  UpdateKnowledgeEntryRequestSchema,
  UpdateThreadRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesResponseSchema,
} from '@openkit/protocol';
import {
  WorkerCanonicalEventRecordSchema,
  WorkerCapabilityCallSummarySchema,
  WorkerControlRequestEnvelopeSchema,
} from '@openkit/worker-protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { buildHumanAttentionResponse } from './action-center.js';
import type { AgentManifest, AuthoredAgentConfig } from './agents/manifest.js';
import {
  importResolvedAgentSetups,
  listExportableResolvedAgentSetups,
} from './agents/setup-ledger.js';
import {
  buildThreadWorkStatus,
  buildWorkspaceWorkSections,
  summarizeDashboardArtifact,
} from './app-dashboard.js';
import {
  importWorkspaceAuditEvents,
  listServerAuditEvents,
  listWorkspaceAuditEvents,
  recordServerAuditEvent,
  recordWorkspaceAuditEvent,
} from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
  type OpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
  verifyOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { createBetterAuth } from './auth/better-auth.js';
import { consumeServerBootstrapToken } from './auth/bootstrap-token.js';
import {
  type AuthVariables,
  type BetterAuthServer,
  createAuthMiddleware,
} from './auth/middleware.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import {
  finishCapabilityCall,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { parseJsoncObject } from './config/jsonc.js';
import type { CoreMode } from './config/mode.js';
import { loadOpenKitConfig, type OpenKitConfig } from './config/openkit-config.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  createRuntimeConfigStaleSession,
  findWorkspaceConfig,
  type RuntimeConfigManager,
  type RuntimeConfigSnapshot,
} from './config/runtime-config.js';
import {
  RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './config/runtime-config-files.js';
import { createSetupDiagnostics } from './diagnostics/setup.js';
import { createDiagnosticsSnapshot } from './diagnostics/snapshot.js';
import {
  createWorkspaceEvidenceBundle,
  importWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
} from './evidence-bundles.js';
import {
  createInjectionPlan,
  importInjectionPlans,
  listExportableInjectionPlans,
} from './injection-plans.js';
import {
  createInjectionReceipt,
  importInjectionReceipts,
  listExportableInjectionReceipts,
} from './injection-receipts.js';
import type { DelegationContextRef } from './internal-agents/delegation.js';
import { QUICK_CHAT_AGENT_ID, type QuickChatAgentOutput } from './internal-agents/quick-chat.js';
import { redactInternalAgentText } from './internal-agents/redaction.js';
import { InternalAgentRunner } from './internal-agents/runner.js';
import type {
  InternalAgentDefaultProviderUse,
  InternalAgentDiagnosticsSnapshot,
} from './internal-agents/types.js';
import {
  createWorkerCoordinatorDecision,
  createWorkerCoordinatorGoalPlanDraft,
  createWorkerCoordinatorGoalStopDecision,
  type WorkerCoordinatorCandidate,
  type WorkerCoordinatorDecision,
} from './internal-agents/worker-coordinator.js';
import {
  answerKnowledgeManager,
  checkKnowledgeHealth,
  draftKnowledgeProposal,
  prepareKnowledgeContext,
  suggestKnowledgeRepairs,
} from './knowledge-manager.js';
import { searchKnowledgeEntries } from './knowledge-search.js';
import { AutomationStore } from './lib/automation-store.js';
import {
  type CommandRequestName,
  type CommandRequestRecord,
  type CommandRequestResponseKind,
  type CommandRequestScope,
  commandRequestKey,
  FsStore,
  type ImportWorkspaceStage,
} from './lib/store.js';
import type { CodexOAuthStore } from './llm/codex-oauth.js';
import { CodexOAuthAccountManager } from './llm/codex-oauth-accounts.js';
import { CodexAuthTokenResolver, CodexResponsesClient } from './llm/codex-responses-client.js';
import { GatewayUnsupportedFeatureError } from './llm/gateway-converters.js';
import { GatewayPolicyStore } from './llm/gateway-policy.js';
import { GatewayUsageTracker, parseUsage } from './llm/gateway-usage.js';
import {
  type OpenAICompatibleChatCompletionResponse,
  type OpenAICompatibleChatMessage,
  OpenAICompatibleProviderError,
  type OpenAICompatibleResponsesResponse,
} from './llm/openai-compatible-client.js';
import { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { LLMProviderConfigStore, type ResolvedLLMProviderConfig } from './llm/provider-config.js';
import { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { createAppOpenApiDocument } from './openapi.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import {
  importWorkspacePermissionDecisions,
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
  recordGatewayPolicyDecision,
  recordGoalWorkerLaunchDecision,
  recordProductPermissionDecision,
} from './policy/permission-decisions.js';
import { readCodexOAuthAccountSlotId } from './providers/codex-oauth-profile.js';
import { resolveDefaultProviderStates } from './providers/default-provider.js';
import type { ProviderDiagnosticsSnapshot } from './providers/diagnostics.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import {
  type OpenAICompatFacadeOptions,
  registerOpenAICompatFacade,
} from './providers/openai-compat-facade.js';
import {
  type ProviderCredentialResolver,
  type ProviderRegistry,
  resolveEnvSecretRef,
} from './providers/registry.js';
import { createVaultProviderCredentialResolver } from './providers/vault-credential-resolver.js';
import {
  importAgentEnvironmentPackageSnapshots,
  listExportableAgentEnvironmentPackageSnapshots,
  requireAgentEnvironmentPackageSnapshot,
} from './runtime/aep-snapshot-ledger.js';
import { UpdateTurnFeedbackRequestSchema, updateTurnFeedback } from './runtime/feedback.js';
import { applyStagedFilesystemChanges } from './runtime/filesystem-workspace-sync.js';
import { executeGitPushAttempt, runGitPushCommand } from './runtime/git-push-executor.js';
import {
  getGitPushRecord,
  importWorkspaceGitPushRecords,
  listExportableGitPushRecords,
  listGitPushRecords,
} from './runtime/git-push-records.js';
import { approveGoalPlan, reviseGoalPlan } from './runtime/goal-plan-approval.js';
import { createGoalPlan } from './runtime/goal-planning.js';
import {
  createGoalReviewRecord,
  type GoalReviewRecord,
  getGoalReviewRecord,
  importGoalReviewRecords,
  listExportableGoalReviewRecords,
  resolveGoalReviewRecord,
} from './runtime/goal-review-records.js';
import { getGoalSteeringReadModel, recordActiveGoalSteering } from './runtime/goal-steering.js';
import {
  createGoalRecord,
  type GoalRecord,
  type GoalTaskRecord,
  getGoalRecord,
  importGoalRecords,
  importGoalTasks,
  listExportableGoalRecords,
  listExportableGoalTasks,
  listGoalRecordsForThread,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import { advanceGoalAfterReview } from './runtime/goal-supervise-advance.js';
import { prepareGoalTaskDelegation } from './runtime/goal-task-delegation.js';
import { persistApprovedGoalTasks } from './runtime/goal-task-persistence.js';
import { selectNextReadyGoalTask } from './runtime/goal-task-selector.js';
import {
  type GoalVerificationRecord,
  importGoalVerificationRecords,
  listExportableGoalVerificationRecords,
  listGoalVerificationRecordsForGoal,
} from './runtime/goal-verification-records.js';
import { recordGoalTaskWorkerOutcome } from './runtime/goal-worker-outcome.js';
import { startGoalTaskWorkerTurn } from './runtime/goal-worker-start.js';
import { DEFAULT_AGENT_MANIFESTS, TurnStartValidationError } from './runtime/orchestrator.js';
import {
  cancelPendingUserTurn,
  convertPendingUserTurnToFollowUp,
  enqueuePendingUserTurn,
  importPendingUserTurns,
  listExportablePendingUserTurns,
  listPendingUserTurns,
  promotePendingUserTurnToInterrupt,
  recordPendingUserTurnEditedAuditEvent,
} from './runtime/pending-user-turns.js';
import type { PreparedNextTurn } from './runtime/prepare-next-turn.js';
import {
  importWorkspaceRuntimeEvidence,
  listWorkspaceRuntimeEvidence,
} from './runtime/runtime-evidence.js';
import { runSchedulerDispatchLoop } from './runtime/scheduler-dispatch-loop.js';
import { stopReasonForTurnStatus } from './runtime/stop-after-turn.js';
import { createConfiguredTurnExecutor } from './runtime/turn-executor-factory.js';
import type {
  AgentSessionBackendControlSummary,
  RuntimeCapabilities,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './runtime/types.js';
import {
  getWorkerCheckpoint,
  importWorkerCheckpoints,
  listExportableWorkerCheckpoints,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import { createWorkerControlCommandDeliveryRecorder } from './runtime/worker-control-commands.js';
import {
  WorkerControlGateway,
  WorkerControlGatewayError,
  type WorkerControlLineage,
  type WorkerControlSessionSnapshot,
} from './runtime/worker-control-gateway.js';
import { rebuildWorkerControlGatewaySessions } from './runtime/worker-control-rebuild.js';
import { createWorkerControlAcceptedRecordRecorder } from './runtime/worker-control-records.js';
import { recordWorkerControlRejectedEvidence } from './runtime/worker-control-rejected-evidence.js';
import { createWorkerControlSequenceRecorder } from './runtime/worker-control-sequences.js';
import {
  createDefaultWorkerMcpGateway,
  type WorkerMcpGateway,
  type WorkerMcpGatewayCredentials,
  type WorkerMcpLiveSchemaSnapshot,
} from './runtime/worker-mcp-gateway.js';
import {
  clearWorkerCheckpointAfterTerminalState,
  materializeInterruptedWorkerStates,
} from './runtime/worker-recovery.js';
import { runWorkerTurnLoop } from './runtime/worker-turn-loop.js';
import {
  importWorkspaceApplyPlans,
  listExportableWorkspaceApplyPlans,
  listWorkspaceApplyPlans,
  recordWorkspaceApplyPlan,
} from './runtime/workspace-apply-plans.js';
import {
  getWorkspaceApplyResult,
  importWorkspaceApplyResults,
  listExportableWorkspaceApplyResults,
  listWorkspaceApplyResults,
  recordWorkspaceApplyResult,
} from './runtime/workspace-apply-results.js';
import { getFilesystemWorkspaceStagingRoot } from './runtime/workspace-filesystem-staging.js';
import {
  importWorkspaceQuarantineRecords,
  listExportableWorkspaceQuarantineRecords,
  listWorkspaceQuarantineRecords,
} from './runtime/workspace-quarantine-records.js';
import {
  importWorkspaceReconciliationRecords,
  listExportableWorkspaceReconciliationRecords,
  listWorkspaceReconciliationRecords,
  resolveWorkspaceReconciliationRecord,
} from './runtime/workspace-reconciliation-records.js';
import {
  importWorkspaceSyncEvidenceBundles,
  listExportableWorkspaceSyncEvidenceBundles,
  listWorkspaceSyncEvidenceBundles,
} from './runtime/workspace-sync-evidence-bundles.js';
import {
  getWorkspaceSyncReview,
  importWorkspaceSyncRecords,
  listBackendWorkspaceHandles,
  listExportableWorkspaceSyncRecords,
  listWorkerOutputManifests,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
  recordWorkspaceSyncReview,
  updateBackendWorkspaceHandleCleanupStatus,
  updateWorkspaceSyncReviewDecision,
} from './runtime/workspace-sync-records.js';
import {
  cancelSchedulerAdmissionEntry,
  completeSchedulerTurnLease,
  createSchedulerAdmissionEntry,
  ensureLocalhostSchedulerBaseline,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  markSchedulerSessionLeaseReleasing,
  recordSchedulerSupplyRefreshAck,
  resolveSchedulerLeaseTokenBinding,
  retryDeniedSchedulerAdmissionEntry,
} from './scheduler-records.js';
import {
  type VerifiedDataRootBackupManifest,
  verifyDataRootBackupManifest,
  writeHotDataRootBackup,
} from './storage/data-root-backup.js';
import {
  type CoreDb,
  openWorkspaceDb,
  openWorkspaceDbAtRoot,
  type WorkspaceDb,
} from './storage/db.js';
import {
  ensureWorkspaceLayout,
  LOCAL_USER_ID,
  readDataRootLayoutMarker,
} from './storage/fs-layout.js';
import {
  readWorkspaceKnowledgeDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { createStorageLayoutReport } from './storage/layout-report.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  dryRunWorkspaceImport,
  readWorkspaceImportSnapshot,
  writeWorkspaceExportTree,
} from './storage/workspace-export.js';
import { recordVaultAdminAuditEvent } from './vault-admin-audit-events.js';
import type { VaultSecretMaterial } from './vault-backend.js';
import {
  createVaultGrant,
  getVaultGrant,
  importWorkspaceVaultGrants,
  listExportableWorkspaceVaultGrants,
} from './vault-grants.js';
import type { OsKeychainVaultAdapter } from './vault-os-keychain-backend.js';
import {
  createVaultReference,
  getVaultReference,
  importUnboundWorkspaceVaultReference,
  listWorkspaceVaultReferences,
  rebindWorkspaceVaultReference,
} from './vault-references.js';
import { createVaultUnlockState, type VaultUnlockState } from './vault-unlock-state.js';
import { createVaultUseAuditedBackend } from './vault-use-audited-backend.js';
import {
  importWorkspaceVaultUseRecords,
  listExportableWorkspaceVaultUseRecords,
  listVaultUseRecords,
} from './vault-use-records.js';
import {
  backfillRepositoryDataSourceCatalogs,
  syncRepositoryDataSourceCatalog,
} from './workspace/repository-data-source-catalog.js';
import {
  createWorkspaceRepositoryDiagnostic,
  safeWorkspaceRepositoryDisplayName,
} from './workspace/repository-diagnostics.js';
import {
  getDefaultWorkspaceRepositoryResource,
  importWorkspaceRepositoryResources,
  listExportableWorkspaceRepositoryResources,
  listWorkspaceRepositoryResources,
  upsertWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from './workspace/repository-store.js';
import { validateRepositoryPath } from './workspace/repository-validation.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const ListKnowledgeResponseSchema = z.object({ items: z.array(KnowledgeEntrySchema) });
const ListThreadsResponseSchema = z.object({ items: z.array(ThreadSchema) });
const ListArtifactsResponseSchema = z.object({ items: z.array(ArtifactSchema) });
const workerMcpToolArgumentValidator = new Ajv2020({ allErrors: false, strict: false });
const VAULT_UNLOCK_FAILURE_LIMIT = 5;
const VAULT_UNLOCK_FAILURE_WINDOW_MS = 60_000;
const CODEX_AUTH_JSON_VAULT_GRANT_ID = 'grant_codex_auth_json';
const CODEX_AUTH_JSON_VAULT_REFERENCE_ID = 'vault_codex_auth_json';
const CODEX_AUTH_JSON_TARGET_PATH = '/sandbox/.codex/auth.json';

type ArtifactReadModel = z.infer<typeof ArtifactSchema>;
type WorkspaceSyncReviewItem = z.infer<typeof GetWorkspaceSyncReviewResponseSchema>;
type WorkspaceApplyPlan = z.infer<typeof WorkspaceApplyPlanSchema>;
type WorkspaceApplyResult = z.infer<typeof WorkspaceApplyResultSchema>;
type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/**
 * Parses one workspace synchronization review artifact into a public App API item.
 *
 * @param artifact Artifact candidate from the workspace store.
 * @returns Parsed workspace sync review item, or null when the artifact is not one.
 */
function parseWorkspaceSyncReviewArtifact(
  artifact: ArtifactReadModel
): WorkspaceSyncReviewItem | null {
  if (artifact.content.format !== 'json') {
    return null;
  }

  try {
    const parsed = JSON.parse(artifact.content.body) as unknown;

    return GetWorkspaceSyncReviewResponseSchema.parse({
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      artifactId: artifact.id,
    });
  } catch {
    return null;
  }
}

/**
 * Lists parsed workspace synchronization review artifacts in stable newest-first order.
 *
 * @param artifacts Workspace artifact candidates.
 * @returns Parsed workspace sync review items.
 */
function listWorkspaceSyncReviewArtifacts(
  artifacts: readonly ArtifactReadModel[]
): WorkspaceSyncReviewItem[] {
  return artifacts
    .map(parseWorkspaceSyncReviewArtifact)
    .filter((item): item is WorkspaceSyncReviewItem => item !== null)
    .sort((left, right) => right.review.updatedAt.localeCompare(left.review.updatedAt));
}

/**
 * Records artifact-backed workspace synchronization reviews into durable product records.
 *
 * @param artifacts Workspace artifact candidates.
 * @param workspaceDb Open workspace-scope database handle.
 * @returns Durable workspace synchronization review items.
 */
function materializeWorkspaceSyncReviewArtifacts(
  artifacts: readonly ArtifactReadModel[],
  workspaceDb: WorkspaceDb
): WorkspaceSyncReviewItem[] {
  return listWorkspaceSyncReviewArtifacts(artifacts).map((item) =>
    recordWorkspaceSyncReview(workspaceDb, { item })
  );
}

/**
 * Materializes pending workspace reviews as local Git review branches when configured.
 *
 * @param input Review branch materialization input.
 */
async function materializeWorkspaceReviewBranches(input: {
  readonly repository: WorkspaceRepositoryResourceRecord | null;
  readonly reviews: readonly WorkspaceSyncReviewItem[];
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
}): Promise<void> {
  if (!input.repository || input.repository.git.stagingStrategy !== 'review-branch') {
    return;
  }

  const appliedReviewIds = new Set(
    listWorkspaceApplyResults(input.workspaceDb, input.repository.workspaceId).map(
      (result) => result.reviewId
    )
  );

  for (const review of input.reviews) {
    if (
      review.changeSet.strategy === 'git' &&
      review.review.status === 'pending' &&
      !appliedReviewIds.has(review.review.id)
    ) {
      const commitId = await materializeWorkspaceReviewBranch(
        input.repository,
        review,
        input.store
      );
      recordWorkspaceSyncReview(input.workspaceDb, {
        item: {
          ...review,
          changeSet: {
            ...review.changeSet,
            head: { ...review.changeSet.head, commit: commitId },
          },
        },
      });
    }
  }
}

/**
 * Creates or refreshes one local Git review branch for a staged review.
 *
 * @param repository Linked repository resource.
 * @param review Workspace synchronization review item.
 * @param store App-local store used for worker attribution.
 */
async function materializeWorkspaceReviewBranch(
  repository: WorkspaceRepositoryResourceRecord,
  review: WorkspaceSyncReviewItem,
  store: FsStore
): Promise<string> {
  if (
    review.changeSet.strategy !== 'git' ||
    review.changeSet.resourceId !== repository.resourceId
  ) {
    return review.changeSet.head.commit ?? '';
  }

  const branch = requireWorkspaceReviewBranch(review);
  const turnId = review.changeSet.evidenceRefs.find((ref) => ref.kind === 'worker')?.ref;

  if (!turnId) {
    throw new Error(`Workspace review has no worker turn lineage: ${review.review.id}`);
  }

  if (!repository.git.authorName || !repository.git.authorEmail) {
    throw new Error(`Workspace repository has no Git identity: ${review.review.id}`);
  }

  if (!review.changeSet.base.commit) {
    throw new Error(`Workspace review has no base commit: ${review.review.id}`);
  }

  const patchText = workspaceReviewPatchTextForGitApply(review);
  const stagedPaths = review.changeSet.changedPaths.map((path) => path.path);
  const currentBranch = (await runGit(repository.localPath, ['branch', '--show-current'])).trim();
  const restoreRef =
    currentBranch || (await runGit(repository.localPath, ['rev-parse', 'HEAD'])).trim();

  try {
    await runGit(repository.localPath, ['checkout', '-B', branch, review.changeSet.base.commit]);
    await runGitWithPatch(
      repository.localPath,
      ['apply', '--check', '--whitespace=nowarn', '-'],
      patchText
    );
    await runGitWithPatch(repository.localPath, ['apply', '--whitespace=nowarn', '-'], patchText);
    await runGit(repository.localPath, ['add', '-A', '--', ...stagedPaths]);
    await runGit(
      repository.localPath,
      ['commit', '--file', '-'],
      workspaceReviewStagingCommitMessage(
        review,
        turnId,
        resolveWorkerGitAttribution(store, review, turnId)
      ),
      {
        GIT_AUTHOR_EMAIL: repository.git.authorEmail,
        GIT_AUTHOR_NAME: repository.git.authorName,
        GIT_COMMITTER_EMAIL: repository.git.authorEmail,
        GIT_COMMITTER_NAME: repository.git.authorName,
      }
    );
    return (await runGit(repository.localPath, ['rev-parse', 'HEAD'])).trim();
  } finally {
    await runGit(repository.localPath, ['checkout', restoreRef]);
  }
}

/**
 * Deletes a terminal local Git review branch when present.
 *
 * @param repository Linked repository resource.
 * @param review Workspace synchronization review item.
 */
async function deleteWorkspaceReviewBranch(
  repository: WorkspaceRepositoryResourceRecord,
  review: WorkspaceSyncReviewItem
): Promise<void> {
  if (repository.git.stagingStrategy !== 'review-branch' || review.changeSet.strategy !== 'git') {
    return;
  }

  const branch = requireWorkspaceReviewBranch(review);

  try {
    await runGit(repository.localPath, ['branch', '-D', branch]);
  } catch {
    return;
  }
}

/**
 * Reads the reserved local Git branch name for one workspace review.
 *
 * @param review Workspace synchronization review item.
 * @returns Reserved branch name.
 */
function requireWorkspaceReviewBranch(review: WorkspaceSyncReviewItem): string {
  const branch = review.review.staging.branch;
  const expected = `openkit/review/${review.review.id}`;

  if (branch !== expected || !/^openkit\/review\/[A-Za-z0-9._-]+$/.test(branch)) {
    throw new Error(`Workspace review branch is not safe: ${review.review.id}`);
  }

  return branch;
}

/**
 * Applies one accepted workspace synchronization review patch to a linked Git repository.
 *
 * @param review Workspace synchronization review item parsed from the artifact.
 * @param repository Linked repository resource that should receive the patch.
 * @param appliedAt Application timestamp.
 * @returns Product-safe apply result.
 */
async function applyWorkspaceSyncReviewPatch(input: {
  review: WorkspaceSyncReviewItem;
  repository: WorkspaceRepositoryResourceRecord;
  store: FsStore;
  appliedAt: string;
}): Promise<WorkspaceApplyResult> {
  const { review, repository, store, appliedAt } = input;

  if (review.changeSet.resourceId !== repository.resourceId) {
    throw new Error(
      `Workspace review resource ${review.changeSet.resourceId} does not match linked repository ${repository.resourceId}.`
    );
  }

  const patchForGitApply = workspaceReviewPatchTextForGitApply(review);

  await runGitWithPatch(
    repository.localPath,
    ['apply', '--check', '--whitespace=nowarn', '-'],
    patchForGitApply
  );
  await runGitWithPatch(
    repository.localPath,
    ['apply', '--whitespace=nowarn', '-'],
    patchForGitApply
  );
  const appliedPaths = review.changeSet.changedPaths.map((path) => path.path);
  const commitIds = repository.git.commitOnApply
    ? [
        await commitAppliedWorkspaceSyncReview({
          patchText: patchForGitApply,
          repositoryGit: repository.git,
          repositoryPath: repository.localPath,
          review,
          stagedPaths: appliedPaths,
          store,
        }),
      ]
    : [];

  return WorkspaceApplyResultSchema.parse({
    id: `war_${review.review.id}`,
    workspaceId: review.review.workspaceId,
    reviewId: review.review.id,
    changeSetId: review.changeSet.id,
    status: 'applied',
    appliedPaths,
    skippedPaths: [],
    conflictRecords: [],
    verification: [{ command: 'git apply --check', status: 'passed', ref: null }],
    commitIds,
    appliedAt,
  });
}

/**
 * Commits an already-applied workspace review patch in the linked repository.
 *
 * @param input Applied review commit input.
 * @returns New commit id.
 * @throws Error when staging or commit creation fails.
 */
async function commitAppliedWorkspaceSyncReview(input: {
  readonly repositoryPath: string;
  readonly repositoryGit: WorkspaceRepositoryResourceRecord['git'];
  readonly review: WorkspaceSyncReviewItem;
  readonly stagedPaths: readonly string[];
  readonly patchText: string;
  readonly store: FsStore;
}): Promise<string> {
  const turnId = input.review.changeSet.evidenceRefs.find((ref) => ref.kind === 'worker')?.ref;

  if (!turnId) {
    await revertAppliedWorkspaceSyncReview(
      input.repositoryPath,
      input.stagedPaths,
      input.patchText
    );
    throw new Error(`Workspace review has no worker turn lineage: ${input.review.review.id}`);
  }

  if (!input.repositoryGit.authorName || !input.repositoryGit.authorEmail) {
    await revertAppliedWorkspaceSyncReview(
      input.repositoryPath,
      input.stagedPaths,
      input.patchText
    );
    throw new Error(`Workspace repository has no Git identity: ${input.review.review.id}`);
  }

  let committed = false;
  try {
    await runGit(input.repositoryPath, ['add', '-A', '--', ...input.stagedPaths]);
    await runGit(
      input.repositoryPath,
      ['commit', '--file', '-'],
      workspaceReviewCommitMessage(
        input.review,
        turnId,
        resolveWorkerGitAttribution(input.store, input.review, turnId)
      ),
      {
        GIT_AUTHOR_EMAIL: input.repositoryGit.authorEmail,
        GIT_AUTHOR_NAME: input.repositoryGit.authorName,
        GIT_COMMITTER_EMAIL: input.repositoryGit.authorEmail,
        GIT_COMMITTER_NAME: input.repositoryGit.authorName,
      }
    );
    committed = true;
    return (await runGit(input.repositoryPath, ['rev-parse', 'HEAD'])).trim();
  } catch (error) {
    if (!committed) {
      await revertAppliedWorkspaceSyncReview(
        input.repositoryPath,
        input.stagedPaths,
        input.patchText
      );
    }
    throw error;
  }
}

/**
 * Resolves product-safe worker attribution for Git commit trailers.
 *
 * @param store App-local store that owns turns and agents.
 * @param review Applied workspace review.
 * @param turnId Worker turn id associated with the change set.
 * @returns Co-author identity for the worker agent.
 */
function resolveWorkerGitAttribution(
  store: FsStore,
  review: WorkspaceSyncReviewItem,
  turnId: string
): { readonly email: string; readonly name: string } {
  const turn = store.getTurnById(turnId);
  const agentId = turn.agentId ?? store.resolveTurnAgentId(turn);
  const agent = agentId ? store.getAgent(review.review.workspaceId, agentId) : null;
  const safeAgentId = (agent?.id ?? 'unknown-agent').replace(/[^A-Za-z0-9._+-]/g, '-');

  return {
    email: `${safeAgentId}@agents.openkit.invalid`,
    name: sanitizeGitTrailerName(agent?.name ?? 'Unknown OpenKit Agent'),
  };
}

/**
 * Removes Git-trailer delimiters from a display name.
 *
 * @param name Candidate display name.
 * @returns Trailer-safe display name.
 */
function sanitizeGitTrailerName(name: string): string {
  const sanitized = name
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || 'Unknown OpenKit Agent';
}

/**
 * Restores a repository after commit-on-apply fails.
 *
 * @param repositoryPath Repository working directory.
 * @param stagedPaths Paths staged by the failed commit attempt.
 * @param patchText Applied patch text to reverse.
 */
async function revertAppliedWorkspaceSyncReview(
  repositoryPath: string,
  stagedPaths: readonly string[],
  patchText: string
): Promise<void> {
  await runGit(repositoryPath, ['reset', '--', ...stagedPaths]);
  await runGitWithPatch(
    repositoryPath,
    ['apply', '--reverse', '--whitespace=nowarn', '-'],
    patchText
  );
}

/**
 * Builds the lineage-bearing commit message for an applied workspace review.
 *
 * @param review Applied workspace review.
 * @param turnId Worker turn id associated with the change set.
 * @returns Git commit message.
 */
function workspaceReviewCommitMessage(
  review: WorkspaceSyncReviewItem,
  turnId: string,
  worker: { readonly email: string; readonly name: string }
): string {
  return [
    `Apply workspace review ${review.review.id}`,
    '',
    review.review.riskSummary,
    '',
    `OpenKit-Review-Id: ${review.review.id}`,
    `OpenKit-Turn-Id: ${turnId}`,
    `OpenKit-Workspace-Id: ${review.review.workspaceId}`,
    `Co-Authored-By: ${worker.name} <${worker.email}>`,
    '',
  ].join('\n');
}

/**
 * Builds the lineage-bearing commit message for a staged local review branch.
 *
 * @param review Staged workspace review.
 * @param turnId Worker turn id associated with the change set.
 * @param worker Product-safe worker attribution.
 * @returns Git commit message.
 */
function workspaceReviewStagingCommitMessage(
  review: WorkspaceSyncReviewItem,
  turnId: string,
  worker: { readonly email: string; readonly name: string }
): string {
  return [
    `Stage workspace review ${review.review.id}`,
    '',
    review.review.riskSummary,
    '',
    `OpenKit-Review-Id: ${review.review.id}`,
    `OpenKit-Turn-Id: ${turnId}`,
    `OpenKit-Workspace-Id: ${review.review.workspaceId}`,
    'Staged-By: OpenKit',
    `Co-Authored-By: ${worker.name} <${worker.email}>`,
    '',
  ].join('\n');
}

/**
 * Applies one accepted filesystem workspace synchronization review through an internal staging root.
 *
 * @param input Filesystem workspace review and storage context.
 * @returns Product-safe apply result.
 */
async function applyWorkspaceSyncReviewFilesystem(input: {
  workspaceDb: WorkspaceDb;
  review: WorkspaceSyncReviewItem;
  appliedAt: string;
}): Promise<WorkspaceApplyResult> {
  const { workspaceDb, review, appliedAt } = input;

  if (review.changeSet.strategy !== 'filesystem') {
    throw new Error(`Workspace review is not filesystem-backed: ${review.review.id}`);
  }

  const staging = getFilesystemWorkspaceStagingRoot(
    workspaceDb,
    review.review.workspaceId,
    review.review.id
  );

  if (!staging) {
    throw new Error(`Filesystem workspace staging root is not available: ${review.review.id}`);
  }

  if (staging.changeSetId !== review.changeSet.id) {
    throw new Error(`Filesystem workspace staging change set mismatch: ${review.review.id}`);
  }

  return applyStagedFilesystemChanges({
    appliedAt,
    before: staging.before,
    changeSet: review.changeSet,
    reviewId: review.review.id,
    stagingRoot: staging.stagingRootPath,
    targetRoot: staging.targetRootPath,
    workspaceId: review.review.workspaceId,
  });
}

/**
 * Records a product-safe apply plan before applying a workspace review.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param review Workspace synchronization review item.
 * @param createdAt Plan timestamp.
 * @returns Stored workspace apply plan.
 */
function recordWorkspaceApplyPlanForReview(
  workspaceDb: WorkspaceDb,
  review: WorkspaceSyncReviewItem,
  createdAt: string
): WorkspaceApplyPlan {
  return recordWorkspaceApplyPlan(
    workspaceDb,
    WorkspaceApplyPlanSchema.parse({
      approvalState: 'approved',
      baselineChecks: review.review.validation,
      binaryRisks: review.changeSet.changedPaths
        .filter((path) => path.binary)
        .map((path) => path.path),
      changeSetId: review.changeSet.id,
      createdAt,
      id: `wap_${review.review.id}`,
      pathConflicts: [],
      permissionChanges: review.changeSet.changedPaths
        .filter((path) => path.status === 'mode_changed')
        .map((path) => path.path),
      plannedWrites: review.changeSet.changedPaths.map((path) => path.path),
      policyChecks: [{ command: 'workspace review accepted', status: 'passed', ref: null }],
      reviewId: review.review.id,
      strategy: review.changeSet.strategy,
      workspaceId: review.review.workspaceId,
    })
  );
}

/**
 * Normalizes text patch framing for `git apply` without changing stored integrity checks.
 *
 * @param patchText Patch payload text after digest and byte validation.
 * @returns Patch text terminated with a newline when non-empty.
 */
function normalizeGitPatchTextForApply(patchText: string): string {
  return patchText.length > 0 && !patchText.endsWith('\n') ? `${patchText}\n` : patchText;
}

/**
 * Validates a workspace review patch payload and returns Git-apply-ready text.
 *
 * @param review Workspace synchronization review item.
 * @returns Normalized patch text.
 */
function workspaceReviewPatchTextForGitApply(review: WorkspaceSyncReviewItem): string {
  const patchPayload = review.patchPayload;

  if (!patchPayload) {
    throw new Error(`Workspace review has no patch payload: ${review.review.id}`);
  }

  if (!review.changeSet.patch) {
    throw new Error(`Workspace review has no patch reference: ${review.review.id}`);
  }

  if (review.changeSet.patch.digest !== patchPayload.digest) {
    throw new Error(`Workspace review patch digest mismatch: ${review.review.id}`);
  }

  if (review.changeSet.patch.bytes !== patchPayload.bytes) {
    throw new Error(`Workspace review patch byte count mismatch: ${review.review.id}`);
  }

  const actualDigest = `sha256:${createHash('sha256').update(patchPayload.text).digest('hex')}`;
  const actualBytes = Buffer.byteLength(patchPayload.text, 'utf8');

  if (actualDigest !== patchPayload.digest || actualBytes !== patchPayload.bytes) {
    throw new Error(
      `Workspace review patch payload failed integrity validation: ${review.review.id}`
    );
  }

  return normalizeGitPatchTextForApply(patchPayload.text);
}

/**
 * Runs one fixed Git patch command with the patch supplied on stdin.
 *
 * @param cwd Repository working directory.
 * @param args Git arguments.
 * @param patchText Patch text to stream to stdin.
 * @returns Resolves after Git exits successfully.
 */
async function runGitWithPatch(
  cwd: string,
  args: readonly string[],
  patchText: string
): Promise<void> {
  await runGit(cwd, args, patchText);
}

/**
 * Runs one fixed Git command with optional stdin and captured diagnostics.
 *
 * @param cwd Repository working directory.
 * @param args Git arguments.
 * @param stdin Optional text to stream to stdin.
 * @param env Optional extra environment variables.
 * @returns Captured stdout.
 */
async function runGit(
  cwd: string,
  args: readonly string[],
  stdin = '',
  env: NodeJS.ProcessEnv = {}
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      callback();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        return;
      }
      finish(() => reject(error));
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        finish(() => resolve(Buffer.concat(stdoutChunks).toString('utf8')));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(() =>
        reject(new Error(stderr || `git ${args.join(' ')} failed with exit code ${exitCode}.`))
      );
    });
    child.stdin.end(stdin);
  });
}

/**
 * Parsed turn read model shape used by route-level guards.
 */
type TurnReadModel = z.infer<typeof TurnSchema>;

/**
 * Checks whether a turn can accept a follow-up user-input response through `/api/turns`.
 *
 * @param turn Turn read model to inspect.
 * @returns True when the turn is paused on a user-input human gate.
 */
function isAwaitingUserInputGate(turn: TurnReadModel): boolean {
  return turn.status === 'awaiting_human' && turn.humanGate.kind === 'user-input';
}

/**
 * Builds an empty task count object for a goal read model.
 *
 * @returns Goal task counts initialized to zero.
 */
function emptyGoalTaskCounts(): GoalTaskCounts {
  return {
    pending: 0,
    ready: 0,
    running: 0,
    reviewing: 0,
    needsRevision: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  };
}

/**
 * Counts goal tasks by lifecycle status.
 *
 * @param tasks Stored goal tasks.
 * @returns Goal task counts keyed by task status.
 */
function countGoalTasks(tasks: readonly GoalTaskRecord[]): GoalTaskCounts {
  const counts = emptyGoalTaskCounts();

  for (const task of tasks) {
    if (task.status === 'needs_revision') {
      counts.needsRevision += 1;
      continue;
    }

    counts[task.status] += 1;
  }

  return counts;
}

/**
 * Finds the current task read model for one goal.
 *
 * @param goal Stored goal record.
 * @param tasks Stored goal tasks for the goal.
 * @returns Current task summary, or null when no current task is set.
 */
function findCurrentGoalTask(
  goal: GoalRecord,
  tasks: readonly GoalTaskRecord[]
): ThreadGoalCurrentTask | null {
  const task = goal.currentTaskId
    ? (tasks.find((candidate) => candidate.taskId === goal.currentTaskId) ?? null)
    : null;

  if (!task) {
    return null;
  }

  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    orderIndex: task.orderIndex,
  };
}

/**
 * Projects pending human attention for one goal.
 *
 * @param goal Stored goal record.
 * @param threadItems Durable thread items associated with the goal thread.
 * @returns Human attention summary for the goal read model.
 */
function projectGoalHumanAttention(
  goal: GoalRecord,
  threadItems: readonly { readonly type: string; readonly status: string }[]
): GoalPendingHumanAttention {
  if (goal.status === 'awaiting_plan_approval') {
    return { required: true, reason: 'Goal plan needs approval.' };
  }

  if (goal.status === 'awaiting_user') {
    return { required: true, reason: 'Goal is awaiting user input.' };
  }

  if (goal.status === 'reviewing') {
    return { required: true, reason: 'Worker result needs review.' };
  }

  if (goal.status === 'blocked') {
    return { required: true, reason: 'Goal is blocked.' };
  }

  if (goal.status === 'failed') {
    return { required: true, reason: 'Goal step failed.' };
  }

  const hasPendingHumanItem = threadItems.some(
    (item) =>
      item.status === 'in_progress' &&
      (item.type === 'approval-request' || item.type === 'user-input-request')
  );

  if (hasPendingHumanItem) {
    return { required: true, reason: 'Goal has pending human input.' };
  }

  return { required: false, reason: null };
}

/**
 * Projects terminal state for one goal.
 *
 * @param goal Stored goal record.
 * @returns Terminal state summary, or null while the goal is still active.
 */
function projectGoalTerminalState(goal: GoalRecord): GoalTerminalState | null {
  switch (goal.status) {
    case 'completed':
    case 'blocked':
    case 'aborted':
    case 'failed':
      return { status: goal.status, stopReason: goal.terminalStopReason };
    default:
      return null;
  }
}

/**
 * Projects stored terminal evidence into a goal closeout read model.
 *
 * @param goal Stored goal record.
 * @param tasks Stored goal tasks for the goal.
 * @param verifications Stored verification evidence for the goal.
 * @returns Terminal summary, or null while the goal is active.
 */
function projectGoalTerminalSummary(
  goal: GoalRecord,
  tasks: readonly GoalTaskRecord[],
  verifications: readonly GoalVerificationRecord[]
): GoalTerminalSummary | null {
  if (!projectGoalTerminalState(goal)) {
    return null;
  }

  return {
    artifactIds: dedupeStrings(verifications.flatMap((verification) => verification.artifactIds)),
    blockedTaskIds: tasks
      .filter((task) => task.status === 'blocked' || task.status === 'failed')
      .map((task) => task.taskId),
    completedTaskIds: tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.taskId),
    risks: projectGoalTerminalRisks(tasks, verifications),
    skippedTaskIds: tasks.filter((task) => task.status === 'skipped').map((task) => task.taskId),
    suggestedNextWork: [],
    verificationEvidence: verifications.map((verification) => ({
      artifactIds: [...verification.artifactIds],
      command: verification.command,
      status: verification.status,
      summary: verification.summary,
      verificationId: verification.verificationId,
    })),
  };
}

/**
 * Projects terminal risks from task and verification state.
 *
 * @param tasks Stored goal tasks for the goal.
 * @param verifications Stored verification evidence for the goal.
 * @returns User-facing terminal risk strings.
 */
function projectGoalTerminalRisks(
  tasks: readonly GoalTaskRecord[],
  verifications: readonly GoalVerificationRecord[]
): string[] {
  const risks: string[] = [];
  const blockedTaskCount = tasks.filter(
    (task) => task.status === 'blocked' || task.status === 'failed'
  ).length;
  const incompleteTaskCount = tasks.filter(
    (task) => !['completed', 'skipped', 'blocked', 'failed'].includes(task.status)
  ).length;
  const hasPassingFinalVerification = verifications.some(
    (verification) => verification.taskId === null && verification.status === 'passed'
  );

  if (blockedTaskCount > 0) {
    risks.push(`${blockedTaskCount} required task is blocked or failed.`);
  }

  if (incompleteTaskCount > 0) {
    risks.push(`${incompleteTaskCount} required task is not accepted or skipped.`);
  }

  if (!hasPassingFinalVerification) {
    risks.push('No passing final verification record is available.');
  }

  return risks;
}

/**
 * Deduplicates strings while preserving first-seen order.
 *
 * @param values Values to deduplicate.
 * @returns Deduplicated values.
 */
function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the latest thread goal summary read model from app-local goal storage.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param threadItems Durable thread items for human attention projection.
 * @returns Latest goal summary for the thread, or null when no goal exists.
 */
function buildThreadGoalSummary(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  threadItems: readonly { readonly type: string; readonly status: string }[]
): ThreadGoalSummary | null {
  const goal = listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).at(-1) ?? null;

  if (!goal) {
    return null;
  }

  const tasks = listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId });
  const verifications = listGoalVerificationRecordsForGoal(workspaceDb, {
    workspaceId,
    threadId,
    goalId: goal.goalId,
  });

  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    threadId: goal.threadId,
    status: goal.status,
    title: goal.title,
    objective: goal.objective,
    currentTask: findCurrentGoalTask(goal, tasks),
    taskCounts: countGoalTasks(tasks),
    pendingHumanAttention: projectGoalHumanAttention(goal, threadItems),
    terminalState: projectGoalTerminalState(goal),
    terminalSummary: projectGoalTerminalSummary(goal, tasks, verifications),
    steering: getGoalSteeringReadModel(workspaceDb, { workspaceId, threadId }),
    updatedAt: goal.updatedAt,
  };
}

/**
 * Checks whether a goal status still represents active Goal Mode work.
 *
 * @param goal Stored goal record.
 * @returns True when the goal is not terminal.
 */
function isActiveGoal(goal: GoalRecord): boolean {
  switch (goal.status) {
    case 'completed':
    case 'blocked':
    case 'aborted':
    case 'failed':
      return false;
    default:
      return true;
  }
}

/**
 * Finds the latest active goal in a thread.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @returns Latest active goal record.
 * @throws Error when no active goal exists.
 */
function requireLatestActiveGoal(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string
): GoalRecord {
  const goal =
    listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).findLast(isActiveGoal) ?? null;

  if (!goal) {
    throw new Error('Thread does not have an active goal.');
  }

  return goal;
}

/**
 * Creates the minimal prepared worker payload used by deterministic supervise e2e routes.
 *
 * @param task Goal task selected for deterministic worker execution.
 * @returns Prepared worker payload with no provider-visible context.
 */
function createDeterministicPreparedGoalTask(task: GoalTaskRecord): PreparedNextTurn {
  return {
    contextPackageDigest: `deterministic:${task.taskId}`,
    delegationRequest: {
      objective: task.objective,
    } as PreparedNextTurn['delegationRequest'],
    followUpInputs: [],
    repository: {
      resourceId: 'repo_deterministic',
    } as PreparedNextTurn['repository'],
    steeringMessages: [],
  };
}

/**
 * Selects the task eligible for the next real Goal Mode worker step.
 *
 * @param tasks Goal tasks for one active goal.
 * @returns Running task when present, otherwise the next ready task.
 */
function selectNextGoalWorkerTask(tasks: readonly GoalTaskRecord[]): GoalTaskRecord | null {
  return (
    tasks
      .filter((task) => task.status === 'running')
      .sort((left, right) => left.orderIndex - right.orderIndex)[0] ??
    selectNextReadyGoalTask(tasks)
  );
}

const WORKER_TURN_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Waits until a worker turn reaches a terminal stored state.
 *
 * @param store Durable turn store.
 * @param turnId Worker turn id to observe.
 * @returns Terminal turn read model.
 * @throws Error when the worker turn does not finish within the bounded wait window.
 */
async function waitForWorkerTurnTerminalState(
  store: FsStore,
  turnId: string
): Promise<TurnReadModel> {
  const initialTurn = store.getTurnById(turnId);

  if (isTerminalTurnStatus(initialTurn.status)) {
    return initialTurn;
  }

  return new Promise<TurnReadModel>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe?.();
      reject(new Error(`Worker turn did not finish within ${WORKER_TURN_AWAIT_TIMEOUT_MS}ms.`));
    }, WORKER_TURN_AWAIT_TIMEOUT_MS);

    unsubscribe = store.addTurnListener(turnId, (event) => {
      if (event.event !== 'turn.completed' && event.event !== 'turn.updated') {
        return;
      }

      const turn = store.getTurnById(turnId);

      if (!isTerminalTurnStatus(turn.status) || settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(turn);
    });

    const currentTurn = store.getTurnById(turnId);

    if (isTerminalTurnStatus(currentTurn.status) && !settled) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(currentTurn);
    }
  });
}

/**
 * Checks whether a stored turn status can be used as a worker terminal outcome.
 *
 * @param status Stored turn status.
 * @returns True when the turn will not continue without a new human/API action.
 */
function isTerminalTurnStatus(status: TurnReadModel['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'awaiting_human'
  );
}

/**
 * Extracts terminal worker evidence from durable thread items.
 *
 * @param items Thread item history.
 * @param turnId Worker turn id.
 * @returns Item and artifact refs associated with the worker turn.
 */
function collectWorkerTurnEvidence(
  items: readonly StoreItem[],
  turnId: string
): { itemIds: string[]; artifactIds: string[] } {
  const turnItems = items.filter((item) => item.turnId === turnId);

  return {
    itemIds: turnItems.map((item) => item.id),
    artifactIds: turnItems.flatMap((item) =>
      item.type === 'artifact-reference' ? [item.artifactId] : []
    ),
  };
}

/**
 * Creates a product-facing pending attention row from one stop decision.
 *
 * @param outcome Higher-level worker-loop outcome.
 * @param itemId Optional item id associated with the attention state.
 * @returns Pending attention row, or null when no human-visible attention is required.
 */
function pendingAttentionForGoalStep(
  outcome: 'continue' | 'review' | 'ask_user' | 'block' | 'abort' | 'complete',
  itemId: string | null
): {
  kind: 'review' | 'user_input' | 'blocked' | 'failed' | 'interrupted';
  reason: string;
  itemId: string | null;
} | null {
  switch (outcome) {
    case 'review':
      return { kind: 'review', reason: 'Worker result needs review.', itemId };
    case 'ask_user':
      return { kind: 'user_input', reason: 'Worker requested user input.', itemId };
    case 'block':
      return { kind: 'blocked', reason: 'Goal step is blocked.', itemId };
    case 'abort':
      return { kind: 'interrupted', reason: 'Goal step was aborted.', itemId };
    case 'continue':
    case 'complete':
      return null;
  }
}

/**
 * Derives a readable goal title from request input.
 *
 * @param title Optional caller-supplied title.
 * @param objective Required goal objective.
 * @returns Title to persist on the goal record.
 */
function deriveThreadGoalTitle(title: string | undefined, objective: string): string {
  return title?.trim() || objective.trim().split(/\r?\n/, 1)[0] || objective.trim();
}

/**
 * Creates a deterministic next goal id within one thread.
 *
 * @param existingGoals Existing goals already stored for the thread.
 * @returns Next goal id.
 */
function nextThreadGoalId(existingGoals: readonly GoalRecord[]): string {
  return `goal_${existingGoals.length + 1}`;
}

const browserCors = cors({
  credentials: true,
  origin: (origin) => origin,
});
const GatewayChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
            content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            tool_call_id: z.string().optional(),
          })
          .passthrough()
      )
      .min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
const GatewayResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional(),
  })
  .passthrough();
const WorkerControlLineageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  agentSessionId: z.string().min(1),
  packageSnapshotId: z.string().min(1),
  requestId: z.string().min(1).nullable().optional(),
});
const WorkerControlHeartbeatRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  sequence: z.number().int().nonnegative(),
  status: z.enum([
    'starting',
    'running',
    'idle',
    'awaiting_command',
    'stopping',
    'completed',
    'failed',
  ]),
  message: z.string().min(1).nullable().optional(),
});
const WorkerControlArtifactNoticeRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  sequence: z.number().int().nonnegative(),
  artifact: z.object({
    title: z.string().min(1),
    path: z.string().min(1),
    mediaType: z.string().min(1).nullable().optional(),
  }),
});
const WorkerControlCommandPollRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerControlCommandAckRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  commandId: z.string().min(1),
});
const WorkerControlTerminalResultRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  terminalCommandId: z.string().min(1),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative().nullable().optional(),
});
const WorkerControlEventAppendRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  record: WorkerCanonicalEventRecordSchema,
});
const WorkerControlFinalStatusBodySchema = z
  .object({
    status: z.enum([
      'blocked',
      'cancelled',
      'completed',
      'degraded',
      'failed',
      'interrupted',
      'lost',
    ]),
    stopReason: z.string().min(1).nullable().optional(),
    evidenceManifestDigests: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
const WorkerControlSupplyRefreshAckBodySchema = z
  .object({
    refreshId: z.string().min(1),
    status: z.enum(['applied', 'rejected', 'unsupported']),
    message: z.string().min(1).nullable().optional(),
  })
  .strict();
const WorkerControlKnowledgeProposalSummaryBodySchema = z
  .object({
    proposalId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();
const WorkerCapabilityKnowledgeSearchRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});
const WorkerCapabilityKnowledgeReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  knowledgeEntryId: z.string().min(1),
});
const WorkerCapabilityKnowledgeProposalRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceReferences: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
const WorkerCapabilityArtifactReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  artifactId: z.string().min(1),
});
const WorkerCapabilityMcpListServersRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerCapabilityMcpListToolsRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  serverId: z.string().min(1),
});
const WorkerCapabilityMcpCallToolRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
  approvalRequestId: z.string().min(1).optional(),
  policyDecisionId: z.string().min(1).optional(),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const WorkerCapabilityDiagnosticReadRequestSchema = z.object({
  lineage: WorkerControlLineageRequestSchema,
});
const WorkerCapabilityMcpServerSummarySchema = z.object({
  id: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'websocket']),
  health: z.enum(['ready', 'degraded', 'failed']),
  toolNames: z.array(z.string().min(1)),
});
const WorkerCapabilityMcpToolSchema = z.object({
  name: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
});
const WorkerCapabilityMcpToolResultSchema = z.record(z.string(), z.unknown());
const WorkerCapabilityKnowledgeSearchResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  items: z.array(KnowledgeEntrySchema),
});
const WorkerCapabilityKnowledgeReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  item: KnowledgeEntrySchema,
});
const WorkerCapabilityKnowledgeProposalResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  draft: KnowledgeManagerDraftProposalResponseSchema,
});
const WorkerCapabilityArtifactReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  artifact: ArtifactSchema,
});
const WorkerCapabilityMcpListServersResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  servers: z.array(WorkerCapabilityMcpServerSummarySchema),
});
const WorkerCapabilityMcpListToolsResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  schemaSnapshotId: z.string().min(1),
  tools: z.array(WorkerCapabilityMcpToolSchema),
});
const WorkerCapabilityMcpCallToolResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  schemaSnapshotId: z.string().min(1),
  result: WorkerCapabilityMcpToolResultSchema,
});
const WorkerCapabilityDiagnosticReadResponseSchema = z.object({
  capabilityCall: WorkerCapabilityCallSummarySchema,
  diagnostics: z
    .object({
      agentSessionId: z.string().min(1),
      capabilityRouteFamilies: z.array(z.string().min(1)),
      mcpServerIds: z.array(z.string().min(1)),
      packageSnapshotId: z.string().min(1),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .strict(),
});
const WorkerCapabilityMcpCallToolApprovalResponseSchema = z.object({
  approval: ApprovalRequestSchema,
  approvalItemId: z.string().min(1),
  policyDecisionId: z.string().min(1),
});
function omitUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/**
 * Removes adapter-native runtime config from an agent catalog row.
 *
 * @param agent Runtime agent read model.
 * @returns App API agent catalog entry.
 */
function appAgentCatalogEntry(agent: unknown): unknown {
  const { config: _config, ...catalogEntry } = agent as Record<string, unknown>;

  return GetAgentCatalogEntryResponseSchema.parse(catalogEntry);
}

/**
 * Lists unique product-visible agent catalog entries across accessible workspaces.
 *
 * @param store Request-scoped workspace store.
 * @returns Agent catalog response payload.
 */
function listAgentCatalog(store: FsStore): unknown {
  const agents = new Map<string, unknown>();

  for (const workspace of store.listWorkspaces()) {
    for (const agent of store.getWorkspaceResources(workspace.id).agents) {
      if (!agents.has(agent.id)) {
        agents.set(agent.id, appAgentCatalogEntry(agent));
      }
    }
  }

  return ListAgentCatalogResponseSchema.parse({ items: [...agents.values()] });
}

/**
 * Reads one product-visible agent catalog entry across accessible workspaces.
 *
 * @param store Request-scoped workspace store.
 * @param agentId Agent id to read.
 * @returns Agent catalog entry.
 */
function getAgentCatalogEntry(store: FsStore, agentId: string): unknown {
  for (const workspace of store.listWorkspaces()) {
    const agent = store
      .getWorkspaceResources(workspace.id)
      .agents.find((candidate) => candidate.id === agentId);

    if (agent) {
      return appAgentCatalogEntry(agent);
    }
  }

  throw new Error(`Agent not found: ${agentId}`);
}

type StoreItem = ReturnType<FsStore['listAllItems']>[number];

/**
 * Converts internal runtime booleans into protocol capability flags.
 */
function mapRuntimeCapabilitiesToFlags(caps: RuntimeCapabilities): string[] {
  const flags: string[] = [];

  if (caps.approvals) {
    flags.push('core.approvals');
  }
  if (caps.interrupts) {
    flags.push('core.interrupt');
  }
  if (caps.artifacts) {
    flags.push('core.artifacts');
  }
  if (caps.workspaceKnowledgeEditing) {
    flags.push('core.knowledge.edit');
  }
  if (caps.questions) {
    flags.push('core.questions');
  }

  flags.push('core.agent_session.visible', 'core.stream.replay');

  return flags;
}

/**
 * Creates a protocol-stamped API error payload.
 *
 * @param input API error fields other than the protocol version.
 * @returns Validated protocol API error.
 */
function apiErrorPayload(
  input: Omit<z.input<typeof ApiErrorSchema>, 'protocolVersion'>
): z.output<typeof ApiErrorSchema> {
  return ApiErrorSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input });
}

function asApiError(message: string, code = 'not_found', status = 404): Response {
  return Response.json(apiErrorPayload({ code, message }), { status });
}

/**
 * Returns the first available imported workspace id using numeric suffixes.
 *
 * @param baseId Preferred imported workspace id.
 * @param exists Target workspace existence predicate.
 * @returns Available workspace id.
 */
function nextImportedWorkspaceId(baseId: string, exists: (workspaceId: string) => boolean): string {
  let workspaceId = baseId;
  let suffix = 2;
  while (exists(workspaceId)) {
    workspaceId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return workspaceId;
}

/**
 * Checks whether a request would admit new product work.
 *
 * @param method HTTP method.
 * @param path Request path.
 * @returns True when boot readiness should gate the request.
 */
function isProductWorkAdmissionRequest(method: string, path: string): boolean {
  if (
    method === 'POST' &&
    (path === '/api/app/quick-chat' ||
      path === '/api/turns' ||
      path === '/internal/v1/chat/completions' ||
      path === '/v1/chat/completions' ||
      path === '/v1/responses')
  ) {
    return true;
  }

  return (
    ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method) &&
    (path === '/api/workspaces' ||
      path.startsWith('/api/workspaces/') ||
      path === '/api/app/workspace-imports' ||
      path.startsWith('/api/app/workspaces/'))
  );
}

/**
 * Error raised when one idempotency key is reused for different command input.
 */
class IdempotencyKeyConflictError extends Error {
  /** Stable protocol API error code. */
  public readonly code = 'idempotency_key_conflict';
  /** HTTP response status. */
  public readonly status = 409;

  /**
   * Creates an idempotency key conflict error.
   */
  public constructor() {
    super('The requestId was already used for different command input.');
    this.name = 'IdempotencyKeyConflictError';
  }
}

/**
 * In-flight command state used to collapse concurrent duplicate requests.
 */
interface InflightIdempotentCommand {
  /** Hash of canonical command input. */
  readonly inputHash: string;
  /** Shared command result promise. */
  readonly promise: Promise<unknown>;
}

/**
 * Options for executing one idempotent command.
 */
interface IdempotentCommandOptions<T> {
  /** Store that owns the idempotency ledger. */
  readonly store: FsStore;
  /** Process-local in-flight command maps keyed by actor-scoped store. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Stable command name. */
  readonly command: CommandRequestName;
  /** Caller-supplied idempotency id. */
  readonly requestId: string;
  /** Non-secret scope ids. */
  readonly scope: CommandRequestScope;
  /** Canonical command input used only to compute a hash. */
  readonly input: unknown;
  /** Resource kind returned by this command. */
  readonly responseKind: CommandRequestResponseKind;
  /** Executes the command when no duplicate exists. */
  readonly execute: () => Promise<T> | T;
  /** Replays the current resource snapshot for an existing ledger record. */
  readonly replay: (record: CommandRequestRecord) => Promise<T> | T;
  /** Extracts the response resource id from a fresh command result. */
  readonly responseId: (result: T) => string;
}

/**
 * Converts command-specific errors into stable protocol API errors.
 */
function asCommandError(error: unknown, code: string, status = 404): Response {
  if (error instanceof IdempotencyKeyConflictError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof TurnStartValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asApiError((error as Error).message, code, status);
}

/**
 * Canonicalizes one value for stable hashing without storing raw command input.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`;
}

/**
 * Hashes command input for idempotency conflict detection.
 */
function commandInputHash(input: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(input)).digest('hex')}`;
}

/**
 * Executes or replays one app-local idempotent command.
 */
async function runIdempotentCommand<T>(options: IdempotentCommandOptions<T>): Promise<T> {
  const inputHash = commandInputHash(options.input);
  const existingRecord = options.store.getCommandRequest(
    options.command,
    options.requestId,
    options.scope
  );

  if (existingRecord) {
    if (existingRecord.inputHash !== inputHash) {
      throw new IdempotencyKeyConflictError();
    }

    return options.replay(existingRecord);
  }

  const key = `${options.store.getUserId()}|${commandRequestKey(
    options.command,
    options.requestId,
    options.scope
  )}`;
  let storeInflightCommands = options.inflightCommands.get(options.store);

  if (!storeInflightCommands) {
    storeInflightCommands = new Map<string, InflightIdempotentCommand>();
    options.inflightCommands.set(options.store, storeInflightCommands);
  }

  const existingInflight = storeInflightCommands.get(key);

  if (existingInflight) {
    if (existingInflight.inputHash !== inputHash) {
      throw new IdempotencyKeyConflictError();
    }

    return (await existingInflight.promise) as T;
  }

  const promise = (async () => {
    const result = await options.execute();

    options.store.recordCommandRequest({
      command: options.command,
      requestId: options.requestId,
      scope: options.scope,
      inputHash,
      response: { kind: options.responseKind, id: options.responseId(result) },
    });

    return result;
  })();

  storeInflightCommands.set(key, { inputHash, promise });

  try {
    return await promise;
  } finally {
    if (storeInflightCommands.get(key)?.promise === promise) {
      storeInflightCommands.delete(key);
    }
  }
}

/**
 * Builds the replayable response for one Goal Review decision route call.
 *
 * @param coreDb Open Core database handles.
 * @param workspaceDb Open workspace-scope database handle.
 * @param review Resolved or resolving Goal Review record.
 * @returns Parsed App API response payload.
 * @throws Error when the reviewed task is no longer available.
 */
function buildGoalReviewDecisionResponse(
  workspaceDb: WorkspaceDb,
  review: GoalReviewRecord
): unknown {
  const task = listGoalTasks(workspaceDb, {
    workspaceId: review.workspaceId,
    threadId: review.threadId,
    goalId: review.goalId,
  }).find((candidate) => candidate.taskId === review.taskId);

  if (!task) {
    throw new Error(`Goal task not found: ${review.goalId}/${review.taskId}`);
  }

  return SubmitGoalReviewDecisionResponseSchema.parse({
    review,
    advance: {
      outcome: goalReviewAdvanceOutcomeForVerdict(review.verdict),
      task,
      goal: getGoalRecord(workspaceDb, review.workspaceId, review.threadId, review.goalId),
      nextTask: review.verdict === 'retry' ? task : null,
    },
  });
}

/**
 * Maps a stored Goal Review verdict to the replayable advance outcome label.
 *
 * @param verdict Stored Goal Review verdict.
 * @returns Stable advance outcome string.
 */
function goalReviewAdvanceOutcomeForVerdict(verdict: GoalReviewRecord['verdict']): string {
  switch (verdict) {
    case 'accept':
      return 'continue';
    case 'refine':
      return 'needs_revision';
    case 'retry':
      return 'retry';
    case 'decompose':
      return 'decompose';
    case 'ask_user':
      return 'awaiting_human';
    case 'block':
      return 'blocked';
    case 'abort':
      return 'aborted';
  }
}

/**
 * Removes app-local audit fields from an artifact review response.
 *
 * @param review Stored artifact review record.
 * @returns Public App API artifact review payload.
 */
function publicArtifactReviewDecision(review: {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly status: string;
  readonly message: string | null;
  readonly decidedAt: string;
  readonly followUpTurnId: string | null;
}): unknown {
  return {
    artifactId: review.artifactId,
    workspaceId: review.workspaceId,
    threadId: review.threadId,
    turnId: review.turnId,
    status: review.status,
    message: review.message,
    decidedAt: review.decidedAt,
    followUpTurnId: review.followUpTurnId,
  };
}

/**
 * Maps account-slot manager errors to stable app API error fields.
 *
 * @param error Error thrown by account-slot creation.
 * @returns API error response metadata.
 */
function codexOAuthAccountCreateError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  const message = (error as Error).message;

  if (message.startsWith('Codex OAuth account slot already exists:')) {
    return { code: 'codex_oauth_account_exists', message, status: 409 };
  }

  return { code: 'codex_oauth_account_create_failed', message, status: 400 };
}

/**
 * Converts validation failures into a shared protocol API error response.
 *
 * @param error Validation error to expose as a product-safe message.
 * @param code Stable API error code.
 */
function asInvalidRequestError(error: unknown, code = 'invalid_request'): Response {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message;

  return asApiError(message, code, 400);
}

/**
 * Rejects project-only operations for lightweight Quick Chat workspaces.
 *
 * @param workspace Workspace record selected by the request.
 * @param action Project-only action summary for the user-facing error.
 * @throws TurnStartValidationError when the workspace is Quick Chat.
 */
function assertProjectWorkspace(workspace: WorkspaceRecord, action: string): void {
  if (workspace.kind !== 'quick-chat') {
    return;
  }

  throw new TurnStartValidationError(
    'workspace_kind_not_supported',
    `Quick Chat workspace cannot ${action}. Create or select a project workspace.`
  );
}

/**
 * Converts worker control gateway failures into stable protocol API errors.
 */
function asWorkerControlApiError(error: unknown): Response {
  if (error instanceof WorkerControlGatewayError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asInvalidRequestError(error);
}

/**
 * Stores product-safe evidence when worker-control verification rejects a parsed request.
 *
 * @param input Rejection metadata from a worker-control route.
 */
function quarantineWorkerControlRejection(input: {
  readonly coreDb: CoreDb | undefined;
  readonly error: unknown;
  readonly lineage: WorkerControlLineage;
  readonly operation: string;
  readonly route: string;
}): void {
  if (!input.coreDb || !(input.error instanceof WorkerControlGatewayError)) {
    return;
  }

  recordWorkerControlRejectedEvidence(input.coreDb, {
    errorCode: input.error.code,
    httpStatus: input.error.status,
    lineage: input.lineage,
    message: input.error.message,
    operation: input.operation,
    rejectedAt: new Date().toISOString(),
    route: input.route,
  });
}

const WORKER_CONTROL_ENVELOPE_MAX_BYTES = 64 * 1024;
const WORKER_CONTROL_EVENT_APPEND_MAX_BYTES = 256 * 1024;
const WORKER_CONTROL_TERMINAL_RESULT_MAX_BYTES = 1024 * 1024;
const WORKER_CAPABILITY_REQUEST_MAX_BYTES = 64 * 1024;

type ParsedJsonRequest<T> =
  | {
      readonly data: T;
      readonly success: true;
    }
  | {
      readonly response: Response;
      readonly success: false;
    };

/**
 * Parses one bounded JSON request body against a schema.
 *
 * @param c Hono request context.
 * @param schema Schema used to validate the parsed JSON body.
 * @param maxBytes Maximum accepted UTF-8 request body byte length.
 * @param label Human-readable payload label for diagnostics.
 * @param codes Stable error codes for oversized and invalid payloads.
 * @returns Parsed request data, or an error response.
 */
async function parseBoundedJsonRequest<T>(
  c: Context,
  schema: z.ZodType<T>,
  maxBytes: number,
  label: string,
  codes: { readonly invalid: string; readonly oversized: string } = {
    invalid: 'invalid_request',
    oversized: 'worker_control_payload_too_large',
  }
): Promise<ParsedJsonRequest<T>> {
  const raw = await c.req.text().catch(() => '');

  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return {
      response: asApiError(`${label} exceeds ${maxBytes} bytes.`, codes.oversized, 413),
      success: false,
    };
  }

  let body: unknown = {};

  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return { response: asInvalidRequestError(parsed.error, codes.invalid), success: false };
  }

  return { data: parsed.data, success: true };
}

/**
 * Parses one bounded worker-control request envelope.
 *
 * @param c Hono request context.
 * @returns Parsed envelope data, or an error response.
 */
async function parseWorkerControlEnvelope(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlRequestEnvelopeSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlRequestEnvelopeSchema,
    WORKER_CONTROL_ENVELOPE_MAX_BYTES,
    'Worker control envelope'
  );
}

/**
 * Parses one bounded worker-control event append request.
 *
 * @param c Hono request context.
 * @returns Parsed event append request data, or an error response.
 */
async function parseWorkerControlEventAppendRequest(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlEventAppendRequestSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlEventAppendRequestSchema,
    WORKER_CONTROL_EVENT_APPEND_MAX_BYTES,
    'Worker control event append payload'
  );
}

/**
 * Parses one bounded worker-control terminal result request.
 *
 * @param c Hono request context.
 * @returns Parsed terminal result request data, or an error response.
 */
async function parseWorkerControlTerminalResultRequest(
  c: Context
): Promise<ParsedJsonRequest<z.infer<typeof WorkerControlTerminalResultRequestSchema>>> {
  return parseBoundedJsonRequest(
    c,
    WorkerControlTerminalResultRequestSchema,
    WORKER_CONTROL_TERMINAL_RESULT_MAX_BYTES,
    'Worker control terminal result payload'
  );
}

/**
 * Parses one bounded worker capability request.
 *
 * @param c Hono request context.
 * @param schema Schema used to validate the capability request.
 * @returns Parsed request data, or an error response.
 */
async function parseWorkerCapabilityRequest<T>(
  c: Context,
  schema: z.ZodType<T>
): Promise<ParsedJsonRequest<T>> {
  return parseBoundedJsonRequest(
    c,
    schema,
    WORKER_CAPABILITY_REQUEST_MAX_BYTES,
    'Worker capability payload',
    { invalid: 'capability_input_invalid', oversized: 'capability_input_invalid' }
  );
}

/**
 * Builds a product-safe worker capability call summary.
 *
 * @param input Summary fields.
 * @returns Validated worker capability call summary.
 */
function buildWorkerCapabilityCallSummary(input: {
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Capability family name. */
  family: z.infer<typeof WorkerCapabilityCallSummarySchema>['family'];
  /** Product-safe input summary. */
  inputSummary: string;
  /** Product-safe output summary. */
  outputSummary: string;
}): z.infer<typeof WorkerCapabilityCallSummarySchema> {
  const timestamp = new Date().toISOString();

  return WorkerCapabilityCallSummarySchema.parse({
    capabilityCallId: `cap_${input.lineage.packageSnapshotId}_${input.family.replace('.', '_')}_${Date.now().toString(36)}`,
    completedAt: timestamp,
    diagnostics: [],
    family: input.family,
    inputSummary: input.inputSummary,
    lineage: input.lineage,
    outputSummary: input.outputSummary,
    schemaVersion: 1,
    sequence: 0,
    startedAt: timestamp,
    status: 'succeeded',
  });
}

/**
 * Records one successful worker capability call when durable storage is available.
 *
 * @param input Worker lineage, summaries, and request context.
 * @returns Product-safe worker capability call summary.
 */
function recordWorkerCapabilityCallSummary(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Capability family name. */
  family:
    | 'knowledge.search'
    | 'knowledge.read'
    | 'knowledge.proposal'
    | 'worker_mcp.call'
    | 'artifact.read'
    | 'diagnostic.read';
  /** Durable usage-ledger capability family. */
  ledgerFamily?: 'knowledge' | 'mcp' | 'workspace' | undefined;
  /** Durable gateway operation. Defaults to the worker-facing family. */
  operation?: string | undefined;
  /** Redacted service reference. */
  serviceRef?: string | undefined;
  /** Optional usage rows recorded before the capability call is completed. */
  usageRecords?:
    | Array<{
        /** Usage category. */
        category: 'tool';
        /** Usage unit. */
        unit: 'capability_calls' | 'tool_calls';
        /** Measured quantity. */
        quantity: number;
        /** Measurement source. */
        source?: string | null;
      }>
    | undefined;
  /** Product-safe input summary. */
  inputSummary: string;
  /** Product-safe output summary. */
  outputSummary: string;
}): z.infer<typeof WorkerCapabilityCallSummarySchema> {
  const fallback = () =>
    buildWorkerCapabilityCallSummary({
      family: input.family,
      inputSummary: input.inputSummary,
      lineage: input.lineage,
      outputSummary: input.outputSummary,
    });

  if (!input.coreDb) {
    return fallback();
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);

    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: input.family,
      family: input.ledgerFamily ?? 'knowledge',
      operation: input.operation ?? input.family,
      redactionClass: 'metadata-only',
      requestId: input.lineage.requestId ?? null,
      serviceRef: input.serviceRef ?? 'knowledge-store',
      summary: input.inputSummary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });
    if (input.usageRecords?.length) {
      recordUsage({
        call,
        records: input.usageRecords,
        workspaceDb,
      });
    }
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
    const completedAt = new Date().toISOString();

    return WorkerCapabilityCallSummarySchema.parse({
      capabilityCallId: call.id,
      completedAt,
      diagnostics: [],
      family: input.family,
      inputSummary: input.inputSummary,
      lineage: input.lineage,
      outputSummary: input.outputSummary,
      schemaVersion: 1,
      sequence: 0,
      startedAt: completedAt,
      status: 'succeeded',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Builds worker-visible MCP server summaries from the authenticated package supply.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @returns Product-safe MCP server summaries.
 */
function listWorkerVisibleMcpServers(
  environmentPackage: AgentEnvironmentPackage,
  gateway: WorkerMcpGateway
) {
  return environmentPackage.supply.mcpServers.map((server) =>
    WorkerCapabilityMcpServerSummarySchema.parse({
      health: gateway.getServerHealth?.(server) ?? 'ready',
      id: server.id,
      toolNames: server.allowedTools,
      transport: server.transport,
    })
  );
}

/**
 * Builds deterministic tool schema snapshots for one worker-visible MCP server.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @returns Schema snapshot id and product-safe tool schemas.
 */
function listWorkerVisibleMcpTools(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string
): {
  schemaSnapshotId: string;
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
} {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${serverId}`,
      404
    );
  }

  const digest = server.integrity?.sha256 ?? server.version ?? 'unknown';
  const schemaByName = new Map(server.toolSchemas.map((tool) => [tool.name, tool.inputSchema]));

  return {
    schemaSnapshotId: `mcpsnap_${server.id}_${digest}`,
    tools: server.allowedTools.map((name) =>
      WorkerCapabilityMcpToolSchema.parse({
        inputSchema: schemaByName.get(name) ?? {
          additionalProperties: true,
          type: 'object',
        },
        name,
      })
    ),
  };
}

/**
 * Records the product-safe MCP tool schema snapshot visible to one worker session.
 *
 * @param input Snapshot persistence context.
 */
function recordMcpToolSchemaSnapshot(input: {
  contentDigest?: string | undefined;
  environmentPackage: AgentEnvironmentPackage;
  schemaSnapshotId: string;
  serverVersion?: string | null | undefined;
  serverId: string;
  source?: 'aep' | 'live' | undefined;
  tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  workspaceDb: WorkspaceDb;
  workspaceId: string;
}): void {
  const server = input.environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === input.serverId
  );

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${input.serverId}`,
      404
    );
  }

  const toolsJson = JSON.stringify(input.tools);
  const contentDigest =
    input.contentDigest ?? server.integrity?.sha256 ?? mcpToolSchemaContentDigest(input.tools);

  input.workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
        snapshot_id,
        workspace_id,
        catalog_entry_id,
        source_ref,
        server_version,
        content_digest,
        tools_json,
        source,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.schemaSnapshotId,
      input.workspaceId,
      server.id,
      server.sourceRef,
      input.serverVersion ?? server.version,
      contentDigest,
      toolsJson,
      input.source ?? 'aep',
      new Date().toISOString()
    );
}

interface ExportableMcpToolSchemaSnapshot {
  /** Snapshot capture timestamp. */
  readonly capturedAt: string;
  /** MCP catalog entry id. */
  readonly catalogEntryId: string;
  /** Digest of the tool schema content. */
  readonly contentDigest: string;
  /** Durable schema snapshot id. */
  readonly schemaSnapshotId: string;
  /** Optional server-reported version. */
  readonly serverVersion: string | null;
  /** Snapshot source. */
  readonly source: 'aep' | 'live';
  /** Optional product-safe catalog source reference. */
  readonly sourceRef: string | null;
  /** Product-safe tool schemas captured for validation. */
  readonly tools: z.infer<typeof WorkerCapabilityMcpToolSchema>[];
  /** Workspace that owns the snapshot. */
  readonly workspaceId: string;
}

/**
 * Lists all product-safe MCP tool schema snapshots for workspace export.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Schema snapshot records in stable order.
 */
function listExportableMcpToolSchemaSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): ExportableMcpToolSchemaSnapshot[] {
  const rows = workspaceDb.sqlite
    .prepare(
      `SELECT
        snapshot_id,
        workspace_id,
        catalog_entry_id,
        source_ref,
        server_version,
        content_digest,
        tools_json,
        source,
        captured_at
      FROM mcp_tool_schema_snapshots
      WHERE workspace_id = ?
      ORDER BY captured_at ASC, snapshot_id ASC`
    )
    .all(workspaceId) as Array<{
    captured_at: string;
    catalog_entry_id: string;
    content_digest: string;
    snapshot_id: string;
    server_version: string | null;
    source: 'aep' | 'live';
    source_ref: string | null;
    tools_json: string;
    workspace_id: string;
  }>;

  return rows.map((row) => ({
    capturedAt: row.captured_at,
    catalogEntryId: row.catalog_entry_id,
    contentDigest: row.content_digest,
    schemaSnapshotId: row.snapshot_id,
    serverVersion: row.server_version,
    source: row.source,
    sourceRef: row.source_ref,
    tools: z.array(WorkerCapabilityMcpToolSchema).parse(JSON.parse(row.tools_json)),
    workspaceId: row.workspace_id,
  }));
}

/**
 * Replays imported MCP schema snapshots without emitting gateway audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param snapshots MCP schema snapshots to replay.
 */
function importMcpToolSchemaSnapshots(
  workspaceDb: WorkspaceDb,
  snapshots: readonly ExportableMcpToolSchemaSnapshot[]
): void {
  for (const snapshot of snapshots) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO mcp_tool_schema_snapshots (
          snapshot_id,
          workspace_id,
          catalog_entry_id,
          source_ref,
          server_version,
          content_digest,
          tools_json,
          source,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.schemaSnapshotId,
        snapshot.workspaceId,
        snapshot.catalogEntryId,
        snapshot.sourceRef,
        snapshot.serverVersion,
        snapshot.contentDigest,
        JSON.stringify(snapshot.tools),
        snapshot.source,
        snapshot.capturedAt
      );
  }
}

function mcpToolSchemaContentDigest(
  tools: Array<{ inputSchema: Record<string, unknown>; name: string }>
): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

/**
 * Closes gateway resources and denies a call when a known MCP vault grant is no longer active.
 *
 * @param input Grant validation context.
 */
async function requireActiveWorkerMcpVaultGrants(input: {
  coreDb: CoreDb;
  gateway: WorkerMcpGateway;
  server: AgentEnvironmentPackage['supply']['mcpServers'][number];
}): Promise<void> {
  for (const grantId of input.server.vaultGrantIds) {
    const grant = getVaultGrant(input.coreDb, grantId);

    if (!grant) {
      continue;
    }

    const expired = grant.expiresAt ? Date.parse(grant.expiresAt) <= Date.now() : false;

    if (grant.status !== 'active' || expired) {
      await input.gateway.closeServer?.(input.server);
      throw new WorkerControlGatewayError(
        'mcp-denied',
        'MCP tool call denied by revoked vault grant.',
        403
      );
    }
  }
}

/**
 * Resolves gateway-private credentials for one MCP call from active vault grants.
 *
 * @param input Credential resolution context.
 * @returns Gateway-private credential material, or undefined when no vault-backed credential applies.
 */
function resolveWorkerMcpGatewayCredentials(input: {
  capabilityCallId: string;
  coreDb: CoreDb;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  server: AgentEnvironmentPackage['supply']['mcpServers'][number];
  vaultUnlockState: VaultUnlockState | null;
}): WorkerMcpGatewayCredentials | undefined {
  if (
    !input.vaultUnlockState ||
    !input.server.providerInstanceIds.includes('provider_github_read')
  ) {
    return undefined;
  }

  const grantId = input.server.vaultGrantIds.find(
    (candidate) => getVaultGrant(input.coreDb, candidate)?.vaultReferenceId === 'vault_github_read'
  );

  if (!grantId) {
    return undefined;
  }

  const grant = getVaultGrant(input.coreDb, grantId);
  const reference = getVaultReference(input.coreDb, 'vault_github_read');

  if (!grant || !reference) {
    return undefined;
  }
  if (!grant.allowedInjectionPaths.includes('gateway-only')) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call denied by vault grant injection policy.',
      403
    );
  }
  if (grant.targetAgentSessionId && grant.targetAgentSessionId !== input.lineage.agentSessionId) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call denied by vault grant target.',
      403
    );
  }

  const planId = `plan_${input.lineage.packageSnapshotId}_${grant.grantId}_mcp_gateway`;
  const receiptId = `receipt_${input.capabilityCallId}_${grant.grantId}`;
  const now = new Date().toISOString();

  createInjectionPlan(input.coreDb, {
    backendCapabilityRequirement: 'mcp-gateway:github-token',
    capabilityId: 'worker_mcp.call',
    expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
    grantId: grant.grantId,
    injectionVisibility: 'gateway-only',
    packageSnapshotId: input.lineage.packageSnapshotId,
    planId,
    redactionRule: 'no-secret-material',
    revocationBehavior: 'close-gateway-session',
    now: () => now,
  });
  createInjectionReceipt(input.coreDb, {
    agentSessionId: input.lineage.agentSessionId,
    backendSummary: 'mcp-gateway:github-token',
    capabilityCallId: input.capabilityCallId,
    expiresAt: grant.expiresAt,
    grantId: grant.grantId,
    injectedAt: now,
    planId,
    receiptId,
    revocationStatus: 'active',
  });

  const material = createVaultUseAuditedBackend({
    agentSessionId: input.lineage.agentSessionId,
    backend: input.vaultUnlockState.backend(),
    capabilityCallId: input.capabilityCallId,
    db: input.coreDb,
    grantId: grant.grantId,
    ownerScope: 'server',
    planId,
    receiptId,
    resolvingPath: 'grant',
    now: () => now,
  }).resolve({ referenceId: reference.referenceId });
  const token = vaultMaterialToString(material);

  return {
    environment: { GH_TOKEN: token, GITHUB_TOKEN: token },
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Converts vault material to a UTF-8 credential string.
 *
 * @param material Vault material.
 * @returns Credential string.
 */
function vaultMaterialToString(material: VaultSecretMaterial): string {
  return typeof material === 'string' ? material : Buffer.from(material).toString('utf8');
}

/**
 * Executes one currently enabled MCP tool through the NanoCore gateway.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @param toolName Requested MCP tool name.
 * @returns Schema snapshot id and product-safe tool result.
 */
function callWorkerVisibleMcpTool(
  environmentPackage: AgentEnvironmentPackage,
  gateway: WorkerMcpGateway,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  credentials?: WorkerMcpGatewayCredentials | undefined,
  liveSchemaSnapshotSink?: ((snapshot: WorkerMcpLiveSchemaSnapshot) => void) | undefined
): Promise<{
  result: z.infer<typeof WorkerCapabilityMcpToolResultSchema>;
  schemaSnapshotId: string;
}> {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );
  const snapshot = listWorkerVisibleMcpTools(environmentPackage, serverId);
  const tool = snapshot.tools.find((candidate) => candidate.name === toolName);

  if (!server) {
    throw new WorkerControlGatewayError(
      'mcp-server-unavailable',
      `MCP server is not enabled for this worker session: ${serverId}`,
      404
    );
  }

  if (!tool) {
    throw new WorkerControlGatewayError(
      'mcp-tool-not-found',
      `MCP tool is not enabled for this worker session: ${serverId}/${toolName}`,
      404
    );
  }

  validateWorkerMcpToolArguments(tool.inputSchema, args, serverId, toolName);

  return gateway
    .callTool({ arguments: args, credentials, liveSchemaSnapshotSink, server, toolName })
    .then((result) => ({
      result: WorkerCapabilityMcpToolResultSchema.parse(result),
      schemaSnapshotId: snapshot.schemaSnapshotId,
    }));
}

/**
 * Checks whether one enabled MCP tool requires human approval.
 *
 * @param environmentPackage Registered Agent Environment Package.
 * @param serverId Requested MCP server id.
 * @param toolName Requested MCP tool name.
 * @returns True when the AEP marks the tool as approval-required.
 */
function workerMcpToolRequiresApproval(
  environmentPackage: AgentEnvironmentPackage,
  serverId: string,
  toolName: string
): boolean {
  const server = environmentPackage.supply.mcpServers.find(
    (candidate) => candidate.id === serverId
  );

  return server?.approvalRequiredTools.includes(toolName) ?? false;
}

/**
 * Throws the stable worker-visible error for a tool outside the worker MCP allowlist.
 *
 * @param serverId MCP server id.
 * @param toolName MCP tool name.
 */
function mcpToolNotFound(serverId: string, toolName: string): never {
  throw new WorkerControlGatewayError(
    'mcp-tool-not-found',
    `MCP tool is not enabled for this worker session: ${serverId}/${toolName}`,
    404
  );
}

/** Stored require-approval policy decision row. */
interface PolicyApprovalDecisionRow {
  /** Product action that required approval. */
  action: string;
  /** Stored permission decision id. */
  decisionId: string;
  /** Redacted context summary. */
  contextSummary: unknown;
  /** Redacted resource summary. */
  resourceSummary: unknown;
  /** Redacted subject summary. */
  subjectSummary: unknown;
}

/**
 * Reads the policy decision that opened one approval gate.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id that owns the approval.
 * @param approvalId Approval request id.
 * @param action Optional action filter.
 * @returns Stored require-approval decision row, or null.
 */
function readPolicyApprovalDecision(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  approvalId: string,
  action?: string
): PolicyApprovalDecisionRow | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        action,
        decision_id,
        subject_summary_json,
        resource_summary_json,
        context_summary_json
      FROM permission_decisions
      WHERE owner_scope = 'workspace'
        AND workspace_id = ?
        AND result = 'require_approval'
        AND approval_id = ?
        AND (? IS NULL OR action = ?)
      ORDER BY created_at DESC
      LIMIT 1`
    )
    .get(workspaceId, approvalId, action ?? null, action ?? null) as
    | {
        action: string;
        context_summary_json: string;
        decision_id: string;
        resource_summary_json: string;
        subject_summary_json: string;
      }
    | undefined;

  return row
    ? {
        action: row.action,
        contextSummary: JSON.parse(row.context_summary_json),
        decisionId: row.decision_id,
        resourceSummary: JSON.parse(row.resource_summary_json),
        subjectSummary: JSON.parse(row.subject_summary_json),
      }
    : null;
}

/**
 * Creates or reuses the approval gate for one approval-required MCP tool call.
 *
 * @param input MCP approval context.
 * @returns Product-safe pending approval response.
 */
function createMcpToolApprovalGate(input: {
  coreDb?: CoreDb;
  environmentPackage: AgentEnvironmentPackage;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
}): z.infer<typeof WorkerCapabilityMcpCallToolApprovalResponseSchema> {
  if (!input.coreDb) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool approval requires durable workspace storage.',
      403
    );
  }

  const tool = listWorkerVisibleMcpTools(input.environmentPackage, input.serverId).tools.find(
    (candidate) => candidate.name === input.toolName
  );

  if (!tool) {
    mcpToolNotFound(input.serverId, input.toolName);
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        agentSessionId: input.lineage.agentSessionId,
        serverId: input.serverId,
        threadId: input.lineage.threadId,
        toolName: input.toolName,
        turnId: input.lineage.turnId,
        workspaceId: input.lineage.workspaceId,
      })
    )
    .digest('hex')
    .slice(0, 20);
  const approvalId = `ap_mcp_${digest}`;
  const approvalItemId = `it_mcp_approval_${digest}`;
  const decisionId = `pd_mcp_require_${digest}`;

  try {
    applyScopedMigrations(workspaceDb);

    const existingDecision = readPolicyApprovalDecision(
      workspaceDb,
      input.lineage.workspaceId,
      approvalId,
      'mcp.call'
    );

    if (existingDecision) {
      return WorkerCapabilityMcpCallToolApprovalResponseSchema.parse({
        approval: input.store.getApproval(approvalId),
        approvalItemId,
        policyDecisionId: existingDecision.decisionId,
      });
    }

    const gate = createPolicyApprovalGate({
      action: 'mcp.call',
      approvalId,
      approvalItemId,
      contextSummary: {
        agentSessionId: input.lineage.agentSessionId,
        packageSnapshotId: input.lineage.packageSnapshotId,
        requestId: input.lineage.requestId,
        threadId: input.lineage.threadId,
        turnId: input.lineage.turnId,
        workspaceId: input.lineage.workspaceId,
      },
      decisionId,
      description: `Allow this worker turn to call ${input.serverId}/${input.toolName}. Tool arguments and credentials are not included in the approval record.`,
      reasonCode: 'mcp_call_requires_human_approval',
      resourceSummary: {
        kind: 'mcp-tool-call',
        packageSnapshotId: input.lineage.packageSnapshotId,
        serverId: input.serverId,
        toolName: input.toolName,
        workspaceId: input.lineage.workspaceId,
      },
      store: input.store,
      subjectSummary: {
        agentSessionId: input.lineage.agentSessionId,
        kind: 'worker-agent-session',
      },
      title: `Approve MCP tool ${input.serverId}/${input.toolName}`,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    return WorkerCapabilityMcpCallToolApprovalResponseSchema.parse({
      approval: input.store.getApproval(gate.approvalId),
      approvalItemId: gate.approvalItemId,
      policyDecisionId: gate.decisionId,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Executes one MCP tool call and records durable success or failure diagnostics when storage exists.
 *
 * @param input Worker MCP call and ledger context.
 * @returns Product-safe call result and capability summary.
 */
async function callWorkerVisibleMcpToolWithLedger(input: {
  coreDb?: CoreDb;
  environmentPackage: AgentEnvironmentPackage;
  gateway: WorkerMcpGateway;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
  args: Record<string, unknown>;
  vaultUnlockState?: VaultUnlockState | null;
}): Promise<{
  callResult: Awaited<ReturnType<typeof callWorkerVisibleMcpTool>>;
  capabilityCall: z.infer<typeof WorkerCapabilityCallSummarySchema>;
}> {
  const toolSnapshot = listWorkerVisibleMcpTools(input.environmentPackage, input.serverId);
  const inputSummary = `MCP tool call requested for ${input.serverId}/${input.toolName} using ${toolSnapshot.schemaSnapshotId}.`;

  if (!input.coreDb) {
    const callResult = await callWorkerVisibleMcpTool(
      input.environmentPackage,
      input.gateway,
      input.serverId,
      input.toolName,
      input.args
    );

    return {
      callResult,
      capabilityCall: buildWorkerCapabilityCallSummary({
        family: 'worker_mcp.call',
        inputSummary,
        lineage: input.lineage,
        outputSummary: `MCP tool ${input.toolName} completed.`,
      }),
    };
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    recordMcpToolSchemaSnapshot({
      environmentPackage: input.environmentPackage,
      schemaSnapshotId: toolSnapshot.schemaSnapshotId,
      serverId: input.serverId,
      tools: toolSnapshot.tools,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: 'worker_mcp.call',
      family: 'mcp',
      operation: 'mcp.call_tool',
      redactionClass: 'metadata-only',
      requestId: input.lineage.requestId ?? null,
      serviceRef: 'mcp-gateway',
      summary: inputSummary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    try {
      const server = input.environmentPackage.supply.mcpServers.find(
        (candidate) => candidate.id === input.serverId
      );
      let credentials: WorkerMcpGatewayCredentials | undefined;

      if (server) {
        await requireActiveWorkerMcpVaultGrants({
          coreDb: input.coreDb,
          gateway: input.gateway,
          server,
        });
        credentials = resolveWorkerMcpGatewayCredentials({
          capabilityCallId: call.id,
          coreDb: input.coreDb,
          lineage: input.lineage,
          server,
          vaultUnlockState: input.vaultUnlockState ?? null,
        });
      }

      const recordLiveSchemaSnapshot = (snapshot: WorkerMcpLiveSchemaSnapshot): void => {
        const contentDigest = mcpToolSchemaContentDigest(snapshot.tools);
        recordMcpToolSchemaSnapshot({
          contentDigest,
          environmentPackage: input.environmentPackage,
          schemaSnapshotId: `mcpsnap_${input.serverId}_${contentDigest.slice(0, 32)}`,
          serverId: input.serverId,
          serverVersion:
            typeof snapshot.serverInfo?.version === 'string' ? snapshot.serverInfo.version : null,
          source: 'live',
          tools: snapshot.tools,
          workspaceDb,
          workspaceId: input.lineage.workspaceId,
        });
      };
      const callResult = await callWorkerVisibleMcpTool(
        input.environmentPackage,
        input.gateway,
        input.serverId,
        input.toolName,
        input.args,
        credentials,
        recordLiveSchemaSnapshot
      );

      recordUsage({
        call,
        records: [
          {
            category: 'tool',
            quantity: 1,
            source: 'gateway-observed',
            unit: 'tool_calls',
          },
        ],
        workspaceDb,
      });
      finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });

      const completedAt = new Date().toISOString();

      return {
        callResult,
        capabilityCall: WorkerCapabilityCallSummarySchema.parse({
          capabilityCallId: call.id,
          completedAt,
          diagnostics: [],
          family: 'worker_mcp.call',
          inputSummary,
          lineage: input.lineage,
          outputSummary: `MCP tool ${input.toolName} completed.`,
          schemaVersion: 1,
          sequence: 0,
          startedAt: completedAt,
          status: 'succeeded',
        }),
      };
    } catch (error) {
      finishCapabilityCall({
        workspaceDb,
        callId: call.id,
        errorCode: workerMcpFailureErrorCode(error),
        status: 'failed',
      });
      throw error;
    }
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Maps one Worker MCP failure to the stable ledger error code.
 *
 * @param error Failure thrown during MCP validation or dispatch.
 * @returns Product-safe error code for capability diagnostics.
 */
function workerMcpFailureErrorCode(error: unknown): string {
  return error instanceof WorkerControlGatewayError ? error.code : 'mcp-call-failed';
}

/**
 * Records a denied worker MCP capability call after authenticated policy evaluation.
 *
 * @param input Denied MCP call context.
 */
function recordDeniedWorkerMcpCapabilityCall(input: {
  coreDb?: CoreDb;
  error: WorkerControlGatewayError;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  serverId: string;
  store: FsStore;
  toolName: string;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: 'worker_mcp.call',
      callId: `cap_denied_mcp_${randomUUID()}`,
      family: 'mcp',
      operation: 'mcp.call_tool',
      redactionClass: 'metadata-only',
      requestId: null,
      serviceRef: 'mcp-gateway',
      summary: `MCP tool call denied for ${input.serverId}/${input.toolName}.`,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    finishCapabilityCall({
      callId: call.id,
      errorCode: input.error.code,
      status: 'failed',
      workspaceDb,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Records one authenticated failed worker capability attempt when durable storage is available.
 *
 * @param input Failed capability context.
 */
function recordFailedWorkerCapabilityCall(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Stable error code returned to the worker. */
  errorCode: string;
  /** Worker-facing capability family. */
  family: 'knowledge.read' | 'artifact.read';
  /** Durable usage-ledger capability family. */
  ledgerFamily: 'knowledge' | 'workspace';
  /** Worker lineage bound to the capability call. */
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  /** Durable gateway operation. */
  operation: string;
  /** Redacted service reference. */
  serviceRef: string;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Product-safe failure summary. */
  summary: string;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      agentSessionId: input.lineage.agentSessionId,
      capabilityId: input.family,
      callId: `cap_failed_${input.family.replace('.', '_')}_${randomUUID()}`,
      family: input.ledgerFamily,
      operation: input.operation,
      redactionClass: 'metadata-only',
      requestId: null,
      serviceRef: input.serviceRef,
      summary: input.summary,
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceDb,
      workspaceId: input.lineage.workspaceId,
    });

    finishCapabilityCall({
      callId: call.id,
      errorCode: input.errorCode,
      status: 'failed',
      workspaceDb,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Verifies that an immutable permission decision allows one MCP tool call.
 *
 * @param input Policy decision lookup input.
 * @throws WorkerControlGatewayError when the decision is absent or not allowed.
 */
function requireAllowedMcpToolCallPolicyDecision(input: {
  approvalRequestId?: string;
  approvalRequired?: boolean;
  coreDb?: CoreDb;
  lineage: z.infer<typeof WorkerControlLineageRequestSchema>;
  policyDecisionId?: string;
  serverId: string;
  store: FsStore;
  toolName: string;
}): void {
  if (!input.coreDb) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call requires an allowed policy decision.',
      403
    );
  }

  if (!input.policyDecisionId && !input.approvalRequestId) {
    throw new WorkerControlGatewayError(
      'mcp-denied',
      'MCP tool call requires an allowed policy decision.',
      403
    );
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const row = workspaceDb.sqlite
      .prepare(
        `SELECT action, approval_id, owner_scope, workspace_id, result, resource_summary_json
         FROM permission_decisions
         WHERE action = 'mcp.call'
           AND result = 'allow'
           AND (
             (? IS NOT NULL AND decision_id = ?)
             OR (? IS NOT NULL AND approval_id = ?)
           )
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(
        input.policyDecisionId ?? null,
        input.policyDecisionId ?? null,
        input.approvalRequestId ?? null,
        input.approvalRequestId ?? null
      ) as
      | {
          action: string;
          approval_id: string | null;
          owner_scope: string;
          resource_summary_json: string;
          result: string;
          workspace_id: string | null;
        }
      | undefined;

    if (
      !row ||
      row.action !== 'mcp.call' ||
      row.owner_scope !== 'workspace' ||
      row.workspace_id !== input.lineage.workspaceId ||
      row.result !== 'allow'
    ) {
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
    }

    if (input.approvalRequired) {
      if (!row.approval_id) {
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
      }

      const approval = input.store.getApproval(row.approval_id);

      if (approval.status !== 'granted') {
        throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
      }
    }

    const resource = JSON.parse(row.resource_summary_json) as Record<string, unknown>;

    if (
      resource.kind !== 'mcp-tool-call' ||
      resource.serverId !== input.serverId ||
      resource.toolName !== input.toolName ||
      resource.workspaceId !== input.lineage.workspaceId
    ) {
      throw new WorkerControlGatewayError('mcp-denied', 'MCP tool call denied by policy.', 403);
    }
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Validates MCP tool arguments against the package snapshot JSON Schema.
 *
 * @param schema Tool input schema from the resolved package snapshot.
 * @param args JSON object arguments supplied by the worker.
 * @param serverId MCP server id used for typed diagnostics.
 * @param toolName MCP tool name used for typed diagnostics.
 */
function validateWorkerMcpToolArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  serverId: string,
  toolName: string
): void {
  let validate: ReturnType<typeof workerMcpToolArgumentValidator.compile>;

  try {
    validate = workerMcpToolArgumentValidator.compile(schema);
  } catch {
    throw new WorkerControlGatewayError(
      'mcp-invalid-arguments',
      `MCP tool arguments do not match schema: ${serverId}/${toolName}`,
      400
    );
  }

  if (!validate(args)) {
    throw new WorkerControlGatewayError(
      'mcp-invalid-arguments',
      `MCP tool arguments do not match schema: ${serverId}/${toolName}`,
      400
    );
  }
}

/**
 * Returns a capability-ledger-safe request id.
 *
 * @param requestId Caller-supplied request id.
 * @returns UUID request id accepted by protocol capability schemas, or null.
 */
function normalizeCapabilityRequestId(requestId: string | null | undefined): string | null {
  const parsed = RequestIdSchema.safeParse(requestId);

  return parsed.success ? parsed.data : null;
}

/**
 * Records durable usage for one successful QuickChat LLM call when storage is available.
 *
 * @param input QuickChat usage attribution and provider usage payload.
 */
function recordQuickChatLlmUsage(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Workspace that owns the QuickChat request. */
  workspaceId: string;
  /** Thread lineage when the call belongs to a thread-scoped mode. */
  threadId?: string | null;
  /** Turn lineage when the call belongs to a durable turn. */
  turnId?: string | null;
  /** Item lineage when the call belongs to a durable item. */
  itemId?: string | null;
  /** Request id used by the originating caller. */
  requestId?: string | null;
  /** Provider id selected for the call. */
  providerId: string;
  /** Model selected for the call. */
  model: string;
  /** Provider-native usage payload. */
  usage?: unknown;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      agentId: QUICK_CHAT_AGENT_ID,
      agentSessionId: null,
      capabilityId: 'inference.local.quick_chat',
      family: 'llm',
      operation: 'quick_chat',
      providerRef: input.providerId,
      redactionClass: 'metadata-only',
      requestId: normalizeCapabilityRequestId(input.requestId) ?? randomUUID(),
      serviceRef: 'llm-gateway',
      summary: 'QuickChatAgent LLM call.',
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      itemId: input.itemId ?? null,
      workspaceDb,
      workspaceId: input.workspaceId,
    });
    const parsed = parseUsage(input.usage);
    const tokenQuantity = parsed.totalTokens || parsed.inputTokens + parsed.completionTokens;

    recordUsage({
      call,
      records: [
        {
          category: 'llm',
          modelId: input.model,
          providerRef: input.providerId,
          quantity: tokenQuantity > 0 ? tokenQuantity : 1,
          source: tokenQuantity > 0 ? 'gateway-reported' : 'gateway-observed',
          unit: tokenQuantity > 0 ? 'tokens' : 'requests',
        },
      ],
      workspaceDb,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Records durable usage for one successful Knowledge Store gateway operation.
 *
 * @param input Knowledge operation attribution and usage source.
 */
function recordKnowledgeGatewayUsage(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Workspace that owns the knowledge request. */
  workspaceId: string;
  /** Product capability id. */
  capabilityId: string;
  /** Durable gateway operation. */
  operation: string;
  /** Usage measurement source. */
  usageSource: string;
  /** Redacted service reference. */
  serviceRef: string;
  /** Product-safe summary. */
  summary: string;
  /** Request id used by the originating caller. */
  requestId?: string | null;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      capabilityId: input.capabilityId,
      family: 'knowledge',
      operation: input.operation,
      providerRef: 'nanocore-knowledge',
      redactionClass: 'metadata-only',
      requestId: normalizeCapabilityRequestId(input.requestId) ?? randomUUID(),
      serviceRef: input.serviceRef,
      summary: input.summary,
      workspaceDb,
      workspaceId: input.workspaceId,
    });

    recordUsage({
      call,
      records: [
        {
          category: 'tool',
          providerRef: 'nanocore-knowledge',
          quantity: 1,
          source: input.usageSource,
          unit: 'capability_calls',
        },
      ],
      workspaceDb,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Public LLM gateway lineage accepted from `metadata.openkit`. */
interface PublicLlmGatewayLineage {
  /** Workspace that owns the gateway request. */
  workspaceId: string;
  /** Thread lineage when available. */
  threadId?: string;
  /** Turn lineage when available. */
  turnId?: string;
  /** Item lineage when available. */
  itemId?: string;
  /** Agent lineage when available. */
  agentId?: string;
  /** Agent session lineage when available. */
  agentSessionId?: string;
  /** Client-supplied request id used for durable idempotency. */
  requestId?: string;
  /** Workspace source ids attributed to the call. */
  sourceIds?: string[];
}

/** Started public gateway call with its workspace database handle. */
interface PublicLlmGatewayCall {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Started capability call row. */
  call: ReturnType<typeof startCapabilityCall>;
}

/**
 * Starts one durable public LLM gateway call when the call is attributable.
 *
 * @param input Provider, request, and storage context.
 * @returns Started call or null when durable attribution is unavailable.
 */
function startPublicLlmGatewayCall(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
  /** Provider selected for the public gateway call. */
  provider: ResolvedLLMProviderConfig;
  /** Gateway endpoint family. */
  endpoint: 'chat_completions' | 'responses';
  /** OpenAI-compatible request metadata. */
  metadata: unknown;
}): PublicLlmGatewayCall | null {
  if (!input.coreDb) {
    return null;
  }

  const lineage = readPublicLlmGatewayLineage(input.metadata);

  if (!lineage) {
    return null;
  }

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    lineage.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);

    return {
      call: startCapabilityCall({
        agentId: lineage.agentId ?? null,
        agentSessionId: lineage.agentSessionId ?? null,
        capabilityId: `llm.${input.endpoint}`,
        family: 'llm',
        itemId: lineage.itemId ?? null,
        operation: input.endpoint,
        providerRef: input.provider.id,
        redactionClass: 'metadata-only',
        requestId: lineage.requestId ?? randomUUID(),
        serviceRef: 'llm-gateway',
        sourceIds: lineage.sourceIds ?? [],
        summary: `Public ${input.endpoint} LLM gateway call.`,
        threadId: lineage.threadId ?? null,
        turnId: lineage.turnId ?? null,
        workspaceDb,
        workspaceId: lineage.workspaceId,
      }),
      workspaceDb,
    };
  } catch (error) {
    workspaceDb.sqlite.close();
    throw error;
  }
}

/**
 * Records durable usage for one public LLM gateway response.
 *
 * @param input Started call and response usage.
 */
function recordPublicLlmGatewayUsage(input: {
  /** Started durable call. */
  durableCall: PublicLlmGatewayCall | null;
  /** Provider selected for the call. */
  provider: ResolvedLLMProviderConfig;
  /** Model requested by the client. */
  model: string;
  /** Provider usage payload. */
  usage: unknown;
}): void {
  if (!input.durableCall) {
    return;
  }

  const parsed = parseUsage(input.usage);
  const records = [
    {
      quantity: parsed.inputTokens,
      source: 'llm-gateway-adapter-reported:input',
    },
    {
      quantity: parsed.completionTokens,
      source: 'llm-gateway-adapter-reported:output',
    },
    {
      quantity: parsed.cachedInputTokens,
      source: 'llm-gateway-adapter-reported:cache_read',
    },
    {
      quantity:
        parsed.inputTokens || parsed.completionTokens || parsed.cachedInputTokens
          ? 0
          : parsed.totalTokens,
      source: 'llm-gateway-adapter-reported:total',
    },
  ].flatMap((record) =>
    record.quantity > 0
      ? [
          {
            category: 'llm' as const,
            modelId: input.model,
            providerRef: input.provider.id,
            quantity: record.quantity,
            source: record.source,
            unit: 'tokens' as const,
          },
        ]
      : []
  );

  if (!records.length) {
    return;
  }

  recordUsage({
    call: input.durableCall.call,
    records,
    workspaceDb: input.durableCall.workspaceDb,
  });
}

/**
 * Reads adapter-reported usage carried by a failed public LLM gateway call.
 *
 * @param error Gateway dispatch error.
 * @returns Usage payload when the adapter reported one.
 */
function readPublicLlmGatewayErrorUsage(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  return (error as { usage?: unknown }).usage;
}

/**
 * Marks a public LLM gateway call terminal and closes its workspace database.
 *
 * @param durableCall Started durable call, when any.
 * @param status Terminal status.
 * @param errorCode Stable error code for failed calls.
 */
function finishPublicLlmGatewayCall(
  durableCall: PublicLlmGatewayCall | null,
  status: 'succeeded' | 'failed',
  errorCode?: string
): void {
  if (!durableCall) {
    return;
  }

  try {
    finishCapabilityCall({
      callId: durableCall.call.id,
      ...(errorCode ? { errorCode } : {}),
      status,
      workspaceDb: durableCall.workspaceDb,
    });
  } finally {
    durableCall.workspaceDb.sqlite.close();
  }
}

/**
 * Finishes a durable public LLM gateway call when a response stream is consumed.
 *
 * @param stream Provider SSE stream after usage observation.
 * @param durableCall Started durable call, when any.
 * @returns Stream that preserves original bytes.
 */
function finishPublicLlmGatewayStream(
  stream: ReadableStream<Uint8Array>,
  durableCall: PublicLlmGatewayCall | null
): ReadableStream<Uint8Array> {
  if (!durableCall) {
    return stream;
  }

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const reader = stream.getReader();

      try {
        while (true) {
          const result = await reader.read();

          if (result.done) {
            break;
          }

          controller.enqueue(result.value);
        }

        finishPublicLlmGatewayCall(durableCall, 'succeeded');
        controller.close();
      } catch (error) {
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_stream_failed');
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/**
 * Reads public LLM gateway attribution from OpenAI-compatible metadata.
 *
 * @param metadata Request metadata object.
 * @returns Durable lineage when workspace attribution is present.
 */
function readPublicLlmGatewayLineage(metadata: unknown): PublicLlmGatewayLineage | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const openkit = (metadata as Record<string, unknown>).openkit;

  if (!openkit || typeof openkit !== 'object') {
    return null;
  }

  const record = openkit as Record<string, unknown>;
  const workspaceId = readPublicGatewayString(record.workspaceId);

  if (!workspaceId) {
    return null;
  }

  const threadId = readPublicGatewayString(record.threadId);
  const turnId = readPublicGatewayString(record.turnId);
  const itemId = readPublicGatewayString(record.itemId);
  const agentId = readPublicGatewayString(record.agentId);
  const agentSessionId = readPublicGatewayString(record.agentSessionId);
  const requestId = readPublicGatewayString(record.requestId);
  const sourceIds = readPublicGatewayStringArray(record.sourceIds);

  return {
    workspaceId,
    ...(agentId ? { agentId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sourceIds ? { sourceIds } : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/**
 * Reads a non-empty metadata string.
 *
 * @param value Candidate metadata value.
 * @returns Trimmed string when present.
 */
function readPublicGatewayString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads a metadata string array.
 *
 * @param value Candidate metadata value.
 * @returns Trimmed string array when present.
 */
function readPublicGatewayStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.flatMap((item) => {
    const text = readPublicGatewayString(item);

    return text ? [text] : [];
  });

  return values.length ? [...new Set(values)].sort() : undefined;
}

/**
 * Converts runtime config file service errors into shared protocol API errors.
 */
function asRuntimeConfigFileError(error: unknown): Response {
  if (error instanceof RuntimeConfigFileServiceError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asInvalidRequestError(error);
}

/**
 * Converts upstream provider failures into status-preserving protocol errors.
 */
function asProviderApiError(error: OpenAICompatibleProviderError): Response {
  if (error.status === 429) {
    return Response.json(
      apiErrorPayload({
        code: 'provider_rate_limited',
        message: error.message,
        details: {
          providerCode: error.code,
          providerStatus: error.status,
          providerType: error.type,
        },
      }),
      { status: 429 }
    );
  }

  return Response.json(
    apiErrorPayload({
      code: 'provider_request_failed',
      message: error.message,
      details: {
        providerCode: error.code,
        providerStatus: error.status,
        providerType: error.type,
      },
    }),
    { status: error.status }
  );
}

/**
 * Converts gateway dispatch failures into OpenAI-compatible error envelopes.
 */
function asOpenAIGatewayError(error: unknown): Response {
  if (error instanceof GatewayUnsupportedFeatureError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: 'invalid_request_error',
          code: error.code,
        },
      },
      { status: error.status }
    );
  }

  if (error instanceof OpenAICompatibleProviderError) {
    const normalized = classifyGatewayProviderFailure(error, 'provider_error');

    return Response.json(
      {
        error: {
          message: redactInternalAgentText(error.message),
          type: normalized.type,
          code: normalized.code,
        },
      },
      { status: error.status }
    );
  }

  return Response.json(
    {
      error: {
        message: (error as Error).message,
        type: 'invalid_request_error',
        code: 'gateway_request_failed',
      },
    },
    { status: 400 }
  );
}

/**
 * Gateway streaming endpoint family used for terminal SSE normalization.
 */
type GatewayStreamingEndpoint = 'chat_completions' | 'responses';

/**
 * Wraps a provider SSE stream so post-start read failures become terminal SSE events.
 *
 * @param stream Upstream or bridged provider SSE stream.
 * @param endpoint Gateway endpoint family being streamed.
 * @returns Stream that preserves bytes and appends a terminal error event on read failure.
 */
function normalizeGatewayTerminalStream(
  stream: ReadableStream<Uint8Array>,
  endpoint: GatewayStreamingEndpoint
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const result = await reader.read();

          if (result.done) {
            break;
          }

          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.enqueue(encoder.encode(createGatewayTerminalErrorSse(error, endpoint)));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/**
 * Creates an OpenAI-compatible terminal SSE error payload with a stable stop reason.
 *
 * @param error Unknown stream read error.
 * @param endpoint Gateway endpoint family being streamed.
 * @returns Terminal SSE bytes as text.
 */
function createGatewayTerminalErrorSse(error: unknown, endpoint: GatewayStreamingEndpoint): string {
  const normalized = classifyGatewayProviderFailure(error, 'gateway_stream_failed');
  const payload = {
    error: {
      message: redactInternalAgentText(error instanceof Error ? error.message : String(error)),
      type: normalized.type,
      code: normalized.code,
      endpoint,
    },
    stopReason: 'error',
  };

  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

/**
 * Normalizes provider failure signal into stable public gateway error identity.
 *
 * @param error Unknown provider or stream failure.
 * @param fallbackCode Stable code used when the failure has no known provider signal.
 * @returns Public gateway error type and code.
 */
function classifyGatewayProviderFailure(error: unknown, fallbackCode: string) {
  const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status = typeof detail.status === 'number' ? detail.status : undefined;
  const type = typeof detail.type === 'string' ? detail.type : 'provider_error';
  const code = typeof detail.code === 'string' ? detail.code : '';
  const message = error instanceof Error ? error.message : String(error);
  const signal = `${code} ${type} ${message}`.toLowerCase();

  if (code.startsWith('vault-')) {
    return { type, code };
  }
  if (
    status === 401 ||
    status === 403 ||
    /\b(auth|authentication|unauthorized|forbidden)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_authentication_failed' };
  }
  if (status === 429 || /\b(rate[_ -]?limit|quota|too many requests)\b/.test(signal)) {
    return { type, code: 'gateway_provider_rate_limited' };
  }
  if (/\b(context|token|input).*\b(overflow|exceed|too long|maximum|max)\b/.test(signal)) {
    return { type, code: 'gateway_context_overflow' };
  }
  if (
    status === 400 ||
    status === 422 ||
    /\b(invalid[_ -]?request|validation|bad request|malformed)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_request_invalid' };
  }
  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /\b(unavailable|overloaded|timeout|timed out|server error)\b/.test(signal)
  ) {
    return { type, code: 'gateway_provider_unavailable' };
  }

  return { type, code: fallbackCode };
}

/**
 * Returns the current thread-bound agent session read model.
 */
function getThreadAgentSession(
  turnExecutor: TurnExecutor,
  store: FsStore,
  workspaceId: string,
  threadId: string,
  currentConfigVersion: number,
  workerControlGateway: WorkerControlGateway
): z.infer<typeof AgentSessionReadModelSchema> | null {
  const session = turnExecutor.getAgentSession?.(store, workspaceId, threadId) ?? null;

  if (!session) {
    return null;
  }

  const storedSession =
    store
      .listThreadAgentSessions(workspaceId, threadId)
      .find((candidate) => candidate.id === session.id) ??
    store.listThreadAgentSessions(workspaceId, threadId).at(-1);
  const configVersion = storedSession?.configVersion ?? session.configVersion ?? null;
  const workspaceRoots = storedSession?.workspaceRoots ?? session.workspaceRoots ?? [];

  const controlSnapshot = workerControlGateway.getSessionSnapshotByAgentSessionId(session.id);

  return AgentSessionReadModelSchema.parse({
    ...session,
    backend: session.backend
      ? {
          ...session.backend,
          control: summarizeWorkerControlSession(controlSnapshot),
        }
      : null,
    configVersion,
    workspaceRoots,
    stale: configVersion !== null && configVersion < currentConfigVersion,
  });
}

/**
 * Builds a product-safe summary from live worker control gateway state.
 *
 * @param snapshot Live control session snapshot.
 * @returns Compact control status, or null when no control session is active.
 */
function summarizeWorkerControlSession(
  snapshot: WorkerControlSessionSnapshot | null
): AgentSessionBackendControlSummary | null {
  if (!snapshot) {
    return null;
  }

  const lastTerminalResult = snapshot.terminalResults.at(-1) ?? null;

  return {
    artifactNoticeCount: snapshot.artifacts.length,
    deliveredCommandCount: snapshot.commands.filter((command) => command.deliveredAt !== null)
      .length,
    heartbeat: snapshot.heartbeat
      ? {
          lastHeartbeatAt: snapshot.heartbeat.lastHeartbeatAt,
          sequence: snapshot.heartbeat.sequence,
          status: snapshot.heartbeat.status,
        }
      : null,
    lastTerminalCompletedAt: lastTerminalResult?.completedAt ?? null,
    lastTerminalExitCode: lastTerminalResult?.exitCode ?? null,
    queuedCommandCount: snapshot.commands.length,
    terminalResultCount: snapshot.terminalResults.length,
  };
}

/**
 * Materializes workspace roots for a turn from the current effective runtime snapshot.
 *
 * @param snapshot Runtime config snapshot captured for the turn.
 * @param store Actor-scoped store that owns the workspace.
 * @param workspaceId Workspace id that owns the turn.
 * @returns Worker launch roots for the accepted turn.
 */
function materializeWorkspaceRootsForTurn(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string,
  repository: WorkspaceRepositoryResourceRecord | null = null
): ConfigMaterializedWorkspaceRoot[] {
  const dataRoot = store.getDataRoot();
  const workspaceConfig = findWorkspaceConfig(snapshot, store.getUserId(), workspaceId);
  const repositoryRoot = repository
    ? {
        access: 'read-write' as const,
        id: repository.resourceId,
        sourceKind: 'host-dir' as const,
        sourcePath: repository.localPath,
        workerPath: '/workspace/openkit',
      }
    : null;

  if (!dataRoot || !workspaceConfig) {
    return repositoryRoot ? [repositoryRoot] : [];
  }

  const layout = ensureWorkspaceLayout(dataRoot, store.getUserId(), workspaceId);

  const configuredRoots = materializeWorkspaceRoots({
    config: workspaceConfig.config,
    workspaceRoot: layout.root,
    createMissing: true,
  });

  if (
    !repositoryRoot ||
    configuredRoots.some(
      (root) => root.id === repositoryRoot.id || root.sourcePath === repositoryRoot.sourcePath
    )
  ) {
    return configuredRoots;
  }

  return [repositoryRoot, ...configuredRoots];
}

interface StartProductTurnInput {
  /** Required Core database for durable scheduler admission and placement. */
  readonly coreDb?: CoreDb;
  /** Parsed protocol turn-start request. */
  readonly input: z.infer<typeof SubmitTurnInputRequestSchema>;
  /** Runtime config snapshot captured for this turn. */
  readonly snapshot: RuntimeConfigSnapshot;
  /** Scheduler epoch owned by this process. */
  readonly schedulerEpoch: number;
  /** Actor-scoped store. */
  readonly store: FsStore;
  /** Runtime executor used to start worker turns. */
  readonly turnExecutor: TurnExecutor;
  /** Optional worker id selected by an upper-level coordinator. */
  readonly requestedAgentId?: string | null;
  /** Host-local working directory selected for worker startup. */
  readonly workspaceCwd: string | null;
  /** Materialized workspace roots captured for worker startup. */
  readonly workspaceRoots: ConfigMaterializedWorkspaceRoot[];
  /** Optional catalog-backed sourceRef context captured for worker startup. */
  readonly workspaceSourceContext?: Pick<
    TurnStartRuntimeContext,
    'workspaceDataSourceCatalog' | 'workspaceSourceRefs'
  >;
}

/**
 * Starts a new product turn through the durable scheduler.
 *
 * @param input Product turn startup input.
 * @returns Accepted turn handle.
 */
async function startProductTurn(input: StartProductTurnInput) {
  const requestedAgentId =
    input.requestedAgentId ??
    resolveSchedulerRequestedAgentId(input.store, input.input.workspaceId, input.input.modelId);

  if (!input.coreDb) {
    throw new TurnStartValidationError(
      'scheduler_unavailable',
      'Durable scheduler storage is required to start product turns.',
      503
    );
  }

  const suffix = schedulerAdmissionIdSuffix(
    input.store.getUserId(),
    input.input.workspaceId,
    input.input.threadId,
    input.input.requestId
  );
  const queueEntryId = `queue_${input.input.requestId}_${suffix}`;

  ensureLocalhostSchedulerBaseline(input.coreDb);
  createSchedulerAdmissionEntry(input.coreDb, {
    priorityClass: 'interactive',
    profileRef: requestedAgentId,
    queueEntryId,
    requestId: input.input.requestId,
    requestedAgentId,
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.input.threadId,
    turnId: `turn_${input.input.requestId}_${suffix}`,
    turnInput: input.input.input,
    userId: input.store.getUserId(),
    workspaceCwd: input.workspaceCwd,
    workspaceId: input.input.workspaceId,
    workspaceRoots: input.workspaceRoots,
  });

  const dispatch = await runSchedulerDispatchLoop({
    agentConfigs: input.snapshot.agentConfigs,
    agentManifests: input.snapshot.agentManifests,
    coreDb: input.coreDb,
    createAgentSessionId: () => `as_${suffix}`,
    createLeaseId: () => `lease_${suffix}`,
    createPlanId: () => `plan_${suffix}`,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    maxDispatches: 1,
    providerRegistry: input.snapshot.providerRegistry,
    schedulerEpoch: input.schedulerEpoch,
    startupTimeoutMs: 120_000,
    store: input.store,
    turnExecutor: input.turnExecutor,
    configVersion: input.snapshot.version,
    workspaceCwd: input.workspaceCwd,
    workspaceRoots: input.workspaceRoots,
    ...(input.workspaceSourceContext?.workspaceDataSourceCatalog
      ? { workspaceDataSourceCatalog: input.workspaceSourceContext.workspaceDataSourceCatalog }
      : {}),
    ...(input.workspaceSourceContext?.workspaceSourceRefs
      ? { workspaceSourceRefs: input.workspaceSourceContext.workspaceSourceRefs }
      : {}),
  });
  const started = dispatch.startedTurns.find(
    (turn) => turn.dispatch.entry.queueEntryId === queueEntryId
  );

  if (!started) {
    throw new TurnStartValidationError(
      'scheduler_admission_deferred',
      'Turn was queued but not dispatched in this scheduler iteration.',
      409
    );
  }

  return started.handle;
}

/**
 * Completes scheduler capacity accounting when an app-local runtime reaches a terminal turn state.
 *
 * @param coreDb Optional Core database handle.
 * @param turn Product turn read model.
 */
function completeSchedulerLeaseForTerminalTurn(
  coreDb: CoreDb | undefined,
  turn: TurnReadModel
): void {
  if (!coreDb) {
    return;
  }

  if (turn.status === 'completed') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'released',
      releaseReason: 'turn-completed',
    });
  } else if (turn.status === 'cancelled') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'released',
      releaseReason: 'turn-cancelled',
    });
  } else if (turn.status === 'failed') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'failed',
      releaseReason: 'turn-failed',
      recoveryState: 'needs-evidence',
    });
  }
}

/**
 * Builds the first V1 Task Mode delegation decision from the rule-based Worker Coordinator.
 *
 * @param input Task Mode request context.
 * @returns Coordinator decision plus the public Task Mode projection when launchable.
 */
function createTaskModeDelegation(input: {
  /** Store that owns workspace resources. */
  readonly store: FsStore;
  /** Workspace id for the task. */
  readonly workspaceId: string;
  /** Thread id for the task. */
  readonly threadId: string;
  /** User task prompt. */
  readonly prompt: string;
}): { coordinator: WorkerCoordinatorDecision; taskDecision: TaskDelegationDecision | null } {
  const knowledgeContext = prepareKnowledgeContext({
    operationId: `km_context_${randomUUID()}`,
    workspaceId: input.workspaceId,
    caller: 'workflow-coordinator',
    query: input.prompt,
    limit: 5,
    entries: input.store.listKnowledge(input.workspaceId),
  });
  const contextRefs: DelegationContextRef[] =
    knowledgeContext.outcome === 'prepared'
      ? knowledgeContext.materials.map((material) => ({
          kind: 'knowledge',
          id: material.knowledgeEntryId,
        }))
      : [];
  const coordinator = createWorkerCoordinatorDecision({
    prompt: input.prompt,
    readiness: workerCoordinatorCandidates(input.store, input.workspaceId),
    threadState: { status: 'idle', threadId: input.threadId },
    workspaceSummary: {
      name: input.store.getWorkspace(input.workspaceId).name,
      workspaceId: input.workspaceId,
    },
    contextRefs,
  });

  if (coordinator.decision !== 'worker_turn' || !coordinator.selectedWorkerCandidate) {
    return { coordinator, taskDecision: null };
  }

  return {
    coordinator,
    taskDecision: {
      mode: 'task',
      sourceAgentId: 'worker-coordinator',
      worker: {
        agentId: coordinator.selectedWorkerCandidate.agentId,
        displayName: coordinator.selectedWorkerCandidate.displayName,
        runtime: coordinator.selectedWorkerCandidate.runtime,
      },
      confidence: coordinator.confidence,
      rationale: coordinator.explanation,
      requiredApprovals:
        coordinator.requiredUserAction === 'none' ||
        coordinator.requiredUserAction === 'confirm_worker_turn'
          ? []
          : [coordinator.requiredUserAction],
      expectedStopCondition: 'one bounded worker turn',
      escalationRecommended: false,
      contextRefs: coordinator.workerRequest?.contextRefs ?? [
        { kind: 'workspace', id: input.workspaceId },
        { kind: 'thread', id: input.threadId },
      ],
    },
  };
}

/**
 * Builds the V1 Goal Mode step delegation decision from the rule-based Worker Coordinator.
 *
 * @param input Goal Mode step context.
 * @returns Public Coordinator delegation decision for the selected worker step.
 */
function createGoalModeStepDelegation(input: {
  /** Store that owns workspace resources. */
  readonly store: FsStore;
  /** Workspace id for the goal. */
  readonly workspaceId: string;
  /** Thread id for the goal. */
  readonly threadId: string;
  /** Goal task selected for execution. */
  readonly task: GoalTaskRecord;
}): TaskDelegationDecision {
  const coordinator = createWorkerCoordinatorDecision({
    prompt: `Run Goal Mode step: ${input.task.objective}`,
    readiness: workerCoordinatorCandidates(input.store, input.workspaceId),
    routingContext: 'goal_step',
    threadState: { status: 'idle', threadId: input.threadId },
    workspaceSummary: {
      name: input.store.getWorkspace(input.workspaceId).name,
      workspaceId: input.workspaceId,
    },
  });

  if (coordinator.decision !== 'worker_turn' || !coordinator.selectedWorkerCandidate) {
    throw new Error(`Goal step Coordinator did not select a worker: ${coordinator.explanation}`);
  }

  return {
    mode: 'goal',
    sourceAgentId: 'worker-coordinator',
    worker: {
      agentId: coordinator.selectedWorkerCandidate.agentId,
      displayName: coordinator.selectedWorkerCandidate.displayName,
      runtime: coordinator.selectedWorkerCandidate.runtime,
    },
    confidence: coordinator.confidence,
    rationale: coordinator.explanation,
    requiredApprovals:
      coordinator.requiredUserAction === 'none' ||
      coordinator.requiredUserAction === 'confirm_worker_turn'
        ? []
        : [coordinator.requiredUserAction],
    expectedStopCondition: 'one bounded worker turn',
    escalationRecommended: false,
    contextRefs: coordinator.workerRequest?.contextRefs ?? [
      { kind: 'workspace', id: input.workspaceId },
      { kind: 'thread', id: input.threadId },
    ],
  };
}

/**
 * Returns true when Chat Mode needs one bounded clarification before routing.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt is too vague to answer or hand off safely.
 */
function isClarificationChatPrompt(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');

  return [
    'help',
    'help me',
    'please help',
    'can you help',
    'can you help me',
    'can you help with this',
    'i need help',
    'help with this',
    'what should i do',
    'what do i do',
    'do it',
    'do something',
    'start',
    'continue',
    'go',
  ].includes(normalized);
}

/**
 * Returns true when Chat Mode is being asked to use external search.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks for unavailable external search.
 */
function isExternalSearchChatPrompt(prompt: string): boolean {
  return /\b(search|browse|look\s+up|google|web|internet)\b/i.test(prompt);
}

/**
 * Returns true when a Quick Chat prompt is asking for project-bound work.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt should require a project workspace.
 */
function isProjectWorkChatPrompt(prompt: string): boolean {
  return /\b(implement|fix|edit|change|modify|patch|refactor|build|ship|worker|task mode|goal mode|repository|repo|git|commit|push)\b/i.test(
    prompt
  );
}

/**
 * Returns true when Chat Mode can answer from a bounded repository root listing.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks only for linked repository file names.
 */
function isRepositoryFileListChatPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();

  return (
    /\b(list|show|what|which)\b/.test(normalized) &&
    /\b(repository|repo|working directory|workdir)\b/.test(normalized) &&
    /\b(files|contents|entries)\b/.test(normalized)
  );
}

type RepositoryFileListResult = {
  answerText: string;
  operation: 'repository.root_list' | 'repository.directory_list' | 'repository.file_read';
  summary: string;
};

type ChatRepositoryInspectionPolicy = {
  enabled: boolean;
  excludedPaths: string[];
};

class ChatRepositoryInspectionPolicyError extends Error {}

const ChatModeReadableFileExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

/**
 * Returns true when Chat Mode can answer from one bounded repository text file.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks to read one linked repository file.
 */
function isRepositoryFileReadChatPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();

  return (
    /\b(read|show|open|display)\b/.test(normalized) &&
    /\b(repository|repo|working directory|workdir)\b/.test(normalized) &&
    /\b(file|path)\b/.test(normalized)
  );
}

/**
 * Reads the Chat Mode repository inspection policy from workspace config.
 *
 * @param snapshot Runtime config snapshot containing workspace policy.
 * @param store Actor-scoped store that owns the workspace.
 * @param workspaceId Workspace id to inspect.
 * @returns Effective repository inspection policy.
 */
function chatRepositoryInspectionPolicy(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string
): ChatRepositoryInspectionPolicy {
  const workspaceConfig = findWorkspaceConfig(snapshot, store.getUserId(), workspaceId);
  const policy = workspaceConfig?.config.workspace?.assistant?.repositoryInspection;

  return {
    enabled: policy?.enabled !== false,
    excludedPaths: policy?.excludedPaths ?? [],
  };
}

/**
 * Extracts one optional repository-relative directory from a file-list prompt.
 *
 * @param prompt User prompt.
 * @returns Repository-relative directory when the prompt asks for one.
 */
function parseRepositoryFileListDirectory(prompt: string): string | null {
  const match = /\b(?:in|under)\s+([a-z0-9._/-]+)\b/i.exec(prompt.trim());
  const requestedDirectory = match?.[1]?.replace(/\/+$/g, '') ?? null;

  if (!requestedDirectory || ['repository', 'repo', 'workdir'].includes(requestedDirectory)) {
    return null;
  }

  return requestedDirectory;
}

/**
 * Extracts one repository-relative file path from a strict file-read prompt.
 *
 * @param prompt User prompt.
 * @returns Repository-relative file path when the prompt names one.
 */
function parseRepositoryFileReadPath(prompt: string): string | null {
  const match = /\b(?:file|path)\s+([a-z0-9._/-]+\.[a-z0-9]+)\b/i.exec(prompt.trim());
  return match?.[1]?.replace(/[.?!,;:]+$/g, '') ?? null;
}

/**
 * Returns a safe repository-relative target path.
 *
 * @param rootPath Absolute repository root path.
 * @param requestedPath Repository-relative path requested by the user.
 * @returns Absolute target and normalized repository-relative label.
 */
function safeRepositoryTarget(
  rootPath: string,
  requestedPath: string
): {
  targetPath: string;
  relativeTarget: string;
} {
  const requestedSegments = requestedPath.split('/').filter(Boolean);
  const targetPath = resolve(rootPath, requestedPath);
  const relativeTarget = relative(rootPath, targetPath);
  const relativeSegments = relativeTarget.split(sep).filter(Boolean);

  if (
    requestedSegments.some((segment) => segment === '.' || segment === '..') ||
    relativeTarget.startsWith('..') ||
    relativeSegments.some((segment) => segment.startsWith('.'))
  ) {
    throw new Error('Unsafe repository path requested.');
  }

  return { targetPath, relativeTarget };
}

/**
 * Normalizes a repository-relative path for policy matching.
 *
 * @param path Repository-relative path.
 * @returns Slash-separated path without leading or trailing separators.
 */
function normalizeRepositoryPolicyPath(path: string): string {
  return path
    .split(sep)
    .join('/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Checks whether a repository-relative path is excluded by policy.
 *
 * @param relativePath Repository-relative path.
 * @param excludedPaths Excluded path prefixes from workspace policy.
 * @returns True when the path itself or one of its ancestors is excluded.
 */
function isRepositoryPathExcluded(relativePath: string, excludedPaths: readonly string[]): boolean {
  const normalized = normalizeRepositoryPolicyPath(relativePath);

  return excludedPaths.some((excludedPath) => {
    const excluded = normalizeRepositoryPolicyPath(excludedPath);

    return normalized === excluded || normalized.startsWith(`${excluded}/`);
  });
}

/**
 * Fails when a repository-relative path is excluded by workspace policy.
 *
 * @param relativePath Repository-relative path.
 * @param excludedPaths Excluded path prefixes from workspace policy.
 */
function assertRepositoryPathNotExcluded(
  relativePath: string,
  excludedPaths: readonly string[]
): void {
  if (relativePath && isRepositoryPathExcluded(relativePath, excludedPaths)) {
    throw new ChatRepositoryInspectionPolicyError(
      'Workspace policy excludes that repository path from Chat Mode inspection.'
    );
  }
}

/**
 * Redacts common secret-like tokens from Chat Mode file previews.
 *
 * @param text Text that may contain raw secret-looking material.
 * @returns Redacted text.
 */
function redactChatModeFilePreview(text: string): string {
  return text
    .replace(
      /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/g,
      '$1[redacted]'
    )
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

/**
 * Builds a read-only summary of the linked repository root or one safe child directory.
 *
 * @param repository Linked repository resource to inspect.
 * @param prompt User prompt that may name one repository-relative directory.
 * @returns User-visible file and directory summary plus audit metadata.
 */
function formatRepositoryFileList(
  repository: WorkspaceRepositoryResourceRecord,
  prompt: string,
  policy: ChatRepositoryInspectionPolicy
): RepositoryFileListResult {
  const rootPath = resolve(repository.localPath);
  const requestedDirectory = parseRepositoryFileListDirectory(prompt);
  const target = requestedDirectory
    ? safeRepositoryTarget(rootPath, requestedDirectory)
    : { targetPath: rootPath, relativeTarget: '' };
  const { targetPath, relativeTarget } = target;
  assertRepositoryPathNotExcluded(relativeTarget, policy.excludedPaths);

  const entries = readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => {
      const relativeEntry = relativeTarget
        ? `${relativeTarget.split(sep).join('/')}/${entry.name}`
        : entry.name;

      return !isRepositoryPathExcluded(relativeEntry, policy.excludedPaths);
    })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 25);
  const label = relativeTarget ? `${relativeTarget.split(sep).join('/')}/` : 'root';
  const operation = relativeTarget ? 'repository.directory_list' : 'repository.root_list';
  const summary = relativeTarget
    ? 'Assistant read linked repository directory entries.'
    : 'Assistant read linked repository root entries.';

  if (entries.length === 0) {
    return {
      answerText: `Repository ${label} has no visible files or directories.`,
      operation,
      summary,
    };
  }

  return {
    answerText: `Repository ${label} entries:\n${entries.map((entry) => `- ${entry}`).join('\n')}`,
    operation,
    summary,
  };
}

/**
 * Builds a read-only preview of one safe linked repository text file.
 *
 * @param repository Linked repository resource to inspect.
 * @param prompt User prompt that names one repository-relative file.
 * @returns User-visible text preview plus audit metadata.
 */
function formatRepositoryFileRead(
  repository: WorkspaceRepositoryResourceRecord,
  prompt: string,
  policy: ChatRepositoryInspectionPolicy
): RepositoryFileListResult {
  const requestedFile = parseRepositoryFileReadPath(prompt);

  if (!requestedFile) {
    throw new Error('Repository file read prompt did not name a file.');
  }

  const rootPath = resolve(repository.localPath);
  const { targetPath, relativeTarget } = safeRepositoryTarget(rootPath, requestedFile);
  assertRepositoryPathNotExcluded(relativeTarget, policy.excludedPaths);
  const extension = extname(relativeTarget).toLowerCase();
  const stat = statSync(targetPath);

  if (!stat.isFile() || !ChatModeReadableFileExtensions.has(extension) || stat.size > 16_384) {
    throw new Error('Repository file is not eligible for Chat Mode preview.');
  }

  const raw = readFileSync(targetPath, 'utf8');

  if (raw.includes('\0')) {
    throw new Error('Repository file is not text.');
  }

  const preview = redactChatModeFilePreview(raw)
    .split(/\r?\n/)
    .slice(0, 40)
    .join('\n')
    .slice(0, 4000);
  const label = relativeTarget.split(sep).join('/');

  return {
    answerText: `Repository file ${label}:\n${preview}`,
    operation: 'repository.file_read',
    summary: 'Assistant read one linked repository text file.',
  };
}

/**
 * Projects enabled workspace agents into the Worker Coordinator candidate shape.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose agents should be projected.
 * @returns Coordinator-visible worker candidates.
 */
function workerCoordinatorCandidates(
  store: FsStore,
  workspaceId: string
): WorkerCoordinatorCandidate[] {
  return store
    .getWorkspaceResources(workspaceId)
    .agents.filter((agent) => agent.status === 'enabled')
    .flatMap((agent) => {
      const runtime = workerRuntimeForAgent(agent.id, agent.name);

      return runtime
        ? [
            {
              agentId: agent.id,
              displayName: agent.name,
              readiness: 'ready' as const,
              runtime,
            },
          ]
        : [];
    });
}

/**
 * Infers the V1 worker runtime family from the current agent catalog naming convention.
 *
 * @param agentId Product agent id.
 * @param agentName Product agent display name.
 * @returns Supported worker runtime family, or null for non-worker/internal agents.
 */
function workerRuntimeForAgent(agentId: string, agentName: string): 'codex' | 'opencode' | null {
  const value = `${agentId} ${agentName}`.toLowerCase();

  if (value.includes('opencode')) {
    return 'opencode';
  }
  if (value.includes('codex')) {
    return 'codex';
  }

  return null;
}

/**
 * Maps a protocol turn status to the Task Mode attempt state vocabulary.
 *
 * @param status Stored turn status.
 * @returns Task Mode attempt state.
 */
function taskModeStateForTurn(status: z.infer<typeof TurnSchema>['status']) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'awaiting_human':
      return 'awaiting-human';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
      return 'blocked';
    default:
      return 'running';
  }
}

/**
 * Projects the final assistant item for a completed Task Mode worker attempt.
 *
 * @param store Store that owns the thread items.
 * @param workspaceId Workspace that owns the task thread.
 * @param threadId Thread that owns the task turn.
 * @param turnId Turn whose assistant result should be projected.
 * @returns Final assistant item summary, or null when the turn has not produced one.
 */
function taskModeCompletionForTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turn: z.infer<typeof TurnSchema>
): { readonly itemId: string; readonly text: string } | null {
  if (turn.status !== 'completed') {
    return null;
  }

  let completion: { readonly itemId: string; readonly text: string } | null = null;

  for (const item of store.listThreadItems(workspaceId, threadId)) {
    if (
      item.turnId === turn.id &&
      item.type === 'assistant-message' &&
      item.status === 'completed'
    ) {
      completion = {
        itemId: item.id,
        text: item.text,
      };
    }
  }

  return completion;
}

/**
 * Projects existing thread item and artifact references that evidence one Task Mode attempt.
 *
 * @param store Store that owns the thread items.
 * @param workspaceDb Optional workspace database used to link staged workspace reviews.
 * @param workspaceId Workspace that owns the task thread.
 * @param threadId Thread that owns the task turn.
 * @param turn Turn whose visible records should be projected.
 * @returns Existing item, artifact, and review ids for callers to read through stable APIs.
 */
function taskModeEvidenceForTurn(
  store: FsStore,
  workspaceDb: WorkspaceDb | null,
  workspaceId: string,
  threadId: string,
  turn: z.infer<typeof TurnSchema>
): TaskModeEvidence {
  const itemIds: string[] = [];
  const artifactIds = new Set<string>();

  for (const item of store.listThreadItems(workspaceId, threadId)) {
    if (item.turnId !== turn.id) {
      continue;
    }

    itemIds.push(item.id);

    if (item.type === 'artifact-reference') {
      artifactIds.add(item.artifactId);
    }
  }

  for (const artifact of store.listArtifacts(workspaceId)) {
    if (artifact.turnId === turn.id) {
      artifactIds.add(artifact.id);
    }
  }

  const reviewIds = workspaceDb
    ? listWorkspaceSyncReviews(workspaceDb, workspaceId)
        .filter((review) => artifactIds.has(review.artifactId))
        .map((review) => review.review.id)
    : [];

  return { itemIds, artifactIds: [...artifactIds], reviewIds };
}

/**
 * Resolves the agent id a scheduler admission entry should request.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose resources should be checked.
 * @param modelId Optional requested model override.
 * @returns Requested agent id for the scheduler entry.
 * @throws TurnStartValidationError when the model override is invalid.
 */
function resolveSchedulerRequestedAgentId(
  store: FsStore,
  workspaceId: string,
  modelId?: string | null
): string {
  if (!modelId) {
    return store.getWorkspace(workspaceId).defaults?.defaultAgentId ?? 'agent_codex_host';
  }

  const resources = store.getWorkspaceResources(workspaceId);
  const model = resources.models.find((candidate) => candidate.id === modelId);

  if (!model) {
    throw new TurnStartValidationError('model_not_found', `Model not found: ${modelId}.`);
  }

  if (!model.enabled) {
    throw new TurnStartValidationError('model_disabled', `Model is disabled: ${modelId}.`);
  }

  const defaultAgentId = store.getWorkspace(workspaceId).defaults?.defaultAgentId ?? null;
  const matchingAgents = resources.agents.filter(
    (agent) => agent.status === 'enabled' && agent.modelId === modelId
  );
  const matchingAgent =
    matchingAgents.find((agent) => agent.id === defaultAgentId) ?? matchingAgents[0] ?? null;

  if (!matchingAgent) {
    throw new TurnStartValidationError(
      'model_not_supported_by_agent',
      `No enabled agent supports model: ${modelId}.`
    );
  }

  return matchingAgent.id;
}

/**
 * Creates a server-scope scheduler id suffix for one product turn admission.
 *
 * @param userId Actor user id.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @returns Stable short id suffix.
 */
function schedulerAdmissionIdSuffix(
  userId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  return createHash('sha256')
    .update(`${userId}:${workspaceId}:${threadId}:${requestId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Resolves the repository resource that should back a worker turn.
 *
 * @param coreDb Optional repository database handles for workspace repository links.
 * @param workspaceId Workspace id that owns the turn.
 * @returns Ready repository resource for internal worker startup, or null when repository storage is disabled.
 * @throws TurnStartValidationError when repository setup is missing or not ready.
 */
function resolveWorkspaceRepositoryForTurn(
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string
): WorkspaceRepositoryResourceRecord | null {
  if (!coreDb) {
    return null;
  }

  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, workspaceId);
  let repository: WorkspaceRepositoryResourceRecord | null;
  try {
    applyScopedMigrations(workspaceDb);
    repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);
  } finally {
    workspaceDb.sqlite.close();
  }

  if (!repository) {
    throw new TurnStartValidationError(
      'workspace_repository_missing',
      'Workspace repository is not configured.'
    );
  }

  const validation = validateRepositoryPath(repository.localPath);

  if (!validation.ok || validation.status !== 'ready') {
    throw new TurnStartValidationError(
      'workspace_repository_not_ready',
      `Workspace repository is not ready: ${validation.summary}`
    );
  }

  return repository;
}

/**
 * Returns active sessions that were captured from an older runtime config snapshot.
 */
function staleRuntimeConfigSessions(
  turnExecutor: TurnExecutor,
  store: FsStore,
  currentConfigVersion: number,
  workerControlGateway: WorkerControlGateway
): RuntimeConfigStaleSession[] {
  const staleSessions: RuntimeConfigStaleSession[] = [];

  for (const workspace of store.listWorkspaces()) {
    for (const thread of store.listThreads(workspace.id)) {
      const session = getThreadAgentSession(
        turnExecutor,
        store,
        workspace.id,
        thread.id,
        currentConfigVersion,
        workerControlGateway
      );

      if (!session?.stale) {
        continue;
      }

      const storedSession = store
        .listThreadAgentSessions(workspace.id, thread.id)
        .find((candidate) => candidate.id === session.id);

      staleSessions.push(
        createRuntimeConfigStaleSession({
          sessionId: session.id,
          threadId: thread.id,
          agentId: storedSession?.agentId ?? 'unknown',
          capturedVersion: session.configVersion,
          currentVersion: currentConfigVersion,
          reasons: ['runtime-config'],
        })
      );
    }
  }

  return staleSessions;
}

/**
 * Finds one stored session by id within a workspace.
 */
function findStoredAgentSessionById(
  store: FsStore,
  workspaceId: string,
  sessionId: string
): ReturnType<FsStore['listThreadAgentSessions']>[number] | null {
  for (const thread of store.listThreads(workspaceId)) {
    const session = store
      .listThreadAgentSessions(workspaceId, thread.id)
      .find((candidate) => candidate.id === sessionId);

    if (session) {
      return session;
    }
  }

  return null;
}

/**
 * Minimal internal agent runner surface used by app routes and diagnostics.
 */
type AppInternalAgentRunner = Pick<InternalAgentRunner, 'run'> & {
  /** Returns safe internal-agent diagnostics without prompts or secrets. */
  getDiagnostics(): InternalAgentDiagnosticsSnapshot;
};

/**
 * Construction options for the Hono app.
 */
export interface CreateAppOptions {
  mode?: CoreMode;
  auth?: BetterAuthServer;
  coreDb?: CoreDb;
  dataRoot?: string;
  store?: FsStore;
  storeFactory?: (userId: string) => FsStore;
  turnExecutor?: TurnExecutor;
  llmProviderConfigStore?: LLMProviderConfigStore;
  /** Optional Pi AI client override for tests and embedded deployments. */
  llmPiAiClient?: PiAiGatewayClient;
  llmCodexResponsesClient?: CodexResponsesClient;
  llmGatewayDispatcher?: LLMGatewayProviderDispatcher;
  /** Optional internal agent runner override for tests. */
  internalAgentRunner?: AppInternalAgentRunner;
  gatewayUsageTracker?: GatewayUsageTracker;
  /** Loaded operator config used for app diagnostics defaults. */
  openKitConfig?: OpenKitConfig;
  providerRegistry?: ProviderRegistry;
  /** Resolver used to check provider profile credential references. */
  providerCredentialResolver?: ProviderCredentialResolver;
  providerDiagnostics?: ProviderDiagnosticsSnapshot;
  runtimeConfigManager?: RuntimeConfigManager;
  internalOpenAICompatFacade?: Partial<OpenAICompatFacadeOptions>;
  codexOAuthAccountManager?: CodexOAuthAccountManager;
  codexOAuthStore?: CodexOAuthStore;
  gatewayPolicyStore?: GatewayPolicyStore;
  automationStore?: AutomationStore;
  /** Process-local worker control gateway used by sandbox-local `control.local` relays. */
  workerControlGateway?: WorkerControlGateway;
  /** Process-local worker MCP gateway used by sandbox-local `capability.local` relays. */
  workerMcpGateway?: WorkerMcpGateway;
  /** Scheduler epoch owned by this app instance. */
  schedulerEpoch?: number;
  agentConfigs?: AuthoredAgentConfig[];
  agentManifests?: AgentManifest[];
  /** Boot readiness snapshot for this process. */
  bootReadiness?: BootReadinessSnapshot;
  /** Returns the current boot readiness snapshot for request-time admission checks. */
  getBootReadiness?: () => BootReadinessSnapshot;
  /** Process-local vault unlock state used by vault admin routes. */
  vaultUnlockState?: VaultUnlockState;
  /** Optional os-keychain adapter override used by tests and embedded local deployments. */
  vaultOsKeychainAdapter?: OsKeychainVaultAdapter;
}

/**
 * Creates the default worker-control gateway for one app instance.
 *
 * @param coreDb Optional server-scope database used for durable scheduler lease binding checks.
 * @returns Worker-control gateway.
 */
export function createDefaultWorkerControlGateway(coreDb?: CoreDb): WorkerControlGateway {
  if (!coreDb) {
    return new WorkerControlGateway();
  }

  const gateway = new WorkerControlGateway({
    acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    commandDeliveryRecorder: createWorkerControlCommandDeliveryRecorder(coreDb),
    onTerminalEventAccepted: (input) => {
      const workspaceDb = openWorkspaceDb(
        coreDb.dataRoot,
        LOCAL_USER_ID,
        input.lineage.workspaceId
      );
      try {
        applyScopedMigrations(workspaceDb);
        updateBackendWorkspaceHandleCleanupStatus(
          workspaceDb,
          input.lineage.workspaceId,
          input.lineage.agentSessionId,
          'retained',
          new Date().toISOString()
        );
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!input.sandboxBindingRef.startsWith('lease-binding:')) {
        return;
      }

      const resolution = resolveSchedulerLeaseTokenBinding(coreDb, input);

      if (resolution.status === 'accepted') {
        markSchedulerSessionLeaseReleasing(coreDb, {
          leaseId: resolution.lease.leaseId,
          releaseReason: 'worker-final-status',
        });
      }
    },
    resolveTokenBinding: (input) => {
      if (!input.sandboxBindingRef.startsWith('lease-binding:')) {
        // ponytail: manually registered test sessions still use process-local tokens.
        return { status: 'accepted' };
      }

      return resolveSchedulerLeaseTokenBinding(coreDb, input);
    },
    sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
  });

  rebuildWorkerControlGatewaySessions(coreDb, gateway);
  return gateway;
}

/** Input used to create the default process vault backend for an app instance. */
export interface CreateDefaultVaultUnlockStateInput {
  /** Data root used by encrypted-file vault storage. */
  readonly dataRoot: string;
  /** Local-mode vault backend selected from operator config. */
  readonly localDefaultBackend?: 'os-keychain' | 'encrypted-file';
  /** NanoCore mode selected for this app. */
  readonly mode: 'local' | 'server';
  /** Optional os-keychain adapter override. */
  readonly osKeychainAdapter?: OsKeychainVaultAdapter;
}

/**
 * Creates the default vault state for the selected Core mode.
 *
 * @param input App mode, data root, and optional keychain adapter.
 * @returns Process-local vault state.
 */
export function createDefaultVaultUnlockState(
  input: CreateDefaultVaultUnlockStateInput
): VaultUnlockState {
  if (input.mode === 'local' && input.localDefaultBackend !== 'encrypted-file') {
    return createVaultUnlockState({
      ...(input.osKeychainAdapter ? { adapter: input.osKeychainAdapter } : {}),
      backendKind: 'os-keychain',
      deploymentId: 'local',
    });
  }

  return createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(input.dataRoot, 'server', 'vault'),
  });
}

/**
 * Resolves the local-mode vault backend default from startup config.
 *
 * @param input App options and data root.
 * @returns Configured local backend default, when present.
 */
function resolveLocalDefaultVaultBackend(input: {
  dataRoot: string | null;
  openKitConfig?: OpenKitConfig;
  runtimeConfigManager?: RuntimeConfigManager;
}): 'os-keychain' | 'encrypted-file' | undefined {
  if (input.openKitConfig?.vault?.localDefaultBackend) {
    return input.openKitConfig.vault.localDefaultBackend;
  }

  if (input.runtimeConfigManager) {
    return input.runtimeConfigManager.current().openKitConfig.vault?.localDefaultBackend;
  }

  return input.dataRoot ? loadOpenKitConfig(input.dataRoot).vault?.localDefaultBackend : undefined;
}

/**
 * Creates the Hono app for tests and runtime startup.
 */
export function createApp(options: CreateAppOptions = {}): Hono<{ Variables: AuthVariables }> {
  const mode = options.mode ?? 'local';
  const auth = options.auth ?? (mode === 'server' ? createBetterAuth() : undefined);
  const dataRoot = options.dataRoot ?? null;
  const bootReadiness = options.bootReadiness ?? createBootReadinessSnapshot();
  const getBootReadiness = options.getBootReadiness ?? (() => bootReadiness);
  const localDefaultBackend = resolveLocalDefaultVaultBackend({
    dataRoot,
    ...(options.openKitConfig ? { openKitConfig: options.openKitConfig } : {}),
    ...(options.runtimeConfigManager ? { runtimeConfigManager: options.runtimeConfigManager } : {}),
  });
  const vaultUnlockState =
    options.vaultUnlockState ??
    (dataRoot
      ? createDefaultVaultUnlockState({
          dataRoot,
          ...(localDefaultBackend ? { localDefaultBackend } : {}),
          mode,
          ...(options.vaultOsKeychainAdapter
            ? { osKeychainAdapter: options.vaultOsKeychainAdapter }
            : {}),
        })
      : null);
  const providerCredentialResolverFallback: ProviderCredentialResolver = (secretRef) =>
    options.providerCredentialResolver?.(secretRef) ?? resolveEnvSecretRef(secretRef);
  const providerCredentialResolver =
    options.coreDb && vaultUnlockState
      ? createVaultProviderCredentialResolver({
          coreDb: options.coreDb,
          vaultBackend: () => vaultUnlockState.backend(),
          fallback: providerCredentialResolverFallback,
        })
      : providerCredentialResolverFallback;
  const accessTokenVerifier = options.coreDb
    ? (secret: string, request: Request) => {
        const pathname = new URL(request.url).pathname;
        const token = verifyOpenKitAccessTokenRecord(options.coreDb!, secret, {
          channel: requestAuditChannel(request, pathname),
          source: requestAuditSource(request, pathname),
        });
        return token
          ? {
              actor: {
                userId: token.ownerUserId,
                kind: 'token' as const,
                tokenId: token.tokenId,
                tokenScope: token.scope,
                tokenWorkspaceIds: token.workspaceIds,
              },
              tokenId: token.tokenId,
            }
          : null;
      }
    : undefined;
  const workspaceMembershipVerifier = options.coreDb
    ? (actor: AuthVariables['actor'], workspaceId: string) =>
        isActiveWorkspaceMember(actor.userId, workspaceId)
    : undefined;
  const authMiddlewareOptions = {
    ...(accessTokenVerifier ? { accessTokenVerifier } : {}),
    ...(workspaceMembershipVerifier ? { workspaceMembershipVerifier } : {}),
  };

  /**
   * Returns the redacted client channel label for token last-use summaries.
   *
   * @param request Authenticated request.
   * @param pathname Request pathname.
   * @returns Client channel label.
   */
  function requestAuditChannel(request: Request, pathname: string): string {
    return (
      normalizeRequestAuditLabel(request.headers.get('x-openkit-client-channel')) ??
      (pathname.startsWith('/api/app/') ? 'app-api' : 'core-api')
    );
  }

  /**
   * Returns the redacted client source label for token last-use summaries.
   *
   * @param request Authenticated request.
   * @param pathname Request pathname.
   * @returns Client source label.
   */
  function requestAuditSource(request: Request, pathname: string): string {
    return normalizeRequestAuditLabel(request.headers.get('x-openkit-client-source')) ?? pathname;
  }

  /**
   * Normalizes a caller-supplied audit label without accepting secret-shaped material.
   *
   * @param value Header value.
   * @returns Safe label or null.
   */
  function normalizeRequestAuditLabel(value: string | null): string | null {
    const label = value?.trim();
    if (!label || label.includes('okt_')) {
      return null;
    }
    return label.slice(0, 80);
  }
  const localStore =
    options.store ?? new FsStore(options.dataRoot ? { dataRoot: options.dataRoot } : {});
  if (options.coreDb) {
    backfillRepositoryDataSourceCatalogs(options.coreDb);
  }
  const storesByUserId = new Map<string, FsStore>();
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const llmProviderConfigStore = options.llmProviderConfigStore ?? new LLMProviderConfigStore();
  const llmPiAiClient = options.llmPiAiClient ?? new PiAiGatewayClient();
  const gatewayUsageTracker = options.gatewayUsageTracker ?? new GatewayUsageTracker();
  const codexOAuthAccountManager =
    options.codexOAuthAccountManager ??
    new CodexOAuthAccountManager({
      dataRoot,
      resolveBoundProviderIds: (accountSlotId) => codexProviderIdsForSlot(accountSlotId),
      resolveDefaultAccountSlotId: () => defaultCodexAccountSlotId(),
    });
  const llmCodexResponsesClient =
    options.llmCodexResponsesClient ??
    new CodexResponsesClient({
      tokenResolverForProvider: (provider) =>
        new CodexAuthTokenResolver({
          accountStore: codexOAuthAccountManager.tokenResolutionStore(
            requireCodexOAuthAccountSlotId(provider.codexOAuthAccountSlotId)
          ),
        }),
    });
  const llmGatewayDispatcher =
    options.llmGatewayDispatcher ??
    new LLMGatewayProviderDispatcher({
      codexResponsesClient: llmCodexResponsesClient,
      piAiClient: llmPiAiClient,
      usageTracker: gatewayUsageTracker,
    });
  const hasInlineRuntimeConfigInput = Boolean(
    options.openKitConfig ??
      options.providerRegistry ??
      options.providerDiagnostics ??
      options.internalOpenAICompatFacade ??
      options.agentConfigs ??
      options.agentManifests
  );
  const runtimeConfigManager =
    options.runtimeConfigManager ??
    createRuntimeConfigManager({
      dataRoot,
      ...(!dataRoot || hasInlineRuntimeConfigInput
        ? {
            initialSnapshot: createInMemoryRuntimeConfigSnapshot({
              dataRoot,
              openKitConfig: options.openKitConfig ?? {},
              ...(options.providerRegistry ? { providerRegistry: options.providerRegistry } : {}),
              ...(options.providerDiagnostics
                ? { providerDiagnostics: options.providerDiagnostics }
                : {}),
              internalOpenAICompatFacade: {
                enabled: options.internalOpenAICompatFacade?.enabled ?? mode === 'local',
                ...(options.internalOpenAICompatFacade?.defaultProviderId
                  ? { defaultProviderId: options.internalOpenAICompatFacade.defaultProviderId }
                  : {}),
                ...(options.internalOpenAICompatFacade?.defaultModel
                  ? { defaultModel: options.internalOpenAICompatFacade.defaultModel }
                  : {}),
              },
              agentConfigs: options.agentConfigs ?? [],
              agentManifests: options.agentManifests ?? DEFAULT_AGENT_MANIFESTS,
            }),
          }
        : {}),
    });
  const gatewayPolicyStore = options.gatewayPolicyStore ?? new GatewayPolicyStore();
  const automationStore = options.automationStore ?? new AutomationStore();
  const workerControlGateway =
    options.workerControlGateway ?? createDefaultWorkerControlGateway(options.coreDb);
  const workerMcpGateway = options.workerMcpGateway ?? createDefaultWorkerMcpGateway();
  const schedulerEpoch = options.schedulerEpoch ?? 1;
  const vaultUnlockFailuresByActor = new Map<string, number[]>();
  const turnExecutor =
    options.turnExecutor ??
    createConfiguredTurnExecutor({
      coreDb: options.coreDb,
      ...(vaultUnlockState ? { vaultBackend: () => vaultUnlockState.backend() } : {}),
      workerControlGateway,
    });
  let internalAgentRunner = options.internalAgentRunner ?? null;
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(async (c, next) => {
    if (
      !getBootReadiness().acceptingProductWork &&
      isProductWorkAdmissionRequest(c.req.method, c.req.path)
    ) {
      return asApiError(
        'NanoCore is not accepting product work during the current boot readiness state.',
        'product_work_unavailable',
        503
      );
    }

    await next();
  });

  /**
   * Returns the store scoped to the current request actor.
   *
   * @param c Hono context carrying the actor variable after auth middleware.
   * @returns Actor-scoped requestStore(c).
   */
  function requestStore(c: { get: (key: 'actor') => AuthVariables['actor'] | undefined }): FsStore {
    if (mode === 'local' || options.store) {
      return localStore;
    }

    const actor = c.get('actor');
    const userId = actor?.userId ?? 'user_local';
    const cachedStore = storesByUserId.get(userId);

    if (cachedStore) {
      return cachedStore;
    }

    const nextStore =
      options.storeFactory?.(userId) ??
      new FsStore(options.dataRoot ? { dataRoot: options.dataRoot, userId } : { userId });

    if (options.coreDb) {
      for (const workspace of nextStore.listWorkspaces()) {
        recordWorkspaceOwnerMembership({
          coreDb: options.coreDb,
          ownerUserId: userId,
          workspaceId: workspace.id,
        });
      }
    }

    storesByUserId.set(userId, nextStore);

    return nextStore;
  }

  /**
   * Filters workspace collection reads for scoped token actors.
   *
   * @param actor Authenticated actor.
   * @param items Workspace records from the actor-scoped store.
   * @returns Workspace records visible to the actor.
   */
  function visibleWorkspacesForActor(
    actor: AuthVariables['actor'] | undefined,
    items: ReturnType<FsStore['listWorkspaces']>
  ): ReturnType<FsStore['listWorkspaces']> {
    if (actor?.kind !== 'token' || actor.tokenScope === 'server-admin') {
      return items;
    }

    const allowed = new Set(actor.tokenWorkspaceIds ?? []);
    return items.filter(
      (workspace) =>
        allowed.has(workspace.id) && isActiveWorkspaceMember(actor.userId, workspace.id)
    );
  }

  /**
   * Checks the minimal server-side workspace membership fact.
   *
   * @param userId Canonical user id.
   * @param workspaceId Workspace id.
   * @returns True when the user is an active workspace member.
   */
  function isActiveWorkspaceMember(userId: string, workspaceId: string): boolean {
    if (!options.coreDb) {
      return false;
    }

    return Boolean(
      options.coreDb.sqlite
        .prepare(
          `SELECT 1
           FROM workspace_members
           WHERE workspace_id = ? AND user_id = ? AND status = 'active'
           LIMIT 1`
        )
        .get(workspaceId, userId)
    );
  }

  /**
   * Returns the redacted vault admin status payload.
   *
   * @returns App API vault status payload.
   */
  function vaultAdminStatus() {
    if (!vaultUnlockState) {
      return VaultAdminStatusResponseSchema.parse({
        backendKind: 'encrypted-file',
        diagnostic: 'Vault backend is not configured.',
        state: 'unavailable',
      });
    }

    const health = vaultUnlockState.backend().health();

    return VaultAdminStatusResponseSchema.parse({
      backendKind: health.kind,
      diagnostic: health.diagnostic,
      state: health.state,
    });
  }

  /**
   * Returns an unavailable vault admin API error when no unlock state exists.
   *
   * @returns API error response.
   */
  function vaultAdminUnavailableError(): Response {
    return asApiError('Vault backend is not configured.', 'vault_backend_unavailable', 503);
  }

  /**
   * Returns the actor-scoped key used for vault unlock rate limiting.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Stable actor key for this process.
   */
  function vaultUnlockActorKey(c: Context<{ Variables: AuthVariables }>): string {
    const actor = c.get('actor');

    return actor ? `${actor.kind}:${actor.userId}` : 'unknown';
  }

  /**
   * Checks whether the current actor can administer OpenKit access tokens.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Error response when access should be denied.
   */
  function requireAccessTokenAdmin(c: Context<{ Variables: AuthVariables }>): Response | null {
    if (mode !== 'server') {
      return asApiError(
        'Access-token administration is only available in server mode.',
        'access_token_admin_server_mode_required',
        404
      );
    }

    if (!options.coreDb) {
      return asApiError(
        'Access-token storage is unavailable.',
        'access_token_storage_unavailable',
        503
      );
    }

    const actor = c.get('actor');
    if (actor?.kind === 'token' && actor.tokenScope !== 'server-admin') {
      return asApiError('Server-admin token required.', 'access_token_admin_forbidden', 403);
    }

    return null;
  }

  /**
   * Records a server audit event for one successful access-token lifecycle operation.
   *
   * @param coreDb Server database that owns the event.
   * @param action Stable access-token lifecycle action.
   * @param record Redacted access-token record affected by the operation.
   * @param actorUserId User id that requested the operation when authenticated.
   */
  function recordAccessTokenLifecycleAuditEvent(
    coreDb: CoreDb,
    action:
      | 'auth.bootstrap.consume'
      | 'auth.token.issue'
      | 'auth.token.revoke'
      | 'auth.token.rotate',
    record: OpenKitAccessTokenRecord,
    actorUserId: string | null
  ): void {
    const actorSuffix = actorUserId ? ` Requested by ${actorUserId}.` : '';
    let summary: string;
    switch (action) {
      case 'auth.bootstrap.consume':
        summary = `Bootstrap token consumed for owner ${record.ownerUserId}.${actorSuffix}`;
        break;
      case 'auth.token.issue':
        summary = `Access token ${record.tokenId} issued with ${record.scope} scope for ${record.ownerUserId}.${actorSuffix}`;
        break;
      case 'auth.token.revoke':
        summary = `Access token ${record.tokenId} revoked.${actorSuffix}`;
        break;
      case 'auth.token.rotate':
        summary = `Access token ${record.predecessorTokenId ?? record.tokenId} rotated to ${record.tokenId}.${actorSuffix}`;
        break;
    }

    recordServerAuditEvent({
      action,
      category: 'system',
      coreDb,
      outcome: 'succeeded',
      resource: `auth-token:${record.tokenId}`,
      severity: 'info',
      summary,
    });
  }

  /**
   * Returns active failed unlock attempts for the actor.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Mutable active attempt timestamps.
   */
  function activeVaultUnlockFailures(c: Context<{ Variables: AuthVariables }>): number[] {
    const key = vaultUnlockActorKey(c);
    const cutoff = Date.now() - VAULT_UNLOCK_FAILURE_WINDOW_MS;
    const active = (vaultUnlockFailuresByActor.get(key) ?? []).filter((at) => at >= cutoff);

    vaultUnlockFailuresByActor.set(key, active);

    return active;
  }

  /**
   * Checks whether the actor has exhausted failed unlock attempts.
   *
   * @param c Hono context carrying the actor variable.
   * @returns True when the next unlock request should be denied.
   */
  function isVaultUnlockRateLimited(c: Context<{ Variables: AuthVariables }>): boolean {
    return activeVaultUnlockFailures(c).length >= VAULT_UNLOCK_FAILURE_LIMIT;
  }

  /**
   * Adds one failed unlock attempt to the actor's process-local window.
   *
   * @param c Hono context carrying the actor variable.
   */
  function rememberVaultUnlockFailure(c: Context<{ Variables: AuthVariables }>): void {
    activeVaultUnlockFailures(c).push(Date.now());
  }

  /**
   * Clears failed unlock attempts after a successful unlock.
   *
   * @param c Hono context carrying the actor variable.
   */
  function clearVaultUnlockFailures(c: Context<{ Variables: AuthVariables }>): void {
    vaultUnlockFailuresByActor.delete(vaultUnlockActorKey(c));
  }

  /**
   * Records a vault admin audit event when server storage is configured.
   *
   * @param c Hono context carrying the actor variable.
   * @param input Redacted audit fields.
   */
  function recordVaultAdminAudit(
    c: Context<{ Variables: AuthVariables }>,
    input: {
      readonly action:
        | 'vault.unlock'
        | 'vault.lock'
        | 'vault.bootstrap_codex_auth_json'
        | 'vault.rebind_workspace_reference';
      readonly outcome: 'succeeded' | 'failed' | 'denied';
      readonly summary: string;
      readonly errorCode?: string;
    }
  ): void {
    if (!options.coreDb) {
      return;
    }

    recordVaultAdminAuditEvent({
      action: input.action,
      actor: c.get('actor'),
      backendKind: vaultUnlockState?.backend().kind ?? 'encrypted-file',
      coreDb: options.coreDb,
      errorCode: input.errorCode ?? null,
      outcome: input.outcome,
      summary: input.summary,
    });
  }

  /**
   * Returns the configured Core database for repository App API routes.
   *
   * @returns Core database handles.
   * @throws Error when repository storage has not been configured for this app instance.
   */
  function repositoryCoreDb(): CoreDb {
    if (!options.coreDb) {
      throw new Error('Repository storage is unavailable for this NanoCore instance.');
    }

    return options.coreDb;
  }

  /**
   * Opens the workspace-owned repository database for one request.
   *
   * @param store Request store that owns the current actor identity.
   * @param workspaceId Workspace id that owns repository resources.
   * @returns Migrated workspace database handle.
   */
  function repositoryWorkspaceDb(store: FsStore, workspaceId: string): WorkspaceDb {
    const coreDb = repositoryCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), workspaceId);
    applyScopedMigrations(workspaceDb);
    return workspaceDb;
  }

  /**
   * Converts a repository storage record to the redacted App API read model.
   *
   * @param record Stored repository resource record.
   * @returns Redacted repository resource payload.
   */
  function repositoryReadModel(record: WorkspaceRepositoryResourceRecord): unknown {
    const validation = record.validation ?? validateRepositoryPath(record.localPath);

    return WorkspaceRepositoryResourceSchema.parse({
      workspaceId: record.workspaceId,
      resourceId: record.resourceId,
      type: record.type,
      displayName: safeWorkspaceRepositoryDisplayName(record, validation),
      diagnosticsStatus: validation.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pathSummary: validation.pathSummary,
      git: record.git,
      validation,
    });
  }

  /**
   * Finds one stored repository resource by id.
   *
   * @param workspaceDb Open workspace-scope database handle.
   * @param workspaceId Workspace id that owns the repository.
   * @param resourceId Repository resource id.
   * @returns Stored repository resource.
   * @throws Error when the repository is not linked.
   */
  function requireWorkspaceRepositoryResource(
    workspaceDb: WorkspaceDb,
    workspaceId: string,
    resourceId: string
  ): WorkspaceRepositoryResourceRecord {
    const repository = listWorkspaceRepositoryResources(workspaceDb, workspaceId).find(
      (candidate) => candidate.resourceId === resourceId
    );

    if (!repository) {
      throw new Error(`Repository resource not found: ${resourceId}`);
    }

    return repository;
  }

  /**
   * Reads the policy decision that opened one repo.push approval.
   *
   * @param workspaceDb Open workspace-scope database handle.
   * @param workspaceId Workspace id that owns the approval.
   * @param approvalId Approval request id.
   * @returns Stored require-approval decision row, or null.
   */
  function readRepoPushApprovalDecision(
    workspaceDb: WorkspaceDb,
    workspaceId: string,
    approvalId: string
  ): PolicyApprovalDecisionRow | null {
    return readPolicyApprovalDecision(workspaceDb, workspaceId, approvalId, 'repo.push');
  }

  /**
   * Resolves the V1 Git push provider from a redacted remote summary.
   *
   * @param remoteSummary User-safe remote summary.
   * @returns GitHub for V1 GitHub remotes, otherwise unsupported.
   */
  function gitPushProvider(remoteSummary: string): 'github' | 'unsupported' {
    return remoteSummary.toLowerCase().includes('github') ? 'github' : 'unsupported';
  }

  /**
   * Resolves host-side Git push credentials through the repository's vault grant.
   *
   * @param input Repository and workspace context.
   * @returns Scrubbed credential env for the GitHub V1 adapter, or undefined for public remotes.
   */
  function resolveGitPushCredentialEnv(input: {
    readonly repository: WorkspaceRepositoryResourceRecord;
    readonly workspaceDb: WorkspaceDb;
    readonly workspaceId: string;
  }): NodeJS.ProcessEnv | undefined {
    const grantId = input.repository.git.vaultGrantRef;

    if (!grantId) {
      return undefined;
    }
    if (!options.coreDb || !vaultUnlockState) {
      throw new Error('Git push vault credential resolution is unavailable.');
    }

    const grant = getVaultGrant(options.coreDb, grantId);

    if (!grant) {
      throw new Error(`Git push vault grant not found: ${grantId}`);
    }
    if (grant.ownerScope === 'workspace' && grant.workspaceId !== input.workspaceId) {
      throw new Error(`Git push vault grant is not scoped to workspace: ${grantId}`);
    }
    if (
      grant.status !== 'active' ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
    ) {
      throw new Error(`Git push vault grant is not active: ${grantId}`);
    }
    if (!grant.allowedInjectionPaths.includes('gateway-only')) {
      throw new Error(`Git push vault grant does not allow gateway-only use: ${grantId}`);
    }

    const reference = getVaultReference(options.coreDb, grant.vaultReferenceId);

    if (!reference || reference.status !== 'active') {
      throw new Error(`Git push vault reference is not active: ${grant.vaultReferenceId}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const capabilityCallId = `cap_git_push_${id}`;
    const planId = `plan_git_push_${id}`;
    const receiptId = `receipt_git_push_${id}`;

    createInjectionPlan(options.coreDb, {
      backendCapabilityRequirement: 'git-push:github-token',
      capabilityId: 'workspace.git.push',
      expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
      grantId,
      injectionVisibility: 'gateway-only',
      packageSnapshotId: 'nanocore-host',
      planId,
      redactionRule: 'no-secret-material',
      revocationBehavior: 'host-process-only',
      now: () => now,
    });
    createInjectionReceipt(options.coreDb, {
      agentSessionId: null,
      backendSummary: 'git-push:github-token',
      capabilityCallId,
      expiresAt: grant.expiresAt,
      grantId,
      injectedAt: now,
      planId,
      receiptId,
      revocationStatus: 'active',
    });

    const token = vaultMaterialToString(
      createVaultUseAuditedBackend({
        backend: vaultUnlockState.backend(),
        capabilityCallId,
        db: input.workspaceDb,
        grantId,
        ownerScope: 'workspace',
        planId,
        receiptId,
        resolvingPath: 'grant',
        workspaceId: input.workspaceId,
        now: () => now,
      }).resolve({ referenceId: grant.vaultReferenceId })
    );

    return { GH_TOKEN: token, GITHUB_TOKEN: token };
  }

  /**
   * Builds sourceRef context for repository-backed worker launches.
   *
   * @param store Request store that owns the workspace tree.
   * @param workspaceId Workspace id that owns the turn.
   * @param repository Repository selected for the worker, when any.
   * @param workspaceRoots Worker roots captured for the turn.
   * @returns Optional AEP sourceRef context.
   */
  function workspaceSourceContextForTurn(
    snapshot: RuntimeConfigSnapshot,
    store: FsStore,
    workspaceId: string,
    repository: WorkspaceRepositoryResourceRecord | null,
    workspaceRoots: ConfigMaterializedWorkspaceRoot[]
  ): Pick<TurnStartRuntimeContext, 'workspaceDataSourceCatalog' | 'workspaceSourceRefs'> {
    let workspaceDataSourceCatalog = snapshot.workspaceDataSourceCatalogs.find(
      (entry) => entry.userId === store.getUserId() && entry.workspaceId === workspaceId
    )?.catalog;

    if (!repository || !workspaceRoots.some((root) => root.id === repository.resourceId)) {
      return workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {};
    }

    workspaceDataSourceCatalog = syncRepositoryDataSourceCatalog({
      dataRoot: repositoryCoreDb().dataRoot,
      userId: store.getUserId(),
      workspaceId,
      record: repository,
    });

    return {
      workspaceDataSourceCatalog,
      workspaceSourceRefs: { [repository.resourceId]: repository.resourceId },
    };
  }

  /**
   * Converts repository route failures into stable App API errors.
   *
   * @param error Route failure.
   * @returns Protocol-stamped API error response.
   */
  function asRepositoryApiError(error: unknown): Response {
    const message = (error as Error).message;

    if (error instanceof TurnStartValidationError) {
      return asApiError(error.message, error.code, error.status);
    }

    if (message === 'Repository storage is unavailable for this NanoCore instance.') {
      return asApiError(message, 'repository_storage_unavailable', 503);
    }

    if (message.startsWith('Workspace not found:')) {
      return asApiError(message, 'workspace_not_found', 404);
    }

    return asApiError(message, 'repository_resource_failed', 400);
  }

  /**
   * Returns the current runtime config snapshot for one request operation.
   */
  function runtimeConfig(): RuntimeConfigSnapshot {
    return runtimeConfigManager.current();
  }

  /**
   * Materializes current workspace roots for explicit context package root-file reads.
   *
   * @param store Request store that owns the workspace.
   * @param workspaceId Workspace id that owns the context request.
   * @returns Current materialized roots, including a ready default repository root when available.
   */
  function workspaceRootsForContextPackage(
    store: FsStore,
    workspaceId: string
  ): ConfigMaterializedWorkspaceRoot[] {
    let repository: WorkspaceRepositoryResourceRecord | null = null;

    try {
      repository = resolveWorkspaceRepositoryForTurn(
        options.coreDb,
        workspaceId,
        store.getUserId()
      );
    } catch {
      repository = null;
    }

    return materializeWorkspaceRootsForTurn(runtimeConfig(), store, workspaceId, repository);
  }

  /**
   * Starts one durable Goal Mode objective on a thread.
   *
   * @param input Goal startup input.
   * @returns Started Goal Mode projection.
   */
  function startGoalModeObjective(input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly objective: string;
    readonly title?: string | undefined;
  }): {
    readonly response: z.infer<typeof StartThreadGoalResponseSchema>;
    readonly turn: z.infer<typeof TurnSchema>;
  } {
    if (!options.coreDb) {
      throw new TurnStartValidationError(
        'goal_storage_unavailable',
        'Goal storage is unavailable for this NanoCore instance.',
        503
      );
    }

    assertProjectWorkspace(input.store.getWorkspace(input.workspaceId), 'start Goal Mode');

    const workspaceDb = repositoryWorkspaceDb(input.store, input.workspaceId);
    try {
      const existingGoals = listGoalRecordsForThread(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
      });

      if (existingGoals.some(isActiveGoal)) {
        throw new TurnStartValidationError(
          'goal_already_active',
          'Thread already has an active goal.',
          409
        );
      }

      const goalId = nextThreadGoalId(existingGoals);
      const turn = input.store.createTurn(input.workspaceId, input.threadId, input.objective);
      const timestamp = turn.startedAt ?? new Date().toISOString();
      const objectiveItem = input.store.createItem({
        id: `it_goal_objective_${goalId}`,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: turn.id,
        type: 'user-message',
        status: 'completed',
        text: input.objective,
        createdAt: timestamp,
        completedAt: timestamp,
      });

      input.store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: timestamp,
        durationMs: 0,
      });

      createGoalRecord(workspaceDb, {
        workspaceExists: (candidateWorkspaceId) => {
          try {
            input.store.getWorkspace(candidateWorkspaceId);
            return true;
          } catch {
            return false;
          }
        },
        goalId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        title: deriveThreadGoalTitle(input.title, input.objective),
        objective: input.objective,
        createdByItemId: objectiveItem.id,
        now: () => timestamp,
      });

      const goal = buildThreadGoalSummary(
        workspaceDb,
        input.workspaceId,
        input.threadId,
        input.store.listThreadItems(input.workspaceId, input.threadId)
      );

      if (!goal) {
        throw new TurnStartValidationError('goal_create_failed', 'Goal was not created.', 500);
      }

      return {
        response: StartThreadGoalResponseSchema.parse({
          goal,
          objectiveItemId: objectiveItem.id,
        }),
        turn: input.store.getTurnById(turn.id),
      };
    } finally {
      workspaceDb.sqlite.close();
    }
  }

  /**
   * Starts one Task Mode worker attempt through the same path used by the public task route.
   *
   * @param input Task Mode startup input.
   * @returns Started Task Mode projection, or null when the Coordinator did not select a worker.
   */
  async function startTaskModeAttempt(input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId?: string | undefined;
    readonly delegation?: ReturnType<typeof createTaskModeDelegation> | undefined;
  }): Promise<{
    readonly decision: TaskDelegationDecision;
    readonly state: ReturnType<typeof taskModeStateForTurn>;
    readonly turn: z.infer<typeof TurnSchema>;
  } | null> {
    const delegation =
      input.delegation ??
      createTaskModeDelegation({
        store: input.store,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        prompt: input.prompt,
      });

    if (!delegation.taskDecision) {
      return null;
    }

    const snapshot = runtimeConfig();
    const repository = resolveWorkspaceRepositoryForTurn(
      options.coreDb,
      input.workspaceId,
      input.store.getUserId()
    );
    const workspaceRoots = materializeWorkspaceRootsForTurn(
      snapshot,
      input.store,
      input.workspaceId,
      repository
    );
    const workspaceSourceContext = workspaceSourceContextForTurn(
      snapshot,
      input.store,
      input.workspaceId,
      repository,
      workspaceRoots
    );
    const handle = await startProductTurn({
      input: {
        input: input.prompt,
        modelId: input.modelId,
        requestId: input.requestId ?? randomUUID(),
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      },
      requestedAgentId: delegation.taskDecision.worker.agentId,
      schedulerEpoch,
      snapshot,
      store: input.store,
      turnExecutor,
      workspaceCwd: repository?.localPath ?? null,
      workspaceRoots,
      workspaceSourceContext,
      ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    });

    return {
      decision: delegation.taskDecision,
      state: taskModeStateForTurn(handle.turn.status),
      turn: handle.turn,
    };
  }

  /**
   * Creates a runtime config file service for the current actor context.
   *
   * @param c Hono context carrying the actor variable.
   * @returns Runtime config file service.
   */
  function runtimeConfigFileService(c: {
    get: (key: 'actor') => AuthVariables['actor'] | undefined;
  }): RuntimeConfigFileService {
    const store = requestStore(c);

    return new RuntimeConfigFileService({
      dataRoot,
      userId: store.getUserId(),
      workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
      runtimeConfigManager,
      readRuntimeConfigStatus: () =>
        runtimeConfigManager.status(
          staleRuntimeConfigSessions(
            turnExecutor,
            store,
            runtimeConfig().version,
            workerControlGateway
          )
        ),
      ...(options.coreDb
        ? {
            onDataSourceAuthorityChange: (change) => {
              const workspaceDb = repositoryWorkspaceDb(store, change.workspaceId);
              try {
                recordWorkspaceAuditEvent({
                  workspaceDb,
                  workspaceId: change.workspaceId,
                  category: 'system',
                  action: 'data_source_catalog.authority.update',
                  resource: `data-source-catalog:${change.sourceId}`,
                  outcome: 'succeeded',
                  severity: 'info',
                  summary: `Workspace data source catalog authority changed for ${change.sourceId}: ${change.fields.join(', ')}.`,
                });
              } finally {
                workspaceDb.sqlite.close();
              }
            },
          }
        : {}),
    });
  }

  /**
   * Resolves internal OpenAI-compatible facade options for the active app mode.
   */
  function internalFacadeOptions(): OpenAICompatFacadeOptions {
    const snapshot = runtimeConfig();
    const config = snapshot.openKitConfig.internal?.openaiCompatFacade;
    const configuredOptions =
      config || options.internalOpenAICompatFacade ? snapshot.internalOpenAICompatFacade : null;

    return {
      enabled: configuredOptions?.enabled ?? mode === 'local',
      ...(configuredOptions?.defaultProviderId
        ? { defaultProviderId: configuredOptions.defaultProviderId }
        : {}),
      ...(configuredOptions?.defaultModel ? { defaultModel: configuredOptions.defaultModel } : {}),
    };
  }

  /**
   * Resolves the Gateway default provider id from runtime config and provider defaults.
   *
   * @returns Gateway provider id or null.
   */
  function gatewayDefaultProviderId(): string | null {
    return (
      runtimeConfig().openKitConfig.defaults?.gatewayProviderId ??
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.defaultProviderId ??
      llmProviderConfigStore.getDefaults().gateway.providerId
    );
  }

  /**
   * Resolves the Gateway default model from runtime config and provider defaults.
   *
   * @returns Gateway model or null.
   */
  function gatewayDefaultModel(): string | null {
    const providerId = gatewayDefaultProviderId();
    const runtimeProfile = providerId ? runtimeConfig().providerRegistry.get(providerId) : null;

    return (
      runtimeConfig().openKitConfig.defaults?.gatewayModel ??
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.defaultModel ??
      runtimeProfile?.defaultModel ??
      llmProviderConfigStore.getDefaults().gateway.model
    );
  }

  /**
   * Resolves the default Codex account slot from the current Gateway provider binding.
   *
   * @returns Account slot id, or null when the default provider is not Codex.
   */
  function defaultCodexAccountSlotId(): string | null {
    const providerId = gatewayDefaultProviderId();
    const profile = providerId ? runtimeConfig().providerRegistry.get(providerId) : null;

    return profile ? readCodexOAuthAccountSlotId(profile) : null;
  }

  /**
   * Requires a Codex OAuth provider account slot before resolving token storage.
   *
   * @param accountSlotId Account slot id from the resolved provider config.
   * @returns Account slot id when present.
   * @throws Error when a Codex OAuth provider omits its account slot.
   */
  function requireCodexOAuthAccountSlotId(accountSlotId: string | null | undefined): string {
    if (!accountSlotId) {
      throw new Error('Codex OAuth provider requires extensions.openkit.codexOAuth.accountSlotId.');
    }

    return accountSlotId;
  }

  /**
   * Lists runtime provider ids bound to one Codex account slot.
   *
   * @param accountSlotId Account slot id.
   * @returns Provider ids bound to the account slot.
   */
  function codexProviderIdsForSlot(accountSlotId: string): string[] {
    return runtimeConfig()
      .providerRegistry.list()
      .filter((profile) => readCodexOAuthAccountSlotId(profile) === accountSlotId)
      .map((profile) => profile.id);
  }

  /**
   * Checks whether the Gateway is enabled by runtime config and policy store.
   *
   * @returns True when Gateway routes are enabled.
   */
  function isGatewayEnabled(): boolean {
    return (
      gatewayPolicyStore.getPolicy().enabled &&
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.enabled !== false
    );
  }

  /**
   * Checks whether a provider id is allowed by runtime config and policy store.
   *
   * @param providerId Provider id to check.
   * @returns True when Gateway routing is allowed.
   */
  function isGatewayProviderAllowed(providerId: string): boolean {
    const runtimeAllowlist =
      runtimeConfig().openKitConfig.gateway?.openaiCompatible?.allowedProviderIds;

    return (
      gatewayPolicyStore.allowsProvider(providerId) &&
      (!runtimeAllowlist || runtimeAllowlist.includes(providerId))
    );
  }

  /**
   * Records an LLM gateway policy decision when durable storage is available.
   *
   * @param input Gateway policy decision details.
   */
  function recordLlmGatewayPolicyDecision(input: {
    action: 'llm.gateway.chat_completions' | 'llm.gateway.responses';
    providerId?: string | null;
    reasonCode: 'gateway_allowed' | 'gateway_disabled' | 'gateway_provider_not_allowed';
    result: 'allow' | 'deny';
    route: '/v1/chat/completions' | '/v1/responses';
  }): void {
    if (!options.coreDb) {
      return;
    }

    try {
      recordGatewayPolicyDecision({ coreDb: options.coreDb, ...input });
    } catch (error) {
      console.warn(
        `Failed to record gateway policy decision: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolves a provider config for Gateway dispatch.
   *
   * @param providerId Provider id selected by Gateway defaults.
   * @returns Secret-bearing provider config.
   */
  function resolveGatewayProvider(providerId: string) {
    const profile = runtimeConfig().providerRegistry.get(providerId);

    if (profile) {
      return resolveProviderProfileToLLMConfig(profile, providerCredentialResolver);
    }

    return llmProviderConfigStore.resolveProvider(providerId);
  }

  /**
   * Returns app-diagnostics default provider and model selections.
   *
   * @returns Default provider/model selections for diagnostics.
   */
  function diagnosticsProviderDefaults() {
    const providerConfigDefaults = llmProviderConfigStore.getDefaults();

    return {
      quickChat: {
        providerId: gatewayDefaultProviderId() ?? providerConfigDefaults.quickChat.providerId,
        model: gatewayDefaultModel() ?? providerConfigDefaults.quickChat.model,
      },
      internalTasks: {
        providerId:
          runtimeConfig().openKitConfig.defaults?.coreProviderId ??
          providerConfigDefaults.internalTasks.providerId,
        model:
          runtimeConfig().openKitConfig.defaults?.coreModel ??
          providerConfigDefaults.internalTasks.model,
      },
      gateway: {
        providerId: gatewayDefaultProviderId(),
        model: gatewayDefaultModel(),
      },
    };
  }

  /**
   * Resolves provider and model defaults for internal agents.
   *
   * @param defaultUse Internal agent provider default slot.
   * @returns Provider id and model selected for the requested slot.
   */
  function internalAgentDefaultSelection(defaultUse: InternalAgentDefaultProviderUse) {
    const providerConfigDefaults = llmProviderConfigStore.getDefaults();

    if (defaultUse === 'quickChat') {
      return {
        providerId: gatewayDefaultProviderId() ?? providerConfigDefaults.quickChat.providerId,
        model: gatewayDefaultModel() ?? providerConfigDefaults.quickChat.model,
      };
    }

    return {
      providerId:
        runtimeConfig().openKitConfig.defaults?.coreProviderId ??
        providerConfigDefaults.internalTasks.providerId,
      model:
        runtimeConfig().openKitConfig.defaults?.coreModel ??
        providerConfigDefaults.internalTasks.model,
    };
  }

  /**
   * Resolves provider and model for quick-chat requests.
   *
   * @param providerId Optional provider id from request body.
   * @param model Optional model from request body.
   * @returns Provider id and model selected for quick chat.
   */
  function quickChatSelection(providerId?: string, model?: string) {
    const defaults = internalAgentDefaultSelection('quickChat');
    const { providerId: defaultProviderId, model: defaultModel } = defaults;

    return {
      providerId: providerId ?? defaultProviderId,
      model: model ?? defaultModel,
    };
  }

  /**
   * Returns the app-local internal agent runner.
   *
   * @returns Internal agent runner backed by current provider defaults and Gateway dispatcher.
   */
  function getInternalAgentRunner(): AppInternalAgentRunner {
    internalAgentRunner ??= new InternalAgentRunner({
      defaultSelectionResolver: internalAgentDefaultSelection,
      llmClient: llmGatewayDispatcher,
      providerConfigStore: llmProviderConfigStore,
      providerResolver: resolveGatewayProvider,
    });

    return internalAgentRunner;
  }

  app.use('/api/worker-control/*', browserCors);

  app.post('/api/worker-control/heartbeat', async (c) => {
    const parsed = WorkerControlHeartbeatRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json({
        heartbeat: workerControlGateway.recordHeartbeat({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          message: parsed.data.message ?? null,
          sequence: parsed.data.sequence,
          status: parsed.data.status,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'heartbeat',
        route: '/api/worker-control/heartbeat',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/artifacts', async (c) => {
    const parsed = WorkerControlArtifactNoticeRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json({
        artifact: workerControlGateway.recordArtifactNotice({
          artifact: parsed.data.artifact,
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          sequence: parsed.data.sequence,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'artifact_notice',
        route: '/api/worker-control/artifacts',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/commands/poll', async (c) => {
    const parsed = WorkerControlCommandPollRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(
        workerControlGateway.pollCommands({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'commands_poll',
        route: '/api/worker-control/commands/poll',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/commands/ack', async (c) => {
    const parsed = WorkerControlCommandAckRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json({
        command: workerControlGateway.acknowledgeCommand({
          authorization: c.req.header('authorization') ?? null,
          commandId: parsed.data.commandId,
          lineage: parsed.data.lineage,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'command_ack',
        route: '/api/worker-control/commands/ack',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/terminal-results', async (c) => {
    const parsed = await parseWorkerControlTerminalResultRequest(c);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json({
        terminalResult: workerControlGateway.recordTerminalResult({
          authorization: c.req.header('authorization') ?? null,
          durationMs: parsed.data.durationMs ?? null,
          exitCode: parsed.data.exitCode,
          lineage: parsed.data.lineage,
          stderr: parsed.data.stderr,
          stdout: parsed.data.stdout,
          terminalCommandId: parsed.data.terminalCommandId,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'terminal_result',
        route: '/api/worker-control/terminal-results',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/events/append', async (c) => {
    const parsed = await parseWorkerControlEventAppendRequest(c);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      return c.json(
        workerControlGateway.appendEvent({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          record: parsed.data.record,
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'event_append',
        route: '/api/worker-control/events/append',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/final-status', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'final_status') {
      return asInvalidRequestError(new Error('Worker control operation must be final_status.'));
    }

    const body = WorkerControlFinalStatusBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      return c.json(
        workerControlGateway.appendEvent({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          record: WorkerCanonicalEventRecordSchema.parse({
            event: {
              data: {
                evidenceManifestDigests: body.data.evidenceManifestDigests ?? {},
                stopReason: body.data.stopReason ?? body.data.status,
              },
              type: body.data.status === 'completed' ? 'turn.completed' : 'turn.failed',
            },
            kind: 'event',
            lineage: parsed.data.lineage,
            schemaVersion: parsed.data.schemaVersion,
            sequence: parsed.data.sequence,
          }),
        })
      );
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'final_status',
        route: '/api/worker-control/final-status',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/supply-refresh-ack', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'supply_refresh_ack') {
      return asInvalidRequestError(
        new Error('Worker control operation must be supply_refresh_ack.')
      );
    }

    const body = WorkerControlSupplyRefreshAckBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      const supplyRefreshAck = workerControlGateway.recordSupplyRefreshAck({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
        message: body.data.message ?? null,
        refreshId: body.data.refreshId,
        sequence: parsed.data.sequence,
        status: body.data.status,
      });

      if (options.coreDb) {
        recordSchedulerSupplyRefreshAck(options.coreDb, {
          acknowledgedAt: supplyRefreshAck.acknowledgedAt,
          agentSessionId: parsed.data.lineage.agentSessionId,
          message: supplyRefreshAck.message,
          packageSnapshotId: parsed.data.lineage.packageSnapshotId,
          refreshId: supplyRefreshAck.refreshId,
          sequence: supplyRefreshAck.sequence,
          status: supplyRefreshAck.status,
          threadId: parsed.data.lineage.threadId,
          turnId: parsed.data.lineage.turnId,
          workspaceId: parsed.data.lineage.workspaceId,
        });
      }

      return c.json({
        supplyRefreshAck,
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'supply_refresh_ack',
        route: '/api/worker-control/supply-refresh-ack',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/capability-summary', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'capability_summary') {
      return asInvalidRequestError(
        new Error('Worker control operation must be capability_summary.')
      );
    }

    const body = WorkerCapabilityCallSummarySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      return c.json({
        response: workerControlGateway.recordCapabilitySummary({
          authorization: c.req.header('authorization') ?? null,
          lineage: parsed.data.lineage,
          summary: body.data,
        }),
      });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'capability_summary',
        route: '/api/worker-control/capability-summary',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-control/knowledge-proposal-summary', async (c) => {
    const parsed = await parseWorkerControlEnvelope(c);

    if (!parsed.success) {
      return parsed.response;
    }

    if (parsed.data.operation !== 'knowledge_proposal_summary') {
      return asInvalidRequestError(
        new Error('Worker control operation must be knowledge_proposal_summary.')
      );
    }

    const body = WorkerControlKnowledgeProposalSummaryBodySchema.safeParse(parsed.data.body);

    if (!body.success) {
      return asInvalidRequestError(body.error);
    }

    try {
      const knowledgeProposalSummary = workerControlGateway.recordKnowledgeProposalSummary({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
        proposalId: body.data.proposalId,
        sequence: parsed.data.sequence,
        summary: body.data.summary,
        title: body.data.title,
      });
      const now = new Date().toISOString();

      localStore.createKnowledgeProposal({
        createdAt: now,
        id: body.data.proposalId,
        status: 'pending',
        summary: body.data.summary,
        title: body.data.title,
        updatedAt: now,
        workspaceId: parsed.data.lineage.workspaceId,
      });

      return c.json({ knowledgeProposalSummary });
    } catch (error) {
      quarantineWorkerControlRejection({
        coreDb: options.coreDb,
        error,
        lineage: parsed.data.lineage,
        operation: 'knowledge_proposal_summary',
        route: '/api/worker-control/knowledge-proposal-summary',
      });
      return asWorkerControlApiError(error);
    }
  });

  app.use('/api/worker-capabilities/*', browserCors);

  app.post('/api/worker-capabilities/knowledge/search', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeSearchRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const session = workerControlGateway.authenticateRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const limit = parsed.data.limit ?? 10;
      const items = searchKnowledgeEntries(
        requestStore(c).listKnowledge(session.workspaceId),
        parsed.data.query,
        limit
      );

      return c.json(
        WorkerCapabilityKnowledgeSearchResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.search',
            inputSummary: `Knowledge search requested with query length ${parsed.data.query.length}.`,
            lineage: parsed.data.lineage,
            outputSummary: `${items.length} knowledge entries matched.`,
            store: requestStore(c),
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-search',
                unit: 'capability_calls',
              },
            ],
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          items,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/knowledge/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeReadRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const session = workerControlGateway.authenticateRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const item = requestStore(c).getKnowledgeEntry(
        session.workspaceId,
        parsed.data.knowledgeEntryId
      );

      return c.json(
        WorkerCapabilityKnowledgeReadResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.read',
            inputSummary: `Knowledge read requested for ${parsed.data.knowledgeEntryId}.`,
            lineage: parsed.data.lineage,
            outputSummary: `Knowledge entry ${item.id} returned.`,
            store: requestStore(c),
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-read',
                unit: 'capability_calls',
              },
            ],
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          item,
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      recordFailedWorkerCapabilityCall({
        errorCode: 'worker_capability_knowledge_not_found',
        family: 'knowledge.read',
        ledgerFamily: 'knowledge',
        lineage: parsed.data.lineage,
        operation: 'knowledge.read',
        serviceRef: 'knowledge-store',
        store: requestStore(c),
        summary: `Knowledge read failed for ${parsed.data.knowledgeEntryId}.`,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });
      return asApiError((error as Error).message, 'worker_capability_knowledge_not_found', 404);
    }
  });

  app.post('/api/worker-capabilities/knowledge/proposals', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityKnowledgeProposalRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const session = workerControlGateway.authenticateRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const store = requestStore(c);
      const timestamp = new Date().toISOString();
      const proposal = store.createKnowledgeProposal({
        createdAt: timestamp,
        id: `kp_${randomUUID()}`,
        status: 'pending',
        summary: parsed.data.summary,
        title: parsed.data.title,
        updatedAt: timestamp,
        workspaceId: session.workspaceId,
      });
      const draft = draftKnowledgeProposal({
        operationId: `km_proposal_${randomUUID()}`,
        workspaceId: session.workspaceId,
        caller: 'assistant',
        proposal,
        sourceReferences: parsed.data.sourceReferences,
        entries: store.listKnowledge(session.workspaceId),
        sources: store.listKnowledgeSources(session.workspaceId),
        confidence: parsed.data.confidence,
      });

      return c.json(
        WorkerCapabilityKnowledgeProposalResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'knowledge.proposal',
            inputSummary: `Knowledge proposal requested with title length ${parsed.data.title.length}.`,
            lineage: parsed.data.lineage,
            operation: 'knowledge.proposal',
            outputSummary: `Knowledge proposal ${proposal.id} drafted.`,
            serviceRef: 'knowledge-manager',
            store,
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-knowledge-proposal',
                unit: 'capability_calls',
              },
            ],
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          draft,
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      return asApiError((error as Error).message, 'worker_capability_knowledge_proposal_failed');
    }
  });

  app.post('/api/worker-capabilities/artifacts/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityArtifactReadRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const session = workerControlGateway.authenticateRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const artifact = requestStore(c).getArtifact(session.workspaceId, parsed.data.artifactId);

      return c.json(
        WorkerCapabilityArtifactReadResponseSchema.parse({
          artifact,
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'artifact.read',
            inputSummary: `Artifact read requested for ${parsed.data.artifactId}.`,
            ledgerFamily: 'workspace',
            lineage: parsed.data.lineage,
            operation: 'artifact.read',
            outputSummary: `Artifact ${artifact.id} returned.`,
            serviceRef: 'artifact-store',
            store: requestStore(c),
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-artifact-read',
                unit: 'capability_calls',
              },
            ],
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
        })
      );
    } catch (error) {
      if (error instanceof WorkerControlGatewayError) {
        return asWorkerControlApiError(error);
      }

      recordFailedWorkerCapabilityCall({
        errorCode: 'worker_capability_artifact_not_found',
        family: 'artifact.read',
        ledgerFamily: 'workspace',
        lineage: parsed.data.lineage,
        operation: 'artifact.read',
        serviceRef: 'artifact-store',
        store: requestStore(c),
        summary: `Artifact read failed for ${parsed.data.artifactId}.`,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });
      return asApiError((error as Error).message, 'worker_capability_artifact_not_found', 404);
    }
  });

  app.post('/api/worker-capabilities/mcp/list-servers', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityMcpListServersRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const environmentPackage = workerControlGateway.authenticatePackageRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const servers = listWorkerVisibleMcpServers(environmentPackage, workerMcpGateway);

      return c.json(
        WorkerCapabilityMcpListServersResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'worker_mcp.call',
            inputSummary: 'MCP server list requested.',
            ledgerFamily: 'mcp',
            lineage: parsed.data.lineage,
            operation: 'mcp.list_servers',
            outputSummary: `${servers.length} MCP servers visible.`,
            serviceRef: 'mcp-gateway',
            store: requestStore(c),
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          servers,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/mcp/list-tools', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityMcpListToolsRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const environmentPackage = workerControlGateway.authenticatePackageRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const toolSnapshot = listWorkerVisibleMcpTools(environmentPackage, parsed.data.serverId);
      if (options.coreDb) {
        const workspaceDb = openWorkspaceDb(
          options.coreDb.dataRoot,
          requestStore(c).getUserId(),
          parsed.data.lineage.workspaceId
        );

        try {
          applyScopedMigrations(workspaceDb);
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: toolSnapshot.schemaSnapshotId,
            serverId: parsed.data.serverId,
            tools: toolSnapshot.tools,
            workspaceDb,
            workspaceId: parsed.data.lineage.workspaceId,
          });
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return c.json(
        WorkerCapabilityMcpListToolsResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'worker_mcp.call',
            inputSummary: `MCP tool list requested for ${parsed.data.serverId}.`,
            ledgerFamily: 'mcp',
            lineage: parsed.data.lineage,
            operation: 'mcp.list_tools',
            outputSummary: `${toolSnapshot.tools.length} MCP tools visible.`,
            serviceRef: 'mcp-gateway',
            store: requestStore(c),
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          schemaSnapshotId: toolSnapshot.schemaSnapshotId,
          tools: toolSnapshot.tools,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/mcp/call-tool', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(c, WorkerCapabilityMcpCallToolRequestSchema);

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const environmentPackage = workerControlGateway.authenticatePackageRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });
      const approvalRequired = workerMcpToolRequiresApproval(
        environmentPackage,
        parsed.data.serverId,
        parsed.data.toolName
      );

      if (approvalRequired && !parsed.data.policyDecisionId && !parsed.data.approvalRequestId) {
        const approval = createMcpToolApprovalGate({
          environmentPackage,
          lineage: parsed.data.lineage,
          serverId: parsed.data.serverId,
          store: requestStore(c),
          toolName: parsed.data.toolName,
          ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        });

        return c.json(approval, 202);
      }

      try {
        requireAllowedMcpToolCallPolicyDecision({
          ...(parsed.data.approvalRequestId
            ? { approvalRequestId: parsed.data.approvalRequestId }
            : {}),
          approvalRequired,
          lineage: parsed.data.lineage,
          ...(parsed.data.policyDecisionId
            ? { policyDecisionId: parsed.data.policyDecisionId }
            : {}),
          serverId: parsed.data.serverId,
          store: requestStore(c),
          toolName: parsed.data.toolName,
          ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        });
      } catch (error) {
        if (error instanceof WorkerControlGatewayError) {
          recordDeniedWorkerMcpCapabilityCall({
            error,
            lineage: parsed.data.lineage,
            serverId: parsed.data.serverId,
            store: requestStore(c),
            toolName: parsed.data.toolName,
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          });
        }
        throw error;
      }
      const { capabilityCall, callResult } = await callWorkerVisibleMcpToolWithLedger({
        args: parsed.data.arguments,
        environmentPackage,
        gateway: workerMcpGateway,
        lineage: parsed.data.lineage,
        serverId: parsed.data.serverId,
        store: requestStore(c),
        toolName: parsed.data.toolName,
        vaultUnlockState,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(
        WorkerCapabilityMcpCallToolResponseSchema.parse({
          capabilityCall,
          result: callResult.result,
          schemaSnapshotId: callResult.schemaSnapshotId,
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.post('/api/worker-capabilities/diagnostics/read', async (c) => {
    const parsed = await parseWorkerCapabilityRequest(
      c,
      WorkerCapabilityDiagnosticReadRequestSchema
    );

    if (!parsed.success) {
      return parsed.response;
    }

    try {
      const environmentPackage = workerControlGateway.authenticatePackageRequest({
        authorization: c.req.header('authorization') ?? null,
        lineage: parsed.data.lineage,
      });

      return c.json(
        WorkerCapabilityDiagnosticReadResponseSchema.parse({
          capabilityCall: recordWorkerCapabilityCallSummary({
            family: 'diagnostic.read',
            inputSummary: 'Worker session diagnostics requested.',
            ledgerFamily: 'workspace',
            lineage: parsed.data.lineage,
            operation: 'diagnostic.read',
            outputSummary: 'Worker session diagnostics returned.',
            serviceRef: 'worker-capability-diagnostics',
            store: requestStore(c),
            usageRecords: [
              {
                category: 'tool',
                quantity: 1,
                source: 'worker-capability-diagnostic-read',
                unit: 'capability_calls',
              },
            ],
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          }),
          diagnostics: {
            agentSessionId: environmentPackage.scope.agentSessionId,
            capabilityRouteFamilies: environmentPackage.capabilities.routes.map(
              (route) => route.family
            ),
            mcpServerIds: environmentPackage.supply.mcpServers.map((server) => server.id),
            packageSnapshotId: environmentPackage.snapshotId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            workspaceId: environmentPackage.scope.workspaceId,
          },
        })
      );
    } catch (error) {
      return asWorkerControlApiError(error);
    }
  });

  app.use('/api/*', browserCors);
  app.use('/api/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));

  if (internalFacadeOptions().enabled) {
    app.use('/internal/*', browserCors);

    if (mode === 'server') {
      app.use('/internal/*', createAuthMiddleware(mode, auth, authMiddlewareOptions));
    }

    registerOpenAICompatFacade({
      app,
      llmClient: {
        createChatCompletion: (provider, request) =>
          llmGatewayDispatcher.createChatCompletion(provider, request),
        createChatCompletionStream: (provider, request) =>
          llmGatewayDispatcher.createChatCompletionStream(provider, request),
      },
      options: internalFacadeOptions,
      providerCredentialResolver,
      providerRegistry: () => runtimeConfig().providerRegistry,
    });
  }

  if (auth) {
    app.all('/api/auth/*', (c) => auth.handler(c.req.raw));
  }

  app.post('/api/app/auth/bootstrap/consume', async (c) => {
    if (mode !== 'server') {
      return asApiError('Server bootstrap is only available in server mode.', 'not_found', 404);
    }

    if (!options.coreDb) {
      return asApiError('Server bootstrap storage is unavailable.', 'bootstrap_unavailable', 503);
    }

    const parsed = ConsumeOpenKitBootstrapTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid bootstrap consume request.', 'invalid_request', 400);
    }

    const consumed = consumeServerBootstrapToken(options.coreDb, {
      displayName: parsed.data.displayName,
      ownerUserId: parsed.data.ownerUserId,
      token: parsed.data.token,
      tokenExpiresAt: parsed.data.tokenExpiresAt,
    });

    if (consumed.status !== 'consumed') {
      return consumed.status === 'unavailable'
        ? asApiError('Server bootstrap is unavailable.', 'bootstrap_unavailable', 409)
        : asApiError('Invalid bootstrap token.', 'bootstrap_invalid', 401);
    }

    recordAccessTokenLifecycleAuditEvent(
      options.coreDb,
      'auth.bootstrap.consume',
      consumed.record,
      null
    );

    return c.json(
      ConsumeOpenKitBootstrapTokenResponseSchema.parse({
        record: consumed.record,
        token: consumed.secret,
      }),
      201
    );
  });

  app.get('/api/app/auth/tokens', (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    return c.json(
      ListOpenKitAccessTokensResponseSchema.parse({
        items: listOpenKitAccessTokenRecords(options.coreDb!),
      })
    );
  });

  app.post('/api/app/auth/tokens', async (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = CreateOpenKitAccessTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid access-token issue request.', 'invalid_request', 400);
    }

    try {
      const ownerUserId = c.get('actor')?.userId ?? 'user_local';
      if (
        parsed.data.scope !== 'server-admin' &&
        parsed.data.workspaceIds.some(
          (workspaceId) => !isActiveWorkspaceMember(ownerUserId, workspaceId)
        )
      ) {
        return asApiError(
          'Access token scope does not allow this request.',
          'core.auth.scope_forbidden',
          403
        );
      }

      const issued = createOpenKitAccessTokenRecord(options.coreDb!, {
        expiresAt: parsed.data.expiresAt,
        ownerUserId,
        scope: parsed.data.scope,
        workspaceIds: parsed.data.workspaceIds,
      });
      recordAccessTokenLifecycleAuditEvent(
        options.coreDb!,
        'auth.token.issue',
        issued.record,
        c.get('actor')?.userId ?? null
      );

      return c.json(
        CreateOpenKitAccessTokenResponseSchema.parse({
          record: issued.record,
          token: issued.secret,
        }),
        201
      );
    } catch (error) {
      return asApiError((error as Error).message, 'access_token_issue_failed', 400);
    }
  });

  app.post('/api/app/auth/tokens/:tokenId/revoke', (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const record = revokeOpenKitAccessTokenRecord(options.coreDb!, c.req.param('tokenId'));
    if (!record) {
      return asApiError('Access token not found.', 'access_token_not_found', 404);
    }

    recordAccessTokenLifecycleAuditEvent(
      options.coreDb!,
      'auth.token.revoke',
      record,
      c.get('actor')?.userId ?? null
    );

    return c.json(RevokeOpenKitAccessTokenResponseSchema.parse({ record }));
  });

  app.post('/api/app/auth/tokens/:tokenId/rotate', async (c) => {
    const adminError = requireAccessTokenAdmin(c);
    if (adminError) {
      return adminError;
    }

    const parsed = RotateOpenKitAccessTokenRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asApiError('Invalid access-token rotation request.', 'invalid_request', 400);
    }

    const rotated = rotateOpenKitAccessTokenRecord(options.coreDb!, c.req.param('tokenId'), {
      graceSeconds: parsed.data.graceSeconds,
    });
    if (!rotated) {
      return asApiError('Access token not found or not rotatable.', 'access_token_not_found', 404);
    }

    recordAccessTokenLifecycleAuditEvent(
      options.coreDb!,
      'auth.token.rotate',
      rotated.record,
      c.get('actor')?.userId ?? null
    );

    return c.json(
      RotateOpenKitAccessTokenResponseSchema.parse({
        record: rotated.record,
        rotatedRecord: rotated.rotatedRecord,
        token: rotated.secret,
      })
    );
  });

  app.get('/api/meta', (c) => {
    if (mode === 'server') {
      return c.json(
        MetaResponseSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [],
          eventFamilies: [],
        })
      );
    }

    const body = MetaResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: mapRuntimeCapabilitiesToFlags(turnExecutor.capabilities),
      eventFamilies: [...turnExecutor.eventFamilies],
      itemTypes: [...(turnExecutor.itemTypes ?? [])],
      itemDeltaKinds: [...(turnExecutor.itemDeltaKinds ?? [])],
    });

    return c.json(body);
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'nanocore',
    })
  );

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      service: 'nanocore',
    })
  );

  app.get('/api/app/vault/status', (c) => c.json(vaultAdminStatus()));

  app.post('/api/app/vault/unlock', async (c) => {
    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }

    if (isVaultUnlockRateLimited(c)) {
      recordVaultAdminAudit(c, {
        action: 'vault.unlock',
        errorCode: 'vault_unlock_rate_limited',
        outcome: 'denied',
        summary: 'Vault unlock denied because recent failed attempts exceeded the limit.',
      });

      return asApiError('Vault unlock rate limit exceeded.', 'vault_unlock_rate_limited', 429);
    }

    const parsed = VaultAdminUnlockRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      unlockState.unlock({
        masterKey: Buffer.from(parsed.data.masterKeyBase64, 'base64'),
      });
      clearVaultUnlockFailures(c);
      recordVaultAdminAudit(c, {
        action: 'vault.unlock',
        outcome: 'succeeded',
        summary: 'Vault unlock succeeded.',
      });

      return c.json(VaultAdminUnlockResponseSchema.parse(vaultAdminStatus()));
    } catch {
      rememberVaultUnlockFailure(c);
      recordVaultAdminAudit(c, {
        action: 'vault.unlock',
        errorCode: 'vault_unlock_failed',
        outcome: 'failed',
        summary: 'Vault unlock failed.',
      });

      return asApiError('Vault unlock failed.', 'vault_unlock_failed', 400);
    }
  });

  app.post('/api/app/vault/bootstrap/codex-auth-json', async (c) => {
    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }
    if (!options.coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const parsed = VaultAdminBootstrapCodexAuthJsonRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const backend = unlockState.backend();
    const health = backend.health();

    if (health.state !== 'available') {
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        errorCode: 'vault_backend_not_available',
        outcome: 'failed',
        summary: 'Codex auth JSON bootstrap failed because the vault backend is not available.',
      });

      return asApiError('Vault backend is not available.', 'vault_backend_not_available', 423);
    }
    if (getVaultReference(options.coreDb, CODEX_AUTH_JSON_VAULT_REFERENCE_ID)) {
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        errorCode: 'vault_codex_auth_json_exists',
        outcome: 'failed',
        summary: 'Codex auth JSON bootstrap failed because the vault reference already exists.',
      });

      return asApiError(
        'Codex auth JSON vault reference already exists.',
        'vault_codex_auth_json_exists',
        409
      );
    }

    try {
      const authJson = Buffer.from(parsed.data.authJsonBase64, 'base64').toString('utf8');
      const decoded = JSON.parse(authJson) as unknown;

      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('Codex auth JSON must decode to a JSON object.');
      }

      backend.store({
        material: authJson,
        metadata: { ownerScope: 'server' },
        referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
      });
      createVaultReference(options.coreDb, {
        backendKind: backend.kind,
        backendLocator: `${backend.kind}://server/vault/${CODEX_AUTH_JSON_VAULT_REFERENCE_ID}`,
        displayName: 'Codex auth JSON',
        ownerScope: 'server',
        referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
        secretKind: 'codex-auth-json',
      });
      createVaultGrant(options.coreDb, {
        allowedInjectionPaths: ['runtime-file'],
        expiresAt: parsed.data.expiresAt ?? null,
        grantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
        lifetime: 'agent-session',
        ownerScope: 'server',
        subjectSummary: 'Codex auth JSON runtime-file injection',
        vaultReferenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
      });
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        outcome: 'succeeded',
        summary: 'Codex auth JSON bootstrap succeeded.',
      });

      return c.json(
        VaultAdminBootstrapCodexAuthJsonResponseSchema.parse({
          backendKind: backend.kind,
          expiresAt: parsed.data.expiresAt ?? null,
          grantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
          grantScope: 'agent-session',
          referenceId: CODEX_AUTH_JSON_VAULT_REFERENCE_ID,
          secretKind: 'codex-auth-json',
          targetPath: CODEX_AUTH_JSON_TARGET_PATH,
        })
      );
    } catch {
      recordVaultAdminAudit(c, {
        action: 'vault.bootstrap_codex_auth_json',
        errorCode: 'vault_codex_auth_json_bootstrap_failed',
        outcome: 'failed',
        summary: 'Codex auth JSON bootstrap failed.',
      });

      return asApiError(
        'Codex auth JSON bootstrap failed.',
        'vault_codex_auth_json_bootstrap_failed',
        400
      );
    }
  });

  app.post('/api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind', async (c) => {
    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }
    if (!options.coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const referenceId = c.req.param('referenceId');
    const parsed = VaultAdminRebindWorkspaceReferenceRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const reference = getVaultReference(options.coreDb, referenceId);

    if (
      !reference ||
      reference.ownerScope !== 'workspace' ||
      reference.workspaceId !== workspaceId
    ) {
      return asApiError('Workspace vault reference not found.', 'vault_reference_not_found', 404);
    }
    if (reference.status !== 'unbound') {
      return asApiError(
        'Workspace vault reference is not unbound.',
        'vault_reference_not_unbound',
        409
      );
    }

    const backend = unlockState.backend();
    const health = backend.health();

    if (health.state !== 'available') {
      recordVaultAdminAudit(c, {
        action: 'vault.rebind_workspace_reference',
        errorCode: 'vault_backend_not_available',
        outcome: 'failed',
        summary:
          'Workspace vault reference rebind failed because the vault backend is not available.',
      });

      return asApiError('Vault backend is not available.', 'vault_backend_not_available', 423);
    }

    try {
      const inventory = backend.store({
        material: Buffer.from(parsed.data.materialBase64, 'base64'),
        metadata: { ownerScope: 'workspace', workspaceId },
        referenceId,
      });
      const rebound = rebindWorkspaceVaultReference(options.coreDb, {
        backendKind: backend.kind,
        backendLocator: `${backend.kind}://workspace/${workspaceId}/vault/${referenceId}`,
        currentVersion: inventory.currentVersion,
        referenceId,
        workspaceId,
      });

      recordVaultAdminAudit(c, {
        action: 'vault.rebind_workspace_reference',
        outcome: 'succeeded',
        summary: 'Workspace vault reference rebind succeeded.',
      });

      return c.json(
        VaultAdminRebindWorkspaceReferenceResponseSchema.parse({
          backendKind: rebound.backendKind,
          currentVersion: rebound.currentVersion,
          ownerScope: rebound.ownerScope,
          referenceId: rebound.referenceId,
          secretKind: rebound.secretKind,
          status: rebound.status,
          workspaceId: rebound.workspaceId,
        })
      );
    } catch {
      recordVaultAdminAudit(c, {
        action: 'vault.rebind_workspace_reference',
        errorCode: 'vault_reference_rebind_failed',
        outcome: 'failed',
        summary: 'Workspace vault reference rebind failed.',
      });

      return asApiError(
        'Workspace vault reference rebind failed.',
        'vault_reference_rebind_failed',
        400
      );
    }
  });

  app.get('/api/app/workspaces/:workspaceId/vault/references', (c) => {
    if (!options.coreDb) {
      return asApiError('Vault storage is not configured.', 'vault_storage_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const items = listWorkspaceVaultReferences(options.coreDb, workspaceId).map((reference) => ({
      backendKind: reference.backendKind,
      currentVersion: reference.currentVersion,
      ownerScope: reference.ownerScope,
      referenceId: reference.referenceId,
      secretKind: reference.secretKind,
      status: reference.status,
      workspaceId: reference.workspaceId,
    }));

    return c.json(
      VaultAdminListWorkspaceReferencesResponseSchema.parse({
        items,
        workspaceId,
      })
    );
  });

  app.get('/api/app/workspaces/:workspaceId/vault/use-records', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspaceVaultUseRecordsResponseSchema.parse({
            workspaceId,
            vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/app/vault/lock', (c) => {
    const unlockState = vaultUnlockState;

    if (!unlockState) {
      return vaultAdminUnavailableError();
    }

    unlockState.lock();
    recordVaultAdminAudit(c, {
      action: 'vault.lock',
      outcome: 'succeeded',
      summary: 'Vault lock succeeded.',
    });

    return c.json(VaultAdminLockResponseSchema.parse(vaultAdminStatus()));
  });

  app.get('/api/app/oauth/openai-codex/accounts', async (c) =>
    c.json(CodexOAuthAccountsPayloadSchema.parse(await codexOAuthAccountManager.listAccounts()))
  );

  app.post('/api/app/oauth/openai-codex/accounts', async (c) => {
    const parsed = CodexOAuthAccountCreateRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(
        CodexOAuthAccountSummarySchema.parse(
          await codexOAuthAccountManager.createAccount({
            accountSlotId: parsed.data.accountSlotId,
            ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
          })
        )
      );
    } catch (error) {
      const apiError = codexOAuthAccountCreateError(error);

      return asApiError(apiError.message, apiError.code, apiError.status);
    }
  });

  app.patch('/api/app/oauth/openai-codex/accounts/:accountSlotId', async (c) => {
    const parsed = CodexOAuthAccountUpdateRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(
        CodexOAuthAccountSummarySchema.parse(
          await codexOAuthAccountManager.updateAccount(c.req.param('accountSlotId'), parsed.data)
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'codex_oauth_account_update_failed', 400);
    }
  });

  app.delete('/api/app/oauth/openai-codex/accounts/:accountSlotId', async (c) => {
    try {
      await codexOAuthAccountManager.deleteAccount(c.req.param('accountSlotId'));
      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'codex_oauth_account_delete_failed', 400);
    }
  });

  app.get('/api/app/oauth/openai-codex/accounts/:accountSlotId/status', async (c) =>
    c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.getStatus(c.req.param('accountSlotId'))
      )
    )
  );

  app.get('/api/diagnostics', (c) =>
    c.json(
      createDiagnosticsSnapshot({
        actor: c.get('actor'),
        dataRoot,
        mode,
        providerRegistry: runtimeConfig().providerRegistry,
        agentManifests: runtimeConfig().agentManifests,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      })
    )
  );

  app.post('/api/app/oauth/openai-codex/accounts/:accountSlotId/start', async (c) => {
    const parsed = CodexOAuthStartRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.start(
          c.req.param('accountSlotId'),
          parsed.data.mode ?? 'browser'
        )
      )
    );
  });

  app.post('/api/app/oauth/openai-codex/accounts/:accountSlotId/cancel', async (c) => {
    const parsed = CodexOAuthCancelRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.cancel(c.req.param('accountSlotId'), parsed.data.loginId)
      )
    );
  });

  app.post('/api/app/oauth/openai-codex/accounts/:accountSlotId/logout', async (c) =>
    c.json(
      CodexOAuthStatusPayloadSchema.parse(
        await codexOAuthAccountManager.logout(c.req.param('accountSlotId'))
      )
    )
  );

  app.get('/api/app/diagnostics', async (c) => {
    const openaiCodexAccounts = await codexOAuthAccountManager.listAccounts();

    return c.json(
      AppDiagnosticsResponseSchema.parse({
        service: 'nanocore',
        boot: getBootReadiness(),
        gateway: {
          status: 'ok',
          endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
          usage: gatewayUsageTracker.snapshot(),
        },
        providers: {
          diagnostics: runtimeConfig().providerDiagnostics.summaries,
          registry: runtimeConfig().providerRegistry.summarize(),
        },
        defaultProviders: resolveDefaultProviderStates(
          runtimeConfig().openKitConfig,
          runtimeConfig().providerRegistry,
          providerCredentialResolver
        ),
        defaults: diagnosticsProviderDefaults(),
        oauth: {
          openaiCodexAccounts,
        },
        // Diagnostics mirrors protocol-visible capabilities for one consistent app surface.
        capabilities: mapRuntimeCapabilitiesToFlags(turnExecutor.capabilities),
        runtimeConfig: runtimeConfigManager.status(
          staleRuntimeConfigSessions(
            turnExecutor,
            requestStore(c),
            runtimeConfig().version,
            workerControlGateway
          )
        ),
        internalAgents: getInternalAgentRunner().getDiagnostics(),
      })
    );
  });

  app.get('/api/setup/diagnostics', (c) =>
    c.json(
      SetupDiagnosticsResponseSchema.parse(
        createSetupDiagnostics({
          dataRoot,
          mode,
          openKitConfig: runtimeConfig().openKitConfig,
          providerRegistry: runtimeConfig().providerRegistry,
          providerCredentialResolver,
          agentConfigs: runtimeConfig().agentConfigs,
          agentManifests: runtimeConfig().agentManifests,
          runtimeConfig: runtimeConfigManager.status(
            staleRuntimeConfigSessions(
              turnExecutor,
              requestStore(c),
              runtimeConfig().version,
              workerControlGateway
            )
          ),
        })
      )
    )
  );

  app.get('/api/app/storage/layout-report', (c) => {
    if (!dataRoot) {
      return asApiError('Storage layout report is unavailable.', 'storage_layout_unavailable', 503);
    }

    return c.json(StorageLayoutReportResponseSchema.parse(createStorageLayoutReport(dataRoot)));
  });

  app.post('/api/app/data-root/backups', async (c) => {
    if (!dataRoot) {
      return asApiError('Data-root backup is unavailable.', 'data_root_backup_unavailable', 503);
    }

    const backupId = `drb_${randomUUID()}`;

    try {
      const verified = await writeHotDataRootBackup({
        dataRoot,
        backupRoot: dataRootBackupRoot(dataRoot, backupId),
        backupId,
        sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      return c.json(DataRootBackupCreateResponseSchema.parse(dataRootBackupResponse(verified)));
    } catch (error) {
      return asApiError(
        error instanceof Error ? error.message : String(error),
        'data_root_backup_failed',
        400
      );
    }
  });

  app.post('/api/app/data-root/backups/:backupId/verify', (c) => {
    if (!dataRoot) {
      return asApiError(
        'Data-root backup verification is unavailable.',
        'data_root_backup_unavailable',
        503
      );
    }

    const parsed = DataRootBackupVerifyRequestSchema.safeParse({
      backupId: c.req.param('backupId'),
    });
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const verified = verifyDataRootBackupManifest({
        backupRoot: dataRootBackupRoot(dataRoot, parsed.data.backupId),
      });

      return c.json(DataRootBackupVerifyResponseSchema.parse(dataRootBackupResponse(verified)));
    } catch (error) {
      return asApiError(
        error instanceof Error ? error.message : String(error),
        'data_root_backup_verify_failed',
        400
      );
    }
  });

  app.post('/api/app/workspaces/:workspaceId/export', (c) => {
    if (!dataRoot) {
      return asApiError('Workspace export is unavailable.', 'workspace_export_unavailable', 503);
    }

    const workspaceId = c.req.param('workspaceId');
    const store = requestStore(c);
    const workspace = store.getWorkspace(workspaceId);
    const threads = store.listThreads(workspaceId);
    const dataSourceCatalogPath = join(
      dataRoot,
      'users',
      store.getUserId(),
      'workspaces',
      workspaceId,
      'config',
      'data-sources.jsonc'
    );
    const dataSourceCatalog = existsSync(dataSourceCatalogPath)
      ? parseWorkspaceDataSourceCatalog(
          parseJsoncObject(readFileSync(dataSourceCatalogPath, 'utf8'), dataSourceCatalogPath)
        )
      : null;
    const workspaceRowFamilies = options.coreDb
      ? (() => {
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

          try {
            const workspaceSyncRecords = listExportableWorkspaceSyncRecords(
              workspaceDb,
              workspaceId
            );

            return {
              auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
              agentEnvironmentPackageSnapshots: listExportableAgentEnvironmentPackageSnapshots(
                workspaceDb,
                workspaceId
              ),
              capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
              evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
              gitPushRecords: listExportableGitPushRecords(workspaceDb, workspaceId),
              goalRecords: listExportableGoalRecords(workspaceDb, workspaceId),
              goalReviewRecords: listExportableGoalReviewRecords(workspaceDb, workspaceId),
              goalTasks: listExportableGoalTasks(workspaceDb, workspaceId),
              goalVerificationRecords: listExportableGoalVerificationRecords(
                workspaceDb,
                workspaceId
              ),
              mcpToolSchemaSnapshots: listExportableMcpToolSchemaSnapshots(
                workspaceDb,
                workspaceId
              ),
              pendingUserTurns: listExportablePendingUserTurns(workspaceDb, workspaceId),
              permissionDecisions: listExportableWorkspacePermissionDecisions(
                workspaceDb,
                workspaceId
              ),
              resolvedAgentSetups: listExportableResolvedAgentSetups(workspaceDb, workspaceId),
              runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
              usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId),
              vaultUseRecords: listExportableWorkspaceVaultUseRecords(workspaceDb, workspaceId),
              workerCheckpoints: listExportableWorkerCheckpoints(workspaceDb, workspaceId),
              workspaceApplyPlans: listExportableWorkspaceApplyPlans(workspaceDb, workspaceId),
              workspaceApplyResults: listExportableWorkspaceApplyResults(workspaceDb, workspaceId),
              workspaceReconciliationRecords: listExportableWorkspaceReconciliationRecords(
                workspaceDb,
                workspaceId
              ),
              workspaceQuarantineRecords: listExportableWorkspaceQuarantineRecords(
                workspaceDb,
                workspaceId
              ),
              workspaceSyncEvidenceBundles: listExportableWorkspaceSyncEvidenceBundles(
                workspaceDb,
                workspaceId
              ),
              workspaceRepositories: listExportableWorkspaceRepositoryResources(
                workspaceDb,
                workspaceId
              ),
              workspaceSyncRecords,
            };
          } finally {
            workspaceDb.sqlite.close();
          }
        })()
      : {
          auditEvents: [],
          agentEnvironmentPackageSnapshots: [],
          capabilityCalls: [],
          evidenceBundles: [],
          gitPushRecords: [],
          goalRecords: [],
          goalReviewRecords: [],
          goalTasks: [],
          goalVerificationRecords: [],
          mcpToolSchemaSnapshots: [],
          pendingUserTurns: [],
          permissionDecisions: [],
          resolvedAgentSetups: [],
          runtimeEvidence: [],
          usageRecords: [],
          vaultUseRecords: [],
          workerCheckpoints: [],
          workspaceApplyPlans: [],
          workspaceApplyResults: [],
          workspaceReconciliationRecords: [],
          workspaceQuarantineRecords: [],
          workspaceSyncEvidenceBundles: [],
          workspaceRepositories: [],
          workspaceSyncRecords: {
            backendWorkspaceHandles: [],
            changeSets: [],
            inputSnapshots: [],
            materializationRecords: [],
            stagedReviews: [],
            workerOutputManifests: [],
          },
        };
    const workspaceVaultGrants = options.coreDb
      ? listExportableWorkspaceVaultGrants(options.coreDb, workspaceId)
      : [];
    const workspaceInjectionPlans = options.coreDb
      ? listExportableInjectionPlans(
          options.coreDb,
          workspaceVaultGrants.map((grant) => grant.grantId)
        )
      : [];
    const exportId = `wsexp_${randomUUID()}`;
    const exported = writeWorkspaceExportTree({
      exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', workspaceId, exportId),
      exportId,
      sourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      createdAt: new Date().toISOString(),
      workspace,
      threads,
      knowledge: store.listKnowledge(workspaceId),
      knowledgeProposalReviews: store.listKnowledgeProposalReviewDecisions(workspaceId),
      knowledgeProposals: store.listKnowledgeProposals(workspaceId),
      knowledgeSources: store.listKnowledgeSources(workspaceId),
      knowledgeSourceMaterials: store.listKnowledgeSourceMaterials(workspaceId),
      threadItems: threads.flatMap((thread) => store.listThreadItems(workspaceId, thread.id)),
      ...(dataSourceCatalog ? { dataSourceCatalog } : {}),
      auditEvents: workspaceRowFamilies.auditEvents,
      agentEnvironmentPackageSnapshots: workspaceRowFamilies.agentEnvironmentPackageSnapshots,
      capabilityCalls: workspaceRowFamilies.capabilityCalls,
      evidenceBundles: workspaceRowFamilies.evidenceBundles,
      gitPushRecords: workspaceRowFamilies.gitPushRecords,
      goalRecords: workspaceRowFamilies.goalRecords,
      goalReviewRecords: workspaceRowFamilies.goalReviewRecords,
      goalTasks: workspaceRowFamilies.goalTasks,
      goalVerificationRecords: workspaceRowFamilies.goalVerificationRecords,
      injectionPlans: workspaceInjectionPlans,
      injectionReceipts: options.coreDb
        ? listExportableInjectionReceipts(
            options.coreDb,
            workspaceInjectionPlans.map((plan) => plan.planId)
          )
        : [],
      mcpToolSchemaSnapshots: workspaceRowFamilies.mcpToolSchemaSnapshots,
      pendingUserTurns: workspaceRowFamilies.pendingUserTurns,
      permissionDecisions: workspaceRowFamilies.permissionDecisions,
      resolvedAgentSetups: workspaceRowFamilies.resolvedAgentSetups,
      runtimeEvidence: workspaceRowFamilies.runtimeEvidence,
      stagedWorkspaceReviews: workspaceRowFamilies.workspaceSyncRecords.stagedReviews,
      usageRecords: workspaceRowFamilies.usageRecords,
      vaultUseRecords: workspaceRowFamilies.vaultUseRecords,
      workerCheckpoints: workspaceRowFamilies.workerCheckpoints,
      workspaceApplyPlans: workspaceRowFamilies.workspaceApplyPlans,
      workspaceApplyResults: workspaceRowFamilies.workspaceApplyResults,
      workspaceReconciliationRecords: workspaceRowFamilies.workspaceReconciliationRecords,
      workspaceQuarantineRecords: workspaceRowFamilies.workspaceQuarantineRecords,
      workspaceSyncEvidenceBundles: workspaceRowFamilies.workspaceSyncEvidenceBundles,
      backendWorkspaceHandles: workspaceRowFamilies.workspaceSyncRecords.backendWorkspaceHandles,
      workerOutputManifests: workspaceRowFamilies.workspaceSyncRecords.workerOutputManifests,
      workspaceChangeSets: workspaceRowFamilies.workspaceSyncRecords.changeSets,
      workspaceInputSnapshots: workspaceRowFamilies.workspaceSyncRecords.inputSnapshots,
      workspaceMaterializationRecords:
        workspaceRowFamilies.workspaceSyncRecords.materializationRecords,
      workspaceRepositories: workspaceRowFamilies.workspaceRepositories,
      vaultGrants: workspaceVaultGrants,
      vaultReferences: options.coreDb
        ? listWorkspaceVaultReferences(options.coreDb, workspaceId).map((reference) => ({
            sourceReferenceId: reference.referenceId,
            displayName: reference.displayName,
            secretKind: reference.secretKind,
            backendKind: reference.backendKind,
            createdAt: reference.createdAt,
            updatedAt: reference.updatedAt,
          }))
        : [],
    });
    const fileCount = exported.checkedFiles.length;
    const totalBytes = exported.manifest.contentInventory.reduce(
      (total, entry) => total + entry.bytes,
      0
    );

    if (options.coreDb) {
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      const now = new Date();

      try {
        const call = startCapabilityCall({
          workspaceDb,
          callId: `cap_storage_export_${exportId}`,
          workspaceId,
          family: 'storage',
          operation: 'workspace.export.write',
          capabilityId: 'storage.workspace_export',
          providerRef: 'nanocore-storage',
          serviceRef: 'workspace-export',
          redactionClass: 'metadata-only',
          summary: `Workspace export ${exportId}`,
          now,
        });
        recordUsage({
          workspaceDb,
          call,
          records: [
            {
              usageId: `use_storage_export_files_${exportId}`,
              category: 'storage',
              unit: 'files',
              quantity: fileCount,
              providerRef: 'nanocore-storage',
              source: 'workspace-export-inventory',
            },
            {
              usageId: `use_storage_export_bytes_${exportId}`,
              category: 'storage',
              unit: 'bytes',
              quantity: totalBytes,
              providerRef: 'nanocore-storage',
              source: 'workspace-export-inventory',
            },
          ],
          now,
        });
        finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded', now });
      } finally {
        workspaceDb.sqlite.close();
      }
    }

    return c.json(
      WorkspaceExportResponseSchema.parse({
        exportId: exported.manifest.id,
        workspaceId,
        manifest: exported.manifest,
        fileCount,
        totalBytes,
        checkedFiles: exported.checkedFiles,
      })
    );
  });

  app.post('/api/app/workspace-imports/dry-run', async (c) => {
    if (!dataRoot) {
      return asApiError(
        'Workspace import dry-run is unavailable.',
        'workspace_import_unavailable',
        503
      );
    }

    const parsed = WorkspaceImportDryRunRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const report = dryRunWorkspaceImport({
        exportRoot: join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          parsed.data.sourceWorkspaceId,
          parsed.data.exportId
        ),
        workspaceExists: (workspaceId) => {
          try {
            requestStore(c).getWorkspace(workspaceId);
            return true;
          } catch {
            return false;
          }
        },
      });

      return c.json(WorkspaceImportDryRunResponseSchema.parse(report));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asApiError(message, 'workspace_import_dry_run_failed', 400);
    }
  });

  app.post('/api/app/workspace-imports', async (c) => {
    if (!dataRoot) {
      return asApiError('Workspace import is unavailable.', 'workspace_import_unavailable', 503);
    }

    const parsed = WorkspaceImportRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const store = requestStore(c);
    const workspaceExists = (workspaceId: string) => {
      try {
        store.getWorkspace(workspaceId);
        return true;
      } catch {
        return false;
      }
    };
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      parsed.data.sourceWorkspaceId,
      parsed.data.exportId
    );

    try {
      const report = dryRunWorkspaceImport({ exportRoot, workspaceExists });
      const importedWorkspaceId =
        report.collision.status === 'available'
          ? report.collision.workspaceId
          : nextImportedWorkspaceId(report.collision.suggestedWorkspaceId, workspaceExists);
      const snapshot = readWorkspaceImportSnapshot({
        exportRoot,
        targetWorkspaceId: importedWorkspaceId,
      });
      const importCoreDb = options.coreDb;
      const stageWorkspace = importCoreDb
        ? ({ workspaceRoot }: ImportWorkspaceStage) => {
            if (snapshot.dataSourceCatalog) {
              const catalogRoot = join(workspaceRoot, 'config');
              mkdirSync(catalogRoot, { recursive: true });
              writeFileSync(
                join(catalogRoot, 'data-sources.jsonc'),
                `${JSON.stringify(snapshot.dataSourceCatalog, null, 2)}\n`
              );
            }

            const workspaceDb = openWorkspaceDbAtRoot({
              dataRoot: importCoreDb.dataRoot,
              userId: store.getUserId(),
              workspaceId: importedWorkspaceId,
              workspaceRoot,
            });

            try {
              applyScopedMigrations(workspaceDb);
              importWorkspaceCapabilityUsageLedger({
                workspaceDb,
                capabilityCalls: snapshot.capabilityCalls,
                usageRecords: snapshot.usageRecords,
              });
              importWorkspaceAuditEvents({
                workspaceDb,
                sourceWorkspaceId: report.exportedWorkspaceId,
                targetWorkspaceId: importedWorkspaceId,
                events: snapshot.auditEvents,
              });
              importWorkspaceEvidenceBundles(workspaceDb, snapshot.evidenceBundles);
              importWorkspaceRuntimeEvidence(workspaceDb, snapshot.runtimeEvidence);
              importWorkspaceRepositoryResources(
                workspaceDb,
                importedWorkspaceId,
                snapshot.workspaceRepositories
              );
              importWorkspaceSyncRecords(workspaceDb, {
                backendWorkspaceHandles: snapshot.backendWorkspaceHandles,
                changeSets: snapshot.workspaceChangeSets,
                inputSnapshots: snapshot.workspaceInputSnapshots,
                materializationRecords: snapshot.workspaceMaterializationRecords,
                stagedReviews: snapshot.stagedWorkspaceReviews,
                workerOutputManifests: snapshot.workerOutputManifests,
              });
              importWorkspaceApplyPlans(workspaceDb, snapshot.workspaceApplyPlans);
              importWorkspaceApplyResults(workspaceDb, snapshot.workspaceApplyResults);
              importWorkspaceReconciliationRecords(
                workspaceDb,
                snapshot.workspaceReconciliationRecords
              );
              importWorkspaceQuarantineRecords(workspaceDb, snapshot.workspaceQuarantineRecords);
              importWorkspaceSyncEvidenceBundles(
                workspaceDb,
                snapshot.workspaceSyncEvidenceBundles
              );
              importWorkspacePermissionDecisions(workspaceDb, snapshot.permissionDecisions);
              importGoalRecords(workspaceDb, snapshot.goalRecords);
              importGoalTasks(workspaceDb, snapshot.goalTasks);
              importGoalReviewRecords(workspaceDb, snapshot.goalReviewRecords);
              importGoalVerificationRecords(workspaceDb, snapshot.goalVerificationRecords);
              importMcpToolSchemaSnapshots(workspaceDb, snapshot.mcpToolSchemaSnapshots);
              importPendingUserTurns(workspaceDb, snapshot.pendingUserTurns);
              importResolvedAgentSetups(workspaceDb, snapshot.resolvedAgentSetups);
              importWorkspaceVaultUseRecords(workspaceDb, snapshot.vaultUseRecords);
              importWorkerCheckpoints(workspaceDb, snapshot.workerCheckpoints);
              importWorkspaceGitPushRecords(workspaceDb, snapshot.gitPushRecords);
              importAgentEnvironmentPackageSnapshots(
                workspaceDb,
                snapshot.agentEnvironmentPackageSnapshots
              );
              recordWorkspaceAuditEvent({
                workspaceDb,
                workspaceId: importedWorkspaceId,
                requestId: parsed.data.requestId ?? null,
                category: 'system',
                action: 'workspace.import',
                resource: `workspace:${importedWorkspaceId}`,
                outcome: 'succeeded',
                severity: 'info',
                summary: `Workspace import created ${importedWorkspaceId} from ${report.exportedWorkspaceId}.`,
              });
              const now = new Date();
              const storageImportId = randomUUID();
              const call = startCapabilityCall({
                workspaceDb,
                callId: `cap_storage_import_${storageImportId}`,
                workspaceId: importedWorkspaceId,
                requestId: parsed.data.requestId ?? null,
                family: 'storage',
                operation: 'workspace.import.write',
                capabilityId: 'storage.workspace_import',
                providerRef: 'nanocore-storage',
                serviceRef: 'workspace-import',
                redactionClass: 'metadata-only',
                summary: `Workspace import ${importedWorkspaceId}`,
                now,
              });
              recordUsage({
                workspaceDb,
                call,
                records: [
                  {
                    usageId: `use_storage_import_files_${storageImportId}`,
                    category: 'storage',
                    unit: 'files',
                    quantity: report.verification.fileCount,
                    providerRef: 'nanocore-storage',
                    source: 'workspace-import-inventory',
                  },
                  {
                    usageId: `use_storage_import_bytes_${storageImportId}`,
                    category: 'storage',
                    unit: 'bytes',
                    quantity: report.verification.totalBytes,
                    providerRef: 'nanocore-storage',
                    source: 'workspace-import-inventory',
                  },
                ],
                now,
              });
              finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded', now });
            } finally {
              workspaceDb.sqlite.close();
            }
          }
        : undefined;
      const workspace = store.importWorkspaceSnapshot({
        ...snapshot,
        ...(stageWorkspace ? { stageWorkspace } : {}),
      });

      if (importCoreDb) {
        for (const reference of snapshot.vaultReferences) {
          importUnboundWorkspaceVaultReference(importCoreDb, reference);
        }
        importWorkspaceVaultGrants(importCoreDb, snapshot.vaultGrants);
        importInjectionPlans(importCoreDb, snapshot.injectionPlans);
        importInjectionReceipts(importCoreDb, snapshot.injectionReceipts);
      }

      return c.json(
        WorkspaceImportResponseSchema.parse({
          ...report,
          mode: 'imported',
          requestId: parsed.data.requestId ?? null,
          importedWorkspaceId: workspace.id,
          workspace,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asApiError(message, 'workspace_import_failed', 400);
    }
  });

  app.get('/api/openapi.json', (c) => c.json(createAppOpenApiDocument()));

  app.post('/api/admin/config/reload', async (c) => {
    const parsed = RuntimeConfigReloadRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    return c.json(runtimeConfigManager.reload(parsed.data));
  });

  app.get('/api/admin/config/files', (c) => {
    try {
      return c.json(runtimeConfigFileService(c).listFiles());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.get('/api/admin/config/file', (c) => {
    const id = c.req.query('id');

    if (!id) {
      return asApiError('Runtime config file id is required.', 'missing_config_file_id', 400);
    }

    try {
      return c.json(runtimeConfigFileService(c).readFile(id));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.post('/api/admin/config/file', async (c) => {
    const parsed = RuntimeConfigFileWriteRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).createFile(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.put('/api/admin/config/file', async (c) => {
    const parsed = RuntimeConfigFileWriteRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).updateFile(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.get('/api/admin/config/schemas', (c) => {
    try {
      return c.json(runtimeConfigFileService(c).schemaCatalog());
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.post('/api/admin/config/validate', async (c) => {
    const parsed = RuntimeConfigValidationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      return c.json(runtimeConfigFileService(c).validate(parsed.data));
    } catch (error) {
      return asRuntimeConfigFileError(error);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/runtime-config/stale-sessions/:sessionId/restart',
    (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const sessionId = c.req.param('sessionId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);

        const session = findStoredAgentSessionById(store, workspaceId, sessionId);

        if (!session) {
          return c.json(
            RestartRuntimeConfigStaleSessionResponseSchema.parse({
              restarted: false,
              session: null,
            })
          );
        }

        const updated = store.updateAgentSession(sessionId, {
          configVersion: runtimeConfig().version,
          message: 'Runtime config stale session retired; start a new worker session.',
          stale: false,
          status: 'interrupted',
        });

        return c.json(
          RestartRuntimeConfigStaleSessionResponseSchema.parse({
            restarted: true,
            session: {
              id: updated.id,
              status: updated.status,
              message: updated.message,
              configVersion: updated.configVersion,
              workspaceRoots: updated.workspaceRoots,
              stale: false,
              sandboxSummary: updated.sandboxSummary,
            },
          })
        );
      } catch (error) {
        return asApiError((error as Error).message, 'runtime_config_stale_session_restart_failed');
      }
    }
  );

  app.get('/v1/models', async (c) => {
    const models: Record<string, unknown>[] = [];
    const runtimeProviders = runtimeConfig().providerRegistry.list();

    if (runtimeProviders.length > 0) {
      for (const provider of runtimeProviders) {
        for (const model of provider.models) {
          models.push({
            id: model,
            object: 'model',
            owned_by: provider.id,
          });
        }
      }

      return c.json({
        object: 'list',
        data: models,
      });
    }

    for (const configured of llmProviderConfigStore.listProviders().configured) {
      try {
        const provider = llmProviderConfigStore.resolveProvider(configured.id);
        const response = await llmPiAiClient.listModels(provider);

        for (const model of response.data) {
          models.push({
            object: 'model',
            owned_by: provider.id,
            ...model,
          });
        }
      } catch {}
    }

    return c.json({
      object: 'list',
      data: models,
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    try {
      const input = GatewayChatCompletionRequestSchema.parse(await c.req.json());
      const providerId = gatewayDefaultProviderId();

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.chat_completions',
          providerId,
          reasonCode: 'gateway_disabled',
          result: 'deny',
          route: '/v1/chat/completions',
        });
        return c.json(
          {
            error: {
              message: 'Gateway is disabled by policy.',
              type: 'invalid_request_error',
              code: 'gateway_disabled',
            },
          },
          403
        );
      }

      if (!providerId) {
        return c.json(
          {
            error: {
              message: 'Gateway requires a default provider.',
              type: 'invalid_request_error',
              code: 'gateway_not_configured',
            },
          },
          400
        );
      }

      if (!isGatewayProviderAllowed(providerId)) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.chat_completions',
          providerId,
          reasonCode: 'gateway_provider_not_allowed',
          result: 'deny',
          route: '/v1/chat/completions',
        });
        return c.json(
          {
            error: {
              message: `Gateway policy does not allow provider: ${providerId}`,
              type: 'invalid_request_error',
              code: 'gateway_provider_not_allowed',
            },
          },
          403
        );
      }

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.chat_completions',
        providerId,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/chat/completions',
      });

      const provider = resolveGatewayProvider(providerId);
      const request = {
        ...input,
        messages: input.messages.map((message): OpenAICompatibleChatMessage => {
          const mapped: OpenAICompatibleChatMessage = {
            role: message.role,
            content: message.content,
          };

          return message.tool_call_id ? { ...mapped, tool_call_id: message.tool_call_id } : mapped;
        }),
      };

      if (input.stream) {
        const durableCall = startPublicLlmGatewayCall({
          ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          endpoint: 'chat_completions',
          metadata: (request as { metadata?: unknown }).metadata,
          provider,
          store: requestStore(c),
        });

        try {
          const stream = await llmGatewayDispatcher.createChatCompletionStream(
            provider,
            {
              ...request,
              stream: true,
            },
            {
              onUsage: (usage) =>
                recordPublicLlmGatewayUsage({
                  durableCall,
                  model: request.model,
                  provider,
                  usage,
                }),
            }
          );

          return new Response(
            normalizeGatewayTerminalStream(
              finishPublicLlmGatewayStream(stream, durableCall),
              'chat_completions'
            ),
            {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            }
          );
        } catch (error) {
          finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
          throw error;
        }
      }

      const durableCall = startPublicLlmGatewayCall({
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        endpoint: 'chat_completions',
        metadata: (request as { metadata?: unknown }).metadata,
        provider,
        store: requestStore(c),
      });

      try {
        const completion: OpenAICompatibleChatCompletionResponse =
          await llmGatewayDispatcher.createChatCompletion(provider, {
            ...request,
            stream: false,
          });
        recordPublicLlmGatewayUsage({
          durableCall,
          model: request.model,
          provider,
          usage: completion.usage,
        });
        finishPublicLlmGatewayCall(durableCall, 'succeeded');

        return c.json(completion);
      } catch (error) {
        recordPublicLlmGatewayUsage({
          durableCall,
          model: request.model,
          provider,
          usage: readPublicLlmGatewayErrorUsage(error),
        });
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });

  app.post('/v1/responses', async (c) => {
    try {
      const input = GatewayResponsesRequestSchema.parse(await c.req.json());
      const providerId = gatewayDefaultProviderId();

      if (!isGatewayEnabled()) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.responses',
          providerId,
          reasonCode: 'gateway_disabled',
          result: 'deny',
          route: '/v1/responses',
        });
        return c.json(
          {
            error: {
              message: 'Gateway is disabled by policy.',
              type: 'invalid_request_error',
              code: 'gateway_disabled',
            },
          },
          403
        );
      }

      if (!providerId) {
        return c.json(
          {
            error: {
              message: 'Gateway requires a default provider.',
              type: 'invalid_request_error',
              code: 'gateway_not_configured',
            },
          },
          400
        );
      }

      if (!isGatewayProviderAllowed(providerId)) {
        recordLlmGatewayPolicyDecision({
          action: 'llm.gateway.responses',
          providerId,
          reasonCode: 'gateway_provider_not_allowed',
          result: 'deny',
          route: '/v1/responses',
        });
        return c.json(
          {
            error: {
              message: `Gateway policy does not allow provider: ${providerId}`,
              type: 'invalid_request_error',
              code: 'gateway_provider_not_allowed',
            },
          },
          403
        );
      }

      recordLlmGatewayPolicyDecision({
        action: 'llm.gateway.responses',
        providerId,
        reasonCode: 'gateway_allowed',
        result: 'allow',
        route: '/v1/responses',
      });

      const provider = resolveGatewayProvider(providerId);
      const request = {
        ...input,
        stream: input.stream ?? false,
      };

      if (input.stream) {
        const durableCall = startPublicLlmGatewayCall({
          ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          endpoint: 'responses',
          metadata: (request as { metadata?: unknown }).metadata,
          provider,
          store: requestStore(c),
        });

        try {
          const stream = await llmGatewayDispatcher.createResponsesStream(
            provider,
            {
              ...request,
              stream: true,
            },
            {
              onUsage: (usage) =>
                recordPublicLlmGatewayUsage({
                  durableCall,
                  model: request.model,
                  provider,
                  usage,
                }),
            }
          );

          return new Response(
            normalizeGatewayTerminalStream(
              finishPublicLlmGatewayStream(stream, durableCall),
              'responses'
            ),
            {
              headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              },
            }
          );
        } catch (error) {
          finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
          throw error;
        }
      }

      const durableCall = startPublicLlmGatewayCall({
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        endpoint: 'responses',
        metadata: (request as { metadata?: unknown }).metadata,
        provider,
        store: requestStore(c),
      });

      try {
        const response: OpenAICompatibleResponsesResponse =
          await llmGatewayDispatcher.createResponses(provider, request);
        recordPublicLlmGatewayUsage({
          durableCall,
          model: request.model,
          provider,
          usage: response.usage,
        });
        finishPublicLlmGatewayCall(durableCall, 'succeeded');

        return c.json(response);
      } catch (error) {
        recordPublicLlmGatewayUsage({
          durableCall,
          model: request.model,
          provider,
          usage: readPublicLlmGatewayErrorUsage(error),
        });
        finishPublicLlmGatewayCall(durableCall, 'failed', 'llm_gateway_failed');
        throw error;
      }
    } catch (error) {
      return asOpenAIGatewayError(error);
    }
  });

  app.post('/api/app/quick-chat', async (c) => {
    try {
      const input = QuickChatRequestSchema.parse(await c.req.json());
      const { model, providerId } = quickChatSelection(input.providerId, input.model);
      const workspaceId = input.workspaceId ?? 'ws_quick_chat';
      const sessionId = `quick-chat:${workspaceId}`;

      if (!providerId || !model) {
        return c.json(
          apiErrorPayload({
            code: 'quick_chat_not_configured',
            message: 'Quick chat requires a default provider and model.',
          }),
          400
        );
      }

      const result = await getInternalAgentRunner().run<QuickChatAgentOutput>({
        agentId: QUICK_CHAT_AGENT_ID,
        providerId,
        model,
        messages: [{ role: 'user', content: input.input }],
        metadata: {
          openkit: {
            sessionId,
            workspaceId,
          },
        },
        dispatchContext: {
          promptCacheScope: {
            sessionId,
            workspaceId,
          },
          usageEndpoint: 'quick_chat',
        },
      });
      recordQuickChatLlmUsage({
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        model,
        providerId: result.providerId,
        store: requestStore(c),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        workspaceId,
      });

      return c.json(
        QuickChatResponseSchema.parse({
          id: result.id,
          status: 'completed',
          workspaceId,
          providerId: result.providerId,
          model,
          content: result.output.content,
        })
      );
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }

      return c.json(
        apiErrorPayload({
          code: 'quick_chat_failed',
          message: (error as Error).message,
        }),
        400
      );
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/chat', async (c) => {
    const parsed = StartChatModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);
      const isQuickChatWorkspace = workspace.kind === 'quick-chat';

      store.getThread(workspaceId, threadId);

      /**
       * Creates the durable Chat Mode turn and its user-message item.
       *
       * @param completedAt Completion timestamp shared by first-slice Chat Mode items.
       * @returns Created turn.
       */
      const createChatTurn = (completedAt: string) => {
        const turn = store.createTurn(workspaceId, threadId, parsed.data.input);

        store.createItem({
          id: `it_chat_user_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: parsed.data.input,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });

        return turn;
      };

      /**
       * Records one item-backed Chat Mode handoff response.
       *
       * @param targetMode Target product mode.
       * @param reason User-visible handoff reason.
       * @returns Parsed Chat Mode response.
       */
      const createHandoffResponse = (targetMode: 'task' | 'goal', reason: string) => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const title = targetMode === 'task' ? 'Task Mode handoff' : 'Goal Mode handoff';
        const handoffItem = store.createItem({
          id: `it_chat_${targetMode}_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'status',
          status: 'completed',
          level: 'info',
          title,
          summary: reason,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return StartChatModeResponseSchema.parse({
          outcome: `${targetMode}-handoff`,
          explanation: reason,
          turn: completedTurn,
          item: handoffItem,
          handoff: {
            targetMode,
            reason,
            statusItemId: handoffItem.id,
          },
        });
      };

      /**
       * Records a bounded Chat Mode clarification gate.
       *
       * @returns Parsed Chat Mode response.
       */
      const createClarificationResponse = () => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const requestId = `ui_chat_clarify_${turn.id}`;
        const questionItem = store.createItem({
          id: `it_chat_clarify_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-input-request',
          status: 'in_progress',
          userInputRequestId: requestId,
          prompt: 'Chat Mode needs a more specific request.',
          questions: [
            {
              id: 'chat_clarification',
              header: 'Clarify',
              question: 'What should the Assistant answer or help route?',
              options: null,
              isOther: true,
              isSecret: false,
            },
          ],
          createdAt: turn.startedAt ?? completedAt,
          completedAt: null,
        });
        const waitingTurn = store.updateTurn(turn.id, {
          status: 'awaiting_human',
          humanGate: {
            kind: 'user-input',
            userInputRequestId: requestId,
            itemId: questionItem.id,
          },
        });

        return StartChatModeResponseSchema.parse({
          outcome: 'clarification-needed',
          explanation: 'The Assistant needs a concrete request before choosing a mode.',
          turn: waitingTurn,
          item: questionItem,
          handoff: null,
        });
      };

      /**
       * Records one item-backed Chat Mode refusal.
       *
       * @param explanation Refusal reason safe for diagnostics.
       * @returns Parsed Chat Mode response.
       */
      const createRefusedResponse = (explanation: string) => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const refusedItem = store.createItem({
          id: `it_chat_refused_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'status',
          status: 'completed',
          level: 'warning',
          title: 'Chat Mode request refused',
          summary: explanation,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return StartChatModeResponseSchema.parse({
          outcome: 'refused',
          explanation,
          turn: completedTurn,
          item: refusedItem,
          handoff: null,
        });
      };

      if (isClarificationChatPrompt(parsed.data.input)) {
        return c.json(createClarificationResponse(), 202);
      }

      if (isExternalSearchChatPrompt(parsed.data.input)) {
        return c.json(createRefusedResponse('External search is not enabled for Chat Mode.'));
      }

      if (isQuickChatWorkspace && isProjectWorkChatPrompt(parsed.data.input)) {
        assertProjectWorkspace(workspace, 'handle project work');
      }

      const delegation = isQuickChatWorkspace
        ? null
        : createTaskModeDelegation({
            store,
            workspaceId,
            threadId,
            prompt: parsed.data.input,
          });

      if (delegation?.taskDecision) {
        await startTaskModeAttempt({
          store,
          workspaceId,
          threadId,
          prompt: parsed.data.input,
          requestId: parsed.data.requestId,
          delegation,
        });

        return c.json(createHandoffResponse('task', delegation.taskDecision.rationale), 202);
      }

      if (delegation?.coordinator.decision === 'goal') {
        startGoalModeObjective({
          store,
          workspaceId,
          threadId,
          objective: parsed.data.input,
        });

        return c.json(createHandoffResponse('goal', delegation.coordinator.explanation), 202);
      }

      if (delegation && delegation.coordinator.decision !== 'quick_chat') {
        return c.json(createRefusedResponse(delegation.coordinator.explanation));
      }

      const knowledgeAnswer = answerKnowledgeManager({
        operationId: `km_answer_${randomUUID()}`,
        workspaceId,
        caller: 'assistant',
        query: parsed.data.input,
        limit: 3,
        entries: store.listKnowledge(workspaceId),
      });

      if (knowledgeAnswer.outcome === 'answered') {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const sourceTitles = knowledgeAnswer.citations.map((citation) => citation.title).join(', ');
        const answerItem = store.createItem({
          id: `it_chat_answer_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: sourceTitles
            ? `${knowledgeAnswer.answer}\n\nSources: ${sourceTitles}`
            : knowledgeAnswer.answer,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return c.json(
          StartChatModeResponseSchema.parse({
            outcome: 'answered',
            explanation: 'The Assistant answered from workspace knowledge.',
            turn: completedTurn,
            item: answerItem,
            handoff: null,
          })
        );
      }

      if (
        (isRepositoryFileListChatPrompt(parsed.data.input) ||
          isRepositoryFileReadChatPrompt(parsed.data.input)) &&
        options.coreDb
      ) {
        const repositoryInspectionPolicy = chatRepositoryInspectionPolicy(
          runtimeConfig(),
          store,
          workspaceId
        );

        if (!repositoryInspectionPolicy.enabled) {
          return c.json(
            createRefusedResponse('Workspace policy disables Chat Mode repository inspection.'),
            202
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        let repository: WorkspaceRepositoryResourceRecord | null;

        try {
          repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);

          if (repository) {
            let repositoryFileList: RepositoryFileListResult;

            try {
              repositoryFileList = isRepositoryFileReadChatPrompt(parsed.data.input)
                ? formatRepositoryFileRead(
                    repository,
                    parsed.data.input,
                    repositoryInspectionPolicy
                  )
                : formatRepositoryFileList(
                    repository,
                    parsed.data.input,
                    repositoryInspectionPolicy
                  );
            } catch (error) {
              if (error instanceof ChatRepositoryInspectionPolicyError) {
                return c.json(createRefusedResponse(error.message), 202);
              }

              throw error;
            }

            const completedAt = new Date().toISOString();
            const turn = createChatTurn(completedAt);
            const capabilityCall = startCapabilityCall({
              workspaceDb,
              workspaceId,
              threadId,
              turnId: turn.id,
              requestId: parsed.data.requestId ?? null,
              family: 'workspace',
              operation: repositoryFileList.operation,
              capabilityId: 'assistant.repository.read',
              summary: repositoryFileList.summary,
              serviceRef: 'workspace-repository',
              redactionClass: 'metadata',
            });
            let answerText: string;

            try {
              answerText = repositoryFileList.answerText;
              finishCapabilityCall({
                workspaceDb,
                callId: capabilityCall.id,
                status: 'succeeded',
              });
            } catch (error) {
              finishCapabilityCall({
                workspaceDb,
                callId: capabilityCall.id,
                status: 'failed',
                errorCode: 'assistant_repository_read_failed',
              });
              throw error;
            }

            const answerItem = store.createItem({
              id: `it_chat_repo_files_${turn.id}`,
              workspaceId,
              threadId,
              turnId: turn.id,
              type: 'assistant-message',
              status: 'completed',
              text: answerText,
              createdAt: turn.startedAt ?? completedAt,
              completedAt,
            });
            const completedTurn = store.updateTurn(turn.id, {
              status: 'completed',
              completedAt,
            });

            return c.json(
              StartChatModeResponseSchema.parse({
                outcome: 'answered',
                explanation: 'The Assistant answered from a read-only repository inspection.',
                turn: completedTurn,
                item: answerItem,
                handoff: null,
              }),
              202
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      const { model, providerId } = quickChatSelection(parsed.data.providerId, parsed.data.model);
      const sessionId = `chat-mode:${workspaceId}:${threadId}`;

      if (!providerId || !model) {
        return c.json(
          apiErrorPayload({
            code: 'chat_mode_not_configured',
            message: 'Chat Mode requires a default provider and model.',
          }),
          400
        );
      }

      const result = await getInternalAgentRunner().run<QuickChatAgentOutput>({
        agentId: QUICK_CHAT_AGENT_ID,
        providerId,
        model,
        messages: [{ role: 'user', content: parsed.data.input }],
        metadata: {
          openkit: {
            sessionId,
            workspaceId,
          },
        },
        dispatchContext: {
          promptCacheScope: {
            sessionId,
            workspaceId,
          },
          usageEndpoint: 'quick_chat',
        },
      });
      const completedAt = new Date().toISOString();
      const turn = createChatTurn(completedAt);
      recordQuickChatLlmUsage({
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        model,
        providerId: result.providerId,
        ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
        store,
        threadId,
        turnId: turn.id,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        workspaceId,
      });

      const item = store.createItem({
        id: `it_chat_answer_${turn.id}`,
        workspaceId,
        threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: result.output.content,
        createdAt: turn.startedAt ?? completedAt,
        completedAt,
      });
      const completedTurn = store.updateTurn(turn.id, {
        status: 'completed',
        completedAt,
      });

      return c.json(
        StartChatModeResponseSchema.parse({
          outcome: 'answered',
          explanation: 'The Assistant answered directly.',
          turn: completedTurn,
          item,
          handoff: null,
        })
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }

      return asCommandError(error, 'chat_mode_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/threads/:threadId/items', (c) => {
    try {
      return c.json(
        ListThreadItemsResponseSchema.parse({
          items: requestStore(c).listThreadItems(
            c.req.param('workspaceId'),
            c.req.param('threadId')
          ),
          nextCursor: null,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/automations', (c) =>
    c.json(ListAutomationsResponseSchema.parse({ items: automationStore.listAutomations() }))
  );

  app.post('/api/app/automations', async (c) => {
    const input = CreateAutomationRequestSchema.parse(await c.req.json());
    requestStore(c).getWorkspace(input.workspaceId);
    return c.json(AutomationRecordSchema.parse(automationStore.createAutomation(input)), 201);
  });

  app.patch('/api/app/automations/:automationId', async (c) => {
    try {
      const input = UpdateAutomationRequestSchema.parse(await c.req.json());

      return c.json(
        AutomationRecordSchema.parse(
          automationStore.updateAutomation(c.req.param('automationId'), input)
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'automation_update_failed');
    }
  });

  app.delete('/api/app/automations/:automationId', (c) => {
    try {
      automationStore.deleteAutomation(c.req.param('automationId'));

      return c.body(null, 204);
    } catch (error) {
      return asApiError((error as Error).message, 'automation_delete_failed');
    }
  });

  app.get('/api/app/search', (c) => {
    const query = (c.req.query('q') ?? '').trim().toLowerCase();

    if (!query) {
      return c.json({ items: [] });
    }

    const matches = (value: string | null | undefined) => value?.toLowerCase().includes(query);
    const items: Array<{
      kind: 'workspace' | 'thread' | 'knowledge' | 'artifact' | 'item';
      id: string;
      title: string;
      workspaceId?: string;
      threadId?: string;
    }> = [];

    for (const workspace of requestStore(c).listWorkspaces()) {
      if (matches(workspace.name)) {
        items.push({ kind: 'workspace', id: workspace.id, title: workspace.name });
      }

      for (const knowledge of requestStore(c).listKnowledge(workspace.id)) {
        if (matches(knowledge.title) || matches(knowledge.content)) {
          items.push({
            kind: 'knowledge',
            id: knowledge.id,
            title: knowledge.title,
            workspaceId: workspace.id,
          });
        }
      }

      for (const artifact of requestStore(c).listArtifacts(workspace.id)) {
        if (matches(artifact.title) || matches(artifact.summary)) {
          const result = {
            kind: 'artifact',
            id: artifact.id,
            title: artifact.title,
            workspaceId: workspace.id,
            ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
          } as const;
          items.push(result);
        }
      }
    }

    for (const thread of requestStore(c)
      .listWorkspaces()
      .flatMap((workspace) => requestStore(c).listThreads(workspace.id))) {
      if (matches(thread.name) || matches(thread.preview)) {
        items.push({
          kind: 'thread',
          id: thread.id,
          title: thread.name ?? thread.id,
          workspaceId: thread.workspaceId,
        });
      }
    }

    for (const item of requestStore(c).listAllItems()) {
      if ('text' in item && matches(item.text)) {
        items.push({
          kind: 'item',
          id: item.id,
          title: item.text ?? item.id,
          workspaceId: item.workspaceId,
          threadId: item.threadId,
        });
      }
    }

    return c.json(AppSearchResponseSchema.parse({ items }));
  });

  app.get('/api/app/agents', (c) => {
    try {
      return c.json(listAgentCatalog(requestStore(c)));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/agents/:agentId', (c) => {
    try {
      return c.json(getAgentCatalogEntry(requestStore(c), c.req.param('agentId')));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/repositories', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceRepositoryResources(workspaceDb, workspaceId).map((record) =>
          repositoryReadModel(record)
        );
        const defaultResource = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);
        const defaultReadModel = defaultResource ? repositoryReadModel(defaultResource) : null;

        return c.json(
          ListWorkspaceRepositoriesResponseSchema.parse({
            items,
            defaultResourceId: defaultResource?.resourceId ?? null,
            defaultResource: defaultReadModel,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/repositories/diagnostics', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const resources = listWorkspaceRepositoryResources(workspaceDb, workspaceId).map((record) =>
          createWorkspaceRepositoryDiagnostic(record)
        );
        const defaultResource = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);
        const defaultDiagnostic = defaultResource
          ? createWorkspaceRepositoryDiagnostic(defaultResource)
          : null;

        return c.json(
          WorkspaceRepositoryDiagnosticsResponseSchema.parse({
            workspaceId,
            defaultResourceId: defaultResource?.resourceId ?? null,
            defaultResource: defaultDiagnostic,
            resources,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/repositories/git-push-records', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listGitPushRecords(workspaceDb, workspaceId);

        return c.json(ListGitPushRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/repositories/:resourceId/git-push/approval',
    async (c) => {
      const parsed = RequestGitPushApprovalRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      try {
        const workspaceId = c.req.param('workspaceId') ?? '';
        const resourceId = c.req.param('resourceId') ?? '';
        const store = requestStore(c);
        const input = parsed.data;
        const workspace = store.getWorkspace(workspaceId);

        assertProjectWorkspace(workspace, 'request Git push approval');
        store.getTurn(workspaceId, input.threadId, input.turnId);

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          requireWorkspaceRepositoryResource(workspaceDb, workspaceId, resourceId);

          const response = await runIdempotentCommand({
            store,
            inflightCommands,
            command: 'git_push.approval.request',
            requestId: input.requestId,
            scope: {
              workspaceId,
              repositoryResourceId: resourceId,
              threadId: input.threadId,
              turnId: input.turnId,
            },
            input,
            responseKind: 'approval',
            execute: () => {
              const gate = createPolicyApprovalGate({
                workspaceDb,
                store,
                workspaceId,
                turnId: input.turnId,
                action: 'repo.push',
                reasonCode: 'repo_push_requires_human_approval',
                title: `Approve Git push to ${input.targetBranch}`,
                description: `Publish ${input.commitIds.join(', ')} from ${input.sourceRef} to ${input.targetBranch} on ${input.remoteSummary}.`,
                subjectSummary: { kind: 'user', userId: store.getUserId() },
                resourceSummary: {
                  kind: 'git-push-target',
                  workspaceId,
                  repositoryResourceId: resourceId,
                  sourceRef: input.sourceRef,
                  targetBranch: input.targetBranch,
                  commitIds: input.commitIds,
                  remoteSummary: input.remoteSummary,
                },
                contextSummary: {
                  requestId: input.requestId,
                  workspaceId,
                  threadId: input.threadId,
                  turnId: input.turnId,
                },
              });
              const approval = store.getApproval(gate.approvalId);

              return RequestGitPushApprovalResponseSchema.parse({
                approval,
                approvalItemId: gate.approvalItemId,
                policyDecisionId: gate.decisionId,
              });
            },
            replay: (record) => {
              const approval = store.getApproval(record.response.id);
              const decision = readRepoPushApprovalDecision(workspaceDb, workspaceId, approval.id);
              const approvalItem = store
                .listAllItems()
                .find(
                  (item) =>
                    item.workspaceId === workspaceId &&
                    item.type === 'approval-request' &&
                    item.approvalRequestId === approval.id
                );

              if (!decision || !approvalItem) {
                throw new Error(`Git push approval request cannot be replayed: ${approval.id}`);
              }

              return RequestGitPushApprovalResponseSchema.parse({
                approval,
                approvalItemId: approvalItem.id,
                policyDecisionId: decision.decisionId,
              });
            },
            responseId: (result) => result.approval.id,
          });

          return c.json(response);
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asCommandError(error, 'git_push_approval_request_failed');
      }
    }
  );

  app.post('/api/app/workspaces/:workspaceId/repositories/:resourceId/git-push', async (c) => {
    const parsed = ExecuteGitPushRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const resourceId = c.req.param('resourceId') ?? '';
      const store = requestStore(c);
      const input = parsed.data;
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'execute Git push');

      const approval = store.getApproval(input.approvalRequestId);

      if (approval.workspaceId !== workspaceId || approval.status !== 'granted') {
        throw new Error(`Git push approval is not granted: ${input.approvalRequestId}`);
      }

      const approvalItem = store
        .listAllItems()
        .find(
          (item) =>
            item.workspaceId === workspaceId &&
            item.type === 'approval-request' &&
            item.approvalRequestId === input.approvalRequestId
        );

      if (!approvalItem) {
        throw new Error(`Git push approval row not found: ${input.approvalRequestId}`);
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const repository = requireWorkspaceRepositoryResource(workspaceDb, workspaceId, resourceId);
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'git_push.execute',
          requestId: input.requestId,
          scope: {
            workspaceId,
            repositoryResourceId: resourceId,
            targetBranch: input.targetBranch,
          },
          input,
          responseKind: 'git_push_record',
          execute: () =>
            executeGitPushAttempt(workspaceDb, {
              attempt: {
                actorId: store.getUserId(),
                approvalNamesProtectedTarget:
                  approval.title === `Approve Git push to ${input.targetBranch}`,
                approvalRowId: approvalItem.id,
                commitIds: input.commitIds,
                git: repository.git,
                policyDecisionId: input.policyDecisionId,
                recordId: `gpr_${randomUUID()}`,
                remoteSummary: input.remoteSummary,
                repositoryResourceId: resourceId,
                requestId: input.requestId,
                sourceRef: input.sourceRef,
                targetBranch: input.targetBranch,
                workspaceId,
              },
              cwd: repository.localPath,
              provider: gitPushProvider(input.remoteSummary),
              remoteHeadAfter: input.commitIds.at(-1) ?? null,
              remoteName: input.remoteName,
              resolveEnv: () =>
                resolveGitPushCredentialEnv({ repository, workspaceDb, workspaceId }),
              runner: runGitPushCommand,
            }),
          replay: (record) => {
            const pushRecord = getGitPushRecord(workspaceDb, workspaceId, record.response.id);

            if (!pushRecord) {
              throw new Error(`Git push record not found: ${record.response.id}`);
            }

            return pushRecord;
          },
          responseId: (result) => result.id,
        });

        return c.json(ExecuteGitPushResponseSchema.parse(response));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asCommandError(error, 'git_push_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/repositories/git-push-records/:pushRecordId', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const pushRecordId = c.req.param('pushRecordId') ?? '';
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let record: GitPushRecord | null;
      try {
        record = getGitPushRecord(workspaceDb, workspaceId, pushRecordId);
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!record) {
        return asApiError(`Git push record not found: ${pushRecordId}`);
      }

      return c.json(GetGitPushRecordResponseSchema.parse(record));
    } catch (error) {
      return asRepositoryApiError(error);
    }
  });

  /**
   * Creates or updates the default repository resource for one workspace.
   *
   * @param c Hono request context.
   * @returns Redacted repository resource response.
   */
  async function setDefaultWorkspaceRepository(
    c: Context<{ Variables: AuthVariables }>
  ): Promise<Response> {
    const parsed = SetWorkspaceRepositoryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId') ?? '';
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'link repositories');

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const repository = upsertWorkspaceRepositoryResource(workspaceDb, {
          workspaceExists: (candidateWorkspaceId) => {
            try {
              store.getWorkspace(candidateWorkspaceId);
              return true;
            } catch {
              return false;
            }
          },
          workspaceId,
          displayName: parsed.data.displayName,
          localPath: parsed.data.localPath,
          ...(parsed.data.git ? { git: parsed.data.git } : {}),
          ...(parsed.data.resourceId ? { resourceId: parsed.data.resourceId } : {}),
        });
        syncRepositoryDataSourceCatalog({
          dataRoot: repositoryCoreDb().dataRoot,
          userId: store.getUserId(),
          workspaceId,
          record: repository,
        });

        return c.json(
          SetWorkspaceRepositoryResponseSchema.parse({
            repository: repositoryReadModel(repository),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asRepositoryApiError(error);
    }
  }

  app.put('/api/app/workspaces/:workspaceId/repositories/default', setDefaultWorkspaceRepository);
  app.post('/api/app/workspaces/:workspaceId/repositories/default', setDefaultWorkspaceRepository);

  app.get('/api/app/workspaces/:workspaceId/action-center', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = options.coreDb ? repositoryWorkspaceDb(store, workspaceId) : undefined;
      try {
        return c.json(
          ListHumanAttentionResponseSchema.parse(
            buildHumanAttentionResponse({
              store,
              coreDb: options.coreDb,
              workspaceDb,
              workspaceId,
            })
          )
        );
      } finally {
        workspaceDb?.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/scheduler/admissions', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');

      if (!options.coreDb) {
        return c.json(ListSchedulerAdmissionsResponseSchema.parse({ items: [] }));
      }

      const queuedPositions = new Map(
        listQueuedSchedulerAdmissionEntries(options.coreDb).map((entry, index) => [
          entry.queueEntryId,
          index + 1,
        ])
      );
      const items = listSchedulerAdmissionEntriesForWorkspace(options.coreDb, {
        workspaceId,
        statuses: ['queued', 'denied'],
      }).map((entry) => ({
        queueEntryId: entry.queueEntryId,
        requestId: entry.requestId,
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        requestedAgentId: entry.requestedAgentId,
        profileRef: entry.profileRef,
        priorityClass: entry.priorityClass,
        enqueuedAt: entry.enqueuedAt,
        effectivePriorityAt: entry.effectivePriorityAt,
        firstCapDeferredAt: entry.firstCapDeferredAt,
        requiredPoolConstraints: entry.requiredPoolConstraints,
        status: entry.status,
        denialReason: entry.denialReason,
        queuePosition:
          entry.status === 'queued' ? (queuedPositions.get(entry.queueEntryId) ?? null) : null,
      }));

      return c.json(ListSchedulerAdmissionsResponseSchema.parse({ items }));
    } catch (error) {
      return asApiError((error as Error).message, 'scheduler_admissions_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/retry', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const queueEntryId = c.req.param('queueEntryId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      if (!options.coreDb) {
        return asApiError(
          'Scheduler storage is unavailable for this NanoCore instance.',
          'scheduler_storage_unavailable',
          503
        );
      }

      const retried = retryDeniedSchedulerAdmissionEntry(options.coreDb, {
        queueEntryId,
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      recordWorkspaceAuditEvent({
        workspaceDb,
        workspaceId,
        threadId: retried.threadId,
        turnId: retried.turnId,
        requestId: retried.requestId,
        action: 'scheduler.admission.retry',
        resource: `scheduler-admission:${retried.queueEntryId}`,
        outcome: 'succeeded',
        summary: 'Scheduler admission retried.',
      });

      return c.json(RetrySchedulerAdmissionResponseSchema.parse({ retried: true }));
    } catch (error) {
      return asApiError((error as Error).message, 'scheduler_admission_retry_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/cancel', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const queueEntryId = c.req.param('queueEntryId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      if (!options.coreDb) {
        return asApiError(
          'Scheduler storage is unavailable for this NanoCore instance.',
          'scheduler_storage_unavailable',
          503
        );
      }

      const cancelled = cancelSchedulerAdmissionEntry(options.coreDb, {
        queueEntryId,
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      recordWorkspaceAuditEvent({
        workspaceDb,
        workspaceId,
        threadId: cancelled.threadId,
        turnId: cancelled.turnId,
        requestId: cancelled.requestId,
        action: 'scheduler.admission.cancel',
        resource: `scheduler-admission:${cancelled.queueEntryId}`,
        outcome: 'cancelled',
        summary: 'Scheduler admission cancelled.',
      });

      return c.json(CancelSchedulerAdmissionResponseSchema.parse({ cancelled: true }));
    } catch (error) {
      return asApiError((error as Error).message, 'scheduler_admission_cancel_failed', 400);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/capability-usage', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          CapabilityUsageResponseSchema.parse({
            workspaceId,
            capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId),
            usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/evidence-bundles', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const input = CreateEvidenceBundleRequestSchema.parse(await c.req.json());
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          CreateEvidenceBundleResponseSchema.parse({
            evidenceBundle: createWorkspaceEvidenceBundle({
              workspaceDb,
              workspaceId,
              request: input,
              redactedEvidenceRefs: collectEvidenceBundleRefs(store, workspaceId, input),
            }),
          }),
          201
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/evidence-bundles', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspaceEvidenceBundlesResponseSchema.parse({
            workspaceId,
            evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/runtime-evidence', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspaceRuntimeEvidenceResponseSchema.parse({
            workspaceId,
            runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/audit/events', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspaceAuditEventsResponseSchema.parse({
            workspaceId,
            auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/audit/events', (c) => {
    try {
      if (!options.coreDb) {
        return asApiError(
          'Server audit storage is unavailable for this NanoCore instance.',
          'server_audit_storage_unavailable',
          503
        );
      }

      return c.json(
        ListServerAuditEventsResponseSchema.parse({
          auditEvents: listServerAuditEvents(options.coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/permission-decisions', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        return c.json(
          ListWorkspacePermissionDecisionsResponseSchema.parse({
            workspaceId,
            permissionDecisions: listExportableWorkspacePermissionDecisions(
              workspaceDb,
              workspaceId
            ),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/vault/grants', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!options.coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListWorkspaceVaultGrantsResponseSchema.parse({
          workspaceId,
          items: listExportableWorkspaceVaultGrants(options.coreDb, workspaceId),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/vault/injection-plans', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!options.coreDb) {
        return asApiError('Core DB is not available.');
      }

      const grantIds = listExportableWorkspaceVaultGrants(options.coreDb, workspaceId).map(
        (grant) => grant.grantId
      );
      return c.json(
        ListWorkspaceInjectionPlansResponseSchema.parse({
          workspaceId,
          items: listExportableInjectionPlans(options.coreDb, grantIds),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/vault/injection-receipts', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      requestStore(c).getWorkspace(workspaceId);

      if (!options.coreDb) {
        return asApiError('Core DB is not available.');
      }

      const grantIds = listExportableWorkspaceVaultGrants(options.coreDb, workspaceId).map(
        (grant) => grant.grantId
      );
      const planIds = listExportableInjectionPlans(options.coreDb, grantIds).map(
        (plan) => plan.planId
      );
      return c.json(
        ListWorkspaceInjectionReceiptsResponseSchema.parse({
          workspaceId,
          items: listExportableInjectionReceipts(options.coreDb, planIds),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/permission-decisions', (c) => {
    try {
      if (!options.coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListServerPermissionDecisionsResponseSchema.parse({
          permissionDecisions: listServerPermissionDecisions(options.coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/vault/use-records', (c) => {
    try {
      if (!options.coreDb) {
        return asApiError('Core DB is not available.');
      }

      return c.json(
        ListServerVaultUseRecordsResponseSchema.parse({
          vaultUseRecords: listVaultUseRecords(options.coreDb),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const workspace = requestStore(c).getWorkspace(workspaceId);
      const resources = requestStore(c).getWorkspaceResources(workspaceId);
      const threads = requestStore(c)
        .listThreads(workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const providerCount = llmProviderConfigStore.listProviders().configured.length;
      const workspaceArtifacts = requestStore(c).listArtifacts(workspaceId);
      const workSections = buildWorkspaceWorkSections({
        threads,
        artifacts: workspaceArtifacts,
        getThreadTurns: (thread) => requestStore(c).listThreadTurns(workspaceId, thread.id),
        getThreadItems: (thread) => requestStore(c).listThreadItems(workspaceId, thread.id),
        resolveAgentId: (turn) => requestStore(c).resolveTurnAgentId(turn),
      });

      return c.json(
        WorkspaceDashboardResponseSchema.parse({
          workspace,
          counts: {
            ...workspace.counts,
            providerCount,
          },
          defaultContext: {
            modelId: workspace.defaults?.defaultModelId ?? null,
            agentId: workspace.defaults?.defaultAgentId ?? null,
            skillIds: workspace.defaults?.defaultSkillIds ?? [],
          },
          agentHealth: resources.agents.map((agent) => ({
            agentId: agent.id,
            status: agent.health.status,
            message: agent.health.message,
            checkedAt: agent.health.checkedAt,
          })),
          recentThreads: threads.slice(0, 10),
          activeWork: workSections.activeWork,
          recentCompletions: workSections.recentCompletions,
          attentionNeeded: workSections.attentionNeeded,
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/threads/:threadId/dashboard', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const workspace = requestStore(c).getWorkspace(workspaceId);
      const thread = requestStore(c).getThread(workspaceId, threadId);
      const turns = requestStore(c).listThreadTurns(workspaceId, threadId);
      const threadItems = requestStore(c).listThreadItems(workspaceId, threadId);
      const latestTurn = turns.at(-1) ?? null;
      const selectedAgentId = latestTurn
        ? requestStore(c).resolveTurnAgentId(latestTurn)
        : (workspace.defaults?.defaultAgentId ?? null);
      const threadArtifacts = requestStore(c)
        .listArtifacts(workspaceId)
        .filter((artifact) => artifact.threadId === threadId);
      const artifacts = threadArtifacts.map((artifact) => summarizeDashboardArtifact(artifact));

      return c.json(
        ThreadDashboardResponseSchema.parse({
          thread,
          activeSession: getThreadAgentSession(
            turnExecutor,
            requestStore(c),
            workspaceId,
            threadId,
            runtimeConfig().version,
            workerControlGateway
          ),
          turns,
          artifacts,
          workStatus: buildThreadWorkStatus({
            turns,
            items: threadItems,
            artifacts: threadArtifacts,
            selectedAgentId,
          }),
          composer: {
            disabled: false,
            defaultModelId: workspace.defaults?.defaultModelId ?? null,
            defaultAgentId: workspace.defaults?.defaultAgentId ?? null,
          },
          itemLog: {
            href: `/api/app/workspaces/${workspaceId}/threads/${threadId}/items`,
          },
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/agent-sessions/:agentSessionId/terminal-commands',
    async (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const agentSessionId = c.req.param('agentSessionId');
        const request = QueueAgentSessionTerminalCommandRequestSchema.parse(await c.req.json());
        const activeSession = getThreadAgentSession(
          turnExecutor,
          requestStore(c),
          workspaceId,
          threadId,
          runtimeConfig().version,
          workerControlGateway
        );

        if (!activeSession || activeSession.id !== agentSessionId) {
          return asApiError(
            `Active agent session not found: ${agentSessionId}`,
            'agent_session_not_found',
            404
          );
        }

        const snapshot = workerControlGateway.getSessionSnapshotByAgentSessionId(agentSessionId);

        if (!snapshot || snapshot.workspaceId !== workspaceId || snapshot.threadId !== threadId) {
          return asApiError(
            `Worker control session not found: ${agentSessionId}`,
            'worker_control_session_not_found',
            404
          );
        }

        const command = workerControlGateway.enqueueTerminalCommand(snapshot.packageSnapshotId, {
          argv: request.argv,
          commandId: request.requestId,
          cwd: request.cwd,
        });

        return c.json(
          QueueAgentSessionTerminalCommandResponseSchema.parse({
            command,
          })
        );
      } catch (error) {
        return asApiError((error as Error).message, 'terminal_command_queue_failed', 400);
      }
    }
  );

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/task', async (c) => {
    const parsed = StartTaskModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'start Task Mode');
      store.getThread(workspaceId, threadId);

      const delegation = createTaskModeDelegation({
        store,
        workspaceId,
        threadId,
        prompt: parsed.data.input,
      });

      if (delegation.coordinator.decision === 'goal') {
        const goalStart = startGoalModeObjective({
          store,
          workspaceId,
          threadId,
          objective: parsed.data.input,
        });
        const reason = delegation.coordinator.explanation;
        const timestamp = new Date().toISOString();
        store.createItem({
          id: `it_task_goal_${goalStart.response.goal.goalId}_${goalStart.turn.id}`,
          workspaceId,
          threadId,
          turnId: goalStart.turn.id,
          type: 'status',
          status: 'completed',
          level: 'info',
          title: 'Task Mode escalated to Goal Mode',
          summary: reason,
          createdAt: timestamp,
          completedAt: timestamp,
        });

        return c.json(
          StartTaskModeResponseSchema.parse({
            decision: null,
            state: 'escalated-to-goal',
            turn: store.getTurnById(goalStart.turn.id),
            evidence: taskModeEvidenceForTurn(store, null, workspaceId, threadId, goalStart.turn),
            escalation: {
              targetMode: 'goal',
              goalId: goalStart.response.goal.goalId,
              reason,
            },
          }),
          202
        );
      }

      if (!delegation.taskDecision) {
        return Response.json(
          apiErrorPayload({
            code: 'task_mode_not_delegated',
            message: delegation.coordinator.explanation,
          }),
          { status: 409 }
        );
      }

      const attempt = await startTaskModeAttempt({
        store,
        workspaceId,
        threadId,
        prompt: parsed.data.input,
        modelId: parsed.data.modelId,
        requestId: parsed.data.requestId,
        delegation,
      });

      if (!attempt) {
        return Response.json(
          apiErrorPayload({
            code: 'task_mode_not_delegated',
            message: delegation.coordinator.explanation,
          }),
          { status: 409 }
        );
      }

      const workspaceDb = options.coreDb ? repositoryWorkspaceDb(store, workspaceId) : null;
      let evidence: TaskModeEvidence;

      try {
        evidence = taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, attempt.turn);
      } finally {
        workspaceDb?.sqlite.close();
      }

      return c.json(
        StartTaskModeResponseSchema.parse({
          decision: attempt.decision,
          state: attempt.state,
          turn: attempt.turn,
          completion: taskModeCompletionForTurn(store, workspaceId, threadId, attempt.turn),
          evidence,
        }),
        202
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'task_mode_start_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/threads/:threadId/goal', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return c.json(ThreadGoalSummaryResponseSchema.parse({ goal: null }));
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          ThreadGoalSummaryResponseSchema.parse({
            goal: buildThreadGoalSummary(
              workspaceDb,
              workspaceId,
              threadId,
              store.listThreadItems(workspaceId, threadId)
            ),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal', async (c) => {
    const parsed = StartThreadGoalRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'start Goal Mode');
      store.getThread(workspaceId, threadId);

      return c.json(
        startGoalModeObjective({
          store,
          workspaceId,
          threadId,
          objective: parsed.data.objective,
          title: parsed.data.title,
        }).response
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asApiError((error as Error).message, 'goal_create_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/steering', async (c) => {
    const parsed = SubmitThreadGoalSteeringRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);
        const turn = store.createTurn(workspaceId, threadId, parsed.data.message);
        const timestamp = turn.startedAt ?? new Date().toISOString();
        const steeringItem = store.createItem({
          id: `it_goal_steering_${goal.goalId}_${parsed.data.requestId}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: parsed.data.message,
          createdAt: timestamp,
          completedAt: timestamp,
        });

        store.updateTurn(turn.id, {
          status: 'completed',
          completedAt: timestamp,
          durationMs: 0,
        });

        const recorded = recordActiveGoalSteering(workspaceDb, {
          workspaceId,
          threadId,
          goalId: goal.goalId,
          requestId: parsed.data.requestId,
          contentItemId: steeringItem.id,
          now: () => timestamp,
        });
        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          SubmitThreadGoalSteeringResponseSchema.parse({
            state: recorded.state === 'pending_steering' ? 'queued' : 'blocked',
            goal: summary,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_steering_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/plan', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'planning') {
          return asApiError('Goal is not ready for planning.', 'goal_not_planning', 409);
        }

        const planner = createWorkerCoordinatorGoalPlanDraft({
          workspaceId,
          threadId,
          goalId: goal.goalId,
          title: goal.title,
          objective: goal.objective,
        });
        const result = await createGoalPlan({
          workspaceDb,
          store,
          workspaceId,
          threadId,
          goalId: goal.goalId,
        });

        if (result.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal planner did not produce an approvable plan.',
            'goal_plan_failed',
            400
          );
        }

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          CreateThreadGoalPlanResponseSchema.parse({
            status: result.status,
            goal: summary,
            planItemId: result.planItem.id,
            planner,
            plan: result.plan,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_create_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve', async (c) => {
    const parsed = ApproveThreadGoalPlanRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal is not awaiting plan approval.',
            'goal_not_awaiting_plan_approval',
            409
          );
        }

        if (goal.planItemId !== parsed.data.planItemId) {
          return asApiError('Plan item does not match the active goal.', 'goal_plan_mismatch', 400);
        }

        const approved = approveGoalPlan({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          planItemId: parsed.data.planItemId,
          plan: parsed.data.plan,
        });
        persistApprovedGoalTasks({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          plan: parsed.data.plan,
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          ApproveThreadGoalPlanResponseSchema.parse({
            goal: summary,
            readyTasks: approved.readyTasks,
            startsWorkerTurn: approved.startsWorkerTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_approve_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/revise', async (c) => {
    const parsed = ReviseThreadGoalPlanRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'awaiting_plan_approval') {
          return asApiError(
            'Goal is not awaiting plan approval.',
            'goal_not_awaiting_plan_approval',
            409
          );
        }

        const revised = reviseGoalPlan({
          workspaceDb,
          store,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          requestId: parsed.data.requestId,
          revision: parsed.data.revision,
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          ReviseThreadGoalPlanResponseSchema.parse({
            goal: summary,
            revisionItemId: revised.revisionItem.id,
            startsWorkerTurn: revised.startsWorkerTurn,
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_plan_revise_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/pause', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const activeTurn = store
        .listThreadTurns(workspaceId, threadId)
        .find((turn) => turn.status === 'running' || turn.status === 'awaiting_human');

      if (activeTurn) {
        return asApiError(
          'Goal cannot pause while a worker turn is active.',
          'goal_pause_active_turn',
          409
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'running' && goal.status !== 'paused') {
          return asApiError('Goal is not running.', 'goal_not_running', 409);
        }

        if (goal.status !== 'paused') {
          updateGoalStatus(workspaceDb, {
            workspaceId,
            threadId,
            goalId: goal.goalId,
            status: 'paused',
          });
        }

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(PauseThreadGoalResponseSchema.parse({ goal: summary }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_pause_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/resume', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status !== 'paused') {
          return asApiError('Goal is not paused.', 'goal_not_paused', 409);
        }

        updateGoalStatus(workspaceDb, {
          workspaceId,
          threadId,
          goalId: goal.goalId,
          status: 'running',
        });

        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(ResumeThreadGoalResponseSchema.parse({ goal: summary }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'goal_resume_failed', 400);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/threads/:threadId/goal/step', async (c) => {
    const parsed = RunThreadGoalStepRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const activeTurn = store
        .listThreadTurns(workspaceId, threadId)
        .find((turn) => turn.status === 'running' || turn.status === 'awaiting_human');

      if (activeTurn) {
        return asApiError('Thread already has an active worker turn.', 'thread_busy', 409);
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

        if (goal.status === 'paused') {
          return asApiError('Goal is paused.', 'goal_paused', 409);
        }

        if (goal.status !== 'running') {
          return asApiError('Goal is not running.', 'goal_not_running', 409);
        }

        const tasks = listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId });
        const task = selectNextGoalWorkerTask(tasks);

        if (!task) {
          return asApiError('Goal does not have a ready task.', 'goal_no_ready_task', 409);
        }

        const repository = resolveWorkspaceRepositoryForTurn(
          options.coreDb,
          workspaceId,
          store.getUserId()
        );

        const coordinator = createGoalModeStepDelegation({
          store,
          workspaceId,
          threadId,
          task,
        });
        const reviewRequired = parsed.data.reviewPolicyOverride !== 'none';

        const snapshot = runtimeConfig();
        const workspaceRoots = materializeWorkspaceRootsForTurn(
          snapshot,
          store,
          workspaceId,
          repository
        );
        const workspaceSourceContext = workspaceSourceContextForTurn(
          snapshot,
          store,
          workspaceId,
          repository,
          workspaceRoots
        );

        const loop = await runWorkerTurnLoop({
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          taskId: task.taskId,
          reviewRequired,
          remainingWorkerIterations: Math.max(
            0,
            tasks.filter((candidate) => candidate.status === 'ready').length - 1
          ),
          ...(parsed.data.followUpDrainMode
            ? { followUpDrainMode: parsed.data.followUpDrainMode }
            : {}),
          prepare: (queues) =>
            prepareGoalTaskDelegation(options.coreDb!, workspaceDb, {
              workspaceId,
              userId: store.getUserId(),
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              threadItems: store.listThreadItems(workspaceId, threadId),
              steeringMessages: queues.steeringMessages,
              followUpInputs: queues.followUpInputs,
            }),
          createTurn: ({ prepared }) => {
            const turn = store.createTurn(
              workspaceId,
              threadId,
              prepared.delegationRequest.objective
            );
            updateGoalTask(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              status: 'running',
            });
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'running',
              currentTaskId: task.taskId,
            });

            return { turnId: turn.id };
          },
          startWorker: async ({ turnId, prepared }) => {
            await turnExecutor.startTurn(store, turnId, prepared.delegationRequest.objective, {
              requestId: parsed.data.requestId,
              workspaceRoots,
              ...workspaceSourceContext,
              workspaceCwd: prepared.repository.localPath,
            });
            const session = turnExecutor.getAgentSession?.(store, workspaceId, threadId) ?? null;

            return { workerSessionId: session?.id ?? null };
          },
          awaitWorker: async ({ turnId }) => {
            const turn = await waitForWorkerTurnTerminalState(store, turnId);
            const evidence = collectWorkerTurnEvidence(
              store.listThreadItems(workspaceId, threadId),
              turnId
            );
            const message =
              turn.error?.message ??
              (turn.status === 'completed' ? null : 'Worker turn ended without success.');

            return {
              stopReason: stopReasonForTurnStatus(turn.status),
              itemIds: evidence.itemIds,
              artifactIds: evidence.artifactIds,
              diagnosticsSummary: message,
            };
          },
        });

        const workerOutcome = recordGoalTaskWorkerOutcome(workspaceDb, {
          workspaceDb,
          workspaceId,
          threadId,
          goalId: goal.goalId,
          taskId: task.taskId,
          turnId: loop.turnId,
          stopReason: loop.stopDecision.stopReason,
          itemIds: loop.evidence.itemIds,
          artifactIds: loop.evidence.artifactIds,
          contextAssembly: loop.contextAssembly,
        });
        const stopDecision = createWorkerCoordinatorGoalStopDecision({
          workspaceId,
          threadId,
          requestId: parsed.data.requestId,
          goalId: goal.goalId,
          taskId: task.taskId,
          turnId: loop.turnId,
          stopDecision: loop.stopDecision,
          evidence: loop.evidence,
        });
        const attentionItemId = loop.evidence.itemIds.at(-1) ?? null;

        switch (stopDecision.outcome) {
          case 'review':
            updateGoalTask(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              status: 'reviewing',
            });
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'reviewing',
              currentTaskId: task.taskId,
            });
            break;
          case 'ask_user': {
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'awaiting_user',
              currentTaskId: task.taskId,
              terminalStopReason: 'ask_user',
            });
            break;
          }
          case 'block':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: stopDecision.stopReason === 'error' ? 'failed' : 'blocked',
              currentTaskId: task.taskId,
              terminalStopReason: stopDecision.stopReason,
            });
            break;
          case 'abort':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'aborted',
              currentTaskId: task.taskId,
              terminalStopReason: 'aborted',
            });
            break;
          case 'complete':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'completed',
              currentTaskId: null,
              terminalStopReason: 'completed',
            });
            break;
          case 'continue':
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'running',
              currentTaskId: null,
            });
            break;
        }

        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId,
          threadId,
          turnId: loop.turnId,
          terminalStage: workerOutcome.checkpointStage,
        });
        const summary = buildThreadGoalSummary(
          workspaceDb,
          workspaceId,
          threadId,
          store.listThreadItems(workspaceId, threadId)
        );

        if (!summary) {
          return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
        }

        return c.json(
          RunThreadGoalStepResponseSchema.parse({
            goal: summary,
            worker: {
              turnId: loop.turnId,
              stopReason: stopDecision.stopReason,
              checkpointStage: workerOutcome.checkpointStage,
              workerSessionId: loop.workerSessionId,
              evidence: loop.evidence,
            },
            contextAssembly: loop.contextAssembly,
            coordinator,
            decision: stopDecision,
            pendingAttention: pendingAttentionForGoalStep(stopDecision.outcome, attentionItemId),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (options.coreDb) {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const store = requestStore(c);
        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const goal =
            listGoalRecordsForThread(workspaceDb, { workspaceId, threadId }).findLast(
              isActiveGoal
            ) ?? null;

          if (goal) {
            updateGoalStatus(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              status: 'failed',
              terminalStopReason: 'error',
            });
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return asApiError(redactInternalAgentText((error as Error).message), 'goal_step_failed', 400);
    }
  });

  if (mode === 'local') {
    app.post(
      '/api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step',
      async (c) => {
        const parsed = RunThreadGoalTestSuperviseStepRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        try {
          const workspaceId = c.req.param('workspaceId');
          const threadId = c.req.param('threadId');
          const store = requestStore(c);

          store.getWorkspace(workspaceId);
          store.getThread(workspaceId, threadId);

          if (!options.coreDb) {
            return asApiError(
              'Goal storage is unavailable for this NanoCore instance.',
              'goal_storage_unavailable',
              503
            );
          }

          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            const goal = requireLatestActiveGoal(workspaceDb, workspaceId, threadId);

            if (goal.status !== 'running') {
              return asApiError('Goal is not running.', 'goal_not_running', 409);
            }

            const task = selectNextReadyGoalTask(
              listGoalTasks(workspaceDb, { workspaceId, threadId, goalId: goal.goalId })
            );

            if (!task) {
              return asApiError('Goal does not have a ready task.', 'goal_no_ready_task', 409);
            }

            recordGoalWorkerLaunchDecision({
              workspaceDb,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              enforcementPoint: 'goal.test.supervise.worker_start',
            });
            const worker = await startGoalTaskWorkerTurn({
              workspaceDb,
              store,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              prepared: createDeterministicPreparedGoalTask(task),
              startWorker: () => ({ workerSessionId: 'deterministic-worker' }),
            });
            const timestamp = worker.turn.startedAt ?? new Date().toISOString();
            const evidenceItem = store.createItem({
              id: `it_goal_worker_${goal.goalId}_${task.taskId}`,
              workspaceId,
              threadId,
              turnId: worker.turn.id,
              type: 'status',
              status: 'completed',
              level: 'info',
              title: 'Deterministic worker completed',
              summary: task.objective,
              createdAt: timestamp,
              completedAt: timestamp,
            });

            store.updateTurn(worker.turn.id, {
              status: 'completed',
              completedAt: timestamp,
              durationMs: 0,
            });

            const workerOutcome = recordGoalTaskWorkerOutcome(workspaceDb, {
              workspaceDb,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              turnId: worker.turn.id,
              stopReason: 'completed',
              itemIds: [evidenceItem.id],
            });
            const review = createGoalReviewRecord(workspaceDb, {
              reviewId: `review_${goal.goalId}_${task.taskId}`,
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              turnId: worker.turn.id,
              itemIds: [evidenceItem.id],
              verdict: parsed.data.verdict,
              reason: 'Deterministic supervise e2e accepted the worker outcome.',
            });
            const advance = advanceGoalAfterReview(workspaceDb, {
              workspaceId,
              threadId,
              goalId: goal.goalId,
              taskId: task.taskId,
              verdict: parsed.data.verdict,
            });
            const summary = buildThreadGoalSummary(
              workspaceDb,
              workspaceId,
              threadId,
              store.listThreadItems(workspaceId, threadId)
            );

            if (!summary) {
              return asApiError('Goal summary is unavailable.', 'goal_summary_unavailable', 500);
            }

            return c.json(
              RunThreadGoalTestSuperviseStepResponseSchema.parse({
                goal: summary,
                task: {
                  taskId: advance.task.taskId,
                  title: advance.task.title,
                  status: advance.task.status,
                  orderIndex: advance.task.orderIndex,
                },
                worker: {
                  turnId: worker.turn.id,
                  stopReason: 'completed',
                  checkpointStage: workerOutcome.checkpointStage,
                },
                review: {
                  reviewId: review.reviewId,
                  verdict: review.verdict,
                },
                advance: {
                  outcome: advance.outcome,
                  nextTaskId: advance.nextTask?.taskId ?? null,
                },
              })
            );
          } finally {
            workspaceDb.sqlite.close();
          }
        } catch (error) {
          return asApiError((error as Error).message, 'goal_supervise_step_failed', 400);
        }
      }
    );
  }

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/interrupted-worker',
    (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const turn = store.createTurn(workspaceId, threadId, 'Deterministic interrupted worker');
        const timestamp = turn.startedAt ?? new Date().toISOString();
        const pendingItem = store.createItem({
          id: `it_recovery_pending_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: 'Pending input preserved across restart.',
          createdAt: timestamp,
          completedAt: timestamp,
        });
        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        let checkpoint: ReturnType<typeof upsertWorkerCheckpoint>;
        let pendingUserTurn: ReturnType<typeof enqueuePendingUserTurn>;
        try {
          checkpoint = upsertWorkerCheckpoint(workspaceDb, {
            workspaceId,
            threadId,
            turnId: turn.id,
            stage: 'running_worker',
            iteration: 1,
            workerSessionId: 'deterministic-worker',
            contextDigest: `deterministic:${turn.id}`,
            diagnosticsSummary: 'Deterministic worker interrupted before terminal save.',
            now: () => timestamp,
          });
          pendingUserTurn = enqueuePendingUserTurn(workspaceDb, {
            workspaceId,
            threadId,
            requestId: `req_${turn.id}`,
            contentItemId: pendingItem.id,
            queueMode: 'safe_point_steering',
            receivedAt: timestamp,
          });
        } finally {
          workspaceDb.sqlite.close();
        }

        return c.json(
          CreateInterruptedRecoveryStateResponseSchema.parse({
            checkpoint: {
              checkpointId: checkpoint.checkpointId,
              turnId: checkpoint.turnId,
              stage: checkpoint.stage,
            },
            pendingUserTurn,
          })
        );
      } catch (error) {
        return asApiError((error as Error).message, 'recovery_seed_failed', 400);
      }
    }
  );

  app.get('/api/app/recovery/interrupted-workers', (c) => {
    try {
      if (!options.coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const store = requestStore(c);

      return c.json(
        ListInterruptedWorkerStatesResponseSchema.parse({
          items: store.listWorkspaces().flatMap((workspace) => {
            const workspaceDb = repositoryWorkspaceDb(store, workspace.id);
            try {
              return materializeInterruptedWorkerStates(workspaceDb);
            } finally {
              workspaceDb.sqlite.close();
            }
          }),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_list_failed', 400);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/threads/:threadId/recovery/pending-user-turns', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      if (!options.coreDb) {
        return asApiError(
          'Recovery storage is unavailable for this NanoCore instance.',
          'recovery_storage_unavailable',
          503
        );
      }

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        return c.json(
          ListRecoveryPendingUserTurnsResponseSchema.parse({
            items: listPendingUserTurns(workspaceDb, { workspaceId, threadId }),
          })
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'recovery_pending_user_turns_failed', 400);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/pending-user-turns/:requestId/edit',
    async (c) => {
      const parsed = EditRecoveryPendingUserTurnRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const requestId = c.req.param('requestId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const pendingTurn =
            listPendingUserTurns(workspaceDb, { workspaceId, threadId }).find(
              (turn) => turn.requestId === requestId
            ) ?? null;

          if (!pendingTurn) {
            return c.json(
              EditRecoveryPendingUserTurnResponseSchema.parse({ edited: false, item: null })
            );
          }

          if (!pendingTurn.contentItemId) {
            return asApiError(
              'Pending user turn does not reference an editable item.',
              'recovery_pending_user_turn_edit_unsupported',
              409
            );
          }

          const item = store
            .listThreadItems(workspaceId, threadId)
            .find((candidate) => candidate.id === pendingTurn.contentItemId);

          if (!item || item.type !== 'user-message') {
            return asApiError(
              'Pending user turn does not reference an editable user message.',
              'recovery_pending_user_turn_edit_unsupported',
              409
            );
          }

          const updated = store.updateItem(item.id, {
            text: parsed.data.text,
          });
          recordPendingUserTurnEditedAuditEvent(workspaceDb, pendingTurn);

          return c.json(
            EditRecoveryPendingUserTurnResponseSchema.parse({ edited: true, item: updated })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError((error as Error).message, 'recovery_pending_user_turn_edit_failed', 400);
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/pending-user-turns/:requestId/follow-up',
    (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const requestId = c.req.param('requestId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const pendingUserTurn = convertPendingUserTurnToFollowUp(workspaceDb, {
            requestId,
            threadId,
            workspaceId,
          });

          return c.json(
            ConvertRecoveryPendingUserTurnToFollowUpResponseSchema.parse({
              converted: Boolean(pendingUserTurn),
              pendingUserTurn,
            })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'recovery_pending_user_turn_follow_up_failed',
          400
        );
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/pending-user-turns/:requestId/interrupt',
    async (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const requestId = c.req.param('requestId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const pendingTurn =
            listPendingUserTurns(workspaceDb, { workspaceId, threadId }).find(
              (turn) => turn.requestId === requestId
            ) ?? null;

          if (!pendingTurn) {
            return c.json(
              PromoteRecoveryPendingUserTurnToInterruptResponseSchema.parse({
                promoted: false,
                turn: null,
              })
            );
          }

          const activeTurn =
            [...store.listThreadTurns(workspaceId, threadId)]
              .reverse()
              .find((turn) => turn.status === 'pending' || turn.status === 'running') ?? null;

          if (!activeTurn) {
            return asApiError(
              'Thread has no active turn to interrupt.',
              'recovery_pending_user_turn_interrupt_unavailable',
              409
            );
          }

          await turnExecutor.interruptTurn(store, activeTurn.id, { requestId });
          const promoted = promotePendingUserTurnToInterrupt(workspaceDb, {
            requestId,
            threadId,
            workspaceId,
          });

          return c.json(
            PromoteRecoveryPendingUserTurnToInterruptResponseSchema.parse({
              promoted: Boolean(promoted),
              turn: store.getTurn(workspaceId, threadId, activeTurn.id),
            })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'recovery_pending_user_turn_interrupt_failed',
          400
        );
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/pending-user-turns/:requestId/cancel',
    (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const requestId = c.req.param('requestId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          return c.json(
            CancelRecoveryPendingUserTurnResponseSchema.parse({
              cancelled: Boolean(
                cancelPendingUserTurn(workspaceDb, { requestId, threadId, workspaceId })
              ),
            })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'recovery_pending_user_turn_cancel_failed',
          400
        );
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/interrupted-worker/:turnId/retry',
    (c) => {
      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const turnId = c.req.param('turnId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId);

          if (!checkpoint) {
            return c.json(
              RetryInterruptedWorkerCheckpointResponseSchema.parse({
                retried: false,
                turn: null,
              })
            );
          }

          if (
            checkpoint.goalId &&
            checkpoint.taskId &&
            (!getGoalRecord(workspaceDb, workspaceId, threadId, checkpoint.goalId) ||
              !listGoalTasks(workspaceDb, {
                goalId: checkpoint.goalId,
                threadId,
                workspaceId,
              }).some((task) => task.taskId === checkpoint.taskId))
          ) {
            return asApiError(
              'Interrupted worker checkpoint has missing goal task lineage.',
              'recovery_retry_lineage_unavailable',
              409
            );
          }

          const now = new Date().toISOString();
          const turn = store.updateTurn(turnId, {
            completedAt: now,
            error: {
              code: 'worker_checkpoint_retry',
              message: 'Interrupted worker checkpoint was queued for retry.',
            },
            status: 'interrupted',
          });

          updateWorkerCheckpoint(workspaceDb, {
            diagnosticsSummary: 'Interrupted worker checkpoint queued for retry.',
            stage: 'aborted',
            stopReason: 'aborted',
            threadId,
            turnId,
            workspaceId,
          });

          if (checkpoint.goalId && checkpoint.taskId) {
            updateGoalTask(workspaceDb, {
              goalId: checkpoint.goalId,
              status: 'ready',
              taskId: checkpoint.taskId,
              threadId,
              workspaceId,
            });
            updateGoalStatus(workspaceDb, {
              currentTaskId: checkpoint.taskId,
              goalId: checkpoint.goalId,
              status: 'running',
              threadId,
              workspaceId,
            });
          }

          clearWorkerCheckpointAfterTerminalState(workspaceDb, {
            terminalStage: 'aborted',
            threadId,
            turnId,
            workspaceId,
          });

          return c.json(
            RetryInterruptedWorkerCheckpointResponseSchema.parse({
              retried: true,
              turn,
            })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError((error as Error).message, 'recovery_retry_failed', 400);
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/recovery/interrupted-worker/:turnId/terminal',
    async (c) => {
      const parsed = ClearInterruptedWorkerCheckpointRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      try {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const turnId = c.req.param('turnId');
        const store = requestStore(c);

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        if (!options.coreDb) {
          return asApiError(
            'Recovery storage is unavailable for this NanoCore instance.',
            'recovery_storage_unavailable',
            503
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          return c.json(
            ClearInterruptedWorkerCheckpointResponseSchema.parse({
              cleared: clearWorkerCheckpointAfterTerminalState(workspaceDb, {
                workspaceId,
                threadId,
                turnId,
                terminalStage: parsed.data.terminalStage,
              }),
            })
          );
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asApiError((error as Error).message, 'recovery_clear_failed', 400);
      }
    }
  );

  app.post('/api/app/workspaces/:workspaceId/agents/health/refresh', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');

      return c.json(
        AgentHealthRefreshResponseSchema.parse({
          items: requestStore(c).refreshAgentHealth(workspaceId),
          sessions: (turnExecutor.refreshAgentSessions?.(requestStore(c), workspaceId) ?? []).map(
            (session) => {
              const storedSession = findStoredAgentSessionById(
                requestStore(c),
                workspaceId,
                session.id
              );
              const configVersion = storedSession?.configVersion ?? session.configVersion ?? null;
              const workspaceRoots = storedSession?.workspaceRoots ?? session.workspaceRoots ?? [];

              return {
                ...session,
                configVersion,
                workspaceRoots,
                stale: configVersion !== null && configVersion < runtimeConfig().version,
              };
            }
          ),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'agent_health_refresh_failed');
    }
  });

  app.get('/api/workspaces', (c) => {
    try {
      const items = visibleWorkspacesForActor(c.get('actor'), requestStore(c).listWorkspaces());

      return c.json(ListWorkspacesResponseSchema.parse({ items }));
    } catch (error) {
      return asApiError((error as Error).message, 'workspace_list_failed', 500);
    }
  });

  app.post('/api/workspaces', async (c) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspace = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace.create',
        requestId: parsed.data.requestId,
        scope: {},
        input: parsed.data,
        responseKind: 'workspace',
        execute: () => {
          const workspace = WorkspaceRecordSchema.parse(store.createWorkspace(parsed.data.name));
          if (options.coreDb) {
            recordWorkspaceOwnerMembership({
              coreDb: options.coreDb,
              ownerUserId: c.get('actor').userId,
              workspaceId: workspace.id,
            });
          }

          return workspace;
        },
        replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(workspace, 201);
    } catch (error) {
      return asCommandError(error, 'workspace_create_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId', (c) => {
    try {
      return c.json(
        WorkspaceRecordSchema.parse(requestStore(c).getWorkspace(c.req.param('workspaceId')))
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/resources', (c) => {
    try {
      return c.json(
        WorkspaceResourcesResponseSchema.parse(
          requestStore(c).getWorkspaceResources(c.req.param('workspaceId'))
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.patch('/api/workspaces/:workspaceId', async (c) => {
    const parsed = UpdateWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspace = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace.update',
        requestId: parsed.data.requestId,
        scope: { workspaceId },
        input: { ...parsed.data, workspaceId },
        responseKind: 'workspace',
        execute: () =>
          WorkspaceRecordSchema.parse(
            store.updateWorkspace(workspaceId, omitUndefined(parsed.data))
          ),
        replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(workspace);
    } catch (error) {
      return asCommandError(error, 'workspace_update_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/knowledge', (c) => {
    try {
      return c.json(
        ListKnowledgeResponseSchema.parse({
          items: requestStore(c).listKnowledge(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/knowledge', async (c) => {
    const parsed = CreateKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const knowledge = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.create',
        requestId: parsed.data.requestId,
        scope: { workspaceId },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge',
        execute: () =>
          KnowledgeEntrySchema.parse(store.createKnowledgeEntry(workspaceId, parsed.data)),
        replay: (record) =>
          KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.entry.create',
        operation: 'knowledge.entry.create',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge entry ${knowledge.id} created.`,
        usageSource: 'knowledge-entry-create',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(knowledge, 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_create_failed');
    }
  });

  app.patch('/api/workspaces/:workspaceId/knowledge/:knowledgeEntryId', async (c) => {
    const parsed = UpdateKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const knowledgeEntryId = c.req.param('knowledgeEntryId');
      const knowledge = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.update',
        requestId: parsed.data.requestId,
        scope: { workspaceId, knowledgeEntryId },
        input: { ...parsed.data, workspaceId, knowledgeEntryId },
        responseKind: 'knowledge',
        execute: () =>
          KnowledgeEntrySchema.parse(
            store.updateKnowledgeEntry(workspaceId, knowledgeEntryId, omitUndefined(parsed.data))
          ),
        replay: (record) =>
          KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.entry.update',
        operation: 'knowledge.entry.update',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge entry ${knowledge.id} updated.`,
        usageSource: 'knowledge-entry-update',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(knowledge);
    } catch (error) {
      return asCommandError(error, 'knowledge_update_failed');
    }
  });

  app.delete('/api/workspaces/:workspaceId/knowledge/:knowledgeEntryId', async (c) => {
    const parsed = DeleteKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const knowledgeEntryId = c.req.param('knowledgeEntryId');

      await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.delete',
        requestId: parsed.data.requestId,
        scope: { workspaceId, knowledgeEntryId },
        input: { ...parsed.data, workspaceId, knowledgeEntryId },
        responseKind: 'knowledge',
        execute: () => {
          store.deleteKnowledgeEntry(workspaceId, knowledgeEntryId);
        },
        replay: () => undefined,
        responseId: () => knowledgeEntryId,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.entry.delete',
        operation: 'knowledge.entry.delete',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge entry ${knowledgeEntryId} deleted.`,
        usageSource: 'knowledge-entry-delete',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.body(null, 204);
    } catch (error) {
      return asCommandError(error, 'knowledge_delete_failed');
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/sources', async (c) => {
    const parsed = RegisterKnowledgeSourceRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const source = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.source.register',
        requestId: parsed.data.requestId,
        scope: { workspaceId, title: parsed.data.title },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_source',
        execute: () =>
          store.createKnowledgeSource(
            {
              id: `ks_${randomUUID()}`,
              workspaceId,
              kind: parsed.data.kind,
              title: parsed.data.title,
              uri: parsed.data.uri ?? null,
              contentDigest: `sha256:${createHash('sha256')
                .update(parsed.data.content)
                .digest('hex')}`,
              originatingThreadId: parsed.data.originatingThreadId ?? null,
              originatingTurnId: parsed.data.originatingTurnId ?? null,
              originatingFileId: parsed.data.originatingFileId ?? null,
              capturedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            parsed.data.content
          ),
        replay: (record) => store.getKnowledgeSource(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.source.register',
        operation: 'knowledge.source.register',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge source ${source.id} registered.`,
        usageSource: 'knowledge-source-register',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(
        RegisterKnowledgeSourceResponseSchema.parse({
          source,
          derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
            workspaceId,
            source.id
          ),
        }),
        201
      );
    } catch (error) {
      return asCommandError(error, 'knowledge_source_register_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/knowledge/sources', (c) => {
    try {
      return c.json(
        ListKnowledgeSourcesResponseSchema.parse({
          items: requestStore(c).listKnowledgeSources(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_source_list_failed', 404);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/observations', async (c) => {
    const parsed = RecordKnowledgeObservationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const observedAt = parsed.data.observedAt ?? now;
      const observation = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.observation.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, summary: parsed.data.summary },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_observation',
        execute: () =>
          store.recordKnowledgeObservation({
            id: `ko_${randomUUID()}`,
            workspaceId,
            kind: parsed.data.kind,
            summary: parsed.data.summary,
            sourceReferences: parsed.data.sourceReferences,
            scope: parsed.data.scope,
            producer: parsed.data.producer,
            confidence: parsed.data.confidence,
            freshness: parsed.data.freshness,
            status: parsed.data.status,
            observedAt,
            createdAt: now,
          }),
        replay: (record) => store.getKnowledgeObservation(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.observation.record',
        operation: 'knowledge.observation.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge observation ${observation.id} recorded.`,
        usageSource: 'knowledge-observation-record',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(RecordKnowledgeObservationResponseSchema.parse({ observation }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_observation_record_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/knowledge/observations', (c) => {
    try {
      return c.json(
        ListKnowledgeObservationsResponseSchema.parse({
          items: requestStore(c).listKnowledgeObservations(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_observation_list_failed', 404);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/claims', async (c) => {
    const parsed = RecordKnowledgeClaimRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const claim = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.claim.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, statement: parsed.data.statement },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_claim',
        execute: () =>
          store.recordKnowledgeClaim({
            id: `kc_${randomUUID()}`,
            workspaceId,
            statement: parsed.data.statement,
            sourceReferences: parsed.data.sourceReferences,
            scope: parsed.data.scope,
            producer: parsed.data.producer,
            confidence: parsed.data.confidence,
            freshness: parsed.data.freshness,
            reviewState: parsed.data.reviewState,
            conflictStatus: parsed.data.conflictStatus,
            createdAt: now,
            updatedAt: now,
          }),
        replay: (record) => store.getKnowledgeClaim(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.claim.record',
        operation: 'knowledge.claim.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge claim ${claim.id} recorded.`,
        usageSource: 'knowledge-claim-record',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(RecordKnowledgeClaimResponseSchema.parse({ claim }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_claim_record_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/knowledge/claims', (c) => {
    try {
      return c.json(
        ListKnowledgeClaimsResponseSchema.parse({
          items: requestStore(c).listKnowledgeClaims(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_claim_list_failed', 404);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/claims/:claimId/promotion', async (c) => {
    const parsed = PromoteKnowledgeClaimRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const claim = store.getKnowledgeClaim(workspaceId, c.req.param('claimId'));

      if (
        claim.reviewState !== 'accepted' ||
        claim.freshness === 'stale' ||
        claim.conflictStatus !== 'none'
      ) {
        return asApiError(
          'Only accepted, current, non-conflicting claims can be promoted.',
          'knowledge_claim_not_promotable',
          409
        );
      }

      const now = new Date().toISOString();
      const proposal = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.claim.promote',
        requestId: parsed.data.requestId,
        scope: { workspaceId, claimId: claim.id },
        input: { ...parsed.data, workspaceId, claimId: claim.id },
        responseKind: 'knowledge_proposal',
        execute: () =>
          store.createKnowledgeProposal({
            createdAt: now,
            id: `kp_${randomUUID()}`,
            sourceClaimId: claim.id,
            status: 'pending',
            summary: claim.statement,
            title: `Claim: ${claim.statement}`,
            updatedAt: now,
            workspaceId,
          }),
        replay: (record) => {
          const replayed = store.getKnowledgeProposal(record.response.id);

          if (!replayed) {
            throw new Error(`Knowledge proposal not found: ${record.response.id}`);
          }

          return replayed;
        },
        responseId: (result) => result.id,
      });
      const draft = draftKnowledgeProposal({
        operationId: `km_claim_promotion_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        proposal,
        sourceReferences: claim.sourceReferences,
        entries: store.listKnowledge(workspaceId),
        sources: store.listKnowledgeSources(workspaceId),
        confidence: claim.confidence,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.claim.promote',
        operation: 'knowledge.claim.promote',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge claim ${claim.id} promoted to proposal ${proposal.id}.`,
        usageSource: 'knowledge-claim-promote',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(PromoteKnowledgeClaimResponseSchema.parse({ claim, draft }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_claim_promote_failed');
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/conflicts', async (c) => {
    const parsed = RecordKnowledgeConflictRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const conflict = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.conflict.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, summary: parsed.data.summary },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_conflict',
        execute: () =>
          store.recordKnowledgeConflict({
            id: `kf_${randomUUID()}`,
            workspaceId,
            subjectReferences: parsed.data.subjectReferences,
            sourceReferences: parsed.data.sourceReferences,
            status: parsed.data.status,
            summary: parsed.data.summary,
            suggestedActions: parsed.data.suggestedActions,
            producer: parsed.data.producer,
            createdAt: now,
            updatedAt: now,
          }),
        replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.conflict.record',
        operation: 'knowledge.conflict.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge conflict ${conflict.id} recorded.`,
        usageSource: 'knowledge-conflict-record',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(RecordKnowledgeConflictResponseSchema.parse({ conflict }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_conflict_record_failed');
    }
  });

  app.get('/api/app/workspaces/:workspaceId/knowledge/conflicts', (c) => {
    try {
      return c.json(
        ListKnowledgeConflictsResponseSchema.parse({
          items: requestStore(c).listKnowledgeConflicts(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_conflict_list_failed', 404);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution',
    async (c) => {
      const parsed = ResolveKnowledgeConflictRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      try {
        const store = requestStore(c);
        const workspaceId = c.req.param('workspaceId');
        const conflictId = c.req.param('conflictId');
        const now = new Date().toISOString();
        const conflict = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.conflict.resolve',
          requestId: parsed.data.requestId,
          scope: { workspaceId, conflictId },
          input: { ...parsed.data, workspaceId, conflictId },
          responseKind: 'knowledge_conflict',
          execute: () =>
            store.resolveKnowledgeConflict({
              workspaceId,
              conflictId,
              status: parsed.data.status,
              resolution: parsed.data.resolution,
              resolvedBy: parsed.data.resolvedBy,
              resolvedAt: now,
            }),
          replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        recordKnowledgeGatewayUsage({
          capabilityId: 'knowledge.conflict.resolve',
          operation: 'knowledge.conflict.resolve',
          requestId: parsed.data.requestId,
          serviceRef: 'knowledge-store',
          store,
          summary: `Knowledge conflict ${conflict.id} resolved.`,
          usageSource: 'knowledge-conflict-resolve',
          workspaceId,
          ...(options.coreDb ? { coreDb: options.coreDb } : {}),
        });

        return c.json(ResolveKnowledgeConflictResponseSchema.parse({ conflict }));
      } catch (error) {
        return asCommandError(error, 'knowledge_conflict_resolve_failed');
      }
    }
  );

  app.get('/api/app/workspaces/:workspaceId/knowledge/indexes', (c) => {
    try {
      const store = requestStore(c);
      const dataRoot = store.getDataRoot();

      if (!dataRoot) {
        return asApiError(
          'Knowledge indexes require a file-backed data root.',
          'data_root_required',
          409
        );
      }

      return c.json(
        KnowledgeDerivedIndexesResponseSchema.parse(
          readWorkspaceKnowledgeDerivedIndexes({
            dataRoot,
            userId: store.getUserId(),
            workspaceId: c.req.param('workspaceId'),
          })
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_indexes_read_failed', 404);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/retrievals', async (c) => {
    const parsed = RetrieveKnowledgeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const dataRoot = store.getDataRoot();
      const workspaceId = c.req.param('workspaceId');

      if (!dataRoot) {
        return asApiError(
          'Knowledge retrieval requires a file-backed data root.',
          'data_root_required',
          409
        );
      }

      const response = KnowledgeRetrievalResponseSchema.parse(
        retrieveWorkspaceKnowledge({
          dataRoot,
          userId: store.getUserId(),
          workspaceId,
          query: parsed.data.query,
          limit: parsed.data.limit,
          pinnedConceptIds: parsed.data.pinnedConceptIds,
          traceId: `krt_${randomUUID()}`,
        })
      );
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.retrieval',
        operation: 'knowledge.retrieval',
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge retrieval selected ${response.selected.length} candidates.`,
        usageSource: 'knowledge-retrieval',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(response);
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_retrieval_failed', 404);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/knowledge/sources/:sourceId', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const sourceId = c.req.param('sourceId');
      const response = ReadKnowledgeSourceResponseSchema.parse({
        source: store.getKnowledgeSource(workspaceId, sourceId),
        derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
          workspaceId,
          sourceId
        ),
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.source.read',
        operation: 'knowledge.source.read',
        serviceRef: 'knowledge-store',
        store,
        summary: `Knowledge source ${sourceId} read.`,
        usageSource: 'knowledge-source-read',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(response);
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_source_not_found', 404);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/manager/answer', async (c) => {
    const parsed = KnowledgeManagerAnswerRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const response = answerKnowledgeManager({
        operationId: `km_answer_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        query: parsed.data.query,
        limit: parsed.data.limit,
        entries: store.listKnowledge(workspaceId),
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.answer',
        operation: 'knowledge.answer',
        serviceRef: 'knowledge-manager',
        store,
        summary: `Knowledge answer completed with ${response.citations.length} citations.`,
        usageSource: 'knowledge-answer',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(KnowledgeManagerAnswerResponseSchema.parse(response));
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_manager_answer_failed', 500);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/manager/context', async (c) => {
    const parsed = KnowledgeManagerPrepareContextRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceRoots =
        (parsed.data.workspaceRootFiles ?? []).length > 0
          ? workspaceRootsForContextPackage(store, workspaceId)
          : [];
      const response = prepareKnowledgeContext({
        operationId: `km_context_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        query: parsed.data.query,
        limit: parsed.data.limit,
        entries: store.listKnowledge(workspaceId),
        claims: store.listKnowledgeClaims(workspaceId),
        conflicts: store.listKnowledgeConflicts(workspaceId),
        artifacts: parsed.data.artifactIds.map((artifactId) =>
          store.getArtifact(workspaceId, artifactId)
        ),
        workspaceFiles: (parsed.data.workspaceFiles ?? []).map(({ path }) => {
          const file = store.readWorkspaceContextFileMaterial(workspaceId, path);

          return {
            contentBytes: file.contentBytes,
            contentDigest: file.contentDigest,
            path: file.path,
          };
        }),
        workspaceRootFiles: (parsed.data.workspaceRootFiles ?? []).map(({ rootId, path }) => {
          const root = workspaceRoots.find((candidate) => candidate.id === rootId);

          if (!root) {
            throw new Error(`Workspace root not available for context file: ${rootId}`);
          }

          const file = store.readWorkspaceRootContextFileMaterial(root, path);

          return {
            contentBytes: file.contentBytes,
            contentDigest: file.contentDigest,
            path: file.path,
            rootId: file.rootId,
          };
        }),
      });
      store.recordKnowledgeContextPackageTrace({
        id: response.packageTrace.contextPackageId,
        workspaceId,
        operationId: response.operationId,
        createdAt: new Date().toISOString(),
        response,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.context.prepare',
        operation: 'knowledge.context.prepare',
        serviceRef: 'knowledge-manager',
        store,
        summary: `Knowledge context prepared ${response.packageTrace.selectedKnowledgeEntryIds.length} knowledge entries.`,
        usageSource: 'knowledge-context-prepare',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(KnowledgeManagerPrepareContextResponseSchema.parse(response));
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_manager_context_failed', 500);
    }
  });

  app.get(
    '/api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId',
    async (c) => {
      try {
        const trace = requestStore(c).readKnowledgeContextPackageTrace(
          c.req.param('workspaceId'),
          c.req.param('contextPackageId')
        );

        if (!trace) {
          return asApiError(
            'Knowledge context package trace not found.',
            'knowledge_context_package_trace_not_found',
            404
          );
        }

        return c.json(ReadKnowledgeManagerContextPackageTraceResponseSchema.parse({ trace }));
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'knowledge_context_package_trace_read_failed',
          500
        );
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization',
    async (c) => {
      try {
        const store = requestStore(c);
        const trace = store.readKnowledgeContextPackageTrace(
          c.req.param('workspaceId'),
          c.req.param('contextPackageId')
        );

        if (!trace) {
          return asApiError(
            'Knowledge context package trace not found.',
            'knowledge_context_package_trace_not_found',
            404
          );
        }

        const workspaceRoots =
          (trace.response.workspaceRootFiles ?? []).length > 0
            ? workspaceRootsForContextPackage(store, trace.workspaceId)
            : [];

        return c.json(
          MaterializeKnowledgeContextPackageResponseSchema.parse(
            store.materializeKnowledgeContextPackageTrace(trace, { workspaceRoots })
          )
        );
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'knowledge_context_package_materialization_failed',
          500
        );
      }
    }
  );

  app.get(
    '/api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization',
    async (c) => {
      try {
        const materialization = requestStore(c).readKnowledgeContextPackageMaterialization(
          c.req.param('workspaceId'),
          c.req.param('contextPackageId')
        );

        if (!materialization) {
          return asApiError(
            'Knowledge context package materialization not found.',
            'knowledge_context_package_materialization_not_found',
            404
          );
        }

        return c.json(MaterializeKnowledgeContextPackageResponseSchema.parse(materialization));
      } catch (error) {
        return asApiError(
          (error as Error).message,
          'knowledge_context_package_materialization_read_failed',
          500
        );
      }
    }
  );

  app.post('/api/app/workspaces/:workspaceId/knowledge/manager/proposals', async (c) => {
    const parsed = KnowledgeManagerDraftProposalRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const proposalId = `kp_${randomUUID()}`;
      const proposal = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.proposal.draft',
        requestId: parsed.data.requestId,
        scope: { workspaceId, title: parsed.data.title },
        input: parsed.data,
        responseKind: 'knowledge_proposal',
        execute: () =>
          store.createKnowledgeProposal({
            createdAt: now,
            id: proposalId,
            status: 'pending',
            summary: parsed.data.summary,
            title: parsed.data.title,
            updatedAt: now,
            workspaceId,
          }),
        replay: (record) => {
          const replayed = store.getKnowledgeProposal(record.response.id);

          if (!replayed) {
            throw new Error(`Knowledge proposal not found: ${record.response.id}`);
          }

          return replayed;
        },
        responseId: (result) => result.id,
      });
      const response = draftKnowledgeProposal({
        operationId: `km_proposal_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        proposal,
        sourceReferences: parsed.data.sourceReferences,
        entries: store.listKnowledge(workspaceId),
        sources: store.listKnowledgeSources(workspaceId),
        confidence: parsed.data.confidence,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.proposal.draft',
        operation: 'knowledge.proposal.draft',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-manager',
        store,
        summary: `Knowledge proposal ${proposal.id} drafted.`,
        usageSource: 'knowledge-proposal-draft',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(KnowledgeManagerDraftProposalResponseSchema.parse(response));
    } catch (error) {
      return asCommandError(error, 'knowledge_manager_proposal_draft_failed');
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/manager/repairs', async (c) => {
    const parsed = KnowledgeManagerSuggestRepairRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const response = suggestKnowledgeRepairs({
        operationId: `km_repair_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        entries: store.listKnowledge(workspaceId),
        limit: parsed.data.limit,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.repair.suggest',
        operation: 'knowledge.repair.suggest',
        serviceRef: 'knowledge-manager',
        store,
        summary: `Knowledge repair suggestions returned ${response.suggestions.length} suggestions.`,
        usageSource: 'knowledge-repair-suggest',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(KnowledgeManagerSuggestRepairResponseSchema.parse(response));
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_manager_repair_suggest_failed', 500);
    }
  });

  app.post('/api/app/workspaces/:workspaceId/knowledge/manager/health', async (c) => {
    const parsed = KnowledgeManagerHealthCheckRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const response = checkKnowledgeHealth({
        operationId: `km_health_${randomUUID()}`,
        workspaceId,
        caller: parsed.data.caller,
        entries: store.listKnowledge(workspaceId),
        limit: parsed.data.limit,
      });
      recordKnowledgeGatewayUsage({
        capabilityId: 'knowledge.health.check',
        operation: 'knowledge.health.check',
        serviceRef: 'knowledge-manager',
        store,
        summary: `Knowledge health completed with ${response.checks.length} checks.`,
        usageSource: 'knowledge-health-check',
        workspaceId,
        ...(options.coreDb ? { coreDb: options.coreDb } : {}),
      });

      return c.json(KnowledgeManagerHealthCheckResponseSchema.parse(response));
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_manager_health_check_failed', 500);
    }
  });

  app.get('/api/workspaces/:workspaceId/threads', (c) => {
    try {
      return c.json(
        ListThreadsResponseSchema.parse({
          items: requestStore(c).listThreads(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/threads', async (c) => {
    const parsed = CreateThreadRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      workspaceId: c.req.param('workspaceId'),
    });

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const input = parsed.data;
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.create',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId },
        input,
        responseKind: 'thread',
        execute: () => ThreadSchema.parse(store.createThread(input.workspaceId, input.name)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread, 201);
    } catch (error) {
      return asCommandError(error, 'thread_create_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/threads/:threadId', (c) => {
    try {
      return c.json(
        ThreadSchema.parse(
          requestStore(c).getThread(c.req.param('workspaceId'), c.req.param('threadId'))
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.patch('/api/workspaces/:workspaceId/threads/:threadId', async (c) => {
    try {
      const parsed = UpdateThreadRequestSchema.safeParse({
        ...(await c.req.json().catch(() => ({}))),
        workspaceId: c.req.param('workspaceId'),
        threadId: c.req.param('threadId'),
      });
      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }
      const input = parsed.data;
      const updates: { name?: string | null; status?: 'active' | 'archived' } = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }
      const store = requestStore(c);
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.update',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'thread',
        execute: () =>
          ThreadSchema.parse(store.updateThread(input.workspaceId, input.threadId, updates)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread);
    } catch (error) {
      return asCommandError(error, 'thread_update_failed');
    }
  });

  app.post('/api/workspaces/:workspaceId/threads/:threadId/archive', async (c) => {
    try {
      const parsed = ArchiveThreadRequestSchema.safeParse({
        ...(await c.req.json().catch(() => ({}))),
        workspaceId: c.req.param('workspaceId'),
        threadId: c.req.param('threadId'),
      });
      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }
      const input = parsed.data;
      const store = requestStore(c);
      const thread = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'thread.archive',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'thread',
        execute: () => ThreadSchema.parse(store.archiveThread(input.workspaceId, input.threadId)),
        replay: (record) =>
          ThreadSchema.parse(store.getThread(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(thread);
    } catch (error) {
      return asCommandError(error, 'thread_archive_failed');
    }
  });

  app.post('/api/turns', async (c) => {
    const parsed = SubmitTurnInputRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const store = requestStore(c);
      if (input.turnId) {
        const turnId = input.turnId;
        const turn = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'turn.input.submit',
          requestId: input.requestId,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId,
          },
          input,
          responseKind: 'turn',
          execute: async () => {
            const currentTurn = store.getTurn(input.workspaceId, input.threadId, turnId);

            if (!isAwaitingUserInputGate(currentTurn)) {
              throw new TurnStartValidationError(
                'turn_not_awaiting_user_input',
                `Turn is not awaiting user input: ${turnId}.`
              );
            }

            const updatedTurn = await turnExecutor.respondUserInput?.(store, turnId, input.input, {
              requestId: input.requestId,
            });

            if (!updatedTurn) {
              throw new Error('The active agent runtime cannot respond to user input.');
            }

            return TurnSchema.parse(updatedTurn);
          },
          replay: (record) =>
            TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, record.response.id)),
          responseId: (result) => result.id,
        });

        completeSchedulerLeaseForTerminalTurn(options.coreDb, turn);

        return c.json(turn, 202);
      }

      assertProjectWorkspace(store.getWorkspace(input.workspaceId), 'start worker turns');

      const snapshot = runtimeConfig();
      const repository = resolveWorkspaceRepositoryForTurn(
        options.coreDb,
        input.workspaceId,
        store.getUserId()
      );
      const workspaceRoots = materializeWorkspaceRootsForTurn(
        snapshot,
        store,
        input.workspaceId,
        repository
      );
      const workspaceSourceContext = workspaceSourceContextForTurn(
        snapshot,
        store,
        input.workspaceId,
        repository,
        workspaceRoots
      );
      const workspaceCwd = repository?.localPath ?? null;
      const turn = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'turn.start',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'turn',
        execute: async () => {
          const handle = await startProductTurn({
            input,
            schedulerEpoch,
            snapshot,
            store,
            turnExecutor,
            workspaceCwd,
            workspaceRoots,
            workspaceSourceContext,
            ...(options.coreDb ? { coreDb: options.coreDb } : {}),
          });

          return TurnSchema.parse(handle.turn);
        },
        replay: (record) =>
          TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(turn, 202);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        return asCommandError(error, 'turn_start_failed');
      }

      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'turn_start_failed');
    }
  });

  app.post('/api/turns/:turnId/feedback', async (c) => {
    const parsed = UpdateTurnFeedbackRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return c.json(
        apiErrorPayload({
          code: 'invalid_feedback',
          message: z.prettifyError(parsed.error),
        }),
        400
      );
    }

    try {
      return c.json(updateTurnFeedback(requestStore(c), c.req.param('turnId'), parsed.data));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/threads/:threadId/turns/:turnId', (c) => {
    try {
      return c.json(
        TurnSchema.parse(
          requestStore(c).getTurn(
            c.req.param('workspaceId'),
            c.req.param('threadId'),
            c.req.param('turnId')
          )
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt', async (c) => {
    try {
      const parsed = InterruptTurnRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const turnId = c.req.param('turnId');
      const turn = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'turn.interrupt',
        requestId: parsed.data.requestId,
        scope: {
          workspaceId: c.req.param('workspaceId'),
          threadId: c.req.param('threadId'),
          turnId,
        },
        input: {
          ...parsed.data,
          workspaceId: c.req.param('workspaceId'),
          threadId: c.req.param('threadId'),
          turnId,
        },
        responseKind: 'turn',
        execute: async () => {
          await turnExecutor.interruptTurn(store, turnId, {
            requestId: parsed.data.requestId,
          });
          return TurnSchema.parse(
            store.getTurn(c.req.param('workspaceId'), c.req.param('threadId'), turnId)
          );
        },
        replay: (record) =>
          TurnSchema.parse(
            store.getTurn(c.req.param('workspaceId'), c.req.param('threadId'), record.response.id)
          ),
        responseId: (result) => result.id,
      });

      return c.json(turn);
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }
  });

  app.post('/api/approvals/:approvalRequestId/respond', async (c) => {
    const parsed = RespondToApprovalRequestSchema.safeParse({
      ...(await c.req.json().catch(() => ({}))),
      approvalRequestId: c.req.param('approvalRequestId'),
    });

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const store = requestStore(c);
      if (options.coreDb) {
        const workspaceDb = repositoryWorkspaceDb(store, input.workspaceId);
        try {
          const policyApproval =
            readPolicyApprovalDecision(
              workspaceDb,
              input.workspaceId,
              input.approvalRequestId,
              'repo.push'
            ) ??
            readPolicyApprovalDecision(
              workspaceDb,
              input.workspaceId,
              input.approvalRequestId,
              'mcp.call'
            );

          if (policyApproval) {
            const approval = store.getApproval(input.approvalRequestId);

            if (
              approval.workspaceId !== input.workspaceId ||
              approval.threadId !== input.threadId ||
              approval.turnId !== input.turnId
            ) {
              throw new Error(`Approval request scope mismatch: ${input.approvalRequestId}`);
            }

            if (approval.status !== 'pending') {
              return c.json(ApprovalRequestSchema.parse(approval));
            }

            const timestamp = new Date().toISOString();
            recordProductPermissionDecision({
              workspaceDb,
              decisionId: `pd_repo_push_${input.decision}_${input.approvalRequestId}`,
              ownerScope: 'workspace',
              workspaceId: input.workspaceId,
              policyEngineVersion: 'nanocore-approval-policy:v1',
              policySnapshotId: 'policy_snapshot_runtime',
              subjectSummary: policyApproval.subjectSummary,
              action: policyApproval.action,
              resourceSummary: policyApproval.resourceSummary,
              contextSummary: {
                ...((policyApproval.contextSummary ?? {}) as Record<string, unknown>),
                requestId: input.requestId,
              },
              result: input.decision === 'granted' ? 'allow' : 'deny',
              reasonCode:
                policyApproval.action === 'mcp.call'
                  ? input.decision === 'granted'
                    ? 'mcp_call_approved'
                    : 'mcp_call_denied'
                  : input.decision === 'granted'
                    ? 'repo_push_approved'
                    : 'repo_push_denied',
              enforcementPoint:
                policyApproval.action === 'mcp.call'
                  ? 'mcp.call.approval_response'
                  : 'repo.push.approval_response',
              approvalId: input.approvalRequestId,
            });

            const updatedApproval = store.updateApproval(input.approvalRequestId, {
              status: input.decision,
              resolvedAt: timestamp,
            });
            store.createItem({
              id: `it_approval_decision_${input.approvalRequestId}`,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              turnId: input.turnId,
              type: 'approval-decision',
              status: 'completed',
              approvalRequestId: input.approvalRequestId,
              decision: input.decision,
              createdAt: timestamp,
              completedAt: timestamp,
            });
            store.updateTurn(input.turnId, { status: 'running', humanGate: null });

            return c.json(ApprovalRequestSchema.parse(updatedApproval));
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      if (!turnExecutor.capabilities.approvals) {
        return c.json(
          apiErrorPayload({
            code: 'approvals_not_supported',
            message: 'The active agent runtime does not support approvals.',
          }),
          501
        );
      }

      const approval = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'approval.respond',
        requestId: input.requestId,
        scope: {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId: input.turnId,
          approvalRequestId: input.approvalRequestId,
        },
        input,
        responseKind: 'approval',
        execute: async () => {
          const updatedApproval = await turnExecutor.respondApproval?.(
            store,
            input.approvalRequestId,
            input.decision,
            { requestId: input.requestId }
          );

          if (!updatedApproval) {
            throw new Error('The active agent runtime cannot respond to approvals.');
          }

          return ApprovalRequestSchema.parse(updatedApproval);
        },
        replay: (record) => ApprovalRequestSchema.parse(store.getApproval(record.response.id)),
        responseId: (result) => result.id,
      });

      completeSchedulerLeaseForTerminalTurn(
        options.coreDb,
        TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, input.turnId))
      );

      return c.json(approval);
    } catch (error) {
      return asCommandError(error, 'approval_response_failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts', (c) => {
    try {
      return c.json(
        ListArtifactsResponseSchema.parse({
          items: requestStore(c).listArtifacts(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId', (c) => {
    try {
      return c.json(
        requestStore(c).getArtifact(c.req.param('workspaceId'), c.req.param('artifactId'))
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/reviews', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        materializeWorkspaceSyncReviewArtifacts(store.listArtifacts(workspaceId), workspaceDb);
        const items = listWorkspaceSyncReviews(workspaceDb, workspaceId);
        await materializeWorkspaceReviewBranches({
          repository: getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId),
          reviews: items,
          store,
          workspaceDb,
        });

        return c.json(ListWorkspaceSyncReviewsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const reviewId = c.req.param('reviewId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let review: WorkspaceSyncReviewItem | null;
      try {
        materializeWorkspaceSyncReviewArtifacts(store.listArtifacts(workspaceId), workspaceDb);
        review = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);
        await materializeWorkspaceReviewBranches({
          repository: getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId),
          reviews: review ? [review] : [],
          store,
          workspaceDb,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!review) {
        return asApiError(`Workspace synchronization review not found: ${reviewId}`);
      }

      return c.json(GetWorkspaceSyncReviewResponseSchema.parse(review));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision',
    async (c) => {
      try {
        const parsed = SubmitWorkspaceSyncReviewDecisionRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        const store = requestStore(c);
        const workspaceId = c.req.param('workspaceId');
        const reviewId = c.req.param('reviewId');
        const input = parsed.data;

        if (!input.requestId) {
          return asApiError('requestId is required.', 'invalid_request', 400);
        }

        const requestId = input.requestId;
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'workspace_sync.review.decide',
          requestId,
          scope: { workspaceId, reviewId },
          input,
          responseKind: 'workspace_sync_review',
          execute: async () => {
            const decidedAt = new Date().toISOString();
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            let review: WorkspaceSyncReviewItem | null;
            try {
              materializeWorkspaceSyncReviewArtifacts(
                store.listArtifacts(workspaceId),
                workspaceDb
              );
              review = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);
            } finally {
              workspaceDb.sqlite.close();
            }

            if (!review) {
              throw new Error(`Workspace synchronization review not found: ${reviewId}`);
            }
            if (review.review.status !== 'pending') {
              throw new Error(`Workspace synchronization review is already resolved: ${reviewId}`);
            }

            let workspaceApplyResult: WorkspaceApplyResult | null = null;

            if (input.decision === 'accepted') {
              const applyPlanDb = repositoryWorkspaceDb(store, workspaceId);
              try {
                recordWorkspaceApplyPlanForReview(applyPlanDb, review, decidedAt);
              } finally {
                applyPlanDb.sqlite.close();
              }

              if (review.changeSet.strategy === 'filesystem') {
                const stagingDb = repositoryWorkspaceDb(store, workspaceId);
                try {
                  workspaceApplyResult = await applyWorkspaceSyncReviewFilesystem({
                    appliedAt: decidedAt,
                    workspaceDb: stagingDb,
                    review,
                  });
                } finally {
                  stagingDb.sqlite.close();
                }
              } else {
                const repositoryDb = repositoryWorkspaceDb(store, workspaceId);
                let repository: WorkspaceRepositoryResourceRecord | null;
                try {
                  repository = getDefaultWorkspaceRepositoryResource(repositoryDb, workspaceId);
                } finally {
                  repositoryDb.sqlite.close();
                }

                if (!repository) {
                  throw new Error('Workspace repository is not configured.');
                }

                if (repository.git.stagingStrategy === 'review-branch') {
                  await materializeWorkspaceReviewBranch(repository, review, store);
                }

                workspaceApplyResult = await applyWorkspaceSyncReviewPatch({
                  appliedAt: decidedAt,
                  repository,
                  review,
                  store,
                });
                await deleteWorkspaceReviewBranch(repository, review);
              }

              const applyResultDb = repositoryWorkspaceDb(store, workspaceId);
              try {
                workspaceApplyResult = recordWorkspaceApplyResult(applyResultDb, {
                  requestId,
                  result: workspaceApplyResult,
                });
              } finally {
                applyResultDb.sqlite.close();
              }
            }

            const updateDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              const updated = updateWorkspaceSyncReviewDecision(updateDb, {
                workspaceId,
                reviewId,
                status: input.decision,
                updatedAt: decidedAt,
              });

              return { review: updated.review, workspaceApplyResult };
            } finally {
              updateDb.sqlite.close();
            }
          },
          replay: (record) => {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              const review = getWorkspaceSyncReview(workspaceDb, workspaceId, record.response.id);

              if (!review) {
                throw new Error(`Workspace synchronization review not found: ${reviewId}`);
              }

              return {
                review: review.review,
                workspaceApplyResult:
                  review.review.status === 'accepted'
                    ? getWorkspaceApplyResult(workspaceDb, workspaceId, `war_${review.review.id}`)
                    : null,
              };
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.review.id,
        });

        return c.json(SubmitWorkspaceSyncReviewDecisionResponseSchema.parse(response));
      } catch (error) {
        return asCommandError(error, 'workspace_sync_review_failed');
      }
    }
  );

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/input-snapshots', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceInputSnapshots(workspaceDb, workspaceId);

        return c.json(ListWorkspaceInputSnapshotsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/materialization-records', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceMaterializationRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceMaterializationRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/backend-handles', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listBackendWorkspaceHandles(workspaceDb, workspaceId);

        return c.json(ListBackendWorkspaceHandlesResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/output-manifests', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkerOutputManifests(workspaceDb, workspaceId);

        return c.json(ListWorkerOutputManifestsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/change-sets', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceChangeSets(workspaceDb, workspaceId);

        return c.json(ListWorkspaceChangeSetsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/staged-reviews', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceSyncReviews(workspaceDb, workspaceId).map((item) => item.review);

        return c.json(ListStagedWorkspaceReviewsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/apply-plans', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceApplyPlans(workspaceDb, workspaceId);

        return c.json(ListWorkspaceApplyPlansResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/reconciliation-records', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceReconciliationRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceReconciliationRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/workspace-sync/reconciliation-records/:reconciliationRecordId/decision',
    async (c) => {
      try {
        const parsed = SubmitWorkspaceRecoveryDecisionRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        const store = requestStore(c);
        const workspaceId = c.req.param('workspaceId');
        const reconciliationRecordId = c.req.param('reconciliationRecordId');
        const input = parsed.data;

        if (!input.requestId) {
          return asApiError('requestId is required.', 'invalid_request', 400);
        }

        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'workspace_sync.recovery.decide',
          requestId: input.requestId,
          scope: { reconciliationRecordId, workspaceId },
          input,
          responseKind: 'workspace_sync_review',
          execute: () => {
            const decidedAt = new Date().toISOString();
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              return {
                reconciliationRecord: resolveWorkspaceReconciliationRecord({
                  workspaceDb,
                  workspaceId,
                  reconciliationRecordId,
                  decision: input.decision,
                  decidedAt,
                  workerOutputManifests: listWorkerOutputManifests(workspaceDb, workspaceId),
                  workspaceSyncEvidenceBundles: listWorkspaceSyncEvidenceBundles(
                    workspaceDb,
                    workspaceId
                  ),
                }),
              };
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          replay: (record) => {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              const reconciliationRecord = listWorkspaceReconciliationRecords(
                workspaceDb,
                workspaceId
              ).find((candidate) => candidate.id === record.response.id);

              if (!reconciliationRecord) {
                throw new Error(
                  `Workspace reconciliation record not found: ${reconciliationRecordId}`
                );
              }

              return { reconciliationRecord };
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.reconciliationRecord.id,
        });

        return c.json(SubmitWorkspaceRecoveryDecisionResponseSchema.parse(response));
      } catch (error) {
        return asCommandError(error, 'workspace_recovery_decision_failed');
      }
    }
  );

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/quarantine-records', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceQuarantineRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceQuarantineRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/evidence-bundles', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceSyncEvidenceBundles(workspaceDb, workspaceId);

        return c.json(ListWorkspaceSyncEvidenceBundlesResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/apply-results', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceApplyResults(workspaceDb, workspaceId);

        return c.json(ListWorkspaceApplyResultsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/workspace-sync/apply-results/:applyResultId', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const applyResultId = c.req.param('applyResultId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let result: WorkspaceApplyResult | null;
      try {
        result = getWorkspaceApplyResult(workspaceDb, workspaceId, applyResultId);
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!result) {
        return asApiError(`Workspace apply result not found: ${applyResultId}`);
      }

      return c.json(GetWorkspaceApplyResultResponseSchema.parse(result));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/agent-environment/snapshots', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listExportableAgentEnvironmentPackageSnapshots(workspaceDb, workspaceId);

        return c.json(ListAgentEnvironmentPackageSnapshotsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const snapshotId = c.req.param('snapshotId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const record = requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, snapshotId);

        return c.json(GetAgentEnvironmentPackageSnapshotResponseSchema.parse(record));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message, 'not_found', 404);
    }
  });

  app.patch('/api/workspaces/:workspaceId/artifacts/:artifactId', async (c) => {
    try {
      const parsed = UpdateArtifactMetadataRequestSchema.safeParse({
        ...(await c.req.json().catch(() => ({}))),
        workspaceId: c.req.param('workspaceId'),
        artifactId: c.req.param('artifactId'),
      });
      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }
      const input = parsed.data;
      const updates: {
        title?: string;
        status?: 'ready' | 'draft' | 'archived';
        summary?: string | null;
      } = {};
      if (input.title !== undefined) {
        updates.title = input.title;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }
      if (input.summary !== undefined) {
        updates.summary = input.summary;
      }
      const store = requestStore(c);
      const artifact = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'artifact.metadata.update',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, artifactId: input.artifactId },
        input,
        responseKind: 'artifact',
        execute: () => ArtifactSchema.parse(store.updateArtifact(input.artifactId, updates)),
        replay: (record) =>
          ArtifactSchema.parse(store.getArtifact(input.workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });

      return c.json(artifact);
    } catch (error) {
      return asCommandError(error, 'artifact_update_failed');
    }
  });

  app.post('/api/app/workspaces/:workspaceId/artifacts/:artifactId/review', async (c) => {
    try {
      const parsed = SubmitArtifactReviewDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const artifact = store.getArtifact(workspaceId, c.req.param('artifactId'));
      const input = parsed.data;

      if (!input.requestId) {
        return asApiError('requestId is required.', 'invalid_request', 400);
      }

      const requestId = input.requestId;
      const review = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'artifact.review.decide',
        requestId,
        scope: { workspaceId, artifactId: artifact.id },
        input,
        responseKind: 'artifact_review',
        execute: async () => {
          const message = input.message ?? null;
          const decidedAt = new Date().toISOString();
          let followUpTurnId: string | null = null;
          let workspaceApplyResult: WorkspaceApplyResult | null = null;

          if (
            artifact.threadId &&
            (input.decision === 'needs_refinement' || input.decision === 'redo')
          ) {
            const followUpText =
              message ??
              (input.decision === 'redo'
                ? `Redo artifact ${artifact.title}.`
                : `Refine artifact ${artifact.title}.`);
            const followUpTurn = store.createTurn(workspaceId, artifact.threadId, followUpText);

            store.createItem({
              id: `it_artifact_review_${followUpTurn.id}`,
              workspaceId,
              threadId: artifact.threadId,
              turnId: followUpTurn.id,
              type: 'user-message',
              status: 'completed',
              text: followUpText,
              createdAt: decidedAt,
              completedAt: decidedAt,
            });
            followUpTurnId = followUpTurn.id;
          }

          const workspaceReview = parseWorkspaceSyncReviewArtifact(artifact);

          if (workspaceReview && input.decision === 'accepted') {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            let durableWorkspaceReview: WorkspaceSyncReviewItem;
            try {
              durableWorkspaceReview = recordWorkspaceSyncReview(workspaceDb, {
                item: workspaceReview,
              });
            } finally {
              workspaceDb.sqlite.close();
            }

            if (durableWorkspaceReview.changeSet.strategy === 'filesystem') {
              const applyPlanDb = repositoryWorkspaceDb(store, workspaceId);
              try {
                recordWorkspaceApplyPlanForReview(applyPlanDb, durableWorkspaceReview, decidedAt);
              } finally {
                applyPlanDb.sqlite.close();
              }

              const stagingDb = repositoryWorkspaceDb(store, workspaceId);
              try {
                workspaceApplyResult = await applyWorkspaceSyncReviewFilesystem({
                  appliedAt: decidedAt,
                  workspaceDb: stagingDb,
                  review: durableWorkspaceReview,
                });
              } finally {
                stagingDb.sqlite.close();
              }
            } else {
              const repositoryDb = repositoryWorkspaceDb(store, workspaceId);
              let repository: WorkspaceRepositoryResourceRecord | null;
              try {
                repository = getDefaultWorkspaceRepositoryResource(repositoryDb, workspaceId);
              } finally {
                repositoryDb.sqlite.close();
              }

              if (!repository) {
                throw new Error('Workspace repository is not configured.');
              }

              const applyPlanDb = repositoryWorkspaceDb(store, workspaceId);
              try {
                recordWorkspaceApplyPlanForReview(applyPlanDb, durableWorkspaceReview, decidedAt);
              } finally {
                applyPlanDb.sqlite.close();
              }

              if (repository.git.stagingStrategy === 'review-branch') {
                await materializeWorkspaceReviewBranch(repository, durableWorkspaceReview, store);
              }

              workspaceApplyResult = await applyWorkspaceSyncReviewPatch({
                appliedAt: decidedAt,
                repository,
                review: durableWorkspaceReview,
                store,
              });
              await deleteWorkspaceReviewBranch(repository, durableWorkspaceReview);
            }

            const applyResultDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              workspaceApplyResult = recordWorkspaceApplyResult(applyResultDb, {
                requestId,
                result: workspaceApplyResult,
              });
            } finally {
              applyResultDb.sqlite.close();
            }
          }

          const review = store.recordArtifactReviewDecision({
            artifactId: artifact.id,
            workspaceId,
            threadId: artifact.threadId,
            turnId: artifact.turnId,
            status: input.decision,
            requestId: input.requestId ?? null,
            message,
            decidedAt,
            followUpTurnId,
          });

          return { review, workspaceApplyResult };
        },
        replay: (record) => {
          const replayed = store.getArtifactReviewDecision(record.response.id);

          if (!replayed) {
            throw new Error(`Artifact review decision not found: ${record.response.id}`);
          }

          const workspaceReview = parseWorkspaceSyncReviewArtifact(artifact);
          let workspaceApplyResult: WorkspaceApplyResult | null = null;
          if (workspaceReview && replayed.status === 'accepted') {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              workspaceApplyResult = getWorkspaceApplyResult(
                workspaceDb,
                workspaceId,
                `war_${workspaceReview.review.id}`
              );
            } finally {
              workspaceDb.sqlite.close();
            }
          }

          return { review: replayed, workspaceApplyResult };
        },
        responseId: (result) => result.review.artifactId,
      });

      return c.json(
        SubmitArtifactReviewDecisionResponseSchema.parse({
          review: publicArtifactReviewDecision(review.review),
          workspaceApplyResult: review.workspaceApplyResult,
        })
      );
    } catch (error) {
      return asCommandError(error, 'artifact_review_failed');
    }
  });

  app.post(
    '/api/app/workspaces/:workspaceId/knowledge/proposals/:proposalId/decision',
    async (c) => {
      try {
        const parsed = SubmitKnowledgeProposalDecisionRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        const store = requestStore(c);
        const workspaceId = c.req.param('workspaceId');
        const proposalId = c.req.param('proposalId');
        const input = parsed.data;

        if (!input.requestId) {
          return asApiError('requestId is required.', 'invalid_request', 400);
        }

        const requestId = input.requestId;
        const message = input.message ?? null;
        const decidedAt = new Date().toISOString();
        const review = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.proposal.decide',
          requestId,
          scope: { workspaceId, proposalId },
          input,
          responseKind: 'knowledge_proposal_review',
          execute: () => {
            const proposal = store.getKnowledgeProposal(proposalId);
            const sourceClaimId =
              proposal && proposal.status !== 'accepted' ? proposal.sourceClaimId : undefined;
            const shouldApplyClaim = input.decision === 'accepted' && sourceClaimId !== undefined;
            if (input.decision === 'edited') {
              const updates: { title?: string; summary?: string; updatedAt: string } = {
                updatedAt: decidedAt,
              };
              if (input.title !== undefined) {
                updates.title = input.title;
              }
              if (input.summary !== undefined) {
                updates.summary = input.summary;
              }
              store.updateKnowledgeProposalContent(proposalId, {
                ...updates,
              });
            }
            const review = store.recordKnowledgeProposalReviewDecision({
              proposalId,
              workspaceId,
              status: input.decision,
              requestId,
              message,
              decidedAt,
            });

            if (shouldApplyClaim) {
              const claim = store.getKnowledgeClaim(workspaceId, sourceClaimId);
              store.createKnowledgeEntry(workspaceId, {
                kind: 'project-context',
                title: claim.statement,
                content: claim.statement,
                sourceReferences: claim.sourceReferences,
              });
            }

            return review;
          },
          replay: (record) => {
            const replayed = store.getKnowledgeProposalReviewDecision(record.response.id);

            if (!replayed) {
              throw new Error(
                `Knowledge proposal review decision not found: ${record.response.id}`
              );
            }

            return replayed;
          },
          responseId: (result) => result.proposalId,
        });

        return c.json(
          SubmitKnowledgeProposalDecisionResponseSchema.parse({
            review,
          })
        );
      } catch (error) {
        return asCommandError(error, 'knowledge_proposal_review_failed');
      }
    }
  );

  app.post(
    '/api/app/workspaces/:workspaceId/threads/:threadId/goals/:goalId/reviews/:reviewId/decision',
    async (c) => {
      try {
        const parsed = SubmitGoalReviewDecisionRequestSchema.safeParse(
          await c.req.json().catch(() => ({}))
        );

        if (!parsed.success) {
          return asInvalidRequestError(parsed.error);
        }

        if (!options.coreDb) {
          return asApiError(
            'Goal storage is unavailable for this NanoCore instance.',
            'goal_storage_unavailable',
            503
          );
        }

        const input = parsed.data;

        if (!input.requestId) {
          return asApiError('requestId is required.', 'invalid_request', 400);
        }

        const store = requestStore(c);
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const goalId = c.req.param('goalId');
        const reviewId = c.req.param('reviewId');

        store.getWorkspace(workspaceId);
        store.getThread(workspaceId, threadId);

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        try {
          const response = await runIdempotentCommand({
            store,
            inflightCommands,
            command: 'goal.review.decide',
            requestId: input.requestId,
            scope: { workspaceId, threadId, goalId, reviewId },
            input,
            responseKind: 'goal_review',
            execute: () => {
              const review = getGoalReviewRecord(
                workspaceDb,
                workspaceId,
                threadId,
                goalId,
                reviewId
              );

              if (!review) {
                throw new Error(
                  `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${reviewId}`
                );
              }

              if (!review.resolvedAt) {
                advanceGoalAfterReview(workspaceDb, {
                  workspaceId,
                  threadId,
                  goalId,
                  taskId: review.taskId,
                  verdict: review.verdict,
                });
              }

              const resolved = resolveGoalReviewRecord(workspaceDb, {
                workspaceId,
                threadId,
                goalId,
                reviewId,
                requestId: input.requestId as string,
              });

              return buildGoalReviewDecisionResponse(workspaceDb, resolved);
            },
            replay: (record) => {
              const review = getGoalReviewRecord(
                workspaceDb,
                workspaceId,
                threadId,
                goalId,
                record.response.id
              );

              if (!review) {
                throw new Error(
                  `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${record.response.id}`
                );
              }

              return buildGoalReviewDecisionResponse(workspaceDb, review);
            },
            responseId: (result) =>
              SubmitGoalReviewDecisionResponseSchema.parse(result).review.reviewId,
          });

          return c.json(response);
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        return asCommandError(error, 'goal_review_decision_failed');
      }
    }
  );

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId/content', (c) => {
    try {
      const artifact = requestStore(c).getArtifact(
        c.req.param('workspaceId'),
        c.req.param('artifactId')
      );
      const content = artifact.content;

      if (!content) {
        return new Response(null, { status: 204 });
      }

      if (content.format === 'markdown') {
        return c.text(content.body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
      }

      if (content.format === 'text') {
        return c.text(content.body, 200, { 'content-type': 'text/plain; charset=utf-8' });
      }

      return c.json(content);
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/threads/:threadId/events', (c) => {
    const turnId = c.req.query('turnId');
    const sinceQuery = c.req.query('since') ?? '0';
    const since = Number(sinceQuery);

    if (!turnId) {
      return c.json(
        apiErrorPayload({ code: 'missing_turn_id', message: 'turnId is required' }),
        400
      );
    }

    if (!Number.isInteger(since) || since < 0) {
      return c.json(
        apiErrorPayload({
          code: 'invalid_since',
          message: 'since must be a nonnegative integer',
        }),
        400
      );
    }

    const retainedEvents = requestStore(c).getTurnEvents(turnId);
    const replayEvents = retainedEvents.filter((event) => event.sequence > since);
    const firstRetainedSequence = retainedEvents.at(0)?.sequence;
    const terminalSequence = retainedEvents.find(
      (event) => event.event === 'turn.completed'
    )?.sequence;
    const completedBeforeCursor = terminalSequence !== undefined && since >= terminalSequence;

    if (firstRetainedSequence !== undefined && since > 0 && since < firstRetainedSequence - 1) {
      return c.json(
        apiErrorPayload({
          code: 'core.stream.cursor_expired',
          message: 'The requested turn event cursor is older than the retained stream window.',
        }),
        410
      );
    }

    if (completedBeforeCursor) {
      return c.body(null, 204);
    }

    return streamSSE(c, async (stream) => {
      let finished = false;

      for (const event of replayEvents) {
        await stream.writeSSE({ data: JSON.stringify(event) });

        if (event.event === 'turn.completed') {
          finished = true;
        }
      }

      if (finished) {
        await stream.close();
        return;
      }

      const unsubscribe = requestStore(c).addTurnListener(turnId, async (event) => {
        if (event.sequence <= since) {
          return;
        }

        await stream.writeSSE({ data: JSON.stringify(event) });

        if (event.event === 'turn.completed') {
          finished = true;
          unsubscribe();
          await stream.close();
        }
      });

      while (!finished) {
        await stream.sleep(250);
      }
    });
  });

  return app;
}

/**
 * Collects product-safe evidence references for one compact bundle.
 *
 * @param store App store that owns app-local thread and artifact records.
 * @param workspaceId Workspace that owns the bundle.
 * @param input Bundle lineage input.
 * @returns Product-safe record references only.
 */
function collectEvidenceBundleRefs(
  store: FsStore,
  workspaceId: string,
  input: CreateEvidenceBundleRequest
): EvidenceBundleRef[] {
  const refs: EvidenceBundleRef[] = [{ kind: 'workspace', ref: workspaceId }];

  if (input.threadId) {
    store.getThread(workspaceId, input.threadId);
    refs.push({ kind: 'thread', ref: input.threadId });
  }

  if (input.turnId) {
    if (input.threadId) {
      store.getTurn(workspaceId, input.threadId, input.turnId);
    }
    refs.push({ kind: 'turn', ref: input.turnId });
  }

  if (input.goalId) {
    refs.push({ kind: 'goal', ref: input.goalId });
  }

  for (const artifact of store.listArtifacts(workspaceId)) {
    if (input.threadId && artifact.threadId !== input.threadId) {
      continue;
    }
    if (input.turnId && artifact.turnId !== input.turnId) {
      continue;
    }
    refs.push({ kind: 'artifact', ref: artifact.id });
  }

  return refs;
}

/**
 * Returns the server-managed backup root for one data-root backup id.
 *
 * @param dataRoot Live NanoCore data root.
 * @param backupId Server-managed backup id.
 * @returns Backup root outside the live data root.
 */
function dataRootBackupRoot(dataRoot: string, backupId: string): string {
  return join(`${dataRoot}.backups`, backupId);
}

/**
 * Projects a verified data-root backup manifest into the public App API response shape.
 *
 * @param verified Parsed manifest plus checked inventory paths.
 * @returns Public backup response without filesystem paths.
 */
function dataRootBackupResponse(verified: VerifiedDataRootBackupManifest): unknown {
  return {
    backupId: verified.manifest.id,
    manifest: verified.manifest,
    fileCount: verified.checkedFiles.length,
    totalBytes: verified.manifest.contentInventory.reduce((total, entry) => total + entry.bytes, 0),
    checkedFiles: verified.checkedFiles,
  };
}
