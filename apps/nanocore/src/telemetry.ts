import { SpanKind, type Tracer, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { MiddlewareHandler } from 'hono';

/** Nested process.telemetry flags describing local configuration only. */
export interface TelemetryConfiguration {
  /** True when export is admitted and no unsupported header env is set. */
  readonly enabled: boolean;
  /** True when OTEL_EXPORTER_OTLP_ENDPOINT is an admitted absolute HTTP(S) URL. */
  readonly exportConfigured: boolean;
}

const UNKNOWN_HTTP_ROUTE = 'unknown';
const HTTP_RESPONSE_HANDOFF = 'handoff';
const TRACES_PATH = 'v1/traces';
const SERVICE_NAME = 'nanocore';
const MAX_QUEUE_SIZE = 512;
const EXPORT_TIMEOUT_MS = 1_000;
const HEADER_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
] as const;
const INVALID_ENDPOINT_DIAGNOSTIC =
  'Telemetry export is disabled because OTEL_EXPORTER_OTLP_ENDPOINT is not a valid HTTP(S) URL.';
const START_FAILURE_DIAGNOSTIC = 'Telemetry export could not start; product boot continues.';

let activeProvider: NodeTracerProvider | null = null;

/**
 * Resolves nested process.telemetry truth conditions from standard OTEL env vars.
 *
 * @param env Process environment, defaulting to the current process.
 * @returns Local configuration flags that do not claim successful delivery.
 */
export function resolveTelemetryConfiguration(
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfiguration {
  const exportConfigured = isValidOtlpEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const sdkDisabled = env.OTEL_SDK_DISABLED?.toLowerCase() === 'true';
  return {
    exportConfigured,
    enabled: exportConfigured && !sdkDisabled && unsupportedExporterHeaderName(env) === undefined,
  };
}

/**
 * Builds the standard traces export URL from a validated OTEL_EXPORTER_OTLP_ENDPOINT base.
 *
 * @param endpoint Admitted absolute HTTP(S) base endpoint without query or fragment.
 * @returns Endpoint with the stock `/v1/traces` suffix.
 */
export function tracesExportUrl(endpoint: string): string {
  return endpoint.endsWith('/') ? `${endpoint}${TRACES_PATH}` : `${endpoint}/${TRACES_PATH}`;
}

/**
 * Starts the optional stock OpenTelemetry lifecycle when export is admitted.
 *
 * Malformed endpoints or unsupported header env disable export with one product-safe
 * diagnostic. Injected exporters are used only when configuration is enabled.
 * Exporter construction failure does not prevent product boot.
 *
 * @param options Existing boot id, optional env override, and test exporter.
 * @returns The resolved process.telemetry configuration.
 */
export function startTelemetry(options: {
  bootId: string;
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter;
}): TelemetryConfiguration {
  if (activeProvider) {
    throw new Error('Telemetry is already started.');
  }

  const env = options.env ?? process.env;
  const configuration = resolveTelemetryConfiguration(env);
  const rawEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const unsupportedHeader = unsupportedExporterHeaderName(env);
  if (hasPresentEndpoint(rawEndpoint) && !configuration.exportConfigured) {
    console.warn(INVALID_ENDPOINT_DIAGNOSTIC);
  } else if (
    configuration.exportConfigured &&
    unsupportedHeader !== undefined &&
    env.OTEL_SDK_DISABLED?.toLowerCase() !== 'true'
  ) {
    console.warn(`Telemetry export is disabled because ${unsupportedHeader} is unsupported.`);
  }
  if (!configuration.enabled || !hasPresentEndpoint(rawEndpoint) || rawEndpoint === undefined) {
    return configuration;
  }

  try {
    const exporter =
      options.exporter ??
      new OTLPTraceExporter({
        url: tracesExportUrl(rawEndpoint),
      });
    const processor = options.exporter
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, {
          maxQueueSize: MAX_QUEUE_SIZE,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': SERVICE_NAME,
        'service.instance.id': options.bootId,
      }),
      spanProcessors: [processor],
    });
    provider.register();
    activeProvider = provider;
  } catch {
    console.warn(START_FAILURE_DIAGNOSTIC);
  }
  return configuration;
}

/**
 * Makes one bounded best-effort flush and clears the global tracer provider.
 * Exporter failure does not throw.
 */
export async function shutdownTelemetry(): Promise<void> {
  const provider = activeProvider;
  activeProvider = null;
  try {
    if (provider) {
      await provider.shutdown();
    }
  } catch {
    console.warn('Telemetry shutdown flush failed; product shutdown continues.');
  } finally {
    trace.disable();
  }
}

/**
 * Records bounded HTTP-boundary spans without URL, query, body, header, or error leakage.
 *
 * Product handlers do not branch on telemetry enablement; a no-op tracer is used when disabled.
 * Correlation uses the server-owned span trace id, not caller header bytes.
 *
 * @returns Hono middleware that ends the span at response handoff.
 */
export function createHttpTelemetryMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const span = telemetryTracer().startSpan('http.server.request', {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': c.req.method,
      },
    });

    try {
      await next();
      recordHttpHandoff(span, c.req.method, c.req.matchedRoutes, c.res.status);
    } catch (error) {
      recordHttpHandoff(span, c.req.method, c.req.matchedRoutes, c.res.status || 500);
      throw error;
    }
  };
}

/** Returns the first nonempty unsupported exporter-header env var name. */
function unsupportedExporterHeaderName(env: NodeJS.ProcessEnv): string | undefined {
  return HEADER_ENV_VARS.find((name) => hasPresentEndpoint(env[name]));
}

/** Returns whether an env value is present for endpoint validation. */
function hasPresentEndpoint(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Returns whether one endpoint is an admitted absolute HTTP(S) URL. */
function isValidOtlpEndpoint(value: string | undefined): boolean {
  if (!hasPresentEndpoint(value) || value === undefined) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** Returns the process tracer, which is a no-op when telemetry is disabled. */
function telemetryTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

/** Ends the HTTP span at response handoff and emits one product-safe correlated diagnostic. */
function recordHttpHandoff(
  span: ReturnType<Tracer['startSpan']>,
  method: string,
  matchedRoutes: readonly { path: string }[],
  status: number
): void {
  const route = matchedRouteTemplate(matchedRoutes);
  span.setAttribute('http.route', route);
  span.setAttribute('http.response.status_code', status);
  span.setAttribute('openkit.http.response_phase', HTTP_RESPONSE_HANDOFF);
  if (span.isRecording()) {
    const { traceId } = span.spanContext();
    console.info(
      `nanocore http.server.request method=${method} route=${route} status=${status} phase=${HTTP_RESPONSE_HANDOFF} trace_id=${traceId}`
    );
  }
  span.end();
}

/** Returns the last concrete matched route template, or the fixed unknown label. */
function matchedRouteTemplate(matchedRoutes: readonly { path: string }[]): string {
  const templates = matchedRoutes
    .map((route) => route.path)
    .filter((path) => path.length > 0 && !path.endsWith('/*'));
  return templates.at(-1) ?? UNKNOWN_HTTP_ROUTE;
}
