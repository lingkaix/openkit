import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import * as productOwners from './runtime/product-turn-start.js';
import * as recoveryOwners from './runtime/worker-recovery.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { createTestCoreDb, disposeTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

const scope = {
  actorId: 'usr_00000000-0000-7000-8000-000000000001',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000001',
};

/**
 * Admits one direct Task through the same native fixture as the terminal-replay race.
 *
 * @returns The app, store, native gates, and an exact `task.start` poster.
 */
async function admitDirectTask() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'task-replay-witness-'));
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
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: scope.workspaceId,
    ownerUserId: scope.actorId,
  });
  const requestId = randomUUID();
  const post = () =>
    Promise.resolve(
      app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: scope.workspaceId, threadId: scope.threadId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, input: 'Implement a focused change.' }),
          }
        )
      )
    );
  return { app, coreDb, dataRoot, native, post, requestId, store };
}

it('returns one terminal projection when two replays collect one retained checkpoint', async () => {
  const fixture = await admitDirectTask();
  const { coreDb, dataRoot, native, post, store } = fixture;
  const refusedClear = vi
    .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
    .mockResolvedValueOnce(false);
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  const releaseCollectors = Promise.withResolvers<void>();
  let closeout: Promise<void> | undefined;
  let first: Promise<Response> | undefined;
  let second: Promise<Response> | undefined;
  try {
    const admitted = await post();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    const accepted = StartTaskModeResponseSchema.parse(await admitted.json());
    closeout = admissions.mock.results.find((result) => result.type === 'return')?.value.closeout;
    expect(closeout).toBeDefined();
    await native.executor.launched.promise;
    native.executor.completion.resolve();
    // The original collector fails before it deletes the row, then drops out of the process-local map.
    await expect(closeout).rejects.toMatchObject({
      code: 'recovery_required',
      message: 'The Task worker checkpoint is not ready for terminal cleanup.',
      status: 409,
    });
    refusedClear.mockRestore();
    const realClear = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
    let entered = 0;
    const bothEntered = Promise.withResolvers<void>();
    vi.spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState').mockImplementation(
      async (...args) => {
        entered += 1;
        if (entered === 2) bothEntered.resolve();
        await bothEntered.promise;
        await releaseCollectors.promise;
        return realClear(...args);
      }
    );
    let left = false;
    let right = false;
    first = post().then((response) => {
      left = true;
      return response;
    });
    second = post().then((response) => {
      right = true;
      return response;
    });
    await bothEntered.promise;
    expect(left, 'Both collectors must be held before either clear.').toBe(false);
    expect(right, 'Both collectors must be held before either clear.').toBe(false);
    releaseCollectors.resolve();
    const [leftResponse, rightResponse] = await Promise.all([first, second]);
    expect(leftResponse.status, await leftResponse.clone().text()).toBe(202);
    expect(rightResponse.status, await rightResponse.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await leftResponse.json())).toMatchObject({
      state: 'completed',
      turn: { id: accepted.turn.id, status: 'completed' },
    });
    expect(StartTaskModeResponseSchema.parse(await rightResponse.json())).toMatchObject({
      state: 'completed',
      turn: { id: accepted.turn.id, status: 'completed' },
    });
    expect(store.listThreadTurns(scope.workspaceId, scope.threadId).map((turn) => turn.id)).toEqual(
      [accepted.turn.id]
    );
    expect(native.executor.launches).toBe(1);
  } finally {
    releaseCollectors.resolve();
    native.executor.completion.resolve();
    await first?.catch(() => undefined);
    await second?.catch(() => undefined);
    await closeout?.catch(() => undefined);
    await native.restore();
    vi.restoreAllMocks();
    await disposeTestStore(dataRoot, coreDb);
  }
}, 60_000);

it('returns the terminal projection after a running replay waits for closeout', async () => {
  const fixture = await admitDirectTask();
  const { coreDb, dataRoot, native, post, store } = fixture;
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
    expect(store.getTurnById(accepted.turn.id).status).toBe('running');
    const originalGetTurnById = store.getTurnById.bind(store);
    let armed = false;
    let reads = 0;
    vi.spyOn(store, 'getTurnById').mockImplementation((turnId: string) => {
      const turn = originalGetTurnById(turnId);
      if (!armed || turnId !== accepted.turn.id) return turn;
      reads += 1;
      // The replay snapshot keeps the real running Turn. The later closeout read observes terminal state.
      if (reads === 1) return turn;
      return { ...turn, status: 'completed' };
    });
    armed = true;
    let responded = false;
    replay = post().then((response) => {
      responded = true;
      return response;
    });
    await setImmediate();
    expect(responded, `Running replay must wait once closeout is terminal (reads=${reads}).`).toBe(
      false
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    native.executor.completion.resolve();
    await releaseEntered.promise;
    expect(responded, 'The waited replay must not answer before the original closeout.').toBe(
      false
    );
    releaseResponse.resolve();
    const response = await replay;
    expect(response.status, await response.clone().text()).toBe(202);
    expect(StartTaskModeResponseSchema.parse(await response.json())).toMatchObject({
      state: 'completed',
      turn: { id: accepted.turn.id, status: 'completed' },
    });
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
}, 60_000);
