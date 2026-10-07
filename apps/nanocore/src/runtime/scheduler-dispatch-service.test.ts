import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store';
import { ProviderRegistry } from '../providers/registry';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records';
import { openCoreDb } from '../storage/db';
import { applyMigrations } from '../storage/migrate';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { startSchedulerDispatchRetryService } from './scheduler-dispatch-service';
import type { TurnExecutor, TurnStartRuntimeContext } from './types';

class RecordingTurnExecutor extends SimulatedTurnExecutor {
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
    await super.startTurn(store, turnId, input, context);
  }
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

describe('scheduler dispatch service', () => {
  it('fails the original accepted Turn after preparation failure and reports its original error without retry', async () => {
    const coreDb = createMigratedCoreDb();
    const store = new FsStore({ dataRoot: coreDb.dataRoot });
    const workspace = store.createWorkspace('Transient background workspace');
    const thread = store.createThread(workspace.id, 'Transient background thread');
    const recordingExecutor = new RecordingTurnExecutor({ coreDb });
    const failure = new Error('Transient AgentSession preparation failure');
    const turnExecutor: TurnExecutor = recordingExecutor;
    turnExecutor.prepareAgentSessionForTurn = async () => {
      throw failure;
    };
    const manifest = createTestAgentSetup().manifest;
    let service: ReturnType<typeof startSchedulerDispatchRetryService> | undefined;
    const errors: unknown[] = [];

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO users
            (id, display_name, email, email_verified, created_at, updated_at, kind)
           VALUES ('user_background', 'Background User', 'background@example.invalid', false, ?, ?, 'human')`
        )
        .run(Date.now(), Date.now());
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_background',
        workspaceId: workspace.id,
      });
      recordTestNativeRuntimeTarget(coreDb);
      store.createTurn(
        workspace.id,
        thread.id,
        'Prepare background work',
        { kind: 'user', id: 'user_background' },
        null,
        {
          turnId: 'turn_transient_background',
          agentId: manifest.id,
          status: 'pending',
          executorKind: 'worker',
        }
      );
      store.recordCommandRequest({
        command: 'turn.start',
        requestId: 'request_transient_background',
        scope: { actorId: 'user_background', workspaceId: workspace.id, threadId: thread.id },
        inputHash: 'transient-fixture',
        response: { kind: 'turn', id: 'turn_transient_background' },
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        priorityClass: 'interactive',
        queueEntryId: 'queue_transient_background',
        requestId: 'request_transient_background',
        requestedAgentId: manifest.id,
        requiredPoolConstraints: ['openshell.local'],
        threadId: thread.id,
        turnId: 'turn_transient_background',
        turnInput: 'Prepare background work',
        triggerActor: { kind: 'user', id: 'user_background' },
        workspaceId: workspace.id,
      });
      service = startSchedulerDispatchRetryService({
        clearInterval: () => {},
        coreDb,
        intervalMs: 60_000,
        onError: (error) => errors.push(error),
        runtimeConfigSnapshot: () =>
          createInMemoryRuntimeConfigSnapshot({
            agentManifests: [manifest],
            dataRoot: null,
            gatewayConfig: createTestGatewayConfig(),
            providerRegistry: new ProviderRegistry([
              {
                id: 'agent-openrouter',
                displayName: 'Background provider',
                kind: 'local',
                models: ['openai/gpt-5.2'],
              },
            ]),
          }),
        setInterval: () => ({ timer: 'test' }),
        store,
        turnExecutor,
        executionBackend: recordingExecutor.executionBackend,
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toBe(failure);
      expect(await service.runOnce()).toMatchObject({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'no-queued-entry' },
      });
      expect(errors).toEqual([failure]);
      expect(requireSchedulerAdmissionEntry(coreDb, 'queue_transient_background').status).toBe(
        'admitted'
      );
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT phase, disposition, operation_id, terminal_cause FROM scheduler_execution_attempts'
          )
          .all()
      ).toEqual([
        {
          phase: 'closed',
          disposition: 'not_accepted',
          operation_id: null,
          terminal_cause: 'turn-start-failed',
        },
      ]);
      expect(store.getTurnById('turn_transient_background')).toMatchObject({
        status: 'failed',
        error: { message: failure.message },
      });
      expect(store.listCommandRequests()).toEqual([
        expect.objectContaining({
          requestId: 'request_transient_background',
          response: { kind: 'turn', id: 'turn_transient_background' },
        }),
      ]);
      expect(recordingExecutor.calls).toEqual([]);
    } finally {
      service?.stop();
      coreDb.sqlite.close();
    }
  });

  it('reads the current runtime snapshot before retrying a queued turn', async () => {
    const coreDb = createMigratedCoreDb();
    const store = new FsStore({ dataRoot: coreDb.dataRoot });
    const workspace = store.createWorkspace('Background dispatch workspace');
    const thread = store.createThread(workspace.id, 'Background dispatch thread');
    const turnExecutor = new RecordingTurnExecutor({ coreDb });
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
    admitTestNativeEnvironment(coreDb, manifest);
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
      recordTestNativeRuntimeTarget(coreDb);
      store.createTurn(
        workspace.id,
        thread.id,
        'Run from the owner store',
        { kind: 'user', id: 'user_background' },
        null,
        {
          turnId: 'turn_background',
          agentId: manifest.id,
          status: 'pending',
          executorKind: 'worker',
        }
      );
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        priorityClass: 'interactive',
        profileRef: null,
        queueEntryId: 'queue_background',
        requestId: 'request_background',
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
        createAttemptId: () => 'attempt_background',
        dependencies: { providerCredentialResolver },
        intervalMs: 60_000,
        maxDispatches: 1,
        onError: (error) => errors.push(error),
        runtimeConfigSnapshot: () => currentSnapshot,
        setInterval: () => ({ timer: 'test' }),
        store,
        turnExecutor,
        executionBackend: turnExecutor.executionBackend,
      });
      expect(await service.runOnce()).toMatchObject({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'entry-publication-pending' },
      });
      expect(errors).toEqual([]);
      expect(turnExecutor.calls).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT attempt_id FROM scheduler_execution_attempts').all()
      ).toEqual([]);

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
            path: `workspaces/${workspace.id}/catalog/catalog.json`,
            workspaceId: workspace.id,
          },
        ],
      });
      store.recordCommandRequest({
        command: 'turn.start',
        requestId: 'request_background',
        scope: { actorId: 'user_background', workspaceId: workspace.id, threadId: thread.id },
        inputHash: 'snapshot-fixture',
        response: { kind: 'turn', id: 'turn_background' },
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
