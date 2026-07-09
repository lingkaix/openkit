import type {
  WorkerCanonicalEventRecord,
  WorkerControlResponseEnvelope,
  WorkerLineage,
} from '@openkit/worker-protocol';

/**
 * Minimal fetch response surface used by the worker control relay client.
 */
export interface WorkerControlRelayFetchResponse {
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
 * Minimal fetch function shape used by the worker control relay client.
 */
export type WorkerControlRelayFetch = (
  url: string,
  init: {
    /** HTTP method. */
    method: 'POST';
    /** Request headers. */
    headers: Record<string, string>;
    /** Serialized JSON request body. */
    body: string;
  }
) => Promise<WorkerControlRelayFetchResponse>;

/**
 * Worker control relay client construction options.
 */
export interface WorkerControlRelayClientOptions {
  /** NanoCore worker-control route base URL. */
  upstreamBaseUrl: string;
  /** Sandbox bearer token injected by NanoCore. */
  token: string;
  /** Lineage attached to every worker control request. */
  lineage: WorkerLineage;
  /** Optional fetch implementation for tests or alternate runtimes. */
  fetch?: WorkerControlRelayFetch;
}

/**
 * Heartbeat request accepted by the worker control relay client.
 */
export interface WorkerControlRelayHeartbeatInput {
  /** Worker sequence number. */
  sequence: number;
  /** Worker lifecycle status. */
  status:
    | 'starting'
    | 'running'
    | 'idle'
    | 'awaiting_command'
    | 'stopping'
    | 'completed'
    | 'failed';
  /** Optional worker status message. */
  message?: string | null | undefined;
}

/**
 * Artifact notice request accepted by the worker control relay client.
 */
export interface WorkerControlRelayArtifactInput {
  /** Worker sequence number. */
  sequence: number;
  /** Artifact candidate. */
  artifact: {
    /** Artifact title. */
    title: string;
    /** Worker-local artifact path. */
    path: string;
    /** Optional media type. */
    mediaType?: string | null | undefined;
  };
}

/**
 * Command poll response returned by NanoCore.
 */
export interface WorkerControlRelayCommandPoll {
  /** Commands delivered to the worker. */
  commands: Array<Record<string, unknown>>;
  /** Optional server poll timestamp. */
  polledAt?: string;
}

/**
 * Terminal result request accepted by the worker control relay client.
 */
export interface WorkerControlRelayTerminalResultInput {
  /** Terminal command id. */
  terminalCommandId: string;
  /** Process exit code. */
  exitCode: number;
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
  /** Optional command duration. */
  durationMs?: number | null | undefined;
}

/**
 * Error raised when NanoCore rejects a worker control relay request.
 */
export class WorkerControlRelayError extends Error {
  /** Stable upstream error code when provided. */
  public readonly code: string;
  /** HTTP response status. */
  public readonly status: number;

  /**
   * Creates a worker control relay error.
   *
   * @param code Stable error code.
   * @param status HTTP response status.
   * @param upstreamMessage Optional upstream message.
   */
  public constructor(code: string, status: number, upstreamMessage: string | null) {
    super(`Worker control relay request failed: ${code}`);
    this.name = 'WorkerControlRelayError';
    this.code = code;
    this.status = status;
    this.cause = upstreamMessage ?? undefined;
  }
}

/**
 * HTTP relay client used by sandbox-local worker shims to reach NanoCore control routes.
 */
export class WorkerControlRelayClient {
  private readonly fetch: WorkerControlRelayFetch;
  private readonly lineage: WorkerLineage;
  private readonly token: string;
  private readonly upstreamBaseUrl: string;

  /**
   * Creates a worker control relay client.
   *
   * @param options Upstream URL, sandbox token, lineage, and optional fetch implementation.
   */
  public constructor(options: WorkerControlRelayClientOptions) {
    this.fetch = options.fetch ?? defaultFetch();
    this.lineage = options.lineage;
    this.token = options.token;
    this.upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Sends a worker heartbeat to NanoCore.
   *
   * @param input Heartbeat payload.
   * @returns Parsed NanoCore response.
   */
  public async recordHeartbeat(input: WorkerControlRelayHeartbeatInput): Promise<unknown> {
    return this.postJson('/heartbeat', input);
  }

  /**
   * Sends an artifact notice to NanoCore.
   *
   * @param input Artifact notice payload.
   * @returns Parsed NanoCore response.
   */
  public async recordArtifactNotice(input: WorkerControlRelayArtifactInput): Promise<unknown> {
    return this.postJson('/artifacts', input);
  }

  /**
   * Polls NanoCore for pending worker commands.
   *
   * @returns Command poll response.
   */
  public async pollCommands(): Promise<WorkerControlRelayCommandPoll> {
    return this.postJson<WorkerControlRelayCommandPoll>('/commands/poll', {});
  }

  /**
   * Sends a terminal command result to NanoCore.
   *
   * @param input Terminal result payload.
   * @returns Parsed NanoCore response.
   */
  public async recordTerminalResult(
    input: WorkerControlRelayTerminalResultInput
  ): Promise<unknown> {
    return this.postJson('/terminal-results', input);
  }

  /**
   * Appends one canonical worker event to NanoCore.
   *
   * @param record Canonical event record emitted by the sidecar.
   * @returns Parsed worker-control response envelope.
   */
  public async appendEvent(
    record: WorkerCanonicalEventRecord
  ): Promise<WorkerControlResponseEnvelope> {
    return this.postJson<WorkerControlResponseEnvelope>('/events/append', { record });
  }

  /**
   * Sends one JSON request to the worker control route.
   *
   * @param path Route path under the upstream base URL.
   * @param body Request body without lineage.
   * @returns Parsed JSON response.
   */
  private async postJson<T = unknown>(path: string, body: object): Promise<T> {
    const response = await this.fetch(`${this.upstreamBaseUrl}${path}`, {
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

      throw new WorkerControlRelayError(code, response.status, message);
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
function defaultFetch(): WorkerControlRelayFetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch;

  if (typeof candidate !== 'function') {
    throw new Error('Worker control relay requires a fetch implementation.');
  }

  return candidate as WorkerControlRelayFetch;
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
