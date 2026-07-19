import { ApiErrorSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { z } from 'zod';

import { KnowledgePageValidationError } from './knowledge/okf.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';

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

  if (error instanceof TurnStartValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  if (error instanceof KnowledgePageValidationError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asApiError((error as Error).message, code, status);
}

/**
 * Converts validation failures into a shared protocol API error response.
 *
 * @param error Validation error to expose as a product-safe message.
 * @param code Stable API error code.
 * @returns JSON API error response.
 */
export function asInvalidRequestError(error: unknown, code = 'invalid_request'): Response {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message;

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
