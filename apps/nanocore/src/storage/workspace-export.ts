import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  BackendWorkspaceHandleSchema,
  EvidenceBundleRecordSchema,
  GitPushRecordSchema,
  RuntimeEvidenceRecordSchema,
  StagedWorkspaceReviewSchema,
  WorkerOutputManifestSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceApplyResultSchema,
  WorkspaceChangeSetSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
  WorkspaceQuarantineRecordSchema,
  WorkspaceReconciliationRecordSchema,
  WorkspaceRepositoryGitConfigSchema,
  WorkspaceSyncEvidenceBundleSchema,
  WorkspaceSyncReviewPatchPayloadSchema,
} from '@openkit/app-api-schemas';
import {
  parseWorkspaceDataSourceCatalog,
  parseWorkspaceExportManifest,
  WORKSPACE_EXPORT_FORMAT_VERSION,
  type WorkspaceDataSourceCatalog,
  type WorkspaceExportManifest,
} from '@openkit/config-schema';
import {
  AuditEventSchema,
  CapabilityCallSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  ThreadSchema,
  UsageRecordSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { ResolvedAgentSetupRecord } from '../agents/setup-ledger.js';
import type { AgentEnvironmentPackageSnapshotRecord } from '../runtime/aep-snapshot-ledger.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type KnowledgeEntry = import('zod').infer<typeof KnowledgeEntrySchema>;
type Item = import('zod').infer<typeof ItemSchema>;
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
type WorkspaceSyncEvidenceBundle = z.infer<typeof WorkspaceSyncEvidenceBundleSchema>;

const ImportedEvidenceBundleRecordSchema = EvidenceBundleRecordSchema.strip();
const ImportedRuntimeEvidenceRecordSchema = RuntimeEvidenceRecordSchema.strip();
const ImportedUsageRecordSchema = UsageRecordSchema.strip();

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

const ExportedKnowledgeProposalSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    status: z.enum(['pending', 'accepted', 'edited', 'rejected', 'deferred']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedKnowledgeProposal = z.infer<typeof ExportedKnowledgeProposalSchema>;

const ExportedKnowledgeProposalReviewSchema = z
  .object({
    proposalId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.enum(['pending', 'accepted', 'edited', 'rejected', 'deferred']),
    requestId: z.string().min(1).nullable(),
    message: z.string().min(1).nullable(),
    decidedAt: z.string().datetime(),
  })
  .strict();

type ExportedKnowledgeProposalReview = z.infer<typeof ExportedKnowledgeProposalReviewSchema>;

const ExportedKnowledgeSourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.enum(['upload', 'url', 'document', 'transcript', 'code']),
    title: z.string().min(1),
    uri: z.string().min(1).nullable(),
    contentDigest: z.string().min(1),
    originatingThreadId: z.string().min(1).nullable(),
    originatingTurnId: z.string().min(1).nullable(),
    originatingFileId: z.string().min(1).nullable(),
    capturedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type ExportedKnowledgeSource = z.infer<typeof ExportedKnowledgeSourceSchema>;

/** Exported text material captured for one workspace knowledge source. */
export interface ExportedKnowledgeSourceMaterial {
  /** Source id that owns the material. */
  sourceId: string;
  /** Captured source text content. */
  content: string;
}

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

const ImportedCapabilityCallSchema = ExportedCapabilityCallSchema.strip();

type ExportedCapabilityCall = z.infer<typeof ExportedCapabilityCallSchema>;

const ExportedGitPushRecordSchema = GitPushRecordSchema.extend({
  requestId: z.string().min(1),
}).strict();

const ImportedGitPushRecordSchema = ExportedGitPushRecordSchema.strip();

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

/** File name for the root workspace export manifest. */
export const WORKSPACE_EXPORT_MANIFEST_FILE = 'openkit-workspace-export.json';

/** Workspace SQLite tables whose portable row families are covered by workspace export/import. */
export const WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES = [
  'agent_environment_package_snapshots',
  'audit_events',
  'backend_workspace_handles',
  'capability_calls',
  'evidence_bundles',
  'git_push_records',
  'goal_records',
  'goal_review_records',
  'goal_tasks',
  'goal_verification_records',
  'mcp_tool_schema_snapshots',
  'pending_user_turns',
  'permission_decisions',
  'resolved_agent_setups',
  'runtime_evidence',
  'usage_records',
  'vault_use_records',
  'worker_output_manifests',
  'workspace_apply_plans',
  'worker_turn_checkpoints',
  'workspace_apply_results',
  'workspace_change_sets',
  'workspace_input_snapshots',
  'workspace_materialization_records',
  'workspace_quarantine_records',
  'workspace_reconciliation_records',
  'workspace_repository_resources',
  'workspace_sync_evidence_bundles',
  'staged_workspace_reviews',
] as const;

/** Workspace SQLite tables intentionally excluded from portable workspace export/import. */
export const WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES = [
  {
    table: 'workspace_filesystem_staging_roots',
    reason: 'host-local apply staging paths are not portable export history',
  },
] as const;

/** Input for offline workspace export verification. */
export interface VerifyWorkspaceExportTreeInput {
  /** Export root directory to verify. */
  exportRoot: string;
  /** Required-feature ids supported by the verifier. */
  supportedFeatures?: readonly string[];
}

/** Result returned by offline workspace export verification. */
export interface VerifiedWorkspaceExportTree {
  /** Parsed export manifest. */
  manifest: WorkspaceExportManifest;
  /** Inventory files whose bytes and digests were checked. */
  checkedFiles: string[];
}

/** Input for writing one workspace export tree. */
export interface WriteWorkspaceExportTreeInput {
  /** Export root directory to populate. */
  exportRoot: string;
  /** Stable export record id. */
  exportId: string;
  /** Source deployment id recorded in the manifest lineage. */
  sourceDeploymentId: string;
  /** Export creation timestamp. */
  createdAt: string;
  /** Workspace record to export. */
  workspace: { id: string; [key: string]: unknown };
  /** Thread records to export. */
  threads: readonly unknown[];
  /** Knowledge records to export. */
  knowledge: readonly unknown[];
  /** Durable thread item records to export. */
  threadItems: readonly unknown[];
  /** Knowledge proposal records to export as line-oriented records. */
  knowledgeProposals?: readonly unknown[];
  /** Knowledge proposal review records to export as line-oriented records. */
  knowledgeProposalReviews?: readonly unknown[];
  /** Knowledge source identity records to export as line-oriented records. */
  knowledgeSources?: readonly unknown[];
  /** Knowledge source text materials to export as evidence files. */
  knowledgeSourceMaterials?: readonly ExportedKnowledgeSourceMaterial[];
  /** Non-secret workspace vault reference records to export. */
  vaultReferences?: readonly unknown[];
  /** Non-secret workspace vault grant records to export. */
  vaultGrants?: readonly unknown[];
  /** Non-secret injection plan records linked to workspace vault grants. */
  injectionPlans?: readonly unknown[];
  /** Non-secret injection receipt records linked to exported injection plans. */
  injectionReceipts?: readonly unknown[];
  /** Non-secret workspace vault use records to export. */
  vaultUseRecords?: readonly unknown[];
  /** Workspace-scoped audit events to export as line-oriented records. */
  auditEvents?: readonly unknown[];
  /** Workspace-scoped capability calls to export as line-oriented records. */
  capabilityCalls?: readonly unknown[];
  /** Workspace-scoped evidence bundles to export as line-oriented records. */
  evidenceBundles?: readonly unknown[];
  /** Workspace-scoped runtime evidence to export as line-oriented records. */
  runtimeEvidence?: readonly unknown[];
  /** Workspace-scoped usage records to export as line-oriented records. */
  usageRecords?: readonly unknown[];
  /** Workspace-owned data source catalog to export. */
  dataSourceCatalog?: unknown;
  /** Workspace-scoped Git push records to export as line-oriented records. */
  gitPushRecords?: readonly unknown[];
  /** Resolved agent setup records to export as line-oriented records. */
  resolvedAgentSetups?: readonly unknown[];
  /** Redacted Agent Environment Package snapshots to export as line-oriented records. */
  agentEnvironmentPackageSnapshots?: readonly unknown[];
  /** Workspace repository resources to export as unbound metadata. */
  workspaceRepositories?: readonly unknown[];
  /** Durable workspace sync input snapshots to export as line-oriented records. */
  workspaceInputSnapshots?: readonly unknown[];
  /** Durable workspace sync materialization records to export as line-oriented records. */
  workspaceMaterializationRecords?: readonly unknown[];
  /** Durable workspace sync backend handles to export as line-oriented records. */
  backendWorkspaceHandles?: readonly unknown[];
  /** Durable worker output manifests to export as line-oriented records. */
  workerOutputManifests?: readonly unknown[];
  /** Durable workspace sync change sets to export as line-oriented records. */
  workspaceChangeSets?: readonly unknown[];
  /** Durable staged workspace review rows to export as line-oriented records. */
  stagedWorkspaceReviews?: readonly unknown[];
  /** Durable workspace apply plan rows to export as line-oriented records. */
  workspaceApplyPlans?: readonly unknown[];
  /** Durable workspace apply result rows to export as line-oriented records. */
  workspaceApplyResults?: readonly unknown[];
  /** Durable workspace reconciliation rows to export as line-oriented records. */
  workspaceReconciliationRecords?: readonly unknown[];
  /** Durable workspace quarantine rows to export as line-oriented records. */
  workspaceQuarantineRecords?: readonly unknown[];
  /** Durable workspace sync evidence bundle rows to export as line-oriented records. */
  workspaceSyncEvidenceBundles?: readonly unknown[];
  /** Workspace-scoped permission decision rows to export as line-oriented records. */
  permissionDecisions?: readonly unknown[];
  /** Pending user turn rows to export as line-oriented records. */
  pendingUserTurns?: readonly unknown[];
  /** Worker checkpoint rows to export as line-oriented records. */
  workerCheckpoints?: readonly unknown[];
  /** Goal Mode goal records to export as line-oriented records. */
  goalRecords?: readonly unknown[];
  /** Goal Mode task records to export as line-oriented records. */
  goalTasks?: readonly unknown[];
  /** Goal Mode review records to export as line-oriented records. */
  goalReviewRecords?: readonly unknown[];
  /** Goal Mode verification records to export as line-oriented records. */
  goalVerificationRecords?: readonly unknown[];
  /** MCP tool schema snapshots to export as line-oriented records. */
  mcpToolSchemaSnapshots?: readonly unknown[];
}

/** Input for previewing a workspace import without writing target state. */
export interface DryRunWorkspaceImportInput {
  /** Export root directory to verify. */
  exportRoot: string;
  /** Returns whether a workspace id already exists in the target deployment. */
  workspaceExists: (workspaceId: string) => boolean;
}

/** Result returned after verifying an export and previewing import collision handling. */
export interface WorkspaceImportDryRunReport {
  /** Operation mode marker. */
  mode: 'dry-run';
  /** Export record id from the verified manifest. */
  exportId: string;
  /** Source workspace handle used to locate the export. */
  sourceWorkspaceId: string;
  /** Workspace id recorded inside the export manifest. */
  exportedWorkspaceId: string;
  /** Verified export manifest. */
  manifest: WorkspaceExportManifest;
  /** Offline verification summary. */
  verification: {
    /** Number of checked inventory files. */
    fileCount: number;
    /** Total checked inventory bytes. */
    totalBytes: number;
    /** Checked inventory file paths. */
    checkedFiles: string[];
  };
  /** Collision preview for the exported workspace id. */
  collision:
    | { status: 'available'; workspaceId: string }
    | { status: 'collides'; workspaceId: string; suggestedWorkspaceId: string };
}

/** Input for reading one verified export into importable records. */
export interface ReadWorkspaceImportSnapshotInput {
  /** Export root directory to verify and read. */
  exportRoot: string;
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
  /** Imported knowledge records. */
  knowledge: KnowledgeEntry[];
  /** Imported thread item records with target workspace and reminted thread ids. */
  threadItems: Item[];
  /** Imported knowledge proposal records. */
  knowledgeProposals: ExportedKnowledgeProposal[];
  /** Imported knowledge proposal review records. */
  knowledgeProposalReviews: ExportedKnowledgeProposalReview[];
  /** Imported knowledge source identity records. */
  knowledgeSources: ExportedKnowledgeSource[];
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
  /** Imported workspace sync evidence bundle rows. */
  workspaceSyncEvidenceBundles: WorkspaceSyncEvidenceBundle[];
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
}

/**
 * Writes one workspace export tree and verifies the result offline.
 *
 * @param input Workspace records and export destination.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when the written tree fails offline verification.
 */
export function writeWorkspaceExportTree(
  input: WriteWorkspaceExportTreeInput
): VerifiedWorkspaceExportTree {
  const recordsRoot = join(input.exportRoot, 'records');

  mkdirSync(recordsRoot, { recursive: true });
  writeJson(join(recordsRoot, 'workspace.json'), input.workspace);
  writeJsonl(join(recordsRoot, 'threads.jsonl'), input.threads);
  writeJsonl(join(recordsRoot, 'knowledge.jsonl'), input.knowledge);
  writeJsonl(join(recordsRoot, 'thread-items.jsonl'), input.threadItems);
  if (input.knowledgeProposals?.length) {
    writeJsonl(join(recordsRoot, 'knowledge-proposals.jsonl'), input.knowledgeProposals);
  }
  if (input.knowledgeProposalReviews?.length) {
    writeJsonl(
      join(recordsRoot, 'knowledge-proposal-reviews.jsonl'),
      input.knowledgeProposalReviews
    );
  }
  if (input.knowledgeSources?.length) {
    writeJsonl(join(recordsRoot, 'knowledge-sources.jsonl'), input.knowledgeSources);
  }
  if (input.knowledgeSourceMaterials?.length) {
    const sourcesById = new Map(
      (input.knowledgeSources ?? [])
        .map((source) => ExportedKnowledgeSourceSchema.parse(source))
        .map((source) => [source.id, source])
    );

    for (const material of input.knowledgeSourceMaterials) {
      const path = join(input.exportRoot, 'sources', 'materials', material.sourceId, 'content.txt');
      const source = sourcesById.get(material.sourceId);

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, material.content);
      if (source) {
        const derivedPath = join(
          input.exportRoot,
          'sources',
          'derived',
          material.sourceId,
          'text.json'
        );

        mkdirSync(dirname(derivedPath), { recursive: true });
        writeJson(derivedPath, {
          id: `${material.sourceId}:text`,
          workspaceId: source.workspaceId,
          sourceId: material.sourceId,
          kind: 'text',
          path: `sources/derived/${material.sourceId}/text.json`,
          materialPath: `sources/materials/${material.sourceId}/content.txt`,
          contentDigest: source.contentDigest,
          sourceContentDigest: source.contentDigest,
          createdAt: source.createdAt,
        });
      }
    }
  }
  if (input.auditEvents?.length) {
    writeJsonl(join(recordsRoot, 'audit-events.jsonl'), input.auditEvents);
  }
  if (input.capabilityCalls?.length) {
    writeJsonl(join(recordsRoot, 'capability-calls.jsonl'), input.capabilityCalls);
  }
  if (input.evidenceBundles?.length) {
    writeJsonl(join(recordsRoot, 'evidence-bundles.jsonl'), input.evidenceBundles);
  }
  if (input.runtimeEvidence?.length) {
    writeJsonl(join(recordsRoot, 'runtime-evidence.jsonl'), input.runtimeEvidence);
  }
  if (input.usageRecords?.length) {
    writeJsonl(join(recordsRoot, 'usage-records.jsonl'), input.usageRecords);
  }
  if (input.vaultReferences?.length) {
    writeJsonl(join(recordsRoot, 'vault-references.jsonl'), input.vaultReferences);
  }
  if (input.vaultGrants?.length) {
    writeJsonl(join(recordsRoot, 'vault-grants.jsonl'), input.vaultGrants);
  }
  if (input.injectionPlans?.length) {
    writeJsonl(join(recordsRoot, 'injection-plans.jsonl'), input.injectionPlans);
  }
  if (input.injectionReceipts?.length) {
    writeJsonl(join(recordsRoot, 'injection-receipts.jsonl'), input.injectionReceipts);
  }
  if (input.vaultUseRecords?.length) {
    writeJsonl(join(recordsRoot, 'vault-use-records.jsonl'), input.vaultUseRecords);
  }
  if (input.dataSourceCatalog) {
    writeJson(
      join(recordsRoot, 'data-sources.json'),
      parseWorkspaceDataSourceCatalog(input.dataSourceCatalog)
    );
  }
  if (input.gitPushRecords?.length) {
    writeJsonl(join(recordsRoot, 'git-push-records.jsonl'), input.gitPushRecords);
  }
  if (input.resolvedAgentSetups?.length) {
    writeJsonl(
      join(recordsRoot, 'resolved-agent-setups.jsonl'),
      input.resolvedAgentSetups.map(toExportedResolvedAgentSetupRecord)
    );
  }
  if (input.agentEnvironmentPackageSnapshots?.length) {
    writeJsonl(
      join(recordsRoot, 'agent-environment-package-snapshots.jsonl'),
      input.agentEnvironmentPackageSnapshots
    );
  }
  if (input.workspaceRepositories?.length) {
    writeJsonl(join(recordsRoot, 'workspace-repositories.jsonl'), input.workspaceRepositories);
  }
  if (input.workspaceInputSnapshots?.length) {
    writeJsonl(join(recordsRoot, 'workspace-input-snapshots.jsonl'), input.workspaceInputSnapshots);
  }
  if (input.workspaceMaterializationRecords?.length) {
    writeJsonl(
      join(recordsRoot, 'workspace-materialization-records.jsonl'),
      input.workspaceMaterializationRecords
    );
  }
  if (input.backendWorkspaceHandles?.length) {
    writeJsonl(join(recordsRoot, 'backend-workspace-handles.jsonl'), input.backendWorkspaceHandles);
  }
  if (input.workerOutputManifests?.length) {
    writeJsonl(join(recordsRoot, 'worker-output-manifests.jsonl'), input.workerOutputManifests);
  }
  if (input.workspaceChangeSets?.length) {
    writeJsonl(join(recordsRoot, 'workspace-change-sets.jsonl'), input.workspaceChangeSets);
  }
  if (input.stagedWorkspaceReviews?.length) {
    writeJsonl(join(recordsRoot, 'staged-workspace-reviews.jsonl'), input.stagedWorkspaceReviews);
  }
  if (input.workspaceApplyPlans?.length) {
    writeJsonl(join(recordsRoot, 'workspace-apply-plans.jsonl'), input.workspaceApplyPlans);
  }
  if (input.workspaceApplyResults?.length) {
    writeJsonl(join(recordsRoot, 'workspace-apply-results.jsonl'), input.workspaceApplyResults);
  }
  if (input.workspaceReconciliationRecords?.length) {
    writeJsonl(
      join(recordsRoot, 'workspace-reconciliation-records.jsonl'),
      input.workspaceReconciliationRecords
    );
  }
  if (input.workspaceQuarantineRecords?.length) {
    writeJsonl(
      join(recordsRoot, 'workspace-quarantine-records.jsonl'),
      input.workspaceQuarantineRecords
    );
  }
  if (input.workspaceSyncEvidenceBundles?.length) {
    writeJsonl(
      join(recordsRoot, 'workspace-sync-evidence-bundles.jsonl'),
      input.workspaceSyncEvidenceBundles
    );
  }
  if (input.permissionDecisions?.length) {
    writeJsonl(join(recordsRoot, 'permission-decisions.jsonl'), input.permissionDecisions);
  }
  if (input.pendingUserTurns?.length) {
    writeJsonl(join(recordsRoot, 'pending-user-turns.jsonl'), input.pendingUserTurns);
  }
  if (input.workerCheckpoints?.length) {
    writeJsonl(join(recordsRoot, 'worker-turn-checkpoints.jsonl'), input.workerCheckpoints);
  }
  if (input.goalRecords?.length) {
    writeJsonl(join(recordsRoot, 'goal-records.jsonl'), input.goalRecords);
  }
  if (input.goalTasks?.length) {
    writeJsonl(join(recordsRoot, 'goal-tasks.jsonl'), input.goalTasks);
  }
  if (input.goalReviewRecords?.length) {
    writeJsonl(join(recordsRoot, 'goal-review-records.jsonl'), input.goalReviewRecords);
  }
  if (input.goalVerificationRecords?.length) {
    writeJsonl(join(recordsRoot, 'goal-verification-records.jsonl'), input.goalVerificationRecords);
  }
  if (input.mcpToolSchemaSnapshots?.length) {
    writeJsonl(join(recordsRoot, 'mcp-tool-schema-snapshots.jsonl'), input.mcpToolSchemaSnapshots);
  }

  const contentInventory = listRegularExportFiles(input.exportRoot)
    .filter((path) => path !== WORKSPACE_EXPORT_MANIFEST_FILE)
    .map((path) => {
      const filePath = join(input.exportRoot, path);
      return {
        path,
        digest: digestFile(filePath),
        bytes: statSync(filePath).size,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkspaceExportManifest = {
    schemaVersion: 1,
    recordType: 'workspace-export',
    id: input.exportId,
    ownerScope: 'workspace',
    lineage: { workspaceId: input.workspace.id },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    contentDigest: digestText(JSON.stringify(contentInventory)),
    redactionLevel: 'metadata',
    sensitivity: 'internal',
    requiredFeatures: [],
    extensions: {},
    sourceDeploymentId: input.sourceDeploymentId,
    workspaceId: input.workspace.id,
    exportCreatedAt: input.createdAt,
    exportFormatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    contentInventory,
  };

  writeJson(join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE), manifest);
  return verifyWorkspaceExportTree({ exportRoot: input.exportRoot });
}

/**
 * Verifies a workspace export and previews import id collision without writing state.
 *
 * @param input Export root and target workspace lookup.
 * @returns Dry-run report with verification and collision summary.
 * @throws Error when the export tree fails offline verification.
 */
export function dryRunWorkspaceImport(
  input: DryRunWorkspaceImportInput
): WorkspaceImportDryRunReport {
  const verified = verifyWorkspaceExportTree({ exportRoot: input.exportRoot });
  const workspaceId = verified.manifest.workspaceId;
  const collision = input.workspaceExists(workspaceId)
    ? {
        status: 'collides' as const,
        workspaceId,
        suggestedWorkspaceId: `ws_imported_${workspaceId}`,
      }
    : { status: 'available' as const, workspaceId };

  return {
    mode: 'dry-run',
    exportId: verified.manifest.id,
    sourceWorkspaceId: verified.manifest.workspaceId,
    exportedWorkspaceId: workspaceId,
    manifest: verified.manifest,
    verification: {
      fileCount: verified.checkedFiles.length,
      totalBytes: verified.manifest.contentInventory.reduce(
        (total, entry) => total + entry.bytes,
        0
      ),
      checkedFiles: verified.checkedFiles,
    },
    collision,
  };
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
  const report = dryRunWorkspaceImport({
    exportRoot: input.exportRoot,
    workspaceExists: () => false,
  });
  const remint = report.exportedWorkspaceId !== input.targetWorkspaceId;
  const threadIds = new Map<string, string>();
  const exportedWorkspace = WorkspaceRecordSchema.parse(
    readImportJson(join(input.exportRoot, 'records', 'workspace.json'), 'records/workspace.json')
  );
  const workspace = WorkspaceRecordSchema.parse({
    ...exportedWorkspace,
    id: input.targetWorkspaceId,
    importedFrom: {
      sourceDeploymentId: report.manifest.sourceDeploymentId,
      sourceWorkspaceId: report.exportedWorkspaceId,
      exportCreatedAt: report.manifest.exportCreatedAt,
      manifestDigest: digestFile(join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE)),
    },
  });
  const threads = readImportJsonl(
    join(input.exportRoot, 'records', 'threads.jsonl'),
    'records/threads.jsonl'
  ).map((record, index) => {
    const parsed = ThreadSchema.parse(record);
    const id = remint ? `th_imported_${input.targetWorkspaceId}_${index + 1}` : parsed.id;
    threadIds.set(parsed.id, id);
    return ThreadSchema.parse({ ...parsed, id, workspaceId: input.targetWorkspaceId });
  });
  const knowledge = readImportJsonl(
    join(input.exportRoot, 'records', 'knowledge.jsonl'),
    'records/knowledge.jsonl'
  ).map((record) => KnowledgeEntrySchema.parse(record));
  const threadItems = readImportJsonl(
    join(input.exportRoot, 'records', 'thread-items.jsonl'),
    'records/thread-items.jsonl'
  ).map((record, index) => {
    const parsed = ItemSchema.parse(record);
    const threadId = threadIds.get(parsed.threadId);
    if (!threadId) {
      throw new Error(`Thread item references missing exported thread: ${parsed.threadId}`);
    }

    return ItemSchema.parse({
      ...parsed,
      id: remint ? `it_imported_${input.targetWorkspaceId}_${index + 1}` : parsed.id,
      threadId,
      turnId: remint ? `tu_imported_${input.targetWorkspaceId}_${parsed.turnId}` : parsed.turnId,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const exportedKnowledgeProposals = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'knowledge-proposals.jsonl'),
    'records/knowledge-proposals.jsonl'
  ).map((record) => ExportedKnowledgeProposalSchema.parse(record));
  const knowledgeProposals = exportedKnowledgeProposals.map((proposal, index) =>
    ExportedKnowledgeProposalSchema.parse({
      ...proposal,
      id: remint ? `kp_imported_${input.targetWorkspaceId}_${index + 1}` : proposal.id,
      workspaceId: input.targetWorkspaceId,
    })
  );
  const knowledgeProposalIds = new Map(
    exportedKnowledgeProposals.map((proposal, index) => [
      proposal.id,
      knowledgeProposals[index]!.id,
    ])
  );
  const knowledgeProposalReviews = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'knowledge-proposal-reviews.jsonl'),
    'records/knowledge-proposal-reviews.jsonl'
  ).map((record) => {
    const parsed = ExportedKnowledgeProposalReviewSchema.parse(record);

    return ExportedKnowledgeProposalReviewSchema.parse({
      ...parsed,
      proposalId: knowledgeProposalIds.get(parsed.proposalId) ?? parsed.proposalId,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const exportedKnowledgeSources = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'knowledge-sources.jsonl'),
    'records/knowledge-sources.jsonl'
  ).map((record) => ExportedKnowledgeSourceSchema.parse(record));
  const knowledgeSources = exportedKnowledgeSources.map((parsed, index) =>
    ExportedKnowledgeSourceSchema.parse({
      ...parsed,
      id: remint ? `ks_imported_${input.targetWorkspaceId}_${index + 1}` : parsed.id,
      uri: parsed.uri
        ? rewriteWorkspaceReference(parsed.uri, report.exportedWorkspaceId, input.targetWorkspaceId)
        : null,
      workspaceId: input.targetWorkspaceId,
    })
  );
  const knowledgeSourceIds = new Map(
    exportedKnowledgeSources.map((source, index) => [source.id, knowledgeSources[index]!.id])
  );
  const knowledgeSourceMaterials = exportedKnowledgeSources
    .map((source): ExportedKnowledgeSourceMaterial | null => {
      const materialPath = join(input.exportRoot, 'sources', 'materials', source.id, 'content.txt');

      return existsSync(materialPath)
        ? {
            sourceId: knowledgeSourceIds.get(source.id) ?? source.id,
            content: readFileSync(materialPath, 'utf8'),
          }
        : null;
    })
    .filter((material): material is ExportedKnowledgeSourceMaterial => material !== null);
  const vaultReferences = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'vault-references.jsonl'),
    'records/vault-references.jsonl'
  ).map((record, index) => {
    const parsed = ExportedWorkspaceVaultReferenceSchema.parse(record);

    return ImportedWorkspaceVaultReferenceSchema.parse({
      ...parsed,
      referenceId: `vault_imported_${input.targetWorkspaceId}_${index + 1}`,
      ownerScope: 'workspace',
      workspaceId: input.targetWorkspaceId,
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
    join(input.exportRoot, 'records', 'vault-grants.jsonl'),
    'records/vault-grants.jsonl'
  ).map((record) => ExportedVaultGrantSchema.parse(record));
  const vaultGrants = exportedVaultGrants.map((grant, index) => {
    const vaultReferenceId = vaultReferenceIds.get(grant.vaultReferenceId);
    if (!vaultReferenceId) {
      throw new Error(
        `Vault grant references missing exported vault reference: ${grant.vaultReferenceId}`
      );
    }

    return ExportedVaultGrantSchema.parse({
      ...grant,
      grantId: `grant_imported_${input.targetWorkspaceId}_${index + 1}`,
      vaultReferenceId,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const vaultGrantIds = new Map(
    exportedVaultGrants.map((grant, index) => [grant.grantId, vaultGrants[index]!.grantId])
  );
  const exportedInjectionPlans = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'injection-plans.jsonl'),
    'records/injection-plans.jsonl'
  ).map((record) => ExportedInjectionPlanSchema.parse(record));
  const injectionPlans = exportedInjectionPlans.map((plan, index) => {
    const grantId = vaultGrantIds.get(plan.grantId);
    if (!grantId) {
      throw new Error(`Injection plan references missing exported vault grant: ${plan.grantId}`);
    }

    return ExportedInjectionPlanSchema.parse({
      ...plan,
      planId: `plan_imported_${input.targetWorkspaceId}_${index + 1}`,
      grantId,
    });
  });
  const injectionPlanIds = new Map(
    exportedInjectionPlans.map((plan, index) => [plan.planId, injectionPlans[index]!.planId])
  );
  const exportedInjectionReceipts = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'injection-receipts.jsonl'),
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
      receiptId: `receipt_imported_${input.targetWorkspaceId}_${index + 1}`,
      planId,
      grantId,
    });
  });
  const injectionReceiptIds = new Map(
    exportedInjectionReceipts.map((receipt, index) => [
      receipt.receiptId,
      injectionReceipts[index]!.receiptId,
    ])
  );
  const vaultUseRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'vault-use-records.jsonl'),
    'records/vault-use-records.jsonl'
  ).map((record) => {
    const parsed = ExportedVaultUseRecordSchema.parse(record);

    return ExportedVaultUseRecordSchema.parse({
      ...parsed,
      grantId: parsed.grantId ? (vaultGrantIds.get(parsed.grantId) ?? parsed.grantId) : null,
      planId: parsed.planId ? (injectionPlanIds.get(parsed.planId) ?? parsed.planId) : null,
      receiptId: parsed.receiptId
        ? (injectionReceiptIds.get(parsed.receiptId) ?? parsed.receiptId)
        : null,
      workspaceId: input.targetWorkspaceId,
      vaultReferenceId: vaultReferenceIds.get(parsed.vaultReferenceId) ?? parsed.vaultReferenceId,
    });
  });
  const auditEvents = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'audit-events.jsonl'),
    'records/audit-events.jsonl'
  ).map((record) => {
    const parsed = AuditEventSchema.parse(record);

    return AuditEventSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
      resource:
        parsed.resource === `workspace:${report.exportedWorkspaceId}`
          ? `workspace:${input.targetWorkspaceId}`
          : parsed.resource,
    });
  });
  const capabilityCalls = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'capability-calls.jsonl'),
    'records/capability-calls.jsonl'
  ).map((record) => {
    const parsed = ImportedCapabilityCallSchema.parse(record);

    return ExportedCapabilityCallSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const evidenceBundles = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'evidence-bundles.jsonl'),
    'records/evidence-bundles.jsonl'
  ).map((record) => {
    const parsed = ImportedEvidenceBundleRecordSchema.parse(record);

    return EvidenceBundleRecordSchema.parse({
      ...parsed,
      rawEvidenceRefs: rewriteEvidenceBundleRefs(
        parsed.rawEvidenceRefs,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      redactedEvidenceRefs: rewriteEvidenceBundleRefs(
        parsed.redactedEvidenceRefs,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      workspaceId: input.targetWorkspaceId,
    });
  });
  const runtimeEvidence = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'runtime-evidence.jsonl'),
    'records/runtime-evidence.jsonl'
  ).map((record) => {
    const parsed = ImportedRuntimeEvidenceRecordSchema.parse(record);

    return RuntimeEvidenceRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const usageRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'usage-records.jsonl'),
    'records/usage-records.jsonl'
  ).map((record) => {
    const parsed = ImportedUsageRecordSchema.parse(record);

    return UsageRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const dataSourceCatalogPath = join(input.exportRoot, 'records', 'data-sources.json');
  const dataSourceCatalog = existsSync(dataSourceCatalogPath)
    ? parseWorkspaceDataSourceCatalog(
        readImportJson(dataSourceCatalogPath, 'records/data-sources.json')
      )
    : null;
  const gitPushRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'git-push-records.jsonl'),
    'records/git-push-records.jsonl'
  ).map((record) => {
    const parsed = ImportedGitPushRecordSchema.parse(record);

    return ExportedGitPushRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const resolvedAgentSetups = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'resolved-agent-setups.jsonl'),
    'records/resolved-agent-setups.jsonl'
  ).map((record) => {
    const parsed = ExportedResolvedAgentSetupSchema.parse(record);

    return {
      id: parsed.id,
      workspaceId: input.targetWorkspaceId,
      turnId: parsed.turnId,
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
  const agentEnvironmentPackageSnapshots = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'agent-environment-package-snapshots.jsonl'),
    'records/agent-environment-package-snapshots.jsonl'
  ).map((record) => {
    const parsed = ExportedAgentEnvironmentPackageSnapshotSchema.parse(record);
    const snapshot = rewriteAgentEnvironmentPackageSnapshotWorkspace(
      parsed.snapshot,
      input.targetWorkspaceId
    );

    return ExportedAgentEnvironmentPackageSnapshotSchema.parse({
      ...parsed,
      contentDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      snapshot,
      workspaceId: input.targetWorkspaceId,
    }) as ExportedAgentEnvironmentPackageSnapshot;
  });
  const workspaceRepositories = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-repositories.jsonl'),
    'records/workspace-repositories.jsonl'
  ).map((record) => ExportedWorkspaceRepositoryResourceSchema.parse(record));
  const workspaceInputSnapshots = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-input-snapshots.jsonl'),
    'records/workspace-input-snapshots.jsonl'
  ).map((record) => {
    const parsed = WorkspaceInputSnapshotSchema.parse(record);

    return WorkspaceInputSnapshotSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceMaterializationRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-materialization-records.jsonl'),
    'records/workspace-materialization-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceMaterializationRecordSchema.parse(record);

    return WorkspaceMaterializationRecordSchema.parse({
      ...parsed,
      materializedRootRef: rewriteWorkspaceReference(
        parsed.materializedRootRef,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      workspaceId: input.targetWorkspaceId,
    });
  });
  const backendWorkspaceHandles = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'backend-workspace-handles.jsonl'),
    'records/backend-workspace-handles.jsonl'
  ).map((record) => {
    const parsed = BackendWorkspaceHandleSchema.parse(record);

    return BackendWorkspaceHandleSchema.parse({
      ...parsed,
      transportRefs: parsed.transportRefs.map((transportRef) => ({
        ...transportRef,
        ref: rewriteWorkspaceReference(
          transportRef.ref,
          report.exportedWorkspaceId,
          input.targetWorkspaceId
        ),
      })),
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workerOutputManifests = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'worker-output-manifests.jsonl'),
    'records/worker-output-manifests.jsonl'
  ).map((record) => {
    const parsed = WorkerOutputManifestSchema.parse(record);

    return WorkerOutputManifestSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceChangeSets = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-change-sets.jsonl'),
    'records/workspace-change-sets.jsonl'
  ).map((record) => {
    const parsed = WorkspaceChangeSetSchema.parse(record);

    return WorkspaceChangeSetSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const stagedWorkspaceReviews = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'staged-workspace-reviews.jsonl'),
    'records/staged-workspace-reviews.jsonl'
  ).map((record) => {
    const parsed = ExportedStagedWorkspaceReviewSchema.parse(record);

    return ExportedStagedWorkspaceReviewSchema.parse({
      ...parsed,
      review: {
        ...parsed.review,
        staging: {
          ...parsed.review.staging,
          ref: rewriteWorkspaceReference(
            parsed.review.staging.ref,
            report.exportedWorkspaceId,
            input.targetWorkspaceId
          ),
        },
        workspaceId: input.targetWorkspaceId,
      },
    });
  });
  const workspaceApplyResults = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-apply-results.jsonl'),
    'records/workspace-apply-results.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkspaceApplyResultSchema.parse(record);

    return ExportedWorkspaceApplyResultSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceApplyPlans = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-apply-plans.jsonl'),
    'records/workspace-apply-plans.jsonl'
  ).map((record) => {
    const parsed = WorkspaceApplyPlanSchema.parse(record);

    return WorkspaceApplyPlanSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceReconciliationRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-reconciliation-records.jsonl'),
    'records/workspace-reconciliation-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceReconciliationRecordSchema.parse(record);

    return WorkspaceReconciliationRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceQuarantineRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-quarantine-records.jsonl'),
    'records/workspace-quarantine-records.jsonl'
  ).map((record) => {
    const parsed = WorkspaceQuarantineRecordSchema.parse(record);

    return WorkspaceQuarantineRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workspaceSyncEvidenceBundles = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'workspace-sync-evidence-bundles.jsonl'),
    'records/workspace-sync-evidence-bundles.jsonl'
  ).map((record) => {
    const parsed = WorkspaceSyncEvidenceBundleSchema.parse(record);

    return WorkspaceSyncEvidenceBundleSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const permissionDecisions = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'permission-decisions.jsonl'),
    'records/permission-decisions.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkspacePermissionDecisionSchema.parse(record);

    return ExportedWorkspacePermissionDecisionSchema.parse({
      ...parsed,
      contextSummary: rewriteWorkspaceIdField(
        parsed.contextSummary,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      resourceSummary: rewriteWorkspaceIdField(
        parsed.resourceSummary,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      subjectSummary: rewriteWorkspaceIdField(
        parsed.subjectSummary,
        report.exportedWorkspaceId,
        input.targetWorkspaceId
      ),
      workspaceId: input.targetWorkspaceId,
    });
  });
  const pendingUserTurns = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'pending-user-turns.jsonl'),
    'records/pending-user-turns.jsonl'
  ).map((record) => {
    const parsed = ExportedPendingUserTurnSchema.parse(record);

    return ExportedPendingUserTurnSchema.parse({
      ...parsed,
      pendingTurnId: `${input.targetWorkspaceId}:${parsed.threadId}:${parsed.requestId}`,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const workerCheckpoints = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'worker-turn-checkpoints.jsonl'),
    'records/worker-turn-checkpoints.jsonl'
  ).map((record) => {
    const parsed = ExportedWorkerCheckpointSchema.parse(record);

    return ExportedWorkerCheckpointSchema.parse({
      ...parsed,
      checkpointId: `${input.targetWorkspaceId}:${parsed.threadId}:${parsed.turnId}`,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const goalRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'goal-records.jsonl'),
    'records/goal-records.jsonl'
  ).map((record) => {
    const parsed = ExportedGoalRecordSchema.parse(record);

    return ExportedGoalRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const goalTasks = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'goal-tasks.jsonl'),
    'records/goal-tasks.jsonl'
  ).map((record) => {
    const parsed = ExportedGoalTaskSchema.parse(record);

    return ExportedGoalTaskSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const goalReviewRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'goal-review-records.jsonl'),
    'records/goal-review-records.jsonl'
  ).map((record) => {
    const parsed = ExportedGoalReviewRecordSchema.parse(record);

    return ExportedGoalReviewRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const goalVerificationRecords = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'goal-verification-records.jsonl'),
    'records/goal-verification-records.jsonl'
  ).map((record) => {
    const parsed = ExportedGoalVerificationRecordSchema.parse(record);

    return ExportedGoalVerificationRecordSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });
  const mcpToolSchemaSnapshots = readOptionalImportJsonl(
    join(input.exportRoot, 'records', 'mcp-tool-schema-snapshots.jsonl'),
    'records/mcp-tool-schema-snapshots.jsonl'
  ).map((record) => {
    const parsed = ExportedMcpToolSchemaSnapshotSchema.parse(record);

    return ExportedMcpToolSchemaSnapshotSchema.parse({
      ...parsed,
      workspaceId: input.targetWorkspaceId,
    });
  });

  return {
    report,
    workspace,
    threads,
    knowledge,
    threadItems,
    knowledgeProposals,
    knowledgeProposalReviews,
    knowledgeSources,
    knowledgeSourceMaterials,
    vaultReferences,
    vaultGrants,
    injectionPlans,
    injectionReceipts,
    vaultUseRecords,
    auditEvents,
    capabilityCalls,
    evidenceBundles,
    runtimeEvidence,
    usageRecords,
    dataSourceCatalog,
    gitPushRecords,
    resolvedAgentSetups,
    agentEnvironmentPackageSnapshots,
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
    workspaceSyncEvidenceBundles,
    permissionDecisions,
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
 * Verifies one workspace export tree without consulting source deployment state.
 *
 * @param input Export root and supported feature set.
 * @returns Parsed manifest plus checked file paths.
 * @throws Error when the manifest, inventory, digest, bytes, or file set is invalid.
 */
export function verifyWorkspaceExportTree(
  input: VerifyWorkspaceExportTreeInput
): VerifiedWorkspaceExportTree {
  const manifestPath = join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
  const manifest = parseWorkspaceExportManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), {
    supportedFeatures: input.supportedFeatures ?? [],
  });
  const expected = new Map(manifest.contentInventory.map((entry) => [entry.path, entry]));
  const actual = listRegularExportFiles(input.exportRoot).filter(
    (path) => path !== WORKSPACE_EXPORT_MANIFEST_FILE
  );

  for (const path of actual) {
    if (!expected.has(path)) {
      throw new Error(`Export file missing from inventory: ${path}`);
    }
  }

  for (const entry of manifest.contentInventory) {
    const path = join(input.exportRoot, entry.path);
    const stat = statSync(path);

    if (!stat.isFile()) {
      throw new Error(`Export inventory entry is not a regular file: ${entry.path}`);
    }
    if (stat.size !== entry.bytes) {
      throw new Error(`Size mismatch for export file ${entry.path}`);
    }
    if (digestFile(path) !== entry.digest) {
      throw new Error(`Digest mismatch for export file ${entry.path}`);
    }
  }

  return { manifest, checkedFiles: manifest.contentInventory.map((entry) => entry.path).sort() };
}

/**
 * Rewrites workspace references in evidence bundle refs.
 *
 * @param refs Evidence bundle references from an export.
 * @param sourceWorkspaceId Workspace id recorded in the export.
 * @param targetWorkspaceId Workspace id used for imported records.
 * @returns Evidence refs with direct workspace refs rewritten.
 */
function rewriteEvidenceBundleRefs(
  refs: EvidenceBundleRecord['redactedEvidenceRefs'],
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): EvidenceBundleRecord['redactedEvidenceRefs'] {
  return refs.map((ref) =>
    ref.kind === 'workspace' && ref.ref === sourceWorkspaceId
      ? { ...ref, ref: targetWorkspaceId }
      : ref
  );
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
 * Rewrites the workspace owner inside a redacted Agent Environment Package snapshot.
 *
 * @param value Exported snapshot payload.
 * @param targetWorkspaceId Workspace id used for imported records.
 * @returns Snapshot payload with direct `scope.workspaceId` rewritten when present.
 */
function rewriteAgentEnvironmentPackageSnapshotWorkspace(
  value: unknown,
  targetWorkspaceId: string
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const snapshot = value as Record<string, unknown>;
  const scope = snapshot.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return value;
  }

  return {
    ...snapshot,
    scope: {
      ...scope,
      workspaceId: targetWorkspaceId,
    },
  };
}

/**
 * Maps a resolved setup ledger record to its workspace export wire format.
 *
 * @param value Resolved setup ledger record.
 * @returns Export record whose runtime capability list does not collide with export feature guards.
 */
function toExportedResolvedAgentSetupRecord(value: unknown): unknown {
  const record = value as ResolvedAgentSetupRecord;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    turnId: record.turnId,
    requestId: record.requestId,
    agentId: record.agentId,
    providerId: record.providerId,
    runtimeKind: record.runtimeKind,
    runtimeAdapter: record.runtimeAdapter,
    setupRequiredFeatures: record.requiredFeatures,
    setup: record.setup,
    createdAt: record.createdAt,
  };
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

/**
 * Lists regular files under one export root using slash-separated relative paths.
 *
 * @param root Export root.
 * @param directory Current directory during recursion.
 * @returns Sorted relative file paths.
 */
function listRegularExportFiles(root: string, directory: string = root): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const relativePath = relative(root, path).split(sep).join('/');
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      throw new Error(`Export tree must not contain symlinks: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      files.push(...listRegularExportFiles(root, path));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Export tree contains unsupported file type: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files.sort();
}

/**
 * Computes a SHA-256 content digest for one file.
 *
 * @param path File path.
 * @returns `sha256:` prefixed digest.
 */
function digestFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Writes one JSON file with a trailing newline. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads one JSON file. */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Reads one import JSON record and rejects unsupported record-level features before schema parsing.
 *
 * @param path File system path to the JSON record.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON value.
 * @throws Error when the record declares required features this importer does not support.
 */
function readImportJson(path: string, exportPath: string): unknown {
  const record = readJson(path);
  rejectUnsupportedRecordFeatures(record, exportPath);

  return record;
}

/** Reads one line-oriented JSON file. */
function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as unknown) : [];
}

/**
 * Reads one import JSONL file and rejects unsupported record-level features before schema parsing.
 *
 * @param path File system path to the JSONL record family.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON values.
 * @throws Error when any record declares required features this importer does not support.
 */
function readImportJsonl(path: string, exportPath: string): unknown[] {
  return readJsonl(path).map((record, index) => {
    rejectUnsupportedRecordFeatures(record, `${exportPath}:${index + 1}`);

    return record;
  });
}

/**
 * Reads one optional import JSONL file with record-level required-feature enforcement.
 *
 * @param path File system path to the optional JSONL record family.
 * @param exportPath Export-relative path used in diagnostics.
 * @returns Parsed JSON values, or an empty array when the file is absent.
 * @throws Error when any present record declares required features this importer does not support.
 */
function readOptionalImportJsonl(path: string, exportPath: string): unknown[] {
  return existsSync(path) ? readImportJsonl(path, exportPath) : [];
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

  const supportedRecordFeatures = new Set(['evidence.bundle.v1', 'runtime.evidence.v1']);
  const unsupported = requiredFeatures.filter((feature) => !supportedRecordFeatures.has(feature));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported requiredFeatures in ${exportPath}: ${unsupported.join(', ')}`);
  }
}

/** Writes sorted line-oriented JSON records. */
function writeJsonl(path: string, records: readonly unknown[]): void {
  const lines = [...records]
    .sort((left, right) => recordSortKey(left).localeCompare(recordSortKey(right)))
    .map((record) => JSON.stringify(record));
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

/** Returns a stable-enough sort key for exported JSONL records. */
function recordSortKey(record: unknown): string {
  return typeof record === 'object' && record !== null && 'id' in record
    ? String((record as { id?: unknown }).id ?? '')
    : JSON.stringify(record);
}

/** Computes a SHA-256 content digest for one text payload. */
function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
