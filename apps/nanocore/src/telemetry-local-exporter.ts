import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  appendTelemetrySegment,
  closeTelemetrySegment,
  createTelemetrySegment,
  hasTelemetryHeadroom,
  listTelemetrySegments,
  removeTelemetrySegment,
  telemetrySegmentNeedsClose,
} from '@openkit/storage';
import { JsonMetricsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

const REQUEST_BYTES = 1_048_576;
const SEGMENT_BYTES = 16 * 1_048_576;
const SEGMENT_AGE_MS = 3_600_000;
const MAX_QUEUED_REQUESTS = 512;

/** Both signals share one queue, inventory, reserve check and byte cap. */
export interface LocalTelemetryExporter extends SpanExporter {
  /** The meter drains first; only the trace exporter's shutdown closes the shared writer. */
  readonly metrics: PushMetricExporter;
}

/** Existing composition facts and accepted sink limits; no capacity policy is created here. */
export interface LocalTelemetryOptions {
  readonly logDirectory: string;
  readonly readReserveBytes: () => number;
  readonly env: NodeJS.ProcessEnv;
}

/** Creates the optional local exporter; invalid limits disable only this destination. */
export function createLocalTraceExporter(
  options: LocalTelemetryOptions
): LocalTelemetryExporter | undefined {
  const maximumBytes = positiveInteger(
    options.env.OPENKIT_TELEMETRY_LOCAL_MAX_BYTES,
    256 * 1_048_576
  );
  const ageSeconds = positiveInteger(options.env.OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS, 604_800);
  if (
    maximumBytes === undefined ||
    ageSeconds === undefined ||
    !Number.isSafeInteger(ageSeconds * 1000)
  ) {
    console.warn('Local telemetry is disabled because its retention limits are invalid.');
    return undefined;
  }
  return new LocalTraceExporter(options, maximumBytes, ageSeconds * 1000);
}

/** Accepts only checked positive integer limits, including safe age conversion. */
function positiveInteger(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Stock SDK serialization over a bounded, single-writer, mixed-signal inventory. */
class LocalTraceExporter implements LocalTelemetryExporter {
  readonly metrics: PushMetricExporter = {
    export: (metrics, done) => this.export(metrics, done),
    selectAggregationTemporality: () => AggregationTemporality.DELTA,
    forceFlush: () => this.tail,
    // The shared writer remains available for the trace provider's final batch.
    shutdown: async () => {},
  };
  private readonly directory: string;
  private tail: Promise<void>;
  private queued = 0;
  private queuedBytes = 0;
  private accepting = true;
  private warned = false;
  // A stalled filesystem must not accumulate idle-maintenance jobs.
  private maintenancePending = true;
  private active:
    | {
        handle: FileHandle;
        path: string;
        bytes: number;
        created: number;
        signal: 'traces' | 'metrics';
      }
    | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: LocalTelemetryOptions,
    private readonly maximumBytes: number,
    private readonly maximumAgeMs: number
  ) {
    this.directory = join(resolve(options.logDirectory), 'telemetry');
    this.tail = this.prune(0)
      .catch(() => this.warn())
      .finally(() => {
        this.maintenancePending = false;
      });
    this.timer = setInterval(
      () => {
        if (this.accepting && this.queued === 0 && !this.maintenancePending) {
          this.maintenancePending = true;
          this.tail = this.tail
            .then(() => this.prune(0))
            .catch(() => this.warn())
            .finally(() => {
              this.maintenancePending = false;
            });
        }
      },
      Math.min(maximumAgeMs, 60_000)
    );
    this.timer.unref();
  }

  /** Drops malformed, oversized or overflowing requests without truncation or delivery state. */
  export(
    data: ReadableSpan[] | ResourceMetrics,
    done: Parameters<SpanExporter['export']>[1]
  ): void {
    const signal = Array.isArray(data) ? 'traces' : 'metrics';
    let bytes: Uint8Array;
    try {
      if (
        !Array.isArray(data) &&
        !data.scopeMetrics.some((scope) =>
          scope.metrics.some((metric) => metric.dataPoints.length > 0)
        )
      ) {
        done({ code: 0 });
        return;
      }
      const request = Array.isArray(data)
        ? JsonTraceSerializer.serializeRequest(data)
        : JsonMetricsSerializer.serializeRequest(data);
      if (!request || request.byteLength > REQUEST_BYTES) {
        done({ code: 0 });
        return;
      }
      bytes = Buffer.concat([request, Buffer.from('\n')]);
    } catch {
      this.warn();
      done({ code: 0 });
      return;
    }
    if (
      !this.accepting ||
      this.queued >= MAX_QUEUED_REQUESTS ||
      bytes.byteLength > SEGMENT_BYTES - this.queuedBytes
    ) {
      done({ code: 0 });
      return;
    }
    this.queued++;
    this.queuedBytes += bytes.byteLength;
    this.tail = this.tail
      .then(async () => {
        try {
          await this.append(bytes, signal);
        } catch {
          await this.closeActive();
          this.warn();
        } finally {
          this.queued--;
          this.queuedBytes -= bytes.byteLength;
          done({ code: 0 });
        }
      })
      .catch(() => this.warn());
  }

  /** Stops idle work and drains accepted batches; the process owner bounds shutdown time. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    clearInterval(this.timer);
    await this.tail;
    await this.closeActive();
  }

  /** Removes expired/oldest disposable segments before growth, never canonical records. */
  private async prune(incoming: number): Promise<void> {
    const files = await listTelemetrySegments(this.directory);
    let total = 0;
    for (const file of files) {
      if (file.bytes > Number.MAX_SAFE_INTEGER - total) throw new Error('Invalid telemetry size.');
      total += file.bytes;
    }
    for (const file of files) {
      // Empty failed creations have no diagnostic value and must not grow an inode-only backlog.
      if (
        file.bytes > 0 &&
        Date.now() - file.modified < this.maximumAgeMs &&
        total <= this.maximumBytes - incoming
      )
        continue;
      if (this.active?.path === file.path) await this.closeActive();
      await removeTelemetrySegment(file.path);
      total -= file.bytes;
    }
    if (incoming > this.maximumBytes || total > this.maximumBytes - incoming)
      throw new Error('Telemetry limit reached.');
  }

  /** Serializes rotation, admission and one append; a partial write abandons this segment. */
  private async append(bytes: Uint8Array, signal: 'traces' | 'metrics'): Promise<void> {
    if (bytes.byteLength > this.maximumBytes) return;
    await this.prune(bytes.byteLength);
    if (this.active && (await telemetrySegmentNeedsClose(this.active))) await this.closeActive();
    if (!(await hasTelemetryHeadroom(this.options, this.directory, bytes.byteLength))) {
      // Reclaiming our files may recover headroom, but never authorizes a doubtful write.
      const files = await listTelemetrySegments(this.directory);
      for (const file of files) {
        if (this.active?.path === file.path) await this.closeActive();
        await removeTelemetrySegment(file.path);
      }
      this.warn();
      return;
    }
    if (
      this.active &&
      (this.active.signal !== signal ||
        this.active.bytes > Math.min(SEGMENT_BYTES, this.maximumBytes) - bytes.byteLength ||
        Date.now() - this.active.created >= SEGMENT_AGE_MS)
    )
      await this.closeActive();
    if (!this.active) {
      const now = Date.now();
      const path = join(this.directory, `${signal}-${now}-${randomUUID()}.jsonl`);
      const handle = await createTelemetrySegment(path);
      this.active = { handle, path, bytes: 0, created: now, signal };
    }
    await appendTelemetrySegment(this.active, bytes);
  }

  /** Releases a segment without repairing or reusing an uncertain tail. */
  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await closeTelemetrySegment(active);
  }

  /** A single fixed diagnostic avoids content leakage, recursion and failure-log floods. */
  private warn(): void {
    if (!this.warned) {
      this.warned = true;
      console.warn('Local telemetry was dropped; product work continues.');
    }
  }
}
