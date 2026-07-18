import type { z } from 'zod';

/**
 * Minimal validation issue shape surfaced by protocol validation errors.
 */
export interface ProtocolValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly message: string;
}

/**
 * Thrown when a server payload fails validation against @openkit/protocol.
 */
export class ProtocolValidationError extends Error {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;

  /**
   * Creates a protocol validation error from the first Zod issue.
   */
  constructor(issue: ProtocolValidationIssue | z.core.$ZodIssue, opts?: { cause?: unknown }) {
    super(issue.message, opts);
    this.name = 'ProtocolValidationError';
    this.path = issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part));
    this.code = issue.code;
  }
}

/**
 * Thrown when the core API returns a non-2xx HTTP response.
 */
export class ApiCallError extends Error {
  /** HTTP response status. */
  readonly status: number;
  /** Machine-readable server error code when available. */
  readonly code: string | null;
  /** Optional structured server error details. */
  readonly details: unknown;
  /** Optional server-reported input path. */
  readonly path: ReadonlyArray<string> | undefined;
  /** Optional server request correlation id. */
  readonly requestId: string | undefined;

  /**
   * Creates an API call error from HTTP status and optional API error details.
   *
   * @param status HTTP response status.
   * @param message Server-provided or fallback error message.
   * @param opts Optional machine-readable API error fields and cause.
   */
  constructor(
    status: number,
    message: string,
    opts?: {
      code?: string;
      cause?: unknown;
      details?: unknown;
      path?: ReadonlyArray<string>;
      requestId?: string;
    }
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'ApiCallError';
    this.status = status;
    this.code = opts?.code ?? null;
    this.details = opts?.details;
    this.path = opts?.path;
    this.requestId = opts?.requestId;
  }
}
