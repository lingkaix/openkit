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

/**
 * Builds a useful generic HTTP error message.
 *
 * @param response Fetch response that failed.
 * @param body Parsed response body.
 * @returns User-facing error message.
 */
function fallbackHttpErrorMessage(response: Response, body: unknown): string {
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }

  return `HTTP ${response.status}`;
}
