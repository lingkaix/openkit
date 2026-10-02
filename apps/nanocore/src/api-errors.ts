import { ApiErrorSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { z } from 'zod';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { PendingRequestCommandError } from './runtime/pending-requests.js';

/**
 * Creates a protocol-stamped API error response.
 *
 * @param message Product-safe error message.
 * @param code Stable error code.
 * @param status HTTP response status.
 * @returns JSON API error response.
 */
export function asApiError(message: string, code = 'not_found', status = 404): Response {
  return Response.json(apiErrorPayload({ code, message }), { status });
}

/**
 * Bounds decoder text before it enters protocol responses or durable failure projections.
 * Parser and schema errors can quote retained input, including through causes and cleanup aggregates whose own message already embeds the primary error.
 * Inspect the whole tree before choosing a message, and tolerate cyclic cause links without changing authored text.
 *
 * @param error Failure whose message is about to be published.
 * @param fallback Existing caller fallback for a non-Error value; defaults to its prior message projection.
 * @returns Fixed readable text for quoting exceptions, otherwise the authored message or fallback.
 */
export function publishedErrorMessage(error: unknown, fallback?: string): string {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof SyntaxError || current instanceof z.ZodError) {
      return 'The retained record could not be read.';
    }
    if (typeof current !== 'object' || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if ('cause' in current) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return error instanceof Error ? error.message : (fallback ?? (error as Error)?.message);
}

/**
 * Converts command-specific errors into stable protocol API errors.
 *
 * @param error Command error.
 * @param code Fallback error code.
 * @param status Fallback HTTP response status.
 * @returns JSON API error response.
 */
export function asCommandError(error: unknown, code: string, status = 404): Response {
  if (error instanceof IdempotencyKeyConflictError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof KernelCommandError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof TurnStartValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof KnowledgePageValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof PendingRequestCommandError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asApiError(publishedErrorMessage(error), code, status);
}

/**
 * Converts validation failures into a shared protocol API error response.
 *
 * @param error Validation error or string to expose as a product-safe message.
 * @param code Stable API error code.
 * @returns JSON API error response.
 */
export function asInvalidRequestError(error: unknown, code = 'invalid_request'): Response {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof z.ZodError
        ? z.prettifyError(error)
        : (error as Error).message;

  return asApiError(message, code, 400);
}

/**
 * Creates a protocol-stamped API error payload.
 *
 * @param input API error fields other than the protocol version.
 * @returns Validated protocol API error.
 */
export function apiErrorPayload(
  input: Omit<z.input<typeof ApiErrorSchema>, 'protocolVersion'>
): z.output<typeof ApiErrorSchema> {
  return ApiErrorSchema.parse({ protocolVersion: PROTOCOL_VERSION, ...input });
}
