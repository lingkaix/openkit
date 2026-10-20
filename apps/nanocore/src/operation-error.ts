import Database from 'better-sqlite3';
import { ControlStoreWorkerError } from './storage/control-store-worker-client.js';

/** Safe fields explicitly authored by the failure owner; causal failures remain private. */
export interface OperationErrorOptions extends ErrorOptions {
  readonly details?: unknown;
  readonly path?: string[];
}

/** The single transport-neutral classified operation failure; status conveys no retry or rollback promise. */
export class OperationError extends Error {
  readonly details: unknown;
  readonly path: string[] | undefined;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options: OperationErrorOptions = {}
  ) {
    super(message, options);
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new Error('OperationError requires an error semantic status.');
    this.name = 'OperationError';
    this.details = options.details;
    this.path = options.path;
  }
}

/** Whitelists shared HTTP/MCP failure fields; only known native error classes can establish storage contention, never arbitrary thrown objects. */
export function projectOperationError(error: unknown) {
  const storageBusy =
    (error instanceof ControlStoreWorkerError && error.code === 'busy') ||
    (error instanceof Database.SqliteError && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error.code));
  // A lock refusal does not establish rollback across COMMIT or the worker reply gap.
  const failure = storageBusy
    ? new OperationError(
        'operation_storage_unavailable',
        'Storage is busy. Inspect the original request outcome before retrying.',
        503,
        { cause: error }
      )
    : error;
  if (!(failure instanceof OperationError)) return undefined;
  return {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...(failure.path === undefined ? {} : { path: failure.path }),
  };
}
