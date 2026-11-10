import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { createTaskConversationOperationImplementations } from '../conversation-operation-implementations.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { createOperationEngine } from '../operation-invocation.js';
import { ProviderRegistry } from '../providers/registry.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import * as harnessOwner from '../runtime/nanohost-harness.js';
import { readTaskSteerState } from '../runtime/task-steer-receipt.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { getWorkerControlAcceptedFinalStatus } from '../runtime/worker-control-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { TEST_WORKER_RELEASE_IDENTITY } from '../test-support/release-identity.js';
import { disposeTestStore } from '../test-support/store.js';
import { createThreadOperationImplementations } from '../thread-operation-implementations.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** Uses the existing admission/restart peer for Core ordering, separately from real pinned runtime qualification. */
async function fixture(runtime = { adapter: 'codex', version: '0.166.0' }) {
  const root = mkdtempSync(join(tmpdir(), 'task-steer-harness-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const admission = new WorkspaceMutationAdmission();
  const manifest = createTestAgentSetup({
    adapter: runtime.adapter,
    imageRef: `sha256:${'a'.repeat(64)}`,
    requiredCapabilities: ['trusted-worker-inference-relay'],
  }).manifest;
  manifest.runtime.version = runtime.version;
  admitTestNativeEnvironment(coreDb, manifest);
  const store = await createDemoStore({ dataRoot: root, knowledge: [] });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
  const configuration = createInMemoryRuntimeConfigSnapshot({
    ...loadRuntimeConfig(root),
    agentManifests: [manifest],
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Steer fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
  });
  const native = await createNativeTaskAdmissionFixture(coreDb, store, {
    readRuntimeConfig: () => configuration,
    workspaceMutationAdmission: admission,
  });
  const handles: ReturnType<typeof openWorkspaceDb>[] = [];
  let cleanupTurn: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
  cleanups.push(async () => {
    await cleanupTurn?.cleanup();
    await native.restore();
    await disposeTestStore(root, ...handles, coreDb);
  });
  const requestId = randomUUID();
  const turnId = allocateEntityId('tu');
  const actor = { kind: 'user', id: userId } as const;
  const scope = { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID, actorId: userId };
  const timestamp = new Date().toISOString();
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    requestId,
    queueEntryId: `steer-original-${turnId}`,
    requestedAgentId: manifest.id,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: DEMO_THREAD_ID,
    turnId,
    turnInput: 'Original Task work',
    triggerActor: actor,
  });
  await store
    .createTurn(entry.workspaceId, entry.threadId, entry.turnInput, actor, undefined, {
      turnId,
      status: 'pending',
      agentId: manifest.id,
      executorKind: 'worker',
      commandReceipt: {
        key: commandRequestKey('turn.start', requestId, scope),
        command: 'turn.start',
        requestId,
        scope,
        inputHash: commandInputHash({
          queueEntryId: entry.queueEntryId,
          turnInput: entry.turnInput,
        }),
        responseKind: 'turn',
        createdAt: timestamp,
        expiresAt: commandRequestExpiresAt(timestamp),
      },
    })
    .catch((cause) => {
      throw new Error('Fixture pending Turn publication failed.', { cause });
    });
  const agentSessionId = allocateEntityId('as');
  const admitted = await native
    .admitTurn(entry, {
      attemptId: testEntityId('attempt', `steer-${turnId}`),
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    })
    .catch((cause) => {
      throw new Error('Fixture exact native admission failed.', { cause });
    });
  cleanupTurn = admitted;
  const dependencies = {
    coreDb,
    store,
    turnExecutor: native.executor,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: admission,
    repositoryWorkspaceDb: (workspaceId: string) => {
      const db = openWorkspaceDb(root, workspaceId);
      handles.push(db);
      return db;
    },
  };
  const implementations = createTaskConversationOperationImplementations(dependencies);
  const threadImplementations = createThreadOperationImplementations(dependencies);
  const invoke = createOperationEngine(
    {
      'task.steer': implementations['task.steer'],
      'thread.timeline': threadImplementations['thread.timeline'],
    },
    dependencies
  );
  const context = { kind: 'public' as const, actor: { kind: 'local' as const, userId } };
  const input = {
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    turnId,
    requestId: randomUUID(),
    input: '  Same-Turn instruction\n',
  };
  return {
    root,
    coreDb,
    store,
    native,
    admitted,
    invoke,
    input,
    context,
    scope,
    entry,
    userId,
    manifest,
    admission,
    configuration,
    inflightCommands: dependencies.inflightCommands,
  };
}

describe('Task steer through the existing native Harness slot', () => {
  it('refuses a recreated lifecycle owner before exact live-worker adoption without creating an input Item', async () => {
    const f = await fixture();
    const before = f.store.getTurnById(f.input.turnId);
    const cold = createConfiguredWorkerLifecycleRuntime({
      releaseIdentity: TEST_WORKER_RELEASE_IDENTITY,
      coreDb: f.coreDb,
      store: f.store,
      workerControlGateway: f.native.workerControlGateway,
      readRuntimeConfig: () => f.configuration,
      workspaceMutationAdmission: f.admission,
    });
    const dependencies = {
      coreDb: f.coreDb,
      store: f.store,
      turnExecutor: cold.turnExecutor,
      workspaceMutationAdmission: f.admission,
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (workspaceId: string) => openWorkspaceDb(f.root, workspaceId),
    };
    const operations = createTaskConversationOperationImplementations(dependencies);
    const invoke = createOperationEngine({ 'task.steer': operations['task.steer'] }, dependencies);
    await expect(invoke('task.steer', f.input, f.context)).rejects.toMatchObject({
      code: 'steer_target_stale',
      status: 409,
    });
    expect(f.store.getTurnById(f.input.turnId)).toEqual(before);
    expect(f.native.steerCalls).toHaveLength(0);
    expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
  }, 30_000);

  it('preserves a fresh admission dependency refusal after the Item commit and before private enqueue', async () => {
    const f = await fixture();
    let itemCommitted = false;
    const emit = f.store.emitTurnEvent.bind(f.store);
    vi.spyOn(f.store, 'emitTurnEvent').mockImplementation((turnId, event) => {
      const result = emit(turnId, event);
      if (
        turnId === f.input.turnId &&
        event.event === 'item.completed' &&
        event.requestId === f.input.requestId
      )
        itemCommitted = true;
      return result;
    });
    const enter = f.admission.enter.bind(f.admission);
    vi.spyOn(f.admission, 'enter').mockImplementation((...args) => {
      if (itemCommitted)
        throw new OperationError(
          'operation_storage_unavailable',
          'Current authority storage is unavailable.',
          503
        );
      return enter(...args);
    });
    await expect(f.invoke('task.steer', f.input, f.context)).rejects.toMatchObject({
      code: 'operation_storage_unavailable',
      status: 503,
    });
    expect(itemCommitted).toBe(true);
    expect(f.native.steerCalls).toHaveLength(0);
    expect(
      f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)?.response.steerMetadata
    ).toMatchObject({
      disposition: 'refused',
      refusal: { code: 'operation_storage_unavailable', status: 503 },
    });
  }, 30_000);

  it('settles native accepted steer while the original Task reaches its terminal acceptance barrier', async () => {
    const f = await fixture();
    const accepted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const collecting = Promise.withResolvers<void>();
    const backend = f.native.executor.executionBackend!;
    const collect = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async (...args) => {
      collecting.resolve();
      return await collect(...args);
    });
    const consume = f.native.runtime.acceptNanoHostHarnessResult.bind(f.native.runtime);
    vi.spyOn(f.native.runtime, 'acceptNanoHostHarnessResult').mockImplementation(async (result) => {
      if (result.body.state === 'accepted') {
        const command = f.native.steerCalls.find(
          (command) => command.operationId === result.operationId
        );
        expect(command).toMatchObject({
          operation: 'turn.steer',
          body: {
            workspaceId: f.input.workspaceId,
            threadId: f.input.threadId,
            turnId: f.input.turnId,
            input: f.input.input,
          },
        });
        expect(result).toMatchObject({
          operationId: command!.operationId,
          harnessInstanceId: command!.harnessInstanceId,
          sequence: command!.sequence,
          disposition: 'succeeded',
          body: {
            state: 'accepted',
            turnId: f.input.turnId,
            inputItemId: command!.body.inputItemId,
            inputDigest: createHash('sha256').update(f.input.input).digest('hex'),
          },
        });
        accepted.resolve();
        await release.promise;
      }
      return await consume(result);
    });
    const first = f.invoke('task.steer', f.input, f.context);
    void first.catch(() => undefined);
    let completion: ReturnType<typeof f.admitted.complete> | undefined;
    cleanups.push(async () => {
      release.resolve();
    });
    try {
      await Promise.race([
        accepted.promise,
        first.then(() => {
          throw new Error('Steer settled before its held native acceptance.');
        }),
      ]);
      expect(f.native.steerCalls).toHaveLength(1);
      const originalItems = f.store
        .getTurnById(f.input.turnId)
        .items.filter((item) => item.causationId === `task.steer:${f.input.requestId}`);
      expect(originalItems).toHaveLength(1);
      expect(originalItems[0]).toMatchObject({
        id: f.native.steerCalls[0]!.body.inputItemId,
        turnId: f.input.turnId,
        text: f.input.input,
      });
      expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
      completion = f.admitted.complete();
      void completion.catch(() => undefined);
      // Worker Control Final Status: durable native terminal evidence is not Core closeout.
      const terminalAccepted = vi.waitFor(
        () => {
          expect(f.native.executor.nativeLineage).toMatchObject({
            workspaceId: f.input.workspaceId,
            threadId: f.input.threadId,
            turnId: f.input.turnId,
          });
          expect(
            getWorkerControlAcceptedFinalStatus(f.coreDb, f.native.executor.nativeLineage!)
          ).toMatchObject({ status: 'completed', stopReason: 'completed' });
        },
        { timeout: 30_000 }
      );
      // Exercise real terminal collection while the accepted steer still occupies the slot.
      const terminalCollection = Promise.all([terminalAccepted, collecting.promise]);
      await Promise.race([
        terminalCollection,
        first.then(() => {
          throw new Error('Steer settled before its held native acceptance.');
        }),
        completion.then(() => terminalCollection),
      ]);
      release.resolve();
      const result = await first;
      expect(result).toMatchObject({ delivery: 'accepted', turnId: f.input.turnId });
      await completion;
      expect(f.store.getTurnById(f.input.turnId).status).toBe('completed');
      expect(await f.invoke('task.steer', f.input, f.context)).toEqual(result);
      expect(f.native.steerCalls).toHaveLength(1);
      expect(
        f.store
          .getTurnById(f.input.turnId)
          .items.filter((item) => item.causationId === `task.steer:${f.input.requestId}`)
      ).toEqual(originalItems);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await completion?.catch(() => undefined);
    }
  }, 30_000);

  it('hides an inaccessible private Task target exactly like an absent Thread before input or native effects', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [f.input.workspaceId],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const context = {
      kind: 'public' as const,
      actor: {
        kind: 'token' as const,
        userId: f.userId,
        tokenId: token.tokenId,
        tokenScope: 'workspace' as const,
        tokenWorkspaceIds: [f.input.workspaceId],
      },
    };
    const thread = await f.store.createThread(
      f.input.workspaceId,
      'Protected target title',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: allocateEntityId('usr') }
    );
    const target = await f.store.createTurn(
      f.input.workspaceId,
      thread.id,
      'Protected target input',
      { kind: 'user', id: f.userId }
    );
    const before = f.store.getTurnById(target.id);
    const append = vi.spyOn(f.store, 'createItem');
    const failure = async (threadId: string) => {
      try {
        await f.invoke('task.steer', { ...f.input, threadId, turnId: target.id }, context);
      } catch (error) {
        const value = error as { code: string; status: number; message: string; details?: unknown };
        return {
          code: value.code,
          status: value.status,
          message: value.message,
          details: value.details,
        };
      }
      throw new Error('Protected target was admitted.');
    };
    const hidden = await failure(thread.id);
    expect(hidden).toMatchObject({ code: 'not_found', status: 404 });
    expect(await failure(allocateEntityId('th'))).toEqual(hidden);
    expect(JSON.stringify(hidden)).not.toContain('Protected target');
    expect(append).not.toHaveBeenCalled();
    expect(f.native.steerCalls).toHaveLength(0);
    expect(f.store.getTurnById(target.id)).toEqual(before);
  }, 30_000);

  it.each([
    { adapter: 'codex', version: '0.160.0' },
    { adapter: 'pi', version: '1.3.0' },
    { adapter: 'opencode', version: '2.2.5' },
    { adapter: 'deepseek', version: '0.2.1-rc.5' },
  ])(
    'refuses unqualified $adapter $version before its input Item or private steer command',
    async (runtime) => {
      const f = await fixture(runtime);
      const before = f.store.getTurnById(f.input.turnId);
      await expect(f.invoke('task.steer', f.input, f.context)).rejects.toMatchObject({
        code: 'steer_unsupported',
        status: 409,
      });
      expect(f.store.getTurnById(f.input.turnId)).toEqual(before);
      expect(f.native.steerCalls).toHaveLength(0);
      expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
    },
    30_000
  );

  it('admits the qualified Pi pin through the same Core producer and completed receipt owner', async () => {
    const f = await fixture({ adapter: 'pi', version: '1.4.0' });
    expect(await f.invoke('task.steer', f.input, f.context)).toMatchObject({
      delivery: 'accepted',
      turnId: f.input.turnId,
    });
    expect(f.native.steerCalls).toHaveLength(1);
    expect(f.native.steerCalls[0]!.body.input).toBe(f.input.input);
    expect(
      f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)?.response.steerMetadata
        ?.disposition
    ).toBe('accepted');
  }, 30_000);

  it('shows Sending only for the exact live Harness attempt and refuses another request before its Item', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const accept = f.native.runtime.acceptNanoHostHarnessCommand.bind(f.native.runtime);
    vi.spyOn(f.native.runtime, 'acceptNanoHostHarnessCommand').mockImplementation(
      async (command) => {
        if (command.operation === 'turn.steer') {
          entered.resolve();
          await release.promise;
        }
        return await accept(command);
      }
    );
    const first = f.invoke('task.steer', f.input, f.context);
    void first.catch(() => undefined);
    await entered.promise;
    try {
      const item = f.store.getTurnById(f.input.turnId).items.at(-1)!;
      expect(
        readTaskSteerState(f.store, f.input.workspaceId, f.input.threadId, item, {
          coreDb: f.coreDb,
        })
      ).toMatchObject({ state: 'unknown' });
      const timeline = await f.invoke(
        'thread.timeline',
        {
          workspaceId: f.input.workspaceId,
          threadId: f.input.threadId,
          view: 'items',
          turnId: f.input.turnId,
          placement: 'all',
          limit: 50,
        },
        f.context
      );
      expect(timeline.items.find((row) => row.id === item.id)?.steer).toMatchObject({
        state: 'sending',
      });
      await expect(
        f.invoke('task.steer', { ...f.input, requestId: randomUUID() }, f.context)
      ).rejects.toMatchObject({ code: 'steer_busy' });
      expect(
        f.store
          .getTurnById(f.input.turnId)
          .items.filter((row) => row.causationId?.startsWith('task.steer:'))
      ).toHaveLength(1);
      const coldDependencies = {
        coreDb: f.coreDb,
        store: f.store,
        turnExecutor: f.native.executor,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        inflightCommands: new WeakMap(),
        repositoryWorkspaceDb: (workspaceId: string) => openWorkspaceDb(f.root, workspaceId),
      };
      const coldOperations = createTaskConversationOperationImplementations(coldDependencies);
      const cold = createOperationEngine(
        { 'task.steer': coldOperations['task.steer'] },
        coldDependencies
      );
      await expect(cold('task.steer', f.input, f.context)).rejects.toMatchObject({
        code: 'steer_outcome_unknown',
      });
      expect(f.native.steerCalls).toHaveLength(0);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
    }
    expect(f.native.steerCalls).toHaveLength(1);
  }, 30_000);

  it('suppresses unsent steer when interrupt authorization wins and frees the sole slot for interrupt', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const accept = f.native.runtime.acceptNanoHostHarnessCommand.bind(f.native.runtime);
    vi.spyOn(f.native.runtime, 'acceptNanoHostHarnessCommand').mockImplementation(
      async (command) => {
        if (command.operation === 'turn.steer') {
          entered.resolve();
          await release.promise;
        }
        return await accept(command);
      }
    );
    const backend = f.native.executor.executionBackend!;
    const cancel = backend.cancel.bind(backend);
    vi.spyOn(backend, 'cancel').mockImplementation(async (correlation) => {
      expect(requireSchedulerExecutionAttempt(f.coreDb, correlation.attemptId).phase).toBe(
        'closing'
      );
      closing.resolve();
      return await cancel(correlation);
    });
    const first = f.invoke('task.steer', f.input, f.context);
    void first.catch(() => undefined);
    let stop: Promise<void> | undefined;
    cleanups.push(async () => {
      release.resolve();
    });
    try {
      await entered.promise;
      stop = f.native.executor.interruptTurn!(f.store, f.input.turnId, { requestId: randomUUID() });
      void stop.catch(() => undefined);
      await Promise.race([
        closing.promise,
        stop.then(() => {
          throw new Error('Interrupt completed without the closing owner observation.');
        }),
      ]);
      expect(requireSchedulerExecutionAttempt(f.coreDb, f.admitted.attempt.attemptId).phase).toBe(
        'closing'
      );
      const closingTimeline = await f.invoke(
        'thread.timeline',
        {
          workspaceId: f.input.workspaceId,
          threadId: f.input.threadId,
          view: 'items',
          turnId: f.input.turnId,
          placement: 'all',
          limit: 50,
        },
        f.context
      );
      expect(closingTimeline.items.find((item) => item.steer)?.steer).toMatchObject({
        state: 'unknown',
      });
      release.resolve();
      await expect(first).rejects.toMatchObject({ code: 'steer_target_stale' });
      await stop;
      await f.admitted.execution;
      expect(f.native.steerCalls).toHaveLength(0);
      expect(f.store.getTurnById(f.input.turnId).status).toBe('interrupted');
      const receipt = f.store.getCommandRequest('task.steer', f.input.requestId, f.scope);
      expect(receipt?.response.steerMetadata).toMatchObject({
        disposition: 'refused',
        turnId: f.input.turnId,
      });
      await expect(f.invoke('task.steer', f.input, f.context)).rejects.toMatchObject({
        code: 'steer_target_stale',
      });
      expect(f.native.steerCalls).toHaveLength(0);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await stop?.catch(() => undefined);
    }
  }, 30_000);

  it('refuses unsent text after caller Token revocation while the original Task remains live', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [f.input.workspaceId],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const context = {
      kind: 'public' as const,
      actor: {
        kind: 'token' as const,
        userId: f.userId,
        tokenId: token.tokenId,
        tokenScope: 'workspace' as const,
        tokenWorkspaceIds: [f.input.workspaceId],
      },
    };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const accept = f.native.runtime.acceptNanoHostHarnessCommand.bind(f.native.runtime);
    vi.spyOn(f.native.runtime, 'acceptNanoHostHarnessCommand').mockImplementation(
      async (command) => {
        if (command.operation === 'turn.steer') {
          entered.resolve();
          await release.promise;
        }
        return await accept(command);
      }
    );
    cleanups.push(async () => {
      release.resolve();
    });
    const first = f.invoke('task.steer', f.input, context);
    void first.catch(() => undefined);
    try {
      await entered.promise;
      expect(revokeOpenKitAccessTokenRecord(f.coreDb, token.tokenId)?.status).toBe('revoked');
      release.resolve();
      await expect(first).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
      expect(f.native.steerCalls).toHaveLength(0);
      expect(f.store.getTurnById(f.input.turnId).status).toBe('running');
      expect(
        f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)?.response.steerMetadata
      ).toMatchObject({
        disposition: 'refused',
        reason: 'workspace_access_denied',
        refusal: { code: 'workspace_access_denied', status: 403 },
      });
    } finally {
      release.resolve();
      await first.catch(() => undefined);
    }
  }, 30_000);

  it('shares actor, target and completed receipt across HTTP and remote MCP without another native call', async () => {
    const f = await fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.userId,
      scope: 'workspace',
      workspaceIds: [f.input.workspaceId],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const app = createApp({
      dataRoot: f.root,
      coreDb: f.coreDb,
      store: f.store,
      mode: 'local',
      localUserId: f.userId,
      turnExecutor: f.native.executor,
      workspaceMutationAdmission: f.admission,
      agentManifests: [f.manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: f.configuration.providerRegistry,
    });
    const http = async (input: typeof f.input) =>
      app.request('http://127.0.0.1/api/app/operations/task.steer', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token.secret}`,
          'x-openkit-request-id': input.requestId,
        },
        body: JSON.stringify(input),
      });
    const mcp = async (input: typeof f.input) => {
      const response = await app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.secret}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'openkit_call', arguments: { operation: 'task.steer', input } },
        }),
      });
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope.error).toBeUndefined();
      return JSON.parse(envelope.result.content[0].text);
    };
    const first = await http(f.input);
    expect(first.status, await first.clone().text()).toBe(200);
    const accepted = await first.json();
    expect(await mcp(f.input)).toEqual(accepted);
    expect(f.native.steerCalls).toHaveLength(1);
    expect(f.store.getTurnById(f.input.turnId).items.at(-1)).toMatchObject({
      actor: { kind: 'user', id: f.userId },
      text: f.input.input,
    });
    const conflict = { ...f.input, input: 'Changed original instruction' };
    const httpConflict = await http(conflict);
    expect(httpConflict.status).toBe(409);
    expect((await httpConflict.json()).code).toBe('idempotency_key_conflict');
    expect(await mcp(conflict)).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.native.steerCalls).toHaveLength(1);
    const workspace = openWorkspaceDb(f.root, f.input.workspaceId);
    try {
      const audit = listWorkspaceAuditEvents(workspace, f.input.workspaceId).filter(
        (row) => row.action === 'task.steer'
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.authentication).toEqual({
        credentialKind: 'token',
        credentialId: token.tokenId,
      });
    } finally {
      workspace.sqlite.close();
    }
    const audits = listServerAuditEvents(f.coreDb).filter(
      (row) => row.action === 'remote-mcp.request'
    );
    expect(audits[0]!.authentication).toEqual({
      credentialKind: 'token',
      credentialId: token.tokenId,
    });
    expect(audits[0]!.summary).toContain('remote-mcp');
    expect(audits[0]!.actor).toEqual({ kind: 'user', id: f.userId });
  }, 30_000);

  it('publishes refs only, commits receipt before private consumption, and replays after genuine Task terminal', async () => {
    const f = await fixture();
    const before = f.store.getTurnById(f.input.turnId);
    const acknowledgement = harnessOwner.acknowledgeNanoHostHarnessResult;
    const passThrough = vi.mocked(acknowledgement).getMockImplementation()!;
    let checked = false;
    vi.mocked(acknowledgement).mockImplementation(async (db, input) => {
      const row = db.sqlite
        .prepare('SELECT operation FROM harness_instance_records WHERE harness_instance_id=?')
        .get(input.result.harnessInstanceId) as { operation: string };
      if (row.operation === 'turn.steer') {
        const receipt = f.store.getCommandRequest('task.steer', f.input.requestId, f.scope);
        expect(receipt?.response.steerMetadata?.disposition).toBe('accepted');
        const command = db.sqlite
          .prepare(
            'SELECT command_body_json FROM harness_instance_records WHERE harness_instance_id=?'
          )
          .get(input.result.harnessInstanceId) as { command_body_json: string };
        const refs = JSON.parse(command.command_body_json);
        expect(refs).not.toHaveProperty('input');
        expect(refs.inputItemId).toBe(receipt!.response.steerMetadata!.inputItemId);
        expect(f.store.getTurnById(f.input.turnId).items.at(-1)?.text).toBe(f.input.input);
        checked = true;
      }
      return await passThrough(db, input);
    });
    const result = await f.invoke('task.steer', f.input, f.context).catch((cause) => {
      throw new Error('Exact public steer failed.', { cause });
    });
    expect(checked).toBe(true);
    expect(f.native.steerCalls).toHaveLength(1);
    expect(f.native.steerCalls[0]!.body.input).toBe(f.input.input);
    const current = f.store.getTurnById(f.input.turnId);
    expect({ ...current, items: before.items }).toEqual(before);
    await f.admitted.complete().catch((cause) => {
      throw new Error('Original Task closeout failed.', { cause });
    });
    expect(f.store.getTurnById(f.input.turnId).status).toBe('completed');
    expect(await f.invoke('task.steer', f.input, f.context)).toEqual(result);
    expect(f.native.steerCalls).toHaveLength(1);
  }, 30_000);
});
