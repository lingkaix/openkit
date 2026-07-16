import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type WorkerCanonicalEventRecord,
  type WorkerCanonicalTerminalEventDataInput,
  WorkerCanonicalTerminalEventDataSchema,
  type WorkerControlResponseEnvelope,
  WorkerControlResponseEnvelopeSchema,
  type WorkerLineage,
} from '@openkit/worker-protocol';

const WORKER_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const WORKER_CONTROL_OUTAGE_BUDGET_MS = 300_000;
const WORKER_CONTROL_RETRY_DELAY_MS = 250;

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
 * Final bounded-step status reported by the worker control client.
 */
export interface WorkerControlFinalStatusInput extends WorkerCanonicalTerminalEventDataInput {
  /** Final transcript sequence for the bounded worker step. */
  sequence: number;
  /** Worker-local bounded-step outcome. */
  status: 'blocked' | 'cancelled' | 'completed' | 'degraded' | 'failed' | 'interrupted' | 'lost';
  /** Product-safe reason the worker stopped. */
  stopReason: string;
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
  private nextHeartbeatSequence = 0;
  private outageStartedAt: number | null = null;
  private postLaunchRecoveryEnabled = false;
  private readonly processKey: string;
  private reconnecting: Promise<unknown> | null = null;
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
    this.processKey = randomBytes(32).toString('base64url');
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Enables bounded retry only after the supervised task has launched. */
  public enablePostLaunchRecovery(): void {
    this.postLaunchRecoveryEnabled = true;
  }

  /** Disables retry when the supervisor is already terminating the task. */
  public disablePostLaunchRecovery(): void {
    this.postLaunchRecoveryEnabled = false;
  }

  /**
   * Sends a worker heartbeat to NanoCore.
   *
   * @param input Heartbeat payload.
   * @returns Parsed NanoCore response.
   */
  public async recordHeartbeat(
    input: Omit<WorkerControlHeartbeatInput, 'sequence'>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const result = await this.sendSequencedHeartbeat(input, signal);

    this.clearOutage();
    return result;
  }

  /**
   * Sends an artifact notice to NanoCore.
   *
   * @param input Artifact notice payload.
   * @returns Parsed NanoCore response.
   */
  public async recordArtifactNotice(
    input: WorkerControlArtifactInput,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.request(() => this.postJson('/artifacts', input, signal), signal);
  }

  /**
   * Polls NanoCore for pending worker commands.
   *
   * @returns Command poll response.
   */
  public async pollCommands(signal?: AbortSignal): Promise<WorkerControlCommandPoll> {
    return this.request(
      () => this.postJson<WorkerControlCommandPoll>('/commands/poll', {}, signal),
      signal
    );
  }

  /**
   * Acknowledges one handled non-terminal worker command.
   *
   * @param commandId NanoCore-issued command id.
   * @returns Parsed NanoCore response.
   */
  public async acknowledgeCommand(commandId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(() => this.postJson('/commands/ack', { commandId }, signal), signal);
  }

  /**
   * Sends a terminal command result to NanoCore.
   *
   * @param input Terminal result payload.
   * @returns Parsed NanoCore response.
   */
  public async recordTerminalResult(
    input: WorkerControlTerminalResultInput,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.request(() => this.postJson('/terminal-results', input, signal), signal);
  }

  /**
   * Reports the final bounded-step status to NanoCore.
   *
   * @param input Terminal sequence, outcome, and stop reason.
   * @returns Parsed worker-control response envelope.
   */
  public async recordFinalStatus(
    input: WorkerControlFinalStatusInput,
    signal?: AbortSignal
  ): Promise<WorkerControlResponseEnvelope> {
    const { sequence, ...terminalData } = input;
    const envelope = {
      body: WorkerCanonicalTerminalEventDataSchema.parse(terminalData),
      operation: 'final_status',
      schemaVersion: 1,
      sequence,
    };

    return this.request(
      async () =>
        requireAcceptedControlResponse(await this.postJson('/final-status', envelope, signal)),
      signal
    );
  }

  /**
   * Appends one canonical worker event to NanoCore.
   *
   * @param record Canonical event record emitted by the control.
   * @returns Parsed worker-control response envelope.
   */
  public async appendEvent(
    record: WorkerCanonicalEventRecord,
    signal?: AbortSignal
  ): Promise<WorkerControlResponseEnvelope> {
    return this.request(
      async () =>
        requireAcceptedControlResponse(await this.postJson('/events/append', { record }, signal)),
      signal
    );
  }

  /** Sends one logical heartbeat and advances its sequence only after exact acceptance. */
  private async sendSequencedHeartbeat(
    input: Omit<WorkerControlHeartbeatInput, 'sequence'>,
    signal?: AbortSignal,
    reconnectFirst = false
  ): Promise<unknown> {
    const heartbeat = Object.freeze({ ...input, sequence: this.nextHeartbeatSequence });
    let presentReconnectKey = reconnectFirst;

    for (;;) {
      try {
        const result = await this.postHeartbeat(heartbeat, presentReconnectKey, signal);

        this.nextHeartbeatSequence += 1;
        return result;
      } catch (error) {
        this.requireRetryable(error);
        if (isReconnectRequired(error) && !reconnectFirst) {
          return this.reconnect(signal);
        }
        presentReconnectKey = isReconnectRequired(error);
        await this.waitForRetry(signal);
      }
    }
  }

  /** Sends one raw heartbeat envelope with an optional process-key reconnect proof. */
  private postHeartbeat(
    heartbeat: WorkerControlHeartbeatInput,
    reconnect: boolean,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.postJson(
      '/heartbeat',
      {
        body: {
          message: heartbeat.message ?? null,
          ...(heartbeat.sequence === 0
            ? {
                processKeyHash: createHash('sha256')
                  .update(Buffer.from(this.processKey, 'base64url'))
                  .digest('base64url'),
              }
            : {}),
          status: heartbeat.status,
        },
        operation: 'heartbeat',
        ...(reconnect ? { reconnectKey: this.processKey } : {}),
        schemaVersion: 1,
        sequence: heartbeat.sequence,
      },
      signal
    );
  }

  /** Runs one ordinary control request through the sole bounded retry owner. */
  private async request<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = await this.retry(operation, signal);

    this.clearOutage();
    return result;
  }

  /** Retries one immutable request and adopts the lease before replay when required. */
  private async retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        this.requireRetryable(error);
        if (isReconnectRequired(error)) {
          try {
            await this.reconnect(signal);
            continue;
          } catch (reconnectError) {
            this.requireRetryable(reconnectError);
          }
        }
        await this.waitForRetry(signal);
      }
    }
  }

  /** Sends one exact-next reconnect heartbeat for all requests blocked by one restart. */
  private async reconnect(signal?: AbortSignal): Promise<unknown> {
    if (!this.reconnecting) {
      const tracked = this.sendSequencedHeartbeat(
        { message: 'Worker shim reconnecting.', status: 'running' },
        signal,
        true
      ).finally(() => {
        if (this.reconnecting === tracked) {
          this.reconnecting = null;
        }
      });

      this.reconnecting = tracked;
    }
    return this.reconnecting;
  }

  /** Starts the shared outage budget and rejects definitive or expired failures. */
  private requireRetryable(error: unknown): void {
    if (!this.postLaunchRecoveryEnabled || !isRetryableFailure(error)) {
      throw error;
    }
    this.outageStartedAt ??= performance.now();
    if (performance.now() - this.outageStartedAt >= WORKER_CONTROL_OUTAGE_BUDGET_MS) {
      throw error;
    }
  }

  /** Waits once inside the original outage budget. */
  private async waitForRetry(signal?: AbortSignal): Promise<void> {
    await delay(WORKER_CONTROL_RETRY_DELAY_MS, undefined, signal ? { signal } : undefined);
    if (
      this.outageStartedAt !== null &&
      performance.now() - this.outageStartedAt >= WORKER_CONTROL_OUTAGE_BUDGET_MS
    ) {
      throw new Error('Worker control outage budget expired.');
    }
  }

  /** Clears the outage timer after one caller-visible request is accepted. */
  private clearOutage(): void {
    this.outageStartedAt = null;
  }

  /**
   * Sends one JSON request to the worker control route.
   *
   * @param path Route path under the upstream base URL.
   * @param body Request body without lineage.
   * @returns Parsed JSON response.
   */
  private async postJson<T = unknown>(
    path: string,
    body: object,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const requestController = new AbortController();
    let abortParent: (() => void) | null = null;
    const abortFailure = new Promise<never>((_resolve, reject) => {
      /** Rejects the in-flight request with the parent cancellation reason. */
      const abort = () => {
        const reason = abortSignalReason(signal);
        requestController.abort(reason);
        reject(reason);
      };
      abortParent = abort;

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new WorkerControlError(
          'worker_control_request_timeout',
          408,
          'Worker control request timed out.'
        );
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
      let parsed: unknown;

      try {
        parsed = parseJson(text);
      } catch {
        throw new WorkerControlError(
          response.ok
            ? 'worker_control_invalid_response'
            : `worker_control_http_${response.status}`,
          response.status,
          null
        );
      }

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
        signal?.removeEventListener('abort', abortParent);
      }
    }
  }
}

/** Returns whether NanoCore requires process-key adoption before request replay. */
function isReconnectRequired(error: unknown): boolean {
  return error instanceof WorkerControlError && error.code === 'worker_control_reconnect_required';
}

/** Restricts post-launch retries to transport failures and explicitly temporary HTTP responses. */
function isRetryableFailure(error: unknown): boolean {
  return (
    isReconnectRequired(error) ||
    error instanceof TypeError ||
    (error instanceof WorkerControlError &&
      (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500))
  );
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
 * Validates that NanoCore returned an accepted worker-control response envelope.
 *
 * @param value Parsed response candidate.
 * @returns Validated accepted response envelope.
 * @throws Error when the response is malformed or explicitly rejected.
 */
function requireAcceptedControlResponse(value: unknown): WorkerControlResponseEnvelope {
  const result = WorkerControlResponseEnvelopeSchema.safeParse(value);

  if (!result.success) {
    throw new WorkerControlError('worker_control_invalid_response', 200, result.error.message);
  }

  if (!result.data.accepted) {
    throw new WorkerControlError('worker_control_not_accepted', 200, null);
  }

  return result.data;
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
