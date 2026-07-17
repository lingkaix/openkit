import type {
  ApproveThreadGoalPlanRequest,
  ConsumeOpenKitBootstrapTokenRequest,
  CreateAutomationRequest,
  CreateOpenKitAccessTokenRequest,
  KnowledgeManagerAnswerRequest,
  KnowledgeManagerDraftProposalRequest,
  KnowledgeManagerHealthCheckRequest,
  KnowledgeManagerPrepareContextRequest,
  KnowledgeManagerSuggestRepairRequest,
  PromoteKnowledgeClaimRequest,
  RecordKnowledgeClaimRequest,
  RecordKnowledgeConflictRequest,
  RecordKnowledgeObservationRequest,
  RegisterKnowledgeSourceRequest,
  ResolveKnowledgeConflictRequest,
  RetrieveKnowledgeRequest,
  ReviseThreadGoalPlanRequest,
  StartChatModeRequest,
  StartTaskModeRequest,
  UpdateAutomationRequest,
  VaultAdminBootstrapCodexAuthJsonRequest,
  VaultAdminUnlockRequest,
} from '@openkit/app-api-schemas';
import {
  type CoreClient,
  type CreateCoreClientOptions,
  createCoreClient,
} from '@openkit/core-client';

/** Input for workspace-scoped read tools. */
export interface WorkspaceScopeInput {
  /** Workspace id to operate on. */
  workspaceId: string;
}

/** Input for creating one workspace export. */
export interface ExportWorkspaceInput extends WorkspaceScopeInput {
  /** Request id retained for MCP audit continuity. */
  requestId: string;
}

/** Input for previewing a server-managed workspace export import. */
export interface DryRunWorkspaceImportInput {
  /** Workspace id used in the server-managed export handle. */
  sourceWorkspaceId: string;
  /** Export id used in the server-managed export handle. */
  exportId: string;
}

/** Input for importing one server-managed workspace export. */
export interface ImportWorkspaceInput extends DryRunWorkspaceImportInput {
  /** Request id retained for MCP audit continuity. */
  requestId: string;
}

/** Input for rebinding one imported workspace vault reference. */
export interface RebindWorkspaceVaultReferenceInput extends WorkspaceScopeInput {
  /** Request id retained for MCP audit continuity. */
  requestId: string;
  /** Imported workspace vault reference id. */
  referenceId: string;
  /** Base64-encoded local secret material. */
  materialBase64: string;
}

/** Input for consuming one server bootstrap token. */
export type ConsumeBootstrapTokenInput = ConsumeOpenKitBootstrapTokenRequest;

/** Input for issuing one OpenKit access token. */
export type CreateOpenKitAccessTokenInput = CreateOpenKitAccessTokenRequest;

/** Input for one token-scoped OpenKit access-token operation. */
export interface OpenKitAccessTokenIdInput {
  /** OpenKit access-token id. */
  tokenId: string;
}

/** Input for rotating one OpenKit access token. */
export interface RotateOpenKitAccessTokenInput extends OpenKitAccessTokenIdInput {
  /** Optional grace period before the rotated token fully expires. */
  graceSeconds?: number | undefined;
}

/** Input for unlocking the configured vault backend. */
export type UnlockVaultAdminBackendInput = VaultAdminUnlockRequest;

/** Input for bootstrapping Codex auth JSON into the unlocked vault. */
export type BootstrapCodexAuthJsonVaultReferenceInput = VaultAdminBootstrapCodexAuthJsonRequest;

/** Input for creating one automation. */
export type CreateAutomationInput = CreateAutomationRequest;

/** Input for one automation-scoped operation. */
export interface AutomationIdInput {
  /** Automation id to operate on. */
  automationId: string;
}

/** Input for updating one automation. */
export interface UpdateAutomationInput extends AutomationIdInput, UpdateAutomationRequest {}

/** Input for thread-scoped read tools. */
export interface ThreadScopeInput extends WorkspaceScopeInput {
  /** Thread id to operate on. */
  threadId: string;
}

/** Input for retrying one interrupted worker checkpoint. */
export interface RetryInterruptedWorkerCheckpointInput extends ThreadScopeInput {
  /** Worker turn id represented by the checkpoint. */
  turnId: string;
}

/** Input for retrying one denied scheduler admission. */
export interface RetrySchedulerAdmissionInput extends WorkspaceScopeInput {
  /** Scheduler admission queue entry id. */
  queueEntryId: string;
}

/** Input for cancelling one scheduler admission. */
export interface CancelSchedulerAdmissionInput extends WorkspaceScopeInput {
  /** Scheduler admission queue entry id. */
  queueEntryId: string;
}

/** Input for reading interface and NanoCore readiness. */
export interface ReadStatusInput {
  /** Optional workspace id to inspect. */
  workspaceId?: string | undefined;
  /** Optional thread id for active goal summary lookup. */
  threadId?: string | undefined;
}

/** Input for asking Knowledge Manager to answer from workspace knowledge. */
export interface AnswerKnowledgeInput extends WorkspaceScopeInput {
  /** Knowledge question to answer. */
  query: string;
  /** Optional source citation limit. */
  limit?: KnowledgeManagerAnswerRequest['limit'];
}

/** Input for preparing Knowledge Manager context material from workspace knowledge. */
export interface PrepareKnowledgeContextInput extends WorkspaceScopeInput {
  /** Context selection query. */
  query: string;
  /** Optional material limit. */
  limit?: KnowledgeManagerPrepareContextRequest['limit'];
  /** Optional explicit artifact ids to include in the context package. */
  artifactIds?: KnowledgeManagerPrepareContextRequest['artifactIds'] | undefined;
  /** Optional explicit workspace-owned files to include in the context package. */
  workspaceFiles?: KnowledgeManagerPrepareContextRequest['workspaceFiles'] | undefined;
  /** Optional explicit materialized workspace-root files to include in the context package. */
  workspaceRootFiles?: KnowledgeManagerPrepareContextRequest['workspaceRootFiles'] | undefined;
}

/** Input for reading one persisted Knowledge Manager context package trace. */
export interface ReadKnowledgeContextPackageTraceInput extends WorkspaceScopeInput {
  /** Context package id to read. */
  contextPackageId: string;
}

/** Input for materializing one Knowledge Manager context package. */
export type MaterializeKnowledgeContextPackageInput = ReadKnowledgeContextPackageTraceInput;

/** Input for reading one materialized Knowledge Manager context package. */
export type ReadKnowledgeContextPackageMaterializationInput = ReadKnowledgeContextPackageTraceInput;

/** Input for drafting one Knowledge Proposal through Knowledge Manager. */
export interface DraftKnowledgeProposalInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Proposal title. */
  title: string;
  /** Proposal summary. */
  summary: string;
  /** Optional source references supporting the draft. */
  sourceReferences?: KnowledgeManagerDraftProposalRequest['sourceReferences'] | undefined;
  /** Optional draft confidence. */
  confidence?: KnowledgeManagerDraftProposalRequest['confidence'] | undefined;
}

/** Input for registering one Knowledge Source through Knowledge Manager. */
export interface RegisterKnowledgeSourceInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Source material category. */
  kind: RegisterKnowledgeSourceRequest['kind'];
  /** Human-readable source title. */
  title: string;
  /** Source content used to compute the stored digest. */
  content: string;
  /** Optional source URI. */
  uri?: RegisterKnowledgeSourceRequest['uri'];
  /** Optional originating thread id. */
  originatingThreadId?: RegisterKnowledgeSourceRequest['originatingThreadId'];
  /** Optional originating turn id. */
  originatingTurnId?: RegisterKnowledgeSourceRequest['originatingTurnId'];
  /** Optional originating file id. */
  originatingFileId?: RegisterKnowledgeSourceRequest['originatingFileId'];
}

/** Input for reading one registered Knowledge Source. */
export interface ReadKnowledgeSourceInput extends WorkspaceScopeInput {
  /** Source id to read. */
  sourceId: string;
}

/** Input for recording one Knowledge Store observation. */
export interface RecordKnowledgeObservationInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Observation category. */
  kind: RecordKnowledgeObservationRequest['kind'];
  /** Observed event or pattern. */
  summary: string;
  /** Optional source references supporting the observation. */
  sourceReferences?: RecordKnowledgeObservationRequest['sourceReferences'] | undefined;
  /** Optional observation scope. */
  scope?: RecordKnowledgeObservationRequest['scope'] | undefined;
  /** Producer that recorded the observation. */
  producer: string;
  /** Optional producer confidence. */
  confidence?: RecordKnowledgeObservationRequest['confidence'] | undefined;
  /** Optional freshness state. */
  freshness?: RecordKnowledgeObservationRequest['freshness'] | undefined;
  /** Optional observation status. */
  status?: RecordKnowledgeObservationRequest['status'] | undefined;
  /** Optional observed event timestamp. */
  observedAt?: RecordKnowledgeObservationRequest['observedAt'] | undefined;
}

/** Input for recording one Knowledge Store claim. */
export interface RecordKnowledgeClaimInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Reusable assertion captured from sourced knowledge. */
  statement: string;
  /** Optional source references supporting the claim. */
  sourceReferences?: RecordKnowledgeClaimRequest['sourceReferences'] | undefined;
  /** Optional claim scope. */
  scope?: RecordKnowledgeClaimRequest['scope'] | undefined;
  /** Producer that recorded the claim. */
  producer: string;
  /** Optional producer confidence. */
  confidence?: RecordKnowledgeClaimRequest['confidence'] | undefined;
  /** Optional freshness state. */
  freshness?: RecordKnowledgeClaimRequest['freshness'] | undefined;
  /** Optional review state. */
  reviewState?: RecordKnowledgeClaimRequest['reviewState'] | undefined;
  /** Optional conflict status. */
  conflictStatus?: RecordKnowledgeClaimRequest['conflictStatus'] | undefined;
}

/** Input for promoting one accepted Knowledge Store claim into review. */
export interface PromoteKnowledgeClaimInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Claim id to promote. */
  claimId: string;
  /** Optional Knowledge Manager caller. */
  caller?: PromoteKnowledgeClaimRequest['caller'] | undefined;
}

/** Input for recording one Knowledge Store conflict. */
export interface RecordKnowledgeConflictInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Knowledge, claim, source, or page references that are in tension. */
  subjectReferences: RecordKnowledgeConflictRequest['subjectReferences'];
  /** Optional source references supporting the conflict. */
  sourceReferences?: RecordKnowledgeConflictRequest['sourceReferences'] | undefined;
  /** Optional conflict status. */
  status?: RecordKnowledgeConflictRequest['status'] | undefined;
  /** Human-readable conflict summary. */
  summary: string;
  /** Optional suggested review or repair actions. */
  suggestedActions?: RecordKnowledgeConflictRequest['suggestedActions'] | undefined;
  /** Producer that recorded the conflict. */
  producer: string;
}

/** Input for resolving one Knowledge Store conflict. */
export interface ResolveKnowledgeConflictInput extends WorkspaceScopeInput {
  /** Idempotency request id. */
  requestId: string;
  /** Conflict id to resolve. */
  conflictId: string;
  /** Optional final resolution status. */
  status?: ResolveKnowledgeConflictRequest['status'] | undefined;
  /** Human-readable resolution summary. */
  resolution: string;
  /** Actor or agent resolving the conflict. */
  resolvedBy: string;
}

/** Input for retrieving ranked Knowledge Store candidates with a persisted trace. */
export interface RetrieveKnowledgeInput extends WorkspaceScopeInput {
  /** Retrieval query. */
  query: string;
  /** Optional selected candidate limit. */
  limit?: RetrieveKnowledgeRequest['limit'] | undefined;
  /** Optional concepts that should be selected when active. */
  pinnedConceptIds?: RetrieveKnowledgeRequest['pinnedConceptIds'] | undefined;
}

/** Input for suggesting knowledge repairs through Knowledge Manager. */
export interface SuggestKnowledgeRepairsInput extends WorkspaceScopeInput {
  /** Optional suggestion limit. */
  limit?: KnowledgeManagerSuggestRepairRequest['limit'] | undefined;
}

/** Input for reading one Knowledge Manager health report. */
export interface CheckKnowledgeHealthInput extends WorkspaceScopeInput {
  /** Optional repair suggestion limit. */
  limit?: KnowledgeManagerHealthCheckRequest['limit'] | undefined;
}

/** Input for creating one workspace. */
export interface CreateWorkspaceInput {
  /** Workspace name. */
  name: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for updating one workspace. */
export interface UpdateWorkspaceInput extends WorkspaceScopeInput {
  /** Optional workspace display name. */
  name?: string | undefined;
  /** Optional product workspace kind. */
  kind?: 'code' | 'content' | 'personal-ops' | 'research' | 'operations' | 'general' | undefined;
  /** Optional workspace status. */
  status?: 'active' | 'archived' | undefined;
  /** Optional workspace execution defaults. */
  defaults?:
    | {
        /** Optional default model id. */
        defaultModelId?: string | null | undefined;
        /** Optional default agent id. */
        defaultAgentId?: string | null | undefined;
        /** Optional default Skill ids. */
        defaultSkillIds?: string[] | undefined;
      }
    | undefined;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for reading one runtime config file. */
export interface ReadRuntimeConfigFileInput {
  /** Runtime config file id. */
  id: string;
}

/** Input for validating one runtime config file draft. */
export interface ValidateRuntimeConfigInput extends ReadRuntimeConfigFileInput {
  /** Draft file source. */
  content: string;
  /** Validation mode. */
  mode?: 'safe' | 'strict' | undefined;
}

/** Input for updating one runtime config file. */
export interface UpdateRuntimeConfigFileInput extends ReadRuntimeConfigFileInput {
  /** Runtime config file kind. */
  kind: 'server' | 'provider' | 'agent' | 'workspace' | 'data-source';
  /** Source text to write. */
  content?: string | undefined;
  /** Expected source revision for optimistic concurrency. */
  expectedRevision?: string | null | undefined;
}

/** Input for reloading runtime config after source changes. */
export interface ReloadRuntimeConfigInput {
  /** Whether to compute the reload plan without applying hot-swappable changes. */
  dryRun?: boolean | undefined;
  /** Reload strictness mode. */
  mode?: 'safe' | 'strict' | undefined;
}

/** Input for retiring one stale runtime config session. */
export interface RestartRuntimeConfigStaleSessionInput extends WorkspaceScopeInput {
  /** Stale agent session id. */
  sessionId: string;
}

/** Input for optional NanoCore startup diagnostics. */
export interface StartNanoCoreInput {
  /** Optional data root requested by the caller. */
  dataRoot?: string | undefined;
  /** Optional port requested by the caller. */
  port?: number | undefined;
  /** Optional workspace checkout requested by the caller. */
  workspaceRoot?: string | undefined;
}

/** Input for linking a default workspace repository. */
export interface LinkRepositoryInput extends WorkspaceScopeInput {
  /** User-facing repository display name. */
  displayName: string;
  /** Host-local repository path accepted by NanoCore. */
  localPath: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for creating one thread. */
export interface CreateThreadInput extends WorkspaceScopeInput {
  /** Thread title. */
  title: string;
  /** Optional initial message for the user-facing agent app. */
  initialMessage?: string | undefined;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for starting Goal Mode. */
export interface StartGoalInput extends ThreadScopeInput {
  /** Goal objective. */
  objective: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for starting one Chat Mode Assistant turn. */
export interface StartChatInput extends ThreadScopeInput {
  /** User message for the Assistant. */
  input: string;
  /** Optional provider id override. */
  providerId?: StartChatModeRequest['providerId'];
  /** Optional model id override. */
  model?: StartChatModeRequest['model'];
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for starting one Task Mode worker attempt. */
export interface StartTaskInput extends ThreadScopeInput {
  /** Bounded task request for the worker. */
  input: string;
  /** Optional model id override. */
  modelId?: StartTaskModeRequest['modelId'];
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for drafting a Goal Mode plan. */
export interface DraftGoalPlanInput extends ThreadScopeInput {
  /** Request id retained for MCP audit continuity. */
  requestId: string;
}

/** Input for approving a Goal Mode plan. */
export interface ApproveGoalPlanInput extends ThreadScopeInput {
  /** Plan item id returned by NanoCore plan drafting. */
  planItemId: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for requesting Goal Mode plan revisions. */
export interface ReviseGoalPlanInput extends ThreadScopeInput {
  /** Human-readable revision request. */
  revision: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for running one bounded Goal Mode step. */
export interface StepGoalInput extends ThreadScopeInput {
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for submitting Goal Mode steering. */
export interface SubmitSteeringInput extends ThreadScopeInput {
  /** Steering message. */
  message: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for reading the Action Center. */
export interface ReadActionCenterInput extends WorkspaceScopeInput {
  /** Optional row kind filter applied by the MCP facade. */
  kind?: string | undefined;
  /** Optional row count limit applied by the MCP facade. */
  limit?: number | undefined;
}

/** Input for resolving one Action Center row. */
export interface ResolveActionCenterItemInput extends WorkspaceScopeInput {
  /** Action Center row id. */
  rowId: string;
  /** Action id or action kind selected by the human. */
  actionId: string;
  /** Explicit human decision. */
  decision: string;
  /** Optional human comment. */
  comment?: string | undefined;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for reading one artifact. */
export interface ReadArtifactInput extends WorkspaceScopeInput {
  /** Artifact id. */
  artifactId: string;
  /** Optional thread id to include in summaries. */
  threadId?: string | undefined;
}

/** Input for reading workspace synchronization reviews. */
export interface ReadWorkspaceReviewsInput extends WorkspaceScopeInput {
  /** Optional staged review id. */
  reviewId?: string | undefined;
}

/** Input for reading durable workspace apply results. */
export interface ReadWorkspaceApplyResultsInput extends WorkspaceScopeInput {
  /** Optional apply result id. */
  applyResultId?: string | undefined;
}

/** Input for reading durable Agent Environment Package snapshots. */
export interface ReadAgentEnvironmentPackageSnapshotsInput extends WorkspaceScopeInput {
  /** Optional Agent Environment Package snapshot id. */
  snapshotId?: string | undefined;
}

/** Input for reading durable Git push records. */
export interface ReadGitPushRecordsInput extends WorkspaceScopeInput {
  /** Optional Git push record id. */
  pushRecordId?: string | undefined;
}

/** Input for requesting one approval-gated Git push action. */
export interface RequestGitPushApprovalInput extends ThreadScopeInput {
  /** Turn that owns the approval gate. */
  turnId: string;
  /** Repository resource id to publish from. */
  repositoryResourceId: string;
  /** Source ref to publish. */
  sourceRef: string;
  /** Target branch to update. */
  targetBranch: string;
  /** OpenKit-created commit ids to publish. */
  commitIds: string[];
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for executing one approved Git push action. */
export interface ExecuteGitPushInput extends WorkspaceScopeInput {
  /** Repository resource id to publish from. */
  repositoryResourceId: string;
  /** Approval request that authorized the push. */
  approvalRequestId: string;
  /** Request id for idempotent mutation tracking. */
  requestId: string;
}

/** Input for reading durable workspace synchronization product records. */
export interface ReadWorkspaceSyncRecordsInput extends WorkspaceScopeInput {
  /** Optional record kind filter. */
  kind?:
    | 'input-snapshots'
    | 'materialization-records'
    | 'backend-handles'
    | 'output-manifests'
    | 'change-sets'
    | 'staged-reviews'
    | 'apply-plans'
    | 'reconciliation-records'
    | 'quarantine-records'
    | undefined;
}

/** Public NanoCore operations used by the OpenKit AI Interface registry. */
export interface OpenKitNanoCoreClient {
  /** Reads interface and NanoCore readiness. */
  readStatus(input: ReadStatusInput): Promise<unknown>;
  /** Reads public runtime diagnostics from NanoCore Settings routes. */
  readRuntimeDiagnostics(): Promise<unknown>;
  /** Reads the storage layout report from the public App API. */
  readStorageLayoutReport(): Promise<unknown>;
  /** Creates one server-managed hot data-root backup. */
  createDataRootBackup(): Promise<unknown>;
  /** Verifies one server-managed data-root backup by id. */
  verifyDataRootBackup(input: { backupId: string }): Promise<unknown>;
  /** Creates one verified workspace export through the public App API. */
  exportWorkspace(input: ExportWorkspaceInput): Promise<unknown>;
  /** Verifies one server-managed export without importing it. */
  dryRunWorkspaceImport(input: DryRunWorkspaceImportInput): Promise<unknown>;
  /** Imports one server-managed export as a new workspace. */
  importWorkspace(input: ImportWorkspaceInput): Promise<unknown>;
  /** Lists redacted workspace vault references. */
  readWorkspaceVaultReferences(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists non-secret workspace vault grants. */
  readWorkspaceVaultGrants(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists non-secret workspace injection plans. */
  readWorkspaceInjectionPlans(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists non-secret workspace injection receipts. */
  readWorkspaceInjectionReceipts(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists redacted workspace vault use records. */
  readWorkspaceVaultUseRecords(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists redacted server vault use records. */
  readServerVaultUseRecords(): Promise<unknown>;
  /** Rebinds one imported workspace vault reference to local secret material. */
  rebindWorkspaceVaultReference(input: RebindWorkspaceVaultReferenceInput): Promise<unknown>;
  /** Reads workspace capability-call and usage evidence. */
  readCapabilityUsage(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists workspace evidence bundles. */
  readWorkspaceEvidenceBundles(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists workspace runtime evidence. */
  readWorkspaceRuntimeEvidence(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists workspace audit events. */
  readWorkspaceAuditEvents(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists server audit events. */
  readServerAuditEvents(): Promise<unknown>;
  /** Lists workspace permission decisions. */
  readWorkspacePermissionDecisions(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists server permission decisions. */
  readServerPermissionDecisions(): Promise<unknown>;
  /** Consumes one server bootstrap token and returns the first server-admin token. */
  consumeBootstrapToken(input: ConsumeBootstrapTokenInput): Promise<unknown>;
  /** Lists redacted OpenKit access-token records. */
  listOpenKitAccessTokens(): Promise<unknown>;
  /** Issues one OpenKit access token and returns the secret once. */
  createOpenKitAccessToken(input: CreateOpenKitAccessTokenInput): Promise<unknown>;
  /** Revokes one OpenKit access token. */
  revokeOpenKitAccessToken(input: OpenKitAccessTokenIdInput): Promise<unknown>;
  /** Rotates one OpenKit access token and returns the replacement secret once. */
  rotateOpenKitAccessToken(input: RotateOpenKitAccessTokenInput): Promise<unknown>;
  /** Reads redacted vault admin status. */
  readVaultAdminStatus(): Promise<unknown>;
  /** Unlocks the configured vault backend. */
  unlockVaultAdminBackend(input: UnlockVaultAdminBackendInput): Promise<unknown>;
  /** Locks the configured vault backend. */
  lockVaultAdminBackend(): Promise<unknown>;
  /** Bootstraps Codex auth JSON into the unlocked vault. */
  bootstrapCodexAuthJsonVaultReference(
    input: BootstrapCodexAuthJsonVaultReferenceInput
  ): Promise<unknown>;
  /** Lists automations. */
  listAutomations(): Promise<unknown>;
  /** Creates one automation. */
  createAutomation(input: CreateAutomationInput): Promise<unknown>;
  /** Updates one automation. */
  updateAutomation(input: UpdateAutomationInput): Promise<unknown>;
  /** Deletes one automation. */
  deleteAutomation(input: AutomationIdInput): Promise<unknown>;
  /** Answers one workspace knowledge question through Knowledge Manager. */
  answerKnowledge(input: AnswerKnowledgeInput): Promise<unknown>;
  /** Prepares source-traceable context material through Knowledge Manager. */
  prepareKnowledgeContext(input: PrepareKnowledgeContextInput): Promise<unknown>;
  /** Reads one persisted Knowledge Manager context package trace. */
  readKnowledgeContextPackageTrace(input: ReadKnowledgeContextPackageTraceInput): Promise<unknown>;
  /** Reads one previously materialized Knowledge Manager context package. */
  readKnowledgeContextPackageMaterialization(
    input: ReadKnowledgeContextPackageMaterializationInput
  ): Promise<unknown>;
  /** Materializes one persisted Knowledge Manager context package trace. */
  materializeKnowledgeContextPackage(
    input: MaterializeKnowledgeContextPackageInput
  ): Promise<unknown>;
  /** Drafts one pending Knowledge Proposal through Knowledge Manager. */
  draftKnowledgeProposal(input: DraftKnowledgeProposalInput): Promise<unknown>;
  /** Suggests review-required knowledge repairs through Knowledge Manager. */
  suggestKnowledgeRepairs(input: SuggestKnowledgeRepairsInput): Promise<unknown>;
  /** Reads one bounded Knowledge Manager health report. */
  checkKnowledgeHealth(input: CheckKnowledgeHealthInput): Promise<unknown>;
  /** Registers one workspace Knowledge Source. */
  registerKnowledgeSource(input: RegisterKnowledgeSourceInput): Promise<unknown>;
  /** Lists workspace Knowledge Sources. */
  listKnowledgeSources(input: WorkspaceScopeInput): Promise<unknown>;
  /** Reads one workspace Knowledge Source. */
  readKnowledgeSource(input: ReadKnowledgeSourceInput): Promise<unknown>;
  /** Reads derived Knowledge Store indexes. */
  readKnowledgeIndexes(input: WorkspaceScopeInput): Promise<unknown>;
  /** Retrieves ranked Knowledge Store candidates and persists the trace. */
  retrieveKnowledge(input: RetrieveKnowledgeInput): Promise<unknown>;
  /** Records one Knowledge Store observation. */
  recordKnowledgeObservation(input: RecordKnowledgeObservationInput): Promise<unknown>;
  /** Lists workspace Knowledge Store observations. */
  listKnowledgeObservations(input: WorkspaceScopeInput): Promise<unknown>;
  /** Records one Knowledge Store claim. */
  recordKnowledgeClaim(input: RecordKnowledgeClaimInput): Promise<unknown>;
  /** Lists workspace Knowledge Store claims. */
  listKnowledgeClaims(input: WorkspaceScopeInput): Promise<unknown>;
  /** Promotes one accepted Knowledge Store claim into review. */
  promoteKnowledgeClaim(input: PromoteKnowledgeClaimInput): Promise<unknown>;
  /** Records one Knowledge Store conflict. */
  recordKnowledgeConflict(input: RecordKnowledgeConflictInput): Promise<unknown>;
  /** Resolves one Knowledge Store conflict. */
  resolveKnowledgeConflict(input: ResolveKnowledgeConflictInput): Promise<unknown>;
  /** Lists workspace Knowledge Store conflicts. */
  listKnowledgeConflicts(input: WorkspaceScopeInput): Promise<unknown>;
  /** Starts or diagnoses NanoCore startup. */
  startNanoCore(input: StartNanoCoreInput): Promise<unknown>;
  /** Lists workspaces visible to the current NanoCore session. */
  listWorkspaces(): Promise<unknown>;
  /** Lists interrupted worker recovery states. */
  listInterruptedWorkers(): Promise<unknown>;
  /** Queues one interrupted worker checkpoint for retry. */
  retryInterruptedWorkerCheckpoint(input: RetryInterruptedWorkerCheckpointInput): Promise<unknown>;
  /** Requeues one denied scheduler admission. */
  retrySchedulerAdmission(input: RetrySchedulerAdmissionInput): Promise<unknown>;
  /** Cancels one queued or denied scheduler admission. */
  cancelSchedulerAdmission(input: CancelSchedulerAdmissionInput): Promise<unknown>;
  /** Lists workspace-filtered scheduler admissions. */
  readSchedulerAdmissions(input: WorkspaceScopeInput): Promise<unknown>;
  /** Creates one workspace. */
  createWorkspace(input: CreateWorkspaceInput): Promise<unknown>;
  /** Updates one workspace. */
  updateWorkspace(input: UpdateWorkspaceInput): Promise<unknown>;
  /** Reads one workspace resource bundle. */
  readWorkspaceResources(input: WorkspaceScopeInput): Promise<unknown>;
  /** Lists runtime config files exposed by NanoCore Settings routes. */
  listRuntimeConfigFiles(): Promise<unknown>;
  /** Reads one runtime config file through public NanoCore admin routes. */
  readRuntimeConfigFile(input: ReadRuntimeConfigFileInput): Promise<unknown>;
  /** Reads runtime config schema catalog entries. */
  readRuntimeConfigSchemas(): Promise<unknown>;
  /** Validates one runtime config file draft without writing it. */
  validateRuntimeConfig(input: ValidateRuntimeConfigInput): Promise<unknown>;
  /** Updates one runtime config file through public NanoCore admin routes. */
  updateRuntimeConfigFile(input: UpdateRuntimeConfigFileInput): Promise<unknown>;
  /** Reloads runtime config through public NanoCore admin routes. */
  reloadRuntimeConfig(input: ReloadRuntimeConfigInput): Promise<unknown>;
  /** Retires one stale runtime config session. */
  restartRuntimeConfigStaleSession(input: RestartRuntimeConfigStaleSessionInput): Promise<unknown>;
  /** Links the default repository resource. */
  linkRepository(input: LinkRepositoryInput): Promise<unknown>;
  /** Reads repository resources and diagnostics. */
  readRepositories(input: WorkspaceScopeInput): Promise<unknown>;
  /** Creates one thread. */
  createThread(input: CreateThreadInput): Promise<unknown>;
  /** Reads one thread and recent items. */
  readThread(input: ThreadScopeInput): Promise<unknown>;
  /** Starts one Chat Mode Assistant turn. */
  startChat(input: StartChatInput): Promise<unknown>;
  /** Starts one Task Mode worker attempt. */
  startTask(input: StartTaskInput): Promise<unknown>;
  /** Starts Goal Mode. */
  startGoal(input: StartGoalInput): Promise<unknown>;
  /** Reads Goal Mode summary. */
  readGoal(input: ThreadScopeInput): Promise<unknown>;
  /** Drafts a Goal Mode plan. */
  draftGoalPlan(input: DraftGoalPlanInput): Promise<unknown>;
  /** Approves a Goal Mode plan. */
  approveGoalPlan(input: ApproveGoalPlanInput): Promise<unknown>;
  /** Requests Goal Mode plan revisions. */
  reviseGoalPlan(input: ReviseGoalPlanInput): Promise<unknown>;
  /** Runs one bounded Goal Mode step. */
  stepGoal(input: StepGoalInput): Promise<unknown>;
  /** Submits Goal Mode steering. */
  submitSteering(input: SubmitSteeringInput): Promise<unknown>;
  /** Reads the Action Center. */
  readActionCenter(input: ReadActionCenterInput): Promise<unknown>;
  /** Resolves one Action Center row. */
  resolveActionCenterItem(input: ResolveActionCenterItemInput): Promise<unknown>;
  /** Reads workspace synchronization reviews. */
  readWorkspaceReviews(input: ReadWorkspaceReviewsInput): Promise<unknown>;
  /** Reads durable workspace apply results. */
  readWorkspaceApplyResults(input: ReadWorkspaceApplyResultsInput): Promise<unknown>;
  /** Reads durable Agent Environment Package snapshots. */
  readAgentEnvironmentPackageSnapshots(
    input: ReadAgentEnvironmentPackageSnapshotsInput
  ): Promise<unknown>;
  /** Reads durable Git push records. */
  readGitPushRecords(input: ReadGitPushRecordsInput): Promise<unknown>;
  /** Requests a human approval gate for one Git push. */
  requestGitPushApproval(input: RequestGitPushApprovalInput): Promise<unknown>;
  /** Executes one approved Git push. */
  executeGitPush(input: ExecuteGitPushInput): Promise<unknown>;
  /** Reads durable workspace synchronization product records. */
  readWorkspaceSyncRecords(input: ReadWorkspaceSyncRecordsInput): Promise<unknown>;
  /** Reads one artifact. */
  readArtifact(input: ReadArtifactInput): Promise<unknown>;
}

/** Options for creating a NanoCore-backed AI Interface client. */
export interface CreateNanoCoreClientOptions extends CreateCoreClientOptions {
  /** Whether this client may try to start NanoCore. */
  allowStartup?: boolean;
}

/** Creates a NanoCore facade backed only by public `@openkit/core-client` surfaces. */
export function createNanoCoreClient(options: CreateNanoCoreClientOptions): OpenKitNanoCoreClient {
  const client = createCoreClient(options);

  return createNanoCoreFacade(client, options);
}

/** Creates a NanoCore facade from an existing composed core client. */
export function createNanoCoreFacade(
  client: CoreClient,
  options: Pick<CreateNanoCoreClientOptions, 'allowStartup'> = {}
): OpenKitNanoCoreClient {
  return {
    approveGoalPlan: (input) =>
      client.app.approveThreadGoalPlan(input.workspaceId, input.threadId, {
        requestId: input.requestId,
        planItemId: input.planItemId,
      } satisfies ApproveThreadGoalPlanRequest),
    reviseGoalPlan: (input) =>
      client.app.reviseThreadGoalPlan(input.workspaceId, input.threadId, {
        requestId: input.requestId,
        revision: input.revision,
      } satisfies ReviseThreadGoalPlanRequest),
    createWorkspace: (input) =>
      client.core.createWorkspace({
        name: input.name,
        requestId: input.requestId,
      }),
    createThread: (input) =>
      client.core.createThread({
        name: input.title,
        requestId: input.requestId,
        workspaceId: input.workspaceId,
      }),
    draftGoalPlan: (input) =>
      client.app.createThreadGoalPlan(input.workspaceId, input.threadId, {
        requestId: input.requestId,
      }),
    executeGitPush: (input) =>
      client.repositories.executeGitPush(input.workspaceId, input.repositoryResourceId, {
        approvalRequestId: input.approvalRequestId,
        requestId: input.requestId,
      }),
    linkRepository: (input) =>
      client.repositories.setDefault(input.workspaceId, {
        displayName: input.displayName,
        localPath: input.localPath,
      }),
    listInterruptedWorkers: () => client.app.listInterruptedWorkers(),
    retryInterruptedWorkerCheckpoint: (input) =>
      client.app.retryInterruptedWorkerCheckpoint(input.workspaceId, input.threadId, input.turnId),
    retrySchedulerAdmission: (input) =>
      client.app.retrySchedulerAdmission(input.workspaceId, input.queueEntryId),
    cancelSchedulerAdmission: (input) =>
      client.app.cancelSchedulerAdmission(input.workspaceId, input.queueEntryId),
    readSchedulerAdmissions: (input) => client.app.listSchedulerAdmissions(input.workspaceId),
    listRuntimeConfigFiles: () => client.runtimeConfig.listFiles(),
    listWorkspaces: () => client.core.listWorkspaces(),
    readActionCenter: async (input) => {
      const response = await client.actionCenter.listHumanAttention(input.workspaceId);
      const items = response.items
        .filter((item) => !input.kind || item.kind === input.kind)
        .slice(0, input.limit ?? response.items.length);
      return { items };
    },
    readArtifact: (input) => client.core.getArtifact(input.workspaceId, input.artifactId),
    readRuntimeConfigFile: (input) => client.runtimeConfig.getFile(input.id),
    readRuntimeConfigSchemas: () => client.runtimeConfig.getSchemas(),
    readStorageLayoutReport: () => client.app.getStorageLayoutReport(),
    createDataRootBackup: () => client.app.createDataRootBackup(),
    verifyDataRootBackup: (input) => client.app.verifyDataRootBackup(input.backupId),
    exportWorkspace: (input) => client.app.exportWorkspace(input.workspaceId),
    dryRunWorkspaceImport: (input) => client.app.dryRunWorkspaceImport(input),
    importWorkspace: (input) => client.app.importWorkspace(input),
    readWorkspaceVaultReferences: (input) =>
      client.app.listWorkspaceVaultReferences(input.workspaceId),
    readWorkspaceVaultGrants: (input) => client.app.listWorkspaceVaultGrants(input.workspaceId),
    readWorkspaceInjectionPlans: (input) =>
      client.app.listWorkspaceInjectionPlans(input.workspaceId),
    readWorkspaceInjectionReceipts: (input) =>
      client.app.listWorkspaceInjectionReceipts(input.workspaceId),
    readWorkspaceVaultUseRecords: (input) =>
      client.app.listWorkspaceVaultUseRecords(input.workspaceId),
    readServerVaultUseRecords: () => client.app.listServerVaultUseRecords(),
    rebindWorkspaceVaultReference: (input) =>
      client.app.rebindWorkspaceVaultReference(input.workspaceId, input.referenceId, {
        materialBase64: input.materialBase64,
      }),
    readCapabilityUsage: (input) => client.app.getCapabilityUsage(input.workspaceId),
    readWorkspaceEvidenceBundles: (input) =>
      client.app.listWorkspaceEvidenceBundles(input.workspaceId),
    readWorkspaceRuntimeEvidence: (input) =>
      client.app.listWorkspaceRuntimeEvidence(input.workspaceId),
    readWorkspaceAuditEvents: (input) => client.app.listWorkspaceAuditEvents(input.workspaceId),
    readServerAuditEvents: () => client.app.listServerAuditEvents(),
    readWorkspacePermissionDecisions: (input) =>
      client.app.listWorkspacePermissionDecisions(input.workspaceId),
    readServerPermissionDecisions: () => client.app.listServerPermissionDecisions(),
    consumeBootstrapToken: (input) => client.app.consumeBootstrapToken(input),
    listOpenKitAccessTokens: () => client.app.listOpenKitAccessTokens(),
    createOpenKitAccessToken: (input) => client.app.createOpenKitAccessToken(input),
    revokeOpenKitAccessToken: (input) => client.app.revokeOpenKitAccessToken(input.tokenId),
    rotateOpenKitAccessToken: (input) => {
      const { tokenId } = input;
      const request = input.graceSeconds === undefined ? {} : { graceSeconds: input.graceSeconds };
      return client.app.rotateOpenKitAccessToken(tokenId, request);
    },
    readVaultAdminStatus: () => client.app.getVaultAdminStatus(),
    unlockVaultAdminBackend: (input) => client.app.unlockVaultAdminBackend(input),
    lockVaultAdminBackend: () => client.app.lockVaultAdminBackend(),
    bootstrapCodexAuthJsonVaultReference: (input) =>
      client.app.bootstrapCodexAuthJsonVaultReference(input),
    listAutomations: () => client.app.listAutomations(),
    createAutomation: (input) => client.app.createAutomation(input),
    updateAutomation: (input) =>
      client.app.updateAutomation(input.automationId, { status: input.status }),
    deleteAutomation: (input) => client.app.deleteAutomation(input.automationId),
    answerKnowledge: (input) =>
      client.app.answerKnowledgeManager(input.workspaceId, {
        caller: 'assistant',
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    prepareKnowledgeContext: (input) =>
      client.app.prepareKnowledgeContext(input.workspaceId, {
        artifactIds: input.artifactIds ?? [],
        caller: 'workflow-coordinator',
        query: input.query,
        workspaceFiles: input.workspaceFiles ?? [],
        workspaceRootFiles: input.workspaceRootFiles ?? [],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    readKnowledgeContextPackageTrace: (input) =>
      client.app.readKnowledgeContextPackageTrace(input.workspaceId, input.contextPackageId),
    readKnowledgeContextPackageMaterialization: (input) =>
      client.app.readKnowledgeContextPackageMaterialization(
        input.workspaceId,
        input.contextPackageId
      ),
    materializeKnowledgeContextPackage: (input) =>
      client.app.materializeKnowledgeContextPackage(input.workspaceId, input.contextPackageId),
    draftKnowledgeProposal: (input) =>
      client.app.draftKnowledgeProposal(input.workspaceId, {
        caller: 'system',
        requestId: input.requestId,
        title: input.title,
        summary: input.summary,
        sourceReferences: input.sourceReferences ?? [],
        confidence: input.confidence ?? 0.5,
      }),
    suggestKnowledgeRepairs: (input) =>
      client.app.suggestKnowledgeRepairs(input.workspaceId, {
        caller: 'system',
        limit: input.limit ?? 10,
      }),
    checkKnowledgeHealth: (input) =>
      client.app.checkKnowledgeHealth(input.workspaceId, {
        caller: 'system',
        limit: input.limit ?? 10,
      }),
    registerKnowledgeSource: (input) =>
      client.app.registerKnowledgeSource(input.workspaceId, {
        caller: 'system',
        requestId: input.requestId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        ...(input.uri === undefined ? {} : { uri: input.uri }),
        ...(input.originatingThreadId === undefined
          ? {}
          : { originatingThreadId: input.originatingThreadId }),
        ...(input.originatingTurnId === undefined
          ? {}
          : { originatingTurnId: input.originatingTurnId }),
        ...(input.originatingFileId === undefined
          ? {}
          : { originatingFileId: input.originatingFileId }),
      }),
    listKnowledgeSources: (input) => client.app.listKnowledgeSources(input.workspaceId),
    readKnowledgeSource: (input) =>
      client.app.readKnowledgeSource(input.workspaceId, input.sourceId),
    readKnowledgeIndexes: (input) => client.app.readKnowledgeIndexes(input.workspaceId),
    retrieveKnowledge: (input) =>
      client.app.retrieveKnowledge(input.workspaceId, {
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        pinnedConceptIds: input.pinnedConceptIds ?? [],
      }),
    recordKnowledgeObservation: (input) =>
      client.app.recordKnowledgeObservation(input.workspaceId, {
        requestId: input.requestId,
        kind: input.kind,
        summary: input.summary,
        sourceReferences: input.sourceReferences ?? [],
        scope: input.scope ?? 'workspace',
        producer: input.producer,
        confidence: input.confidence ?? 0.5,
        freshness: input.freshness ?? 'current',
        status: input.status ?? 'retained',
        ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
      }),
    listKnowledgeObservations: (input) => client.app.listKnowledgeObservations(input.workspaceId),
    recordKnowledgeClaim: (input) =>
      client.app.recordKnowledgeClaim(input.workspaceId, {
        requestId: input.requestId,
        statement: input.statement,
        sourceReferences: input.sourceReferences ?? [],
        scope: input.scope ?? 'workspace',
        producer: input.producer,
        confidence: input.confidence ?? 0.5,
        freshness: input.freshness ?? 'current',
        reviewState: input.reviewState ?? 'needs-review',
        conflictStatus: input.conflictStatus ?? 'none',
      }),
    listKnowledgeClaims: (input) => client.app.listKnowledgeClaims(input.workspaceId),
    promoteKnowledgeClaim: (input) =>
      client.app.promoteKnowledgeClaim(input.workspaceId, input.claimId, {
        caller: input.caller ?? 'system',
        requestId: input.requestId,
      }),
    recordKnowledgeConflict: (input) =>
      client.app.recordKnowledgeConflict(input.workspaceId, {
        requestId: input.requestId,
        subjectReferences: input.subjectReferences,
        sourceReferences: input.sourceReferences ?? [],
        status: input.status ?? 'conflicting',
        summary: input.summary,
        suggestedActions: input.suggestedActions ?? [],
        producer: input.producer,
      }),
    resolveKnowledgeConflict: (input) =>
      client.app.resolveKnowledgeConflict(input.workspaceId, input.conflictId, {
        requestId: input.requestId,
        status: input.status ?? 'resolved',
        resolution: input.resolution,
        resolvedBy: input.resolvedBy,
      }),
    listKnowledgeConflicts: (input) => client.app.listKnowledgeConflicts(input.workspaceId),
    readWorkspaceResources: (input) => client.core.getWorkspaceResources(input.workspaceId),
    readWorkspaceReviews: (input) =>
      input.reviewId
        ? client.app.getWorkspaceSyncReview(input.workspaceId, input.reviewId)
        : client.app.listWorkspaceSyncReviews(input.workspaceId),
    readWorkspaceApplyResults: (input) =>
      input.applyResultId
        ? client.app.getWorkspaceApplyResult(input.workspaceId, input.applyResultId)
        : client.app.listWorkspaceApplyResults(input.workspaceId),
    readAgentEnvironmentPackageSnapshots: (input) =>
      input.snapshotId
        ? client.app.getAgentEnvironmentPackageSnapshot(input.workspaceId, input.snapshotId)
        : client.app.listAgentEnvironmentPackageSnapshots(input.workspaceId),
    readGitPushRecords: (input) =>
      input.pushRecordId
        ? client.repositories.getGitPushRecord(input.workspaceId, input.pushRecordId)
        : client.repositories.listGitPushRecords(input.workspaceId),
    requestGitPushApproval: (input) =>
      client.repositories.requestGitPushApproval(input.workspaceId, input.repositoryResourceId, {
        commitIds: input.commitIds,
        requestId: input.requestId,
        sourceRef: input.sourceRef,
        targetBranch: input.targetBranch,
        threadId: input.threadId,
        turnId: input.turnId,
      }),
    readWorkspaceSyncRecords: (input) =>
      readWorkspaceSyncRecordPayloads(client, input.workspaceId, input.kind),
    readGoal: (input) => client.app.getThreadGoalSummary(input.workspaceId, input.threadId),
    readRepositories: async (input) => {
      const [repositories, diagnostics] = await Promise.all([
        client.repositories.list(input.workspaceId),
        client.repositories.diagnostics(input.workspaceId),
      ]);
      return { diagnostics, repositories };
    },
    readRuntimeDiagnostics: () => client.app.getDiagnostics(),
    readStatus: async (input) => {
      const meta = await client.core.meta();
      const workspaceId = input.workspaceId;
      const [repositories, actionCenter, goal] = await Promise.all([
        workspaceId
          ? client.repositories.diagnostics(workspaceId).catch((error: unknown) => ({ error }))
          : Promise.resolve(null),
        workspaceId
          ? client.actionCenter
              .listHumanAttention(workspaceId)
              .catch((error: unknown) => ({ error }))
          : Promise.resolve(null),
        workspaceId && input.threadId
          ? client.app
              .getThreadGoalSummary(workspaceId, input.threadId)
              .catch((error: unknown) => ({ error }))
          : Promise.resolve(null),
      ]);

      return { actionCenter, goal, meta, repositories };
    },
    readThread: async (input) => {
      const [thread, dashboard, items] = await Promise.all([
        client.core.getThread(input.workspaceId, input.threadId),
        client.app.getThreadDashboard(input.workspaceId, input.threadId),
        client.core.listThreadItems(input.workspaceId, input.threadId, { limit: 20 }),
      ]);
      return { dashboard, items, thread };
    },
    resolveActionCenterItem: async (input) => {
      const rows = await client.actionCenter.listHumanAttention(input.workspaceId);
      const row = rows.items.find((candidate) => candidate.id === input.rowId);

      if (!row) {
        throw new Error(`Action Center row not found: ${input.rowId}`);
      }

      if (!row.actions.some((action) => action.kind === input.actionId)) {
        throw new Error(`Action Center action not available: ${input.actionId}`);
      }

      if (row.source.type === 'artifact') {
        const request = {
          decision: input.decision as never,
          requestId: input.requestId,
          ...(input.comment ? { message: input.comment } : {}),
        };

        return client.app.submitArtifactReviewDecision(input.workspaceId, row.source.artifactId, {
          ...request,
        });
      }

      if (row.source.type === 'goal_review') {
        const verdict =
          input.actionId === 'accept_review'
            ? 'accept'
            : input.actionId === 'request_refinement'
              ? 'refine'
              : input.actionId === 'retry_work'
                ? 'retry'
                : input.actionId === 'abort'
                  ? 'abort'
                  : null;
        if (!verdict || input.decision !== verdict) {
          throw new Error('Goal Review action and decision do not match.');
        }

        return client.app.submitGoalReviewDecision(
          input.workspaceId,
          row.source.threadId,
          row.source.goalId,
          row.source.reviewId,
          {
            requestId: input.requestId,
            verdict,
            ...(verdict === 'refine' && input.comment
              ? { revisionInstruction: input.comment }
              : {}),
            ...((verdict === 'retry' || verdict === 'abort') && input.comment
              ? { reason: input.comment }
              : {}),
          }
        );
      }

      if (row.source.type === 'workspace_recovery') {
        return client.app.submitWorkspaceRecoveryDecision(
          input.workspaceId,
          row.source.reconciliationRecordId,
          {
            decision: input.decision as never,
            requestId: input.requestId,
            ...(input.comment ? { message: input.comment } : {}),
          }
        );
      }

      if (row.source.type === 'approval') {
        return client.core.respondApproval(row.source.approvalRequestId, {
          decision: input.decision as never,
          requestId: input.requestId,
          threadId: row.source.threadId,
          turnId: row.source.turnId,
          workspaceId: row.source.workspaceId,
        });
      }

      if (
        row.source.type === 'protocol_item' &&
        row.source.itemType === 'user-input-request' &&
        input.actionId === 'answer_question'
      ) {
        return client.core.startTurn({
          workspaceId: row.source.workspaceId,
          threadId: row.source.threadId,
          turnId: row.source.turnId,
          input: input.comment ?? input.decision,
          requestId: input.requestId,
        });
      }

      throw new Error(`Action Center source is not resolvable through MCP yet: ${row.source.type}`);
    },
    startChat: (input) =>
      client.app.startChatMode(input.workspaceId, input.threadId, {
        input: input.input,
        requestId: input.requestId,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.model === undefined ? {} : { model: input.model }),
      } satisfies StartChatModeRequest),
    startTask: (input) =>
      client.app.startTaskMode(input.workspaceId, input.threadId, {
        input: input.input,
        requestId: input.requestId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      } satisfies StartTaskModeRequest),
    startGoal: (input) =>
      client.app.startThreadGoal(input.workspaceId, input.threadId, {
        objective: input.objective,
        requestId: input.requestId,
      }),
    startNanoCore: async () => ({
      allowStartup: options.allowStartup === true,
      status: options.allowStartup === true ? 'not_configured' : 'disabled',
      summary:
        options.allowStartup === true
          ? 'NanoCore startup is allowed but no allowlisted launcher is configured in this milestone.'
          : 'NanoCore startup is disabled. Start NanoCore separately and reconnect.',
    }),
    reloadRuntimeConfig: (input) =>
      client.runtimeConfig.reload({
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      }),
    restartRuntimeConfigStaleSession: (input) =>
      client.runtimeConfig.restartStaleSession(input.workspaceId, input.sessionId),
    stepGoal: (input) =>
      client.app.runThreadGoalStep(input.workspaceId, input.threadId, {
        requestId: input.requestId,
      }),
    submitSteering: (input) =>
      client.app.submitThreadGoalSteering(input.workspaceId, input.threadId, {
        message: input.message,
        requestId: input.requestId,
      }),
    updateRuntimeConfigFile: (input) =>
      client.runtimeConfig.updateFile({
        id: input.id,
        kind: input.kind,
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      }),
    updateWorkspace: (input) =>
      client.core.updateWorkspace(input.workspaceId, {
        requestId: input.requestId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.defaults === undefined ? {} : { defaults: input.defaults }),
      }),
    validateRuntimeConfig: (input) =>
      client.runtimeConfig.validate({
        files: [{ content: input.content, id: input.id }],
        mode: input.mode ?? 'safe',
      }),
  };
}

/**
 * Reads durable workspace synchronization records through public App API client methods.
 *
 * @param client Public OpenKit core client.
 * @param workspaceId Workspace id.
 * @param kind Optional record kind filter.
 * @returns Durable record payloads grouped by product record type.
 */
async function readWorkspaceSyncRecordPayloads(
  client: CoreClient,
  workspaceId: string,
  kind?: ReadWorkspaceSyncRecordsInput['kind']
): Promise<unknown> {
  if (kind === 'input-snapshots') {
    return { inputSnapshots: await client.app.listWorkspaceInputSnapshots(workspaceId) };
  }

  if (kind === 'materialization-records') {
    return {
      materializationRecords: await client.app.listWorkspaceMaterializationRecords(workspaceId),
    };
  }

  if (kind === 'backend-handles') {
    return { backendHandles: await client.app.listBackendWorkspaceHandles(workspaceId) };
  }

  if (kind === 'output-manifests') {
    return { outputManifests: await client.app.listWorkerOutputManifests(workspaceId) };
  }

  if (kind === 'change-sets') {
    return { changeSets: await client.app.listWorkspaceChangeSets(workspaceId) };
  }

  if (kind === 'staged-reviews') {
    return { stagedReviews: await client.app.listStagedWorkspaceReviews(workspaceId) };
  }

  if (kind === 'apply-plans') {
    return { applyPlans: await client.app.listWorkspaceApplyPlans(workspaceId) };
  }

  if (kind === 'reconciliation-records') {
    return {
      reconciliationRecords: await client.app.listWorkspaceReconciliationRecords(workspaceId),
    };
  }

  if (kind === 'quarantine-records') {
    return {
      quarantineRecords: await client.app.listWorkspaceQuarantineRecords(workspaceId),
    };
  }

  const [
    inputSnapshots,
    materializationRecords,
    backendHandles,
    outputManifests,
    changeSets,
    stagedReviews,
    applyPlans,
    reconciliationRecords,
    quarantineRecords,
  ] = await Promise.all([
    client.app.listWorkspaceInputSnapshots(workspaceId),
    client.app.listWorkspaceMaterializationRecords(workspaceId),
    client.app.listBackendWorkspaceHandles(workspaceId),
    client.app.listWorkerOutputManifests(workspaceId),
    client.app.listWorkspaceChangeSets(workspaceId),
    client.app.listStagedWorkspaceReviews(workspaceId),
    client.app.listWorkspaceApplyPlans(workspaceId),
    client.app.listWorkspaceReconciliationRecords(workspaceId),
    client.app.listWorkspaceQuarantineRecords(workspaceId),
  ]);

  return {
    applyPlans,
    backendHandles,
    changeSets,
    inputSnapshots,
    materializationRecords,
    outputManifests,
    quarantineRecords,
    reconciliationRecords,
    stagedReviews,
  };
}
