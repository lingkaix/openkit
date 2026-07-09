import type { WorkerLineage } from '@openkit/worker-protocol';

/**
 * Minimal fetch response surface used by the worker capability client.
 */
export interface WorkerCapabilityFetchResponse {
  /** Whether the HTTP response was successful. */
  ok: boolean;
  /** HTTP response status. */
  status: number;
  /**
   * Reads the response body as text.
   *
   * @returns Response body text.
   */
  text(): Promise<string>;
}

/**
 * Minimal fetch function shape used by the worker capability client.
 */
export type WorkerCapabilityFetch = (
  url: string,
  init: {
    /** HTTP method. */
    method: 'POST';
    /** Request headers. */
    headers: Record<string, string>;
    /** Serialized JSON request body. */
    body: string;
  }
) => Promise<WorkerCapabilityFetchResponse>;

/**
 * Worker capability client construction options.
 */
export interface WorkerCapabilityClientOptions {
  /** Worker-visible capability endpoint base URL. */
  baseUrl: string;
  /** Sandbox bearer token injected by NanoCore. */
  token: string;
  /** Lineage attached to every worker capability request. */
  lineage: WorkerLineage;
  /** Optional fetch implementation for tests or alternate runtimes. */
  fetch?: WorkerCapabilityFetch;
}

/**
 * Knowledge search request accepted by the worker capability client.
 */
export interface WorkerCapabilityKnowledgeSearchInput {
  /** Search query. */
  query: string;
  /** Optional maximum number of results to return. */
  limit?: number | undefined;
}

/**
 * Knowledge read request accepted by the worker capability client.
 */
export interface WorkerCapabilityKnowledgeReadInput {
  /** Knowledge entry id to read. */
  knowledgeEntryId: string;
}

/**
 * Knowledge proposal request accepted by the worker capability client.
 */
export interface WorkerCapabilityKnowledgeProposalInput {
  /** Draft title. */
  title: string;
  /** Draft summary. */
  summary: string;
  /** Source references supporting the proposal. */
  sourceReferences?: string[] | undefined;
  /** Draft confidence from 0 to 1. */
  confidence?: number | undefined;
}

/**
 * Artifact read request accepted by the worker capability client.
 */
export interface WorkerCapabilityArtifactReadInput {
  /** Artifact id to read. */
  artifactId: string;
}

/**
 * MCP tool-list request accepted by the worker capability client.
 */
export interface WorkerCapabilityMcpListToolsInput {
  /** MCP server id from the resolved Agent Environment Package. */
  serverId: string;
}

/**
 * MCP tool-call request accepted by the worker capability client.
 */
export interface WorkerCapabilityMcpCallToolInput {
  /** Granted approval request id allowing this MCP tool call. */
  approvalRequestId?: string | undefined;
  /** Immutable policy decision id allowing this MCP tool call. */
  policyDecisionId?: string | undefined;
  /** MCP server id from the resolved Agent Environment Package. */
  serverId: string;
  /** MCP tool name enabled for this worker session. */
  toolName: string;
  /** JSON object arguments sent to the MCP gateway. */
  arguments?: Record<string, unknown> | undefined;
}

/**
 * Error raised when NanoCore rejects a worker capability request.
 */
export class WorkerCapabilityError extends Error {
  /** Stable upstream error code when provided. */
  public readonly code: string;
  /** HTTP response status. */
  public readonly status: number;

  /**
   * Creates a worker capability error.
   *
   * @param code Stable error code.
   * @param status HTTP response status.
   * @param upstreamMessage Optional upstream message.
   */
  public constructor(code: string, status: number, upstreamMessage: string | null) {
    super(`Worker capability request failed: ${code}`);
    this.name = 'WorkerCapabilityError';
    this.code = code;
    this.status = status;
    this.cause = upstreamMessage ?? undefined;
  }
}

/**
 * HTTP client used by sandbox-local worker shims to reach NanoCore capability routes.
 */
export class WorkerCapabilityClient {
  private readonly baseUrl: string;
  private readonly fetch: WorkerCapabilityFetch;
  private readonly lineage: WorkerLineage;
  private readonly token: string;

  /**
   * Creates a worker capability client.
   *
   * @param options Base URL, sandbox token, lineage, and optional fetch implementation.
   */
  public constructor(options: WorkerCapabilityClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? defaultFetch();
    this.lineage = options.lineage;
    this.token = options.token;
  }

  /**
   * Searches governed workspace knowledge.
   *
   * @param input Knowledge search input.
   * @returns Parsed NanoCore response.
   */
  public async searchKnowledge(input: WorkerCapabilityKnowledgeSearchInput): Promise<unknown> {
    return this.postJson('/knowledge/search', input);
  }

  /**
   * Reads one governed workspace knowledge entry.
   *
   * @param input Knowledge read input.
   * @returns Parsed NanoCore response.
   */
  public async readKnowledge(input: WorkerCapabilityKnowledgeReadInput): Promise<unknown> {
    return this.postJson('/knowledge/read', input);
  }

  /**
   * Drafts one review-required knowledge proposal.
   *
   * @param input Knowledge proposal input.
   * @returns Parsed NanoCore response.
   */
  public async proposeKnowledge(input: WorkerCapabilityKnowledgeProposalInput): Promise<unknown> {
    return this.postJson('/knowledge/proposals', input);
  }

  /**
   * Reads one governed workspace artifact.
   *
   * @param input Artifact read input.
   * @returns Parsed NanoCore response.
   */
  public async readArtifact(input: WorkerCapabilityArtifactReadInput): Promise<unknown> {
    return this.postJson('/artifacts/read', input);
  }

  /**
   * Lists MCP servers visible to this worker session.
   *
   * @returns Parsed NanoCore response.
   */
  public async listMcpServers(): Promise<unknown> {
    return this.postJson('/mcp/list-servers', {});
  }

  /**
   * Lists MCP tools for one worker-visible server.
   *
   * @param input MCP tool-list input.
   * @returns Parsed NanoCore response.
   */
  public async listMcpTools(input: WorkerCapabilityMcpListToolsInput): Promise<unknown> {
    return this.postJson('/mcp/list-tools', input);
  }

  /**
   * Calls one MCP tool through NanoCore's governed capability gateway.
   *
   * @param input MCP tool-call input.
   * @returns Parsed NanoCore response.
   */
  public async callMcpTool(input: WorkerCapabilityMcpCallToolInput): Promise<unknown> {
    return this.postJson('/mcp/call-tool', input);
  }

  /**
   * Reads product-safe diagnostics for the current worker session.
   *
   * @returns Parsed NanoCore response.
   */
  public async readDiagnostics(): Promise<unknown> {
    return this.postJson('/diagnostics/read', {});
  }

  /**
   * Sends one JSON request to the worker capability route.
   *
   * @param path Route path under the capability base URL.
   * @param body Request body without lineage.
   * @returns Parsed JSON response.
   */
  private async postJson<T = unknown>(path: string, body: object): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      body: JSON.stringify({ ...body, lineage: this.lineage }),
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      const code = readErrorCode(parsed, response.status);
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message?: unknown }).message ?? '')
          : null;

      throw new WorkerCapabilityError(code, response.status, message);
    }

    return parsed as T;
  }
}

/**
 * Reads global fetch while preserving a narrow local type.
 *
 * @returns Fetch function.
 * @throws Error when fetch is unavailable.
 */
function defaultFetch(): WorkerCapabilityFetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch;

  if (typeof candidate !== 'function') {
    throw new Error('Worker capability client requires a fetch implementation.');
  }

  return candidate as WorkerCapabilityFetch;
}

/**
 * Parses a JSON response body.
 *
 * @param text Response text.
 * @returns Parsed JSON value, or null for empty bodies.
 */
function parseJson(text: string): unknown {
  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text) as unknown;
}

/**
 * Reads a stable error code from a response body.
 *
 * @param parsed Parsed response body.
 * @param status HTTP response status.
 * @returns Stable error code.
 */
function readErrorCode(parsed: unknown, status: number): string {
  if (parsed && typeof parsed === 'object' && 'code' in parsed) {
    const code = (parsed as { code?: unknown }).code;

    if (typeof code === 'string' && code.trim()) {
      return code;
    }
  }

  return `http_${status}`;
}
