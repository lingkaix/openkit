import type { FsStore } from '../lib/store.js';

/** Input for idempotently projecting one governed-worker terminal outcome. */
export interface TerminalizeGovernedWorkerTurnInput {
  /** AgentSession created for the worker, when its write completed. */
  readonly agentSessionId: string | null;
  /** Canonical terminal completion timestamp. */
  readonly completedAt: string;
  /** Stable product diagnostic code. */
  readonly errorCode: string;
  /** Product-safe terminal message. */
  readonly message: string;
  /** Product outcome established by governed-worker terminalization. */
  readonly outcome: 'cancelled' | 'failed' | 'interrupted';
  /** Request id correlated with emitted events. */
  readonly requestId: string | null;
  /** Product store that owns the turn. */
  readonly store: FsStore;
  /** Governed worker turn id. */
  readonly turnId: string;
}

/** Missing-turn projection result. */
export interface MissingGovernedWorkerTurnResult {
  /** Signals that no product turn was durably created. */
  readonly status: 'missing';
}

/**
 * Idempotently terminalizes a governed-worker turn and repairs partial product-store writes.
 *
 * @param input Store, lineage, outcome, diagnostic, request, and timestamp.
 * @returns The authoritative turn, or `missing` when no product turn exists.
 * @throws AggregateError when a durable write reports failure; a later retry can repair it.
 */
export function terminalizeGovernedWorkerTurn(
  input: TerminalizeGovernedWorkerTurnInput
): ReturnType<FsStore['getTurnById']> | MissingGovernedWorkerTurnResult {
  const initialTurn = readTurn(input.store, input.turnId);
  if (!initialTurn) {
    return { status: 'missing' };
  }

  const successfulTerminalEvent = input.store
    .getTurnEvents(input.turnId)
    .find(
      (event) =>
        event.event === 'turn.completed' &&
        event.data.type === 'turn-completed' &&
        event.data.stopReason === 'completed'
    );
  if (successfulTerminalEvent?.data.type === 'turn-completed') {
    return reconcileCompletedTurn(input, initialTurn, successfulTerminalEvent.data.turn);
  }
  if (initialTurn.status === 'completed') {
    return reconcileCompletedTurn(input, initialTurn, initialTurn);
  }

  const recoveryOwnsOutcome = Boolean(
    initialTurn.status === input.outcome &&
      initialTurn.error &&
      typeof initialTurn.error.code === 'string' &&
      isGovernedWorkerTerminalCode(initialTurn.error.code)
  );
  if (isTerminalTurnStatus(initialTurn.status) && !recoveryOwnsOutcome) {
    return initialTurn;
  }

  const errorCode = recoveryOwnsOutcome ? initialTurn.error?.code : input.errorCode;
  const message = recoveryOwnsOutcome ? initialTurn.error?.message : input.message;
  const completedAt = recoveryOwnsOutcome
    ? (initialTurn.completedAt ?? input.completedAt)
    : input.completedAt;
  if (!errorCode || !message) {
    throw new Error('Governed worker terminalization is missing its durable error projection.');
  }
  const errors: unknown[] = [];
  const turnPatch = {
    completedAt,
    error: { code: errorCode, message },
    status: input.outcome,
  } as const;
  let terminalTurn = initialTurn;

  if (!turnMatchesOutcome(terminalTurn, input.outcome, errorCode, message)) {
    try {
      terminalTurn = input.store.updateTurn(input.turnId, turnPatch);
    } catch (error) {
      errors.push(error);
      terminalTurn = input.store.getTurnById(input.turnId);
    }
  }

  const terminalSessionStatus = input.outcome === 'cancelled' ? 'interrupted' : input.outcome;
  let terminalSession = input.agentSessionId
    ? readAgentSession(input.store, input.agentSessionId)
    : null;
  if (
    input.agentSessionId &&
    terminalSession &&
    (terminalSession.status !== terminalSessionStatus || terminalSession.message !== message)
  ) {
    try {
      terminalSession = input.store.updateAgentSession(input.agentSessionId, {
        message,
        status: terminalSessionStatus,
        updatedAt: completedAt,
      });
    } catch (error) {
      errors.push(error);
      terminalSession = readAgentSession(input.store, input.agentSessionId);
    }
  }

  const events = input.store.getTurnEvents(input.turnId);
  const sessionEventExists = Boolean(
    input.agentSessionId &&
      terminalSession?.status === terminalSessionStatus &&
      events.some(
        (event) =>
          event.event === 'agent.session.updated' &&
          event.data.type === 'agent-session-updated' &&
          event.data.agentSession.id === input.agentSessionId &&
          event.data.agentSession.status === terminalSessionStatus
      )
  );
  if (terminalSession?.status === terminalSessionStatus && !sessionEventExists) {
    try {
      input.store.emitTurnEvent(input.turnId, {
        data: { agentSession: terminalSession, type: 'agent-session-updated' },
        event: 'agent.session.updated',
        requestId: input.requestId,
        threadId: terminalTurn.threadId,
        turnId: terminalTurn.id,
        workspaceId: terminalTurn.workspaceId,
      });
    } catch (error) {
      errors.push(error);
    }
  }

  const terminalEventExists = input.store
    .getTurnEvents(input.turnId)
    .some((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');
  if (turnMatchesOutcome(terminalTurn, input.outcome, errorCode, message) && !terminalEventExists) {
    try {
      input.store.emitTurnEvent(input.turnId, {
        data: {
          stopReason: input.outcome === 'failed' ? 'error' : 'aborted',
          turn: terminalTurn,
          type: 'turn-completed',
        },
        event: 'turn.completed',
        requestId: input.requestId,
        threadId: terminalTurn.threadId,
        turnId: terminalTurn.id,
        workspaceId: terminalTurn.workspaceId,
      });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Governed worker turn terminalization encountered partial persistence errors.'
    );
  }
  return input.store.getTurnById(input.turnId);
}

/**
 * Repairs missing durable success projections without converting them into a restart failure.
 *
 * @param input Recovery input with store and lineage.
 * @param currentTurn Current durable turn row.
 * @param authoritativeTurn Completed turn from the row or terminal event.
 * @returns Reconciled completed turn.
 * @throws AggregateError when a durable write reports failure.
 */
function reconcileCompletedTurn(
  input: TerminalizeGovernedWorkerTurnInput,
  currentTurn: ReturnType<FsStore['getTurnById']>,
  authoritativeTurn: ReturnType<FsStore['getTurnById']>
): ReturnType<FsStore['getTurnById']> {
  const errors: unknown[] = [];
  let completedTurn = currentTurn;
  if (
    currentTurn.status !== 'completed' ||
    currentTurn.completedAt !== authoritativeTurn.completedAt ||
    currentTurn.error !== null
  ) {
    try {
      completedTurn = input.store.updateTurn(input.turnId, {
        completedAt: authoritativeTurn.completedAt,
        error: null,
        status: 'completed',
      });
    } catch (error) {
      errors.push(error);
      completedTurn = input.store.getTurnById(input.turnId);
    }
  }

  let idleSession = input.agentSessionId
    ? readAgentSession(input.store, input.agentSessionId)
    : null;
  if (input.agentSessionId && idleSession && idleSession.status !== 'idle') {
    try {
      idleSession = input.store.updateAgentSession(input.agentSessionId, {
        message: null,
        status: 'idle',
        updatedAt: authoritativeTurn.completedAt ?? input.completedAt,
      });
    } catch (error) {
      errors.push(error);
      idleSession = readAgentSession(input.store, input.agentSessionId);
    }
  }

  const events = input.store.getTurnEvents(input.turnId);
  if (
    idleSession?.status === 'idle' &&
    !events.some(
      (event) =>
        event.event === 'agent.session.updated' &&
        event.data.type === 'agent-session-updated' &&
        event.data.agentSession.id === input.agentSessionId &&
        event.data.agentSession.status === 'idle'
    )
  ) {
    try {
      input.store.emitTurnEvent(input.turnId, {
        data: { agentSession: idleSession, type: 'agent-session-updated' },
        event: 'agent.session.updated',
        requestId: input.requestId,
        threadId: completedTurn.threadId,
        turnId: completedTurn.id,
        workspaceId: completedTurn.workspaceId,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (
    !input.store
      .getTurnEvents(input.turnId)
      .some(
        (event) =>
          event.event === 'turn.completed' &&
          event.data.type === 'turn-completed' &&
          event.data.stopReason === 'completed'
      )
  ) {
    try {
      input.store.emitTurnEvent(input.turnId, {
        data: { stopReason: 'completed', turn: completedTurn, type: 'turn-completed' },
        event: 'turn.completed',
        requestId: input.requestId,
        threadId: completedTurn.threadId,
        turnId: completedTurn.id,
        workspaceId: completedTurn.workspaceId,
      });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Completed turn reconciliation encountered partial persistence errors.'
    );
  }
  return input.store.getTurnById(input.turnId);
}

/** Reads one turn without treating an absent pre-anchor write as corruption. */
function readTurn(store: FsStore, turnId: string): ReturnType<FsStore['getTurnById']> | null {
  try {
    return store.getTurnById(turnId);
  } catch (error) {
    if (error instanceof Error && error.message === `Turn not found: ${turnId}`) {
      return null;
    }
    throw error;
  }
}

/** Reads one optional AgentSession without treating an absent setup write as corruption. */
function readAgentSession(
  store: FsStore,
  agentSessionId: string
): ReturnType<FsStore['getAgentSession']> | null {
  try {
    return store.getAgentSession(agentSessionId);
  } catch (error) {
    if (error instanceof Error && error.message === `AgentSession not found: ${agentSessionId}`) {
      return null;
    }
    throw error;
  }
}

/** Returns whether one turn already carries this helper's exact terminal projection. */
function turnMatchesOutcome(
  turn: ReturnType<FsStore['getTurnById']>,
  outcome: TerminalizeGovernedWorkerTurnInput['outcome'],
  errorCode: string,
  message: string
): boolean {
  return (
    turn.status === outcome && turn.error?.code === errorCode && turn.error.message === message
  );
}

/** Returns whether a product turn outcome is already authoritative and terminal. */
function isTerminalTurnStatus(status: ReturnType<FsStore['getTurnById']>['status']): boolean {
  return ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);
}

/** Returns whether an existing terminal outcome belongs to governed-worker lifecycle projection. */
function isGovernedWorkerTerminalCode(errorCode: string): boolean {
  return (
    errorCode === 'worker_governance_turn_failed' ||
    errorCode === 'worker_governance_restart_recovery' ||
    errorCode === 'worker_governance_turn_cancelled' ||
    errorCode === 'worker_human_gate_unavailable'
  );
}
