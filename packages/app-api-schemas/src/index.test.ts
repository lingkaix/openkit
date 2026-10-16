import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceMcpCredentialBindingSchema } from '@openkit/config-schema/mcp-credentials';

import {
  SubscriptionProviderIdSchema as ConfigSubscriptionProviderIdSchema,
  ProviderSubscriptionAccountSlotIdSchema,
} from '@openkit/config-schema/provider-subscription';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as appApiSchemas from './index.js';
import {
  AppDiagnosticsClientResponseSchema,
  AppDiagnosticsResponseSchema,
  AppSearchResponseSchema,
  ArchivedGitPushRecordSchema,
  AuthGetSessionResponseSchema,
  AuthGetSessionResultSchema,
  AuthSignInEmailResponseSchema,
  AuthSignOutResponseSchema,
  AuthSignUpEmailResponseSchema,
  AutomationRecordSchema,
  BackendWorkspaceHandleSchema,
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ChatModeOutcomeSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  GatewayUsageSummarySchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  GetWorkspaceMaterialRevisionResponseSchema,
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
  KnowledgeRetrievalTraceSchema,
  KnowledgeSourceSchema,
  ListAgentCatalogResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  ListArtifactReviewsResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListHumanAttentionResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ListMyAdminAccessTokensResponseSchema,
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
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  ProviderApiKeyProfileIdSchema,
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
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  RetrieveKnowledgeRequestSchema,
  RetryInterruptedWorkerCheckpointRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
  RuntimeConfigFileListResponseSchema,
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigReloadResponseSchema,
  RuntimeConfigSchemaCatalogResponseSchema,
  RuntimeConfigStatusSchema,
  RuntimeConfigValidationResponseSchema,
  RuntimeEvidenceRecordSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  SetMyAdminAccessTokenDefaultRequestSchema,
  SetProviderApiKeyRequestSchema,
  SetProviderApiKeyResponseSchema,
  SetupDiagnosticsResponseSchema,
  StagedWorkspaceReviewSchema,
  StartTaskModeRequestSchema,
  StartTaskModeResponseSchema,
  StorageLayoutReportResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
  SubmitConversationRequestSchema,
  SubmitConversationResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
  SubmitTurnFeedbackRequestSchema,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  TaskModeAttemptStateSchema,
  TaskModeWorkerTargetSchema,
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
} from './index.js';
import { TASK_OPERATION_DEFINITIONS } from './operation-definitions.js';

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
const retrievalTraceId = 'krt_00000000-0000-75f3-bd1b-a7b739921bbd';
const knowledgePageScopeId = 'page/workspace/ws_00000000-0000-7000-8000-000000000001';
const retrievalTraceRef = {
  scopeId:
    'retrieval-trace/thread/ws_00000000-0000-7000-8000-000000000001/th_00000000-0000-7000-8000-000000000001',
  objectId: retrievalTraceId,
} as const;
const knowledgeQueryContext = {
  serverId: 'srv_demo',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
  threadId: 'th_00000000-0000-7000-8000-000000000001',
} as const;
const knowledgeSourceReference = `source:ks_00000000-0000-7e28-9211-1f67fd14ca84@sha256:${'1'.repeat(64)}`;
const knowledgePageId = 'lessons/release-review';
const canonicalKnowledgePageBytes = [
  '---',
  'type: "KnowledgePage"',
  'title: "Release review"',
  'schema_version: "openkit-workspace-knowledge-schema-v2"',
  'openkit_status: "active"',
  'status: "stable"',
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
  '@openkit/config-schema/mcp-credentials',
  '@openkit/config-schema/native-environment',
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
  it('reuses the browser-safe MCP credential binding schema without defaulting omitted updates', () => {
    const credentials = appApiSchemas.UpdateMcpBindingRequestSchema.shape.credentialBindings;
    expect(credentials.unwrap().element).toBe(WorkspaceMcpCredentialBindingSchema);
    expect(credentials.parse(undefined)).toBeUndefined();
    expect(credentials.parse([])).toEqual([]);
  });
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
        .soft(branch.shape.subscriptionProviderId, `quota ${branch.shape.availability.value}`)
        .toBe(ConfigSubscriptionProviderIdSchema);
      expect
        .soft(branch.shape.accountSlotId, `quota ${branch.shape.availability.value}`)
        .toBe(ProviderSubscriptionAccountSlotIdSchema);
    }
    for (const branch of appApiSchemas.ProviderSubscriptionAutoTopupSchema.options) {
      expect.soft(branch.shape.subscriptionProviderId.value, 'auto-topup provider').toBe('xai');
      expect
        .soft(branch.shape.accountSlotId, `auto-topup ${branch.shape.availability.value}`)
        .toBe(ProviderSubscriptionAccountSlotIdSchema);
    }
  });
});

describe('S16 Material and Artifact Review schemas', () => {
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const material = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
    title: 'Working notes',
    kind: 'markdown',
    currentRevisionId: 'mrev_00000000-0000-7dfd-b321-ac6a81c1b523',
    sensitivity: 'internal',
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const revisionSummary = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
    revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
    parentRevisionId: null,
    mediaType: 'text/markdown',
    contentDigest,
    authorId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
    createdAt: timestamp,
  } as const;
  const unresolvedReview = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    reviewId: 'arev_00000000-0000-5fec-bd54-6ef3c5727e32',
    artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
    artifactVersion: 1,
    contentDigest,
    sourceThreadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
    sourceTurnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
      [
        ImportWorkspaceArtifactResponseSchema,
        { artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af', artifactVersion: 1 },
      ],
      [
        IntroduceWorkspaceArtifactResponseSchema,
        {
          artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
          artifactVersion: 1,
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-7167-b408-becd17a436db',
        },
      ],
      [ListArtifactReviewsResponseSchema, { reviews: [unresolvedReview] }],
      [
        SubmitArtifactReviewDecisionResponseSchema,
        {
          reviewId: 'arev_00000000-0000-5fec-bd54-6ef3c5727e32',
          artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
          artifactVersion: 1,
          decision: 'accepted',
          followUpTurnId: null,
        },
      ],
      [ListWorkspaceMaterialsResponseSchema, { materials: [material] }],
      [
        CreateWorkspaceMaterialResponseSchema,
        { materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3' },
      ],
      [GetWorkspaceMaterialResponseSchema, { material }],
      [ListWorkspaceMaterialRevisionsResponseSchema, { revisions: [revisionSummary] }],
      [
        SaveWorkspaceMaterialRevisionResponseSchema,
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
        },
      ],
      [
        GetWorkspaceMaterialRevisionResponseSchema,
        { revision: { ...revisionSummary, content: '# Working notes' } },
      ],
      [
        GetThreadMaterialResponseSchema,
        {
          material: {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
            resource: material,
            currentRevision: revisionSummary,
            inclusionState: 'included',
            latestQueuedRevisionId: 'mrev_00000000-0000-7000-8000-000000000001',
            lastWorkerSeenRevisionId: null,
            currentTurnRevisionId: null,
            activeDelivery: {
              state: 'queued',
              pendingTurnId: 'tu_00000000-0000-7840-ba75-ca03fb2115a3',
              requestId: 'request_steering',
              contentItemId: 'it_00000000-0000-7e2c-91ba-c8a92695b9a1',
              goalId: 'goal_demo',
              activeTurnId: 'tu_00000000-0000-7f6c-8538-e35e2d71b14f',
              materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
              revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
              contentDigest,
            },
          },
        },
      ],
      [
        BindThreadMaterialResponseSchema,
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
          outcome: 'bound',
        },
      ],
      [
        UnbindThreadMaterialResponseSchema,
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
          outcome: 'unbound',
        },
      ],
      [
        ExcludeThreadMaterialResponseSchema,
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
          outcome: 'excluded',
        },
      ],
      [
        RestoreThreadMaterialResponseSchema,
        {
          materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
          threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
          outcome: 'included',
        },
      ],
    ] as const;

    for (const [schema, response] of responses) {
      expect(schema.safeParse(response).success).toBe(true);
      expect(
        schema.safeParse({ ...response, workspaceId: 'ws_00000000-0000-7ed3-96eb-8737bd07515e' })
          .success
      ).toBe(false);
    }
    expect(GetThreadMaterialResponseSchema.safeParse({ material: null }).success).toBe(true);
    expect(
      GetThreadMaterialResponseSchema.safeParse({
        material: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7852-ab38-2cf70969cb1c',
          resource: material,
          currentRevision: revisionSummary,
          inclusionState: 'included',
          latestQueuedRevisionId: 'mrev_00000000-0000-7000-8000-000000000001',
          lastWorkerSeenRevisionId: null,
          currentTurnRevisionId: null,
          activeDelivery: {
            state: 'queued',
            pendingTurnId: 'tu_00000000-0000-7840-ba75-ca03fb2115a3',
            requestId: 'import-lineage:reserved',
            contentItemId: 'it_00000000-0000-7e2c-91ba-c8a92695b9a1',
            goalId: 'goal_demo',
            activeTurnId: 'tu_00000000-0000-7f6c-8538-e35e2d71b14f',
            materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
            revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
            contentDigest,
          },
        },
      }).success
    ).toBe(false);
    expect(
      ImportWorkspaceArtifactResponseSchema.safeParse({
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
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
          expectedQueuedRevisionId: 'mrev_00000000-0000-7000-8000-000000000001',
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
        expectedRevisionId: 'mrev_00000000-0000-7000-8000-000000000001',
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
      decisionActorId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      feedback: 'Revise the proposal.',
      decidedAt: timestamp,
      followUpTurnId: 'tu_00000000-0000-72d1-b818-434d696c7933',
    } as const;
    expect(ListArtifactReviewsResponseSchema.safeParse({ reviews: [decidedReview] }).success).toBe(
      true
    );
    const acceptedProposalReview = {
      ...unresolvedReview,
      materialProposal: {
        materialId: 'mat_00000000-0000-72f2-b4bf-036246e8e3d3',
        baseRevisionId: 'mrev_00000000-0000-7dfd-b321-ac6a81c1b523',
        baseContentDigest: contentDigest,
      },
      decision: 'accepted',
      decisionActorId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
      decidedAt: timestamp,
      appliedMaterialRevisionId: 'mrev_00000000-0000-7000-8000-000000000002',
    } as const;
    expect(
      ListArtifactReviewsResponseSchema.safeParse({ reviews: [acceptedProposalReview] }).success
    ).toBe(true);
    for (const review of [
      { ...decidedReview, feedback: null },
      { ...decidedReview, followUpTurnId: null },
      { ...decidedReview, appliedMaterialRevisionId: 'mrev_00000000-0000-7000-8000-000000000002' },
      { ...acceptedProposalReview, appliedMaterialRevisionId: null },
      { ...unresolvedReview, decidedAt: timestamp },
    ]) {
      expect(ListArtifactReviewsResponseSchema.safeParse({ reviews: [review] }).success).toBe(
        false
      );
    }
    expect(
      SubmitArtifactReviewDecisionResponseSchema.safeParse({
        reviewId: 'arev_00000000-0000-5fec-bd54-6ef3c5727e32',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        artifactVersion: 1,
        decision: 'accepted',
        followUpTurnId: 'tu_00000000-0000-7f20-9928-aae7c6463fb5',
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

/** Builds one valid App Diagnostics payload. */
function appDiagnosticsPayload(): Record<string, unknown> {
  return {
    service: 'nanocore',
    boot: bootReadiness(),
    process: processDiagnosticsSample(),
    build: { releaseTag: null, sourceCommit: null },
    gateway: {
      status: 'ok',
      endpoints: ['/health'],
      defaultModelId: 'default',
      models: [{ id: 'default', displayName: 'Default', capabilities: ['chat'] }],
    },
    providers: { diagnostics: [], registry: [] },
    capabilities: ['core.stream.replay'],
    runtimeConfig: runtimeConfigStatus(),
  };
}

/** Builds one valid App Diagnostics process sample. */
function processDiagnosticsSample(): Record<string, unknown> {
  return {
    observedAt: timestamp,
    nodeVersion: 'v24.0.0',
    uptimeSeconds: 1.5,
    memory: {
      rssBytes: 1,
      heapUsedBytes: 1,
      heapTotalBytes: 1,
    },
    telemetry: {
      enabled: false,
      exportConfigured: false,
    },
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
        defaultAgentId: 'codex',
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
      id: 'ks_00000000-0000-7ef0-a551-80b39073108f',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      contentDigest: 'sha256:abc123',
      originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
      originatingTurnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
        originatingTurnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
    ).toMatchObject({ kind: 'document', requestId: 'req_source' });
    expect(KnowledgeSourceSchema.parse(source)).toEqual(source);
    const derivedRepresentation = {
      id: 'ks_00000000-0000-7ef0-a551-80b39073108f:text',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      sourceId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
      kind: 'text',
      path: 'sources/derived/ks_00000000-0000-7ef0-a551-80b39073108f/text.json',
      materialPath: 'sources/materials/ks_00000000-0000-7ef0-a551-80b39073108f/content.txt',
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
      id: 'ko_00000000-0000-7998-bb5a-f6e99a870e41',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      kind: 'retrieval',
      summary: 'Worker repeatedly needed release cadence context.',
      sourceReferences: ['knowledge:kn_demo', 'source:ks_00000000-0000-7ef0-a551-80b39073108f'],
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
      id: 'kc_00000000-0000-7120-8707-e527057f1dd9',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      statement: 'Release cadence is weekly.',
      sourceReferences: [
        'knowledge:release-plan',
        'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
      ],
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
      id: 'kf_00000000-0000-7b22-b99c-14cb0ba3c7ef',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      subjectReferences: [
        'knowledge:release-plan',
        'claim:kc_00000000-0000-78d1-ade0-e140ee38bc7a',
      ],
      sourceReferences: [
        'source:ks_00000000-0000-7b52-90c5-8003864b63f9',
        'source:ks_00000000-0000-7cfe-8f5a-5c42a2b55641',
      ],
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

  it('keeps scored Knowledge retrieval responses distinct from persisted evidence', () => {
    const selected = {
      reference: { scopeId: knowledgePageScopeId, objectId: 'release-plan' },
      revision: `sha256:${'b'.repeat(64)}`,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      score: 4,
      sourceReferences: ['source:ks_00000000-0000-7ef0-a551-80b39073108f'],
    };
    const excluded = {
      reference: { scopeId: knowledgePageScopeId, objectId: 'old-plan' },
      revision: null,
      contentDigest: null,
      sourceReferences: [],
      reason: 'source_unavailable',
    };
    const response = {
      queryContext: knowledgeQueryContext,
      sourceScope: knowledgePageScopeId,
      notebookRevision: null,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'assistant',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      retrievalParameters: {
        limit: 3,
        pinnedReferences: [selected.reference],
        states: ['active'],
        sourceScope: 'workspace',
      },
      selected: [selected],
      excluded: [excluded],
      retrievalTraceRef,
      createdAt: timestamp,
    } as const;

    expect(
      RetrieveKnowledgeRequestSchema.parse({
        query: 'release cadence',
        limit: 3,
        pinnedReferences: [selected.reference],
      })
    ).toEqual({
      query: 'release cadence',
      limit: 3,
      pinnedReferences: [selected.reference],
      states: ['active'],
    });
    expect(KnowledgeRetrievalResponseSchema.parse(response)).toEqual(response);
    expect(jsonContainsKey(response, 'traceId')).toBe(false);
    expect(jsonContainsKey(response, 'retrievalTraceId')).toBe(false);
    const {
      retrievalTraceRef: _retrievalTraceRef,
      workspaceId: _workspaceId,
      ...responseMetadata
    } = response;
    const trace = {
      ...responseMetadata,
      queryContext: knowledgeQueryContext,
      traceId: retrievalTraceId,
      selected: response.selected.map(({ score: _score, ...candidate }) => candidate),
    };
    const parsedTrace = KnowledgeRetrievalTraceSchema.parse(trace);
    expect(parsedTrace.traceId).toBe(retrievalTraceId);
    expect(jsonContainsKey(parsedTrace.selected, 'score')).toBe(false);
    expect(() => RetrieveKnowledgeRequestSchema.parse({ query: 'release', states: [] })).toThrow();
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(() =>
        KnowledgeRetrievalResponseSchema.parse({ ...response, selected: [{ ...selected, score }] })
      ).toThrow();
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
                  message:
                    'Knowledge source reference source:ks_00000000-0000-7e65-a399-d53a84c98ecb does not resolve.',
                },
              ],
            },
          ],
        },
        sourceReferences: {
          schemaVersion: 1,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          rebuiltAt: timestamp,
          references: [
            {
              conceptId: 'alpha',
              path: 'knowledge/pages/alpha.md',
              reference: 'source:ks_00000000-0000-7ef0-a551-80b39073108f',
              kind: 'registered-source',
              targetId: 'ks_00000000-0000-7ef0-a551-80b39073108f',
              resolved: true,
            },
            {
              conceptId: 'missing-source',
              path: 'knowledge/pages/missing-source.md',
              reference: 'source:ks_00000000-0000-7e65-a399-d53a84c98ecb',
              kind: 'registered-source',
              targetId: 'ks_00000000-0000-7e65-a399-d53a84c98ecb',
              resolved: false,
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
          expect.objectContaining({
            reference: 'source:ks_00000000-0000-7ef0-a551-80b39073108f',
            resolved: true,
          }),
        ]),
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        caller: 'assistant',
        query: 'release cadence',
        outcome: 'answered',
        answer: 'Release cadence is weekly.',
        citations: [
          {
            reference: { scopeId: knowledgePageScopeId, objectId: 'mem_demo' },
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
      citations: [{ reference: { scopeId: knowledgePageScopeId, objectId: 'mem_demo' } }],
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
        artifactIds: ['ar_00000000-0000-72b0-af20-358179c1710c'],
      }).success
    ).toBe(false);
  });

  it('accepts only narrow Knowledge Manager context retrieval responses', () => {
    const response = {
      operationId: 'km_context_demo',
      operation: 'prepare-context-material' as const,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api' as const,
      outcome: 'prepared' as const,
      selected: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'kn_demo' },
          revision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          contentDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          score: 3,
          sourceReferences: ['source:ks_00000000-0000-7b52-90c5-8003864b63f9'],
        },
      ],
      excluded: [
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'kn_expired' },
          revision: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          contentDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          reason: 'freshness_expired' as const,
          sourceReferences: [],
        },
        {
          reference: { scopeId: knowledgePageScopeId, objectId: 'kn_missing' },
          revision: null,
          contentDigest: null,
          reason: 'source_unavailable' as const,
          sourceReferences: [],
        },
      ],
    };

    expect(KnowledgeManagerPrepareContextResponseSchema.parse(response)).toEqual(response);
    expect(jsonContainsKey(response, 'retrievalTraceRef')).toBe(false);
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
    for (const reservedId of ['index', 'log', 'nested/index', 'nested/log']) {
      expect(
        KnowledgeManagerDraftProposalRequestSchema.safeParse({
          ...request,
          knowledgePageId: reservedId,
        }).success
      ).toBe(false);
      expect(
        KnowledgeManagerDraftProposalRequestSchema.safeParse({
          ...request,
          sourceReferences: [`knowledge:${reservedId}@sha256:${'a'.repeat(64)}`],
        }).success
      ).toBe(false);
    }

    expect(
      KnowledgeManagerDraftProposalRequestSchema.safeParse({
        ...request,
        sourceReferences: [
          `context-package:tu_00000000-0000-77e3-bfde-66477d556f64@ctxpkg_sha256_${'a'.repeat(64)}`,
          'item:it_00000000-0000-7167-b408-becd17a436db',
          'turn:tu_00000000-0000-77e3-bfde-66477d556f64',
        ],
      }).success
    ).toBe(true);
    expect(
      KnowledgeManagerDraftProposalRequestSchema.safeParse({
        ...request,
        sourceReferences: [
          `context-package:tu_00000000-0000-77e3-bfde-66477d556f64@sha256:${'a'.repeat(64)}`,
          'item:it_00000000-0000-7167-b408-becd17a436db',
          'turn:tu_00000000-0000-77e3-bfde-66477d556f64',
        ],
      }).success
    ).toBe(false);

    const response = {
      operationId: 'km_proposal_demo',
      operation: 'draft-proposal' as const,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      caller: 'app-api' as const,
      proposal: {
        id: 'kp_demo',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          responsibleUserId: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        appliedMigrations: ['core_0000_setup'],
      },
      users: [
        {
          userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          userDb: {
            path: 'users/usr_00000000-0000-7e68-8ab1-8dcac1be1b5b/db/user.sqlite',
            exists: true,
            appliedMigrations: ['usr_00000000-0000-76f6-b592-f63edf15ea68'],
          },
        },
      ],
      workspaces: [
        {
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
          workspaceDb: {
            path: 'workspaces/ws_00000000-0000-73c3-900f-8d310e4ba201/db/workspace.sqlite',
            exists: true,
            appliedMigrations: ['ws_00000000-0000-7cbe-80db-14aa357efc76'],
          },
          indexesDir: {
            path: 'workspaces/ws_00000000-0000-73c3-900f-8d310e4ba201/indexes',
            exists: true,
            entryCount: 1,
          },
        },
      ],
      quarantineEntries: [
        {
          scope: 'workspace',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
          path: 'workspaces/ws_00000000-0000-73c3-900f-8d310e4ba201/quarantine/1-workspace.sqlite',
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
        quarantineEntries: [
          { ...report.quarantineEntries[0], userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        ],
      }).success
    ).toBe(false);
  });

  it('accepts workspace export responses and rejects secret-shaped payloads', () => {
    const payload = {
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      manifest: {
        schemaVersion: 1,
        recordType: 'workspace-export',
        id: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        ownerScope: 'workspace',
        lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        createdAt: timestamp,
        updatedAt: timestamp,
        contentDigest: 'sha256:manifest',
        redactionLevel: 'metadata',
        sensitivity: 'internal',
        requiredFeatures: [],
        extensions: {},
        sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportCreatedAt: timestamp,
        exportFormatVersion: 3,
        contentInventory: [
          {
            path: 'records/workspace-record.json',
            digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
            bytes: 16,
          },
        ],
      },
      fileCount: 1,
      totalBytes: 16,
      checkedFiles: ['records/workspace-record.json'],
    };

    expect(WorkspaceExportResponseSchema.parse(payload)).toMatchObject({
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      id: 'drb_00000000-0000-795e-9322-0c2b42caa5d0',
      ownerScope: 'server',
      lineage: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: 'sha256:manifest',
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
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
        backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0',
        manifest,
        fileCount: 1,
        totalBytes: 16,
        checkedFiles: ['server/db/core.sqlite'],
      })
    ).toMatchObject({ backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0', fileCount: 1 });
    expect(
      DataRootBackupVerifyRequestSchema.parse({
        backupId: 'drb_00000000-0000-71b9-9183-a46d80f383de',
      })
    ).toEqual({
      backupId: 'drb_00000000-0000-71b9-9183-a46d80f383de',
    });
    expect(() =>
      DataRootBackupVerifyRequestSchema.parse({
        backupId: '..',
      })
    ).toThrow();
    expect(
      DataRootBackupVerifyResponseSchema.parse({
        backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0',
        manifest,
        fileCount: 1,
        totalBytes: 16,
        checkedFiles: ['server/db/core.sqlite'],
      })
    ).toMatchObject({ backupId: 'drb_00000000-0000-795e-9322-0c2b42caa5d0' });
  });

  it('accepts workspace import dry-run reports and rejects unsafe export handles', () => {
    expect(
      WorkspaceImportDryRunRequestSchema.parse({
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7f8f-a228-c5edd2ef12d4',
      })
    ).toEqual({
      sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportId: 'wsexp_00000000-0000-7f8f-a228-c5edd2ef12d4',
    });
    expect(() =>
      WorkspaceImportDryRunRequestSchema.parse({
        sourceWorkspaceId: '..',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      })
    ).toThrow();

    expect(
      WorkspaceImportDryRunResponseSchema.parse({
        mode: 'dry-run',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportedWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        manifest: {
          schemaVersion: 1,
          recordType: 'workspace-export',
          id: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
          ownerScope: 'workspace',
          lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          createdAt: timestamp,
          updatedAt: timestamp,
          contentDigest: 'sha256:manifest',
          redactionLevel: 'metadata',
          sensitivity: 'internal',
          requiredFeatures: [],
          extensions: {},
          sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          exportCreatedAt: timestamp,
          exportFormatVersion: 3,
          contentInventory: [],
        },
        verification: { fileCount: 0, totalBytes: 0, checkedFiles: [] },
        collision: {
          status: 'collides',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          suggestedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
        },
      }).collision.status
    ).toBe('collides');
  });

  it('accepts workspace import responses and request ids', () => {
    expect(
      WorkspaceImportRequestSchema.parse({
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        requestId: 'req_import',
      })
    ).toEqual({
      sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      requestId: 'req_import',
    });

    expect(
      WorkspaceImportResponseSchema.parse({
        mode: 'imported',
        requestId: 'req_import',
        exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
        sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        exportedWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        importedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
        manifest: {
          schemaVersion: 1,
          recordType: 'workspace-export',
          id: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
          ownerScope: 'workspace',
          lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          createdAt: timestamp,
          updatedAt: timestamp,
          contentDigest: 'sha256:manifest',
          redactionLevel: 'metadata',
          sensitivity: 'internal',
          requiredFeatures: [],
          extensions: {},
          sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          exportCreatedAt: timestamp,
          exportFormatVersion: 3,
          contentInventory: [],
        },
        workspace: {
          id: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
          name: 'Demo workspace',
          kind: 'general',
          status: 'active',
          counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 1 },
          importedFrom: {
            sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
            sourceWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            exportCreatedAt: timestamp,
            manifestDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        verification: {
          fileCount: 4,
          totalBytes: 16,
          checkedFiles: ['records/workspace-record.json'],
        },
        collision: {
          status: 'collides',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          suggestedWorkspaceId: 'ws_00000000-0000-7089-bb95-d4e3b1944597',
        },
      }).workspace.importedFrom?.sourceWorkspaceId
    ).toBe('ws_00000000-0000-7000-8000-000000000001');
  });

  it('keeps credential-pattern rejection on secret-adjacent Vault metadata', () => {
    expect(
      VaultAdminStatusResponseSchema.safeParse({
        backendKind: 'encrypted-file',
        state: 'available',
        diagnostic: 'Public fixture ghp_publicFixture',
      }).success
    ).toBe(false);
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
        grantId: 'grant_00000000-0000-79cb-b598-745f38b7a39a',
        grantScope: 'agent-session',
        referenceId: 'vault_00000000-0000-72d1-b90a-e14fea8ea955',
        secretKind: 'codex-auth-json',
        targetPath: '/sandbox/.codex/auth.json',
        expiresAt: null,
      }).targetPath
    ).toBe('/sandbox/.codex/auth.json');
    expect(SetProviderApiKeyRequestSchema.parse({ apiKey: 'provider-secret' }).apiKey).toBe(
      'provider-secret'
    );
    expect(
      SetProviderApiKeyResponseSchema.parse({ configured: true, providerId: 'xai-api' })
    ).toEqual({ configured: true, providerId: 'xai-api' });
    expect(ProviderApiKeyProfileIdSchema.safeParse('openrouter').success).toBe(true);
    for (const providerId of ['openrouter.ai', 'provider/path', 'foo-sk-demo', 'foo-okt_demo']) {
      expect(ProviderApiKeyProfileIdSchema.safeParse(providerId).success).toBe(false);
    }
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
        referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
        secretKind: 'api-token',
        status: 'active',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }).status
    ).toBe('active');
    expect(
      VaultAdminListWorkspaceReferencesResponseSchema.parse({
        items: [
          {
            backendKind: 'encrypted-file',
            currentVersion: 0,
            ownerScope: 'workspace',
            referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
            secretKind: 'api-token',
            status: 'unbound',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          grantId: 'grant_00000000-0000-79cb-b598-745f38b7a39a',
          grantScope: 'agent-session',
          referenceId: 'vault_00000000-0000-72d1-b90a-e14fea8ea955',
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
          referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
          secretKind: secret,
          status: 'active',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        }).success
      ).toBe(false);
      expect(
        SetProviderApiKeyResponseSchema.safeParse({
          configured: true,
          providerId: secret,
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
        grantId: 'grant_00000000-0000-79cb-b598-745f38b7a39a',
        grantScope: 'agent-session',
        referenceId: 'vault_00000000-0000-72d1-b90a-e14fea8ea955',
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
        referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
        secretKind: 'api-token',
        status: 'active',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            referenceId: 'vault_00000000-0000-7f9a-ae09-1112bc878c49',
            secretKind: 'api-token',
            status: 'unbound',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        vaultUseRecords: [
          {
            useId: 'vu_00000000-0000-75fa-849e-4340c0f82434',
            ownerScope: 'workspace',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            vaultReferenceId: 'vault_00000000-0000-7853-804c-d936d74689a9',
            materialVersion: 1,
            backendKind: 'os-keychain',
            resolvingPath: 'grant',
            grantId: 'grant_00000000-0000-7c9a-b1a6-5332fc0a70f3',
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
            useId: 'vu_00000000-0000-7b30-8b4d-e1ffa9d38436',
            ownerScope: 'server',
            workspaceId: null,
            vaultReferenceId: 'vault_00000000-0000-7853-804c-d936d74689a9',
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

  it('requires a strict process sample without host health or build claims', () => {
    const processSample = processDiagnosticsSample();
    const payload = appDiagnosticsPayload();
    const { process: _process, ...withoutProcess } = payload;

    expect(AppDiagnosticsResponseSchema.parse(payload).process).toEqual(processSample);
    expect(AppDiagnosticsResponseSchema.safeParse(withoutProcess).success).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        process: { ...processSample, hostHealthy: true },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        process: { ...processSample, buildId: 'build_demo' },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        process: { ...processSample, uptimeSeconds: -1 },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        process: { ...processSample, telemetry: { enabled: true } },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        process: {
          ...processSample,
          telemetry: { enabled: true, exportConfigured: true, delivered: true },
        },
      }).success
    ).toBe(false);
  });

  it('requires a closed release identity and lets an older client omit it', () => {
    const payload = appDiagnosticsPayload();
    const { build: _build, ...withoutBuild } = payload;
    const release = {
      releaseTag: 'v0.1.0-rc.5',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    };

    expect(AppDiagnosticsResponseSchema.parse({ ...payload, build: release }).build).toEqual(
      release
    );
    expect(AppDiagnosticsResponseSchema.safeParse(withoutBuild).success).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        build: { releaseTag: release.releaseTag, sourceCommit: null },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsResponseSchema.safeParse({
        ...payload,
        build: { ...release, imageId: 'sha256:ignored' },
      }).success
    ).toBe(false);
    expect(AppDiagnosticsClientResponseSchema.parse(withoutBuild)).toEqual(withoutBuild);
    expect(AppDiagnosticsClientResponseSchema.parse({ ...payload, build: release }).build).toEqual(
      release
    );
    expect(
      AppDiagnosticsClientResponseSchema.parse({
        ...payload,
        build: { ...release, note: 'inert future metadata' },
      }).build
    ).toEqual(release);
    expect(
      AppDiagnosticsClientResponseSchema.safeParse({
        ...payload,
        build: { releaseTag: release.releaseTag, sourceCommit: null },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsClientResponseSchema.safeParse({
        ...payload,
        build: { releaseTag: null, sourceCommit: release.sourceCommit },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsClientResponseSchema.safeParse({
        ...payload,
        build: { releaseTag: 'V0.1.0', sourceCommit: release.sourceCommit },
      }).success
    ).toBe(false);
    expect(
      AppDiagnosticsClientResponseSchema.safeParse({
        ...payload,
        build: { releaseTag: release.releaseTag, sourceCommit: 'abc' },
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
          id: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-7d53-9abb-fba003a3df39',
          agentId: 'assistant',
          agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
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
          id: 'use_00000000-0000-7bad-8061-11b8ce86e984',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-7d53-9abb-fba003a3df39',
          agentId: 'assistant',
          agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
          sourceIds: ['repo_default'],
          requestId,
          capabilityCallId: 'cap_00000000-0000-7d4f-884e-ab4fdf8dc968',
          category: 'llm',
          unit: 'usd',
          quantity: 0.012,
          modelId: 'openai/gpt-5.1',
          providerRef: 'openrouter',
          source: 'llm-gateway-adapter-reported:cost_estimate',
          recordedAt: timestamp,
        },
      ],
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });

    expect(parsed.usageRecords[0]?.capabilityCallId).toBe(
      'cap_00000000-0000-7d4f-884e-ab4fdf8dc968'
    );
    expect(parsed.usageRecords[0]?.unit).toBe('usd');
    expect(parsed.capabilityCalls[0]).toMatchObject({
      packageSnapshotId: 'aepsnap_demo',
      runtimeOriginRef: `rto_${'a'.repeat(24)}`,
      runtimeCacheLineageRef: `rcl_${'b'.repeat(24)}`,
    });
    expect(
      CapabilityUsageResponseSchema.parse({
        ...parsed,
        capabilityCalls: [
          {
            ...parsed.capabilityCalls[0],
            capabilityId: 'workspace.git.push',
            family: 'network',
            operation: 'git.push',
          },
        ],
      }).capabilityCalls[0]?.family
    ).toBe('network');
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
    expect(() =>
      CapabilityUsageResponseSchema.parse({
        ...parsed,
        capabilityCalls: [{ ...parsed.capabilityCalls[0], completedAt: null }],
      })
    ).toThrow();
  });

  it('accepts read-only evidence bundle list models', () => {
    const evidenceBundle = {
      id: 'evb_demo',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      goalId: 'goal_demo',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        evidenceBundles: [evidenceBundle],
      })
    ).toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      goalId: 'goal_demo',
      taskId: 'task_demo',
      agentSessionId: 'as_00000000-0000-78be-889a-02eee50dd060',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).toEqual({
      runtimeEvidence: [runtimeEvidence],
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

  it('accepts workspace permission decision read models with ordinary credential-looking context', () => {
    const response = ListWorkspacePermissionDecisionsResponseSchema.parse({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      permissionDecisions: [
        {
          decisionId: 'pd_00000000-0000-76cb-aeec-205247da1d48',
          ownerScope: 'workspace',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          policyEngineVersion: 'nanocore-worker-policy:v1',
          policySnapshotId: 'worker_turn_launch_policy',
          subjectSummary: { kind: 'nanocore', id: 'worker-coordinator' },
          action: 'runtime.launch',
          resourceSummary: {
            kind: 'worker-turn',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          },
          contextSummary: {
            requestId: '00000000-0000-4000-8000-00000000d791',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          },
          result: 'require_escalation',
          reasonCode: 'higher_authority_required',
          enforcementPoint: 'runtime.worker_turn_loop.start',
          requiredApprovalKind: null,
          approvalId: null,
          auditEventId: 'aud_00000000-0000-7a69-8a43-4327a55d44c3',
          createdAt: timestamp,
        },
      ],
    });

    expect(response.permissionDecisions[0]?.decisionId).toBe(
      'pd_00000000-0000-76cb-aeec-205247da1d48'
    );
    expect(
      ListWorkspacePermissionDecisionsResponseSchema.safeParse({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        permissionDecisions: [
          {
            ...response.permissionDecisions[0],
            subjectSummary: { fixture: rawSecretShapes[0] },
          },
        ],
      }).success
    ).toBe(true);
  });

  it('accepts server permission decision read models with ordinary credential-looking context', () => {
    const response = ListServerPermissionDecisionsResponseSchema.parse({
      permissionDecisions: [
        {
          decisionId: 'pd_00000000-0000-787f-8828-437c03348633',
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

    expect(response.permissionDecisions[0]?.decisionId).toBe(
      'pd_00000000-0000-787f-8828-437c03348633'
    );
    expect(
      ListServerPermissionDecisionsResponseSchema.safeParse({
        permissionDecisions: [
          {
            ...response.permissionDecisions[0],
            resourceSummary: { fixture: rawSecretShapes[0] },
          },
        ],
      }).success
    ).toBe(true);
  });

  it('preserves ordinary workspace synchronization content and canonical patch encoding', () => {
    const inputSnapshot = WorkspaceInputSnapshotSchema.parse({
      id: 'wis_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      backendKind: 'openshell',
      packageSnapshotId: 'aepsnap_1',
      workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
      strategy: 'git',
      materializedRootRef: 'worker-root://repo',
      base: { commit: 'abc123', contentDigest: null },
      policyDigest: 'sha256:policy',
      readinessEvidence: [{ kind: 'openshell.ready', ref: 'ev_1' }],
      createdAt: timestamp,
    });
    const backendHandle = BackendWorkspaceHandleSchema.parse({
      id: 'bwh_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materializationRecordId: materialization.id,
      backendKind: 'openshell',
      packageSnapshotId: 'aepsnap_1',
      workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
      transportRefs: [{ kind: 'worker-root', ref: 'worker-root://repo' }],
      cleanupStatus: 'pending',
      retention: 'until-reconciliation',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const outputManifest = WorkerOutputManifestSchema.parse({
      id: 'wom_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materializationRecordId: materialization.id,
      inputSnapshotId: inputSnapshot.id,
      workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
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
      artifactIds: ['ar_00000000-0000-7f26-8292-8ac950dddeba'],
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      artifactIds: ['ar_00000000-0000-7f26-8292-8ac950dddeba'],
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    const workspaceReviews = ListWorkspaceSyncReviewsResponseSchema.parse({
      items: [
        {
          artifactId: 'ar_00000000-0000-7e93-b881-32f3f8c0b14a',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    });
    expect(workspaceReviews.items[0]?.artifactId).toBe('ar_00000000-0000-7e93-b881-32f3f8c0b14a');

    const item = workspaceReviews.items[0]!;
    for (const text of [
      'diff --git a/src/fixture.ts b/src/fixture.ts\n+const fixture = "ghp_publicFixture";\n',
      'sk-Latn hf_publicFixture okt_publicFixture',
    ]) {
      const payload = { ...item.patchPayload!, text };
      for (const patchPayload of [
        payload,
        { ...payload, encoding: 'base64' as const, text: btoa(text) },
      ]) {
        const retained = { ...item, patchPayload, review: { ...item.review, riskSummary: text } };
        const read = ListWorkspaceSyncReviewsResponseSchema.parse({ items: [retained] }).items[0]!;
        expect(read).toEqual(retained);
        expect(
          new TextDecoder().decode(appApiSchemas.workspaceSyncReviewPatchBytes(read.patchPayload!))
        ).toBe(text);
      }
    }
    for (const text of ['%%%', 'Zg', 'Zh==']) {
      expect(
        appApiSchemas.WorkspaceSyncReviewPatchPayloadSchema.safeParse({
          ...item.patchPayload!,
          encoding: 'base64',
          text,
        }).success
      ).toBe(false);
    }

    const applyResult = {
      id: 'war_swr_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            backendKind: 'openshell',
            packageSnapshotId: 'aepsnap_1',
            workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
            strategy: 'git',
            materializedRootRef: 'workspace://ws_00000000-0000-7000-8000-000000000001/repo_default',
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
            transportRefs: [
              {
                kind: 'materialized-root',
                ref: 'workspace://ws_00000000-0000-7000-8000-000000000001/repo_default',
              },
            ],
            updatedAt: timestamp,
            workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
      }).items[0]?.id
    ).toBe('bwh_1');
    expect(
      ListWorkerOutputManifestsResponseSchema.parse({ items: [outputManifest] }).items[0]?.id
    ).toBe('wom_1');
    const applyPlan = WorkspaceApplyPlanSchema.parse({
      id: 'wap_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      triggerReason: 'restart',
      affectedRecordIds: ['wmr_1', 'bwh_1'],
      backendHandleSummary: {
        backendKind: 'openshell',
        handleId: 'bwh_1',
        workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            title: 'Workspace recovery needs review',
            summary: 'Recovery requires a human decision: inspect_recovery.',
            severity: 'blocked',
            createdAt: timestamp,
            recommendedAction:
              'Review the recovery evidence and choose how NanoCore should proceed.',
            source: {
              type: 'workspace_recovery',
              reconciliationRecordId: 'wrr_1',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
                method: 'POST',
                href: '/api/app/operations/sync.reconciliation-list',
              },
              {
                kind: 'retry_work',
                label: 'Resume collection',
                method: 'POST',
                href: '/api/app/operations/sync.recovery-decide',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

  it('rejects unsafe workspace synchronization paths', () => {
    const payload = {
      id: 'wcs_unsafe',
      materializationRecordId: 'wmr_1',
      inputSnapshotId: 'wis_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materializationRecordId: 'wmr_1',
        inputSnapshotId: 'wis_1',
        workerSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      agentSessionId: 'as_00000000-0000-7860-9e37-d1a60b30c856',
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
    expect(
      GetAgentEnvironmentPackageSnapshotResponseSchema.parse({
        ...record,
        snapshot: { ...snapshot, note: 'sk-public-fixture' },
      }).snapshot.note
    ).toBe('sk-public-fixture');
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

  it('preserves bounded optional runtime activity without claiming complete coverage', () => {
    const activity = {
      turnId: 'tu_00000000-0000-7bde-8e11-bbfbdf1c1bf6',
      contentCapture: 'off',
      coverage: 'partial',
      entries: [
        {
          sequence: 1,
          observedAt: timestamp,
          kind: 'result',
          label: 'Reported child result',
          text: 'Verified the selected change.',
          textTruncated: false,
        },
      ],
      omittedEntryCount: 2,
    };
    const schema = appApiSchemas.ThreadDashboardResponseSchema.partial();
    expect(schema.parse({ runtimeActivity: [activity] })).toEqual({ runtimeActivity: [activity] });
    expect(schema.parse({})).not.toHaveProperty('runtimeActivity');
    for (const coverage of ['collecting', 'partial', 'unavailable']) {
      expect(schema.safeParse({ runtimeActivity: [{ ...activity, coverage }] }).success).toBe(true);
    }
    for (const invalid of [
      { ...activity, coverage: 'complete' },
      { ...activity, contentCapture: undefined },
      { ...activity, contentCapture: 'collecting' },
      { ...activity, omittedEntryCount: -1 },
      { ...activity, entries: Array.from({ length: 51 }, () => activity.entries[0]) },
      ...[
        { text: 'x'.repeat(1001) },
        { label: 'x'.repeat(81) },
        { sequence: -1 },
        { observedAt: 'not-a-timestamp' },
        { kind: 'approval-required' },
        { body: 'restricted content' },
        { runtimeOriginRef: 'native-child-id' },
        { approvalRequestId: 'ap_fake' },
      ].map((fields) => ({ ...activity, entries: [{ ...activity.entries[0], ...fields }] })),
    ]) {
      expect(schema.safeParse({ runtimeActivity: [invalid] }).success).toBe(false);
    }
  });

  it('discards unowned dashboard mode and routing fields as additive read metadata', () => {
    const workStatus = {
      selectedAgentId: 'quick-chat',
      activeTurnStatus: 'idle',
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      latestArtifact: null,
    };
    expect(
      appApiSchemas.ThreadWorkStatusSchema.parse({
        ...workStatus,
        currentMode: 'automation',
        routing: {
          decision: 'worker_turn',
          explanation: 'Unowned projection.',
          selectedAgentId: 'quick-chat',
          confidence: 1,
          requiredUserAction: null,
        },
      })
    ).toEqual(workStatus);
    const activeWork = {
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      title: 'Active conversation',
      status: 'running',
      agentId: 'quick-chat',
      summary: null,
      updatedAt: timestamp,
    };
    expect(
      appApiSchemas.WorkspaceActiveWorkSchema.parse({ ...activeWork, mode: 'automation' })
    ).toEqual(activeWork);
    expect(appApiSchemas).not.toHaveProperty('ProductWorkModeSchema');
    expect(appApiSchemas).not.toHaveProperty('WorkRoutingSchema');
  });

  it('keeps AgentSession continuity out of ordinary App API schemas', () => {
    expect(appApiSchemas.ThreadDashboardResponseSchema.shape).not.toHaveProperty('activeSession');
    expect(appApiSchemas.ThreadDashboardResponseSchema.shape).toHaveProperty('taskInputs');
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
    expect(appApiSchemas.ExecutionAttemptHumanAttentionSourceSchema.shape).not.toHaveProperty(
      'agentSessionId'
    );
  });

  it('keeps AgentSession identity out of ordinary embedded Turn projections', () => {
    const turn = {
      id: 'tu_00000000-0000-7bde-8e11-bbfbdf1c1bf6',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
      items: [],
      status: 'running' as const,
      error: null,
      agentSessionId: 'as_00000000-0000-7271-8ba3-bea82b217022',
      configVersion: null,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
    };
    const dashboard = appApiSchemas.ThreadDashboardResponseSchema.parse({
      viewerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      participants: [
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001', displayName: 'Simon' },
      ],
      thread: {
        id: 'th_00000000-0000-7000-8000-000000000001',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        entryPath: 'conversation',
        visibility: 'workspace',
        name: 'Demo',
        preview: 'Demo',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      turns: [turn],
      artifacts: [],
      workStatus: {
        selectedAgentId: null,
        activeTurnStatus: 'running',
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        latestArtifact: null,
      },
      composer: {
        disabled: false,
        defaultAgentId: null,
      },
      itemLog: {
        href: '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/items',
      },
      taskInputs: [],
    });
    const chat = SubmitConversationResponseSchema.parse({
      outcome: 'answered',
      explanation: 'Answered.',
      turn,
      item: {
        id: 'it_00000000-0000-7636-ae96-fc295661d12a',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-7bde-8e11-bbfbdf1c1bf6',
        type: 'status',
        status: 'completed',
        level: 'info',
        title: 'Answered',
        summary: 'Answered.',
        createdAt: timestamp,
        completedAt: timestamp,
      },
      handoff: null,
      originatingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
      receivingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      receivingThreadId: 'th_00000000-0000-7000-8000-000000000001',
      targetRef: 'internal-role:assistant',
      logicalModelId: 'default',
    });
    const task = StartTaskModeResponseSchema.parse({
      state: 'running',
      turn,
      evidence: { itemIds: [], artifactIds: [] },
    });

    expect(dashboard.viewerUserId).toBe('usr_00000000-0000-7000-8000-000000000001');
    expect(dashboard.participants[0]?.displayName).toBe('Simon');
    expect(jsonContainsKey(dashboard, 'agentSessionId')).toBe(false);
    expect(jsonContainsKey(chat, 'agentSessionId')).toBe(false);
    expect(jsonContainsKey(task, 'agentSessionId')).toBe(false);
    expect(
      jsonContainsKey(z.toJSONSchema(appApiSchemas.ThreadDashboardResponseSchema), 'agentSessionId')
    ).toBe(false);
    expect(
      jsonContainsKey(z.toJSONSchema(SubmitConversationResponseSchema), 'agentSessionId')
    ).toBe(false);
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

  it('accepts Workspace catalog runtime config file metadata', () => {
    expect(
      RuntimeConfigFileListResponseSchema.parse({
        files: [
          {
            id: 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
            kind: 'data-source',
            path: 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
            exists: true,
            revision: 'sha256:abc',
            updatedAt: timestamp,
          },
        ],
      }).files[0]?.kind
    ).toBe('data-source');
    expect(
      RuntimeConfigFileWriteRequestSchema.parse({
        id: 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc',
        kind: 'data-source',
        content: '{"schemaVersion":1,"sources":[]}',
      }).kind
    ).toBe('data-source');
    expect(
      RuntimeConfigSchemaCatalogResponseSchema.parse({
        schemas: [{ kind: 'data-source', title: 'Workspace data sources', schema: {} }],
      }).schemas[0]?.kind
    ).toBe('data-source');
    expect(
      RuntimeConfigFileWriteRequestSchema.safeParse({
        id: 'workspaces/ws_00000000-0000-7000-8000-000000000001/mcp-servers.jsonc',
        kind: 'mcp-server',
        content: '{"schemaVersion":1,"servers":[]}',
      }).success
    ).toBe(false);
  });

  it('preserves an optional exact Task Agent selector in the shared and operation schemas', () => {
    const request = {
      input: 'Implement the focused fix.',
      requestId: '0190f4c8-0000-7000-8000-000000000133',
    };
    const selector = { agentId: 'agent_selected' };
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    expect(StartTaskModeRequestSchema.parse({ ...request, ...selector })).toEqual({
      ...request,
      ...selector,
    });
    expect(
      TASK_OPERATION_DEFINITIONS['task.start'].inputSchema.parse({
        ...request,
        ...scope,
        ...selector,
      })
    ).toEqual({ ...request, ...scope, ...selector });
    expect(StartTaskModeRequestSchema.parse(request)).toEqual(request);
    expect(
      TASK_OPERATION_DEFINITIONS['task.start'].inputSchema.parse({ ...request, ...scope })
    ).toEqual({ ...request, ...scope });
  });

  it.each(['', null, 133])('rejects an invalid exact Task Agent selector %s', (agentId) => {
    const request = {
      agentId,
      input: 'Implement the focused fix.',
      requestId: '0190f4c8-0000-7000-8000-000000000133',
    };
    expect(StartTaskModeRequestSchema.safeParse(request).success).toBe(false);
    expect(
      TASK_OPERATION_DEFINITIONS['task.start'].inputSchema.safeParse({
        ...request,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      }).success
    ).toBe(false);
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
          { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
          { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
          { kind: 'knowledge', id: 'mem_project' },
        ],
      },
      state: 'completed',
      turn: {
        id: 'tu_00000000-0000-7535-81b9-0d55f9492809',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
        items: [],
        status: 'completed',
        configVersion: null,
        feedback: null,
        error: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 1,
      },
      completion: {
        itemId: 'it_00000000-0000-7d7d-9289-0dbf0bfeea93',
        text: 'Completed by worker.',
      },
      evidence: {
        itemIds: ['it_00000000-0000-7d7d-9289-0dbf0bfeea93'],
        artifactIds: ['ar_00000000-0000-71b9-88b9-1f73be293bf4'],
        reviewIds: ['swr_task_result'],
      },
    });

    expect(taskResponse).not.toHaveProperty('decision');
    expect(taskResponse.completion).toEqual({
      itemId: 'it_00000000-0000-7d7d-9289-0dbf0bfeea93',
      text: 'Completed by worker.',
    });
    expect(taskResponse.evidence).toEqual({
      itemIds: ['it_00000000-0000-7d7d-9289-0dbf0bfeea93'],
      artifactIds: ['ar_00000000-0000-71b9-88b9-1f73be293bf4'],
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
          itemIds: ['it_00000000-0000-7af7-a15f-76f69a2469cb'],
          artifactIds: [],
        },
        turn: {
          id: 'tu_00000000-0000-7ae2-b8ad-bd9415f8e874',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
          items: [],
          status: 'completed',
          configVersion: null,
          feedback: null,
          error: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 1,
        },
      }).escalation?.goalId
    ).toBe('goal_1');
  });

  it('accepts Chat Mode Assistant answers and handoff projections', () => {
    expect(ChatModeOutcomeSchema.safeParse('failed').success).toBe(false);
    expect(
      SubmitConversationRequestSchema.safeParse({ input: 'Missing request id.' }).success
    ).toBe(false);
    expect(
      SubmitConversationRequestSchema.parse({
        input: 'What is this workspace?',
        targetRef: 'internal-role:assistant',
        requestId: 'req_chat_1',
      }).input
    ).toBe('What is this workspace?');
    expect(
      SubmitConversationRequestSchema.parse({
        input: 'What is this workspace?',
        targetRef: 'internal-role:assistant',
        requestId: 'req_chat_1',
      }).workerStorageChoice
    ).toBeUndefined();
    expect(
      SubmitConversationRequestSchema.parse({
        input: 'Ship the bounded task.',
        requestId: 'req_chat_storage_fresh',
        targetRef: 'new-task-worker',
        workerStorageChoice: { kind: 'fresh' },
      }).workerStorageChoice
    ).toEqual({ kind: 'fresh' });
    expect(
      SubmitConversationRequestSchema.parse({
        input: 'Ship the bounded task.',
        requestId: 'req_chat_storage_selected',
        targetRef: 'warm-worker:agent_codex_host:default',
        workerStorageChoice: {
          expectedRevision: 4,
          kind: 'selected',
          purpose: 'work',
          storageRef: 'wst_00000000-0000-7b39-9ec2-cb19893c9f63',
        },
      }).workerStorageChoice
    ).toMatchObject({
      expectedRevision: 4,
      kind: 'selected',
      storageRef: 'wst_00000000-0000-7b39-9ec2-cb19893c9f63',
    });
    expect(
      SubmitConversationRequestSchema.safeParse({
        input: 'Ship the bounded task.',
        requestId: 'req_chat_storage_forged',
        targetRef: 'new-task-worker',
        workerStorageChoice: {
          expectedRevision: 4,
          goalId: 'goal_forged',
          kind: 'selected',
          purpose: 'work',
          storageRef: 'wst_00000000-0000-7b39-9ec2-cb19893c9f63',
        },
      }).success
    ).toBe(false);
    expect(
      SubmitConversationResponseSchema.parse({
        outcome: 'task-handoff',
        explanation: 'The request needs bounded worker execution.',
        handoff: {
          targetMode: 'task',
          reason: 'The request needs bounded worker execution.',
          statusItemId: 'it_00000000-0000-77cd-a3ff-b9fd6e85f6b3',
        },
        turn: {
          id: 'tu_00000000-0000-72d8-abbb-24b8f02f0976',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
          items: [],
          status: 'completed',
          configVersion: null,
          feedback: null,
          error: null,
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 1,
        },
        item: {
          id: 'it_00000000-0000-77cd-a3ff-b9fd6e85f6b3',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-72d8-abbb-24b8f02f0976',
          type: 'status',
          status: 'completed',
          level: 'info',
          title: 'Task Mode handoff',
          summary: 'The request needs bounded worker execution.',
          createdAt: timestamp,
          completedAt: timestamp,
        },
        originatingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
        receivingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        receivingThreadId: 'th_00000000-0000-7000-8000-000000000001',
        targetRef: 'internal-role:assistant',
        logicalModelId: 'default',
      }).handoff?.targetMode
    ).toBe('task');
  });

  it.each([
    ['Quick Chat', QuickChatRequestSchema, { input: 'Hello' }],
    [
      'Chat Mode',
      SubmitConversationRequestSchema,
      { input: 'Hello', requestId: 'req_chat_provider_authority' },
    ],
  ])('rejects caller provider and model authority from %s requests', (_name, schema, input) => {
    for (const override of [{ providerId: 'caller-provider' }, { model: 'caller-model' }]) {
      expect(schema.safeParse({ ...input, ...override }).success).toBe(false);
    }
  });

  it('rejects caller Workspace authority from Quick Chat requests', () => {
    expect(
      QuickChatRequestSchema.safeParse({
        input: 'Hello',
        workspaceId: 'ws_00000000-0000-7349-9b29-0b0df94928e7',
      }).success
    ).toBe(false);
  });

  it('preserves ordinary Git push summaries and rejects host paths', () => {
    const pushRecord = {
      id: 'gpr_1',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      repositoryResourceId: 'repo_default',
      approvalRowId: 'har_1',
      policyDecisionId: 'pd_00000000-0000-7a55-84b6-910265042f6b',
      actorId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
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

    expect(ArchivedGitPushRecordSchema.parse(pushRecord).outcome).toBe('pushed');
    expect(
      ArchivedGitPushRecordSchema.parse({
        ...pushRecord,
        errorSummary: 'Git push refused because V1 supports GitHub remotes only.',
        outcome: 'unsupported-provider',
        remoteHeadAfter: null,
        remoteHeadBefore: null,
      }).outcome
    ).toBe('unsupported-provider');
    expect(
      ArchivedGitPushRecordSchema.safeParse({
        ...pushRecord,
        remoteSummary: 'GitHub repository at /Users/example/openkit',
      }).success
    ).toBe(false);
    expect(
      ArchivedGitPushRecordSchema.safeParse({
        ...pushRecord,
        errorSummary: 'public fixture ghp_openkit_fixture',
      }).success
    ).toBe(true);
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
          quotaCapability: 'available',
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

  it('accepts only positive integer provider-subscription window durations when supplied', () => {
    const quota = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'work',
      availability: 'available',
      observedAt: timestamp,
      windows: [{ id: 'primary', limitWindowSeconds: 18_000 }],
    };
    const schema = appApiSchemas.ProviderSubscriptionQuotaSchema;
    expect(schema.parse(quota)).toEqual(quota);
    expect(schema.parse({ ...quota, windows: [{ id: 'secondary' }] })).toEqual({
      ...quota,
      windows: [{ id: 'secondary' }],
    });
    for (const duration of [0, -1, 1.5, '18000', null]) {
      expect(
        schema.safeParse({
          ...quota,
          windows: [{ id: 'primary', limitWindowSeconds: duration }],
        }).success
      ).toBe(false);
    }
  });

  it('accepts only the declared provider-subscription quota dispositions', () => {
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
    const availableXai = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      availability: 'available',
      observedAt: timestamp,
      planType: 'SuperGrok',
      subscriptionActive: true,
      accountObservedAt: timestamp,
      windows: [
        {
          id: 'included',
          usedPercent: 42.5,
          remainingPercent: 57.5,
          periodType: 'weekly',
          startsAt: timestamp,
          resetsAt: timestamp,
        },
      ],
      billing: {
        currency: 'USD',
        prepaidBalanceCents: 0,
        onDemandUsedCents: 125,
        onDemandCapCents: 5000,
        sharedAllowance: true,
      },
    };
    const availableXaiOmittedUsage = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      availability: 'available',
      observedAt: timestamp,
      subscriptionActive: false,
      accountObservedAt: timestamp,
      windows: [
        {
          id: 'included',
          periodType: 'monthly',
          startsAt: timestamp,
          resetsAt: timestamp,
        },
      ],
    };
    const unavailable = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'work',
      availability: 'temporarily_unavailable',
      observedAt: timestamp,
      retryAfter: timestamp,
    };
    const unavailableXai = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      availability: 'temporarily_unavailable',
      observedAt: timestamp,
      planType: 'SuperGrok',
      subscriptionActive: true,
      accountObservedAt: timestamp,
    };
    const unsupported = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      availability: 'unsupported',
      observedAt: timestamp,
    };

    expect(quotaSchema.parse(available)).toEqual(available);
    expect(quotaSchema.parse(availableXai)).toEqual(availableXai);
    expect(quotaSchema.parse(availableXaiOmittedUsage)).toEqual(availableXaiOmittedUsage);
    expect(quotaSchema.parse(unavailable)).toEqual(unavailable);
    expect(quotaSchema.parse(unavailableXai)).toEqual(unavailableXai);
    const rejected = {
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'work',
      availability: 'authentication_required',
      observedAt: timestamp,
    };
    expect(quotaSchema.parse(rejected)).toEqual(rejected);
    for (const extra of [
      { windows: [] },
      { rawProviderError: 'secret' },
      { credential: 'secret' },
    ]) {
      expect(quotaSchema.safeParse({ ...rejected, ...extra }).success).toBe(false);
    }
    for (const quota of [
      unsupported,
      { ...unsupported, subscriptionProviderId: 'openai-codex' },
      {
        ...available,
        windows: [{ ...available.windows[0], usedPercent: 101 }],
      },
      {
        ...availableXai,
        windows: [{ ...availableXai.windows[0], usedPercent: null }],
      },
      {
        ...availableXai,
        windows: [{ ...availableXai.windows[0], periodType: 'daily' }],
      },
      { ...availableXai, billing: { ...availableXai.billing, prepaidBalanceCents: 1.5 } },
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
      { ...unavailable, observedAt: 'not-a-datetime' },
      { ...unavailable, retryAfter: 'not-a-datetime' },
      { ...unavailableXai, observedAt: 'not-a-datetime' },
    ]) {
      expect.soft(quotaSchema.safeParse(quota).success).toBe(false);
    }
  });

  it('accepts only the xAI auto-top-up observation', () => {
    const autoTopupSchema = Reflect.get(appApiSchemas, 'ProviderSubscriptionAutoTopupSchema') as
      | typeof AppDiagnosticsResponseSchema
      | undefined;

    expect(autoTopupSchema).toBeDefined();
    if (!autoTopupSchema) {
      return;
    }

    const available = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      observedAt: timestamp,
      availability: 'available',
      currency: 'USD',
      enabled: false,
      thresholdCents: 100,
      amountCents: 2500,
      monthlyCapCents: 10_000,
    };
    const availableUnknownEnabled = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      observedAt: timestamp,
      availability: 'available',
      currency: 'USD',
    };
    const unavailable = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'work',
      observedAt: timestamp,
      availability: 'temporarily_unavailable',
    };

    expect(autoTopupSchema.parse(available)).toEqual(available);
    expect(autoTopupSchema.parse(availableUnknownEnabled)).toEqual(availableUnknownEnabled);
    expect(autoTopupSchema.parse(unavailable)).toEqual(unavailable);
    for (const observation of [
      { ...available, subscriptionProviderId: 'openai-codex' },
      { ...available, enabled: null },
      { ...available, thresholdCents: 1.5 },
      { ...available, savedPaymentMethod: true },
      { ...unavailable, currency: 'USD' },
      { ...unavailable, retryAfter: timestamp },
    ]) {
      expect(autoTopupSchema.safeParse(observation).success).toBe(false);
    }
  });

  it('accepts dashboard, auth, quick chat, agent catalog, and action center payloads', () => {
    expect(
      AuthSignUpEmailResponseSchema.parse({
        token: 'as_00000000-0000-78f3-bdfb-13f04d6a5a83',
        user: {
          id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          email: 'user@example.com',
          name: 'Demo User',
          emailVerified: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          image: null,
        },
      }).user.id
    ).toBe('usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    expect(
      AuthSignInEmailResponseSchema.parse({
        redirect: false,
        token: 'as_00000000-0000-78f3-bdfb-13f04d6a5a83',
        url: null,
        user: {
          id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
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
    expect(
      AuthGetSessionResponseSchema.parse({
        session: { id: 'as_00000000-0000-7fee-81f4-cfcfc003f25f' },
        user: {
          id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          email: 'user@example.com',
          name: 'Demo User',
          emailVerified: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }).user.id
    ).toBe('usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    expect(AuthGetSessionResultSchema.parse(null)).toBeNull();
    expect(
      AuthSignUpEmailResponseSchema.safeParse({
        user: { id: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b' },
      }).success
    ).toBe(false);
    expect(
      ConsumeOpenKitBootstrapTokenRequestSchema.parse({
        displayName: 'Owner',
        email: 'owner@example.com',
        ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
        password: 'password123456',
        token: 'okt_bootstrap_secret',
        tokenExpiresAt: timestamp,
      }).ownerUserId
    ).toBe('usr_00000000-0000-7011-88df-c2b1e8466b6f');
    expect(
      ConsumeOpenKitBootstrapTokenResponseSchema.parse({
        token: 'okt_owner_secret',
        record: {
          tokenId: 'tok_00000000-0000-7194-b4f8-8fa26eda7175',
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
    ).toBe('usr_00000000-0000-7011-88df-c2b1e8466b6f');
    expect(
      CreateOpenKitAccessTokenRequestSchema.parse({
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: timestamp,
      }).scope
    ).toBe('workspace');
    expect(
      CreateOpenKitAccessTokenRequestSchema.parse({
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: timestamp,
        ownerUserId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
      }).ownerUserId
    ).toBe('usr_00000000-0000-7d56-82f8-ec994b63859b');
    expect(
      CreateOpenKitAccessTokenResponseSchema.parse({
        token: 'okt_openkit_secret',
        record: {
          tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
            tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
    ).toBe('tok_00000000-0000-71d2-a336-a862021357ff');
    expect(
      RevokeOpenKitAccessTokenResponseSchema.parse({
        record: {
          tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
          tokenId: 'tok_00000000-0000-7c9e-a136-86e094ee0dc9',
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
          scope: 'server-admin',
          workspaceIds: [],
          status: 'active',
          issuedAt: timestamp,
          expiresAt: timestamp,
          revokedAt: null,
          predecessorTokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
          rotatedGraceExpiresAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
          lastUsedSource: null,
        },
        rotatedRecord: {
          tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
          ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
            tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
      ListMyAdminAccessTokensResponseSchema.parse({
        items: [
          {
            tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        defaultTokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
      }).defaultTokenId
    ).toBe('tok_00000000-0000-71d2-a336-a862021357ff');
    expect(
      SetMyAdminAccessTokenDefaultRequestSchema.parse({
        tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
      }).tokenId
    ).toBe('tok_00000000-0000-71d2-a336-a862021357ff');
    expect(
      ListMyAdminAccessTokensResponseSchema.safeParse({
        items: [
          {
            tokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
            ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
        defaultTokenId: 'tok_00000000-0000-71d2-a336-a862021357ff',
      }).success
    ).toBe(false);
    expect(
      QuickChatResponseSchema.parse({
        id: 'quick_1',
        status: 'completed',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        modelId: 'default',
        content: 'ok',
      }).content
    ).toBe('ok');
    expect(
      AutomationRecordSchema.parse({
        id: 'auto_00000000-0000-753e-a23a-1b96fc74424c',
        name: 'Daily summary',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        cron: '0 9 * * *',
        prompt: 'Summarize yesterday.',
        status: 'paused',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).status
    ).toBe('paused');
    expect(
      AppSearchResponseSchema.parse({
        items: [
          {
            kind: 'thread',
            id: 'th_00000000-0000-7000-8000-000000000001',
            title: 'Thread',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          },
        ],
      }).items[0]?.kind
    ).toBe('thread');
    expect(
      TurnFeedbackResponseSchema.parse({
        turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
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
          id: 'ws_00000000-0000-7000-8000-000000000001',
          name: 'Demo',
          kind: 'code',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0, providerCount: 0 },
        defaultContext: { agentId: null },
        agentHealth: [],
        activeWork: [],
        recentCompletions: [],
        attentionNeeded: [],
        recentThreads: [],
      }).activeWork
    ).toEqual([]);
    expect(
      ListInterruptedWorkerStatesResponseSchema.parse({
        items: [
          {
            kind: 'interrupted_worker_state',
            checkpointId:
              'ws_00000000-0000-7000-8000-000000000001:th_00000000-0000-7000-8000-000000000001:tu_00000000-0000-77e3-bfde-66477d556f64',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
            goalId: null,
            taskId: null,
            stage: 'running_worker',
            iteration: 1,
            workerSessionId: 'deterministic-worker',
            contextDigest: 'deterministic:tu_00000000-0000-77e3-bfde-66477d556f64',
            contextAssembly: {
              contextDigest: 'deterministic:tu_00000000-0000-77e3-bfde-66477d556f64',
              contextRefs: [
                { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
                { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
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
      contextDigest: 'deterministic:tu_00000000-0000-77e3-bfde-66477d556f64',
      contextRefs: [
        { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
        { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
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
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
      })
    ).toEqual({ outcome: 'released_for_retry', turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64' });
    expect(CancelSchedulerAdmissionResponseSchema.parse({ cancelled: true }).cancelled).toBe(true);
    expect(RetrySchedulerAdmissionResponseSchema.parse({ retried: true }).retried).toBe(true);
    expect(
      appApiSchemas.SchedulerAdmissionDenialReasonSchema.safeParse('no-healthy-target').success
    ).toBe(false);
    expect(
      ListSchedulerAdmissionsResponseSchema.parse({
        items: [
          {
            queueEntryId: 'queue_1',
            requestId: '00000000-0000-4000-8000-000000000001',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
            requestedAgentId: 'agent_codex_host',
            profileRef: 'default',
            modelId: null,
            enqueuedAt: timestamp,
            status: 'queued',
            denialReason: null,
            queuePosition: 1,
          },
          {
            queueEntryId: 'queue_denied',
            requestId: null,
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-7e56-9ec6-94a079616b6f',
            requestedAgentId: 'agent_codex_host',
            profileRef: 'default',
            modelId: null,
            enqueuedAt: timestamp,
            status: 'denied',
            denialReason: 'authority-denied',
            queuePosition: null,
          },
        ],
      }).items.map((item) => item.queuePosition)
    ).toEqual([1, null]);
    expect(
      ListServerAuditEventsResponseSchema.parse({
        auditEvents: [
          {
            id: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        auditEvents: [
          {
            id: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            protocolVersion: '0.4.0',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        vaultUseRecords: [
          {
            useId: 'vu_00000000-0000-743f-be9c-c9e897c3ec54',
            ownerScope: 'workspace',
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
            materialVersion: 1,
            backendKind: 'encrypted-file',
            resolvingPath: 'grant',
            grantId: 'grant_00000000-0000-7fe9-9377-b84721e910b4',
            planId: null,
            receiptId: null,
            agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
            capabilityCallId: null,
            outcome: 'succeeded',
            failureCode: null,
            auditEventId: 'aud_00000000-0000-72f4-8dcc-8c92fd4028d3',
            usedAt: timestamp,
          },
        ],
      }).vaultUseRecords
    ).toHaveLength(1);
    expect(
      ListServerVaultUseRecordsResponseSchema.parse({
        vaultUseRecords: [
          {
            useId: 'vu_00000000-0000-7172-b60a-9708e418f9c9',
            ownerScope: 'server',
            workspaceId: null,
            vaultReferenceId: 'vault_00000000-0000-74ac-b50a-3150f74675d0',
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
            auditEventId: 'aud_00000000-0000-726b-8ee2-162b4bf37c24',
            usedAt: timestamp,
          },
        ],
      }).vaultUseRecords
    ).toHaveLength(1);
    expect(ListAgentCatalogResponseSchema.parse({ items: [] }).items).toEqual([]);
    expect(ListHumanAttentionResponseSchema.parse({ items: [] }).items).toEqual([]);
  });

  it('accepts only exact version-keyed Artifact Review Action Center sources', () => {
    const source = {
      type: 'artifact_review',
      reviewId: 'arev_00000000-0000-725e-9350-18e29b99fc35',
      artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
      artifactVersion: 2,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        itemId: 'it_00000000-0000-7069-8bdd-c3aee83f1f35',
        title: 'Approval required',
        summary: 'Approve the command before the worker continues.',
        severity: 'needs_input',
        createdAt: timestamp,
        recommendedAction: 'Review and respond to the approval request.',
        source: {
          type: 'approval',
          approvalRequestId: 'ap_demo',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-7069-8bdd-c3aee83f1f35',
        },
        actions: [
          {
            kind: 'grant_approval',
            label: 'Approve',
            method: 'POST',
            href: appApiSchemas.operationHttpPath('approval.respond'),
          },
          {
            kind: 'deny_approval',
            label: 'Deny',
            method: 'POST',
            href: appApiSchemas.operationHttpPath('approval.respond'),
          },
        ],
      },
      {
        id: 'question:it_00000000-0000-7552-bffa-5f2e0a67b337',
        kind: 'question',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        itemId: 'it_00000000-0000-7552-bffa-5f2e0a67b337',
        title: 'Answer required',
        summary: 'Choose a path.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'protocol_item',
          itemType: 'user-input-request',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-7552-bffa-5f2e0a67b337',
        },
        actions: [
          {
            kind: 'answer_question',
            label: 'Answer',
            method: 'POST',
            href: '/api/turns/tu_00000000-0000-77e3-bfde-66477d556f64/input',
          },
        ],
      },
      {
        id: 'checkpoint:checkpoint_demo',
        kind: 'checkpoint_recovery',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        title: 'Worker checkpoint needs review',
        summary: 'Interrupted before terminal save.',
        severity: 'blocked',
        createdAt: timestamp,
        source: {
          type: 'worker_checkpoint',
          checkpointId: 'checkpoint_demo',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        id: 'agent-readiness:agent_demo',
        kind: 'agent_readiness',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        title: 'Agent is blocked',
        summary: 'Runtime binary is not available.',
        severity: 'blocked',
        createdAt: timestamp,
        source: {
          type: 'agent_readiness',
          agentId: 'agent_demo',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          status: 'blocked',
        },
        actions: [
          {
            kind: 'refresh_agent_readiness',
            label: 'Refresh',
            method: 'POST',
            href: '/api/app/operations/agent.health-refresh',
          },
        ],
      },
      {
        id: 'artifact-review:arev_00000000-0000-725e-9350-18e29b99fc35',
        kind: 'artifact_review',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        reviewId: 'arev_00000000-0000-725e-9350-18e29b99fc35',
        artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
        artifactVersion: 1,
        title: 'Review artifact',
        summary: 'The artifact is ready for acceptance.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'artifact_review',
          reviewId: 'arev_00000000-0000-725e-9350-18e29b99fc35',
          artifactId: 'ar_00000000-0000-78f7-9fad-58a15c7011af',
          artifactVersion: 1,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        },
        actions: [
          { kind: 'accept_review', label: 'Accept', method: 'POST' },
          { kind: 'defer', label: 'Defer', method: 'POST' },
        ],
      },
      {
        id: 'workspace-review:swr_demo',
        kind: 'workspace_review',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId: 'ar_00000000-0000-7a1b-992d-86a6a4ca1a23',
        title: 'Review workspace changes',
        summary: '1 changed path staged for human review.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'workspace_review',
          reviewId: 'swr_demo',
          changeSetId: 'wcs_demo',
          artifactId: 'ar_00000000-0000-7a1b-992d-86a6a4ca1a23',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        title: 'Review knowledge proposal',
        summary: 'A knowledge proposal is waiting for review.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'knowledge',
          knowledgeProposalId: 'knowledge_proposal_demo',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        title: 'External side effect needs review',
        summary: 'A side effect requires explicit human action.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'protocol_item',
          itemType: 'approval-request',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          itemId: 'it_00000000-0000-700c-9754-b8c00fd380a8',
        },
        actions: [{ kind: 'open_turn', label: 'Open turn', method: 'GET' }],
      },
      {
        id: 'scheduler-admission:queue_demo',
        kind: 'pending_input',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        title: 'Worker turn is queued',
        summary: 'The worker turn is waiting for scheduler capacity.',
        severity: 'info',
        createdAt: timestamp,
        source: {
          type: 'scheduler_admission',
          queueEntryId: 'queue_demo',
          status: 'queued',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          requestedAgentId: 'agent_codex_host',
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
      {
        id: 'worker-control-rejection:wcr_demo',
        kind: 'blocked_turn',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        title: 'Worker control evidence was rejected',
        summary: 'A worker control request failed lineage validation.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'worker_control_rejection',
          rejectionId: 'wcr_demo',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
          packageSnapshotId: 'pkg_demo',
          route: '/api/worker-control/events/append',
          operation: 'event_append',
          errorCode: 'worker_control_lineage_mismatch',
          httpStatus: 403,
        },
        actions: [{ kind: 'open_thread', label: 'Open thread', method: 'GET' }],
      },
      {
        id: 'execution-attempt:attempt_00000000-0000-791f-9772-e5a5525d4f6a',
        kind: 'blocked_turn',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
        title: 'Worker session needs recovery review',
        summary: 'An unresolved execution attempt retains its exclusion.',
        severity: 'risk',
        createdAt: timestamp,
        source: {
          type: 'execution_attempt',
          attemptId: 'attempt_00000000-0000-791f-9772-e5a5525d4f6a',
          backendId: 'nanohost',
          phase: 'closing',
          disposition: 'unknown',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
            itemId: 'it_00000000-0000-7069-8bdd-c3aee83f1f35',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            title: 'Invalid action',
            summary: 'The action kind is not part of the public contract.',
            severity: 'needs_input',
            createdAt: timestamp,
            source: {
              type: 'approval',
              approvalRequestId: 'ap_demo',
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              turnId: 'tu_00000000-0000-77e3-bfde-66477d556f64',
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
        reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
        proposalId: 'kp_demo',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId: requestIds.accepted,
        decision: 'accepted' as const,
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
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
      reviewId: 'kr_00000000-0000-7612-9103-c189935bbc75',
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
});

describe('WP5 Workspace sharing schemas', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const workspace = {
    id: 'ws_00000000-0000-7000-8000-000000000001',
    name: 'Demo Workspace',
    kind: 'general',
    status: 'active',
    counts: { threadCount: 1, artifactCount: 2, knowledgeEntryCount: 3 },
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const authorizedWorkspace = {
    membershipStatus: 'active',
    accessCause: 'membership',
    workspace,
    ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    effectiveRole: 'owner',
    registryRevision: 4,
    membershipRevision: 2,
  } as const;
  const activeOwner = {
    workspaceId: workspace.id,
    userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
    invitationId: 'inv_00000000-0000-745d-88a0-12495fca5f0d',
    workspaceId: workspace.id,
    inviteeUserId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
    proposedAccessLevel: 'viewer',
    inviterUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
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
    ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    administratorRole: null,
    registryRevision: 4,
  } as const;
  const workspaceDeletion = {
    workspaceId: workspace.id,
    requestId,
    status: 'active',
    phase: 'fenced',
    recoveryExportId: null,
    closureId: null,
    retainedStaging: false,
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
    ).toBe('inv_00000000-0000-745d-88a0-12495fca5f0d');
    expect(
      appApiSchemas.WorkspaceMemberMutationResponseSchema.parse({ member: activeOwner }).member
        .userId
    ).toBe('usr_00000000-0000-7011-88df-c2b1e8466b6f');
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
      userId: 'usr_00000000-0000-7e63-b85a-c188de8ee1c3',
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
    ).toBe('usr_00000000-0000-7a9e-8345-2bce44a3dce0');
    expect(
      appApiSchemas.ListWorkspaceInvitationsResponseSchema.safeParse({
        items: [pendingInvitation],
        userId: 'usr_00000000-0000-7a9e-8345-2bce44a3dce0',
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
        targetUserId: 'usr_00000000-0000-78d4-ac7e-58c6c985f80a',
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

  it('accepts only the bounded Workspace deletion and recovery contracts', () => {
    const deletedWorkspaceRecovery = {
      sourceWorkspaceId: workspace.id,
      deletionRequestId: '00000000-0000-4000-8000-000000000002',
      recoveryExportId: 'wsexp_00000000-0000-7b20-a16c-5e4b4bdc5e50',
      closureId: 'closure_recovery',
      import: {
        mode: 'imported',
        requestId,
        exportId: 'wsexp_00000000-0000-7b20-a16c-5e4b4bdc5e50',
        sourceWorkspaceId: workspace.id,
        exportedWorkspaceId: workspace.id,
        importedWorkspaceId: 'ws_00000000-0000-7070-8f2f-a7b85ec0a443',
        manifest: {
          schemaVersion: 1,
          recordType: 'workspace-export',
          id: 'wsexp_00000000-0000-7b20-a16c-5e4b4bdc5e50',
          ownerScope: 'workspace',
          lineage: { workspaceId: workspace.id },
          createdAt: timestamp,
          updatedAt: timestamp,
          contentDigest: 'sha256:manifest',
          redactionLevel: 'metadata',
          sensitivity: 'internal',
          requiredFeatures: [],
          extensions: {},
          sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
          workspaceId: workspace.id,
          exportCreatedAt: timestamp,
          exportFormatVersion: 3,
          contentInventory: [],
        },
        workspace: {
          ...workspace,
          id: 'ws_00000000-0000-7070-8f2f-a7b85ec0a443',
          name: 'Recovered Workspace',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        },
        verification: { fileCount: 0, totalBytes: 0, checkedFiles: [] },
        collision: {
          status: 'collides',
          workspaceId: workspace.id,
          suggestedWorkspaceId: 'ws_00000000-0000-7070-8f2f-a7b85ec0a443',
        },
      },
    } as const;

    expect(
      appApiSchemas.DeleteWorkspaceRequestSchema.parse({
        requestId,
        expectedRegistryRevision: 4,
        confirmation: `permanently-delete-workspace:${workspace.id}:4`,
      }).expectedRegistryRevision
    ).toBe(4);
    for (const confirmation of ['yes', `permanently-delete-workspace:${workspace.id}:3`]) {
      expect(
        appApiSchemas.DeleteWorkspaceRequestSchema.safeParse({
          requestId,
          expectedRegistryRevision: 4,
          confirmation,
        }).success
      ).toBe(false);
    }
    expect(
      appApiSchemas.WorkspaceDeletionResponseSchema.parse({ deletion: workspaceDeletion }).deletion
    ).toEqual(workspaceDeletion);
    expect(
      appApiSchemas.RecoverDeletedWorkspaceRequestSchema.parse({
        requestId,
        deletionRequestId: '00000000-0000-4000-8000-000000000002',
      }).deletionRequestId
    ).toBe('00000000-0000-4000-8000-000000000002');
    expect(
      appApiSchemas.RecoverDeletedWorkspaceResponseSchema.parse({
        recovery: deletedWorkspaceRecovery,
      }).recovery.import.importedWorkspaceId
    ).toBe('ws_00000000-0000-7070-8f2f-a7b85ec0a443');
    for (const invalidDeletion of [
      { ...workspaceDeletion, path: '/private/workspace' },
      { ...workspaceDeletion, status: 'deleted' },
      { ...workspaceDeletion, phase: 'cleaned' },
    ]) {
      expect(appApiSchemas.WorkspaceDeletionStateSchema.safeParse(invalidDeletion).success).toBe(
        false
      );
    }
    for (const invalidRecovery of [
      { ...deletedWorkspaceRecovery, sourceWorkspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' },
      {
        ...deletedWorkspaceRecovery,
        recoveryExportId: 'wsexp_00000000-0000-727e-90ff-47fb691fffd7',
      },
      {
        ...deletedWorkspaceRecovery,
        import: {
          ...deletedWorkspaceRecovery.import,
          collision: { status: 'available', workspaceId: workspace.id },
        },
      },
      {
        ...deletedWorkspaceRecovery,
        import: {
          ...deletedWorkspaceRecovery.import,
          importedWorkspaceId: workspace.id,
          workspace,
        },
      },
    ]) {
      expect(
        appApiSchemas.RecoverDeletedWorkspaceResponseSchema.safeParse({
          recovery: invalidRecovery,
        }).success
      ).toBe(false);
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
          userId: 'usr_00000000-0000-7d56-82f8-ec994b63859b',
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
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'workspace_deletion_blocked',
        message: 'Workspace deletion is blocked by retention policy.',
        details: { holdRecordIds: ['bundle_legal_hold'] },
        requestId,
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'workspace_deletion_in_progress',
        message: 'Another Workspace deletion request is in progress.',
        details: workspaceDeletion,
        requestId,
      }).success
    ).toBe(true);
    expect(
      appApiSchemas.WorkspaceSharingErrorSchema.safeParse({
        protocolVersion: '0.4.0',
        code: 'workspace_deletion_in_progress',
        message: 'Another Workspace deletion request is in progress.',
        details: { ...workspaceDeletion, path: '/private/workspace' },
        requestId,
      }).success
    ).toBe(false);
  });
});

describe('derived approval exact effect', () => {
  it('accepts complete detail and strips additive non-authoritative fields', () => {
    expect(
      appApiSchemas.ApprovalEffectPreviewSchema.parse({
        status: 'available',
        summary: 'Summary: Publish',
        detail: '{"commitIds":["abc"]}',
        futureOptional: true,
      })
    ).toEqual({
      status: 'available',
      summary: 'Summary: Publish',
      detail: '{"commitIds":["abc"]}',
    });
    expect(
      appApiSchemas.ApprovalEffectPreviewSchema.parse({
        status: 'unavailable',
        reason: 'Complete detail could not be loaded.',
      })
    ).toEqual({ status: 'unavailable', reason: 'Complete detail could not be loaded.' });
  });
  it('refuses unknown availability and absent complete detail', () => {
    expect(
      appApiSchemas.ApprovalEffectPreviewSchema.safeParse({ status: 'future', detail: '{}' })
        .success
    ).toBe(false);
    expect(
      appApiSchemas.ApprovalEffectPreviewSchema.safeParse({
        status: 'available',
        summary: 'Summary',
      }).success
    ).toBe(false);
  });
});

it('preserves non-UTF8 patch bytes with canonical encoding and closed encoding admission', () => {
  const raw = Buffer.from([97, 255, 10]);
  const payload = {
    text: raw.toString('base64'),
    encoding: 'base64',
    bytes: raw.length,
    digest: 'sha256:payload',
    mediaType: 'text/x-diff',
  };
  expect(appApiSchemas.WorkspaceSyncReviewPatchPayloadSchema.safeParse(payload).success).toBe(true);
  expect(
    Buffer.from(
      appApiSchemas.workspaceSyncReviewPatchBytes({ text: payload.text, encoding: 'base64' })
    )
  ).toEqual(raw);
  expect(
    appApiSchemas.WorkspaceSyncReviewPatchPayloadSchema.parse({
      ...payload,
      futureDescription: 'harmless',
    })
  ).toEqual(payload);
  const fixtureLiteral = `sk-proj-${'x'.repeat(48)}`;
  expect(
    appApiSchemas.WorkspaceSyncReviewPatchPayloadSchema.safeParse({
      ...payload,
      text: Buffer.from(fixtureLiteral).toString('base64'),
    }).success
  ).toBe(true);
  for (const bad of [
    { ...payload, encoding: 'unknown' },
    { ...payload, text: 'Zh==' },
    { ...payload, text: '***' },
  ]) {
    expect(appApiSchemas.WorkspaceSyncReviewPatchPayloadSchema.safeParse(bad).success).toBe(false);
  }
});
