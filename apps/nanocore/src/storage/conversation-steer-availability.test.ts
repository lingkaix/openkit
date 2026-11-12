import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationTargetCatalogSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openWorkspaceDb } from './db.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** Creates public product/configuration owners; native binding state is never seeded with SQL. */
async function fixture(runtime = { adapter: 'codex', version: '0.166.0' }) {
  const root = mkdtempSync(join(tmpdir(), 'conversation-steer-availability-'));
  const coreDb = createTestCoreDb(root);
  cleanups.push(() => disposeTestStore(root, coreDb));
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root, knowledge: [] });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const manifest = createTestAgentSetup({
    adapter: runtime.adapter,
    imageRef: `sha256:${'a'.repeat(64)}`,
    requiredCapabilities: ['trusted-worker-inference-relay'],
  }).manifest;
  manifest.runtime.version = runtime.version;
  admitTestNativeEnvironment(coreDb, manifest);
  const admission = new WorkspaceMutationAdmission();
  const configuration = createInMemoryRuntimeConfigSnapshot({
    ...loadRuntimeConfig(root),
    agentManifests: [manifest],
    gatewayConfig: createTestGatewayConfig(),
    openKitConfig: { defaults: { defaultAgentId: manifest.id } },
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Catalog fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
  });
  const options = {
    coreDb,
    store,
    dataRoot: root,
    workspaceMutationAdmission: admission,
    agentManifests: [manifest],
    gatewayConfig: configuration.gatewayConfig,
    providerRegistry: configuration.providerRegistry,
    openKitConfig: configuration.openKitConfig,
  };
  return { root, coreDb, userId, store, manifest, admission, configuration, options };
}

/** Uses the original native scheduler/adoption fixture. Its external peer does not qualify a real adapter release. */
async function liveFixture(runtime: { adapter: string; version: string }) {
  const f = await fixture(runtime);
  const native = await createNativeTaskAdmissionFixture(f.coreDb, f.store, {
    readRuntimeConfig: () => f.configuration,
    workspaceMutationAdmission: f.admission,
  });
  let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
  cleanups.push(async () => {
    await admitted?.cleanup();
    await native.restore();
  });
  const requestId = randomUUID();
  const turnId = allocateEntityId('tu');
  const actor = { kind: 'user', id: f.userId } as const;
  const scope = { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID, actorId: f.userId };
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    requestId,
    queueEntryId: `catalog-original-${turnId}`,
    requestedAgentId: f.manifest.id,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: DEMO_THREAD_ID,
    turnId,
    turnInput: 'Original Task work',
    triggerActor: actor,
  });
  const timestamp = new Date().toISOString();
  await f.store.createTurn(entry.workspaceId, entry.threadId, entry.turnInput, actor, undefined, {
    turnId,
    status: 'pending',
    agentId: f.manifest.id,
    executorKind: 'worker',
    commandReceipt: {
      key: commandRequestKey('turn.start', requestId, scope),
      command: 'turn.start',
      requestId,
      scope,
      inputHash: commandInputHash({ queueEntryId: entry.queueEntryId, turnInput: entry.turnInput }),
      responseKind: 'turn',
      createdAt: timestamp,
      expiresAt: commandRequestExpiresAt(timestamp),
    },
  });
  const agentSessionId = allocateEntityId('as');
  admitted = await native.admitTurn(entry, {
    attemptId: testEntityId('attempt', `catalog-${turnId}`),
    agentSessionId,
    candidateAgentSessionId: agentSessionId,
  });
  const app = createAppWithLocalIdentity({ ...f.options, turnExecutor: native.executor });
  return { ...f, native, app, turnId, scope };
}

/** Reads the existing authorized catalog and validates its released public shape. */
async function catalog(app: ReturnType<typeof createAppWithLocalIdentity>, threadId?: string) {
  const response = await app.request(
    ...operationRequest('conversation.targets', {
      workspaceId: DEMO_WORKSPACE_ID,
      ...(threadId ? { threadId } : {}),
    })
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return ConversationTargetCatalogSchema.parse(body);
}

describe('Conversation target live-steer availability', () => {
  it('scopes idle and stale Worker continuity without borrowing another Thread or inventing an active Turn', async () => {
    const f = await fixture();
    const app = createAppWithLocalIdentity(f.options);
    const threads = await Promise.all(
      ['idle', 'ready', 'busy'].map((status) =>
        f.store.createThread(DEMO_WORKSPACE_ID, `Worker ${status}`)
      )
    );
    const sessions: string[] = [];
    for (const [index, status] of ['idle', 'ready', 'busy'].entries()) {
      const id = allocateEntityId('as');
      sessions.push(id);
      await f.store.createAgentSession({
        id,
        agentId: f.manifest.id,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: threads[index]!.id,
        status: status as 'idle' | 'ready' | 'busy',
        message: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    for (const thread of threads) {
      const before = f.store.listThreadTurns(DEMO_WORKSPACE_ID, thread.id);
      const result = await catalog(app, thread.id);
      const workers = result.targets.filter((target) => target.kind === 'running-worker');
      expect(workers).toHaveLength(1);
      expect(workers[0]).toMatchObject({
        threadId: thread.id,
        activeTurnId: null,
        steerAvailability: 'unavailable',
      });
      expect(workers[0]!.steerUnavailableReason).toEqual(expect.any(String));
      expect(f.store.listThreadTurns(DEMO_WORKSPACE_ID, thread.id)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('as_');
    }
    await f.store.updateAgentSession(sessions[0]!, { stale: true });
    const stale = await catalog(app, threads[0]!.id);
    expect(stale.targets.find((target) => target.kind === 'running-worker')).toMatchObject({
      availability: 'unavailable',
      activeTurnId: null,
      steerAvailability: 'unavailable',
    });
    const starter = await catalog(app);
    expect(starter.targets.some((target) => target.kind === 'running-worker')).toBe(false);
    for (const target of starter.targets) {
      expect(target.activeTurnId).toBeNull();
      expect(target.steerAvailability).not.toBe('available');
      expect(target.steerUnavailableReason).toEqual(expect.any(String));
    }
  }, 30_000);

  it('keeps the real Goal Coordinator explicitly unsupported rather than offering a Task live-input action', async () => {
    const f = await fixture();
    const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    cleanups.push(async () => {
      db.sqlite.close();
    });
    const created = await executeGoalOperation(
      'goal.create',
      {
        workspaceId: DEMO_WORKSPACE_ID,
        requestId: randomUUID(),
        intent: 'Produce a reviewed plan',
      },
      { actor: { kind: 'local', userId: f.userId } },
      f.store,
      db
    );
    const app = createAppWithLocalIdentity(f.options);
    const result = await catalog(app, created.goal!.threadId);
    const coordinator = result.targets.find((target) => target.kind === 'goal-coordinator');
    expect(coordinator).toBeDefined();
    expect(coordinator).toMatchObject({ activeTurnId: null, steerAvailability: 'unsupported' });
    expect(coordinator!.steerUnavailableReason).toEqual(expect.any(String));
  }, 30_000);

  it.each([
    { adapter: 'codex', version: '0.166.0' },
    { adapter: 'pi', version: '1.4.0' },
  ])(
    'projects the exact adopted $adapter $version live pin independently of ordinary busy availability',
    async (runtime) => {
      const f = await liveFixture(runtime);
      const before = f.store.getTurnById(f.turnId);
      const result = await catalog(f.app, DEMO_THREAD_ID);
      const worker = result.targets.find((target) => target.kind === 'running-worker');
      expect(worker).toMatchObject({
        threadId: DEMO_THREAD_ID,
        availability: 'busy',
        activeTurnId: f.turnId,
        steerAvailability: 'available',
        steerUnavailableReason: null,
      });
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.native.steerCalls).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(before.agentSessionId!);
      const foreign = await f.store.createThread(DEMO_WORKSPACE_ID, 'Other conversation');
      const other = await catalog(f.app, foreign.id);
      expect(other.targets.some((target) => target.kind === 'running-worker')).toBe(false);
      expect(other.targets.every((target) => target.activeTurnId === null)).toBe(true);
      await f.store.updateAgentSession(before.agentSessionId!, { stale: true });
      const stale = await catalog(f.app, DEMO_THREAD_ID);
      expect(
        stale.targets.find((target) => target.kind === 'running-worker')?.steerAvailability
      ).toBe('unavailable');
      const requestId = randomUUID();
      const refused = await f.app.request(
        ...operationRequest(
          'task.steer',
          {
            workspaceId: DEMO_WORKSPACE_ID,
            threadId: DEMO_THREAD_ID,
            turnId: f.turnId,
          },
          { body: JSON.stringify({ requestId, input: 'An old catalog cannot grant admission' }) }
        )
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'steer_target_stale' });
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getCommandRequest('task.steer', requestId, f.scope)).toBeNull();
      expect(f.native.steerCalls).toHaveLength(0);
    },
    30_000
  );

  it('does not advertise or admit stored live work before this native lifecycle owner adopts it', async () => {
    const f = await liveFixture({ adapter: 'codex', version: '0.166.0' });
    const cold = createConfiguredWorkerLifecycleRuntime({
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      coreDb: f.coreDb,
      store: f.store,
      workerControlGateway: f.native.workerControlGateway,
      readRuntimeConfig: () => f.configuration,
      workspaceMutationAdmission: f.admission,
    });
    const app = createAppWithLocalIdentity({ ...f.options, turnExecutor: cold.turnExecutor });
    const before = f.store.getTurnById(f.turnId);
    const result = await catalog(app, DEMO_THREAD_ID);
    expect(result.targets.find((target) => target.kind === 'running-worker')).toMatchObject({
      activeTurnId: f.turnId,
      steerAvailability: 'unavailable',
    });
    const response = await app.request(
      ...operationRequest(
        'task.steer',
        {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: DEMO_THREAD_ID,
          turnId: f.turnId,
        },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            input: 'Do not reconstruct delivery ownership from stored rows',
          }),
        }
      )
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'steer_target_stale' });
    expect(f.store.getTurnById(f.turnId)).toEqual(before);
    expect(f.native.steerCalls).toHaveLength(0);
  }, 30_000);

  it('reports the actual occupied native slot as busy and clears that projection only after the real operation settles', async () => {
    const f = await liveFixture({ adapter: 'codex', version: '0.166.0' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const accept = f.native.runtime.acceptNanoHostHarnessCommand.bind(f.native.runtime);
    // Model only the outside peer latency; Core owns the actual dispatched slot and receipt.
    vi.spyOn(f.native.runtime, 'acceptNanoHostHarnessCommand').mockImplementation(
      async (command) => {
        if (command.operation === 'turn.steer') {
          entered.resolve();
          await release.promise;
        }
        return accept(command);
      }
    );
    const first = f.app.request(
      ...operationRequest(
        'task.steer',
        {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: DEMO_THREAD_ID,
          turnId: f.turnId,
        },
        { body: JSON.stringify({ requestId: randomUUID(), input: 'Hold the actual live slot' }) }
      )
    );
    try {
      await Promise.race([
        entered.promise,
        first.then(async (response) => {
          throw new Error(`Steer did not reach its original native slot: ${await response.text()}`);
        }),
      ]);
      const busy = await catalog(f.app, DEMO_THREAD_ID);
      expect(busy.targets.find((target) => target.kind === 'running-worker')).toMatchObject({
        activeTurnId: f.turnId,
        steerAvailability: 'busy',
      });
    } finally {
      release.resolve();
      await first;
    }
    expect((await first).status).toBe(200);
    const available = await catalog(f.app, DEMO_THREAD_ID);
    expect(available.targets.find((target) => target.kind === 'running-worker')).toMatchObject({
      activeTurnId: f.turnId,
      steerAvailability: 'available',
      steerUnavailableReason: null,
    });
  }, 30_000);

  it.each([
    { adapter: 'codex', version: '0.165.0' },
    { adapter: 'pi', version: '1.3.9' },
  ])(
    'refuses unsupported live $adapter $version even though the native executor has a steer hook',
    async (runtime) => {
      const f = await liveFixture(runtime);
      expect(typeof f.native.executor.steerTurn).toBe('function');
      const before = f.store.getTurnById(f.turnId);
      const result = await catalog(f.app, DEMO_THREAD_ID);
      const worker = result.targets.find((target) => target.kind === 'running-worker');
      expect(worker).toMatchObject({ activeTurnId: f.turnId, steerAvailability: 'unsupported' });
      expect(worker!.steerUnavailableReason).toEqual(expect.any(String));
      const requestId = randomUUID();
      const refused = await f.app.request(
        ...operationRequest(
          'task.steer',
          {
            workspaceId: DEMO_WORKSPACE_ID,
            threadId: DEMO_THREAD_ID,
            turnId: f.turnId,
          },
          {
            body: JSON.stringify({ requestId, input: 'Do not infer support from method presence' }),
          }
        )
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: 'steer_unsupported' });
      expect(f.store.getTurnById(f.turnId)).toEqual(before);
      expect(f.store.getCommandRequest('task.steer', requestId, f.scope)).toBeNull();
      expect(f.native.steerCalls).toHaveLength(0);
    },
    30_000
  );
});
