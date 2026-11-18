import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import * as productOwners from './runtime/product-turn-start.js';
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

it('keeps exact Task replay through native terminal progress and refuses fresh busy work', async () => {
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
