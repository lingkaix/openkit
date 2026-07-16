import {
  InterruptTurnRequestSchema,
  SubmitTurnInputRequestSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import type { FsStore } from './lib/store.js';
import { registerFeedbackRoutes } from './runtime/feedback-routes.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { startProductTurn } from './runtime/product-turn-start.js';
import type { TurnExecutor } from './runtime/types.js';
import { completeSchedulerLeaseForTerminalTurn } from './scheduler-records.js';
import type { CoreDb } from './storage/db.js';

/** Parsed turn read model shape used by route-level guards. */
type TurnReadModel = z.infer<typeof TurnSchema>;

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
 * Registers the Core turn start, feedback, read, and interrupt routes.
 *
 * @param dependencies Hono app and concrete turn persistence, scheduler, and runtime dependencies.
 */
export function registerTurnRoutes({
  app,
  coreDb,
  inflightCommands,
  requestStore,
  runtimeConfig,
  schedulerEpoch,
  turnExecutor,
  workerPlacement,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
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
      if (input.turnId) {
        const turnId = input.turnId;
        const turn = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'turn.input.submit',
          requestId: input.requestId,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId,
          },
          input,
          responseKind: 'turn',
          execute: async () => {
            const currentTurn = store.getTurn(input.workspaceId, input.threadId, turnId);

            if (!isAwaitingUserInputGate(currentTurn)) {
              throw new TurnStartValidationError(
                'turn_not_awaiting_user_input',
                `Turn is not awaiting user input: ${turnId}.`
              );
            }

            const updatedTurn = await turnExecutor.respondUserInput?.(store, turnId, input.input, {
              requestId: input.requestId,
            });

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

        return c.json(turn, 202);
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
            schedulerEpoch,
            snapshot: runtimeConfig(),
            store,
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

      return c.json(turn, 202);
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
    try {
      return c.json(
        TurnSchema.parse(
          requestStore(c).getTurn(
            c.req.param('workspaceId'),
            c.req.param('threadId'),
            c.req.param('turnId')
          )
        )
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt', async (c) => {
    try {
      const parsed = InterruptTurnRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const turnId = c.req.param('turnId');
      const store = requestStore(c);
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

      return c.json(turn);
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }
  });
}
