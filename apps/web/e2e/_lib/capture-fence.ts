import { ApiCallError } from '@openkit/core-client';

/**
 * Startup snapshot maintenance fences the Workspace until mutable state is copied.
 * `workspace_frozen` is the documented retryable refusal and names no retry time.
 */
export async function whenCaptureFenceReleases<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 20_000;
  let refused: ApiCallError | undefined;
  while (Date.now() < deadline) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ApiCallError) || error.code !== 'workspace_frozen') throw error;
      refused = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw refused ?? new Error('Workspace capture fence did not release.');
}
