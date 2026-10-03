import {
  isSealedTurnTerminal,
  ProductTurnSchema,
  type SubmitTurnInputRequestSchema,
  TurnReadProjectionSchema,
  TurnSchema,
} from '@openkit/protocol';
import type { z } from 'zod';

import type { Actor } from './auth/identity.js';
import type { RuntimeConfigSnapshot } from './config/runtime-config.js';
import { readStrictWorkerContextPackageDigest } from './context/worker-context-projection.js';
import { throwCoreCommandError } from './core-command-errors.js';
import type { FsStore } from './lib/store.js';
import { QUICK_CHAT_AGENT_ID } from './mode-entry-routes.js';
import type { ProviderCredentialResolver } from './providers/registry.js';
import {
  commandInputHash,
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

/** Existing worker admission dependencies; invocation adds no Turn lifecycle. */
export interface TurnStartDependencies {
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly providerCredentialResolver: ProviderCredentialResolver;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly schedulerEpoch: number;
  readonly turnExecutor: TurnExecutor;
  readonly workerPlacement: 'local' | 'remote';
}

/** Starts or replays the existing worker Turn after Workspace and Thread admission. */
export async function startTurn(
  input: z.infer<typeof SubmitTurnInputRequestSchema>,
  store: FsStore,
  actor: Actor,
  dependencies: TurnStartDependencies
) {
  const {
    coreDb,
    inflightCommands,
    providerCredentialResolver,
    runtimeConfig,
    schedulerEpoch,
    turnExecutor,
    workerPlacement,
  } = dependencies;
  try {
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
          requestActor: actor,
          providerCredentialResolver,
          schedulerEpoch,
          snapshot: runtimeConfig(),
          store,
          triggerActor: { kind: 'user', id: actor.userId },
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

    return projectOrdinaryTurn(turn);
  } catch (error) {
    throwCoreCommandError(error, 'turn_start_failed');
  }
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

/** Reads the owner-scoped product Turn and nullable verified Context Package evidence; unavailable evidence never repairs history. */
export function readTurn(
  store: FsStore,
  coreDb: CoreDb | undefined,
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  input: { workspaceId: string; threadId: string; turnId: string }
) {
  const { workspaceId, threadId, turnId } = input;
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

  return TurnReadProjectionSchema.parse({ ...projectOrdinaryTurn(turn), contextPackageDigest });
}
