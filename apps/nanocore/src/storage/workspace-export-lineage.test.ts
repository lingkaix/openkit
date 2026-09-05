import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
} from '@openkit/config-schema';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

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
} from '../context/worker-context-package.js';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { computeGoalPlanDigest, GoalPlanOutputSchema } from '../runtime/goal-plan.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import {
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import {
  artifactReferenceItemId,
  parseOwnedKnowledgeEntry,
  serializeUserAuthoredKnowledgePage,
} from './workspace-file-records.js';
import {
  readWorkspaceImportSnapshot,
  verifyImportedWorkerContextPackageSnapshot,
} from './workspace-import.js';
import { writeWorkspacePortableFileState } from './workspace-portable-file-state.js';

const timestamp = '2026-07-12T00:00:00.000Z';
const source = {
  approvalId: 'apr_source',
  approvalItemId: 'it_approval_source',
  artifactId: 'ar_source',
  goalId: 'goal_source',
  grantId: 'grant_source',
  itemId: 'it_source',
  planItemId: 'it_goal_plan_source',
  sessionId: 'as_source',
  taskId: 'task_source',
  threadId: 'th_source',
  turnId: 'tu_source',
  workspaceId: 'ws_source',
} as const;
const targetWorkspaceId = 'ws_imported';

/** Builds one export containing every auxiliary record family that refers to canonical history. */
function createLineageExportInput(
  missing?:
    | 'aep-item'
    | 'aep-session'
    | 'capability-thread'
    | 'checkpoint-turn'
    | 'evidence-goal'
    | 'git-approval'
    | 'goal-item'
    | 'permission-approval'
    | 'repository-grant'
    | 'resolved-turn'
    | 'runtime-turn'
    | 'sync-artifact'
    | 'usage-session'
    | 'vault-approval'
    | 'vault-session'
): WriteWorkspaceExportTreeInput {
  const agentSetup = createTestAgentSetup();
  const item = {
    id: source.itemId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'assistant-message',
    status: 'completed',
    text: 'Portable lineage.',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const approvalItem = {
    id: source.approvalItemId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'approval-request',
    status: 'completed',
    causationId: source.itemId,
    approvalRequestId: source.approvalId,
    title: 'Approve portable lineage',
    description: 'Approve the portable operation.',
    kind: 'permission',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const artifact = {
    id: source.artifactId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    kind: 'summary',
    title: 'Portable artifact',
    status: 'ready',
    summary: 'Portable artifact.',
    version: 1,
    content: { format: 'markdown', body: '# Portable' },
    contentDigest: `sha256:${createHash('sha256').update('# Portable', 'utf8').digest('hex')}`,
    lastMutationRequestId: 'request_source',
    origin: {
      kind: 'turn-output',
      threadId: source.threadId,
      turnId: source.turnId,
      requestId: 'request_source',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const artifactReferenceItem = {
    id: artifactReferenceItemId(source.artifactId, source.turnId),
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'artifact-reference',
    status: 'completed',
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    lastMutationRequestId: artifact.lastMutationRequestId,
    title: artifact.title,
    summary: artifact.summary,
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const planItem = {
    id: source.planItemId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'plan',
    status: 'completed',
    title: 'Portable goal plan',
    summary: 'Keep lineage portable.',
    steps: [{ id: source.taskId, title: 'Portable task', status: 'pending' }],
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const turn = {
    id: source.turnId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    triggerActor: { kind: 'user', id: 'user_local' } as const,
    items: [item, planItem, artifactReferenceItem, approvalItem],
    status: 'completed',
    humanGate: null,
    error: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 1,
  };
  const environmentPackage = resolveAgentEnvironmentPackage({
    agent: {
      id: 'agent_codex_host',
      name: 'Codex Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [
        {
          id: 'default',
          displayName: 'Default',
          instructionsRef: null,
          modelId: null,
          skillIds: [],
          capabilityIds: [],
        },
      ],
      defaultProfileId: 'default',
      capabilities: [],
      sandboxSummary: null,
      config: {
        adapterType: 'codex',
        command: null,
        baseUrl: null,
        workspaceRoot: '/workspace',
        environment: {},
        capabilities: [],
      },
    },
    agentSetup,
    agentSessionId: source.sessionId,
    triggerActor: { kind: 'user', id: 'user_local' },
    userId: 'user_local',
    backend: {
      kind: 'openshell',
    },
    requestId: 'request_source',
    turn,
    turnInput: 'Verify portability.',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  environmentPackage.scope.itemId = missing === 'aep-item' ? 'it_missing' : source.itemId;
  const session = {
    id: source.sessionId,
    agentId: 'agent_codex_host',
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    status: 'idle',
    message: null,
    sandboxSummary: {
      access: 'read-write',
      workspaceRootRefs: ['repo'],
      summary: 'Source host workspace.',
    },
    configVersion: 7,
    environmentPackageSnapshotId: environmentPackage.snapshotId,
    policySnapshotId: 'policy_source',
    sessionCompatibilityKey: 'sha256:source-session-compatibility',
    stale: false,
    workspaceRoots: [
      {
        id: 'repo',
        sourceKind: 'host-dir',
        sourcePath: '/private/source/workspace',
        workerPath: '/workspace/repo',
        access: 'read-write',
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const goalPlan = GoalPlanOutputSchema.parse({
    schemaVersion: 1,
    goalSummary: 'Keep lineage portable.',
    assumptions: [],
    tasks: [
      {
        taskId: source.taskId,
        title: 'Portable task',
        objective: 'Verify lineage.',
        acceptanceCriteria: ['Lineage is portable.'],
        contextBudgetTokens: 1_000,
        resources: [
          {
            kind: 'item',
            reference: source.itemId,
            reason: 'The source Item carries the task context.',
          },
          {
            kind: 'artifact',
            reference: source.artifactId,
            reason: 'The source Artifact carries the task evidence.',
          },
        ],
        expectedArtifacts: [{ kind: 'artifact', description: 'Portable task evidence.' }],
        verificationChecks: [{ kind: 'manual', description: 'Review portable lineage.' }],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review the portable Task evidence.',
        },
        dependsOnTaskIds: [],
        escalationConditions: ['Escalate if portable lineage is incomplete.'],
      },
    ],
    risks: [],
    questions: [],
    verificationApproach: 'Review every reminted reference.',
  });
  return {
    exportRoot: join(mkdtempSync(join(tmpdir(), 'openkit-workspace-lineage-')), 'export'),
    exportId: 'wsexp_lineage',
    sourceDeploymentId: 'dep_source',
    createdAt: timestamp,
    workspace: {
      id: source.workspaceId,
      name: 'Lineage workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 1, artifactCount: 1, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    portableFileState: {
      claims: new Map(),
      conflicts: new Map(),
      nativeKnowledgePages: new Map(),
      observations: new Map(),
      retrievalTraces: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Lineage workspace', defaultAgentId: null },
      }),
      workspaceSchema: null,
    },
    threads: [
      {
        id: source.threadId,
        workspaceId: source.workspaceId,
        name: 'Lineage thread',
        preview: 'Lineage thread',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    turns: [turn],
    knowledge: [],
    dataSourceCatalog: {
      schemaVersion: 1,
      requiredFeatures: [],
      extensions: {},
      sources: [
        {
          id: 'portable-repository',
          kind: 'git',
          displayName: 'Portable repository source',
          locator: { url: 'https://example.com/openkit.git' },
          access: 'read-only',
          sensitivity: 'internal',
          vaultGrantRef: source.grantId,
          allowedSlotKinds: ['worktree'],
          syncHints: {},
          status: 'active',
          requiredFeatures: [],
          extensions: {},
        },
      ],
    },
    itemRevisions: [item, planItem, artifactReferenceItem, approvalItem],
    artifacts: [artifact],
    artifactReviews: [],
    threadMaterialBindings: [],
    workspaceMaterialRevisions: [],
    workspaceMaterials: [],
    agentSessions: [session],
    turnEvents: [],
    resolvedAgentSetups: [
      {
        id: 'ras_source',
        workspaceId: source.workspaceId,
        turnId: missing === 'resolved-turn' ? 'tu_missing' : source.turnId,
        requestId: 'request_source',
        agentId: 'agent_codex_host',
        logicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
        runtimeKind: 'codex',
        runtimeAdapter: 'codex-app-server',
        requiredFeatures: [],
        setup: {
          manifest: {
            id: agentSetup.manifest.id,
            requiredFeatures: agentSetup.manifest.requiredFeatures,
            runtime: agentSetup.manifest.runtime,
            sandbox: {
              credentialDeclarations: agentSetup.manifest.sandbox.credentialDeclarations,
              network: agentSetup.manifest.sandbox.network,
            },
          },
          logicalModels: {
            preferredLogicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
            allowed: agentSetup.logicalModels.allowed.map((model) => ({
              id: model.id,
              capabilities: model.capabilities,
              modelFamilyId: model.modelFamilyId,
            })),
          },
        },
        createdAt: timestamp,
      },
    ],
    agentEnvironmentPackageSnapshots: [
      {
        snapshotId: environmentPackage.snapshotId,
        workspaceId: source.workspaceId,
        turnId: source.turnId,
        threadId: source.threadId,
        agentSessionId: missing === 'aep-session' ? 'as_missing' : source.sessionId,
        agentId: environmentPackage.agent.agentId,
        packageId: environmentPackage.packageId,
        runtimeKind: environmentPackage.agent.runtimeKind,
        backendKind: environmentPackage.backend.preferred,
        contentDigest: createHash('sha256')
          .update(JSON.stringify(environmentPackage))
          .digest('hex'),
        snapshot: environmentPackage,
        createdAt: timestamp,
      },
    ],
    capabilityCalls: [
      {
        id: 'cap_source',
        workspaceId: source.workspaceId,
        threadId: missing === 'capability-thread' ? 'th_missing' : source.threadId,
        turnId: source.turnId,
        itemId: source.itemId,
        agentId: 'agent_codex_host',
        agentSessionId: source.sessionId,
        requestId: null,
        sourceIds: [],
        capabilityId: 'runtime.worker_turn',
        status: 'succeeded',
        summary: 'Portable capability call.',
        errorCode: null,
        startedAt: timestamp,
        completedAt: timestamp,
        family: 'runtime',
        operation: 'worker.checkpoint.terminal',
        providerRef: null,
        serviceRef: null,
        redactionClass: 'metadata-only',
      },
    ],
    usageRecords: [
      {
        id: 'use_source',
        workspaceId: source.workspaceId,
        responsibleUserId: 'user_source',
        threadId: source.threadId,
        turnId: source.turnId,
        itemId: source.itemId,
        capabilityCallId: 'cap_source',
        requestId: null,
        agentId: 'agent_codex_host',
        agentSessionId: missing === 'usage-session' ? 'as_missing' : source.sessionId,
        sourceIds: [],
        category: 'runtime',
        unit: 'sandbox_sessions',
        quantity: 1,
        modelId: null,
        providerRef: null,
        source: 'worker-checkpoint-terminal',
        recordedAt: timestamp,
      },
    ],
    evidenceBundles: [
      {
        id: 'evb_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: missing === 'evidence-goal' ? 'goal_missing' : source.goalId,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker',
        summary: 'Portable evidence bundle.',
        rawEvidenceRefs: [
          { kind: 'thread', ref: source.threadId },
          { kind: 'turn', ref: source.turnId },
          {
            kind: 'goal',
            ref: missing === 'evidence-goal' ? 'goal_missing' : source.goalId,
          },
          { kind: 'artifact', ref: source.artifactId },
        ],
        redactedEvidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        contentDigests: ['sha256:evidence'],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'verified',
        requiredFeatures: ['evidence.bundle.v1'],
        createdAt: timestamp,
      },
    ],
    runtimeEvidence: [
      {
        id: 'rte_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: missing === 'runtime-turn' ? 'tu_missing' : source.turnId,
        goalId: source.goalId,
        taskId: null,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        backendVersion: null,
        placement: 'local',
        phase: 'teardown',
        summary: 'Portable runtime evidence.',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: null,
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: null,
        outcome: 'succeeded',
        exitCode: 0,
        signal: null,
        stopReason: 'completed',
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [],
        contentDigests: ['sha256:runtime'],
        requiredFeatures: ['runtime.evidence.v1'],
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        collectedAt: timestamp,
      },
    ],
    workerCheckpoints: [
      {
        checkpointId: `${source.workspaceId}:${source.threadId}:${source.turnId}`,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: missing === 'checkpoint-turn' ? 'tu_missing' : source.turnId,
        goalId: source.goalId,
        taskId: source.taskId,
        requestId: 'request_source',
        requestInputHash: 'sha256:request-source',
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: missing ? null : 'worker_source',
        contextDigest: 'sha256:context',
        stopReason: null,
        diagnosticsSummary: null,
        replayInstruction: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    goalRecords: [
      {
        goalId: source.goalId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        status: 'running',
        title: 'Portable goal',
        objective: 'Keep lineage portable.',
        createdByItemId: missing === 'goal-item' ? 'it_missing' : source.itemId,
        planItemId: source.planItemId,
        currentTaskId: source.taskId,
        terminalStopReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    goalPlanRecords: [
      {
        ...goalPlan,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: source.goalId,
        planItemId: source.planItemId,
        planDigest: computeGoalPlanDigest(goalPlan),
        createdByRequestId: 'goal-plan-source-1',
        createdAt: timestamp,
      },
    ],
    goalTasks: [
      {
        ...goalPlan.tasks[0],
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: source.goalId,
        planItemId: source.planItemId,
        status: 'reviewing',
        latestGateContextItemId: null,
        orderIndex: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    goalReviewRecords: [
      {
        reviewId: 'review_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: source.goalId,
        taskId: source.taskId,
        turnId: source.turnId,
        itemIds: [source.itemId],
        artifactIds: [source.artifactId],
        verificationEvidence: [],
        prompt: 'Review the portable Task evidence.',
        createdByRequestId: 'goal-step-portable-1',
        verdict: null,
        reason: null,
        revisionInstruction: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        resolutionRequestId: null,
        resolvedByActorId: null,
        resolutionSnapshot: null,
      },
    ],
    goalVerificationRecords: [
      {
        verificationId: 'verification_source',
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: source.goalId,
        taskId: source.taskId,
        turnId: source.turnId,
        commandId: null,
        command: null,
        status: 'passed',
        summary: 'Portable.',
        itemIds: [source.itemId],
        artifactIds: [source.artifactId],
        outputPointers: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    gitPushRecords: [
      {
        id: 'gpr_source',
        workspaceId: source.workspaceId,
        repositoryResourceId: 'repo_source',
        approvalRowId: missing === 'git-approval' ? 'apr_missing' : source.approvalId,
        policyDecisionId: 'pd_source',
        actorId: 'user_local',
        remoteSummary: 'Portable repository origin',
        sourceRef: 'HEAD',
        targetBranch: 'main',
        commitIds: ['abc123'],
        reviewIds: [],
        remoteHeadBefore: 'abc000',
        remoteHeadAfter: 'abc123',
        outcome: 'pushed',
        errorSummary: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        requestId: '00000000-0000-4000-8000-000000000001',
      },
    ],
    permissionDecisions: [
      {
        action: 'runtime.launch',
        approvalId: missing === 'permission-approval' ? 'apr_missing' : source.approvalId,
        auditEventId: null,
        contextSummary: {},
        createdAt: timestamp,
        decisionId: 'pd_source',
        enforcementPoint: 'worker.launch',
        ownerScope: 'workspace',
        policyEngineVersion: 'nanocore-policy:v1',
        policySnapshotId: 'policy_source',
        reasonCode: 'approved',
        requiredApprovalKind: 'permission',
        resourceSummary: {},
        result: 'allow',
        subjectSummary: {},
        workspaceId: source.workspaceId,
      },
    ],
    workspaceRepositories: [
      {
        resourceId: 'repo_source',
        type: 'git_repository',
        displayName: 'Portable repository',
        git: {
          authorEmail: null,
          authorName: null,
          allowedPushTargets: ['main'],
          commitOnApply: true,
          protectedBranchPatterns: ['main'],
          requireReviewLinkage: true,
          stagingStrategy: 'staging-root',
          vaultGrantRef: missing === 'repository-grant' ? 'grant_missing' : source.grantId,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    workerOutputManifests: [
      {
        id: 'wom_source',
        workspaceId: source.workspaceId,
        materializationRecordId: 'wmr_source',
        inputSnapshotId: 'wis_source',
        workerSessionId: 'worker_source',
        backendKind: 'openshell',
        strategy: 'git',
        changedPaths: [],
        artifactIds: [missing === 'sync-artifact' ? 'ar_missing' : source.artifactId],
        logRefs: [],
        testOutputRefs: [],
        ignoredOutputs: [],
        evidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        collectedAt: timestamp,
      },
    ],
    workspaceChangeSets: [
      {
        id: 'wcs_source',
        materializationRecordId: 'wmr_source',
        inputSnapshotId: 'wis_source',
        workspaceId: source.workspaceId,
        resourceId: 'repo_source',
        strategy: 'git',
        base: { commit: 'abc000', contentDigest: null },
        head: { commit: 'abc123', contentDigest: null },
        changedPaths: [],
        patch: null,
        bundle: null,
        artifactIds: [missing === 'sync-artifact' ? 'ar_missing' : source.artifactId],
        evidenceRefs: [{ kind: 'worker', ref: source.turnId }],
        redaction: { status: 'no-sensitive-content-found', notes: [] },
        createdAt: timestamp,
      },
    ],
    vaultReferences: [
      {
        sourceReferenceId: 'vault_source',
        displayName: 'Portable secret',
        secretKind: 'api-key',
        backendKind: 'encrypted-file',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    vaultGrants: [
      {
        grantId: source.grantId,
        vaultReferenceId: 'vault_source',
        ownerScope: 'workspace',
        workspaceId: source.workspaceId,
        userId: null,
        subjectSummary: null,
        targetAgentId: null,
        targetAgentSessionId: missing === 'vault-session' ? 'as_missing' : source.sessionId,
        targetCapabilityId: null,
        allowedInjectionPaths: [],
        lifetime: 'agent-session',
        policyDecisionId: null,
        approvalId: missing === 'vault-approval' ? 'apr_missing' : source.approvalId,
        status: 'active',
        createdAt: timestamp,
        expiresAt: null,
      },
    ],
  };
}

/**
 * Writes and reads one export through the public portability boundary.
 *
 * @param input Complete source export fixture.
 * @returns Reminted import snapshot.
 * @throws Error when export or import validation rejects the fixture.
 */
function importLineage(input: WriteWorkspaceExportTreeInput) {
  const verified = writeWorkspaceExportTree(input);
  return readWorkspaceImportSnapshot({
    verified,
    targetWorkspaceId,
  });
}

/**
 * Builds one complete source Material, Review, and S39 portability graph.
 *
 * @param followUp Optional exact Artifact Review follow-up fixture.
 * @returns Complete export fixture covering the accepted work-resource lineage.
 * @throws Error when the structured worker request or package fixture cannot be built.
 */
function createWorkResourceLineageExportInput(followUp?: {
  artifactMediaType?: 'text/markdown' | 'text/plain' | 'application/json';
  decisionRequestId?: string;
}): WriteWorkspaceExportTreeInput {
  const input = createLineageExportInput();
  const materialId = 'mat_source';
  const baseRevisionId = 'mrev_source_1';
  const appliedRevisionId = 'mrev_source_2';
  const baseContent = '# Portable base\n';
  const appliedContent = '# Portable\n';
  const baseContentDigest = `sha256:${createHash('sha256').update(baseContent).digest('hex')}`;
  const appliedContentDigest = `sha256:${createHash('sha256').update(appliedContent).digest('hex')}`;
  const knowledgePageId = 'knowledge_portable_source';
  const knowledgeContent = '# Retained portable knowledge\n\nUse the retained package bytes.\n';
  const knowledgeContentDigest = `sha256:${createHash('sha256')
    .update(knowledgeContent)
    .digest('hex')}`;
  const knowledgeSourceRefs = ['https://example.com/retained-portable-knowledge'];
  const retrievalTraceId = 'krt_00000000-0000-4000-8000-000000000001';
  const workerRequest = serializeStructuredWorkerDelegationRequest(
    createStructuredWorkerDelegationRequest({
      acceptanceCriteria: ['Preserve the portable Material graph.'],
      constraints: { maxContextTokens: 4_096, maxWorkerIterations: 1 },
      contextRefs: [
        { kind: 'workspace', id: source.workspaceId },
        { kind: 'thread', id: source.threadId },
      ],
      escalationConditions: [],
      expectedArtifacts: [{ kind: 'artifact', description: 'Portable proposal.' }],
      objective: 'Produce one portable Material proposal.',
      resources: [{ kind: 'artifact', reference: source.artifactId, reason: 'Proposal output.' }],
      reviewContext: null,
      reviewPolicy: {
        instructions: 'Review the exact proposal.',
        required: true,
        reviewers: ['human'],
      },
      verification: [{ kind: 'manual', description: 'Inspect the imported graph.' }],
    })
  );
  input.threads = input.threads.map((thread) => ({ ...thread, preview: workerRequest }));
  const sourceThread = input.threads[0]!;
  const requestItem = {
    ...(input.itemRevisions.find(
      (candidate) => (candidate as { id?: string }).id === source.itemId
    ) as Record<string, unknown>),
    type: 'user-message',
    actor: { kind: 'user', id: 'user_local' },
    text: workerRequest,
  };
  input.itemRevisions = input.itemRevisions.map((candidate) =>
    (candidate as { id?: string }).id === source.itemId ? requestItem : candidate
  );
  input.turns = input.turns.map((candidate) => ({
    ...(candidate as Record<string, unknown>),
    agentId: 'agent_codex_host',
    agentSessionId: source.sessionId,
    items: (candidate as { items: Array<Record<string, unknown>> }).items.map((item) =>
      item.id === source.itemId ? requestItem : item
    ),
  }));
  input.turnEvents = [
    [
      source.turnId,
      [
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'thread.created',
          sequence: 1,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'thread-created', thread: sourceThread },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'thread.updated',
          sequence: 2,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'thread-updated', thread: sourceThread },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'item.completed',
          sequence: 3,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: { type: 'item-completed', itemId: source.itemId, item: requestItem },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          event: 'item.delta',
          sequence: 4,
          requestId: null,
          timestamp,
          workspaceId: source.workspaceId,
          threadId: source.threadId,
          turnId: source.turnId,
          data: {
            type: 'item-delta',
            itemId: artifactReferenceItemId(source.artifactId, source.turnId),
            itemType: 'artifact-reference',
            deltaKind: 'artifact-updated',
            artifactId: source.artifactId,
          },
        },
      ],
    ],
  ];
  const packageFiles = createWorkerContextPackageFiles({
    contextBudgetTokens: 4_096,
    includedItemIds: [source.itemId],
    knowledgeSelections: [
      {
        content: knowledgeContent,
        contentDigest: knowledgeContentDigest,
        knowledgePageId,
        sourceRefs: knowledgeSourceRefs,
      },
    ],
    materialSelections: [
      {
        bindingMutationRequestId: 'request_material_bind',
        content: baseContent,
        contentDigest: baseContentDigest,
        inclusionReason: 'thread_binding',
        materialId,
        mediaType: 'text/markdown',
        parentRevisionId: null,
        revisionId: baseRevisionId,
        sensitivity: 'internal',
      },
    ],
    threadId: source.threadId,
    turnId: source.turnId,
    workerRequestBytes: workerRequest,
    workerRequestItemId: source.itemId,
    workspaceId: source.workspaceId,
  });
  const snapshotRecord = input.agentEnvironmentPackageSnapshots?.[0];
  if (!snapshotRecord) {
    throw new Error('Work-resource fixture requires one AEP snapshot.');
  }
  const sourceSnapshot = AgentEnvironmentPackageSchema.parse(snapshotRecord.snapshot);
  const snapshot = AgentEnvironmentPackageSchema.parse({
    ...sourceSnapshot,
    workspace: {
      ...sourceSnapshot.workspace,
      inputs: [
        buildWorkerContextPackageWorkspaceInput({
          agentSessionId: source.sessionId,
          packageRootDigest: packageFiles.packageRootDigest,
          threadId: source.threadId,
          turnId: source.turnId,
        }),
      ],
    },
  });
  input.agentEnvironmentPackageSnapshots = [
    {
      ...snapshotRecord,
      contentDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      snapshot,
    },
  ];
  const trace = createWorkerContextPackageTrace({
    agentSessionId: source.sessionId,
    excludedItems: [],
    goalId: null,
    knowledgeSelectionInput: { retrievalTraceId },
    packageFiles,
    packageSnapshotId: snapshot.snapshotId,
    requestId: 'request_source',
    taskId: null,
  });
  const workspaceInputSnapshot = {
    backend: {
      capabilitySummary: [...snapshot.backend.requiredCapabilities],
      kind: 'openshell' as const,
      label: 'openshell worker backend',
    },
    base: { commit: null, contentDigest: packageFiles.packageRootDigest },
    createdAt: timestamp,
    generatedFiles: [],
    id: trace.workspaceInputSnapshotId,
    ignoredPaths: [],
    pathScope: [`context_${source.turnId}`],
    resourceId: `context_${source.turnId}`,
    resourceKind: 'filesystem' as const,
    strategy: 'filesystem' as const,
    workspaceId: source.workspaceId,
    writableRoots: [],
  };
  const workerSessionId = 'worker_source';
  input.workspaceInputSnapshots = [workspaceInputSnapshot];
  input.workspaceMaterializationRecords = [
    {
      backendKind: 'openshell',
      base: workspaceInputSnapshot.base,
      createdAt: timestamp,
      id: trace.workspaceMaterializationRecordId,
      inputSnapshotId: trace.workspaceInputSnapshotId,
      materializedRootRef: `/openkit/sessions/${source.sessionId}/context`,
      packageSnapshotId: snapshot.snapshotId,
      policyDigest: createWorkerContextPackagePolicyDigest({
        backendKind: 'openshell',
        packageSnapshotId: snapshot.snapshotId,
        requiredCapabilities: snapshot.backend.requiredCapabilities,
      }),
      readinessEvidence: [
        { kind: 'backend.ready', ref: 'version:0.0.80' },
        { kind: 'sandbox.created', ref: workerSessionId },
      ],
      strategy: 'filesystem',
      workerSessionId,
      workspaceId: source.workspaceId,
    },
  ];
  input.workspaceMaterials = [
    {
      createdAt: timestamp,
      currentRevisionId: appliedRevisionId,
      kind: 'markdown',
      lastMutationRequestId: 'request_review_accept',
      materialId,
      sensitivity: 'internal',
      title: 'Portable Material',
      updatedAt: timestamp,
      workspaceId: source.workspaceId,
    },
  ];
  input.workspaceMaterialRevisions = [
    {
      authorId: 'user_local',
      content: baseContent,
      contentDigest: baseContentDigest,
      createdAt: timestamp,
      createdByRequestId: 'request_material_base',
      materialId,
      mediaType: 'text/markdown',
      parentRevisionId: null,
      revisionId: baseRevisionId,
      workspaceId: source.workspaceId,
    },
    {
      authorId: 'user_local',
      content: appliedContent,
      contentDigest: appliedContentDigest,
      createdAt: timestamp,
      createdByRequestId: 'request_review_accept',
      materialId,
      mediaType: 'text/markdown',
      parentRevisionId: baseRevisionId,
      revisionId: appliedRevisionId,
      workspaceId: source.workspaceId,
    },
  ];
  input.threadMaterialBindings = [
    {
      bindingState: 'bound',
      createdAt: timestamp,
      inclusionState: 'included',
      lastMutationRequestId: 'request_review_accept',
      latestQueuedRevisionId: appliedRevisionId,
      materialId,
      threadId: source.threadId,
      updatedAt: timestamp,
      workspaceId: source.workspaceId,
    },
  ];
  input.artifactReviews = [
    {
      appliedMaterialRevisionId: appliedRevisionId,
      artifactId: source.artifactId,
      artifactVersion: 1,
      contentDigest: appliedContentDigest,
      createdAt: timestamp,
      decidedAt: timestamp,
      decision: 'accepted',
      decisionActorId: 'user_local',
      decisionRequestId: 'request_review_accept',
      feedback: null,
      followUpTurnId: null,
      materialProposal: { materialId, baseRevisionId, baseContentDigest },
      reviewId: deriveArtifactReviewId(source.workspaceId, source.artifactId, 1),
      sourceAgentId: 'agent_codex_host',
      sourceThreadId: source.threadId,
      sourceTurnId: source.turnId,
      workspaceId: source.workspaceId,
    },
  ];
  input.portableFileState = {
    claims: new Map(),
    conflicts: new Map(),
    nativeKnowledgePages: new Map(),
    observations: new Map(),
    retrievalTraces: new Map([
      [
        '202607',
        [
          {
            caller: 'task-mode',
            createdAt: timestamp,
            excluded: [],
            requestDigest: `sha256:${createHash('sha256')
              .update('portable Knowledge retrieval')
              .digest('hex')}`,
            retrievalParameters: { limit: 5, pinnedConceptIds: [] },
            selected: [
              {
                contentDigest: knowledgeContentDigest,
                knowledgePageId,
                score: 1,
                sourceReferences: knowledgeSourceRefs,
              },
            ],
            traceId: retrievalTraceId,
            workspaceId: source.workspaceId,
          },
        ],
      ],
    ]),
    workerContextPackageFiles: new Map([
      ...packageFiles.files.map(
        (file) =>
          [
            `threads/${source.threadId}/turns/${source.turnId}/context-package/${file.path}`,
            Buffer.from(file.bytes).toString('utf8'),
          ] as const
      ),
      [
        `threads/${source.threadId}/turns/${source.turnId}/context-package.json`,
        serializeWorkerContextPackageTrace(trace),
      ],
    ]),
    workspaceConfig: JSON.stringify({
      schemaVersion: 1,
      workspace: { name: 'Lineage workspace', defaultAgentId: null },
    }),
    workspaceSchema: null,
  };
  if (followUp) {
    const decisionRequestId = followUp.decisionRequestId ?? 'request_review_redo';
    const prefixedImportRequest = decisionRequestId.startsWith('import-lineage:');
    const followUpTurnId = prefixedImportRequest
      ? 'tu_follow_up_source'
      : deriveArtifactReviewFollowUpTurnId(
          source.workspaceId,
          source.artifactId,
          1,
          decisionRequestId
        );
    const workerRequestId = prefixedImportRequest
      ? 'request_follow_up_source'
      : deriveArtifactReviewWorkerRequestId(decisionRequestId);
    const followUpItemId = 'it_follow_up_source';
    const followUpRequest = serializeArtifactReviewFollowUpRequest({
      kind: 'artifact-review-follow-up',
      workspaceId: source.workspaceId,
      reviewId: deriveArtifactReviewId(source.workspaceId, source.artifactId, 1),
      artifactId: source.artifactId,
      artifactVersion: 1,
      contentDigest: appliedContentDigest,
      artifactContent: appliedContent,
      artifactMediaType: followUp.artifactMediaType ?? 'text/markdown',
      sourceThreadId: source.threadId,
      sourceTurnId: source.turnId,
      sourceAgentId: 'agent_codex_host',
      materialProposal: { materialId, baseRevisionId, baseContentDigest },
      decision: 'redo',
      feedback: 'Try again.',
      decisionRequestId,
      workerRequestId,
    });
    const followUpItem = {
      id: followUpItemId,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: followUpTurnId,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      text: followUpRequest,
      createdAt: timestamp,
      completedAt: timestamp,
    };
    input.itemRevisions = [...input.itemRevisions, followUpItem];
    input.turns = [
      ...input.turns,
      {
        id: followUpTurnId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        triggerActor: { kind: 'user', id: 'user_local' },
        items: [followUpItem],
        status: 'completed',
        humanGate: null,
        error: null,
        configVersion: null,
        agentId: 'agent_codex_host',
        agentSessionId: source.sessionId,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 1,
      },
    ];
    const followUpPackage = createWorkerContextPackageFiles({
      contextBudgetTokens: 4_096,
      includedItemIds: [followUpItemId],
      materialSelections: [
        {
          bindingMutationRequestId: 'request_material_bind',
          content: baseContent,
          contentDigest: baseContentDigest,
          inclusionReason: 'thread_binding',
          materialId,
          mediaType: 'text/markdown',
          parentRevisionId: null,
          revisionId: baseRevisionId,
          sensitivity: 'internal',
        },
      ],
      threadId: source.threadId,
      turnId: followUpTurnId,
      workerRequestBytes: followUpRequest,
      workerRequestItemId: followUpItemId,
      workspaceId: source.workspaceId,
    });
    const followUpSnapshot = AgentEnvironmentPackageSchema.parse({
      ...snapshot,
      snapshotId: 'aepsnap_follow_up_source',
      packageId: 'aepkg_follow_up_source',
      scope: {
        ...snapshot.scope,
        requestId: workerRequestId,
        itemId: followUpItemId,
        turnId: followUpTurnId,
      },
      workspace: {
        ...snapshot.workspace,
        inputs: [
          buildWorkerContextPackageWorkspaceInput({
            agentSessionId: source.sessionId,
            packageRootDigest: followUpPackage.packageRootDigest,
            threadId: source.threadId,
            turnId: followUpTurnId,
          }),
        ],
      },
    });
    input.agentEnvironmentPackageSnapshots = [
      ...(input.agentEnvironmentPackageSnapshots ?? []),
      {
        ...snapshotRecord,
        snapshotId: followUpSnapshot.snapshotId,
        packageId: followUpSnapshot.packageId,
        turnId: followUpTurnId,
        contentDigest: createHash('sha256').update(JSON.stringify(followUpSnapshot)).digest('hex'),
        snapshot: followUpSnapshot,
      },
    ];
    const followUpTrace = createWorkerContextPackageTrace({
      agentSessionId: source.sessionId,
      excludedItems: [],
      goalId: null,
      packageFiles: followUpPackage,
      packageSnapshotId: followUpSnapshot.snapshotId,
      requestId: workerRequestId,
      taskId: null,
    });
    const followUpInputSnapshot = {
      ...workspaceInputSnapshot,
      base: { commit: null, contentDigest: followUpPackage.packageRootDigest },
      id: followUpTrace.workspaceInputSnapshotId,
      pathScope: [`context_${followUpTurnId}`],
      resourceId: `context_${followUpTurnId}`,
    };
    input.workspaceInputSnapshots = [
      ...(input.workspaceInputSnapshots ?? []),
      followUpInputSnapshot,
    ];
    input.workspaceMaterializationRecords = [
      ...(input.workspaceMaterializationRecords ?? []),
      {
        ...(input.workspaceMaterializationRecords?.[0] as Record<string, unknown>),
        base: followUpInputSnapshot.base,
        id: followUpTrace.workspaceMaterializationRecordId,
        inputSnapshotId: followUpTrace.workspaceInputSnapshotId,
        packageSnapshotId: followUpSnapshot.snapshotId,
        policyDigest: createWorkerContextPackagePolicyDigest({
          backendKind: 'openshell',
          packageSnapshotId: followUpSnapshot.snapshotId,
          requiredCapabilities: followUpSnapshot.backend.requiredCapabilities,
        }),
        readinessEvidence: [
          { kind: 'backend.ready', ref: 'version:0.0.80' },
          { kind: 'sandbox.created', ref: 'worker_follow_up_source' },
        ],
        workerSessionId: 'worker_follow_up_source',
      },
    ];
    input.workspaceMaterials = input.workspaceMaterials.map((material) => ({
      ...(material as Record<string, unknown>),
      currentRevisionId: baseRevisionId,
      lastMutationRequestId: 'request_material_base',
    }));
    input.workspaceMaterialRevisions = [input.workspaceMaterialRevisions[0]!];
    input.threadMaterialBindings = input.threadMaterialBindings.map((binding) => ({
      ...(binding as Record<string, unknown>),
      latestQueuedRevisionId: baseRevisionId,
      lastMutationRequestId: 'request_material_base',
    }));
    input.artifactReviews = input.artifactReviews.map((review) => ({
      ...(review as Record<string, unknown>),
      appliedMaterialRevisionId: null,
      decision: 'redo',
      decisionRequestId,
      feedback: 'Try again.',
      followUpTurnId,
    }));
    for (const file of followUpPackage.files) {
      input.portableFileState.workerContextPackageFiles.set(
        `threads/${source.threadId}/turns/${followUpTurnId}/context-package/${file.path}`,
        Buffer.from(file.bytes).toString('utf8')
      );
    }
    input.portableFileState.workerContextPackageFiles.set(
      `threads/${source.threadId}/turns/${followUpTurnId}/context-package.json`,
      serializeWorkerContextPackageTrace(followUpTrace)
    );
  }
  return input;
}

describe('workspace auxiliary lineage reminting', () => {
  it('remints accepted Knowledge Page Context Package references with the imported digest', () => {
    const input = createWorkResourceLineageExportInput();
    const sourceTraceText = [...input.portableFileState!.workerContextPackageFiles.entries()].find(
      ([path]) => path.endsWith('/context-package.json')
    )?.[1];
    const sourceTrace = parseWorkerContextPackageTrace(JSON.parse(sourceTraceText ?? '{}'));
    const knowledge = {
      id: 'mem_1',
      kind: 'task-summary' as const,
      title: 'Portable work history',
      content: 'Reuse the accepted Context Package.',
      sourceReferences: [`context-package:${source.turnId}@${sourceTrace.contextPackageDigest}`],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    input.knowledge = [knowledge];
    input.workspace = {
      ...input.workspace,
      counts: { ...input.workspace.counts, knowledgeEntryCount: 1 },
    };
    input.portableFileState!.nativeKnowledgePages.set(
      `knowledge/pages/${knowledge.id}.md`,
      serializeUserAuthoredKnowledgePage(knowledge)
    );

    const imported = importLineage(input);
    const targetTraceText = [
      ...imported.portableFileState.workerContextPackageFiles.entries(),
    ].find(([path]) => path.endsWith('/context-package.json'))?.[1];
    const targetTrace = parseWorkerContextPackageTrace(JSON.parse(targetTraceText ?? '{}'));
    const expectedReference = `context-package:${targetTrace.turnId}@${targetTrace.contextPackageDigest}`;
    const [pagePath, pageContent] = [
      ...imported.portableFileState.nativeKnowledgePages.entries(),
    ][0]!;

    expect(targetTrace.contextPackageDigest).not.toBe(sourceTrace.contextPackageDigest);
    expect(imported.knowledge[0]?.sourceReferences).toEqual([expectedReference]);
    expect(parseOwnedKnowledgeEntry(pagePath, knowledge.id, pageContent).sourceReferences).toEqual([
      expectedReference,
    ]);
  });

  it('remints one complete Material, Review, and S39 imported-history graph', () => {
    const imported = importLineage(createWorkResourceLineageExportInput());
    const material = imported.workspaceMaterials[0];
    const revisions = imported.workspaceMaterialRevisions;
    const binding = imported.threadMaterialBindings[0];
    const review = imported.artifactReviews[0];
    const traceText = [...imported.portableFileState.workerContextPackageFiles.entries()].find(
      ([path]) => path.endsWith('/context-package.json')
    )?.[1];
    const trace = parseWorkerContextPackageTrace(JSON.parse(traceText ?? '{}'));
    const stagedRoot = mkdtempSync(join(tmpdir(), 'openkit-imported-history-package-'));
    writeWorkspacePortableFileState(stagedRoot, imported.portableFileState);
    expect(() => verifyImportedWorkerContextPackageSnapshot(imported, stagedRoot)).not.toThrow();

    expect(material?.workspaceId).toBe(targetWorkspaceId);
    expect(material?.materialId).not.toBe('mat_source');
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.content).toBe('# Portable base\n');
    expect(revisions[1]).toMatchObject({
      materialId: material?.materialId,
      parentRevisionId: revisions[0]?.revisionId,
    });
    expect(material?.currentRevisionId).toBe(revisions[1]?.revisionId);
    expect(binding).toMatchObject({
      materialId: material?.materialId,
      threadId: imported.threads[0]?.id,
      latestQueuedRevisionId: revisions[1]?.revisionId,
    });
    expect(review).toMatchObject({
      appliedMaterialRevisionId: revisions[1]?.revisionId,
      artifactId: imported.artifacts[0]?.id,
      materialProposal: {
        baseRevisionId: revisions[0]?.revisionId,
        materialId: material?.materialId,
      },
      reviewId: deriveArtifactReviewId(targetWorkspaceId, imported.artifacts[0]!.id, 1),
      sourceAgentId: 'agent_codex_host',
      sourceThreadId: imported.threads[0]?.id,
      sourceTurnId: imported.turns[0]?.id,
      workspaceId: targetWorkspaceId,
    });
    expect(material?.lastMutationRequestId).toBe(review?.decisionRequestId);
    expect(revisions[1]?.createdByRequestId).toBe(review?.decisionRequestId);
    expect(binding?.lastMutationRequestId).toBe(review?.decisionRequestId);
    expect(review?.decisionRequestId).toMatch(/^import-lineage:sha256:[a-f0-9]{64}$/);
    expect(trace).toMatchObject({
      agentSessionId: imported.agentSessions[0]?.id,
      contextPackageId: `ctxpkg_${imported.turns[0]?.id}`,
      knowledgeSelectionInput: { retrievalTraceId: 'krt_00000000-0000-4000-8000-000000000001' },
      knowledgeSelections: [
        {
          contentDigest: `sha256:${createHash('sha256')
            .update('# Retained portable knowledge\n\nUse the retained package bytes.\n')
            .digest('hex')}`,
          knowledgePageId: 'knowledge_portable_source',
          packagePath: 'knowledge/pages/knowledge_portable_source.md',
          sourceRefs: ['https://example.com/retained-portable-knowledge'],
        },
      ],
      materialSelections: [
        {
          materialId: material?.materialId,
          revisionId: revisions[0]?.revisionId,
        },
      ],
      packageSnapshotId: imported.agentEnvironmentPackageSnapshots[0]?.snapshotId,
      requestId: expect.stringMatching(/^import-lineage:sha256:[a-f0-9]{64}$/),
      threadId: imported.threads[0]?.id,
      turnId: imported.turns[0]?.id,
      workerRequestItemId: imported.turns[0]?.items[0]?.id,
      workspaceId: targetWorkspaceId,
      workspaceInputSnapshotId: imported.workspaceInputSnapshots[0]?.id,
      workspaceMaterializationRecordId: imported.workspaceMaterializationRecords[0]?.id,
    });
    const requestText =
      imported.turns[0]?.items[0]?.type === 'user-message' ? imported.turns[0].items[0].text : null;
    expect(trace.requestId).not.toBe('request_source');
    expect(imported.threads[0]?.preview).toBe(requestText);
    expect(requestText).toContain(targetWorkspaceId);
    expect(requestText).toContain(imported.threads[0]?.id);
    expect(requestText).not.toContain(source.workspaceId);
    expect(requestText).not.toContain(source.threadId);
    expect(imported.turnEvents[0]?.[1][0]?.data).toEqual({
      type: 'thread-created',
      thread: imported.threads[0],
    });
    expect(imported.turnEvents[0]?.[1][1]?.data).toEqual({
      type: 'thread-updated',
      thread: imported.threads[0],
    });
    expect(imported.workspaceMaterializationRecords[0]?.workerSessionId).toBe(
      `import-history-worker_${trace.packageSnapshotId}`
    );
    expect([...imported.portableFileState.workerContextPackageFiles.keys()]).toEqual(
      expect.arrayContaining([
        `threads/${trace.threadId}/turns/${trace.turnId}/context-package.json`,
        `threads/${trace.threadId}/turns/${trace.turnId}/context-package/package.json`,
      ])
    );
    expect(imported.portableFileState.nativeKnowledgePages.size).toBe(0);
    expect(
      imported.portableFileState.workerContextPackageFiles.get(
        `threads/${trace.threadId}/turns/${trace.turnId}/context-package/knowledge/pages/knowledge_portable_source.md`
      )
    ).toBe('# Retained portable knowledge\n\nUse the retained package bytes.\n');
    expect(imported.turnEvents[0]?.[1][2]?.data).toMatchObject({
      itemId: imported.turns[0]?.items[0]?.id,
      item: imported.turns[0]?.items[0],
    });
    expect(imported.turnEvents[0]?.[1][3]?.data).toMatchObject({
      type: 'item-delta',
      itemId: imported.artifacts[0]
        ? artifactReferenceItemId(imported.artifacts[0].id, imported.turns[0]!.id)
        : undefined,
      artifactId: imported.artifacts[0]?.id,
    });

    const reExported = writeWorkspaceExportTree({
      agentEnvironmentPackageSnapshots: imported.agentEnvironmentPackageSnapshots,
      agentSessions: imported.agentSessions,
      artifactReviews: imported.artifactReviews,
      artifacts: imported.artifacts,
      createdAt: timestamp,
      exportId: 'wsexp_imported_history',
      exportRoot: join(mkdtempSync(join(tmpdir(), 'openkit-reexported-history-')), 'export'),
      itemRevisions: imported.itemRevisions,
      knowledge: imported.knowledge,
      portableFileState: imported.portableFileState,
      sourceDeploymentId: 'dep_imported_history',
      threadMaterialBindings: imported.threadMaterialBindings,
      threads: imported.threads,
      turnEvents: imported.turnEvents,
      turns: imported.turns,
      workspace: imported.workspace,
      workspaceInputSnapshots: imported.workspaceInputSnapshots,
      workspaceMaterialRevisions: imported.workspaceMaterialRevisions,
      workspaceMaterializationRecords: imported.workspaceMaterializationRecords,
      workspaceMaterials: imported.workspaceMaterials,
    });
    const reimported = readWorkspaceImportSnapshot({
      verified: reExported,
      targetWorkspaceId: 'ws_reimported',
    });
    const reimportedRoot = mkdtempSync(join(tmpdir(), 'openkit-reimported-history-package-'));
    writeWorkspacePortableFileState(reimportedRoot, reimported.portableFileState);
    expect(() =>
      verifyImportedWorkerContextPackageSnapshot(reimported, reimportedRoot)
    ).not.toThrow();
    expect(reimported.workspaceMaterialRevisions.map((revision) => revision.content)).toEqual(
      imported.workspaceMaterialRevisions.map((revision) => revision.content)
    );
    expect(
      [...reimported.portableFileState.workerContextPackageFiles.entries()].find(([path]) =>
        path.endsWith('/context-package.json')
      )?.[1]
    ).toContain('import-lineage:sha256:');
  });

  it('preserves a Thread preview that is not the exact traced worker request', () => {
    const input = createWorkResourceLineageExportInput();
    const preview = `User note: ${input.threads[0]!.preview}`;
    input.threads = input.threads.map((thread) => ({ ...thread, preview }));
    input.turnEvents = input.turnEvents.map(([turnId, events]) => [
      turnId,
      events.map((event) =>
        event.data.type === 'thread-created' || event.data.type === 'thread-updated'
          ? { ...event, data: { ...event.data, thread: { ...event.data.thread, preview } } }
          : event
      ),
    ]);

    const imported = importLineage(input);

    expect(imported.threads[0]?.preview).toBe(preview);
    expect(imported.turnEvents[0]?.[1][0]?.data).toEqual({
      type: 'thread-created',
      thread: imported.threads[0],
    });
    expect(imported.turnEvents[0]?.[1][1]?.data).toEqual({
      type: 'thread-updated',
      thread: imported.threads[0],
    });
  });

  it('preserves compatible Artifact Review follow-up media through remint', () => {
    const imported = importLineage(createWorkResourceLineageExportInput({}));
    const review = imported.artifactReviews[0]!;
    const turn = imported.turns.find((candidate) => candidate.id === review.followUpTurnId);
    const item = turn?.items[0];
    const request = ArtifactReviewFollowUpRequestSchema.parse(
      JSON.parse(item?.type === 'user-message' ? item.text : '{}')
    );

    expect(request.artifactMediaType).toBe('text/markdown');
    expect(request.materialProposal?.materialId).toBe(imported.workspaceMaterials[0]?.materialId);
    expect(request.decisionRequestId).toMatch(/^import-lineage:sha256:[a-f0-9]{64}$/);
  });

  it('rejects an artifact update delta detached from its artifact-reference Item', () => {
    const input = createWorkResourceLineageExportInput();
    const content = '# Independently valid Artifact';
    const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    input.artifacts = [
      ...input.artifacts,
      {
        id: 'ar_other',
        workspaceId: source.workspaceId,
        threadId: null,
        turnId: null,
        kind: 'summary',
        title: 'Other Artifact',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'markdown', body: content },
        contentDigest,
        lastMutationRequestId: 'request_other_artifact',
        origin: {
          kind: 'imported',
          sourceKind: 'direct-import',
          sourceId: 'request_other_artifact',
          sourceDigest: contentDigest,
          actor: { kind: 'user', id: 'user_local' },
          requestId: 'request_other_artifact',
          recordedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    input.turnEvents = input.turnEvents.map(([turnId, events]) => [
      turnId,
      events.map((event) =>
        event.data.type === 'item-delta' && event.data.deltaKind === 'artifact-updated'
          ? { ...event, data: { ...event.data, artifactId: 'ar_other' } }
          : event
      ),
    ]);

    expect(() => importLineage(input)).toThrow(
      'Artifact update delta has contradictory artifact-reference lineage.'
    );
  });

  it.each([
    {
      name: 'forked Material history',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.workspaceMaterialRevisions = [
          ...(input.workspaceMaterialRevisions ?? []),
          {
            ...(input.workspaceMaterialRevisions?.[1] as Record<string, unknown>),
            revisionId: 'mrev_source_fork',
          },
        ];
      },
    },
    {
      name: 'digest-invalid revision',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.workspaceMaterialRevisions = (input.workspaceMaterialRevisions ?? []).map(
          (revision, index) =>
            index === 1
              ? { ...(revision as Record<string, unknown>), content: 'Changed.' }
              : revision
        );
      },
    },
    {
      name: 'dangling Review result',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.artifactReviews = (input.artifactReviews ?? []).map((review) => ({
          ...(review as Record<string, unknown>),
          appliedMaterialRevisionId: 'mrev_missing',
        }));
      },
    },
    {
      name: 'Material mutation proof detached from its current revision',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.workspaceMaterials = (input.workspaceMaterials ?? []).map((material) => ({
          ...(material as Record<string, unknown>),
          lastMutationRequestId: 'request_other',
        }));
      },
    },
    {
      name: 'stale bound Material queue',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.threadMaterialBindings = (input.threadMaterialBindings ?? []).map((binding) => ({
          ...(binding as Record<string, unknown>),
          latestQueuedRevisionId: 'mrev_source_1',
        }));
      },
    },
    {
      name: 'future decided Review version',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.artifactReviews = (input.artifactReviews ?? []).map((review) => ({
          ...(review as Record<string, unknown>),
          reviewId: deriveArtifactReviewId(source.workspaceId, source.artifactId, 2),
          artifactVersion: 2,
        }));
      },
    },
    {
      name: 'media-incompatible Review follow-up proposal',
      createInput: () => createWorkResourceLineageExportInput({ artifactMediaType: 'text/plain' }),
      error: 'Artifact Review follow-up Turn lineage is contradictory.',
      alter: () => undefined,
    },
    {
      name: 'malformed import-lineage follow-up request',
      createInput: () =>
        createWorkResourceLineageExportInput({
          decisionRequestId: 'import-lineage:not-a-digest',
        }),
      error: 'Artifact Review follow-up Turn lineage is contradictory.',
      alter: () => undefined,
    },
    {
      name: 'self-referential Review follow-up Turn',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.artifactReviews = (input.artifactReviews ?? []).map((review) => ({
          ...(review as Record<string, unknown>),
          appliedMaterialRevisionId: null,
          decision: 'redo',
          feedback: 'Try again.',
          followUpTurnId: source.turnId,
        }));
      },
    },
    {
      name: 'untraced sibling Review follow-up Turn',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.turns = [
          ...input.turns,
          {
            ...(input.turns[0] as Record<string, unknown>),
            agentSessionId: null,
            id: 'tu_untraced_follow_up',
            items: [],
          },
        ];
        input.artifactReviews = (input.artifactReviews ?? []).map((review) => ({
          ...(review as Record<string, unknown>),
          appliedMaterialRevisionId: null,
          decision: 'redo',
          feedback: 'Try again.',
          followUpTurnId: 'tu_untraced_follow_up',
        }));
      },
    },
    {
      name: 'media-incompatible unresolved proposal',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        const baseRevision = input.workspaceMaterialRevisions?.[0] as Record<string, unknown>;
        input.workspaceMaterialRevisions = [baseRevision];
        input.workspaceMaterials = (input.workspaceMaterials ?? []).map((material) => ({
          ...(material as Record<string, unknown>),
          currentRevisionId: 'mrev_source_1',
          lastMutationRequestId: baseRevision.createdByRequestId,
        }));
        input.threadMaterialBindings = (input.threadMaterialBindings ?? []).map((binding) => ({
          ...(binding as Record<string, unknown>),
          latestQueuedRevisionId: 'mrev_source_1',
        }));
        input.artifacts = input.artifacts.map((artifact) => ({
          ...(artifact as Record<string, unknown>),
          content: { format: 'text', body: '# Portable' },
        }));
        input.artifactReviews = (input.artifactReviews ?? []).map((review) => ({
          ...(review as Record<string, unknown>),
          decision: null,
          decisionActorId: null,
          decisionRequestId: null,
          decidedAt: null,
          appliedMaterialRevisionId: null,
        }));
      },
    },
    {
      name: 'missing S39 package for a worker Turn',
      alter: (input: WriteWorkspaceExportTreeInput) => {
        input.artifactReviews = [];
        input.portableFileState = {
          ...input.portableFileState!,
          workerContextPackageFiles: new Map(),
        };
      },
    },
  ])('rejects a $name before target writes', (testCase) => {
    const input =
      'createInput' in testCase ? testCase.createInput() : createWorkResourceLineageExportInput();
    testCase.alter(input);

    if ('error' in testCase) {
      expect(() => importLineage(input)).toThrow(testCase.error);
    } else {
      expect(() => importLineage(input)).toThrow();
    }
  });

  it.each([
    ['Goal', 'records/goal-records.jsonl', 'verifying'],
    ['Goal Task', 'records/goal-tasks.jsonl', 'skipped'],
    ['Goal Task', 'records/goal-tasks.jsonl', 'needs_revision'],
  ])('rejects an imported %s with an unowned lifecycle status', (_label, path, status) => {
    const verified = writeWorkspaceExportTree(createLineageExportInput());
    const fileContents = new Map(verified.fileContents);
    const record = JSON.parse(fileContents.get(path) ?? '') as Record<string, unknown>;

    fileContents.set(path, JSON.stringify({ ...record, status }));

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents },
        targetWorkspaceId,
      })
    ).toThrow();
  });

  it('rejects Goal Plan digest corruption and Task divergence', () => {
    const verified = writeWorkspaceExportTree(createLineageExportInput());
    const planPath = 'records/goal-plan-records.jsonl';
    const planText = verified.fileContents.get(planPath);

    expect(planText).toBeDefined();
    if (!planText) {
      return;
    }

    const planFiles = new Map(verified.fileContents);
    const plan = JSON.parse(planText) as Record<string, unknown>;
    planFiles.set(planPath, JSON.stringify({ ...plan, planDigest: 'sha256:corrupt' }));
    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents: planFiles },
        targetWorkspaceId,
      })
    ).toThrow('Goal Plan digest');

    const taskFiles = new Map(verified.fileContents);
    const taskPath = 'records/goal-tasks.jsonl';
    const task = JSON.parse(taskFiles.get(taskPath) ?? '') as Record<string, unknown>;
    taskFiles.set(
      taskPath,
      JSON.stringify({ ...task, objective: 'Divergent imported objective.' })
    );
    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents: taskFiles },
        targetWorkspaceId,
      })
    ).toThrow('Goal Task does not match its immutable Plan');
  });

  it('rejects a Goal Plan whose Item projection has the wrong type or Thread', () => {
    const wrongType = createLineageExportInput();
    const wrongTypePlanItem = {
      id: source.planItemId,
      workspaceId: source.workspaceId,
      threadId: source.threadId,
      turnId: source.turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'This is not a Plan projection.',
      createdAt: timestamp,
      completedAt: timestamp,
    };
    wrongType.itemRevisions = wrongType.itemRevisions.map((record) => {
      const item = record as Record<string, unknown>;
      return item.id === source.planItemId ? wrongTypePlanItem : item;
    });
    wrongType.turns = wrongType.turns.map((record) => {
      const turn = record as Record<string, unknown>;
      return {
        ...turn,
        items: (turn.items as Array<Record<string, unknown>>).map((item) =>
          item.id === source.planItemId ? wrongTypePlanItem : item
        ),
      };
    });
    expect(() => importLineage(wrongType)).toThrow('Goal Plan has invalid lineage');

    const wrongThread = createLineageExportInput();
    const sourceTurn = wrongThread.turns[0] as Record<string, unknown>;
    const sourceTurnItems = sourceTurn.items as Array<Record<string, unknown>>;
    const sourcePlanItem = wrongThread.itemRevisions.find(
      (record) => (record as Record<string, unknown>).id === source.planItemId
    ) as Record<string, unknown>;
    const movedPlanItem = { ...sourcePlanItem, threadId: 'th_other', turnId: 'tu_other' };
    wrongThread.threads = [
      ...wrongThread.threads,
      {
        ...(wrongThread.threads[0] as Record<string, unknown>),
        id: 'th_other',
        name: 'Other thread',
      },
    ];
    wrongThread.turns = [
      {
        ...sourceTurn,
        items: sourceTurnItems.filter((item) => item.id !== source.planItemId),
      },
      {
        ...sourceTurn,
        id: 'tu_other',
        threadId: 'th_other',
        items: [movedPlanItem],
      },
    ];
    wrongThread.itemRevisions = wrongThread.itemRevisions.map((record) => {
      const item = record as Record<string, unknown>;
      return item.id === source.planItemId ? movedPlanItem : item;
    });
    expect(() => importLineage(wrongThread)).toThrow('Goal Plan has invalid lineage');
  });

  it('preserves a valid Plan-only Task before approval', () => {
    const input = createLineageExportInput();
    input.goalRecords = (input.goalRecords ?? []).map((record) => ({
      ...(record as Record<string, unknown>),
      status: 'awaiting_plan_approval',
      currentTaskId: null,
    }));
    input.goalTasks = [];
    input.goalReviewRecords = [];
    input.goalVerificationRecords = [];
    input.workerCheckpoints = [];
    input.runtimeEvidence = [];

    const imported = importLineage(input);

    expect(imported.goalTasks).toEqual([]);
    expect(imported.goalPlanRecords).toHaveLength(1);
    expect(imported.goalPlanRecords[0]?.tasks).toHaveLength(1);
    expect(imported.goalPlanRecords[0]?.planDigest).toBe(
      computeGoalPlanDigest(imported.goalPlanRecords[0]!)
    );
  });

  it('rejects approved Task rows while a Goal awaits Plan approval', () => {
    const input = createLineageExportInput();
    input.goalRecords = (input.goalRecords ?? []).map((record) => ({
      ...(record as Record<string, unknown>),
      status: 'awaiting_plan_approval',
      currentTaskId: null,
    }));

    expect(() => importLineage(input)).toThrow('Goal lifecycle has incoherent Task authority');
  });

  it.each([
    'running',
    'paused',
    'reviewing',
    'completed',
    'blocked',
    'aborted',
    'failed',
  ] as const)('rejects a %s Goal without its complete approved Task set', (status) => {
    const input = createLineageExportInput();
    input.goalRecords = (input.goalRecords ?? []).map((record) => ({
      ...(record as Record<string, unknown>),
      status,
      currentTaskId: null,
    }));
    input.goalTasks = [];
    input.goalReviewRecords = [];
    input.goalVerificationRecords = [];
    input.workerCheckpoints = [];

    expect(() => importLineage(input)).toThrow('Goal lifecycle has incoherent Task authority');
  });

  it.each([
    'ask_user',
    'decompose',
    'block',
  ])('rejects an imported Goal Review with unsupported verdict %s', (verdict) => {
    const verified = writeWorkspaceExportTree(createLineageExportInput());
    const fileContents = new Map(verified.fileContents);
    const path = 'records/goal-review-records.jsonl';
    const record = JSON.parse(fileContents.get(path) ?? '') as Record<string, unknown>;

    fileContents.set(path, JSON.stringify({ ...record, verdict }));

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents },
        targetWorkspaceId,
      })
    ).toThrow();
  });

  it('rejects an imported Goal Review with a partial decision tuple', () => {
    const verified = writeWorkspaceExportTree(createLineageExportInput());
    const fileContents = new Map(verified.fileContents);
    const path = 'records/goal-review-records.jsonl';
    const record = JSON.parse(fileContents.get(path) ?? '') as Record<string, unknown>;

    fileContents.set(path, JSON.stringify({ ...record, verdict: 'accept' }));

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents },
        targetWorkspaceId,
      })
    ).toThrow();
  });

  it('rejects an imported Goal Review with an unsupported resolution outcome', () => {
    const verified = writeWorkspaceExportTree(createLineageExportInput());
    const fileContents = new Map(verified.fileContents);
    const path = 'records/goal-review-records.jsonl';
    const record = JSON.parse(fileContents.get(path) ?? '') as Record<string, unknown>;

    fileContents.set(
      path,
      JSON.stringify({
        ...record,
        verdict: 'abort',
        reason: 'Abort the Goal.',
        resolvedAt: timestamp,
        resolutionRequestId: 'goal-review-resolution-1',
        resolvedByActorId: 'user_source',
        resolutionSnapshot: {
          outcome: 'blocked',
          task: { taskId: source.taskId, status: 'failed' },
          goal: {
            goalId: source.goalId,
            status: 'aborted',
            currentTaskId: null,
            terminalStopReason: 'aborted',
          },
          nextReadyTaskId: null,
        },
      })
    );

    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents },
        targetWorkspaceId,
      })
    ).toThrow();
  });

  it('rewrites every canonical reference, including both AEP layers', () => {
    const input = createLineageExportInput();
    input.workspaceReconciliationRecords = [
      {
        id: 'wrr_source',
        workspaceId: source.workspaceId,
        triggerReason: 'restart',
        affectedRecordIds: ['wmr_source'],
        backendHandleSummary: {
          backendKind: 'openshell',
          handleId: 'bwh_source',
          workerSessionId: 'worker_source',
          cleanupStatus: 'pending',
        },
        backendReachability: { status: 'unknown', checkedAt: timestamp, detail: null },
        collectedOutputManifestIds: ['wom_source'],
        evidenceBundleIds: ['evb_source'],
        stateBefore: 'ready',
        stateAfter: 'requires-human',
        quarantineRefs: [],
        requiredHumanDecision: 'inspect_recovery',
        retentionDecision: 'teardown-backend',
        startedAt: timestamp,
        finishedAt: null,
      },
    ];
    const sourceSnapshotId = input.agentEnvironmentPackageSnapshots![0]!.snapshotId;
    const imported = importLineage(input);
    const thread = imported.threads[0]!;
    const turn = imported.turns[0]!;
    const item = imported.itemRevisions[0]!;
    const planItem = imported.itemRevisions.find((candidate) => candidate.type === 'plan');
    const approvalItem = imported.itemRevisions.find(
      (candidate) => candidate.type === 'approval-request'
    );
    const artifactReferenceItem = imported.itemRevisions.find(
      (candidate) => candidate.type === 'artifact-reference'
    );
    const artifact = imported.artifacts[0]!;
    const session = imported.agentSessions[0]!;
    const aep = imported.agentEnvironmentPackageSnapshots[0]!;
    const goal = imported.goalRecords[0]!;
    const plan = imported.goalPlanRecords[0]!;
    const task = imported.goalTasks[0]!;
    const grant = imported.vaultGrants[0]!;

    if (
      approvalItem?.type !== 'approval-request' ||
      artifactReferenceItem?.type !== 'artifact-reference' ||
      planItem?.type !== 'plan'
    ) {
      throw new Error('Expected imported Plan, approval request, and artifact-reference items.');
    }

    expect.soft(artifactReferenceItem).toMatchObject({
      artifactId: artifact.id,
      artifactVersion: artifact.version,
    });
    expect.soft(approvalItem.causationId).toBe(item.id);
    expect.soft(artifactReferenceItem.id).toBe(artifactReferenceItemId(artifact.id, turn.id));
    expect.soft(artifact.origin).toMatchObject({
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
    });
    expect.soft(session.environmentPackageSnapshotId).toBe(aep.snapshotId);
    expect.soft(session).toMatchObject({
      sandboxSummary: null,
      configVersion: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: true,
      status: 'closed',
      workspaceRoots: [],
    });
    expect.soft(JSON.stringify(session)).not.toContain('/private/source/workspace');
    expect.soft(aep.snapshotId).not.toBe(sourceSnapshotId);
    const importedPackage = AgentEnvironmentPackageSchema.parse(aep.snapshot);
    expect.soft(importedPackage.extensions.openkit).toMatchObject({
      sessionWorkspace: planSessionWorkspaceMaterialization({
        environmentPackage: importedPackage,
      }),
    });
    expect
      .soft(JSON.stringify(importedPackage))
      .not.toContain(`/openkit/sessions/${source.sessionId}/`);
    expect.soft(aep).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      agentSessionId: session.id,
      snapshot: {
        snapshotId: aep.snapshotId,
        packageId: aep.packageId,
        scope: {
          workspaceId: targetWorkspaceId,
          threadId: thread.id,
          turnId: turn.id,
          agentSessionId: session.id,
          itemId: item.id,
        },
      },
    });
    expect.soft(imported.resolvedAgentSetups[0]!.turnId).toBe(turn.id);
    expect.soft(imported.workerCheckpoints[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      workerSessionId: 'worker_source',
      requestId: 'request_source',
      requestInputHash: 'sha256:request-source',
    });
    expect.soft(imported.goalRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      createdByItemId: item.id,
      planItemId: planItem.id,
    });
    expect.soft(plan).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      goalId: goal.goalId,
      planItemId: planItem.id,
      createdByRequestId: 'goal-plan-source-1',
      tasks: [{ taskId: task.taskId }],
    });
    expect
      .soft(planItem.steps.map((step) => step.id))
      .toEqual(plan.tasks.map((entry) => entry.taskId));
    expect.soft(plan.planDigest).toBe(computeGoalPlanDigest(plan));
    expect.soft(plan.tasks[0]?.resources).toEqual([
      {
        kind: 'item',
        reference: item.id,
        reason: 'The source Item carries the task context.',
      },
      {
        kind: 'artifact',
        reference: artifact.id,
        reason: 'The source Artifact carries the task evidence.',
      },
    ]);
    expect.soft(task).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      goalId: goal.goalId,
      planItemId: planItem.id,
      taskId: plan.tasks[0]?.taskId,
      resources: plan.tasks[0]?.resources,
    });
    expect.soft(imported.goalReviewRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      itemIds: [item.id],
      artifactIds: [artifact.id],
      prompt: 'Review the portable Task evidence.',
      createdByRequestId: 'goal-step-portable-1',
      verdict: null,
      reason: null,
      revisionInstruction: null,
      resolvedAt: null,
      resolutionRequestId: null,
      resolvedByActorId: null,
      resolutionSnapshot: null,
    });
    expect.soft(imported.goalVerificationRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      itemIds: [item.id],
      artifactIds: [artifact.id],
    });
    expect.soft(imported.workerOutputManifests[0]!.artifactIds).toEqual([artifact.id]);
    expect
      .soft(imported.workerOutputManifests[0]!.evidenceRefs)
      .toEqual([{ kind: 'worker', ref: turn.id }]);
    expect.soft(imported.workspaceChangeSets[0]).toMatchObject({
      artifactIds: [artifact.id],
      evidenceRefs: [{ kind: 'worker', ref: turn.id }],
      workspaceId: targetWorkspaceId,
    });
    expect.soft(grant).toMatchObject({
      targetAgentSessionId: session.id,
      approvalId: approvalItem.approvalRequestId,
    });
    expect.soft(imported.capabilityCalls[0]).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      agentSessionId: session.id,
    });
    expect.soft(imported.usageRecords[0]).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      agentSessionId: session.id,
    });
    expect.soft(imported.evidenceBundles[0]).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      goalId: goal.goalId,
      agentSessionId: session.id,
      rawEvidenceRefs: [
        { kind: 'thread', ref: thread.id },
        { kind: 'turn', ref: turn.id },
        { kind: 'goal', ref: goal.goalId },
        { kind: 'artifact', ref: artifact.id },
      ],
      redactedEvidenceRefs: [{ kind: 'worker', ref: turn.id }],
    });
    expect
      .soft(imported.workspaceReconciliationRecords[0]?.evidenceBundleIds)
      .toEqual([imported.evidenceBundles[0]?.id]);
    expect.soft(imported.runtimeEvidence[0]).toMatchObject({
      threadId: thread.id,
      turnId: turn.id,
      goalId: goal.goalId,
      agentSessionId: session.id,
    });
    expect.soft(imported.gitPushRecords[0]!.approvalRowId).toBe(approvalItem.approvalRequestId);
    expect.soft(imported.permissionDecisions[0]!.approvalId).toBe(approvalItem.approvalRequestId);
    expect.soft(imported.workspaceRepositories[0]!.git.vaultGrantRef).toBe(grant.grantId);
    expect.soft(imported.dataSourceCatalog?.sources[0]?.vaultGrantRef).toBe(grant.grantId);

    const rewrittenReferences = JSON.stringify({
      agentEnvironmentPackageSnapshots: imported.agentEnvironmentPackageSnapshots,
      capabilityCalls: imported.capabilityCalls,
      evidenceBundles: imported.evidenceBundles,
      gitPushRecords: imported.gitPushRecords,
      permissionDecisions: imported.permissionDecisions,
      runtimeEvidence: imported.runtimeEvidence,
      usageRecords: imported.usageRecords,
      vaultGrants: imported.vaultGrants,
      workerOutputManifests: imported.workerOutputManifests,
      workspaceChangeSets: imported.workspaceChangeSets,
      workspaceReconciliationRecords: imported.workspaceReconciliationRecords,
      workspaceRepositories: imported.workspaceRepositories,
    });
    for (const sourceId of [
      source.approvalId,
      source.artifactId,
      source.goalId,
      source.grantId,
      source.itemId,
      source.sessionId,
      source.threadId,
      source.turnId,
    ]) {
      expect.soft(rewrittenReferences).not.toContain(sourceId);
    }
  });

  it('remints typed Audit resource owners', () => {
    const input = createLineageExportInput();
    input.auditEvents = [
      ['goal', `goal:${source.goalId}`],
      ['goal-task', `goal-task:${source.taskId}`],
      [
        'worker-checkpoint',
        `worker-checkpoint:${source.workspaceId}:${source.threadId}:${source.turnId}`,
      ],
      ['vault-reference', 'vault:vault_source'],
    ].map(([suffix, resource]) => ({
      id: `audit_${suffix}_source`,
      workspaceId: source.workspaceId,
      category: 'system',
      action: `portable.${suffix}`,
      resource,
      outcome: 'succeeded',
      severity: 'info',
      summary: `Portable ${suffix} audit.`,
      occurredAt: timestamp,
    }));

    const imported = importLineage(input);

    expect(imported.auditEvents.map((event) => event.resource)).toEqual(
      expect.arrayContaining([
        `goal:${imported.goalRecords[0]!.goalId}`,
        `goal-task:${imported.goalTasks[0]!.taskId}`,
        `worker-checkpoint:${imported.workerCheckpoints[0]!.checkpointId}`,
        `vault:${imported.vaultReferences[0]!.referenceId}`,
      ])
    );
  });

  it.each([
    ['aep-item', 'it_missing'],
    ['aep-session', /lineage|as_missing/i],
    ['capability-thread', 'th_missing'],
    ['checkpoint-turn', 'tu_missing'],
    ['evidence-goal', 'goal_missing'],
    ['git-approval', 'apr_missing'],
    ['goal-item', 'it_missing'],
    ['permission-approval', 'apr_missing'],
    ['repository-grant', 'grant_missing'],
    ['resolved-turn', 'tu_missing'],
    ['runtime-turn', 'tu_missing'],
    ['sync-artifact', 'ar_missing'],
    ['usage-session', 'as_missing'],
    ['vault-approval', 'apr_missing'],
    ['vault-session', 'as_missing'],
  ] as const)('fails closed when %s references state outside the export', (missing, error) => {
    expect(() => importLineage(createLineageExportInput(missing))).toThrow(error);
  });

  it('exports and remints only the product-safe runtime provenance index', () => {
    const input = createLineageExportInput();
    const packageSnapshotId = input.agentEnvironmentPackageSnapshots![0]!.snapshotId;
    const rawBundleId = 'evb_runtime_raw_source';
    const indexBundleId = 'evb_runtime_index_source';
    const runtimeEvidenceId = 'rte_runtime_source';
    const sourceOriginRef = `rto_${'a'.repeat(24)}`;
    const sourceTurnRef = `rtt_${'b'.repeat(24)}`;
    const indexText = `${JSON.stringify({
      lineage: {
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        packageSnapshotId,
        requestId: 'request_source',
      },
      streamRef: 'stream-0000.jsonl',
      frameSequence: 0,
      byteOffset: 0,
      byteLength: 24,
      frameSha256: `sha256:${'1'.repeat(64)}`,
      eventKind: 'thread.started',
      parseStatus: 'parsed',
      runtimeOriginRef: sourceOriginRef,
      parentRuntimeOriginRef: null,
      runtimeTurnRef: sourceTurnRef,
      runtimeRole: 'worker',
      runtimeDepth: 0,
    })}\n`;
    const indexDigest = `sha256:${createHash('sha256').update(indexText).digest('hex')}`;
    input.evidenceBundles = [
      {
        id: rawBundleId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: null,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-raw',
        summary: 'Restricted runtime provenance.',
        rawEvidenceRefs: [
          { kind: 'worker-runtime-provenance-stream', ref: 'raw/native-canary.jsonl' },
        ],
        redactedEvidenceRefs: [],
        contentDigests: [`sha256:${'2'.repeat(64)}`],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
      },
      {
        id: indexBundleId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: null,
        turnId: source.turnId,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        sourceKind: 'worker-runtime-provenance-index',
        summary: 'Product-safe runtime provenance.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
        ],
        contentDigests: [indexDigest],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
      },
    ];
    input.runtimeEvidence = [
      {
        id: runtimeEvidenceId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        turnId: source.turnId,
        goalId: null,
        taskId: null,
        agentSessionId: source.sessionId,
        backendType: 'openshell',
        backendVersion: '0.0.80',
        placement: 'local',
        phase: 'transcript-collection',
        summary: 'Portable runtime provenance.',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: null,
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: null,
        outcome: 'succeeded',
        exitCode: null,
        signal: null,
        stopReason: null,
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [rawBundleId, indexBundleId],
        contentDigests: [`sha256:${'2'.repeat(64)}`, indexDigest],
        requiredFeatures: ['worker.runtime-provenance.v1'],
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        collectedAt: timestamp,
      },
    ];
    input.runtimeProvenanceIndexes = new Map([[indexBundleId, indexText]]);
    const sourceCacheLineageRef = `rcl_${'c'.repeat(24)}`;
    input.capabilityCalls = [
      {
        ...(input.capabilityCalls?.[0] as Record<string, unknown>),
        packageSnapshotId,
        runtimeOriginRef: sourceOriginRef,
        runtimeCacheLineageRef: sourceCacheLineageRef,
      },
      {
        ...(input.capabilityCalls?.[0] as Record<string, unknown>),
        id: 'cap_source_same_cache_lineage',
        packageSnapshotId,
        runtimeOriginRef: sourceOriginRef,
        runtimeCacheLineageRef: sourceCacheLineageRef,
      },
    ];

    const verified = writeWorkspaceExportTree(input);
    const exportedBundles = readFileSync(
      join(input.exportRoot, 'records', 'evidence-bundles.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exportedBundles.find((bundle) => bundle.id === rawBundleId)).toMatchObject({
      id: rawBundleId,
      importStatus: 'expired',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
    });
    expect(JSON.stringify([...verified.fileContents])).not.toContain('native-canary');
    expect(
      verified.fileContents.get(
        `workspace-files/evidence/bundles/${indexBundleId}/runtime-origin-index.jsonl`
      )
    ).toBe(indexText);
    expect(
      [...verified.fileContents.keys()].some((path) => path.startsWith('evidence/backend/'))
    ).toBe(false);

    const imported = readWorkspaceImportSnapshot({
      verified,
      targetWorkspaceId,
    }) as ReturnType<typeof readWorkspaceImportSnapshot> & {
      runtimeProvenanceIndexes: ReadonlyMap<string, string>;
    };
    const importedRawBundle = imported.evidenceBundles.find(
      (bundle) => bundle.sourceKind === 'worker-runtime-provenance-raw'
    );
    const importedIndexBundle = imported.evidenceBundles.find(
      (bundle) => bundle.sourceKind === 'worker-runtime-provenance-index'
    );
    expect(importedRawBundle).toMatchObject({ importStatus: 'expired', rawEvidenceRefs: [] });
    expect(importedRawBundle?.id).not.toBe(rawBundleId);
    expect(importedIndexBundle?.id).not.toBe(indexBundleId);
    expect(imported.runtimeEvidence[0]?.id).not.toBe(runtimeEvidenceId);
    expect(imported.runtimeEvidence[0]?.evidenceBundleIds).toEqual([
      importedRawBundle?.id,
      importedIndexBundle?.id,
    ]);
    const importedIndexText = imported.runtimeProvenanceIndexes.get(importedIndexBundle?.id ?? '');
    expect(importedIndexText).not.toContain(source.workspaceId);
    expect(importedIndexText).not.toContain(source.threadId);
    expect(importedIndexText).not.toContain(source.turnId);
    expect(importedIndexText).not.toContain(source.sessionId);
    expect(importedIndexText).not.toContain(packageSnapshotId);
    expect(importedIndexText).not.toContain(sourceOriginRef);
    expect(importedIndexText).not.toContain(sourceTurnRef);
    const importedIndexRow = JSON.parse(importedIndexText?.trim() ?? '{}') as {
      lineage?: { packageSnapshotId?: string };
      runtimeOriginRef?: string;
      runtimeTurnRef?: string;
    };
    expect(importedIndexRow.runtimeTurnRef).toMatch(/^rtt_[a-f0-9]{24}$/);
    expect(imported.capabilityCalls[0]).toMatchObject({
      packageSnapshotId: importedIndexRow.lineage?.packageSnapshotId,
      runtimeOriginRef: importedIndexRow.runtimeOriginRef,
    });
    expect(imported.capabilityCalls[0]?.runtimeCacheLineageRef).toMatch(/^rcl_[a-f0-9]{24}$/);
    expect(imported.capabilityCalls[0]?.runtimeCacheLineageRef).not.toBe(sourceCacheLineageRef);
    expect(imported.capabilityCalls[1]?.runtimeCacheLineageRef).toBe(
      imported.capabilityCalls[0]?.runtimeCacheLineageRef
    );
    expect(importedIndexBundle?.contentDigests).toEqual([
      `sha256:${createHash('sha256')
        .update(importedIndexText ?? '')
        .digest('hex')}`,
    ]);

    const unlinkedRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-provenance-unlinked-')),
      'export'
    );
    const unlinked = writeWorkspaceExportTree({
      ...input,
      exportRoot: unlinkedRoot,
      runtimeEvidence: [],
    });
    expect(() =>
      readWorkspaceImportSnapshot({ verified: unlinked, targetWorkspaceId: 'ws_unlinked' })
    ).toThrow(/runtime provenance.*link/i);

    const alternateImport = readWorkspaceImportSnapshot({
      verified,
      targetWorkspaceId: 'ws_imported_alternate',
    });
    expect(alternateImport.capabilityCalls[0]?.runtimeCacheLineageRef).not.toBe(
      imported.capabilityCalls[0]?.runtimeCacheLineageRef
    );

    const unmatchedRoot = join(
      mkdtempSync(join(tmpdir(), 'openkit-workspace-provenance-unmatched-')),
      'export'
    );
    const unmatched = writeWorkspaceExportTree({
      ...input,
      exportRoot: unmatchedRoot,
      capabilityCalls: [
        {
          ...(input.capabilityCalls?.[0] as Record<string, unknown>),
          runtimeOriginRef: `rto_${'f'.repeat(24)}`,
        },
      ],
    });
    expect(() =>
      readWorkspaceImportSnapshot({ verified: unmatched, targetWorkspaceId: 'ws_unmatched' })
    ).toThrow(/runtime origin.*normalized index/i);
  });
});
