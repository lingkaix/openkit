const inflight = new Map<string, Set<AbortController>>();

/** Remembers one title fetch so disabling that endpoint aborts it. */
export function trackLocalTitleAbort(baseUrl: string, controller: AbortController): () => void {
  const calls = inflight.get(baseUrl) ?? new Set();
  calls.add(controller);
  inflight.set(baseUrl, calls);
  return () => {
    calls.delete(controller);
    if (calls.size === 0) inflight.delete(baseUrl);
  };
}

/** Aborts title fetches on one local endpoint. The reason is not a deadline. */
export function abortLocalTitleCalls(baseUrl: string): void {
  const calls = inflight.get(baseUrl);
  if (!calls) return;
  inflight.delete(baseUrl);
  for (const controller of calls) {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The local model was disabled.', 'AbortError'));
    }
  }
}
