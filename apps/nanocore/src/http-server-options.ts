import type { ServerOptions } from 'node:http';

/**
 * Shared App HTTP/HTTPS receive deadlines and idle connection policy.
 * Five minutes covers Chromium's used idle socket window for direct Web connections.
 * Node's additional one-minute socket buffer keeps even clients following that hint well ahead of the six-minute idle close during stalls.
 * Header and request receipt retain Node 24's defaults; neither limits active responses.
 */
export const NANOCORE_HTTP_SERVER_OPTIONS = {
  keepAliveTimeout: 300_000,
  keepAliveTimeoutBuffer: 60_000,
  headersTimeout: 60_000,
  requestTimeout: 300_000,
} as const satisfies ServerOptions;
