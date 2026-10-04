import type { AppApiClient } from './app.js';
import { createAppApiClient } from './app.js';
import type { EmailAuthClient } from './auth.js';
import { createEmailAuthClient } from './auth.js';
import type { CapabilitiesClient } from './capabilities.js';
import { createCapabilitiesClient } from './capabilities.js';
import type { CoreProjectionClient } from './core.js';
import { createCoreProjectionClient } from './core.js';
import { createOperationClient, type OperationClient } from './operations.js';
import type { EventSourceConstructor } from './sse.js';
import { type ClientTransportOptions, createClientTransport } from './transport.js';

/** Options for creating the composed OpenKit client. */
export interface CreateCoreClientOptions extends ClientTransportOptions {
  /**
   * Optional constructor that selects EventSource for turn SSE while HTTP keeps the configured
   * fetch transport.
   */
  eventSource?: EventSourceConstructor;
}

/** Composed OpenKit client with protocol and App API surfaces separated by ownership. */
export interface CoreClient {
  /** Canonical operation methods generated from migrated definitions. */
  readonly operations: OperationClient;
  /** Stable Core protocol projection routes and turn event streams. */
  readonly core: CoreProjectionClient;
  /** NanoCore App API read models and app-local commands. */
  readonly app: AppApiClient;
  /** Browser authentication clients grouped by credential method. */
  readonly auth: {
    /** Better Auth email/password client. */
    readonly email: EmailAuthClient;
  };
  /** First-class capability discovery helper backed by `/api/meta`. */
  readonly capabilities: CapabilitiesClient;
}

/** Creates a composed OpenKit client from one shared HTTP/SSE transport. */
export function createCoreClient(options: CreateCoreClientOptions): CoreClient {
  const transport = createClientTransport(options);
  const core = createCoreProjectionClient(transport, options.eventSource);
  const app = createAppApiClient(transport);
  const email = createEmailAuthClient(transport);
  const capabilities = createCapabilitiesClient(core.meta);

  return {
    operations: createOperationClient(transport),
    app,
    auth: { email },
    capabilities,
    core,
  };
}
