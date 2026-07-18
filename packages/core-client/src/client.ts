import type { ActionCenterClient } from './action-center.js';
import { createActionCenterClient } from './action-center.js';
import type { AgentCatalogClient } from './agents.js';
import { createAgentCatalogClient } from './agents.js';
import type { AppApiClient } from './app.js';
import { createAppApiClient } from './app.js';
import type { EmailAuthClient } from './auth.js';
import { createEmailAuthClient } from './auth.js';
import type { CapabilitiesClient } from './capabilities.js';
import { createCapabilitiesClient } from './capabilities.js';
import type { CoreProjectionClient } from './core.js';
import { createCoreProjectionClient } from './core.js';
import type { OpenAICodexOAuthClient } from './oauth.js';
import { createOpenAICodexOAuthClient } from './oauth.js';
import type { WorkspaceRepositoryClient } from './repository.js';
import { createWorkspaceRepositoryClient } from './repository.js';
import type { RuntimeConfigClient } from './runtime-config.js';
import { createRuntimeConfigClient } from './runtime-config.js';
import type { EventSourceConstructor } from './sse.js';
import { type ClientTransportOptions, createClientTransport } from './transport.js';

/** Options for creating the composed OpenKit client. */
export interface CreateCoreClientOptions extends ClientTransportOptions {
  /** Optional EventSource constructor used by browser hosts that prefer EventSource SSE. */
  eventSource?: EventSourceConstructor;
}

/** Composed OpenKit client with protocol and App API surfaces separated by ownership. */
export interface CoreClient {
  /** Stable Core protocol projection routes and turn event streams. */
  readonly core: CoreProjectionClient;
  /** NanoCore App API read models and app-local commands. */
  readonly app: AppApiClient;
  /** Runtime config editor and reload routes. */
  readonly runtimeConfig: RuntimeConfigClient;
  /** OAuth account clients grouped by provider. */
  readonly oauth: {
    /** OpenAI Codex ChatGPT OAuth account client. */
    readonly openaiCodex: OpenAICodexOAuthClient;
  };
  /** Browser authentication clients grouped by credential method. */
  readonly auth: {
    /** Better Auth email/password client. */
    readonly email: EmailAuthClient;
  };
  /** First-class capability discovery helper backed by `/api/meta`. */
  readonly capabilities: CapabilitiesClient;
  /** Product-facing Agent Catalog read-model client. */
  readonly agents: AgentCatalogClient;
  /** Product-facing Action Center read-model client. */
  readonly actionCenter: ActionCenterClient;
  /** Product-facing workspace repository resource client. */
  readonly repositories: WorkspaceRepositoryClient;
}

/** Creates a composed OpenKit client from one shared HTTP/SSE transport. */
export function createCoreClient(options: CreateCoreClientOptions): CoreClient {
  const transport = createClientTransport(options);
  const core = createCoreProjectionClient(transport, options.eventSource);
  const app = createAppApiClient(transport);
  const runtimeConfig = createRuntimeConfigClient(transport);
  const openaiCodex = createOpenAICodexOAuthClient(transport);
  const email = createEmailAuthClient(transport);
  const capabilities = createCapabilitiesClient(core.meta);
  const agents = createAgentCatalogClient(transport);
  const actionCenter = createActionCenterClient(transport);
  const repositories = createWorkspaceRepositoryClient(transport);

  return {
    actionCenter,
    agents,
    app,
    auth: { email },
    capabilities,
    core,
    oauth: { openaiCodex },
    repositories,
    runtimeConfig,
  };
}
