import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
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
    | 'pending-thread'
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
  const turn = {
    id: source.turnId,
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    items: [item, approvalItem],
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
      controlRelayUpstream: 'https://nanocore.local/api/worker-control',
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
    itemRevisions: [item, approvalItem],
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
        redactedEvidenceRefs: [],
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
    pendingUserTurns: [
      {
        pendingTurnId: `${source.workspaceId}:${source.threadId}:request_pending`,
        workspaceId: source.workspaceId,
        threadId: missing === 'pending-thread' ? 'th_missing' : source.threadId,
        requestId: 'request_pending',
        contentItemId: source.itemId,
        contentDigest: 'sha256:pending',
        queueMode: 'follow_up',
        receivedAt: timestamp,
        createdAt: timestamp,
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
        planItemId: source.itemId,
        currentTaskId: source.taskId,
        terminalStopReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    goalTasks: [
      {
        taskId: source.taskId,
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        goalId: source.goalId,
        status: 'reviewing',
        title: 'Portable task',
        objective: 'Verify lineage.',
        orderIndex: 1,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Lineage is portable.'],
        contextBudgetTokens: 1_000,
        verificationChecks: [],
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
        verdict: 'accept',
        reason: 'Portable.',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        resolutionRequestId: null,
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
        evidenceRefs: [],
        collectedAt: timestamp,
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
  it('rewrites every canonical reference, including both AEP layers', () => {
    const input = createLineageExportInput();
    const sourceSnapshotId = (input.agentEnvironmentPackageSnapshots?.[0] as { snapshotId: string })
      .snapshotId;
    const imported = importLineage(input);
    const thread = imported.threads[0]!;
    const turn = imported.turns[0]!;
    const item = imported.itemRevisions[0]!;
    const approvalItem = imported.itemRevisions.find(
      (candidate) => candidate.type === 'approval-request'
    );
    const artifact = imported.artifacts[0]!;
    const session = imported.agentSessions[0]!;
    const aep = imported.agentEnvironmentPackageSnapshots[0]!;
    const goal = imported.goalRecords[0]!;
    const grant = imported.vaultGrants[0]!;

    if (approvalItem?.type !== 'approval-request') {
      throw new Error('Expected imported approval request item.');
    }

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
    expect.soft(imported.pendingUserTurns[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      contentItemId: item.id,
    });
    expect.soft(imported.workerCheckpoints[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      workerSessionId: 'worker_source',
    });
    expect.soft(imported.goalRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      createdByItemId: item.id,
      planItemId: item.id,
    });
    expect.soft(imported.goalReviewRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      itemIds: [item.id],
      artifactIds: [artifact.id],
    });
    expect.soft(imported.goalVerificationRecords[0]).toMatchObject({
      workspaceId: targetWorkspaceId,
      threadId: thread.id,
      turnId: turn.id,
      itemIds: [item.id],
      artifactIds: [artifact.id],
    });
    expect.soft(imported.workerOutputManifests[0]!.artifactIds).toEqual([artifact.id]);
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
    });
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
    ['pending-thread', 'th_missing'],
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
});
