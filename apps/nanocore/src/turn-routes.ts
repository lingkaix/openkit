import {
  InterruptTurnRequestSchema,
  isSealedTurnTerminal,
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
import type { FsStore } from './lib/store.js';
import { QUICK_CHAT_AGENT_ID } from './mode-entry-routes.js';
import type { ProviderCredentialResolver } from './providers/registry.js';
import { registerFeedbackRoutes } from './runtime/feedback-routes.js';
import { GoalPlanApprovalError } from './runtime/goal-plan-approval.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { startProductTurn } from './runtime/product-turn-start.js';
import type { TurnExecutor } from './runtime/types.js';
import { completeSchedulerLeaseForTerminalTurn } from './scheduler-records.js';
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
 * Registers the Core turn start, feedback, read, and interrupt routes.
 *
 * @param dependencies Hono app and concrete turn persistence, scheduler, and runtime dependencies.
 */
export function registerTurnRoutes({
  app,
  coreDb,
  inflightCommands,
  interruptInternalChatTurn,
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
  readonly interruptInternalChatTurn: (store: FsStore, turnId: string) => Promise<boolean>;
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
            .some((turn) => !isSealedTurnTerminal(turn.status));
          if (threadBusy) {
            throw new TurnStartValidationError(
              'thread_busy',
              'Thread already has an active worker turn.',
              409
            );
          }

          const handle = await startProductTurn({
            input,
            requestActor: c.get('actor'),
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
      if (error instanceof GoalPlanApprovalError) {
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
      const turn = await interruptProductTurn({
        store,
        inflightCommands,
        interruptInternalChatTurn,
        coreDb,
        turnExecutor,
        workspaceId,
        threadId,
        turnId,
        requestId: parsed.data.requestId,
      });

      return c.json(projectOrdinaryTurn(turn));
    } catch (error) {
      return asCommandError(error, 'turn_interrupt_failed');
    }
  });
}

/** Interrupts one exact Turn through its existing command receipt and scheduler lease owner. */
export async function interruptProductTurn(input: {
  readonly store: FsStore;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly interruptInternalChatTurn?: (store: FsStore, turnId: string) => Promise<boolean>;
  readonly coreDb: CoreDb | undefined;
  readonly turnExecutor: TurnExecutor;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string;
}): Promise<z.infer<typeof TurnSchema>> {
  const {
    store,
    inflightCommands,
    interruptInternalChatTurn,
    coreDb,
    turnExecutor,
    workspaceId,
    threadId,
    turnId,
    requestId,
  } = input;
  const turn = await runIdempotentCommand({
    store,
    inflightCommands,
    command: 'turn.interrupt',
    requestId: requestId,
    scope: {
      workspaceId,
      threadId,
      turnId,
    },
    input: {
      requestId,
      workspaceId,
      threadId,
      turnId,
    },
    responseKind: 'turn',
    execute: async () => {
      const currentTurn = store.getTurn(workspaceId, threadId, turnId);

      if (isSealedTurnTerminal(currentTurn.status)) {
        throw new TurnStartValidationError(
          'turn_not_interruptible',
          `Turn is already terminal: ${turnId}.`,
          409
        );
      }

      if (await interruptInternalChatTurn?.(store, turnId)) {
        return TurnSchema.parse(store.getTurn(workspaceId, threadId, turnId));
      }

      if (!turnExecutor.capabilities.interrupts) {
        throw new TurnStartValidationError(
          'interrupts_not_supported',
          'The active agent runtime cannot interrupt turns.',
          501
        );
      }

      await turnExecutor.interruptTurn(store, turnId, {
        requestId: requestId,
      });
      return TurnSchema.parse(store.getTurn(workspaceId, threadId, turnId));
    },
    replay: (record) => TurnSchema.parse(store.getTurn(workspaceId, threadId, record.response.id)),
    responseId: (result) => result.id,
  }).catch((error: unknown) => {
    if (error instanceof TurnStartValidationError && error.code === 'recovery_required')
      throw error;
    const currentTurn = store.getTurn(workspaceId, threadId, turnId);
    if (
      interruptInternalChatTurn &&
      currentTurn.agentId === QUICK_CHAT_AGENT_ID &&
      !currentTurn.agentSessionId &&
      currentTurn.status === 'interrupted' &&
      currentTurn.error?.code === 'provider_call_aborted'
    ) {
      if (error instanceof TurnStartValidationError && error.code === 'turn_not_interruptible') {
        const receipts = store.listCommandRequests();
        const hasSubmitReceipt = receipts.some(
          (receipt) =>
            receipt.command === 'conversation.submit' &&
            currentTurn.triggerActor.kind === 'user' &&
            receipt.scope.actorId === currentTurn.triggerActor.id &&
            receipt.scope.workspaceId === workspaceId &&
            receipt.scope.threadId === threadId &&
            receipt.response.kind === 'turn' &&
            receipt.response.id === turnId &&
            receipt.response.conversationMetadata === undefined
        );
        const hasInterruptReceipt = receipts.some(
          (receipt) =>
            receipt.command === 'turn.interrupt' &&
            receipt.scope.workspaceId === workspaceId &&
            receipt.scope.threadId === threadId &&
            receipt.scope.turnId === turnId &&
            receipt.response.kind === 'turn' &&
            receipt.response.id === turnId &&
            receipt.inputHash ===
              commandInputHash({
                requestId: receipt.requestId,
                workspaceId,
                threadId,
                turnId,
              })
        );
        // Complete publication makes a fresh Stop an ordinary terminal conflict.
        if (hasSubmitReceipt && hasInterruptReceipt) throw error;
      }
      throw new TurnStartValidationError(
        'recovery_required',
        'The Chat interruption is missing its required durable records.',
        409
      );
    }
    throw error;
  });

  completeSchedulerLeaseForTerminalTurn(coreDb, turn);

  return turn;
}

/** Structured user-input command that closes one existing Human Gate. */
