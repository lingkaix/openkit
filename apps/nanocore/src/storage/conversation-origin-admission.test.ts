import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as knowledgeOwners from '../knowledge-operations.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { commandInputHash, conversationTaskTurnId } from '../runtime/idempotent-command.js';
import * as productOwners from '../runtime/product-turn-start.js';
import * as loopOwners from '../runtime/worker-turn-loop.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { assistantWiringFixture, conversationBody } from '../test-support/mode-entry-fixture.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
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
