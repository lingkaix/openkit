import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  SubscriptionProviderIdSchema as ConfigSubscriptionProviderIdSchema,
  ProviderSubscriptionAccountSlotIdSchema,
} from '@openkit/config-schema/provider-subscription';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as appApiSchemas from './index.js';
import {
  AppDiagnosticsResponseSchema,
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  AppSearchResponseSchema,
  AuthSignInEmailResponseSchema,
  AuthSignOutResponseSchema,
  AuthSignUpEmailResponseSchema,
  AutomationRecordSchema,
  BackendWorkspaceHandleSchema,
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  CancelGoalSteeringRequestSchema,
  CancelGoalSteeringResponseSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ChatModeOutcomeSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  ConvertGoalSteeringToFollowUpRequestSchema,
  ConvertGoalSteeringToFollowUpResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateThreadGoalPlanRequestSchema,
  CreateThreadGoalPlanResponseSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GatewayUsageSummarySchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetGitPushRecordResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  GetWorkspaceMaterialRevisionResponseSchema,
  GitPushRecordSchema,
  GoalReadModelStatusSchema,
  GoalReviewResolutionOutcomeSchema,
  GoalTaskCountsSchema,
  GoalTaskReadModelStatusSchema,
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  KnowledgeClaimSchema,
  KnowledgeConflictSchema,
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
  KnowledgeObservationSchema,
  KnowledgeRetrievalResponseSchema,
  KnowledgeSourceSchema,
  ListAgentCatalogResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  ListArtifactReviewsResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListGitPushRecordsResponseSchema,
  ListHumanAttentionResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListServerVaultUseRecordsResponseSchema,
  ListStagedWorkspaceReviewsResponseSchema,
  ListWorkerOutputManifestsResponseSchema,
  ListWorkspaceApplyPlansResponseSchema,
  ListWorkspaceApplyResultsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspaceMaterialRevisionsResponseSchema,
  ListWorkspaceMaterialsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  PauseThreadGoalRequestSchema,
  PauseThreadGoalResponseSchema,
  PendingGoalSteeringHumanAttentionSourceSchema,
  ProviderRegistryEntrySchema,
  QuickChatRequestSchema,
  QuickChatResponseSchema,
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
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  ResumeThreadGoalRequestSchema,
  ResumeThreadGoalResponseSchema,
  RetrieveKnowledgeRequestSchema,
  RetryInterruptedWorkerCheckpointRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
  ReviseThreadGoalPlanRequestSchema,
  ReviseThreadGoalPlanResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
  RunThreadGoalStepRequestSchema,
  RunThreadGoalStepResponseSchema,
  RunThreadGoalSuperviseStepRequestSchema,
  RunThreadGoalSuperviseStepResponseSchema,
  RunThreadGoalTestSuperviseStepRequestSchema,
  RunThreadGoalTestSuperviseStepResponseSchema,
  RuntimeConfigFileListResponseSchema,
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigReloadResponseSchema,
  RuntimeConfigSchemaCatalogResponseSchema,
  RuntimeConfigStatusSchema,
  RuntimeConfigValidationResponseSchema,
  RuntimeEvidenceRecordSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  SetupDiagnosticsResponseSchema,
  SetWorkspaceRepositoryResponseSchema,
  StagedWorkspaceReviewSchema,
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
  SubmitTurnFeedbackRequestSchema,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  TaskModeAttemptStateSchema,
  TaskModeWorkerTargetSchema,
  ThreadGoalPlanSchema,
  ThreadGoalSummaryResponseSchema,
  TurnFeedbackResponseSchema,
  UnbindThreadMaterialRequestSchema,
  UnbindThreadMaterialResponseSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminLockResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  VaultAdminStatusResponseSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminUnlockResponseSchema,
  WorkerOutputManifestSchema,
  WorkerRecoveryStageSchema,
  WorkspaceApplyPlanSchema,
  WorkspaceChangeSetSchema,
  WorkspaceDashboardResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
  WorkspaceQuarantineRecordSchema,
  WorkspaceReconciliationRecordSchema,
  WorkspaceRecoveryDecisionSchema,
  WorkspaceRepositoryDiagnosticsResponseSchema,
  WorkspaceRepositoryResourceSchema,
} from './index.js';

const timestamp = '2026-05-15T05:17:42.000Z';

/**
 * Returns whether a JSON-compatible value contains a key at any depth.
 *
 * @param value Nested JSON value.
 * @param key Property name to search for.
 * @returns True when the key appears recursively.
 */
function jsonContainsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsKey(item, key));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([entryKey, nested]) => entryKey === key || jsonContainsKey(nested, key)
    );
  }
  return false;
}
const retrievalTraceId = 'krt_123e4567-e89b-42d3-a456-426614174000';
const knowledgeSourceReference = `source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:${'1'.repeat(64)}`;
const knowledgePageId = 'lessons/release-review';
const canonicalKnowledgePageBytes = [
  '---',
  'type: "KnowledgePage"',
  'title: "Release review"',
  'schema_version: "openkit-workspace-knowledge-schema-v1"',
  'status: "active"',
  'scope: "workspace"',
  `source_refs: ${JSON.stringify([knowledgeSourceReference])}`,
  'review_state: "accepted"',
  'sensitivity: "normal"',
  'freshness: "current"',
  `created_at: ${JSON.stringify(timestamp)}`,
  `updated_at: ${JSON.stringify(timestamp)}`,
  'openkit_entry_kind: "project-context"',
  `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
  '---',
  'Release reviews happen every Friday.',
  '',
].join('\n');
const knowledgeContentDigest = `sha256:${createHash('sha256')
  .update(canonicalKnowledgePageBytes)
  .digest('hex')}`;
const knowledgeProposalDigest = `sha256:${'2'.repeat(64)}`;
const knowledgeProposalDraftRequest = {
  requestId: '00000000-0000-4000-8000-000000000601',
  knowledgePageId,
  canonicalPageBytes: canonicalKnowledgePageBytes,
  contentDigest: knowledgeContentDigest,
  sourceReferences: [knowledgeSourceReference],
  rationale: 'This completed-work evidence supports one reusable release-review rule.',
  confidence: 0.75,
};
const rawSecretShapes = [
  'sk-openkit-secret',
  'hf_openkit_secret',
  'ghp_openkit_secret',
  'okt_openkit_secret',
] as const;
const schemaSourceRoot = new URL('.', import.meta.url);
const allowedRuntimeNeutralImports = new Set([
  '@openkit/config-schema',
  '@openkit/config-schema/provider-subscription',
  '@openkit/config-schema/workspace-export',
  '@openkit/protocol',
  'zod',
]);

/** Lists package source files that define runtime App API schemas. */
function listSchemaSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) {
      return listSchemaSourceFiles(path);
    }

    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Extracts static module specifiers from TypeScript source imports. */
function staticImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport(?:\s+type)?(?:\s+[^'"]+\s+from)?\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1]
  );
}

/** Returns true when an App API schema import is runtime-neutral. */
function isRuntimeNeutralSchemaImport(specifier: string): boolean {
  return specifier.startsWith('./') || allowedRuntimeNeutralImports.has(specifier);
}

describe('app api schema package boundary', () => {
  it('depends only on runtime-neutral schema dependencies', () => {
    const offenders = listSchemaSourceFiles(schemaSourceRoot.pathname).flatMap((path) => {
      const disallowedImports = staticImportSpecifiers(readFileSync(path, 'utf8')).filter(
        (specifier) => !isRuntimeNeutralSchemaImport(specifier)
      );

      return disallowedImports.map((specifier) => ({ path, specifier }));
    });

    expect(offenders).toEqual([]);
  });

  it('exports the closed provider-subscription identifier schema from the package root', () => {
    const schema = Reflect.get(appApiSchemas, 'SubscriptionProviderIdSchema');

    expect(schema).toBeDefined();
    expect(schema.options).toEqual(['openai-codex', 'xai']);
    expect(schema.parse('openai-codex')).toBe('openai-codex');
    expect(schema.parse('xai')).toBe('xai');
    expect(schema.safeParse('anthropic').success).toBe(false);
  });

  it('reuses the config-schema provider-subscription identity across public account schemas', () => {
    expect
      .soft(appApiSchemas.SubscriptionProviderIdSchema, 'package root')
      .toBe(ConfigSubscriptionProviderIdSchema);
    for (const branch of appApiSchemas.ProviderSubscriptionAccountSchema.options) {
      expect
        .soft(branch.shape.subscriptionProviderId, `account status ${branch.shape.status.value}`)
        .toBe(ConfigSubscriptionProviderIdSchema);
    }
  });

  it('reuses the config-schema account-slot identity across public account schemas', () => {
    expect
      .soft(
        appApiSchemas.CreateProviderSubscriptionAccountRequestSchema.shape.accountSlotId,
        'create request'
      )
      .toBe(ProviderSubscriptionAccountSlotIdSchema);
    for (const branch of appApiSchemas.ProviderSubscriptionAccountSchema.options) {
      expect
        .soft(branch.shape.accountSlotId, `account status ${branch.shape.status.value}`)
        .toBe(ProviderSubscriptionAccountSlotIdSchema);
    }
    for (const branch of appApiSchemas.ProviderSubscriptionQuotaSchema.options) {
      expect
        .soft(branch.shape.accountSlotId, `quota ${branch.shape.availability.value}`)
        .toBe(ProviderSubscriptionAccountSlotIdSchema);
    }
  });
});

describe('S16 Material and Artifact Review schemas', () => {
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const material = {
    workspaceId: 'ws_demo',
    materialId: 'material_demo',
    title: 'Working notes',
    kind: 'markdown',
    currentRevisionId: 'revision_1',
    sensitivity: 'internal',
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const revisionSummary = {
    workspaceId: 'ws_demo',
    materialId: 'material_demo',
    revisionId: 'revision_1',
    parentRevisionId: null,
    mediaType: 'text/markdown',
    contentDigest,
    authorId: 'user_demo',
    createdAt: timestamp,
  } as const;
  const unresolvedReview = {
    workspaceId: 'ws_demo',
    reviewId: 'artifact_review_demo',
    artifactId: 'artifact_demo',
    artifactVersion: 1,
    contentDigest,
    sourceThreadId: 'thread_demo',
    sourceTurnId: 'turn_demo',
    sourceAgentId: 'agent_demo',
    materialProposal: null,
    decision: null,
    decisionActorId: null,
    feedback: null,
    decidedAt: null,
    followUpTurnId: null,
    appliedMaterialRevisionId: null,
    createdAt: timestamp,
  } as const;

  it('accepts only the 15 closed operation success identities', () => {
    const responses = [
      [ImportWorkspaceArtifactResponseSchema, { artifactId: 'artifact_demo', artifactVersion: 1 }],
      [
        IntroduceWorkspaceArtifactResponseSchema,
        {
          artifactId: 'artifact_demo',
          artifactVersion: 1,
          turnId: 'turn_demo',
          itemId: 'item_demo',
        },
      ],
      [ListArtifactReviewsResponseSchema, { reviews: [unresolvedReview] }],
      [
        SubmitArtifactReviewDecisionResponseSchema,
        {
          reviewId: 'artifact_review_demo',
          artifactId: 'artifact_demo',
          artifactVersion: 1,
          decision: 'accepted',
          followUpTurnId: null,
        },
      ],
      [ListWorkspaceMaterialsResponseSchema, { materials: [material] }],
      [CreateWorkspaceMaterialResponseSchema, { materialId: 'material_demo' }],
      [GetWorkspaceMaterialResponseSchema, { material }],
      [ListWorkspaceMaterialRevisionsResponseSchema, { revisions: [revisionSummary] }],
      [
        SaveWorkspaceMaterialRevisionResponseSchema,
        { materialId: 'material_demo', revisionId: 'revision_1' },
      ],
      [
        GetWorkspaceMaterialRevisionResponseSchema,
        { revision: { ...revisionSummary, content: '# Working notes' } },
      ],
      [
        GetThreadMaterialResponseSchema,
        {
          material: {
            workspaceId: 'ws_demo',
            threadId: 'thread_demo',
            resource: material,
            currentRevision: revisionSummary,
            inclusionState: 'included',
            latestQueuedRevisionId: 'revision_1',
            lastWorkerSeenRevisionId: null,
            currentTurnRevisionId: null,
            activeDelivery: {
              state: 'queued',
              pendingTurnId: 'turn_pending',
              requestId: 'request_steering',
              contentItemId: 'item_steering',
              goalId: 'goal_demo',
              activeTurnId: 'turn_active',
              materialId: 'material_demo',
              revisionId: 'revision_1',
              contentDigest,
            },
          },
        },
      ],
      [
        BindThreadMaterialResponseSchema,
        { materialId: 'material_demo', threadId: 'thread_demo', outcome: 'bound' },
      ],
      [
        UnbindThreadMaterialResponseSchema,
        { materialId: 'material_demo', threadId: 'thread_demo', outcome: 'unbound' },
      ],
      [
        ExcludeThreadMaterialResponseSchema,
        { materialId: 'material_demo', threadId: 'thread_demo', outcome: 'excluded' },
      ],
      [
        RestoreThreadMaterialResponseSchema,
        { materialId: 'material_demo', threadId: 'thread_demo', outcome: 'included' },
      ],
    ] as const;

    for (const [schema, response] of responses) {
      expect(schema.safeParse(response).success).toBe(true);
      expect(
        schema.safeParse({ ...response, workspaceId: 'path_id_is_not_a_body_field' }).success
      ).toBe(false);
    }
    expect(GetThreadMaterialResponseSchema.safeParse({ material: null }).success).toBe(true);
    expect(
      GetThreadMaterialResponseSchema.safeParse({
        material: {
          workspaceId: 'ws_demo',
          threadId: 'thread_demo',
          resource: material,
          currentRevision: revisionSummary,
          inclusionState: 'included',
          latestQueuedRevisionId: 'revision_1',
          lastWorkerSeenRevisionId: null,
          currentTurnRevisionId: null,
          activeDelivery: {
            state: 'queued',
            pendingTurnId: 'turn_pending',
            requestId: 'import-lineage:reserved',
            contentItemId: 'item_steering',
            goalId: 'goal_demo',
            activeTurnId: 'turn_active',
            materialId: 'material_demo',
            revisionId: 'revision_1',
            contentDigest,
          },
        },
      }).success
    ).toBe(false);
    expect(
      ImportWorkspaceArtifactResponseSchema.safeParse({
        artifactId: 'artifact_demo',
        artifactVersion: 2,
      }).success
    ).toBe(false);
  });

  it('keeps public views closed and excludes owner-only request proof', () => {
    expect(
      GetWorkspaceMaterialResponseSchema.safeParse({
        material: { ...material, lastMutationRequestId: 'request_owner_only' },
      }).success
    ).toBe(false);
    expect(
      ListWorkspaceMaterialRevisionsResponseSchema.safeParse({
        revisions: [{ ...revisionSummary, createdByRequestId: 'request_owner_only' }],
      }).success
    ).toBe(false);
    expect(
      ListArtifactReviewsResponseSchema.safeParse({
        reviews: [{ ...unresolvedReview, decisionRequestId: 'request_owner_only' }],
      }).success
    ).toBe(false);
  });

  it('accepts only the six exact Material mutation bodies', () => {
    const mutations = [
      [
        CreateWorkspaceMaterialRequestSchema,
        {
          requestId: 'request_create',
          title: 'Working notes',
          kind: 'markdown',
          sensitivity: 'internal',
        },
        'workspaceId',
      ],
      [
        SaveWorkspaceMaterialRevisionRequestSchema,
        {
          requestId: 'request_save',
          expectedRevisionId: null,
          contentDigest,
          content: '# Working notes',
        },
        'materialId',
      ],
      [
        BindThreadMaterialRequestSchema,
        { requestId: 'request_bind', expectedBindingState: 'not_bound' },
        'threadId',
      ],
      [
        UnbindThreadMaterialRequestSchema,
        { requestId: 'request_unbind', expectedBindingState: 'bound' },
        'materialId',
      ],
      [
        ExcludeThreadMaterialRequestSchema,
        {
          requestId: 'request_exclude',
          expectedBindingState: 'bound',
          expectedInclusionState: 'included',
          expectedQueuedRevisionId: 'revision_1',
        },
        'workspaceId',
      ],
      [
        RestoreThreadMaterialRequestSchema,
        {
          requestId: 'request_restore',
          expectedBindingState: 'bound',
          expectedInclusionState: 'excluded',
        },
        'threadId',
      ],
    ] as const;

    for (const [schema, request, pathField] of mutations) {
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({ ...request, [pathField]: 'duplicated_path_id' }).success).toBe(
        false
      );
      expect(schema.safeParse({ ...request, requestId: 'import-lineage:reserved' }).success).toBe(
        false
      );
    }

    for (const removedLiteral of ['absent', 'unbound']) {
      expect(
        BindThreadMaterialRequestSchema.safeParse({
          requestId: 'request_bind',
          expectedBindingState: removedLiteral,
        }).success
      ).toBe(false);
    }
  });

  it('requires an explicit nullable expected revision and lowercase sha256 digests', () => {
    const request = {
      requestId: 'request_save',
      expectedRevisionId: null,
      contentDigest,
      content: '# Working notes',
    } as const;

    expect(SaveWorkspaceMaterialRevisionRequestSchema.safeParse(request).success).toBe(true);
    expect(
      SaveWorkspaceMaterialRevisionRequestSchema.safeParse({
        ...request,
        expectedRevisionId: 'revision_1',
      }).success
    ).toBe(true);
    expect(
      SaveWorkspaceMaterialRevisionRequestSchema.safeParse({
        requestId: request.requestId,
        contentDigest,
        content: request.content,
      }).success
    ).toBe(false);
    for (const invalidDigest of [`sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`]) {
      expect(
        SaveWorkspaceMaterialRevisionRequestSchema.safeParse({
          ...request,
          contentDigest: invalidDigest,
        }).success
      ).toBe(false);
    }
  });

  it('enforces Artifact request strictness and Review decision coherence', () => {
    const requests = [
      [
        ImportWorkspaceArtifactRequestSchema,
        {
          requestId: 'request_import',
          title: 'Imported notes',
          mediaType: 'text/markdown',
          contentDigest,
          content: '# Imported notes',
        },
        'workspaceId',
      ],
      [
        IntroduceWorkspaceArtifactRequestSchema,
        { requestId: 'request_introduce', expectedArtifactVersion: 1 },
        'artifactId',
      ],
      [
        SubmitArtifactReviewDecisionRequestSchema,
        { requestId: 'request_review', decision: 'accepted' },
        'artifactVersion',
      ],
    ] as const;

    for (const [schema, request, pathField] of requests) {
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({ ...request, [pathField]: 'duplicated_path_id' }).success).toBe(
        false
      );
    }
    for (const [content, expected] of [
      ['{"valid":true}', true],
      ['{"invalid":', false],
    ] as const) {
      expect(
        ImportWorkspaceArtifactRequestSchema.safeParse({
          ...requests[0][1],
          mediaType: 'application/json',
          content,
        }).success
      ).toBe(expected);
    }
    expect(
      ImportWorkspaceArtifactRequestSchema.safeParse({
        ...requests[0][1],
        content: '',
      }).success
    ).toBe(false);
    expect(
      SubmitArtifactReviewDecisionRequestSchema.safeParse({
        requestId: 'import-lineage:reserved',
        decision: 'accepted',
      }).success
    ).toBe(false);
    for (const request of [
      { requestId: 'request_refine', decision: 'needs_refinement' },
      { requestId: 'request_redo', decision: 'redo', feedback: '' },
      { requestId: 'request_reject', decision: 'rejected', feedback: '' },
    ]) {
      expect(SubmitArtifactReviewDecisionRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(
      SubmitArtifactReviewDecisionRequestSchema.safeParse({
        requestId: 'request_refine',
        decision: 'needs_refinement',
        feedback: 'Keep the previous attempt and revise the proposal.',
      }).success
    ).toBe(true);

    const decidedReview = {
      ...unresolvedReview,
      decision: 'needs_refinement',
      decisionActorId: 'user_demo',
      feedback: 'Revise the proposal.',
      decidedAt: timestamp,
      followUpTurnId: 'turn_follow_up',
    } as const;
    expect(ListArtifactReviewsResponseSchema.safeParse({ reviews: [decidedReview] }).success).toBe(
      true
    );
    const acceptedProposalReview = {
      ...unresolvedReview,
      materialProposal: {
        materialId: 'material_demo',
        baseRevisionId: 'revision_1',
        baseContentDigest: contentDigest,
      },
      decision: 'accepted',
      decisionActorId: 'user_demo',
      decidedAt: timestamp,
      appliedMaterialRevisionId: 'revision_2',
    } as const;
    expect(
      ListArtifactReviewsResponseSchema.safeParse({ reviews: [acceptedProposalReview] }).success
    ).toBe(true);
    for (const review of [
      { ...decidedReview, feedback: null },
      { ...decidedReview, followUpTurnId: null },
      { ...decidedReview, appliedMaterialRevisionId: 'revision_2' },
      { ...acceptedProposalReview, appliedMaterialRevisionId: null },
      { ...unresolvedReview, decidedAt: timestamp },
    ]) {
      expect(ListArtifactReviewsResponseSchema.safeParse({ reviews: [review] }).success).toBe(
        false
      );
    }
    expect(
      SubmitArtifactReviewDecisionResponseSchema.safeParse({
        reviewId: 'artifact_review_demo',
        artifactId: 'artifact_demo',
        artifactVersion: 1,
        decision: 'accepted',
        followUpTurnId: 'turn_not_allowed',
      }).success
    ).toBe(false);
  });
});

function runtimeConfigStatus(): unknown {
  return {
    currentVersion: 1,
    loadedAt: timestamp,
    lastReload: null,
    lastFailedReload: null,
    pendingRestart: [],
  };
}

function runtimeConfigPlan(): unknown {
  return {
    previousVersion: 1,
    nextVersion: 2,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [],
    warnings: [],
  };
}

function defaultProviders(): unknown {
  return {
    core: {
      configured: false,
      origin: 'unset',
      reason: 'unset',
    },
    gateway: {
      configured: false,
      origin: 'unset',
      reason: 'unset',
    },
  };
}

/** Builds one valid App Diagnostics payload. */
function appDiagnosticsPayload(): Record<string, unknown> {
  return {
    service: 'nanocore',
    boot: bootReadiness(),
    gateway: { status: 'ok', endpoints: ['/health'] },
    providers: { diagnostics: [], registry: [] },
    defaultProviders: defaultProviders(),
    defaults: {
      quickChat: { providerId: null, model: null },
      gateway: { providerId: null, model: null },
    },
    capabilities: ['core.stream.replay'],
    runtimeConfig: runtimeConfigStatus(),
  };
}

function bootReadiness(): Record<string, unknown> {
  return {
    bootId: 'boot_demo',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: { state: 'ready', reasons: [] },
      storage: { state: 'ready', reasons: [] },
      policy: { state: 'ready', reasons: [] },
      vault: { state: 'ready', reasons: [] },
      scheduler: { state: 'ready', reasons: [] },
      llmGateway: { state: 'ready', reasons: [] },
      knowledgeIndex: { state: 'ready', reasons: [] },
    },
  };
}

function setupDiagnosticsPayload(): Record<string, unknown> {
  return {
    service: 'nanocore',
    server: {
      mode: 'local',
      dataRoot: 'configured',
      config: {
        schemaVersion: 1,
        defaults: { coreProviderId: null, gatewayProviderId: null },
        gateway: {
          openaiCompatible: {
            auth: { configured: false, marker: 'none', ref: null },
            defaultModel: null,
            defaultProviderId: null,
            enabled: true,
            route: '/v1',
          },
        },
      },
    },
    providers: [],
    agents: [],
    runtimeConfig: runtimeConfigStatus(),
  };
}

function runtimeConfigReloadResponse(): Record<string, unknown> {
  return {
    status: 'applied',
    runtimeConfig: runtimeConfigStatus(),
    plan: runtimeConfigPlan(),
  };
}

function runtimeConfigValidationResponse(): Record<string, unknown> {
  return {
    valid: true,
    diagnostics: [],
    plan: runtimeConfigPlan(),
    runtimeConfig: runtimeConfigStatus(),
  };
}

describe('app api schemas', () => {
  it('accepts knowledge source registration and read payloads', () => {
    const source = {
      id: 'ks_demo',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      contentDigest: 'sha256:abc123',
      originatingThreadId: 'th_demo',
      originatingTurnId: 'turn_demo',
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(
      RegisterKnowledgeSourceRequestSchema.parse({
        requestId: 'req_source',
        kind: 'document',
        title: 'Release notes',
        uri: 'file://release.md',
        content: 'Release cadence is weekly.',
        originatingThreadId: 'th_demo',
        originatingTurnId: 'turn_demo',
      })
    ).toMatchObject({ kind: 'document', requestId: 'req_source' });
    expect(KnowledgeSourceSchema.parse(source)).toEqual(source);
    const derivedRepresentation = {
      id: 'ks_demo:text',
      workspaceId: 'ws_demo',
      sourceId: 'ks_demo',
      kind: 'text',
      path: 'sources/derived/ks_demo/text.json',
      materialPath: 'sources/materials/ks_demo/content.txt',
      contentDigest: 'sha256:abc123',
      sourceContentDigest: 'sha256:abc123',
      createdAt: timestamp,
    };

    expect(
      RegisterKnowledgeSourceResponseSchema.parse({
        source,
        derivedRepresentations: [derivedRepresentation],
      })
    ).toEqual({ source, derivedRepresentations: [derivedRepresentation] });
    expect(
      ReadKnowledgeSourceResponseSchema.parse({
        source,
        derivedRepresentations: [derivedRepresentation],
      })
    ).toEqual({ source, derivedRepresentations: [derivedRepresentation] });
    expect(ListKnowledgeSourcesResponseSchema.parse({ items: [source] })).toEqual({
      items: [source],
    });
  });

  it('accepts Knowledge Store observation ledger payloads', () => {
    const observation = {
      id: 'ko_demo',
      workspaceId: 'ws_demo',
      kind: 'retrieval',
      summary: 'Worker repeatedly needed release cadence context.',
      sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
      scope: 'workspace',
      producer: 'knowledge-manager',
      confidence: 0.75,
      freshness: 'current',
      status: 'retained',
      observedAt: timestamp,
      createdAt: timestamp,
    };

    expect(
      RecordKnowledgeObservationRequestSchema.parse({
        requestId: 'req_observation',
        kind: 'retrieval',
        summary: observation.summary,
        sourceReferences: observation.sourceReferences,
        confidence: observation.confidence,
        producer: observation.producer,
      })
    ).toMatchObject({ kind: 'retrieval', requestId: 'req_observation' });
    expect(KnowledgeObservationSchema.parse(observation)).toEqual(observation);
    expect(RecordKnowledgeObservationResponseSchema.parse({ observation })).toEqual({
      observation,
    });
    expect(ListKnowledgeObservationsResponseSchema.parse({ items: [observation] })).toEqual({
      items: [observation],
    });
  });

  it('accepts Knowledge Store claim ledger payloads', () => {
    const claim = {
      id: 'kc_demo',
      workspaceId: 'ws_demo',
      statement: 'Release cadence is weekly.',
      sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
      scope: 'workspace',
      producer: 'knowledge-manager',
      confidence: 0.8,
      freshness: 'current',
      reviewState: 'needs-review',
      conflictStatus: 'none',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(
      RecordKnowledgeClaimRequestSchema.parse({
        requestId: 'req_claim',
        statement: claim.statement,
        sourceReferences: claim.sourceReferences,
        producer: claim.producer,
        confidence: claim.confidence,
      })
    ).toEqual({
      requestId: 'req_claim',
      statement: claim.statement,
      sourceReferences: claim.sourceReferences,
      scope: 'workspace',
      producer: claim.producer,
      confidence: claim.confidence,
      freshness: 'current',
      reviewState: 'needs-review',
      conflictStatus: 'none',
    });
    expect(KnowledgeClaimSchema.parse(claim)).toEqual(claim);
    expect(RecordKnowledgeClaimResponseSchema.parse({ claim })).toEqual({ claim });
    expect(ListKnowledgeClaimsResponseSchema.parse({ items: [claim] })).toEqual({
      items: [claim],
    });
  });

  it('accepts Knowledge Store conflict ledger payloads', () => {
    const conflict = {
      id: 'kf_demo',
      workspaceId: 'ws_demo',
      subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
      sourceReferences: ['source:ks_release', 'source:ks_correction'],
      status: 'conflicting',
      summary: 'Release cadence has contradictory source evidence.',
      suggestedActions: ['Ask the user which source is authoritative.'],
      producer: 'knowledge-manager',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(
      RecordKnowledgeConflictRequestSchema.parse({
        requestId: 'req_conflict',
        subjectReferences: conflict.subjectReferences,
        sourceReferences: conflict.sourceReferences,
        summary: conflict.summary,
        producer: conflict.producer,
      })
    ).toEqual({
      requestId: 'req_conflict',
      subjectReferences: conflict.subjectReferences,
      sourceReferences: conflict.sourceReferences,
      status: 'conflicting',
      summary: conflict.summary,
      suggestedActions: [],
      producer: conflict.producer,
    });
    expect(() =>
      RecordKnowledgeConflictRequestSchema.parse({
        requestId: 'req_conflict_resolved',
        subjectReferences: conflict.subjectReferences,
        status: 'resolved',
        summary: conflict.summary,
        producer: conflict.producer,
      })
    ).toThrow();
    expect(KnowledgeConflictSchema.parse(conflict)).toEqual(conflict);
    expect(RecordKnowledgeConflictResponseSchema.parse({ conflict })).toEqual({ conflict });
    expect(ListKnowledgeConflictsResponseSchema.parse({ items: [conflict] })).toEqual({
      items: [conflict],
    });

    const resolvedConflict = {
      ...conflict,
      status: 'resolved',
      resolution: 'Friday release reviews are authoritative.',
      resolvedAt: timestamp,
      resolvedBy: 'knowledge-manager',
      updatedAt: timestamp,
    };

    expect(
      ResolveKnowledgeConflictRequestSchema.parse({
        requestId: 'req_resolve_conflict',
        status: 'resolved',
        resolution: resolvedConflict.resolution,
        resolvedBy: resolvedConflict.resolvedBy,
      })
    ).toEqual({
      requestId: 'req_resolve_conflict',
      status: 'resolved',
      resolution: resolvedConflict.resolution,
      resolvedBy: resolvedConflict.resolvedBy,
    });
    expect(ResolveKnowledgeConflictResponseSchema.parse({ conflict: resolvedConflict })).toEqual({
      conflict: resolvedConflict,
    });
  });

  it('accepts Knowledge Store retrieval trace payloads', () => {
    const selected = {
      knowledgePageId: 'release-plan',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      score: 4,
      sourceReferences: ['source:ks_demo'],
    };
    const excluded = {
      knowledgePageId: 'old-plan',
      contentDigest: null,
      reason: 'source_unavailable',
    };
    const response = {
      traceId: retrievalTraceId,
      workspaceId: 'ws_demo',
      caller: 'assistant',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      retrievalParameters: {
        limit: 3,
        pinnedConceptIds: ['release-plan'],
      },
      selected: [selected],
      excluded: [excluded],
      createdAt: timestamp,
    } as const;

    expect(
      RetrieveKnowledgeRequestSchema.parse({
        query: 'release cadence',
        limit: 3,
        pinnedConceptIds: ['release-plan'],
      })
    ).toEqual({
      query: 'release cadence',
      limit: 3,
      pinnedConceptIds: ['release-plan'],
    });
    expect(KnowledgeRetrievalResponseSchema.parse(response)).toEqual(response);
    expect(KnowledgeRetrievalResponseSchema.parse({ ...response, caller: 'task-mode' })).toEqual({
      ...response,
      caller: 'task-mode',
    });
    expect(KnowledgeRetrievalResponseSchema.parse({ ...response, caller: 'app-api' })).toEqual({
      ...response,
      caller: 'app-api',
    });
    expect(() =>
      KnowledgeRetrievalResponseSchema.parse({ ...response, caller: 'workflow-coordinator' })
    ).toThrow();
    expect(() =>
      KnowledgeRetrievalResponseSchema.parse({ ...response, query: 'release cadence' })
    ).toThrow();

    for (const legacyFields of [
      { matchedTerms: ['release', 'cadence'] },
      { path: 'knowledge/pages/release-plan.md' },
      { title: 'Release plan' },
    ]) {
      expect(() =>
        KnowledgeRetrievalResponseSchema.parse({
          ...response,
          selected: [{ ...selected, ...legacyFields }],
        })
      ).toThrow();
    }

    for (const legacyFields of [
      { path: 'knowledge/pages/old-plan.md' },
      { title: 'Old plan' },
      { detail: 'The source page was unavailable.' },
    ]) {
      expect(() =>
        KnowledgeRetrievalResponseSchema.parse({
          ...response,
          excluded: [{ ...excluded, ...legacyFields }],
        })
      ).toThrow();
    }
  });

  it('accepts Knowledge Store derived index payloads', () => {
    expect(
      KnowledgeDerivedIndexesResponseSchema.parse({
        linkGraph: {
          schemaVersion: 1,
          workspaceId: 'ws_demo',
          rebuiltAt: timestamp,
          edges: [
            {
              fromId: 'alpha',
              target: '/beta.md',
              toId: 'beta',
              resolved: true,
            },
          ],
        },
        validation: {
          schemaVersion: 1,
          workspaceId: 'ws_demo',
          rebuiltAt: timestamp,
          records: [
            {
              conceptId: 'alpha',
              path: 'knowledge/pages/alpha.md',
              title: 'Alpha',
              conformance: 'Workspace-schema-valid',
              active: true,
              indexed: true,
              errors: [],
            },
            {
              conceptId: 'missing-source',
              path: 'knowledge/pages/missing-source.md',
              conformance: 'Workspace-schema-valid',
              active: true,
              indexed: false,
              errors: [
                {
                  code: 'reference.unresolved_source',
                  field: 'source_refs',
                  message: 'Knowledge source reference source:ks_missing does not resolve.',
                },
              ],
            },
          ],
        },
        sourceReferences: {
          schemaVersion: 1,
          workspaceId: 'ws_demo',
          rebuiltAt: timestamp,
          references: [
            {
              conceptId: 'alpha',
              path: 'knowledge/pages/alpha.md',
              reference: 'source:ks_demo',
              kind: 'registered-source',
              targetId: 'ks_demo',
              resolved: true,
            },
            {
              conceptId: 'missing-source',
              path: 'knowledge/pages/missing-source.md',
              reference: 'source:ks_missing',
              kind: 'registered-source',
              targetId: 'ks_missing',
              resolved: false,
            },
          ],
        },
        fullText: {
          schemaVersion: 1,
          workspaceId: 'ws_demo',
          rebuiltAt: timestamp,
          tokenizer: 'unicode-simple-v1',
          terms: [
            {
              term: 'alpha',
              postings: [
                {
                  conceptId: 'alpha',
                  fields: ['title', 'body'],
                  occurrences: 2,
                },
              ],
            },
          ],
        },
      })
    ).toMatchObject({
      linkGraph: { edges: [{ fromId: 'alpha', resolved: true }] },
      validation: {
        records: expect.arrayContaining([
          expect.objectContaining({ conceptId: 'alpha', indexed: true }),
        ]),
      },
      sourceReferences: {
        references: expect.arrayContaining([
          expect.objectContaining({ reference: 'source:ks_demo', resolved: true }),
        ]),
      },
      fullText: {
        tokenizer: 'unicode-simple-v1',
        terms: [{ term: 'alpha', postings: [{ conceptId: 'alpha' }] }],
      },
    });
  });

  it('accepts Knowledge Manager answer requests and cited responses', () => {
    expect(
      KnowledgeManagerAnswerRequestSchema.parse({
        query: 'release cadence',
      })
    ).toEqual({ query: 'release cadence' });

    expect(
      KnowledgeManagerAnswerResponseSchema.parse({
        operationId: 'km_answer_demo',
        operation: 'answer',
        workspaceId: 'ws_demo',
        caller: 'assistant',
        retrievalTraceId,
        query: 'release cadence',
        outcome: 'answered',
        answer: 'Release cadence is weekly.',
        citations: [
          {
            knowledgeEntryId: 'mem_demo',
            kind: 'project-context',
            title: 'Release plan',
            excerpt: 'Release cadence is weekly.',
          },
        ],
        confidence: 0.65,
        uncertainty: null,
      })
    ).toMatchObject({
      operation: 'answer',
      outcome: 'answered',
      retrievalTraceId,
      citations: [{ knowledgeEntryId: 'mem_demo' }],
    });
  });

  it('accepts only bounded Knowledge Manager context retrieval requests', () => {
    expect(
      KnowledgeManagerPrepareContextRequestSchema.parse({
        query: 'release cadence',
        limit: 5,
      })
    ).toEqual({
      query: 'release cadence',
      limit: 5,
    });
    expect(KnowledgeManagerPrepareContextRequestSchema.parse({ query: 'release cadence' })).toEqual(
      {
        query: 'release cadence',
      }
    );

    expect(
      KnowledgeManagerPrepareContextRequestSchema.safeParse({
        query: 'release cadence',
        artifactIds: ['artifact_release_log'],
      }).success
    ).toBe(false);
  });

  it('accepts only narrow Knowledge Manager context retrieval responses', () => {
    const response = {
      operationId: 'km_context_demo',
      operation: 'prepare-context-material' as const,
      workspaceId: 'ws_demo',
      caller: 'app-api' as const,
      retrievalTraceId,
      outcome: 'prepared' as const,
      selected: [
        {
          knowledgePageId: 'kn_demo',
          contentDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          score: 3,
          sourceReferences: ['source:ks_release'],
        },
      ],
      excluded: [
        {
          knowledgePageId: 'kn_expired',
          contentDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          reason: 'freshness_expired' as const,
        },
        {
          knowledgePageId: 'kn_missing',
          contentDigest: null,
          reason: 'source_unavailable' as const,
        },
      ],
    };

    expect(KnowledgeManagerPrepareContextResponseSchema.parse(response)).toEqual(response);
    expect(
      KnowledgeManagerPrepareContextResponseSchema.safeParse({
        ...response,
        packageTrace: {},
      }).success
    ).toBe(false);
  });

  it('does not export standalone Knowledge context trace or materialization schemas', () => {
    for (const exportName of [
      'KnowledgeManagerWorkspaceRootFileRequestSchema',
      'KnowledgeManagerContextTraceSchema',
      'KnowledgeManagerContextMaterialSchema',
      'KnowledgeManagerContextExclusionSchema',
      'KnowledgeManagerContextPackageBudgetSchema',
      'KnowledgeManagerContextPackageTraceSchema',
      'KnowledgeManagerContextPolicySchema',
      'KnowledgeManagerWorkspaceFileSchema',
      'KnowledgeManagerWorkspaceRootFileSchema',
      'KnowledgeManagerContextPackageTraceRecordSchema',
      'ReadKnowledgeManagerContextPackageTraceResponseSchema',
      'WorkerContextPackageMaterializedFileSchema',
      'WorkerContextPackageSensitivityLabelSchema',
      'WorkerContextPackageManifestEntrySchema',
      'WorkerContextPackageBudgetSchema',
      'WorkerContextPackageManifestSchema',
      'MaterializeKnowledgeContextPackageResponseSchema',
    ]) {
      expect(appApiSchemas).not.toHaveProperty(exportName);
    }
  });

  it('accepts Knowledge Manager proposal draft requests and responses', () => {
    const request = knowledgeProposalDraftRequest;

    expect(KnowledgeManagerDraftProposalRequestSchema.parse(request)).toEqual(request);
    expect(
      KnowledgeManagerDraftProposalRequestSchema.safeParse({
        ...request,
        sourceReferences: [
          `context-package:turn_demo@ctxpkg_sha256_${'a'.repeat(64)}`,
          'item:item_demo',
          'turn:turn_demo',
        ],
      }).success
    ).toBe(true);
    expect(
      KnowledgeManagerDraftProposalRequestSchema.safeParse({
        ...request,
        sourceReferences: [
          `context-package:turn_demo@sha256:${'a'.repeat(64)}`,
          'item:item_demo',
          'turn:turn_demo',
        ],
      }).success
    ).toBe(false);

    const response = {
      operationId: 'km_proposal_demo',
      operation: 'draft-proposal' as const,
      workspaceId: 'ws_demo',
      caller: 'app-api' as const,
      proposal: {
        id: 'kp_demo',
        workspaceId: 'ws_demo',
        operation: 'create' as const,
        knowledgePageId: request.knowledgePageId,
        canonicalPageBytes: request.canonicalPageBytes,
        contentDigest: request.contentDigest,
        sourceReferences: request.sourceReferences,
        rationale: request.rationale,
        confidence: request.confidence,
        producer: {
          kind: 'agent' as const,
          id: 'knowledge-manager',
          responsibleUserId: 'user_demo',
        },
        status: 'pending' as const,
        createdAt: timestamp,
      },
      validation: {
        conformance: 'Workspace-schema-valid' as const,
        generatedFromCompletedWorkHistory: false,
      },
    };

    expect(KnowledgeManagerDraftProposalResponseSchema.parse(response)).toEqual(response);
    expect(
      KnowledgeManagerDraftProposalResponseSchema.safeParse({
        ...response,
        sourceLineage: [],
      }).success
    ).toBe(false);
  });

  it.each([
    [
      'legacy title and summary',
      {
        requestId: '00000000-0000-4000-8000-000000000602',
        title: 'Release cadence',
        summary: 'Record that releases are reviewed every Friday.',
      },
    ],
    [
      'caller-supplied producer',
      {
        ...knowledgeProposalDraftRequest,
        producer: { kind: 'agent', id: 'client', responsibleUserId: null },
      },
    ],
    [
      'unsupported source reference',
      {
        ...knowledgeProposalDraftRequest,
        sourceReferences: ['https://example.com/release-notes'],
      },
    ],
    [
      'non-sha256 digest',
      {
        ...knowledgeProposalDraftRequest,
        contentDigest: 'digest_demo',
      },
    ],
    [
      'non-UUID request id',
      {
        ...knowledgeProposalDraftRequest,
        requestId: 'req_km_proposal',
      },
    ],
    [
      'raw secret in candidate page bytes',
      {
        ...knowledgeProposalDraftRequest,
        canonicalPageBytes: `${knowledgeProposalDraftRequest.canonicalPageBytes}\nghp_openkit_candidate_canary`,
      },
    ],
    [
      'raw secret in rationale',
      {
        ...knowledgeProposalDraftRequest,
        rationale: 'Preserve ghp_openkit_rationale_canary as a reusable lesson.',
      },
    ],
    [
      'absolute host path in candidate page bytes',
      {
        ...knowledgeProposalDraftRequest,
        canonicalPageBytes: `${knowledgeProposalDraftRequest.canonicalPageBytes}\nHost source: /Users/example/openkit/private.md`,
      },
    ],
    [
      'absolute host path in rationale',
      {
        ...knowledgeProposalDraftRequest,
        rationale: 'Preserve the lesson from /Users/example/openkit/private.md.',
      },
    ],
  ])('rejects loose Knowledge Manager proposal draft input: %s', (_name, request) => {
    expect(KnowledgeManagerDraftProposalRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts Knowledge Manager repair suggestion requests and responses', () => {
    expect(KnowledgeManagerSuggestRepairRequestSchema.parse({})).toEqual({ limit: 10 });

    expect(
      KnowledgeManagerSuggestRepairResponseSchema.parse({
        operationId: 'km_repair_demo',
        operation: 'suggest-repair',
        workspaceId: 'ws_demo',
        caller: 'app-api',
        outcome: 'suggested',
        suggestions: [
          {
            id: 'repair_duplicate_title_release_plan',
            kind: 'duplicate-title',
            title: 'Duplicate title: Release plan',
            detail: '2 knowledge entries share the same normalized title.',
            affectedKnowledgeEntryIds: ['kn_1', 'kn_2'],
            autoApplicable: false,
            reviewRequired: true,
          },
        ],
      })
    ).toMatchObject({
      operation: 'suggest-repair',
      outcome: 'suggested',
      suggestions: [{ kind: 'duplicate-title', reviewRequired: true }],
    });
  });

  it('accepts Knowledge Manager health-check requests and responses', () => {
    expect(KnowledgeManagerHealthCheckRequestSchema.parse({})).toEqual({ limit: 10 });

    expect(
      KnowledgeManagerHealthCheckResponseSchema.parse({
        operationId: 'km_health_demo',
        operation: 'health-check',
        workspaceId: 'ws_demo',
        caller: 'app-api',
        outcome: 'needs-attention',
        summary: 'Knowledge Manager found 1 repair suggestion.',
        checks: [
          {
            code: 'knowledge-present',
            status: 'pass',
            detail: '2 knowledge entries are available.',
          },
          {
            code: 'repair-suggestions',
            status: 'warn',
            detail: '1 review-required repair suggestion was found.',
          },
        ],
        repairSuggestions: [
          {
            id: 'repair_duplicate_title_release_plan',
            kind: 'duplicate-title',
            title: 'Duplicate title: Release plan',
            detail: '2 knowledge entries share the same normalized title.',
            affectedKnowledgeEntryIds: ['kn_1', 'kn_2'],
            autoApplicable: false,
            reviewRequired: true,
          },
        ],
      })
    ).toMatchObject({
      operation: 'health-check',
      outcome: 'needs-attention',
      repairSuggestions: [{ kind: 'duplicate-title' }],
    });
  });

  it('keeps semantic Knowledge callers server-owned', () => {
    expect(appApiSchemas.KnowledgeManagerCallerSchema.options).toEqual([
      'assistant',
      'task-mode',
      'app-api',
    ]);

    const publicRequests = [
      [KnowledgeManagerAnswerRequestSchema, { query: 'release cadence' }],
      [
        KnowledgeManagerPrepareContextRequestSchema,
        {
          query: 'release cadence',
        },
      ],
      [
        KnowledgeManagerDraftProposalRequestSchema,
        {
          ...knowledgeProposalDraftRequest,
          requestId: '00000000-0000-4000-8000-000000000603',
        },
      ],
      [KnowledgeManagerSuggestRepairRequestSchema, {}],
      [KnowledgeManagerHealthCheckRequestSchema, {}],
      [
        RegisterKnowledgeSourceRequestSchema,
        {
          requestId: 'req_km_source_caller',
          kind: 'document',
          title: 'Release notes',
          content: 'Releases are reviewed every Friday.',
        },
      ],
    ] as const;

    for (const [schema, request] of publicRequests) {
      expect(schema.safeParse({ ...request, caller: 'assistant' }).success).toBe(false);
    }
  });

  it('accepts owner-independent storage layout reports and quarantine findings', () => {
    const report = {
      dataRoot: '/tmp/openkit',
      serverDb: {
        path: 'server/db/core.sqlite',
        exists: true,
        appliedMigrations: ['core_0000_baseline'],
      },
      users: [
        {
          userId: 'user_1',
          userDb: {
            path: 'users/user_1/db/user.sqlite',
            exists: true,
            appliedMigrations: ['user_0000_baseline'],
          },
        },
      ],
      workspaces: [
        {
          workspaceId: 'ws_1',
          workspaceDb: {
            path: 'workspaces/ws_1/db/workspace.sqlite',
            exists: true,
            appliedMigrations: ['workspace_0000_baseline'],
          },
          indexesDir: {
            path: 'workspaces/ws_1/indexes',
            exists: true,
            entryCount: 1,
          },
        },
      ],
      quarantineEntries: [
        {
          scope: 'workspace',
          workspaceId: 'ws_1',
          path: 'workspaces/ws_1/quarantine/1-workspace.sqlite',
          bytes: 128,
        },
      ],
    } as const;

    expect(StorageLayoutReportResponseSchema.parse(report).quarantineEntries[0]?.scope).toBe(
      'workspace'
    );
    expect(
      StorageLayoutReportResponseSchema.safeParse({
        ...report,
        users: [{ ...report.users[0], workspaces: report.workspaces }],
      }).success
    ).toBe(false);
    expect(
      StorageLayoutReportResponseSchema.safeParse({
        ...report,
        quarantineEntries: [{ ...report.quarantineEntries[0], userId: 'user_1' }],
      }).success
    ).toBe(false);
  });

  it('accepts workspace export responses and rejects secret-shaped payloads', () => {
    const payload = {
      exportId: 'wsexp_demo',
      workspaceId: 'ws_demo',
      manifest: {
        schemaVersion: 1,
        recordType: 'workspace-export',
        id: 'wsexp_demo',
        ownerScope: 'workspace',
        lineage: { workspaceId: 'ws_demo' },
        createdAt: timestamp,
        updatedAt: timestamp,
        contentDigest: 'sha256:manifest',
        redactionLevel: 'metadata',
        sensitivity: 'internal',
        requiredFeatures: [],
        extensions: {},
        sourceDeploymentId: 'dep_local',
        workspaceId: 'ws_demo',
        exportCreatedAt: timestamp,
        exportFormatVersion: 2,
        contentInventory: [
          {
            path: 'records/workspace.json',
            digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
            bytes: 16,
          },
        ],
      },
      fileCount: 1,
      totalBytes: 16,
      checkedFiles: ['records/workspace.json'],
    };

    expect(WorkspaceExportResponseSchema.parse(payload)).toMatchObject({
      exportId: 'wsexp_demo',
      workspaceId: 'ws_demo',
      fileCount: 1,
    });

    expect(() =>
      WorkspaceExportResponseSchema.parse({
        ...payload,
        manifest: {
          ...payload.manifest,
          extensions: { diagnostic: rawSecretShapes[0] },
        },
      })
    ).toThrow();
  });

  it('accepts data-root backup create and verify responses', () => {
    const manifest = {
      schemaVersion: 1,
      recordType: 'data-root-backup',
      id: 'drb_demo',
      ownerScope: 'server',
      lineage: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_local',
      backupStartedAt: timestamp,
      backupCompletedAt: timestamp,
      backupMode: 'hot',
      consistency: 'crash-consistent',
      backupFormatVersion: 1,
      contentInventory: [
        {
          path: 'server/db/core.sqlite',
          digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
          bytes: 16,
        },
      ],
    };

    expect(
      DataRootBackupCreateResponseSchema.parse({
        backupId: 'drb_demo',
        manifest,
        fileCount: 1,
        totalBytes: 16,
        checkedFiles: ['server/db/core.sqlite'],
      })
    ).toMatchObject({ backupId: 'drb_demo', fileCount: 1 });
    expect(DataRootBackupVerifyRequestSchema.parse({ backupId: 'drb_demo-1' })).toEqual({
      backupId: 'drb_demo-1',
    });
    expect(() => DataRootBackupVerifyRequestSchema.parse({ backupId: '..' })).toThrow();
    expect(
      DataRootBackupVerifyResponseSchema.parse({
        backupId: 'drb_demo',
        manifest,
        fileCount: 1,
        totalBytes: 16,
        checkedFiles: ['server/db/core.sqlite'],
      })
    ).toMatchObject({ backupId: 'drb_demo' });
  });

  it('accepts workspace import dry-run reports and rejects unsafe export handles', () => {
    expect(
      WorkspaceImportDryRunRequestSchema.parse({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo-1',
      })
    ).toEqual({ sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo-1' });
    expect(() =>
      WorkspaceImportDryRunRequestSchema.parse({
        sourceWorkspaceId: '..',
        exportId: 'wsexp_demo',
      })
    ).toThrow();

    expect(
      WorkspaceImportDryRunResponseSchema.parse({
        mode: 'dry-run',
        exportId: 'wsexp_demo',
        sourceWorkspaceId: 'ws_demo',
        exportedWorkspaceId: 'ws_demo',
        manifest: {
          schemaVersion: 1,
          recordType: 'workspace-export',
          id: 'wsexp_demo',
          ownerScope: 'workspace',
          lineage: { workspaceId: 'ws_demo' },
          createdAt: timestamp,
          updatedAt: timestamp,
          contentDigest: 'sha256:manifest',
          redactionLevel: 'metadata',
          sensitivity: 'internal',
          requiredFeatures: [],
          extensions: {},
          sourceDeploymentId: 'dep_local',
          workspaceId: 'ws_demo',
          exportCreatedAt: timestamp,
          exportFormatVersion: 2,
          contentInventory: [],
        },
        verification: { fileCount: 0, totalBytes: 0, checkedFiles: [] },
        collision: {
          status: 'collides',
          workspaceId: 'ws_demo',
          suggestedWorkspaceId: 'ws_imported_ws_demo',
        },
      }).collision.status
    ).toBe('collides');
  });

  it('accepts workspace import responses and request ids', () => {
    expect(
      WorkspaceImportRequestSchema.parse({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo',
        requestId: 'req_import',
      })
    ).toEqual({ sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo', requestId: 'req_import' });

    expect(
      WorkspaceImportResponseSchema.parse({
        mode: 'imported',
        requestId: 'req_import',
        exportId: 'wsexp_demo',
        sourceWorkspaceId: 'ws_demo',
        exportedWorkspaceId: 'ws_demo',
        importedWorkspaceId: 'ws_imported_ws_demo',
        manifest: {
          schemaVersion: 1,
          recordType: 'workspace-export',
          id: 'wsexp_demo',
          ownerScope: 'workspace',
          lineage: { workspaceId: 'ws_demo' },
          createdAt: timestamp,
          updatedAt: timestamp,
          contentDigest: 'sha256:manifest',
          redactionLevel: 'metadata',
          sensitivity: 'internal',
          requiredFeatures: [],
          extensions: {},
          sourceDeploymentId: 'dep_local',
          workspaceId: 'ws_demo',
          exportCreatedAt: timestamp,
          exportFormatVersion: 2,
          contentInventory: [],
        },
        workspace: {
          id: 'ws_imported_ws_demo',
          name: 'Demo workspace',
          kind: 'general',
          status: 'active',
          defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
          counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 1 },
          importedFrom: {
            sourceDeploymentId: 'dep_source',
            sourceWorkspaceId: 'ws_demo',
            exportCreatedAt: timestamp,
            manifestDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        verification: { fileCount: 4, totalBytes: 16, checkedFiles: ['records/workspace.json'] },
        collision: {
          status: 'collides',
          workspaceId: 'ws_demo',
          suggestedWorkspaceId: 'ws_imported_ws_demo',
        },
      }).workspace.importedFrom?.sourceWorkspaceId
    ).toBe('ws_demo');
  });

  it('accepts redacted vault admin payloads and rejects secret-shaped responses', () => {
    expect(
      VaultAdminStatusResponseSchema.parse({
        backendKind: 'encrypted-file',
        state: 'locked',
        diagnostic: 'Vault backend is locked.',
      }).state
    ).toBe('locked');
    expect(
      VaultAdminUnlockRequestSchema.parse({
        masterKeyBase64: Buffer.alloc(32, 7).toString('base64'),
      }).masterKeyBase64
    ).toHaveLength(44);
    expect(
      VaultAdminBootstrapCodexAuthJsonRequestSchema.parse({
        authJsonBase64: Buffer.from('{"tokens":{}}').toString('base64'),
        expiresAt: timestamp,
      }).expiresAt
    ).toBe(timestamp);
    expect(
      VaultAdminBootstrapCodexAuthJsonResponseSchema.parse({
        backendKind: 'encrypted-file',
        grantId: 'grant_codex_auth_json',
        grantScope: 'agent-session',
        referenceId: 'vault_codex_auth_json',
        secretKind: 'codex-auth-json',
        targetPath: '/sandbox/.codex/auth.json',
        expiresAt: null,
      }).targetPath
    ).toBe('/sandbox/.codex/auth.json');
    expect(
      VaultAdminRebindWorkspaceReferenceRequestSchema.parse({
        materialBase64: Buffer.from('workspace-secret').toString('base64'),
      }).materialBase64
    ).toBe(Buffer.from('workspace-secret').toString('base64'));
    expect(
      VaultAdminRebindWorkspaceReferenceResponseSchema.parse({
        backendKind: 'encrypted-file',
        currentVersion: 1,
        ownerScope: 'workspace',
        referenceId: 'vault_imported',
        secretKind: 'api-token',
        status: 'active',
        workspaceId: 'ws_demo',
      }).status
    ).toBe('active');
    expect(
      VaultAdminListWorkspaceReferencesResponseSchema.parse({
        items: [
          {
            backendKind: 'encrypted-file',
            currentVersion: 0,
            ownerScope: 'workspace',
            referenceId: 'vault_imported',
            secretKind: 'api-token',
            status: 'unbound',
            workspaceId: 'ws_demo',
          },
        ],
        workspaceId: 'ws_demo',
      }).items[0]?.status
    ).toBe('unbound');
    expect(
      VaultAdminUnlockResponseSchema.parse({
        backendKind: 'encrypted-file',
        state: 'available',
        diagnostic: 'Vault backend is available.',
      }).state
    ).toBe('available');
    expect(
      VaultAdminLockResponseSchema.parse({
        backendKind: 'encrypted-file',
        state: 'locked',
        diagnostic: 'Vault backend is locked.',
      }).state
    ).toBe('locked');
    for (const secret of rawSecretShapes) {
      expect(
        VaultAdminStatusResponseSchema.safeParse({
          backendKind: 'encrypted-file',
          state: 'available',
          diagnostic: `raw secret ${secret}`,
        }).success
      ).toBe(false);
      expect(
        VaultAdminBootstrapCodexAuthJsonResponseSchema.safeParse({
          backendKind: 'encrypted-file',
          grantId: 'grant_codex_auth_json',
          grantScope: 'agent-session',
          referenceId: 'vault_codex_auth_json',
          secretKind: 'codex-auth-json',
          targetPath: '/sandbox/.codex/auth.json',
          expiresAt: null,
          diagnostic: secret,
        }).success
      ).toBe(false);
      expect(
        VaultAdminRebindWorkspaceReferenceResponseSchema.safeParse({
          backendKind: 'encrypted-file',
          currentVersion: 1,
          ownerScope: 'workspace',
          referenceId: 'vault_imported',
          secretKind: secret,
          status: 'active',
          workspaceId: 'ws_demo',
        }).success
      ).toBe(false);
    }
  });

  it.each([
    {
      name: 'vault status',
      payload: {
        backendKind: 'os-keychain',
        state: 'available',
        diagnostic: 'Vault backend is available.',
      },
      schema: VaultAdminStatusResponseSchema,
    },
    {
      name: 'Codex auth bootstrap',
      payload: {
        backendKind: 'os-keychain',
        grantId: 'grant_codex_auth_json',
        grantScope: 'agent-session',
        referenceId: 'vault_codex_auth_json',
        secretKind: 'codex-auth-json',
        targetPath: '/sandbox/.codex/auth.json',
        expiresAt: null,
      },
      schema: VaultAdminBootstrapCodexAuthJsonResponseSchema,
    },
    {
      name: 'workspace reference rebind',
      payload: {
        backendKind: 'os-keychain',
        currentVersion: 1,
        ownerScope: 'workspace',
        referenceId: 'vault_imported',
        secretKind: 'api-token',
        status: 'active',
        workspaceId: 'ws_demo',
      },
      schema: VaultAdminRebindWorkspaceReferenceResponseSchema,
    },
    {
      name: 'workspace reference list',
      payload: {
        items: [
          {
            backendKind: 'os-keychain',
            currentVersion: 0,
            ownerScope: 'workspace',
            referenceId: 'vault_imported',
            secretKind: 'api-token',
            status: 'unbound',
            workspaceId: 'ws_demo',
          },
        ],
        workspaceId: 'ws_demo',
      },
      schema: VaultAdminListWorkspaceReferencesResponseSchema,
    },
    {
      name: 'vault unlock',
      payload: {
        backendKind: 'os-keychain',
        state: 'available',
        diagnostic: 'Vault backend is available.',
      },
      schema: VaultAdminUnlockResponseSchema,
    },
    {
      name: 'vault lock',
      payload: {
        backendKind: 'os-keychain',
        state: 'locked',
        diagnostic: 'Vault backend is locked.',
      },
      schema: VaultAdminLockResponseSchema,
    },
    {
      name: 'workspace Vault use records',
      payload: {
        workspaceId: 'ws_demo',
        vaultUseRecords: [
          {
            useId: 'use_legacy',
            ownerScope: 'workspace',
            workspaceId: 'ws_demo',
            vaultReferenceId: 'vault_legacy',
            materialVersion: 1,
            backendKind: 'os-keychain',
            resolvingPath: 'grant',
            grantId: 'grant_legacy',
            planId: null,
            receiptId: null,
            agentSessionId: null,
            capabilityCallId: null,
            outcome: 'succeeded',
            failureCode: null,
            auditEventId: null,
            usedAt: timestamp,
          },
        ],
      },
      schema: ListWorkspaceVaultUseRecordsResponseSchema,
    },
    {
      name: 'server Vault use records',
      payload: {
        vaultUseRecords: [
          {
            useId: 'use_server_legacy',
            ownerScope: 'server',
            workspaceId: null,
            vaultReferenceId: 'vault_legacy',
            materialVersion: 1,
            backendKind: 'os-keychain',
            resolvingPath: 'provider',
            grantId: null,
            planId: null,
            receiptId: null,
            agentSessionId: null,
            capabilityCallId: null,
            outcome: 'succeeded',
            failureCode: null,
            auditEventId: null,
            usedAt: timestamp,
          },
        ],
      },
      schema: ListServerVaultUseRecordsResponseSchema,
    },
  ])('rejects obsolete os-keychain backend values in $name payloads', ({ payload, schema }) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it('accepts strict app diagnostics and rejects provider arrays', () => {
    const payload = appDiagnosticsPayload();

    expect(AppDiagnosticsResponseSchema.parse(payload).providers).toEqual({
      diagnostics: [],
      registry: [],
    });
    expect(AppDiagnosticsResponseSchema.safeParse({ ...payload, providers: [] }).success).toBe(
      false
    );
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        providers: {
          diagnostics: [
            {
              providerId: 'provider_demo',
              status: 'ready',
              message: null,
              checkedAt: timestamp,
            },
          ],
          registry: [],
        },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.parse({
        ...payload,
        providers: {
          diagnostics: [
            {
              code: 'invalid-provider-profile',
              message: 'Provider profile could not be parsed.',
              profileId: 'provider_demo',
              source: 'config/providers/provider-demo.provider.jsonc',
              status: 'blocked',
            },
          ],
          registry: [
            {
              displayName: 'Provider Demo',
              gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
              id: 'provider_demo',
              kind: 'gateway',
              models: ['gpt-demo'],
            },
          ],
        },
      }).providers
    ).toEqual({
      diagnostics: [
        {
          code: 'invalid-provider-profile',
          message: 'Provider profile could not be parsed.',
          profileId: 'provider_demo',
          source: 'config/providers/provider-demo.provider.jsonc',
          status: 'blocked',
        },
      ],
      registry: [
        {
          displayName: 'Provider Demo',
          gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
          id: 'provider_demo',
          kind: 'gateway',
          models: ['gpt-demo'],
        },
      ],
    });
  });

  it('accepts optional gateway cache token diagnostics and rejects removed cache fields', () => {
    const summary = {
      completionTokens: 3,
      endpoint: 'responses',
      inputTokens: 5,
      lastObservedAt: timestamp,
      model: 'gpt-5.4',
      providerId: 'provider_openai',
      requestCount: 1,
      totalTokens: 8,
    };

    expect(GatewayUsageSummarySchema.parse(summary)).toEqual(summary);
    expect(
      GatewayUsageSummarySchema.parse({
        ...summary,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    ).toEqual({ ...summary, cacheReadTokens: 0, cacheWriteTokens: 0 });
    for (const removedField of ['cachedInputTokens', 'cacheHitRate']) {
      expect(GatewayUsageSummarySchema.safeParse({ ...summary, [removedField]: 0 }).success).toBe(
        false
      );
    }
  });

  it('preserves provider kind without exposing a dispatch family', () => {
    const provider = {
      displayName: 'Provider Demo',
      gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
      id: 'provider_demo',
      kind: 'gateway',
      models: ['gpt-demo'],
    };

    expect(ProviderRegistryEntrySchema.parse(provider).kind).toBe('gateway');
    expect(
      ProviderRegistryEntrySchema.safeParse({
        ...provider,
        dispatchFamily: 'provider-api',
      }).success
    ).toBe(false);
  });

  it('keeps generic internal-agent runtime state outside App Diagnostics', () => {
    const payload = appDiagnosticsPayload();
    expect(AppDiagnosticsResponseSchema.parse(payload)).toEqual(payload);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        internalAgents: { agents: [], recentFailures: [], recentHookFailures: [] },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        defaults: {
          ...payload.defaults,
          internalTasks: { providerId: null, model: null },
        },
      }).success
    ).toBe(false);
  });

  it('accepts capability usage read models', () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    const parsed = CapabilityUsageResponseSchema.parse({
      capabilityCalls: [
        {
          id: 'cap_1',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: 'it_demo',
          agentId: 'assistant',
          agentSessionId: 'session_demo',
          packageSnapshotId: 'aepsnap_demo',
          runtimeOriginRef: `rto_${'a'.repeat(24)}`,
          runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
          sourceIds: ['repo_default'],
          requestId,
          capabilityId: 'llm.chat_completions',
          family: 'llm',
          operation: 'chat_completions',
          providerRef: 'openrouter',
          serviceRef: 'llm-gateway',
          redactionClass: 'metadata-only',
          status: 'succeeded',
          startedAt: timestamp,
          completedAt: timestamp,
          summary: 'Gateway call completed.',
          errorCode: null,
        },
      ],
      usageRecords: [
        {
          id: 'usage_1',
          workspaceId: 'ws_demo',
          responsibleUserId: 'user_1',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: 'it_demo',
          agentId: 'assistant',
          agentSessionId: 'session_demo',
          sourceIds: ['repo_default'],
          requestId,
          capabilityCallId: 'cap_1',
          category: 'llm',
          unit: 'usd',
          quantity: 0.012,
          modelId: 'openai/gpt-5.1',
          providerRef: 'openrouter',
          source: 'llm-gateway-adapter-reported:cost_estimate',
          recordedAt: timestamp,
        },
      ],
      workspaceId: 'ws_demo',
    });

    expect(parsed.usageRecords[0]?.capabilityCallId).toBe('cap_1');
    expect(parsed.usageRecords[0]?.unit).toBe('usd');
    expect(parsed.capabilityCalls[0]).toMatchObject({
      packageSnapshotId: 'aepsnap_demo',
      runtimeOriginRef: `rto_${'a'.repeat(24)}`,
      runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
    });
    expect(() =>
      CapabilityUsageResponseSchema.parse({
        ...parsed,
        capabilityCalls: [
          {
            ...parsed.capabilityCalls[0],
            runtimeOriginRef: 'native-thread-id',
          },
        ],
      })
    ).toThrow();
  });

  it('accepts read-only evidence bundle list models', () => {
    const evidenceBundle = {
      id: 'evb_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      goalId: 'goal_demo',
      turnId: 'turn_demo',
      agentSessionId: null,
      backendType: null,
      sourceKind: 'workspace-apply-result',
      summary: 'Workspace apply evidence is ready for review.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'workspace-apply-result', ref: 'workspace-apply-result:war_1' },
      ],
      contentDigests: ['sha256:9a0f3c8d4b7e5a6c9d2f1b0a3e4c5d6f7a8b9c0d1e2f3456789abcdef0123456'],
      retentionClass: 'workspace-audit',
      sensitivityClass: 'product-safe',
      importStatus: 'promoted',
      requiredFeatures: ['evidence.bundle.v1'],
      createdAt: timestamp,
    };

    expect(
      ListWorkspaceEvidenceBundlesResponseSchema.parse({
        workspaceId: 'ws_demo',
        evidenceBundles: [evidenceBundle],
      })
    ).toEqual({
      workspaceId: 'ws_demo',
      evidenceBundles: [evidenceBundle],
    });
  });

  it('does not export manual or synchronization-specific evidence contracts', () => {
    expect(appApiSchemas).not.toHaveProperty('CreateEvidenceBundleRequestSchema');
    expect(appApiSchemas).not.toHaveProperty('CreateEvidenceBundleResponseSchema');
    expect(appApiSchemas).not.toHaveProperty('WorkspaceSyncEvidenceBundleSchema');
    expect(appApiSchemas).not.toHaveProperty('ListWorkspaceSyncEvidenceBundlesResponseSchema');
  });

  it('does not authorize generic pending-input recovery', () => {
    expect(
      appApiSchemas.HumanAttentionActionKindSchema.safeParse('edit_pending_input').success
    ).toBe(false);
    expect(
      appApiSchemas.HumanAttentionActionKindSchema.safeParse('promote_pending_input_to_interrupt')
        .success
    ).toBe(false);
    expect(
      appApiSchemas.HumanAttentionActionKindSchema.safeParse('convert_pending_input_to_follow_up')
        .success
    ).toBe(false);
    expect(
      appApiSchemas.HumanAttentionActionKindSchema.safeParse('cancel_pending_input').success
    ).toBe(false);
    expect(appApiSchemas).not.toHaveProperty('EditRecoveryPendingUserTurnRequestSchema');
    expect(appApiSchemas).not.toHaveProperty('EditRecoveryPendingUserTurnResponseSchema');
    expect(appApiSchemas).not.toHaveProperty(
      'PromoteRecoveryPendingUserTurnToInterruptResponseSchema'
    );
    expect(appApiSchemas).not.toHaveProperty('RecoveryPendingUserTurnSchema');
    expect(appApiSchemas).not.toHaveProperty('CreateInterruptedRecoveryStateResponseSchema');
    expect(appApiSchemas).not.toHaveProperty('ListRecoveryPendingUserTurnsResponseSchema');
    expect(appApiSchemas).not.toHaveProperty('CancelRecoveryPendingUserTurnResponseSchema');
    expect(appApiSchemas).not.toHaveProperty(
      'ConvertRecoveryPendingUserTurnToFollowUpResponseSchema'
    );
    expect(appApiSchemas).not.toHaveProperty('PendingUserTurnHumanAttentionSourceSchema');
  });

  it('accepts workspace runtime evidence read models without raw backend payloads', () => {
    const runtimeEvidence = RuntimeEvidenceRecordSchema.parse({
      id: 'rte_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      agentSessionId: 'session_demo',
      backendType: 'openshell',
      backendVersion: null,
      placement: 'local',
      phase: 'checkpoint',
      summary: 'Worker checkpoint terminal: completed.',
      policyDigest: 'sha256:9a0f3c8d4b7e5a6c9d2f1b0a3e4c5d6f7a8b9c0d1e2f3456789abcdef0123456',
      workerImage: 'openkit/worker-codex:dev',
      sandboxSummary: 'sandbox ending in demo',
      capabilitySummary: 'worker turn checkpoint',
      uploadManifest: [],
      downloadManifest: [{ path: 'artifacts/result.md', size: 42, digest: 'sha256:abc' }],
      transcriptSummary: '1 item, 1 artifact',
      workspaceChangeSummary: null,
      controlSummary: 'last heartbeat at 2026-05-15T05:17:42.000Z',
      outcome: 'succeeded',
      exitCode: 0,
      signal: null,
      stopReason: 'completed',
      errorCode: null,
      errorMessage: null,
      redactedStdoutSummary: null,
      redactedStderrSummary: null,
      evidenceBundleIds: ['evb_demo'],
      contentDigests: ['sha256:runtime'],
      requiredFeatures: ['runtime.evidence.v1'],
      createdAt: timestamp,
      startedAt: null,
      completedAt: timestamp,
      collectedAt: timestamp,
    });

    expect(
      ListWorkspaceRuntimeEvidenceResponseSchema.parse({
        runtimeEvidence: [runtimeEvidence],
        workspaceId: 'ws_demo',
      })
    ).toEqual({
      runtimeEvidence: [runtimeEvidence],
      workspaceId: 'ws_demo',
    });
    expect(JSON.stringify(runtimeEvidence)).not.toContain('Authorization');
    expect(JSON.stringify(runtimeEvidence)).not.toContain('sk-openkit-secret');
    expect(
      RuntimeEvidenceRecordSchema.safeParse({
        ...runtimeEvidence,
        phase: 'sidecar-startup',
      }).success
    ).toBe(false);
  });

  it('accepts workspace permission decision read models without raw secrets', () => {
    const response = ListWorkspacePermissionDecisionsResponseSchema.parse({
      workspaceId: 'ws_demo',
      permissionDecisions: [
        {
          decisionId: 'pd_demo',
          ownerScope: 'workspace',
          workspaceId: 'ws_demo',
          policyEngineVersion: 'nanocore-worker-policy:v1',
          policySnapshotId: 'worker_turn_launch_policy',
          subjectSummary: { kind: 'nanocore', id: 'worker-coordinator' },
          action: 'runtime.launch',
          resourceSummary: { kind: 'worker-turn', turnId: 'turn_demo' },
          contextSummary: {
            requestId: '00000000-0000-4000-8000-00000000d791',
            threadId: 'th_demo',
            turnId: 'turn_demo',
          },
          result: 'require_escalation',
          reasonCode: 'higher_authority_required',
          enforcementPoint: 'runtime.worker_turn_loop.start',
          requiredApprovalKind: null,
          approvalId: null,
          auditEventId: 'aud_demo',
          createdAt: timestamp,
        },
      ],
    });

    expect(response.permissionDecisions[0]?.decisionId).toBe('pd_demo');
    expect(
      ListWorkspacePermissionDecisionsResponseSchema.safeParse({
        workspaceId: 'ws_demo',
        permissionDecisions: [
          {
            ...response.permissionDecisions[0],
            subjectSummary: { token: rawSecretShapes[0] },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('accepts server permission decision read models without raw secrets', () => {
    const response = ListServerPermissionDecisionsResponseSchema.parse({
      permissionDecisions: [
        {
          decisionId: 'pd_server_demo',
          ownerScope: 'server',
          workspaceId: null,
          policyEngineVersion: 'nanocore-gateway-policy:v1',
          policySnapshotId: 'runtime_config_gateway_policy',
          subjectSummary: { kind: 'gateway-client', id: 'openai-compatible' },
          action: 'llm.gateway.chat_completions',
          resourceSummary: { kind: 'llm-provider', providerId: 'openrouter' },
          contextSummary: { route: '/v1/chat/completions' },
          result: 'defer',
          reasonCode: 'policy_context_missing',
          enforcementPoint: 'llm.gateway.policy',
          requiredApprovalKind: null,
          approvalId: null,
          auditEventId: null,
          createdAt: timestamp,
        },
      ],
    });

    expect(response.permissionDecisions[0]?.decisionId).toBe('pd_server_demo');
    expect(
      ListServerPermissionDecisionsResponseSchema.safeParse({
        permissionDecisions: [
          {
            ...response.permissionDecisions[0],
            resourceSummary: { token: rawSecretShapes[0] },
          },
        ],
      }).success
    ).toBe(false);
  });

  it('accepts workspace synchronization records without raw backend paths', () => {
    const inputSnapshot = WorkspaceInputSnapshotSchema.parse({
      id: 'wis_1',
      workspaceId: 'ws_demo',
      resourceId: 'default',
      resourceKind: 'git_repository',
      strategy: 'git',
      pathScope: ['docs', 'apps/nanocore'],
      writableRoots: ['docs'],
      ignoredPaths: ['node_modules'],
      generatedFiles: [{ id: 'task', target: 'openkit/task.md' }],
      base: { commit: 'abc123', contentDigest: null },
      backend: {
        kind: 'openshell',
        capabilitySummary: ['git-materialization', 'change-set-collection'],
        label: 'container runtime',
      },
      createdAt: timestamp,
    });

    const materialization = WorkspaceMaterializationRecordSchema.parse({
      id: 'wmr_1',
      inputSnapshotId: inputSnapshot.id,
      workspaceId: 'ws_demo',
      backendKind: 'openshell',
      packageSnapshotId: 'aepsnap_1',
      workerSessionId: 'session_1',
      strategy: 'git',
      materializedRootRef: 'worker-root://repo',
      base: { commit: 'abc123', contentDigest: null },
      policyDigest: 'sha256:policy',
      readinessEvidence: [{ kind: 'openshell.ready', ref: 'ev_1' }],
      createdAt: timestamp,
    });
    const backendHandle = BackendWorkspaceHandleSchema.parse({
      id: 'bwh_1',
      workspaceId: 'ws_demo',
      materializationRecordId: materialization.id,
      backendKind: 'openshell',
      packageSnapshotId: 'aepsnap_1',
      workerSessionId: 'session_1',
      transportRefs: [{ kind: 'worker-root', ref: 'worker-root://repo' }],
      cleanupStatus: 'pending',
      retention: 'until-reconciliation',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const outputManifest = WorkerOutputManifestSchema.parse({
      id: 'wom_1',
      workspaceId: 'ws_demo',
      materializationRecordId: materialization.id,
      inputSnapshotId: inputSnapshot.id,
      workerSessionId: 'session_1',
      backendKind: 'openshell',
      strategy: 'git',
      changedPaths: [
        { path: 'docs/spec.md', status: 'modified', binary: false },
        { path: 'docs/new.md', status: 'added', binary: false },
        {
          path: 'scripts/build.sh',
          status: 'mode_changed',
          binary: false,
          oldPermissions: '0644',
          newPermissions: '0755',
        },
      ],
      artifactIds: ['ar_patch'],
      logRefs: [{ kind: 'worker-log', ref: 'artifact://log', digest: 'sha256:log', bytes: 64 }],
      testOutputRefs: [
        { kind: 'test-output', ref: 'artifact://test', digest: 'sha256:test', bytes: 128 },
      ],
      ignoredOutputs: [{ path: 'node_modules/cache.bin', reason: 'excluded by workspace policy' }],
      evidenceRefs: [{ kind: 'test', ref: 'ev_test' }],
      collectedAt: timestamp,
    });

    const changeSet = WorkspaceChangeSetSchema.parse({
      id: 'wcs_1',
      materializationRecordId: materialization.id,
      inputSnapshotId: inputSnapshot.id,
      workspaceId: 'ws_demo',
      resourceId: 'default',
      sourceId: 'repo_default',
      strategy: 'git',
      base: { commit: 'abc123', contentDigest: null },
      head: { commit: 'def456', contentDigest: null },
      changedPaths: [
        { path: 'docs/spec.md', status: 'modified', binary: false },
        { path: 'docs/new.md', status: 'added', binary: false },
        {
          path: 'assets/screenshot.png',
          status: 'modified',
          binary: true,
          size: 2048,
          digest: 'sha256:image',
          mediaType: 'image/png',
          binaryReview: {
            bytes: 2048,
            digest: 'sha256:image',
            mediaType: 'image/png',
            mode: 'artifact-only',
            reason: 'binary-path',
            summary:
              'Binary change assets/screenshot.png is available as an artifact-only review item.',
          },
        },
      ],
      patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 1200 },
      bundle: null,
      artifactIds: ['ar_patch'],
      evidenceRefs: [{ kind: 'test', ref: 'ev_test' }],
      redaction: { status: 'redacted', notes: [] },
      createdAt: timestamp,
    });

    expect(changeSet.sourceId).toBe('repo_default');
    const {
      packageSnapshotId: materializationPackageSnapshotId,
      ...materializationWithoutPackageSnapshotId
    } = materialization;
    expect(materializationPackageSnapshotId).toBe('aepsnap_1');
    expect(
      WorkspaceMaterializationRecordSchema.safeParse(materializationWithoutPackageSnapshotId)
        .success
    ).toBe(false);
    expect(changeSet.changedPaths[2]?.binaryReview).toMatchObject({
      mediaType: 'image/png',
      mode: 'artifact-only',
      reason: 'binary-path',
    });
    expect(backendHandle.transportRefs).toEqual([
      { kind: 'worker-root', ref: 'worker-root://repo' },
    ]);
    const { packageSnapshotId, ...backendHandleWithoutPackageSnapshotId } = backendHandle;
    expect(packageSnapshotId).toBe('aepsnap_1');
    expect(
      BackendWorkspaceHandleSchema.safeParse(backendHandleWithoutPackageSnapshotId).success
    ).toBe(false);
    expect(outputManifest.changedPaths.map((path) => path.path)).toEqual([
      'docs/spec.md',
      'docs/new.md',
      'scripts/build.sh',
    ]);
    expect(outputManifest.changedPaths[2]).toMatchObject({
      newPermissions: '0755',
      oldPermissions: '0644',
      status: 'mode_changed',
    });

    expect(
      StagedWorkspaceReviewSchema.parse({
        id: 'swr_1',
        changeSetId: changeSet.id,
        workspaceId: 'ws_demo',
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: 'staging://workspace/swr_1',
          branch: 'openkit/review/swr_1',
        },
        diffSummary: { filesChanged: 2, additions: 7, deletions: 1 },
        riskSummary: 'Docs-only review candidate.',
        validation: [{ command: 'pnpm test', status: 'passed', ref: 'ev_test' }],
        actionCenterRowId: 'workspace-review:swr_1',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).actionCenterRowId
    ).toBe('workspace-review:swr_1');

    expect(
      ListWorkspaceSyncReviewsResponseSchema.parse({
        items: [
          {
            artifactId: 'ar_workspace_changes_1',
            changeSet,
            patchPayload: {
              mediaType: 'text/x-diff',
              text: 'diff --git a/docs/spec.md b/docs/spec.md\n',
              digest: 'sha256:patch',
              bytes: 41,
            },
            review: {
              id: 'swr_1',
              changeSetId: changeSet.id,
              workspaceId: 'ws_demo',
              status: 'pending',
              staging: {
                strategy: 'git_worktree',
                ref: 'staging://workspace/swr_1',
                branch: 'openkit/review/swr_1',
              },
              diffSummary: { filesChanged: 2, additions: 7, deletions: 1 },
              riskSummary: 'Docs-only review candidate.',
              validation: [{ command: 'pnpm test', status: 'passed', ref: 'ev_test' }],
              actionCenterRowId: 'workspace-review:swr_1',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
        ],
      }).items[0]?.artifactId
    ).toBe('ar_workspace_changes_1');

    const applyResult = {
      id: 'war_swr_1',
      workspaceId: 'ws_demo',
      reviewId: 'swr_1',
      changeSetId: changeSet.id,
      status: 'applied',
      appliedPaths: ['docs/spec.md', 'docs/new.md'],
      skippedPaths: [],
      conflictRecords: [],
      verification: [{ command: 'git apply --check', status: 'passed', ref: null }],
      commitIds: [],
      appliedAt: timestamp,
    };

    expect(
      ListWorkspaceApplyResultsResponseSchema.parse({ items: [applyResult] }).items[0]?.id
    ).toBe('war_swr_1');
    expect(GetWorkspaceApplyResultResponseSchema.parse(applyResult).reviewId).toBe('swr_1');
    expect(
      SubmitWorkspaceSyncReviewDecisionRequestSchema.parse({
        requestId: 'workspace-sync-review-request-1',
        decision: 'needs_refinement',
        message: 'Please narrow the patch.',
      }).decision
    ).toBe('needs_refinement');
    expect(
      SubmitWorkspaceSyncReviewDecisionResponseSchema.parse({
        review: {
          id: 'swr_1',
          changeSetId: changeSet.id,
          workspaceId: 'ws_demo',
          status: 'needs_refinement',
          staging: {
            strategy: 'git_worktree',
            ref: 'staging://workspace/swr_1',
            branch: 'openkit/review/swr_1',
          },
          diffSummary: { filesChanged: 2, additions: 7, deletions: 1 },
          riskSummary: 'Docs-only review candidate.',
          validation: [{ command: 'pnpm test', status: 'passed', ref: 'ev_test' }],
          actionCenterRowId: 'workspace-review:swr_1',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        workspaceApplyResult: null,
      }).review.status
    ).toBe('needs_refinement');
    expect(
      SubmitWorkspaceRecoveryDecisionRequestSchema.parse({
        requestId: 'workspace-recovery-request-1',
        decision: 'resume_collection',
        message: 'Resume durable recovery collection.',
      }).decision
    ).toBe('resume_collection');
    expect(WorkspaceRecoveryDecisionSchema.parse('resume_collection')).toBe('resume_collection');
    expect(
      SubmitWorkspaceRecoveryDecisionResponseSchema.parse({
        reconciliationRecord: {
          id: 'wrr_decision_1',
          workspaceId: 'ws_demo',
          triggerReason: 'manual',
          affectedRecordIds: ['wmr_1', 'bwh_1'],
          backendHandleSummary: {},
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: ['wom_1'],
          evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
          stateBefore: 'requires-human',
          stateAfter: 'quarantined',
          quarantineRefs: [],
          requiredHumanDecision: null,
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: timestamp,
        },
      }).reconciliationRecord.stateAfter
    ).toBe('quarantined');
    expect(
      ListWorkspaceInputSnapshotsResponseSchema.parse({
        items: [
          {
            id: 'wis_1',
            workspaceId: 'ws_demo',
            resourceId: 'repo_default',
            resourceKind: 'git_repository',
            strategy: 'git',
            pathScope: ['repo_default'],
            writableRoots: ['repo_default'],
            ignoredPaths: [],
            generatedFiles: [],
            base: { commit: 'abc123', contentDigest: null },
            backend: { kind: 'openshell', label: 'OpenShell', capabilitySummary: [] },
            createdAt: timestamp,
          },
        ],
      }).items[0]?.id
    ).toBe('wis_1');
    expect(
      ListWorkspaceMaterializationRecordsResponseSchema.parse({
        items: [
          {
            id: 'wmr_1',
            inputSnapshotId: 'wis_1',
            workspaceId: 'ws_demo',
            backendKind: 'openshell',
            packageSnapshotId: 'aepsnap_1',
            workerSessionId: 'session_1',
            strategy: 'git',
            materializedRootRef: 'workspace://ws_demo/repo_default',
            base: { commit: 'abc123', contentDigest: null },
            policyDigest: 'sha256:policy',
            readinessEvidence: [],
            createdAt: timestamp,
          },
        ],
      }).items[0]?.id
    ).toBe('wmr_1');
    expect(
      ListBackendWorkspaceHandlesResponseSchema.parse({
        items: [
          {
            backendKind: 'openshell',
            cleanupStatus: 'pending',
            createdAt: timestamp,
            id: 'bwh_1',
            materializationRecordId: 'wmr_1',
            packageSnapshotId: 'aepsnap_1',
            retention: 'until-reconciliation',
            transportRefs: [{ kind: 'materialized-root', ref: 'workspace://ws_demo/repo_default' }],
            updatedAt: timestamp,
            workerSessionId: 'session_1',
            workspaceId: 'ws_demo',
          },
        ],
      }).items[0]?.id
    ).toBe('bwh_1');
    expect(
      ListWorkerOutputManifestsResponseSchema.parse({ items: [outputManifest] }).items[0]?.id
    ).toBe('wom_1');
    const applyPlan = WorkspaceApplyPlanSchema.parse({
      id: 'wap_1',
      workspaceId: 'ws_demo',
      reviewId: 'swr_1',
      changeSetId: changeSet.id,
      strategy: 'git',
      approvalState: 'approved',
      plannedWrites: ['docs/spec.md', 'docs/new.md'],
      baselineChecks: [{ command: 'git apply --check', status: 'passed', ref: null }],
      pathConflicts: [],
      binaryRisks: [],
      permissionChanges: [],
      policyChecks: [
        { command: 'repo.push policy gate not required', status: 'skipped', ref: null },
      ],
      createdAt: timestamp,
    });
    expect(ListWorkspaceApplyPlansResponseSchema.parse({ items: [applyPlan] }).items[0]?.id).toBe(
      'wap_1'
    );
    const reconciliation = WorkspaceReconciliationRecordSchema.parse({
      id: 'wrr_1',
      workspaceId: 'ws_demo',
      triggerReason: 'restart',
      affectedRecordIds: ['wmr_1', 'bwh_1'],
      backendHandleSummary: {
        backendKind: 'openshell',
        handleId: 'bwh_1',
        workerSessionId: 'session_1',
        cleanupStatus: 'pending',
      },
      backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
      collectedOutputManifestIds: ['wom_1'],
      evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
      stateBefore: 'ready',
      stateAfter: 'requires-human',
      quarantineRefs: [],
      requiredHumanDecision: 'inspect_recovery',
      retentionDecision: 'retain-backend',
      startedAt: timestamp,
      finishedAt: null,
    });
    expect(
      ListWorkspaceReconciliationRecordsResponseSchema.parse({ items: [reconciliation] }).items[0]
        ?.id
    ).toBe('wrr_1');
    expect(
      ListHumanAttentionResponseSchema.parse({
        items: [
          {
            id: 'workspace-recovery:wrr_1',
            kind: 'blocked_turn',
            workspaceId: 'ws_demo',
            title: 'Workspace recovery needs review',
            summary: 'Recovery requires a human decision: inspect_recovery.',
            severity: 'blocked',
            createdAt: timestamp,
            recommendedAction:
              'Review the recovery evidence and choose how NanoCore should proceed.',
            source: {
              type: 'workspace_recovery',
              reconciliationRecordId: 'wrr_1',
              workspaceId: 'ws_demo',
              triggerReason: 'restart',
              stateAfter: 'requires-human',
              affectedRecordIds: ['wmr_1', 'bwh_1'],
              evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
              requiredHumanDecision: 'inspect_recovery',
            },
            actions: [
              {
                kind: 'open_artifact',
                label: 'Open evidence',
                method: 'GET',
                href: '/api/app/workspaces/ws_demo/workspace-sync/reconciliation-records',
              },
              {
                kind: 'retry_work',
                label: 'Resume collection',
                method: 'POST',
                href: '/api/app/workspaces/ws_demo/workspace-sync/reconciliation-records/wrr_1/decision',
              },
              { kind: 'accept_review', label: 'Stage verified', disabled: true },
              { kind: 'mark_blocked', label: 'Quarantine', disabled: true },
              { kind: 'abort', label: 'Abandon', disabled: true },
            ],
          },
        ],
      }).items[0]?.source.type
    ).toBe('workspace_recovery');
    const quarantine = WorkspaceQuarantineRecordSchema.parse({
      id: 'wqr_1',
      workspaceId: 'ws_demo',
      lifecycleRecordIds: ['wrr_1', 'wom_1'],
      failureKind: 'digest_mismatch',
      storageRef: 'quarantine/workspace-sync/wqr_1',
      retentionClass: 'restricted-evidence',
      requiredHumanDecision: 'inspect_quarantined_output',
      resolution: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
    });
    expect(
      ListWorkspaceQuarantineRecordsResponseSchema.parse({ items: [quarantine] }).items[0]?.id
    ).toBe('wqr_1');
    expect(ListWorkspaceChangeSetsResponseSchema.parse({ items: [changeSet] }).items[0]?.id).toBe(
      changeSet.id
    );
    expect(
      ListStagedWorkspaceReviewsResponseSchema.parse({
        items: [
          {
            id: 'swr_1',
            changeSetId: changeSet.id,
            workspaceId: 'ws_demo',
            status: 'pending',
            staging: {
              strategy: 'git_worktree',
              ref: 'staging://workspace/swr_1',
              branch: 'openkit/review/swr_1',
            },
            diffSummary: { filesChanged: 2, additions: 7, deletions: 1 },
            riskSummary: 'Docs-only review candidate.',
            validation: [{ command: 'pnpm test', status: 'passed', ref: 'ev_test' }],
            actionCenterRowId: 'workspace-review:swr_1',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      }).items[0]?.id
    ).toBe('swr_1');
  });

  it('rejects unsafe workspace synchronization paths and secret-like payloads', () => {
    const payload = {
      id: 'wcs_unsafe',
      materializationRecordId: 'wmr_1',
      inputSnapshotId: 'wis_1',
      workspaceId: 'ws_demo',
      resourceId: 'default',
      strategy: 'git',
      base: { commit: 'abc123', contentDigest: null },
      head: { commit: 'def456', contentDigest: null },
      changedPaths: [{ path: '/Users/m5pro/Documents/AI/openkit/secret.txt', status: 'modified' }],
      patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 12 },
      bundle: null,
      artifactIds: [],
      evidenceRefs: [],
      redaction: { status: 'redacted', notes: ['ghp_openkit_secret'] },
      createdAt: timestamp,
    };

    expect(WorkspaceChangeSetSchema.safeParse(payload).success).toBe(false);
    expect(
      WorkerOutputManifestSchema.safeParse({
        id: 'wom_unsafe',
        workspaceId: 'ws_demo',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workerSessionId: 'session_1',
        backendKind: 'openshell',
        strategy: 'git',
        changedPaths: [{ path: '../secret.txt', status: 'modified' }],
        artifactIds: [],
        logRefs: [
          { kind: 'worker-log', ref: 'ghp_openkit_secret', digest: 'sha256:log', bytes: 1 },
        ],
        testOutputRefs: [],
        ignoredOutputs: [],
        evidenceRefs: [],
        collectedAt: timestamp,
      }).success
    ).toBe(false);
    expect(
      WorkspaceApplyPlanSchema.safeParse({
        id: 'wap_unsafe',
        workspaceId: 'ws_demo',
        reviewId: 'swr_1',
        changeSetId: 'wcs_1',
        strategy: 'git',
        approvalState: 'approved',
        plannedWrites: ['../secret.txt'],
        baselineChecks: [],
        pathConflicts: ['ghp_openkit_secret'],
        binaryRisks: [],
        permissionChanges: [],
        policyChecks: [],
        createdAt: timestamp,
      }).success
    ).toBe(false);
    expect(
      WorkspaceReconciliationRecordSchema.safeParse({
        id: 'wrr_unsafe',
        workspaceId: 'ws_demo',
        triggerReason: 'restart',
        affectedRecordIds: ['ghp_openkit_secret'],
        backendHandleSummary: { backendKind: 'openshell', handleId: 'bwh_1' },
        backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
        collectedOutputManifestIds: [],
        evidenceBundleIds: [],
        stateBefore: 'ready',
        stateAfter: 'quarantined',
        quarantineRefs: ['../secret.txt'],
        requiredHumanDecision: null,
        retentionDecision: 'retain-backend',
        startedAt: timestamp,
        finishedAt: null,
      }).success
    ).toBe(false);
    expect(
      WorkspaceQuarantineRecordSchema.safeParse({
        id: 'wqr_unsafe',
        workspaceId: 'ws_demo',
        lifecycleRecordIds: ['ghp_openkit_secret'],
        failureKind: 'schema_failure',
        storageRef: '../secret.txt',
        retentionClass: 'restricted-evidence',
        requiredHumanDecision: null,
        resolution: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
      }).success
    ).toBe(false);
  });

  it('accepts redacted Agent Environment Package snapshot records', () => {
    const snapshot = {
      snapshotId: 'aepsnap_1',
      packageId: 'aepkg_1',
      scope: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        agentSessionId: 'as_demo',
      },
      agent: {
        agentId: 'agent_codex',
        runtimeKind: 'coder',
      },
      backend: {
        preferred: 'openshell',
      },
    };

    const record = GetAgentEnvironmentPackageSnapshotResponseSchema.parse({
      snapshotId: 'aepsnap_1',
      workspaceId: 'ws_demo',
      turnId: 'turn_demo',
      threadId: 'th_demo',
      agentSessionId: 'as_demo',
      agentId: 'agent_codex',
      packageId: 'aepkg_1',
      runtimeKind: 'coder',
      backendKind: 'openshell',
      contentDigest: '0123456789abcdef',
      snapshot,
      createdAt: timestamp,
    });

    expect(record.snapshot).toEqual(snapshot);
    expect(
      ListAgentEnvironmentPackageSnapshotsResponseSchema.parse({ items: [record] }).items[0]
        ?.snapshotId
    ).toBe('aepsnap_1');
    expect(() =>
      GetAgentEnvironmentPackageSnapshotResponseSchema.parse({
        ...record,
        snapshot: { ...snapshot, secret: 'sk-demo' },
      })
    ).toThrow();
  });

  it('rejects removed app diagnostics compatibility fields', () => {
    const payload = appDiagnosticsPayload();

    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        defaultProvider: { configured: false, reason: 'unset' },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        oauth: {
          openaiCodexAccounts: {
            accounts: [
              {
                accountSlotId: 'default',
                boundProviderIds: [],
                isDefault: true,
                providerId: 'openai_codex',
                status: 'logged_out',
              },
            ],
            defaultAccountSlotId: 'default',
          },
        },
      }).success
    ).toBe(false);
  });

  it('rejects raw-secret-shaped strings from app diagnostics responses', () => {
    for (const rawSecret of rawSecretShapes) {
      expect(
        AppDiagnosticsResponseSchema.safeParse({
          ...appDiagnosticsPayload(),
          providers: {
            diagnostics: [
              {
                code: 'invalid-provider-profile',
                message: `Provider failed with ${rawSecret}`,
                profileId: 'provider_demo',
                source: 'config/providers/provider-demo.provider.jsonc',
                status: 'blocked',
              },
            ],
            registry: [],
          },
        }).success
      ).toBe(false);
      expect(
        AppDiagnosticsResponseSchema.safeParse({
          ...appDiagnosticsPayload(),
          runtimeConfig: {
            ...runtimeConfigStatus(),
            lastFailedReload: {
              at: timestamp,
              mode: 'safe',
              dryRun: false,
              previousVersion: 1,
              currentVersion: 1,
              status: 'failed',
              message: `Reload failed with ${rawSecret}`,
            },
          },
        }).success
      ).toBe(false);
    }
  });

  it('keeps AgentSession continuity out of ordinary App API schemas', () => {
    expect(appApiSchemas.ThreadDashboardResponseSchema.shape).not.toHaveProperty('activeSession');
    expect(RuntimeConfigStatusSchema.shape).not.toHaveProperty('staleSessions');
    expect(appApiSchemas).not.toHaveProperty('RestartRuntimeConfigStaleSessionResponseSchema');
  });

  it('keeps AgentSession identity out of ordinary agent health refresh schemas', () => {
    expect(appApiSchemas.AgentHealthRefreshResponseSchema.shape).not.toHaveProperty('sessions');
  });

  it('keeps AgentSession identity out of ordinary Action Center schemas', () => {
    expect(appApiSchemas.HumanAttentionRowSchema.shape).not.toHaveProperty('agentSessionId');
    expect(appApiSchemas.WorkerControlRejectionHumanAttentionSourceSchema.shape).not.toHaveProperty(
      'agentSessionId'
    );
    expect(appApiSchemas.SchedulerOrphanWorkerHumanAttentionSourceSchema.shape).not.toHaveProperty(
      'agentSessionId'
    );
  });

  it('keeps AgentSession identity out of ordinary embedded Turn projections', () => {
    const turn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_1' },
      items: [],
      status: 'running' as const,
      humanGate: null,
      error: null,
      agentSessionId: 'as_hidden',
      configVersion: null,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
    };
    const dashboard = appApiSchemas.ThreadDashboardResponseSchema.parse({
      thread: {
        id: 'th_demo',
        workspaceId: 'ws_demo',
        name: 'Demo',
        preview: 'Demo',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      turns: [turn],
      artifacts: [],
      workStatus: {
        currentMode: 'chat',
        selectedAgentId: null,
        activeTurnStatus: 'running',
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        latestArtifact: null,
        routing: {
          decision: 'idle',
          explanation: 'Idle.',
          selectedAgentId: null,
          confidence: null,
          requiredUserAction: null,
        },
      },
      composer: {
        disabled: false,
        defaultModelId: null,
        defaultAgentId: null,
      },
      itemLog: { href: '/api/app/workspaces/ws_demo/threads/th_demo/items' },
    });
    const chat = StartChatModeResponseSchema.parse({
      outcome: 'answered',
      explanation: 'Answered.',
      turn,
      item: {
        id: 'it_chat_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'tu_demo',
        type: 'status',
        status: 'completed',
        level: 'info',
        title: 'Answered',
        summary: 'Answered.',
        createdAt: timestamp,
        completedAt: timestamp,
      },
      handoff: null,
    });
    const task = StartTaskModeResponseSchema.parse({
      state: 'running',
      turn,
      evidence: { itemIds: [], artifactIds: [] },
    });

    expect(jsonContainsKey(dashboard, 'agentSessionId')).toBe(false);
    expect(jsonContainsKey(chat, 'agentSessionId')).toBe(false);
    expect(jsonContainsKey(task, 'agentSessionId')).toBe(false);
    expect(
      jsonContainsKey(z.toJSONSchema(appApiSchemas.ThreadDashboardResponseSchema), 'agentSessionId')
    ).toBe(false);
    expect(jsonContainsKey(z.toJSONSchema(StartChatModeResponseSchema), 'agentSessionId')).toBe(
      false
    );
    expect(jsonContainsKey(z.toJSONSchema(StartTaskModeResponseSchema), 'agentSessionId')).toBe(
      false
    );
    expect(jsonContainsKey(z.toJSONSchema(RuntimeEvidenceRecordSchema), 'agentSessionId')).toBe(
      true
    );
  });

  it('accepts setup diagnostics and runtime config reload responses', () => {
    expect(
      SetupDiagnosticsResponseSchema.parse(setupDiagnosticsPayload()).runtimeConfig.currentVersion
    ).toBe(1);

    expect(RuntimeConfigReloadResponseSchema.parse(runtimeConfigReloadResponse()).status).toBe(
      'applied'
    );
  });

  it('accepts workspace data source runtime config file metadata', () => {
    expect(
      RuntimeConfigFileListResponseSchema.parse({
        files: [
          {
            id: 'workspaces/ws_demo/data-sources.jsonc',
            kind: 'data-source',
            path: 'workspaces/ws_demo/data-sources.jsonc',
            exists: true,
            revision: 'sha256:abc',
            updatedAt: timestamp,
          },
        ],
      }).files[0]?.kind
    ).toBe('data-source');
    expect(
      RuntimeConfigFileWriteRequestSchema.parse({
        id: 'workspaces/ws_demo/data-sources.jsonc',
        kind: 'data-source',
        content: '{"schemaVersion":1,"sources":[]}',
      }).kind
    ).toBe('data-source');
    expect(
      RuntimeConfigSchemaCatalogResponseSchema.parse({
        schemas: [{ kind: 'data-source', title: 'Workspace data sources', schema: {} }],
      }).schemas[0]?.kind
    ).toBe('data-source');
  });

  it('accepts owner-derived Task Mode state without exposing the launch decision', () => {
    expect(
      TaskModeWorkerTargetSchema.safeParse({
        agentId: 'agent_fourth_runtime',
        displayName: 'Fourth Runtime Agent',
        runtime: 'codex',
      }).success
    ).toBe(false);
    expect(
      TaskModeWorkerTargetSchema.parse({
        agentId: 'agent_fourth_runtime',
        displayName: 'Fourth Runtime Agent',
      })
    ).toEqual({
      agentId: 'agent_fourth_runtime',
      displayName: 'Fourth Runtime Agent',
    });
    expect(StartTaskModeRequestSchema.safeParse({ input: 'Missing request id.' }).success).toBe(
      false
    );
    expect(
      StartTaskModeRequestSchema.safeParse({
        input: 'Implement the focused fix.',
        requestId: 'req_task_1',
      }).success
    ).toBe(false);
    expect(
      StartTaskModeRequestSchema.parse({
        input: 'Implement the focused fix.',
        requestId: '0190f4c8-0000-7000-8000-000000000301',
      }).input
    ).toBe('Implement the focused fix.');
    const taskResponse = StartTaskModeResponseSchema.parse({
      decision: {
        mode: 'task',
        sourceAgentId: 'worker-coordinator',
        worker: {
          agentId: 'agent_codex_host',
          displayName: 'Codex Host Agent',
        },
        confidence: 0.86,
        rationale: 'The request needs bounded worker execution.',
        requiredApprovals: [],
        expectedStopCondition: 'one bounded worker turn',
        escalationRecommended: false,
        contextRefs: [
          { kind: 'workspace', id: 'ws_demo' },
          { kind: 'thread', id: 'th_demo' },
          { kind: 'knowledge', id: 'mem_project' },
        ],
      },
      state: 'completed',
      turn: {
        id: 'tu_task_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_1' },
        items: [],
        status: 'completed',
        configVersion: null,
        feedback: null,
        error: null,
        humanGate: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 1,
      },
      completion: {
        itemId: 'it_assistant_tu_task_1',
        text: 'Completed by worker.',
      },
      evidence: {
        itemIds: ['it_assistant_tu_task_1'],
        artifactIds: ['ar_task_result'],
        reviewIds: ['swr_task_result'],
      },
    });

    expect(taskResponse).not.toHaveProperty('decision');
    expect(taskResponse.completion).toEqual({
      itemId: 'it_assistant_tu_task_1',
      text: 'Completed by worker.',
    });
    expect(taskResponse.evidence).toEqual({
      itemIds: ['it_assistant_tu_task_1'],
      artifactIds: ['ar_task_result'],
      reviewIds: ['swr_task_result'],
    });
    expect(TaskModeAttemptStateSchema.parse('cancelled')).toBe('cancelled');
    expect(() => TaskModeAttemptStateSchema.parse('needs-review')).toThrow();
    expect(
      StartTaskModeResponseSchema.parse({
        state: 'escalated-to-goal',
        escalation: {
          targetMode: 'goal',
          goalId: 'goal_1',
          reason: 'The request needs explicit Goal Mode planning.',
        },
        evidence: {
          itemIds: ['it_task_goal'],
          artifactIds: [],
        },
        turn: {
          id: 'tu_task_goal',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          triggerActor: { kind: 'user', id: 'user_1' },
          items: [],
          status: 'completed',
          configVersion: null,
          feedback: null,
          error: null,
          humanGate: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 1,
        },
      }).escalation?.goalId
    ).toBe('goal_1');
  });

  it('accepts Chat Mode Assistant answers and handoff projections', () => {
    expect(ChatModeOutcomeSchema.safeParse('failed').success).toBe(false);
    expect(StartChatModeRequestSchema.safeParse({ input: 'Missing request id.' }).success).toBe(
      false
    );
    expect(
      StartChatModeRequestSchema.parse({
        input: 'What is this workspace?',
        requestId: 'req_chat_1',
      }).input
    ).toBe('What is this workspace?');
    expect(
      StartChatModeResponseSchema.parse({
        outcome: 'task-handoff',
        explanation: 'The request needs bounded worker execution.',
        handoff: {
          targetMode: 'task',
          reason: 'The request needs bounded worker execution.',
          statusItemId: 'it_chat_status_1',
        },
        turn: {
          id: 'tu_chat_1',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          triggerActor: { kind: 'user', id: 'user_1' },
          items: [],
          status: 'completed',
          configVersion: null,
          feedback: null,
          error: null,
          humanGate: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 1,
        },
        item: {
          id: 'it_chat_status_1',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_chat_1',
          type: 'status',
          status: 'completed',
          level: 'info',
          title: 'Task Mode handoff',
          summary: 'The request needs bounded worker execution.',
          createdAt: timestamp,
          completedAt: timestamp,
        },
      }).handoff?.targetMode
    ).toBe('task');
  });

  it.each([
    ['Quick Chat', QuickChatRequestSchema, { input: 'Hello' }],
    [
      'Chat Mode',
      StartChatModeRequestSchema,
      { input: 'Hello', requestId: 'req_chat_provider_authority' },
    ],
  ])('rejects caller provider and model authority from %s requests', (_name, schema, input) => {
    for (const override of [{ providerId: 'caller-provider' }, { model: 'caller-model' }]) {
      expect(schema.safeParse({ ...input, ...override }).success).toBe(false);
    }
  });

  it('rejects caller Workspace authority from Quick Chat requests', () => {
    expect(
      QuickChatRequestSchema.safeParse({ input: 'Hello', workspaceId: 'ws_caller_selected' })
        .success
    ).toBe(false);
  });

  it('accepts redacted workspace repository resources and rejects raw local paths', () => {
    const repository = {
      workspaceId: 'ws_demo',
      resourceId: 'repo_default',
      type: 'git_repository',
      displayName: 'OpenKit',
      diagnosticsStatus: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      pathSummary: 'local directory "openkit"',
      git: {
        authorEmail: 'approver@example.invalid',
        authorName: 'Approving Human',
        allowedPushTargets: ['openkit/release'],
        commitOnApply: true,
        protectedBranchPatterns: ['main', 'release/*'],
        requireReviewLinkage: true,
        stagingStrategy: 'review-branch',
      },
      validation: {
        ok: true,
        resourceKind: 'git_repository',
        status: 'ready',
        summary: 'local directory "openkit" is ready as a git repository.',
        pathSummary: 'local directory "openkit"',
      },
    };

    expect(WorkspaceRepositoryResourceSchema.parse(repository)).toMatchObject({
      resourceId: 'repo_default',
      diagnosticsStatus: 'ready',
      git: {
        authorEmail: 'approver@example.invalid',
        authorName: 'Approving Human',
        allowedPushTargets: ['openkit/release'],
        commitOnApply: true,
        protectedBranchPatterns: ['main', 'release/*'],
        requireReviewLinkage: true,
        stagingStrategy: 'review-branch',
      },
    });
    expect(
      WorkspaceRepositoryResourceSchema.safeParse({
        ...repository,
        localPath: '/Users/example/openkit',
      }).success
    ).toBe(false);
    expect(
      WorkspaceRepositoryResourceSchema.safeParse({
        ...repository,
        pathSummary: 'local directory "task-real-worker-repo"',
        validation: {
          ...repository.validation,
          summary: 'local directory "task-real-worker-repo" is ready as a git repository.',
          pathSummary: 'local directory "task-real-worker-repo"',
        },
      }).success
    ).toBe(true);
    expect(
      WorkspaceRepositoryResourceSchema.safeParse({
        ...repository,
        displayName: '/Users/example/openkit',
      }).success
    ).toBe(false);
    expect(
      WorkspaceRepositoryResourceSchema.safeParse({
        ...repository,
        displayName: 'C:\\Users\\example\\openkit',
      }).success
    ).toBe(false);
    expect(
      WorkspaceRepositoryResourceSchema.safeParse({
        ...repository,
        displayName: 'OpenKit at /Users/example/other',
      }).success
    ).toBe(false);
    expect(
      ListWorkspaceRepositoriesResponseSchema.parse({
        items: [repository],
        defaultResourceId: 'repo_default',
        defaultResource: repository,
      }).defaultResource?.resourceId
    ).toBe('repo_default');
    expect(
      SetWorkspaceRepositoryResponseSchema.parse({
        repository,
      }).repository.resourceId
    ).toBe('repo_default');
    expect(
      WorkspaceRepositoryResourceSchema.parse({
        ...repository,
        git: {
          authorEmail: null,
          authorName: null,
          commitOnApply: false,
        },
      }).git
    ).toMatchObject({
      allowedPushTargets: [],
      protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
      requireReviewLinkage: true,
      stagingStrategy: 'staging-root',
      vaultGrantRef: null,
    });
  });

  it('accepts redacted Git push records and rejects raw secrets or host paths', () => {
    const pushRecord = {
      id: 'gpr_1',
      workspaceId: 'ws_demo',
      repositoryResourceId: 'repo_default',
      approvalRowId: 'har_1',
      policyDecisionId: 'pd_1',
      actorId: 'user_1',
      remoteSummary: 'GitHub repository openkit on origin',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
      reviewIds: ['swr_1'],
      remoteHeadBefore: 'def456',
      remoteHeadAfter: 'abc123',
      outcome: 'pushed',
      errorSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(GitPushRecordSchema.parse(pushRecord).outcome).toBe('pushed');
    expect(
      GitPushRecordSchema.parse({
        ...pushRecord,
        errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
        outcome: 'unsupported-provider',
        remoteHeadAfter: null,
        remoteHeadBefore: null,
      }).outcome
    ).toBe('unsupported-provider');
    expect(
      ListGitPushRecordsResponseSchema.parse({
        items: [pushRecord],
      }).items[0]?.id
    ).toBe('gpr_1');
    expect(GetGitPushRecordResponseSchema.parse(pushRecord).id).toBe('gpr_1');
    expect(
      GitPushRecordSchema.safeParse({
        ...pushRecord,
        remoteSummary: 'GitHub repository at /Users/example/openkit',
      }).success
    ).toBe(false);
    expect(
      GitPushRecordSchema.safeParse({
        ...pushRecord,
        errorSummary: 'auth failed for ghp_openkit_secret',
      }).success
    ).toBe(false);
  });

  it('accepts Git push approval requests without caller-authored remote identity', () => {
    const request = {
      requestId: '00000000-0000-4000-8000-000000000024',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
    };
    const approval = {
      id: 'ap_git_push_1',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      kind: 'permission',
      status: 'pending',
      title: 'Approve Git push to main',
      description: 'Publish abc123 to GitHub repository openkit on origin.',
      createdAt: timestamp,
      resolvedAt: null,
    };

    expect(RequestGitPushApprovalRequestSchema.parse(request)).toEqual(request);
    expect(
      RequestGitPushApprovalResponseSchema.parse({
        approval,
        approvalItemId: 'it_git_push_approval_1',
        policyDecisionId: 'pd_git_push_approval_1',
      }).approval.id
    ).toBe('ap_git_push_1');
    expect(
      RequestGitPushApprovalRequestSchema.safeParse({
        ...request,
        remoteSummary: 'GitHub repository openkit on origin',
      }).success
    ).toBe(false);
  });

  it('accepts approval-bound Git push execution requests and rejects repeated authority', () => {
    const request = {
      requestId: '00000000-0000-4000-8000-000000000026',
      approvalRequestId: 'ap_git_push_1',
    };
    const record = {
      id: 'gpr_1',
      workspaceId: 'ws_demo',
      repositoryResourceId: 'repo_default',
      approvalRowId: 'it_git_push_approval_1',
      policyDecisionId: 'pd_repo_push_granted_ap_git_push_1',
      actorId: 'user_1',
      remoteSummary: 'GitHub repository openkit on origin',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
      reviewIds: ['swr_1'],
      remoteHeadBefore: null,
      remoteHeadAfter: 'abc123',
      outcome: 'pushed',
      errorSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(ExecuteGitPushRequestSchema.parse(request)).toEqual(request);
    expect(ExecuteGitPushResponseSchema.parse(record).outcome).toBe('pushed');
    for (const repeatedAuthority of [
      { policyDecisionId: 'pd_repo_push_granted_ap_git_push_1' },
      { remoteSummary: 'GitHub repository openkit on origin' },
      { remoteName: 'origin' },
      { sourceRef: 'HEAD' },
      { targetBranch: 'main' },
      { commitIds: ['abc123'] },
    ]) {
      expect(
        ExecuteGitPushRequestSchema.safeParse({ ...request, ...repeatedAuthority }).success
      ).toBe(false);
    }
  });

  it('accepts repository diagnostics snapshots and rejects raw local paths', () => {
    const diagnostic = {
      workspaceId: 'ws_demo',
      resourceId: 'repo_default',
      type: 'git_repository',
      displayName: 'OpenKit',
      diagnosticsStatus: 'ready',
      ready: true,
      summary: 'local directory "openkit" is ready as a git repository.',
      pathSummary: 'local directory "openkit"',
      updatedAt: timestamp,
    };

    expect(
      WorkspaceRepositoryDiagnosticsResponseSchema.parse({
        workspaceId: 'ws_demo',
        defaultResourceId: 'repo_default',
        defaultResource: diagnostic,
        resources: [
          diagnostic,
          {
            ...diagnostic,
            resourceId: 'repo_missing',
            diagnosticsStatus: 'missing',
            ready: false,
            summary: 'local directory "missing" does not exist.',
            pathSummary: 'local directory "missing"',
          },
          {
            ...diagnostic,
            resourceId: 'repo_not_git',
            diagnosticsStatus: 'not_git',
            ready: false,
            summary: 'local directory "plain" is not a git repository directory.',
            pathSummary: 'local directory "plain"',
          },
          {
            ...diagnostic,
            resourceId: 'repo_inaccessible',
            diagnosticsStatus: 'inaccessible',
            ready: false,
            summary: 'local directory "private" could not be inspected.',
            pathSummary: 'local directory "private"',
          },
        ],
      }).resources.map((item) => item.diagnosticsStatus)
    ).toEqual(['ready', 'missing', 'not_git', 'inaccessible']);

    expect(
      WorkspaceRepositoryDiagnosticsResponseSchema.safeParse({
        workspaceId: 'ws_demo',
        defaultResourceId: 'repo_default',
        defaultResource: diagnostic,
        resources: [
          {
            ...diagnostic,
            localPath: '/Users/example/openkit',
          },
        ],
      }).success
    ).toBe(false);
    expect(
      WorkspaceRepositoryDiagnosticsResponseSchema.safeParse({
        workspaceId: 'ws_demo',
        defaultResourceId: 'repo_default',
        defaultResource: diagnostic,
        resources: [
          {
            ...diagnostic,
            displayName: 'Repository at /Users/example/other',
          },
        ],
      }).success
    ).toBe(false);
    expect(
      WorkspaceRepositoryDiagnosticsResponseSchema.safeParse({
        workspaceId: 'ws_demo',
        defaultResourceId: 'repo_default',
        defaultResource: diagnostic,
        resources: [
          {
            ...diagnostic,
            summary: 'Repository at /Users/example/openkit is ready.',
          },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects raw-secret-shaped strings from setup diagnostics responses', () => {
    for (const rawSecret of rawSecretShapes) {
      expect(
        SetupDiagnosticsResponseSchema.safeParse({
          ...setupDiagnosticsPayload(),
          agents: [
            {
              id: 'agent_codex',
              displayName: 'Codex Host',
              readiness: { status: 'blocked', reasons: [`leaked ${rawSecret}`] },
              setup: {
                status: 'blocked',
                deploymentMode: 'local',
                providerId: 'agent-openrouter',
                diagnostics: [
                  {
                    agentId: 'agent_codex',
                    code: 'setup_failed',
                    message: `Provider failed with ${rawSecret}`,
                    severity: 'error',
                  },
                ],
              },
            },
          ],
        }).success
      ).toBe(false);
    }
  });

  it('rejects absolute data-root paths from setup diagnostics responses', () => {
    const payload = setupDiagnosticsPayload();
    const server = payload.server as Record<string, unknown>;

    expect(
      SetupDiagnosticsResponseSchema.safeParse({
        ...payload,
        server: { ...server, dataRoot: '/private/var/openkit' },
      }).success
    ).toBe(false);
    expect(SetupDiagnosticsResponseSchema.parse(payload).server.dataRoot).toBe('configured');
  });

  it('rejects raw-secret-shaped strings from runtime reload and validation responses', () => {
    for (const rawSecret of rawSecretShapes) {
      expect(
        RuntimeConfigReloadResponseSchema.safeParse({
          ...runtimeConfigReloadResponse(),
          runtimeConfig: {
            ...runtimeConfigStatus(),
            lastReload: {
              at: timestamp,
              mode: 'safe',
              dryRun: false,
              previousVersion: 1,
              currentVersion: 2,
              status: 'failed',
              message: `Reload leaked ${rawSecret}`,
            },
          },
          plan: {
            previousVersion: 1,
            nextVersion: 2,
            applied: [
              {
                path: 'providers.openai',
                category: 'hot-swappable',
                action: 'applied',
                summary: `Applied ${rawSecret}`,
              },
            ],
            deferred: [],
            requiresRestart: [],
            rejected: [],
            warnings: [{ code: 'unsafe-warning', message: `Warning leaked ${rawSecret}` }],
          },
        }).success
      ).toBe(false);
      expect(
        RuntimeConfigValidationResponseSchema.safeParse({
          ...runtimeConfigValidationResponse(),
          diagnostics: [
            {
              fileId: 'provider:openai',
              severity: 'error',
              code: 'invalid-provider',
              message: `Diagnostic leaked ${rawSecret}`,
              source: 'config/providers/openai.provider.jsonc',
            },
          ],
          plan: {
            previousVersion: 1,
            nextVersion: 2,
            applied: [],
            deferred: [],
            requiresRestart: [],
            rejected: [
              {
                path: 'providers.openai',
                category: 'rejected',
                action: 'rejected',
                summary: `Rejected ${rawSecret}`,
              },
            ],
            warnings: [],
          },
        }).success
      ).toBe(false);
    }
  });

  it('accepts safe redacted markers and normal config paths in renderable responses', () => {
    expect(
      SetupDiagnosticsResponseSchema.parse({
        ...setupDiagnosticsPayload(),
        providers: [
          {
            id: 'provider_openai',
            displayName: 'OpenAI',
            kind: 'direct',
            vendor: 'openai',
            role: 'core',
            defaultModel: 'gpt-5.4',
            secret: { configured: true, marker: 'secret-ref', ref: 'env:OPENAI_API_KEY' },
          },
        ],
      }).providers[0]?.secret.ref
    ).toBe('env:OPENAI_API_KEY');
    expect(
      RuntimeConfigReloadResponseSchema.parse({
        ...runtimeConfigReloadResponse(),
        plan: {
          previousVersion: 1,
          nextVersion: 2,
          applied: [
            {
              path: 'config/providers/openai.provider.jsonc',
              category: 'hot-swappable',
              action: 'applied',
              summary: 'redacted secret-ref env:OPENAI_API_KEY',
            },
          ],
          deferred: [],
          requiresRestart: [],
          rejected: [],
          warnings: [
            {
              code: 'safe-warning',
              message: 'config/providers/openai.provider.jsonc uses secret-ref',
            },
          ],
        },
      }).status
    ).toBe('applied');
    expect(
      RuntimeConfigValidationResponseSchema.parse({
        ...runtimeConfigValidationResponse(),
        diagnostics: [
          {
            fileId: 'provider:openai',
            severity: 'info',
            code: 'safe-diagnostic',
            message: 'redacted provider uses env:OPENAI_API_KEY',
            source: 'config/providers/openai.provider.jsonc',
          },
        ],
      }).valid
    ).toBe(true);
    expect(
      AppDiagnosticsResponseSchema.parse({
        ...appDiagnosticsPayload(),
        providers: {
          diagnostics: [
            {
              code: 'safe-diagnostic',
              message: 'redacted secret-ref env:OPENAI_API_KEY',
              profileId: 'provider_openai',
              source: 'config/providers/openai.provider.jsonc',
              status: 'degraded',
            },
          ],
          registry: [],
        },
      }).providers.diagnostics[0]?.message
    ).toBe('redacted secret-ref env:OPENAI_API_KEY');
  });

  it('does not export the retired Codex OAuth schema family', () => {
    for (const exportName of [
      'CodexOAuthLoginModeSchema',
      'CodexOAuthStatusSchema',
      'CodexOAuthStatusPayloadSchema',
      'CodexOAuthAccountSummarySchema',
      'CodexOAuthAccountsPayloadSchema',
      'StartOpenAICodexOAuthRequestSchema',
      'CancelOpenAICodexOAuthRequestSchema',
      'CreateOpenAICodexOAuthAccountRequestSchema',
      'UpdateOpenAICodexOAuthAccountRequestSchema',
    ]) {
      expect.soft(exportName in appApiSchemas).toBe(false);
    }
  });

  it('accepts only strict provider-subscription operation requests', () => {
    const createSchema = Reflect.get(
      appApiSchemas,
      'CreateProviderSubscriptionAccountRequestSchema'
    ) as typeof AppDiagnosticsResponseSchema | undefined;
    const updateSchema = Reflect.get(
      appApiSchemas,
      'UpdateProviderSubscriptionAccountRequestSchema'
    ) as typeof AppDiagnosticsResponseSchema | undefined;
    const startLoginSchema = Reflect.get(
      appApiSchemas,
      'StartProviderSubscriptionAccountLoginRequestSchema'
    ) as typeof AppDiagnosticsResponseSchema | undefined;
    const cancelLoginSchema = Reflect.get(
      appApiSchemas,
      'CancelProviderSubscriptionAccountLoginRequestSchema'
    ) as typeof AppDiagnosticsResponseSchema | undefined;

    for (const schema of [createSchema, updateSchema, startLoginSchema, cancelLoginSchema]) {
      expect.soft(schema).toBeDefined();
    }
    if (!createSchema || !updateSchema || !startLoginSchema || !cancelLoginSchema) {
      return;
    }

    expect(createSchema.parse({ accountSlotId: 'work', displayName: 'Work' })).toEqual({
      accountSlotId: 'work',
      displayName: 'Work',
    });
    expect(updateSchema.parse({ displayName: 'Renamed' })).toEqual({ displayName: 'Renamed' });
    expect(startLoginSchema.parse({ mode: 'device_code' })).toEqual({ mode: 'device_code' });
    expect(cancelLoginSchema.parse({ interactionId: 'interaction_1' })).toEqual({
      interactionId: 'interaction_1',
    });

    for (const request of [
      {},
      { mode: 'browser' },
      { mode: 'unknown' },
      { mode: 'device_code', extra: true },
    ]) {
      expect(startLoginSchema.safeParse(request).success).toBe(false);
    }
    for (const request of [
      {},
      { interactionId: 'interaction_1', loginId: 'legacy' },
      { interactionId: 'id', extra: true },
    ]) {
      expect(cancelLoginSchema.safeParse(request).success).toBe(false);
    }
    expect(createSchema.safeParse({ accountSlotId: '../work' }).success).toBe(false);
    expect(createSchema.safeParse({ accountSlotId: 'work', accessToken: 'secret' }).success).toBe(
      false
    );
    expect(updateSchema.safeParse({ displayName: 'Work', extra: true }).success).toBe(false);
  });

  it('accepts strict provider inventory and sanitized account status branches', () => {
    const providersSchema = Reflect.get(appApiSchemas, 'ProviderSubscriptionsResponseSchema') as
      | typeof AppDiagnosticsResponseSchema
      | undefined;
    const accountsSchema = Reflect.get(
      appApiSchemas,
      'ProviderSubscriptionAccountsResponseSchema'
    ) as typeof AppDiagnosticsResponseSchema | undefined;
    const accountSchema = Reflect.get(appApiSchemas, 'ProviderSubscriptionAccountSchema') as
      | typeof AppDiagnosticsResponseSchema
      | undefined;

    for (const schema of [providersSchema, accountsSchema, accountSchema]) {
      expect.soft(schema).toBeDefined();
    }
    if (!providersSchema || !accountsSchema || !accountSchema) {
      return;
    }

    const providers = {
      providers: [
        {
          subscriptionProviderId: 'openai-codex',
          displayName: 'OpenAI Codex',
          loginModes: ['device_code'],
          quotaCapability: 'available',
        },
        {
          subscriptionProviderId: 'xai',
          displayName: 'xAI',
          loginModes: ['device_code'],
          quotaCapability: 'unsupported',
        },
      ],
    };
    const accountBase = {
      subscriptionProviderId: 'openai-codex',
      boundProviderIds: ['provider_a', 'provider_b'],
      createdAt: timestamp,
      displayName: 'Work account',
      accountLabel: 'Signed-in account',
      planLabel: 'Plus',
      updatedAt: timestamp,
    };
    const accounts = [
      { ...accountBase, accountSlotId: 'error', status: 'error', message: 'Login failed.' },
      { ...accountBase, accountSlotId: 'logged-in', status: 'logged_in' },
      { ...accountBase, accountSlotId: 'logged-out', status: 'logged_out' },
      {
        ...accountBase,
        accountSlotId: 'pending',
        status: 'pending',
        interaction: {
          mode: 'device_code',
          interactionId: 'interaction_1',
          verificationUrl: 'https://example.test/device',
          userCode: 'ABCD-EFGH',
          expiresAt: timestamp,
        },
      },
      {
        ...accountBase,
        accountSlotId: 'unavailable',
        status: 'unavailable',
        message: 'Provider unavailable.',
      },
    ];

    expect(providersSchema.parse(providers)).toEqual(providers);
    expect(accountsSchema.parse({ accounts })).toEqual({ accounts });
    for (const account of accounts) {
      expect(accountSchema.parse(account)).toEqual(account);
    }

    expect(
      providersSchema.safeParse({ providers: [...providers.providers].reverse() }).success
    ).toBe(false);
    expect(providersSchema.safeParse({ ...providers, extra: true }).success).toBe(false);
    expect(accountsSchema.safeParse({ accounts: [...accounts].reverse() }).success).toBe(false);
    expect(accountsSchema.safeParse({ accounts, extra: true }).success).toBe(false);
    expect(
      accountSchema.safeParse({ ...accounts[2], status: 'logged_out', message: 'not allowed' })
        .success
    ).toBe(false);
    expect(accountSchema.safeParse({ ...accounts[3], interaction: undefined }).success).toBe(false);
    expect(accountSchema.safeParse({ ...accounts[4], message: undefined }).success).toBe(false);
    for (const account of [
      { ...accounts[2], createdAt: 'not-a-datetime' },
      { ...accounts[2], updatedAt: 'not-a-datetime' },
      {
        ...accounts[3],
        interaction: {
          mode: 'device_code',
          interactionId: 'interaction_1',
          verificationUrl: 'https://example.test/device',
          userCode: 'ABCD-EFGH',
          expiresAt: 'not-a-datetime',
        },
      },
    ]) {
      expect.soft(accountSchema.safeParse(account).success).toBe(false);
    }
    for (const account of [
      { ...accounts[2], subscriptionProviderId: 'anthropic' },
      { ...accounts[2], accountSlotId: '../work' },
      { ...accounts[2], boundProviderIds: ['provider_a', 'provider_a'] },
      { ...accounts[2], boundProviderIds: ['provider_b', 'provider_a'] },
    ]) {
      expect(accountSchema.safeParse(account).success).toBe(false);
    }
    for (const secretField of [
      'accessToken',
      'refreshToken',
      'vaultReferenceId',
      'providerAccountId',
      'email',
    ]) {
      expect(accountSchema.safeParse({ ...accounts[2], [secretField]: 'secret' }).success).toBe(
        false
      );
    }
  });

  it('accepts only the three provider-subscription quota dispositions', () => {
    const quotaSchema = Reflect.get(appApiSchemas, 'ProviderSubscriptionQuotaSchema') as
      | typeof AppDiagnosticsResponseSchema
      | undefined;

    expect(quotaSchema).toBeDefined();
    if (!quotaSchema) {
      return;
    }

    const available = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'work',
      availability: 'available',
      observedAt: timestamp,
      planType: 'plus',
      windows: [
        {
          id: 'five-hour',
          usedPercent: 25,
          remainingPercent: 75,
          resetsAt: timestamp,
        },
      ],
    };
    const unsupported = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      availability: 'unsupported',
      observedAt: timestamp,
    };
    const unavailable = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'work',
      availability: 'temporarily_unavailable',
      observedAt: timestamp,
      retryAfter: timestamp,
    };

    expect(quotaSchema.parse(available)).toEqual(available);
    expect(quotaSchema.parse(unsupported)).toEqual(unsupported);
    expect(quotaSchema.parse(unavailable)).toEqual(unavailable);
    for (const quota of [
      { ...available, subscriptionProviderId: 'xai' },
      { ...unsupported, subscriptionProviderId: 'openai-codex' },
      {
        ...available,
        windows: [{ ...available.windows[0], usedPercent: 101 }],
      },
      { ...available, accountSlotId: '../work' },
      { ...available, accessToken: 'secret' },
      { ...available, rawProviderResponse: {} },
    ]) {
      expect(quotaSchema.safeParse(quota).success).toBe(false);
    }
    for (const quota of [
      { ...available, observedAt: 'not-a-datetime' },
      {
        ...available,
        windows: [{ ...available.windows[0], resetsAt: 'not-a-datetime' }],
      },
      { ...unsupported, observedAt: 'not-a-datetime' },
      { ...unavailable, observedAt: 'not-a-datetime' },
      { ...unavailable, retryAfter: 'not-a-datetime' },
    ]) {
      expect.soft(quotaSchema.safeParse(quota).success).toBe(false);
    }
  });

  it('accepts dashboard, auth, quick chat, agent catalog, and action center payloads', () => {
    expect(
      AuthSignUpEmailResponseSchema.parse({
        token: 'session_token',
        user: {
          id: 'user_1',
          email: 'user@example.com',
          name: 'Demo User',
          emailVerified: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          image: null,
        },
      }).user.id
    ).toBe('user_1');
    expect(
      AuthSignInEmailResponseSchema.parse({
        redirect: false,
        token: 'session_token',
        url: null,
        user: {
          id: 'user_1',
          email: 'user@example.com',
          name: 'Demo User',
          emailVerified: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          image: null,
        },
      }).redirect
    ).toBe(false);
    expect(AuthSignOutResponseSchema.parse({ success: true }).success).toBe(true);
    expect(AuthSignUpEmailResponseSchema.safeParse({ user: { id: 'user_1' } }).success).toBe(false);
    expect(
      ConsumeOpenKitBootstrapTokenRequestSchema.parse({
        displayName: 'Owner',
        ownerUserId: 'user_owner',
        token: 'okt_bootstrap_secret',
        tokenExpiresAt: timestamp,
      }).ownerUserId
    ).toBe('user_owner');
    expect(
      ConsumeOpenKitBootstrapTokenResponseSchema.parse({
        token: 'okt_owner_secret',
        record: {
          tokenId: 'tok_owner',
          ownerUserId: 'user_owner',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'active',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: null,
          predecessorTokenId: null,
          rotatedGraceExpiresAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
      }).record.ownerUserId
    ).toBe('user_owner');
    expect(
      CreateOpenKitAccessTokenRequestSchema.parse({
        scope: 'workspace',
        workspaceIds: ['ws_demo'],
        expiresAt: timestamp,
      }).scope
    ).toBe('workspace');
    expect(
      CreateOpenKitAccessTokenResponseSchema.parse({
        token: 'okt_openkit_secret',
        record: {
          tokenId: 'tok_1',
          ownerUserId: 'user_owner',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'active',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: null,
          predecessorTokenId: null,
          rotatedGraceExpiresAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
      }).token
    ).toBe('okt_openkit_secret');
    expect(
      ListOpenKitAccessTokensResponseSchema.parse({
        items: [
          {
            tokenId: 'tok_1',
            ownerUserId: 'user_owner',
            scope: 'server-admin',
            workspaceIds: [],
            status: 'active',
            issuedAt: timestamp,
            expiresAt: timestamp,
            revokedAt: null,
            predecessorTokenId: null,
            rotatedGraceExpiresAt: null,
            lastUsedAt: null,
            lastUsedChannel: null,
            lastUsedSource: null,
          },
        ],
      }).items[0]?.tokenId
    ).toBe('tok_1');
    expect(
      RevokeOpenKitAccessTokenResponseSchema.parse({
        record: {
          tokenId: 'tok_1',
          ownerUserId: 'user_owner',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'revoked',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: timestamp,
          predecessorTokenId: null,
          rotatedGraceExpiresAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
      }).record.status
    ).toBe('revoked');
    expect(RotateOpenKitAccessTokenRequestSchema.parse({ graceSeconds: 60 }).graceSeconds).toBe(60);
    expect(
      RotateOpenKitAccessTokenResponseSchema.parse({
        token: 'okt_rotated_secret',
        record: {
          tokenId: 'tok_2',
          ownerUserId: 'user_owner',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'active',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: null,
          predecessorTokenId: 'tok_1',
          rotatedGraceExpiresAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
        rotatedRecord: {
          tokenId: 'tok_1',
          ownerUserId: 'user_owner',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'rotated',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: null,
          predecessorTokenId: null,
          rotatedGraceExpiresAt: timestamp,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
      }).rotatedRecord.status
    ).toBe('rotated');
    expect(
      ListOpenKitAccessTokensResponseSchema.safeParse({
        items: [
          {
            tokenId: 'tok_1',
            ownerUserId: 'user_owner',
            scope: 'server-admin',
            workspaceIds: [],
            status: 'active',
            issuedAt: timestamp,
            expiresAt: timestamp,
            revokedAt: null,
            predecessorTokenId: null,
            rotatedGraceExpiresAt: null,
            lastUsedAt: null,
            lastUsedChannel: null,
            lastUsedSource: 'okt_openkit_secret',
          },
        ],
      }).success
    ).toBe(false);
    expect(
      QuickChatResponseSchema.parse({
        id: 'quick_1',
        status: 'completed',
        workspaceId: 'ws_demo',
        providerId: 'provider_demo',
        model: 'model_demo',
        content: 'ok',
      }).content
    ).toBe('ok');
    expect(
      AutomationRecordSchema.parse({
        id: 'auto_1',
        name: 'Daily summary',
        workspaceId: 'ws_demo',
        cron: '0 9 * * *',
        prompt: 'Summarize yesterday.',
        status: 'paused',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).status
    ).toBe('paused');
    expect(
      AppSearchResponseSchema.parse({
        items: [{ kind: 'thread', id: 'th_demo', title: 'Thread', workspaceId: 'ws_demo' }],
      }).items[0]?.kind
    ).toBe('thread');
    expect(
      TurnFeedbackResponseSchema.parse({
        turnId: 'turn_1',
        agentId: 'agent_1',
        rating: 'good',
        note: null,
        createdAt: timestamp,
      }).rating
    ).toBe('good');
    expect(
      SubmitTurnFeedbackRequestSchema.safeParse({ rating: 'good', note: null, extra: true }).success
    ).toBe(false);
    expect(
      WorkspaceDashboardResponseSchema.parse({
        workspace: {
          id: 'ws_demo',
          name: 'Demo',
          kind: 'code',
          status: 'active',
          defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0, providerCount: 0 },
        defaultContext: { modelId: null, agentId: null, skillIds: [] },
        agentHealth: [],
        activeWork: [],
        recentCompletions: [],
        attentionNeeded: [],
        recentThreads: [],
      }).activeWork
    ).toEqual([]);
    expect(
      ThreadGoalSummaryResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'running',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready.',
          currentTask: {
            taskId: 'task_demo',
            title: 'Run verification',
            status: 'running',
            orderIndex: 1,
          },
          taskCounts: {
            pending: 1,
            ready: 0,
            running: 1,
            reviewing: 0,
            completed: 2,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      }).goal?.goalId
    ).toBe('goal_demo');
    expect(
      ThreadGoalSummaryResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'paused',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 1,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      }).goal?.status
    ).toBe('paused');
    expect(PauseThreadGoalRequestSchema.parse({ requestId: 'req_goal_pause' })).toEqual({
      requestId: 'req_goal_pause',
    });
    expect(PauseThreadGoalRequestSchema.safeParse({}).success).toBe(false);
    expect(
      PauseThreadGoalRequestSchema.safeParse({ requestId: 'req_goal_pause', extra: true }).success
    ).toBe(false);
    expect(
      PauseThreadGoalResponseSchema.parse({
        outcome: 'paused',
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'paused',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 1,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      })
    ).toMatchObject({ outcome: 'paused', goal: { status: 'paused' } });
    expect(ResumeThreadGoalRequestSchema.parse({ requestId: 'req_goal_resume' })).toEqual({
      requestId: 'req_goal_resume',
    });
    expect(ResumeThreadGoalRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ResumeThreadGoalRequestSchema.safeParse({ requestId: 'req_goal_resume', extra: true }).success
    ).toBe(false);
    expect(
      ResumeThreadGoalResponseSchema.parse({
        outcome: 'resumed',
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'running',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 1,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      })
    ).toMatchObject({ outcome: 'resumed', goal: { status: 'running' } });
    expect(ThreadGoalSummaryResponseSchema.parse({ goal: null }).goal).toBeNull();
    expect(
      StartThreadGoalRequestSchema.parse({
        requestId: 'req_goal_start',
        objective: 'Make v0.0.6 ready to publish.',
        title: 'Ship v0.0.6',
      })
    ).toEqual({
      requestId: 'req_goal_start',
      objective: 'Make v0.0.6 ready to publish.',
      title: 'Ship v0.0.6',
    });
    expect(
      StartThreadGoalRequestSchema.safeParse({
        objective: 'Make v0.0.6 ready to publish.',
      }).success
    ).toBe(false);
    expect(
      StartThreadGoalResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'planning',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
        objectiveItemId: 'it_goal_objective',
      }).objectiveItemId
    ).toBe('it_goal_objective');
    expect(
      SubmitThreadGoalSteeringRequestSchema.parse({
        requestId: 'req_steer',
        message: 'Focus on the release notes before publishing.',
      }).message
    ).toBe('Focus on the release notes before publishing.');
    expect(
      SubmitThreadGoalSteeringResponseSchema.parse({
        state: 'queued',
        pendingTurnId: 'turn_pending_steer',
        requestId: 'req_steer',
        contentItemId: 'it_goal_steer',
        goalId: 'goal_demo',
        activeTurnId: 'turn_goal_active',
      })
    ).toEqual({
      state: 'queued',
      pendingTurnId: 'turn_pending_steer',
      requestId: 'req_steer',
      contentItemId: 'it_goal_steer',
      goalId: 'goal_demo',
      activeTurnId: 'turn_goal_active',
    });
    expect(
      SubmitThreadGoalSteeringResponseSchema.safeParse({
        state: 'blocked',
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'running',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 1,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      }).success
    ).toBe(false);
    const plan = {
      schemaVersion: 1,
      goalSummary: 'Make v0.0.6 ready to publish.',
      assumptions: ['The goal can be attempted as one bounded worker task.'],
      tasks: [
        {
          taskId: 'task_1',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          acceptanceCriteria: ['The requested objective is implemented and verified.'],
          contextBudgetTokens: 12_000,
          resources: [
            {
              kind: 'repository',
              reference: 'linked workspace repository',
              reason: 'Default workspace context for the bounded worker task.',
            },
          ],
          expectedArtifacts: [
            {
              kind: 'artifact',
              description: 'Worker result summary and implementation evidence.',
            },
          ],
          verificationChecks: [
            {
              kind: 'manual',
              description: 'Review the worker output and confirm the objective is satisfied.',
            },
          ],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review deterministic fallback output before continuing Goal Mode.',
          },
          dependsOnTaskIds: [],
          escalationConditions: [
            'Escalate if the objective needs decomposition into multiple tasks.',
          ],
        },
      ],
      risks: [
        'Deterministic fallback output is intentionally generic and may need human refinement.',
      ],
      questions: [],
      verificationApproach:
        'Use manual review for fallback-generated plans before worker execution begins.',
    };
    expect(
      CreateThreadGoalPlanResponseSchema.parse({
        status: 'awaiting_plan_approval',
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'awaiting_plan_approval',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Goal plan needs approval.',
          },
          terminalState: null,
          updatedAt: timestamp,
        },
        planItemId: 'it_goal_plan_goal_demo',
        planner: {
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          confidence: 0.84,
          rationale: 'Workflow Coordinator drafted a reviewable Goal Mode plan.',
          contextRefs: [
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: 'th_demo' },
          ],
          requiredApprovals: ['plan_approval'],
          plan,
        },
        plan,
      }).planner.plan
    ).toEqual(plan);
    expect(
      CreateThreadGoalPlanRequestSchema.parse({ requestId: 'req_goal_plan_create' }).requestId
    ).toBe('req_goal_plan_create');
    expect(
      ApproveThreadGoalPlanRequestSchema.parse({
        requestId: 'req_goal_plan_approve',
        planItemId: 'it_goal_plan_goal_demo',
      }).planItemId
    ).toBe('it_goal_plan_goal_demo');
    expect(
      ApproveThreadGoalPlanRequestSchema.safeParse({
        requestId: 'req_goal_plan_approve',
        planItemId: 'it_goal_plan_goal_demo',
        plan,
      }).success
    ).toBe(false);
    expect(
      ThreadGoalPlanSchema.safeParse({
        ...plan,
        tasks: [
          {
            ...plan.tasks[0],
            reviewPolicy: { ...plan.tasks[0].reviewPolicy, reviewers: ['internal'] },
          },
        ],
      }).success
    ).toBe(false);
    expect(
      ReviseThreadGoalPlanRequestSchema.parse({
        requestId: 'req_goal_plan_revise',
        revision: 'Split the release plan into documentation and verification tasks.',
      }).revision
    ).toBe('Split the release plan into documentation and verification tasks.');
    expect(
      ReviseThreadGoalPlanRequestSchema.safeParse({ revision: 'Missing request identity.' }).success
    ).toBe(false);
    expect(
      ReviseThreadGoalPlanRequestSchema.safeParse({
        requestId: 'req_goal_plan_revise',
        revision: 'Reject unowned input.',
        plan: {},
      }).success
    ).toBe(false);
    expect(
      ReviseThreadGoalPlanResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'planning',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
        revisionItemId: 'it_goal_plan_revision_goal_demo',
        startsWorkerTurn: false,
      }).revisionItemId
    ).toBe('it_goal_plan_revision_goal_demo');
    expect(
      ApproveThreadGoalPlanResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'running',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: null,
          taskCounts: {
            pending: 0,
            ready: 1,
            running: 0,
            reviewing: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          updatedAt: timestamp,
        },
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
        startsWorkerTurn: false,
      }).readyTasks
    ).toEqual([{ taskId: 'task_1', status: 'ready' }]);
    expect(RunThreadGoalStepRequestSchema.parse({ requestId: 'req_goal_step_1' })).toEqual({
      requestId: 'req_goal_step_1',
    });
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'req_goal_step_1',
        followUpDrainMode: 'all',
      }).success
    ).toBe(false);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'req_goal_step_1',
        reviewPolicyOverride: 'human',
      }).success
    ).toBe(false);
    expect(GoalReadModelStatusSchema.safeParse('verifying').success).toBe(false);
    expect(GoalTaskReadModelStatusSchema.safeParse('skipped').success).toBe(false);
    expect(GoalTaskReadModelStatusSchema.safeParse('needs_revision').success).toBe(false);
    expect(
      GoalTaskCountsSchema.parse({
        pending: 0,
        ready: 0,
        running: 0,
        reviewing: 0,
        needsRevision: 1,
        completed: 0,
        blocked: 0,
        failed: 0,
      })
    ).not.toHaveProperty('needsRevision');
    expect(() =>
      RunThreadGoalStepRequestSchema.parse({
        requestId: 'req_goal_step_1',
        followUpDrainMode: 'latest',
      })
    ).toThrow();
    expect(
      RunThreadGoalStepResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'reviewing',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: {
            taskId: 'task_1',
            title: 'Ship v0.0.6',
            status: 'reviewing',
            orderIndex: 0,
          },
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 1,
            completed: 0,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Worker result needs review.',
          },
          terminalState: null,
          updatedAt: timestamp,
        },
      }).goal
    ).toMatchObject({
      goalId: 'goal_demo',
      status: 'reviewing',
      currentTask: {
        taskId: 'task_1',
        status: 'reviewing',
      },
    });
    expect(RunThreadGoalStepResponseSchema.keyof().options).toEqual(['goal']);
    expect(RunThreadGoalSuperviseStepRequestSchema.parse({}).verdict).toBe('accept');
    expect(RunThreadGoalTestSuperviseStepRequestSchema.parse({}).verdict).toBe('accept');
    for (const verdict of ['accept', 'refine', 'retry', 'abort']) {
      expect(RunThreadGoalTestSuperviseStepRequestSchema.safeParse({ verdict }).success).toBe(true);
    }
    for (const verdict of ['ask_user', 'decompose', 'block']) {
      expect(RunThreadGoalTestSuperviseStepRequestSchema.safeParse({ verdict }).success).toBe(
        false
      );
    }
    expect(
      RunThreadGoalSuperviseStepResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'completed',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: {
            taskId: 'task_1',
            title: 'Ship v0.0.6',
            status: 'completed',
            orderIndex: 0,
          },
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
          terminalSummary: {
            completedTaskIds: ['task_1'],
            blockedTaskIds: [],
            artifactIds: ['artifact_release_log'],
            verificationEvidence: [
              {
                verificationId: 'verify_final',
                status: 'passed',
                summary: 'Release verification passed.',
                command: 'pnpm -w verify:release',
                artifactIds: ['artifact_release_log'],
              },
            ],
            risks: [],
            suggestedNextWork: ['Publish v0.0.6.'],
          },
          updatedAt: timestamp,
        },
        task: {
          taskId: 'task_1',
          title: 'Ship v0.0.6',
          status: 'completed',
          orderIndex: 0,
        },
        worker: {
          turnId: 'turn_worker',
          stopReason: 'completed',
          checkpointStage: 'completed',
        },
        review: {
          reviewId: 'review_goal_demo_task_1',
          verdict: 'accept',
        },
        advance: {
          outcome: 'complete_goal',
          nextReadyTaskId: null,
        },
      }).advance.outcome
    ).toBe('complete_goal');
    expect(
      RunThreadGoalTestSuperviseStepResponseSchema.parse({
        goal: {
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'completed',
          title: 'Ship v0.0.6',
          objective: 'Make v0.0.6 ready to publish.',
          currentTask: {
            taskId: 'task_1',
            title: 'Ship v0.0.6',
            status: 'completed',
            orderIndex: 0,
          },
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
          updatedAt: timestamp,
        },
        task: {
          taskId: 'task_1',
          title: 'Ship v0.0.6',
          status: 'completed',
          orderIndex: 0,
        },
        worker: {
          turnId: 'turn_worker',
          stopReason: 'completed',
          checkpointStage: 'completed',
        },
        review: {
          reviewId: 'review_goal_demo_task_1',
          verdict: 'accept',
        },
        advance: {
          outcome: 'complete_goal',
          nextReadyTaskId: null,
        },
      }).advance.outcome
    ).toBe('complete_goal');
    expect(
      ListInterruptedWorkerStatesResponseSchema.parse({
        items: [
          {
            kind: 'interrupted_worker_state',
            checkpointId: 'ws_demo:th_demo:turn_demo',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            goalId: null,
            taskId: null,
            stage: 'running_worker',
            iteration: 1,
            workerSessionId: 'deterministic-worker',
            contextDigest: 'deterministic:turn_demo',
            contextAssembly: {
              contextDigest: 'deterministic:turn_demo',
              contextRefs: [
                { kind: 'workspace', id: 'ws_demo' },
                { kind: 'thread', id: 'th_demo' },
              ],
            },
            stopReason: null,
            diagnosticsSummary: 'Interrupted before terminal save.',
            replayInstruction: false,
            choices: [
              {
                kind: 'inspect',
                label: 'Inspect interrupted worker evidence',
                recommended: true,
              },
              {
                kind: 'retry',
                label: 'Retry interrupted worker turn',
              },
              {
                kind: 'request_human',
                label: 'Ask the user how to recover this worker turn',
              },
            ],
            materializedAt: timestamp,
            sourceUpdatedAt: timestamp,
          },
        ],
      }).items[0]?.contextAssembly
    ).toEqual({
      contextDigest: 'deterministic:turn_demo',
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
    });
    for (const unownedStage of ['reviewing', 'verifying', 'saving', 'recovering']) {
      expect(WorkerRecoveryStageSchema.safeParse(unownedStage).success).toBe(false);
    }
    expect(WorkerRecoveryStageSchema.parse('failed')).toBe('failed');
    expect(
      RetryInterruptedWorkerCheckpointRequestSchema.parse({ requestId: 'req_worker_retry' })
    ).toEqual({ requestId: 'req_worker_retry' });
    expect(RetryInterruptedWorkerCheckpointRequestSchema.safeParse({}).success).toBe(false);
    expect(
      RetryInterruptedWorkerCheckpointRequestSchema.safeParse({
        requestId: 'req_worker_retry',
        retryMode: 'resume',
      }).success
    ).toBe(false);
    expect(
      RetryInterruptedWorkerCheckpointResponseSchema.parse({
        outcome: 'released_for_retry',
        turnId: 'turn_demo',
      })
    ).toEqual({ outcome: 'released_for_retry', turnId: 'turn_demo' });
    expect(CancelSchedulerAdmissionResponseSchema.parse({ cancelled: true }).cancelled).toBe(true);
    expect(RetrySchedulerAdmissionResponseSchema.parse({ retried: true }).retried).toBe(true);
    expect(
      ListSchedulerAdmissionsResponseSchema.parse({
        items: [
          {
            queueEntryId: 'queue_1',
            requestId: '00000000-0000-4000-8000-000000000001',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            requestedAgentId: 'agent_codex_host',
            profileRef: 'default',
            priorityClass: 'interactive',
            enqueuedAt: timestamp,
            effectivePriorityAt: timestamp,
            firstCapDeferredAt: null,
            requiredPoolConstraints: ['openshell.local'],
            status: 'queued',
            denialReason: null,
            queuePosition: 1,
          },
          {
            queueEntryId: 'queue_denied',
            requestId: null,
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_denied',
            requestedAgentId: 'agent_codex_host',
            profileRef: 'default',
            priorityClass: 'interactive',
            enqueuedAt: timestamp,
            effectivePriorityAt: timestamp,
            firstCapDeferredAt: null,
            requiredPoolConstraints: ['openshell.local'],
            status: 'denied',
            denialReason: 'no-healthy-target',
            queuePosition: null,
          },
        ],
      }).items.map((item) => item.queuePosition)
    ).toEqual([1, null]);
    expect(
      ListServerAuditEventsResponseSchema.parse({
        auditEvents: [
          {
            id: 'aud_server_1',
            workspaceId: null,
            protocolVersion: '0.4.0',
            threadId: null,
            turnId: null,
            itemId: null,
            capabilityCallId: null,
            permissionDecisionId: null,
            vaultGrantId: null,
            requestId: '00000000-0000-4000-8000-000000000001',
            agentId: null,
            agentSessionId: null,
            category: 'system',
            action: 'server.config.update',
            resource: 'server:runtime-config',
            outcome: 'succeeded',
            severity: 'info',
            summary: 'Runtime config updated.',
            errorCode: null,
            createdAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      }).auditEvents
    ).toHaveLength(1);
    expect(
      ListWorkspaceAuditEventsResponseSchema.parse({
        workspaceId: 'ws_demo',
        auditEvents: [
          {
            id: 'aud_1',
            workspaceId: 'ws_demo',
            protocolVersion: '0.4.0',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            itemId: null,
            capabilityCallId: null,
            permissionDecisionId: null,
            vaultGrantId: null,
            requestId: '00000000-0000-4000-8000-000000000001',
            agentId: null,
            agentSessionId: null,
            category: 'system',
            action: 'goal.create',
            resource: 'goal:goal_1',
            outcome: 'succeeded',
            severity: 'info',
            summary: 'Goal created.',
            errorCode: null,
            createdAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      }).auditEvents
    ).toHaveLength(1);
    expect(
      ListWorkspaceVaultUseRecordsResponseSchema.parse({
        workspaceId: 'ws_demo',
        vaultUseRecords: [
          {
            useId: 'use_1',
            ownerScope: 'workspace',
            workspaceId: 'ws_demo',
            vaultReferenceId: 'vault_github',
            materialVersion: 1,
            backendKind: 'encrypted-file',
            resolvingPath: 'grant',
            grantId: 'grant_github',
            planId: null,
            receiptId: null,
            agentSessionId: 'as_1',
            capabilityCallId: null,
            outcome: 'succeeded',
            failureCode: null,
            auditEventId: 'aud_1',
            usedAt: timestamp,
          },
        ],
      }).vaultUseRecords
    ).toHaveLength(1);
    expect(
      ListServerVaultUseRecordsResponseSchema.parse({
        vaultUseRecords: [
          {
            useId: 'use_server_1',
            ownerScope: 'server',
            workspaceId: null,
            vaultReferenceId: 'vault_provider',
            materialVersion: 1,
            backendKind: 'encrypted-file',
            resolvingPath: 'provider',
            grantId: null,
            planId: null,
            receiptId: null,
            agentSessionId: null,
            capabilityCallId: null,
            outcome: 'failed',
            failureCode: 'backend-locked',
            auditEventId: 'aud_server_1',
            usedAt: timestamp,
          },
        ],
      }).vaultUseRecords
    ).toHaveLength(1);
    expect(ListAgentCatalogResponseSchema.parse({ items: [] }).items).toEqual([]);
    expect(ListHumanAttentionResponseSchema.parse({ items: [] }).items).toEqual([]);
  });

  it('accepts only the exact active Goal steering command contracts', () => {
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const queuedResponse = {
      state: 'queued',
      pendingTurnId: 'pending_goal_steering',
      requestId: 'req_goal_steering',
      contentItemId: 'it_goal_steering',
      goalId: 'goal_demo',
      activeTurnId: 'turn_worker',
    } as const;

    expect(
      SubmitThreadGoalSteeringRequestSchema.parse({
        requestId: 'req_message',
        message: 'x'.repeat(4_001),
      })
    ).toEqual({ requestId: 'req_message', message: 'x'.repeat(4_001) });
    expect(
      SubmitThreadGoalSteeringRequestSchema.parse({
        requestId: 'req_material',
        materialId: 'material_demo',
        revisionId: 'revision_demo',
        contentDigest,
        note: 'Use this exact revision.',
      })
    ).toEqual({
      requestId: 'req_material',
      materialId: 'material_demo',
      revisionId: 'revision_demo',
      contentDigest,
      note: 'Use this exact revision.',
    });
    for (const invalid of [
      {
        requestId: 'req_mixed',
        message: 'Use the material.',
        materialId: 'material_demo',
        revisionId: 'revision_demo',
        contentDigest,
      },
      { requestId: 'req_incomplete', materialId: 'material_demo', revisionId: 'revision_demo' },
      { requestId: 'req_unknown', message: 'Use this.', extra: true },
    ]) {
      expect(SubmitThreadGoalSteeringRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(SubmitThreadGoalSteeringResponseSchema.parse(queuedResponse)).toEqual(queuedResponse);
    expect(
      SubmitThreadGoalSteeringResponseSchema.safeParse({ ...queuedResponse, goal: {} }).success
    ).toBe(false);

    const terminalRequest = { requestId: 'req_terminal' };
    expect(ConvertGoalSteeringToFollowUpRequestSchema.parse(terminalRequest)).toEqual(
      terminalRequest
    );
    expect(CancelGoalSteeringRequestSchema.parse(terminalRequest)).toEqual(terminalRequest);
    expect(
      ConvertGoalSteeringToFollowUpRequestSchema.safeParse({ ...terminalRequest, state: 'queued' })
        .success
    ).toBe(false);
    expect(
      CancelGoalSteeringRequestSchema.safeParse({ ...terminalRequest, state: 'queued' }).success
    ).toBe(false);

    const followUpResponse = {
      state: 'follow-up',
      pendingTurnId: queuedResponse.pendingTurnId,
      requestId: terminalRequest.requestId,
      sourceRequestId: queuedResponse.requestId,
      contentItemId: queuedResponse.contentItemId,
      goalId: queuedResponse.goalId,
      activeTurnId: queuedResponse.activeTurnId,
      followUpTurnId: 'turn_follow_up',
      followUpItemId: 'it_follow_up',
    } as const;
    const cancelResponse = {
      state: 'cancelled',
      pendingTurnId: queuedResponse.pendingTurnId,
      requestId: terminalRequest.requestId,
      sourceRequestId: queuedResponse.requestId,
      contentItemId: queuedResponse.contentItemId,
      goalId: queuedResponse.goalId,
      activeTurnId: queuedResponse.activeTurnId,
    } as const;

    expect(ConvertGoalSteeringToFollowUpResponseSchema.parse(followUpResponse)).toEqual(
      followUpResponse
    );
    expect(CancelGoalSteeringResponseSchema.parse(cancelResponse)).toEqual(cancelResponse);
    expect(
      CancelGoalSteeringResponseSchema.safeParse({
        ...cancelResponse,
        followUpTurnId: 'turn_follow_up',
      }).success
    ).toBe(false);
  });

  it('accepts only the verified Goal steering pending-input Action Center source', () => {
    const source = {
      type: 'pending_input',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      pendingTurnId: 'pending_goal_steering',
      requestId: 'req_goal_steering',
      contentItemId: 'it_goal_steering',
      goalId: 'goal_demo',
      activeTurnId: 'turn_worker',
      state: 'queued',
    } as const;

    expect(PendingGoalSteeringHumanAttentionSourceSchema.parse(source)).toEqual(source);
    expect(appApiSchemas.HumanAttentionSourceSchema.parse({ ...source, state: 'applied' })).toEqual(
      {
        ...source,
        state: 'applied',
      }
    );
    for (const ownerOnlyField of [
      'itemText',
      'materialId',
      'revisionId',
      'contentDigest',
      'terminalClaimKind',
      'receipt',
      'currentGoal',
      'status',
    ]) {
      expect(
        PendingGoalSteeringHumanAttentionSourceSchema.safeParse({
          ...source,
          [ownerOnlyField]: 'forbidden',
        }).success
      ).toBe(false);
    }
  });

  it('accepts only exact version-keyed Artifact Review Action Center sources', () => {
    const source = {
      type: 'artifact_review',
      reviewId: 'arev_demo',
      artifactId: 'artifact_demo',
      artifactVersion: 2,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
    } as const;

    expect(appApiSchemas.ArtifactReviewHumanAttentionSourceSchema.parse(source)).toEqual(source);
    expect(appApiSchemas.HumanAttentionSourceSchema.parse(source)).toEqual(source);
    expect(
      appApiSchemas.HumanAttentionSourceSchema.safeParse({
        type: 'artifact',
        artifactId: source.artifactId,
        workspaceId: source.workspaceId,
        reviewStatus: 'pending',
      }).success
    ).toBe(false);
    for (const requiredField of ['reviewId', 'artifactVersion'] as const) {
      const invalid = { ...source, [requiredField]: undefined };
      expect(appApiSchemas.HumanAttentionSourceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts unified human attention rows for every backed source kind', () => {
    const rows = [
      {
        id: 'approval:ap_demo',
        kind: 'approval',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: 'it_approval',
        title: 'Approval required',
        summary: 'Approve the command before the worker continues.',
        severity: 'needs_input',
        createdAt: timestamp,
        recommendedAction: 'Review and respond to the approval request.',
        source: {
          type: 'approval',
          approvalRequestId: 'ap_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: 'it_approval',
        },
        actions: [
          {
            kind: 'grant_approval',
            label: 'Approve',
            method: 'POST',
            href: '/api/approvals/ap_demo/respond',
          },
          {
            kind: 'deny_approval',
            label: 'Deny',
            method: 'POST',
            href: '/api/approvals/ap_demo/respond',
          },
        ],
      },
      {
        id: 'question:it_question',
        kind: 'question',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: 'it_question',
        title: 'Answer required',
        summary: 'Choose a path.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: 'it_question',
        },
        actions: [
          {
            kind: 'answer_question',
            label: 'Answer',
            method: 'POST',
            href: '/api/turns/turn_demo/input',
          },
        ],
      },
      {
        id: 'checkpoint:checkpoint_demo',
        kind: 'checkpoint_recovery',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'Worker checkpoint needs review',
        summary: 'Interrupted before terminal save.',
        severity: 'blocked',
        createdAt: timestamp,
        source: {
          type: 'worker_checkpoint',
          checkpointId: 'checkpoint_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          stage: 'running_worker',
          stopReason: null,
        },
        actions: [
          {
            kind: 'resume_from_checkpoint',
            label: 'Resume',
            disabled: true,
            reason: 'Checkpoint resume is not implemented yet.',
          },
        ],
      },
      {
        id: 'goal:goal_demo',
        kind: 'blocked_turn',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        title: 'Goal is blocked',
        summary: 'The goal needs human follow-up.',
        severity: 'blocked',
        createdAt: timestamp,
        source: {
          type: 'goal',
          goalId: 'goal_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'blocked',
        },
        actions: [
          { kind: 'open_thread', label: 'Open thread', method: 'GET', href: '/threads/th_demo' },
        ],
      },
      {
        id: 'goal-task:task_demo',
        kind: 'review_cap',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        title: 'Review cap reached',
        summary: 'The task exhausted its review budget.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'goal_task',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'blocked',
        },
        actions: [
          {
            kind: 'retry_work',
            label: 'Retry',
            disabled: true,
            reason: 'No retry route exists yet.',
          },
        ],
      },
      {
        id: 'goal-review:review_demo',
        kind: 'artifact_review',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        artifactId: 'artifact_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        title: 'Review worker output',
        summary: 'Reviewer requested refinement.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'goal_review',
          reviewId: 'review_demo',
          goalId: 'goal_demo',
          taskId: 'task_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
        },
        actions: [{ kind: 'request_refinement', label: 'Request refinement', method: 'POST' }],
      },
      {
        id: 'agent-readiness:agent_demo',
        kind: 'agent_readiness',
        workspaceId: 'ws_demo',
        title: 'Agent is blocked',
        summary: 'Runtime binary is not available.',
        severity: 'blocked',
        createdAt: timestamp,
        source: {
          type: 'agent_readiness',
          agentId: 'agent_demo',
          workspaceId: 'ws_demo',
          status: 'blocked',
        },
        actions: [
          {
            kind: 'refresh_agent_readiness',
            label: 'Refresh',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/agents/health/refresh',
          },
        ],
      },
      {
        id: 'artifact-review:arev_demo',
        kind: 'artifact_review',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        reviewId: 'arev_demo',
        artifactId: 'artifact_demo',
        artifactVersion: 1,
        title: 'Review artifact',
        summary: 'The artifact is ready for acceptance.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'artifact_review',
          reviewId: 'arev_demo',
          artifactId: 'artifact_demo',
          artifactVersion: 1,
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
        },
        actions: [
          { kind: 'accept_review', label: 'Accept', method: 'POST' },
          { kind: 'defer', label: 'Defer', method: 'POST' },
        ],
      },
      {
        id: 'workspace-review:swr_demo',
        kind: 'workspace_review',
        workspaceId: 'ws_demo',
        artifactId: 'artifact_workspace_demo',
        title: 'Review workspace changes',
        summary: '1 changed path staged for human review.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'workspace_review',
          reviewId: 'swr_demo',
          changeSetId: 'wcs_demo',
          artifactId: 'artifact_workspace_demo',
          workspaceId: 'ws_demo',
          status: 'pending',
        },
        actions: [
          { kind: 'accepted', label: 'Accept', method: 'POST' },
          { kind: 'needs_refinement', label: 'Refine', method: 'POST' },
          { kind: 'rejected', label: 'Reject', method: 'POST' },
          { kind: 'blocked', label: 'Block', method: 'POST' },
        ],
      },
      {
        id: 'knowledge:knowledge_proposal_demo',
        kind: 'knowledge_review',
        workspaceId: 'ws_demo',
        title: 'Review knowledge proposal',
        summary: 'A knowledge proposal is waiting for review.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'knowledge',
          knowledgeProposalId: 'knowledge_proposal_demo',
          workspaceId: 'ws_demo',
          status: 'pending',
        },
        actions: [
          { kind: 'accept_knowledge', label: 'Accept', method: 'POST' },
          { kind: 'reject_knowledge', label: 'Reject', method: 'POST' },
        ],
      },
      {
        id: 'external:side_effect_demo',
        kind: 'external_side_effect',
        workspaceId: 'ws_demo',
        title: 'External side effect needs review',
        summary: 'A side effect requires explicit human action.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'protocol_item',
          itemType: 'approval-request',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          itemId: 'it_side_effect',
        },
        actions: [{ kind: 'open_turn', label: 'Open turn', method: 'GET' }],
      },
      {
        id: 'budget:turn_demo',
        kind: 'budget',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'Budget exhausted',
        summary: 'The worker stopped after exhausting its budget.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'goal_task',
          goalId: 'goal_demo',
          taskId: 'task_budget',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          status: 'blocked',
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
      {
        id: 'scheduler-admission:queue_demo',
        kind: 'pending_input',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'Worker turn is queued',
        summary: 'The worker turn is waiting for scheduler capacity.',
        severity: 'info',
        createdAt: timestamp,
        source: {
          type: 'scheduler_admission',
          queueEntryId: 'queue_demo',
          status: 'queued',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          requestedAgentId: 'agent_codex_host',
          priorityClass: 'interactive',
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
      {
        id: 'worker-control-rejection:wcr_demo',
        kind: 'blocked_turn',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'Worker control evidence was rejected',
        summary: 'A worker control request failed lineage validation.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'worker_control_rejection',
          rejectionId: 'wcr_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          packageSnapshotId: 'pkg_demo',
          route: '/api/worker-control/events/append',
          operation: 'event_append',
          errorCode: 'worker_control_lineage_mismatch',
          httpStatus: 403,
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
      {
        id: 'scheduler-orphan-worker:orphan_demo',
        kind: 'blocked_turn',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        title: 'Worker session needs recovery review',
        summary: 'A scheduler restart found an orphaned worker session.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'scheduler_orphan_worker',
          evidenceId: 'orphan_demo',
          leaseId: 'lease_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          packageSnapshotId: 'pkg_demo',
          reason: 'restart-heartbeat-timeout',
          schedulerEpoch: 7,
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
    ];

    expect(ListHumanAttentionResponseSchema.parse({ items: rows }).items).toHaveLength(rows.length);
  });

  it('rejects removed split action center response fields and invalid human attention actions', () => {
    expect(
      ListHumanAttentionResponseSchema.safeParse({
        items: [
          {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            itemId: 'it_approval',
            threadTitle: 'Old row',
            createdAt: timestamp,
            approval: {},
            item: {},
          },
        ],
      }).success
    ).toBe(false);
    expect(
      ListHumanAttentionResponseSchema.safeParse({
        items: [
          {
            id: 'invalid:action',
            kind: 'approval',
            workspaceId: 'ws_demo',
            title: 'Invalid action',
            summary: 'The action kind is not part of the public contract.',
            severity: 'needs_input',
            createdAt: timestamp,
            source: {
              type: 'approval',
              approvalRequestId: 'ap_demo',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              turnId: 'turn_demo',
            },
            actions: [{ kind: 'archive_everything', label: 'Archive' }],
          },
        ],
      }).success
    ).toBe(false);
  });

  it('accepts knowledge proposal decision requests and responses', () => {
    const requestIds = {
      accepted: '00000000-0000-4000-8000-000000000611',
      rejected: '00000000-0000-4000-8000-000000000612',
      deferred: '00000000-0000-4000-8000-000000000613',
    } as const;
    for (const decision of ['accepted', 'rejected', 'deferred'] as const) {
      expect(
        SubmitKnowledgeProposalDecisionRequestSchema.parse({
          requestId: requestIds[decision],
          decision,
        }).decision
      ).toBe(decision);
    }

    const response = {
      review: {
        reviewId: 'kr_demo',
        proposalId: 'kp_demo',
        workspaceId: 'ws_demo',
        requestId: requestIds.accepted,
        decision: 'accepted' as const,
        actor: { kind: 'user' as const, id: 'user_demo' },
        proposalDigest: knowledgeProposalDigest,
        knowledgePageId,
        contentDigest: knowledgeContentDigest,
        targetAbsentAtDecision: true as const,
        decidedAt: timestamp,
      },
      application: {
        knowledgePageId,
        contentDigest: knowledgeContentDigest,
        present: true as const,
      },
    };

    expect(SubmitKnowledgeProposalDecisionResponseSchema.parse(response)).toEqual(response);
    expect(
      SubmitKnowledgeProposalDecisionResponseSchema.safeParse({
        ...response,
        review: { ...response.review, status: 'accepted', message: 'Legacy review projection.' },
      }).success
    ).toBe(false);
  });

  it.each([
    ['missing request id', { decision: 'accepted' }],
    ['non-UUID request id', { requestId: 'req_knowledge_edit', decision: 'accepted' }],
    ['edited decision', { requestId: '00000000-0000-4000-8000-000000000614', decision: 'edited' }],
    [
      'message field',
      {
        requestId: '00000000-0000-4000-8000-000000000615',
        decision: 'accepted',
        message: 'Looks reusable.',
      },
    ],
    [
      'title field',
      {
        requestId: '00000000-0000-4000-8000-000000000616',
        decision: 'accepted',
        title: 'Edited knowledge title',
      },
    ],
    [
      'summary field',
      {
        requestId: '00000000-0000-4000-8000-000000000617',
        decision: 'accepted',
        summary: 'Edited knowledge summary.',
      },
    ],
  ])('rejects removed knowledge proposal request %s', (_name, request) => {
    expect(SubmitKnowledgeProposalDecisionRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts only bounded knowledge proposal reversal projections', () => {
    const request = {
      requestId: '00000000-0000-4000-8000-000000000618',
      reviewId: 'kr_demo',
      knowledgePageId,
      expectedContentDigest: knowledgeContentDigest,
    };
    const response = {
      proposalId: 'kp_demo',
      reviewId: request.reviewId,
      application: {
        knowledgePageId: request.knowledgePageId,
        contentDigest: request.expectedContentDigest,
        present: false as const,
      },
    };

    expect(ReverseKnowledgeProposalRequestSchema.parse(request)).toEqual(request);
    expect(ReverseKnowledgeProposalResponseSchema.parse(response)).toEqual(response);
    expect(
      ReverseKnowledgeProposalRequestSchema.safeParse({
        ...request,
        proposalId: 'kp_client_override',
      }).success
    ).toBe(false);
    expect(
      ReverseKnowledgeProposalRequestSchema.safeParse({
        ...request,
        requestId: 'req_knowledge_reverse',
      }).success
    ).toBe(false);
    expect(
      ReverseKnowledgeProposalResponseSchema.safeParse({
        ...response,
        reversalId: 'knowledge_reversal_demo',
      }).success
    ).toBe(false);
  });

  it('rejects goal step review overrides', () => {
    expect(
      RunThreadGoalStepRequestSchema.safeParse({ requestId: 'goal-step-default' }).success
    ).toBe(true);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-human',
        reviewPolicyOverride: 'human',
      }).success
    ).toBe(false);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-none',
        reviewPolicyOverride: 'none',
      }).success
    ).toBe(false);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-auto',
        reviewPolicyOverride: 'auto',
      }).success
    ).toBe(false);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-unknown',
        reviewPolicyOverride: 'unknown',
      }).success
    ).toBe(false);
  });

  it('accepts goal review decision requests and responses', () => {
    expect(GoalReviewResolutionOutcomeSchema.safeParse('continue').success).toBe(false);
    expect(
      SubmitGoalReviewDecisionRequestSchema.parse({
        requestId: 'goal-review-decision-1',
        verdict: 'accept',
      }).verdict
    ).toBe('accept');
    expect(
      SubmitGoalReviewDecisionRequestSchema.safeParse({
        requestId: 'goal-review-decision-2',
        verdict: 'refine',
        revisionInstruction: 'Cover the restart failure case.',
      }).success
    ).toBe(true);
    for (const verdict of ['retry', 'abort']) {
      expect(
        SubmitGoalReviewDecisionRequestSchema.safeParse({
          requestId: `goal-review-${verdict}`,
          verdict,
          reason: 'The evidence does not satisfy the acceptance criteria.',
        }).success
      ).toBe(true);
    }
    const retryResponse = {
      review: {
        reviewId: 'review_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: 'turn_demo',
        itemIds: ['item_demo'],
        artifactIds: ['artifact_demo'],
        verificationEvidence: [{ command: 'pnpm test', status: 'passed' }],
        prompt: 'Review the worker evidence against the accepted task.',
        createdByRequestId: 'goal-step-1',
        verdict: 'retry',
        reason: 'Retry with stronger verification.',
        revisionInstruction: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: timestamp,
        resolutionRequestId: 'goal-review-decision-1',
        resolvedByActorId: 'user_demo',
      },
      advance: {
        outcome: 'retry',
        task: { taskId: 'task_demo', status: 'ready' },
        goal: {
          goalId: 'goal_demo',
          status: 'running',
          currentTaskId: null,
          terminalStopReason: null,
        },
        nextReadyTaskId: 'task_demo',
      },
    } as const;
    expect(
      SubmitGoalReviewDecisionResponseSchema.parse(retryResponse).review.resolutionRequestId
    ).toBe('goal-review-decision-1');
    for (const response of [
      {
        ...retryResponse,
        advance: { ...retryResponse.advance, outcome: 'refine' },
      },
      {
        ...retryResponse,
        advance: {
          ...retryResponse.advance,
          task: { ...retryResponse.advance.task, taskId: 'task_other' },
        },
      },
      {
        ...retryResponse,
        advance: {
          ...retryResponse.advance,
          goal: { ...retryResponse.advance.goal, goalId: 'goal_other' },
        },
      },
    ]) {
      expect(SubmitGoalReviewDecisionResponseSchema.safeParse(response).success).toBe(false);
    }
    for (const request of [
      { verdict: 'accept' },
      { requestId: 'goal-review-missing-verdict' },
      { requestId: '', verdict: 'accept' },
      { requestId: 'goal-review-refine', verdict: 'refine' },
      { requestId: 'goal-review-retry', verdict: 'retry' },
      { requestId: 'goal-review-abort', verdict: 'abort' },
      { requestId: 'goal-review-ask', verdict: 'ask_user' },
      {
        requestId: 'goal-review-accept-instruction',
        verdict: 'accept',
        revisionInstruction: 'Unexpected instruction.',
      },
    ]) {
      expect(SubmitGoalReviewDecisionRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe('WP5 Workspace sharing schemas', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const workspace = {
    id: 'ws_demo',
    name: 'Demo Workspace',
    kind: 'general',
    status: 'active',
    counts: { threadCount: 1, artifactCount: 2, knowledgeEntryCount: 3 },
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const authorizedWorkspace = {
    workspace,
    ownerUserId: 'user_owner',
    effectiveRole: 'owner',
    registryRevision: 4,
    membershipRevision: 2,
  } as const;
  const activeOwner = {
    workspaceId: workspace.id,
    userId: 'user_owner',
    status: 'active',
    accessLevel: 'editor',
    effectiveRole: 'owner',
    invitationId: null,
    joinedAt: timestamp,
    removedAt: null,
    revision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const pendingInvitation = {
    invitationId: 'invite_demo',
    workspaceId: workspace.id,
    inviteeUserId: 'user_invitee',
    proposedAccessLevel: 'viewer',
    inviterUserId: 'user_owner',
    effectiveStatus: 'pending',
    expiresAt: timestamp,
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const accessRecovery = {
    workspaceId: workspace.id,
    ownerUserId: 'user_owner',
    administratorRole: null,
    registryRevision: 4,
  } as const;

  it('accepts the exact Workspace sharing read and mutation projections', () => {
    expect(
      appApiSchemas.ListAuthorizedWorkspacesResponseSchema.parse({
        items: [authorizedWorkspace],
      }).items[0]?.effectiveRole
    ).toBe('owner');
    expect(
      appApiSchemas.ListWorkspaceMembersResponseSchema.parse({ items: [activeOwner] }).items[0]
        ?.revision
    ).toBe(2);
    expect(
      appApiSchemas.ListWorkspaceInvitationsResponseSchema.parse({
        items: [pendingInvitation],
      }).items[0]?.effectiveStatus
    ).toBe('pending');
    expect(
      appApiSchemas.WorkspaceInvitationMutationResponseSchema.parse({
        invitation: pendingInvitation,
      }).invitation.invitationId
    ).toBe('invite_demo');
    expect(
      appApiSchemas.WorkspaceMemberMutationResponseSchema.parse({ member: activeOwner }).member
        .userId
    ).toBe('user_owner');
    expect(
      appApiSchemas.WorkspaceOwnershipMutationResponseSchema.parse({
        workspace: authorizedWorkspace,
      }).workspace.registryRevision
    ).toBe(4);
    expect(appApiSchemas.WorkspaceAccessRecoveryStateSchema.parse(accessRecovery)).toEqual(
      accessRecovery
    );
    expect(
      appApiSchemas.WorkspaceAccessRecoveryResponseSchema.parse({ recovery: accessRecovery })
        .recovery
    ).toEqual(accessRecovery);
    expect(
      appApiSchemas.WorkspaceOwnershipMutationResponseSchema.safeParse({
        recovery: accessRecovery,
      }).success
    ).toBe(false);
  });

  it('keeps user disable and invitee discovery projections strict and minimal', () => {
    const disabledUser = {
      userId: 'user_disabled',
      status: 'disabled',
      disabledAt: timestamp,
    } as const;

    expect(appApiSchemas.UserLifecycleSummarySchema.parse(disabledUser)).toEqual(disabledUser);
    expect(appApiSchemas.DisableUserRequestSchema.parse({ requestId })).toEqual({ requestId });
    expect(appApiSchemas.DisableUserResponseSchema.parse({ user: disabledUser }).user).toEqual(
      disabledUser
    );
    expect(
      appApiSchemas.UserLifecycleSummarySchema.safeParse({ ...disabledUser, status: 'active' })
        .success
    ).toBe(false);
    expect(
      appApiSchemas.DisableUserRequestSchema.safeParse({ requestId, userId: disabledUser.userId })
        .success
    ).toBe(false);
    expect(
      appApiSchemas.DisableUserResponseSchema.safeParse({
        user: { ...disabledUser, email: 'disabled@example.com' },
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.ListWorkspaceInvitationsResponseSchema.parse({
        items: [pendingInvitation],
      }).items[0]?.inviteeUserId
    ).toBe('user_invitee');
    expect(
      appApiSchemas.ListWorkspaceInvitationsResponseSchema.safeParse({
        items: [pendingInvitation],
        userId: 'user_invitee',
      }).success
    ).toBe(false);
  });

  it('requires one request identity and the documented CAS field for every mutation', () => {
    expect(
      appApiSchemas.CreateWorkspaceInvitationRequestSchema.parse({
        requestId,
        inviteeEmail: 'invitee@example.com',
        proposedAccessLevel: 'viewer',
      }).inviteeEmail
    ).toBe('invitee@example.com');

    for (const schema of [
      appApiSchemas.AcceptWorkspaceInvitationRequestSchema,
      appApiSchemas.DeclineWorkspaceInvitationRequestSchema,
      appApiSchemas.RevokeWorkspaceInvitationRequestSchema,
      appApiSchemas.RemoveWorkspaceMemberRequestSchema,
      appApiSchemas.LeaveWorkspaceRequestSchema,
    ]) {
      expect(schema.safeParse({ requestId, expectedRevision: 1 }).success).toBe(true);
      expect(schema.safeParse({ requestId }).success).toBe(false);
      expect(schema.safeParse({ requestId, expectedRevision: 0 }).success).toBe(false);
    }

    expect(
      appApiSchemas.ChangeWorkspaceMemberAccessRequestSchema.safeParse({
        requestId,
        expectedRevision: 2,
        accessLevel: 'editor',
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.TransferWorkspaceOwnershipRequestSchema.safeParse({
        requestId,
        targetUserId: 'user_next_owner',
        expectedRegistryRevision: 4,
      }).success
    ).toBe(true);
    for (const action of ['add-self-as-editor', 'transfer-ownership-to-self']) {
      expect(
        appApiSchemas.RecoverWorkspaceAccessRequestSchema.safeParse({
          action,
          requestId,
          expectedRegistryRevision: 4,
        }).success
      ).toBe(true);
    }
  });

  it('rejects incoherent lifecycle projections and forbidden authority fields', () => {
    expect(
      appApiSchemas.AuthorizedWorkspaceSummarySchema.safeParse({
        ...authorizedWorkspace,
        membershipRevision: 0,
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceAccessRecoveryStateSchema.safeParse({
        ...accessRecovery,
        administratorRole: 'administrator',
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceAccessRecoveryStateSchema.safeParse({
        ...accessRecovery,
        workspace,
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceMemberSchema.safeParse({
        ...activeOwner,
        status: 'removed',
        removedAt: timestamp,
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceMemberSchema.safeParse({
        ...activeOwner,
        accessLevel: 'viewer',
      }).success
    ).toBe(false);
    for (const mismatch of [
      { accessLevel: 'viewer', effectiveRole: 'editor' },
      { accessLevel: 'editor', effectiveRole: 'viewer' },
    ] as const) {
      expect(
        appApiSchemas.WorkspaceMemberSchema.safeParse({
          ...activeOwner,
          userId: 'user_member',
          ...mismatch,
        }).success
      ).toBe(false);
    }
    expect(
      appApiSchemas.WorkspaceInvitationSchema.safeParse({
        ...pendingInvitation,
        effectiveStatus: 'accepted',
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceInvitationSchema.safeParse({
        ...pendingInvitation,
        effectiveStatus: 'accepted',
        acceptedAt: timestamp,
      }).success
    ).toBe(true);
    for (const forbiddenField of ['organizationId', 'tenantId', 'storageOwnerUserId', 'rawToken']) {
      expect(
        appApiSchemas.CreateWorkspaceInvitationRequestSchema.safeParse({
          requestId,
          inviteeEmail: 'invitee@example.com',
          proposedAccessLevel: 'viewer',
          [forbiddenField]: 'forbidden',
        }).success
      ).toBe(false);
    }
  });

  it('keeps Workspace sharing errors closed and returns only the documented safe current view', () => {
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'revision_conflict',
        message: 'The Workspace registry revision changed.',
        details: { resource: 'workspace', current: authorizedWorkspace },
        requestId,
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'invitation_not_pending',
        message: 'The invitation is no longer pending.',
        details: {
          current: { ...pendingInvitation, effectiveStatus: 'expired' },
        },
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'invitation_not_pending',
        message: 'The invitation is still pending.',
        details: { current: pendingInvitation },
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'workspace_access_denied',
        message: 'Workspace access is denied.',
        details: { current: authorizedWorkspace },
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'revision_conflict',
        message: 'The membership revision changed.',
        details: { resource: 'membership', current: pendingInvitation },
      }).success
    ).toBe(false);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'revision_conflict',
        message: 'The Workspace recovery revision changed.',
        details: { resource: 'workspace_recovery', current: accessRecovery },
        requestId,
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'revision_conflict',
        message: 'The Workspace recovery revision changed.',
        details: {
          resource: 'workspace_recovery',
          current: { ...accessRecovery, workspace },
        },
        requestId,
      }).success
    ).toBe(false);
  });
});
