import { createHash } from 'node:crypto';
import {
  ArtifactReviewViewSchema,
  BackendWorkspaceHandleSchema,
  EvidenceBundleRecordSchema,
  GitPushRecordSchema,
  GoalReviewResolutionSnapshotSchema,
  GoalReviewVerdictSchema,
  KnowledgeClaimSchema,
  KnowledgeConflictSchema,
  KnowledgeObservationSchema,
  KnowledgeRetrievalResponseSchema,
  RuntimeEvidenceRecordSchema,
  StagedWorkspaceReviewSchema,
  WorkerOutputManifestSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceApplyResultSchema,
  WorkspaceChangeSetSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
  WorkspaceMaterialRevisionViewSchema,
  WorkspaceMaterialViewSchema,
  WorkspaceQuarantineRecordSchema,
  WorkspaceReconciliationRecordSchema,
  WorkspaceRepositoryGitConfigSchema,
  WorkspaceSyncReviewPatchPayloadSchema,
} from '@openkit/app-api-schemas';
import {
  AgentEnvironmentPackageSchema,
  parseWorkspaceDataSourceCatalog,
  type WorkspaceDataSourceCatalog,
  type WorkspaceExportManifest,
} from '@openkit/config-schema';
import {
  ArtifactSchema,
  AuditEventSchema,
  CapabilityCallSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  SseEventEnvelopeSchema,
  ThreadSchema,
  TurnSchema,
  UsageRecordSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { ResolvedAgentSetupRecord } from '../agents/setup-ledger.js';
import {
  ArtifactReviewFollowUpRequestSchema,
  deriveArtifactReviewFollowUpTurnId,
  deriveArtifactReviewId,
  deriveArtifactReviewWorkerRequestId,
  serializeArtifactReviewFollowUpRequest,
} from '../artifact-reviews.js';
import {
  buildWorkerContextPackageWorkspaceInput,
  createWorkerContextPackageFiles,
  createWorkerContextPackagePolicyDigest,
  createWorkerContextPackageTrace,
  parseWorkerContextPackageTrace,
  serializeWorkerContextPackageTrace,
  verifyImportedWorkerContextPackageTrace,
  type WorkerContextPackageAuthorityReader,
  type WorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import {
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { parseOkfDocument, stringFrontmatterField } from '../knowledge/okf.js';
import type { AgentSession, KnowledgeSourceRecord } from '../lib/store.js';
import type { AgentEnvironmentPackageSnapshotRecord } from '../runtime/aep-snapshot-ledger.js';
import {
  assertValidGoalPlanGraph,
  computeGoalPlanDigest,
  GoalPlanOutputSchema,
  type GoalPlanTask,
  GoalPlanTaskSchema,
  selectGoalPlanPayload,
} from '../runtime/goal-plan.js';
import { assertGoalReviewRecordConsistency } from '../runtime/goal-review-records.js';
import { createWorkerRuntimeProvenanceEvidenceId } from '../runtime/runtime-evidence.js';
import {
  createWorkerRuntimeProvenanceBundleId,
  remintWorkerRuntimeProvenanceIndex,
  WorkerRuntimeOriginIndexRowSchema,
} from '../runtime/worker-runtime-provenance.js';
import {
  dryRunWorkspaceImport,
  type ExportedKnowledgeSourceMaterial,
  type VerifiedWorkspaceExportTree,
  type WorkspaceImportDryRunReport,
} from './workspace-export.js';
import {
  AgentSessionRecordSchema,
  artifactContentFileName,
  artifactReferenceItemId,
  assertSafeWorkspacePathSegment,
  KnowledgeSourceRecordSchema,
  knowledgeEntriesEqual,
  listUnresolvedUserInputRequestItemIds,
  parseCanonicalWorkspaceHistory,
  parseOwnedKnowledgeEntry,
} from './workspace-file-records.js';
import type { WorkspacePortableFileState } from './workspace-portable-file-state.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;
type KnowledgeEntry = import('zod').infer<typeof KnowledgeEntrySchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Artifact = import('zod').infer<typeof ArtifactSchema>;
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;
type AuditEvent = import('zod').infer<typeof AuditEventSchema>;
type EvidenceBundleRecord = z.infer<typeof EvidenceBundleRecordSchema>;
type RuntimeEvidenceRecord = z.infer<typeof RuntimeEvidenceRecordSchema>;
type UsageRecord = import('zod').infer<typeof UsageRecordSchema>;
type WorkspaceInputSnapshot = z.infer<typeof WorkspaceInputSnapshotSchema>;
type WorkspaceMaterializationRecord = z.infer<typeof WorkspaceMaterializationRecordSchema>;
type BackendWorkspaceHandle = z.infer<typeof BackendWorkspaceHandleSchema>;
type WorkerOutputManifest = z.infer<typeof WorkerOutputManifestSchema>;
type WorkspaceChangeSet = z.infer<typeof WorkspaceChangeSetSchema>;
type WorkspaceApplyPlan = z.infer<typeof WorkspaceApplyPlanSchema>;
type WorkspaceQuarantineRecord = z.infer<typeof WorkspaceQuarantineRecordSchema>;
type WorkspaceReconciliationRecord = z.infer<typeof WorkspaceReconciliationRecordSchema>;

const ImportedWorkspaceMaterialSchema = WorkspaceMaterialViewSchema.extend({
  lastMutationRequestId: z.string().min(1),
}).strict();
const ImportedWorkspaceMaterialRevisionSchema = WorkspaceMaterialRevisionViewSchema.extend({
  createdByRequestId: z.string().min(1),
}).strict();
const ImportedThreadMaterialBindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    materialId: z.string().min(1),
    bindingState: z.enum(['bound', 'unbound']),
    latestQueuedRevisionId: z.string().min(1).nullable(),
    inclusionState: z.enum(['included', 'excluded']),
    lastMutationRequestId: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const ImportedArtifactReviewSchema = ArtifactReviewViewSchema.extend({
  decisionRequestId: z.string().min(1).nullable(),
}).strict();

/** Strict portable Workspace Material owner accepted by import. */
type ImportedWorkspaceMaterial = z.infer<typeof ImportedWorkspaceMaterialSchema>;
/** Strict portable immutable Material revision accepted by import. */
type ImportedWorkspaceMaterialRevision = z.infer<typeof ImportedWorkspaceMaterialRevisionSchema>;
/** Strict portable Thread-to-Material binding accepted by import. */
type ImportedThreadMaterialBinding = z.infer<typeof ImportedThreadMaterialBindingSchema>;
/** Strict portable version-keyed Artifact Review accepted by import. */
type ImportedArtifactReview = z.infer<typeof ImportedArtifactReviewSchema>;

const ImportedEvidenceBundleRecordSchema = EvidenceBundleRecordSchema.strict();
const ImportedRuntimeEvidenceRecordSchema = RuntimeEvidenceRecordSchema.strict();
const ImportedUsageRecordSchema = UsageRecordSchema.strict();
const ImportedKnowledgeObservationSchema = KnowledgeObservationSchema.strict();
const ImportedKnowledgeClaimSchema = KnowledgeClaimSchema.strict();
const ImportedKnowledgeConflictSchema = KnowledgeConflictSchema.strict();
const ImportedKnowledgeRetrievalTraceSchema = KnowledgeRetrievalResponseSchema.strict();

const ExportedResolvedAgentSetupSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
    agentId: z.string().min(1),
    providerId: z.string().min(1).nullable(),
    runtimeKind: z.string().min(1),
    runtimeAdapter: z.string().min(1),
    setupRequiredFeatures: z.array(z.string().min(1)),
    setup: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();

type ExportedResolvedAgentSetup = Omit<ResolvedAgentSetupRecord, 'setup'> & {
  readonly requiredFeatures: ResolvedAgentSetupRecord['requiredFeatures'];
  readonly setup: ResolvedAgentSetupRecord['setup'];
};

const ExportedAgentEnvironmentPackageSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    workspaceId: z.string().min(1),
    turnId: z.string().min(1),
    threadId: z.string().min(1),
    agentSessionId: z.string().min(1),
    agentId: z.string().min(1),
    packageId: z.string().min(1),
    runtimeKind: z.string().min(1),
    backendKind: z.string().min(1),
    contentDigest: z.string().min(1),
    snapshot: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();

type ExportedAgentEnvironmentPackageSnapshot = Omit<
  AgentEnvironmentPackageSnapshotRecord,
  'snapshot'
> & {
  readonly snapshot: AgentEnvironmentPackageSnapshotRecord['snapshot'];
};

const ExportedWorkspaceRepositoryResourceSchema = z
  .object({
    resourceId: z.string().min(1),
    type: z.literal('git_repository'),
    displayName: z.string().min(1),
    git: WorkspaceRepositoryGitConfigSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedWorkspaceRepositoryResource = z.infer<
  typeof ExportedWorkspaceRepositoryResourceSchema
>;

const ExportedCapabilityCallSchema = CapabilityCallSchema.extend({
  family: z.enum(['llm', 'mcp', 'knowledge', 'runtime', 'storage', 'workspace']),
  operation: z.string().min(1),
  providerRef: z.string().min(1).nullable(),
  serviceRef: z.string().min(1).nullable(),
  redactionClass: z.string().min(1),
}).strict();

type ExportedCapabilityCall = z.infer<typeof ExportedCapabilityCallSchema>;

const ExportedGitPushRecordSchema = GitPushRecordSchema.extend({
  requestId: z.string().min(1),
}).strict();

type ExportedGitPushRecord = z.infer<typeof ExportedGitPushRecordSchema>;

const ExportedStagedWorkspaceReviewSchema = z
  .object({
    artifactId: z.string().min(1),
    review: StagedWorkspaceReviewSchema,
    patchPayload: WorkspaceSyncReviewPatchPayloadSchema.nullable(),
  })
  .strict();

type ExportedStagedWorkspaceReview = z.infer<typeof ExportedStagedWorkspaceReviewSchema>;

const ExportedWorkspaceApplyResultSchema = WorkspaceApplyResultSchema.extend({
  requestId: z.string().min(1),
}).strict();

type ExportedWorkspaceApplyResult = z.infer<typeof ExportedWorkspaceApplyResultSchema>;

const ExportedWorkspacePermissionDecisionSchema = z
  .object({
    action: z.string().min(1),
    approvalId: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    contextSummary: z.unknown(),
    createdAt: z.string().datetime(),
    decisionId: z.string().min(1),
    enforcementPoint: z.string().min(1),
    ownerScope: z.literal('workspace'),
    policyEngineVersion: z.string().min(1),
    policySnapshotId: z.string().min(1),
    reasonCode: z.string().min(1),
    requiredApprovalKind: z.string().min(1).nullable(),
    resourceSummary: z.unknown(),
    result: z.enum([
      'allow',
      'deny',
      'require_approval',
      'require_escalation',
      'defer',
      'not_applicable',
      'error',
    ]),
    subjectSummary: z.unknown(),
    workspaceId: z.string().min(1),
  })
  .strict();

type ExportedWorkspacePermissionDecision = z.infer<
  typeof ExportedWorkspacePermissionDecisionSchema
>;

const ExportedStopReasonSchema = z.enum([
  'completed',
  'aborted',
  'ask_user',
  'error',
  'length',
  'budget_exhausted',
]);

const ExportedWorkerCheckpointSchema = z
  .object({
    checkpointId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    goalId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    requestId: z.string().min(1),
    requestInputHash: z.string().min(1),
    stage: z.enum([
      'preparing',
      'running_worker',
      'waiting_for_user',
      'completed',
      'failed',
      'aborted',
    ]),
    iteration: z.number().int().nonnegative(),
    workerSessionId: z.string().min(1).nullable(),
    contextDigest: z.string().min(1).nullable(),
    stopReason: ExportedStopReasonSchema.nullable(),
    diagnosticsSummary: z.string().min(1).nullable(),
    replayInstruction: z.literal(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedWorkerCheckpoint = z.infer<typeof ExportedWorkerCheckpointSchema>;

const ExportedGoalRecordSchema = z
  .object({
    goalId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.enum([
      'planning',
      'awaiting_plan_approval',
      'running',
      'awaiting_user',
      'paused',
      'reviewing',
      'completed',
      'blocked',
      'aborted',
      'failed',
    ]),
    title: z.string().min(1),
    objective: z.string().min(1),
    createdByItemId: z.string().min(1).nullable(),
    planItemId: z.string().min(1).nullable(),
    currentTaskId: z.string().min(1).nullable(),
    terminalStopReason: ExportedStopReasonSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedGoalRecord = z.infer<typeof ExportedGoalRecordSchema>;

const ExportedGoalPlanRecordSchema = GoalPlanOutputSchema.extend({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  goalId: z.string().min(1),
  planItemId: z.string().min(1),
  planDigest: z.string().min(1),
  createdByRequestId: z.string().min(1),
  createdAt: z.string().datetime(),
}).strict();

type ExportedGoalPlanRecord = z.infer<typeof ExportedGoalPlanRecordSchema>;

const ExportedGoalTaskSchema = GoalPlanTaskSchema.extend({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  goalId: z.string().min(1),
  planItemId: z.string().min(1),
  status: z.enum(['pending', 'ready', 'running', 'reviewing', 'completed', 'blocked', 'failed']),
  latestGateContextItemId: z.string().min(1).nullable(),
  orderIndex: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

type ExportedGoalTask = z.infer<typeof ExportedGoalTaskSchema>;

const ExportedGoalReviewRecordSchema = z
  .object({
    reviewId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    goalId: z.string().min(1),
    taskId: z.string().min(1),
    turnId: z.string().min(1),
    itemIds: z.array(z.string().min(1)),
    artifactIds: z.array(z.string().min(1)),
    verificationEvidence: z.array(z.unknown()),
    prompt: z.string().min(1),
    createdByRequestId: z.string().min(1),
    verdict: GoalReviewVerdictSchema.nullable(),
    reason: z.string().min(1).nullable(),
    revisionInstruction: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    resolutionRequestId: z.string().min(1).nullable(),
    resolvedByActorId: z.string().min(1).nullable(),
    resolutionSnapshot: GoalReviewResolutionSnapshotSchema.nullable(),
  })
  .strict();

type ExportedGoalReviewRecord = z.infer<typeof ExportedGoalReviewRecordSchema>;

const ExportedGoalVerificationRecordSchema = z
  .object({
    verificationId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    goalId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    commandId: z.string().min(1).nullable(),
    command: z.string().min(1).nullable(),
    status: z.enum(['passed', 'failed', 'skipped', 'unavailable', 'manual_required']),
    summary: z.string().min(1),
    itemIds: z.array(z.string().min(1)),
    artifactIds: z.array(z.string().min(1)),
    outputPointers: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedGoalVerificationRecord = z.infer<typeof ExportedGoalVerificationRecordSchema>;

const ExportedMcpToolSchemaSnapshotSchema = z
  .object({
    capturedAt: z.string().datetime(),
    catalogEntryId: z.string().min(1),
    contentDigest: z.string().min(1),
    schemaSnapshotId: z.string().min(1),
    serverVersion: z.string().min(1).nullable(),
    source: z.enum(['aep', 'live']),
    sourceRef: z.string().min(1).nullable(),
    tools: z.array(
      z
        .object({
          inputSchema: z.record(z.string(), z.unknown()),
          name: z.string().min(1),
        })
        .strict()
    ),
    workspaceId: z.string().min(1),
  })
  .strict();

type ExportedMcpToolSchemaSnapshot = z.infer<typeof ExportedMcpToolSchemaSnapshotSchema>;

const ExportedWorkspaceVaultReferenceSchema = z
  .object({
    sourceReferenceId: z.string().min(1),
    displayName: z.string().min(1),
    secretKind: z.string().min(1),
    backendKind: z.enum(['encrypted-file', 'os-keychain']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const ImportedWorkspaceVaultReferenceSchema = ExportedWorkspaceVaultReferenceSchema.extend({
  referenceId: z.string().min(1),
  ownerScope: z.literal('workspace'),
  workspaceId: z.string().min(1),
  backendLocator: z.null(),
  status: z.literal('unbound'),
  currentVersion: z.literal(0),
}).strict();

type ImportedWorkspaceVaultReference = z.infer<typeof ImportedWorkspaceVaultReferenceSchema>;

const ExportedVaultGrantSchema = z
  .object({
    grantId: z.string().min(1),
    vaultReferenceId: z.string().min(1),
    ownerScope: z.literal('workspace'),
    workspaceId: z.string().min(1),
    userId: z.null(),
    subjectSummary: z.string().min(1).nullable(),
    targetAgentId: z.string().min(1).nullable(),
    targetAgentSessionId: z.string().min(1).nullable(),
    targetCapabilityId: z.string().min(1).nullable(),
    allowedInjectionPaths: z.array(z.string().min(1)),
    lifetime: z.enum(['capability-call', 'turn', 'agent-session', 'workspace', 'server']),
    policyDecisionId: z.string().min(1).nullable(),
    approvalId: z.string().min(1).nullable(),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();

type ExportedVaultGrant = z.infer<typeof ExportedVaultGrantSchema>;

const ExportedInjectionPlanSchema = z
  .object({
    planId: z.string().min(1),
    grantId: z.string().min(1),
    packageSnapshotId: z.string().min(1).nullable(),
    capabilityId: z.string().min(1).nullable(),
    injectionVisibility: z.enum([
      'gateway-only',
      'backend-provider',
      'runtime-file',
      'runtime-env',
      'runtime-token',
      'external-handle',
    ]),
    targetPath: z.string().min(1).nullable(),
    targetEnvVarName: z.string().min(1).nullable(),
    expirationBehavior: z.string().min(1),
    revocationBehavior: z.string().min(1),
    redactionRule: z.string().min(1),
    backendCapabilityRequirement: z.string().min(1),
    status: z.enum(['active', 'revoked', 'expired']),
    createdAt: z.string().datetime(),
  })
  .strict();

type ExportedInjectionPlan = z.infer<typeof ExportedInjectionPlanSchema>;

const ExportedInjectionReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    planId: z.string().min(1),
    grantId: z.string().min(1),
    agentSessionId: z.string().min(1).nullable(),
    capabilityCallId: z.string().min(1).nullable(),
    backendSummary: z.string().min(1),
    injectedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    revocationStatus: z.enum(['active', 'revoked', 'expired', 'stale-session']),
    auditEventId: z.string().min(1).nullable(),
  })
  .strict();

type ExportedInjectionReceipt = z.infer<typeof ExportedInjectionReceiptSchema>;

const ExportedVaultUseRecordSchema = z
  .object({
    useId: z.string().min(1),
    ownerScope: z.literal('workspace'),
    workspaceId: z.string().min(1),
    vaultReferenceId: z.string().min(1),
    materialVersion: z.number().int().nonnegative().nullable(),
    backendKind: z.enum(['encrypted-file', 'os-keychain']),
    resolvingPath: z.enum(['grant', 'plan', 'admin', 'provider']),
    grantId: z.string().min(1).nullable(),
    planId: z.string().min(1).nullable(),
    receiptId: z.string().min(1).nullable(),
    agentSessionId: z.string().min(1).nullable(),
    capabilityCallId: z.string().min(1).nullable(),
    outcome: z.enum(['succeeded', 'failed', 'denied']),
    failureCode: z.string().min(1).nullable(),
    auditEventId: z.string().min(1).nullable(),
    usedAt: z.string().datetime(),
  })
  .strict();

type ExportedVaultUseRecord = z.infer<typeof ExportedVaultUseRecordSchema>;

/** Input for reading one verified export into importable records. */
export interface ReadWorkspaceImportSnapshotInput {
  /** Already verified export tree whose exact bytes are being imported. */
  verified: VerifiedWorkspaceExportTree;
  /** Workspace id to use in imported records. */
  targetWorkspaceId: string;
}

/** Importable record snapshot extracted from one workspace export. */
export interface WorkspaceImportSnapshot {
  /** Verified dry-run report for the export. */
  report: WorkspaceImportDryRunReport;
  /** Imported workspace record with target id. */
  workspace: WorkspaceRecord;
  /** Imported thread records with target workspace id. */
  threads: Thread[];
  /** Imported turns with target workspace, thread, and current item lineage. */
  turns: Turn[];
  /** Imported knowledge records. */
  knowledge: KnowledgeEntry[];
  /** Imported full item revision history. */
  itemRevisions: Item[];
  /** Imported artifacts with reconstructed bodies. */
  artifacts: Artifact[];
  /** Imported Workspace Material owners. */
  workspaceMaterials: ImportedWorkspaceMaterial[];
  /** Imported immutable Material revisions. */
  workspaceMaterialRevisions: ImportedWorkspaceMaterialRevision[];
  /** Imported Thread-to-Material bindings. */
  threadMaterialBindings: ImportedThreadMaterialBinding[];
  /** Imported version-keyed Artifact Reviews. */
  artifactReviews: ImportedArtifactReview[];
  /** Imported durable agent sessions. */
  agentSessions: AgentSession[];
  /** Imported retained turn event logs keyed by reminted turn id. */
  turnEvents: Array<[string, SseEventEnvelope[]]>;
  /** Imported knowledge source identity records. */
  knowledgeSources: KnowledgeSourceRecord[];
  /** Imported knowledge source text materials. */
  knowledgeSourceMaterials: ExportedKnowledgeSourceMaterial[];
  /** Imported unbound workspace vault references. */
  vaultReferences: ImportedWorkspaceVaultReference[];
  /** Imported non-secret workspace vault grants. */
  vaultGrants: ExportedVaultGrant[];
  /** Imported non-secret injection plans. */
  injectionPlans: ExportedInjectionPlan[];
  /** Imported non-secret injection receipts. */
  injectionReceipts: ExportedInjectionReceipt[];
  /** Imported non-secret workspace vault use records. */
  vaultUseRecords: ExportedVaultUseRecord[];
  /** Imported workspace audit events. */
  auditEvents: AuditEvent[];
  /** Imported workspace capability calls. */
  capabilityCalls: ExportedCapabilityCall[];
  /** Imported workspace evidence bundles. */
  evidenceBundles: EvidenceBundleRecord[];
  /** Imported workspace runtime evidence. */
  runtimeEvidence: RuntimeEvidenceRecord[];
  /** Reminted product-safe runtime provenance indexes keyed by target bundle id. */
  runtimeProvenanceIndexes: ReadonlyMap<string, string>;
  /** Imported workspace usage records. */
  usageRecords: UsageRecord[];
  /** Imported workspace-owned data source catalog. */
  dataSourceCatalog: WorkspaceDataSourceCatalog | null;
  /** Imported workspace Git push records. */
  gitPushRecords: ExportedGitPushRecord[];
  /** Imported resolved agent setup records. */
  resolvedAgentSetups: ExportedResolvedAgentSetup[];
  /** Imported redacted Agent Environment Package snapshots. */
  agentEnvironmentPackageSnapshots: ExportedAgentEnvironmentPackageSnapshot[];
  /** Imported workspace repository resources. */
  workspaceRepositories: ExportedWorkspaceRepositoryResource[];
  /** Imported workspace sync input snapshots. */
  workspaceInputSnapshots: WorkspaceInputSnapshot[];
  /** Imported workspace sync materialization records. */
  workspaceMaterializationRecords: WorkspaceMaterializationRecord[];
  /** Imported workspace sync backend handles. */
  backendWorkspaceHandles: BackendWorkspaceHandle[];
  /** Imported worker output manifests. */
  workerOutputManifests: WorkerOutputManifest[];
  /** Imported workspace sync change sets. */
  workspaceChangeSets: WorkspaceChangeSet[];
  /** Imported staged workspace review rows. */
  stagedWorkspaceReviews: ExportedStagedWorkspaceReview[];
  /** Imported workspace apply plan rows. */
  workspaceApplyPlans: WorkspaceApplyPlan[];
  /** Imported workspace apply result rows. */
  workspaceApplyResults: ExportedWorkspaceApplyResult[];
  /** Imported workspace reconciliation rows. */
  workspaceReconciliationRecords: WorkspaceReconciliationRecord[];
  /** Imported workspace quarantine rows. */
  workspaceQuarantineRecords: WorkspaceQuarantineRecord[];
  /** Imported workspace permission decision rows. */
  permissionDecisions: ExportedWorkspacePermissionDecision[];
  /** Imported worker checkpoint rows. */
  workerCheckpoints: ExportedWorkerCheckpoint[];
  /** Imported Goal Mode goal rows. */
  goalRecords: ExportedGoalRecord[];
  /** Imported immutable Goal Plan rows. */
  goalPlanRecords: ExportedGoalPlanRecord[];
  /** Imported Goal Mode task rows. */
  goalTasks: ExportedGoalTask[];
  /** Imported Goal Mode review rows. */
  goalReviewRecords: ExportedGoalReviewRecord[];
  /** Imported Goal Mode verification rows. */
  goalVerificationRecords: ExportedGoalVerificationRecord[];
  /** Imported MCP tool schema snapshot rows. */
  mcpToolSchemaSnapshots: ExportedMcpToolSchemaSnapshot[];
  /** Imported authoritative workspace files ready for staged publication. */
  portableFileState: WorkspacePortableFileState;
}

/**
 * Verifies every staged imported-history Context Package against the reminted snapshot owners.
 *
 * @param snapshot Fully parsed and reminted import snapshot.
 * @param workspaceRoot Staging root containing the exact reminted package files.
 * @throws Error when any trace, package byte, or portable owner tuple is inconsistent.
 */
export function verifyImportedWorkerContextPackageSnapshot(
  snapshot: WorkspaceImportSnapshot,
  workspaceRoot: string
): void {
  const authorities = createImportedWorkerContextPackageAuthorityReader(snapshot);
  for (const [path, text] of snapshot.portableFileState.workerContextPackageFiles) {
    if (!path.endsWith('/context-package.json')) {
      continue;
    }
    verifyImportedWorkerContextPackageTrace({
      authorities,
      trace: parseWorkerContextPackageTrace(JSON.parse(text)),
      workspaceRoot,
    });
  }
}

/**
 * Builds the read-only authority projection required by imported-history verification.
 *
 * @param snapshot Fully reminted import snapshot.
 * @returns Authority reader backed only by the snapshot's durable owners.
 */
function createImportedWorkerContextPackageAuthorityReader(
  snapshot: WorkspaceImportSnapshot
): WorkerContextPackageAuthorityReader {
  const items = snapshot.turns.flatMap((turn) => turn.items);
  return {
    readAdmission: () => null,
    readAgentEnvironmentPackage: (workspaceId, packageSnapshotId) =>
      snapshot.agentEnvironmentPackageSnapshots.find(
        (record) => record.workspaceId === workspaceId && record.snapshotId === packageSnapshotId
      )?.snapshot ?? null,
    readAgentSession: (workspaceId, agentSessionId) => {
      const session = snapshot.agentSessions.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.id === agentSessionId
      );
      return session?.threadId
        ? {
            id: session.id,
            workspaceId: session.workspaceId,
            threadId: session.threadId,
            environmentPackageSnapshotId: session.environmentPackageSnapshotId,
            stale: session.stale,
          }
        : null;
    },
    readWorkspaceImportedFrom: (workspaceId) =>
      workspaceId === snapshot.workspace.id ? (snapshot.workspace.importedFrom ?? null) : null,
    readBackendHandoff: () => null,
    readGoalTask: (workspaceId, threadId, goalId, taskId) => {
      const goal = snapshot.goalRecords.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.threadId === threadId &&
          candidate.goalId === goalId
      );
      const task = snapshot.goalTasks.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.threadId === threadId &&
          candidate.goalId === goalId &&
          candidate.taskId === taskId
      );
      if (!goal || !task || goal.planItemId === null || task.planItemId !== goal.planItemId) {
        return null;
      }
      const gateContextItemIds = importedGoalGateContextItemIds(task, items);
      return gateContextItemIds ? { goal, task, gateContextItemIds } : null;
    },
    readMaterialRevision: (workspaceId, materialId, revisionId) => {
      const material = snapshot.workspaceMaterials.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.materialId === materialId
      );
      const revision = snapshot.workspaceMaterialRevisions.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.materialId === materialId &&
          candidate.revisionId === revisionId
      );
      return material && revision ? { ...revision, sensitivity: material.sensitivity } : null;
    },
    readThreadItems: (workspaceId, threadId) =>
      items.filter((item) => item.workspaceId === workspaceId && item.threadId === threadId),
    readTurn: (workspaceId, threadId, turnId) => {
      const turn = snapshot.turns.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.threadId === threadId &&
          candidate.id === turnId
      );
      return turn ? { ...turn, agentSessionId: turn.agentSessionId ?? null } : null;
    },
    readWorkspaceInputSnapshot: (workspaceId, snapshotId) =>
      snapshot.workspaceInputSnapshots.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.id === snapshotId
      ) ?? null,
    readWorkspaceMaterializationRecord: (workspaceId, recordId) =>
      snapshot.workspaceMaterializationRecords.find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.id === recordId
      ) ?? null,
  };
}

/**
 * Resolves the already-validated imported Goal Gate pair from reminted Item authority.
 *
 * @param task Imported Goal Task carrying the optional latest Gate response.
 * @param items Imported current Items.
 * @returns Empty ids without a Gate, the exact request-response pair, or null for invalid lineage.
 */
function importedGoalGateContextItemIds(
  task: ExportedGoalTask,
  items: readonly Item[]
): readonly string[] | null {
  if (!task.latestGateContextItemId) {
    return [];
  }
  const response = items.find((item) => item.id === task.latestGateContextItemId);
  const requests =
    response?.type === 'approval-decision'
      ? items.filter(
          (item) =>
            item.type === 'approval-request' &&
            item.turnId === response.turnId &&
            item.approvalRequestId === response.approvalRequestId
        )
      : response?.type === 'user-input-response'
        ? items.filter(
            (item) =>
              item.type === 'user-input-request' &&
              item.turnId === response.turnId &&
              item.userInputRequestId === response.userInputRequestId
          )
        : [];
  return response?.status === 'completed' && requests.length === 1
    ? [requests[0]!.id, response.id]
    : null;
}

/** Shared id lineage used while reconstructing one portable workspace import. */
interface ImportRemintContext {
  /** Exact export files captured by offline verification. */
  files: ReadonlyMap<string, string>;
  /** Digest of the verified manifest bytes. */
  manifestDigest: string;
  /** Dry-run report that owns source export lineage. */
  report: WorkspaceImportDryRunReport;
  /** Workspace id assigned to reconstructed records. */
  targetWorkspaceId: string;
  /** Parsed source Material owners. */
  sourceWorkspaceMaterials: ImportedWorkspaceMaterial[];
  /** Parsed source Material revisions. */
  sourceWorkspaceMaterialRevisions: ImportedWorkspaceMaterialRevision[];
  /** Parsed source Thread Material bindings. */
  sourceThreadMaterialBindings: ImportedThreadMaterialBinding[];
  /** Parsed source version-keyed Artifact Reviews. */
  sourceArtifactReviews: ImportedArtifactReview[];
  /** Imported thread ids keyed by source id. */
  threadIds: Map<string, string>;
  /** Imported turn ids keyed by source id. */
  turnIds: Map<string, string>;
  /** Imported item ids keyed by source id. */
  itemIds: Map<string, string>;
  /** Latest source Item revision keyed by source id. */
  itemLineage: Map<string, Item>;
  /** Imported artifact ids keyed by source id. */
  artifactIds: Map<string, string>;
  /** Imported Material ids keyed by source id. */
  materialIds: Map<string, string>;
  /** Imported Material revision ids keyed by source id. */
  materialRevisionIds: Map<string, string>;
  /** Imported agent-session ids keyed by source id. */
  agentSessionIds: Map<string, string>;
  /** Imported approval-request ids keyed by source id. */
  approvalRequestIds: Map<string, string>;
  /** Imported AEP snapshot ids keyed by source id. */
  agentEnvironmentPackageSnapshotIds: Map<string, string>;
  /** Imported knowledge-source ids keyed by source id. */
  knowledgeSourceIds: Map<string, string>;
  /** Exact accepted Context Package references keyed by their source form. */
  contextPackageReferences: Map<string, string>;
  /** Imported Goal ids keyed by source id. */
  goalIds: Map<string, string>;
  /** Imported Goal task ids keyed by source id. */
  goalTaskIds: Map<string, string>;
  /** Imported worker checkpoint ids keyed by source id. */
  workerCheckpointIds: Map<string, string>;
  /** Source Plan Item ids whose step projections carry Goal Task ids. */
  goalPlanItemIds: Set<string>;
  /** Source Goal and Task pairs that have approved durable Task rows. */
  goalTaskRecordKeys: Set<string>;
  /** Imported Goal review ids keyed by source id. */
  goalReviewIds: Map<string, string>;
  /** Imported Goal verification ids keyed by source id. */
  goalVerificationIds: Map<string, string>;
  /** Imported Vault grant ids keyed by source id. */
  vaultGrantIds: Map<string, string>;
  /** Imported evidence bundle ids keyed by source id. */
  evidenceBundleIds: Map<string, string>;
  /** Canonical knowledge ids retained by the imported workspace. */
  knowledgeIds: Set<string>;
}

/**
 * Reads one verified workspace export into records ready for FsStore import.
 *
 * @param input Export root and imported workspace id.
 * @returns Parsed import snapshot with target workspace and thread ids.
 * @throws Error when export verification or record parsing fails.
 */
export function readWorkspaceImportSnapshot(
  input: ReadWorkspaceImportSnapshotInput
): WorkspaceImportSnapshot {
  for (const removedPath of [
    'records/workspace-sync-evidence-bundles.jsonl',
    'records/knowledge-context-package-traces.jsonl',
    'records/knowledge-proposals.jsonl',
    'records/knowledge-proposal-reviews.jsonl',
  ]) {
    if (input.verified.fileContents.has(removedPath)) {
      throw new Error(`Unsupported workspace export record path: ${removedPath}`);
    }
  }
  const report = dryRunWorkspaceImport({
    verified: input.verified,
    workspaceExists: () => false,
  });
  const sourceWorkspaceMaterials = readImportJsonl(
    input.verified.fileContents,
    'records/workspace-materials.jsonl'
  ).map((record) => ImportedWorkspaceMaterialSchema.parse(record));
  const sourceWorkspaceMaterialRevisions = readImportJsonl(
    input.verified.fileContents,
    'records/workspace-material-revisions.jsonl'
  ).map((record) => ImportedWorkspaceMaterialRevisionSchema.parse(record));
  const sourceThreadMaterialBindings = readImportJsonl(
    input.verified.fileContents,
    'records/thread-material-bindings.jsonl'
  ).map((record) => ImportedThreadMaterialBindingSchema.parse(record));
  const sourceArtifactReviews = readImportJsonl(
    input.verified.fileContents,
    'records/artifact-reviews.jsonl'
  ).map((record) => ImportedArtifactReviewSchema.parse(record));
  const context: ImportRemintContext = {
    files: input.verified.fileContents,
    manifestDigest: input.verified.manifestDigest,
    report,
    targetWorkspaceId: input.targetWorkspaceId,
    sourceWorkspaceMaterials,
    sourceWorkspaceMaterialRevisions,
    sourceThreadMaterialBindings,
    sourceArtifactReviews,
    threadIds: new Map(),
    turnIds: new Map(),
    itemIds: new Map(),
    itemLineage: new Map(),
    artifactIds: new Map(),
    materialIds: new Map(
      sourceWorkspaceMaterials.map((material, index) => [
        material.materialId,
        `mat_imported_${input.targetWorkspaceId}_${index + 1}`,
      ])
    ),
    materialRevisionIds: new Map(
      sourceWorkspaceMaterialRevisions.map((revision, index) => [
        materialRevisionKey(revision.materialId, revision.revisionId),
        `mrev_imported_${input.targetWorkspaceId}_${index + 1}`,
      ])
    ),
    agentSessionIds: new Map(),
    approvalRequestIds: new Map(),
    agentEnvironmentPackageSnapshotIds: new Map(),
    knowledgeSourceIds: new Map(),
    contextPackageReferences: new Map(),
    goalIds: new Map(),
    goalTaskIds: new Map(),
    workerCheckpointIds: new Map(),
    goalPlanItemIds: new Set(),
    goalTaskRecordKeys: new Set(),
    goalReviewIds: new Map(),
    goalVerificationIds: new Map(),
    vaultGrantIds: new Map(),
    evidenceBundleIds: new Map(),
    knowledgeIds: new Set(),
  };
  const exportedGoalAuthority = {
    goals: readOptionalImportJsonl(context.files, 'records/goal-records.jsonl').map((record) =>
      ExportedGoalRecordSchema.parse(record)
    ),
    plans: readOptionalImportJsonl(context.files, 'records/goal-plan-records.jsonl').map((record) =>
      ExportedGoalPlanRecordSchema.parse(record)
    ),
    tasks: readOptionalImportJsonl(context.files, 'records/goal-tasks.jsonl').map((record) =>
      ExportedGoalTaskSchema.parse(record)
    ),
  };
  context.goalTaskIds = createStableGoalTaskIdMap(
    exportedGoalAuthority.plans,
    exportedGoalAuthority.tasks,
    context.targetWorkspaceId
  );
  context.goalPlanItemIds = new Set(exportedGoalAuthority.plans.map((plan) => plan.planItemId));
  const canonical = readCanonicalImportState(context);
  const goalRuntime = readGoalRuntimeControlState(context, exportedGoalAuthority);
  const securityRuntime = readSecurityRuntimeLedgerState(context);
  const workspaceSync = readWorkspaceSyncImportState(context);
  const workResources = readWorkResourceImportState(context, canonical, workspaceSync);
  const knowledgeReferenceReplacements = [
    ...context.contextPackageReferences,
    ...context.turnIds,
    ...context.itemIds,
    ...context.knowledgeSourceIds,
  ] as const;
  const knowledge = canonical.knowledge.map((entry) =>
    KnowledgeEntrySchema.parse({
      ...entry,
      ...(entry.sourceReferences
        ? {
            sourceReferences: rewritePortableReferences(
              entry.sourceReferences,
              knowledgeReferenceReplacements
            ),
          }
        : {}),
    })
  );
  const portableFileState = readPortableImportState(
    context,
    workResources.workerContextPackageFiles,
    knowledge
  );

  return {
    report,
    workspace: canonical.workspace,
    threads: workResources.threads,
    turns: workResources.turns,
    knowledge,
    itemRevisions: workResources.itemRevisions,
    artifacts: canonical.artifacts,
    workspaceMaterials: workResources.workspaceMaterials,
    workspaceMaterialRevisions: workResources.workspaceMaterialRevisions,
    threadMaterialBindings: workResources.threadMaterialBindings,
    artifactReviews: workResources.artifactReviews,
    agentSessions: canonical.agentSessions,
    turnEvents: workResources.turnEvents,
    knowledgeSources: canonical.knowledgeSources,
    knowledgeSourceMaterials: canonical.knowledgeSourceMaterials,
    vaultReferences: securityRuntime.vaultReferences,
    vaultGrants: securityRuntime.vaultGrants,
    injectionPlans: securityRuntime.injectionPlans,
    injectionReceipts: securityRuntime.injectionReceipts,
    vaultUseRecords: securityRuntime.vaultUseRecords,
    auditEvents: securityRuntime.auditEvents,
    capabilityCalls: securityRuntime.capabilityCalls,
    evidenceBundles: securityRuntime.evidenceBundles,
    runtimeEvidence: securityRuntime.runtimeEvidence,
    runtimeProvenanceIndexes: securityRuntime.runtimeProvenanceIndexes,
    usageRecords: securityRuntime.usageRecords,
    dataSourceCatalog: securityRuntime.dataSourceCatalog,
    gitPushRecords: securityRuntime.gitPushRecords,
    resolvedAgentSetups: securityRuntime.resolvedAgentSetups,
    agentEnvironmentPackageSnapshots: workResources.agentEnvironmentPackageSnapshots,
    workspaceRepositories: workspaceSync.workspaceRepositories,
    workspaceInputSnapshots: workResources.workspaceInputSnapshots,
    workspaceMaterializationRecords: workResources.workspaceMaterializationRecords,
    backendWorkspaceHandles: workspaceSync.backendWorkspaceHandles,
    workerOutputManifests: workspaceSync.workerOutputManifests,
    workspaceChangeSets: workspaceSync.workspaceChangeSets,
    stagedWorkspaceReviews: workspaceSync.stagedWorkspaceReviews,
    workspaceApplyPlans: workspaceSync.workspaceApplyPlans,
    workspaceApplyResults: workspaceSync.workspaceApplyResults,
    workspaceReconciliationRecords: workspaceSync.workspaceReconciliationRecords,
    workspaceQuarantineRecords: workspaceSync.workspaceQuarantineRecords,
    permissionDecisions: securityRuntime.permissionDecisions,
    workerCheckpoints: goalRuntime.workerCheckpoints,
    goalRecords: goalRuntime.goalRecords,
    goalPlanRecords: goalRuntime.goalPlanRecords,
    goalTasks: goalRuntime.goalTasks,
    goalReviewRecords: goalRuntime.goalReviewRecords,
    goalVerificationRecords: goalRuntime.goalVerificationRecords,
    mcpToolSchemaSnapshots: goalRuntime.mcpToolSchemaSnapshots,
    portableFileState,
  };
}

/**
 * Remints one Artifact and its immutable turn-output lineage.
 *
 * @param artifact Source Artifact from the verified export.
 * @param context Target workspace and canonical id maps.
 * @returns Schema-valid Artifact with target lineage.
 * @throws Error when a required source id is absent or the reminted Artifact is invalid.
 */
function remintPortableArtifact(
  artifact: Artifact,
  context: {
    readonly targetWorkspaceId: string;
    readonly artifactIds: ReadonlyMap<string, string>;
    readonly threadIds: ReadonlyMap<string, string>;
    readonly turnIds: ReadonlyMap<string, string>;
  }
): Artifact {
  return ArtifactSchema.parse({
    ...artifact,
    id: requiredMapValue(context.artifactIds, artifact.id, 'artifact'),
    workspaceId: context.targetWorkspaceId,
    threadId: artifact.threadId
      ? requiredMapValue(context.threadIds, artifact.threadId, 'thread')
      : null,
    turnId: artifact.turnId ? requiredMapValue(context.turnIds, artifact.turnId, 'turn') : null,
    origin:
      artifact.origin.kind === 'turn-output'
        ? {
            ...artifact.origin,
            threadId: requiredMapValue(context.threadIds, artifact.origin.threadId, 'thread'),
            turnId: requiredMapValue(context.turnIds, artifact.origin.turnId, 'turn'),
          }
        : artifact.origin,
  });
}

/**
 * Reconstructs the canonical workspace graph, AEP snapshots, events, and sources.
 *
 * @param context Shared import lineage and verified bytes.
 * @returns Canonical imported records.
 * @throws Error when canonical record parsing or lineage validation fails.
 */
function readCanonicalImportState(context: ImportRemintContext) {
  const { report } = context;
  const exportedWorkspace = WorkspaceRecordSchema.parse(
    readImportJson(context.files, 'records/workspace.json')
  );
  if (exportedWorkspace.id !== report.manifest.workspaceId) {
    throw new Error('Workspace record id does not match the export manifest.');
  }
  const workspace = WorkspaceRecordSchema.parse({
    ...exportedWorkspace,
    id: context.targetWorkspaceId,
    importedFrom: {
      sourceDeploymentId: report.manifest.sourceDeploymentId,
      sourceWorkspaceId: report.exportedWorkspaceId,
      exportCreatedAt: report.manifest.exportCreatedAt,
      manifestDigest: context.manifestDigest,
    },
  });
  const exportedThreads = readImportJsonl(context.files, 'records/threads.jsonl').map((record) =>
    ThreadSchema.parse(record)
  );
  const threads = exportedThreads.map((thread, index) =>
    ThreadSchema.parse({
      ...thread,
      id: `th_imported_${context.targetWorkspaceId}_${index + 1}`,
      workspaceId: context.targetWorkspaceId,
    })
  );
  const threadIds = new Map(
    exportedThreads.map((thread, index) => [thread.id, threads[index]!.id])
  );
  const exportedKnowledge = readImportJsonl(context.files, 'records/knowledge.jsonl').map(
    (record) => KnowledgeEntrySchema.parse(record)
  );
  const exportedTurns = readImportJsonl(context.files, 'records/turns.jsonl').map((record) =>
    TurnSchema.parse(record)
  );
  const turnIds = new Map(
    exportedTurns.map((turn, index) => [
      turn.id,
      `tu_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const exportedArtifacts = readExportedArtifacts(context.files, report.manifest);
  const artifactIds = new Map(
    exportedArtifacts.map((artifact, index) => [
      artifact.id,
      `ar_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const exportedAgentSessions = readImportJsonl(context.files, 'records/agent-sessions.jsonl').map(
    (record) => AgentSessionRecordSchema.parse(record) as AgentSession
  );
  const agentSessionIds = new Map(
    exportedAgentSessions.map((session, index) => [
      session.id,
      `as_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const exportedItemRevisions = readImportJsonl(context.files, 'records/item-revisions.jsonl').map(
    (record) => ItemSchema.parse(record)
  );
  const unresolvedUserInputRequestIds =
    listUnresolvedUserInputRequestItemIds(exportedItemRevisions);

  if (unresolvedUserInputRequestIds.length > 0) {
    throw new Error(
      `Workspace import is blocked by unresolved user-input-request Items: ${unresolvedUserInputRequestIds.join(', ')}.`
    );
  }
  const itemIds = new Map<string, string>();
  const itemLineage = new Map<string, Item>();
  const approvalRequestIds = new Map<string, string>();
  const userInputRequestIds = new Map<string, string>();
  for (const revision of exportedItemRevisions) {
    if (!itemIds.has(revision.id)) {
      itemIds.set(
        revision.id,
        revision.type === 'artifact-reference'
          ? artifactReferenceItemId(
              requiredMapValue(artifactIds, revision.artifactId, 'artifact'),
              requiredMapValue(turnIds, revision.turnId, 'turn')
            )
          : `it_imported_${context.targetWorkspaceId}_${itemIds.size + 1}`
      );
    }
    itemLineage.set(revision.id, revision);
    if (
      (revision.type === 'approval-request' || revision.type === 'approval-decision') &&
      !approvalRequestIds.has(revision.approvalRequestId)
    ) {
      approvalRequestIds.set(
        revision.approvalRequestId,
        `apr_imported_${context.targetWorkspaceId}_${approvalRequestIds.size + 1}`
      );
    }
    if (
      (revision.type === 'user-input-request' || revision.type === 'user-input-response') &&
      !userInputRequestIds.has(revision.userInputRequestId)
    ) {
      userInputRequestIds.set(
        revision.userInputRequestId,
        `uir_imported_${context.targetWorkspaceId}_${userInputRequestIds.size + 1}`
      );
    }
  }
  const exportedAgentEnvironmentPackageSnapshots = readOptionalImportJsonl(
    context.files,
    'records/agent-environment-package-snapshots.jsonl'
  ).map((record) => ExportedAgentEnvironmentPackageSnapshotSchema.parse(record));
  const agentEnvironmentPackageSnapshotIds = new Map(
    exportedAgentEnvironmentPackageSnapshots.map((record, index) => [
      record.snapshotId,
      `aepsnap_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const agentEnvironmentPackageIds = new Map(
    exportedAgentEnvironmentPackageSnapshots.map((record, index) => [
      record.packageId,
      `aepkg_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const agentEnvironmentPackageSnapshots = exportedAgentEnvironmentPackageSnapshots.map(
    (parsed) => {
      const snapshot = z.record(z.string(), z.unknown()).parse(parsed.snapshot);
      const scope = z.record(z.string(), z.unknown()).parse(snapshot.scope);
      if (
        parsed.workspaceId !== report.exportedWorkspaceId ||
        snapshot.snapshotId !== parsed.snapshotId ||
        snapshot.packageId !== parsed.packageId ||
        scope.workspaceId !== parsed.workspaceId ||
        scope.threadId !== parsed.threadId ||
        scope.turnId !== parsed.turnId ||
        scope.agentSessionId !== parsed.agentSessionId
      ) {
        throw new Error(
          `Agent environment package snapshot has invalid lineage: ${parsed.snapshotId}`
        );
      }

      const snapshotId = requiredMapValue(
        agentEnvironmentPackageSnapshotIds,
        parsed.snapshotId,
        'agent environment package snapshot'
      );
      const packageId = requiredMapValue(
        agentEnvironmentPackageIds,
        parsed.packageId,
        'agent environment package'
      );
      const threadId = requiredMapValue(threadIds, parsed.threadId, 'thread');
      const turnId = requiredMapValue(turnIds, parsed.turnId, 'turn');
      const agentSessionId = requiredMapValue(
        agentSessionIds,
        parsed.agentSessionId,
        'agent session'
      );
      const portableSnapshot = z.record(z.string(), z.unknown()).parse(
        rewriteJsonStringReferences(snapshot, [
          [parsed.snapshotId, snapshotId],
          [parsed.packageId, packageId],
        ])
      );
      const rewrittenSnapshot = {
        ...portableSnapshot,
        snapshotId,
        packageId,
        scope: {
          ...scope,
          workspaceId: context.targetWorkspaceId,
          threadId,
          turnId,
          agentSessionId,
          ...(scope.itemId === undefined
            ? {}
            : {
                itemId:
                  scope.itemId === null
                    ? null
                    : requiredMapValue(itemIds, z.string().parse(scope.itemId), 'item'),
              }),
        },
      };

      return ExportedAgentEnvironmentPackageSnapshotSchema.parse({
        ...parsed,
        snapshotId,
        packageId,
        workspaceId: context.targetWorkspaceId,
        threadId,
        turnId,
        agentSessionId,
        contentDigest: createHash('sha256').update(JSON.stringify(rewrittenSnapshot)).digest('hex'),
        snapshot: rewrittenSnapshot,
      }) as ExportedAgentEnvironmentPackageSnapshot;
    }
  );
  const itemRevisions = exportedItemRevisions.map((item) => {
    const rewritten: Record<string, unknown> = {
      ...item,
      id: requiredMapValue(itemIds, item.id, 'item'),
      threadId: requiredMapValue(threadIds, item.threadId, 'thread'),
      turnId: requiredMapValue(turnIds, item.turnId, 'turn'),
      workspaceId: context.targetWorkspaceId,
      ...(item.parentItemId === undefined
        ? {}
        : {
            parentItemId:
              item.parentItemId === null
                ? null
                : requiredMapValue(itemIds, item.parentItemId, 'parent item'),
          }),
    };
    if (item.type !== 'user-input-response' && item.causationId && itemIds.has(item.causationId)) {
      rewritten.causationId = requiredMapValue(itemIds, item.causationId, 'causation item');
    }
    if (item.type === 'artifact-reference') {
      rewritten.artifactId = requiredMapValue(artifactIds, item.artifactId, 'artifact');
    } else if (item.type === 'plan' && context.goalPlanItemIds.has(item.id)) {
      rewritten.steps = item.steps.map((step) => ({
        ...step,
        id: requiredMapValue(context.goalTaskIds, step.id, 'goal task'),
      }));
    } else if (item.type === 'approval-request' || item.type === 'approval-decision') {
      rewritten.approvalRequestId = requiredMapValue(
        approvalRequestIds,
        item.approvalRequestId,
        'approval request'
      );
    } else if (item.type === 'user-input-request' || item.type === 'user-input-response') {
      rewritten.userInputRequestId = requiredMapValue(
        userInputRequestIds,
        item.userInputRequestId,
        'user input request'
      );
    }
    return ItemSchema.parse(rewritten);
  });
  const currentItems = new Map<string, Item>();
  for (const item of itemRevisions) {
    currentItems.set(item.id, item);
  }
  const turns = exportedTurns.map((turn) => {
    const humanGate =
      turn.humanGate === null
        ? null
        : turn.humanGate.kind === 'approval'
          ? {
              ...turn.humanGate,
              approvalRequestId: requiredMapValue(
                approvalRequestIds,
                turn.humanGate.approvalRequestId,
                'approval request'
              ),
              itemId: requiredMapValue(itemIds, turn.humanGate.itemId, 'item'),
            }
          : {
              ...turn.humanGate,
              userInputRequestId: requiredMapValue(
                userInputRequestIds,
                turn.humanGate.userInputRequestId,
                'user input request'
              ),
              itemId: requiredMapValue(itemIds, turn.humanGate.itemId, 'item'),
            };
    return TurnSchema.parse({
      ...turn,
      id: requiredMapValue(turnIds, turn.id, 'turn'),
      threadId: requiredMapValue(threadIds, turn.threadId, 'thread'),
      workspaceId: context.targetWorkspaceId,
      agentSessionId: turn.agentSessionId
        ? requiredMapValue(agentSessionIds, turn.agentSessionId, 'agent session')
        : turn.agentSessionId,
      humanGate,
      items: turn.items.map((item) =>
        requiredMapValue(currentItems, requiredMapValue(itemIds, item.id, 'item'), 'item')
      ),
    });
  });
  const artifacts = exportedArtifacts.map((artifact) =>
    remintPortableArtifact(artifact, {
      targetWorkspaceId: context.targetWorkspaceId,
      artifactIds,
      threadIds,
      turnIds,
    })
  );
  const agentSessions = exportedAgentSessions.map(
    (session) =>
      AgentSessionRecordSchema.parse({
        ...session,
        id: requiredMapValue(agentSessionIds, session.id, 'agent session'),
        sandboxSummary: null,
        configVersion: null,
        environmentPackageSnapshotId: session.environmentPackageSnapshotId
          ? requiredMapValue(
              agentEnvironmentPackageSnapshotIds,
              session.environmentPackageSnapshotId,
              'agent environment package snapshot'
            )
          : null,
        threadId: session.threadId ? requiredMapValue(threadIds, session.threadId, 'thread') : null,
        policySnapshotId: null,
        sessionCompatibilityKey: null,
        stale: true,
        workspaceRoots: [],
        workspaceId: context.targetWorkspaceId,
      }) as AgentSession
  );
  const exportedEvents = readImportJsonl(context.files, 'records/turn-events.jsonl').map((record) =>
    SseEventEnvelopeSchema.parse(record)
  );
  const exportedTurnIds = new Set(exportedTurns.map((turn) => turn.id));
  if (exportedEvents.some((event) => !event.turnId || !exportedTurnIds.has(event.turnId))) {
    throw new Error('Turn event references missing exported turn.');
  }
  const exportedTurnEvents = exportedTurns.map((turn): [string, SseEventEnvelope[]] => [
    turn.id,
    exportedEvents.filter((event) => event.turnId === turn.id),
  ]);
  const importedThreads = new Map(
    exportedThreads.map((record, index) => [record.id, threads[index]!])
  );
  const importedTurns = new Map(exportedTurns.map((record, index) => [record.id, turns[index]!]));
  const importedItems = new Map(
    [...itemIds].map(([sourceId, importedId]) => [sourceId, currentItems.get(importedId) as Item])
  );
  const importedArtifacts = new Map(
    exportedArtifacts.map((record, index) => [record.id, artifacts[index]!])
  );
  const importedAgentSessions = new Map(
    exportedAgentSessions.map((record, index) => [record.id, agentSessions[index]!])
  );
  const turnEvents = exportedTurns.map((turn): [string, SseEventEnvelope[]] => [
    requiredMapValue(turnIds, turn.id, 'turn'),
    exportedEvents
      .filter((event) => event.turnId === turn.id)
      .map((event) =>
        rewritePortableTurnEvent(event, {
          workspace,
          threads: importedThreads,
          turns: importedTurns,
          items: importedItems,
          artifacts: importedArtifacts,
          agentSessions: importedAgentSessions,
          approvalRequestIds,
        })
      ),
  ]);
  const exportedKnowledgeSources = readOptionalImportJsonl(
    context.files,
    'records/knowledge-sources.jsonl'
  ).map((record) => {
    const source = KnowledgeSourceRecordSchema.parse(record);
    assertSafeWorkspacePathSegment(source.id, 'Knowledge source id');
    return source;
  });
  const knowledgeSources = exportedKnowledgeSources.map((parsed, index) =>
    KnowledgeSourceRecordSchema.parse({
      ...parsed,
      id: `ks_imported_${context.targetWorkspaceId}_${index + 1}`,
      originatingThreadId: parsed.originatingThreadId
        ? requiredMapValue(threadIds, parsed.originatingThreadId, 'thread')
        : null,
      originatingTurnId: parsed.originatingTurnId
        ? requiredMapValue(turnIds, parsed.originatingTurnId, 'turn')
        : null,
      uri: parsed.uri
        ? rewriteWorkspaceReference(
            parsed.uri,
            report.exportedWorkspaceId,
            context.targetWorkspaceId
          )
        : null,
      workspaceId: context.targetWorkspaceId,
    })
  );
  const knowledgeSourceIds = new Map(
    exportedKnowledgeSources.map((source, index) => [source.id, knowledgeSources[index]!.id])
  );
  const knowledge = exportedKnowledge;
  parseCanonicalWorkspaceHistory({
    workspace: exportedWorkspace,
    threads: exportedThreads,
    turns: exportedTurns,
    itemRevisions: exportedItemRevisions,
    artifacts: exportedArtifacts,
    knowledgeSources: exportedKnowledgeSources,
    agentSessions: exportedAgentSessions,
    turnEvents: exportedTurnEvents,
  });
  parseCanonicalWorkspaceHistory({
    workspace,
    threads,
    turns,
    itemRevisions,
    artifacts,
    knowledgeSources,
    agentSessions,
    turnEvents,
  });
  const knowledgeSourceMaterials = exportedKnowledgeSources
    .map((source): ExportedKnowledgeSourceMaterial | null => {
      const materialPath = `sources/materials/${source.id}/content.txt`;

      return context.files.has(materialPath)
        ? {
            sourceId: requiredMapValue(knowledgeSourceIds, source.id, 'knowledge source'),
            content: requiredExportFile(context.files, materialPath),
          }
        : null;
    })
    .filter((material): material is ExportedKnowledgeSourceMaterial => material !== null);
  context.threadIds = threadIds;
  context.turnIds = turnIds;
  context.itemIds = itemIds;
  context.itemLineage = itemLineage;
  context.artifactIds = artifactIds;
  context.agentSessionIds = agentSessionIds;
  context.approvalRequestIds = approvalRequestIds;
  context.agentEnvironmentPackageSnapshotIds = agentEnvironmentPackageSnapshotIds;
  context.knowledgeSourceIds = knowledgeSourceIds;
  context.knowledgeIds = new Set(knowledge.map((entry) => entry.id));

  return {
    workspace,
    threads,
    turns,
    knowledge,
    itemRevisions,
    artifacts,
    agentSessions,
    turnEvents,
    knowledgeSources,
    knowledgeSourceMaterials,
    agentEnvironmentPackageSnapshots,
  };
}

/**
 * Reconstructs Goal Mode and worker-control records after canonical ids are known.
 *
 * @param context Shared import lineage and verified bytes.
 * @param authority Parsed Goal, Plan, and Task authority records.
 * @returns Imported Goal Mode and worker-control records.
 * @throws Error when a control record references missing exported state.
 */
function readGoalRuntimeControlState(
  context: ImportRemintContext,
  authority: {
    readonly goals: readonly ExportedGoalRecord[];
    readonly plans: readonly ExportedGoalPlanRecord[];
    readonly tasks: readonly ExportedGoalTask[];
  }
) {
  const { artifactIds, itemIds, itemLineage, threadIds, turnIds } = context;
  const exportedGoalRecords = authority.goals;
  const exportedGoalPlanRecords = authority.plans;
  const exportedGoalTasks = authority.tasks;
  const goalIds = new Map<string, string>();
  for (const [index, record] of exportedGoalRecords.entries()) {
    if (goalIds.has(record.goalId)) {
      throw new Error(`Goal identity is duplicated: ${record.goalId}`);
    }
    goalIds.set(record.goalId, `goal_imported_${context.targetWorkspaceId}_${index + 1}`);
  }
  const goalTaskIds = context.goalTaskIds;
  const goalTaskRecordKeys = assertGoalAuthorityConsistency({
    sourceWorkspaceId: context.report.exportedWorkspaceId,
    goals: exportedGoalRecords,
    plans: exportedGoalPlanRecords,
    tasks: exportedGoalTasks,
    itemLineage,
  });
  context.goalIds = goalIds;
  context.goalTaskIds = goalTaskIds;
  context.goalTaskRecordKeys = goalTaskRecordKeys;
  const goalRecords = exportedGoalRecords.map((record) =>
    rewriteImportedGoalRecord(
      record,
      context.targetWorkspaceId,
      threadIds,
      itemIds,
      goalIds,
      goalTaskIds
    )
  );
  const goalPlanRecords = exportedGoalPlanRecords.map((record) =>
    rewriteImportedGoalPlanRecord(
      record,
      context.targetWorkspaceId,
      threadIds,
      itemIds,
      artifactIds,
      goalIds,
      goalTaskIds
    )
  );
  const goalTasks = exportedGoalTasks.map((record) =>
    rewriteImportedGoalTask(
      record,
      context.targetWorkspaceId,
      threadIds,
      itemIds,
      artifactIds,
      goalIds,
      goalTaskIds
    )
  );
  const exportedWorkerCheckpoints = readOptionalImportJsonl(
    context.files,
    'records/worker-turn-checkpoints.jsonl'
  ).map((record) => ExportedWorkerCheckpointSchema.parse(record));
  const workerCheckpoints = exportedWorkerCheckpoints.map((parsed) => {
    const threadId = requiredMapValue(threadIds, parsed.threadId, 'thread');
    const turnId = requiredMapValue(turnIds, parsed.turnId, 'turn');
    assertApprovedGoalTaskReference(
      parsed.goalId,
      parsed.taskId,
      goalTaskRecordKeys,
      'Worker checkpoint'
    );

    return ExportedWorkerCheckpointSchema.parse({
      ...parsed,
      checkpointId: `${context.targetWorkspaceId}:${threadId}:${turnId}`,
      workspaceId: context.targetWorkspaceId,
      threadId,
      turnId,
      workerSessionId: parsed.workerSessionId,
      goalId: parsed.goalId ? requiredMapValue(goalIds, parsed.goalId, 'goal') : null,
      taskId: parsed.taskId ? requiredMapValue(goalTaskIds, parsed.taskId, 'goal task') : null,
    });
  });
  context.workerCheckpointIds = new Map(
    exportedWorkerCheckpoints.map((checkpoint, index) => [
      checkpoint.checkpointId,
      workerCheckpoints[index]!.checkpointId,
    ])
  );
  const exportedGoalReviewRecords = readOptionalImportJsonl(
    context.files,
    'records/goal-review-records.jsonl'
  ).map((record) => {
    const parsed = ExportedGoalReviewRecordSchema.parse(record);
    assertGoalReviewRecordConsistency(parsed);
    assertApprovedGoalTaskReference(
      parsed.goalId,
      parsed.taskId,
      goalTaskRecordKeys,
      'Goal Review'
    );
    return parsed;
  });
  const goalReviewIds = new Map(
    exportedGoalReviewRecords.map((record, index) => [
      record.reviewId,
      `review_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  context.goalReviewIds = goalReviewIds;
  const goalReviewRecords = exportedGoalReviewRecords.map((parsed) => {
    const resolutionSnapshot = parsed.resolutionSnapshot;

    return ExportedGoalReviewRecordSchema.parse({
      ...parsed,
      reviewId: requiredMapValue(goalReviewIds, parsed.reviewId, 'goal review'),
      threadId: requiredMapValue(threadIds, parsed.threadId, 'thread'),
      goalId: requiredMapValue(goalIds, parsed.goalId, 'goal'),
      taskId: requiredMapValue(goalTaskIds, parsed.taskId, 'goal task'),
      turnId: requiredMapValue(turnIds, parsed.turnId, 'turn'),
      itemIds: parsed.itemIds.map((itemId) => requiredMapValue(itemIds, itemId, 'item')),
      artifactIds: parsed.artifactIds.map((artifactId) =>
        requiredMapValue(artifactIds, artifactId, 'artifact')
      ),
      resolutionSnapshot: resolutionSnapshot
        ? {
            ...resolutionSnapshot,
            task: {
              ...resolutionSnapshot.task,
              taskId: requiredMapValue(goalTaskIds, resolutionSnapshot.task.taskId, 'goal task'),
            },
            goal: {
              ...resolutionSnapshot.goal,
              goalId: requiredMapValue(goalIds, resolutionSnapshot.goal.goalId, 'goal'),
            },
            nextReadyTaskId: resolutionSnapshot.nextReadyTaskId
              ? requiredMapValue(goalTaskIds, resolutionSnapshot.nextReadyTaskId, 'goal task')
              : null,
          }
        : null,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const exportedGoalVerificationRecords = readOptionalImportJsonl(
    context.files,
    'records/goal-verification-records.jsonl'
  ).map((record) => ExportedGoalVerificationRecordSchema.parse(record));
  const goalVerificationIds = new Map(
    exportedGoalVerificationRecords.map((record, index) => [
      record.verificationId,
      `verification_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  context.goalVerificationIds = goalVerificationIds;
  const goalVerificationRecords = exportedGoalVerificationRecords.map((parsed) => {
    assertApprovedGoalTaskReference(
      parsed.goalId,
      parsed.taskId,
      goalTaskRecordKeys,
      'Goal Verification'
    );
    return ExportedGoalVerificationRecordSchema.parse({
      ...parsed,
      verificationId: requiredMapValue(
        goalVerificationIds,
        parsed.verificationId,
        'goal verification'
      ),
      workspaceId: context.targetWorkspaceId,
      threadId: requiredMapValue(threadIds, parsed.threadId, 'thread'),
      goalId: requiredMapValue(goalIds, parsed.goalId, 'goal'),
      taskId: parsed.taskId ? requiredMapValue(goalTaskIds, parsed.taskId, 'goal task') : null,
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      itemIds: parsed.itemIds.map((itemId) => requiredMapValue(itemIds, itemId, 'item')),
      artifactIds: parsed.artifactIds.map((artifactId) =>
        requiredMapValue(artifactIds, artifactId, 'artifact')
      ),
    });
  });
  const mcpToolSchemaSnapshots = readOptionalImportJsonl(
    context.files,
    'records/mcp-tool-schema-snapshots.jsonl'
  ).map((record) => {
    const parsed = ExportedMcpToolSchemaSnapshotSchema.parse(record);

    return ExportedMcpToolSchemaSnapshotSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
    });
  });

  return {
    workerCheckpoints,
    goalRecords,
    goalPlanRecords,
    goalTasks,
    goalReviewRecords,
    goalVerificationRecords,
    mcpToolSchemaSnapshots,
  };
}

/**
 * Reconstructs portable security, audit, capability, evidence, usage, and runtime ledgers.
 *
 * @param context Shared import lineage and verified bytes.
 * @returns Imported security and runtime ledger records.
 * @throws Error when a ledger record references missing exported state.
 */
function readSecurityRuntimeLedgerState(context: ImportRemintContext) {
  const {
    agentEnvironmentPackageSnapshotIds,
    agentSessionIds,
    approvalRequestIds,
    evidenceBundleIds,
    goalIds,
    goalReviewIds,
    goalTaskIds,
    goalTaskRecordKeys,
    goalVerificationIds,
    itemIds,
    report,
    threadIds,
    turnIds,
    workerCheckpointIds,
  } = context;
  const vaultReferences = readOptionalImportJsonl(
    context.files,
    'records/vault-references.jsonl'
  ).map((record, index) => {
    const parsed = ExportedWorkspaceVaultReferenceSchema.parse(record);

    return ImportedWorkspaceVaultReferenceSchema.parse({
      ...parsed,
      referenceId: `vault_imported_${context.targetWorkspaceId}_${index + 1}`,
      ownerScope: 'workspace',
      workspaceId: context.targetWorkspaceId,
      backendLocator: null,
      status: 'unbound',
      currentVersion: 0,
      createdAt: report.manifest.exportCreatedAt,
      updatedAt: report.manifest.exportCreatedAt,
    });
  });
  const vaultReferenceIds = new Map(
    vaultReferences.map((reference) => [reference.sourceReferenceId, reference.referenceId])
  );
  const exportedVaultGrants = readOptionalImportJsonl(
    context.files,
    'records/vault-grants.jsonl'
  ).map((record) => ExportedVaultGrantSchema.parse(record));
  const vaultGrants = exportedVaultGrants.map((grant, index) =>
    ExportedVaultGrantSchema.parse({
      ...grant,
      grantId: `grant_imported_${context.targetWorkspaceId}_${index + 1}`,
      approvalId: grant.approvalId
        ? requiredMapValue(approvalRequestIds, grant.approvalId, 'approval request')
        : null,
      targetAgentSessionId: grant.targetAgentSessionId
        ? requiredMapValue(agentSessionIds, grant.targetAgentSessionId, 'agent session')
        : null,
      vaultReferenceId: requiredMapValue(
        vaultReferenceIds,
        grant.vaultReferenceId,
        'vault reference'
      ),
      workspaceId: context.targetWorkspaceId,
    })
  );
  const vaultGrantIds = new Map(
    exportedVaultGrants.map((grant, index) => [grant.grantId, vaultGrants[index]!.grantId])
  );
  const exportedInjectionPlans = readOptionalImportJsonl(
    context.files,
    'records/injection-plans.jsonl'
  ).map((record) => ExportedInjectionPlanSchema.parse(record));
  const injectionPlans = exportedInjectionPlans.map((plan, index) => {
    const grantId = vaultGrantIds.get(plan.grantId);
    if (!grantId) {
      throw new Error(`Injection plan references missing exported vault grant: ${plan.grantId}`);
    }

    return ExportedInjectionPlanSchema.parse({
      ...plan,
      planId: `plan_imported_${context.targetWorkspaceId}_${index + 1}`,
      grantId,
      packageSnapshotId: plan.packageSnapshotId
        ? requiredMapValue(
            agentEnvironmentPackageSnapshotIds,
            plan.packageSnapshotId,
            'agent environment package snapshot'
          )
        : null,
    });
  });
  const injectionPlanIds = new Map(
    exportedInjectionPlans.map((plan, index) => [plan.planId, injectionPlans[index]!.planId])
  );
  const exportedInjectionReceipts = readOptionalImportJsonl(
    context.files,
    'records/injection-receipts.jsonl'
  ).map((record) => ExportedInjectionReceiptSchema.parse(record));
  const injectionReceipts = exportedInjectionReceipts.map((receipt, index) => {
    const planId = injectionPlanIds.get(receipt.planId);
    if (!planId) {
      throw new Error(
        `Injection receipt references missing exported injection plan: ${receipt.planId}`
      );
    }

    const grantId = vaultGrantIds.get(receipt.grantId);
    if (!grantId) {
      throw new Error(
        `Injection receipt references missing exported vault grant: ${receipt.grantId}`
      );
    }

    return ExportedInjectionReceiptSchema.parse({
      ...receipt,
      receiptId: `receipt_imported_${context.targetWorkspaceId}_${index + 1}`,
      planId,
      grantId,
      agentSessionId: receipt.agentSessionId
        ? requiredMapValue(agentSessionIds, receipt.agentSessionId, 'agent session')
        : null,
    });
  });
  const injectionReceiptIds = new Map(
    exportedInjectionReceipts.map((receipt, index) => [
      receipt.receiptId,
      injectionReceipts[index]!.receiptId,
    ])
  );
  const vaultUseRecords = readOptionalImportJsonl(
    context.files,
    'records/vault-use-records.jsonl'
  ).map((record) => {
    const parsed = ExportedVaultUseRecordSchema.parse(record);

    return ExportedVaultUseRecordSchema.parse({
      ...parsed,
      agentSessionId: parsed.agentSessionId
        ? requiredMapValue(agentSessionIds, parsed.agentSessionId, 'agent session')
        : null,
      grantId: parsed.grantId
        ? requiredMapValue(vaultGrantIds, parsed.grantId, 'vault grant')
        : null,
      planId: parsed.planId
        ? requiredMapValue(injectionPlanIds, parsed.planId, 'injection plan')
        : null,
      receiptId: parsed.receiptId
        ? requiredMapValue(injectionReceiptIds, parsed.receiptId, 'injection receipt')
        : null,
      workspaceId: context.targetWorkspaceId,
      vaultReferenceId: requiredMapValue(
        vaultReferenceIds,
        parsed.vaultReferenceId,
        'vault reference'
      ),
    });
  });
  context.vaultGrantIds = vaultGrantIds;
  const auditEvents = readOptionalImportJsonl(context.files, 'records/audit-events.jsonl').map(
    (record) => {
      const parsed = AuditEventSchema.parse(record);

      return AuditEventSchema.parse({
        ...parsed,
        threadId: parsed.threadId ? requiredMapValue(threadIds, parsed.threadId, 'thread') : null,
        turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
        itemId: parsed.itemId ? requiredMapValue(itemIds, parsed.itemId, 'item') : null,
        agentSessionId: parsed.agentSessionId
          ? requiredMapValue(agentSessionIds, parsed.agentSessionId, 'agent session')
          : null,
        vaultGrantId: parsed.vaultGrantId
          ? requiredMapValue(vaultGrantIds, parsed.vaultGrantId, 'vault grant')
          : null,
        workspaceId: context.targetWorkspaceId,
        resource:
          parsed.resource === `workspace:${report.exportedWorkspaceId}`
            ? `workspace:${context.targetWorkspaceId}`
            : parsed.resource?.startsWith('goal-review:')
              ? `goal-review:${requiredMapValue(
                  goalReviewIds,
                  parsed.resource.slice('goal-review:'.length),
                  'goal review'
                )}`
              : parsed.resource?.startsWith('goal-verification:')
                ? `goal-verification:${requiredMapValue(
                    goalVerificationIds,
                    parsed.resource.slice('goal-verification:'.length),
                    'goal verification'
                  )}`
                : parsed.resource?.startsWith('goal-task:')
                  ? `goal-task:${requiredMapValue(
                      goalTaskIds,
                      parsed.resource.slice('goal-task:'.length),
                      'goal task'
                    )}`
                  : parsed.resource?.startsWith('goal:')
                    ? `goal:${requiredMapValue(
                        goalIds,
                        parsed.resource.slice('goal:'.length),
                        'goal'
                      )}`
                    : parsed.resource?.startsWith('worker-checkpoint:')
                      ? `worker-checkpoint:${requiredMapValue(
                          workerCheckpointIds,
                          parsed.resource.slice('worker-checkpoint:'.length),
                          'worker checkpoint'
                        )}`
                      : parsed.resource?.startsWith('vault:') &&
                          vaultReferenceIds.has(parsed.resource.slice('vault:'.length))
                        ? `vault:${requiredMapValue(
                            vaultReferenceIds,
                            parsed.resource.slice('vault:'.length),
                            'vault reference'
                          )}`
                        : parsed.resource,
      });
    }
  );
  const exportedCapabilityCalls = readOptionalImportJsonl(
    context.files,
    'records/capability-calls.jsonl'
  ).map((record) => ExportedCapabilityCallSchema.parse(record));
  const exportedEvidenceBundles = readOptionalImportJsonl(
    context.files,
    'records/evidence-bundles.jsonl'
  ).map((record) => ImportedEvidenceBundleRecordSchema.parse(record));
  const exportedRuntimeEvidence = readOptionalImportJsonl(
    context.files,
    'records/runtime-evidence.jsonl'
  ).map((record) => ImportedRuntimeEvidenceRecordSchema.parse(record));
  const runtimeProvenanceIndexes = new Map<string, string>();
  const provenancePackages = new Map<string, { targetPackageSnapshotId: string; digest: string }>();
  const runtimeOriginRefsByPackageSnapshotId = new Map<string, ReadonlyMap<string, string>>();
  for (const bundle of exportedEvidenceBundles) {
    if (bundle.sourceKind !== 'worker-runtime-provenance-index') {
      continue;
    }
    const exportPath = `workspace-files/evidence/bundles/${bundle.id}/runtime-origin-index.jsonl`;
    const sourceText = requiredExportFile(context.files, exportPath);
    const firstLine = sourceText.trim().split('\n')[0];
    if (!firstLine) {
      throw new Error('Runtime provenance index is empty.');
    }
    const firstRow = WorkerRuntimeOriginIndexRowSchema.parse(JSON.parse(firstLine));
    const sourceLineage = firstRow.lineage;
    if (
      bundle.workspaceId !== sourceLineage.workspaceId ||
      bundle.threadId !== sourceLineage.threadId ||
      bundle.turnId !== sourceLineage.turnId ||
      bundle.agentSessionId !== sourceLineage.agentSessionId ||
      bundle.rawEvidenceRefs.length > 0 ||
      bundle.redactedEvidenceRefs.length !== 1 ||
      bundle.redactedEvidenceRefs[0]?.kind !== 'worker-runtime-provenance-index' ||
      bundle.redactedEvidenceRefs[0]?.ref !== 'runtime-origin-index.jsonl' ||
      bundle.contentDigests.length !== 1 ||
      bundle.contentDigests[0] !== digestText(sourceText)
    ) {
      throw new Error(`Runtime provenance index bundle is inconsistent: ${bundle.id}`);
    }
    const targetPackageSnapshotId = requiredMapValue(
      agentEnvironmentPackageSnapshotIds,
      sourceLineage.packageSnapshotId,
      'agent environment package snapshot'
    );
    const targetLineage = {
      workspaceId: context.targetWorkspaceId,
      threadId: requiredMapValue(threadIds, sourceLineage.threadId, 'thread'),
      turnId: requiredMapValue(turnIds, sourceLineage.turnId, 'turn'),
      agentSessionId: requiredMapValue(
        agentSessionIds,
        sourceLineage.agentSessionId,
        'agent session'
      ),
      packageSnapshotId: targetPackageSnapshotId,
      requestId: sourceLineage.requestId,
    };
    const reminted = remintWorkerRuntimeProvenanceIndex(sourceText, sourceLineage, targetLineage);
    const targetBundleId = createWorkerRuntimeProvenanceBundleId(
      'worker-runtime-provenance-index',
      targetPackageSnapshotId
    );
    provenancePackages.set(bundle.id, {
      targetPackageSnapshotId,
      digest: reminted.digest,
    });
    runtimeOriginRefsByPackageSnapshotId.set(
      sourceLineage.packageSnapshotId,
      reminted.runtimeOriginRefs
    );
    runtimeProvenanceIndexes.set(targetBundleId, reminted.text);
  }
  for (const sourceIndexId of provenancePackages.keys()) {
    const linkedRuntime = exportedRuntimeEvidence.filter((runtime) =>
      runtime.evidenceBundleIds.includes(sourceIndexId)
    );
    const linkedRaw = linkedRuntime.flatMap((runtime) =>
      runtime.evidenceBundleIds.filter(
        (id) =>
          exportedEvidenceBundles.find((bundle) => bundle.id === id)?.sourceKind ===
          'worker-runtime-provenance-raw'
      )
    );
    if (
      linkedRuntime.length !== 1 ||
      linkedRaw.length !== 1 ||
      linkedRuntime[0]?.phase !== 'transcript-collection' ||
      !linkedRuntime[0]?.requiredFeatures.includes('worker.runtime-provenance.v1')
    ) {
      throw new Error('Runtime provenance bundle linkage is incomplete.');
    }
  }
  const capabilityCalls = exportedCapabilityCalls.map((parsed) => {
    const packageSnapshotId = parsed.packageSnapshotId
      ? requiredMapValue(
          agentEnvironmentPackageSnapshotIds,
          parsed.packageSnapshotId,
          'agent environment package snapshot'
        )
      : null;
    const runtimeOriginRef = parsed.runtimeOriginRef
      ? parsed.packageSnapshotId
        ? runtimeOriginRefsByPackageSnapshotId
            .get(parsed.packageSnapshotId)
            ?.get(parsed.runtimeOriginRef)
        : undefined
      : null;
    if (parsed.runtimeOriginRef && !runtimeOriginRef) {
      throw new Error('Runtime origin reference is absent from its package normalized index.');
    }

    return ExportedCapabilityCallSchema.parse({
      ...parsed,
      threadId: parsed.threadId ? requiredMapValue(threadIds, parsed.threadId, 'thread') : null,
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      itemId: parsed.itemId ? requiredMapValue(itemIds, parsed.itemId, 'item') : null,
      agentSessionId: parsed.agentSessionId
        ? requiredMapValue(agentSessionIds, parsed.agentSessionId, 'agent session')
        : null,
      packageSnapshotId,
      runtimeOriginRef,
      runtimeCacheLineageRef: parsed.runtimeCacheLineageRef
        ? `rcl_${createHash('sha256')
            .update(
              `runtime-cache-lineage:${context.targetWorkspaceId}:${parsed.runtimeCacheLineageRef}`
            )
            .digest('hex')
            .slice(0, 24)}`
        : null,
      workspaceId: context.targetWorkspaceId,
    });
  });
  for (const [index, bundle] of exportedEvidenceBundles.entries()) {
    const indexPackage = provenancePackages.get(bundle.id);
    const pairedIndexId = exportedRuntimeEvidence
      .find((runtime) => runtime.evidenceBundleIds.includes(bundle.id))
      ?.evidenceBundleIds.find((id) => provenancePackages.has(id));
    const pairedPackage = pairedIndexId ? provenancePackages.get(pairedIndexId) : undefined;
    const provenancePackage = indexPackage ?? pairedPackage;
    if (
      (bundle.sourceKind === 'worker-runtime-provenance-raw' ||
        bundle.sourceKind === 'worker-runtime-provenance-index') &&
      !provenancePackage
    ) {
      throw new Error('Runtime provenance bundle linkage is incomplete.');
    }
    const targetId = provenancePackage
      ? createWorkerRuntimeProvenanceBundleId(
          bundle.sourceKind === 'worker-runtime-provenance-raw'
            ? 'worker-runtime-provenance-raw'
            : 'worker-runtime-provenance-index',
          provenancePackage.targetPackageSnapshotId
        )
      : `evb_imported_${context.targetWorkspaceId}_${index + 1}`;
    evidenceBundleIds.set(bundle.id, targetId);
  }
  const evidenceBundles = exportedEvidenceBundles.map((parsed) => {
    const provenancePackage = provenancePackages.get(parsed.id);
    if (
      parsed.sourceKind === 'worker-runtime-provenance-raw' &&
      (parsed.importStatus !== 'expired' ||
        parsed.rawEvidenceRefs.length > 0 ||
        parsed.redactedEvidenceRefs.length > 0)
    ) {
      throw new Error('Portable restricted runtime provenance must be expired and ref-free.');
    }

    return EvidenceBundleRecordSchema.parse({
      ...parsed,
      id: requiredMapValue(evidenceBundleIds, parsed.id, 'evidence bundle'),
      threadId: parsed.threadId ? requiredMapValue(threadIds, parsed.threadId, 'thread') : null,
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      goalId: parsed.goalId ? requiredMapValue(goalIds, parsed.goalId, 'goal') : null,
      agentSessionId: parsed.agentSessionId
        ? requiredMapValue(agentSessionIds, parsed.agentSessionId, 'agent session')
        : null,
      rawEvidenceRefs: rewriteEvidenceRefs(parsed.rawEvidenceRefs, context),
      redactedEvidenceRefs: rewriteEvidenceRefs(parsed.redactedEvidenceRefs, context),
      ...(provenancePackage ? { contentDigests: [provenancePackage.digest] } : {}),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const runtimeEvidence = exportedRuntimeEvidence.map((parsed) => {
    const sourceIndexId = parsed.evidenceBundleIds.find((id) => provenancePackages.has(id));
    const provenancePackage = sourceIndexId ? provenancePackages.get(sourceIndexId) : undefined;
    const sourceIndexBundle = sourceIndexId
      ? exportedEvidenceBundles.find((bundle) => bundle.id === sourceIndexId)
      : undefined;
    const targetIndexDigest = provenancePackage?.digest;
    assertApprovedGoalTaskReference(
      parsed.goalId,
      parsed.taskId,
      goalTaskRecordKeys,
      'Runtime Evidence'
    );

    return RuntimeEvidenceRecordSchema.parse({
      ...parsed,
      ...(provenancePackage
        ? { id: createWorkerRuntimeProvenanceEvidenceId(provenancePackage.targetPackageSnapshotId) }
        : {}),
      threadId: parsed.threadId ? requiredMapValue(threadIds, parsed.threadId, 'thread') : null,
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      goalId: parsed.goalId ? requiredMapValue(goalIds, parsed.goalId, 'goal') : null,
      taskId: parsed.taskId ? requiredMapValue(goalTaskIds, parsed.taskId, 'goal task') : null,
      agentSessionId: parsed.agentSessionId
        ? (agentSessionIds.get(parsed.agentSessionId) ?? parsed.agentSessionId)
        : null,
      evidenceBundleIds: parsed.evidenceBundleIds.map((id) =>
        requiredMapValue(evidenceBundleIds, id, 'evidence bundle')
      ),
      contentDigests:
        targetIndexDigest && sourceIndexBundle
          ? parsed.contentDigests.map((digest) =>
              sourceIndexBundle.contentDigests.includes(digest) ? targetIndexDigest : digest
            )
          : parsed.contentDigests,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const usageRecords = readOptionalImportJsonl(context.files, 'records/usage-records.jsonl').map(
    (record) => {
      const parsed = ImportedUsageRecordSchema.parse(record);

      return UsageRecordSchema.parse({
        ...parsed,
        threadId: parsed.threadId ? requiredMapValue(threadIds, parsed.threadId, 'thread') : null,
        turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
        itemId: parsed.itemId ? requiredMapValue(itemIds, parsed.itemId, 'item') : null,
        agentSessionId: parsed.agentSessionId
          ? requiredMapValue(agentSessionIds, parsed.agentSessionId, 'agent session')
          : null,
        workspaceId: context.targetWorkspaceId,
      });
    }
  );
  const dataSourceCatalogPath = 'records/data-sources.json';
  let dataSourceCatalog: WorkspaceDataSourceCatalog | null = null;
  if (context.files.has(dataSourceCatalogPath)) {
    const catalog = parseWorkspaceDataSourceCatalog(
      readImportJson(context.files, dataSourceCatalogPath)
    );
    dataSourceCatalog = parseWorkspaceDataSourceCatalog({
      ...catalog,
      sources: catalog.sources.map((source) => ({
        ...source,
        ...(source.vaultGrantRef
          ? {
              vaultGrantRef: requiredMapValue(vaultGrantIds, source.vaultGrantRef, 'vault grant'),
            }
          : {}),
      })),
    });
  }
  const gitPushRecords = readOptionalImportJsonl(
    context.files,
    'records/git-push-records.jsonl'
  ).map((record) => {
    const parsed = ExportedGitPushRecordSchema.parse(record);

    return ExportedGitPushRecordSchema.parse({
      ...parsed,
      approvalRowId: parsed.approvalRowId
        ? requiredMapValue(approvalRequestIds, parsed.approvalRowId, 'approval request')
        : null,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const resolvedAgentSetups = readOptionalImportJsonl(
    context.files,
    'records/resolved-agent-setups.jsonl'
  ).map((record) => {
    const parsed = ExportedResolvedAgentSetupSchema.parse(record);

    return {
      id: parsed.id,
      workspaceId: context.targetWorkspaceId,
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      requestId: parsed.requestId,
      agentId: parsed.agentId,
      providerId: parsed.providerId,
      runtimeKind: parsed.runtimeKind,
      runtimeAdapter: parsed.runtimeAdapter,
      requiredFeatures: parsed.setupRequiredFeatures,
      setup: parsed.setup,
      createdAt: parsed.createdAt,
    } as ExportedResolvedAgentSetup;
  });
  const permissionDecisions = readOptionalImportJsonl(
    context.files,
    'records/permission-decisions.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkspacePermissionDecisionSchema.parse(record);

    return ExportedWorkspacePermissionDecisionSchema.parse({
      ...parsed,
      approvalId: parsed.approvalId
        ? requiredMapValue(approvalRequestIds, parsed.approvalId, 'approval request')
        : null,
      contextSummary: rewriteWorkspaceIdField(
        parsed.contextSummary,
        report.exportedWorkspaceId,
        context.targetWorkspaceId
      ),
      resourceSummary: rewriteWorkspaceIdField(
        parsed.resourceSummary,
        report.exportedWorkspaceId,
        context.targetWorkspaceId
      ),
      subjectSummary: rewriteWorkspaceIdField(
        parsed.subjectSummary,
        report.exportedWorkspaceId,
        context.targetWorkspaceId
      ),
      workspaceId: context.targetWorkspaceId,
    });
  });

  return {
    vaultReferences,
    vaultGrants,
    injectionPlans,
    injectionReceipts,
    vaultUseRecords,
    auditEvents,
    capabilityCalls,
    evidenceBundles,
    runtimeEvidence,
    runtimeProvenanceIndexes,
    usageRecords,
    dataSourceCatalog,
    gitPushRecords,
    resolvedAgentSetups,
    permissionDecisions,
  };
}

/**
 * Reconstructs portable repository and workspace synchronization records.
 *
 * @param context Shared import lineage and verified bytes.
 * @returns Imported repository and workspace synchronization records.
 * @throws Error when a synchronization record references missing exported state.
 */
function readWorkspaceSyncImportState(context: ImportRemintContext) {
  const { artifactIds, evidenceBundleIds, report, vaultGrantIds } = context;
  const workspaceRepositories = readOptionalImportJsonl(
    context.files,
    'records/workspace-repositories.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkspaceRepositoryResourceSchema.parse(record);
    return ExportedWorkspaceRepositoryResourceSchema.parse({
      ...parsed,
      git: {
        ...parsed.git,
        vaultGrantRef: parsed.git.vaultGrantRef
          ? requiredMapValue(vaultGrantIds, parsed.git.vaultGrantRef, 'vault grant')
          : null,
      },
    });
  });
  const workspaceInputSnapshots = readOptionalImportJsonl(
    context.files,
    'records/workspace-input-snapshots.jsonl'
  ).map((record) => {
    const parsed = WorkspaceInputSnapshotSchema.parse(record);

    return WorkspaceInputSnapshotSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workspaceMaterializationRecords = readOptionalImportJsonl(
    context.files,
    'records/workspace-materialization-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceMaterializationRecordSchema.parse(record);

    return WorkspaceMaterializationRecordSchema.parse({
      ...parsed,
      packageSnapshotId: requiredMapValue(
        context.agentEnvironmentPackageSnapshotIds,
        parsed.packageSnapshotId,
        'agent environment package snapshot'
      ),
      materializedRootRef: rewriteWorkspaceReference(
        parsed.materializedRootRef,
        report.exportedWorkspaceId,
        context.targetWorkspaceId
      ),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const backendWorkspaceHandles = readOptionalImportJsonl(
    context.files,
    'records/backend-workspace-handles.jsonl'
  ).map((record) => {
    const parsed = BackendWorkspaceHandleSchema.parse(record);

    return BackendWorkspaceHandleSchema.parse({
      ...parsed,
      packageSnapshotId: requiredMapValue(
        context.agentEnvironmentPackageSnapshotIds,
        parsed.packageSnapshotId,
        'agent environment package snapshot'
      ),
      transportRefs: parsed.transportRefs.map((transportRef) => ({
        ...transportRef,
        ref: rewriteWorkspaceReference(
          transportRef.ref,
          report.exportedWorkspaceId,
          context.targetWorkspaceId
        ),
      })),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workerOutputManifests = readOptionalImportJsonl(
    context.files,
    'records/worker-output-manifests.jsonl'
  ).map((record) => {
    const parsed = WorkerOutputManifestSchema.parse(record);

    return WorkerOutputManifestSchema.parse({
      ...parsed,
      artifactIds: parsed.artifactIds.map((artifactId) =>
        requiredMapValue(artifactIds, artifactId, 'artifact')
      ),
      evidenceRefs: rewriteEvidenceRefs(parsed.evidenceRefs, context),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workspaceChangeSets = readOptionalImportJsonl(
    context.files,
    'records/workspace-change-sets.jsonl'
  ).map((record) => {
    const parsed = WorkspaceChangeSetSchema.parse(record);

    return WorkspaceChangeSetSchema.parse({
      ...parsed,
      artifactIds: parsed.artifactIds.map((artifactId) =>
        requiredMapValue(artifactIds, artifactId, 'artifact')
      ),
      evidenceRefs: rewriteEvidenceRefs(parsed.evidenceRefs, context),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const stagedWorkspaceReviews = readOptionalImportJsonl(
    context.files,
    'records/staged-workspace-reviews.jsonl'
  ).map((record) => {
    const parsed = ExportedStagedWorkspaceReviewSchema.parse(record);

    return ExportedStagedWorkspaceReviewSchema.parse({
      ...parsed,
      artifactId: requiredMapValue(artifactIds, parsed.artifactId, 'artifact'),
      review: {
        ...parsed.review,
        staging: {
          ...parsed.review.staging,
          ref: rewriteWorkspaceReference(
            parsed.review.staging.ref,
            report.exportedWorkspaceId,
            context.targetWorkspaceId
          ),
        },
        workspaceId: context.targetWorkspaceId,
      },
    });
  });
  const workspaceApplyResults = readOptionalImportJsonl(
    context.files,
    'records/workspace-apply-results.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkspaceApplyResultSchema.parse(record);

    return ExportedWorkspaceApplyResultSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workspaceApplyPlans = readOptionalImportJsonl(
    context.files,
    'records/workspace-apply-plans.jsonl'
  ).map((record) => {
    const parsed = WorkspaceApplyPlanSchema.parse(record);

    return WorkspaceApplyPlanSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workspaceReconciliationRecords = readOptionalImportJsonl(
    context.files,
    'records/workspace-reconciliation-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceReconciliationRecordSchema.parse(record);

    return WorkspaceReconciliationRecordSchema.parse({
      ...parsed,
      evidenceBundleIds: parsed.evidenceBundleIds.map((id) =>
        requiredMapValue(evidenceBundleIds, id, 'evidence bundle')
      ),
      workspaceId: context.targetWorkspaceId,
    });
  });
  const workspaceQuarantineRecords = readOptionalImportJsonl(
    context.files,
    'records/workspace-quarantine-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceQuarantineRecordSchema.parse(record);

    return WorkspaceQuarantineRecordSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
    });
  });
  return {
    workspaceRepositories,
    workspaceInputSnapshots,
    workspaceMaterializationRecords,
    backendWorkspaceHandles,
    workerOutputManifests,
    workspaceChangeSets,
    stagedWorkspaceReviews,
    workspaceApplyPlans,
    workspaceApplyResults,
    workspaceReconciliationRecords,
    workspaceQuarantineRecords,
  };
}

/**
 * Reconstructs the accepted Material, Review, and worker Context Package import graph.
 *
 * @param context Shared import lineage and verified export bytes.
 * @param canonical Reminted canonical workspace history.
 * @param workspaceSync Reminted Workspace Sync owners referenced by work-resource records.
 * @returns Reminted work-resource rows, canonical snapshots, and portable Context Package files.
 * @throws Error when source lineage is incomplete, ambiguous, or contradictory.
 */
function readWorkResourceImportState(
  context: ImportRemintContext,
  canonical: ReturnType<typeof readCanonicalImportState>,
  workspaceSync: ReturnType<typeof readWorkspaceSyncImportState>
) {
  assertMaterialGraph(
    context.sourceWorkspaceMaterials,
    context.sourceWorkspaceMaterialRevisions,
    context.sourceThreadMaterialBindings,
    context.report.exportedWorkspaceId,
    new Set(context.threadIds.keys())
  );
  const workspaceMaterials = context.sourceWorkspaceMaterials.map((material) =>
    ImportedWorkspaceMaterialSchema.parse({
      ...material,
      workspaceId: context.targetWorkspaceId,
      materialId: requiredMapValue(context.materialIds, material.materialId, 'Material'),
      currentRevisionId: material.currentRevisionId
        ? requiredMaterialRevisionId(context, material.materialId, material.currentRevisionId)
        : null,
      lastMutationRequestId: importRequestLineage(context, material.lastMutationRequestId),
    })
  );
  const workspaceMaterialRevisions = context.sourceWorkspaceMaterialRevisions.map((revision) =>
    ImportedWorkspaceMaterialRevisionSchema.parse({
      ...revision,
      workspaceId: context.targetWorkspaceId,
      materialId: requiredMapValue(context.materialIds, revision.materialId, 'Material'),
      revisionId: requiredMaterialRevisionId(context, revision.materialId, revision.revisionId),
      parentRevisionId: revision.parentRevisionId
        ? requiredMaterialRevisionId(context, revision.materialId, revision.parentRevisionId)
        : null,
      createdByRequestId: importRequestLineage(context, revision.createdByRequestId),
    })
  );
  const threadMaterialBindings = context.sourceThreadMaterialBindings.map((binding) =>
    ImportedThreadMaterialBindingSchema.parse({
      ...binding,
      workspaceId: context.targetWorkspaceId,
      threadId: requiredMapValue(context.threadIds, binding.threadId, 'thread'),
      materialId: requiredMapValue(context.materialIds, binding.materialId, 'Material'),
      latestQueuedRevisionId: binding.latestQueuedRevisionId
        ? requiredMaterialRevisionId(context, binding.materialId, binding.latestQueuedRevisionId)
        : null,
      lastMutationRequestId: importRequestLineage(context, binding.lastMutationRequestId),
    })
  );
  assertMaterialGraph(
    workspaceMaterials,
    workspaceMaterialRevisions,
    threadMaterialBindings,
    context.targetWorkspaceId,
    new Set(canonical.threads.map((thread) => thread.id))
  );
  const itemText = new Map<string, string>();
  const threadPreviewText = new Map<string, string>();
  const tracesBySourceTurn = new Map<string, WorkerContextPackageTrace>();
  const workerContextPackageFiles = new Map<string, string>();
  const agentEnvironmentPackageSnapshots = [...canonical.agentEnvironmentPackageSnapshots];
  const workspaceInputSnapshots = [...workspaceSync.workspaceInputSnapshots];
  const workspaceMaterializationRecords = [...workspaceSync.workspaceMaterializationRecords];
  const tracePaths = [...context.files.keys()]
    .map(
      (path) =>
        [
          path,
          /^workspace-files\/threads\/([^/]+)\/turns\/([^/]+)\/context-package\.json$/.exec(path),
        ] as const
    )
    .filter((entry): entry is readonly [string, RegExpExecArray] => entry[1] !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  const tracedTurnIds = new Set(tracePaths.map(([, match]) => match[2]!));
  for (const [sourceTurnId, targetTurnId] of context.turnIds) {
    const turn = canonical.turns.find((candidate) => candidate.id === targetTurnId)!;
    if ((turn.agentSessionId != null) !== tracedTurnIds.has(sourceTurnId)) {
      throw new Error(`Worker Context Package coverage is incomplete: ${sourceTurnId}`);
    }
  }
  for (const [tracePath, pathMatch] of tracePaths) {
    const sourceThreadId = pathMatch[1]!;
    const sourceTurnId = pathMatch[2]!;
    const sourceTrace = parseWorkerContextPackageTrace(
      JSON.parse(requiredExportFile(context.files, tracePath))
    );
    if (
      sourceTrace.workspaceId !== context.report.exportedWorkspaceId ||
      sourceTrace.threadId !== sourceThreadId ||
      sourceTrace.turnId !== sourceTurnId
    ) {
      throw new Error('Worker Context Package trace path lineage is contradictory.');
    }
    const sourceRequestItem = requiredMapValue(
      context.itemLineage,
      sourceTrace.workerRequestItemId,
      'worker request Item'
    );
    if (sourceRequestItem.type !== 'user-message') {
      throw new Error('Worker Context Package request Item has no canonical text.');
    }
    const sourcePackageRoot = `workspace-files/threads/${sourceThreadId}/turns/${sourceTurnId}/context-package`;
    const sourceManifest = z
      .object({ contextBudgetTokens: z.number().int().positive().safe() })
      .passthrough()
      .parse(JSON.parse(requiredExportFile(context.files, `${sourcePackageRoot}/package.json`)));
    const knowledgeSelections = sourceTrace.knowledgeSelections.map((selection) => ({
      content: requiredExportFile(context.files, `${sourcePackageRoot}/${selection.packagePath}`),
      contentDigest: selection.contentDigest,
      knowledgePageId: selection.knowledgePageId,
      sourceRefs: selection.sourceRefs,
    }));
    const sourcePackage = createWorkerContextPackageFiles({
      contextBudgetTokens: sourceManifest.contextBudgetTokens,
      includedItemIds: sourceTrace.includedItemIds,
      knowledgeSelections,
      materialSelections: sourceTrace.materialSelections.map((selection) => {
        const revision = requireMaterialRevision(
          context.sourceWorkspaceMaterialRevisions,
          selection.materialId,
          selection.revisionId
        );
        const material = requireMaterial(context.sourceWorkspaceMaterials, selection.materialId);
        return { ...selection, content: revision.content, sensitivity: material.sensitivity };
      }),
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      workerRequestBytes: sourceRequestItem.text,
      workerRequestItemId: sourceTrace.workerRequestItemId,
      workspaceId: context.report.exportedWorkspaceId,
    });
    const rebuiltSourceTrace = createWorkerContextPackageTrace({
      agentSessionId: sourceTrace.agentSessionId,
      excludedItems: sourceTrace.excludedItems,
      goalId: sourceTrace.goalId,
      knowledgeExclusions: sourceTrace.knowledgeExclusions,
      knowledgeSelectionInput: sourceTrace.knowledgeSelectionInput,
      materialExclusions: sourceTrace.materialExclusions,
      packageFiles: sourcePackage,
      packageSnapshotId: sourceTrace.packageSnapshotId,
      requestId: sourceTrace.requestId,
      taskId: sourceTrace.taskId,
    });
    if (
      serializeWorkerContextPackageTrace(rebuiltSourceTrace) !==
      requiredExportFile(context.files, tracePath)
    ) {
      throw new Error('Worker Context Package source trace is contradictory.');
    }
    const sourcePackagePaths = new Set<string>();
    for (const file of sourcePackage.files) {
      const path = `${sourcePackageRoot}/${file.path}`;
      sourcePackagePaths.add(path);
      if (requiredExportFile(context.files, path) !== Buffer.from(file.bytes).toString('utf8')) {
        throw new Error(`Worker Context Package source bytes are contradictory: ${file.path}`);
      }
    }
    const unexpectedSourceFile = [...context.files.keys()].find(
      (path) => path.startsWith(`${sourcePackageRoot}/`) && !sourcePackagePaths.has(path)
    );
    if (unexpectedSourceFile) {
      throw new Error(
        `Worker Context Package contains an unexpected file: ${unexpectedSourceFile}`
      );
    }

    const targetThreadId = requiredMapValue(context.threadIds, sourceThreadId, 'thread');
    const targetTurnId = requiredMapValue(context.turnIds, sourceTurnId, 'turn');
    const targetTurn = canonical.turns.find((turn) => turn.id === targetTurnId)!;
    const targetRequestItemId = requiredMapValue(
      context.itemIds,
      sourceTrace.workerRequestItemId,
      'worker request Item'
    );
    const targetRequestBytes = remintWorkerRequest(sourceRequestItem.text, context);
    itemText.set(targetRequestItemId, targetRequestBytes);
    const targetThread = canonical.threads.find((thread) => thread.id === targetThreadId)!;
    if (targetThread.preview === sourceRequestItem.text) {
      threadPreviewText.set(targetThreadId, targetRequestBytes);
    }
    const targetPackage = createWorkerContextPackageFiles({
      contextBudgetTokens: sourceManifest.contextBudgetTokens,
      includedItemIds: sourceTrace.includedItemIds.map((id) =>
        requiredMapValue(context.itemIds, id, 'included Item')
      ),
      knowledgeSelections,
      materialSelections: sourceTrace.materialSelections.map((selection) => {
        const sourceRevision = requireMaterialRevision(
          context.sourceWorkspaceMaterialRevisions,
          selection.materialId,
          selection.revisionId
        );
        const sourceMaterial = requireMaterial(
          context.sourceWorkspaceMaterials,
          selection.materialId
        );
        return {
          ...selection,
          materialId: requiredMapValue(context.materialIds, selection.materialId, 'Material'),
          revisionId: requiredMaterialRevisionId(
            context,
            selection.materialId,
            selection.revisionId
          ),
          parentRevisionId: selection.parentRevisionId
            ? requiredMaterialRevisionId(context, selection.materialId, selection.parentRevisionId)
            : null,
          bindingMutationRequestId: selection.bindingMutationRequestId
            ? importRequestLineage(context, selection.bindingMutationRequestId)
            : null,
          content: sourceRevision.content,
          sensitivity: sourceMaterial.sensitivity,
        };
      }),
      threadId: targetThreadId,
      turnId: targetTurnId,
      workerRequestBytes: targetRequestBytes,
      workerRequestItemId: targetRequestItemId,
      workspaceId: context.targetWorkspaceId,
    });
    const targetPackageSnapshotId = requiredMapValue(
      context.agentEnvironmentPackageSnapshotIds,
      sourceTrace.packageSnapshotId,
      'agent environment package snapshot'
    );
    const targetTrace = createWorkerContextPackageTrace({
      agentSessionId: requiredMapValue(
        context.agentSessionIds,
        sourceTrace.agentSessionId,
        'agent session'
      ),
      excludedItems: sourceTrace.excludedItems.map((exclusion) => ({
        ...exclusion,
        itemId: requiredMapValue(context.itemIds, exclusion.itemId, 'excluded Item'),
      })),
      goalId: sourceTrace.goalId
        ? requiredMapValue(context.goalIds, sourceTrace.goalId, 'Goal')
        : null,
      knowledgeExclusions: sourceTrace.knowledgeExclusions,
      knowledgeSelectionInput: sourceTrace.knowledgeSelectionInput,
      materialExclusions: sourceTrace.materialExclusions.map((exclusion) => ({
        ...exclusion,
        materialId: requiredMapValue(context.materialIds, exclusion.materialId, 'Material'),
        revisionId: requiredMaterialRevisionId(context, exclusion.materialId, exclusion.revisionId),
      })),
      packageFiles: targetPackage,
      packageSnapshotId: targetPackageSnapshotId,
      requestId: importRequestLineage(context, sourceTrace.requestId),
      taskId: sourceTrace.taskId
        ? requiredMapValue(context.goalTaskIds, sourceTrace.taskId, 'Goal task')
        : null,
    });
    context.contextPackageReferences.set(
      `context-package:${sourceTurnId}@${sourceTrace.contextPackageDigest}`,
      `context-package:${targetTurnId}@${targetTrace.contextPackageDigest}`
    );
    const targetRoot = `threads/${targetThreadId}/turns/${targetTurnId}`;
    for (const file of targetPackage.files) {
      workerContextPackageFiles.set(
        `${targetRoot}/context-package/${file.path}`,
        Buffer.from(file.bytes).toString('utf8')
      );
    }
    workerContextPackageFiles.set(
      `${targetRoot}/context-package.json`,
      serializeWorkerContextPackageTrace(targetTrace)
    );
    tracesBySourceTurn.set(sourceTurnId, sourceTrace);

    const packageIndex = agentEnvironmentPackageSnapshots.findIndex(
      (record) => record.snapshotId === targetPackageSnapshotId
    );
    if (packageIndex < 0) {
      throw new Error('Worker Context Package AEP snapshot is missing.');
    }
    const record = agentEnvironmentPackageSnapshots[packageIndex]!;
    const environmentPackage = AgentEnvironmentPackageSchema.parse(record.snapshot);
    const rewrittenEnvironmentPackage = AgentEnvironmentPackageSchema.parse({
      ...environmentPackage,
      scope: {
        ...environmentPackage.scope,
        requestId: targetTrace.requestId,
        itemId: targetRequestItemId,
      },
      workspace: {
        ...environmentPackage.workspace,
        inputs: environmentPackage.workspace.inputs.map((candidate) =>
          candidate.target === '/openkit/context'
            ? buildWorkerContextPackageWorkspaceInput({
                packageRootDigest: targetPackage.packageRootDigest,
                threadId: targetThreadId,
                turnId: targetTurnId,
              })
            : candidate
        ),
      },
    });
    agentEnvironmentPackageSnapshots[packageIndex] = {
      ...record,
      contentDigest: createHash('sha256')
        .update(JSON.stringify(rewrittenEnvironmentPackage))
        .digest('hex'),
      snapshot: rewrittenEnvironmentPackage,
    };

    const sourceInputIndex = workspaceInputSnapshots.findIndex(
      (snapshot) => snapshot.id === sourceTrace.workspaceInputSnapshotId
    );
    const sourceMaterializationIndex = workspaceMaterializationRecords.findIndex(
      (materialization) => materialization.id === sourceTrace.workspaceMaterializationRecordId
    );
    if (sourceInputIndex < 0 || sourceMaterializationIndex < 0) {
      throw new Error('Worker Context Package workspace handoff owner is missing.');
    }
    const sourceInput = workspaceInputSnapshots[sourceInputIndex]!;
    const sourceMaterialization = workspaceMaterializationRecords[sourceMaterializationIndex]!;
    const historicalWorkerSessionId = `import-history-worker_${targetPackageSnapshotId}`;
    workspaceInputSnapshots[sourceInputIndex] = WorkspaceInputSnapshotSchema.parse({
      backend: sourceInput.backend,
      base: { commit: null, contentDigest: targetPackage.packageRootDigest },
      createdAt: targetTurn.startedAt,
      generatedFiles: [],
      id: targetTrace.workspaceInputSnapshotId,
      ignoredPaths: [],
      pathScope: [`context_${targetTurnId}`],
      resourceId: `context_${targetTurnId}`,
      resourceKind: 'filesystem',
      strategy: 'filesystem',
      workspaceId: context.targetWorkspaceId,
      writableRoots: [],
    });
    workspaceMaterializationRecords[sourceMaterializationIndex] =
      WorkspaceMaterializationRecordSchema.parse({
        backendKind: sourceMaterialization.backendKind,
        base: { commit: null, contentDigest: targetPackage.packageRootDigest },
        createdAt: targetTurn.startedAt,
        id: targetTrace.workspaceMaterializationRecordId,
        inputSnapshotId: targetTrace.workspaceInputSnapshotId,
        materializedRootRef: '/openkit/context',
        packageSnapshotId: targetPackageSnapshotId,
        policyDigest: createWorkerContextPackagePolicyDigest({
          backendKind: sourceMaterialization.backendKind,
          packageSnapshotId: targetPackageSnapshotId,
          requiredCapabilities: rewrittenEnvironmentPackage.backend.requiredCapabilities,
        }),
        readinessEvidence: sourceMaterialization.readinessEvidence.map((entry) =>
          entry.kind.startsWith('sandbox.') && entry.ref === sourceMaterialization.workerSessionId
            ? { ...entry, ref: historicalWorkerSessionId }
            : entry
        ),
        strategy: 'filesystem',
        workerSessionId: historicalWorkerSessionId,
        workspaceId: context.targetWorkspaceId,
      });
  }
  const orphanWorkerFile = [...context.files.keys()].find(
    (path) =>
      path.startsWith('workspace-files/threads/') &&
      !tracePaths.some(([tracePath]) => path.startsWith(tracePath.slice(0, -'.json'.length)))
  );
  if (orphanWorkerFile) {
    throw new Error(`Worker Context Package file has no trace: ${orphanWorkerFile}`);
  }

  const threads = canonical.threads.map((thread) => {
    const preview = threadPreviewText.get(thread.id);
    return preview === undefined ? thread : ThreadSchema.parse({ ...thread, preview });
  });
  const itemRevisions = canonical.itemRevisions.map((item) =>
    itemText.has(item.id) ? ItemSchema.parse({ ...item, text: itemText.get(item.id) }) : item
  );
  const currentItems = new Map<string, Item>();
  itemRevisions.forEach((item) => {
    currentItems.set(item.id, item);
  });
  const turns = canonical.turns.map((turn) =>
    TurnSchema.parse({
      ...turn,
      items: turn.items.map((item) => requiredMapValue(currentItems, item.id, 'Item')),
    })
  );
  const turnEvents = refreshImportedTurnEventSnapshots(
    canonical.turnEvents,
    threads,
    currentItems,
    turns
  );
  const artifactReviews = context.sourceArtifactReviews.map((review) => {
    if (
      review.workspaceId !== context.report.exportedWorkspaceId ||
      review.reviewId !==
        deriveArtifactReviewId(review.workspaceId, review.artifactId, review.artifactVersion)
    ) {
      throw new Error('Artifact Review source identity is contradictory.');
    }
    const artifactId = requiredMapValue(context.artifactIds, review.artifactId, 'artifact');
    const materialProposal = review.materialProposal
      ? {
          materialId: requiredMapValue(
            context.materialIds,
            review.materialProposal.materialId,
            'Material'
          ),
          baseRevisionId: requiredMaterialRevisionId(
            context,
            review.materialProposal.materialId,
            review.materialProposal.baseRevisionId
          ),
          baseContentDigest: review.materialProposal.baseContentDigest,
        }
      : null;
    const imported = ImportedArtifactReviewSchema.parse({
      ...review,
      workspaceId: context.targetWorkspaceId,
      reviewId: deriveArtifactReviewId(
        context.targetWorkspaceId,
        artifactId,
        review.artifactVersion
      ),
      artifactId,
      sourceThreadId: review.sourceThreadId
        ? requiredMapValue(context.threadIds, review.sourceThreadId, 'thread')
        : null,
      sourceTurnId: review.sourceTurnId
        ? requiredMapValue(context.turnIds, review.sourceTurnId, 'turn')
        : null,
      materialProposal,
      decisionRequestId: review.decisionRequestId
        ? importRequestLineage(context, review.decisionRequestId)
        : null,
      followUpTurnId: review.followUpTurnId
        ? requiredMapValue(context.turnIds, review.followUpTurnId, 'follow-up turn')
        : null,
      appliedMaterialRevisionId:
        review.appliedMaterialRevisionId && review.materialProposal
          ? requiredMaterialRevisionId(
              context,
              review.materialProposal.materialId,
              review.appliedMaterialRevisionId
            )
          : review.appliedMaterialRevisionId,
    });
    assertArtifactReviewImport(
      review,
      imported,
      canonical.artifacts,
      turns,
      workspaceMaterialRevisions,
      workspaceMaterials,
      workspaceSync.stagedWorkspaceReviews,
      tracesBySourceTurn,
      context.itemLineage
    );
    return imported;
  });

  return {
    agentEnvironmentPackageSnapshots,
    artifactReviews,
    itemRevisions,
    threadMaterialBindings,
    threads,
    turnEvents,
    turns,
    workerContextPackageFiles,
    workspaceInputSnapshots,
    workspaceMaterialRevisions,
    workspaceMaterializationRecords,
    workspaceMaterials,
  };
}

/**
 * Rebinds Thread, Item, and Turn snapshots embedded in already-reminted typed events.
 *
 * @param turnEvents Imported event logs carrying target ids.
 * @param threads Current imported Threads.
 * @param items Current imported Items keyed by target id.
 * @param turns Current imported Turns.
 * @returns Event logs whose typed snapshots match current imported authority.
 * @throws Error when an embedded target Item or Turn is absent.
 */
function refreshImportedTurnEventSnapshots(
  turnEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[],
  threads: readonly Thread[],
  items: ReadonlyMap<string, Item>,
  turns: readonly Turn[]
): Array<[string, SseEventEnvelope[]]> {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  return turnEvents.map(([turnId, events]) => [
    turnId,
    events.map((event) => {
      const data = event.data;
      if (data.type === 'thread-created' || data.type === 'thread-updated') {
        return SseEventEnvelopeSchema.parse({
          ...event,
          data: { ...data, thread: requiredMapValue(threadsById, data.thread.id, 'Thread') },
        });
      }
      if (data.type === 'item-created') {
        return SseEventEnvelopeSchema.parse({
          ...event,
          data: { ...data, item: requiredMapValue(items, data.item.id, 'Item') },
        });
      }
      if (data.type === 'item-completed') {
        const item = requiredMapValue(items, data.item.id, 'Item');
        return SseEventEnvelopeSchema.parse({ ...event, data: { ...data, itemId: item.id, item } });
      }
      if (data.type === 'turn-updated' || data.type === 'turn-completed') {
        return SseEventEnvelopeSchema.parse({
          ...event,
          data: { ...data, turn: requiredMapValue(turnsById, data.turn.id, 'Turn') },
        });
      }
      return event;
    }),
  ]);
}

/**
 * Validates one complete linear Material graph and its Thread bindings.
 *
 * @param materials Source Workspace Material owners.
 * @param revisions Source immutable Material revisions.
 * @param bindings Source Thread-to-Material bindings.
 * @param workspaceId Required source Workspace id.
 * @param threadIds Exported source Thread ids.
 * @throws Error when identity, history, digest, mutation proof, or binding lineage is invalid.
 */
function assertMaterialGraph(
  materials: readonly ImportedWorkspaceMaterial[],
  revisions: readonly ImportedWorkspaceMaterialRevision[],
  bindings: readonly ImportedThreadMaterialBinding[],
  workspaceId: string,
  threadIds: ReadonlySet<string>
): void {
  const materialIds = new Set<string>();
  const revisionKeys = new Set<string>();
  for (const material of materials) {
    if (material.workspaceId !== workspaceId || materialIds.has(material.materialId)) {
      throw new Error(`Material identity is duplicate or out of scope: ${material.materialId}`);
    }
    materialIds.add(material.materialId);
  }
  for (const revision of revisions) {
    const key = materialRevisionKey(revision.materialId, revision.revisionId);
    const material = materials.find((candidate) => candidate.materialId === revision.materialId);
    if (
      revision.workspaceId !== workspaceId ||
      revisionKeys.has(key) ||
      !material ||
      revision.mediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain') ||
      `sha256:${createHash('sha256').update(revision.content).digest('hex')}` !==
        revision.contentDigest
    ) {
      throw new Error(`Material revision is contradictory: ${revision.revisionId}`);
    }
    revisionKeys.add(key);
  }
  for (const material of materials) {
    const owned = revisions.filter((revision) => revision.materialId === material.materialId);
    if (material.currentRevisionId === null) {
      if (owned.length !== 0) {
        throw new Error(
          `Material without a current revision retains history: ${material.materialId}`
        );
      }
      continue;
    }
    const byId = new Map(owned.map((revision) => [revision.revisionId, revision]));
    const roots = owned.filter((revision) => revision.parentRevisionId === null);
    const childCounts = new Map<string, number>();
    for (const revision of owned) {
      if (revision.parentRevisionId !== null) {
        if (!byId.has(revision.parentRevisionId)) {
          throw new Error(`Material revision has a missing parent: ${revision.revisionId}`);
        }
        childCounts.set(
          revision.parentRevisionId,
          (childCounts.get(revision.parentRevisionId) ?? 0) + 1
        );
      }
    }
    if (
      roots.length !== 1 ||
      [...childCounts.values()].some((count) => count !== 1) ||
      byId.get(material.currentRevisionId)?.createdByRequestId !== material.lastMutationRequestId
    ) {
      throw new Error(`Material revision graph is not linear: ${material.materialId}`);
    }
    const visited = new Set<string>();
    let revision = byId.get(material.currentRevisionId);
    while (revision) {
      if (visited.has(revision.revisionId)) {
        throw new Error(`Material revision graph contains a cycle: ${material.materialId}`);
      }
      visited.add(revision.revisionId);
      revision = revision.parentRevisionId ? byId.get(revision.parentRevisionId) : undefined;
    }
    if (visited.size !== owned.length) {
      throw new Error(`Material revision graph is disconnected: ${material.materialId}`);
    }
  }
  const bindingKeys = new Set<string>();
  const boundThreads = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.threadId}\0${binding.materialId}`;
    const material = materials.find((candidate) => candidate.materialId === binding.materialId);
    if (
      binding.workspaceId !== workspaceId ||
      bindingKeys.has(key) ||
      !threadIds.has(binding.threadId) ||
      !material ||
      (binding.latestQueuedRevisionId !== null &&
        (binding.latestQueuedRevisionId !== material.currentRevisionId ||
          !revisionKeys.has(
            materialRevisionKey(binding.materialId, binding.latestQueuedRevisionId)
          ))) ||
      (binding.bindingState === 'unbound' &&
        (binding.latestQueuedRevisionId !== null || binding.inclusionState !== 'included')) ||
      (binding.inclusionState === 'excluded' &&
        (binding.bindingState !== 'bound' || binding.latestQueuedRevisionId === null))
    ) {
      throw new Error(`Thread Material binding is contradictory: ${key}`);
    }
    bindingKeys.add(key);
    if (binding.bindingState === 'bound') {
      if (boundThreads.has(binding.threadId)) {
        throw new Error(`Thread has more than one bound Material: ${binding.threadId}`);
      }
      boundThreads.add(binding.threadId);
    }
  }
}

/**
 * Rewrites one accepted worker request without changing user-authored prose or Artifact bytes.
 *
 * @param text Serialized structured delegation or Artifact Review follow-up request.
 * @param context Shared import lineage maps.
 * @returns Serialized request with every owned reference reminted.
 * @throws Error when the request is malformed or references missing authority.
 */
function remintWorkerRequest(text: string, context: ImportRemintContext): string {
  const value = JSON.parse(text) as unknown;
  const followUp = ArtifactReviewFollowUpRequestSchema.safeParse(value);
  if (followUp.success) {
    const review = context.sourceArtifactReviews.find(
      (candidate) => candidate.reviewId === followUp.data.reviewId
    );
    if (!review) {
      throw new Error(
        `Worker request references missing Artifact Review: ${followUp.data.reviewId}`
      );
    }
    const artifactId = requiredMapValue(context.artifactIds, review.artifactId, 'artifact');
    return serializeArtifactReviewFollowUpRequest({
      ...followUp.data,
      workspaceId: context.targetWorkspaceId,
      reviewId: deriveArtifactReviewId(
        context.targetWorkspaceId,
        artifactId,
        review.artifactVersion
      ),
      artifactId,
      sourceThreadId: requiredMapValue(context.threadIds, followUp.data.sourceThreadId, 'thread'),
      sourceTurnId: requiredMapValue(context.turnIds, followUp.data.sourceTurnId, 'turn'),
      materialProposal: followUp.data.materialProposal
        ? {
            ...followUp.data.materialProposal,
            materialId: requiredMapValue(
              context.materialIds,
              followUp.data.materialProposal.materialId,
              'Material'
            ),
            baseRevisionId: requiredMaterialRevisionId(
              context,
              followUp.data.materialProposal.materialId,
              followUp.data.materialProposal.baseRevisionId
            ),
          }
        : null,
      decisionRequestId: importRequestLineage(context, followUp.data.decisionRequestId),
      workerRequestId: importRequestLineage(context, followUp.data.workerRequestId),
    });
  }
  const request = StructuredWorkerDelegationRequestSchema.parse(value);
  /**
   * Rewrites one structured request reference through the matching import authority map.
   *
   * @param kind Structured reference kind.
   * @param id Source reference identity.
   * @returns Target identity, or the unchanged id for stable or unknown reference kinds.
   * @throws Error when a reminted reference has no matching source owner.
   */
  const rewriteReference = (kind: string, id: string): string => {
    switch (kind) {
      case 'workspace':
        if (id !== context.report.exportedWorkspaceId) {
          throw new Error(`Worker request references another Workspace: ${id}`);
        }
        return context.targetWorkspaceId;
      case 'thread':
        return requiredMapValue(context.threadIds, id, 'thread');
      case 'item':
        return requiredMapValue(context.itemIds, id, 'Item');
      case 'artifact':
        return requiredMapValue(context.artifactIds, id, 'artifact');
      case 'knowledge':
        if (!context.knowledgeIds.has(id)) {
          throw new Error(`Worker request references missing knowledge: ${id}`);
        }
        return id;
      default:
        return id;
    }
  };
  return serializeStructuredWorkerDelegationRequest({
    ...request,
    contextRefs: request.contextRefs.map((reference) => ({
      ...reference,
      id: rewriteReference(reference.kind, reference.id),
    })),
    resources: request.resources.map((resource) => ({
      ...resource,
      reference: rewriteReference(resource.kind, resource.reference),
    })),
    reviewContext: request.reviewContext
      ? {
          ...request.reviewContext,
          reviewId: requiredMapValue(
            context.goalReviewIds,
            request.reviewContext.reviewId,
            'Review'
          ),
          priorTurnId: requiredMapValue(context.turnIds, request.reviewContext.priorTurnId, 'turn'),
          evidence: {
            itemIds: request.reviewContext.evidence.itemIds.map((id) =>
              requiredMapValue(context.itemIds, id, 'Item')
            ),
            artifactIds: request.reviewContext.evidence.artifactIds.map((id) =>
              requiredMapValue(context.artifactIds, id, 'artifact')
            ),
          },
        }
      : null,
  });
}

/**
 * Validates one source and reminted Artifact Review against its durable result owners.
 *
 * @param source Parsed source Artifact Review.
 * @param target Reminted target Artifact Review.
 * @param artifacts Reminted canonical Artifacts.
 * @param turns Reminted canonical Turns.
 * @param revisions Reminted Material revisions.
 * @param materials Reminted Workspace Materials.
 * @param stagedWorkspaceReviews Reminted Workspace Sync review owners.
 * @param tracesBySourceTurn Validated source S39 traces keyed by source Turn id.
 * @param sourceItems Canonical source Items keyed by source id.
 * @throws Error when source, proposal, decision, result, or follow-up lineage is contradictory.
 */
function assertArtifactReviewImport(
  source: ImportedArtifactReview,
  target: ImportedArtifactReview,
  artifacts: readonly Artifact[],
  turns: readonly Turn[],
  revisions: readonly ImportedWorkspaceMaterialRevision[],
  materials: readonly ImportedWorkspaceMaterial[],
  stagedWorkspaceReviews: readonly ExportedStagedWorkspaceReview[],
  tracesBySourceTurn: ReadonlyMap<string, WorkerContextPackageTrace>,
  sourceItems: ReadonlyMap<string, Item>
): void {
  const artifact = artifacts.find((candidate) => candidate.id === target.artifactId);
  if (!artifact || stagedWorkspaceReviews.some((review) => review.artifactId === artifact.id)) {
    throw new Error('Artifact Review conflicts with Artifact or Workspace Sync authority.');
  }
  const sourceTurn = target.sourceTurnId
    ? turns.find((turn) => turn.id === target.sourceTurnId)
    : undefined;
  if (
    (target.sourceThreadId === null) !== (target.sourceTurnId === null) ||
    (target.sourceTurnId !== null &&
      (!sourceTurn ||
        sourceTurn.threadId !== target.sourceThreadId ||
        (sourceTurn.agentId ?? null) !== target.sourceAgentId)) ||
    artifact.origin.kind !== 'turn-output' ||
    artifact.threadId !== target.sourceThreadId ||
    artifact.turnId !== target.sourceTurnId ||
    artifact.origin.threadId !== target.sourceThreadId ||
    artifact.origin.turnId !== target.sourceTurnId ||
    source.artifactVersion > artifact.version
  ) {
    throw new Error('Artifact Review source lineage is contradictory.');
  }
  if (source.decision === null) {
    if (
      source.decisionRequestId !== null ||
      artifact.version !== source.artifactVersion ||
      artifact.status !== 'ready' ||
      artifact.contentDigest !== source.contentDigest
    ) {
      throw new Error('Unresolved Artifact Review has no exact current Artifact version.');
    }
    if (target.materialProposal) {
      const material = materials.find(
        (candidate) => candidate.materialId === target.materialProposal?.materialId
      );
      const mediaFormat = material?.kind === 'markdown' ? 'markdown' : 'text';
      if (!material || artifact.content.format !== mediaFormat) {
        throw new Error('Artifact Review proposal media type is contradictory.');
      }
    }
  } else if (source.decisionRequestId === null) {
    throw new Error('Decided Artifact Review has no request lineage.');
  }
  if (source.materialProposal) {
    if (!source.sourceTurnId) {
      throw new Error('Material proposal Review has no source Turn.');
    }
    const selections = (
      tracesBySourceTurn.get(source.sourceTurnId)?.materialSelections ?? []
    ).filter(
      (selection) =>
        selection.materialId === source.materialProposal?.materialId &&
        selection.revisionId === source.materialProposal.baseRevisionId &&
        selection.contentDigest === source.materialProposal.baseContentDigest
    );
    if (selections.length !== 1) {
      throw new Error('Artifact Review Material proposal lacks one exact S39 selection.');
    }
  }
  if (target.decision === 'accepted' && target.materialProposal) {
    const applied = target.appliedMaterialRevisionId
      ? revisions.find(
          (revision) =>
            revision.materialId === target.materialProposal?.materialId &&
            revision.revisionId === target.appliedMaterialRevisionId
        )
      : undefined;
    const material = materials.find(
      (candidate) => candidate.materialId === target.materialProposal?.materialId
    );
    if (
      !applied ||
      !material ||
      applied.parentRevisionId !== target.materialProposal.baseRevisionId ||
      applied.contentDigest !== target.contentDigest ||
      applied.authorId !== target.decisionActorId ||
      applied.createdByRequestId !== target.decisionRequestId ||
      applied.createdAt !== target.decidedAt ||
      applied.mediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain')
    ) {
      throw new Error('Artifact Review applied Material revision is contradictory.');
    }
  } else if (target.appliedMaterialRevisionId !== null) {
    throw new Error('Artifact Review has an invalid applied Material revision.');
  }
  if (target.decision === 'needs_refinement' || target.decision === 'redo') {
    const followUpTurn = turns.find((turn) => turn.id === target.followUpTurnId);
    const sourceTrace = source.followUpTurnId
      ? tracesBySourceTurn.get(source.followUpTurnId)
      : undefined;
    const requestItem = sourceTrace ? sourceItems.get(sourceTrace.workerRequestItemId) : undefined;
    const request =
      requestItem?.type === 'user-message'
        ? ArtifactReviewFollowUpRequestSchema.safeParse(JSON.parse(requestItem.text))
        : null;
    const proposal = request?.success ? request.data.materialProposal : null;
    const proposalMaterial = target.materialProposal
      ? materials.find((material) => material.materialId === target.materialProposal?.materialId)
      : undefined;
    const proposalMatches =
      proposal === null
        ? source.materialProposal === null
        : source.materialProposal !== null &&
          request?.success === true &&
          proposal.materialId === source.materialProposal.materialId &&
          proposal.baseRevisionId === source.materialProposal.baseRevisionId &&
          proposal.baseContentDigest === source.materialProposal.baseContentDigest &&
          proposalMaterial !== undefined &&
          request.data.artifactMediaType ===
            (proposalMaterial.kind === 'markdown' ? 'text/markdown' : 'text/plain');
    const decisionRequestId = source.decisionRequestId;
    if (
      !followUpTurn ||
      followUpTurn.id === target.sourceTurnId ||
      followUpTurn.threadId !== target.sourceThreadId ||
      (followUpTurn.agentId ?? null) !== target.sourceAgentId ||
      !sourceTrace ||
      sourceTrace.goalId !== null ||
      sourceTrace.taskId !== null ||
      !request?.success ||
      decisionRequestId === null ||
      request.data.workspaceId !== source.workspaceId ||
      request.data.reviewId !== source.reviewId ||
      request.data.artifactId !== source.artifactId ||
      request.data.artifactVersion !== source.artifactVersion ||
      request.data.contentDigest !== source.contentDigest ||
      request.data.sourceThreadId !== source.sourceThreadId ||
      request.data.sourceTurnId !== source.sourceTurnId ||
      request.data.sourceAgentId !== source.sourceAgentId ||
      !proposalMatches ||
      request.data.decision !== source.decision ||
      request.data.feedback !== source.feedback ||
      request.data.decisionRequestId !== decisionRequestId ||
      request.data.workerRequestId !== sourceTrace.requestId ||
      (!/^import-lineage:sha256:[a-f0-9]{64}$/.test(decisionRequestId) &&
        (source.followUpTurnId !==
          deriveArtifactReviewFollowUpTurnId(
            source.workspaceId,
            source.artifactId,
            source.artifactVersion,
            decisionRequestId
          ) ||
          request.data.workerRequestId !== deriveArtifactReviewWorkerRequestId(decisionRequestId)))
    ) {
      throw new Error('Artifact Review follow-up Turn lineage is contradictory.');
    }
  }
}

/**
 * Derives one reserved historical request token from exact source deployment lineage.
 *
 * @param context Shared import lineage and source manifest.
 * @param requestId Source private mutation request id.
 * @returns Deterministic non-command import lineage token.
 */
function importRequestLineage(context: ImportRemintContext, requestId: string): string {
  const digest = createHash('sha256')
    .update(context.report.manifest.sourceDeploymentId)
    .update('\0')
    .update(context.report.exportedWorkspaceId)
    .update('\0')
    .update(requestId)
    .digest('hex');
  return `import-lineage:sha256:${digest}`;
}

/**
 * Reads one required Material from a parsed row set.
 *
 * @param materials Parsed source Materials.
 * @param materialId Required source Material id.
 * @returns The unique matching Material.
 * @throws Error when the reference is missing or ambiguous.
 */
function requireMaterial(
  materials: readonly ImportedWorkspaceMaterial[],
  materialId: string
): ImportedWorkspaceMaterial {
  const matches = materials.filter((material) => material.materialId === materialId);
  if (matches.length !== 1) {
    throw new Error(`Material reference is missing or ambiguous: ${materialId}`);
  }
  return matches[0]!;
}

/**
 * Reads one required Material revision from a parsed row set.
 *
 * @param revisions Parsed source Material revisions.
 * @param materialId Owning source Material id.
 * @param revisionId Required source revision id.
 * @returns The unique matching Material revision.
 * @throws Error when the reference is missing or ambiguous.
 */
function requireMaterialRevision(
  revisions: readonly ImportedWorkspaceMaterialRevision[],
  materialId: string,
  revisionId: string
): ImportedWorkspaceMaterialRevision {
  const matches = revisions.filter(
    (revision) => revision.materialId === materialId && revision.revisionId === revisionId
  );
  if (matches.length !== 1) {
    throw new Error(`Material revision reference is missing or ambiguous: ${revisionId}`);
  }
  return matches[0]!;
}

/**
 * Reads one target revision id from its composite source identity.
 *
 * @param context Shared import lineage maps.
 * @param materialId Owning source Material id.
 * @param revisionId Source revision id.
 * @returns Reminted target revision id.
 * @throws Error when the source revision has no reminted identity.
 */
function requiredMaterialRevisionId(
  context: ImportRemintContext,
  materialId: string,
  revisionId: string
): string {
  return requiredMapValue(
    context.materialRevisionIds,
    materialRevisionKey(materialId, revisionId),
    'Material revision'
  );
}

/**
 * Builds an unambiguous Material revision map key.
 *
 * @param materialId Owning Material id.
 * @param revisionId Material revision id.
 * @returns NUL-delimited composite identity.
 */
function materialRevisionKey(materialId: string, revisionId: string): string {
  return `${materialId}\0${revisionId}`;
}

/**
 * Reconstructs authoritative workspace files after every referenced id map is known.
 *
 * @param context Shared import lineage and verified bytes.
 * @returns Imported portable file state.
 * @throws Error when a portable record references missing exported state.
 */
function readPortableImportState(
  context: ImportRemintContext,
  workerContextPackageFiles: ReadonlyMap<string, string>,
  knowledge: readonly KnowledgeEntry[]
): WorkspacePortableFileState {
  const {
    agentSessionIds,
    approvalRequestIds,
    artifactIds,
    goalIds,
    goalTaskIds,
    itemIds,
    knowledgeSourceIds,
    report,
    threadIds,
    turnIds,
    vaultGrantIds,
  } = context;
  const portableFileState = readPortableFileStateFromExport(context.files, {
    sourceWorkspaceId: report.exportedWorkspaceId,
    targetWorkspaceId: context.targetWorkspaceId,
    threadIds,
    turnIds,
    itemIds,
    artifactIds,
    agentSessionIds,
    knowledgeSourceIds,
    contextPackageReferences: context.contextPackageReferences,
    approvalRequestIds,
    vaultGrantIds,
    goalIds,
    goalTaskIds,
  });
  assertPortableKnowledgePagesMatch(portableFileState.nativeKnowledgePages, knowledge);
  return { ...portableFileState, workerContextPackageFiles };
}

/**
 * Verifies a one-to-one projection between canonical Knowledge records and exact portable pages.
 *
 * @param pages Reminted portable page bytes keyed by workspace-relative path.
 * @param knowledge Canonical imported KnowledgeEntry projections.
 * @throws Error when an owned page is missing, duplicated, malformed, or contradictory.
 */
function assertPortableKnowledgePagesMatch(
  pages: ReadonlyMap<string, string>,
  knowledge: readonly KnowledgeEntry[]
): void {
  const expectedById = new Map(knowledge.map((entry) => [entry.id, entry]));
  if (expectedById.size !== knowledge.length) {
    throw new Error('Portable Knowledge Page record identity is ambiguous.');
  }
  const matchedIds = new Set<string>();

  for (const [path, content] of pages) {
    const parsed = parseOkfDocument({ path, content });
    const entryId = parsed.document
      ? stringFrontmatterField(parsed.document, 'openkit_entry_id')
      : null;
    if (!entryId) {
      continue;
    }
    if (matchedIds.has(entryId) || path !== `knowledge/pages/${entryId}.md`) {
      throw new Error(`Portable Knowledge Page identity is ambiguous: ${entryId}`);
    }

    let projected: KnowledgeEntry;
    try {
      projected = parseOwnedKnowledgeEntry(path, entryId, content);
    } catch {
      throw new Error(`Portable Knowledge Page is invalid: ${entryId}`);
    }
    const expected = expectedById.get(entryId);
    if (!expected || !knowledgeEntriesEqual(projected, expected)) {
      throw new Error(`Portable Knowledge Page contradicts its canonical record: ${entryId}`);
    }
    matchedIds.add(entryId);
  }

  const missing = knowledge.find((entry) => !matchedIds.has(entry.id));
  if (missing) {
    throw new Error(`Portable Knowledge Page is missing: ${missing.id}`);
  }
}

/**
 * Reads and remints authoritative workspace files from verified export bytes.
 *
 * @param files Exact verified export file contents.
 * @param context Canonical id maps established by the current import.
 * @returns Portable file state ready for staged publication.
 */
function readPortableFileStateFromExport(
  files: ReadonlyMap<string, string>,
  context: {
    readonly sourceWorkspaceId: string;
    readonly targetWorkspaceId: string;
    readonly threadIds: ReadonlyMap<string, string>;
    readonly turnIds: ReadonlyMap<string, string>;
    readonly itemIds: ReadonlyMap<string, string>;
    readonly artifactIds: ReadonlyMap<string, string>;
    readonly agentSessionIds: ReadonlyMap<string, string>;
    readonly knowledgeSourceIds: ReadonlyMap<string, string>;
    readonly contextPackageReferences: ReadonlyMap<string, string>;
    readonly approvalRequestIds: ReadonlyMap<string, string>;
    readonly vaultGrantIds: ReadonlyMap<string, string>;
    readonly goalIds: ReadonlyMap<string, string>;
    readonly goalTaskIds: ReadonlyMap<string, string>;
  }
): WorkspacePortableFileState {
  const replacementMap = new Map<string, string>([
    [context.sourceWorkspaceId, context.targetWorkspaceId],
  ]);
  for (const idMap of [
    context.contextPackageReferences,
    context.threadIds,
    context.turnIds,
    context.itemIds,
    context.artifactIds,
    context.agentSessionIds,
    context.knowledgeSourceIds,
    context.approvalRequestIds,
    context.vaultGrantIds,
    context.goalIds,
    context.goalTaskIds,
  ]) {
    for (const [sourceId, targetId] of idMap) {
      const existing = replacementMap.get(sourceId);
      if (existing && existing !== targetId) {
        throw new Error(`Portable reference id is ambiguous: ${sourceId}`);
      }
      replacementMap.set(sourceId, targetId);
    }
  }
  const replacements = [...replacementMap].sort(([left], [right]) => right.length - left.length);
  const observations = readImportJsonl(files, 'records/knowledge-observations.jsonl').map(
    (record) => {
      const parsed = ImportedKnowledgeObservationSchema.parse(record);
      assertPortableWorkspaceOwner(parsed.workspaceId, context.sourceWorkspaceId, 'observation');
      return ImportedKnowledgeObservationSchema.parse({
        ...parsed,
        workspaceId: context.targetWorkspaceId,
        sourceReferences: rewritePortableReferences(parsed.sourceReferences, replacements),
      });
    }
  );
  const claims = readImportJsonl(files, 'records/knowledge-claims.jsonl').map((record) => {
    const parsed = ImportedKnowledgeClaimSchema.parse(record);
    assertPortableWorkspaceOwner(parsed.workspaceId, context.sourceWorkspaceId, 'claim');
    return ImportedKnowledgeClaimSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
      sourceReferences: rewritePortableReferences(parsed.sourceReferences, replacements),
    });
  });
  const conflicts = readImportJsonl(files, 'records/knowledge-conflicts.jsonl').map((record) => {
    const parsed = ImportedKnowledgeConflictSchema.parse(record);
    assertPortableWorkspaceOwner(parsed.workspaceId, context.sourceWorkspaceId, 'conflict');
    return ImportedKnowledgeConflictSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
      subjectReferences: rewritePortableReferences(parsed.subjectReferences, replacements),
      sourceReferences: rewritePortableReferences(parsed.sourceReferences, replacements),
    });
  });
  const retrievalTraces = readImportJsonl(files, 'records/knowledge-retrieval-traces.jsonl').map(
    (record) => {
      const parsed = ImportedKnowledgeRetrievalTraceSchema.parse(record);
      assertPortableWorkspaceOwner(
        parsed.workspaceId,
        context.sourceWorkspaceId,
        'retrieval trace'
      );
      return ImportedKnowledgeRetrievalTraceSchema.parse({
        ...parsed,
        workspaceId: context.targetWorkspaceId,
        selected: parsed.selected.map((candidate) => ({
          ...candidate,
          sourceReferences: rewritePortableReferences(candidate.sourceReferences, replacements),
        })),
      });
    }
  );

  let workspaceConfig: string | null = null;
  let workspaceSchema: string | null = null;
  const nativeKnowledgePages = new Map<string, string>();
  for (const [exportPath, content] of files) {
    if (!exportPath.startsWith('workspace-files/')) {
      continue;
    }
    const workspacePath = exportPath.slice('workspace-files/'.length);
    assertPortableWorkspaceFilePath(workspacePath);
    if (workspacePath === 'config/workspace.jsonc') {
      workspaceConfig = content;
    } else if (workspacePath === 'knowledge/schema/workspace-schema.yaml') {
      workspaceSchema = content;
    } else if (workspacePath.startsWith('knowledge/pages/')) {
      nativeKnowledgePages.set(
        workspacePath,
        rewriteNativePageReferences(workspacePath, content, replacements)
      );
    } else if (
      workspacePath.startsWith('evidence/bundles/') ||
      workspacePath.startsWith('threads/')
    ) {
    } else {
      throw new Error(`Unsupported portable workspace file: ${workspacePath}`);
    }
  }

  return {
    observations: groupPortableRecords(observations, (record) => record.observedAt),
    claims: groupPortableRecords(claims, (record) => record.createdAt),
    conflicts: groupPortableRecords(conflicts, (record) => record.resolvedAt ?? record.createdAt),
    retrievalTraces: groupPortableRecords(retrievalTraces, (record) => record.createdAt),
    workspaceConfig,
    workspaceSchema,
    nativeKnowledgePages,
    workerContextPackageFiles: new Map(),
  };
}

/** Fails closed when a portable row is owned by another source workspace. */
function assertPortableWorkspaceOwner(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`Portable ${label} belongs to another workspace: ${actual}`);
  }
}

/** Rewrites known stable ids inside opaque reference strings. */
function rewritePortableReferences(
  references: readonly string[],
  replacements: readonly (readonly [string, string])[]
): string[] {
  return references.map((reference) =>
    replacements.reduce(
      (rewritten, [sourceId, targetId]) => rewritten.replaceAll(sourceId, targetId),
      reference
    )
  );
}

/** Groups append-order records by their authoritative ledger month. */
function groupPortableRecords<T>(
  records: readonly T[],
  timestamp: (record: T) => string
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const value = timestamp(record);
    const match = /^(\d{4})-(\d{2})-/.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
      throw new Error(`Portable ledger timestamp is invalid: ${value}`);
    }
    const month = `${match[1]}${match[2]}`;
    const rows = grouped.get(month) ?? [];
    rows.push(record);
    grouped.set(month, rows);
  }
  return grouped;
}

/** Rewrites only the structured source_refs field of one native OKF page. */
function rewriteNativePageReferences(
  path: string,
  content: string,
  replacements: readonly (readonly [string, string])[]
): string {
  const parsed = parseOkfDocument({ path, content });
  const sourceReferences = parsed.document?.frontmatter.source_refs;
  if (sourceReferences === undefined) {
    return content;
  }
  if (!Array.isArray(sourceReferences)) {
    throw new Error(`Native OKF page has invalid source_refs: ${path}`);
  }
  const rewritten = rewritePortableReferences(sourceReferences, replacements);
  if (rewritten.every((reference, index) => reference === sourceReferences[index])) {
    return content;
  }
  if (!/^source_refs:\s*.+$/m.test(content)) {
    throw new Error(`Native OKF page source_refs cannot be rewritten: ${path}`);
  }
  return content.replace(/^source_refs:\s*.+$/m, `source_refs: ${JSON.stringify(rewritten)}`);
}

/**
 * Reads artifact metadata and its single canonical body file from an export tree.
 *
 * @param files Exact verified export file contents.
 * @param manifest Verified export manifest.
 * @returns Reconstructed artifacts in stable metadata-path order.
 * @throws Error when artifact paths, metadata, or body ownership are inconsistent.
 */
function readExportedArtifacts(
  files: ReadonlyMap<string, string>,
  manifest: WorkspaceExportManifest
): Artifact[] {
  const artifactPaths = manifest.contentInventory
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('artifacts/'));
  const metadataPaths = artifactPaths
    .filter((path) => /^artifacts\/[^/]+\/artifact\.json$/.test(path))
    .sort();
  const expectedPaths = new Set<string>();
  const artifacts = metadataPaths.map((metadataPath) => {
    const artifactId = metadataPath.split('/')[1] as string;
    const metadata = readImportJson(files, metadataPath) as Record<string, unknown>;
    const format = z
      .enum(['markdown', 'text', 'json'])
      .parse((metadata.content as { format?: unknown } | undefined)?.format);
    const bodyPath = `artifacts/${artifactId}/files/${artifactContentFileName(format)}`;

    expectedPaths.add(metadataPath);
    expectedPaths.add(bodyPath);
    const artifact = ArtifactSchema.parse({
      ...metadata,
      content: { format, body: requiredExportFile(files, bodyPath) },
    });
    if (artifact.id !== artifactId) {
      throw new Error(`Artifact ${artifact.id} has invalid directory lineage.`);
    }
    return artifact;
  });

  if (
    artifactPaths.length !== expectedPaths.size ||
    artifactPaths.some((path) => !expectedPaths.has(path))
  ) {
    throw new Error('Artifact export contains missing or duplicate metadata/body ownership.');
  }
  return artifacts;
}

/**
 * Builds one stable Task-id map from Plan order before approved Task rows.
 *
 * @param plans Exported immutable Goal Plans.
 * @param tasks Exported approved Goal Task rows.
 * @param workspaceId Imported Workspace id used in deterministic ids.
 * @returns Source-to-target Task identity map including Plan-only Tasks.
 */
function createStableGoalTaskIdMap(
  plans: readonly ExportedGoalPlanRecord[],
  tasks: readonly ExportedGoalTask[],
  workspaceId: string
): Map<string, string> {
  const result = new Map<string, string>();

  /**
   * Adds one source Task id exactly once in first-seen order.
   *
   * @param taskId Source Task id.
   * @returns Nothing.
   */
  const add = (taskId: string): void => {
    if (!result.has(taskId)) {
      result.set(taskId, `task_imported_${workspaceId}_${result.size + 1}`);
    }
  };

  for (const plan of plans) {
    for (const task of plan.tasks) {
      add(task.taskId);
    }
  }
  for (const task of tasks) {
    add(task.taskId);
    task.dependsOnTaskIds.forEach(add);
  }
  return result;
}

/**
 * Validates immutable Goal, Plan, and approved Task ownership before reminting.
 *
 * @param input Exported authority rows and canonical Item identities.
 * @returns Source Goal-and-Task keys that have approved durable Task rows.
 * @throws Error when ownership, digest, graph, identity, or Task facts disagree.
 */
function assertGoalAuthorityConsistency(input: {
  readonly sourceWorkspaceId: string;
  readonly goals: readonly ExportedGoalRecord[];
  readonly plans: readonly ExportedGoalPlanRecord[];
  readonly tasks: readonly ExportedGoalTask[];
  readonly itemLineage: ReadonlyMap<string, Item>;
}): Set<string> {
  const goalsById = new Map(input.goals.map((goal) => [goal.goalId, goal]));
  const plansByKey = new Map<string, ExportedGoalPlanRecord>();
  const taskRecordKeys = new Set<string>();

  for (const goal of input.goals) {
    if (goal.workspaceId !== input.sourceWorkspaceId) {
      throw new Error(`Goal has invalid Workspace lineage: ${goal.goalId}`);
    }
  }
  for (const plan of input.plans) {
    const goal = goalsById.get(plan.goalId);
    const planItem = input.itemLineage.get(plan.planItemId);
    const key = goalPlanRecordKey(plan.goalId, plan.planItemId);
    if (plansByKey.has(key)) {
      throw new Error(`Goal Plan identity is duplicated: ${plan.planItemId}`);
    }
    if (
      !goal ||
      plan.workspaceId !== input.sourceWorkspaceId ||
      plan.threadId !== goal.threadId ||
      !planItem ||
      planItem.workspaceId !== input.sourceWorkspaceId ||
      planItem.threadId !== plan.threadId ||
      planItem.type !== 'plan'
    ) {
      throw new Error(`Goal Plan has invalid lineage: ${plan.planItemId}`);
    }
    if (plan.questions.length !== 0) {
      throw new Error(`Goal Plan authority cannot retain unresolved questions: ${plan.planItemId}`);
    }
    assertValidGoalPlanGraph(plan.tasks);
    if (plan.planDigest !== computeGoalPlanDigest(plan)) {
      throw new Error(`Goal Plan digest does not match its payload: ${plan.planItemId}`);
    }
    plansByKey.set(key, plan);
  }
  for (const task of input.tasks) {
    const goal = goalsById.get(task.goalId);
    const taskKey = goalTaskRecordKey(task.goalId, task.taskId);
    const plan = plansByKey.get(goalPlanRecordKey(task.goalId, task.planItemId));
    const plannedTask = plan?.tasks[task.orderIndex];
    if (taskRecordKeys.has(taskKey)) {
      throw new Error(`Goal Task identity is duplicated: ${task.goalId}/${task.taskId}`);
    }
    if (
      !goal ||
      !plan ||
      task.workspaceId !== input.sourceWorkspaceId ||
      task.threadId !== goal.threadId ||
      task.planItemId !== goal.planItemId ||
      !plannedTask ||
      JSON.stringify(selectGoalPlanTaskPayload(task)) !== JSON.stringify(plannedTask)
    ) {
      throw new Error(`Goal Task does not match its immutable Plan: ${task.goalId}/${task.taskId}`);
    }
    const response = task.latestGateContextItemId
      ? input.itemLineage.get(task.latestGateContextItemId)
      : null;
    const requestMatches =
      response?.type === 'approval-decision'
        ? [...input.itemLineage.values()].filter(
            (item) =>
              item.type === 'approval-request' &&
              item.status === 'completed' &&
              item.workspaceId === response.workspaceId &&
              item.threadId === response.threadId &&
              item.turnId === response.turnId &&
              item.approvalRequestId === response.approvalRequestId
          )
        : response?.type === 'user-input-response'
          ? [...input.itemLineage.values()].filter(
              (item) =>
                item.type === 'user-input-request' &&
                item.status === 'completed' &&
                item.workspaceId === response.workspaceId &&
                item.threadId === response.threadId &&
                item.turnId === response.turnId &&
                item.userInputRequestId === response.userInputRequestId
            )
          : [];
    if (
      (['completed', 'blocked', 'failed'].includes(task.status) &&
        task.latestGateContextItemId !== null) ||
      (task.latestGateContextItemId !== null &&
        (!response ||
          response.status !== 'completed' ||
          response.workspaceId !== task.workspaceId ||
          response.threadId !== task.threadId ||
          requestMatches.length !== 1))
    ) {
      throw new Error(`Goal Task has invalid Gate context: ${task.goalId}/${task.taskId}`);
    }
    taskRecordKeys.add(taskKey);
  }
  for (const goal of input.goals) {
    if (
      (goal.planItemId !== null &&
        !plansByKey.has(goalPlanRecordKey(goal.goalId, goal.planItemId))) ||
      (goal.currentTaskId !== null &&
        !taskRecordKeys.has(goalTaskRecordKey(goal.goalId, goal.currentTaskId)))
    ) {
      throw new Error(`Goal has incomplete Plan or Task authority: ${goal.goalId}`);
    }
    const activePlan =
      goal.planItemId === null
        ? undefined
        : plansByKey.get(goalPlanRecordKey(goal.goalId, goal.planItemId));
    const goalTasks = input.tasks.filter((task) => task.goalId === goal.goalId);
    const hasNoApprovedTasks = goalTasks.length === 0;
    const hasCompleteApprovedTasks =
      activePlan !== undefined && goalTasks.length === activePlan.tasks.length;
    const hasNoActivePlanOrTasks = goal.planItemId === null && hasNoApprovedTasks;
    const lifecycleIsCoherent =
      goal.status === 'planning'
        ? hasNoActivePlanOrTasks
        : goal.status === 'awaiting_plan_approval'
          ? activePlan !== undefined && hasNoApprovedTasks
          : goal.status === 'awaiting_user'
            ? hasNoActivePlanOrTasks || hasCompleteApprovedTasks
            : goal.status === 'failed'
              ? hasNoActivePlanOrTasks || hasCompleteApprovedTasks
              : hasCompleteApprovedTasks;
    if (!lifecycleIsCoherent) {
      throw new Error(`Goal lifecycle has incoherent Task authority: ${goal.goalId}`);
    }
  }
  return taskRecordKeys;
}

/**
 * Selects the exact immutable Task facts shared by a Goal Plan and Goal Task row.
 *
 * @param task Task payload or persisted Task row carrying extra lineage.
 * @returns Strict Goal Plan Task payload.
 */
function selectGoalPlanTaskPayload(task: GoalPlanTask): GoalPlanTask {
  return GoalPlanTaskSchema.parse({
    taskId: task.taskId,
    title: task.title,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    contextBudgetTokens: task.contextBudgetTokens,
    resources: task.resources,
    expectedArtifacts: task.expectedArtifacts,
    verificationChecks: task.verificationChecks,
    reviewPolicy: task.reviewPolicy,
    dependsOnTaskIds: task.dependsOnTaskIds,
    escalationConditions: task.escalationConditions,
  });
}

/**
 * Builds the source identity key for one immutable Goal Plan.
 *
 * @param goalId Source Goal id.
 * @param planItemId Source Plan Item id.
 * @returns Composite Goal Plan identity key.
 */
function goalPlanRecordKey(goalId: string, planItemId: string): string {
  return `${goalId}\u0000${planItemId}`;
}

/**
 * Builds the source identity key for one approved Goal Task row.
 *
 * @param goalId Source Goal id.
 * @param taskId Source Task id.
 * @returns Composite approved Goal Task identity key.
 */
function goalTaskRecordKey(goalId: string, taskId: string): string {
  return `${goalId}\u0000${taskId}`;
}

/**
 * Requires an execution-time Task reference to name an approved durable Task row.
 *
 * @param goalId Source Goal id carried by the referencing record.
 * @param taskId Optional source Task id carried by the referencing record.
 * @param taskRecordKeys Approved source Goal-and-Task identities.
 * @param label Referencing record family used in failure messages.
 * @throws Error when a Task reference is missing its approved Task row.
 */
function assertApprovedGoalTaskReference(
  goalId: string | null,
  taskId: string | null,
  taskRecordKeys: ReadonlySet<string>,
  label: string
): void {
  if (
    taskId !== null &&
    (goalId === null || !taskRecordKeys.has(goalTaskRecordKey(goalId, taskId)))
  ) {
    throw new Error(`${label} references a Goal Task without an approved Task row: ${taskId}`);
  }
}

/**
 * Rewrites one imported Goal record and its canonical references.
 *
 * @param record Exported Goal record.
 * @param workspaceId Imported workspace id.
 * @param threadIds Imported thread ids keyed by source id.
 * @param itemIds Imported item ids keyed by source id.
 * @param goalIds Imported Goal ids keyed by source id.
 * @param taskIds Imported Goal task ids keyed by source id.
 * @returns Goal record with deterministic imported lineage.
 */
function rewriteImportedGoalRecord(
  record: ExportedGoalRecord,
  workspaceId: string,
  threadIds: ReadonlyMap<string, string>,
  itemIds: ReadonlyMap<string, string>,
  goalIds: ReadonlyMap<string, string>,
  taskIds: ReadonlyMap<string, string>
): ExportedGoalRecord {
  return ExportedGoalRecordSchema.parse({
    ...record,
    goalId: requiredMapValue(goalIds, record.goalId, 'goal'),
    workspaceId,
    threadId: requiredMapValue(threadIds, record.threadId, 'thread'),
    createdByItemId: record.createdByItemId
      ? requiredMapValue(itemIds, record.createdByItemId, 'item')
      : null,
    planItemId: record.planItemId ? requiredMapValue(itemIds, record.planItemId, 'item') : null,
    currentTaskId: record.currentTaskId
      ? requiredMapValue(taskIds, record.currentTaskId, 'goal task')
      : null,
  });
}

/**
 * Rewrites one immutable Goal Plan and recomputes its digest after complete reminting.
 *
 * @param record Exported immutable Goal Plan.
 * @param workspaceId Imported Workspace id.
 * @param threadIds Imported Thread ids keyed by source id.
 * @param itemIds Imported Item ids keyed by source id.
 * @param artifactIds Imported Artifact ids keyed by source id.
 * @param goalIds Imported Goal ids keyed by source id.
 * @param taskIds Imported Goal Task ids keyed by source id.
 * @returns Immutable Goal Plan with reminted lineage and digest.
 */
function rewriteImportedGoalPlanRecord(
  record: ExportedGoalPlanRecord,
  workspaceId: string,
  threadIds: ReadonlyMap<string, string>,
  itemIds: ReadonlyMap<string, string>,
  artifactIds: ReadonlyMap<string, string>,
  goalIds: ReadonlyMap<string, string>,
  taskIds: ReadonlyMap<string, string>
): ExportedGoalPlanRecord {
  const plan = GoalPlanOutputSchema.parse({
    ...selectGoalPlanPayload(record),
    tasks: record.tasks.map((task) =>
      rewriteGoalPlanTaskPayload(task, itemIds, artifactIds, taskIds)
    ),
  });
  assertValidGoalPlanGraph(plan.tasks);
  return ExportedGoalPlanRecordSchema.parse({
    ...record,
    ...plan,
    workspaceId,
    threadId: requiredMapValue(threadIds, record.threadId, 'thread'),
    goalId: requiredMapValue(goalIds, record.goalId, 'goal'),
    planItemId: requiredMapValue(itemIds, record.planItemId, 'item'),
    planDigest: computeGoalPlanDigest(plan),
  });
}

/**
 * Rewrites one imported Goal task and its Goal dependency references.
 *
 * @param record Exported Goal task.
 * @param workspaceId Imported workspace id.
 * @param threadIds Imported thread ids keyed by source id.
 * @param itemIds Imported Item ids keyed by source id.
 * @param artifactIds Imported Artifact ids keyed by source id.
 * @param goalIds Imported Goal ids keyed by source id.
 * @param taskIds Imported Goal task ids keyed by source id.
 * @returns Goal task with deterministic imported lineage.
 */
function rewriteImportedGoalTask(
  record: ExportedGoalTask,
  workspaceId: string,
  threadIds: ReadonlyMap<string, string>,
  itemIds: ReadonlyMap<string, string>,
  artifactIds: ReadonlyMap<string, string>,
  goalIds: ReadonlyMap<string, string>,
  taskIds: ReadonlyMap<string, string>
): ExportedGoalTask {
  return ExportedGoalTaskSchema.parse({
    ...record,
    ...rewriteGoalPlanTaskPayload(record, itemIds, artifactIds, taskIds),
    workspaceId,
    threadId: requiredMapValue(threadIds, record.threadId, 'thread'),
    goalId: requiredMapValue(goalIds, record.goalId, 'goal'),
    planItemId: requiredMapValue(itemIds, record.planItemId, 'item'),
    latestGateContextItemId: record.latestGateContextItemId
      ? requiredMapValue(itemIds, record.latestGateContextItemId, 'item')
      : null,
  });
}

/**
 * Rewrites one exact Goal Plan Task payload without adding lifecycle state.
 *
 * @param task Source Goal Plan Task facts.
 * @param itemIds Imported Item ids keyed by source id.
 * @param artifactIds Imported Artifact ids keyed by source id.
 * @param taskIds Imported Goal Task ids keyed by source id.
 * @returns Strict Goal Plan Task payload with reminted references.
 */
function rewriteGoalPlanTaskPayload(
  task: GoalPlanTask,
  itemIds: ReadonlyMap<string, string>,
  artifactIds: ReadonlyMap<string, string>,
  taskIds: ReadonlyMap<string, string>
): GoalPlanTask {
  return GoalPlanTaskSchema.parse({
    ...selectGoalPlanTaskPayload(task),
    taskId: requiredMapValue(taskIds, task.taskId, 'goal task'),
    resources: task.resources.map((resource) => {
      if (resource.kind === 'item') {
        return {
          ...resource,
          reference: requiredMapValue(itemIds, resource.reference, 'item'),
        };
      }
      if (resource.kind === 'artifact') {
        return {
          ...resource,
          reference: requiredMapValue(artifactIds, resource.reference, 'artifact'),
        };
      }
      return resource;
    }),
    dependsOnTaskIds: task.dependsOnTaskIds.map((taskId) =>
      requiredMapValue(taskIds, taskId, 'goal task')
    ),
  });
}

/**
 * Rewrites every identity-bearing event payload to imported canonical records.
 *
 * @param event Exported event envelope.
 * @param records Imported canonical records keyed by source ids.
 * @returns Event envelope with rewritten direct and nested lineage.
 * @throws Error when the event references state outside the export.
 */
function rewritePortableTurnEvent(
  event: SseEventEnvelope,
  records: {
    workspace: WorkspaceRecord;
    threads: ReadonlyMap<string, Thread>;
    turns: ReadonlyMap<string, Turn>;
    items: ReadonlyMap<string, Item>;
    artifacts: ReadonlyMap<string, Artifact>;
    agentSessions: ReadonlyMap<string, AgentSession>;
    approvalRequestIds: ReadonlyMap<string, string>;
  }
): SseEventEnvelope {
  const threadId = event.threadId
    ? requiredMapValue(records.threads, event.threadId, 'thread').id
    : undefined;
  const turn = event.turnId ? records.turns.get(event.turnId) : undefined;
  if (event.turnId && !turn) {
    throw new Error(`Turn event references missing exported turn: ${event.turnId}`);
  }
  const data = event.data;
  let rewrittenData: unknown;

  switch (data.type) {
    case 'workspace-updated':
      rewrittenData = { ...data, workspace: records.workspace };
      break;
    case 'thread-created':
    case 'thread-updated':
      rewrittenData = {
        ...data,
        thread: requiredMapValue(records.threads, data.thread.id, 'thread'),
      };
      break;
    case 'turn-started':
      rewrittenData = {
        ...data,
        turnId: requiredMapValue(records.turns, data.turnId, 'turn').id,
      };
      break;
    case 'turn-updated':
    case 'turn-completed':
      rewrittenData = {
        ...data,
        turn: requiredMapValue(records.turns, data.turn.id, 'turn'),
      };
      break;
    case 'item-created':
      rewrittenData = {
        ...data,
        item: requiredMapValue(records.items, data.item.id, 'item'),
      };
      break;
    case 'item-completed': {
      const item = requiredMapValue(records.items, data.item.id, 'item');
      rewrittenData = { ...data, itemId: item.id, item };
      break;
    }
    case 'item-delta': {
      const item = requiredMapValue(records.items, data.itemId, 'item');
      if (data.deltaKind === 'artifact-updated') {
        const artifact = requiredMapValue(records.artifacts, data.artifactId, 'artifact');
        if (
          item.type !== 'artifact-reference' ||
          item.artifactId !== artifact.id ||
          item.artifactVersion !== artifact.version
        ) {
          throw new Error('Artifact update delta has contradictory artifact-reference lineage.');
        }
        rewrittenData = { ...data, itemId: item.id, artifactId: artifact.id };
      } else {
        rewrittenData = { ...data, itemId: item.id };
      }
      break;
    }
    case 'approval-requested':
    case 'approval-resolved':
      rewrittenData = {
        ...data,
        approval: {
          ...data.approval,
          id: requiredMapValue(records.approvalRequestIds, data.approval.id, 'approval request'),
          workspaceId: records.workspace.id,
          threadId: requiredMapValue(records.threads, data.approval.threadId, 'thread').id,
          turnId: requiredMapValue(records.turns, data.approval.turnId, 'turn').id,
        },
      };
      break;
    case 'agent-session-updated':
      rewrittenData = {
        ...data,
        agentSession: requiredMapValue(
          records.agentSessions,
          data.agentSession.id,
          'agent session'
        ),
      };
      break;
    case 'artifact-created':
    case 'artifact-updated':
      rewrittenData = {
        ...data,
        artifact: requiredMapValue(records.artifacts, data.artifact.id, 'artifact'),
      };
      break;
    case 'error':
      rewrittenData = data;
      break;
  }

  return SseEventEnvelopeSchema.parse({
    ...event,
    workspaceId: records.workspace.id,
    ...(threadId ? { threadId } : {}),
    ...(turn ? { turnId: turn.id } : {}),
    data: rewrittenData,
  });
}

/**
 * Returns one required imported value keyed by its source id.
 *
 * @param records Imported values keyed by source id.
 * @param sourceId Source id to resolve.
 * @param label Record-family label used in diagnostics.
 * @returns Imported value.
 * @throws Error when the source id was not exported.
 */
function requiredMapValue<T>(records: ReadonlyMap<string, T>, sourceId: string, label: string): T {
  const record = records.get(sourceId);
  if (record === undefined) {
    throw new Error(`${label} references missing exported state: ${sourceId}`);
  }
  return record;
}

/**
 * Rewrites portable evidence references through imported canonical lineage.
 *
 * @param refs Evidence references from an export.
 * @param context Imported canonical lineage maps.
 * @returns Evidence refs with direct workspace refs rewritten.
 */
function rewriteEvidenceRefs(
  refs: EvidenceBundleRecord['redactedEvidenceRefs'],
  context: ImportRemintContext
): EvidenceBundleRecord['redactedEvidenceRefs'] {
  return refs.map((ref) => {
    let rewritten = ref.ref;
    switch (ref.kind) {
      case 'workspace':
        if (ref.ref !== context.report.exportedWorkspaceId) {
          throw new Error(`Evidence ref references missing exported workspace: ${ref.ref}`);
        }
        rewritten = context.targetWorkspaceId;
        break;
      case 'thread':
        rewritten = requiredMapValue(context.threadIds, ref.ref, 'thread');
        break;
      case 'turn':
      case 'worker':
        rewritten = requiredMapValue(context.turnIds, ref.ref, 'turn');
        break;
      case 'goal':
        rewritten = requiredMapValue(context.goalIds, ref.ref, 'goal');
        break;
      case 'artifact':
        rewritten = requiredMapValue(context.artifactIds, ref.ref, 'artifact');
        break;
      case 'item':
        rewritten = requiredMapValue(context.itemIds, ref.ref, 'item');
        break;
      case 'agent-session':
        rewritten = requiredMapValue(context.agentSessionIds, ref.ref, 'agent session');
        break;
    }
    return rewritten === ref.ref ? ref : { ...ref, ref: rewritten };
  });
}

/**
 * Rewrites direct workspace URI references when an import remints the workspace id.
 *
 * @param value Reference string from an exported record.
 * @param sourceWorkspaceId Workspace id recorded in the export.
 * @param targetWorkspaceId Workspace id used for imported records.
 * @returns Reference with a rewritten workspace URI prefix when applicable.
 */
function rewriteWorkspaceReference(
  value: string,
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): string {
  const sourcePrefix = `workspace://${sourceWorkspaceId}/`;

  return value.startsWith(sourcePrefix)
    ? `workspace://${targetWorkspaceId}/${value.slice(sourcePrefix.length)}`
    : value;
}

/**
 * Rewrites stable ids embedded in a redacted JSON snapshot without changing its structure.
 *
 * @param value Snapshot value to rewrite.
 * @param replacements Source and imported id pairs.
 * @returns Snapshot value with every embedded source id replaced.
 */
function rewriteJsonStringReferences(
  value: unknown,
  replacements: readonly (readonly [string, string])[]
): unknown {
  if (typeof value === 'string') {
    return replacements.reduce(
      (rewritten, [source, target]) => rewritten.replaceAll(source, target),
      value
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonStringReferences(entry, replacements));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteJsonStringReferences(entry, replacements),
      ])
    );
  }
  return value;
}

/**
 * Rewrites a top-level `workspaceId` field in redacted summary objects.
 *
 * @param value Summary value from an exported record.
 * @param sourceWorkspaceId Workspace id recorded in the export.
 * @param targetWorkspaceId Workspace id used for imported records.
 * @returns Summary with a rewritten workspace id field when applicable.
 */
function rewriteWorkspaceIdField(
  value: unknown,
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return record.workspaceId === sourceWorkspaceId
    ? { ...record, workspaceId: targetWorkspaceId }
    : value;
}

/** Rejects absolute, linked-platform, and traversal-bearing portable paths. */
function assertPortableWorkspaceFilePath(path: string): void {
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Portable workspace file path is invalid: ${path}`);
  }
}

/**
 * Returns one exact file captured by export verification.
 *
 * @param files Verified export contents keyed by inventory path.
 * @param exportPath Required export-relative path.
 * @returns Verified file text.
 * @throws Error when the required path was not inventoried.
 */
function requiredExportFile(files: ReadonlyMap<string, string>, exportPath: string): string {
  const text = files.get(exportPath);
  if (text === undefined) {
    throw new Error(`Required export file is missing from inventory: ${exportPath}`);
  }
  return text;
}

/**
 * Reads one import JSON record and rejects unsupported record-level features before schema parsing.
 *
 * @param files Verified export contents keyed by inventory path.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON value.
 * @throws Error when the record declares required features this importer does not support.
 */
function readImportJson(files: ReadonlyMap<string, string>, exportPath: string): unknown {
  const record = JSON.parse(requiredExportFile(files, exportPath)) as unknown;
  rejectUnsupportedRecordFeatures(record, exportPath);

  return record;
}

/**
 * Reads one import JSONL file and rejects unsupported record-level features before schema parsing.
 *
 * @param files Verified export contents keyed by inventory path.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON values.
 * @throws Error when any record declares required features this importer does not support.
 */
function readImportJsonl(files: ReadonlyMap<string, string>, exportPath: string): unknown[] {
  const text = requiredExportFile(files, exportPath).trim();
  const records = text ? text.split('\n').map((line) => JSON.parse(line) as unknown) : [];
  return records.map((record, index) => {
    rejectUnsupportedRecordFeatures(record, `${exportPath}:${index + 1}`);

    return record;
  });
}

/**
 * Reads one optional import JSONL file with record-level required-feature enforcement.
 *
 * @param files Verified export contents keyed by inventory path.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON values, or an empty array when the file is absent.
 * @throws Error when any present record declares required features this importer does not support.
 */
function readOptionalImportJsonl(
  files: ReadonlyMap<string, string>,
  exportPath: string
): unknown[] {
  return files.has(exportPath) ? readImportJsonl(files, exportPath) : [];
}

/**
 * Rejects imported records that require semantics this importer has not explicitly implemented.
 *
 * @param record Imported raw JSON record.
 * @param exportPath Export-relative path used in diagnostics.
 * @throws Error when `requiredFeatures` is malformed or unsupported.
 */
function rejectUnsupportedRecordFeatures(record: unknown, exportPath: string): void {
  if (typeof record !== 'object' || record === null || !('requiredFeatures' in record)) {
    return;
  }

  const requiredFeatures = (record as { requiredFeatures?: unknown }).requiredFeatures;
  if (
    requiredFeatures === undefined ||
    (Array.isArray(requiredFeatures) && requiredFeatures.length === 0)
  ) {
    return;
  }
  if (
    !Array.isArray(requiredFeatures) ||
    !requiredFeatures.every(
      (feature): feature is string => typeof feature === 'string' && feature.length > 0
    )
  ) {
    throw new Error(`Invalid requiredFeatures in ${exportPath}.`);
  }

  const supportedRecordFeatures = new Set([
    'evidence.bundle.v1',
    'runtime.evidence.v1',
    'worker.runtime-provenance.v1',
  ]);
  const unsupported = requiredFeatures.filter((feature) => !supportedRecordFeatures.has(feature));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported requiredFeatures in ${exportPath}: ${unsupported.join(', ')}`);
  }
}

/** Computes a SHA-256 content digest for one text payload. */
function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
