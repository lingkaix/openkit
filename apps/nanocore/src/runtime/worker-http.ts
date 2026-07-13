import { Buffer } from 'node:buffer';

import type { Context } from 'hono';
import { z } from 'zod';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import { WorkerControlGatewayError } from './worker-control-gateway.js';

export const WorkerControlLineageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  agentSessionId: z.string().min(1),
  packageSnapshotId: z.string().min(1),
  requestId: z.string().min(1).nullable().optional(),
});

/** Result of parsing one bounded JSON request. */
export type ParsedJsonRequest<T> =
  | {
      readonly data: T;
      readonly success: true;
    }
  | {
      readonly response: Response;
      readonly success: false;
    };

/**
 * Converts worker control gateway failures into stable protocol API errors.
 *
 * @param error Worker route error.
 * @returns Stable worker API error response.
 */
export function asWorkerControlApiError(error: unknown): Response {
  if (error instanceof WorkerControlGatewayError) {
    return asApiError(error.message, error.code, error.status);
  }

  return asApiError('Worker request failed.', 'worker_internal_error', 500);
}

/**
 * Parses one bounded JSON request body against a schema.
 *
 * @param c Hono request context.
 * @param schema Schema used to validate the parsed JSON body.
 * @param maxBytes Maximum accepted UTF-8 request body byte length.
 * @param label Human-readable payload label for diagnostics.
 * @param codes Stable error codes for oversized and invalid payloads.
 * @returns Parsed request data, or an error response.
 */
export async function parseBoundedJsonRequest<T>(
  c: Context,
  schema: z.ZodType<T>,
  maxBytes: number,
  label: string,
  codes: { readonly invalid: string; readonly oversized: string } = {
    invalid: 'invalid_request',
    oversized: 'worker_control_payload_too_large',
  }
): Promise<ParsedJsonRequest<T>> {
  const raw = await c.req.text().catch(() => '');

  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return {
      response: asApiError(`${label} exceeds ${maxBytes} bytes.`, codes.oversized, 413),
      success: false,
    };
  }

  let body: unknown = {};

  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return { response: asInvalidRequestError(parsed.error, codes.invalid), success: false };
  }

  return { data: parsed.data, success: true };
}
