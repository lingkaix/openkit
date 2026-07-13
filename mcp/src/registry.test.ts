import { CapabilityUsageResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import type { OpenKitNanoCoreClient } from './nanocore-client.js';
import { createOpenKitAiInterface } from './registry.js';

const requiredTools = [
  'openkit.read_status',
  'openkit.read_runtime_diagnostics',
  'openkit.read_storage_layout_report',
  'openkit.consume_bootstrap_token',
  'openkit.list_openkit_access_tokens',
  'openkit.create_openkit_access_token',
  'openkit.revoke_openkit_access_token',
  'openkit.rotate_openkit_access_token',
  'openkit.create_data_root_backup',
  'openkit.verify_data_root_backup',
  'openkit.read_vault_admin_status',
  'openkit.unlock_vault_admin_backend',
  'openkit.lock_vault_admin_backend',
  'openkit.bootstrap_codex_auth_json_vault_reference',
  'openkit.export_workspace',
  'openkit.dry_run_workspace_import',
  'openkit.import_workspace',
  'openkit.read_workspace_vault_references',
  'openkit.read_workspace_vault_grants',
  'openkit.read_workspace_injection_plans',
  'openkit.read_workspace_injection_receipts',
  'openkit.read_workspace_vault_use_records',
  'openkit.read_vault_use_records',
  'openkit.rebind_workspace_vault_reference',
  'openkit.read_capability_usage',
  'openkit.read_workspace_audit_events',
  'openkit.read_server_audit_events',
  'openkit.read_workspace_permission_decisions',
  'openkit.read_server_permission_decisions',
  'openkit.start_nanocore',
  'openkit.answer_knowledge',
  'openkit.register_knowledge_source',
  'openkit.list_knowledge_sources',
  'openkit.read_knowledge_source',
  'openkit.record_knowledge_observation',
  'openkit.list_knowledge_observations',
  'openkit.record_knowledge_claim',
  'openkit.list_knowledge_claims',
  'openkit.promote_knowledge_claim',
  'openkit.record_knowledge_conflict',
  'openkit.resolve_knowledge_conflict',
  'openkit.list_knowledge_conflicts',
  'openkit.retrieve_knowledge',
  'openkit.read_knowledge_indexes',
  'openkit.prepare_knowledge_context',
  'openkit.read_knowledge_context_package_trace',
  'openkit.read_knowledge_context_package_materialization',
  'openkit.materialize_knowledge_context_package',
  'openkit.draft_knowledge_proposal',
  'openkit.suggest_knowledge_repairs',
  'openkit.check_knowledge_health',
  'openkit.list_interrupted_workers',
  'openkit.clear_interrupted_worker_checkpoint',
  'openkit.retry_interrupted_worker_checkpoint',
  'openkit.retry_scheduler_admission',
  'openkit.cancel_scheduler_admission',
  'openkit.read_scheduler_admissions',
  'openkit.list_recovery_pending_user_turns',
  'openkit.cancel_recovery_pending_user_turn',
  'openkit.edit_recovery_pending_user_turn',
  'openkit.convert_recovery_pending_user_turn_to_follow_up',
  'openkit.promote_recovery_pending_user_turn_to_interrupt',
  'openkit.list_workspaces',
  'openkit.create_workspace',
  'openkit.update_workspace',
  'openkit.list_automations',
  'openkit.create_automation',
  'openkit.update_automation',
  'openkit.delete_automation',
  'openkit.read_workspace_resources',
  'openkit.list_runtime_config_files',
  'openkit.read_runtime_config_file',
  'openkit.validate_runtime_config',
  'openkit.update_runtime_config_file',
  'openkit.reload_runtime_config',
  'openkit.restart_runtime_config_stale_session',
  'openkit.link_repository',
  'openkit.read_repositories',
  'openkit.read_git_push_records',
  'openkit.request_git_push_approval',
  'openkit.execute_git_push',
  'openkit.create_thread',
  'openkit.read_thread',
  'openkit.start_chat',
  'openkit.start_task',
  'openkit.start_goal',
  'openkit.read_goal',
  'openkit.draft_goal_plan',
  'openkit.approve_goal_plan',
  'openkit.revise_goal_plan',
  'openkit.step_goal',
  'openkit.submit_steering',
  'openkit.read_action_center',
  'openkit.resolve_action_center_item',
  'openkit.read_workspace_reviews',
  'openkit.read_workspace_sync_records',
  'openkit.read_workspace_apply_results',
  'openkit.read_agent_environment_package_snapshots',
  'openkit.read_artifact',
] as const;

const requiredResources = [
  'openkit://status',
  'openkit://runtime/diagnostics',
  'openkit://storage/layout-report',
  'openkit://workspaces',
  'openkit://runtime-config/files',
  'openkit://runtime-config/files/{fileId}',
  'openkit://runtime-config/schemas',
  'openkit://workspaces/{workspaceId}/repositories',
  'openkit://workspaces/{workspaceId}/repositories/git-push-records',
  'openkit://workspaces/{workspaceId}/audit/events',
  'openkit://workspaces/{workspaceId}/evidence-bundles',
  'openkit://workspaces/{workspaceId}/runtime-evidence',
  'openkit://audit/events',
  'openkit://workspaces/{workspaceId}/permission-decisions',
  'openkit://permission-decisions',
  'openkit://workspaces/{workspaceId}/vault/references',
  'openkit://workspaces/{workspaceId}/vault/grants',
  'openkit://workspaces/{workspaceId}/vault/injection-plans',
  'openkit://workspaces/{workspaceId}/vault/injection-receipts',
  'openkit://workspaces/{workspaceId}/vault/use-records',
  'openkit://vault/use-records',
  'openkit://workspaces/{workspaceId}/resources',
  'openkit://workspaces/{workspaceId}/action-center',
  'openkit://workspaces/{workspaceId}/workspace-sync/reviews',
  'openkit://workspaces/{workspaceId}/workspace-sync/records',
  'openkit://workspaces/{workspaceId}/workspace-sync/apply-results',
  'openkit://workspaces/{workspaceId}/scheduler/admissions',
  'openkit://workspaces/{workspaceId}/agent-environment/snapshots',
  'openkit://workspaces/{workspaceId}/threads/{threadId}',
  'openkit://workspaces/{workspaceId}/threads/{threadId}/goal',
  'openkit://workspaces/{workspaceId}/threads/{threadId}/items',
  'openkit://workspaces/{workspaceId}/artifacts/{artifactId}',
] as const;

const requiredPrompts = [
  'operate_openkit',
  'run_goal_mode_step',
  'self_improve_openkit',
  'review_openkit_goal_result',
  'write_openkit_change_record',
] as const;

const explicitRequestId = '00000000-0000-4000-8000-000000000001';

interface RecordedCall {
  readonly input: unknown;
  readonly method: string;
}

/** Creates a fake NanoCore facade for registry tests. */
function createFakeNanoCoreClient(): {
  readonly calls: RecordedCall[];
  readonly client: OpenKitNanoCoreClient;
} {
  const calls: RecordedCall[] = [];
  const record = async (method: string, input: unknown): Promise<unknown> => {
    calls.push({ input, method });
    return {
      method,
      input,
      repository: {
        resourceId: 'default',
        displayName: 'OpenKit',
        pathSummary: 'git repository ending in openkit',
      },
      goal: { goalId: 'goal_demo', status: 'running' },
      items: [],
      artifact: { id: 'artifact_demo', title: 'Demo artifact' },
    };
  };

  return {
    calls,
    client: {
      approveGoalPlan: (input) => record('approveGoalPlan', input),
      answerKnowledge: (input) => record('answerKnowledge', input),
      listKnowledgeObservations: (input) => record('listKnowledgeObservations', input),
      listKnowledgeClaims: (input) => record('listKnowledgeClaims', input),
      promoteKnowledgeClaim: (input) => record('promoteKnowledgeClaim', input),
      listKnowledgeConflicts: (input) => record('listKnowledgeConflicts', input),
      listKnowledgeSources: (input) => record('listKnowledgeSources', input),
      readKnowledgeIndexes: (input) => record('readKnowledgeIndexes', input),
      prepareKnowledgeContext: (input) => record('prepareKnowledgeContext', input),
      readKnowledgeContextPackageTrace: (input) =>
        record('readKnowledgeContextPackageTrace', input),
      readKnowledgeContextPackageMaterialization: (input) =>
        record('readKnowledgeContextPackageMaterialization', input),
      materializeKnowledgeContextPackage: (input) =>
        record('materializeKnowledgeContextPackage', input),
      readKnowledgeSource: (input) => record('readKnowledgeSource', input),
      recordKnowledgeObservation: (input) => record('recordKnowledgeObservation', input),
      recordKnowledgeClaim: (input) => record('recordKnowledgeClaim', input),
      recordKnowledgeConflict: (input) => record('recordKnowledgeConflict', input),
      resolveKnowledgeConflict: (input) => record('resolveKnowledgeConflict', input),
      registerKnowledgeSource: (input) => record('registerKnowledgeSource', input),
      retrieveKnowledge: (input) => record('retrieveKnowledge', input),
      draftKnowledgeProposal: (input) => record('draftKnowledgeProposal', input),
      suggestKnowledgeRepairs: (input) => record('suggestKnowledgeRepairs', input),
      checkKnowledgeHealth: (input) => record('checkKnowledgeHealth', input),
      readWorkspaceEvidenceBundles: (input) => record('readWorkspaceEvidenceBundles', input),
      readWorkspaceRuntimeEvidence: (input) => record('readWorkspaceRuntimeEvidence', input),
      consumeBootstrapToken: async (input) => {
        calls.push({ input, method: 'consumeBootstrapToken' });
        return {
          token: 'okt_owner_secret',
          record: {
            expiresAt: '2999-01-01T00:00:00.000Z',
            issuedAt: '2026-07-06T00:00:00.000Z',
            lastUsedAt: null,
            lastUsedChannel: null,
            lastUsedSource: null,
            ownerUserId: 'user_owner',
            predecessorTokenId: null,
            revokedAt: null,
            rotatedGraceExpiresAt: null,
            scope: 'server-admin',
            status: 'active',
            tokenId: 'tok_owner',
            workspaceIds: [],
          },
        };
      },
      listOpenKitAccessTokens: () => record('listOpenKitAccessTokens', {}),
      createOpenKitAccessToken: (input) => record('createOpenKitAccessToken', input),
      revokeOpenKitAccessToken: (input) => record('revokeOpenKitAccessToken', input),
      rotateOpenKitAccessToken: (input) => record('rotateOpenKitAccessToken', input),
      createDataRootBackup: () => record('createDataRootBackup', {}),
      readVaultAdminStatus: () => record('readVaultAdminStatus', {}),
      unlockVaultAdminBackend: (input) => record('unlockVaultAdminBackend', input),
      lockVaultAdminBackend: () => record('lockVaultAdminBackend', {}),
      bootstrapCodexAuthJsonVaultReference: (input) =>
        record('bootstrapCodexAuthJsonVaultReference', input),
      listAutomations: () => record('listAutomations', {}),
      createAutomation: (input) => record('createAutomation', input),
      updateAutomation: (input) => record('updateAutomation', input),
      deleteAutomation: (input) => record('deleteAutomation', input),
      createThread: (input) => record('createThread', input),
      createWorkspace: (input) => record('createWorkspace', input),
      draftGoalPlan: (input) => record('draftGoalPlan', input),
      dryRunWorkspaceImport: (input) => record('dryRunWorkspaceImport', input),
      exportWorkspace: (input) => record('exportWorkspace', input),
      importWorkspace: (input) => record('importWorkspace', input),
      readWorkspaceVaultReferences: (input) => record('readWorkspaceVaultReferences', input),
      readWorkspaceVaultGrants: (input) => record('readWorkspaceVaultGrants', input),
      readWorkspaceInjectionPlans: (input) => record('readWorkspaceInjectionPlans', input),
      readWorkspaceInjectionReceipts: (input) => record('readWorkspaceInjectionReceipts', input),
      readWorkspaceVaultUseRecords: (input) => record('readWorkspaceVaultUseRecords', input),
      readServerVaultUseRecords: () => record('readServerVaultUseRecords', {}),
      rebindWorkspaceVaultReference: (input) => record('rebindWorkspaceVaultReference', input),
      readCapabilityUsage: (input) => record('readCapabilityUsage', input),
      readWorkspaceAuditEvents: (input) => record('readWorkspaceAuditEvents', input),
      readServerAuditEvents: () => record('readServerAuditEvents', {}),
      readWorkspacePermissionDecisions: (input) =>
        record('readWorkspacePermissionDecisions', input),
      readServerPermissionDecisions: () => record('readServerPermissionDecisions', {}),
      executeGitPush: (input) => record('executeGitPush', input),
      linkRepository: (input) => record('linkRepository', input),
      listInterruptedWorkers: () => record('listInterruptedWorkers', {}),
      clearInterruptedWorkerCheckpoint: (input) =>
        record('clearInterruptedWorkerCheckpoint', input),
      retryInterruptedWorkerCheckpoint: (input) =>
        record('retryInterruptedWorkerCheckpoint', input),
      retrySchedulerAdmission: (input) => record('retrySchedulerAdmission', input),
      cancelSchedulerAdmission: (input) => record('cancelSchedulerAdmission', input),
      readSchedulerAdmissions: (input) => record('readSchedulerAdmissions', input),
      listRecoveryPendingUserTurns: (input) => record('listRecoveryPendingUserTurns', input),
      cancelRecoveryPendingUserTurn: (input) => record('cancelRecoveryPendingUserTurn', input),
      editRecoveryPendingUserTurn: (input) => record('editRecoveryPendingUserTurn', input),
      convertRecoveryPendingUserTurnToFollowUp: (input) =>
        record('convertRecoveryPendingUserTurnToFollowUp', input),
      promoteRecoveryPendingUserTurnToInterrupt: (input) =>
        record('promoteRecoveryPendingUserTurnToInterrupt', input),
      listRuntimeConfigFiles: () => record('listRuntimeConfigFiles', {}),
      listWorkspaces: () => record('listWorkspaces', {}),
      readRuntimeConfigFile: (input) => record('readRuntimeConfigFile', input),
      readRuntimeConfigSchemas: () => record('readRuntimeConfigSchemas', {}),
      restartRuntimeConfigStaleSession: (input) =>
        record('restartRuntimeConfigStaleSession', input),
      readActionCenter: (input) => record('readActionCenter', input),
      readArtifact: (input) => record('readArtifact', input),
      readGoal: (input) => record('readGoal', input),
      readGitPushRecords: (input) => record('readGitPushRecords', input),
      readRepositories: (input) => record('readRepositories', input),
      requestGitPushApproval: (input) => record('requestGitPushApproval', input),
      reviseGoalPlan: (input) => record('reviseGoalPlan', input),
      readRuntimeDiagnostics: () => record('readRuntimeDiagnostics', {}),
      readStatus: (input) => record('readStatus', input),
      readStorageLayoutReport: () => record('readStorageLayoutReport', {}),
      readThread: (input) => record('readThread', input),
      readWorkspaceResources: (input) => record('readWorkspaceResources', input),
      readWorkspaceApplyResults: (input) => record('readWorkspaceApplyResults', input),
      readAgentEnvironmentPackageSnapshots: (input) =>
        record('readAgentEnvironmentPackageSnapshots', input),
      readWorkspaceSyncRecords: (input) => record('readWorkspaceSyncRecords', input),
      readWorkspaceReviews: (input) => record('readWorkspaceReviews', input),
      reloadRuntimeConfig: (input) => record('reloadRuntimeConfig', input),
      resolveActionCenterItem: (input) => record('resolveActionCenterItem', input),
      startChat: (input) => record('startChat', input),
      startTask: async (input) => {
        calls.push({ input, method: 'startTask' });
        return {
          completion: {
            itemId: 'it_assistant_task_demo',
            text: 'Task result from NanoCore.',
          },
          evidence: {
            itemIds: ['it_assistant_task_demo'],
            artifactIds: ['ar_task_demo'],
            reviewIds: ['swr_task_demo'],
          },
          state: 'completed',
        };
      },
      startGoal: (input) => record('startGoal', input),
      startNanoCore: (input) => record('startNanoCore', input),
      stepGoal: (input) => record('stepGoal', input),
      submitSteering: (input) => record('submitSteering', input),
      updateRuntimeConfigFile: (input) => record('updateRuntimeConfigFile', input),
      updateWorkspace: (input) => record('updateWorkspace', input),
      validateRuntimeConfig: (input) => record('validateRuntimeConfig', input),
      verifyDataRootBackup: (input) => record('verifyDataRootBackup', input),
    },
  };
}

describe('OpenKit AI Interface registry', () => {
  it('lists the required MCP tools, resources, and prompts', () => {
    const { client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    expect(registry.listTools().map((tool) => tool.name)).toEqual([...requiredTools]);
    expect(registry.listResources().map((resource) => resource.uri)).toEqual([
      ...requiredResources,
    ]);
    expect(
      registry
        .listResources()
        .find((resource) => resource.uri === 'openkit://workspaces/{workspaceId}/resources')
        ?.description
    ).toContain('knowledge');
    expect(registry.listPrompts().map((prompt) => prompt.name)).toEqual([...requiredPrompts]);
  });

  it('exposes stable mutating metadata for MCP tools', () => {
    const { client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });
    const mutatingByName = new Map(
      registry.listTools().map((tool) => [tool.name, tool.mutating] as const)
    );

    expect(
      [...mutatingByName.entries()].filter(([, mutating]) => !mutating).map(([name]) => name)
    ).toEqual([
      'openkit.read_status',
      'openkit.read_runtime_diagnostics',
      'openkit.read_storage_layout_report',
      'openkit.list_openkit_access_tokens',
      'openkit.verify_data_root_backup',
      'openkit.read_vault_admin_status',
      'openkit.dry_run_workspace_import',
      'openkit.read_workspace_vault_references',
      'openkit.read_workspace_vault_grants',
      'openkit.read_workspace_injection_plans',
      'openkit.read_workspace_injection_receipts',
      'openkit.read_workspace_vault_use_records',
      'openkit.read_vault_use_records',
      'openkit.read_capability_usage',
      'openkit.read_workspace_audit_events',
      'openkit.read_server_audit_events',
      'openkit.read_workspace_permission_decisions',
      'openkit.read_server_permission_decisions',
      'openkit.answer_knowledge',
      'openkit.list_knowledge_sources',
      'openkit.read_knowledge_source',
      'openkit.list_knowledge_observations',
      'openkit.list_knowledge_claims',
      'openkit.list_knowledge_conflicts',
      'openkit.read_knowledge_indexes',
      'openkit.prepare_knowledge_context',
      'openkit.read_knowledge_context_package_trace',
      'openkit.read_knowledge_context_package_materialization',
      'openkit.suggest_knowledge_repairs',
      'openkit.check_knowledge_health',
      'openkit.list_interrupted_workers',
      'openkit.read_scheduler_admissions',
      'openkit.list_recovery_pending_user_turns',
      'openkit.list_workspaces',
      'openkit.list_automations',
      'openkit.read_workspace_resources',
      'openkit.list_runtime_config_files',
      'openkit.read_runtime_config_file',
      'openkit.validate_runtime_config',
      'openkit.read_repositories',
      'openkit.read_git_push_records',
      'openkit.read_thread',
      'openkit.read_goal',
      'openkit.read_action_center',
      'openkit.read_workspace_reviews',
      'openkit.read_workspace_sync_records',
      'openkit.read_workspace_apply_results',
      'openkit.read_agent_environment_package_snapshots',
      'openkit.read_artifact',
    ]);
  });

  it('rejects the removed workspace synchronization evidence projection', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await expect(
      registry.callTool('openkit.read_workspace_sync_records', {
        kind: 'sync-evidence-bundles',
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('routes Knowledge Manager proposal drafts through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.draft_knowledge_proposal', {
      requestId: explicitRequestId,
      summary: 'Record that releases are reviewed every Friday.',
      title: 'Release cadence',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'draftKnowledgeProposal',
        input: {
          requestId: explicitRequestId,
          summary: 'Record that releases are reviewed every Friday.',
          title: 'Release cadence',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge proposal drafted.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Source registration through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.register_knowledge_source', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Release notes',
      uri: 'file://release.md',
      content: 'Release cadence is weekly.',
      originatingThreadId: 'th_demo',
    });

    expect(calls).toEqual([
      {
        method: 'registerKnowledgeSource',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          kind: 'document',
          title: 'Release notes',
          uri: 'file://release.md',
          content: 'Release cadence is weekly.',
          originatingThreadId: 'th_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge source registered.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager repair suggestions through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.suggest_knowledge_repairs', {
      limit: 5,
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'suggestKnowledgeRepairs',
        input: { limit: 5, workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge repair suggestions read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Source list and read through read-only tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.list_knowledge_sources', { workspaceId: 'ws_demo' });
    await registry.callTool('openkit.read_knowledge_source', {
      workspaceId: 'ws_demo',
      sourceId: 'ks_demo',
    });

    expect(calls).toEqual([
      {
        method: 'listKnowledgeSources',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'readKnowledgeSource',
        input: { sourceId: 'ks_demo', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('routes Knowledge Observation record and list through MCP tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const recordResponse = await registry.callTool('openkit.record_knowledge_observation', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      kind: 'retrieval',
      summary: 'Worker repeatedly needed release cadence context.',
      sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
      producer: 'knowledge-manager',
      confidence: 0.75,
    });
    const listResponse = await registry.callTool('openkit.list_knowledge_observations', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'recordKnowledgeObservation',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          kind: 'retrieval',
          summary: 'Worker repeatedly needed release cadence context.',
          sourceReferences: ['knowledge:kn_demo', 'source:ks_demo'],
          producer: 'knowledge-manager',
          confidence: 0.75,
        },
      },
      {
        method: 'listKnowledgeObservations',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(recordResponse).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge observation recorded.',
      workspaceId: 'ws_demo',
    });
    expect(listResponse).toMatchObject({
      ok: true,
      summary: 'Knowledge observations read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Claim record and list through MCP tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const recordResponse = await registry.callTool('openkit.record_knowledge_claim', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      statement: 'Release cadence is weekly.',
      sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
      producer: 'knowledge-manager',
      confidence: 0.8,
    });
    const listResponse = await registry.callTool('openkit.list_knowledge_claims', {
      workspaceId: 'ws_demo',
    });
    const promoteResponse = await registry.callTool('openkit.promote_knowledge_claim', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      claimId: 'kc_release',
    });

    expect(calls).toEqual([
      {
        method: 'recordKnowledgeClaim',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          statement: 'Release cadence is weekly.',
          sourceReferences: ['knowledge:release-plan', 'source:ks_release'],
          producer: 'knowledge-manager',
          confidence: 0.8,
        },
      },
      {
        method: 'listKnowledgeClaims',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'promoteKnowledgeClaim',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          claimId: 'kc_release',
        },
      },
    ]);
    expect(recordResponse).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge claim recorded.',
      workspaceId: 'ws_demo',
    });
    expect(listResponse).toMatchObject({
      ok: true,
      summary: 'Knowledge claims read.',
      workspaceId: 'ws_demo',
    });
    expect(promoteResponse).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge claim promoted.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Conflict record and list through MCP tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const recordResponse = await registry.callTool('openkit.record_knowledge_conflict', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
      sourceReferences: ['source:ks_release', 'source:ks_correction'],
      summary: 'Release cadence has contradictory source evidence.',
      producer: 'knowledge-manager',
    });
    const listResponse = await registry.callTool('openkit.list_knowledge_conflicts', {
      workspaceId: 'ws_demo',
    });
    const resolveResponse = await registry.callTool('openkit.resolve_knowledge_conflict', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
      conflictId: 'kf_demo',
      resolution: 'Friday release reviews are authoritative.',
      resolvedBy: 'knowledge-manager',
    });

    expect(calls).toEqual([
      {
        method: 'recordKnowledgeConflict',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          subjectReferences: ['knowledge:release-plan', 'claim:kc_release'],
          sourceReferences: ['source:ks_release', 'source:ks_correction'],
          summary: 'Release cadence has contradictory source evidence.',
          producer: 'knowledge-manager',
        },
      },
      {
        method: 'listKnowledgeConflicts',
        input: { workspaceId: 'ws_demo' },
      },
      {
        method: 'resolveKnowledgeConflict',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
          conflictId: 'kf_demo',
          resolution: 'Friday release reviews are authoritative.',
          resolvedBy: 'knowledge-manager',
        },
      },
    ]);
    expect(recordResponse).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge conflict recorded.',
      workspaceId: 'ws_demo',
    });
    expect(resolveResponse).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Knowledge conflict resolved.',
      workspaceId: 'ws_demo',
    });
    expect(listResponse).toMatchObject({
      ok: true,
      summary: 'Knowledge conflicts read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge retrieval through a trace-writing MCP tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.retrieve_knowledge', {
      workspaceId: 'ws_demo',
      query: 'release cadence',
      limit: 1,
      pinnedConceptIds: ['release-plan'],
    });

    expect(calls).toEqual([
      {
        method: 'retrieveKnowledge',
        input: {
          workspaceId: 'ws_demo',
          query: 'release cadence',
          limit: 1,
          pinnedConceptIds: ['release-plan'],
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge retrieved.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Store index reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_knowledge_indexes', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readKnowledgeIndexes',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge indexes read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager health checks through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.check_knowledge_health', {
      limit: 5,
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'checkKnowledgeHealth',
        input: { limit: 5, workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge health read.',
      workspaceId: 'ws_demo',
    });
  });

  it('validates tool arguments before calling NanoCore', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await expect(
      registry.callTool('openkit.link_repository', {
        displayName: 'OpenKit',
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow(/localPath/);
    expect(calls).toHaveLength(0);

    await expect(
      registry.callTool('openkit.step_goal', {
        requestId: 'not-a-uuid',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow(/Invalid UUID/);
    expect(calls).toHaveLength(0);
  });

  it('rejects unsupported Goal Mode review policy overrides', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await expect(
      registry.callTool('openkit.step_goal', {
        requestId: explicitRequestId,
        reviewPolicyOverride: 'auto',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('routes Knowledge Manager answer requests through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.answer_knowledge', {
      query: 'release cadence',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'answerKnowledge',
        input: { query: 'release cadence', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge answer read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager context material requests through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.prepare_knowledge_context', {
      artifactIds: ['artifact_release_log'],
      query: 'release cadence',
      workspaceId: 'ws_demo',
      workspaceFiles: [{ path: 'docs/release.md' }],
      workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
    });

    expect(calls).toEqual([
      {
        method: 'prepareKnowledgeContext',
        input: {
          artifactIds: ['artifact_release_log'],
          query: 'release cadence',
          workspaceId: 'ws_demo',
          workspaceFiles: [{ path: 'docs/release.md' }],
          workspaceRootFiles: [{ rootId: 'repo_docs', path: 'docs/runtime.md' }],
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge context material read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager context package trace reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_knowledge_context_package_trace', {
      contextPackageId: 'ctxpkg_km_context_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readKnowledgeContextPackageTrace',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge context package trace read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager context package materialization through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.materialize_knowledge_context_package', {
      contextPackageId: 'ctxpkg_km_context_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'materializeKnowledgeContextPackage',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge context package materialized.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Knowledge Manager context package materialization reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool(
      'openkit.read_knowledge_context_package_materialization',
      {
        contextPackageId: 'ctxpkg_km_context_demo',
        workspaceId: 'ws_demo',
      }
    );

    expect(calls).toEqual([
      {
        method: 'readKnowledgeContextPackageMaterialization',
        input: {
          contextPackageId: 'ctxpkg_km_context_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Knowledge context package materialization read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes interrupted worker recovery reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.list_interrupted_workers', {});

    expect(calls).toEqual([{ method: 'listInterruptedWorkers', input: {} }]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Interrupted worker recovery states read.',
    });
  });

  it('routes interrupted worker checkpoint cleanup through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.clear_interrupted_worker_checkpoint', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_worker',
      terminalStage: 'aborted',
    });

    expect(calls).toEqual([
      {
        method: 'clearInterruptedWorkerCheckpoint',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_worker',
          terminalStage: 'aborted',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Interrupted worker checkpoint cleared.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes interrupted worker checkpoint retry through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.retry_interrupted_worker_checkpoint', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_worker',
    });

    expect(calls).toEqual([
      {
        method: 'retryInterruptedWorkerCheckpoint',
        input: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_worker',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Interrupted worker checkpoint queued for retry.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes scheduler admission retry through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.retry_scheduler_admission', {
      workspaceId: 'ws_demo',
      queueEntryId: 'queue_denied',
    });

    expect(calls).toEqual([
      {
        method: 'retrySchedulerAdmission',
        input: {
          workspaceId: 'ws_demo',
          queueEntryId: 'queue_denied',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Scheduler admission queued for retry.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes scheduler admission cancellation through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.cancel_scheduler_admission', {
      workspaceId: 'ws_demo',
      queueEntryId: 'queue_queued',
    });

    expect(calls).toEqual([
      {
        method: 'cancelSchedulerAdmission',
        input: {
          workspaceId: 'ws_demo',
          queueEntryId: 'queue_queued',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Scheduler admission cancelled.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes pending user turn recovery reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.list_recovery_pending_user_turns', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
    });

    expect(calls).toEqual([
      {
        method: 'listRecoveryPendingUserTurns',
        input: { threadId: 'th_demo', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Recovery pending user turns read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes pending user turn cancellation through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.cancel_recovery_pending_user_turn', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: 'req_pending',
    });

    expect(calls).toEqual([
      {
        method: 'cancelRecoveryPendingUserTurn',
        input: { requestId: 'req_pending', threadId: 'th_demo', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Recovery pending user turn cancelled.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes pending user turn edits through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.edit_recovery_pending_user_turn', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      requestId: 'req_pending',
      text: 'Edited pending input.',
    });

    expect(calls).toEqual([
      {
        method: 'editRecoveryPendingUserTurn',
        input: {
          requestId: 'req_pending',
          text: 'Edited pending input.',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Recovery pending user turn edited.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes pending user turn follow-up conversion through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool(
      'openkit.convert_recovery_pending_user_turn_to_follow_up',
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_pending',
      }
    );

    expect(calls).toEqual([
      {
        method: 'convertRecoveryPendingUserTurnToFollowUp',
        input: { requestId: 'req_pending', threadId: 'th_demo', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Recovery pending user turn converted to follow-up.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes pending user turn interrupt promotion through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool(
      'openkit.promote_recovery_pending_user_turn_to_interrupt',
      {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_pending',
      }
    );

    expect(calls).toEqual([
      {
        method: 'promoteRecoveryPendingUserTurnToInterrupt',
        input: { requestId: 'req_pending', threadId: 'th_demo', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Recovery pending user turn promoted to interrupt.',
      workspaceId: 'ws_demo',
    });
  });

  it('generates request IDs and redacts caller-provided local paths from responses', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.link_repository', {
      displayName: 'OpenKit',
      localPath: '/Users/m5pro/Documents/AI/openkit',
      workspaceId: 'ws_demo',
    });

    expect(calls[0]).toMatchObject({
      method: 'linkRepository',
      input: {
        displayName: 'OpenKit',
        localPath: '/Users/m5pro/Documents/AI/openkit',
        requestId: expect.any(String),
        workspaceId: 'ws_demo',
      },
    });
    expect(response).toMatchObject({
      ok: true,
      requestId: expect.any(String),
      summary: 'Repository linked.',
      workspaceId: 'ws_demo',
    });
    expect(JSON.stringify(response)).not.toContain('/Users/m5pro/Documents/AI/openkit');
  });

  it('creates and updates workspaces through MCP-facing product verbs', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.create_workspace', {
      name: 'Customer Project',
      requestId: explicitRequestId,
    });
    await registry.callTool('openkit.update_workspace', {
      defaults: { defaultAgentId: 'agent_default' },
      kind: 'research',
      requestId: explicitRequestId,
      workspaceId: 'ws_customer',
    });

    expect(calls).toEqual([
      {
        method: 'createWorkspace',
        input: {
          name: 'Customer Project',
          requestId: explicitRequestId,
        },
      },
      {
        method: 'updateWorkspace',
        input: {
          defaults: { defaultAgentId: 'agent_default' },
          kind: 'research',
          requestId: explicitRequestId,
          workspaceId: 'ws_customer',
        },
      },
    ]);
  });

  it('routes Chat Mode turns through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.start_chat', {
      input: 'Can you summarize this workspace?',
      model: 'gpt-5-codex',
      providerId: 'openai',
      requestId: explicitRequestId,
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'startChat',
        input: {
          input: 'Can you summarize this workspace?',
          model: 'gpt-5-codex',
          providerId: 'openai',
          requestId: explicitRequestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Chat Mode turn recorded.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });
  });

  it('routes Task Mode turns through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.start_task', {
      input: 'Inspect the repository status once.',
      modelId: 'gpt-5-codex',
      requestId: explicitRequestId,
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'startTask',
        input: {
          input: 'Inspect the repository status once.',
          modelId: 'gpt-5-codex',
          requestId: explicitRequestId,
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      raw: {
        completion: {
          itemId: 'it_assistant_task_demo',
          text: 'Task result from NanoCore.',
        },
        evidence: {
          itemIds: ['it_assistant_task_demo'],
          artifactIds: ['ar_task_demo'],
          reviewIds: ['swr_task_demo'],
        },
        state: 'completed',
      },
      requestId: explicitRequestId,
      summary: 'Task Mode attempt started.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });
  });

  it('routes workspace exports through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.export_workspace', {
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'exportWorkspace',
        input: {
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Workspace export created.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes data-root backup tools through server-managed handles', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const created = await registry.callTool('openkit.create_data_root_backup', {});
    const verified = await registry.callTool('openkit.verify_data_root_backup', {
      backupId: 'drb_demo',
    });

    expect(calls).toEqual([
      { method: 'createDataRootBackup', input: {} },
      { method: 'verifyDataRootBackup', input: { backupId: 'drb_demo' } },
    ]);
    expect(created).toMatchObject({
      ok: true,
      summary: 'Data-root backup created.',
    });
    expect(verified).toMatchObject({
      ok: true,
      summary: 'Data-root backup verified.',
    });
  });

  it('routes workspace import dry-runs through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.dry_run_workspace_import', {
      sourceWorkspaceId: 'ws_demo',
      exportId: 'wsexp_demo',
    });

    expect(calls).toEqual([
      {
        method: 'dryRunWorkspaceImport',
        input: {
          sourceWorkspaceId: 'ws_demo',
          exportId: 'wsexp_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Workspace import dry-run completed.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes capability usage reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const runtimeOriginRef = `rto_${'a'.repeat(24)}`;
    const runtimeCacheLineageRef = `rcl_${'b'.repeat(24)}`;
    client.readCapabilityUsage = async (input) => {
      calls.push({ input, method: 'readCapabilityUsage' });
      return CapabilityUsageResponseSchema.parse({
        capabilityCalls: [
          {
            agentId: 'assistant',
            agentSessionId: 'session_demo',
            capabilityId: 'llm.chat_completions',
            completedAt: '2026-07-13T00:00:00.000Z',
            errorCode: null,
            family: 'llm',
            id: 'cap_demo',
            itemId: null,
            nativeCacheLineageId: 'native-cache-secret',
            nativeSessionId: 'native-session-secret',
            nativeThreadId: 'native-thread-secret',
            operation: 'chat_completions',
            packageSnapshotId: 'aepsnap_demo',
            providerRef: 'openrouter',
            redactionClass: 'metadata-only',
            requestId: '00000000-0000-4000-8000-000000000001',
            runtimeCacheLineageRef,
            runtimeOriginRef,
            serviceRef: 'llm-gateway',
            sourceIds: [],
            startedAt: '2026-07-13T00:00:00.000Z',
            status: 'succeeded',
            summary: 'Gateway call completed.',
            threadId: 'th_demo',
            turnId: 'turn_demo',
            workspaceId: 'ws_demo',
          },
        ],
        usageRecords: [],
        workspaceId: 'ws_demo',
      });
    };
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_capability_usage', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readCapabilityUsage',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      raw: {
        capabilityCalls: [
          {
            packageSnapshotId: 'aepsnap_demo',
            runtimeCacheLineageRef,
            runtimeOriginRef,
          },
        ],
      },
      summary: 'Capability usage read.',
      workspaceId: 'ws_demo',
    });
    expect(JSON.stringify(response)).not.toMatch(/native-(?:cache|session|thread)-secret/);
  });

  it('routes workspace audit event reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_workspace_audit_events', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readWorkspaceAuditEvents',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Workspace audit events read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes server audit event reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_server_audit_events', {});

    expect(calls).toEqual([{ method: 'readServerAuditEvents', input: {} }]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Server audit events read.',
    });
  });

  it('routes workspace permission decision reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_workspace_permission_decisions', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readWorkspacePermissionDecisions',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Workspace permission decisions read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes server permission decision reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_server_permission_decisions', {});

    expect(calls).toEqual([{ method: 'readServerPermissionDecisions', input: {} }]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Server permission decisions read.',
    });
  });

  it('routes Agent Environment Package snapshot reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_agent_environment_package_snapshots', {
      snapshotId: 'aepsnap_1',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readAgentEnvironmentPackageSnapshots',
        input: { snapshotId: 'aepsnap_1', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Agent Environment Package snapshots read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes scheduler admission reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_scheduler_admissions', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readSchedulerAdmissions',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Scheduler admissions read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes bootstrap token consumption without echoing the bootstrap token', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.consume_bootstrap_token', {
      displayName: 'Owner',
      ownerUserId: 'user_owner',
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    expect(response).toMatchObject({
      ok: true,
      summary: 'Server bootstrap token consumed.',
      raw: {
        token: 'okt_owner_secret',
        record: { ownerUserId: 'user_owner', scope: 'server-admin' },
      },
    });
    expect(JSON.stringify(response)).not.toContain('okt_bootstrap_secret');
    expect(calls).toEqual([
      {
        method: 'consumeBootstrapToken',
        input: {
          displayName: 'Owner',
          ownerUserId: 'user_owner',
          token: 'okt_bootstrap_secret',
          tokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
    ]);
  });

  it('stores the consumed bootstrap token only when requested', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const credentialWrites: Array<{ baseUrl: string; token: string }> = [];
    const registry = createOpenKitAiInterface({
      credentialStore: {
        readNanoCoreToken: () => null,
        writeNanoCoreToken: (input) => {
          credentialWrites.push(input);
          return 'encrypted-file';
        },
      },
      nanoCore: client,
      nanoCoreBaseUrl: 'https://nanocore.example.test/',
    });

    const response = await registry.callTool('openkit.consume_bootstrap_token', {
      displayName: 'Owner',
      ownerUserId: 'user_owner',
      storeCredential: true,
      token: 'okt_bootstrap_secret',
      tokenExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    expect(calls).toEqual([
      {
        method: 'consumeBootstrapToken',
        input: {
          displayName: 'Owner',
          ownerUserId: 'user_owner',
          token: 'okt_bootstrap_secret',
          tokenExpiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
    ]);
    expect(credentialWrites).toEqual([
      {
        baseUrl: 'https://nanocore.example.test/',
        token: 'okt_owner_secret',
      },
    ]);
    expect(response).toMatchObject({
      raw: {
        credentialStorageBackend: 'encrypted-file',
        credentialStorageWarning:
          'OpenKit MCP is using encrypted-file NanoCore token storage because no OS keychain token was available.',
      },
    });
  });

  it('routes OpenKit access-token administration through MCP tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.list_openkit_access_tokens', {});
    const created = await registry.callTool('openkit.create_openkit_access_token', {
      expiresAt: '2999-01-01T00:00:00.000Z',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    await registry.callTool('openkit.revoke_openkit_access_token', {
      tokenId: 'tok_workspace',
    });
    await registry.callTool('openkit.rotate_openkit_access_token', {
      graceSeconds: 60,
      tokenId: 'tok_workspace',
    });

    expect(calls).toEqual([
      { method: 'listOpenKitAccessTokens', input: {} },
      {
        method: 'createOpenKitAccessToken',
        input: {
          expiresAt: '2999-01-01T00:00:00.000Z',
          scope: 'workspace',
          workspaceIds: ['ws_demo'],
        },
      },
      { method: 'revokeOpenKitAccessToken', input: { tokenId: 'tok_workspace' } },
      {
        method: 'rotateOpenKitAccessToken',
        input: { graceSeconds: 60, tokenId: 'tok_workspace' },
      },
    ]);
    expect(created).toMatchObject({
      ok: true,
      summary: 'OpenKit access token issued.',
      raw: { method: 'createOpenKitAccessToken' },
    });
  });

  it('routes vault admin operations through MCP tools without echoing secret input', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });
    const masterKeyBase64 = Buffer.alloc(32, 1).toString('base64');
    const authJsonBase64 = Buffer.from('{"tokens":{"openai":"secret"}}').toString('base64');

    await registry.callTool('openkit.read_vault_admin_status', {});
    const unlock = await registry.callTool('openkit.unlock_vault_admin_backend', {
      masterKeyBase64,
    });
    await registry.callTool('openkit.lock_vault_admin_backend', {});
    const bootstrap = await registry.callTool('openkit.bootstrap_codex_auth_json_vault_reference', {
      authJsonBase64,
    });

    expect(calls).toEqual([
      { method: 'readVaultAdminStatus', input: {} },
      { method: 'unlockVaultAdminBackend', input: { masterKeyBase64 } },
      { method: 'lockVaultAdminBackend', input: {} },
      {
        method: 'bootstrapCodexAuthJsonVaultReference',
        input: { authJsonBase64 },
      },
    ]);
    expect(unlock).toMatchObject({
      ok: true,
      summary: 'Vault backend unlocked.',
    });
    expect(bootstrap).toMatchObject({
      ok: true,
      summary: 'Codex auth JSON vault reference bootstrapped.',
    });
    expect(JSON.stringify(unlock)).not.toContain(masterKeyBase64);
    expect(JSON.stringify(bootstrap)).not.toContain(authJsonBase64);
  });

  it('routes automation operations through MCP tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.list_automations', {});
    const created = await registry.callTool('openkit.create_automation', {
      cron: '0 9 * * *',
      name: 'Daily review',
      prompt: 'Summarize workspace status.',
      workspaceId: 'ws_demo',
    });
    await registry.callTool('openkit.update_automation', {
      automationId: 'auto_demo',
      status: 'enabled',
    });
    await registry.callTool('openkit.delete_automation', {
      automationId: 'auto_demo',
    });

    expect(calls).toEqual([
      { method: 'listAutomations', input: {} },
      {
        method: 'createAutomation',
        input: {
          cron: '0 9 * * *',
          name: 'Daily review',
          prompt: 'Summarize workspace status.',
          workspaceId: 'ws_demo',
        },
      },
      {
        method: 'updateAutomation',
        input: { automationId: 'auto_demo', status: 'enabled' },
      },
      { method: 'deleteAutomation', input: { automationId: 'auto_demo' } },
    ]);
    expect(created).toMatchObject({
      ok: true,
      summary: 'Automation created.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes workspace vault reference reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_workspace_vault_references', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readWorkspaceVaultReferences',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Workspace vault references read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes workspace vault injection metadata reads through read-only tools', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.read_workspace_vault_grants', { workspaceId: 'ws_demo' });
    await registry.callTool('openkit.read_workspace_injection_plans', {
      workspaceId: 'ws_demo',
    });
    await registry.callTool('openkit.read_workspace_injection_receipts', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      { method: 'readWorkspaceVaultGrants', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceInjectionPlans', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceInjectionReceipts', input: { workspaceId: 'ws_demo' } },
    ]);
  });

  it('routes workspace vault use record reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_workspace_vault_use_records', {
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readWorkspaceVaultUseRecords',
        input: { workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Workspace vault use records read.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes server vault use record reads through a read-only tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.read_vault_use_records', {});

    expect(calls).toEqual([{ method: 'readServerVaultUseRecords', input: {} }]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Server vault use records read.',
    });
  });

  it('routes workspace vault reference rebind through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });
    const materialBase64 = Buffer.from('workspace-secret').toString('base64');

    const response = await registry.callTool('openkit.rebind_workspace_vault_reference', {
      materialBase64,
      referenceId: 'vault_imported',
      requestId: explicitRequestId,
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'rebindWorkspaceVaultReference',
        input: {
          materialBase64,
          referenceId: 'vault_imported',
          requestId: explicitRequestId,
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Workspace vault reference rebound.',
      workspaceId: 'ws_demo',
    });
    expect(JSON.stringify(response)).not.toContain('workspace-secret');
    expect(JSON.stringify(response)).not.toContain(materialBase64);
  });

  it('routes workspace imports through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.import_workspace', {
      sourceWorkspaceId: 'ws_demo',
      exportId: 'wsexp_demo',
      requestId: explicitRequestId,
    });

    expect(calls).toEqual([
      {
        method: 'importWorkspace',
        input: {
          sourceWorkspaceId: 'ws_demo',
          exportId: 'wsexp_demo',
          requestId: explicitRequestId,
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Workspace imported.',
    });
  });

  it('routes runtime config tools through explicit file and reload operations', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.list_runtime_config_files', {});
    await registry.callTool('openkit.read_runtime_config_file', { id: 'server.jsonc' });
    await registry.callTool('openkit.validate_runtime_config', {
      content: '{}',
      id: 'server.jsonc',
    });
    await registry.callTool('openkit.update_runtime_config_file', {
      content: '{}',
      expectedRevision: 'rev_1',
      id: 'server.jsonc',
      kind: 'server',
    });
    await registry.callTool('openkit.update_runtime_config_file', {
      content: '{"schemaVersion":1,"sources":[]}',
      expectedRevision: 'rev_2',
      id: 'workspaces/ws_demo/data-sources.jsonc',
      kind: 'data-source',
    });
    await registry.callTool('openkit.reload_runtime_config', { dryRun: true, mode: 'safe' });
    await registry.callTool('openkit.restart_runtime_config_stale_session', {
      sessionId: 'as_stale',
      workspaceId: 'ws_demo',
    });
    await registry.readResource(
      'openkit://runtime-config/files/workspaces/ws_demo/data-sources.jsonc'
    );

    expect(calls).toEqual([
      { method: 'listRuntimeConfigFiles', input: {} },
      { method: 'readRuntimeConfigFile', input: { id: 'server.jsonc' } },
      {
        method: 'validateRuntimeConfig',
        input: { content: '{}', id: 'server.jsonc' },
      },
      {
        method: 'updateRuntimeConfigFile',
        input: { content: '{}', expectedRevision: 'rev_1', id: 'server.jsonc', kind: 'server' },
      },
      {
        method: 'updateRuntimeConfigFile',
        input: {
          content: '{"schemaVersion":1,"sources":[]}',
          expectedRevision: 'rev_2',
          id: 'workspaces/ws_demo/data-sources.jsonc',
          kind: 'data-source',
        },
      },
      { method: 'reloadRuntimeConfig', input: { dryRun: true, mode: 'safe' } },
      {
        method: 'restartRuntimeConfigStaleSession',
        input: { sessionId: 'as_stale', workspaceId: 'ws_demo' },
      },
      {
        method: 'readRuntimeConfigFile',
        input: { id: 'workspaces/ws_demo/data-sources.jsonc' },
      },
    ]);
  });

  it('routes runtime diagnostics through a read-only public facade operation', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.read_runtime_diagnostics', {});
    await registry.readResource('openkit://runtime/diagnostics');

    expect(calls).toEqual([
      { method: 'readRuntimeDiagnostics', input: {} },
      { method: 'readRuntimeDiagnostics', input: {} },
    ]);
  });

  it('routes storage layout report through a read-only public facade operation', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.read_storage_layout_report' as never, {});
    await registry.readResource('openkit://storage/layout-report');

    expect(calls).toEqual([
      { method: 'readStorageLayoutReport', input: {} },
      { method: 'readStorageLayoutReport', input: {} },
    ]);
  });

  it('preserves caller request IDs and runs one bounded goal step by default', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.step_goal', {
      requestId: explicitRequestId,
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls[0]).toMatchObject({
      method: 'stepGoal',
      input: {
        followUpDrainMode: 'one_at_a_time',
        requestId: explicitRequestId,
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      },
    });
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'One bounded Goal Mode step completed.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });
  });

  it('preserves caller request IDs when requesting Goal Mode plan revisions', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.revise_goal_plan', {
      requestId: explicitRequestId,
      revision: 'Split the plan into smaller review gates.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });

    expect(calls[0]).toMatchObject({
      method: 'reviseGoalPlan',
      input: {
        requestId: explicitRequestId,
        revision: 'Split the plan into smaller review gates.',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
      },
    });
    expect(response).toMatchObject({
      ok: true,
      requestId: explicitRequestId,
      summary: 'Goal Mode plan revision requested.',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
    });
  });

  it('renders prompts with required human review gates', () => {
    const { client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const prompt = registry.getPrompt('self_improve_openkit', {
      objective: 'Improve one AI Interface test.',
      repositoryPath: '/Users/m5pro/Documents/AI/openkit',
      workspaceId: 'ws_demo',
    });

    expect(prompt.messages.map((message) => message.content).join('\n')).toContain(
      'run exactly one bounded worker step'
    );
    expect(prompt.messages.map((message) => message.content).join('\n')).toContain(
      'Do not commit, push, tag, deploy, or trigger external side effects without explicit human approval.'
    );
  });

  it('reads resources through the matching NanoCore facade operations', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const resource = await registry.readResource(
      'openkit://workspaces/ws_demo/threads/th_demo/goal'
    );

    expect(calls[0]).toEqual({
      input: { threadId: 'th_demo', workspaceId: 'ws_demo' },
      method: 'readGoal',
    });
    expect(resource).toMatchObject({
      mimeType: 'application/json',
      uri: 'openkit://workspaces/ws_demo/threads/th_demo/goal',
    });
    expect(resource.text).toContain('goal_demo');
  });

  it('routes runtime config stale-session restart through a mutating tool', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.restart_runtime_config_stale_session', {
      workspaceId: 'ws_demo',
      sessionId: 'as_stale',
    });

    expect(calls).toEqual([
      {
        method: 'restartRuntimeConfigStaleSession',
        input: { sessionId: 'as_stale', workspaceId: 'ws_demo' },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      summary: 'Runtime config stale session restarted.',
      workspaceId: 'ws_demo',
    });
  });

  it('reads workspace and runtime-config resources through public facade operations', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.readResource('openkit://workspaces');
    await registry.readResource('openkit://workspaces/ws_demo/resources');
    await registry.readResource('openkit://workspaces/ws_demo/repositories/git-push-records');
    await registry.readResource('openkit://workspaces/ws_demo/vault/references');
    await registry.readResource('openkit://workspaces/ws_demo/vault/grants');
    await registry.readResource('openkit://workspaces/ws_demo/vault/injection-plans');
    await registry.readResource('openkit://workspaces/ws_demo/vault/injection-receipts');
    await registry.readResource('openkit://workspaces/ws_demo/vault/use-records');
    await registry.readResource('openkit://vault/use-records');
    await registry.readResource('openkit://audit/events');
    await registry.readResource('openkit://workspaces/ws_demo/evidence-bundles');
    await registry.readResource('openkit://workspaces/ws_demo/runtime-evidence');
    await registry.readResource('openkit://workspaces/ws_demo/permission-decisions');
    await registry.readResource('openkit://permission-decisions');
    await registry.readResource('openkit://runtime-config/files');
    await registry.readResource('openkit://runtime-config/schemas');

    expect(calls).toEqual([
      { method: 'listWorkspaces', input: {} },
      { method: 'readWorkspaceResources', input: { workspaceId: 'ws_demo' } },
      { method: 'readGitPushRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceVaultReferences', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceVaultGrants', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceInjectionPlans', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceInjectionReceipts', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceVaultUseRecords', input: { workspaceId: 'ws_demo' } },
      { method: 'readServerVaultUseRecords', input: {} },
      { method: 'readServerAuditEvents', input: {} },
      { method: 'readWorkspaceEvidenceBundles', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspaceRuntimeEvidence', input: { workspaceId: 'ws_demo' } },
      { method: 'readWorkspacePermissionDecisions', input: { workspaceId: 'ws_demo' } },
      { method: 'readServerPermissionDecisions', input: {} },
      { method: 'listRuntimeConfigFiles', input: {} },
      { method: 'readRuntimeConfigSchemas', input: {} },
    ]);
  });

  it('routes Git push record reads through the public facade operation', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    await registry.callTool('openkit.read_git_push_records', {
      pushRecordId: 'gpr_1',
      workspaceId: 'ws_demo',
    });

    expect(calls).toEqual([
      {
        method: 'readGitPushRecords',
        input: { pushRecordId: 'gpr_1', workspaceId: 'ws_demo' },
      },
    ]);
  });

  it('routes Git push approval requests through the public facade operation', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.request_git_push_approval', {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      repositoryResourceId: 'repo_default',
      sourceRef: 'HEAD',
      targetBranch: 'main',
      commitIds: ['abc123'],
    });

    expect(calls).toEqual([
      {
        method: 'requestGitPushApproval',
        input: {
          commitIds: ['abc123'],
          repositoryResourceId: 'repo_default',
          requestId: expect.any(String),
          sourceRef: 'HEAD',
          targetBranch: 'main',
          threadId: 'th_demo',
          turnId: 'tu_demo',
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: expect.any(String),
      summary: 'Git push approval requested.',
      workspaceId: 'ws_demo',
    });
  });

  it('routes approved Git push execution through the public facade operation', async () => {
    const { calls, client } = createFakeNanoCoreClient();
    const registry = createOpenKitAiInterface({ nanoCore: client });

    const response = await registry.callTool('openkit.execute_git_push', {
      workspaceId: 'ws_demo',
      repositoryResourceId: 'repo_default',
      approvalRequestId: 'ap_git_push_1',
    });

    expect(calls).toEqual([
      {
        method: 'executeGitPush',
        input: {
          approvalRequestId: 'ap_git_push_1',
          repositoryResourceId: 'repo_default',
          requestId: expect.any(String),
          workspaceId: 'ws_demo',
        },
      },
    ]);
    expect(response).toMatchObject({
      ok: true,
      requestId: expect.any(String),
      summary: 'Git push executed.',
      workspaceId: 'ws_demo',
    });
  });
});
