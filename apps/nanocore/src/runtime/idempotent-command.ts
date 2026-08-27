import { createHash } from 'node:crypto';

import {
  type ChatCommandReceiptMetadata,
  type CommandRequestName,
  type CommandRequestRecord,
  type CommandRequestResponseKind,
  type CommandRequestScope,
  commandRequestKey,
  type FsStore,
} from '../lib/store.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';

/** Error raised when one idempotency key is reused for different command input. */
export class IdempotencyKeyConflictError extends Error {
  /** Stable protocol API error code. */
  public readonly code = 'idempotency_key_conflict';
  /** HTTP response status. */
  public readonly status = 409;

  /** Creates an idempotency key conflict error. */
  public constructor() {
    super('The requestId was already used for different command input.');
    this.name = 'IdempotencyKeyConflictError';
  }
}

/** In-flight command state used to collapse concurrent duplicate requests. */
export interface InflightIdempotentCommand {
  /** Hash of canonical command input. */
  readonly inputHash: string;
  /** Shared command result promise. */
  readonly promise: Promise<unknown>;
}

/** Options shared by synchronous transactional and ordinary idempotent commands. */
interface IdempotentCommandBaseOptions<T> {
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
  /** Captures the sole Core-authorized extra receipt metadata for `chat.start`. */
  readonly chatResponseMetadata?: (result: T) => ChatCommandReceiptMetadata;
  /** Replays the current resource snapshot for an existing ledger record. */
  readonly replay: (record: CommandRequestRecord) => Promise<T> | T;
  /** Extracts the response resource id from a fresh command result. */
  readonly responseId: (result: T) => string;
}

/** Options for one idempotent command, discriminated by its transaction boundary. */
type IdempotentCommandOptions<T> = IdempotentCommandBaseOptions<T> &
  (
    | {
        /** Executes synchronously inside the required Workspace transaction. */
        readonly execute: () => T;
        /** Open Workspace database that owns both the business record and receipt. */
        readonly workspaceDb: WorkspaceDb;
        /** Runs synchronous command execution and receipt writing in one Workspace transaction. */
        readonly workspaceTransaction: true;
        /** Core transaction mode is not selected. */
        readonly coreTransaction?: undefined;
        /** Core database is not selected. */
        readonly coreDb?: undefined;
      }
    | {
        /** Executes synchronously inside the required Core transaction. */
        readonly execute: () => T;
        /** Open Core database that owns both the business record and receipt. */
        readonly coreDb: CoreDb;
        /** Runs synchronous command execution and receipt writing in one Core transaction. */
        readonly coreTransaction: true;
        /** Workspace transaction mode is not selected. */
        readonly workspaceTransaction?: undefined;
        /** Workspace database is not selected. */
        readonly workspaceDb?: undefined;
      }
    | {
        /** Executes an ordinary command that may be asynchronous. */
        readonly execute: () => Promise<T> | T;
        /** Optional open Workspace database for receipt-first reads and writes. */
        readonly workspaceDb?: WorkspaceDb;
        /** Transactional execution is enabled only by the explicit true literal. */
        readonly workspaceTransaction?: undefined;
        /** Core database is not selected for ordinary commands. */
        readonly coreDb?: undefined;
        /** Core transactional execution is enabled only by the explicit true literal. */
        readonly coreTransaction?: undefined;
      }
  );

/**
 * Executes or replays one app-local idempotent command.
 *
 * @param options Command identity, input, ledger, execution, and replay behavior.
 * @returns Fresh or replayed command result.
 * @throws IdempotencyKeyConflictError when the same request id is reused with different input.
 * @throws Error when transaction mode lacks its database or receives asynchronous execution.
 */
export async function runIdempotentCommand<T>(options: IdempotentCommandOptions<T>): Promise<T> {
  if (options.chatResponseMetadata && options.command !== 'chat.start') {
    throw new Error('Only chat.start may store extra command receipt metadata.');
  }
  let transaction: { readonly db: CoreDb | WorkspaceDb; readonly execute: () => T } | undefined;

  if (options.workspaceTransaction) {
    if (!options.workspaceDb) {
      throw new Error('workspaceTransaction requires an open Workspace database.');
    }
    if (Object.prototype.toString.call(options.execute) === '[object AsyncFunction]') {
      throw new Error('workspaceTransaction commands must execute synchronously.');
    }
    transaction = { db: options.workspaceDb, execute: options.execute };
  }
  if (options.coreTransaction) {
    if (!options.coreDb) {
      throw new Error('coreTransaction requires an open Core database.');
    }
    if (Object.prototype.toString.call(options.execute) === '[object AsyncFunction]') {
      throw new Error('coreTransaction commands must execute synchronously.');
    }
    transaction = { db: options.coreDb, execute: options.execute };
  }

  const inputHash = commandInputHash(options.input);
  const commandDb = options.coreDb ?? options.workspaceDb;
  const existingRecord = options.store.getCommandRequest(
    options.command,
    options.requestId,
    options.scope,
    commandDb
  );

  if (existingRecord) {
    if (existingRecord.inputHash !== inputHash) {
      throw new IdempotencyKeyConflictError();
    }

    return options.replay(existingRecord);
  }

  const key = commandRequestKey(options.command, options.requestId, options.scope);
  let storeInflightCommands = options.inflightCommands.get(options.store);

  if (!storeInflightCommands) {
    storeInflightCommands = new Map<string, InflightIdempotentCommand>();
    options.inflightCommands.set(options.store, storeInflightCommands);
  }

  const existingInflight = storeInflightCommands.get(key);

  if (existingInflight) {
    if (existingInflight.inputHash !== inputHash) {
      throw new IdempotencyKeyConflictError();
    }

    return (await existingInflight.promise) as T;
  }

  /**
   * Records the receipt for one freshly executed command result.
   *
   * @param result Fresh command result whose resource pointer is recorded.
   * @returns The same result after its receipt is durable.
   */
  const recordResult = (result: T): T => {
    options.store.recordCommandRequest(
      {
        command: options.command,
        requestId: options.requestId,
        scope: options.scope,
        inputHash,
        response: {
          kind: options.responseKind,
          id: options.responseId(result),
          ...(options.chatResponseMetadata
            ? { chatMetadata: options.chatResponseMetadata(result) }
            : {}),
        },
      },
      commandDb
    );

    return result;
  };
  const promise = (async () => {
    if (transaction) {
      return transaction.db.sqlite.transaction(() => {
        const result = transaction.execute();

        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          throw new Error('Transactional commands must execute synchronously.');
        }

        return recordResult(result as T);
      })();
    }

    return recordResult(await options.execute());
  })();

  storeInflightCommands.set(key, { inputHash, promise });

  try {
    return await promise;
  } finally {
    if (storeInflightCommands.get(key)?.promise === promise) {
      storeInflightCommands.delete(key);
    }
  }
}

/**
 * Canonicalizes one value for stable hashing without storing raw command input.
 *
 * @param value Value to canonicalize.
 * @returns Stable JSON text.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`;
}

/**
 * Hashes command input for idempotency conflict detection.
 *
 * @param input Canonical command input.
 * @returns SHA-256-prefixed input hash.
 */
export function commandInputHash(input: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(input)).digest('hex')}`;
}

/**
 * Derives one Chat-subordinate Task Turn id without impersonating a direct Task command.
 *
 * @param actorId Authenticated actor id.
 * @param workspaceId Workspace command scope.
 * @param threadId Thread command scope.
 * @param requestId Caller-supplied Chat command request id.
 * @returns Stable Chat-subordinate worker Turn id.
 */
export function chatTaskModeTurnId(
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = commandInputHash({
    command: 'chat.start.task',
    actorId,
    workspaceId,
    threadId,
    requestId,
  }).slice(-16);
  return `turn_${requestId}_${suffix}`;
}
