import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as appApiSchemas from './index.js';
import {
  AgentSessionReadModelSchema,
  AppDiagnosticsResponseSchema,
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  AppSearchResponseSchema,
  AuthSignInEmailResponseSchema,
  AuthSignOutResponseSchema,
  AuthSignUpEmailResponseSchema,
  AutomationRecordSchema,
  BackendWorkspaceHandleSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ClearInterruptedWorkerCheckpointRequestSchema,
  ClearInterruptedWorkerCheckpointResponseSchema,
  CodexOAuthAccountsPayloadSchema,
  CodexOAuthStatusPayloadSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  ConvertRecoveryPendingUserTurnToFollowUpResponseSchema,
  CreateInterruptedRecoveryStateResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateThreadGoalPlanResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetGitPushRecordResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GitPushRecordSchema,
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
  ListWorkerOutputManifestsResponseSchema,
  ListWorkspaceApplyPlansResponseSchema,
  ListWorkspaceApplyResultsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  MaterializeKnowledgeContextPackageResponseSchema,
  PauseThreadGoalResponseSchema,
  PromoteKnowledgeClaimRequestSchema,
  PromoteKnowledgeClaimResponseSchema,
  PromoteRecoveryPendingUserTurnToInterruptResponseSchema,
  QueueAgentSessionTerminalCommandRequestSchema,
  QueueAgentSessionTerminalCommandResponseSchema,
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
  ThreadGoalSummaryResponseSchema,
  TurnFeedbackResponseSchema,
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
const rawSecretShapes = [
  'sk-openkit-secret',
  'hf_openkit_secret',
  'ghp_openkit_secret',
  'okt_openkit_secret',
] as const;
const schemaSourceRoot = new URL('.', import.meta.url);
const allowedRuntimeNeutralImports = new Set([
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
});

function runtimeConfigStatus(): unknown {
  return {
    currentVersion: 1,
    loadedAt: timestamp,
    lastReload: null,
    lastFailedReload: null,
    pendingRestart: [],
    staleSessions: [],
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

function defaultCodexOAuthAccounts(): unknown {
  return {
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
      internalTasks: { providerId: null, model: null },
      gateway: { providerId: null, model: null },
    },
    oauth: {
      openaiCodexAccounts: defaultCodexOAuthAccounts(),
    },
    capabilities: ['core.stream.replay'],
    runtimeConfig: runtimeConfigStatus(),
    internalAgents: { agents: [], recentFailures: [], recentHookFailures: [] },
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
      conceptId: 'release-plan',
      title: 'Release plan',
      path: 'knowledge/pages/release-plan.md',
      score: 4,
      matchedTerms: ['release', 'cadence'],
      sourceReferences: ['source:ks_demo'],
    };
    const excluded = {
      conceptId: 'old-plan',
      title: 'Old plan',
      path: 'knowledge/pages/old-plan.md',
      reason: 'relevance_too_low',
      detail: 'No query terms matched this candidate.',
    };

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
    expect(
      KnowledgeRetrievalResponseSchema.parse({
        traceId: 'krt_demo',
        workspaceId: 'ws_demo',
        query: 'release cadence',
        createdAt: timestamp,
        selected: [selected],
        excluded: [excluded],
      })
    ).toEqual({
      traceId: 'krt_demo',
      workspaceId: 'ws_demo',
      query: 'release cadence',
      createdAt: timestamp,
      selected: [selected],
      excluded: [excluded],
    });
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
    ).toMatchObject({ caller: 'assistant', query: 'release cadence' });

    expect(
      KnowledgeManagerAnswerResponseSchema.parse({
        operationId: 'km_answer_demo',
        operation: 'answer',
        workspaceId: 'ws_demo',
        caller: 'assistant',
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
      citations: [{ knowledgeEntryId: 'mem_demo' }],
    });
  });

  it('accepts Knowledge Manager context material requests and responses', () => {
    expect(
      KnowledgeManagerPrepareContextRequestSchema.parse({
        artifactIds: ['artifact_release_log'],
        query: 'release cadence',
        workspaceFiles: [{ path: 'docs/release.md' }],
        workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
      })
    ).toMatchObject({
      artifactIds: ['artifact_release_log'],
      caller: 'workflow-coordinator',
      query: 'release cadence',
      workspaceFiles: [{ path: 'docs/release.md' }],
      workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
    });

    expect(
      KnowledgeManagerPrepareContextResponseSchema.parse({
        operationId: 'km_context_demo',
        operation: 'prepare-context-material',
        workspaceId: 'ws_demo',
        caller: 'workflow-coordinator',
        query: 'release cadence',
        outcome: 'prepared',
        materials: [
          {
            knowledgeEntryId: 'kn_demo',
            kind: 'project-context',
            title: 'Release plan',
            excerpt: 'Release cadence is weekly.',
            trace: {
              source: 'workspace-knowledge',
              reason: 'matched-query',
            },
          },
        ],
        exclusions: [],
        artifacts: [
          {
            id: 'artifact_release_log',
            workspaceId: 'ws_demo',
            threadId: null,
            turnId: null,
            kind: 'summary',
            title: 'Release log',
            status: 'ready',
            summary: 'Release evidence.',
            version: 1,
            content: {
              format: 'markdown',
              body: 'Release evidence is ready.',
            },
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:00:00.000Z',
          },
        ],
        workspaceFiles: [
          {
            path: 'docs/release.md',
            contentBytes: 68,
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        ],
        workspaceRootFiles: [
          {
            rootId: 'repo_docs',
            path: 'docs/runtime.md',
            contentBytes: 61,
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        ],
        claims: [
          {
            id: 'kc_release',
            workspaceId: 'ws_demo',
            statement: 'Release cadence is weekly.',
            sourceReferences: ['knowledge:kn_demo'],
            scope: 'workspace',
            producer: 'knowledge-manager',
            confidence: 0.8,
            freshness: 'current',
            reviewState: 'accepted',
            conflictStatus: 'none',
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:00:00.000Z',
          },
        ],
        conflicts: [
          {
            id: 'kf_release',
            workspaceId: 'ws_demo',
            subjectReferences: ['knowledge:kn_demo', 'claim:kc_release'],
            sourceReferences: ['source:ks_release'],
            status: 'conflicting',
            summary: 'Release cadence has conflicting evidence.',
            suggestedActions: ['Ask the user which source is authoritative.'],
            producer: 'knowledge-manager',
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:00:00.000Z',
          },
        ],
        policy: {
          version: 'knowledge-context-v1',
          claimReviewState: 'accepted',
          conflictResolution: 'exclude-resolved',
        },
        packageTrace: {
          contextPackageId: 'ctxpkg_km_context_demo',
          contextPackageDigest:
            'ctxpkg_sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          policyVersion: 'knowledge-context-v1',
          selectedKnowledgeEntryIds: ['kn_demo'],
          selectedArtifactIds: ['artifact_release_log'],
          selectedWorkspaceFilePaths: ['docs/release.md'],
          selectedWorkspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
          selectedClaimIds: ['kc_release'],
          selectedConflictIds: ['kf_release'],
          excludedCandidateCount: 0,
          budget: {
            requestedLimit: 5,
            selectedCount: 1,
            excludedCount: 0,
          },
        },
        confidence: 0.65,
        uncertainty: null,
      })
    ).toMatchObject({
      operation: 'prepare-context-material',
      outcome: 'prepared',
      materials: [{ knowledgeEntryId: 'kn_demo' }],
      artifacts: [{ id: 'artifact_release_log' }],
      workspaceFiles: [{ path: 'docs/release.md' }],
      workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
      claims: [{ id: 'kc_release' }],
      conflicts: [{ id: 'kf_release' }],
      policy: { claimReviewState: 'accepted' },
      packageTrace: {
        selectedKnowledgeEntryIds: ['kn_demo'],
        selectedArtifactIds: ['artifact_release_log'],
        selectedWorkspaceFilePaths: ['docs/release.md'],
        selectedWorkspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
        selectedClaimIds: ['kc_release'],
        selectedConflictIds: ['kf_release'],
      },
    });
  });

  it('accepts persisted Knowledge Manager context package trace responses', () => {
    expect(
      ReadKnowledgeManagerContextPackageTraceResponseSchema.parse({
        trace: {
          id: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
          operationId: 'km_context_demo',
          createdAt: '2026-07-07T00:00:00.000Z',
          response: {
            operationId: 'km_context_demo',
            operation: 'prepare-context-material',
            workspaceId: 'ws_demo',
            caller: 'workflow-coordinator',
            query: 'release cadence',
            outcome: 'prepared',
            materials: [
              {
                knowledgeEntryId: 'kn_demo',
                kind: 'project-context',
                title: 'Release plan',
                excerpt: 'Release cadence is weekly.',
                trace: {
                  source: 'workspace-knowledge',
                  reason: 'matched-query',
                },
              },
            ],
            exclusions: [],
            packageTrace: {
              contextPackageId: 'ctxpkg_km_context_demo',
              contextPackageDigest:
                'ctxpkg_sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              policyVersion: 'knowledge-context-v1',
              selectedKnowledgeEntryIds: ['kn_demo'],
              excludedCandidateCount: 0,
              budget: {
                requestedLimit: 5,
                selectedCount: 1,
                excludedCount: 0,
              },
            },
            confidence: 0.65,
            uncertainty: null,
          },
        },
      })
    ).toMatchObject({
      trace: {
        id: 'ctxpkg_km_context_demo',
        response: {
          packageTrace: {
            contextPackageId: 'ctxpkg_km_context_demo',
          },
        },
      },
    });
  });

  it('accepts materialized worker context package responses', () => {
    expect(
      MaterializeKnowledgeContextPackageResponseSchema.parse({
        manifest: {
          version: 'worker-context-package-v1',
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
          contextPackageDigest:
            'ctxpkg_sha256_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          rootPath: '/openkit/context',
          generatedAt: '2026-07-07T00:00:00.000Z',
          budget: {
            entryCount: 2,
            estimatedTokenCount: 32,
            fileCount: 3,
            materializedContentBytes: 128,
          },
          entries: [
            {
              kind: 'knowledge',
              path: '/openkit/context/knowledge/kn_demo.md',
              relativePath: 'knowledge/kn_demo.md',
              sensitivityLabel: 'normal',
              title: 'Release plan',
              sourceReferences: ['knowledge:kn_demo'],
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
            {
              kind: 'workspace',
              path: '/openkit/context/workspace/docs/release.md',
              relativePath: 'workspace/docs/release.md',
              sensitivityLabel: 'normal',
              title: 'docs/release.md',
              sourceReferences: ['workspace:docs/release.md'],
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
            {
              kind: 'workspace-root',
              path: '/openkit/context/workspace-roots/repo_docs/docs/runtime.md',
              relativePath: 'workspace-roots/repo_docs/docs/runtime.md',
              sensitivityLabel: 'normal',
              title: 'repo_docs:docs/runtime.md',
              sourceReferences: ['workspace-root:repo_docs:docs/runtime.md'],
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
            {
              citationLabel: 'Source ks_demo',
              derivedRepresentationId: 'ks_demo:text',
              kind: 'source',
              path: '/openkit/context/sources/ks_demo.txt',
              relativePath: 'sources/ks_demo.txt',
              sensitivityLabel: 'redacted',
              sourceContentDigest: 'sha256:abcdef',
              sourceId: 'ks_demo',
              sourceKind: 'document',
              sourceUri: 'file://release-source.md',
              title: 'Source ks_demo',
              sourceReferences: ['source:ks_demo'],
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
          ],
        },
        files: [
          {
            path: '/openkit/context/package.json',
            kind: 'manifest',
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          {
            path: '/openkit/context/knowledge/kn_demo.md',
            kind: 'knowledge',
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          {
            path: '/openkit/context/workspace/docs/release.md',
            kind: 'workspace',
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          {
            path: '/openkit/context/workspace-roots/repo_docs/docs/runtime.md',
            kind: 'workspace-root',
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          {
            path: '/openkit/context/sources/ks_demo.txt',
            kind: 'source',
            contentDigest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        ],
      })
    ).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          budget: expect.objectContaining({
            estimatedTokenCount: 32,
          }),
          contextPackageId: 'ctxpkg_km_context_demo',
          entries: expect.arrayContaining([
            expect.objectContaining({
              kind: 'knowledge',
              sensitivityLabel: 'normal',
            }),
            expect.objectContaining({
              kind: 'source',
              sourceId: 'ks_demo',
              sensitivityLabel: 'redacted',
            }),
            expect.objectContaining({
              kind: 'workspace',
              path: '/openkit/context/workspace/docs/release.md',
            }),
            expect.objectContaining({
              kind: 'workspace-root',
              path: '/openkit/context/workspace-roots/repo_docs/docs/runtime.md',
            }),
          ]),
          rootPath: '/openkit/context',
        }),
        files: expect.arrayContaining([
          expect.objectContaining({ path: '/openkit/context/package.json' }),
        ]),
      })
    );
  });

  it('accepts Knowledge Manager proposal draft requests and responses', () => {
    expect(
      KnowledgeManagerDraftProposalRequestSchema.parse({
        requestId: 'req_km_proposal',
        title: 'Release cadence',
        summary: 'Record that releases are reviewed every Friday.',
      })
    ).toMatchObject({
      caller: 'system',
      requestId: 'req_km_proposal',
      title: 'Release cadence',
    });

    expect(
      KnowledgeManagerDraftProposalResponseSchema.parse({
        operationId: 'km_proposal_demo',
        operation: 'draft-proposal',
        workspaceId: 'ws_demo',
        caller: 'system',
        proposal: {
          id: 'kp_demo',
          workspaceId: 'ws_demo',
          title: 'Release cadence',
          summary: 'Record that releases are reviewed every Friday.',
          status: 'pending',
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
        sourceReferences: ['knowledge:kn_demo'],
        sourceLineage: [
          {
            reference: 'knowledge:kn_demo',
            classification: 'workspace-knowledge',
            sourceId: null,
            knowledgeEntryId: 'kn_demo',
            title: 'Release plan',
            reviewRequired: false,
            detail: 'Reference resolves to an existing workspace knowledge entry.',
          },
        ],
        validation: {
          status: 'ready-for-review',
          checks: [
            {
              code: 'source-reference-resolved',
              passed: true,
              detail: 'Reference resolves to an existing workspace knowledge entry.',
            },
          ],
        },
        confidence: 0.5,
      })
    ).toMatchObject({
      operation: 'draft-proposal',
      proposal: { id: 'kp_demo', status: 'pending' },
      validation: { status: 'ready-for-review' },
    });
  });

  it('accepts Knowledge Claim promotion requests and responses', () => {
    expect(
      PromoteKnowledgeClaimRequestSchema.parse({
        requestId: 'req_claim_promote',
      })
    ).toEqual({
      caller: 'system',
      requestId: 'req_claim_promote',
    });

    expect(
      PromoteKnowledgeClaimResponseSchema.parse({
        claim: {
          id: 'kc_release',
          workspaceId: 'ws_demo',
          statement: 'Release cadence is weekly.',
          sourceReferences: ['knowledge:kn_demo'],
          scope: 'workspace',
          producer: 'knowledge-manager',
          confidence: 0.8,
          freshness: 'current',
          reviewState: 'accepted',
          conflictStatus: 'none',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
        draft: {
          operationId: 'km_claim_promotion_demo',
          operation: 'draft-proposal',
          workspaceId: 'ws_demo',
          caller: 'system',
          proposal: {
            id: 'kp_demo',
            workspaceId: 'ws_demo',
            title: 'Claim: Release cadence is weekly.',
            summary: 'Release cadence is weekly.',
            status: 'pending',
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:00:00.000Z',
          },
          sourceReferences: ['knowledge:kn_demo'],
          sourceLineage: [
            {
              reference: 'knowledge:kn_demo',
              classification: 'workspace-knowledge',
              sourceId: null,
              knowledgeEntryId: 'kn_demo',
              title: 'Release plan',
              reviewRequired: false,
              detail: 'Reference resolves to an existing workspace knowledge entry.',
            },
          ],
          validation: {
            status: 'ready-for-review',
            checks: [
              {
                code: 'source-reference-resolved',
                passed: true,
                detail: 'Reference resolves to an existing workspace knowledge entry.',
              },
            ],
          },
          confidence: 0.8,
        },
      })
    ).toMatchObject({
      claim: { id: 'kc_release' },
      draft: {
        operation: 'draft-proposal',
        proposal: { status: 'pending' },
      },
    });
  });

  it('accepts Knowledge Manager repair suggestion requests and responses', () => {
    expect(KnowledgeManagerSuggestRepairRequestSchema.parse({})).toMatchObject({
      caller: 'system',
      limit: 10,
    });

    expect(
      KnowledgeManagerSuggestRepairResponseSchema.parse({
        operationId: 'km_repair_demo',
        operation: 'suggest-repair',
        workspaceId: 'ws_demo',
        caller: 'system',
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
    expect(KnowledgeManagerHealthCheckRequestSchema.parse({})).toMatchObject({
      caller: 'system',
      limit: 10,
    });

    expect(
      KnowledgeManagerHealthCheckResponseSchema.parse({
        operationId: 'km_health_demo',
        operation: 'health-check',
        workspaceId: 'ws_demo',
        caller: 'system',
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

  it('accepts storage layout reports with legacy and quarantine findings', () => {
    expect(
      StorageLayoutReportResponseSchema.parse({
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
            workspaces: [
              {
                workspaceId: 'ws_1',
                workspaceDb: {
                  path: 'users/user_1/workspaces/ws_1/db/workspace.sqlite',
                  exists: true,
                  appliedMigrations: ['workspace_0000_baseline'],
                },
                indexesDir: {
                  path: 'users/user_1/workspaces/ws_1/indexes',
                  exists: true,
                  entryCount: 1,
                },
              },
            ],
          },
        ],
        quarantineEntries: [
          {
            scope: 'workspace',
            userId: 'user_1',
            workspaceId: 'ws_1',
            path: 'users/user_1/workspaces/ws_1/quarantine/1-workspace.sqlite',
            bytes: 128,
          },
        ],
      }).quarantineEntries[0]?.scope
    ).toBe('workspace');
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
      VaultAdminStatusResponseSchema.parse({
        backendKind: 'os-keychain',
        state: 'available',
        diagnostic: 'Vault backend is available.',
      }).backendKind
    ).toBe('os-keychain');
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

  it('preserves internal-agent failure and hook diagnostics', () => {
    const internalAgents = {
      agents: [],
      recentFailures: [
        {
          agentId: 'quick-chat',
          code: 'internal_agent_budget_exhausted',
          details: { source: 'loop' },
          message: 'Internal agent budget was exhausted.',
          occurredAt: timestamp,
          status: 'aborted' as const,
          stopReason: 'budget_exhausted' as const,
        },
      ],
      recentHookFailures: [
        {
          eventType: 'message_update' as const,
          hookId: 'diagnostics-observer',
          message: 'Diagnostics observer failed.',
          mode: 'observational' as const,
        },
      ],
    };

    expect(
      AppDiagnosticsResponseSchema.parse({
        ...appDiagnosticsPayload(),
        internalAgents,
      }).internalAgents
    ).toEqual(internalAgents);
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

  it('accepts product-safe OpenShell backend summaries on agent sessions', () => {
    expect(
      AgentSessionReadModelSchema.parse({
        id: 'as_openshell_1',
        status: 'busy',
        message: null,
        configVersion: 1,
        workspaceRoots: [],
        stale: false,
        sandboxSummary: {
          access: 'read-write',
          workspaceRootRefs: ['repo'],
          summary: '1 workspace root materialized.',
        },
        backend: {
          kind: 'openshell',
          health: 'ready',
          controlMode: 'direct-nanocore',
          control: {
            heartbeat: {
              status: 'running',
              sequence: 4,
              lastHeartbeatAt: '2026-06-16T00:00:03.000Z',
            },
            artifactNoticeCount: 1,
            queuedCommandCount: 2,
            deliveredCommandCount: 1,
            terminalResultCount: 1,
            lastTerminalExitCode: 0,
            lastTerminalCompletedAt: '2026-06-16T00:00:04.000Z',
          },
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.63',
          sandboxName: 'openkit-as-openshell-1',
        },
      }).backend
    ).toEqual({
      kind: 'openshell',
      health: 'ready',
      controlMode: 'direct-nanocore',
      control: {
        heartbeat: {
          status: 'running',
          sequence: 4,
          lastHeartbeatAt: '2026-06-16T00:00:03.000Z',
        },
        artifactNoticeCount: 1,
        queuedCommandCount: 2,
        deliveredCommandCount: 1,
        terminalResultCount: 1,
        lastTerminalExitCode: 0,
        lastTerminalCompletedAt: '2026-06-16T00:00:04.000Z',
      },
      gatewayName: 'openshell',
      gatewayEndpoint: 'https://127.0.0.1:17670',
      version: '0.0.63',
      sandboxName: 'openkit-as-openshell-1',
    });
  });

  it.each([
    'transcript-sink',
    'backend-relay',
    'sidecar',
    'stdio',
    'disabled',
  ])('rejects retired agent-session control mode %s', (controlMode) => {
    expect(
      AgentSessionReadModelSchema.safeParse({
        id: 'as_openshell_legacy',
        status: 'ready',
        message: null,
        configVersion: 1,
        workspaceRoots: [],
        stale: false,
        sandboxSummary: null,
        backend: {
          kind: 'openshell',
          health: 'ready',
          controlMode,
          control: null,
          gatewayName: 'openshell',
          gatewayEndpoint: 'https://127.0.0.1:17670',
          version: '0.0.80',
          sandboxName: 'openkit-as-openshell-legacy',
        },
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

  it('accepts agent session terminal command queue payloads', () => {
    expect(
      QueueAgentSessionTerminalCommandRequestSchema.parse({
        requestId: 'terminal-request-1',
        argv: ['pwd'],
        cwd: '/workspace',
      })
    ).toEqual({
      requestId: 'terminal-request-1',
      argv: ['pwd'],
      cwd: '/workspace',
    });
    expect(
      QueueAgentSessionTerminalCommandResponseSchema.parse({
        command: {
          commandId: 'terminal-request-1',
          kind: 'terminal-command',
          sequence: 1,
          queuedAt: '2026-06-16T00:00:03.000Z',
          deliveredAt: null,
          argv: ['pwd'],
          cwd: '/workspace',
        },
      }).command
    ).toMatchObject({
      commandId: 'terminal-request-1',
      kind: 'terminal-command',
      deliveredAt: null,
    });
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
          ...(payload.oauth as Record<string, unknown>),
          openaiCodex: { providerId: 'openai_codex', status: 'logged_out' },
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
          internalAgents: {
            agents: [],
            recentFailures: [
              {
                agentId: 'quick-chat',
                code: 'internal_agent_failed',
                details: {},
                message: `Upstream failed with ${rawSecret}`,
                occurredAt: timestamp,
                status: 'error',
                stopReason: 'error',
              },
            ],
            recentHookFailures: [],
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

  it('accepts setup diagnostics and runtime config reload responses', () => {
    expect(
      RuntimeConfigStatusSchema.parse({
        ...runtimeConfigStatus(),
        staleSessions: [
          {
            sessionId: 'as_stale',
            threadId: 'th_demo',
            agentId: 'agent_codex_host',
            capturedVersion: 1,
            currentVersion: 2,
            reasons: ['runtime-config'],
            choices: [
              {
                kind: 'inspect',
                label: 'Inspect stale session details',
                recommended: true,
              },
              {
                kind: 'restart_session',
                label: 'Restart the stale session before continuing',
              },
              {
                kind: 'request_human',
                label: 'Ask the user how to handle the stale session',
              },
            ],
          },
        ],
      }).staleSessions[0]?.choices.map((choice) => choice.kind)
    ).toEqual(['inspect', 'restart_session', 'request_human']);
    expect(
      RestartRuntimeConfigStaleSessionResponseSchema.parse({
        restarted: true,
        session: {
          id: 'as_stale',
          status: 'interrupted',
          message: 'Runtime config stale session retired; start a new worker session.',
          configVersion: 2,
          workspaceRoots: [],
          stale: false,
          sandboxSummary: null,
        },
      }).session?.stale
    ).toBe(false);

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

  it('accepts Task Mode delegation decisions and worker attempt state', () => {
    expect(
      StartTaskModeRequestSchema.parse({
        input: 'Implement the focused fix.',
        requestId: 'req_task_1',
      }).input
    ).toBe('Implement the focused fix.');
    const taskResponse = StartTaskModeResponseSchema.parse({
      decision: {
        mode: 'task',
        sourceAgentId: 'worker-coordinator',
        worker: {
          agentId: 'agent_codex_host',
          displayName: 'Codex Host Agent',
          runtime: 'codex',
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

    expect(taskResponse.decision?.contextRefs).toEqual([
      { kind: 'workspace', id: 'ws_demo' },
      { kind: 'thread', id: 'th_demo' },
      { kind: 'knowledge', id: 'mem_project' },
    ]);
    expect(taskResponse.completion).toEqual({
      itemId: 'it_assistant_tu_task_1',
      text: 'Completed by worker.',
    });
    expect(taskResponse.evidence).toEqual({
      itemIds: ['it_assistant_tu_task_1'],
      artifactIds: ['ar_task_result'],
      reviewIds: ['swr_task_result'],
    });
    expect(
      StartTaskModeResponseSchema.parse({
        decision: null,
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
        internalAgents: {
          agents: [],
          recentFailures: [
            {
              agentId: 'quick-chat',
              code: 'internal_agent_failed',
              details: {},
              message: 'Upstream failed with [redacted].',
              occurredAt: timestamp,
              status: 'error',
              stopReason: 'error',
            },
          ],
          recentHookFailures: [],
        },
      }).providers.diagnostics[0]?.message
    ).toBe('redacted secret-ref env:OPENAI_API_KEY');
  });

  it('requires Codex OAuth account lists to include a default account row', () => {
    expect(
      CodexOAuthAccountsPayloadSchema.parse(defaultCodexOAuthAccounts()).accounts[0]?.isDefault
    ).toBe(true);
    expect(
      CodexOAuthAccountsPayloadSchema.safeParse({
        accounts: [],
        defaultAccountSlotId: 'default',
      }).success
    ).toBe(false);
    expect(
      CodexOAuthAccountsPayloadSchema.safeParse({
        accounts: [
          {
            accountSlotId: 'default',
            boundProviderIds: [],
            isDefault: false,
            providerId: 'openai_codex',
            status: 'logged_out',
          },
        ],
        defaultAccountSlotId: 'default',
      }).success
    ).toBe(false);
  });

  it('accepts dashboard, auth, oauth, quick chat, agent catalog, and action center payloads', () => {
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
      CodexOAuthStatusPayloadSchema.parse({
        accountSlotId: 'default',
        boundProviderIds: [],
        isDefault: true,
        providerId: 'openai_codex',
        status: 'logged_out',
      }).providerId
    ).toBe('openai_codex');
    expect(CodexOAuthStatusPayloadSchema.safeParse({ status: 'logged_out' }).success).toBe(false);
    expect(
      CodexOAuthStatusPayloadSchema.safeParse({
        status: 'logged_out',
        authorizationUrl: 'https://example.test/unsupported',
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
            needsRevision: 0,
            completed: 2,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 1,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 2,
          },
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
      }).goal?.status
    ).toBe('paused');
    expect(
      PauseThreadGoalResponseSchema.parse({
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
      }).goal.status
    ).toBe('paused');
    expect(
      ResumeThreadGoalResponseSchema.parse({
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
      }).goal.status
    ).toBe('running');
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
            taskId: 'task_revision',
            title: 'Refine work',
            status: 'needs_revision',
            orderIndex: 2,
          },
          taskCounts: {
            pending: 0,
            ready: 0,
            running: 0,
            reviewing: 0,
            needsRevision: 1,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
      }).goal?.currentTask?.status
    ).toBe('needs_revision');
    expect(ThreadGoalSummaryResponseSchema.parse({ goal: null }).goal).toBeNull();
    expect(
      StartThreadGoalRequestSchema.parse({
        objective: 'Make v0.0.6 ready to publish.',
        title: 'Ship v0.0.6',
      }).title
    ).toBe('Ship v0.0.6');
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 1,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
      }).state
    ).toBe('queued');
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Goal plan needs approval.',
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
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
        },
        plan,
      }).planner.sourceAgentId
    ).toBe('worker-coordinator');
    expect(
      ApproveThreadGoalPlanRequestSchema.parse({
        planItemId: 'it_goal_plan_goal_demo',
        plan,
      }).planItemId
    ).toBe('it_goal_plan_goal_demo');
    expect(
      ReviseThreadGoalPlanRequestSchema.parse({
        requestId: 'req_goal_plan_revise',
        revision: 'Split the release plan into documentation and verification tasks.',
      }).revision
    ).toBe('Split the release plan into documentation and verification tasks.');
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
          },
          updatedAt: timestamp,
        },
        readyTasks: [{ taskId: 'task_1', status: 'ready' }],
        startsWorkerTurn: false,
      }).readyTasks
    ).toEqual([{ taskId: 'task_1', status: 'ready' }]);
    expect(
      RunThreadGoalStepRequestSchema.parse({
        requestId: 'req_goal_step_1',
        followUpDrainMode: 'all',
        reviewPolicyOverride: 'human',
      }).followUpDrainMode
    ).toBe('all');
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
            needsRevision: 0,
            completed: 0,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: true,
            reason: 'Worker result needs review.',
          },
          terminalState: null,
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 1,
          },
          updatedAt: timestamp,
        },
        worker: {
          turnId: 'turn_worker',
          stopReason: 'completed',
          checkpointStage: 'completed',
          workerSessionId: null,
          evidence: {
            itemIds: ['it_worker_terminal'],
            artifactIds: ['artifact_release_log'],
          },
        },
        contextAssembly: {
          contextDigest: 'ctxpkg_sha256_demo',
          contextRefs: [
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: 'th_demo' },
            { kind: 'item', id: 'it_context' },
          ],
          repositoryResourceId: 'repo_default',
          steeringMessageCount: 1,
          followUpInputCount: 0,
        },
        coordinator: {
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          worker: {
            agentId: 'codex',
            displayName: 'Codex',
            runtime: 'codex',
          },
          confidence: 0.86,
          rationale: 'The Goal Mode step needs bounded worker execution and Codex is ready.',
          requiredApprovals: [],
          expectedStopCondition: 'one bounded worker turn',
          escalationRecommended: false,
          contextRefs: [
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: 'th_demo' },
          ],
        },
        decision: {
          schemaVersion: 1,
          mode: 'goal',
          sourceAgentId: 'worker-coordinator',
          requestId: 'req_goal_step_1',
          outcome: 'review',
          shouldStop: true,
          stopReason: 'completed',
          rationale: 'Worker turn completed and needs human review before Goal Mode continues.',
          contextRefs: [
            { kind: 'workspace', id: 'ws_demo' },
            { kind: 'thread', id: 'th_demo' },
          ],
          evidence: {
            itemIds: ['it_worker_terminal'],
            artifactIds: ['artifact_release_log'],
          },
        },
        pendingAttention: {
          kind: 'review',
          reason: 'Worker result needs review.',
          itemId: 'it_worker_terminal',
        },
      }).contextAssembly.contextDigest
    ).toBe('ctxpkg_sha256_demo');
    expect(RunThreadGoalSuperviseStepRequestSchema.parse({}).verdict).toBe('accept');
    expect(RunThreadGoalTestSuperviseStepRequestSchema.parse({}).verdict).toBe('accept');
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
            needsRevision: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
            skipped: 0,
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
            skippedTaskIds: [],
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
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
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
          nextTaskId: null,
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
            needsRevision: 0,
            completed: 1,
            blocked: 0,
            failed: 0,
            skipped: 0,
          },
          pendingHumanAttention: {
            required: false,
            reason: null,
          },
          terminalState: {
            status: 'completed',
            stopReason: 'completed',
          },
          steering: {
            pendingSteeringCount: 0,
            pendingFollowUpCount: 0,
            appliedSteeringCount: 0,
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
          nextTaskId: null,
        },
      }).advance.outcome
    ).toBe('complete_goal');
    const pendingUserTurn = {
      pendingTurnId: 'pending_ws_demo_th_demo_req_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: 'req_demo',
      contentItemId: 'it_pending',
      contentDigest: null,
      queueMode: 'safe_point_steering',
      receivedAt: timestamp,
      createdAt: timestamp,
    };
    expect(
      CreateInterruptedRecoveryStateResponseSchema.parse({
        checkpoint: {
          checkpointId: 'ws_demo:th_demo:turn_demo',
          turnId: 'turn_demo',
          stage: 'running_worker',
        },
        pendingUserTurn,
      }).checkpoint.stage
    ).toBe('running_worker');
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
              repositoryResourceId: 'repo_default',
              steeringMessageCount: 0,
              followUpInputCount: 0,
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
                kind: 'record_terminal',
                label: 'Record terminal worker state',
                allowedTerminalStages: ['completed', 'failed', 'aborted'],
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
      }).items[0]?.contextAssembly?.repositoryResourceId
    ).toBe('repo_default');
    expect(WorkerRecoveryStageSchema.parse('reviewing')).toBe('reviewing');
    expect(WorkerRecoveryStageSchema.parse('failed')).toBe('failed');
    expect(
      ListRecoveryPendingUserTurnsResponseSchema.parse({ items: [pendingUserTurn] }).items
    ).toHaveLength(1);
    expect(
      ConvertRecoveryPendingUserTurnToFollowUpResponseSchema.parse({
        converted: true,
        pendingUserTurn: { ...pendingUserTurn, queueMode: 'follow_up' },
      }).pendingUserTurn?.queueMode
    ).toBe('follow_up');
    expect(
      PromoteRecoveryPendingUserTurnToInterruptResponseSchema.parse({
        promoted: false,
        turn: null,
      }).promoted
    ).toBe(false);
    expect(
      ClearInterruptedWorkerCheckpointRequestSchema.parse({ terminalStage: 'completed' })
        .terminalStage
    ).toBe('completed');
    expect(ClearInterruptedWorkerCheckpointResponseSchema.parse({ cleared: true }).cleared).toBe(
      true
    );
    expect(
      RetryInterruptedWorkerCheckpointResponseSchema.parse({
        retried: true,
        turn: null,
      }).retried
    ).toBe(true);
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
            protocolVersion: '0.3.0',
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
            protocolVersion: '0.3.0',
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
        id: 'pending-input:pending_demo',
        kind: 'pending_input',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        title: 'Input queued for a safe point',
        summary: 'The user message is queued until the worker reaches a safe point.',
        severity: 'info',
        createdAt: timestamp,
        source: {
          type: 'pending_user_turn',
          pendingTurnId: 'pending_demo',
          requestId: 'req_demo',
          queueMode: 'safe_point_steering',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
        },
        actions: [
          { kind: 'open_thread', label: 'Open thread', method: 'GET', href: '/threads/th_demo' },
        ],
      },
      {
        id: 'checkpoint:checkpoint_demo',
        kind: 'checkpoint_recovery',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        agentSessionId: 'agent_session_demo',
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
          verdict: 'refine',
        },
        actions: [{ kind: 'request_refinement', label: 'Request refinement', method: 'POST' }],
      },
      {
        id: 'agent-readiness:agent_demo',
        kind: 'agent_readiness',
        workspaceId: 'ws_demo',
        agentSessionId: 'agent_demo',
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
        id: 'artifact:artifact_demo',
        kind: 'artifact_review',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        artifactId: 'artifact_demo',
        title: 'Review artifact',
        summary: 'The artifact is ready for acceptance.',
        severity: 'needs_input',
        createdAt: timestamp,
        source: {
          type: 'artifact',
          artifactId: 'artifact_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          reviewStatus: 'pending',
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
        actions: [{ kind: 'open_artifact', label: 'Open review', method: 'GET' }],
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
        agentSessionId: 'as_demo',
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
          agentSessionId: 'as_demo',
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
        agentSessionId: 'as_demo',
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
          agentSessionId: 'as_demo',
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

  it('accepts artifact review decision requests and responses', () => {
    expect(
      SubmitArtifactReviewDecisionRequestSchema.parse({
        decision: 'needs_refinement',
        requestId: 'review-request-1',
        message: 'Tighten the implementation notes.',
      }).decision
    ).toBe('needs_refinement');
    expect(
      SubmitArtifactReviewDecisionResponseSchema.parse({
        review: {
          artifactId: 'artifact_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          status: 'redo',
          message: 'Start over with the corrected scope.',
          decidedAt: timestamp,
          followUpTurnId: 'turn_follow_up',
        },
        workspaceApplyResult: null,
      }).review.followUpTurnId
    ).toBe('turn_follow_up');
    expect(
      SubmitArtifactReviewDecisionResponseSchema.parse({
        review: {
          artifactId: 'artifact_demo',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          status: 'accepted',
          message: null,
          decidedAt: timestamp,
          followUpTurnId: null,
        },
        workspaceApplyResult: {
          id: 'war_swr_1',
          workspaceId: 'ws_demo',
          reviewId: 'swr_1',
          changeSetId: 'wcs_1',
          status: 'applied',
          appliedPaths: ['docs/spec.md'],
          skippedPaths: [],
          conflictRecords: [],
          verification: [{ command: 'git apply --check', status: 'passed', ref: null }],
          commitIds: [],
          appliedAt: timestamp,
        },
      }).workspaceApplyResult?.status
    ).toBe('applied');
    expect(
      SubmitArtifactReviewDecisionRequestSchema.safeParse({
        decision: 'maybe',
      }).success
    ).toBe(false);
  });

  it('accepts knowledge proposal decision requests and responses', () => {
    expect(
      SubmitKnowledgeProposalDecisionRequestSchema.parse({
        decision: 'edited',
        requestId: 'knowledge-review-1',
        message: 'Looks reusable.',
        title: 'Edited knowledge title',
        summary: 'Edited knowledge summary.',
      }).decision
    ).toBe('edited');
    expect(
      SubmitKnowledgeProposalDecisionResponseSchema.parse({
        review: {
          proposalId: 'kp_demo',
          workspaceId: 'ws_demo',
          status: 'accepted',
          message: 'Looks reusable.',
          decidedAt: timestamp,
          requestId: 'knowledge-review-1',
        },
      }).review.status
    ).toBe('accepted');
    expect(
      SubmitKnowledgeProposalDecisionRequestSchema.safeParse({
        decision: 'redo',
      }).success
    ).toBe(false);
  });

  it('limits goal step review overrides to implemented policies', () => {
    expect(
      RunThreadGoalStepRequestSchema.safeParse({ requestId: 'goal-step-default' }).success
    ).toBe(true);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-human',
        reviewPolicyOverride: 'human',
      }).success
    ).toBe(true);
    expect(
      RunThreadGoalStepRequestSchema.safeParse({
        requestId: 'goal-step-none',
        reviewPolicyOverride: 'none',
      }).success
    ).toBe(true);
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
    expect(
      SubmitGoalReviewDecisionRequestSchema.parse({
        requestId: 'goal-review-decision-1',
      }).requestId
    ).toBe('goal-review-decision-1');
    expect(
      SubmitGoalReviewDecisionResponseSchema.parse({
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
          verdict: 'retry',
          reason: 'Retry with stronger verification.',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: timestamp,
          resolutionRequestId: 'goal-review-decision-1',
        },
        advance: {
          outcome: 'retry',
          task: { taskId: 'task_demo', status: 'ready' },
          goal: null,
          nextTask: null,
        },
      }).review.resolutionRequestId
    ).toBe('goal-review-decision-1');
    expect(
      SubmitGoalReviewDecisionRequestSchema.safeParse({
        requestId: '',
      }).success
    ).toBe(false);
  });
});
