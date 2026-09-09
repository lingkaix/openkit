/** Closed Kernel command failure codes owned by the initial contract. */
export type KernelErrorCode =
  | 'validation_failed'
  | 'conflict'
  | 'schema_stale'
  | 'not_found'
  | 'access_denied'
  | 'limit_exceeded'
  | 'unsupported_operation'
  | 'unavailable'
  | 'idempotency_key_conflict'
  | 'recovery_required';

/** Typed Kernel command failure with a stable protocol error code. */
export class KernelCommandError extends Error {
  /** Stable protocol API error code. */
  public readonly code: KernelErrorCode;
  /** HTTP status used by the App API projection. */
  public readonly status: number;
  /** Optional field or JSON path for validation failures. */
  public readonly path?: string;
  /** Optional limit name for limit_exceeded. */
  public readonly limit?: string;
  /** Optional numeric ceiling for limit_exceeded. */
  public readonly maximum?: number;

  /**
   * Creates one Kernel command failure.
   *
   * @param code Stable protocol error code.
   * @param message Product-safe error message.
   * @param details Optional validation or limit metadata.
   */
  public constructor(
    code: KernelErrorCode,
    message: string,
    details: { path?: string; limit?: string; maximum?: number; status?: number } = {}
  ) {
    super(message);
    this.name = 'KernelCommandError';
    this.code = code;
    if (details.path !== undefined) {
      this.path = details.path;
    }
    if (details.limit !== undefined) {
      this.limit = details.limit;
    }
    if (details.maximum !== undefined) {
      this.maximum = details.maximum;
    }
    this.status =
      details.status ??
      (
        {
          validation_failed: 400,
          conflict: 409,
          schema_stale: 409,
          not_found: 404,
          access_denied: 403,
          limit_exceeded: 400,
          unsupported_operation: 400,
          unavailable: 503,
          idempotency_key_conflict: 409,
          recovery_required: 409,
        } satisfies Record<KernelErrorCode, number>
      )[code];
  }
}
