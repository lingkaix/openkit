import { isSettledForWaitersTurnStatus } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';

type TurnReadModel = ReturnType<FsStore['getTurnById']>;

const WORKER_TURN_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Waits until a worker turn reaches a settled-for-waiters stored state.
 *
 * @param store Durable turn store.
 * @param turnId Worker turn id to observe.
 * @returns Turn read model in a settled-for-waiters status.
 * @throws Error when the worker turn does not finish within the bounded wait window.
 */
export async function waitForWorkerTurnTerminalState(
  store: FsStore,
  turnId: string
): Promise<TurnReadModel> {
  const initialTurn = store.getTurnById(turnId);

  if (isSettledForWaitersTurnStatus(initialTurn.status)) {
    return initialTurn;
  }

  return new Promise<TurnReadModel>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe?.();
      reject(new Error(`Worker turn did not finish within ${WORKER_TURN_AWAIT_TIMEOUT_MS}ms.`));
    }, WORKER_TURN_AWAIT_TIMEOUT_MS);

    unsubscribe = store.addTurnListener(turnId, (event) => {
      if (event.event !== 'turn.completed' && event.event !== 'turn.updated') {
        return;
      }

      const turn = store.getTurnById(turnId);

      if (!isSettledForWaitersTurnStatus(turn.status) || settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(turn);
    });

    const currentTurn = store.getTurnById(turnId);

    if (isSettledForWaitersTurnStatus(currentTurn.status) && !settled) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(currentTurn);
    }
  });
}
