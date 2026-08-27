import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateWorkspaceMaterialResponseSchema,
  GetThreadMaterialResponseSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  StartChatModeResponseSchema,
  StartTaskModeResponseSchema,
} from '@openkit/app-api-schemas';
import type { WorkspaceDataSourceCatalog } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { getArtifactReview } from '../artifact-reviews.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import { listWorkerBackendSessions } from '../runtime/worker-backend-sessions.js';
import {
  ensureConfiguredSchedulerBaseline,
  upsertSchedulerCapacityRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { SimulatedTurnExecutor } from './simulator.js';

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
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });
  configureLocalSchedulerCapacity(coreDb, 3);
  return coreDb;
}

/**
 * Configures local scheduler capacity for multi-turn simulator route tests.
 *
 * @param coreDb Migrated Core database handles.
 * @param capacity Concurrent local lease capacity.
 */
function configureLocalSchedulerCapacity(coreDb: CoreDb, capacity: number): void {
  ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
  upsertSchedulerWorkerPool(coreDb, {
    allowedBackendKinds: ['openshell'],
    allowedPlacements: ['local'],
    allowedWorkspaceScopes: ['local'],
    budgetClass: 'interactive',
    currentAdmittedSessionCount: 0,
    currentQueueDepth: 0,
    defaultTimeoutMs: 900_000,
    healthSummary: 'ready',
    maxConcurrentSessions: capacity,
    poolId: 'pool_local',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: capacity,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: new Date().toISOString(),
    poolId: 'pool_local',
    queueDepth: 0,
    targetId: 'target_local',
  });
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
  await app.request('/api/app/workspaces/ws_demo/repositories/default', {
    method: 'PUT',
    body: JSON.stringify({
      displayName: 'Simulator repository',
      localPath: repositoryPath,
    }),
    headers: { 'content-type': 'application/json' },
  });
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
  const canaryPath = join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'invalid-source-canary');
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot: coreDb.dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      agentManifests: [manifest],
      dataRoot: coreDb.dataRoot,
      providerRegistry,
      workspaceConfigs: configuredCanary
        ? [
            {
              config: {
                schemaVersion: 1,
                workspace: {
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
              path: join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'config', 'workspace.jsonc'),
              workspaceId: 'ws_demo',
            },
          ]
        : [],
      workspaceDataSourceCatalogs: [
        {
          catalog,
          path: join(coreDb.dataRoot, 'workspaces', 'ws_demo', 'config', 'data-sources.jsonc'),
          workspaceId: 'ws_demo',
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

  it('pauses a scheduled worker directly on one non-secret user-input Gate', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
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
      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000211',
          input: 'Simulated scheduled worker run',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnResponse.json()) as { id: string };

      expect(turnResponse.status, JSON.stringify(turn)).toBe(202);
      const storedTurn = store.getTurnById(turn.id);
      expect(storedTurn).toMatchObject({
        agentId: 'agent_codex_host',
        agentProfileId: 'default',
        agentSessionId: expect.stringMatching(/^as_/),
        status: 'awaiting_human',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: `ui_${turn.id}`,
          itemId: `it_user_input_request_${turn.id}`,
        },
      });
      expect(executor.getAgentSession(store, 'ws_demo', 'th_demo').id).toBe(
        storedTurn.agentSessionId
      );

      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id)
          .map((item) => item.type)
      ).toEqual([
        'user-message',
        'assistant-message',
        'reasoning',
        'command-execution',
        'user-input-request',
      ]);
      expect(
        store
          .listAllItems()
          .filter(
            (item) =>
              item.workspaceId === 'ws_demo' &&
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
    const turn = store.createTurn('ws_demo', 'th_demo', 'Reject a mismatched lease key', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { agentId: agentSetup.manifest.id });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Reject a mismatched lease key', {
          agentSessionId: 'as_mismatched_lease_key',
          agentSetup,
          requestId: '0190f4c8-0000-7000-8000-000000000220',
          sessionCompatibilityKey: `sha256:${'f'.repeat(64)}`,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('scheduler lease SessionCompatibilityKey');
      expect(listWorkerBackendSessions(coreDb)).toEqual([]);
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        expect(listExportableAgentEnvironmentPackageSnapshots(workspaceDb, 'ws_demo')).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses one compatible current AgentSession across sequential simulator Turns', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new SimulatedTurnExecutor({ coreDb });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
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
      const firstResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000212',
          input: 'Run the first sequential simulator Turn',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const firstBody = await firstResponse.json();
      expect(firstResponse.status, JSON.stringify(firstBody)).toBe(202);
      const first = StartTaskModeResponseSchema.parse(firstBody);
      const storedFirstTurn = store.getTurnById(first.turn.id);
      if (first.turn.humanGate?.kind !== 'user-input' || !storedFirstTurn.agentSessionId) {
        throw new Error('Expected the first simulator Turn and its AgentSession Gate.');
      }
      const agentSessionId = storedFirstTurn.agentSessionId;
      const closeResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000213',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: first.turn.id,
          answers: { tone: ['Concise'] },
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(closeResponse.status, await closeResponse.clone().text()).toBe(202);
      expect(store.getAgentSession(agentSessionId)).toMatchObject({
        sessionCompatibilityKey: expect.any(String),
        stale: false,
        status: 'idle',
      });

      const secondResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/task', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000214',
          input: 'Run the second sequential simulator Turn',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const secondBody = await secondResponse.clone().text();
      expect.soft(secondResponse.status, secondBody).toBe(202);
      const secondTurn = store
        .listThreadTurns('ws_demo', 'th_demo')
        .find((turn) => turn.id !== first.turn.id && turn.agentId === 'agent_codex_host');
      expect.soft(secondTurn).toMatchObject({
        agentSessionId,
        status: 'awaiting_human',
      });
      const leases = coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, lease_id AS leaseId, turn_id AS turnId
           FROM scheduler_session_leases
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
      coreDb.sqlite.close();
    }
  });

  it('terminalizes an incompatible idle predecessor before a later Turn starts', async () => {
    const imageRefA = 'openkit/worker-codex:image-a';
    const imageRefB = 'openkit/worker-codex:image-b';
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const executor = new SimulatedTurnExecutor({ coreDb });
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
      agentManifests: [createTestAgentSetup({ imageRef: imageRefA }).manifest],
      coreDb,
      providerRegistry,
      store,
      turnExecutor: executor,
    });
    const secondApp = createApp({
      agentManifests: [createTestAgentSetup({ imageRef: imageRefB }).manifest],
      coreDb,
      providerRegistry,
      store,
      turnExecutor: executor,
    });

    try {
      await linkRepository(firstApp);
      const firstResponse = await firstApp.request(
        '/api/app/workspaces/ws_demo/threads/th_demo/task',
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: '0190f4c8-0000-7000-8000-000000000221',
            input: 'Run the first incompatible-replacement simulator Turn',
          }),
          headers: { 'content-type': 'application/json' },
        }
      );
      const firstBody = await firstResponse.json();
      expect(firstResponse.status, JSON.stringify(firstBody)).toBe(202);
      const first = StartTaskModeResponseSchema.parse(firstBody);
      const storedFirstTurn = store.getTurnById(first.turn.id);
      if (first.turn.humanGate?.kind !== 'user-input' || !storedFirstTurn.agentSessionId) {
        throw new Error('Expected the first simulator Turn and its AgentSession Gate.');
      }
      const predecessorId = storedFirstTurn.agentSessionId;
      const closeResponse = await firstApp.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          requestId: '0190f4c8-0000-7000-8000-000000000222',
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: first.turn.id,
          answers: { tone: ['Concise'] },
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(closeResponse.status, await closeResponse.clone().text()).toBe(202);
      expect(store.getAgentSession(predecessorId)).toMatchObject({
        sessionCompatibilityKey: expect.any(String),
        stale: false,
        status: 'idle',
      });

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        const firstSnapshots = listExportableAgentEnvironmentPackageSnapshots(
          workspaceDb,
          'ws_demo'
        );
        const predecessorSnapshot = firstSnapshots.find(
          (record) => record.agentSessionId === predecessorId
        );
        expect(predecessorSnapshot?.snapshot.runtime.image).toMatchObject({
          kind: 'reference',
          ref: imageRefA,
        });

        const secondResponse = await secondApp.request(
          '/api/app/workspaces/ws_demo/threads/th_demo/task',
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000223',
              input: 'Run the later incompatible-replacement simulator Turn',
            }),
            headers: { 'content-type': 'application/json' },
          }
        );
        const secondBody = await secondResponse.clone().text();
        expect.soft(secondResponse.status, secondBody).toBe(202);

        const secondTurn = store
          .listThreadTurns('ws_demo', 'th_demo')
          .find((turn) => turn.id !== first.turn.id && turn.agentId === 'agent_codex_host');
        const successorId =
          secondTurn?.agentSessionId && secondTurn.agentSessionId !== predecessorId
            ? secondTurn.agentSessionId
            : undefined;
        expect.soft(secondTurn?.status, JSON.stringify(secondTurn ?? null)).toBe('awaiting_human');
        expect.soft(successorId).not.toBe(predecessorId);

        const predecessor = store.getAgentSession(predecessorId);
        expect
          .soft(isCurrentAgentSessionStatus(predecessor.status), JSON.stringify(predecessor))
          .toBe(false);

        const currentSessions = store
          .listThreadAgentSessions('ws_demo', 'th_demo')
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
          'ws_demo'
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
             WHERE workspace_id = 'ws_demo'
               AND thread_id = 'th_demo'
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
            `SELECT agent_session_id AS agentSessionId, lease_id AS leaseId, turn_id AS turnId
             FROM scheduler_session_leases
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
      coreDb.sqlite.close();
    }
  });

  it('strictly projects and consumes the bound Material for the configured self-check executor', async () => {
    process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
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
      const createResponse = await app.request('/api/app/workspaces/ws_demo/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'simulator-material-create',
          title: 'Deterministic worker input',
          kind: 'markdown',
          sensitivity: 'internal',
        }),
      });
      expect(createResponse.status).toBe(201);
      const material = CreateWorkspaceMaterialResponseSchema.parse(await createResponse.json());
      const revisionResponse = await app.request(
        `/api/app/workspaces/ws_demo/materials/${material.materialId}/revisions`,
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
      );
      expect(revisionResponse.status).toBe(201);
      const revision = SaveWorkspaceMaterialRevisionResponseSchema.parse(
        await revisionResponse.json()
      );
      const bindResponse = await app.request(
        `/api/app/workspaces/ws_demo/threads/th_demo/materials/${material.materialId}/bind`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'simulator-material-bind',
            expectedBindingState: 'not_bound',
          }),
        }
      );
      expect(bindResponse.status).toBe(200);

      const requestId = '0190f4c8-0000-7000-8000-000000000241';
      const turnResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          input: 'Implement the focused Material-backed Task Mode fix.',
        }),
      });
      const turnBody = await turnResponse.json();
      expect(turnResponse.status, JSON.stringify(turnBody)).toBe(202);
      const chat = StartChatModeResponseSchema.parse(turnBody);
      expect(chat).toMatchObject({
        outcome: 'task-handoff',
        handoff: { targetMode: 'task' },
      });
      const workerTurns = store
        .listThreadTurns('ws_demo', 'th_demo')
        .filter((turn) => turn.id !== chat.turn.id);
      expect(workerTurns).toHaveLength(1);
      const workerTurn = workerTurns[0]!;
      expect(workerTurn).toMatchObject({
        status: 'awaiting_human',
        humanGate: { kind: 'user-input' },
      });
      const proposals = store.listArtifacts('ws_demo');
      expect(proposals).toHaveLength(2);
      expect(new Set(proposals.map((artifact) => artifact.contentDigest)).size).toBe(2);
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        const reviews = proposals.map((artifact) =>
          getArtifactReview(workspaceDb, artifact.id, artifact.version)
        );
        expect(
          new Set(reviews.map((review) => `${review.artifactId}@${review.artifactVersion}`)).size
        ).toBe(2);
        expect(reviews).toEqual(
          proposals.map((artifact) =>
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
        '/api/app/workspaces/ws_demo/threads/th_demo/material'
      );
      const projectionBody = await projectionResponse.json();
      expect(projectionResponse.status, JSON.stringify(projectionBody)).toBe(200);
      expect(GetThreadMaterialResponseSchema.parse(projectionBody)).toMatchObject({
        material: {
          currentTurnRevisionId: revision.revisionId,
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
            'ws_demo',
            'threads',
            'th_demo',
            'turns',
            workerTurn.id,
            'context-package.json'
          ),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect(trace).toMatchObject({
        knowledgeExclusions: [],
        knowledgeSelectionInput: null,
        knowledgeSelections: [],
        materialSelections: [
          expect.objectContaining({
            materialId: material.materialId,
            revisionId: revision.revisionId,
          }),
        ],
        requestId,
        turnId: workerTurn.id,
      });
    } finally {
      coreDb.sqlite.close();
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
    const firstTurn = store.createTurn('ws_demo', 'th_demo', 'Use the default agent', {
      kind: 'user',
      id: 'user_local',
    });

    store.updateTurn(firstTurn.id, { agentId: 'agent_codex_host' });
    await executor.startTurn(store, firstTurn.id, 'Use the default agent', {
      agentSetup: firstAgentSetup,
      triggerActor: firstTurn.triggerActor,
      workspaceRoots: [],
    });
    const firstSession = store.getAgentSession(`session_sim_turn_${firstTurn.id}`);
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
    const selectedThread = store.createThread('ws_demo', 'Selected agent thread');
    const turn = store.createTurn('ws_demo', selectedThread.id, 'Use the selected agent', {
      kind: 'user',
      id: 'user_local',
    });

    store.updateTurn(turn.id, { agentId: selectedAgentSetup.manifest.id });
    await executor.startTurn(store, turn.id, 'Use the selected agent', {
      agentSetup: selectedAgentSetup,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });

    expect(store.getTurnById(turn.id)).toMatchObject({
      agentId: selectedAgentSetup.manifest.id,
      agentProfileId: 'review',
      agentSessionId: `session_sim_turn_${turn.id}`,
    });
    expect(store.getAgentSession(`session_sim_turn_${turn.id}`).agentId).toBe(
      selectedAgentSetup.manifest.id
    );
    expect(store.getAgentSession(firstSession.id).agentId).toBe('agent_codex_host');
    expect(store.getTurnById(firstTurn.id).agentSessionId).not.toBe(
      store.getTurnById(turn.id).agentSessionId
    );

    await executor.interruptTurn(store, turn.id);

    expect(executor.getAgentSession(store, 'ws_demo', 'th_demo').id).toBe(firstSession.id);
  });

  it('fails closed when the resolved agent setup is missing', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Missing setup', {
      kind: 'user',
      id: 'user_local',
    });

    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });

    await expect(executor.startTurn(store, turn.id, 'Missing setup')).rejects.toThrow(
      'Simulator execution requires one resolved agent setup.'
    );
    expect(store.getTurnById(turn.id).agentSessionId).toBeUndefined();
    expect(store.listThreadAgentSessions('ws_demo', 'th_demo')).toEqual([]);
  });

  it('commits one ready version-one Artifact with exact turn-output proof', async () => {
    const store = createDemoStore();
    const executor = new SimulatedTurnExecutor();
    const agentSetup = createTestAgentSetup({ provider: null, requiredCapabilities: [] });
    const actor = { kind: 'user', id: 'user_local' } as const;
    const turn = store.createTurn('ws_demo', 'th_demo', 'Create one simulator Artifact', actor);
    const artifactRequestId = '0190f4c8-0000-7000-8000-000000000232';
    const body = 'Simulator answer: Concise';

    store.updateTurn(turn.id, { agentId: agentSetup.manifest.id });
    await executor.startTurn(store, turn.id, 'Create one simulator Artifact', {
      agentSetup,
      requestId: '0190f4c8-0000-7000-8000-000000000230',
      triggerActor: actor,
      workspaceRoots: [],
    });
    const beforeMissingProof = {
      artifacts: store.listArtifacts('ws_demo'),
      events: store.getTurnEvents(turn.id),
      items: store.listThreadItems('ws_demo', 'th_demo'),
      session: store.getAgentSession(`session_sim_turn_${turn.id}`),
      turn: store.getTurnById(turn.id),
    };

    await expect(
      executor.respondUserInput(store, turn.id, { tone: ['Concise'] }, { actor, requestId: null })
    ).rejects.toThrow('Simulator Artifact creation requires the current request identity.');
    expect({
      artifacts: store.listArtifacts('ws_demo'),
      events: store.getTurnEvents(turn.id),
      items: store.listThreadItems('ws_demo', 'th_demo'),
      session: store.getAgentSession(`session_sim_turn_${turn.id}`),
      turn: store.getTurnById(turn.id),
    }).toEqual(beforeMissingProof);

    await executor.respondUserInput(
      store,
      turn.id,
      { tone: ['Concise'] },
      {
        actor,
        requestId: artifactRequestId,
      }
    );

    expect(store.listArtifacts('ws_demo')).toEqual([
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
    expect(store.listThreadItems('ws_demo', 'th_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user-message', actor }),
        expect.objectContaining({
          type: 'user-input-request',
          responsibleUserId: actor.id,
        }),
        expect.objectContaining({
          type: 'user-input-response',
          actor,
          causationId: artifactRequestId,
        }),
      ])
    );
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
    const store = createDemoStore();
    const app = createApp({
      agentManifests: [createTestAgentSetup().manifest],
      coreDb,
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
      turnExecutor: new SimulatedTurnExecutor(),
    });

    try {
      await linkRepository(app);

      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000240',
          input: 'Exercise simulated command output.',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnResponse.json()) as { id: string };
      const commandItemId = `it_command_${turn.id}`;
      const commandEvents = store.getTurnEvents(turn.id).filter((event) => {
        const data = event.data as { item?: { id: string }; itemId?: string };
        return (data.itemId ?? data.item?.id) === commandItemId;
      });
      const commandItem = store
        .listThreadItems('ws_demo', 'th_demo')
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
    const { app, coreDb, executor } = createRemoteGitProductFixture({
      commit: REMOTE_GIT_COMMIT,
      url: REMOTE_GIT_URL,
    });
    const prepareSpy = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const startSpy = vi.spyOn(executor, 'startTurn');

    try {
      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: '0190f4c8-0000-7000-8000-000000000314',
          input: 'Use the exact remote Git source',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const turn = (await turnResponse.json()) as { agentSessionId?: string; id?: string };
      const admissions = coreDb.sqlite
        .prepare(
          `SELECT workspace_cwd AS workspaceCwd
           FROM scheduler_admission_entries
           WHERE workspace_id = ?`
        )
        .all('ws_demo') as Array<{ workspaceCwd: string | null }>;
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
      vaultGrantRef: 'grant_git_read',
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
    const turnsBefore = structuredClone(store.listThreadTurns('ws_demo', 'th_demo'));
    const itemsBefore = structuredClone(store.listThreadItems('ws_demo', 'th_demo'));

    try {
      expect(existsSync(canaryPath)).toBe(false);
      const turnResponse = await app.request('/api/turns', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId,
          input: 'Reject an invalid remote Git source',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const payload = (await turnResponse.json()) as Record<string, unknown>;

      expect.soft(turnResponse.status, JSON.stringify(payload)).toBe(409);
      expect.soft(payload).toMatchObject({ code: 'workspace_data_source_blocked' });
      expect.soft(prepareSpy).toHaveBeenCalledTimes(0);
      expect.soft(startSpy).toHaveBeenCalledTimes(0);
      expect
        .soft(
          coreDb.sqlite
            .prepare(`SELECT * FROM scheduler_admission_entries WHERE workspace_id = ?`)
            .all('ws_demo')
        )
        .toEqual([]);
      expect
        .soft(
          coreDb.sqlite
            .prepare(`SELECT * FROM scheduler_session_leases WHERE workspace_id = ?`)
            .all('ws_demo')
        )
        .toEqual([]);
      expect.soft(store.listWorkspaceAgentSessions('ws_demo')).toEqual([]);
      expect.soft(listWorkerBackendSessions(coreDb)).toEqual([]);
      expect.soft(store.listThreadTurns('ws_demo', 'th_demo')).toEqual(turnsBefore);
      expect.soft(store.listThreadItems('ws_demo', 'th_demo')).toEqual(itemsBefore);
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
