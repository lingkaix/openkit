/** Safe fields explicitly authored by the failure owner; causal failures remain private. */
export interface OperationErrorOptions extends ErrorOptions {
  readonly details?: unknown;
  readonly path?: string[];
}

/** The single transport-neutral classified operation failure; status conveys no retry or rollback promise. */
export class OperationError extends Error {
  readonly details: unknown;
  readonly path: string[] | undefined;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options: OperationErrorOptions = {}
  ) {
    super(message, options);
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new Error('OperationError requires an error semantic status.');
    this.name = 'OperationError';
    this.details = options.details;
    this.path = options.path;
  }
}
