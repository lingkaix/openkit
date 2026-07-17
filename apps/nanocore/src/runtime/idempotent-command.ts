import { createHash } from 'node:crypto';

import {
  type CommandRequestName,
  type CommandRequestRecord,
  type CommandRequestResponseKind,
  type CommandRequestScope,
  commandRequestKey,
  type FsStore,
} from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';

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

/** Options for executing one idempotent command. */
interface IdempotentCommandOptions<T> {
  /** Store that owns the idempotency ledger. */
  readonly store: FsStore;
  /** Optional open Workspace database for receipt-first reads and writes. */
  readonly workspaceDb?: WorkspaceDb;
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
  /** Captures an immutable public response when exact replay cannot use a mutable resource. */
  readonly responseSnapshot?: (result: T) => unknown;
  /** Executes the command when no duplicate exists. */
  readonly execute: () => Promise<T> | T;
  /** Replays the current resource snapshot for an existing ledger record. */
  readonly replay: (record: CommandRequestRecord) => Promise<T> | T;
  /** Extracts the response resource id from a fresh command result. */
  readonly responseId: (result: T) => string;
}

/**
 * Executes or replays one app-local idempotent command.
 *
 * @param options Command identity, input, ledger, execution, and replay behavior.
 * @returns Fresh or replayed command result.
 * @throws IdempotencyKeyConflictError when the same request id is reused with different input.
 */
export async function runIdempotentCommand<T>(options: IdempotentCommandOptions<T>): Promise<T> {
  const inputHash = commandInputHash(options.input);
  const existingRecord = options.store.getCommandRequest(
    options.command,
    options.requestId,
    options.scope,
    options.workspaceDb
  );

  if (existingRecord) {
    if (existingRecord.inputHash !== inputHash) {
      throw new IdempotencyKeyConflictError();
    }

    return options.replay(existingRecord);
  }

  const key = `${options.store.getUserId()}|${commandRequestKey(
    options.command,
    options.requestId,
    options.scope
  )}`;
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

  const promise = (async () => {
    const result = await options.execute();

    options.store.recordCommandRequest(
      {
        command: options.command,
        requestId: options.requestId,
        scope: options.scope,
        inputHash,
        response: {
          kind: options.responseKind,
          id: options.responseId(result),
          ...(options.responseSnapshot ? { snapshot: options.responseSnapshot(result) } : {}),
        },
      },
      options.workspaceDb
    );

    return result;
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
