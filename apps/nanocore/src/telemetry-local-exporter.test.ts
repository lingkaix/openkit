// openkit-test-platform: posix
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureTelemetryContext,
  createHttpTelemetryMiddleware,
  injectTelemetryContext,
  shutdownTelemetry,
  startTelemetry,
  withTurnDispatchTelemetry,
} from './telemetry.js';

// Use the public serializer belonging to the installed stock HTTP exporter, not a private
// node_modules path or an OpenKit decoder. Its 0.221.0 version is fixed by the lockfile.
const require = createRequire(import.meta.url);
const exporterRequire = createRequire(require.resolve('@opentelemetry/exporter-trace-otlp-http'));
const { JsonTraceSerializer } = exporterRequire('@opentelemetry/otlp-transformer') as {
  JsonTraceSerializer: { serializeRequest(spans: ReadableSpan[]): Uint8Array };
};
const BOOT_ID = 'boot-local-telemetry';
const TURN_ID = 'turn-local-telemetry';
const ENDPOINT = 'http://127.0.0.1:4318';
const REQUEST_LIMIT = 1_048_576;
const readFilesystemStats = fs.statfs;
let root: string;
let logDirectory: string;

/** Only the stock OTLP/JSON fields inspected by these assertions; JSON.parse reads the bytes. */
interface TraceRequest {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: unknown }> };
    scopeSpans: Array<{
      scope: unknown;
      spans: Array<{
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        attributes: Array<{ key: string; value: unknown }>;
      }>;
    }>;
  }>;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'telemetry-local-'));
  logDirectory = join(root, 'logs');
  await fs.mkdir(logDirectory);
  vi.spyOn(fs, 'statfs').mockImplementation(finiteFilesystemStats);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  try {
    await shutdownTelemetry();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await fs.chmod(logDirectory, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('local telemetry through the production SDK lifecycle', () => {
  it('captures HTTP and dispatch with no endpoint, stock framing, safe identity and no content', async () => {
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'host.name=resource-host-canary');
    start();
    const librarySpan = trace.getTracer('foreign-library').startSpan('foreign-content-canary');
    librarySpan.setAttribute('secret', 'foreign-secret-canary');
    librarySpan.end();
    let headers: Record<string, string> = {};
    const response = await productApp(() => {
      headers = {};
      injectTelemetryContext(captureTelemetryContext(), headers);
    }).request('/items/path-canary?query=query-canary', {
      method: 'POST',
      headers: { authorization: 'Bearer credential-canary', 'x-private': 'header-canary' },
      body: 'prompt-content-canary',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, result: 'response-content-canary' });
    await shutdownTelemetry();

    const files = await segmentFiles();
    expect(
      files.length,
      'default capture must write a local request without an endpoint'
    ).toBeGreaterThan(0);
    const requests = await readRequests(files);
    const spans = requestSpans(requests);
    expect(spans.map((span) => span.name).sort()).toEqual([
      'http.server.request',
      'worker.turn.dispatch',
    ]);
    const http = spans.find((span) => span.name === 'http.server.request')!;
    const dispatch = spans.find((span) => span.name === 'worker.turn.dispatch')!;
    expect(http.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(http.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(dispatch.traceId).toBe(http.traceId);
    expect(dispatch.parentSpanId).toBe(http.spanId);
    expect(headers.traceparent).toBe(`00-${dispatch.traceId}-${dispatch.spanId}-01`);
    expect(http.attributes).toEqual(
      expect.arrayContaining([
        { key: 'http.route', value: { stringValue: '/items/:id' } },
        { key: 'http.response.status_code', value: { intValue: 201 } },
      ])
    );
    expect(dispatch.attributes).toContainEqual({
      key: 'openkit.turn.id',
      value: { stringValue: TURN_ID },
    });
    for (const request of requests) {
      for (const group of request.resourceSpans) {
        expect(group.resource.attributes).toEqual(
          expect.arrayContaining([
            { key: 'service.name', value: { stringValue: 'nanocore' } },
            { key: 'service.instance.id', value: { stringValue: BOOT_ID } },
          ])
        );
      }
    }
    const bytes = (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('');
    for (const canary of [
      'resource-host-canary',
      'foreign-content-canary',
      'foreign-secret-canary',
      'path-canary',
      'query-canary',
      'credential-canary',
      'header-canary',
      'prompt-content-canary',
      'response-content-canary',
      root,
    ])
      expect(bytes).not.toContain(canary);
    for (const file of files) expect((await fs.stat(file)).mode & 0o077).toBe(0);
  });

  it('writes the same span model as the lock-matched public stock JSON serializer', async () => {
    const exporter = new InMemorySpanExporter();
    const exported = vi.spyOn(exporter, 'export');
    start({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, exporter);
    expect((await productApp().request('/items/one', { method: 'POST' })).status).toBe(201);
    await shutdownTelemetry();
    const sdkSpans = exported.mock.calls.flatMap(([spans]) => spans);
    expect(sdkSpans).toHaveLength(2);
    const local = await readRequests(await segmentFiles());
    expect(requestSpans(local)).toHaveLength(2);
    for (const span of sdkSpans) {
      const stock = JSON.parse(
        Buffer.from(JsonTraceSerializer.serializeRequest([span])).toString('utf8')
      ) as TraceRequest;
      expect(requestSpans(local)).toContainEqual(requestSpans([stock])[0]);
      expect(
        local.flatMap((request) => request.resourceSpans.map((group) => group.resource))
      ).toContainEqual(stock.resourceSpans[0]?.resource);
    }
  });

  it('disables local and external capture together without changing product outcome or cleanup', async () => {
    const exporter = new InMemorySpanExporter();
    const exported = vi.spyOn(exporter, 'export');
    start({ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, exporter);
    const cleanup = vi.fn();
    const failure = new Error('product-failure-canary');
    const work = withTurnDispatchTelemetry(TURN_ID, async () => {
      try {
        throw failure;
      } finally {
        cleanup();
      }
    });
    await expect(work).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await productApp().request('/items/one', { method: 'POST' })).status).toBe(201);
    expect(captureTelemetryContext()).toBeUndefined();
    await shutdownTelemetry();
    expect(exported).not.toHaveBeenCalled();
    expect(await segmentFiles()).toEqual([]);
  });

  it('retains local requests when the optional external exporter refuses every batch', async () => {
    const exporter = new InMemorySpanExporter();
    const refused = vi
      .spyOn(exporter, 'export')
      .mockImplementation((_spans, done) => done({ code: 1 }));
    start({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, exporter);
    const response = await productApp().request('/items/one', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, result: 'response-content-canary' });
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(refused).toHaveBeenCalled();
    expect(requestSpans(await readRequests(await segmentFiles()))).toHaveLength(2);
  });

  it('accepts a 1 MiB request before newline and drops a request one byte larger', async () => {
    // Size is derived from stock serialization of the real SDK producer, never from sink constants.
    const calibration = new InMemorySpanExporter();
    const calibrated = vi.spyOn(calibration, 'export');
    start({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, calibration);
    withTurnDispatchTelemetry('x', () => {});
    await shutdownTelemetry();
    const oneByte = calibrated.mock.calls.flatMap(([spans]) => spans);
    expect(oneByte).toHaveLength(1);
    const overhead = JsonTraceSerializer.serializeRequest(oneByte).byteLength - 1;
    const initialFiles = new Set(await segmentFiles());

    for (const extra of [0, 1]) {
      const exporter = new InMemorySpanExporter();
      const exported = vi.spyOn(exporter, 'export');
      start({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, exporter);
      withTurnDispatchTelemetry('x'.repeat(REQUEST_LIMIT - overhead + extra), () => {});
      await shutdownTelemetry();
      const spans = exported.mock.calls.flatMap(([batch]) => batch);
      expect(JsonTraceSerializer.serializeRequest(spans).byteLength).toBe(REQUEST_LIMIT + extra);
      const files = (await segmentFiles()).filter((file) => !initialFiles.has(file));
      const lines = (await Promise.all(files.map((file) => fs.readFile(file)))).filter(
        (bytes) => bytes.length > 0
      );
      if (extra === 0) {
        expect(
          lines.map((bytes) => bytes.length),
          'the boundary request includes exactly one extra newline byte'
        ).toEqual([REQUEST_LIMIT + 1]);
        expect(requestSpans(await readRequests(files))[0]?.attributes).toContainEqual({
          key: 'openkit.turn.id',
          value: { stringValue: 'x'.repeat(REQUEST_LIMIT - overhead) },
        });
      } else {
        expect(lines, 'oversize requests must not be truncated or split').toEqual([]);
      }
      for (const file of files) initialFiles.add(file);
    }
  });

  it('enforces the combined cap by pruning old segments, not unrelated retained bytes', async () => {
    const retained = join(root, 'canonical-record.json');
    await fs.writeFile(retained, 'retained-content-canary');
    const cap = 9_000;
    const filesByBoot: string[][] = [];
    for (let boot = 0; boot < 3; boot++) {
      start({ OPENKIT_TELEMETRY_LOCAL_MAX_BYTES: String(cap) });
      withTurnDispatchTelemetry(`turn-${boot}-${'x'.repeat(4_000)}`, () => {});
      await shutdownTelemetry();
      const files = await segmentFiles();
      expect(files.length, 'each admissible batch must produce local bytes').toBeGreaterThan(0);
      const sizes = await Promise.all(files.map(async (file) => (await fs.stat(file)).size));
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(cap);
      expect(
        requestSpans(await readRequests(files)).some((span) =>
          span.attributes.some(
            (attribute) =>
              attribute.key === 'openkit.turn.id' &&
              JSON.stringify(attribute.value).includes(`turn-${boot}-`)
          )
        )
      ).toBe(true);
      filesByBoot.push(files);
    }
    expect(filesByBoot[2]).not.toContain(filesByBoot[0]?.[0]);
    expect(await fs.readFile(retained, 'utf8')).toBe('retained-content-canary');
  });

  it('prunes expired files at startup even without a new product request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    start({ OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS: '60' });
    withTurnDispatchTelemetry(TURN_ID, () => {});
    await shutdownTelemetry();
    const old = await segmentFiles();
    expect(requestSpans(await readRequests(old))).toHaveLength(1);
    vi.setSystemTime(now + 61_000);
    start({ OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS: '60' });
    await shutdownTelemetry();
    for (const file of old) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'sink',
    'ancestor',
  ] as const)('preserves external bytes during idle cleanup after rejecting a pre-existing %s symlink', async (linkAt) => {
    start();
    withTurnDispatchTelemetry('turn-idle-confinement', () => {});
    await shutdownTelemetry();
    const produced = await segmentFiles();
    expect(requestSpans(await readRequests(produced))).toHaveLength(1);
    expect(produced).toHaveLength(1);
    const segment = produced[0]!;
    const bytes = await fs.readFile(segment);
    const sink = dirname(segment);
    await fs.unlink(segment);

    // Establish a live idle-pruning control, using a real producer's filename and bytes.
    // Seed only after startup has read an empty directory, so startup cannot satisfy it.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scans = vi.spyOn(fs, 'readdir');
    const env = { OPENKIT_TELEMETRY_LOCAL_MAX_AGE_SECONDS: '1' };
    start(env);
    await vi.waitFor(() => {
      expect(scans).toHaveBeenCalledWith(sink, { withFileTypes: true });
    });
    const scanIndex = scans.mock.calls.findIndex(([path]) => path === sink);
    const startupScan = scans.mock.results[scanIndex]!;
    expect(startupScan.type).toBe('return');
    expect(await startupScan.value).toEqual([]);
    await fs.writeFile(segment, bytes);
    await fs.utimes(segment, new Date(0), new Date(0));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => {
      await expect(fs.stat(segment)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await shutdownTelemetry();

    const outside = join(root, 'outside');
    const externalSink = linkAt === 'sink' ? outside : join(outside, relative(logDirectory, sink));
    await fs.mkdir(externalSink, { recursive: true });
    const externalSegment = join(externalSink, basename(segment));
    await fs.writeFile(externalSegment, bytes);
    await fs.utimes(externalSegment, new Date(0), new Date(0));
    const linkedPath = linkAt === 'sink' ? sink : logDirectory;
    await fs.rm(linkedPath, { recursive: true });
    await fs.symlink(outside, linkedPath, 'dir');
    expect((await fs.lstat(linkedPath)).isSymbolicLink()).toBe(true);

    const warnings = vi.mocked(console.warn).mockClear();
    start(env);
    await vi.waitFor(() => expect(warnings).toHaveBeenCalled());
    expect(await fs.readFile(externalSegment), 'startup refusal preserves external bytes').toEqual(
      bytes
    );
    // No export or path replacement occurs while this instance runs.
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdownTelemetry();
    const retained = await fs.readFile(externalSegment).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    expect(retained, 'idle cleanup must preserve exact bytes beyond the rejected symlink').toEqual(
      bytes
    );
  });

  it.each([
    'bytes',
    'inodes',
    'unknown',
  ] as const)('drops below-cap batches when filesystem headroom is unsafe: %s', async (failure) => {
    start();
    withTurnDispatchTelemetry('turn-before-pressure', () => {});
    await shutdownTelemetry();
    expect(
      requestSpans(await readRequests(await segmentFiles())),
      'healthy capture is the positive control'
    ).toHaveLength(1);
    const checked = vi
      .mocked(fs.statfs)
      .mockClear()
      .mockImplementation(async (...args) => {
        if (failure === 'unknown')
          throw Object.assign(new Error('filesystem unavailable'), { code: 'EIO' });
        const result = await finiteFilesystemStats(...args);
        const zero = typeof result.bavail === 'bigint' ? 0n : 0;
        if (failure === 'bytes') return Object.assign(result, { bavail: zero, bfree: zero });
        // A positive finite total distinguishes exhaustion from absent inode accounting.
        return Object.assign(result, { ffree: zero });
      });
    start();
    expect((await productApp().request('/items/one', { method: 'POST' })).status).toBe(201);
    await shutdownTelemetry();
    expect(
      checked,
      'admission must inspect the actual filesystem, not just the telemetry cap'
    ).toHaveBeenCalled();
    const requests = await readRequests(await segmentFiles());
    expect(requestSpans(requests).some((span) => span.name === 'http.server.request')).toBe(false);
  });

  it('applies only the byte reserve when the filesystem reports no inode limit', async () => {
    const checked = vi.mocked(fs.statfs).mockImplementation(async (...args) => {
      const result = await finiteFilesystemStats(...args);
      const zero = typeof result.bavail === 'bigint' ? 0n : 0;
      return Object.assign(result, { files: zero, ffree: zero });
    });
    start();
    expect((await productApp().request('/items/one', { method: 'POST' })).status).toBe(201);
    await shutdownTelemetry();
    expect(checked).toHaveBeenCalled();
    const requests = await readRequests(await segmentFiles());
    expect(requestSpans(requests).some((span) => span.name === 'http.server.request')).toBe(true);
    checked.mockImplementation(async (...args) => {
      const result = await finiteFilesystemStats(...args);
      const zero = typeof result.bavail === 'bigint' ? 0n : 0;
      return Object.assign(result, { files: zero, ffree: zero, bavail: zero, bfree: zero });
    });
    start();
    withTurnDispatchTelemetry('turn-unreported-inodes-no-bytes', () => {});
    await shutdownTelemetry();
    expect(JSON.stringify(await readRequests(await segmentFiles()))).not.toContain(
      'turn-unreported-inodes-no-bytes'
    );
  });

  it('reads the existing reserve and drops on low or unknown allowance', async () => {
    const reserve = vi.fn(() => 1_000_000_000);
    const options = { bootId: BOOT_ID, env: {}, logDirectory, readReserveBytes: reserve };
    startTelemetry(options);
    withTurnDispatchTelemetry('turn-before-reserve-change', () => {});
    await shutdownTelemetry();
    expect(requestSpans(await readRequests(await segmentFiles()))).toHaveLength(1);
    expect(reserve).toHaveBeenCalled();
    for (const value of [Number.MAX_SAFE_INTEGER, Number.NaN]) {
      reserve.mockReturnValue(value);
      startTelemetry(options);
      withTurnDispatchTelemetry('turn-reserve-refused', () => {});
      await shutdownTelemetry();
      expect(JSON.stringify(await readRequests(await segmentFiles()))).not.toContain(
        'turn-reserve-refused'
      );
    }
  });

  it('starts a fresh segment after restart rather than appending behind a truncated fragment', async () => {
    start();
    withTurnDispatchTelemetry('turn-before-restart', () => {});
    await shutdownTelemetry();
    const old = await segmentFiles();
    expect(old).toHaveLength(1);
    const file = old[0]!;
    await fs.appendFile(file, '{"resourceSpans":');
    const torn = await fs.readFile(file);
    start();
    withTurnDispatchTelemetry('turn-after-restart', () => {});
    await shutdownTelemetry();
    expect(await fs.readFile(file)).toEqual(torn);
    const fresh = (await segmentFiles()).filter((path) => path !== file);
    expect(fresh).toHaveLength(1);
    expect(JSON.stringify(await readRequests(fresh))).toContain('turn-after-restart');
    expect(JSON.stringify(await readRequests(fresh))).not.toContain('turn-before-restart');
  });

  it('keeps product return, rejection and cleanup independent of a deleted or unwritable sink', async () => {
    start();
    withTurnDispatchTelemetry('turn-before-deletion', () => {});
    await shutdownTelemetry();
    const files = await segmentFiles();
    expect(requestSpans(await readRequests(files))).toHaveLength(1);
    await fs.rm(logDirectory, { recursive: true });
    await fs.mkdir(logDirectory, { mode: 0o500 });
    start();
    const result = Promise.resolve({ accepted: true });
    expect(withTurnDispatchTelemetry(TURN_ID, () => result)).toBe(result);
    const cleanup = vi.fn();
    const failure = new Error('owned-product-failure');
    await expect(
      withTurnDispatchTelemetry(TURN_ID, async () => {
        try {
          throw failure;
        } finally {
          cleanup();
        }
      })
    ).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await productApp().request('/items/one', { method: 'POST' })).status).toBe(201);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(await segmentFiles(), 'unwritable capture must not prevent product settlement').toEqual(
      []
    );
    await fs.chmod(logDirectory, 0o700);
    start();
    withTurnDispatchTelemetry('turn-after-permission-restored', () => {});
    await shutdownTelemetry();
    expect(JSON.stringify(await readRequests(await segmentFiles()))).toContain(
      'turn-after-permission-restored'
    );
  });
});

/**
 * Supplies explicit finite capacity, not a claim about the fixture's backing filesystem.
 * Btrfs reports files=ffree=0 (no inode limit); that case has its own byte-only regression.
 * Only statfs capacity is doubled. Paths, permissions, appends, pruning and reads stay real.
 */
async function finiteFilesystemStats(...args: Parameters<typeof fs.statfs>) {
  const stats = await readFilesystemStats(...args);
  const capacity = {
    type: 0xef53, // Linux ext-family finite inode accounting, not a Btrfs policy exception.
    bsize: 4096,
    blocks: 1_048_576,
    bfree: 1_048_576,
    bavail: 1_048_576,
    files: 1_000_000,
    ffree: 900_000,
  };
  return Object.assign(
    stats,
    typeof stats.bsize === 'bigint'
      ? Object.fromEntries(Object.entries(capacity).map(([key, value]) => [key, BigInt(value)]))
      : capacity
  );
}

/** Adds only the agreed composition inputs; the variable also typechecks against unchanged main. */
function start(env: NodeJS.ProcessEnv = {}, exporter?: InMemorySpanExporter): void {
  const options = {
    bootId: BOOT_ID,
    env,
    ...(exporter ? { exporter } : {}),
    logDirectory,
    readReserveBytes: () => 1_000_000_000,
  };
  startTelemetry(options);
}

/** Composes real HTTP and dispatch producers, with a product-owned response and optional callback. */
function productApp(dispatch: () => void = () => {}): Hono {
  const app = new Hono();
  app.use(createHttpTelemetryMiddleware());
  app.post('/items/:id', async (c) => {
    await c.req.text();
    return withTurnDispatchTelemetry(TURN_ID, () => {
      dispatch();
      return c.json({ ok: true, result: 'response-content-canary' }, 201);
    });
  });
  return app;
}

/** Enumerates only this fixture's log subtree, without imposing a production filename convention. */
async function segmentFiles(directory = logDirectory): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await segmentFiles(path)));
    else {
      expect(entry.isFile(), 'the sink must not introduce symlinks or special files').toBe(true);
      files.push(path);
    }
  }
  return files.sort();
}

/** Parses complete UTF-8 export requests with standard JSON, checking framing before shape. */
async function readRequests(files: string[]): Promise<TraceRequest[]> {
  const requests: TraceRequest[] = [];
  for (const file of files) {
    const bytes = await fs.readFile(file);
    if (bytes.length === 0) continue;
    expect(bytes.at(-1), 'each complete request ends with one newline').toBe(10);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const line of text.slice(0, -1).split('\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(REQUEST_LIMIT);
      const request = JSON.parse(line) as TraceRequest;
      expect(Object.keys(request)).toEqual(['resourceSpans']);
      expect(Array.isArray(request.resourceSpans)).toBe(true);
      requests.push(request);
    }
  }
  return requests;
}

/** Selects standard span fields for assertions; this is not an OTLP decoder. */
function requestSpans(requests: TraceRequest[]) {
  return requests.flatMap((request) =>
    request.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
  );
}
