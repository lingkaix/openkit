import { publishedErrorMessage } from './api-errors.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { PendingRequestCommandError } from './runtime/pending-requests.js';

/** Transport-neutral projection of the former Core command and read error envelopes. */
export class CoreCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'CoreCommandError';
  }
}

/** Keeps typed owner refusals and the command's existing fallback; this is no retry or repair owner. */
export function throwCoreCommandError(error: unknown, code: string): never {
  // Normalize these owner errors for native invocation so HTTP and MCP preserve their original refusals.
  if (error instanceof KnowledgePageValidationError || error instanceof KernelCommandError)
    throw new CoreCommandError(error.code, error.message, error.status);
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof TurnStartValidationError ||
    error instanceof PendingRequestCommandError ||
    error instanceof CoreCommandError
  )
    throw error;
  throw new CoreCommandError(code, publishedErrorMessage(error), 404);
}
