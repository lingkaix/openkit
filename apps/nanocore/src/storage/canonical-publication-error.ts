/** A published canonical reference whose parent directory commit was not acknowledged. */
export class CanonicalPublicationError extends Error {
  public readonly code = 'recovery_required';
  public readonly status = 409;

  /** Preserves the publication stage and original I/O failure without adding retained state. */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CanonicalPublicationError';
  }
}
