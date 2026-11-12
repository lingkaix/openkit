import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationTargetCatalogSchema,
  StartTaskModeResponseSchema,
  SteerTaskResponseSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import * as productTurnStart from '../runtime/product-turn-start.js';
import { readTaskSteerState } from '../runtime/task-steer-receipt.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp, createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** Holds the real scheduler-launched simulator after native delivery proof, without replacing steer or seeding private state. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'simulator-real-task-steer-'));
  const coreDb = createTestCoreDb(root);
  const actor = { kind: 'user', id: ensureLocalUser(coreDb) } as const;
  const release = Promise.withResolvers<void>();
  let running: Promise<void> | undefined;
  const closeouts: Promise<unknown>[] = [];
  const observe = productTurnStart.observeTurnAdmission;
  vi.spyOn(productTurnStart, 'observeTurnAdmission').mockImplementation((input) => {
    const observed = observe(input);
    closeouts.push(observed.closeout);
    return observed;
  });
  cleanups.push(async () => {
    release.resolve();
    await running?.catch(() => undefined);
    await Promise.allSettled(closeouts);
    vi.restoreAllMocks();
    await disposeTestStore(root, coreDb);
  });
  await recordTestNativeRuntimeTarget(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: actor.id });
  const setup = createTestAgentSetup();
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Real simulator live input');
  const fileAdmission = new FileStorageAdmission(root, () => 1_000_000n);
  const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
  const app = createApp({
    coreDb,
    fileAdmission,
    store,
    agentManifests: [setup.manifest],
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    turnExecutor: executor,
  });
  const launched = Promise.withResolvers<{ completion: Promise<void> }>();
  const startTurn = executor.startTurn.bind(executor);
  vi.spyOn(executor, 'startTurn').mockImplementation((...args) => {
    running = startTurn(...args);
    launched.resolve({ completion: running });
    return running;
  });
  const reached = Promise.withResolvers<void>();
  const apply = store.applyPendingRequestCommand.bind(store);
  // Keep the actual proof and its FULL acknowledgement; hold only the response before native finalization.
  vi.spyOn(store, 'applyPendingRequestCommand').mockImplementation(async (...args) => {
    const result = await apply(...args);
    if (args[1].action === 'delivery-prove') {
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  const startResponse = await app.request(
    ...operationRequest(
      'task.start',
      {
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
      },
      { body: JSON.stringify({ requestId: randomUUID(), input: 'Original Task input' }) }
    )
  );
  const startBody = await startResponse.json();
  expect(startResponse.status, JSON.stringify(startBody)).toBe(202);
  const { turn } = StartTaskModeResponseSchema.parse(startBody);
  const execution = await launched.promise;
  await Promise.race([
    reached.promise,
    execution.completion.then(() => {
      throw new Error('Simulator completed before the native live test boundary.');
    }),
  ]);
  expect(executor.isTurnExecutionActive(turn.id)).toBe(true);
  expect(store.getTurnById(turn.id)).toMatchObject({
    status: 'running',
    agentId: setup.manifest.id,
  });
  const input = {
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    turnId: turn.id,
    requestId: randomUUID(),
    input: '  Preserve these exact bytes.\n\tUse the current Task.  ',
  };
  const scope = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id, actorId: actor.id };
  const steer = (value = input, targetApp = app) =>
    targetApp.request(
      ...operationRequest(
        'task.steer',
        {
          workspaceId: value.workspaceId,
          threadId: value.threadId,
          turnId: value.turnId,
        },
        { body: JSON.stringify({ requestId: value.requestId, input: value.input }) }
      )
    );
  const finish = async () => {
    release.resolve();
    await running;
    await Promise.all(closeouts);
    expect(executor.isTurnExecutionActive(turn.id)).toBe(false);
    expect(store.getTurnById(turn.id).status).toBe('completed');
  };
  return { root, store, setup, actor, thread, turn, executor, app, input, scope, steer, finish };
}

describe('Real simulator Task live steer through the public operation', () => {
  it('accepts one exact in-run user Item with a completed receipt, replays after completion, and conflicts changed input', async () => {
    const f = await fixture();
    const before = f.store.getTurnById(f.turn.id);
    const response = await f.steer();
    const body = await response.json();
    expect(
      response.status,
      JSON.stringify({
        response: body,
        active: f.executor.isTurnExecutionActive(f.turn.id),
        sessionStatus: f.store.getAgentSession(before.agentSessionId!).status,
      })
    ).toBe(200);
    const result = SteerTaskResponseSchema.parse(body);
    expect(result).toMatchObject({
      workspaceId: f.input.workspaceId,
      threadId: f.thread.id,
      turnId: f.turn.id,
      delivery: 'accepted',
    });
    const targets = await f.app.request(
      ...operationRequest('conversation.targets', {
        workspaceId: f.input.workspaceId,
        threadId: f.thread.id,
      })
    );
    expect(targets.status).toBe(200);
    const catalog = ConversationTargetCatalogSchema.parse(await targets.json());
    expect(catalog.targets.find((target) => target.kind === 'running-worker')).toMatchObject({
      threadId: f.thread.id,
      activeTurnId: f.turn.id,
      steerAvailability: 'available',
      steerUnavailableReason: null,
    });
    const after = f.store.getTurnById(f.turn.id);
    // Task Live steer: preserve all admission-time metadata, not only the displayed input.
    expect({ ...after, items: before.items }).toEqual(before);
    expect(after.items).toHaveLength(before.items.length + 1);
    const instructions = after.items.filter(
      (item) => item.causationId === `task.steer:${f.input.requestId}`
    );
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      id: result.inputItemId,
      type: 'user-message',
      actor: f.actor,
      turnId: f.turn.id,
      text: f.input.input,
      status: 'completed',
    });
    expect(
      f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)?.response.steerMetadata
    ).toMatchObject({
      disposition: 'accepted',
      turnId: f.turn.id,
      inputItemId: result.inputItemId,
    });
    expect(readTaskSteerState(f.store, f.input.workspaceId, f.thread.id, instructions[0]!)).toEqual(
      { requestId: f.input.requestId, state: 'accepted', reason: null }
    );
    expect(
      f.store.listThreadTurns(f.input.workspaceId, f.thread.id).map((turn) => turn.id)
    ).toEqual([f.turn.id]);
    await f.finish();
    const completed = f.store.getTurnById(f.turn.id);
    const replay = await f.steer();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(f.store.getTurnById(f.turn.id)).toEqual(completed);
    const changed = await f.steer({ ...f.input, input: 'A different instruction' });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(f.store.getTurnById(f.turn.id)).toEqual(completed);
  }, 30_000);

  it('refuses a fresh request after the real execution ends without an Item, receipt or successor Turn', async () => {
    const f = await fixture();
    await f.finish();
    const before = f.store.getTurnById(f.turn.id);
    const response = await f.steer();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'steer_target_stale' });
    expect(f.store.getTurnById(f.turn.id)).toEqual(before);
    expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
    expect(
      f.store.listThreadTurns(f.input.workspaceId, f.thread.id).map((turn) => turn.id)
    ).toEqual([f.turn.id]);
  }, 30_000);

  it('does not borrow another simulator instance live ownership from stored running metadata', async () => {
    const f = await fixture();
    const cold = createAppWithWorkspaceAuthority({
      store: f.store,
      agentManifests: [f.setup.manifest],
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const before = f.store.getTurnById(f.turn.id);
    const response = await f.steer(f.input, cold);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'steer_target_stale' });
    expect(f.store.getTurnById(f.turn.id)).toEqual(before);
    expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
    await f.finish();
  }, 30_000);

  it('rechecks a stale current AgentSession before admitting any in-run Item', async () => {
    const f = await fixture();
    const sessionId = f.store.getTurnById(f.turn.id).agentSessionId!;
    await f.store.updateAgentSession(sessionId, { stale: true });
    const before = f.store.getTurnById(f.turn.id);
    const response = await f.steer();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'steer_target_stale' });
    expect(f.store.getTurnById(f.turn.id)).toEqual(before);
    expect(f.store.getCommandRequest('task.steer', f.input.requestId, f.scope)).toBeNull();
    await f.finish();
  }, 30_000);
});
