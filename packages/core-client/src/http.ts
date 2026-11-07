import { ApiErrorSchema } from '@openkit/protocol';
import type { z } from 'zod';

import { ApiCallError, ProtocolValidationError } from './errors.js';

/**
 * Minimal fetch-like signature used by the client.
 */
export type FetchLike = typeof globalThis.fetch;

/**
 * Parses one JSON response and validates successful payloads against a protocol schema.
 */
export async function parseJsonResponse<TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  const body = await parseResponseBody(response);

  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(body);

    if (parsedError.success) {
      throw new ApiCallError(response.status, parsedError.data.message, {
        code: parsedError.data.code,
        details: parsedError.data.details,
        ...(parsedError.data.path === undefined ? {} : { path: parsedError.data.path }),
        ...(parsedError.data.requestId === undefined
          ? {}
          : { requestId: parsedError.data.requestId }),
      });
    }

    throw new ApiCallError(response.status, fallbackHttpErrorMessage(response, body));
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ProtocolValidationError(
      first ?? {
        path: [],
        code: 'invalid_payload',
        message: 'Response payload failed protocol validation.',
      },
      { cause: parsed.error }
    );
  }

  return parsed.data;
}

/**
 * Parses a response body without assuming error responses are JSON.
 *
 * @param response Fetch response to read.
 * @returns Parsed JSON, raw text, or null for empty bodies.
 */
async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Today's incomplete server sign-up refusal. Better Auth sends it without a protocol envelope. */
const SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE = 'Server bootstrap is incomplete.';

/**
 * Builds a useful generic HTTP error message.
 *
 * The incomplete-bootstrap sentence is preserved so Web can reveal the bootstrap field.
 * Other non-protocol bodies stay a status line and are not echoed.
 *
 * @param response Fetch response that failed.
 * @param body Parsed response body.
 * @returns User-facing error message.
 */
function fallbackHttpErrorMessage(response: Response, body: unknown): string {
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }

  if (jsonMessage(body) === SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE) {
    return SERVER_BOOTSTRAP_INCOMPLETE_MESSAGE;
  }

  return `HTTP ${response.status}`;
}

/** Reads a JSON object's message when that field is a string. */
function jsonMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('message' in body)) return null;
  const message = body.message;
  return typeof message === 'string' ? message : null;
}
