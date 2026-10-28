import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import type { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import * as productOwners from './runtime/product-turn-start.js';
import type { TurnStartRuntimeContext } from './runtime/types.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import * as loopOwners from './runtime/worker-turn-loop.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { observeExecutionAttempts } from './test-support/mode-entry-fixture.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Waits until the exact attempt and worker checkpoint owners have finished selected-Worker closeout.
 *
 * `HoldingTurnExecutor.finished` resolves before checkpoint, attempt, and Workspace DB cleanup.
 *
 * @param input Durable lineage and checkpoint outcome; successful closeout is the default, while execution exceptions preserve the admitted state.
 */
async function waitForSelectedWorkerLoopCloseout(input: {
  readonly coreDb: ReturnType<typeof openCoreDb>;
  readonly dataRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly checkpointOutcome?: 'completed' | 'preserved';
}): Promise<void> {
  await vi.waitFor(() => {
    const attempts = observeExecutionAttempts(input.coreDb).filter(
      (attempt) => attempt.turn_id === input.turnId
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      attempts.every(
        (attempt) =>
          attempt.phase === (input.checkpointOutcome === 'preserved' ? 'closing' : 'closed')
      )
    ).toBe(true);
    const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
    try {
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        input.workspaceId,
        input.threadId,
        input.turnId
      );
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.workerSessionId).toBe(attempts[0]!.agent_session_id);
      expect(checkpoint).toMatchObject(
        input.checkpointOutcome === 'preserved'
          ? { stage: 'running_worker', stopReason: null }
          : { stage: 'completed', stopReason: 'completed' }
      );
    } finally {
      workspaceDb.sqlite.close();
    }
  });
}

describe('reasoning effort admission and replay', () => {
  it.each([
    { entry: 'turn.start', supplied: 'none', defaultEffort: 'high', expected: 'none' },
    { entry: 'turn.start', supplied: undefined, defaultEffort: 'high', expected: 'high' },
    { entry: 'turn.start', supplied: undefined, defaultEffort: undefined, expected: undefined },
    { entry: 'conversation.submit', supplied: 'none', defaultEffort: 'high', expected: 'none' },
    { entry: 'conversation.submit', supplied: undefined, defaultEffort: 'high', expected: 'high' },
    {
      entry: 'conversation.submit',
      supplied: undefined,
      defaultEffort: undefined,
      expected: undefined,
    },
  ] as const)('records submission then Agent default for $entry: %j', async ({
    entry,
    supplied,
    defaultEffort,
    expected,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-effort-admission-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordTestNativeRuntimeTarget(coreDb);
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n);
    const executor = Object.assign(new SimulatedTurnExecutor({ coreDb, fileAdmission }), {
      startContexts: [] as TurnStartRuntimeContext[],
    });
    const starts = vi.spyOn(executor, 'startTurn').mockImplementation((...args) => {
      executor.startContexts.push(args[3]!);
      return SimulatedTurnExecutor.prototype.startTurn.call(executor, ...args);
    });
    const products = vi.spyOn(productOwners, 'startProductTurn');
    const loops = vi.spyOn(loopOwners, 'runWorkerTurnLoop');
    const storeOwner = Object.getPrototypeOf(store) as FsStore;
    const creates = vi.spyOn(storeOwner, 'createItem');
    const updates = vi.spyOn(storeOwner, 'updateItem');
    const setup = createTestAgentSetup();
    const manifest = {
      ...setup.manifest,
      models: {
        ...setup.manifest.models,
        ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
      },
    };
    const makeApp = (activeStore: FsStore) =>
      createApp({
        coreDb,
        dataRoot,
        fileAdmission,
        store: activeStore,
        agentManifests: [manifest],
        openKitConfig: { defaults: { defaultAgentId: manifest.id } },
        turnExecutor: executor,
      });
    const app = makeApp(store);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const payload =
      entry === 'turn.start'
        ? {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            requestId: '00000000-0000-4000-8000-000000000777',
            input: 'Implement the focused correction.',
            agentId: manifest.id,
          }
        : {
            requestId: '00000000-0000-4000-8000-000000000777',
            input: 'Implement the focused correction.',
            targetRef: 'new-task-worker',
            artifactRefs: [],
          };
    const body = { ...payload, ...(supplied !== undefined ? { reasoningEffort: supplied } : {}) };
    const post = (targetApp: typeof app, input: unknown) =>
      targetApp.request(
        ...operationRequest(
          entry,
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );
    try {
      const response = await post(app, body);
      expect(response.status, await response.clone().text()).toBe(202);
      const accepted = await response.json();
      const turn = entry === 'turn.start' ? accepted : accepted.turn;
      if (expected === undefined) expect(turn).not.toHaveProperty('reasoningEffort');
      else expect(turn).toHaveProperty('reasoningEffort', expected);
      for (const owner of [products, loops, starts, creates, updates])
        await Promise.all(owner.mock.results.map((result) => result.value));
      await vi.waitFor(() => expect(store.getTurnById(turn.id).status).toBe('completed'));
      if (entry === 'conversation.submit')
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        });
      await vi.waitFor(() =>
        expect(
          observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === turn.id)?.phase
        ).toBe('closed')
      );
      const launches = executor.startContexts.length;
      manifest.models = { ...manifest.models, reasoningEffort: 'max' };
      const reloaded = await createDemoStore({ dataRoot });
      if (expected === undefined)
        expect(reloaded.getTurnById(turn.id)).not.toHaveProperty('reasoningEffort');
      else expect(reloaded.getTurnById(turn.id)).toHaveProperty('reasoningEffort', expected);
      const replay = await post(makeApp(reloaded), body);
      expect(replay.status, await replay.clone().text()).toBe(202);
      const replayed = await replay.json();
      expect((entry === 'turn.start' ? replayed : replayed.turn).id).toBe(turn.id);
      if (expected === undefined)
        expect(entry === 'turn.start' ? replayed : replayed.turn).not.toHaveProperty(
          'reasoningEffort'
        );
      else
        expect(entry === 'turn.start' ? replayed : replayed.turn).toHaveProperty(
          'reasoningEffort',
          expected
        );
      expect(executor.startContexts).toHaveLength(launches);
      const conflict = await post(makeApp(reloaded), { ...body, reasoningEffort: 'low' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
      expect(executor.startContexts).toHaveLength(launches);
      await expect(
        reloaded.updateTurn(turn.id, { reasoningEffort: 'low' } as never)
      ).rejects.toThrow('Turn update cannot change field: reasoningEffort');
      const later = await post(makeApp(reloaded), {
        ...payload,
        requestId: '00000000-0000-4000-8000-000000000779',
      });
      expect(later.status, await later.clone().text()).toBe(202);
      const laterResponse = await later.json();
      const laterTurn = entry === 'turn.start' ? laterResponse : laterResponse.turn;
      expect(laterTurn).toHaveProperty('reasoningEffort', 'max');
      await vi.waitFor(() => expect(executor.startContexts).toHaveLength(launches + 1));
      for (const owner of [products, loops, starts, creates, updates])
        await Promise.all(owner.mock.results.map((result) => result.value));
      await vi.waitFor(() =>
        expect(
          observeExecutionAttempts(coreDb).find((attempt) => attempt.turn_id === laterTurn.id)
            ?.phase
        ).toBe('closed')
      );
      if (entry === 'conversation.submit')
        await waitForSelectedWorkerLoopCloseout({
          coreDb,
          dataRoot,
          threadId: laterTurn.threadId,
          turnId: laterTurn.id,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        });
    } finally {
      // Join the real lifecycle and its final display publication before disposing native owners.
      for (const owner of [products, loops, starts, creates, updates]) {
        await Promise.allSettled(owner.mock.results.map((result) => result.value));
      }
      if (productOwners.startProductTurn === products) products.mockRestore();
      if (loopOwners.runWorkerTurnLoop === loops) loops.mockRestore();
      starts.mockRestore();
      if (storeOwner.createItem === creates) creates.mockRestore();
      if (storeOwner.updateItem === updates) updates.mockRestore();
      try {
        await shutdownControlStoreWorkerClient();
      } finally {
        coreDb.sqlite.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it.each([
    'turn.start',
    'conversation.submit',
  ])('rejects unknown effort before %s effects', async (entry) => {
    const store = await createDemoStore();
    const app = createApp({ store });
    const before = store.listThreads('ws_00000000-0000-7000-8000-000000000001').length;
    const input =
      entry === 'turn.start'
        ? {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            requestId: '00000000-0000-4000-8000-000000000778',
            input: 'Run',
            reasoningEffort: 'default',
          }
        : {
            requestId: 'request',
            targetRef: 'new-task-worker',
            input: 'Run',
            reasoningEffort: 'default',
          };
    const response = await app.request(
      ...operationRequest(
        entry,
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    expect(response.status).toBe(400);
    expect(store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(before);
    expect(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    expect(store.listCommandRequests()).toEqual([]);
  });
});

it('publishes resolver effort levels, empty controls, and absent controls in the conversation catalog', async () => {
  const models = ['controlled', 'empty', 'plain'];
  const setup = createTestAgentSetup({ logicalModelId: 'controlled' });
  setup.manifest.models.allowedLogicalModelIds = models;
  const providerRegistry = new ProviderRegistry([
    {
      id: 'agent-openrouter',
      kind: 'local',
      displayName: 'Catalog fixture',
      models,
      modelMetadata: {
        controlled: {
          reasoning: true,
          limit: { context: 1000000 },
          reasoning_options: [{ type: 'effort', values: ['high', 'none'] }],
        },
        empty: { reasoning: true, reasoning_options: [], limit: { context: 1000000 } },
        plain: { reasoning: false, limit: { context: 1000000 } },
      },
    },
  ]);
  const base = createTestGatewayConfig();
  const app = createAppWithWorkspaceAuthority({
    store: await createDemoStore(),
    providerRegistry,
    gatewayConfig: {
      ...base,
      defaultLogicalModelId: 'controlled',
      logicalModels: models.map((id) => ({
        ...base.logicalModels[0]!,
        id,
        displayName: id,
        routes: [{ id, providerProfileId: 'agent-openrouter', providerModel: id }],
      })),
    },
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
  });
  const response = await app.request(
    ...operationRequest(
      'conversation.targets',
      { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      undefined
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const catalog = await response.json();
  const choices = catalog.targets.find(
    (target: { targetRef: string }) => target.targetRef === 'new-task-worker'
  ).logicalModels;
  expect(choices.find((model: { id: string }) => model.id === 'controlled')).toHaveProperty(
    'reasoningEffortLevels',
    ['none', 'high']
  );
  expect(choices.find((model: { id: string }) => model.id === 'empty')).toHaveProperty(
    'reasoningEffortLevels',
    []
  );
  expect(choices.find((model: { id: string }) => model.id === 'plain')).not.toHaveProperty(
    'reasoningEffortLevels'
  );
});

// Restore shared callables before native drain; a timed-out body can still finish later.
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
