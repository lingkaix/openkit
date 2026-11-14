import { commandInputHash } from '../storage/control-store-input.js';

export { commandInputHash } from '../storage/control-store-input.js';

import { IdempotencyKeyConflictError } from '../operation-error.js';

export { IdempotencyKeyConflictError } from '../operation-error.js';

import { deriveEntityId } from '@openkit/protocol';

import {
  type CommandRequestName,
  type CommandRequestRecord,
  type CommandRequestResponseKind,
  type CommandRequestScope,
  type ConversationCommandReceiptMetadata,
  commandRequestExpiresAt,
  commandRequestKey,
  type FsStore,
} from '../lib/store.js';
import type { AppDb } from '../storage/app-db.js';
import type { CoreDb, UserDb, WorkspaceDb } from '../storage/db.js';

/** Original command facts passed to the existing producer before its single native tuple; the product owner supplies the final response pointer. */
export type IdempotentCommandReceipt = Readonly<
  Omit<CommandRequestRecord, 'response' | 'expiresAt'> & {
    responseKind: CommandRequestResponseKind;
    expiresAt: string;
  }
>;

/** In-flight command state used to collapse concurrent duplicate requests. */
export interface InflightIdempotentCommand {
  /** Hash of canonical command input. */
  readonly inputHash: string;
  /** Shared command result promise. */
  readonly promise: Promise<unknown>;
}

/** Exact lineage used to locate one Worker Turn owned by `conversation.submit`. */
export interface ConversationWorkerReceiptLineage {
  /** Responsible product user. */
  readonly actorId: string;
  /** Workspace receiving the Worker Turn. */
  readonly workspaceId: string;
  /** Thread receiving the Worker Turn. */
  readonly receivingThreadId: string;
  /** Original conversation command request. */
  readonly requestId: string;
  /** Canonical conversation command input hash retained by the Worker checkpoint. */
  readonly requestInputHash: string;
  /** Worker Turn owned by the receipt. */
  readonly turnId: string;
}

/**
 * Finds the unique conversation receipt that owns one selected Worker Turn.
 *
 * The originating Thread is intentionally read from the receipt scope because a new Task Worker may receive the Turn in a different Thread.
 *
 * @param store Product store containing bounded command receipts.
 * @param lineage Exact responsible actor, receiving lineage, request, input, and Turn tuple.
 * @returns The unique matching receipt, or null when authority is absent or contradictory.
 */
export function findExactConversationWorkerOwnerReceipt(
  store: FsStore,
  lineage: ConversationWorkerReceiptLineage
): CommandRequestRecord | null {
  const matches = store.listCommandRequests(lineage.workspaceId).filter((receipt) => {
    const metadata = receipt.response.conversationMetadata;
    return (
      receipt.command === 'conversation.submit' &&
      receipt.requestId === lineage.requestId &&
      receipt.inputHash === lineage.requestInputHash &&
      receipt.scope.actorId === lineage.actorId &&
      receipt.scope.workspaceId === lineage.workspaceId &&
      receipt.response.kind === 'turn' &&
      receipt.response.id === lineage.turnId &&
      metadata?.receivingWorkspaceId === lineage.workspaceId &&
      metadata.receivingThreadId === lineage.receivingThreadId &&
      metadata.resultKind === 'worker-turn' &&
      metadata.status === 202 &&
      metadata.downstream?.kind === 'task' &&
      metadata.downstream.turnId === lineage.turnId
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** One native producer and its original scoped replay contract. */
interface IdempotentCommandOptions<T> {
  /** Store that owns the idempotency ledger. */
  readonly store: FsStore;
  /** Process-local in-flight command maps keyed by actor-scoped store. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Stable command name. */
  readonly command: CommandRequestName;
  /** Caller-supplied idempotency id. */
  readonly requestId: string;
  /** Non-secret scope ids. */
  readonly scope: CommandRequestScope;
  /** Canonical command input used only to compute a hash. */
  readonly input: unknown;
  /** Resource kind returned by this command. */
  readonly responseKind: CommandRequestResponseKind;
  /** Captures the sole Core-authorized extra receipt metadata for `conversation.submit`. */
  readonly conversationResponseMetadata?: (result: T) => ConversationCommandReceiptMetadata;
  /** Replays the current resource snapshot for an existing ledger record. */
  readonly replay: (record: CommandRequestRecord) => Promise<T> | T;
  /** Extracts the response resource id from a fresh command result. */
  readonly responseId: (result: T) => string;
  /** Producer commits its original native tuple or post-effect receipt before it returns. */
  readonly execute: (receipt: IdempotentCommandReceipt) => Promise<T> | T;
  /** Explicit original Core or User receipt owner; this connection is used only for reads. */
  readonly receiptDb?: UserDb | CoreDb;
  /** Optional original Workspace receipt reader. */
  readonly workspaceDb?: WorkspaceDb;
  /** Optional original App receipt reader; expired App identities still refuse reuse. */
  readonly appDb?: AppDb;
}
/** Executes or replays one command, retaining actor-scoped in-flight collapse and native receipt authority. */
export async function runIdempotentCommand<T>(options: IdempotentCommandOptions<T>): Promise<T> {
  if (options.conversationResponseMetadata && options.command !== 'conversation.submit')
    throw new Error('Only conversation.submit may store extra command receipt metadata.');
  const inputHash = commandInputHash(options.input);
  const commandDb = options.receiptDb ?? options.workspaceDb ?? options.appDb;
  const existingRecord = options.store.getCommandRequest(
    options.command,
    options.requestId,
    options.scope,
    commandDb
  );
  if (existingRecord) {
    if (existingRecord.inputHash !== inputHash) throw new IdempotencyKeyConflictError();
    return options.replay(existingRecord);
  }
  const key = commandRequestKey(options.command, options.requestId, options.scope);
  let inflight = options.inflightCommands.get(options.store);
  if (!inflight) {
    inflight = new Map();
    options.inflightCommands.set(options.store, inflight);
  }
  const prior = inflight.get(key);
  if (prior) {
    if (prior.inputHash !== inputHash) throw new IdempotencyKeyConflictError();
    return (await prior.promise) as T;
  }
  const createdAt = new Date().toISOString();
  const receipt: IdempotentCommandReceipt = {
    key,
    command: options.command,
    requestId: options.requestId,
    scope: { ...options.scope },
    inputHash,
    responseKind: options.responseKind,
    createdAt,
    expiresAt: commandRequestExpiresAt(createdAt),
  };
  const promise = (async () => {
    const result = await options.execute(receipt);
    if (options.store.getDataRoot() !== null || commandDb !== undefined) {
      // Never backfill a tuple after its native owner returned: this is observation, not publication.
      const committed = options.store.getCommandRequest(
        options.command,
        options.requestId,
        options.scope,
        commandDb
      );
      if (!committed)
        throw new Error('Native command returned without its original committed receipt.');
      if (committed.inputHash !== inputHash) throw new IdempotencyKeyConflictError();
      if (
        committed.response.kind !== options.responseKind ||
        committed.response.id !== options.responseId(result)
      )
        throw new Error('Native command result differs from its original committed receipt.');
    } else {
      options.store.recordCommandRequest({
        ...receipt,
        response: {
          kind: options.responseKind,
          id: options.responseId(result),
          ...(options.conversationResponseMetadata
            ? { conversationMetadata: options.conversationResponseMetadata(result) }
            : {}),
        },
      });
    }
    return result;
  })();
  inflight.set(key, { inputHash, promise });
  try {
    return await promise;
  } finally {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  }
}

/** Derives the receiving Thread of an admitted command-initiated conversation handoff. */
export function conversationTaskThreadId(
  actor: import('@openkit/protocol').ActorRef,
  workspaceId: string,
  originatingThreadId: string,
  requestId: string
): string {
  return deriveEntityId('th', [actor, workspaceId, originatingThreadId, requestId]);
}

/** Derives the first Task Turn inside that handoff's exact receiving Thread. */
export function conversationTaskTurnId(
  actor: import('@openkit/protocol').ActorRef,
  workspaceId: string,
  originatingThreadId: string,
  receivingThreadId: string,
  requestId: string
): string {
  return deriveEntityId('tu', [
    actor,
    workspaceId,
    originatingThreadId,
    receivingThreadId,
    requestId,
  ]);
}
