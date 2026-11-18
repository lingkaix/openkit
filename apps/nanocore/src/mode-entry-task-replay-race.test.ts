import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { listSchedulerExecutionAttemptsForTurn } from './runtime/execution-attempt-records.js';
import * as productOwners from './runtime/product-turn-start.js';
import { getWorkerCheckpoint, type WorkerCheckpointRecord } from './runtime/worker-checkpoints.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestWorkspaceDb,
  disposeTestStore,
} from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

/** Creates an app with a native Task worker and an exact request that can be replayed. */
async function createTaskReplayFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'task-replay-native-progress-'));
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const native = await createNativeTaskAdmissionFixture(coreDb, store);
  const setup = createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] });
  const app = createAppWithWorkspaceAuthority({
    coreDb,
    dataRoot,
    store,
    turnExecutor: native.executor,
    fileAdmission: native.fileAdmission,
    workerControlGateway: native.workerControlGateway,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
  });
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
  };
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: scope.workspaceId,
    ownerUserId: scope.actorId,
  });
  const requestId = randomUUID();
  const post = (id = requestId) =>
    Promise.resolve(
      app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: scope.workspaceId, threadId: scope.threadId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: id, input: 'Implement a focused change.' }),
          }
        )
      )
    );
  return { coreDb, dataRoot, native, post, requestId, scope, store };
}

it('keeps exact Task replay through native terminal progress and refuses fresh busy work', async () => {
  const { coreDb, dataRoot, native, post, requestId, scope, store } =
    await createTaskReplayFixture();
  const releaseEntered = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  const backend = native.executor.executionBackend!;
  const originalRelease = vi.mocked(backend.release).getMockImplementation()!;
  const heldRelease = vi.spyOn(backend, 'release').mockImplementation(async (input) => {
    const result = await originalRelease(input);
    releaseEntered.resolve();
    await releaseResponse.promise;
    return result;
  });
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  let closeout: Promise<void> | undefined;
  let replay: Promise<Response> | undefined;
  try {
    const admitted = await post();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    const accepted = StartTaskModeResponseSchema.parse(await admitted.json());
    closeout = admissions.mock.results.find((result) => result.type === 'return')?.value.closeout;
    expect(closeout).toBeDefined();
    await native.executor.launched.promise;
    const lastLiveRead = store.getTurnById(accepted.turn.id);
    expect(lastLiveRead.status).toBe('running');
    const receipt = structuredClone(store.getCommandRequest('task.start', requestId, scope));
    const liveReplay = await post();
    expect(liveReplay.status, await liveReplay.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await liveReplay.json()).turn.id).toBe(
      accepted.turn.id
    );
    const fresh = await post(randomUUID());
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toMatchObject({ code: 'thread_busy' });

    native.executor.completion.resolve();
    await releaseEntered.promise;
    expect(store.getTurnById(accepted.turn.id).status).toBe('completed');
    // Reproduce a read begun before the native commit. All records and the held
    // release are real; only delivery of this already-read live snapshot is delayed.
    const staleRead = Promise.withResolvers<void>();
    vi.spyOn(store, 'getTurnById').mockImplementationOnce(() => {
      staleRead.resolve();
      return lastLiveRead;
    });
    let responded = false;
    replay = post().then((response) => {
      responded = true;
      return response;
    });
    await staleRead.promise;
    await setImmediate();
    expect(responded, 'Terminal replay must join the original closeout.').toBe(false);
    releaseResponse.resolve();
    const response = await replay;
    expect(response.status, await response.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await response.json())).toMatchObject({
      state: 'completed',
      turn: { id: accepted.turn.id, status: 'completed' },
    });
    expect(store.getCommandRequest('task.start', requestId, scope)).toEqual(receipt);
    expect(store.listThreadTurns(scope.workspaceId, scope.threadId).map((turn) => turn.id)).toEqual(
      [accepted.turn.id]
    );
    expect(native.executor.launches).toBe(1);
  } finally {
    releaseResponse.resolve();
    native.executor.completion.resolve();
    await replay?.catch(() => undefined);
    await closeout?.catch(() => undefined);
    heldRelease.mockRestore();
    await native.restore();
    vi.restoreAllMocks();
    await disposeTestStore(dataRoot, coreDb);
  }
});

it('collects a retained running checkpoint while two exact replays repair terminal closeout', async () => {
  const { coreDb, dataRoot, native, post, requestId, scope, store } =
    await createTaskReplayFixture();
  const workspaceDb = createTestWorkspaceDb(dataRoot, scope.workspaceId);
  const client = getControlStoreWorkerClient();
  const capability = client.workspaceCapability.bind(client);
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  const promotionEntered = Promise.withResolvers<void>();
  const allowPromotion = Promise.withResolvers<void>();
  const firstClearEntered = Promise.withResolvers<void>();
  const firstClearFinished = Promise.withResolvers<void>();
  const secondPromotionFinished = Promise.withResolvers<void>();
  const secondReceiptRead = Promise.withResolvers<void>();
  let closeout: Promise<void> | undefined;
  let first: Promise<Response> | undefined;
  let second: Promise<Response> | undefined;
  let turnId: string | undefined;
  let refuseTerminalWrite = true;
  let promotions = 0;
  let clears = 0;

  vi.spyOn(client, 'workspaceCapability').mockImplementation(async (db, command) => {
    if (command.kind === 'checkpoint' && command.input.turnId === turnId) {
      const input = command.input;
      if (input.kind === 'update' && input.stage === 'completed') {
        if (refuseTerminalWrite) throw new ControlStoreWorkerError('unavailable', 'not-committed');
        promotions += 1;
        if (promotions === 1) {
          promotionEntered.resolve();
          await allowPromotion.promise;
        } else if (promotions === 2) {
          // The first collector already holds its real native comparison snapshot.
          await firstClearEntered.promise;
          try {
            const now = new Date(Date.parse(input.now) + 1000).toISOString();
            return await capability(db, { ...command, input: { ...input, now } });
          } finally {
            secondPromotionFinished.resolve();
          }
        }
      }
      if (input.kind === 'clear-terminal') {
        clears += 1;
        if (clears === 1) {
          firstClearEntered.resolve();
          if (promotions > 1) await secondPromotionFinished.promise;
          return capability(db, command);
        }
        // Keep the row present until the first replay handles the native comparison result.
        await firstClearFinished.promise;
      }
    }
    return capability(db, command);
  });

  try {
    const admitted = await post();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    turnId = StartTaskModeResponseSchema.parse(await admitted.json()).turn.id;
    closeout = admissions.mock.results.find((result) => result.type === 'return')?.value.closeout;
    expect(closeout).toBeDefined();
    await native.executor.launched.promise;
    native.executor.completion.resolve();
    await expect(closeout).rejects.toMatchObject({ code: 'unavailable', commit: 'not-committed' });
    const receipt = store.getCommandRequest('task.start', requestId, scope);
    expect(receipt?.response).toEqual({ kind: 'turn', id: turnId });
    expect(store.getTurnById(turnId).status).toBe('completed');
    expect(listSchedulerExecutionAttemptsForTurn(coreDb, { ...scope, turnId })).toEqual([
      expect.objectContaining({ phase: 'closed' }),
    ]);
    expect(
      getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId)
    ).toMatchObject({
      stage: 'running_worker',
      stopReason: null,
    });

    refuseTerminalWrite = false;
    first = post().finally(() => firstClearFinished.resolve());
    await Promise.race([promotionEntered.promise, first]);
    expect(promotions).toBe(1);
    const getReceipt = store.getCommandRequest.bind(store);
    vi.spyOn(store, 'getCommandRequest').mockImplementation((...args) => {
      const result = getReceipt(...args);
      if (args[0] === 'task.start' && args[1] === requestId && result?.response.id === turnId)
        secondReceiptRead.resolve();
      return result;
    });
    second = post();
    await Promise.race([secondReceiptRead.promise, second]);
    await setImmediate();
    allowPromotion.resolve();

    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      expect(response.status, await response.clone().text()).toBe(202);
      expect(StartTaskModeResponseSchema.parse(await response.json())).toMatchObject({
        state: 'completed',
        turn: { id: turnId, status: 'completed' },
      });
    }
    expect(getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId)).toBeNull();
    expect(store.getCommandRequest('task.start', requestId, scope)).toEqual(receipt);
    expect(store.listThreadTurns(scope.workspaceId, scope.threadId).map((turn) => turn.id)).toEqual(
      [turnId]
    );
    expect(native.executor.launches).toBe(1);
  } finally {
    allowPromotion.resolve();
    firstClearEntered.resolve();
    firstClearFinished.resolve();
    native.executor.completion.resolve();
    await Promise.allSettled([first, second, closeout]);
    vi.restoreAllMocks();
    await native.restore();
    closeTestCoreDb(workspaceDb);
    await disposeTestStore(dataRoot, coreDb);
  }
}, 60_000);

it('keeps exact Task replay when maintenance repeats the original terminal promotion', async () => {
  const { coreDb, dataRoot, native, post, requestId, scope, store } =
    await createTaskReplayFixture();
  const workspaceDb = createTestWorkspaceDb(dataRoot, scope.workspaceId);
  const client = getControlStoreWorkerClient();
  const capability = client.workspaceCapability.bind(client);
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  const originalPromotion = Promise.withResolvers<void>();
  const maintenancePromotion = Promise.withResolvers<void>();
  const releaseOriginalPromotion = Promise.withResolvers<void>();
  const originalCompare = Promise.withResolvers<void>();
  const maintenancePromoted = Promise.withResolvers<void>();
  const originalSettled = Promise.withResolvers<void>();
  const replayReadTurn = Promise.withResolvers<void>();
  let promotionCalls = 0;
  let clearCalls = 0;
  let turnId: string | undefined;
  let closeout: Promise<void> | undefined;
  let replay: Promise<Response> | undefined;
  let maintenance: Promise<'complete' | 'live'> | undefined;
  let originalSnapshot: WorkerCheckpointRecord | undefined;
  let repeatedSnapshot: WorkerCheckpointRecord | null | undefined;

  vi.spyOn(client, 'workspaceCapability').mockImplementation(async (db, command) => {
    if (command.kind !== 'checkpoint' || command.input.turnId !== turnId)
      return capability(db, command);
    const input = command.input;
    if (input.kind === 'update' && input.stage === 'completed') {
      if (++promotionCalls === 1) {
        originalPromotion.resolve();
        await releaseOriginalPromotion.promise;
      } else if (promotionCalls === 2) {
        maintenancePromotion.resolve();
        await originalCompare.promise;
        try {
          const now = new Date(Date.parse(originalSnapshot!.updatedAt) + 1000).toISOString();
          const result = await capability(db, { ...command, input: { ...input, now } });
          repeatedSnapshot = getWorkerCheckpoint(
            workspaceDb,
            scope.workspaceId,
            scope.threadId,
            input.turnId
          );
          return result;
        } finally {
          maintenancePromoted.resolve();
        }
      }
    }
    if (input.kind === 'clear-terminal') {
      if (++clearCalls === 1) {
        const { kind: _kind, ...snapshot } = input;
        originalSnapshot = snapshot;
        originalCompare.resolve();
        await maintenancePromoted.promise;
      } else {
        await originalSettled.promise;
      }
    }
    return capability(db, command);
  });

  try {
    const admitted = await post();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    turnId = StartTaskModeResponseSchema.parse(await admitted.json()).turn.id;
    closeout = admissions.mock.results.find((result) => result.type === 'return')?.value.closeout;
    expect(closeout).toBeDefined();
    void closeout!.then(originalSettled.resolve, originalSettled.resolve);
    await native.executor.launched.promise;
    native.executor.completion.resolve();
    await Promise.race([originalPromotion.promise, closeout]);

    const receipt = store.getCommandRequest('task.start', requestId, scope);
    expect(receipt?.response).toEqual({ kind: 'turn', id: turnId });
    expect(store.getTurnById(turnId).status).toBe('completed');
    expect(listSchedulerExecutionAttemptsForTurn(coreDb, { ...scope, turnId })).toEqual([
      expect.objectContaining({ phase: 'closed' }),
    ]);
    const checkpoint = getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId);
    expect(checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null });
    maintenance = classifyDirectTaskCheckpointAfterSchedulerRecovery({
      coreDb,
      store,
      workspaceDb,
      checkpoint: checkpoint!,
    });
    await Promise.race([maintenancePromotion.promise, maintenance]);
    expect(promotionCalls).toBe(2);

    const getTurn = store.getTurnById.bind(store);
    vi.spyOn(store, 'getTurnById').mockImplementation((id) => {
      const turn = getTurn(id);
      if (id === turnId) replayReadTurn.resolve();
      return turn;
    });
    let responded = false;
    replay = post().then((response) => {
      responded = true;
      return response;
    });
    await Promise.race([replayReadTurn.promise, replay]);
    await setImmediate();
    expect(responded, 'The replay must wait for the original closeout.').toBe(false);
    releaseOriginalPromotion.resolve();

    const response = await replay;
    expect(response.status, await response.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await response.json())).toMatchObject({
      state: 'completed',
      turn: { id: turnId, status: 'completed' },
    });
    await expect(closeout).resolves.toBeUndefined();
    await expect(maintenance).resolves.toBe('complete');
    expect(originalSnapshot).toBeDefined();
    expect(repeatedSnapshot).toEqual(originalSnapshot);
    expect(getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId)).toBeNull();
    expect(store.getCommandRequest('task.start', requestId, scope)).toEqual(receipt);
    expect(native.executor.launches).toBe(1);
  } finally {
    releaseOriginalPromotion.resolve();
    originalCompare.resolve();
    maintenancePromoted.resolve();
    originalSettled.resolve();
    native.executor.completion.resolve();
    await Promise.allSettled([closeout, maintenance, replay]);
    vi.restoreAllMocks();
    await native.restore();
    closeTestCoreDb(workspaceDb);
    await disposeTestStore(dataRoot, coreDb);
  }
}, 60_000);

it('replays one failed Task when maintenance promotes its checkpoint before live closeout', async () => {
  const { coreDb, dataRoot, native, post, requestId, scope, store } =
    await createTaskReplayFixture();
  const workspaceDb = createTestWorkspaceDb(dataRoot, scope.workspaceId);
  const client = getControlStoreWorkerClient();
  const capability = client.workspaceCapability.bind(client);
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  const originalPromotion = Promise.withResolvers<void>();
  const releaseOriginalPromotion = Promise.withResolvers<void>();
  const maintenanceCompare = Promise.withResolvers<void>();
  const originalSettled = Promise.withResolvers<void>();
  const replayReadTurn = Promise.withResolvers<void>();
  const promotions: Array<{ stopReason?: string | null; diagnosticsSummary?: string | null }> = [];
  let clearCalls = 0;
  let turnId: string | undefined;
  let closeout: Promise<void> | undefined;
  let replay: Promise<Response> | undefined;
  let maintenance: Promise<'complete' | 'live'> | undefined;

  native.peerFaults.failedFinal = true;
  vi.spyOn(client, 'workspaceCapability').mockImplementation(async (db, command) => {
    if (command.kind !== 'checkpoint' || command.input.turnId !== turnId)
      return capability(db, command);
    const input = command.input;
    if (input.kind === 'update' && input.stage === 'failed') {
      promotions.push(input);
      if (promotions.length === 1) {
        originalPromotion.resolve();
        await releaseOriginalPromotion.promise;
      }
    }
    if (input.kind === 'clear-terminal' && ++clearCalls === 1) {
      // Maintenance has published its promotion. Keep that row present for the live writer.
      maintenanceCompare.resolve();
      await originalSettled.promise;
    }
    return capability(db, command);
  });

  try {
    const admitted = await post();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    turnId = StartTaskModeResponseSchema.parse(await admitted.json()).turn.id;
    closeout = admissions.mock.results.find((result) => result.type === 'return')?.value.closeout;
    expect(closeout).toBeDefined();
    void closeout!.then(originalSettled.resolve, originalSettled.resolve);
    await native.executor.launched.promise;
    native.executor.completion.resolve();
    await Promise.race([originalPromotion.promise, closeout]);
    expect(promotions).toHaveLength(1);

    const receipt = store.getCommandRequest('task.start', requestId, scope);
    const failed = store.getTurnById(turnId);
    expect(receipt?.response).toEqual({ kind: 'turn', id: turnId });
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toBeTruthy();
    expect(listSchedulerExecutionAttemptsForTurn(coreDb, { ...scope, turnId })).toEqual([
      expect.objectContaining({ phase: 'closed' }),
    ]);
    const checkpoint = getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId);
    expect(checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null });
    maintenance = classifyDirectTaskCheckpointAfterSchedulerRecovery({
      coreDb,
      store,
      workspaceDb,
      checkpoint: checkpoint!,
    });
    await Promise.race([maintenanceCompare.promise, maintenance]);
    expect(promotions.map((promotion) => promotion.stopReason)).toEqual(['error', 'error']);
    const promoted = getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId);
    expect(promoted).toMatchObject({ stage: 'failed', stopReason: 'error' });

    const getTurn = store.getTurnById.bind(store);
    vi.spyOn(store, 'getTurnById').mockImplementation((id) => {
      const turn = getTurn(id);
      if (id === turnId) replayReadTurn.resolve();
      return turn;
    });
    replay = post();
    await Promise.race([replayReadTurn.promise, replay]);
    await setImmediate();
    releaseOriginalPromotion.resolve();

    const response = await replay;
    expect(response.status, await response.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await response.json())).toMatchObject({
      state: 'failed',
      turn: { id: turnId, status: 'failed', error: failed.error },
    });
    await expect(closeout).resolves.toBeUndefined();
    await expect(maintenance).resolves.toBe('complete');
    expect(promotions[0]?.diagnosticsSummary).toEqual(promotions[1]?.diagnosticsSummary);
    expect(JSON.parse(promoted!.diagnosticsSummary!)).toMatchObject({
      failureSummary: failed.error!.message,
    });
    expect(getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId)).toBeNull();
    expect(store.getCommandRequest('task.start', requestId, scope)).toEqual(receipt);
    expect(native.executor.launches).toBe(1);
  } finally {
    releaseOriginalPromotion.resolve();
    originalSettled.resolve();
    native.executor.completion.resolve();
    await Promise.allSettled([closeout, maintenance, replay]);
    vi.restoreAllMocks();
    await native.restore();
    closeTestCoreDb(workspaceDb);
    await disposeTestStore(dataRoot, coreDb);
  }
}, 60_000);
