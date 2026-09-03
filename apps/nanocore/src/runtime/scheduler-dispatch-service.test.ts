import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  createSchedulerAdmissionEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { startSchedulerDispatchRetryService } from './scheduler-dispatch-service';
import type { TurnExecutor, TurnStartRuntimeContext } from './types';

class RecordingTurnExecutor implements TurnExecutor {
  public readonly capabilities = {
    approvals: false,
    artifacts: false,
    interrupts: true,
    questions: false,
    workspaceConfig: true,
    workspaceKnowledgeEditing: true,
  };
  public readonly eventFamilies = ['turn.started'] as const;
  public readonly calls: Array<{
    context: TurnStartRuntimeContext | undefined;
    input: string;
    store: FsStore;
    turnId: string;
  }> = [];

  /**
   * Records the shared store used by background dispatch.
   *
   * @param store Shared Workspace store selected for the queued admission.
   * @param turnId Turn id selected by the scheduler queue entry.
   * @param input Turn input captured in the scheduler queue entry.
   * @param context Runtime context forwarded to the worker executor.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    this.calls.push({ context, input, store, turnId });
  }

  /** No-op interrupt implementation. */
  public async interruptTurn(): Promise<void> {}
}

/**
 * Creates an isolated migrated Core database for dispatch-service tests.
 *
 * @returns Open Core database handle.
 */
function createMigratedCoreDb() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-scheduler-dispatch-service-')));
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Seeds one active localhost scheduler target.
 *
 * @param coreDb Open Core database handle.
 */
function seedLocalSchedulerTarget(coreDb: ReturnType<typeof createMigratedCoreDb>): void {
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 1,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: 1,
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
    warmSessionTarget: 0,
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observedAt: '2026-07-05T00:00:00.000Z',
    observationSource: 'configured',
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-05T00:00:00.000Z',
    nextProbeAt: '2026-07-05T00:01:00.000Z',
    targetId: 'target_local',
  });
}

describe('scheduler dispatch service', () => {
  it('reads the current runtime snapshot before retrying a queued turn', async () => {
    const coreDb = createMigratedCoreDb();
    const store = new FsStore();
    const workspace = store.createWorkspace('Background dispatch workspace');
    const thread = store.createThread(workspace.id, 'Background dispatch thread');
    const turnExecutor = new RecordingTurnExecutor();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-background-dispatch-repo-'));
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# Background dispatch fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-m', 'initial'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const providerCredentialResolver = vi.fn(() => null);
    const manifest = createTestAgentSetup({ mcpIds: ['echo'] }).manifest;
    const gatewayConfig = createTestGatewayConfig();
    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: 'http://127.0.0.1:11434/v1',
        displayName: 'Background provider',
        id: 'agent-openrouter',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]);
    let currentSnapshot = createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: null,
      gatewayConfig,
      providerRegistry,
    });

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users
            (id, display_name, email, email_verified, created_at, updated_at, kind)
           VALUES ('user_background', 'Background User', 'background@example.com', false, ?, ?, 'human')`
        )
        .run(Date.now(), Date.now());
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_background',
        workspaceId: workspace.id,
      });
      seedLocalSchedulerTarget(coreDb);
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_background',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_background',
        turnInput: 'Run from the owner store',
        triggerActor: { kind: 'user', id: 'user_background' },
        workspaceId: workspace.id,
        workspaceCwd: '/workspace/background',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: repositoryPath,
            workerPath: '/workspace/background',
          },
        ],
        now: () => '2026-07-05T00:00:01.000Z',
      });

      const errors: unknown[] = [];
      const service = startSchedulerDispatchRetryService({
        clearInterval: () => {},
        coreDb,
        createAgentSessionId: () => 'as_background',
        createLeaseId: () => 'lease_background',
        createPlanId: () => 'plan_background',
        dependencies: { providerCredentialResolver },
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        intervalMs: 60_000,
        leaseDurationMs: 900_000,
        maxDispatches: 1,
        onError: (error) => errors.push(error),
        runtimeConfigSnapshot: () => currentSnapshot,
        schedulerEpoch: 1,
        setInterval: () => ({ timer: 'test' }),
        startupTimeoutMs: 120_000,
        store,
        turnExecutor,
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));

      currentSnapshot = createInMemoryRuntimeConfigSnapshot({
        agentManifests: [manifest],
        dataRoot: null,
        gatewayConfig,
        providerRegistry,
        workspaceMcpServerCatalogs: [
          {
            catalog: {
              schemaVersion: 1,
              servers: [
                {
                  allowedTools: ['echo'],
                  approvalRequiredTools: [],
                  credentialBindings: [],
                  deniedTools: [],
                  enabled: true,
                  id: 'echo',
                  pinnedSchemaSnapshotId: null,
                  schemaPolicy: 'tracking',
                  timeoutMs: 60_000,
                  transport: {
                    args: [],
                    command: 'node',
                    environment: {},
                    kind: 'stdio',
                  },
                },
              ],
            },
            path: `workspaces/${workspace.id}/config/mcp-servers.jsonc`,
            workspaceId: workspace.id,
          },
        ],
      });
      const result = await service.runOnce();
      service.stop();

      expect(result?.startedTurns).toHaveLength(1);
      expect(providerCredentialResolver).not.toHaveBeenCalled();
      expect(turnExecutor.calls).toMatchObject([
        { input: 'Run from the owner store', turnId: 'turn_background' },
      ]);
      expect(turnExecutor.calls[0]?.store).toBe(store);
      expect(turnExecutor.calls[0]?.context).toMatchObject({
        agentSetup: {
          manifest,
          profileId: 'default',
          logicalModels: expect.objectContaining({
            preferredLogicalModelId: 'openai/gpt-5.2',
          }),
        },
        workspaceCwd: '/workspace/background',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: repositoryPath,
            workerPath: '/workspace/background',
          },
        ],
        workspaceMcpServerCatalog: expect.objectContaining({
          servers: [expect.objectContaining({ id: 'echo' })],
        }),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
