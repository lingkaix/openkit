import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordEmissionSchema,
  WorkerCanonicalTerminalEventDataEmissionSchema,
  type WorkerCanonicalTerminalEventDataInput,
  type WorkerControlResponseEnvelope,
  WorkerControlResponseEnvelopeReaderSchema,
  type WorkerLineage,
} from '@openkit/worker-protocol';
import { LIFECYCLE_DEFAULTS, LifecycleDeadline } from './lifecycle-deadline.js';
import { containTurnLifecycleRecorder, type TurnLifecycleRecorder } from './turn-timeline.js';

const WORKER_CONTROL_OUTAGE_BUDGET_MS = 300_000;
// Leave two seconds of the Core lease window for the reserved request to reach Core.
const HEARTBEAT_RESERVE_MS = 28_000;
const PERIODIC_HEARTBEAT = { message: 'Worker shim running.', status: 'running' } as const;

/** Internal Turn entry point for the bounded post-launch heartbeat schedule. */
export const workerHeartbeatTick = Symbol('workerHeartbeatTick');
/** Internal access to the Turn's one-shot heartbeat observations. */
export const workerHeartbeatFailureDetail = Symbol('workerHeartbeatFailureDetail');

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
  /** Shared recorder for physical heartbeat attempts and reconnect evidence, without request values. */
  recordLifecycleFact?: TurnLifecycleRecorder;
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
  status: 'starting' | 'running' | 'idle' | 'stopping' | 'completed' | 'failed';
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
    /** Optional worker-announced digest; Core verifies collected bytes separately. */
    digest?: string | null | undefined;
    /** Optional descriptive collection hint; it grants no collection authority. */
    collectionHint?: string | null | undefined;
  };
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
  private heartbeatQueue: Promise<unknown> = Promise.resolve();
  private periodicHeartbeats = false;
  private confirmedHeartbeatSequence = -1;
  private firstLaunchHeartbeatAt: number | undefined;
  private heartbeatReserveAt = Number.NEGATIVE_INFINITY;
  private heartbeatReservationWake: AbortController | undefined;
  private heartbeatOutage = false;
  private waitingForHeartbeatSlot = false;
  private readonly heartbeatAttempts = new Map<
    number,
    { request: Promise<unknown>; status: { code?: number }; deadlineAt: number }
  >();
  private lastHeartbeatSent: { sequence: number; at: number } | undefined;
  private lastHeartbeatAck: { sequence: number; at: number } | undefined;
  private outageDeadline: LifecycleDeadline | null = null;
  /** Pending recoveries keep the shared budget anchored despite independent successful traffic. */
  private retryingRequests = 0;
  private postLaunchRecoveryEnabled = false;
  private readonly processKey: string;
  private reconnecting: Promise<unknown> | null = null;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly recordLifecycleFact: TurnLifecycleRecorder | undefined;

  /**
   * Creates a worker control client.
   *
   * @param options Upstream URL, sandbox token, lineage, and optional fetch implementation.
   */
  public constructor(options: WorkerControlClientOptions) {
    this.fetch = options.fetch ?? defaultFetch();
    this.recordLifecycleFact = containTurnLifecycleRecorder(options.recordLifecycleFact);
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
    const result = await this.enqueueHeartbeat(input, signal);

    this.clearOutage();
    return result;
  }

  /** Sends a fresh observation when launch proof and transport capacity permit it. */
  public async [workerHeartbeatTick](
    signal: AbortSignal,
    stopScheduling: AbortSignal,
    onSend: () => void
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (stopScheduling.aborted || this.reconnecting || this.waitingForHeartbeatSlot) return false;
    this.periodicHeartbeats = true;

    const attempts = this.heartbeatAttempts;
    // Sequence one is the startup proof. Keep its original body until Core confirms it.
    if (this.nextHeartbeatSequence === 1 && attempts.size > 0) return false;
    if (
      attempts.size === 2 ||
      this.shouldReserveHeartbeatSlot(this.heartbeatReserveAt - performance.now())
    ) {
      this.waitingForHeartbeatSlot = true;
      try {
        if (!(await this.waitForHeartbeatAdmission(signal, stopScheduling))) return false;
      } finally {
        this.waitingForHeartbeatSlot = false;
      }
      if (stopScheduling.aborted || this.reconnecting) return false;
      signal.throwIfAborted();
    }
    // Give a definitive refusal its bounded body read so its typed authority error survives.
    for (const { status } of attempts.values()) {
      if (status.code !== undefined && status.code >= 400 && !isRetryableHttpStatus(status.code))
        return false;
    }

    const sequence = this.nextHeartbeatSequence;
    if (sequence >= 2) this.nextHeartbeatSequence += 1;
    const status: { code?: number } = {};
    onSend();
    const request = this.postHeartbeat(
      { ...PERIODIC_HEARTBEAT, sequence },
      false,
      signal,
      (code) => {
        status.code = code;
        if (sequence === 1 && code === 200)
          this.nextHeartbeatSequence = Math.max(this.nextHeartbeatSequence, 2);
      }
    ).finally(() => attempts.delete(sequence));
    attempts.set(sequence, {
      request,
      status,
      deadlineAt: performance.now() + LIFECYCLE_DEFAULTS.workerControlRequestMs,
    });

    try {
      await request;
      this.clearOutage();
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if (this.isStaleHeartbeat(error, sequence)) return false;
      if (isRetryableFailure(error) && sequence < (this.lastHeartbeatAck?.sequence ?? -1))
        return false;
      this.requireRetryable(error);
      this.heartbeatOutage = true;
      if (isReconnectRequired(error)) await this.reconnect(signal);
      return false;
    }
  }

  /** Protects the deadline send without pushing its ordinary cadence past the reserve. */
  private shouldReserveHeartbeatSlot(untilReserve: number): boolean {
    if (untilReserve <= 0) return false;
    if (untilReserve < LIFECYCLE_DEFAULTS.workerHeartbeatIntervalMs) return true;
    const occupied = this.heartbeatAttempts.values().next().value;
    return (
      untilReserve < LIFECYCLE_DEFAULTS.workerControlRequestMs &&
      occupied !== undefined &&
      occupied.deadlineAt > this.heartbeatReserveAt
    );
  }

  /** Coalesces busy ticks and keeps a slot available for the reserved deadline send. */
  private async waitForHeartbeatAdmission(
    signal: AbortSignal,
    stopScheduling: AbortSignal
  ): Promise<boolean> {
    const attempts = this.heartbeatAttempts;
    while (!stopScheduling.aborted && !signal.aborted && !this.reconnecting) {
      const untilReserve = this.heartbeatReserveAt - performance.now();
      if (attempts.size < 2 && !this.shouldReserveHeartbeatSlot(untilReserve)) return true;

      const completions = [...attempts].map(([sequence, { request }]) =>
        request.then(
          () => true,
          (error: unknown) => this.isStaleHeartbeat(error, sequence) || isRetryableFailure(error)
        )
      );
      if (attempts.size === 2) {
        if (!(await Promise.race(completions))) return false;
        continue;
      }

      const wake = new AbortController();
      this.heartbeatReservationWake = wake;
      const timer = delay(Math.ceil(untilReserve), true, {
        signal: AbortSignal.any([wake.signal, signal, stopScheduling]),
      }).catch(() => true);
      try {
        if (!(await Promise.race([timer, ...completions]))) return false;
      } finally {
        this.heartbeatReservationWake = undefined;
        wake.abort();
      }
    }
    return false;
  }

  /** A later observation can overtake this request before Core sees it. */
  private isStaleHeartbeat(error: unknown, sequence: number): boolean {
    return (
      sequence + 1 < this.nextHeartbeatSequence &&
      error instanceof WorkerControlError &&
      error.code === 'worker_control_sequence_stale'
    );
  }

  /** Gives one value-free heartbeat summary for the local durable lease-failure detail. */
  public [workerHeartbeatFailureDetail](): string {
    const describe = (point: { sequence: number; at: number } | undefined) =>
      point ? `${point.sequence}@${new Date(point.at).toISOString()}` : 'none';
    return `Heartbeat lastSent=${describe(this.lastHeartbeatSent)} lastAck=${describe(this.lastHeartbeatAck)}.`;
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
      body: WorkerCanonicalTerminalEventDataEmissionSchema.parse(terminalData),
      operation: 'final_status',
      schemaVersion: 2,
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
    const validated = WorkerCanonicalEventRecordEmissionSchema.parse(record);
    return this.request(
      async () =>
        requireAcceptedControlResponse(
          await this.postJson('/events/append', { record: validated }, signal)
        ),
      signal
    );
  }

  /** Serializes lease heartbeats and reconnect proof through their single sequence owner; an accepted intervening heartbeat already proves live authority for a queued recovery request. */
  private enqueueHeartbeat(
    input: Omit<WorkerControlHeartbeatInput, 'sequence'>,
    signal?: AbortSignal,
    reconnectSequence?: number
  ): Promise<unknown> {
    const queued = this.heartbeatQueue.then(() => {
      signal?.throwIfAborted();
      if (reconnectSequence !== undefined && this.nextHeartbeatSequence > reconnectSequence) {
        return undefined;
      }
      return this.sendSequencedHeartbeat(input, signal, reconnectSequence !== undefined);
    });
    this.heartbeatQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  /** Sends one logical heartbeat and advances its sequence only after exact acceptance. */
  private async sendSequencedHeartbeat(
    input: Omit<WorkerControlHeartbeatInput, 'sequence'>,
    signal?: AbortSignal,
    reconnectFirst = false,
    sequence = this.nextHeartbeatSequence
  ): Promise<unknown> {
    const heartbeat = Object.freeze({ ...input, sequence });
    const firstSentAt = performance.now();
    let presentReconnectKey = reconnectFirst;
    let retrying = false;

    try {
      for (;;) {
        try {
          const result = await this.postHeartbeat(
            heartbeat,
            presentReconnectKey,
            signal,
            undefined,
            firstSentAt
          );

          this.nextHeartbeatSequence = Math.max(this.nextHeartbeatSequence, sequence + 1);
          return result;
        } catch (error) {
          this.requireRetryable(error);
          if (!retrying) {
            retrying = true;
            this.retryingRequests += 1;
          }
          presentReconnectKey = isReconnectRequired(error);
          await this.waitForRetry(signal);
        }
      }
    } finally {
      if (retrying) this.retryingRequests -= 1;
    }
  }

  /** Sends one raw heartbeat envelope with an optional process-key reconnect proof. */
  private async postHeartbeat(
    heartbeat: WorkerControlHeartbeatInput,
    reconnect: boolean,
    signal?: AbortSignal,
    onFinalStatus?: (code: number) => void,
    firstSentAt?: number
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const { sequence } = heartbeat;
    if (sequence === 1) this.firstLaunchHeartbeatAt ??= startedAt;
    const anchor = (sequence === 1 ? this.firstLaunchHeartbeatAt : firstSentAt) ?? startedAt;
    const label = reconnect ? 'reconnect' : 'heartbeat';
    this.lastHeartbeatSent = { sequence, at: Date.now() };
    this.recordLifecycleFact?.({ label, reason: 'attempt' });
    try {
      const result = await this.postJson(
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
          schemaVersion: 2,
          sequence: heartbeat.sequence,
        },
        signal,
        (code) => {
          if (code === 200 && sequence > this.confirmedHeartbeatSequence) {
            this.confirmedHeartbeatSequence = sequence;
            if (sequence > 0) {
              this.heartbeatReserveAt = anchor + HEARTBEAT_RESERVE_MS;
              this.heartbeatReservationWake?.abort();
            }
          }
          onFinalStatus?.(code);
        }
      );
      requireAcceptedControlResponse(result);
      if (sequence >= (this.lastHeartbeatAck?.sequence ?? -1))
        this.lastHeartbeatAck = { sequence, at: Date.now() };
      this.heartbeatOutage = false;
      this.recordLifecycleFact?.({
        label,
        reason: 'accepted',
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.recordLifecycleFact?.({
        label,
        reason: 'rejected',
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }

  /** Runs one ordinary control request through the sole bounded retry owner. */
  private async request<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = await this.retry(operation, signal);

    this.clearOutage();
    return result;
  }

  /** Retries one immutable request and adopts the lease before replay when required. */
  private async retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let retrying = false;
    try {
      for (;;) {
        try {
          return await operation();
        } catch (error) {
          this.requireRetryable(error);
          if (!retrying) {
            retrying = true;
            this.retryingRequests += 1;
          }
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
    } finally {
      if (retrying) this.retryingRequests -= 1;
    }
  }

  /** Sends one exact-next reconnect heartbeat for all requests blocked by one restart. */
  private async reconnect(signal?: AbortSignal): Promise<unknown> {
    if (!this.reconnecting) {
      const recovery = this.periodicHeartbeats
        ? this.reconnectPeriodicHeartbeat(signal)
        : this.enqueueHeartbeat(
            { message: 'Worker shim reconnecting.', status: 'running' },
            signal,
            this.nextHeartbeatSequence
          );
      const tracked = recovery.finally(() => {
        if (this.reconnecting === tracked) {
          this.reconnecting = null;
        }
      });

      this.reconnecting = tracked;
    }
    return this.reconnecting;
  }

  /** Drains entered exchanges and proves the exact next sequence before periodic sends resume. */
  private async reconnectPeriodicHeartbeat(signal?: AbortSignal): Promise<unknown> {
    await Promise.allSettled([...this.heartbeatAttempts.values()].map(({ request }) => request));
    // A sent sequence may have committed before its ACK was lost. Core decides this exact proof.
    const result = await this.sendSequencedHeartbeat(
      PERIODIC_HEARTBEAT,
      signal,
      true,
      this.confirmedHeartbeatSequence + 1
    );
    this.clearOutage();
    return result;
  }

  /** Starts the shared outage budget and rejects definitive or expired failures. */
  private requireRetryable(error: unknown): void {
    if (!this.postLaunchRecoveryEnabled || !isRetryableFailure(error)) {
      throw error;
    }
    this.outageDeadline ??= new LifecycleDeadline(WORKER_CONTROL_OUTAGE_BUDGET_MS);
    if (this.outageDeadline.remainingMs() <= 0) {
      throw error;
    }
  }

  /** Waits once inside the original outage budget. */
  private async waitForRetry(signal?: AbortSignal): Promise<void> {
    await delay(
      this.outageDeadline?.remainingMs(LIFECYCLE_DEFAULTS.workerControlRetryMs) ??
        LIFECYCLE_DEFAULTS.workerControlRetryMs,
      undefined,
      signal ? { signal } : undefined
    );
    if (this.outageDeadline && this.outageDeadline.remainingMs() <= 0) {
      throw new Error('Worker control outage budget expired.');
    }
  }

  /** Clears the shared outage timer after acceptance only when no logical request still needs recovery. */
  private clearOutage(): void {
    if (this.retryingRequests === 0 && !this.heartbeatOutage) this.outageDeadline = null;
  }

  /**
   * Sends one JSON request to the worker control route.
   *
   * @param path Route path under the upstream base URL.
   * @param body Request body without lineage.
   * @param signal Parent cancellation for this control request.
   * @param onFinalStatus Internal observer of the correlated heartbeat response headers.
   * @returns Parsed JSON response.
   */
  private async postJson<T = unknown>(
    path: string,
    body: object,
    signal?: AbortSignal,
    onFinalStatus?: (code: number) => void
  ): Promise<T> {
    signal?.throwIfAborted();
    const requestLimit = LIFECYCLE_DEFAULTS.workerControlRequestMs;
    const remaining = this.outageDeadline?.remainingMs(requestLimit) ?? requestLimit;
    if (remaining <= 0) throw new Error('Worker control outage budget expired.');
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
    let finalStatus: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const refused =
          finalStatus !== undefined && finalStatus >= 400 && !isRetryableHttpStatus(finalStatus);
        const error = new WorkerControlError(
          refused ? `worker_control_http_${finalStatus}` : 'worker_control_request_timeout',
          refused ? finalStatus! : 408,
          'Worker control request timed out.'
        );
        requestController.abort(error);
        reject(error);
      }, remaining);
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
        requestController.signal.throwIfAborted();
        if (onFinalStatus) {
          finalStatus = response.status;
          onFinalStatus(finalStatus);
        }
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          if (
            finalStatus !== undefined &&
            finalStatus >= 400 &&
            !isRetryableHttpStatus(finalStatus)
          )
            throw new WorkerControlError(`worker_control_http_${finalStatus}`, finalStatus, null);
          throw error;
        }
        requestController.signal.throwIfAborted();
        return { response, text };
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
    (error instanceof WorkerControlError && isRetryableHttpStatus(error.status))
  );
}

/**
 * Whether one HTTP status is a temporary failure the same immutable request may retry under the
 * bounded outage budget: 408, 425, 429, and 500-599. Every other status is terminal.
 *
 * @param status Received HTTP status.
 * @returns True for the retryable statuses the Worker Control Protocol names.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
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
  const result = WorkerControlResponseEnvelopeReaderSchema.safeParse(value);

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
