import {
  type Context,
  type Histogram,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { MiddlewareHandler } from 'hono';
import { createLocalTraceExporter } from './telemetry-local-exporter.js';

/** Nested process.telemetry flags describing local configuration only. */
export interface TelemetryConfiguration {
  /** True when private SDK capture is configured; it does not claim destination delivery. */
  readonly enabled: boolean;
  /** True when OTEL_EXPORTER_OTLP_ENDPOINT is an admitted absolute HTTP(S) URL. */
  readonly exportConfigured: boolean;
}

const UNKNOWN_HTTP_ROUTE = 'unknown';
const HTTP_RESPONSE_HANDOFF = 'handoff';
const TRACES_PATH = 'v1/traces';
const STAGE_DURATION_METRIC = 'openkit.turn.stage.duration';
const STAGE_DIMENSIONS = [
  'openkit.lifecycle.stage',
  'openkit.outcome.class',
  'openkit.worker.kind',
];
// Milliseconds through the current 25-minute preparation limit, expressed in seconds.
const STAGE_BUCKETS = [
  0, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1500,
];
const RELEASE_WORKER_KINDS = new Set(['codex', 'pi', 'opencode', 'claude-code', 'internal']);
const SERVICE_NAME = 'nanocore';
const MAX_QUEUE_SIZE = 512;
const EXPORT_TIMEOUT_MS = 1_000;
const HEADER_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
] as const;
const INVALID_ENDPOINT_DIAGNOSTIC =
  'Telemetry export is disabled because OTEL_EXPORTER_OTLP_ENDPOINT is not a valid HTTP(S) URL.';
const START_FAILURE_DIAGNOSTIC = 'Telemetry export could not start; product boot continues.';

let activeProvider: NodeTracerProvider | null = null;
let activeMeterProvider: MeterProvider | null = null;
let stageDuration: Histogram | null = null;
let activeContextManager: AsyncLocalStorageContextManager | null = null;
const traceContextPropagator = new W3CTraceContextPropagator();

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
    enabled: !sdkDisabled,
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
 * Starts private SDK capture, independently attaching local and optional external destinations.
 *
 * Only explicit product instrumentation uses this provider. Local I/O is asynchronous and disposable; invalid external settings never disable admitted local capture.
 * @param options Existing boot/log identity, live reserve reader, and optional test exporter.
 * @returns Configuration intent, never successful delivery.
 */
export function startTelemetry(options: {
  bootId: string;
  logDirectory?: string;
  readReserveBytes?: () => number;
  serviceVersion?: string | undefined;
  deploymentEnvironment?: 'local' | 'server' | 'test' | undefined;
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter;
}): TelemetryConfiguration {
  if (activeProvider) throw new Error('Telemetry is already started.');
  const env = options.env ?? process.env;
  const configuration = resolveTelemetryConfiguration(env);
  const rawEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const unsupportedHeader = unsupportedExporterHeaderName(env);
  if (hasPresentEndpoint(rawEndpoint) && !configuration.exportConfigured) {
    console.warn(INVALID_ENDPOINT_DIAGNOSTIC);
  } else if (
    configuration.exportConfigured &&
    unsupportedHeader !== undefined &&
    configuration.enabled
  ) {
    console.warn(`Telemetry export is disabled because ${unsupportedHeader} is unsupported.`);
  }
  if (!configuration.enabled) return configuration;

  const processors: (SimpleSpanProcessor | BatchSpanProcessor)[] = [];
  const metricExporters: PushMetricExporter[] = [];
  if (options.logDirectory && options.readReserveBytes) {
    const local = createLocalTraceExporter({
      logDirectory: options.logDirectory,
      readReserveBytes: options.readReserveBytes,
      env,
    });
    if (local) {
      metricExporters.push(local.metrics);
      processors.push(
        options.exporter
          ? new SimpleSpanProcessor(local)
          : new BatchSpanProcessor(local, {
              maxQueueSize: MAX_QUEUE_SIZE,
              exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            })
      );
    }
  }
  if (
    configuration.exportConfigured &&
    unsupportedHeader === undefined &&
    rawEndpoint !== undefined
  ) {
    try {
      const exporter =
        options.exporter ?? new OTLPTraceExporter({ url: tracesExportUrl(rawEndpoint) });
      processors.push(
        options.exporter
          ? new SimpleSpanProcessor(exporter)
          : new BatchSpanProcessor(exporter, {
              maxQueueSize: MAX_QUEUE_SIZE,
              exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            })
      );
    } catch {
      console.warn(START_FAILURE_DIAGNOSTIC);
    }
    // The injected trace exporter is an in-process test destination, not a network opt-in.
    if (!options.exporter) {
      try {
        metricExporters.push(
          new OTLPMetricExporter({
            url: `${rawEndpoint.replace(/\/$/, '')}/v1/metrics`,
            temporalityPreference: AggregationTemporalityPreference.DELTA,
            timeoutMillis: EXPORT_TIMEOUT_MS,
          })
        );
      } catch {
        console.warn(START_FAILURE_DIAGNOSTIC);
      }
    }
  }
  try {
    const resource = resourceFromAttributes({
      'service.name': SERVICE_NAME,
      'service.instance.id': options.bootId,
      ...(options.serviceVersion ? { 'service.version': options.serviceVersion } : {}),
      ...(options.deploymentEnvironment
        ? { 'deployment.environment.name': options.deploymentEnvironment }
        : {}),
    });
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: processors,
    });
    activeContextManager = new AsyncLocalStorageContextManager().enable();
    activeProvider = provider;
    try {
      activeMeterProvider = new MeterProvider({
        resource,
        readers: metricExporters.map(
          (exporter) =>
            new PeriodicExportingMetricReader({
              exporter,
              exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            })
        ),
        views: [
          {
            instrumentName: STAGE_DURATION_METRIC,
            attributesProcessors: [createAllowListAttributesProcessor(STAGE_DIMENSIONS)],
          },
        ],
      });
      stageDuration = activeMeterProvider
        .getMeter(SERVICE_NAME)
        .createHistogram(STAGE_DURATION_METRIC, {
          unit: 's',
          description: 'Duration of one observed Worker lifecycle operation.',
          advice: { explicitBucketBoundaries: STAGE_BUCKETS },
        });
    } catch {
      console.warn('Lifecycle metrics could not start; product execution continues.');
    }
  } catch {
    console.warn(START_FAILURE_DIAGNOSTIC);
  }
  return configuration;
}

/**
 * Makes one bounded best-effort flush and clears the installed tracer provider.
 * Exporter failure does not throw.
 */
export async function shutdownTelemetry(): Promise<void> {
  const provider = activeProvider;
  const meterProvider = activeMeterProvider;
  const contextManager = activeContextManager;
  activeProvider = null;
  activeMeterProvider = null;
  stageDuration = null;
  activeContextManager = null;
  contextManager?.disable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (provider || meterProvider) {
      await Promise.race([
        (async () => {
          // Drain metric readers before the trace provider closes their shared local writer.
          try {
            await meterProvider?.shutdown();
          } finally {
            await provider?.shutdown();
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn('Telemetry shutdown flush timed out; product shutdown continues.');
            resolve();
          }, EXPORT_TIMEOUT_MS);
        }),
      ]);
    }
  } catch {
    console.warn('Telemetry shutdown flush failed; product shutdown continues.');
  } finally {
    clearTimeout(timer);
  }
}

/** Existing awaited operation families; no admission, human-wait or durable-root lifetime is invented. */
export type LifecycleStage =
  | 'preparation'
  | 'validation'
  | 'materialization'
  | 'session.open.inspect'
  | 'turn.start.delivery'
  | 'native.run'
  | 'collection'
  | 'cleanup.release';

/** Closed diagnostic classifications, never product outcome authority. */
export type LifecycleOutcome =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timeout'
  | 'rejected'
  | 'unknown'
  | 'degraded';

/** Known Core ids and one operation classification; this is not an arbitrary attribute map. */
export interface LifecycleStageContext {
  readonly stage: LifecycleStage;
  readonly workerKind: string;
  readonly turnId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly agentSessionId?: string;
  readonly packageSnapshotId?: string;
  /** A rejected delivery wait does not prove native non-receipt or failure. */
  readonly rejectionOutcome?: LifecycleOutcome;
}

/**
 * Observes one awaited invocation without replacing its Promise, result, error or controls.
 *
 * The private active/captured context contains this span until the invocation settles. Trusted callers can attach admitted observations before settlement; ended spans are never reopened. SDK/setup/classifier/recording failures cannot suppress or retry the operation. No error content is recorded.
 * @param stage Existing operation family and known correlation, not a generated execution identity.
 * @param operation Original call, invoked exactly once.
 * @param classify Classifies returned facts; fulfillment alone need not mean success.
 * @returns The original operation Promise, including when SDK capture is disabled.
 */
export function withLifecycleStageTelemetry<T>(
  stage: LifecycleStageContext,
  operation: () => Promise<T>,
  classify?: (result: T) => LifecycleOutcome
): Promise<T> {
  const provider = activeProvider;
  const manager = activeContextManager;
  if (!provider || !manager) return operation();
  let span: Span;
  let spanContext: Context;
  let started: bigint;
  const histogram = stageDuration;
  const workerKind = RELEASE_WORKER_KINDS.has(stage.workerKind) ? stage.workerKind : 'unknown';
  try {
    const parent = manager.active();
    started = process.hrtime.bigint();
    span = provider.getTracer(SERVICE_NAME).startSpan(
      `worker.${stage.stage}`,
      {
        attributes: {
          'openkit.lifecycle.stage': stage.stage,
          'openkit.reporting.owner': 'core',
          'openkit.stage.reached': true,
          'openkit.worker.kind': workerKind,
          ...(stage.turnId ? { 'openkit.turn.id': stage.turnId } : {}),
          ...(stage.threadId ? { 'openkit.thread.id': stage.threadId } : {}),
          ...(stage.workspaceId ? { 'openkit.workspace.id': stage.workspaceId } : {}),
          ...(stage.agentSessionId ? { 'openkit.agent.session.id': stage.agentSessionId } : {}),
          ...(stage.packageSnapshotId
            ? { 'openkit.package.snapshot.id': stage.packageSnapshotId }
            : {}),
        },
      },
      parent
    );
    spanContext = trace.setSpan(parent, span);
  } catch {
    return operation();
  }
  let ended = false;
  const finish = (outcome: LifecycleOutcome): void => {
    if (ended) return;
    ended = true;
    let duration: number | undefined;
    try {
      duration = Number(process.hrtime.bigint() - started) / 1e9;
    } catch {
      /* No guessed duration. */
    }
    try {
      span.setAttribute('openkit.outcome.class', outcome);
      span.setAttribute('openkit.lifecycle.status', 'ended');
      span.setStatus({
        code:
          outcome === 'success'
            ? SpanStatusCode.OK
            : outcome === 'failure' || outcome === 'rejected' || outcome === 'timeout'
              ? SpanStatusCode.ERROR
              : SpanStatusCode.UNSET,
      });
    } catch {
      /* Diagnostics cannot change product settlement. */
    }
    try {
      span.end();
    } catch {
      /* Diagnostics cannot change product settlement. */
    }
    try {
      if (duration !== undefined && Number.isFinite(duration) && duration >= 0)
        histogram?.record(duration, {
          'openkit.lifecycle.stage': stage.stage,
          'openkit.outcome.class': outcome,
          'openkit.worker.kind': workerKind,
        });
    } catch {
      /* Diagnostics cannot change product settlement. */
    }
  };
  let invoked = false;
  let operationThrew = false;
  let operationError: unknown;
  let result: Promise<T> | undefined;
  const invoke = (): void => {
    if (invoked) return;
    invoked = true;
    try {
      result = operation();
    } catch (error) {
      operationThrew = true;
      operationError = error;
    }
  };
  try {
    manager.with(spanContext, invoke);
  } catch {
    /* Context failure before or after the callback cannot replace its result. */
  }
  if (!invoked) invoke();
  if (operationThrew) {
    finish(stage.rejectionOutcome ?? 'failure');
    throw operationError;
  }
  try {
    void result!.then(
      (value) => {
        let outcome: LifecycleOutcome = 'unknown';
        try {
          outcome = classify ? classify(value) : 'success';
        } catch {
          /* Unknown is truthful. */
        }
        finish(outcome);
      },
      () => finish(stage.rejectionOutcome ?? 'failure')
    );
  } catch {
    /* A broken observation hook cannot replace the operation Promise. */
  }
  return result!;
}

/**
 * Records bounded HTTP-boundary spans without URL, query, body, header, or error leakage.
 *
 * Product handlers do not branch on telemetry enablement; a non-recording span is used when disabled.
 * Correlation uses the server-owned span trace id, not caller header bytes.
 *
 * @returns Hono middleware that ends the span at response handoff.
 */
export function createHttpTelemetryMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const span = activeProvider
      ? activeProvider.getTracer(SERVICE_NAME).startSpan(
          'http.server.request',
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.request.method': c.req.method,
            },
          },
          ROOT_CONTEXT
        )
      : trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

    const handle = async () => {
      try {
        await next();
        recordHttpHandoff(span, c.req.method, c.req.matchedRoutes, c.res.status);
      } catch (error) {
        recordHttpHandoff(span, c.req.method, c.req.matchedRoutes, c.res.status || 500);
        throw error;
      }
    };
    return activeContextManager
      ? activeContextManager.with(trace.setSpan(ROOT_CONTEXT, span), handle)
      : handle();
  };
}

/**
 * Starts one Turn's dispatch under its private context and ends the initiation span immediately.
 * Async work keeps the ended parent context without holding a span through effect delivery waits.
 * @param turnId Existing accepted Turn identity, never minted for telemetry.
 * @param dispatch Existing dispatch invocation; its return value and errors are unchanged.
 * @returns The invocation's original result, including its unmodified Promise when asynchronous.
 */
export function withTurnDispatchTelemetry<T>(turnId: string, dispatch: () => T): T {
  const manager = activeContextManager;
  if (!activeProvider || !manager) return dispatch();
  const span = activeProvider.getTracer(SERVICE_NAME).startSpan(
    'worker.turn.dispatch',
    {
      attributes: { 'openkit.turn.id': turnId },
    },
    manager.active()
  );
  try {
    return manager.with(trace.setSpan(manager.active(), span), dispatch);
  } finally {
    span.end();
  }
}

/** Returns only the current private initiating context, without consulting global instrumentation. */
export function captureTelemetryContext(): Context | undefined {
  return activeProvider ? activeContextManager?.active() : undefined;
}

/**
 * Injects admitted stock W3C context into command response headers, outside command identity.
 * @param initiatingContext Context captured when the process-local effect was enqueued.
 * @param headers Native response header carrier; command bytes are never changed.
 */
export function injectTelemetryContext(
  initiatingContext: Context | undefined,
  headers: Record<string, string>
): void {
  if (!activeProvider || !initiatingContext) return;
  traceContextPropagator.inject(initiatingContext, headers, {
    set: (carrier, name, value) => {
      carrier[name] = value;
    },
  });
}

/**
 * Records one short accepted-result boundary using only the returned host context.
 * Invoke after ordinary first settlement; refused/deferred results and duplicate delivery do not emit spans.
 * @param headers Existing native result request headers; no header becomes a span attribute.
 */
export function recordNanoHostEffectAcceptance(headers: Headers | undefined): void {
  if (!activeProvider) return;
  try {
    const parent = headers
      ? traceContextPropagator.extract(ROOT_CONTEXT, headers, {
          keys: (carrier) => [...carrier.keys()],
          get: (carrier, name) => carrier.get(name) ?? undefined,
        })
      : ROOT_CONTEXT;
    activeProvider.getTracer(SERVICE_NAME).startSpan('nanohost.effect.accept', {}, parent).end();
  } catch {
    // Optional telemetry cannot change an already accepted product result.
  }
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

/** Ends the HTTP span at response handoff and emits one product-safe correlated diagnostic. */
function recordHttpHandoff(
  span: Span,
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
