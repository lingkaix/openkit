import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { compareCodeUnits } from '@openkit/protocol';
import { JsonMetricsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

const REQUEST_BYTES = 1_048_576;
const SEGMENT_BYTES = 16 * 1_048_576;
const SEGMENT_AGE_MS = 3_600_000;
const MAX_QUEUED_REQUESTS = 512;
const SEGMENT_NAME = /^(traces|metrics)-\d+-[a-f0-9-]+\.jsonl$/;

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

/** One disposable file found inside the service-owned sink subtree. */
interface Segment {
  readonly path: string;
  readonly bytes: number;
  readonly modified: number;
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

  /** Creates only confined directories and never follows an existing directory link. */
  private async prepare(): Promise<void> {
    let path = parse(this.directory).root;
    for (const part of this.directory.slice(path.length).split(sep).filter(Boolean)) {
      path = join(path, part);
      try {
        await fs.mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const state = await fs.lstat(path);
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error('Invalid telemetry directory.');
    }
  }

  /** Revalidates confinement before every inventory, including idle cleanup after startup refusal. */
  private async segments(): Promise<Segment[]> {
    await this.prepare();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files: Segment[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !SEGMENT_NAME.test(entry.name))
        throw new Error('Invalid telemetry segment.');
      const path = join(this.directory, entry.name);
      const state = await fs.lstat(path);
      if (
        !state.isFile() ||
        !Number.isSafeInteger(state.size) ||
        state.size < 0 ||
        !Number.isFinite(state.mtimeMs)
      )
        throw new Error('Invalid telemetry file.');
      files.push({ path, bytes: state.size, modified: state.mtimeMs });
    }
    return files.sort((a, b) => a.modified - b.modified || compareCodeUnits(a.path, b.path));
  }

  /** Removes expired/oldest disposable segments before growth, never canonical records. */
  private async prune(incoming: number): Promise<void> {
    const files = await this.segments();
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
      await fs.unlink(file.path);
      total -= file.bytes;
    }
    if (incoming > this.maximumBytes || total > this.maximumBytes - incoming)
      throw new Error('Telemetry limit reached.');
  }

  /** Checks current reserve and filesystem facts for each append; uncertainty means no write. */
  private async hasHeadroom(bytes: number): Promise<boolean> {
    try {
      const reserve = this.options.readReserveBytes();
      if (!Number.isSafeInteger(reserve) || reserve < 0) return false;
      const state = await fs.statfs(this.directory, { bigint: true });
      // A zero inode total means no inode limit is reported (Btrfs); only bytes then apply.
      return (
        state.bsize > 0n &&
        state.bavail >= 0n &&
        (state.files === 0n || state.ffree > 0n) &&
        state.bavail * state.bsize - BigInt(bytes) >= BigInt(reserve)
      );
    } catch {
      return false;
    }
  }

  /** Serializes rotation, admission and one append; a partial write abandons this segment. */
  private async append(bytes: Uint8Array, signal: 'traces' | 'metrics'): Promise<void> {
    if (bytes.byteLength > this.maximumBytes) return;
    await this.prune(bytes.byteLength);
    if (this.active) {
      const current = await fs.lstat(this.active.path).catch(() => undefined);
      const opened = await this.active.handle.stat();
      if (!current?.isFile() || current.ino !== opened.ino || current.dev !== opened.dev)
        await this.closeActive();
    }
    if (!(await this.hasHeadroom(bytes.byteLength))) {
      // Reclaiming our files may recover headroom, but never authorizes a doubtful write.
      const files = await this.segments();
      for (const file of files) {
        if (this.active?.path === file.path) await this.closeActive();
        await fs.unlink(file.path);
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
      const handle = await fs.open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      this.active = { handle, path, bytes: 0, created: now, signal };
    }
    const result = await this.active.handle.write(bytes);
    if (result.bytesWritten !== bytes.byteLength) throw new Error('Incomplete telemetry append.');
    this.active.bytes += result.bytesWritten;
  }

  /** Releases a segment without repairing or reusing an uncertain tail. */
  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.handle.close().catch(() => {});
  }

  /** A single fixed diagnostic avoids content leakage, recursion and failure-log floods. */
  private warn(): void {
    if (!this.warned) {
      this.warned = true;
      console.warn('Local telemetry was dropped; product work continues.');
    }
  }
}
