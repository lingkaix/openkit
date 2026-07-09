import { createCoreClient } from '@openkit/core-client';

/**
 * Creates the browser client used by the SPA at runtime.
 */
export function createDefaultClient() {
  return createCoreClient({
    baseUrl: import.meta.env.VITE_CORE_URL ?? '',
    eventSource: EventSource,
  });
}
