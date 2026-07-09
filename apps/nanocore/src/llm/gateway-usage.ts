import type { ResolvedLLMProviderConfig } from './provider-config.js';

/**
 * Gateway endpoint family used for usage aggregation.
 */
export type GatewayUsageEndpoint = 'chat_completions' | 'responses' | 'quick_chat';

/**
 * One usage aggregation input.
 */
export interface GatewayUsageRecordInput {
  /** Provider that served the request. */
  readonly provider: ResolvedLLMProviderConfig;
  /** Model requested by the client. */
  readonly model: string;
  /** Gateway endpoint family that handled the request. */
  readonly endpoint: GatewayUsageEndpoint;
  /** Provider-native usage payload. */
  readonly usage?: unknown;
  /** Optional side-effect observer for each parsed usage payload. */
  readonly onUsage?: (usage: unknown) => void;
}

/**
 * Aggregated gateway usage summary returned through diagnostics.
 */
export interface GatewayUsageSummary {
  /** Provider id used for routing. */
  readonly providerId: string;
  /** Model requested by the client. */
  readonly model: string;
  /** Gateway endpoint family that handled the request. */
  readonly endpoint: GatewayUsageEndpoint;
  /** Number of responses observed for this bucket. */
  readonly requestCount: number;
  /** Total input or prompt tokens observed for this bucket. */
  readonly inputTokens: number;
  /** Total output or completion tokens observed for this bucket. */
  readonly completionTokens: number;
  /** Total tokens observed for this bucket. */
  readonly totalTokens: number;
  /** Total cached input tokens observed for this bucket. */
  readonly cachedInputTokens: number;
  /** Cached input token ratio for this bucket. */
  readonly cacheHitRate: number;
  /** ISO timestamp for the latest observation. */
  readonly lastObservedAt: string;
}

/**
 * Gateway usage diagnostics payload.
 */
export interface GatewayUsageSnapshot {
  /** Aggregated usage summaries. */
  readonly summaries: GatewayUsageSummary[];
}

/**
 * Construction options for GatewayUsageTracker.
 */
export interface GatewayUsageTrackerOptions {
  /** Clock used for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Process-local usage tracker for Gateway diagnostics.
 */
export class GatewayUsageTracker {
  private readonly buckets = new Map<string, MutableGatewayUsageSummary>();
  private readonly now: () => Date;

  /**
   * Creates one usage tracker.
   *
   * @param options Tracker dependencies and deterministic test hooks.
   */
  public constructor(options: GatewayUsageTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Records one provider usage payload.
   *
   * @param input Usage payload and routing metadata.
   */
  public recordUsage(input: GatewayUsageRecordInput): void {
    const parsed = parseUsage(input.usage);
    const key = usageBucketKey(input);
    const existing = this.buckets.get(key);
    const next = existing ?? {
      cachedInputTokens: 0,
      completionTokens: 0,
      endpoint: input.endpoint,
      inputTokens: 0,
      lastObservedAt: this.now().toISOString(),
      model: input.model,
      providerId: input.provider.id,
      requestCount: 0,
      totalTokens: 0,
    };

    next.cachedInputTokens += parsed.cachedInputTokens;
    next.completionTokens += parsed.completionTokens;
    next.inputTokens += parsed.inputTokens;
    next.totalTokens += parsed.totalTokens;
    next.requestCount += 1;
    next.lastObservedAt = this.now().toISOString();

    this.buckets.set(key, next);
    if (input.usage !== undefined) {
      input.onUsage?.(input.usage);
    }
  }

  /**
   * Observes SSE usage payloads while preserving the original stream bytes.
   *
   * @param stream Provider SSE stream.
   * @param input Routing metadata for usage aggregation.
   * @returns Stream with the original event bytes.
   */
  public observeSseUsage(
    stream: ReadableStream<Uint8Array>,
    input: Omit<GatewayUsageRecordInput, 'usage'>
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = '';

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = stream.getReader();

        try {
          while (true) {
            const result = await reader.read();

            if (result.done) {
              break;
            }

            buffer += decoder.decode(result.value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';

            for (const event of events) {
              this.recordSseEventUsage(event, input);
            }

            controller.enqueue(result.value);
          }

          if (buffer.trim()) {
            this.recordSseEventUsage(buffer, input);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      },
    });
  }

  /**
   * Returns current usage summaries.
   *
   * @returns Diagnostics usage snapshot.
   */
  public snapshot(): GatewayUsageSnapshot {
    return {
      summaries: [...this.buckets.values()].map((bucket) => ({
        cachedInputTokens: bucket.cachedInputTokens,
        cacheHitRate: bucket.inputTokens > 0 ? bucket.cachedInputTokens / bucket.inputTokens : 0,
        completionTokens: bucket.completionTokens,
        endpoint: bucket.endpoint,
        inputTokens: bucket.inputTokens,
        lastObservedAt: bucket.lastObservedAt,
        model: bucket.model,
        providerId: bucket.providerId,
        requestCount: bucket.requestCount,
        totalTokens: bucket.totalTokens,
      })),
    };
  }

  private recordSseEventUsage(event: string, input: Omit<GatewayUsageRecordInput, 'usage'>): void {
    const usage = usageFromSseEvent(event);

    if (usage) {
      this.recordUsage({ ...input, usage });
    }
  }
}

interface MutableGatewayUsageSummary {
  providerId: string;
  model: string;
  endpoint: GatewayUsageEndpoint;
  requestCount: number;
  inputTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  lastObservedAt: string;
}

interface ParsedUsage {
  inputTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
}

/**
 * Converts provider-native usage payloads into normalized token counts.
 *
 * @param usage Provider usage payload.
 * @returns Normalized usage counts.
 */
export function parseUsage(usage: unknown): ParsedUsage {
  if (!usage || typeof usage !== 'object') {
    return { cachedInputTokens: 0, completionTokens: 0, inputTokens: 0, totalTokens: 0 };
  }

  const record = usage as Record<string, unknown>;
  const promptDetails = readRecord(record.prompt_tokens_details);
  const inputDetails = readRecord(record.input_tokens_details);

  return {
    cachedInputTokens:
      readNumber(promptDetails.cached_tokens) ??
      readNumber(inputDetails.cached_tokens) ??
      readNumber(record.cached_tokens) ??
      0,
    completionTokens: readNumber(record.completion_tokens) ?? readNumber(record.output_tokens) ?? 0,
    inputTokens: readNumber(record.prompt_tokens) ?? readNumber(record.input_tokens) ?? 0,
    totalTokens: readNumber(record.total_tokens) ?? 0,
  };
}

function usageBucketKey(input: GatewayUsageRecordInput): string {
  return [input.provider.id, input.model, input.endpoint].join('\0');
}

function usageFromSseEvent(event: string): unknown {
  const payload = dataPayloadFromSseEvent(event);

  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const response = readRecord(parsed.response);

    return parsed.usage ?? response.usage ?? null;
  } catch {
    return null;
  }
}

function dataPayloadFromSseEvent(event: string): string | null {
  const line = event
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data:'));

  return line ? line.slice('data:'.length).trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
