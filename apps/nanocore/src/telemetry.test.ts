import { createServer, type IncomingMessage } from 'node:http';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpTelemetryMiddleware,
  resolveTelemetryConfiguration,
  shutdownTelemetry,
  startTelemetry,
  tracesExportUrl,
} from './telemetry.js';

const VALID_ENDPOINT = 'http://127.0.0.1:4318';
const TEST_BOOT_ID = 'boot_telemetry-instance';

afterEach(async () => {
  await shutdownTelemetry();
  vi.restoreAllMocks();
});

describe('process.telemetry configuration', () => {
  it('treats absent and malformed endpoints as disabled and unconfigured', () => {
    expect(resolveTelemetryConfiguration({})).toEqual({
      enabled: false,
      exportConfigured: false,
    });
    expect(resolveTelemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toEqual({
      enabled: false,
      exportConfigured: false,
    });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://user:pass@127.0.0.1:4318',
      })
    ).toEqual({ enabled: false, exportConfigured: false });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318?q=1',
      })
    ).toEqual({ enabled: false, exportConfigured: false });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318#frag',
      })
    ).toEqual({ enabled: false, exportConfigured: false });
  });

  it('enables only when the base endpoint is valid and the SDK is not disabled', () => {
    expect(resolveTelemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT })).toEqual({
      enabled: true,
      exportConfigured: true,
    });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT,
        OTEL_SDK_DISABLED: 'TRUE',
      })
    ).toEqual({ enabled: false, exportConfigured: true });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=secret-token',
      })
    ).toEqual({ enabled: false, exportConfigured: true });
    expect(
      resolveTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'X-Trace-Secret=tracetoken',
      })
    ).toEqual({ enabled: false, exportConfigured: true });
  });

  it('appends the stock traces suffix to the base OTLP endpoint', () => {
    expect(tracesExportUrl(VALID_ENDPOINT)).toBe(`${VALID_ENDPOINT}/v1/traces`);
    expect(tracesExportUrl(`${VALID_ENDPOINT}/`)).toBe(`${VALID_ENDPOINT}/v1/traces`);
  });
});

describe('telemetry lifecycle', () => {
  it('records HTTP handoff spans without caller headers, URLs, or host paths', async () => {
    const exporter = new InMemorySpanExporter();
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    startTelemetry({
      bootId: TEST_BOOT_ID,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT },
      exporter,
    });
    const app = httpApp();
    const response = await app.request('/items/abc?secret=1', {
      headers: { 'x-openkit-request-id': 'untrusted-caller-header' },
    });

    expect(response.status).toBe(200);
    const span = soleSpan(exporter);
    expect(span.name).toBe('http.server.request');
    expect(span.attributes['http.request.method']).toBe('GET');
    expect(span.attributes['http.route']).toBe('/items/:id');
    expect(span.attributes['http.response.status_code']).toBe(200);
    expect(span.attributes['openkit.http.response_phase']).toBe('handoff');
    expect(span.resource.attributes['service.name']).toBe('nanocore');
    expect(span.resource.attributes['service.instance.id']).toBe(TEST_BOOT_ID);
    expect(span.attributes).not.toHaveProperty('openkit.request_id');
    expect(JSON.stringify(span.attributes)).not.toContain('untrusted-caller-header');
    expect(JSON.stringify(span.attributes)).not.toContain('/items/abc');
    expect(JSON.stringify(span.attributes)).not.toContain('secret=1');
    expect(logs).toEqual([
      `nanocore http.server.request method=GET route=/items/:id status=200 phase=handoff trace_id=${span.spanContext().traceId}`,
    ]);
  });

  it('uses the fixed unknown route label when no template matched', async () => {
    const exporter = new InMemorySpanExporter();
    startTelemetry({
      bootId: TEST_BOOT_ID,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT },
      exporter,
    });
    const app = httpApp();
    for (const path of ['/missing', '/api/not-a-cataloged-operation', '/v1/not-a-gateway-route']) {
      exporter.reset();
      const response = await app.request(path);
      expect(response.status).toBe(404);
      const span = soleSpan(exporter);
      expect(span.attributes['http.route']).toBe('unknown');
      expect(JSON.stringify(span.attributes)).not.toContain(path);
      expect(JSON.stringify(span.attributes)).not.toContain('/api/*');
      expect(JSON.stringify(span.attributes)).not.toContain('/v1/*');
    }
    exporter.reset();
    const matched = await app.request('/api/items/abc');
    expect(matched.status).toBe(200);
    expect(soleSpan(exporter).attributes['http.route']).toBe('/api/items/:id');
  });

  it('does not export spans after shutdown and records again after a later start', async () => {
    const first = new InMemorySpanExporter();
    startTelemetry({
      bootId: TEST_BOOT_ID,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT },
      exporter: first,
    });
    await httpApp().request('/items/abc');
    expect(first.getFinishedSpans()).toHaveLength(1);
    await shutdownTelemetry();

    const disabled = new InMemorySpanExporter();
    expect(
      startTelemetry({
        bootId: TEST_BOOT_ID,
        env: {},
        exporter: disabled,
      })
    ).toEqual({ enabled: false, exportConfigured: false });
    await httpApp().request('/items/abc');
    expect(disabled.getFinishedSpans()).toEqual([]);

    const restarted = new InMemorySpanExporter();
    startTelemetry({
      bootId: TEST_BOOT_ID,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT },
      exporter: restarted,
    });
    await httpApp().request('/items/abc');
    expect(restarted.getFinishedSpans()).toHaveLength(1);
  });

  it('keeps product requests succeeding when export fails', async () => {
    startTelemetry({
      bootId: TEST_BOOT_ID,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT },
      exporter: failingExporter(),
    });
    const response = await httpApp().request('/items/abc');
    expect(response.status).toBe(200);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('disables telemetry when exporter header env is nonempty without leaking values', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const exporter = new InMemorySpanExporter();
    expect(
      startTelemetry({
        bootId: TEST_BOOT_ID,
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: VALID_ENDPOINT,
          OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=secret-token',
        },
        exporter,
      })
    ).toEqual({ enabled: false, exportConfigured: true });
    await httpApp().request('/items/abc');
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(warnings).toEqual([
      'Telemetry export is disabled because OTEL_EXPORTER_OTLP_HEADERS is unsupported.',
    ]);
    expect(warnings.join('\n')).not.toContain('secret-token');
  });

  it('exports to /v1/traces with NanoCore boot identity and does not inherit env resource maps', async () => {
    const captured: Array<{
      authorization?: string;
      body: string;
      url?: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        captured.push({
          authorization: headerValue(request, 'authorization'),
          body: Buffer.concat(chunks).toString('utf8'),
          url: request.url,
        });
        response.writeHead(200);
        response.end();
      });
    });
    const port = await listen(server);
    const previous = snapshotEnv([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'OTEL_RESOURCE_ATTRIBUTES',
      'OTEL_SDK_DISABLED',
    ]);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'host.name=leaked.example';
    delete process.env.OTEL_SDK_DISABLED;
    try {
      startTelemetry({ bootId: TEST_BOOT_ID });
      await httpApp().request('/items/abc', {
        headers: { 'x-openkit-request-id': 'untrusted-caller-header' },
      });
      await shutdownTelemetry();
      await waitFor(() => captured.length > 0);
    } finally {
      restoreEnv(previous);
      server.close();
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('/v1/traces');
    expect(captured[0]?.authorization).toBeUndefined();
    expect(captured[0]?.body).toContain('service.name');
    expect(captured[0]?.body).toContain('nanocore');
    expect(captured[0]?.body).toContain('service.instance.id');
    expect(captured[0]?.body).toContain(TEST_BOOT_ID);
    expect(captured[0]?.body).not.toContain('unknown_service');
    expect(captured[0]?.body).not.toContain('leaked.example');
    expect(captured[0]?.body).not.toContain('untrusted-caller-header');
    expect(captured[0]?.body).not.toContain('host.name');
  });
});

/** Creates one Hono app with HTTP telemetry plus the real wildcard middleware mounts. */
function httpApp(): Hono {
  const app = new Hono();
  app.use(createHttpTelemetryMiddleware());
  app.use('/api/*', async (_c, next) => next());
  app.use('/v1/*', async (_c, next) => next());
  app.get('/items/:id', (c) => c.json({ ok: true }));
  app.get('/api/items/:id', (c) => c.json({ ok: true }));
  return app;
}

/** Returns the single finished span. */
function soleSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  const span = spans[0];
  expect(span).toBeDefined();
  return span as ReadableSpan;
}

/** Creates an exporter that fails both export and shutdown. */
function failingExporter(): SpanExporter {
  return {
    export(_spans, resultCallback) {
      resultCallback({ code: 1 });
    },
    shutdown: () => Promise.reject(new Error('otlp unavailable')),
  };
}

/** Reads one optional request header. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Starts an HTTP server on an ephemeral loopback port. */
function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('loopback server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Waits until a condition is true or the timeout elapses. */
async function waitFor(isReady: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!isReady()) {
    if (Date.now() >= deadline) {
      throw new Error('OTLP export was not observed');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Copies named env values for later restore. */
function snapshotEnv(names: readonly string[]): Array<readonly [string, string | undefined]> {
  return names.map((name) => [name, process.env[name]]);
}

/** Restores named env values from a snapshot. */
function restoreEnv(entries: Array<readonly [string, string | undefined]>): void {
  for (const [name, value] of entries) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
