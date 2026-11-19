/** Retry marker fields authored by the authorized Workspace capture gate. */
export const CAPTURE_RETRY_AFTER_HEADER = 'Retry-After';
export const CAPTURE_RETRY_CONTEXT_HEADER = 'x-openkit-retry-context';

/** A replayable HTTP request has pre-serialized JSON bytes or an empty body. */
export type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: string };

/** Waits only behind a definite admission refusal. */
async function waitForCaptureRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Keeps the wire retry in one place while callers supply their refusal response reader. */
export async function fetchWithCaptureRetry(
  url: string,
  init: JsonRequestInit,
  options: {
    fetch: typeof globalThis.fetch;
    signal: AbortSignal;
    confirmRefusal: (response: Response) => Promise<boolean>;
  }
): Promise<Response> {
  const { fetch: fetcher, signal, confirmRefusal } = options;
  const request = { ...init };
  const headers = new Headers(request.headers);
  const deadline = performance.now() + 20_000;
  let lastRefusal: Response | undefined;
  for (;;) {
    signal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (lastRefusal && remaining <= 0) return lastRefusal;
    // A timeout after resend is an unknown response, not the prior definite refusal.
    const attemptSignal = lastRefusal
      ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))])
      : signal;
    const response = await fetcher(url, {
      ...request,
      headers: new Headers(headers),
      signal: attemptSignal,
    });
    const context = response.headers.get(CAPTURE_RETRY_CONTEXT_HEADER);
    if (
      response.status !== 409 ||
      response.headers.get(CAPTURE_RETRY_AFTER_HEADER) !== '1' ||
      !context ||
      !/^[a-f0-9]{64}$/.test(context) ||
      (headers.has(CAPTURE_RETRY_CONTEXT_HEADER) &&
        headers.get(CAPTURE_RETRY_CONTEXT_HEADER) !== context)
    )
      return response;
    let refusal: Response;
    try {
      // Preserve a readable refusal if cancellation finishes after the retry window.
      refusal = response.clone();
      if (!(await confirmRefusal(response.clone()))) return response;
    } catch {
      return response;
    }
    signal.throwIfAborted();
    const wait = Math.min(1_000, deadline - performance.now());
    if (wait <= 0) return refusal;
    await waitForCaptureRetry(wait, signal);
    if (performance.now() >= deadline) return refusal;
    await response.body?.cancel();
    headers.set(CAPTURE_RETRY_CONTEXT_HEADER, context);
    lastRefusal = refusal;
  }
}
