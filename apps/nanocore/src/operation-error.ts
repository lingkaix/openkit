import Database from 'better-sqlite3';
import type { PiAiFailure } from './llm/pi-ai-failure.js';
import type { ControlCapabilityAdmissionFailure } from './storage/control-store-capability.js';
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

/**
 * Validation failure that can be returned to UI clients as a typed API error.
 */
export class TurnStartValidationError extends Error {
  /** Protocol API error code. */
  public readonly code: string;
  /** HTTP status for the validation failure. */
  public readonly status: number;

  /**
   * Creates a turn-start validation error.
   *
   * @param code Protocol API error code.
   * @param message User-facing error message.
   * @param status HTTP status code.
   */
  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TurnStartValidationError';
    this.code = code;
    this.status = status;
  }
}

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

/**
 * Error raised by worker control request validation.
 */
export class WorkerControlGatewayError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: string;
  /** HTTP status that routes should use when projecting this error. */
  public readonly status: number;

  /**
   * Creates a worker control gateway error.
   *
   * @param code Stable error code.
   * @param message Human-readable message.
   * @param status HTTP status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WorkerControlGatewayError';
    this.code = code;
    this.status = status;
  }
}

/** One failure projection; the original exception stays private and never supplies classification. */
export class GatewayAttemptFailure extends Error {
  /** Boundary-produced or owner-assigned failure evidence. */
  public readonly failure: PiAiFailure;
  /** Local member checks may advance but are never retried as reached Provider attempts. */
  public readonly beforeDispatch: boolean;
  /** Creates a typed private failure without inventing upstream status. */
  public constructor(failure: PiAiFailure, original?: unknown, beforeDispatch = false) {
    super('Provider attempt failed.', { cause: original });
    this.failure = failure;
    this.beforeDispatch = beforeDispatch;
  }
}

/** Uses the same trusted class boundary as existing operation error projection. */
export function projectControlCapabilityFailure(error: unknown) {
  const failure =
    error instanceof WorkerControlGatewayError ||
    error instanceof TurnStartValidationError ||
    error instanceof OperationError
      ? error
      : undefined;
  if (!failure) return undefined;
  const kind =
    failure instanceof WorkerControlGatewayError
      ? ('mcp' as const)
      : failure instanceof TurnStartValidationError
        ? ('turn' as const)
        : ('operation' as const);
  return { kind, code: failure.code, message: failure.message, status: failure.status };
}
/** Restores the same public owner class; arbitrary native exceptions have no projection. */
export function restoreControlCapabilityFailure(
  value: Exclude<ControlCapabilityAdmissionFailure, { kind: 'unknown' }>
): Error {
  if (value.kind === 'mcp')
    return new WorkerControlGatewayError(value.code, value.message, value.status);
  if (value.kind === 'turn')
    return new TurnStartValidationError(value.code, value.message, value.status);
  if (value.code === 'capability_request_reused')
    return new GatewayAttemptFailure({ kind: 'invalid_request', settled: true });
  return new OperationError(value.code, value.message, value.status);
}
