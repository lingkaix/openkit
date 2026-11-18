import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import * as knowledgeOwners from '../knowledge-operations.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { listSchedulerExecutionAttemptsForTurn } from '../runtime/execution-attempts.js';
import { commandInputHash, conversationTaskTurnId } from '../runtime/idempotent-command.js';
import * as productOwners from '../runtime/product-turn-start.js';
import * as loopOwners from '../runtime/worker-turn-loop.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { assistantWiringFixture, conversationBody } from '../test-support/mode-entry-fixture.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as schedulerOwners from './control-store-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const actorId = 'usr_00000000-0000-7000-8000-000000000001';

it.each(['existing', 'new'] as const)(
  'accepts the %s Worker Thread when safe reload disables its Agent after publication',
  async (entry) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'conversation-worker-readiness-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot, coreDb });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actorId, workspaceId });
    const { manifest } = createTestAgentSetup({
      agentId: 'agent_reload_fixture',
      logicalModelId: 'smart',
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const configRoot = join(dataRoot, 'config');
    const agentPath = join(configRoot, 'agents', 'worker.agent.jsonc');
    mkdirSync(join(configRoot, 'agents'), { recursive: true });
    mkdirSync(join(configRoot, 'providers'), { recursive: true });
    writeFileSync(agentPath, JSON.stringify(manifest));
    writeFileSync(
      join(configRoot, 'server.jsonc'),
      JSON.stringify({ schemaVersion: 1, defaults: { defaultAgentId: manifest.id } })
    );
    const gateway = createTestGatewayConfig({ logicalModelId: 'smart' });
    writeFileSync(join(configRoot, 'gateway.jsonc'), JSON.stringify(gateway));
    const model = gateway.logicalModels[0]!.routes[0]!.providerModel;
    writeFileSync(
      join(configRoot, 'providers', 'agent-openrouter.provider.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent-openrouter',
        kind: 'local',
        displayName: 'Test provider',
        models: [model],
        modelMetadata: { [model]: { limit: { context: 256_000, output: 32_000 } } },
      })
    );
    const manager = createRuntimeConfigManager({ dataRoot });
    if (entry === 'existing') {
      const now = new Date().toISOString();
      await store.createAgentSession({
        id: 'as_00000000-0000-713e-88a7-b182503728ab',
        agentId: manifest.id,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        status: 'idle',
        message: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const executor = new SimulatedTurnExecutor({ coreDb });
    const launches = vi.spyOn(executor, 'startTurn');
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: manager,
      turnExecutor: executor,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalPrepare = knowledgeOwners.createTaskKnowledgePreparation;
    const preparation = vi
      .spyOn(knowledgeOwners, 'createTaskKnowledgePreparation')
      .mockImplementation((dependencies) => {
        const prepare = originalPrepare(dependencies);
        return async (...args) => {
          entered.resolve();
          await release.promise;
          return prepare(...args);
        };
      });
    const loops = vi.spyOn(loopOwners, 'runWorkerTurnLoop');
    const publications = vi.spyOn(store, 'refreshDisplayProjectionItem');
    const requestId = randomUUID();
    const submit = () =>
      app.request(
        ...operationRequest(
          'conversation.submit',
          { workspaceId, threadId: DEMO_THREAD_ID },
          {
            body: conversationBody({
              input: 'Continue this focused work.',
              requestId,
              targetRef:
                entry === 'existing'
                  ? `running-worker:${DEMO_THREAD_ID}:${manifest.id}`
                  : 'new-task-worker',
            }),
          }
        )
      );
    const receipt = () =>
      store.getCommandRequest('conversation.submit', requestId, {
        actorId,
        workspaceId,
        threadId: DEMO_THREAD_ID,
      });
    const admissions = () =>
      listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      });
    const pending = submit();
    try {
      await Promise.race([
        entered.promise,
        pending.then(async (response) => {
          throw new Error(
            `Conversation returned before Worker preparation: ${await response.clone().text()}`
          );
        }),
      ]);
      const [origin] = store.listThreadTurns(workspaceId, DEMO_THREAD_ID);
      const before = { origin, receipt: receipt(), admissions: admissions() };
      writeFileSync(agentPath, JSON.stringify({ ...manifest, readiness: { status: 'disabled' } }));
      expect(await manager.reload({ mode: 'safe', dryRun: false })).toMatchObject({
        status: 'applied',
      });
      expect(
        manager.current().agentManifests.find((candidate) => candidate.id === manifest.id)
          ?.readiness?.status
      ).toBe('disabled');
      release.resolve();

      const first = await pending;
      await Promise.allSettled(loops.mock.results.map((result) => result.value));
      if (first.status === 202) {
        // The accepted-work owner publishes its final display Item after the Worker loop settles.
        const accepted = SubmitConversationResponseSchema.parse(await first.clone().json());
        await vi.waitFor(() =>
          expect(store.getTurnById(accepted.turn.id).items).toContainEqual(
            expect.objectContaining({ id: accepted.item.id, title: 'Worker Turn failed' })
          )
        );
        await Promise.all(publications.mock.results.map((result) => result.value));
        await setImmediate();
      }
      const replay = await submit();
      expect(
        [first.status, replay.status],
        `Initial response: ${await first.clone().text()}\nReplay: ${await replay.clone().text()}`
      ).toEqual([202, 202]);
      const accepted = SubmitConversationResponseSchema.parse(await first.json());
      const repeated = SubmitConversationResponseSchema.parse(await replay.json());
      expect(before.admissions).toEqual([]);
      if (entry === 'existing') {
        expect(before.origin).toMatchObject({ agentId: manifest.id, status: 'pending' });
        expect(before.receipt?.response).toMatchObject({ id: before.origin?.id });
      } else {
        expect(before.origin?.status).toBe('completed');
        expect(before.receipt).toBeNull();
      }
      expect(repeated).toMatchObject({
        outcome: accepted.outcome,
        originatingWorkspaceId: workspaceId,
        originatingThreadId: DEMO_THREAD_ID,
        receivingWorkspaceId: workspaceId,
        receivingThreadId: accepted.receivingThreadId,
        item: { id: accepted.item.id },
        turn: { id: accepted.turn.id, status: 'failed' },
      });
      expect(accepted.receivingThreadId === DEMO_THREAD_ID).toBe(entry === 'existing');
      expect(store.getTurnById(accepted.turn.id)).toMatchObject({
        status: 'failed',
        error: {
          code: 'worker_preparation_failed',
          message: `Agent ${manifest.id} readiness is disabled.`,
        },
      });
      expect(receipt()?.response).toMatchObject({ id: accepted.turn.id });
      expect(admissions()).toMatchObject([
        { requestId, turnId: accepted.turn.id, status: 'admitted' },
      ]);
      expect(
        listSchedulerExecutionAttemptsForTurn(coreDb, {
          workspaceId,
          threadId: accepted.receivingThreadId,
          turnId: accepted.turn.id,
        })
      ).toMatchObject([{ phase: 'closed', disposition: 'not_accepted', operationId: null }]);
      expect(launches).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending, ...loops.mock.results.map((result) => result.value)]);
      preparation.mockRestore();
      loops.mockRestore();
      publications.mockRestore();
      await closeRetrievalServices();
      await disposeTestStore(dataRoot, coreDb);
    }
  }
);

/** Observe real owners while the winning request is paused before Knowledge effects. */
describe('existing Worker origin admission', () => {
  it.each(['complete', 'pre-scheduler-fault', 'interrupt-claim'] as const)(
    'refuses a competing continuation before downstream writes (%s)',
    async (mode) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'worker-origin-admission-'));
      const coreDb = openCoreDb(dataRoot);
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = await createDemoStore({ dataRoot });
      const native = await createNativeTaskAdmissionFixture(coreDb, store);
      const setup = createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
      const thread = await store.createThread(workspaceId, 'Available Worker');
      await store.createAgentSession({
        id: 'as_00000000-0000-713e-88a7-b182503728ab',
        agentId: setup.manifest.id,
        workspaceId,
        threadId: thread.id,
        status: 'idle',
        message: null,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      });
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actorId, workspaceId });
      const app = createAppWithWorkspaceAuthority({
        agentManifests: [setup.manifest],
        coreDb,
        dataRoot,
        store,
        fileAdmission: native.fileAdmission,
        workerControlGateway: native.workerControlGateway,
        turnExecutor: native.executor,
        openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
      });
      const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalPrepare = knowledgeOwners.createTaskKnowledgePreparation;
      let preparations = 0;
      const preparation = vi
        .spyOn(knowledgeOwners, 'createTaskKnowledgePreparation')
        .mockImplementation((dependencies) => {
          const prepare = originalPrepare(dependencies);
          return async (...args) => {
            preparations += 1;
            if (preparations === 1) {
              entered.resolve();
              await release.promise;
            }
            return prepare(...args);
          };
        });
      const loops: Promise<unknown>[] = [];
      const originalLoop = loopOwners.runWorkerTurnLoop;
      const loop = vi.spyOn(loopOwners, 'runWorkerTurnLoop').mockImplementation((input) => {
        const pending = originalLoop(input);
        if (input.store === store) loops.push(pending);
        return pending;
      });
      const targetRef = `running-worker:${encodeURIComponent(thread.id)}:${encodeURIComponent(setup.manifest.id)}`;
      const submit = (requestId: string) =>
        app.request(
          ...operationRequest(
            'conversation.submit',
            {
              workspaceId,
              threadId: thread.id,
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: conversationBody({
                input: 'Continue this focused work.',
                requestId,
                targetRef,
              }),
            }
          )
        );
      const traceDirectory = join(
        dataRoot,
        'workspaces',
        workspaceId,
        'threads',
        thread.id,
        'retrieval-traces'
      );
      const facts = () => ({
        traces: existsSync(traceDirectory) ? readdirSync(traceDirectory).sort() : [],
        checkpoints: workspaceDb.sqlite
          .prepare('SELECT * FROM worker_turn_checkpoints ORDER BY checkpoint_id')
          .all(),
        calls: workspaceDb.sqlite.prepare('SELECT * FROM capability_calls ORDER BY call_id').all(),
        usage: workspaceDb.sqlite.prepare('SELECT * FROM usage_records ORDER BY usage_id').all(),
        admissions: coreDb.sqlite
          .prepare('SELECT * FROM scheduler_admission_entries ORDER BY queue_entry_id')
          .all(),
        turns: store.listThreadTurns(workspaceId, thread.id),
        sessions: store.listWorkspaceAgentSessions(workspaceId),
      });
      const winnerId = randomUUID();
      const pending = submit(winnerId);
      let duplicate: ReturnType<typeof submit> | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(async (response) => {
            throw new Error(
              `Worker returned before preparation: ${response.status} ${await response.clone().text()}`
            );
          }),
        ]);
        const before = facts();
        expect(before.turns).toMatchObject([{ status: 'pending', agentId: setup.manifest.id }]);
        duplicate = submit(winnerId);
        const losingId = randomUUID();
        const loser = await submit(losingId);
        expect(loser.status, await loser.clone().text()).toBe(409);
        expect(await loser.json()).toMatchObject({ code: 'thread_busy' });
        expect(
          store.getCommandRequest('conversation.submit', losingId, {
            actorId,
            workspaceId,
            threadId: thread.id,
          })
        ).toBeNull();
        expect(preparations).toBe(1);
        expect(facts()).toEqual(before);
        expect(native.executor.launches).toBe(0);
        if (mode === 'interrupt-claim') {
          const cold = new FsStore({ dataRoot });
          const restarted = createAppWithWorkspaceAuthority({
            agentManifests: [setup.manifest],
            coreDb,
            dataRoot,
            store: cold,
            fileAdmission: native.fileAdmission,
            workerControlGateway: native.workerControlGateway,
            turnExecutor: native.executor,
            openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
          });
          const admitted = Promise.withResolvers<void>();
          const releaseAdmission = Promise.withResolvers<void>();
          const admit = schedulerOwners.admitCoreScheduler;
          const admission = vi
            .spyOn(schedulerOwners, 'admitCoreScheduler')
            .mockImplementation(async (...args) => {
              const result = await admit(...args);
              if (args[1].mode === 'create' && args[1].entry.turnId === before.turns[0]!.id) {
                admitted.resolve();
                await releaseAdmission.promise;
              }
              return result;
            });
          const complete = cold.completeTurn.bind(cold);
          const cancellation = vi
            .spyOn(cold, 'completeTurn')
            .mockImplementationOnce(async (...args) => {
              release.resolve();
              await Promise.race([
                admitted.promise,
                pending.then(async (response) => {
                  throw new Error(
                    `Worker returned before the admission race: ${response.status} ${await response.clone().text()}`
                  );
                }),
              ]);
              return complete(...args);
            });
          try {
            const stopped = await restarted.request(
              ...operationRequest(
                'turn.interrupt',
                {
                  workspaceId,
                  threadId: thread.id,
                  turnId: before.turns[0]!.id,
                },
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ requestId: randomUUID() }),
                }
              )
            );
            expect(stopped.status, await stopped.clone().text()).toBe(200);
            expect(await stopped.json()).toMatchObject({ status: 'interrupted' });
            releaseAdmission.resolve();
            expect((await pending).status).toBe(409);
            expect((await duplicate).status).toBe(409);
            await Promise.allSettled(loops);
            expect(native.executor.launches).toBe(0);
            expect(facts().admissions).toMatchObject([{ status: 'cancelled' }]);
            expect(
              coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all()
            ).toEqual([]);
            expect(store.getTurnById(before.turns[0]!.id).status).toBe('interrupted');
            const later = await store.createTurn(
              workspaceId,
              thread.id,
              'After explicit interruption',
              { kind: 'user', id: actorId }
            );
            expect(later.status).toBe('running');
          } finally {
            release.resolve();
            releaseAdmission.resolve();
            cancellation.mockRestore();
            admission.mockRestore();
          }
          return;
        }
        if (mode === 'pre-scheduler-fault') {
          const admissionFault = vi
            .spyOn(productOwners, 'startProductTurn')
            .mockRejectedValueOnce(new Error('Injected scheduler preparation fault.'));
          try {
            release.resolve();
            const failed = await pending;
            expect(failed.status).toBe(500);
            expect((await duplicate).status).toBe(500);
            await Promise.allSettled(loops);
            expect(facts().turns).toMatchObject([{ status: 'failed' }]);
            expect(native.executor.launches).toBe(0);
            expect(facts().admissions).toEqual(before.admissions);
            expect(store.getAgentSession('as_00000000-0000-713e-88a7-b182503728ab').status).toBe(
              'idle'
            );
            const later = await store.createTurn(
              workspaceId,
              thread.id,
              'Retry after preparation fault',
              { kind: 'user', id: actorId }
            );
            expect(later.status).toBe('running');
            const beforeReplay = facts();
            const replay = await submit(winnerId);
            expect(replay.status, await replay.clone().text()).toBe(202);
            expect(await replay.json()).toMatchObject({
              turn: { id: before.turns[0]!.id, status: 'failed' },
            });
            expect(facts()).toEqual(beforeReplay);
          } finally {
            admissionFault.mockRestore();
          }
          return;
        }
        release.resolve();
        const accepted = await pending;
        expect(accepted.status, await accepted.clone().text()).toBe(202);
        const repeated = await duplicate;
        expect(repeated.status).toBe(202);
        expect(await repeated.json()).toEqual(await accepted.clone().json());
        await native.executor.launched.promise;
        expect(native.executor.launches).toBe(1);
        native.executor.completion.resolve();
        await native.executor.execution;
        await Promise.all(loops);
        expect(facts().turns).toMatchObject([{ status: 'completed' }]);
        const replay = await submit(winnerId);
        expect(replay.status).toBe(202);
        expect(native.executor.launches).toBe(1);
      } finally {
        release.resolve();
        try {
          const response = await pending;
          if (response.status === 202) await native.executor.launched.promise;
        } finally {
          native.executor.completion.resolve();
          preparation.mockRestore();
          loop.mockRestore();
          await Promise.allSettled([pending, ...(duplicate ? [duplicate] : []), ...loops]);
          await native.restore();
          await closeRetrievalServices();
          await shutdownControlStoreWorkerClient();
          workspaceDb.sqlite.close();
          coreDb.sqlite.close();
          rmSync(dataRoot, { recursive: true, force: true });
        }
      }
    }
  );
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ] as const)(
    'cold interruption handles its exact claim (receipt pruned=%s, admission wins=%s)',
    async (expired, racing) => {
      const setup = createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
      const f = await assistantWiringFixture(false, undefined, false, undefined, false, setup);
      onTestFinished(() => f.close());
      const requestId = randomUUID();
      const scope = { actorId, workspaceId, threadId: f.thread.id };
      const turnId = conversationTaskTurnId(
        { kind: 'user', id: actorId },
        workspaceId,
        f.thread.id,
        f.thread.id,
        requestId
      );
      const targetRef = `running-worker:${encodeURIComponent(f.thread.id)}:${encodeURIComponent(setup.manifest.id)}`;
      const input = 'Continue after a restart.';
      const createdAt = new Date().toISOString();
      const key = commandRequestKey('conversation.submit', requestId, scope);
      await f.store.createTurn(
        workspaceId,
        f.thread.id,
        input,
        { kind: 'user', id: actorId },
        null,
        {
          turnId,
          status: 'pending',
          agentId: setup.manifest.id,
          executorKind: 'worker',
          triggerSource: { kind: 'handoff', summary: 'Task Worker handoff.' },
          commandReceipt: {
            key,
            command: 'conversation.submit',
            requestId,
            scope,
            inputHash: commandInputHash({
              artifactRefs: [],
              input,
              logicalModelId: null,
              targetRef,
              workerStorageChoice: undefined,
            }),
            responseKind: 'turn',
            createdAt,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          commandReceiptResponse: {
            kind: 'turn',
            id: turnId,
            conversationMetadata: {
              targetRef,
              logicalModelId: null,
              receivingWorkspaceId: workspaceId,
              receivingThreadId: f.thread.id,
              downstream: { kind: 'task', turnId },
              resultKind: 'worker-turn',
              status: 202,
            },
          },
        }
      );
      if (expired) {
        const client = getControlStoreWorkerClient();
        const scope = nativeProductScope(f.dataRoot, { kind: 'workspace', workspaceId });
        await client.write(`workspace:${scope.path}`, [
          {
            mode: 'run',
            sql: 'DELETE FROM idempotency_requests WHERE request_key=?',
            parameters: [key],
            expectChanges: 1,
          },
        ]);
      }
      await shutdownControlStoreWorkerClient();
      const cold = new FsStore({ dataRoot: f.dataRoot });
      const app = createAppWithWorkspaceAuthority({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: cold,
        agentManifests: [setup.manifest],
        openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
      });
      if (!expired) {
        const replay = await app.request(
          ...operationRequest(
            'conversation.submit',
            { workspaceId, threadId: f.thread.id },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: conversationBody({ requestId, targetRef, input }),
            }
          )
        );
        expect(replay.status).toBe(409);
        expect(await replay.json()).toMatchObject({ code: 'recovery_required' });
      }
      expect(cold.getTurnById(turnId).status).toBe('pending');
      const stopId = randomUUID();
      const stop = () =>
        app.request(
          ...operationRequest(
            'turn.interrupt',
            { workspaceId, threadId: f.thread.id, turnId },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: stopId }),
            }
          )
        );
      if (racing) {
        const complete = cold.completeTurn.bind(cold);
        const advance = vi.spyOn(cold, 'completeTurn').mockImplementationOnce(async (...args) => {
          await cold.updateTurn(turnId, { status: 'running' });
          return complete(...args);
        });
        try {
          const refusal = await stop();
          expect(refusal.status).toBe(409);
          expect(await refusal.json()).toMatchObject({ code: 'recovery_required' });
          expect(advance).toHaveBeenCalledTimes(1);
          expect(cold.getTurnById(turnId).status).toBe('running');
          expect(
            cold.getCommandRequest('turn.interrupt', stopId, {
              workspaceId,
              threadId: f.thread.id,
              turnId,
            })
          ).toBeNull();
        } finally {
          advance.mockRestore();
        }
        return;
      }
      const stopped = await stop();
      expect(stopped.status, await stopped.clone().text()).toBe(200);
      const result = await stopped.json();
      expect(result).toMatchObject({ status: 'interrupted' });
      if (!expired) {
        const replay = await app.request(
          ...operationRequest(
            'conversation.submit',
            { workspaceId, threadId: f.thread.id },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: conversationBody({ requestId, targetRef, input }),
            }
          )
        );
        expect(replay.status, await replay.clone().text()).toBe(202);
        expect(await replay.json()).toMatchObject({
          turn: { status: 'interrupted' },
          item: { title: 'Worker Turn interrupted' },
        });
      }
      const later = await cold.createTurn(workspaceId, f.thread.id, 'After cold Stop', {
        kind: 'user',
        id: actorId,
      });
      expect(later.status).toBe('running');
      const repeated = await stop();
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(result);
      expect(cold.getTurnById(later.id).status).toBe('running');
      expect(f.dispatchCount()).toBe(0);
    }
  );
});
