import { describe, expect, it } from 'vitest';

import { waitForWorkerTurnTerminalState } from './goal-routes.js';
import type { FsStore } from './lib/store.js';
import { createDemoStore } from './test-support/demo-store.js';

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
  const thread = store.createThread('ws_demo', 'Worker turn wait', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const turn = store.createTurn(
    'ws_demo',
    thread.id,
    'Run delegated work',
    { kind: 'user', id: 'user_local' },
    null,
    { turnId }
  );
  return { store, turnId: turn.id };
}

describe('waitForWorkerTurnTerminalState', () => {
  it('settles on a Turn that is already cancelled', async () => {
    const { store, turnId } = createWorkerTurn('turn_cancelled_before_wait');
    store.updateTurn(turnId, { status: 'cancelled' });

    const settled = await settleOrSentinel(store, turnId);

    expect(settled).not.toBe(SENTINEL);
    expect(settled).toMatchObject({ id: turnId, status: 'cancelled' });
  });

  it('settles when a waited Turn becomes cancelled', async () => {
    const { store, turnId } = createWorkerTurn('turn_cancelled_during_wait');
    const threadId = store.getTurnById(turnId).threadId;
    const settled = settleOrSentinel(store, turnId);
    const cancelled = store.updateTurn(turnId, { status: 'cancelled' });

    store.emitTurnEvent(turnId, {
      data: { type: 'turn-updated', turn: cancelled },
      event: 'turn.updated',
      threadId,
      turnId,
      workspaceId: 'ws_demo',
    });

    const result = await settled;

    expect(result).not.toBe(SENTINEL);
    expect(result).toMatchObject({ id: turnId, status: 'cancelled' });
  });

  it('keeps waiting on a Turn that is still running', async () => {
    const { store, turnId } = createWorkerTurn('turn_running_during_wait');

    await expect(settleOrSentinel(store, turnId)).resolves.toBe(SENTINEL);
  });
});
