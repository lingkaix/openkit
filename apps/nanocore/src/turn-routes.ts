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
import type { FsStore } from './lib/store.js';
import { QUICK_CHAT_AGENT_ID } from './mode-entry-routes.js';
import type { ProviderCredentialResolver } from './providers/registry.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import {
  observeTurnAdmission,
  startProductTurn,
  validateLiveProductTurnAdmission,
} from './runtime/product-turn-start.js';
import type { TurnExecutor } from './runtime/types.js';
import {
  completeSchedulerLeaseForTerminalTurn,
  listSchedulerSessionLeasesForTurn,
} from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/** Parsed turn read model shape used by route-level guards. */
type TurnReadModel = z.infer<typeof TurnSchema>;

// Core database identity scopes process-local execution ownership to this App.
const activeTurnCloseouts = new WeakMap<CoreDb, Map<string, Promise<void>>>();

/**
 * Binds Core command input to the common durable live Turn admission.
 *
 * Receipt lookup already verifies the complete semantic-input hash before replay; this predicate verifies that the scheduler owners still carry that same admitted input.
 *
 * @param coreDb Scheduler authority, required for worker admission.
 * @param store Command store.
 * @param input Immutable command input.
 * @param actorId Original initiating actor, retained on replay.
 * @param turnId Original admitted Turn.
 * @throws TurnStartValidationError when Core input or scheduler authority disagrees.
 */
function validateCoreTurnAdmission(
  coreDb: CoreDb | undefined,
  store: FsStore,
  input: z.infer<typeof SubmitTurnInputRequestSchema>,
  actorId: string,
  turnId: string
): void {
  if (!coreDb)
    throw new TurnStartValidationError(
      'recovery_required',
      'Turn admission has no scheduler storage.',
      409
    );
  const { admission } = validateLiveProductTurnAdmission({
    coreDb,
    store,
    actorId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestId: input.requestId,
    turnId,
  });
  if (
    admission.turnInput !== input.input ||
    admission.modelId !== (input.modelId ?? null) ||
    admission.profileRef !== (input.profileId ?? null) ||
    (input.agentId !== undefined && admission.requestedAgentId !== input.agentId) ||
    admission.reasoningEffort !== input.reasoningEffort
  )
    throw new TurnStartValidationError(
      'recovery_required',
      'Turn scheduler admission contradicts command input.',
      409
    );
}

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

      const closeouts = coreDb
        ? (activeTurnCloseouts.get(coreDb) ?? new Map<string, Promise<void>>())
        : new Map<string, Promise<void>>();
      if (coreDb) activeTurnCloseouts.set(coreDb, closeouts);
      let admittedTurnId: string | undefined;
      const observed = observeTurnAdmission({
        execute: (admit) =>
          startProductTurn({
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
            onTurnCreated: (created) => {
              validateCoreTurnAdmission(coreDb, store, input, actor.userId, created.id);
              admittedTurnId = created.id;
              closeouts.set(created.id, observed.closeout);
              admit(created);
            },
          }),
        closeout: (handle) => completeSchedulerLeaseForTerminalTurn(coreDb, handle.turn),
        settled: () => {
          if (admittedTurnId) closeouts.delete(admittedTurnId);
        },
        failed: () => console.error('turn_worker_closeout_failed_after_admission'),
      });
      const admitted = await observed.accepted;
      // Terminal publication can precede cleanup; only replay joins that closeout.
      return TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, admitted.id));
    },
    replay: async (record) => {
      try {
        // The receipt kind and exact owner must agree before either replay branch is selected.
        if (record.response.kind !== 'turn') throw new Error('Turn receipt kind contradiction.');
        const current = TurnSchema.parse(
          store.getTurn(input.workspaceId, input.threadId, record.response.id)
        );
        if (current.status === 'pending' || current.status === 'running') {
          validateCoreTurnAdmission(coreDb, store, input, current.triggerActor.id, current.id);
        } else {
          const closeout = coreDb ? activeTurnCloseouts.get(coreDb)?.get(current.id) : undefined;
          if (closeout) {
            try {
              await closeout;
            } catch {
              // A durable failed Turn remains readable; a successful Turn cannot hide failed closeout.
              if (current.status !== 'failed')
                throw new TurnStartValidationError(
                  'recovery_required',
                  'The original Turn worker closeout failed.',
                  409
                );
            }
          }
          if (
            coreDb &&
            current.status === 'completed' &&
            listSchedulerSessionLeasesForTurn(coreDb, {
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              turnId: current.id,
            }).some((lease) => lease.status !== 'released')
          )
            throw new TurnStartValidationError(
              'recovery_required',
              'The terminal Turn lease requires recovery.',
              409
            );
        }
        return TurnSchema.parse(store.getTurn(input.workspaceId, input.threadId, current.id));
      } catch (error) {
        if (error instanceof TurnStartValidationError) throw error;
        throw new TurnStartValidationError(
          'recovery_required',
          'The original Turn receipt owner is missing or contradictory.',
          409
        );
      }
    },
    responseId: (result) => result.id,
  });

  return projectOrdinaryTurn(turn);
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
