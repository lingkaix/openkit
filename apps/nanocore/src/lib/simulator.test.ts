import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateWorkspaceMaterialResponseSchema,
  GetThreadMaterialResponseSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  StartTaskModeResponseSchema,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage, WorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { AgentSessionIdSchema, deriveEntityId } from '@openkit/protocol';
import type { WorkerContextPackageTrace } from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as artifactReviews from '../artifact-reviews.js';
import { getArtifactReview } from '../artifact-reviews.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { listWorkerBackendSessions } from '../runtime/worker-backend-sessions.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import * as filePayload from '../storage/artifacts/file-payload.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { SimulatedTurnExecutor } from './simulator.js';
import type { FsStore } from './store.js';

/** Test-only view for fault injection at the real admitted simulator publication boundary. */
interface MaterialProposalPublisher {
  publishMaterialProposals(
    store: FsStore,
    pkg: AgentEnvironmentPackage,
    trace: WorkerContextPackageTrace,
    db: WorkspaceDb,
    recordedAt: string
  ): Promise<void>;
}

/**
 * Opens a migrated Core database for simulator route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-simulator-route-')));

  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  configureNativeRuntimeTarget(coreDb);
  return coreDb;
}

/**
 * Records explicit fresh Native RuntimeTarget evidence for the simulator route fixtures.
 *
 * @param coreDb Migrated Core database handles.
 */
function configureNativeRuntimeTarget(coreDb: CoreDb): void {
  if (!getNanoHostRuntimeTarget(coreDb, 'target_local')) {
    const runtimeTarget = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: readDataRootLayoutMarker(coreDb.dataRoot).deploymentId,
      identityId: 'identity_local',
      observedAt: '2026-07-05T00:00:00.000Z',
      targetId: 'target_local',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...runtimeTarget,
      freshEmpty: true,
      observedAt: '2026-07-05T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
}

/**
 * Links a temporary repository resource for scheduler-backed turn starts.
 *
 * @param app NanoCore app under test.
 */
async function linkRepository(app: ReturnType<typeof createApp>): Promise<string> {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-simulator-repository-'));

  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: repositoryPath,
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
  writeFileSync(join(repositoryPath, 'README.md'), '# Simulator fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  });
  await app.request(
    '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/repositories/default',
    {
      method: 'PUT',
      body: JSON.stringify({
        displayName: 'Simulator repository',
        localPath: repositoryPath,
      }),
      headers: { 'content-type': 'application/json' },
    }
  );
  return repositoryPath;
}

const REMOTE_GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const REMOTE_GIT_URL = 'https://git.example.test/openkit/repository.git';

/** Creates a product-start fixture whose only authored Workspace input is remote Git. */
function createRemoteGitProductFixture(
  locator: Readonly<Record<string, unknown>>,
  vaultGrantRef?: string,
  configuredCanary = false
) {
  const coreDb = createCoreDb();
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const executor = new SimulatedTurnExecutor({ coreDb });
  const providerRegistry = new ProviderRegistry([
    {
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Simulator remote Git inference',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
  const agentSetup = createTestAgentSetup();
  const manifest = {
    ...agentSetup.manifest,
    workspace: {
      inputs: [{ access: 'read-write', id: 'repo_remote', sourceRef: 'main-repo' }],
    },
  };
  const catalog: WorkspaceDataSourceCatalog = {
    extensions: {},
    requiredFeatures: [],
    schemaVersion: 1,
    sources: [
      {
        access: 'read-write',
        allowedSlotKinds: ['worktree'],
        displayName: 'Remote repository',
        extensions: {},
        id: 'main-repo',
        kind: 'git',
        locator,
        requiredFeatures: [],
        sensitivity: 'internal',
        status: 'active',
        syncHints: {},
        ...(vaultGrantRef ? { vaultGrantRef } : {}),
      },
    ],
  };
  const canaryPath = join(
    coreDb.dataRoot,
    'workspaces',
    'ws_00000000-0000-7000-8000-000000000001',
    'invalid-source-canary'
  );
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot: coreDb.dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: coreDb.dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry,
      workspaceConfigs: configuredCanary
        ? [
            {
              config: {
                schemaVersion: 1,
                workspace: {
                  name: 'Demo Workspace',
                  roots: [
                    {
                      access: 'read-write',
                      createIfMissing: true,
                      id: 'invalid-source-canary',
                      kind: 'host-dir',
                      path: 'invalid-source-canary',
                    },
                  ],
                },
              },
              path: join(
                coreDb.dataRoot,
                'workspaces',
                'ws_00000000-0000-7000-8000-000000000001',
                'config',
                'workspace.jsonc'
              ),
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            },
          ]
        : [],
      workspaceDataSourceCatalogs: [
        {
          catalog,
          path: join(
            coreDb.dataRoot,
            'workspaces',
            'ws_00000000-0000-7000-8000-000000000001',
            'config',
            'data-sources.jsonc'
          ),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    }),
  });
  const app = createApp({ coreDb, runtimeConfigManager, store, turnExecutor: executor });

  return { app, canaryPath, coreDb, executor, store };
}

describe('SimulatedTurnExecutor', () => {
  afterEach(() => {
    delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  });

  it('records simulator input and completes the bounded Turn', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new SimulatedTurnExecutor({ coreDb });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Simulator inference',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      store,
      turnExecutor: executor,
    });

    try {
      await linkRepository(app);
      const turnResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              requestId: '0190f4c8-0000-7000-8000-000000000211',
              input: 'Simulated scheduled worker run',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = (await turnResponse.json()) as { id: string };

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      await vi.waitFor(() => expect(store.getTurnById(turn.id).status).toBe('completed'));
      const storedTurn = store.getTurnById(turn.id);
      expect(storedTurn).toMatchObject({
        agentId: 'agent_codex_host',
        agentProfileId: 'default',
        agentSessionId: expect.stringMatching(
          /^as_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        status: 'completed',
      });
      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .some((item) => item.turnId === turn.id && item.type === 'user-input-request')
      ).toBe(true);
      expect(
        executor.getAgentSession(
          store,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        ).id
      ).toBe(storedTurn.agentSessionId);

      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter((item) => item.turnId === turn.id)
          .map((item) => item.type)
      ).toEqual([
        'user-message',
        'user-input-request',
        'assistant-message',
        'reasoning',
        'command-execution',
        'artifact-reference',
      ]);
      expect(
        store
          .listAllItems()
          .filter(
            (item) =>
              item.workspaceId === 'ws_00000000-0000-7000-8000-000000000001' &&
              (item.type === 'approval-request' || item.type === 'approval-decision')
          )
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a mismatched scheduler lease key before any simulator backend effect', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new SimulatedTurnExecutor({ coreDb });
    const agentSetup = createTestAgentSetup();
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Reject a mismatched lease key',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.updateTurn(turn.id, { agentId: agentSetup.manifest.id });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Reject a mismatched lease key', {
          agentSessionId: 'as_00000000-0000-7387-ba49-b05a73884e0c',
          agentSetup,
          requestId: '0190f4c8-0000-7000-8000-000000000220',
          sessionCompatibilityKey: `sha256:${'f'.repeat(64)}`,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('execution attempt SessionCompatibilityKey');
      expect(listWorkerBackendSessions(coreDb)).toEqual([]);
      const workspaceDb = openWorkspaceDb(
        coreDb.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      try {
        expect(
          listExportableAgentEnvironmentPackageSnapshots(
            workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001'
          )
        ).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  // Two real S39 publication and native execution lifecycles use this local runner budget; product deadlines stay unchanged.
  it('reuses one compatible current AgentSession across sequential simulator Turns', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const fileAdmission = new FileStorageAdmission(coreDb.dataRoot, () => 1_000_000n);
    const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
    // HTTP202 admits the Turn; await the actual execution before inspecting terminal state.
    const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    let nextExecution = 0;
    const startTurn = executor.startTurn.bind(executor);
    const executions = vi.spyOn(executor, 'startTurn').mockImplementation((...args) => {
      const completion = startTurn(...args);
      completions[nextExecution++]?.resolve(completion);
      return completion;
    });
    const app = createApp({
      fileAdmission,
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Simulator continuity inference',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      store,
      turnExecutor: executor,
    });

    try {
      await linkRepository(app);
      const firstResponse = await app.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000212',
              input: 'Run the first sequential simulator Turn',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const firstBody = await firstResponse.json();
      expect(firstResponse.status, JSON.stringify(firstBody)).toBe(202);
      const first = StartTaskModeResponseSchema.parse(firstBody);
      await completions[0].promise;
      await vi.waitFor(() => {
        expect(store.getTurnById(first.turn.id).status).toBe('completed');
        expect(
          coreDb.sqlite
            .prepare('SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ?')
            .get(first.turn.id)
        ).toEqual({ phase: 'closed' });
      });
      const storedFirstTurn = store.getTurnById(first.turn.id);
      if (!storedFirstTurn.agentSessionId) {
        throw new Error('Expected the first simulator Turn and its AgentSession.');
      }
      expect(storedFirstTurn.status).toBe('completed');
      const agentSessionId = storedFirstTurn.agentSessionId;
      expect(store.getAgentSession(agentSessionId).status).toBe('idle');
      expect(store.getAgentSession(agentSessionId)).toMatchObject({
        sessionCompatibilityKey: expect.any(String),
        stale: false,
        status: 'idle',
      });

      const secondResponse = await app.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000214',
              input: 'Run the second sequential simulator Turn',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const secondBody = await secondResponse.clone().text();
      expect.soft(secondResponse.status, secondBody).toBe(202);
      const acceptedSecond = StartTaskModeResponseSchema.parse(JSON.parse(secondBody));
      await completions[1].promise;
      await vi.waitFor(() =>
        expect(store.getTurnById(acceptedSecond.turn.id).status).toBe('completed')
      );
      const secondTurn = store
        .listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .find((turn) => turn.id !== first.turn.id && turn.agentId === 'agent_codex_host');
      expect.soft(secondTurn).toMatchObject({
        agentSessionId,
        status: 'completed',
      });
      const leases = coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, attempt_id AS leaseId, turn_id AS turnId
           FROM scheduler_execution_attempts
           WHERE turn_id IN (?, ?)
           ORDER BY turn_id`
        )
        .all(first.turn.id, secondTurn?.id ?? 'missing') as Array<{
        agentSessionId: string;
        leaseId: string;
        turnId: string;
      }>;
      expect.soft(leases).toHaveLength(2);
      expect
        .soft(new Set(leases.map((lease) => lease.agentSessionId)))
        .toEqual(new Set([agentSessionId]));
      expect.soft(new Set(leases.map((lease) => lease.leaseId)).size).toBe(2);
      expect.soft(new Set(leases.map((lease) => lease.turnId)).size).toBe(2);
    } finally {
      executions.mockRestore();
      coreDb.sqlite.close();
    }
  }, 60_000);

  it('terminalizes an incompatible idle predecessor before a later Turn starts', async () => {
    const imageRefA = 'openkit/worker-codex:image-a';
    const imageRefB = 'openkit/worker-codex:image-b';
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const fileAdmission = new FileStorageAdmission(coreDb.dataRoot, () => 1_000_000n);
    const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
    // HTTP202 admits the Turn; await the actual execution before inspecting terminal state.
    const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    let nextExecution = 0;
    const startTurn = executor.startTurn.bind(executor);
    const executions = vi.spyOn(executor, 'startTurn').mockImplementation((...args) => {
      const completion = startTurn(...args);
      completions[nextExecution++]?.resolve(completion);
      return completion;
    });
    const providerRegistry = new ProviderRegistry([
      {
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Simulator continuity inference',
        id: 'agent-openrouter',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]);
    const firstApp = createApp({
      fileAdmission,
      agentManifests: [createTestAgentSetup({ imageRef: imageRefA }).manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry,
      store,
      turnExecutor: executor,
    });
    const secondApp = createApp({
      fileAdmission,
      agentManifests: [createTestAgentSetup({ imageRef: imageRefB }).manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry,
      store,
      turnExecutor: executor,
    });

    try {
      await linkRepository(firstApp);
      const firstResponse = await firstApp.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000221',
              input: 'Run the first incompatible-replacement simulator Turn',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const firstBody = await firstResponse.json();
      expect(firstResponse.status, JSON.stringify(firstBody)).toBe(202);
      const first = StartTaskModeResponseSchema.parse(firstBody);
      await completions[0].promise;
      await vi.waitFor(() => {
        expect(store.getTurnById(first.turn.id).status).toBe('completed');
        expect(
          coreDb.sqlite
            .prepare('SELECT phase FROM scheduler_execution_attempts WHERE turn_id = ?')
            .get(first.turn.id)
        ).toEqual({ phase: 'closed' });
      });
      const storedFirstTurn = store.getTurnById(first.turn.id);
      if (!storedFirstTurn.agentSessionId) {
        throw new Error('Expected the first simulator Turn and its AgentSession.');
      }
      expect(storedFirstTurn.status).toBe('completed');
      const predecessorId = storedFirstTurn.agentSessionId;
      expect(store.getAgentSession(predecessorId).status).toBe('idle');
      expect(store.getAgentSession(predecessorId)).toMatchObject({
        sessionCompatibilityKey: expect.any(String),
        stale: false,
        status: 'idle',
      });

      const workspaceDb = openWorkspaceDb(
        coreDb.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      try {
        const firstSnapshots = listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        );
        const predecessorSnapshot = firstSnapshots.find(
          (record) => record.agentSessionId === predecessorId
        );
        expect(predecessorSnapshot?.snapshot.runtime.image).toMatchObject({
          kind: 'reference',
          ref: imageRefA,
        });

        const secondResponse = await secondApp.request(
          ...operationRequest(
            'task.start',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
            },
            {
              method: 'POST',
              body: JSON.stringify({
                requestId: '0190f4c8-0000-7000-8000-000000000223',
                input: 'Run the later incompatible-replacement simulator Turn',
              }),
              headers: { 'content-type': 'application/json' },
            }
          )
        );
        const secondBody = await secondResponse.clone().text();
        expect.soft(secondResponse.status, secondBody).toBe(202);
        const acceptedSecond = StartTaskModeResponseSchema.parse(JSON.parse(secondBody));
        await completions[1].promise;
        await vi.waitFor(() =>
          expect(store.getTurnById(acceptedSecond.turn.id).status).toBe('completed')
        );

        const secondTurn = store
          .listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .find((turn) => turn.id !== first.turn.id && turn.agentId === 'agent_codex_host');
        const successorId =
          secondTurn?.agentSessionId && secondTurn.agentSessionId !== predecessorId
            ? secondTurn.agentSessionId
            : undefined;
        expect.soft(secondTurn?.status, JSON.stringify(secondTurn ?? null)).toBe('completed');
        expect.soft(successorId).not.toBe(predecessorId);

        const predecessor = store.getAgentSession(predecessorId);
        expect
          .soft(isCurrentAgentSessionStatus(predecessor.status), JSON.stringify(predecessor))
          .toBe(false);

        const currentSessions = store
          .listThreadAgentSessions(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter((session) => isCurrentAgentSessionStatus(session.status));
        expect.soft(currentSessions.map((session) => session.id)).toEqual([successorId]);
        const successor = successorId ? store.getAgentSession(successorId) : undefined;
        expect
          .soft(successor?.sessionCompatibilityKey)
          .not.toBe(predecessor.sessionCompatibilityKey);
        expect
          .soft(successor?.environmentPackageSnapshotId)
          .not.toBe(predecessor.environmentPackageSnapshotId);

        const laterSnapshots = listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        );
        const successorSnapshot = laterSnapshots.find(
          (record) => record.agentSessionId === successorId
        );
        expect.soft(successorSnapshot?.snapshot.runtime.image).toMatchObject({
          kind: 'reference',
          ref: imageRefB,
        });
        expect.soft(successorSnapshot?.snapshotId).not.toBe(predecessorSnapshot?.snapshotId);

        const predecessorBackends = coreDb.sqlite
          .prepare(`SELECT state FROM worker_backend_sessions WHERE agent_session_id = ?`)
          .all(predecessorId) as Array<{ state: string }>;
        expect
          .soft(
            predecessorBackends.length > 0 &&
              predecessorBackends.every((session) => session.state === 'cleaned'),
            JSON.stringify(predecessorBackends)
          )
          .toBe(true);
        const liveCurrentBindings = coreDb.sqlite
          .prepare(
            `SELECT agent_session_id AS agentSessionId, state
             FROM worker_backend_sessions
             WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001'
               AND thread_id = 'th_00000000-0000-7000-8000-000000000001'
               AND state NOT IN ('cleaned', 'physical-cleaned')`
          )
          .all() as Array<{ agentSessionId: string; state: string }>;
        expect
          .soft(
            liveCurrentBindings.filter((row) => row.agentSessionId === predecessorId),
            JSON.stringify(liveCurrentBindings)
          )
          .toEqual([]);

        const leases = coreDb.sqlite
          .prepare(
            `SELECT agent_session_id AS agentSessionId, attempt_id AS leaseId, turn_id AS turnId
             FROM scheduler_execution_attempts
             WHERE turn_id IN (?, ?)
             ORDER BY turn_id`
          )
          .all(first.turn.id, secondTurn?.id ?? 'missing') as Array<{
          agentSessionId: string;
          leaseId: string;
          turnId: string;
        }>;
        expect.soft(leases, JSON.stringify(leases)).toHaveLength(2);
        expect.soft(new Set(leases.map((lease) => lease.agentSessionId)).size).toBe(2);
        expect.soft(new Set(leases.map((lease) => lease.leaseId)).size).toBe(2);
        expect.soft(new Set(leases.map((lease) => lease.turnId)).size).toBe(2);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      executions.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('strictly projects and consumes bound Material with shared file admission', async () => {
    process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const capacity = 16_000_000n;
    let configuredReserve = 2_000_000n;
    const admission = new FileStorageAdmission(
      coreDb.dataRoot,
      () => configuredReserve,
      () => capacity
    );
    type StartedExecution = { turnId: string; completion: Promise<void> };
    let notifyStartedExecution!: (execution: StartedExecution) => void;
    const startedExecution = new Promise<StartedExecution>((resolve) => {
      notifyStartedExecution = resolve;
    });
    const startTurn = SimulatedTurnExecutor.prototype.startTurn;
    const executions = vi
      .spyOn(SimulatedTurnExecutor.prototype, 'startTurn')
      .mockImplementation(function (this: SimulatedTurnExecutor, ...args) {
        const completion = startTurn.apply(this, args);
        notifyStartedExecution({ turnId: args[1], completion });
        return completion;
      });
    const publisher = SimulatedTurnExecutor.prototype as unknown as MaterialProposalPublisher;
    const publish = publisher.publishMaterialProposals;
    let admissionProof: Promise<void> | undefined;
    const publication = vi
      .spyOn(publisher, 'publishMaterialProposals')
      .mockImplementationOnce(function (this: SimulatedTurnExecutor, ...args) {
        // These are the App/factory executor's real package, live Turn, and accepted S39 trace.
        admissionProof = (async () => {
          const [actualStore, pkg, trace, db] = args;
          expect(actualStore).toBe(store);
          expect(pkg.scope.turnId).toBe(trace.turnId);
          expect(trace.materialSelections).toHaveLength(1);
          const beforeArtifacts = store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
          const beforeItems = store.listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          );
          const beforeReviews = db.sqlite
            .prepare('SELECT * FROM artifact_reviews ORDER BY artifact_id')
            .all();
          const stagingRoot = join(coreDb.dataRoot, 'workspaces', '.staging');
          const stages = () => (existsSync(stagingRoot) ? readdirSync(stagingRoot).sort() : []);
          const beforeStages = stages();
          const fullCapacity = {
            stagingBytes: capacity - configuredReserve,
            extractionBytes: 0n,
            derivativeBytes: 0n,
            publicationBytes: 0n,
          };
          const assertUnchanged = () => {
            expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(
              beforeArtifacts
            );
            expect(
              store.listThreadItems(
                'ws_00000000-0000-7000-8000-000000000001',
                'th_00000000-0000-7000-8000-000000000001'
              )
            ).toEqual(beforeItems);
            expect(
              db.sqlite.prepare('SELECT * FROM artifact_reviews ORDER BY artifact_id').all()
            ).toEqual(beforeReviews);
            expect(stages()).toEqual(beforeStages);
          };
          const assertReleased = () => {
            const available = admission.reserve(fullCapacity);
            available.release();
          };
          const reserve = vi.spyOn(admission, 'reserve');
          try {
            // An independent upload owns the remaining writable capacity. The actual simulator must compete with it.
            const competingUpload = admission.reserve(fullCapacity);
            try {
              await expect(publish.apply(this, args)).rejects.toMatchObject({
                code: 'storage_capacity_unavailable',
              });
              assertUnchanged();
            } finally {
              competingUpload.release();
            }
            assertReleased();

            configuredReserve = capacity;
            try {
              await expect(publish.apply(this, args)).rejects.toMatchObject({
                code: 'storage_capacity_unavailable',
              });
              assertUnchanged();
            } finally {
              configuredReserve = 2_000_000n;
            }

            await expect(
              publish.apply(new SimulatedTurnExecutor({ coreDb }), args)
            ).rejects.toMatchObject({ code: 'storage_capacity_unavailable' });
            assertUnchanged();

            // A proved capture cleanup releases the original shared reservation after the failure.
            const stage = filePayload.stageArtifactPayload;
            const rejectedStage = vi
              .spyOn(filePayload, 'stageArtifactPayload')
              .mockImplementationOnce(async (input) => {
                const staged = await stage(input);
                await staged.remove();
                throw new Error('Fixture capture acknowledgement failed after cleanup.');
              });
            try {
              await expect(publish.apply(this, args)).rejects.toThrow(
                'Fixture capture acknowledgement failed after cleanup.'
              );
              assertUnchanged();
              assertReleased();
            } finally {
              rejectedStage.mockRestore();
            }

            // The real private stage stays occupied across an unproved cleanup failure.
            let retainedStage: Awaited<ReturnType<typeof stage>> | undefined;
            let retainedReservation: Parameters<typeof stage>[0]['reservation'] | undefined;
            const unprovedStage = vi
              .spyOn(filePayload, 'stageArtifactPayload')
              .mockImplementationOnce(async (input) => {
                retainedStage = await stage(input);
                retainedReservation = input.reservation;
                throw new filePayload.ArtifactPayloadCleanupError([
                  new Error('Fixture cleanup result is unknown.'),
                ]);
              });
            try {
              await expect(publish.apply(this, args)).rejects.toBeInstanceOf(
                filePayload.ArtifactPayloadCleanupError
              );
              expect(retainedStage).toBeDefined();
              expect(existsSync(retainedStage!.path)).toBe(true);
              expect(() => admission.reserve(fullCapacity)).toThrow('Storage capacity');
              expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(
                beforeArtifacts
              );
            } finally {
              unprovedStage.mockRestore();
              // Fixture cleanup proves removal before it returns the retained capacity.
              await retainedStage?.remove();
              retainedReservation?.release();
            }
            assertUnchanged();
            assertReleased();

            // Fill the remaining budget only after the real payload is captured. Canonical metadata must also compete.
            const createArtifact = store.createArtifact.bind(store);
            const publicationPressure = vi
              .spyOn(store, 'createArtifact')
              .mockImplementationOnce((artifact, payload) => {
                const forecast = reserve.mock.calls.at(-1)![0];
                const pending =
                  forecast.stagingBytes +
                  forecast.extractionBytes +
                  forecast.derivativeBytes +
                  forecast.publicationBytes -
                  BigInt(payload!.byteLength);
                const contender = admission.reserve({
                  ...fullCapacity,
                  stagingBytes: capacity - configuredReserve - pending,
                });
                try {
                  return createArtifact(artifact, payload);
                } finally {
                  contender.release();
                }
              });
            try {
              await expect(publish.apply(this, args)).rejects.toMatchObject({
                code: 'storage_capacity_unavailable',
              });
              assertUnchanged();
              assertReleased();
            } finally {
              publicationPressure.mockRestore();
            }

            // A Review failure must compensate through this same canonical-write admission owner.
            const rollbackArtifact = store.rollbackArtifactCreation.bind(store);
            const compensation = vi
              .spyOn(store, 'rollbackArtifactCreation')
              .mockImplementation((id) => {
                const previousReservations = reserve.mock.calls.length;
                rollbackArtifact(id);
                expect(reserve.mock.calls.length).toBeGreaterThan(previousReservations);
              });
            const reviewFailure = vi
              .spyOn(artifactReviews, 'createArtifactReview')
              .mockImplementationOnce(() => {
                throw new Error('Fixture Review publication failed.');
              });
            try {
              await expect(publish.apply(this, args)).rejects.toThrow(
                'Fixture Review publication failed.'
              );
              expect(compensation).toHaveBeenCalledOnce();
              assertUnchanged();
              assertReleased();
            } finally {
              reviewFailure.mockRestore();
              compensation.mockRestore();
            }

            await publish.apply(this, args);
            assertReleased();
            expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(
              beforeArtifacts.length + 2
            );
          } finally {
            reserve.mockRestore();
          }
        })();
        return admissionProof;
      });
    const app = createApp({
      fileAdmission: admission,
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Simulator backend inference',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      store,
    });
    const content = '# Deterministic worker input\n';

    try {
      await linkRepository(app);
      const createResponse = await app.request(
        ...operationRequest(
          'material.create',
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: 'simulator-material-create',
              title: 'Deterministic worker input',
              kind: 'markdown',
              sensitivity: 'internal',
            }),
          }
        )
      );
      expect(createResponse.status).toBe(201);
      const material = CreateWorkspaceMaterialResponseSchema.parse(await createResponse.json());
      const revisionResponse = await app.request(
        ...operationRequest(
          'material.revision-save',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            materialId: material.materialId,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: 'simulator-material-save',
              expectedRevisionId: null,
              content,
              contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
            }),
          }
        )
      );
      expect(revisionResponse.status).toBe(201);
      const revision = SaveWorkspaceMaterialRevisionResponseSchema.parse(
        await revisionResponse.json()
      );
      const bindResponse = await app.request(
        ...operationRequest(
          'material.bind',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            materialId: material.materialId,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: 'simulator-material-bind',
              expectedBindingState: 'not_bound',
            }),
          }
        )
      );
      expect(bindResponse.status).toBe(200);

      const requestId = '0190f4c8-0000-7000-8000-000000000241';
      const turnResponse = await app.request(
        ...operationRequest(
          'task.start',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId,
              input: 'Implement the focused Material-backed Task Mode fix.',
            }),
          }
        )
      );
      const turnBody = await turnResponse.json();
      expect(turnResponse.status, JSON.stringify(turnBody)).toBe(202);
      const task = StartTaskModeResponseSchema.parse(turnBody);
      const execution = await startedExecution;
      expect(execution.turnId).toBe(task.turn.id);
      await execution.completion;
      expect(admissionProof).toBeDefined();
      await admissionProof;
      await vi.waitFor(() => expect(store.getTurnById(task.turn.id).status).toBe('completed'));
      const workerTurn = store.getTurnById(task.turn.id);
      expect(workerTurn).toMatchObject({
        status: 'completed',
      });
      const dashboardResponse = await app.request(
        ...operationRequest('thread.dashboard', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        })
      );
      expect(dashboardResponse.status).toBe(200);
      const dashboard = await dashboardResponse.json();
      expect(dashboard.pendingRequests).toEqual([
        expect.objectContaining({ state: 'pending', resolution: null, canRespond: true }),
      ]);
      const question = store
        .listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .find((item) => item.type === 'user-input-request' && item.turnId === workerTurn.id);
      expect(question?.type).toBe('user-input-request');
      if (question?.type !== 'user-input-request') throw new Error('Simulator question missing.');
      expect(dashboard.pendingRequests[0].requestId).toBe(question.userInputRequestId);
      const pendingDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(readPendingRequest(pendingDb.sqlite, question.userInputRequestId)).toMatchObject({
          kind: 'user-input',
          requesterKind: 'worker',
          state: 'pending',
          resolution: null,
          raisingTurnId: workerTurn.id,
          requestItemId: question.id,
          agentId: workerTurn.agentId,
          agentSessionId: workerTurn.agentSessionId,
        });
      } finally {
        pendingDb.sqlite.close();
      }
      const proposals = store.listArtifacts('ws_00000000-0000-7000-8000-000000000001');
      expect(proposals).toHaveLength(3);
      expect(new Set(proposals.map((artifact) => artifact.contentDigest)).size).toBe(3);
      const workspaceDb = openWorkspaceDb(
        coreDb.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      try {
        const reviewedProposals = proposals.filter((artifact) => {
          try {
            getArtifactReview(workspaceDb, artifact.id, artifact.version);
            return true;
          } catch {
            return false;
          }
        });
        expect(reviewedProposals).toHaveLength(2);
        expect(new Set(reviewedProposals.map((artifact) => artifact.origin.requestId)).size).toBe(
          2
        );
        expect(
          reviewedProposals.every((artifact) =>
            artifact.origin.requestId?.startsWith('simulator-material-')
          )
        ).toBe(true);
        const reviews = reviewedProposals.map((artifact) =>
          getArtifactReview(workspaceDb, artifact.id, artifact.version)
        );
        expect(
          new Set(reviews.map((review) => `${review.artifactId}@${review.artifactVersion}`)).size
        ).toBe(2);
        expect(reviews).toEqual(
          reviewedProposals.map((artifact) =>
            expect.objectContaining({
              artifactId: artifact.id,
              artifactVersion: artifact.version,
              contentDigest: artifact.contentDigest,
              decision: null,
              materialProposal: {
                materialId: material.materialId,
                baseRevisionId: revision.revisionId,
                baseContentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
              },
            })
          )
        );
      } finally {
        workspaceDb.sqlite.close();
      }

      const projectionResponse = await app.request(
        ...operationRequest(
          'material.thread-read',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {}
        )
      );
      const projectionBody = await projectionResponse.json();
      expect(projectionResponse.status, JSON.stringify(projectionBody)).toBe(200);
      expect(GetThreadMaterialResponseSchema.parse(projectionBody)).toMatchObject({
        material: {
          currentTurnRevisionId: null,
          lastWorkerSeenRevisionId: revision.revisionId,
          latestQueuedRevisionId: null,
          resource: { materialId: material.materialId },
        },
      });
      const trace = JSON.parse(
        readFileSync(
          join(
            coreDb.dataRoot,
            'workspaces',
            'ws_00000000-0000-7000-8000-000000000001',
            'threads',
            'th_00000000-0000-7000-8000-000000000001',
            'turns',
            workerTurn.id,
            'context-package.json'
          ),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect(trace).toMatchObject({
        materialSelections: [
          expect.objectContaining({
            materialId: material.materialId,
            revisionId: revision.revisionId,
          }),
        ],
        requestId,
        turnId: workerTurn.id,
      });
      const replayDb = openWorkspaceDb(coreDb.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        const snapshot = listExportableAgentEnvironmentPackageSnapshots(
          replayDb,
          'ws_00000000-0000-7000-8000-000000000001'
        ).find((record) => record.snapshot.scope.turnId === workerTurn.id)!.snapshot;
        const retained = proposals.filter((artifact) =>
          artifact.origin.requestId?.startsWith('simulator-material-')
        );
        const historyPath = join(
          coreDb.dataRoot,
          'workspaces',
          'ws_00000000-0000-7000-8000-000000000001',
          'threads',
          'th_00000000-0000-7000-8000-000000000001',
          'turns',
          workerTurn.id,
          'items.jsonl'
        );
        const history = readFileSync(historyPath);
        const references = store.listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        );
        const reviews = retained.map((artifact) =>
          getArtifactReview(replayDb, artifact.id, artifact.version)
        );
        const executor = new SimulatedTurnExecutor({
          coreDb,
          fileAdmission: admission,
        }) as unknown as MaterialProposalPublisher;
        // Repeat the actual deterministic producer, then contradict its retained immutable tuple.
        await expect(
          executor.publishMaterialProposals(
            store,
            snapshot,
            trace as unknown as WorkerContextPackageTrace,
            replayDb,
            retained[0]!.createdAt
          )
        ).resolves.toBeUndefined();
        await expect(
          executor.publishMaterialProposals(
            store,
            snapshot,
            trace as unknown as WorkerContextPackageTrace,
            replayDb,
            '2099-01-01T00:00:00.000Z'
          )
        ).rejects.toThrow();
        expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual(proposals);
        expect(
          store.listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        ).toEqual(references);
        expect(readFileSync(historyPath)).toEqual(history);
        expect(
          retained.map((artifact) => getArtifactReview(replayDb, artifact.id, artifact.version))
        ).toEqual(reviews);
      } finally {
        replayDb.sqlite.close();
      }
      const answerResponse = await app.request(
        ...operationRequest(
          'question.answer',
          { userInputRequestId: question.userInputRequestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              userInputRequestId: question.userInputRequestId,
              requestId: '0190f4c8-0000-7000-8000-000000000242',
              answers: { tone: ['Detailed'] },
            }),
          }
        )
      );
      expect(answerResponse.status, await answerResponse.clone().text()).toBe(200);
      const deliveringTurn = store
        .listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .at(-1)!;
      expect(deliveringTurn.id).not.toBe(workerTurn.id);
      if (deliveringTurn.status !== 'completed' && deliveringTurn.status !== 'failed') {
        await new Promise<void>((resolve) => {
          const remove = store.addTurnListener(deliveringTurn.id, (event) => {
            if (event.event === 'turn.completed') {
              remove();
              resolve();
            }
          });
        });
      }
      expect(store.getTurnById(workerTurn.id).status).toBe('completed');
      expect(
        store.getTurnById(deliveringTurn.id),
        JSON.stringify(store.getTurnById(deliveringTurn.id))
      ).toMatchObject({ status: 'completed' });
      expect(
        store.getArtifact(
          'ws_00000000-0000-7000-8000-000000000001',
          deriveEntityId('ar', deliveringTurn.id)
        ).content?.body
      ).toBe('Simulator answer: Detailed');
      expect(store.getTurnById(deliveringTurn.id)).toMatchObject({
        status: 'completed',
        agentId: workerTurn.agentId,
        triggerSource: { kind: 'user-input' },
      });
      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter(
            (item) =>
              item.turnId === deliveringTurn.id &&
              item.type === 'user-message' &&
              item.actor.kind === 'user'
          )
      ).toEqual([]);
      const outcomeMaterialResponse = await app.request(
        ...operationRequest(
          'material.thread-read',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {}
        )
      );
      expect(outcomeMaterialResponse.status, await outcomeMaterialResponse.clone().text()).toBe(
        200
      );
      const outcomeTurnResponse = await app.request(
        ...operationRequest('turn.read', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: deliveringTurn.id,
        })
      );
      expect((await outcomeTurnResponse.json()).contextPackageDigest).toMatch(
        /^ctxpkg_sha256_[a-f0-9]{64}$/
      );
      expect(
        store
          .listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
          .filter((item) => item.type === 'user-input-response')
      ).toEqual([
        expect.objectContaining({
          turnId: deliveringTurn.id,
          userInputRequestId: question.userInputRequestId,
          answers: { tone: ['Detailed'] },
        }),
      ]);
      const deliveredDb = openWorkspaceDb(
        coreDb.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      try {
        expect(readPendingRequest(deliveredDb.sqlite, question.userInputRequestId)).toMatchObject({
          state: 'resolved',
          resolution: 'answered',
          delivery: 'delivered',
          publicationTurnId: deliveringTurn.id,
          deliveryTurnId: deliveringTurn.id,
          raisingTurnId: workerTurn.id,
          answerMap: { tone: ['Detailed'] },
        });
        const snapshot = listExportableAgentEnvironmentPackageSnapshots(
          deliveredDb,
          'ws_00000000-0000-7000-8000-000000000001'
        ).find((record) => record.snapshot.scope.turnId === deliveringTurn.id);
        const workerInput = (snapshot!.snapshot.extensions.openkit as { turnInput: string })
          .turnInput;
        expect(JSON.parse(workerInput).pendingOutcomes).toEqual([
          expect.objectContaining({
            requestId: question.userInputRequestId,
            resolution: 'answered',
            answers: { tone: ['Detailed'] },
            publicationTurnId: deliveringTurn.id,
          }),
        ]);
      } finally {
        deliveredDb.sqlite.close();
      }
    } finally {
      await Promise.allSettled(
        executions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value)
      );
      publication.mockRestore();
      // Let the scheduler's already-attached completion observer settle before closing its database.
      await new Promise<void>((resolve) => setImmediate(resolve));
      executions.mockRestore();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('uses the resolved manifest agent and default profile', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const firstAgentSetup = createTestAgentSetup({
      agentId: 'agent_codex_host',
      provider: null,
      requiredCapabilities: [],
    });
    const firstTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Use the default agent',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );

    store.updateTurn(firstTurn.id, { agentId: 'agent_codex_host' });
    await executor.startTurn(store, firstTurn.id, 'Use the default agent', {
      agentSetup: firstAgentSetup,
      triggerActor: firstTurn.triggerActor,
      workspaceRoots: [],
    });
    const firstSession = store.getAgentSession(
      AgentSessionIdSchema.parse(store.getTurnById(firstTurn.id).agentSessionId)
    );
    const selectedAgentSetup = createTestAgentSetup({
      agentId: 'agent_manifest_selected',
      provider: null,
      requiredCapabilities: [],
    });
    selectedAgentSetup.manifest.defaultProfileId = 'review';
    selectedAgentSetup.manifest.profiles = [
      { id: 'draft', instructionsRef: 'draft', skills: [] },
      { id: 'review', instructionsRef: 'review', skills: [] },
    ];
    const selectedThread = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Selected agent thread'
    );
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      selectedThread.id,
      'Use the selected agent',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );

    store.updateTurn(turn.id, { agentId: selectedAgentSetup.manifest.id });
    await executor.startTurn(store, turn.id, 'Use the selected agent', {
      agentSetup: selectedAgentSetup,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });

    const selectedSession = store.getAgentSession(
      AgentSessionIdSchema.parse(store.getTurnById(turn.id).agentSessionId)
    );
    expect(store.getTurnById(turn.id)).toMatchObject({
      agentId: selectedAgentSetup.manifest.id,
      agentProfileId: 'review',
      agentSessionId: selectedSession.id,
    });
    expect(selectedSession.agentId).toBe(selectedAgentSetup.manifest.id);
    expect(store.getAgentSession(firstSession.id).agentId).toBe('agent_codex_host');
    expect(store.getTurnById(firstTurn.id).agentSessionId).not.toBe(
      store.getTurnById(turn.id).agentSessionId
    );

    expect(
      executor.getAgentSession(
        store,
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ).id
    ).toBe(firstSession.id);
  });

  it('fails closed when the resolved agent setup is missing', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Missing setup',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );

    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });

    await expect(executor.startTurn(store, turn.id, 'Missing setup')).rejects.toThrow(
      'Simulator execution requires one resolved agent setup.'
    );
    expect(store.getTurnById(turn.id).agentSessionId).toBeUndefined();
    expect(
      store.listThreadAgentSessions(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
  });

  it('commits one ready version-one Artifact with exact turn-output proof', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const agentSetup = createTestAgentSetup({ provider: null, requiredCapabilities: [] });
    const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Create one simulator Artifact',
      actor
    );
    const artifactRequestId = '0190f4c8-0000-7000-8000-000000000230';
    const body = 'Simulator answer: Concise';

    store.updateTurn(turn.id, { agentId: agentSetup.manifest.id });
    await executor.startTurn(store, turn.id, 'Create one simulator Artifact', {
      agentSetup,
      requestId: artifactRequestId,
      triggerActor: actor,
      workspaceRoots: [],
    });

    await expect(
      executor.respondUserInput(store, turn.id, { tone: ['Concise'] }, { actor, requestId: null })
    ).rejects.toThrow('Simulator user-input request is not active');
    expect(store.getTurnById(turn.id).status).toBe('completed');

    expect(store.listArtifacts('ws_00000000-0000-7000-8000-000000000001')).toEqual([
      expect.objectContaining({
        content: { body, format: 'markdown' },
        contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
        lastMutationRequestId: artifactRequestId,
        origin: {
          kind: 'turn-output',
          requestId: artifactRequestId,
          threadId: turn.threadId,
          turnId: turn.id,
        },
        status: 'ready',
        summary: 'Deterministic simulator artifact ready.',
        version: 1,
      }),
    ]);
    expect(
      store.listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user-message', actor }),
        expect.objectContaining({
          type: 'user-input-request',
          responsibleUserId: actor.id,
        }),
      ])
    );
    expect(
      store
        .listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .some((item) => item.type === 'user-input-response')
    ).toBe(false);
    expect(
      store
        .getTurnEvents(turn.id)
        .filter((event) => event.event.startsWith('artifact.'))
        .map((event) => event.event)
    ).toEqual(['artifact.created']);
  });

  it('uses the simulator as the default executor when requested by environment', async () => {
    process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';

    const app = createApp();
    const response = await app.request('/api/meta');
    const meta = (await response.json()) as { itemTypes: string[] };

    expect(meta.itemTypes).toEqual(
      expect.arrayContaining(['reasoning', 'command-execution', 'user-input-request'])
    );
  });

  it('emits command output delta before the command item completes', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: { defaults: { defaultAgentId: 'agent_codex_host' } },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Simulator inference',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      store,
      turnExecutor: new SimulatedTurnExecutor({ coreDb }),
    });

    try {
      await linkRepository(app);

      const turnResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              requestId: '0190f4c8-0000-7000-8000-000000000240',
              input: 'Exercise simulated command output.',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = (await turnResponse.json()) as { id: string };
      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      await vi.waitFor(() => expect(store.getTurnById(turn.id).status).toBe('completed'));
      const commandItemId = deriveEntityId('it', ['command', turn.id]);
      const commandEvents = store.getTurnEvents(turn.id).filter((event) => {
        const data = event.data as { item?: { id: string }; itemId?: string };
        return (data.itemId ?? data.item?.id) === commandItemId;
      });
      const commandItem = store
        .listThreadItems(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001'
        )
        .find((item) => item.id === commandItemId);

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      expect(commandEvents[0]).toMatchObject({
        event: 'item.created',
        data: {
          type: 'item-created',
          item: {
            type: 'command-execution',
          },
        },
      });
      expect(commandEvents[1]).toMatchObject({
        event: 'item.delta',
        data: {
          type: 'item-delta',
          deltaKind: 'output-delta',
          itemType: 'command-execution',
          delta: 'simulator: ok',
        },
      });
      expect(commandEvents[2]).toMatchObject({
        event: 'item.completed',
        data: {
          type: 'item-completed',
        },
      });
      expect(commandItem?.output).toBe('simulator: ok');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('admits one manifest-selected remote Git source without a WorkspaceRepository or host path', async () => {
    const { app, coreDb, executor, store } = createRemoteGitProductFixture({
      commit: REMOTE_GIT_COMMIT,
      url: REMOTE_GIT_URL,
    });
    const prepareSpy = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const startSpy = vi.spyOn(executor, 'startTurn');

    try {
      const turnResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              requestId: '0190f4c8-0000-7000-8000-000000000314',
              input: 'Use the exact remote Git source',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const turn = (await turnResponse.json()) as { agentSessionId?: string; id?: string };
      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      await vi.waitFor(() => expect(store.getTurnById(turn.id!).status).toBe('completed'));
      const admissions = coreDb.sqlite
        .prepare(
          `SELECT workspace_cwd AS workspaceCwd
           FROM scheduler_admission_entries
           WHERE workspace_id = ?`
        )
        .all('ws_00000000-0000-7000-8000-000000000001') as Array<{ workspaceCwd: string | null }>;
      const prepareContext = prepareSpy.mock.calls[0]?.[1] as {
        workspaceCwd?: string | null;
        workspaceRoots?: Array<Record<string, unknown>>;
      };
      const startContext = startSpy.mock.calls[0]?.[3] as {
        workspaceCwd?: string | null;
        workspaceRoots?: Array<Record<string, unknown>>;
      };

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(admissions).toEqual([{ workspaceCwd: '/workspace/openkit' }]);
      expect(prepareContext.workspaceCwd).toBe('/workspace/openkit');
      expect(startContext.workspaceCwd).toBe('/workspace/openkit');
      expect(startContext.workspaceRoots).toEqual([
        {
          access: 'read-write',
          id: 'repo_remote',
          sourceCommit: REMOTE_GIT_COMMIT,
          sourceKind: 'remote-git',
          workerPath: '/workspace/openkit',
        },
      ]);
      expect(startContext.workspaceRoots?.[0]).not.toHaveProperty('sourcePath');
      expect(JSON.stringify({ admissions, startContext })).not.toContain(coreDb.dataRoot);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      kind: 'local-only',
      locator: { localPath: '/srv/private/repository' },
      requestId: '0190f4c8-0000-7000-8000-000000000315',
    },
    {
      kind: 'missing-commit',
      locator: { url: REMOTE_GIT_URL },
      requestId: '0190f4c8-0000-7000-8000-000000000316',
    },
    {
      kind: 'invalid-commit',
      locator: { commit: 'main', url: REMOTE_GIT_URL },
      requestId: '0190f4c8-0000-7000-8000-000000000317',
    },
    {
      forbiddenPayloadFragment: '?ref=private-review',
      kind: 'query-bearing-url',
      locator: { commit: REMOTE_GIT_COMMIT, url: `${REMOTE_GIT_URL}?ref=private-review` },
      requestId: '0190f4c8-0000-7000-8000-000000000319',
    },
    {
      forbiddenPayloadFragment: '#private-review',
      kind: 'fragment-bearing-url',
      locator: { commit: REMOTE_GIT_COMMIT, url: `${REMOTE_GIT_URL}#private-review` },
      requestId: '0190f4c8-0000-7000-8000-000000000320',
    },
    {
      kind: 'credential-bearing',
      locator: { commit: REMOTE_GIT_COMMIT, url: REMOTE_GIT_URL },
      requestId: '0190f4c8-0000-7000-8000-000000000318',
      vaultGrantRef: 'grant_00000000-0000-7899-9b3f-8965fec90404',
    },
  ])('rejects a $kind remote Git source before product admission or runtime effects', async ({
    forbiddenPayloadFragment,
    locator,
    requestId,
    vaultGrantRef,
  }) => {
    const { app, canaryPath, coreDb, executor, store } = createRemoteGitProductFixture(
      locator,
      vaultGrantRef,
      true
    );
    const prepareSpy = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const startSpy = vi.spyOn(executor, 'startTurn');
    const turnsBefore = structuredClone(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    );
    const itemsBefore = structuredClone(
      store.listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    );

    try {
      expect(existsSync(canaryPath)).toBe(false);
      const turnResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
              requestId,
              input: 'Reject an invalid remote Git source',
            }),
            headers: { 'content-type': 'application/json' },
          }
        )
      );
      const payload = (await turnResponse.json()) as Record<string, unknown>;

      expect.soft(turnResponse.status, JSON.stringify(payload)).toBe(409);
      expect.soft(payload).toMatchObject({ code: 'workspace_data_source_blocked' });
      expect.soft(prepareSpy).toHaveBeenCalledTimes(0);
      expect.soft(startSpy).toHaveBeenCalledTimes(0);
      expect
        .soft(
          coreDb.sqlite
            .prepare(`SELECT * FROM scheduler_admission_entries WHERE workspace_id = ?`)
            .all('ws_00000000-0000-7000-8000-000000000001')
        )
        .toEqual([]);
      expect
        .soft(
          coreDb.sqlite
            .prepare(`SELECT * FROM scheduler_execution_attempts WHERE workspace_id = ?`)
            .all('ws_00000000-0000-7000-8000-000000000001')
        )
        .toEqual([]);
      expect
        .soft(store.listWorkspaceAgentSessions('ws_00000000-0000-7000-8000-000000000001'))
        .toEqual([]);
      expect.soft(listWorkerBackendSessions(coreDb)).toEqual([]);
      expect
        .soft(
          store.listThreadTurns(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        )
        .toEqual(turnsBefore);
      expect
        .soft(
          store.listThreadItems(
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001'
          )
        )
        .toEqual(itemsBefore);
      expect.soft(existsSync(canaryPath)).toBe(false);
      expect.soft(JSON.stringify(payload)).not.toContain('/srv/private/repository');
      if (forbiddenPayloadFragment) {
        expect.soft(JSON.stringify(payload)).not.toContain(forbiddenPayloadFragment);
      }
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('../runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
