import {
  InterruptTurnRequestSchema,
  ProductTurnSchema,
  SubmitTurnInputRequestSchema,
  TurnReadProjectionSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import { readStrictWorkerContextPackageDigest } from './context/worker-context-projection.js';
import { StructuredWorkerDelegationRequestSchema } from './internal-agents/delegation.js';
import type { FsStore } from './lib/store.js';
import type { ProviderCredentialResolver } from './providers/registry.js';
import { registerFeedbackRoutes } from './runtime/feedback-routes.js';
import {
  getGoalRecord,
  listGoalTasks,
  updateGoalStatus,
  updateGoalTask,
} from './runtime/goal-store.js';
import {
  chatTaskModeTurnId,
  commandInputHash,
  findExactConversationWorkerOwnerReceipt,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { startProductTurn } from './runtime/product-turn-start.js';
import type { TurnExecutor } from './runtime/types.js';
import {
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  parseWorkerCheckpointEvidence,
  updateWorkerCheckpoint,
} from './runtime/worker-checkpoints.js';
import {
  classifyClosedWorkerUserInputGate,
  clearWorkerCheckpointAfterTerminalState,
  recoverWorkerCheckpointStopReason,
  requireWorkerCheckpointHumanCommandScope,
} from './runtime/worker-recovery.js';
import {
  completeSchedulerLeaseForTerminalTurn,
  listSchedulerSessionLeasesForTurn,
} from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Parsed turn read model shape used by route-level guards. */
type TurnReadModel = z.infer<typeof TurnSchema>;

/**
 * Projects one durable Turn onto the ordinary product-safe response shape.
 *
 * @param turn Durable or protocol Turn that may carry AgentSession identity.
 * @returns Ordinary Turn projection without `agentSessionId`.
 */
function projectOrdinaryTurn(turn: TurnReadModel) {
  return ProductTurnSchema.parse(turn);
}

/**
 * Checks whether a turn can accept a follow-up user-input response through `/api/turns`.
 *
 * @param turn Turn read model to inspect.
 * @returns True when the turn is paused on a user-input human gate.
 */
function isAwaitingUserInputGate(turn: TurnReadModel): boolean {
  return turn.status === 'awaiting_human' && turn.humanGate.kind === 'user-input';
}

/**
 * Rejects ordinary input for an exact Gate that contains a secret question.
 *
 * @param store Product store containing the paused Turn and request Item.
 * @param input Structured response command scoped to that Turn.
 * @throws TurnStartValidationError before any receipt or response Item write.
 */
function rejectSecretUserInput(
  store: FsStore,
  input: Extract<z.infer<typeof SubmitTurnInputRequestSchema>, { turnId: string }>
): void {
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  if (turn.status !== 'awaiting_human' || turn.humanGate.kind !== 'user-input') {
    return;
  }
  const request = turn.items.find((item) => item.id === turn.humanGate.itemId);
  if (
    request?.type === 'user-input-request' &&
    request.status === 'completed' &&
    request.userInputRequestId === turn.humanGate.userInputRequestId &&
    new Set(request.questions.map((question) => question.id)).size === request.questions.length &&
    request.questions.some((question) => question.isSecret)
  ) {
    throw new TurnStartValidationError(
      'secret_input_not_supported',
      'Secret answers require a future Vault-backed input contract.',
      400
    );
  }
}

/**
 * Registers the Core turn start, feedback, read, and interrupt routes.
 *
 * @param dependencies Hono app and concrete turn persistence, scheduler, and runtime dependencies.
 */
export function registerTurnRoutes({
  app,
  coreDb,
  inflightCommands,
  providerCredentialResolver,
  requestStore,
  repositoryWorkspaceDb,
  runtimeConfig,
  schedulerEpoch,
  turnExecutor,
  workerPlacement,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly providerCredentialResolver: ProviderCredentialResolver;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly schedulerEpoch: number;
  readonly turnExecutor: TurnExecutor;
  readonly workerPlacement: 'local' | 'remote';
}): void {
  app.post('/api/turns', async (c) => {
    const parsed = SubmitTurnInputRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const store = requestStore(c);
      if ('turnId' in input) {
        const turnId = input.turnId;
        const responseActor = { kind: 'user', id: c.get('actor').userId } as const;
        rejectSecretUserInput(store, input);
        const activeTurn = store.getTurn(input.workspaceId, input.threadId, turnId);
        if (activeTurn.status === 'awaiting_human' && activeTurn.humanGate.kind === 'user-input') {
          const request = activeTurn.items.find((item) => item.id === activeTurn.humanGate.itemId);
          if (
            request?.type !== 'user-input-request' ||
            request.status !== 'completed' ||
            request.userInputRequestId !== activeTurn.humanGate.userInputRequestId
          ) {
            throw workerGateRecoveryError(
              'The user-input Gate has no exact responsible-user owner.'
            );
          }
          if (request.responsibleUserId !== responseActor.id) {
            throw new TurnStartValidationError(
              'workspace_access_denied',
              'Workspace access denied.',
              403
            );
          }
        }
        const commandScope = {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId,
        };
        const inputReceipt = store.getCommandRequest(
          'turn.input.submit',
          input.requestId,
          commandScope
        );
        if (coreDb) {
          const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
          try {
            const checkpoint = getWorkerCheckpoint(
              workspaceDb,
              input.workspaceId,
              input.threadId,
              turnId
            );
            if (checkpoint) {
              let gateOwner: ReturnType<typeof requireWorkerCheckpointHumanCommandScope>;
              try {
                gateOwner = requireWorkerCheckpointHumanCommandScope(coreDb, checkpoint);
              } catch {
                throw workerGateRecoveryError(
                  'The worker user-input Gate has no exact human command identity.'
                );
              }
              if (gateOwner.actorId !== c.get('actor').userId) {
                return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
              }

              let turn: TurnReadModel;
              try {
                turn = await runIdempotentCommand({
                  store,
                  inflightCommands,
                  command: 'turn.input.submit',
                  requestId: input.requestId,
                  scope: commandScope,
                  input,
                  responseKind: 'turn',
                  execute: () =>
                    closeWorkerUserInputGate(
                      coreDb,
                      store,
                      workspaceDb,
                      input,
                      responseActor.id,
                      false
                    ),
                  replay: (record) =>
                    TurnSchema.parse(
                      store.getTurn(input.workspaceId, input.threadId, record.response.id)
                    ),
                  responseId: (result) => result.id,
                });
              } catch (error) {
                const currentCheckpoint = getWorkerCheckpoint(
                  workspaceDb,
                  input.workspaceId,
                  input.threadId,
                  turnId
                );
                if (!(error instanceof TurnStartValidationError) && currentCheckpoint) {
                  throw workerGateRecoveryError('The worker user-input receipt was not published.');
                }
                throw error;
              }
              if (turn.status === 'awaiting_human') {
                turn = closeWorkerUserInputGate(
                  coreDb,
                  store,
                  workspaceDb,
                  input,
                  responseActor.id,
                  true
                );
              }
              await clearWorkerUserInputGateCheckpoint(coreDb, store, workspaceDb, input);
              return c.json(projectOrdinaryTurn(turn), 202);
            }
            if (
              !inputReceipt &&
              listSchedulerSessionLeasesForTurn(coreDb, {
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                turnId,
              }).length > 0
            ) {
              throw workerGateRecoveryError(
                'The worker user-input Gate has no supported exact checkpoint.'
              );
            }
          } finally {
            workspaceDb.sqlite.close();
          }
        }
        const turn = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'turn.input.submit',
          requestId: input.requestId,
          scope: commandScope,
          input,
          responseKind: 'turn',
          execute: async () => {
            const currentTurn = store.getTurn(input.workspaceId, input.threadId, turnId);

            if (!isAwaitingUserInputGate(currentTurn)) {
              throw new TurnStartValidationError(
                'not_awaiting_input',
                `Turn is not awaiting user input: ${turnId}.`,
                409
              );
            }

            const updatedTurn = await turnExecutor.respondUserInput?.(
              store,
              turnId,
              input.answers,
              { requestId: input.requestId, actor: responseActor }
            );

            if (!updatedTurn) {
              throw new Error('The active agent runtime cannot respond to user input.');
            }

            return TurnSchema.parse(updatedTurn);
          },
          replay: (record) =>
            TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, record.response.id)),
          responseId: (result) => result.id,
        });

        completeSchedulerLeaseForTerminalTurn(coreDb, turn);

        return c.json(projectOrdinaryTurn(turn), 202);
      }

      if (store.getWorkspace(input.workspaceId).kind === 'quick-chat') {
        throw new TurnStartValidationError(
          'workspace_kind_not_supported',
          'Quick Chat workspace cannot start worker turns. Create or select a project workspace.'
        );
      }
      store.getThread(input.workspaceId, input.threadId);
      const turn = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'turn.start',
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, threadId: input.threadId },
        input,
        responseKind: 'turn',
        execute: async () => {
          const threadBusy = store
            .listThreadTurns(input.workspaceId, input.threadId)
            .some(
              (turn) =>
                turn.status === 'pending' ||
                turn.status === 'running' ||
                turn.status === 'awaiting_human'
            );
          if (threadBusy) {
            throw new TurnStartValidationError(
              'thread_busy',
              'Thread already has an active worker turn.',
              409
            );
          }

          const handle = await startProductTurn({
            input,
            providerCredentialResolver,
            schedulerEpoch,
            snapshot: runtimeConfig(),
            store,
            triggerActor: { kind: 'user', id: c.get('actor').userId },
            turnExecutor,
            workerPlacement,
            ...(coreDb ? { coreDb } : {}),
          });

          return TurnSchema.parse(handle.turn);
        },
        replay: (record) =>
          TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, record.response.id)),
        responseId: (result) => result.id,
      });

      completeSchedulerLeaseForTerminalTurn(coreDb, turn);

      return c.json(projectOrdinaryTurn(turn), 202);
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        return asCommandError(error, 'turn_start_failed');
      }

      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'turn_start_failed');
    }
  });

  registerFeedbackRoutes({ app, requestStore });

  app.get('/api/workspaces/:workspaceId/threads/:threadId/turns/:turnId', (c) => {
    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    const turnId = c.req.param('turnId');
    const store = requestStore(c);
    let ownerTurn: ReturnType<FsStore['getTurnById']>;

    try {
      ownerTurn = store.getTurnById(turnId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    const workspaceAccess = c.get('workspaceAccess');
    if (workspaceAccess) {
      assertAuthorizedWorkspaceLineage(workspaceAccess, ownerTurn.workspaceId);
    }

    try {
      const turn = store.getTurn(workspaceId, threadId, turnId);
      let contextPackageDigest: string | null = null;

      if (coreDb) {
        let workspaceDb: WorkspaceDb | null = null;
        try {
          workspaceDb = repositoryWorkspaceDb(workspaceId);
          contextPackageDigest = readStrictWorkerContextPackageDigest({
            coreDb,
            store,
            threadId,
            turnId,
            workspaceDb,
          });
        } catch {
          contextPackageDigest = null;
        } finally {
          workspaceDb?.sqlite.close();
        }
      }

      return c.json(
        TurnReadProjectionSchema.parse({ ...projectOrdinaryTurn(turn), contextPackageDigest })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt', async (c) => {
    const parsed = InterruptTurnRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    const turnId = c.req.param('turnId');
    const store = requestStore(c);
    let ownerTurn: ReturnType<FsStore['getTurnById']>;

    try {
      ownerTurn = store.getTurnById(turnId);
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }

    const workspaceAccess = c.get('workspaceAccess');
    if (workspaceAccess) {
      assertAuthorizedWorkspaceLineage(workspaceAccess, ownerTurn.workspaceId);
    }

    try {
      store.getTurn(workspaceId, threadId, turnId);
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }

    try {
      const turn = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'turn.interrupt',
        requestId: parsed.data.requestId,
        scope: {
          workspaceId,
          threadId,
          turnId,
        },
        input: {
          ...parsed.data,
          workspaceId,
          threadId,
          turnId,
        },
        responseKind: 'turn',
        execute: async () => {
          const currentTurn = store.getTurn(workspaceId, threadId, turnId);

          if (
            currentTurn.status === 'completed' ||
            currentTurn.status === 'interrupted' ||
            currentTurn.status === 'cancelled' ||
            currentTurn.status === 'failed'
          ) {
            throw new TurnStartValidationError(
              'turn_not_interruptible',
              `Turn is already terminal: ${turnId}.`,
              409
            );
          }

          if (!turnExecutor.capabilities.interrupts) {
            throw new TurnStartValidationError(
              'interrupts_not_supported',
              'The active agent runtime cannot interrupt turns.',
              501
            );
          }

          await turnExecutor.interruptTurn(store, turnId, {
            requestId: parsed.data.requestId,
          });
          return TurnSchema.parse(store.getTurn(workspaceId, threadId, turnId));
        },
        replay: (record) =>
          TurnSchema.parse(store.getTurn(workspaceId, threadId, record.response.id)),
        responseId: (result) => result.id,
      });

      completeSchedulerLeaseForTerminalTurn(coreDb, turn);

      return c.json(projectOrdinaryTurn(turn));
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }
  });
}

/** Structured user-input command that closes one existing Human Gate. */
type WorkerUserInputCommand = Extract<
  z.infer<typeof SubmitTurnInputRequestSchema>,
  { turnId: string }
>;

/**
 * Verifies the exact outer mode-command receipt that owns one worker user-input Gate.
 *
 * @param store Product store containing command receipts.
 * @param workspaceDb Workspace receipt owner for Goal steps.
 * @param checkpoint Exact worker checkpoint awaiting closeout.
 * @param ownerScope Authenticated actor, Workspace, and Thread owner scope.
 * @param turnId Worker Turn whose deterministic origin must match the receipt.
 * @returns Whether the receipt proves the checkpoint's exact direct or Chat-subordinate origin.
 */
function hasExactWorkerUserInputOwnerReceipt(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  checkpoint: NonNullable<ReturnType<typeof getWorkerCheckpoint>>,
  ownerScope: ReturnType<typeof requireWorkerCheckpointHumanCommandScope>,
  turnId: string
): boolean {
  if (checkpoint.goalId && checkpoint.taskId) {
    const receipt = store.getCommandRequest(
      'goal.step',
      checkpoint.requestId,
      ownerScope,
      workspaceDb
    );
    return (
      receipt?.inputHash === checkpoint.requestInputHash &&
      receipt.scope.actorId === ownerScope.actorId &&
      receipt.scope.workspaceId === ownerScope.workspaceId &&
      receipt.scope.threadId === ownerScope.threadId &&
      receipt.response.kind === 'goal' &&
      receipt.response.id === checkpoint.goalId
    );
  }

  const chatSubordinateTurnId = chatTaskModeTurnId(
    ownerScope.actorId,
    ownerScope.workspaceId,
    ownerScope.threadId,
    checkpoint.requestId
  );
  if (turnId === chatSubordinateTurnId) {
    const receipt = store.getCommandRequest(
      'conversation.submit',
      checkpoint.requestId,
      ownerScope
    );
    return (
      receipt?.scope.actorId === ownerScope.actorId &&
      receipt.scope.workspaceId === ownerScope.workspaceId &&
      receipt.scope.threadId === ownerScope.threadId &&
      receipt.response.kind === 'turn' &&
      receipt.response.conversationMetadata?.resultKind === 'task-handoff' &&
      receipt.response.conversationMetadata.status === 202 &&
      receipt.response.conversationMetadata.downstream?.kind === 'task' &&
      receipt.response.conversationMetadata.downstream.turnId === turnId
    );
  }

  if (
    findExactConversationWorkerOwnerReceipt(store, {
      actorId: ownerScope.actorId,
      workspaceId: ownerScope.workspaceId,
      receivingThreadId: ownerScope.threadId,
      requestId: checkpoint.requestId,
      requestInputHash: checkpoint.requestInputHash,
      turnId,
    })
  ) {
    return true;
  }

  const receipt = store.getCommandRequest('task.start', checkpoint.requestId, ownerScope);
  return (
    receipt?.inputHash === checkpoint.requestInputHash &&
    receipt.scope.actorId === ownerScope.actorId &&
    receipt.scope.workspaceId === ownerScope.workspaceId &&
    receipt.scope.threadId === ownerScope.threadId &&
    receipt.response.kind === 'turn' &&
    receipt.response.id === turnId
  );
}

/**
 * Closes one worker user-input Gate without resuming its worker executor.
 *
 * @param coreDb Core database containing scheduler and worker lineage.
 * @param store Product store containing the Turn, AgentSession, Items, and receipts.
 * @param workspaceDb Workspace database containing the worker checkpoint.
 * @param input Exact structured user-input command.
 * @param actorId Authenticated responsible user answering the request.
 * @param applyCloseout Whether to apply the already-validated response effect after receipt publish.
 * @returns Validated active Turn before receipt publication, or its applied terminal closeout.
 * @throws TurnStartValidationError when the Gate owner tuple is absent or contradictory.
 */
function closeWorkerUserInputGate(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: WorkerUserInputCommand,
  actorId: string,
  applyCloseout: boolean
): TurnReadModel {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const goalId = checkpoint?.goalId ?? null;
  const taskId = checkpoint?.taskId ?? null;
  const goalTaskCheckpoint = goalId !== null && taskId !== null;
  if (
    !checkpoint?.workerSessionId ||
    ((goalId === null || taskId === null) && (goalId !== null || taskId !== null))
  ) {
    throw workerGateRecoveryError('The worker user-input Gate has no exact checkpoint.');
  }
  if (checkpoint.stage !== 'waiting_for_user' || checkpoint.stopReason !== 'ask_user') {
    throw workerGateRecoveryError('The worker user-input checkpoint is not waiting.');
  }
  try {
    if (recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, checkpoint) !== 'ask_user') {
      throw new Error('Unexpected worker Gate outcome.');
    }
  } catch {
    throw workerGateRecoveryError('The worker user-input Gate has no exact active owner tuple.');
  }
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const gate = turn.humanGate;
  const requestItem = turn.items.find((item) => item.id === gate?.itemId);
  if (
    turn.status !== 'awaiting_human' ||
    gate?.kind !== 'user-input' ||
    requestItem?.type !== 'user-input-request' ||
    requestItem.status !== 'completed' ||
    requestItem.userInputRequestId !== gate.userInputRequestId
  ) {
    throw workerGateRecoveryError('The worker user-input command does not match the active Gate.');
  }
  const questionIds = requestItem.questions.map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length) {
    throw workerGateRecoveryError('The worker user-input Gate contains duplicate question ids.');
  }
  if (JSON.stringify(Object.keys(input.answers).sort()) !== JSON.stringify(questionIds.sort())) {
    throw new TurnStartValidationError(
      'invalid_request',
      'The answer keys must exactly match the active Gate questions.',
      400
    );
  }
  const initiatingItem = turn.items.find((item) => item.id === `it_user_${turn.id}`);
  const contextAssembly = parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary);
  try {
    if (
      initiatingItem?.type !== 'user-message' ||
      initiatingItem.status !== 'completed' ||
      initiatingItem.workspaceId !== input.workspaceId ||
      initiatingItem.threadId !== input.threadId ||
      initiatingItem.turnId !== input.turnId ||
      !checkpoint.contextDigest
    ) {
      throw new Error('Worker input mismatch.');
    }
    const workerRequest = StructuredWorkerDelegationRequestSchema.parse(
      JSON.parse(initiatingItem.text)
    );
    if (!goalTaskCheckpoint && commandInputHash(workerRequest) !== checkpoint.contextDigest) {
      throw new Error('Worker input mismatch.');
    }
    if (
      goalTaskCheckpoint &&
      (!contextAssembly ||
        contextAssembly.contextDigest !== checkpoint.contextDigest ||
        JSON.stringify(contextAssembly.contextRefs) !== JSON.stringify(workerRequest.contextRefs))
    ) {
      throw new Error('Worker context mismatch.');
    }
  } catch {
    throw workerGateRecoveryError('The worker user-input Gate has no authoritative worker input.');
  }
  const evidence = parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary);
  let ownerScope: ReturnType<typeof requireWorkerCheckpointHumanCommandScope>;
  try {
    ownerScope = requireWorkerCheckpointHumanCommandScope(coreDb, checkpoint);
  } catch {
    throw workerGateRecoveryError(
      'The worker user-input Gate has no exact human command identity.'
    );
  }
  if (
    !evidence ||
    !hasExactWorkerUserInputOwnerReceipt(store, workspaceDb, checkpoint, ownerScope, input.turnId)
  ) {
    throw workerGateRecoveryError('The worker user-input Gate has no exact mode-command receipt.');
  }
  if (goalTaskCheckpoint) {
    const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, goalId);
    const task = listGoalTasks(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId,
    }).find((candidate) => candidate.taskId === taskId);
    if (
      goal?.status !== 'awaiting_user' ||
      goal.currentTaskId !== taskId ||
      goal.terminalStopReason !== null ||
      task?.status !== 'running'
    ) {
      throw workerGateRecoveryError('The worker user-input Gate contradicts its Goal Task owner.');
    }
  }
  if (!applyCloseout) {
    return TurnSchema.parse(turn);
  }
  const timestamp = new Date().toISOString();
  const responseItemId = `it_user_input_response_${input.turnId}`;
  store.createItem({
    id: responseItemId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    type: 'user-input-response',
    status: 'completed',
    actor: { kind: 'user', id: actorId },
    causationId: input.requestId,
    userInputRequestId: gate.userInputRequestId,
    answers: input.answers,
    createdAt: timestamp,
    completedAt: timestamp,
  });
  store.updateAgentSession(checkpoint.workerSessionId, {
    status: 'idle',
    updatedAt: timestamp,
  });
  const closedTurn = store.updateTurn(input.turnId, {
    status: 'completed',
    humanGate: null,
    completedAt: timestamp,
  });
  store.emitTurnEvent(input.turnId, {
    event: 'turn.completed',
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    data: { type: 'turn-completed', stopReason: 'completed', turn: closedTurn },
  });
  const terminalCheckpoint = updateWorkerCheckpoint(workspaceDb, {
    authorityActor: turn.triggerActor,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    stage: 'completed',
    stopReason: 'completed',
    diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(
      {
        itemIds: [...new Set([...evidence.itemIds, responseItemId])],
        artifactIds: evidence.artifactIds,
      },
      contextAssembly
    ),
  });
  if (goalTaskCheckpoint) {
    workspaceDb.sqlite.transaction(() => {
      updateGoalTask(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId,
        taskId,
        status: 'ready',
        latestGateContextItemId: responseItemId,
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId,
        status: 'running',
        currentTaskId: null,
        terminalStopReason: null,
      });
    })();
  }
  completeSchedulerLeaseForTerminalTurn(coreDb, TurnSchema.parse(closedTurn));
  try {
    if (
      recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, terminalCheckpoint) !==
      'completed'
    ) {
      throw new Error('Unexpected terminal outcome.');
    }
  } catch {
    throw workerGateRecoveryError(
      'The worker user-input Gate did not release scheduler ownership.'
    );
  }
  return TurnSchema.parse(closedTurn);
}

/**
 * Validates both user-input receipts and removes the completed worker checkpoint.
 *
 * @param coreDb Core database containing the released scheduler lease.
 * @param store Product store containing the Gate and Turn owners.
 * @param workspaceDb Workspace database containing the terminal checkpoint.
 * @param input Exact structured user-input command.
 * @throws TurnStartValidationError when any closeout owner is absent or contradictory.
 */
async function clearWorkerUserInputGateCheckpoint(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: WorkerUserInputCommand
): Promise<void> {
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const closure = classifyClosedWorkerUserInputGate(store, turn);
  const evidence = checkpoint ? parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary) : null;
  let hasOwnerReceipt = false;
  try {
    hasOwnerReceipt = checkpoint
      ? hasExactWorkerUserInputOwnerReceipt(
          store,
          workspaceDb,
          checkpoint,
          requireWorkerCheckpointHumanCommandScope(coreDb, checkpoint),
          input.turnId
        )
      : false;
  } catch {
    hasOwnerReceipt = false;
  }
  const gateReceipt = store.getCommandRequest('turn.input.submit', input.requestId, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
  });
  let goalOwnerComplete = true;
  try {
    if (checkpoint?.goalId && checkpoint.taskId && closure) {
      const goal = getGoalRecord(workspaceDb, input.workspaceId, input.threadId, checkpoint.goalId);
      const task = listGoalTasks(workspaceDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        goalId: checkpoint.goalId,
      }).find((candidate) => candidate.taskId === checkpoint.taskId);
      goalOwnerComplete =
        goal?.status === 'running' &&
        goal.currentTaskId === null &&
        goal.terminalStopReason === null &&
        task?.status === 'ready' &&
        task.latestGateContextItemId === closure.responseItemId;
    }
  } catch {
    goalOwnerComplete = false;
  }
  try {
    if (
      !checkpoint ||
      recoverWorkerCheckpointStopReason(coreDb, store, workspaceDb, checkpoint) !== 'completed' ||
      !closure ||
      !evidence?.itemIds.includes(closure.requestItemId) ||
      !evidence.itemIds.includes(closure.responseItemId) ||
      !hasOwnerReceipt ||
      gateReceipt?.response.kind !== 'turn' ||
      gateReceipt.response.id !== input.turnId ||
      !goalOwnerComplete
    ) {
      throw new Error('Incomplete Gate closeout.');
    }
  } catch {
    throw workerGateRecoveryError('The worker user-input closeout is incomplete.');
  }
  if (
    !(await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
    }))
  ) {
    throw workerGateRecoveryError('The worker user-input checkpoint could not be cleared.');
  }
}

/**
 * Creates the typed fail-closed error for worker Gate contradictions.
 *
 * @param message Product-safe contradiction summary.
 * @returns Recovery-required route error.
 */
function workerGateRecoveryError(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}
