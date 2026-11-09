import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { steerTask, taskSteerInputItemId } from '../runtime/task-steer.js';
import { readTaskSteerState } from '../runtime/task-steer-receipt.js';
import type { TaskSteerControl, TaskSteerTarget } from '../runtime/types.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

async function fixture(terminal = false) {
  const root = mkdtempSync(join(tmpdir(), 'task-steer-operation-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Task live input');
  const thread = await store.createThread(workspace.id, 'Exact worker work');
  const turn = await store.createTurn(workspace.id, thread.id, 'Immutable original request', actor);
  const agentSessionId = allocateEntityId('as');
  const timestamp = new Date().toISOString();
  if (terminal) await store.updateTurn(turn.id, { status: 'completed', completedAt: timestamp });
  else {
    await store.createAgentSession({
      id: agentSessionId,
      workspaceId: workspace.id,
      threadId: thread.id,
      agentId: 'codex-worker',
      environmentPackageSnapshotId: 'original-package',
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'busy',
      message: null,
    });
    await store.updateTurn(turn.id, { status: 'running', agentSessionId, agentId: 'codex-worker' });
  }
  const input = {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    requestId: randomUUID(),
    input: '  Exact instruction\n',
  };
  const recheck = vi.fn(async () => undefined);
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'token', userId: actor.id, tokenId: allocateEntityId('tok') },
    actorRef: actor,
    scope: { kind: 'workspace', workspaceId: workspace.id },
    recheckAdmission: recheck,
  };
  const turnExecutor = Object.assign(new SimulatedTurnExecutor(), {
    steerTurn: vi.fn(async (_store, _target: TaskSteerTarget, control: TaskSteerControl) => {
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      await control.complete({ disposition: 'accepted', reason: null });
    }),
  });
  const dependencies = { store, turnExecutor, inflightCommands: new WeakMap() };
  return {
    root,
    store,
    turn,
    thread,
    workspace,
    input,
    context,
    recheck,
    dependencies,
    turnExecutor,
  };
}

describe('Task steer command receipt and Item boundaries', () => {
  it('commits one exact user Item before native contact, preserves admission, and replays after restart without current execution lookup', async () => {
    const f = await fixture();
    const before = f.store.getTurnById(f.turn.id);
    f.turnExecutor.steerTurn.mockImplementation(async (_store, target, control) => {
      expect(f.store.getTurnById(f.turn.id).items).toEqual(before.items);
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      expect(
        f.store.readThreadTimelineSnapshot(f.workspace.id, f.thread.id, (snapshot) =>
          snapshot.item(target.inputItemId)
        )
      ).toMatchObject({
        text: f.input.input,
        actor,
        turnId: f.turn.id,
        causationId: `task.steer:${f.input.requestId}`,
      });
      await control.complete({ disposition: 'accepted', reason: null });
      expect(
        f.store.getCommandRequest('task.steer', f.input.requestId, {
          actorId: actor.id,
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
        })?.response.steerMetadata?.disposition
      ).toBe('accepted');
    });
    const result = await steerTask(f.dependencies, f.input, f.context);
    expect(result).toEqual({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      inputItemId: taskSteerInputItemId(f.input, actor.id),
      delivery: 'accepted',
    });
    const after = f.store.getTurnById(f.turn.id);
    expect({ ...after, items: before.items }).toEqual(before);
    expect(after.items).toHaveLength(before.items.length + 1);
    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    vi.spyOn(cold, 'getTurnMetadata').mockImplementation(() => {
      throw new Error('Replay must not resolve current execution.');
    });
    expect(await steerTask({ ...f.dependencies, store: cold }, f.input, f.context)).toEqual(result);
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);
    expect(f.recheck).toHaveBeenCalledTimes(1);
  });

  it('shares identical in-flight work, conflicts changed target/text, and refuses a different busy request before Item admission', async () => {
    const f = await fixture();
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let occupied = false;
    f.turnExecutor.steerTurn.mockImplementation(async (_store, _target, control) => {
      if (occupied) throw new OperationError('steer_busy', 'The private slot is occupied.', 409);
      occupied = true;
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      admitted.resolve();
      await release.promise;
      await control.complete({ disposition: 'accepted', reason: null });
      occupied = false;
    });
    const first = steerTask(f.dependencies, f.input, f.context);
    let duplicate: typeof first | undefined;
    try {
      await admitted.promise;
      const liveItem = f.store.getTurnById(f.turn.id).items.at(-1)!;
      expect(readTaskSteerState(f.store, f.workspace.id, f.thread.id, liveItem)).toMatchObject({
        state: 'unknown',
      });
      duplicate = steerTask(f.dependencies, f.input, f.context);
      await expect(
        steerTask(f.dependencies, { ...f.input, input: 'changed' }, f.context)
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
      await expect(
        steerTask(f.dependencies, { ...f.input, turnId: allocateEntityId('tu') }, f.context)
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
      await expect(
        steerTask(f.dependencies, { ...f.input, requestId: randomUUID() }, f.context)
      ).rejects.toMatchObject({ code: 'steer_busy' });
      expect(
        f.store
          .getTurnById(f.turn.id)
          .items.filter((item) => item.causationId?.startsWith('task.steer:'))
      ).toHaveLength(1);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
    }
    expect(await duplicate!).toEqual(await first);
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(2); // One actual attempt and one pre-admission busy check.
  });

  it.each(['unsupported', 'pending', 'terminal', 'coordinator', 'mis-scoped'] as const)(
    'refuses %s before Item or native admission',
    async (state) => {
      const f = await fixture(state === 'terminal');
      if (state === 'unsupported')
        f.dependencies.turnExecutor = new SimulatedTurnExecutor() as typeof f.turnExecutor;
      if (state === 'pending') await f.store.updateTurn(f.turn.id, { status: 'pending' });
      if (state === 'coordinator')
        await f.store.updateTurn(f.turn.id, { agentId: 'goal-coordinator' });
      const before = f.store.getTurnById(f.turn.id);
      const input =
        state === 'mis-scoped'
          ? { ...f.input, threadId: (await f.store.createThread(f.workspace.id, 'Other')).id }
          : f.input;
      await expect(steerTask(f.dependencies, input, f.context)).rejects.toMatchObject({
        code:
          state === 'unsupported'
            ? 'steer_unsupported'
            : state === 'mis-scoped'
              ? 'turn_not_found'
              : 'steer_target_stale',
      });
      expect(f.store.getTurnById(f.turn.id)).toEqual(before);
      expect(f.turnExecutor.steerTurn).not.toHaveBeenCalled();
    }
  );

  it('retains unknown input after a possible native effect and never resends after response loss or receipt expiry', async () => {
    const f = await fixture();
    let nativeCalls = 0;
    f.turnExecutor.steerTurn.mockImplementation(async (_store, _target, control) => {
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      nativeCalls++;
      throw new Error('Lost exact native response.');
    });
    await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toMatchObject({
      code: 'steer_outcome_unknown',
    });
    await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toMatchObject({
      code: 'steer_outcome_unknown',
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toMatchObject({
      code: 'steer_outcome_unknown',
    });
    await expect(
      steerTask(f.dependencies, { ...f.input, input: 'changed' }, f.context)
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(nativeCalls).toBe(1);
  });

  it('retains a definite pre-dispatch event-publication refusal with its original dependency semantics', async () => {
    const f = await fixture();
    let nativeCalls = 0;
    f.turnExecutor.steerTurn.mockImplementation(async (_store, _target, control) => {
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      nativeCalls++;
      await control.complete({ disposition: 'accepted', reason: null });
    });
    vi.spyOn(f.store, 'persistTurnEvent').mockRejectedValueOnce(
      new OperationError(
        'operation_storage_unavailable',
        'Storage is busy. Inspect the original request outcome before retrying.',
        503
      )
    );
    for (let call = 0; call < 2; call++) {
      await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toMatchObject({
        code: 'operation_storage_unavailable',
        status: 503,
      });
    }
    expect(nativeCalls).toBe(0);
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);
    expect(f.store.getTurnById(f.turn.id).items.at(-1)).toMatchObject({
      text: f.input.input,
      actor,
    });
    expect(
      f.store.getCommandRequest('task.steer', f.input.requestId, {
        actorId: actor.id,
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
      })?.response.steerMetadata?.disposition
    ).toBe('refused');
  });

  it('retains exact input after lost Item append acknowledgement and fences recreated-owner retries', async () => {
    const f = await fixture();
    f.input.input = '  Keep café and 雪 exactly.\r\n\t';
    const before = f.store.getTurnById(f.turn.id);
    let nativeCalls = 0;
    f.turnExecutor.steerTurn.mockImplementation(async (_store, _target, control) => {
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      nativeCalls++;
      await control.complete({ disposition: 'accepted', reason: null });
    });
    const append = f.store.createItem.bind(f.store);
    const appendAck = vi.spyOn(f.store, 'createItem').mockImplementationOnce(async (...args) => {
      await append(...args);
      throw new Error('Lost acknowledgement after durable input Item append.');
    });
    // Task live steer, Lifecycle step 2: the real durable Item precedes every possible enqueue.
    // The storage failure owns its initial error; this boundary must not invent a steer code.
    await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toBeInstanceOf(Error);
    expect(appendAck).toHaveBeenCalledTimes(1);
    appendAck.mockRestore();
    expect(nativeCalls).toBe(0);
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);

    await shutdownControlStoreWorkerClient();
    const cold = createTestStore({ dataRoot: f.root });
    const retained = cold
      .getTurnById(f.turn.id)
      .items.filter((item) => item.causationId === `task.steer:${f.input.requestId}`);
    expect(retained).toHaveLength(1);
    const original = retained[0]!;
    // Definition and exclusions: retain submitted bytes without whitespace or Unicode normalization.
    expect(original).toMatchObject({ text: f.input.input, actor, turnId: f.turn.id });
    expect(cold.getTurnById(f.turn.id).items).toEqual([...before.items, original]);
    const recreated = { ...f.dependencies, store: cold, inflightCommands: new WeakMap() };
    await expect(steerTask(recreated, f.input, f.context)).rejects.toMatchObject({
      code: 'steer_outcome_unknown',
    });
    expect(readTaskSteerState(cold, f.workspace.id, f.thread.id, original)).toMatchObject({
      state: 'unknown',
    });
    // Lifecycle step 5: exact text and Turn enter the hash, but neither changes command scope.
    for (const changed of [
      { ...f.input, input: f.input.input.trim() },
      { ...f.input, turnId: allocateEntityId('tu') },
    ]) {
      await expect(steerTask(recreated, changed, f.context)).rejects.toMatchObject({
        code: 'idempotency_key_conflict',
      });
    }
    await expect(steerTask(recreated, f.input, f.context)).rejects.toMatchObject({
      code: 'steer_outcome_unknown',
    });
    expect(cold.getTurnById(f.turn.id)).toEqual({ ...before, items: [...before.items, original] });
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);
    expect(nativeCalls).toBe(0);
  });

  it.each(['before-commit', 'lost-ack'] as const)(
    'does not re-invoke native acceptance after public receipt failure: %s',
    async (fault) => {
      const f = await fixture();
      const publish = f.store.publishTaskSteerReceipt.bind(f.store);
      vi.spyOn(f.store, 'publishTaskSteerReceipt').mockImplementationOnce(async (admission) => {
        if (fault === 'lost-ack') await publish(admission);
        throw new Error('Injected original receipt publication failure.');
      });
      const accepted = await steerTask(f.dependencies, f.input, f.context);
      expect(accepted.delivery).toBe('accepted');
      expect(await steerTask(f.dependencies, f.input, f.context)).toEqual(accepted);
      expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);
      expect(
        f.store
          .getTurnById(f.turn.id)
          .items.filter((item) => item.causationId === `task.steer:${f.input.requestId}`)
      ).toHaveLength(1);
    }
  );

  it('records definite post-admission refusal, retains the exact draft Item, and replays the refusal', async () => {
    const f = await fixture();
    f.turnExecutor.steerTurn.mockImplementation(async (_store, _target, control) => {
      await control.admit({ operationId: 'a'.repeat(64), executionId: 'original-execution' });
      await control.complete({ disposition: 'refused', reason: 'stale' });
    });
    for (let call = 0; call < 2; call++)
      await expect(steerTask(f.dependencies, f.input, f.context)).rejects.toMatchObject({
        code: 'steer_target_stale',
      });
    expect(f.turnExecutor.steerTurn).toHaveBeenCalledTimes(1);
    expect(f.store.getTurnById(f.turn.id).items.at(-1)).toMatchObject({
      text: f.input.input,
      actor,
    });
  });
});
