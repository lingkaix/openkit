import {
  type GitFailureExplanation,
  GitFailureExplanationSchema,
  isSealedTurnTerminal,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';

import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  type FsStore,
  type TerminalTurnPublication,
} from '../lib/store.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import {
  createExecutionStepJournalReader,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
} from './execution-journal.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';

/** Input for idempotently projecting one governed-worker terminal outcome. */
export interface TerminalizeGovernedWorkerTurnInput {
  /** AgentSession created for the worker, when its write completed. */
  readonly agentSessionId: string | null;
  /**
   * Whether the backend still holds this AgentSession's reusable runtime binding after closeout.
   * A retained AgentSession returns to `idle` for its next Turn instead of becoming terminal.
   */
  readonly agentSessionRetained?: boolean;
  /** Canonical terminal completion timestamp. */
  readonly completedAt: string;
  /** Stable product diagnostic code. */
  readonly errorCode: string;
  /** Closed primary observation, separate from cleanup disposition. */
  readonly explanation?: GitFailureExplanation;
  /** Product-safe terminal message. */
  readonly message: string;
  /** Product outcome established by governed-worker terminalization. */
  readonly outcome: 'cancelled' | 'failed' | 'interrupted';
  /** Request id correlated with emitted events. */
  readonly requestId: string | null;
  /** Product store that owns the turn. */
  readonly store: FsStore;
  /** Existing native terminal facts supplied by the execution owner; omission creates no proof. */
  readonly publication?: TerminalTurnPublication;
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
 * @returns The authoritative Turn after publication acknowledgement, or `missing` when no product Turn exists.
 * @throws AggregateError when a durable write reports failure; a later retry can repair it.
 */
export async function terminalizeGovernedWorkerTurn(
  input: TerminalizeGovernedWorkerTurnInput
): Promise<ReturnType<FsStore['getTurnById']> | MissingGovernedWorkerTurnResult> {
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
    return await reconcileCompletedTurn(input, initialTurn, successfulTerminalEvent.data.turn);
  }
  if (initialTurn.status === 'completed') {
    return await reconcileCompletedTurn(input, initialTurn, initialTurn);
  }

  // Exact callers may finish an already decided typed failure; they never replace its diagnostic.
  const recoveryOwnsOutcome = Boolean(
    initialTurn.status === input.outcome &&
      initialTurn.error &&
      typeof initialTurn.error.code === 'string' &&
      (isGovernedWorkerTerminalCode(initialTurn.error.code) ||
        initialTurn.error.code === input.errorCode)
  );
  if (isSealedTurnTerminal(initialTurn.status) && !recoveryOwnsOutcome) {
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
  const explanation = recoveryOwnsOutcome ? initialTurn.error?.explanation : input.explanation;
  const safeExplanation = explanation ? GitFailureExplanationSchema.parse(explanation) : undefined;
  const errors: unknown[] = [];
  const notifications: Array<Awaited<ReturnType<FsStore['persistTurnEvent']>>> = [];
  const turnPatch = {
    completedAt,
    error: {
      code: errorCode,
      message,
      ...(safeExplanation ? { explanation: safeExplanation } : {}),
    },
    status: input.outcome,
  } as const;
  let terminalTurn = initialTurn;

  const terminalSessionStatus = input.agentSessionRetained
    ? 'idle'
    : input.outcome === 'cancelled'
      ? 'interrupted'
      : input.outcome;
  const terminalSessionMessage = input.agentSessionRetained ? null : message;
  let terminalSession = input.agentSessionId
    ? readAgentSession(input.store, input.agentSessionId)
    : null;
  const composeSession = Boolean(
    input.store.getDataRoot() &&
      input.agentSessionId &&
      initialTurn.agentSessionId === input.agentSessionId &&
      !isSealedTurnTerminal(initialTurn.status)
  );
  let terminalSessionPublication: TerminalTurnPublication['agentSession'];
  if (
    input.agentSessionId &&
    terminalSession &&
    (terminalSession.status !== terminalSessionStatus ||
      terminalSession.message !== terminalSessionMessage)
  ) {
    try {
      const projection: NonNullable<TerminalTurnPublication['agentSession']> = {
        id: input.agentSessionId,
        message: terminalSessionMessage,
        status: terminalSessionStatus,
        updatedAt: completedAt,
      };
      if (composeSession) {
        terminalSessionPublication = projection;
        terminalSession = { ...terminalSession, ...projection };
      } else {
        const { id: _id, ...patch } = projection;
        terminalSession = await input.store.updateAgentSession(input.agentSessionId, patch);
      }
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
  if (terminalSession?.status === terminalSessionStatus && !sessionEventExists && !composeSession) {
    try {
      notifications.push(
        await input.store.persistTurnEvent(
          input.turnId,
          {
            data: { agentSession: terminalSession, type: 'agent-session-updated' },
            event: 'agent.session.updated',
            requestId: input.requestId,
            threadId: terminalTurn.threadId,
            turnId: terminalTurn.id,
            workspaceId: workspaceIdForOwner(terminalTurn.owner),
          },
          ALREADY_DECIDED_PUBLICATION_ADMISSION
        )
      );
    } catch (error) {
      errors.push(error);
    }
  }

  const terminalEventExists = input.store
    .getTurnEvents(input.turnId)
    .some((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');
  if (
    !turnMatchesOutcome(terminalTurn, input.outcome, errorCode, message) ||
    !terminalEventExists ||
    input.publication !== undefined
  ) {
    try {
      terminalTurn = await input.store.completeTurn(input.turnId, turnPatch, {
        ...(await readTerminalPublication(input, terminalTurn)),
        ...(terminalSessionPublication && terminalSession
          ? {
              agentSession: terminalSessionPublication,
              precedingEvents: [
                ...(input.publication?.precedingEvents ?? []),
                {
                  data: { agentSession: terminalSession, type: 'agent-session-updated' as const },
                  event: 'agent.session.updated' as const,
                  requestId: input.requestId,
                  threadId: terminalTurn.threadId,
                  turnId: terminalTurn.id,
                  workspaceId: workspaceIdForOwner(terminalTurn.owner),
                },
              ],
            }
          : {}),
        requestId: input.requestId,
        stopReason: input.outcome === 'failed' ? 'error' : 'aborted',
      });
      if (terminalSessionPublication) {
        const event = input.store
          .getTurnEvents(input.turnId)
          .findLast(
            (entry) =>
              entry.data.type === 'agent-session-updated' &&
              entry.data.agentSession.id === terminalSessionPublication.id &&
              entry.data.agentSession.status === terminalSessionPublication.status
          );
        if (event)
          notifications.push(
            await input.store.persistTurnEvent(
              input.turnId,
              event,
              ALREADY_DECIDED_PUBLICATION_ADMISSION
            )
          );
      }
      if (!terminalEventExists) {
        const event = input.store
          .getTurnEvents(input.turnId)
          .find(
            (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
          );
        if (event)
          notifications.push(
            await input.store.persistTurnEvent(
              input.turnId,
              event,
              ALREADY_DECIDED_PUBLICATION_ADMISSION
            )
          );
      }
    } catch (error) {
      errors.push(error);
      terminalTurn = input.store.getTurnById(input.turnId);
    }
  }

  // All durable writes finish before this synchronous observer tail.
  for (const event of notifications) {
    try {
      input.store.emitTurnEvent(input.turnId, event);
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
 * @returns The reconciled completed Turn after publication acknowledgement.
 * @throws AggregateError when a durable write reports failure.
 */
async function reconcileCompletedTurn(
  input: TerminalizeGovernedWorkerTurnInput,
  currentTurn: ReturnType<FsStore['getTurnById']>,
  authoritativeTurn: ReturnType<FsStore['getTurnById']>
): Promise<ReturnType<FsStore['getTurnById']>> {
  const errors: unknown[] = [];
  const notifications: Array<Awaited<ReturnType<FsStore['persistTurnEvent']>>> = [];
  let completedTurn = currentTurn;
  let idleSession = input.agentSessionId
    ? readAgentSession(input.store, input.agentSessionId)
    : null;
  if (input.agentSessionId && idleSession && idleSession.status !== 'idle') {
    try {
      idleSession = await input.store.updateAgentSession(input.agentSessionId, {
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
      notifications.push(
        await input.store.persistTurnEvent(
          input.turnId,
          {
            data: { agentSession: idleSession, type: 'agent-session-updated' },
            event: 'agent.session.updated',
            requestId: input.requestId,
            threadId: completedTurn.threadId,
            turnId: completedTurn.id,
            workspaceId: workspaceIdForOwner(completedTurn.owner),
          },
          ALREADY_DECIDED_PUBLICATION_ADMISSION
        )
      );
    } catch (error) {
      errors.push(error);
    }
  }
  const terminalEventExists = input.store
    .getTurnEvents(input.turnId)
    .some(
      (event) =>
        event.event === 'turn.completed' &&
        event.data.type === 'turn-completed' &&
        event.data.stopReason === 'completed'
    );
  if (
    currentTurn.status !== 'completed' ||
    currentTurn.completedAt !== authoritativeTurn.completedAt ||
    currentTurn.error !== null ||
    !terminalEventExists ||
    input.publication !== undefined
  ) {
    try {
      completedTurn = await input.store.completeTurn(
        input.turnId,
        {
          completedAt: authoritativeTurn.completedAt,
          durationMs: authoritativeTurn.durationMs,
          error: null,
          status: 'completed',
        },
        {
          ...(await readTerminalPublication(input, completedTurn)),
          requestId: input.requestId,
          stopReason: 'completed',
        }
      );
      if (!terminalEventExists) {
        const event = input.store
          .getTurnEvents(input.turnId)
          .find(
            (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
          );
        if (event)
          notifications.push(
            await input.store.persistTurnEvent(
              input.turnId,
              event,
              ALREADY_DECIDED_PUBLICATION_ADMISSION
            )
          );
      }
    } catch (error) {
      errors.push(error);
      completedTurn = input.store.getTurnById(input.turnId);
    }
  }

  // All durable writes finish before this synchronous observer tail.
  for (const event of notifications) {
    try {
      input.store.emitTurnEvent(input.turnId, event);
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

/** Returns whether an existing terminal outcome belongs to governed-worker lifecycle projection. */
function isGovernedWorkerTerminalCode(errorCode: string): boolean {
  return (
    errorCode === 'worker_governance_turn_failed' ||
    errorCode === 'delivery_unknown' ||
    errorCode === 'worker_governance_restart_recovery' ||
    errorCode === 'worker_governance_turn_cancelled' ||
    errorCode === 'unsupported_gateway_feature' ||
    errorCode === 'worker_human_gate_unavailable'
  );
}

/** Supplies only original journal descriptors and actual runtime evidence to native terminal publication. */
export async function workerTurnTerminalPublication(
  workspaceDb: WorkspaceDb,
  turnId: string,
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed'
): Promise<TerminalTurnPublication> {
  const roots = workspaceDb.sqlite
    .prepare('SELECT id FROM control_executions WHERE work_id=?')
    .all(turnId) as { id: string }[];
  if (roots.length !== 1)
    throw new Error('Worker terminal publication requires its original unique execution.');
  const ref = {
    owner: { kind: 'workspace' as const, workspaceId: workspaceDb.workspaceId },
    executionId: roots[0]!.id,
  };
  const reader = createExecutionStepJournalReader(workspaceDb, ref.owner);
  const root = await reader.readExecution(ref);
  if (
    root.definitionVersion !== WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION ||
    root.workId !== turnId
  )
    throw new Error('Worker terminal journal definition or lineage conflicts.');
  const obligations = workspaceDb.sqlite
    .prepare(
      "SELECT step_id,json_extract(control_json,'$.kind') AS kind FROM control_execution_steps WHERE execution_id=? AND json_extract(control_json,'$.kind') IN ('terminal-publication','release')"
    )
    .all(ref.executionId) as { step_id: string; kind: string }[];
  const terminal = obligations.filter((step) => step.kind === 'terminal-publication');
  const release = obligations.filter((step) => step.kind === 'release');
  if (terminal.length !== 1 || release.length !== 1)
    throw new Error('Worker terminal journal requires original terminal and release obligations.');
  await reader.readInvocation({ execution: ref, stepId: terminal[0]!.step_id });
  await reader.readInvocation({ execution: ref, stepId: release[0]!.step_id });
  const evidence = listWorkspaceRuntimeEvidence(workspaceDb, workspaceDb.workspaceId).filter(
    (record) => record.turnId === turnId
  );
  if (!['failed', 'cancelled', 'interrupted'].includes(outcome) && !evidence.length)
    throw new Error('Worker terminal publication requires actual runtime evidence.');
  return {
    execution: {
      executionId: ref.executionId,
      terminalStepId: terminal[0]!.step_id,
      cleanupStepId: release[0]!.step_id,
      expectedRevision: root.revision,
    },
    evidence: evidence.map((record) => writeRetainedV1(record)),
  };
}

/** Resolves native facts only when the existing terminal owner must write; no-op reads stay no-ops. */
async function readTerminalPublication(
  input: TerminalizeGovernedWorkerTurnInput,
  turn: ReturnType<FsStore['getTurnById']>
): Promise<TerminalTurnPublication | undefined> {
  if (input.publication) return input.publication;
  const dataRoot = input.store.getDataRoot();
  if (!turn.agentSessionId || !dataRoot) return undefined;
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceIdForOwner(turn.owner));
  try {
    return await workerTurnTerminalPublication(
      workspaceDb,
      input.turnId,
      turn.status === 'completed' ? 'completed' : input.outcome
    );
  } finally {
    workspaceDb.sqlite.close();
  }
}
