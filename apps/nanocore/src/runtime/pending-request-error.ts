/** Closed failure raised by a pending-request command before any record write. */
export class PendingRequestCommandError extends Error {
  /** Stable API error code. */
  public readonly code: string;

  /** HTTP status for the command failure. */
  public readonly status: number;

  /**
   * Creates one command failure.
   *
   * @param code Stable API code.
   * @param message Product-safe message.
   * @param status HTTP status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'PendingRequestCommandError';
    this.code = code;
    this.status = status;
  }
}
