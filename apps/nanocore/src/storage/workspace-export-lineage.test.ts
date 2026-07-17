import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { computeGoalPlanDigest, GoalPlanOutputSchema } from '../runtime/goal-plan.js';
import {
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const artifactReferenceItem = {
    id: 'it_artifact_source',
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    turnId: source.turnId,
    type: 'artifact-reference',
    status: 'completed',
    artifactId: artifact.id,
    artifactVersion: artifact.version,
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
    agentSessionId: source.sessionId,
    userId: 'user_local',
    backend: {
      workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
      kind: 'openshell',
      sandboxImageRef: 'openkit/worker-codex:dev',
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
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 1, artifactCount: 1, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
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
    agentSessions: [session],
    turnEvents: [],
    resolvedAgentSetups: [
      {
        id: 'ras_source',
        workspaceId: source.workspaceId,
        turnId: missing === 'resolved-turn' ? 'tu_missing' : source.turnId,
        requestId: 'request_source',
        agentId: 'agent_codex_host',
        providerId: 'openai_codex',
        runtimeKind: 'codex',
        runtimeAdapter: 'codex-app-server',
        requiredFeatures: [],
        setup: {},
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

/** Writes and reads one export through the public portability boundary. */
function importLineage(input: WriteWorkspaceExportTreeInput) {
  const verified = writeWorkspaceExportTree(input);
  return readWorkspaceImportSnapshot({
    verified,
    targetWorkspaceId,
  });
}

describe('workspace auxiliary lineage reminting', () => {
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
    const sourceSnapshotId = (input.agentEnvironmentPackageSnapshots?.[0] as { snapshotId: string })
      .snapshotId;
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
    expect.soft(session.environmentPackageSnapshotId).toBe(aep.snapshotId);
    expect.soft(session).toMatchObject({
      sandboxSummary: null,
      configVersion: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: true,
      workspaceRoots: [],
    });
    expect.soft(JSON.stringify(session)).not.toContain('/private/source/workspace');
    expect.soft(aep.snapshotId).not.toBe(sourceSnapshotId);
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
    const packageSnapshotId = (
      input.agentEnvironmentPackageSnapshots?.[0] as { snapshotId: string }
    ).snapshotId;
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
