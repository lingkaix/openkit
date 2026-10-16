import { describe, expect, it } from 'vitest';
import type { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { waitForWorkerTurnTerminalState } from './task-turn-wait.js';

const SENTINEL = Symbol('still-waiting');

/**
 * Races the bounded waiter against a short timer so a non-resolving wait fails
 * fast instead of consuming the suite timeout.
 *
 * @param store Durable turn store.
 * @param turnId Worker turn id to observe.
 * @returns Terminal turn read model, or the sentinel when the waiter did not settle.
 */
async function settleOrSentinel(
  store: FsStore,
  turnId: string
): Promise<Awaited<ReturnType<typeof waitForWorkerTurnTerminalState>> | typeof SENTINEL> {
  return Promise.race([
    waitForWorkerTurnTerminalState(store, turnId),
    new Promise<typeof SENTINEL>((resolve) => {
      setTimeout(() => resolve(SENTINEL), 50).unref?.();
    }),
  ]);
}

/**
 * Creates a demo-workspace thread plus one worker turn.
 *
 * @param turnId Deterministic turn id.
 * @returns Store and the created turn id.
 */
function createWorkerTurn(turnId: string): { store: FsStore; turnId: string } {
  const store = createDemoStore();
  const thread = store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Worker turn wait',
    undefined,
    'conversation',
    {
      visibility: 'workspace',
    }
  );
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    thread.id,
    'Run delegated work',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    { turnId }
  );
  return { store, turnId: turn.id };
}

describe('waitForWorkerTurnTerminalState', () => {
  it('settles on a Turn that is already cancelled', async () => {
    const { store, turnId } = createWorkerTurn('tu_00000000-0000-7802-96a2-d58cd74af20e');
    store.updateTurn(turnId, { status: 'cancelled' });

    const settled = await settleOrSentinel(store, turnId);

    expect(settled).not.toBe(SENTINEL);
    expect(settled).toMatchObject({ id: turnId, status: 'cancelled' });
  });

  it('settles when a waited Turn becomes cancelled', async () => {
    const { store, turnId } = createWorkerTurn('tu_00000000-0000-7016-930d-e39a543eda32');
    const threadId = store.getTurnById(turnId).threadId;
    const settled = settleOrSentinel(store, turnId);
    const cancelled = store.updateTurn(turnId, { status: 'cancelled' });

    store.emitTurnEvent(turnId, {
      data: { type: 'turn-updated', turn: cancelled },
      event: 'turn.updated',
      threadId,
      turnId,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });

    const result = await settled;

    expect(result).not.toBe(SENTINEL);
    expect(result).toMatchObject({ id: turnId, status: 'cancelled' });
  });

  it('keeps waiting on a Turn that is still running', async () => {
    const { store, turnId } = createWorkerTurn('tu_00000000-0000-7929-a551-13e159ad5fda');

    await expect(settleOrSentinel(store, turnId)).resolves.toBe(SENTINEL);
  });
});
