import type {
  WorkerCanonicalEventRecord,
  WorkerControlResponseEnvelope,
  WorkerLineage,
} from '@openkit/worker-protocol';

const WORKER_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimal fetch response surface used by the worker control client.
 */
export interface WorkerControlFetchResponse {
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
 * Minimal fetch function shape used by the worker control client.
 */
export type WorkerControlFetch = (
  url: string,
  init: {
    /** HTTP method. */
    method: 'POST';
    /** Request headers. */
    headers: Record<string, string>;
    /** Serialized JSON request body. */
    body: string;
    /** Optional supervisor cancellation signal. */
    signal?: AbortSignal | undefined;
  }
) => Promise<WorkerControlFetchResponse>;

/**
 * Worker control client construction options.
 */
export interface WorkerControlClientOptions {
  /** NanoCore worker-control route base URL. */
  baseUrl: string;
  /** Sandbox bearer token injected by NanoCore. */
  token: string;
  /** Lineage attached to every worker control request. */
  lineage: WorkerLineage;
  /** Optional fetch implementation for tests or alternate runtimes. */
  fetch?: WorkerControlFetch;
  /** Optional supervisor cancellation signal. */
  signal?: AbortSignal | undefined;
}

/**
 * Heartbeat request accepted by the worker control client.
 */
export interface WorkerControlHeartbeatInput {
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
 * Artifact notice request accepted by the worker control client.
 */
export interface WorkerControlArtifactInput {
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
export interface WorkerControlCommandPoll {
  /** Commands delivered to the worker. */
  commands: Array<Record<string, unknown>>;
  /** Optional server poll timestamp. */
  polledAt?: string;
}

/**
 * Terminal result request accepted by the worker control client.
 */
export interface WorkerControlTerminalResultInput {
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
 * Error raised when NanoCore rejects a worker control request.
 */
export class WorkerControlError extends Error {
  /** Stable upstream error code when provided. */
  public readonly code: string;
  /** HTTP response status. */
  public readonly status: number;

  /**
   * Creates a worker control error.
   *
   * @param code Stable error code.
   * @param status HTTP response status.
   * @param upstreamMessage Optional upstream message.
   */
  public constructor(code: string, status: number, upstreamMessage: string | null) {
    super(`Worker control request failed: ${code}`);
    this.name = 'WorkerControlError';
    this.code = code;
    this.status = status;
    this.cause = upstreamMessage ?? undefined;
  }
}

/**
 * HTTP control client used by sandbox-local worker shims to reach NanoCore control routes.
 */
export class WorkerControlClient {
  private readonly fetch: WorkerControlFetch;
  private readonly lineage: WorkerLineage;
  private readonly signal: AbortSignal | undefined;
  private readonly token: string;
  private readonly baseUrl: string;

  /**
   * Creates a worker control client.
   *
   * @param options Upstream URL, sandbox token, lineage, and optional fetch implementation.
   */
  public constructor(options: WorkerControlClientOptions) {
    this.fetch = options.fetch ?? defaultFetch();
    this.lineage = options.lineage;
    this.signal = options.signal;
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Sends a worker heartbeat to NanoCore.
   *
   * @param input Heartbeat payload.
   * @returns Parsed NanoCore response.
   */
  public async recordHeartbeat(input: WorkerControlHeartbeatInput): Promise<unknown> {
    return this.postJson('/heartbeat', input);
  }

  /**
   * Sends an artifact notice to NanoCore.
   *
   * @param input Artifact notice payload.
   * @returns Parsed NanoCore response.
   */
  public async recordArtifactNotice(input: WorkerControlArtifactInput): Promise<unknown> {
    return this.postJson('/artifacts', input);
  }

  /**
   * Polls NanoCore for pending worker commands.
   *
   * @returns Command poll response.
   */
  public async pollCommands(): Promise<WorkerControlCommandPoll> {
    return this.postJson<WorkerControlCommandPoll>('/commands/poll', {});
  }

  /**
   * Acknowledges one handled non-terminal worker command.
   *
   * @param commandId NanoCore-issued command id.
   * @returns Parsed NanoCore response.
   */
  public async acknowledgeCommand(commandId: string): Promise<unknown> {
    return this.postJson('/commands/ack', { commandId });
  }

  /**
   * Sends a terminal command result to NanoCore.
   *
   * @param input Terminal result payload.
   * @returns Parsed NanoCore response.
   */
  public async recordTerminalResult(input: WorkerControlTerminalResultInput): Promise<unknown> {
    return this.postJson('/terminal-results', input);
  }

  /**
   * Appends one canonical worker event to NanoCore.
   *
   * @param record Canonical event record emitted by the control.
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
    this.signal?.throwIfAborted();
    const requestController = new AbortController();
    let abortParent: (() => void) | null = null;
    const abortFailure = new Promise<never>((_resolve, reject) => {
      /** Rejects the in-flight request with the parent cancellation reason. */
      const abort = () => {
        const reason = abortSignalReason(this.signal);
        requestController.abort(reason);
        reject(reason);
      };
      abortParent = abort;

      if (this.signal?.aborted) {
        abort();
        return;
      }
      this.signal?.addEventListener('abort', abort, { once: true });
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Worker control request timed out.');
        requestController.abort(error);
        reject(error);
      }, WORKER_CONTROL_REQUEST_TIMEOUT_MS);
    });

    try {
      /** Performs the complete fetch and response-body read under one deadline. */
      const request = async () => {
        const response = await this.fetch(`${this.baseUrl}${path}`, {
          body: JSON.stringify({ ...body, lineage: this.lineage }),
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal: requestController.signal,
        });
        return { response, text: await response.text() };
      };
      const { response, text } = await Promise.race([request(), abortFailure, timeoutFailure]);
      const parsed = parseJson(text);

      if (!response.ok) {
        const code = readErrorCode(parsed, response.status);
        const message =
          parsed && typeof parsed === 'object' && 'message' in parsed
            ? String((parsed as { message?: unknown }).message ?? '')
            : null;

        throw new WorkerControlError(code, response.status, message);
      }

      return parsed as T;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortParent) {
        this.signal?.removeEventListener('abort', abortParent);
      }
    }
  }
}

/**
 * Resolves a stable rejection reason for one aborted control request.
 *
 * @param signal Optional parent signal.
 * @returns Parent reason or a standard abort error.
 */
function abortSignalReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Reads global fetch while preserving a narrow local type.
 *
 * @returns Fetch function.
 * @throws Error when fetch is unavailable.
 */
function defaultFetch(): WorkerControlFetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch;

  if (typeof candidate !== 'function') {
    throw new Error('Worker control requires a fetch implementation.');
  }

  return candidate as WorkerControlFetch;
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
