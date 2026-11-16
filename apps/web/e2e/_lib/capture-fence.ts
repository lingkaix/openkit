import { ApiCallError, type CoreClient } from '@openkit/core-client';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const CAPTURE_WAIT_MS = 20_000;

function retryableCapture(details: unknown): boolean {
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
 * Resends one raw import while startup capture still refuses it.
 * The transport does not replay request streams, and this refusal is pre-effect.
 */
export async function importRetainedArtifact(
  client: CoreClient,
  input: Parameters<CoreClient['artifactFiles']['import']>[0],
  bytes: Blob
): Promise<{ artifactId: string; artifactVersion: 1 }> {
  const deadline = performance.now() + CAPTURE_WAIT_MS;
  for (;;) {
    try {
      return await client.artifactFiles.import(input, bytes);
    } catch (error) {
      const details =
        error instanceof ApiCallError && error.status === 409 && error.code === 'workspace_frozen'
          ? error.details
          : undefined;
      if (!retryableCapture(details) || performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Resends one direct POST while startup capture still refuses it before any effect.
 * Playwright's request API does not use the core-client capture retry.
 */
export async function postWhenCaptureAllows(
  request: APIRequestContext,
  url: string,
  options: { headers?: Record<string, string>; data: unknown }
): Promise<APIResponse> {
  const deadline = Date.now() + CAPTURE_WAIT_MS;
  for (;;) {
    const response = await request.post(url, options);
    if (response.status() !== 409 || Date.now() >= deadline) return response;
    let retryable = false;
    try {
      const parsed = JSON.parse(await response.text()) as {
        code?: string;
        details?: unknown;
      };
      retryable = parsed.code === 'workspace_frozen' && retryableCapture(parsed.details);
    } catch {
      retryable = false;
    }
    if (!retryable) return response;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
