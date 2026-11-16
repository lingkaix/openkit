const CAPTURE_WAIT_MS = 20_000;

/** A startup capture fence: pre-effect, retryable, and limited to that operation. */
export function retryableCaptureFreeze(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('code' in body)) return false;
  if (body.code !== 'workspace_frozen') return false;
  const details = 'details' in body ? body.details : undefined;
  return (
    typeof details === 'object' &&
    details !== null &&
    'retryable' in details &&
    details.retryable === true &&
    'operation' in details &&
    details.operation === 'capture'
  );
}

/**
 * Resends one request while startup capture still refuses it.
 * The refusal is pre-effect, so the same request is safe to send again.
 */
export async function fetchWhenCaptureAllows(url: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + CAPTURE_WAIT_MS;
  for (;;) {
    const response = await fetch(url, init);
    if (response.status !== 409 || Date.now() >= deadline) return response;
    let retryable = false;
    try {
      retryable = retryableCaptureFreeze(await response.clone().json());
    } catch {
      retryable = false;
    }
    if (!retryable) return response;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
