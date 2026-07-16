import { createHash } from 'node:crypto';
import {
  BackendWorkspaceHandleSchema,
  EvidenceBundleRecordSchema,
  GitPushRecordSchema,
  KnowledgeClaimSchema,
  KnowledgeConflictSchema,
  KnowledgeManagerContextPackageTraceRecordSchema,
  KnowledgeManagerContextPackageTraceSchema,
  KnowledgeManagerContextPolicySchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeObservationSchema,
  KnowledgeRetrievalResponseSchema,
  RuntimeEvidenceRecordSchema,
  StagedWorkspaceReviewSchema,
  WorkerContextPackageManifestSchema,
  WorkerOutputManifestSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceApplyResultSchema,
  WorkspaceChangeSetSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
  WorkspaceQuarantineRecordSchema,
  WorkspaceReconciliationRecordSchema,
  WorkspaceRepositoryGitConfigSchema,
  WorkspaceSyncReviewPatchPayloadSchema,
} from '@openkit/app-api-schemas';
import {
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
import { parseOkfDocument } from '../knowledge/okf.js';
import { createKnowledgeContextPackageDigest } from '../knowledge-manager.js';
import type {
  AgentSession,
  ArtifactReviewRecord,
  KnowledgeProposalRecord,
  KnowledgeProposalReviewRecord,
  KnowledgeSourceRecord,
} from '../lib/store.js';
import type { AgentEnvironmentPackageSnapshotRecord } from '../runtime/aep-snapshot-ledger.js';
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
  ArtifactReviewRecordSchema,
  artifactContentFileName,
  assertSafeWorkspacePathSegment,
  KnowledgeProposalRecordSchema,
  KnowledgeProposalReviewRecordSchema,
  KnowledgeSourceRecordSchema,
  parseCanonicalWorkspaceHistory,
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

const ImportedEvidenceBundleRecordSchema = EvidenceBundleRecordSchema.strict();
const ImportedRuntimeEvidenceRecordSchema = RuntimeEvidenceRecordSchema.strict();
const ImportedUsageRecordSchema = UsageRecordSchema.strict();
const ImportedKnowledgeObservationSchema = KnowledgeObservationSchema.strict();
const ImportedKnowledgeClaimSchema = KnowledgeClaimSchema.strict();
const ImportedKnowledgeConflictSchema = KnowledgeConflictSchema.strict();
const ImportedKnowledgeContextPackageTraceSchema =
  KnowledgeManagerContextPackageTraceRecordSchema.strict();
const ImportedKnowledgeRetrievalTraceSchema = KnowledgeRetrievalResponseSchema.strict();
const ImportedContextMaterializationPolicySchema = z
  .object({
    claims: z.array(ImportedKnowledgeClaimSchema),
    conflicts: z.array(ImportedKnowledgeConflictSchema),
    packageTrace: KnowledgeManagerContextPackageTraceSchema,
    policy: KnowledgeManagerContextPolicySchema,
    materializationDecisions: z.array(
      z
        .object({
          action: z.literal('skipped'),
          reason: z.literal('source_unavailable'),
          sourceReference: z.string().min(1),
        })
        .strict()
    ),
    sensitivityDecisions: z.array(
      z
        .object({
          action: z.literal('redacted'),
          path: z.string().min(1),
          reason: z.literal('sensitive_content'),
        })
        .strict()
    ),
  })
  .strict();

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

const ExportedPendingUserTurnSchema = z
  .object({
    pendingTurnId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    contentItemId: z.string().min(1).nullable(),
    contentDigest: z.string().min(1).nullable(),
    queueMode: z.enum(['safe_point_steering', 'follow_up', 'blocked_gate']),
    receivedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

type ExportedPendingUserTurn = z.infer<typeof ExportedPendingUserTurnSchema>;

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
    stage: z.enum([
      'preparing',
      'running_worker',
      'waiting_for_user',
      'reviewing',
      'verifying',
      'saving',
      'recovering',
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
      'reviewing',
      'verifying',
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

const ExportedGoalVerificationCheckSchema = z
  .object({
    kind: z.enum(['command', 'test', 'manual']),
    description: z.string().min(1).max(1_000),
    command: z.string().min(1).max(1_000).optional(),
  })
  .strict();

const ExportedGoalTaskSchema = z
  .object({
    taskId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    goalId: z.string().min(1),
    status: z.enum([
      'pending',
      'ready',
      'running',
      'reviewing',
      'needs_revision',
      'completed',
      'blocked',
      'failed',
      'skipped',
    ]),
    title: z.string().min(1),
    objective: z.string().min(1),
    orderIndex: z.number().int(),
    dependsOnTaskIds: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(z.string().min(1)),
    contextBudgetTokens: z.number().int().positive(),
    verificationChecks: z.array(ExportedGoalVerificationCheckSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedGoalTask = z.infer<typeof ExportedGoalTaskSchema>;

const ExportedGoalReviewResolutionSnapshotSchema = z
  .object({
    outcome: z.enum([
      'complete_next_task',
      'complete_goal',
      'continue',
      'retry',
      'needs_revision',
      'decompose',
      'awaiting_human',
      'blocked',
      'aborted',
    ]),
    task: ExportedGoalTaskSchema,
    goal: ExportedGoalRecordSchema.nullable(),
    nextTask: ExportedGoalTaskSchema.nullable(),
  })
  .strict();

const ExportedGoalReviewRecordSchema = z
  .object({
    reviewId: z.string().min(1),
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    goalId: z.string().min(1),
    taskId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    itemIds: z.array(z.string().min(1)),
    artifactIds: z.array(z.string().min(1)),
    verificationEvidence: z.array(z.unknown()),
    verdict: z.enum(['accept', 'refine', 'retry', 'decompose', 'ask_user', 'block', 'abort']),
    reason: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    resolutionRequestId: z.string().min(1).nullable(),
    resolutionSnapshot: ExportedGoalReviewResolutionSnapshotSchema.nullable(),
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
  /** Imported artifact review decisions. */
  artifactReviews: ArtifactReviewRecord[];
  /** Imported durable agent sessions. */
  agentSessions: AgentSession[];
  /** Imported retained turn event logs keyed by reminted turn id. */
  turnEvents: Array<[string, SseEventEnvelope[]]>;
  /** Imported knowledge proposal records. */
  knowledgeProposals: KnowledgeProposalRecord[];
  /** Imported knowledge proposal review records. */
  knowledgeProposalReviews: KnowledgeProposalReviewRecord[];
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
  /** Imported pending user turn rows. */
  pendingUserTurns: ExportedPendingUserTurn[];
  /** Imported worker checkpoint rows. */
  workerCheckpoints: ExportedWorkerCheckpoint[];
  /** Imported Goal Mode goal rows. */
  goalRecords: ExportedGoalRecord[];
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
  /** Imported thread ids keyed by source id. */
  threadIds: Map<string, string>;
  /** Imported turn ids keyed by source id. */
  turnIds: Map<string, string>;
  /** Imported item ids keyed by source id. */
  itemIds: Map<string, string>;
  /** Imported artifact ids keyed by source id. */
  artifactIds: Map<string, string>;
  /** Imported agent-session ids keyed by source id. */
  agentSessionIds: Map<string, string>;
  /** Imported approval-request ids keyed by source id. */
  approvalRequestIds: Map<string, string>;
  /** Imported AEP snapshot ids keyed by source id. */
  agentEnvironmentPackageSnapshotIds: Map<string, string>;
  /** Imported knowledge-source ids keyed by source id. */
  knowledgeSourceIds: Map<string, string>;
  /** Imported Goal ids keyed by source id. */
  goalIds: Map<string, string>;
  /** Imported Goal task ids keyed by source id. */
  goalTaskIds: Map<string, string>;
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
  const removedPath = 'records/workspace-sync-evidence-bundles.jsonl';
  if (input.verified.fileContents.has(removedPath)) {
    throw new Error(`Unsupported workspace export record path: ${removedPath}`);
  }
  const report = dryRunWorkspaceImport({
    verified: input.verified,
    workspaceExists: () => false,
  });
  const context: ImportRemintContext = {
    files: input.verified.fileContents,
    manifestDigest: input.verified.manifestDigest,
    report,
    targetWorkspaceId: input.targetWorkspaceId,
    threadIds: new Map(),
    turnIds: new Map(),
    itemIds: new Map(),
    artifactIds: new Map(),
    agentSessionIds: new Map(),
    approvalRequestIds: new Map(),
    agentEnvironmentPackageSnapshotIds: new Map(),
    knowledgeSourceIds: new Map(),
    goalIds: new Map(),
    goalTaskIds: new Map(),
    goalReviewIds: new Map(),
    goalVerificationIds: new Map(),
    vaultGrantIds: new Map(),
    evidenceBundleIds: new Map(),
    knowledgeIds: new Set(),
  };
  const canonical = readCanonicalImportState(context);
  const goalRuntime = readGoalRuntimeControlState(context);
  const securityRuntime = readSecurityRuntimeLedgerState(context);
  const workspaceSync = readWorkspaceSyncImportState(context);
  const portableFileState = readPortableImportState(context, canonical.knowledgeProposals);

  return {
    report,
    workspace: canonical.workspace,
    threads: canonical.threads,
    turns: canonical.turns,
    knowledge: canonical.knowledge,
    itemRevisions: canonical.itemRevisions,
    artifacts: canonical.artifacts,
    artifactReviews: canonical.artifactReviews,
    agentSessions: canonical.agentSessions,
    turnEvents: canonical.turnEvents,
    knowledgeProposals: canonical.knowledgeProposals,
    knowledgeProposalReviews: canonical.knowledgeProposalReviews,
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
    agentEnvironmentPackageSnapshots: canonical.agentEnvironmentPackageSnapshots,
    workspaceRepositories: workspaceSync.workspaceRepositories,
    workspaceInputSnapshots: workspaceSync.workspaceInputSnapshots,
    workspaceMaterializationRecords: workspaceSync.workspaceMaterializationRecords,
    backendWorkspaceHandles: workspaceSync.backendWorkspaceHandles,
    workerOutputManifests: workspaceSync.workerOutputManifests,
    workspaceChangeSets: workspaceSync.workspaceChangeSets,
    stagedWorkspaceReviews: workspaceSync.stagedWorkspaceReviews,
    workspaceApplyPlans: workspaceSync.workspaceApplyPlans,
    workspaceApplyResults: workspaceSync.workspaceApplyResults,
    workspaceReconciliationRecords: workspaceSync.workspaceReconciliationRecords,
    workspaceQuarantineRecords: workspaceSync.workspaceQuarantineRecords,
    permissionDecisions: securityRuntime.permissionDecisions,
    pendingUserTurns: goalRuntime.pendingUserTurns,
    workerCheckpoints: goalRuntime.workerCheckpoints,
    goalRecords: goalRuntime.goalRecords,
    goalTasks: goalRuntime.goalTasks,
    goalReviewRecords: goalRuntime.goalReviewRecords,
    goalVerificationRecords: goalRuntime.goalVerificationRecords,
    mcpToolSchemaSnapshots: goalRuntime.mcpToolSchemaSnapshots,
    portableFileState,
  };
}

/**
 * Reconstructs the canonical workspace graph, AEP snapshots, events, proposals, and sources.
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
  const knowledge = readImportJsonl(context.files, 'records/knowledge.jsonl').map((record) =>
    KnowledgeEntrySchema.parse(record)
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
  const itemIds = new Map<string, string>();
  const approvalRequestIds = new Map<string, string>();
  const userInputRequestIds = new Map<string, string>();
  for (const revision of exportedItemRevisions) {
    if (!itemIds.has(revision.id)) {
      itemIds.set(revision.id, `it_imported_${context.targetWorkspaceId}_${itemIds.size + 1}`);
    }
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
    if (item.type === 'artifact-reference') {
      rewritten.artifactId = requiredMapValue(artifactIds, item.artifactId, 'artifact');
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
    ArtifactSchema.parse({
      ...artifact,
      id: requiredMapValue(artifactIds, artifact.id, 'artifact'),
      threadId: artifact.threadId ? requiredMapValue(threadIds, artifact.threadId, 'thread') : null,
      turnId: artifact.turnId ? requiredMapValue(turnIds, artifact.turnId, 'turn') : null,
      workspaceId: context.targetWorkspaceId,
    })
  );
  const exportedArtifactReviews = readImportJsonl(
    context.files,
    'records/artifact-reviews.jsonl'
  ).map((record) => ArtifactReviewRecordSchema.parse(record));
  const followUpTurnIds = new Map(turnIds);
  for (const review of exportedArtifactReviews) {
    if (
      review.followUpTurnId &&
      !followUpTurnIds.has(review.followUpTurnId) &&
      review.lifecycle === 'pending'
    ) {
      followUpTurnIds.set(
        review.followUpTurnId,
        `tu_imported_${context.targetWorkspaceId}_pending_${followUpTurnIds.size - turnIds.size + 1}`
      );
    }
  }
  const artifactReviews = exportedArtifactReviews.map((review) =>
    ArtifactReviewRecordSchema.parse({
      ...review,
      artifactId: requiredMapValue(artifactIds, review.artifactId, 'artifact'),
      threadId: review.threadId ? requiredMapValue(threadIds, review.threadId, 'thread') : null,
      turnId: review.turnId ? requiredMapValue(turnIds, review.turnId, 'turn') : null,
      followUpTurnId: review.followUpTurnId
        ? requiredMapValue(followUpTurnIds, review.followUpTurnId, 'follow-up turn')
        : null,
      workspaceId: context.targetWorkspaceId,
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
  const exportedKnowledgeProposals = readOptionalImportJsonl(
    context.files,
    'records/knowledge-proposals.jsonl'
  ).map((record) => KnowledgeProposalRecordSchema.parse(record));
  const knowledgeProposals = exportedKnowledgeProposals.map((proposal, index) =>
    KnowledgeProposalRecordSchema.parse({
      ...proposal,
      id: `kp_imported_${context.targetWorkspaceId}_${index + 1}`,
      workspaceId: context.targetWorkspaceId,
    })
  );
  const knowledgeProposalIds = new Map(
    exportedKnowledgeProposals.map((proposal, index) => [
      proposal.id,
      knowledgeProposals[index]!.id,
    ])
  );
  const exportedKnowledgeProposalReviews = readOptionalImportJsonl(
    context.files,
    'records/knowledge-proposal-reviews.jsonl'
  ).map((record) => KnowledgeProposalReviewRecordSchema.parse(record));
  const knowledgeProposalReviews = exportedKnowledgeProposalReviews.map((parsed) =>
    KnowledgeProposalReviewRecordSchema.parse({
      ...parsed,
      proposalId: requiredMapValue(knowledgeProposalIds, parsed.proposalId, 'knowledge proposal'),
      workspaceId: context.targetWorkspaceId,
    })
  );
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
  parseCanonicalWorkspaceHistory({
    workspace: exportedWorkspace,
    threads: exportedThreads,
    turns: exportedTurns,
    itemRevisions: exportedItemRevisions,
    artifacts: exportedArtifacts,
    artifactReviews: exportedArtifactReviews,
    knowledgeProposals: exportedKnowledgeProposals,
    knowledgeProposalReviews: exportedKnowledgeProposalReviews,
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
    artifactReviews,
    knowledgeProposals,
    knowledgeProposalReviews,
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
    artifactReviews,
    agentSessions,
    turnEvents,
    knowledgeProposals,
    knowledgeProposalReviews,
    knowledgeSources,
    knowledgeSourceMaterials,
    agentEnvironmentPackageSnapshots,
  };
}

/**
 * Reconstructs Goal Mode and worker-control records after canonical ids are known.
 *
 * @param context Shared import lineage and verified bytes.
 * @returns Imported Goal Mode and worker-control records.
 * @throws Error when a control record references missing exported state.
 */
function readGoalRuntimeControlState(context: ImportRemintContext) {
  const { artifactIds, itemIds, threadIds, turnIds } = context;
  const exportedGoalRecords = readOptionalImportJsonl(
    context.files,
    'records/goal-records.jsonl'
  ).map((record) => ExportedGoalRecordSchema.parse(record));
  const goalIds = new Map(
    exportedGoalRecords.map((record, index) => [
      record.goalId,
      `goal_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  const exportedGoalTasks = readOptionalImportJsonl(context.files, 'records/goal-tasks.jsonl').map(
    (record) => ExportedGoalTaskSchema.parse(record)
  );
  const goalTaskIds = new Map(
    exportedGoalTasks.map((record, index) => [
      record.taskId,
      `task_imported_${context.targetWorkspaceId}_${index + 1}`,
    ])
  );
  context.goalIds = goalIds;
  context.goalTaskIds = goalTaskIds;
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
  const goalTasks = exportedGoalTasks.map((record) =>
    rewriteImportedGoalTask(record, context.targetWorkspaceId, threadIds, goalIds, goalTaskIds)
  );
  const pendingUserTurns = readOptionalImportJsonl(
    context.files,
    'records/pending-user-turns.jsonl'
  ).map((record) => {
    const parsed = ExportedPendingUserTurnSchema.parse(record);
    const threadId = requiredMapValue(threadIds, parsed.threadId, 'thread');

    return ExportedPendingUserTurnSchema.parse({
      ...parsed,
      pendingTurnId: `${context.targetWorkspaceId}:${threadId}:${parsed.requestId}`,
      workspaceId: context.targetWorkspaceId,
      threadId,
      contentItemId: parsed.contentItemId
        ? requiredMapValue(itemIds, parsed.contentItemId, 'item')
        : null,
    });
  });
  const workerCheckpoints = readOptionalImportJsonl(
    context.files,
    'records/worker-turn-checkpoints.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkerCheckpointSchema.parse(record);
    const threadId = requiredMapValue(threadIds, parsed.threadId, 'thread');
    const turnId = requiredMapValue(turnIds, parsed.turnId, 'turn');

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
  const exportedGoalReviewRecords = readOptionalImportJsonl(
    context.files,
    'records/goal-review-records.jsonl'
  ).map((record) => ExportedGoalReviewRecordSchema.parse(record));
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
      turnId: parsed.turnId ? requiredMapValue(turnIds, parsed.turnId, 'turn') : null,
      itemIds: parsed.itemIds.map((itemId) => requiredMapValue(itemIds, itemId, 'item')),
      artifactIds: parsed.artifactIds.map((artifactId) =>
        requiredMapValue(artifactIds, artifactId, 'artifact')
      ),
      resolutionSnapshot: resolutionSnapshot
        ? {
            ...resolutionSnapshot,
            task: rewriteImportedGoalTask(
              resolutionSnapshot.task,
              context.targetWorkspaceId,
              threadIds,
              goalIds,
              goalTaskIds
            ),
            goal: resolutionSnapshot.goal
              ? rewriteImportedGoalRecord(
                  resolutionSnapshot.goal,
                  context.targetWorkspaceId,
                  threadIds,
                  itemIds,
                  goalIds,
                  goalTaskIds
                )
              : null,
            nextTask: resolutionSnapshot.nextTask
              ? rewriteImportedGoalTask(
                  resolutionSnapshot.nextTask,
                  context.targetWorkspaceId,
                  threadIds,
                  goalIds,
                  goalTaskIds
                )
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
  const goalVerificationRecords = exportedGoalVerificationRecords.map((parsed) =>
    ExportedGoalVerificationRecordSchema.parse({
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
    })
  );
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
    pendingUserTurns,
    workerCheckpoints,
    goalRecords,
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
    artifactIds,
    evidenceBundleIds,
    goalIds,
    goalReviewIds,
    goalTaskIds,
    goalVerificationIds,
    itemIds,
    report,
    threadIds,
    turnIds,
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
      rawEvidenceRefs: rewriteEvidenceBundleRefs(
        parsed.rawEvidenceRefs,
        report.exportedWorkspaceId,
        context.targetWorkspaceId,
        threadIds,
        turnIds,
        goalIds,
        artifactIds,
        itemIds,
        agentSessionIds
      ),
      redactedEvidenceRefs: rewriteEvidenceBundleRefs(
        parsed.redactedEvidenceRefs,
        report.exportedWorkspaceId,
        context.targetWorkspaceId,
        threadIds,
        turnIds,
        goalIds,
        artifactIds,
        itemIds,
        agentSessionIds
      ),
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
 * Reconstructs authoritative workspace files after every referenced id map is known.
 *
 * @param context Shared import lineage and verified bytes.
 * @param knowledgeProposals Imported proposals whose claim references require validation.
 * @returns Imported portable file state.
 * @throws Error when a portable record references missing exported state.
 */
function readPortableImportState(
  context: ImportRemintContext,
  knowledgeProposals: readonly KnowledgeProposalRecord[]
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
    approvalRequestIds,
    vaultGrantIds,
    goalIds,
    goalTaskIds,
    knowledgeIds: context.knowledgeIds,
  });
  const portableClaimIds = new Set(
    [...portableFileState.claims.values()].flat().map((claim) => claim.id)
  );
  for (const proposal of knowledgeProposals) {
    if (proposal.sourceClaimId && !portableClaimIds.has(proposal.sourceClaimId)) {
      throw new Error(
        `Knowledge proposal references missing portable claim: ${proposal.sourceClaimId}`
      );
    }
  }

  return portableFileState;
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
    readonly approvalRequestIds: ReadonlyMap<string, string>;
    readonly vaultGrantIds: ReadonlyMap<string, string>;
    readonly goalIds: ReadonlyMap<string, string>;
    readonly goalTaskIds: ReadonlyMap<string, string>;
    readonly knowledgeIds: ReadonlySet<string>;
  }
): WorkspacePortableFileState {
  const replacementMap = new Map<string, string>([
    [context.sourceWorkspaceId, context.targetWorkspaceId],
  ]);
  for (const idMap of [
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
  const claimIds = new Set(claims.map((claim) => claim.id));
  const conflictIds = new Set(conflicts.map((conflict) => conflict.id));
  const sourceContextPackageTraces = new Map<
    string,
    z.infer<typeof ImportedKnowledgeContextPackageTraceSchema>
  >();
  const contextPackageTraces = readImportJsonl(
    files,
    'records/knowledge-context-package-traces.jsonl'
  ).map((record) => {
    const parsed = ImportedKnowledgeContextPackageTraceSchema.parse(record);
    assertPortableWorkspaceOwner(
      parsed.workspaceId,
      context.sourceWorkspaceId,
      'context package trace'
    );
    if (
      parsed.operationId !== parsed.response.operationId ||
      parsed.id !== parsed.response.packageTrace.contextPackageId ||
      parsed.response.workspaceId !== context.sourceWorkspaceId
    ) {
      throw new Error(`Context package trace has invalid lineage: ${parsed.id}`);
    }
    if (
      parsed.response.packageTrace.contextPackageDigest !==
      createKnowledgeContextPackageDigest(parsed.response)
    ) {
      throw new Error(`Context package trace digest mismatch: ${parsed.id}`);
    }
    sourceContextPackageTraces.set(parsed.id, parsed);
    for (const claimId of parsed.response.packageTrace.selectedClaimIds) {
      if (!claimIds.has(claimId)) {
        throw new Error(`Context package trace references missing claim: ${claimId}`);
      }
    }
    for (const conflictId of parsed.response.packageTrace.selectedConflictIds) {
      if (!conflictIds.has(conflictId)) {
        throw new Error(`Context package trace references missing conflict: ${conflictId}`);
      }
    }
    for (const knowledgeId of parsed.response.packageTrace.selectedKnowledgeEntryIds) {
      if (!context.knowledgeIds.has(knowledgeId)) {
        throw new Error(`Context package trace references missing knowledge: ${knowledgeId}`);
      }
    }
    for (const material of parsed.response.materials) {
      if (!context.knowledgeIds.has(material.knowledgeEntryId)) {
        throw new Error(
          `Context package material references missing knowledge: ${material.knowledgeEntryId}`
        );
      }
    }
    for (const claim of parsed.response.claims) {
      if (!claimIds.has(claim.id)) {
        throw new Error(`Context package trace embeds missing claim: ${claim.id}`);
      }
    }
    for (const conflict of parsed.response.conflicts) {
      if (!conflictIds.has(conflict.id)) {
        throw new Error(`Context package trace embeds missing conflict: ${conflict.id}`);
      }
    }

    const response = KnowledgeManagerPrepareContextResponseSchema.parse({
      ...parsed.response,
      workspaceId: context.targetWorkspaceId,
      materials: parsed.response.materials.map((material) => ({
        ...material,
        sourceReferences: rewritePortableReferences(material.sourceReferences, replacements),
      })),
      artifacts: parsed.response.artifacts.map((artifact) => {
        assertPortableWorkspaceOwner(
          artifact.workspaceId,
          context.sourceWorkspaceId,
          'context artifact'
        );
        return ArtifactSchema.parse({
          ...artifact,
          id: requiredMapValue(context.artifactIds, artifact.id, 'artifact'),
          workspaceId: context.targetWorkspaceId,
          threadId: artifact.threadId
            ? requiredMapValue(context.threadIds, artifact.threadId, 'thread')
            : null,
          turnId: artifact.turnId
            ? requiredMapValue(context.turnIds, artifact.turnId, 'turn')
            : null,
        });
      }),
      claims: parsed.response.claims.map((claim) => {
        assertPortableWorkspaceOwner(claim.workspaceId, context.sourceWorkspaceId, 'context claim');
        return ImportedKnowledgeClaimSchema.parse({
          ...claim,
          workspaceId: context.targetWorkspaceId,
          sourceReferences: rewritePortableReferences(claim.sourceReferences, replacements),
        });
      }),
      conflicts: parsed.response.conflicts.map((conflict) => {
        assertPortableWorkspaceOwner(
          conflict.workspaceId,
          context.sourceWorkspaceId,
          'context conflict'
        );
        return ImportedKnowledgeConflictSchema.parse({
          ...conflict,
          workspaceId: context.targetWorkspaceId,
          subjectReferences: rewritePortableReferences(conflict.subjectReferences, replacements),
          sourceReferences: rewritePortableReferences(conflict.sourceReferences, replacements),
        });
      }),
      packageTrace: {
        ...parsed.response.packageTrace,
        selectedArtifactIds: parsed.response.packageTrace.selectedArtifactIds.map((artifactId) =>
          requiredMapValue(context.artifactIds, artifactId, 'artifact')
        ),
      },
    });
    const remintedResponse = KnowledgeManagerPrepareContextResponseSchema.parse({
      ...response,
      packageTrace: {
        ...response.packageTrace,
        contextPackageDigest: createKnowledgeContextPackageDigest(response),
      },
    });

    return ImportedKnowledgeContextPackageTraceSchema.parse({
      ...parsed,
      workspaceId: context.targetWorkspaceId,
      response: remintedResponse,
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
  const contextMaterializations = new Map<string, string>();
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
    } else if (workspacePath.startsWith('knowledge/context-materializations/')) {
      contextMaterializations.set(workspacePath, content);
    } else if (workspacePath.startsWith('evidence/bundles/')) {
    } else {
      throw new Error(`Unsupported portable workspace file: ${workspacePath}`);
    }
  }

  return {
    observations: groupPortableRecords(observations, (record) => record.observedAt),
    claims: groupPortableRecords(claims, (record) => record.createdAt),
    conflicts: groupPortableRecords(conflicts, (record) => record.resolvedAt ?? record.createdAt),
    contextPackageTraces: groupPortableRecords(contextPackageTraces, (record) => record.createdAt),
    retrievalTraces: groupPortableRecords(retrievalTraces, (record) => record.createdAt),
    workspaceConfig,
    workspaceSchema,
    nativeKnowledgePages,
    contextMaterializations: remintContextMaterializations(contextMaterializations, {
      sourceWorkspaceId: context.sourceWorkspaceId,
      targetWorkspaceId: context.targetWorkspaceId,
      artifactIds: context.artifactIds,
      knowledgeSourceIds: context.knowledgeSourceIds,
      sourceContextPackageTraces,
      contextPackageTraces,
      replacements,
    }),
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

/** Rewrites materialization paths and manifests while preserving captured file bytes. */
function remintContextMaterializations(
  files: ReadonlyMap<string, string>,
  context: {
    readonly sourceWorkspaceId: string;
    readonly targetWorkspaceId: string;
    readonly artifactIds: ReadonlyMap<string, string>;
    readonly knowledgeSourceIds: ReadonlyMap<string, string>;
    readonly sourceContextPackageTraces: ReadonlyMap<
      string,
      z.infer<typeof ImportedKnowledgeContextPackageTraceSchema>
    >;
    readonly contextPackageTraces: readonly z.infer<
      typeof ImportedKnowledgeContextPackageTraceSchema
    >[];
    readonly replacements: readonly (readonly [string, string])[];
  }
): ReadonlyMap<string, string> {
  const traces = new Map(context.contextPackageTraces.map((trace) => [trace.id, trace]));
  const imported = new Map<string, string>();
  const packages = new Map<string, Map<string, string>>();

  for (const [sourcePath, sourceContent] of files) {
    const segments = sourcePath.split('/');
    if (
      segments.length < 6 ||
      segments[0] !== 'knowledge' ||
      segments[1] !== 'context-materializations' ||
      segments[3] !== 'openkit' ||
      segments[4] !== 'context'
    ) {
      throw new Error(`Context materialization path is invalid: ${sourcePath}`);
    }
    const contextPackageId = segments[2] as string;
    const relativePath = segments.slice(5).join('/');
    assertPortableWorkspaceFilePath(relativePath);
    const packageFiles = packages.get(contextPackageId) ?? new Map<string, string>();
    if (packageFiles.has(relativePath)) {
      throw new Error(`Duplicate context materialization file: ${sourcePath}`);
    }
    packageFiles.set(relativePath, sourceContent);
    packages.set(contextPackageId, packageFiles);
  }

  for (const [contextPackageId, packageFiles] of packages) {
    const sourceTrace = context.sourceContextPackageTraces.get(contextPackageId);
    const trace = traces.get(contextPackageId);
    const sourceManifestContent = packageFiles.get('package.json');
    if (!sourceTrace || !trace || sourceManifestContent === undefined) {
      throw new Error(`Context materialization is missing canonical lineage: ${contextPackageId}`);
    }
    const sourceManifest = WorkerContextPackageManifestSchema.parse(
      JSON.parse(sourceManifestContent)
    );
    if (
      sourceManifest.contextPackageId !== contextPackageId ||
      sourceManifest.workspaceId !== context.sourceWorkspaceId ||
      sourceManifest.contextPackageDigest !== sourceTrace.response.packageTrace.contextPackageDigest
    ) {
      throw new Error(`Context materialization manifest has invalid lineage: ${contextPackageId}`);
    }

    const sourceEntryPaths = new Set<string>();
    for (const entry of sourceManifest.entries) {
      assertPortableWorkspaceFilePath(entry.relativePath);
      if (
        entry.relativePath === 'package.json' ||
        entry.path !== `/openkit/context/${entry.relativePath}` ||
        sourceEntryPaths.has(entry.relativePath)
      ) {
        throw new Error(`Context materialization manifest has invalid entry: ${entry.path}`);
      }
      sourceEntryPaths.add(entry.relativePath);
      const sourceContent = packageFiles.get(entry.relativePath);
      if (sourceContent === undefined || digestText(sourceContent) !== entry.digest) {
        throw new Error(`Context materialization file digest mismatch: ${entry.path}`);
      }
    }
    if (
      packageFiles.size !== sourceEntryPaths.size + 1 ||
      [...packageFiles.keys()].some(
        (path) => path !== 'package.json' && !sourceEntryPaths.has(path)
      )
    ) {
      throw new Error(`Context materialization contains unlisted files: ${contextPackageId}`);
    }

    const targetRoot = `knowledge/context-materializations/${contextPackageId}/openkit/context`;
    const targetEntries = sourceManifest.entries.map((entry) => {
      const relativePath = rewriteContextRelativePath(
        entry.relativePath,
        context.artifactIds,
        context.knowledgeSourceIds
      );
      const targetPath = `${targetRoot}/${relativePath}`;
      let content = packageFiles.get(entry.relativePath) as string;
      if (entry.kind === 'policy') {
        if (entry.relativePath !== 'policy.json') {
          throw new Error(`Context policy has an invalid path: ${entry.relativePath}`);
        }
        content = rewriteContextMaterializationPolicy(content, {
          sourceTrace,
          targetTrace: trace,
          artifactIds: context.artifactIds,
          knowledgeSourceIds: context.knowledgeSourceIds,
          replacements: context.replacements,
        });
      } else if (entry.relativePath === 'policy.json') {
        throw new Error('Context materialization policy.json must have kind policy.');
      }
      if (imported.has(targetPath)) {
        throw new Error(`Context materialization path collides after remint: ${targetPath}`);
      }
      imported.set(targetPath, content);
      return {
        ...entry,
        relativePath,
        path: `/openkit/context/${relativePath}`,
        digest: digestText(content),
        sourceId: entry.sourceId
          ? requiredMapValue(context.knowledgeSourceIds, entry.sourceId, 'knowledge source')
          : undefined,
        derivedRepresentationId: entry.derivedRepresentationId
          ? rewritePortableReferences([entry.derivedRepresentationId], context.replacements)[0]
          : undefined,
        sourceReferences: rewritePortableReferences(entry.sourceReferences, context.replacements),
      };
    });
    const materializedContentBytes = targetEntries.reduce((total, entry) => {
      const content = imported.get(`${targetRoot}/${entry.relativePath}`) as string;
      return total + Buffer.byteLength(content);
    }, 0);
    const targetManifest = WorkerContextPackageManifestSchema.parse({
      ...sourceManifest,
      workspaceId: context.targetWorkspaceId,
      contextPackageDigest: trace.response.packageTrace.contextPackageDigest,
      budget: {
        entryCount: targetEntries.length,
        estimatedTokenCount: Math.ceil(materializedContentBytes / 4),
        fileCount: targetEntries.length + 1,
        materializedContentBytes,
      },
      entries: targetEntries,
    });
    imported.set(`${targetRoot}/package.json`, `${JSON.stringify(targetManifest, null, 2)}\n`);
  }
  return imported;
}

/** Rewrites one policy snapshot to the already-reminted context trace. */
function rewriteContextMaterializationPolicy(
  content: string,
  context: {
    readonly sourceTrace: z.infer<typeof ImportedKnowledgeContextPackageTraceSchema>;
    readonly targetTrace: z.infer<typeof ImportedKnowledgeContextPackageTraceSchema>;
    readonly artifactIds: ReadonlyMap<string, string>;
    readonly knowledgeSourceIds: ReadonlyMap<string, string>;
    readonly replacements: readonly (readonly [string, string])[];
  }
): string {
  const source = ImportedContextMaterializationPolicySchema.parse(JSON.parse(content));
  if (
    JSON.stringify(source.claims) !== JSON.stringify(context.sourceTrace.response.claims) ||
    JSON.stringify(source.conflicts) !== JSON.stringify(context.sourceTrace.response.conflicts) ||
    JSON.stringify(source.packageTrace) !==
      JSON.stringify(context.sourceTrace.response.packageTrace) ||
    JSON.stringify(source.policy) !== JSON.stringify(context.sourceTrace.response.policy)
  ) {
    throw new Error(
      `Context materialization policy does not match its trace: ${context.sourceTrace.id}`
    );
  }
  const target = ImportedContextMaterializationPolicySchema.parse({
    ...source,
    claims: context.targetTrace.response.claims,
    conflicts: context.targetTrace.response.conflicts,
    packageTrace: context.targetTrace.response.packageTrace,
    policy: context.targetTrace.response.policy,
    materializationDecisions: source.materializationDecisions.map((decision) => ({
      ...decision,
      sourceReference: rewritePortableReferences(
        [decision.sourceReference],
        context.replacements
      )[0],
    })),
    sensitivityDecisions: source.sensitivityDecisions.map((decision) => {
      if (!decision.path.startsWith('/openkit/context/')) {
        throw new Error(`Context sensitivity decision has invalid path: ${decision.path}`);
      }
      return {
        ...decision,
        path: `/openkit/context/${rewriteContextRelativePath(
          decision.path.slice('/openkit/context/'.length),
          context.artifactIds,
          context.knowledgeSourceIds
        )}`,
      };
    }),
  });
  return `${JSON.stringify(target, null, 2)}\n`;
}

/** Rewrites exact id-bearing context-relative path segments and filenames. */
function rewriteContextRelativePath(
  path: string,
  artifactIds: ReadonlyMap<string, string>,
  knowledgeSourceIds: ReadonlyMap<string, string>
): string {
  return path
    .split('/')
    .map((segment) => {
      for (const ids of [artifactIds, knowledgeSourceIds]) {
        for (const [sourceId, targetId] of ids) {
          if (segment === sourceId || segment.startsWith(`${sourceId}.`)) {
            return `${targetId}${segment.slice(sourceId.length)}`;
          }
        }
      }
      return segment;
    })
    .join('/');
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
 * Rewrites one imported Goal task and its Goal dependency references.
 *
 * @param record Exported Goal task.
 * @param workspaceId Imported workspace id.
 * @param threadIds Imported thread ids keyed by source id.
 * @param goalIds Imported Goal ids keyed by source id.
 * @param taskIds Imported Goal task ids keyed by source id.
 * @returns Goal task with deterministic imported lineage.
 */
function rewriteImportedGoalTask(
  record: ExportedGoalTask,
  workspaceId: string,
  threadIds: ReadonlyMap<string, string>,
  goalIds: ReadonlyMap<string, string>,
  taskIds: ReadonlyMap<string, string>
): ExportedGoalTask {
  return ExportedGoalTaskSchema.parse({
    ...record,
    taskId: requiredMapValue(taskIds, record.taskId, 'goal task'),
    workspaceId,
    threadId: requiredMapValue(threadIds, record.threadId, 'thread'),
    goalId: requiredMapValue(goalIds, record.goalId, 'goal'),
    dependsOnTaskIds: record.dependsOnTaskIds.map((taskId) =>
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
    case 'item-delta':
      rewrittenData = {
        ...data,
        itemId: requiredMapValue(records.items, data.itemId, 'item').id,
        ...(data.deltaKind === 'artifact-updated'
          ? {
              artifactId: requiredMapValue(records.artifacts, data.artifactId, 'artifact').id,
            }
          : {}),
      };
      break;
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
 * Rewrites workspace references in evidence bundle refs.
 *
 * @param refs Evidence bundle references from an export.
 * @param sourceWorkspaceId Workspace id recorded in the export.
 * @param targetWorkspaceId Workspace id used for imported records.
 * @param threadIds Imported thread ids keyed by source id.
 * @param turnIds Imported turn ids keyed by source id.
 * @param goalIds Imported goal ids keyed by source id.
 * @param artifactIds Imported artifact ids keyed by source id.
 * @param itemIds Imported item ids keyed by source id.
 * @param agentSessionIds Imported agent session ids keyed by source id.
 * @returns Evidence refs with direct workspace refs rewritten.
 */
function rewriteEvidenceBundleRefs(
  refs: EvidenceBundleRecord['redactedEvidenceRefs'],
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  threadIds: ReadonlyMap<string, string>,
  turnIds: ReadonlyMap<string, string>,
  goalIds: ReadonlyMap<string, string>,
  artifactIds: ReadonlyMap<string, string>,
  itemIds: ReadonlyMap<string, string>,
  agentSessionIds: ReadonlyMap<string, string>
): EvidenceBundleRecord['redactedEvidenceRefs'] {
  return refs.map((ref) => {
    let rewritten = ref.ref;
    switch (ref.kind) {
      case 'workspace':
        if (ref.ref !== sourceWorkspaceId) {
          throw new Error(`Evidence ref references missing exported workspace: ${ref.ref}`);
        }
        rewritten = targetWorkspaceId;
        break;
      case 'thread':
        rewritten = requiredMapValue(threadIds, ref.ref, 'thread');
        break;
      case 'turn':
        rewritten = requiredMapValue(turnIds, ref.ref, 'turn');
        break;
      case 'goal':
        rewritten = requiredMapValue(goalIds, ref.ref, 'goal');
        break;
      case 'artifact':
        rewritten = requiredMapValue(artifactIds, ref.ref, 'artifact');
        break;
      case 'item':
        rewritten = requiredMapValue(itemIds, ref.ref, 'item');
        break;
      case 'agent-session':
        rewritten = requiredMapValue(agentSessionIds, ref.ref, 'agent session');
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
