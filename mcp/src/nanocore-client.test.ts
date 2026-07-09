import type { CoreClient } from '@openkit/core-client';
import { describe, expect, it } from 'vitest';
import { createNanoCoreFacade } from './nanocore-client.js';

interface RecordedClientCall {
  readonly input?: unknown;
  readonly method: string;
}

/** Creates a fake public CoreClient for NanoCore facade route-mapping tests. */
function createFakeCoreClient(): {
  readonly calls: RecordedClientCall[];
  readonly client: CoreClient;
} {
  const calls: RecordedClientCall[] = [];
  const record = async (method: string, input?: unknown): Promise<unknown> => {
    calls.push({ input, method });
    return { input, method };
  };
  const actionCenterItems = [
    {
      id: 'row_artifact',
      kind: 'review',
      actions: [{ kind: 'needs_refinement' }],
      source: { type: 'artifact', artifactId: 'artifact_demo' },
    },
    {
      id: 'row_goal_review',
      kind: 'review',
      actions: [{ kind: 'accept' }],
      source: {
        type: 'goal_review',
        threadId: 'th_demo',
        goalId: 'goal_demo',
        reviewId: 'review_demo',
      },
    },
    {
      id: 'row_approval',
      kind: 'approval',
      actions: [{ kind: 'grant_approval' }],
      source: {
        type: 'approval',
        approvalRequestId: 'approval_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
      },
    },
    {
      id: 'row_question',
      kind: 'question',
      actions: [{ kind: 'answer_question' }],
      source: {
        type: 'protocol_item',
        itemType: 'user-input-request',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        itemId: 'it_question',
      },
    },
    {
      id: 'row_workspace_recovery',
      kind: 'blocked_turn',
      actions: [{ kind: 'mark_blocked' }],
      source: {
        type: 'workspace_recovery',
        reconciliationRecordId: 'wrr_demo',
        workspaceId: 'ws_demo',
      },
    },
  ];

  return {
    calls,
    client: {
      actionCenter: {
        listHumanAttention: (workspaceId: string) =>
          record('actionCenter.listHumanAttention', { workspaceId }).then(() => ({
            items: actionCenterItems,
          })),
      },
      app: {
        approveThreadGoalPlan: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.approveThreadGoalPlan', { input, threadId, workspaceId }),
        answerKnowledgeManager: (workspaceId: string, input: unknown) =>
          record('app.answerKnowledgeManager', { input, workspaceId }),
        listKnowledgeSources: (workspaceId: string) =>
          record('app.listKnowledgeSources', { workspaceId }),
        listKnowledgeObservations: (workspaceId: string) =>
          record('app.listKnowledgeObservations', { workspaceId }),
        listKnowledgeClaims: (workspaceId: string) =>
          record('app.listKnowledgeClaims', { workspaceId }),
        listKnowledgeConflicts: (workspaceId: string) =>
          record('app.listKnowledgeConflicts', { workspaceId }),
        readKnowledgeIndexes: (workspaceId: string) =>
          record('app.readKnowledgeIndexes', { workspaceId }),
        retrieveKnowledge: (workspaceId: string, input: unknown) =>
          record('app.retrieveKnowledge', { input, workspaceId }),
        prepareKnowledgeContext: (workspaceId: string, input: unknown) =>
          record('app.prepareKnowledgeContext', { input, workspaceId }),
        readKnowledgeContextPackageTrace: (workspaceId: string, contextPackageId: string) =>
          record('app.readKnowledgeContextPackageTrace', { contextPackageId, workspaceId }),
        readKnowledgeContextPackageMaterialization: (
          workspaceId: string,
          contextPackageId: string
        ) =>
          record('app.readKnowledgeContextPackageMaterialization', {
            contextPackageId,
            workspaceId,
          }),
        materializeKnowledgeContextPackage: (workspaceId: string, contextPackageId: string) =>
          record('app.materializeKnowledgeContextPackage', { contextPackageId, workspaceId }),
        readKnowledgeSource: (workspaceId: string, sourceId: string) =>
          record('app.readKnowledgeSource', { sourceId, workspaceId }),
        recordKnowledgeObservation: (workspaceId: string, input: unknown) =>
          record('app.recordKnowledgeObservation', { input, workspaceId }),
        recordKnowledgeClaim: (workspaceId: string, input: unknown) =>
          record('app.recordKnowledgeClaim', { input, workspaceId }),
        promoteKnowledgeClaim: (workspaceId: string, claimId: string, input: unknown) =>
          record('app.promoteKnowledgeClaim', { claimId, input, workspaceId }),
        recordKnowledgeConflict: (workspaceId: string, input: unknown) =>
          record('app.recordKnowledgeConflict', { input, workspaceId }),
        resolveKnowledgeConflict: (workspaceId: string, conflictId: string, input: unknown) =>
          record('app.resolveKnowledgeConflict', { conflictId, input, workspaceId }),
        registerKnowledgeSource: (workspaceId: string, input: unknown) =>
          record('app.registerKnowledgeSource', { input, workspaceId }),
        suggestKnowledgeRepairs: (workspaceId: string, input: unknown) =>
          record('app.suggestKnowledgeRepairs', { input, workspaceId }),
        createThreadGoalPlan: (workspaceId: string, threadId: string) =>
          record('app.createThreadGoalPlan', { threadId, workspaceId }),
        draftKnowledgeProposal: (workspaceId: string, input: unknown) =>
          record('app.draftKnowledgeProposal', { input, workspaceId }),
        getThreadDashboard: (workspaceId: string, threadId: string) =>
          record('app.getThreadDashboard', { threadId, workspaceId }),
        getThreadGoalSummary: (workspaceId: string, threadId: string) =>
          record('app.getThreadGoalSummary', { threadId, workspaceId }),
        createEvidenceBundle: (workspaceId: string, input: unknown) =>
          record('app.createEvidenceBundle', { input, workspaceId }),
        listWorkspaceEvidenceBundles: (workspaceId: string) =>
          record('app.listWorkspaceEvidenceBundles', { workspaceId }),
        listWorkspaceRuntimeEvidence: (workspaceId: string) =>
          record('app.listWorkspaceRuntimeEvidence', { workspaceId }),
        listWorkspaceSyncReviews: (workspaceId: string) =>
          record('app.listWorkspaceSyncReviews', { workspaceId }),
        getWorkspaceSyncReview: (workspaceId: string, reviewId: string) =>
          record('app.getWorkspaceSyncReview', { reviewId, workspaceId }),
        listWorkspaceInputSnapshots: (workspaceId: string) =>
          record('app.listWorkspaceInputSnapshots', { workspaceId }),
        listWorkspaceMaterializationRecords: (workspaceId: string) =>
          record('app.listWorkspaceMaterializationRecords', { workspaceId }),
        listBackendWorkspaceHandles: (workspaceId: string) =>
          record('app.listBackendWorkspaceHandles', { workspaceId }),
        listWorkerOutputManifests: (workspaceId: string) =>
          record('app.listWorkerOutputManifests', { workspaceId }),
        listWorkspaceChangeSets: (workspaceId: string) =>
          record('app.listWorkspaceChangeSets', { workspaceId }),
        listStagedWorkspaceReviews: (workspaceId: string) =>
          record('app.listStagedWorkspaceReviews', { workspaceId }),
        listWorkspaceApplyPlans: (workspaceId: string) =>
          record('app.listWorkspaceApplyPlans', { workspaceId }),
        listWorkspaceReconciliationRecords: (workspaceId: string) =>
          record('app.listWorkspaceReconciliationRecords', { workspaceId }),
        listWorkspaceQuarantineRecords: (workspaceId: string) =>
          record('app.listWorkspaceQuarantineRecords', { workspaceId }),
        listWorkspaceSyncEvidenceBundles: (workspaceId: string) =>
          record('app.listWorkspaceSyncEvidenceBundles', { workspaceId }),
        listWorkspaceApplyResults: (workspaceId: string) =>
          record('app.listWorkspaceApplyResults', { workspaceId }),
        getWorkspaceApplyResult: (workspaceId: string, applyResultId: string) =>
          record('app.getWorkspaceApplyResult', { applyResultId, workspaceId }),
        listAgentEnvironmentPackageSnapshots: (workspaceId: string) =>
          record('app.listAgentEnvironmentPackageSnapshots', { workspaceId }),
        getAgentEnvironmentPackageSnapshot: (workspaceId: string, snapshotId: string) =>
          record('app.getAgentEnvironmentPackageSnapshot', { snapshotId, workspaceId }),
        getStorageLayoutReport: () => record('app.getStorageLayoutReport'),
        clearInterruptedWorkerCheckpoint: (
          workspaceId: string,
          threadId: string,
          turnId: string,
          input: unknown
        ) =>
          record('app.clearInterruptedWorkerCheckpoint', {
            input,
            threadId,
            turnId,
            workspaceId,
          }),
        retryInterruptedWorkerCheckpoint: (workspaceId: string, threadId: string, turnId: string) =>
          record('app.retryInterruptedWorkerCheckpoint', {
            threadId,
            turnId,
            workspaceId,
          }),
        retrySchedulerAdmission: (workspaceId: string, queueEntryId: string) =>
          record('app.retrySchedulerAdmission', {
            queueEntryId,
            workspaceId,
          }),
        cancelSchedulerAdmission: (workspaceId: string, queueEntryId: string) =>
          record('app.cancelSchedulerAdmission', {
            queueEntryId,
            workspaceId,
          }),
        listSchedulerAdmissions: (workspaceId: string) =>
          record('app.listSchedulerAdmissions', { workspaceId }),
        listWorkspaceAuditEvents: (workspaceId: string) =>
          record('app.listWorkspaceAuditEvents', { workspaceId }),
        listServerAuditEvents: () => record('app.listServerAuditEvents'),
        listWorkspacePermissionDecisions: (workspaceId: string) =>
          record('app.listWorkspacePermissionDecisions', { workspaceId }),
        listServerPermissionDecisions: () => record('app.listServerPermissionDecisions'),
        listRecoveryPendingUserTurns: (workspaceId: string, threadId: string) =>
          record('app.listRecoveryPendingUserTurns', { threadId, workspaceId }),
        cancelRecoveryPendingUserTurn: (workspaceId: string, threadId: string, requestId: string) =>
          record('app.cancelRecoveryPendingUserTurn', { requestId, threadId, workspaceId }),
        convertRecoveryPendingUserTurnToFollowUp: (
          workspaceId: string,
          threadId: string,
          requestId: string
        ) =>
          record('app.convertRecoveryPendingUserTurnToFollowUp', {
            requestId,
            threadId,
            workspaceId,
          }),
        promoteRecoveryPendingUserTurnToInterrupt: (
          workspaceId: string,
          threadId: string,
          requestId: string
        ) =>
          record('app.promoteRecoveryPendingUserTurnToInterrupt', {
            requestId,
            threadId,
            workspaceId,
          }),
        editRecoveryPendingUserTurn: (
          workspaceId: string,
          threadId: string,
          requestId: string,
          input: unknown
        ) =>
          record('app.editRecoveryPendingUserTurn', {
            input,
            requestId,
            threadId,
            workspaceId,
          }),
        listOpenKitAccessTokens: () => record('app.listOpenKitAccessTokens'),
        createOpenKitAccessToken: (input: unknown) => record('app.createOpenKitAccessToken', input),
        revokeOpenKitAccessToken: (tokenId: string) =>
          record('app.revokeOpenKitAccessToken', { tokenId }),
        rotateOpenKitAccessToken: (tokenId: string, input: unknown) =>
          record('app.rotateOpenKitAccessToken', { input, tokenId }),
        consumeBootstrapToken: (input: unknown) => record('app.consumeBootstrapToken', input),
        exportWorkspace: (workspaceId: string) => record('app.exportWorkspace', { workspaceId }),
        dryRunWorkspaceImport: (input: unknown) => record('app.dryRunWorkspaceImport', input),
        importWorkspace: (input: unknown) => record('app.importWorkspace', input),
        getVaultAdminStatus: () => record('app.getVaultAdminStatus'),
        unlockVaultAdminBackend: (input: unknown) => record('app.unlockVaultAdminBackend', input),
        lockVaultAdminBackend: () => record('app.lockVaultAdminBackend'),
        bootstrapCodexAuthJsonVaultReference: (input: unknown) =>
          record('app.bootstrapCodexAuthJsonVaultReference', input),
        listWorkspaceVaultReferences: (workspaceId: string) =>
          record('app.listWorkspaceVaultReferences', { workspaceId }),
        listWorkspaceVaultGrants: (workspaceId: string) =>
          record('app.listWorkspaceVaultGrants', { workspaceId }),
        listWorkspaceInjectionPlans: (workspaceId: string) =>
          record('app.listWorkspaceInjectionPlans', { workspaceId }),
        listWorkspaceInjectionReceipts: (workspaceId: string) =>
          record('app.listWorkspaceInjectionReceipts', { workspaceId }),
        listWorkspaceVaultUseRecords: (workspaceId: string) =>
          record('app.listWorkspaceVaultUseRecords', { workspaceId }),
        listServerVaultUseRecords: () => record('app.listServerVaultUseRecords'),
        rebindWorkspaceVaultReference: (workspaceId: string, referenceId: string, input: unknown) =>
          record('app.rebindWorkspaceVaultReference', { input, referenceId, workspaceId }),
        listAutomations: () => record('app.listAutomations'),
        createAutomation: (input: unknown) => record('app.createAutomation', input),
        updateAutomation: (automationId: string, input: unknown) =>
          record('app.updateAutomation', { automationId, input }),
        deleteAutomation: (automationId: string) =>
          record('app.deleteAutomation', { automationId }),
        runThreadGoalStep: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.runThreadGoalStep', { input, threadId, workspaceId }),
        reviseThreadGoalPlan: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.reviseThreadGoalPlan', { input, threadId, workspaceId }),
        startChatMode: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.startChatMode', { input, threadId, workspaceId }),
        startTaskMode: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.startTaskMode', { input, threadId, workspaceId }),
        startThreadGoal: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.startThreadGoal', { input, threadId, workspaceId }),
        submitArtifactReviewDecision: (workspaceId: string, artifactId: string, input: unknown) =>
          record('app.submitArtifactReviewDecision', { artifactId, input, workspaceId }),
        submitGoalReviewDecision: (
          workspaceId: string,
          threadId: string,
          goalId: string,
          reviewId: string,
          input: unknown
        ) =>
          record('app.submitGoalReviewDecision', {
            goalId,
            input,
            reviewId,
            threadId,
            workspaceId,
          }),
        submitWorkspaceRecoveryDecision: (
          workspaceId: string,
          reconciliationRecordId: string,
          input: unknown
        ) =>
          record('app.submitWorkspaceRecoveryDecision', {
            input,
            reconciliationRecordId,
            workspaceId,
          }),
        submitThreadGoalSteering: (workspaceId: string, threadId: string, input: unknown) =>
          record('app.submitThreadGoalSteering', { input, threadId, workspaceId }),
      },
      core: {
        createWorkspace: (input: unknown) => record('core.createWorkspace', input),
        createThread: (input: unknown) => record('core.createThread', input),
        getWorkspaceResources: (workspaceId: string) =>
          record('core.getWorkspaceResources', { workspaceId }),
        getArtifact: (workspaceId: string, artifactId: string) =>
          record('core.getArtifact', { artifactId, workspaceId }),
        getThread: (workspaceId: string, threadId: string) =>
          record('core.getThread', { threadId, workspaceId }),
        listArtifacts: (workspaceId: string) => record('core.listArtifacts', { workspaceId }),
        listWorkspaces: () => record('core.listWorkspaces'),
        listThreadItems: (workspaceId: string, threadId: string, input: unknown) =>
          record('core.listThreadItems', { input, threadId, workspaceId }),
        meta: () => record('core.meta'),
        respondApproval: (approvalRequestId: string, input: unknown) =>
          record('core.respondApproval', { approvalRequestId, input }),
        startTurn: (input: unknown) => record('core.startTurn', input),
        updateWorkspace: (workspaceId: string, input: unknown) =>
          record('core.updateWorkspace', { input, workspaceId }),
      },
      repositories: {
        diagnostics: (workspaceId: string) => record('repositories.diagnostics', { workspaceId }),
        executeGitPush: (workspaceId: string, resourceId: string, input: unknown) =>
          record('repositories.executeGitPush', { input, resourceId, workspaceId }),
        getGitPushRecord: (workspaceId: string, pushRecordId: string) =>
          record('repositories.getGitPushRecord', { pushRecordId, workspaceId }),
        list: (workspaceId: string) => record('repositories.list', { workspaceId }),
        listGitPushRecords: (workspaceId: string) =>
          record('repositories.listGitPushRecords', { workspaceId }),
        requestGitPushApproval: (workspaceId: string, resourceId: string, input: unknown) =>
          record('repositories.requestGitPushApproval', { input, resourceId, workspaceId }),
        setDefault: (workspaceId: string, input: unknown) =>
          record('repositories.setDefault', { input, workspaceId }),
      },
      runtimeConfig: {
        getFile: (id: string) => record('runtimeConfig.getFile', { id }),
        getSchemas: () => record('runtimeConfig.getSchemas'),
        listFiles: () => record('runtimeConfig.listFiles'),
        reload: (input: unknown) => record('runtimeConfig.reload', input),
        restartStaleSession: (workspaceId: string, sessionId: string) =>
          record('runtimeConfig.restartStaleSession', { sessionId, workspaceId }),
        updateFile: (input: unknown) => record('runtimeConfig.updateFile', input),
        validate: (input: unknown) => record('runtimeConfig.validate', input),
      },
    } as unknown as CoreClient,
  };
}

describe('NanoCore public client facade', () => {
  it('maps status reads to public meta, repository, Action Center, and goal routes', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readStatus({ workspaceId: 'ws_demo', threadId: 'th_demo' });

    expect(calls.map((call) => call.method)).toEqual([
      'core.meta',
      'repositories.diagnostics',
      'actionCenter.listHumanAttention',
      'app.getThreadGoalSummary',
    ]);
  });

  it('routes mutating tools through public clients and forwards request IDs where routes support them', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.createThread({
      requestId: 'req_thread',
      workspaceId: 'ws_demo',
      title: 'AI Interface test',
    });
    await facade.createWorkspace({
      requestId: 'req_workspace',
      name: 'AI Interface workspace',
    });
    await facade.consumeBootstrapToken({
      displayName: 'Owner',
      ownerUserId: 'user_owner',
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    await facade.updateWorkspace({
      requestId: 'req_workspace_update',
      workspaceId: 'ws_demo',
      kind: 'research',
      defaults: { defaultAgentId: 'agent_default' },
    });
    await facade.linkRepository({
      requestId: 'req_repo',
      workspaceId: 'ws_demo',
      displayName: 'OpenKit',
      localPath: '/Users/m5pro/Documents/AI/openkit',
    });
    await facade.startChat({
      requestId: 'req_chat',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      input: 'Can you summarize this workspace?',
      providerId: 'openai',
      model: 'gpt-5-codex',
    });
    await facade.startTask({
      requestId: 'req_task',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      input: 'Inspect the repository status once.',
      modelId: 'gpt-5-codex',
    });
    await facade.startGoal({
      requestId: 'req_goal_start',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      objective: 'Improve one test.',
    });
    await facade.approveGoalPlan({
      requestId: 'req_plan_approve',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      planItemId: 'it_plan',
      plan: { schemaVersion: 1 },
    });
    await facade.reviseGoalPlan({
      requestId: 'req_plan_revise',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      revision: 'Split the plan into smaller review gates.',
    });
    await facade.stepGoal({
      requestId: 'req_step',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      followUpDrainMode: 'one_at_a_time',
    });
    await facade.submitSteering({
      requestId: 'req_steering',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      message: 'Keep the change small.',
    });

    expect(calls).toEqual([
      {
        method: 'core.createThread',
        input: { requestId: 'req_thread', workspaceId: 'ws_demo', name: 'AI Interface test' },
      },
      {
        method: 'core.createWorkspace',
        input: { requestId: 'req_workspace', name: 'AI Interface workspace' },
      },
      {
        method: 'app.consumeBootstrapToken',
        input: {
          displayName: 'Owner',
          ownerUserId: 'user_owner',
          token: 'okt_bootstrap_secret',
          tokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
      {
        method: 'core.updateWorkspace',
        input: {
          workspaceId: 'ws_demo',
          input: {
            requestId: 'req_workspace_update',
            kind: 'research',
            defaults: { defaultAgentId: 'agent_default' },
          },
        },
      },
      {
        method: 'repositories.setDefault',
        input: {
          workspaceId: 'ws_demo',
          input: {
            displayName: 'OpenKit',
            localPath: '/Users/m5pro/Documents/AI/openkit',
          },
        },
      },
      {
        method: 'app.startChatMode',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: {
            input: 'Can you summarize this workspace?',
            requestId: 'req_chat',
            providerId: 'openai',
            model: 'gpt-5-codex',
          },
        },
      },
      {
        method: 'app.startTaskMode',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: {
            input: 'Inspect the repository status once.',
            requestId: 'req_task',
            modelId: 'gpt-5-codex',
          },
        },
      },
      {
        method: 'app.startThreadGoal',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: { objective: 'Improve one test.' },
        },
      },
      {
        method: 'app.approveThreadGoalPlan',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: { planItemId: 'it_plan', plan: { schemaVersion: 1 } },
        },
      },
      {
        method: 'app.reviseThreadGoalPlan',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: {
            requestId: 'req_plan_revise',
            revision: 'Split the plan into smaller review gates.',
          },
        },
      },
      {
        method: 'app.runThreadGoalStep',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: { requestId: 'req_step', followUpDrainMode: 'one_at_a_time' },
        },
      },
      {
        method: 'app.submitThreadGoalSteering',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          input: { requestId: 'req_steering', message: 'Keep the change small.' },
        },
      },
    ]);
  });

  it('routes OpenKit access-token administration through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.listOpenKitAccessTokens();
    await facade.createOpenKitAccessToken({
      expiresAt: '2999-01-01T00:00:00.000Z',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    await facade.revokeOpenKitAccessToken({ tokenId: 'tok_workspace' });
    await facade.rotateOpenKitAccessToken({ graceSeconds: 60, tokenId: 'tok_workspace' });

    expect(calls).toEqual([
      { method: 'app.listOpenKitAccessTokens' },
      {
        method: 'app.createOpenKitAccessToken',
        input: {
          expiresAt: '2999-01-01T00:00:00.000Z',
          scope: 'workspace',
          workspaceIds: ['ws_demo'],
        },
      },
      { method: 'app.revokeOpenKitAccessToken', input: { tokenId: 'tok_workspace' } },
      {
        method: 'app.rotateOpenKitAccessToken',
        input: { tokenId: 'tok_workspace', input: { graceSeconds: 60 } },
      },
    ]);
  });

  it('routes vault admin operations through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readVaultAdminStatus();
    await facade.unlockVaultAdminBackend({ masterKeyBase64: 'master-key' });
    await facade.lockVaultAdminBackend();
    await facade.bootstrapCodexAuthJsonVaultReference({ authJsonBase64: 'auth-json' });

    expect(calls).toEqual([
      { method: 'app.getVaultAdminStatus' },
      { method: 'app.unlockVaultAdminBackend', input: { masterKeyBase64: 'master-key' } },
      { method: 'app.lockVaultAdminBackend' },
      {
        method: 'app.bootstrapCodexAuthJsonVaultReference',
        input: { authJsonBase64: 'auth-json' },
      },
    ]);
  });

  it('routes automation operations through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.listAutomations();
    await facade.createAutomation({
      cron: '0 9 * * *',
      name: 'Daily review',
      prompt: 'Summarize workspace status.',
      workspaceId: 'ws_demo',
    });
    await facade.updateAutomation({ automationId: 'auto_demo', status: 'enabled' });
    await facade.deleteAutomation({ automationId: 'auto_demo' });

    expect(calls).toEqual([
      { method: 'app.listAutomations' },
      {
        method: 'app.createAutomation',
        input: {
          cron: '0 9 * * *',
          name: 'Daily review',
          prompt: 'Summarize workspace status.',
          workspaceId: 'ws_demo',
        },
      },
      {
        method: 'app.updateAutomation',
        input: { automationId: 'auto_demo', input: { status: 'enabled' } },
      },
      { method: 'app.deleteAutomation', input: { automationId: 'auto_demo' } },
    ]);
  });

  it('routes Knowledge Manager answers through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.answerKnowledge({
      query: 'release cadence',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.answerKnowledgeManager',
        input: {
          workspaceId: 'ws_demo',
          input: { caller: 'assistant', query: 'release cadence' },
        },
      },
    ]);
  });

  it('routes Knowledge Manager context material through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.prepareKnowledgeContext({
      artifactIds: ['artifact_release_log'],
      query: 'release cadence',
      workspaceId: 'ws_demo',
      workspaceFiles: [{ path: 'docs/release.md' }],
      workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
    });

    expect(calls).toEqual([
      {
        method: 'app.prepareKnowledgeContext',
        input: {
          workspaceId: 'ws_demo',
          input: {
            artifactIds: ['artifact_release_log'],
            caller: 'workflow-coordinator',
            query: 'release cadence',
            workspaceFiles: [{ path: 'docs/release.md' }],
            workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
          },
        },
      },
    ]);
  });

  it('routes Knowledge Manager context package trace reads through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readKnowledgeContextPackageTrace({
      contextPackageId: 'ctxpkg_km_context_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.readKnowledgeContextPackageTrace',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes Knowledge Manager context package materialization through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.materializeKnowledgeContextPackage({
      contextPackageId: 'ctxpkg_km_context_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.materializeKnowledgeContextPackage',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes Knowledge Manager context package materialization reads through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readKnowledgeContextPackageMaterialization({
      contextPackageId: 'ctxpkg_km_context_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.readKnowledgeContextPackageMaterialization',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes Knowledge Manager proposal drafts through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.draftKnowledgeProposal({
      requestId: '00000000-0000-4000-8000-000000000123',
      summary: 'Record that releases are reviewed every Friday.',
      title: 'Release cadence',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.draftKnowledgeProposal',
        input: {
          workspaceId: 'ws_demo',
          input: {
            caller: 'system',
            confidence: 0.5,
            requestId: '00000000-0000-4000-8000-000000000123',
            sourceReferences: [],
            summary: 'Record that releases are reviewed every Friday.',
            title: 'Release cadence',
          },
        },
      },
    ]);
  });

  it('routes interrupted worker checkpoint cleanup through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.clearInterruptedWorkerCheckpoint({
      terminalStage: 'aborted',
      threadId: 'th_demo',
      turnId: 'turn_worker',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.clearInterruptedWorkerCheckpoint',
        input: {
          input: { terminalStage: 'aborted' },
          threadId: 'th_demo',
          turnId: 'turn_worker',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes interrupted worker checkpoint retry through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.retryInterruptedWorkerCheckpoint({
      threadId: 'th_demo',
      turnId: 'turn_worker',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.retryInterruptedWorkerCheckpoint',
        input: {
          threadId: 'th_demo',
          turnId: 'turn_worker',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes scheduler admission retry through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.retrySchedulerAdmission({
      queueEntryId: 'queue_denied',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.retrySchedulerAdmission',
        input: {
          queueEntryId: 'queue_denied',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes scheduler admission cancellation through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.cancelSchedulerAdmission({
      queueEntryId: 'queue_queued',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.cancelSchedulerAdmission',
        input: {
          queueEntryId: 'queue_queued',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes pending user turn recovery reads through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.listRecoveryPendingUserTurns({
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.listRecoveryPendingUserTurns',
        input: {
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes pending user turn cancellation through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.cancelRecoveryPendingUserTurn({
      requestId: 'req_pending',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.cancelRecoveryPendingUserTurn',
        input: {
          requestId: 'req_pending',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes pending user turn edits through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.editRecoveryPendingUserTurn({
      requestId: 'req_pending',
      text: 'Edited pending input.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.editRecoveryPendingUserTurn',
        input: {
          input: { text: 'Edited pending input.' },
          requestId: 'req_pending',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes pending user turn follow-up conversion through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.convertRecoveryPendingUserTurnToFollowUp({
      requestId: 'req_pending',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.convertRecoveryPendingUserTurnToFollowUp',
        input: {
          requestId: 'req_pending',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes pending user turn interrupt promotion through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.promoteRecoveryPendingUserTurnToInterrupt({
      requestId: 'req_pending',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.promoteRecoveryPendingUserTurnToInterrupt',
        input: {
          requestId: 'req_pending',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('routes Knowledge Source registry calls through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.registerKnowledgeSource({
      requestId: 'req_source',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      content: 'Release cadence is weekly.',
      originatingThreadId: 'th_demo',
    });
    await facade.listKnowledgeSources({ workspaceId: 'ws_demo' });
    await facade.readKnowledgeSource({ workspaceId: 'ws_demo', sourceId: 'ks_demo' });

    expect(calls).toEqual([
      {
        method: 'app.registerKnowledgeSource',
        input: {
          workspaceId: 'ws_demo',
          input: {
            caller: 'system',
            requestId: 'req_source',
            kind: 'document',
            title: 'Release notes',
            uri: 'file://release.md',
            content: 'Release cadence is weekly.',
            originatingThreadId: 'th_demo',
          },
        },
      },
      {
        method: 'app.listKnowledgeSources',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'app.readKnowledgeSource',
        input: { sourceId: 'ks_demo', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('routes Knowledge Store index reads through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readKnowledgeIndexes({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      {
        method: 'app.readKnowledgeIndexes',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('routes Knowledge retrieval through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.retrieveKnowledge({
      workspaceId: 'ws_demo',
      query: 'release cadence',
      limit: 1,
      pinnedConceptIds: ['release-plan'],
    });

    expect(calls).toEqual([
      {
        method: 'app.retrieveKnowledge',
        input: {
          workspaceId: 'ws_demo',
          input: {
            query: 'release cadence',
            limit: 1,
            pinnedConceptIds: ['release-plan'],
          },
        },
      },
    ]);
  });

  it('routes Knowledge Observation ledger calls through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.recordKnowledgeObservation({
      requestId: 'req_observation',
      workspaceId: 'ws_demo',
      kind: 'retrieval',
      summary: 'Worker repeatedly needed release cadence context.',
      sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
      producer: 'knowledge-manager',
      confidence: 0.75,
    });
    await facade.listKnowledgeObservations({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      {
        method: 'app.recordKnowledgeObservation',
        input: {
          workspaceId: 'ws_demo',
          input: {
            requestId: 'req_observation',
            kind: 'retrieval',
            summary: 'Worker repeatedly needed release cadence context.',
            sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
            scope: 'workspace',
            producer: 'knowledge-manager',
            confidence: 0.75,
            freshness: 'current',
            status: 'retained',
          },
        },
      },
      {
        method: 'app.listKnowledgeObservations',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('routes Knowledge Claim ledger calls through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.recordKnowledgeClaim({
      requestId: 'req_claim',
      workspaceId: 'ws_demo',
      statement: 'Release cadence is weekly.',
      sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
      producer: 'knowledge-manager',
      confidence: 0.8,
    });
    await facade.listKnowledgeClaims({ workspaceId: 'ws_demo' });
    await facade.promoteKnowledgeClaim({
      requestId: 'req_claim_promote',
      workspaceId: 'ws_demo',
      claimId: 'kc_release',
    });

    expect(calls).toEqual([
      {
        method: 'app.recordKnowledgeClaim',
        input: {
          workspaceId: 'ws_demo',
          input: {
            requestId: 'req_claim',
            statement: 'Release cadence is weekly.',
            sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
            scope: 'workspace',
            producer: 'knowledge-manager',
            confidence: 0.8,
            freshness: 'current',
            reviewState: 'needs-review',
            conflictStatus: 'none',
          },
        },
      },
      {
        method: 'app.listKnowledgeClaims',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'app.promoteKnowledgeClaim',
        input: {
          workspaceId: 'ws_demo',
          claimId: 'kc_release',
          input: { requestId: 'req_claim_promote', caller: 'system' },
        },
      },
    ]);
  });

  it('routes Knowledge Conflict ledger calls through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.recordKnowledgeConflict({
      requestId: 'req_conflict',
      workspaceId: 'ws_demo',
      subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
      sourceReferences: ['source:ks_release', 'source:ks_correction'],
      summary: 'Release cadence has contradictory source evidence.',
      producer: 'knowledge-manager',
    });
    await facade.listKnowledgeConflicts({ workspaceId: 'ws_demo' });
    await facade.resolveKnowledgeConflict({
      requestId: 'req_resolve_conflict',
      workspaceId: 'ws_demo',
      conflictId: 'kf_demo',
      resolution: 'Friday release reviews are authoritative.',
      resolvedBy: 'knowledge-manager',
    });

    expect(calls).toEqual([
      {
        method: 'app.recordKnowledgeConflict',
        input: {
          workspaceId: 'ws_demo',
          input: {
            requestId: 'req_conflict',
            subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
            sourceReferences: ['source:ks_release', 'source:ks_correction'],
            status: 'conflicting',
            summary: 'Release cadence has contradictory source evidence.',
            suggestedActions: [],
            producer: 'knowledge-manager',
          },
        },
      },
      {
        method: 'app.listKnowledgeConflicts',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'app.resolveKnowledgeConflict',
        input: {
          workspaceId: 'ws_demo',
          conflictId: 'kf_demo',
          input: {
            requestId: 'req_resolve_conflict',
            status: 'resolved',
            resolution: 'Friday release reviews are authoritative.',
            resolvedBy: 'knowledge-manager',
          },
        },
      },
    ]);
  });

  it('routes Knowledge Manager repair suggestions through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.suggestKnowledgeRepairs({
      limit: 5,
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.suggestKnowledgeRepairs',
        input: {
          workspaceId: 'ws_demo',
          input: { caller: 'system', limit: 5 },
        },
      },
    ]);
  });

  it('routes workspace and runtime config setup calls through public clients', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.listWorkspaces();
    await facade.readWorkspaceResources({ workspaceId: 'ws_demo' });
    await facade.listRuntimeConfigFiles();
    await facade.readRuntimeConfigFile({ id: 'server.jsonc' });
    await facade.readRuntimeConfigSchemas();
    await facade.validateRuntimeConfig({
      content: '{}',
      id: 'server.jsonc',
    });
    await facade.updateRuntimeConfigFile({
      content: '{}',
      expectedRevision: 'rev_1',
      id: 'server.jsonc',
      kind: 'server',
    });
    await facade.reloadRuntimeConfig({ dryRun: true, mode: 'safe' });
    await facade.restartRuntimeConfigStaleSession({
      sessionId: 'as_stale',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      { method: 'core.listWorkspaces' },
      { method: 'core.getWorkspaceResources', input: { workspaceId: 'ws_demo' } },
      { method: 'runtimeConfig.listFiles' },
      { method: 'runtimeConfig.getFile', input: { id: 'server.jsonc' } },
      { method: 'runtimeConfig.getSchemas' },
      {
        method: 'runtimeConfig.validate',
        input: { files: [{ content: '{}', id: 'server.jsonc' }], mode: 'safe' },
      },
      {
        method: 'runtimeConfig.updateFile',
        input: { content: '{}', expectedRevision: 'rev_1', id: 'server.jsonc', kind: 'server' },
      },
      { method: 'runtimeConfig.reload', input: { dryRun: true, mode: 'safe' } },
      {
        method: 'runtimeConfig.restartStaleSession',
        input: { sessionId: 'as_stale', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads the storage layout report through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readStorageLayoutReport();

    expect(calls).toEqual([{ method: 'app.getStorageLayoutReport' }]);
  });

  it('exports workspaces through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.exportWorkspace({ requestId: 'req_export', workspaceId: 'ws_demo' });

    expect(calls).toEqual([{ method: 'app.exportWorkspace', input: { workspaceId: 'ws_demo' } }]);
  });

  it('dry-runs workspace imports through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.dryRunWorkspaceImport({
      sourceWorkspaceId: 'ws_demo',
      exportId: 'wsexp_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.dryRunWorkspaceImport',
        input: { sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo' },
      },
    ]);
  });

  it('imports workspaces through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.importWorkspace({
      sourceWorkspaceId: 'ws_demo',
      exportId: 'wsexp_demo',
      requestId: 'req_import',
    });

    expect(calls).toEqual([
      {
        method: 'app.importWorkspace',
        input: { sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo', requestId: 'req_import' },
      },
    ]);
  });

  it('rebinds workspace vault references through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);
    const materialBase64 = Buffer.from('workspace-secret').toString('base64');

    await facade.rebindWorkspaceVaultReference({
      materialBase64,
      referenceId: 'vault_imported',
      requestId: 'req_rebind',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.rebindWorkspaceVaultReference',
        input: {
          input: { materialBase64 },
          referenceId: 'vault_imported',
          workspaceId: 'ws_demo',
        },
      },
    ]);
  });

  it('reads workspace vault references through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceVaultReferences({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      {
        method: 'app.listWorkspaceVaultReferences',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads workspace vault injection metadata through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceVaultGrants({ workspaceId: 'ws_demo' });
    await facade.readWorkspaceInjectionPlans({ workspaceId: 'ws_demo' });
    await facade.readWorkspaceInjectionReceipts({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      { method: 'app.listWorkspaceVaultGrants', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceInjectionPlans', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceInjectionReceipts', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('reads workspace vault use records through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceVaultUseRecords({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      {
        method: 'app.listWorkspaceVaultUseRecords',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads server vault use records through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readServerVaultUseRecords();

    expect(calls).toEqual([
      {
        method: 'app.listServerVaultUseRecords',
        input: undefined,
      },
    ]);
  });

  it('filters Action Center rows without mutating NanoCore state', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    const result = await facade.readActionCenter({
      workspaceId: 'ws_demo',
      kind: 'review',
      limit: 1,
    });

    expect(calls).toEqual([
      { method: 'actionCenter.listHumanAttention', input: { workspaceId: 'ws_demo' } },
    ]);
    expect(result).toMatchObject({
      items: [{ id: 'row_artifact' }],
    });
  });

  it('creates evidence bundles through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.createEvidenceBundle({
      workspaceId: 'ws_demo',
      goalId: 'goal_demo',
      threadId: 'th_demo',
      turnId: 'turn_demo',
    });

    expect(calls).toEqual([
      {
        method: 'app.createEvidenceBundle',
        input: {
          workspaceId: 'ws_demo',
          input: {
            goalId: 'goal_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
          },
        },
      },
    ]);
  });

  it('reads runtime evidence through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceRuntimeEvidence({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      {
        method: 'app.listWorkspaceRuntimeEvidence',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads workspace synchronization reviews through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceReviews({ workspaceId: 'ws_demo' });
    await facade.readWorkspaceReviews({ workspaceId: 'ws_demo', reviewId: 'swr_1' });

    expect(calls).toEqual([
      { method: 'app.listWorkspaceSyncReviews', input: { workspaceId: 'ws_demo' } },
      {
        method: 'app.getWorkspaceSyncReview',
        input: { workspaceId: 'ws_demo', reviewId: 'swr_1' },
      },
    ]);
  });

  it('reads durable workspace apply results through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceApplyResults({ workspaceId: 'ws_demo' });
    await facade.readWorkspaceApplyResults({ workspaceId: 'ws_demo', applyResultId: 'war_1' });

    expect(calls).toEqual([
      { method: 'app.listWorkspaceApplyResults', input: { workspaceId: 'ws_demo' } },
      {
        method: 'app.getWorkspaceApplyResult',
        input: { applyResultId: 'war_1', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads durable Git push records through the public repository client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readGitPushRecords({ workspaceId: 'ws_demo' });
    await facade.readGitPushRecords({ workspaceId: 'ws_demo', pushRecordId: 'gpr_1' });

    expect(calls).toEqual([
      { method: 'repositories.listGitPushRecords', input: { workspaceId: 'ws_demo' } },
      {
        method: 'repositories.getGitPushRecord',
        input: { pushRecordId: 'gpr_1', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('requests Git push approval through the public repository client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.requestGitPushApproval({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      repositoryResourceId: 'repo_default',
      remoteSummary: 'GitHub repository openkit on origin',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
      requestId: '00000000-0000-4000-8000-000000000024',
    });

    expect(calls).toEqual([
      {
        method: 'repositories.requestGitPushApproval',
        input: {
          workspaceId: 'ws_demo',
          resourceId: 'repo_default',
          input: {
            commitIds: ['abc123'],
            remoteSummary: 'GitHub repository openkit on origin',
            requestId: '00000000-0000-4000-8000-000000000024',
            sourceRef: 'HEAD',
            targetBranch: 'main',
            threadId: 'th_demo',
            turnId: 'tu_demo',
          },
        },
      },
    ]);
  });

  it('executes approved Git pushes through the public repository client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.executeGitPush({
      workspaceId: 'ws_demo',
      repositoryResourceId: 'repo_default',
      approvalRequestId: 'ap_git_push_1',
      policyDecisionId: 'pd_repo_push_granted_ap_git_push_1',
      remoteSummary: 'GitHub repository openkit on origin',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
      requestId: '00000000-0000-4000-8000-000000000026',
    });

    expect(calls).toEqual([
      {
        method: 'repositories.executeGitPush',
        input: {
          workspaceId: 'ws_demo',
          resourceId: 'repo_default',
          input: {
            approvalRequestId: 'ap_git_push_1',
            commitIds: ['abc123'],
            policyDecisionId: 'pd_repo_push_granted_ap_git_push_1',
            remoteName: 'origin',
            remoteSummary: 'GitHub repository openkit on origin',
            requestId: '00000000-0000-4000-8000-000000000026',
            sourceRef: 'HEAD',
            targetBranch: 'main',
          },
        },
      },
    ]);
  });

  it('reads durable workspace synchronization records through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceSyncRecords({ workspaceId: 'ws_demo' });
    await facade.readWorkspaceSyncRecords({
      workspaceId: 'ws_demo',
      kind: 'materialization-records',
    });
    await facade.readWorkspaceSyncRecords({ workspaceId: 'ws_demo', kind: 'backend-handles' });
    await facade.readWorkspaceSyncRecords({ workspaceId: 'ws_demo', kind: 'output-manifests' });
    await facade.readWorkspaceSyncRecords({ workspaceId: 'ws_demo', kind: 'change-sets' });
    await facade.readWorkspaceSyncRecords({ workspaceId: 'ws_demo', kind: 'apply-plans' });
    await facade.readWorkspaceSyncRecords({
      workspaceId: 'ws_demo',
      kind: 'reconciliation-records',
    });
    await facade.readWorkspaceSyncRecords({
      workspaceId: 'ws_demo',
      kind: 'quarantine-records',
    });
    await facade.readWorkspaceSyncRecords({
      workspaceId: 'ws_demo',
      kind: 'sync-evidence-bundles',
    });

    expect(calls).toEqual([
      { method: 'app.listWorkspaceInputSnapshots', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceMaterializationRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listBackendWorkspaceHandles', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkerOutputManifests', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceChangeSets', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listStagedWorkspaceReviews', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceApplyPlans', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceReconciliationRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceQuarantineRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceSyncEvidenceBundles', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceMaterializationRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listBackendWorkspaceHandles', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkerOutputManifests', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceChangeSets', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceApplyPlans', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceReconciliationRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceQuarantineRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'app.listWorkspaceSyncEvidenceBundles', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('reads durable Agent Environment Package snapshots through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readAgentEnvironmentPackageSnapshots({ workspaceId: 'ws_demo' });
    await facade.readAgentEnvironmentPackageSnapshots({
      workspaceId: 'ws_demo',
      snapshotId: 'aepsnap_1',
    });

    expect(calls).toEqual([
      { method: 'app.listAgentEnvironmentPackageSnapshots', input: { workspaceId: 'ws_demo' } },
      {
        method: 'app.getAgentEnvironmentPackageSnapshot',
        input: { snapshotId: 'aepsnap_1', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('reads scheduler admissions through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readSchedulerAdmissions({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      { method: 'app.listSchedulerAdmissions', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('reads workspace audit events through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspaceAuditEvents({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      { method: 'app.listWorkspaceAuditEvents', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('reads server audit events through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readServerAuditEvents();

    expect(calls).toEqual([{ method: 'app.listServerAuditEvents' }]);
  });

  it('reads workspace permission decisions through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readWorkspacePermissionDecisions({ workspaceId: 'ws_demo' });

    expect(calls).toEqual([
      { method: 'app.listWorkspacePermissionDecisions', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('reads server permission decisions through the public App API client', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.readServerPermissionDecisions();

    expect(calls).toEqual([{ method: 'app.listServerPermissionDecisions' }]);
  });

  it('resolves supported Action Center row sources through public review and approval routes', async () => {
    const { calls, client } = createFakeCoreClient();
    const facade = createNanoCoreFacade(client);

    await facade.resolveActionCenterItem({
      workspaceId: 'ws_demo',
      rowId: 'row_artifact',
      actionId: 'needs_refinement',
      decision: 'needs_refinement',
      comment: 'Tighten the summary.',
      requestId: 'req_artifact_review',
    });
    await facade.resolveActionCenterItem({
      workspaceId: 'ws_demo',
      rowId: 'row_goal_review',
      actionId: 'accept',
      decision: 'accept',
      requestId: 'req_goal_review',
    });
    await facade.resolveActionCenterItem({
      workspaceId: 'ws_demo',
      rowId: 'row_approval',
      actionId: 'grant_approval',
      decision: 'granted',
      requestId: 'req_approval',
    });
    await facade.resolveActionCenterItem({
      workspaceId: 'ws_demo',
      rowId: 'row_question',
      actionId: 'answer_question',
      decision: 'answer_question',
      comment: 'Use the smallest safe follow-up.',
      requestId: 'req_question',
    });
    await facade.resolveActionCenterItem({
      workspaceId: 'ws_demo',
      rowId: 'row_workspace_recovery',
      actionId: 'mark_blocked',
      decision: 'quarantine',
      comment: 'Keep unsafe material isolated.',
      requestId: 'req_workspace_recovery',
    });

    expect(calls.filter((call) => call.method !== 'actionCenter.listHumanAttention')).toEqual([
      {
        method: 'app.submitArtifactReviewDecision',
        input: {
          workspaceId: 'ws_demo',
          artifactId: 'artifact_demo',
          input: {
            decision: 'needs_refinement',
            requestId: 'req_artifact_review',
            message: 'Tighten the summary.',
          },
        },
      },
      {
        method: 'app.submitGoalReviewDecision',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalId: 'goal_demo',
          reviewId: 'review_demo',
          input: { requestId: 'req_goal_review' },
        },
      },
      {
        method: 'core.respondApproval',
        input: {
          approvalRequestId: 'approval_demo',
          input: {
            decision: 'granted',
            requestId: 'req_approval',
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: 'turn_demo',
          },
        },
      },
      {
        method: 'core.startTurn',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_demo',
          input: 'Use the smallest safe follow-up.',
          requestId: 'req_question',
        },
      },
      {
        method: 'app.submitWorkspaceRecoveryDecision',
        input: {
          workspaceId: 'ws_demo',
          reconciliationRecordId: 'wrr_demo',
          input: {
            decision: 'quarantine',
            requestId: 'req_workspace_recovery',
            message: 'Keep unsafe material isolated.',
          },
        },
      },
    ]);
  });
});
