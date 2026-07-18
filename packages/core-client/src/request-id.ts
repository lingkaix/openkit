/** Creates a UUID request id for mutating Core commands. */
export function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) =>
    (Number(digit) ^ ((Math.random() * 16) >> (Number(digit) / 4))).toString(16)
  );
}

/** Adds a request id to a mutating command if the caller did not provide one. */
export function withRequestId<T extends { requestId?: string }>(
  input: T
): T & { requestId: string } {
  return { ...input, requestId: input.requestId ?? createRequestId() };
}

/** Mutating command input with optional caller-provided request id. */
export type OptionalRequestId<T extends { requestId: string }> = T extends unknown
  ? Omit<T, 'requestId'> & { requestId?: string }
  : never;
