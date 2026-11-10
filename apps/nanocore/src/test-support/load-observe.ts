/** Test-only passive client-admission and native observer handshake; never controls admission. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { loadavg } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { BroadcastChannel } from 'node:worker_threads';
import { startMainLoopObserver } from '../main-loop-observer.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { CONTROL_WORKER_LIMITS } from '../storage/control-store-worker-protocol.js';
import { classifyOutcomeError } from './load-plan.js';
import baseline from './main-loop-baseline.json' with { type: 'json' };

type LoopMetrics = { p50Ms: number; p99Ms: number; p999Ms: number; maxMs: number };
type HostLoad = { load1: number; load5: number } | null;
type LoopRecord = Readonly<Record<string, string | number>>;
const LOOP_RECORD_LIMIT = 64;

type OpenObservation = {
  entry: { route: 'compiled' | 'temporary' | 'typescript-eval'; sha256: string } | null;
  groups: Record<
    string,
    { count: number; success: number; errors: number; sumMs: number; maxMs: number }
  >;
  observerErrors: number;
};

function openCoverage(observation: OpenObservation | null, requireEntry: boolean) {
  return {
    expected: requireEntry ? ['sqlite-constructors', 'worker-entry'] : ['sqlite-constructors'],
    observed: observation,
    missing: [
      ...(!observation || !Object.values(observation.groups).some((group) => group.count > 0)
        ? ['sqlite-constructors']
        : []),
      ...(requireEntry && !observation?.entry ? ['worker-entry'] : []),
    ],
  };
}

/** Read the measurement process itself while it is still alive. */
export function observeMainOpens() {
  const observer = (
    globalThis as typeof globalThis & {
      __lopsOpen?: { snapshot: () => OpenObservation };
    }
  ).__lopsOpen;
  return openCoverage(observer?.snapshot() ?? null, false);
}

/** Boundary samples describe host contention; an unavailable sample is never quiet evidence. */
export function observeHostLoad(): HostLoad {
  try {
    const [load1, load5] = loadavg();
    return Number.isFinite(load1) && Number.isFinite(load5)
      ? { load1: load1!, load5: load5! }
      : null;
  } catch {
    return null;
  }
}

/** Absolute budgets decide quiet runs; relative changes are descriptive warnings only. */
export function mainLoopBudget(
  metrics: { [K in keyof LoopMetrics]: number | null } & { samples: number },
  host: { start: HostLoad; end: HostLoad },
  profile: string
) {
  const observed = host.start !== null && host.end !== null;
  const confounded = observed
    ? Math.max(host.start!.load1, host.start!.load5, host.end!.load1, host.end!.load5) >= 8
    : null;
  const complete =
    metrics.samples > 0 &&
    (Object.keys(baseline.metrics) as Array<keyof LoopMetrics>).every(
      (key) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key])
    );
  const exceeded = [
    ...(metrics.p99Ms !== null && metrics.p99Ms > 20 ? ['p99Ms'] : []),
    ...(metrics.p999Ms !== null && metrics.p999Ms > 50 ? ['p999Ms'] : []),
  ];
  const warnings =
    complete && profile === baseline.profile
      ? (Object.keys(baseline.metrics) as Array<keyof LoopMetrics>)
          .filter((key) => metrics[key]! > baseline.metrics[key] * 1.25)
          .map((key) => `WARN main-loop ${key} exceeds baseline by more than 25%`)
      : [];
  return {
    status:
      !observed || !complete
        ? 'NOT CHECKED'
        : confounded
          ? 'HOST CONFOUNDED'
          : exceeded.length
            ? 'FAIL'
            : 'PASS',
    confounded,
    confoundedRule: 'max(start.load1,start.load5,end.load1,end.load5) >= 8',
    absolute: { p99MaxMs: 20, p999MaxMs: 50, exceeded },
    baselineCommit: baseline.sourceCommit,
    relative:
      profile === baseline.profile && complete
        ? 'CHECKED; WARN ONLY'
        : 'NOT CHECKED; profile or samples differ',
    warnings,
  };
}

/** Reuses the load histogram and step-3 sampler; bounded overlap is not a causal attribution. */
export function observeMainLoop() {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const gaps: Array<{ startMonotonicMs: number; endMonotonicMs: number; durationMs: number }> = [];
  const observations: LoopRecord[] = [];
  let count = 0,
    droppedObservations = 0,
    observerErrors = 0;
  let previous = performance.now();
  const sampleGap = () => {
    const now = performance.now();
    if (now - previous > 100) {
      count++;
      if (gaps.length < LOOP_RECORD_LIMIT)
        gaps.push({ startMonotonicMs: previous, endMonotonicMs: now, durationMs: now - previous });
    }
    previous = now;
  };
  let sampler: ReturnType<typeof startMainLoopObserver>;
  try {
    sampler = startMainLoopObserver({
      emit(record) {
        if (record.event === 'main_loop_observation_gap') observerErrors += Number(record.count);
        if (record.event !== 'main_loop_long_task') return;
        if (observations.length < LOOP_RECORD_LIMIT) observations.push(record);
        else droppedObservations++;
      },
    });
  } catch {
    histogram.disable();
    return null;
  }
  const timer = setInterval(sampleGap, 1);
  timer.unref();
  histogram.enable();
  return {
    finish() {
      sampleGap();
      clearInterval(timer);
      sampler.stop();
      histogram.disable();
      return {
        p50Ms: histogram.percentile(50) / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        p999Ms: histogram.percentile(99.9) / 1e6,
        maxMs: histogram.max / 1e6,
        samples: histogram.count,
        gapsOver100Ms: count,
        gapCountMeaning:
          'observed 1ms timer scheduling intervals over 100ms; not a count of unique blocking causes',
        gaps: gaps.map((gap) => {
          const overlap = observations.filter(
            (record) =>
              Number(record.startMonotonicMs) < gap.endMonotonicMs &&
              Number(record.endMonotonicMs) > gap.startMonotonicMs
          );
          return {
            ...gap,
            attribution: overlap.length ? 'observed_work_overlap' : 'unknown',
            observations: overlap,
          };
        }),
        omittedGaps: count - gaps.length,
        droppedObservations,
        observerErrors,
      };
    },
  };
}
export async function observeNative(lower: number, upper: number) {
  const client = getControlStoreWorkerClient() as any;
  const expected: number[] = [];
  const ready = new Set<number>(),
    finished = new Set<number>();
  const openReports = new Map<number, OpenObservation>();
  const hr = () => Number(process.hrtime.bigint()) / 1000;
  const all = {
    maxInputBytes: 0,
    maxTotalInputBytes: 0,
    maxOutstandingPerDatabase: 0,
    maxOutstandingTotal: 0,
    maxPendingNativeRequests: 0,
  };
  const steady = { ...all };
  let observerErrors = 0;
  function observe<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      observerErrors++;
    }
  }
  const channel = observe(() => {
    const value = new BroadcastChannel(process.env.R2_CLOSE_CHANNEL!);
    value.unref();
    value.onmessage = ({ data }: any) => {
      if (data.kind === 'ready') ready.add(data.threadId);
      if (data.kind === 'finished') {
        finished.add(data.threadId);
        if (data.openObservation) openReports.set(data.threadId, data.openObservation);
      }
    };
    return value;
  });
  function sample() {
    observe(() => {
      const total = [...client.outstanding.values()].reduce(
        (a: number, b: any) => a + Number(b),
        0
      ) as number;
      const maximum = Math.max(0, ...[...client.outstanding.values()].map(Number));
      // Admission is bounded per database, not by the removed client-wide scalar (44450f033).
      const bytes = [...client.backing.values()].map((entry: any) => Number(entry.inputBytes));
      for (const row of [all, ...(hr() >= lower && hr() < upper ? [steady] : [])]) {
        row.maxInputBytes = Math.max(row.maxInputBytes, 0, ...bytes);
        row.maxTotalInputBytes = Math.max(
          row.maxTotalInputBytes,
          bytes.reduce((a: number, b: number) => a + b, 0)
        );
        row.maxOutstandingPerDatabase = Math.max(row.maxOutstandingPerDatabase, maximum);
        row.maxOutstandingTotal = Math.max(row.maxOutstandingTotal, total);
        row.maxPendingNativeRequests = Math.max(row.maxPendingNativeRequests, client.pending.size);
      }
    });
  }
  const restore: Array<() => void> = [];
  for (const name of ['outstanding', 'pending', 'backing'])
    observe(() => {
      const map = client[name];
      for (const method of ['set', 'delete', 'clear']) {
        const descriptor = Object.getOwnPropertyDescriptor(map, method);
        const original = map[method];
        map[method] = function (...args: any[]) {
          const value = Reflect.apply(original, this, args);
          sample();
          return value;
        };
        restore.push(() => {
          if (descriptor) Object.defineProperty(map, method, descriptor);
          else delete map[method];
        });
      }
    });
  const refresh = () =>
    observe(() => {
      for (const host of client.hosts)
        if (host.worker && !expected.includes(host.worker.threadId))
          expected.push(host.worker.threadId);
      if (!expected.every((id) => ready.has(id)))
        channel?.postMessage({ kind: 'window', lower, upper });
    });
  refresh();
  // Workspace hosts can start lazily after observation begins; their custody must stay explicit.
  const refreshTimer = setInterval(refresh, 100);
  refreshTimer.unref();
  for (let i = 0; channel && !expected.every((x) => ready.has(x)) && i < 500; i++) await sleep(10);
  if (!expected.length || !expected.every((x) => ready.has(x))) observerErrors++;
  return {
    async finish() {
      clearInterval(refreshTimer);
      refresh();
      observe(() => channel?.postMessage({ kind: 'finish' }));
      for (let i = 0; channel && !expected.every((x) => finished.has(x)) && i < 500; i++)
        await sleep(10);
      const complete = expected.length > 0 && expected.every((x) => finished.has(x));
      for (const fn of restore.reverse()) observe(fn);
      observe(() => channel?.close());
      if (!complete) observerErrors++;
      return {
        all,
        steady,
        expectedNativeNodeIds: expected,
        nativeComplete: complete,
        limits: CONTROL_WORKER_LIMITS,
        exactClientMutationBoundaryPeaks: observerErrors === 0,
        observerErrors,
        openCoverage: expected.map((threadId) => ({
          threadId,
          ...openCoverage(openReports.get(threadId) ?? null, true),
        })),
        privateCounterPurpose:
          'Inherited queueBounded count/byte threshold only; no producer/request wrapper',
        countMeaning:
          'original client admitted publication/request reservations, including producer FIFO; not a worker ready/preparing queue',
        workerInternalQueues:
          'NOT OBSERVABLE directly; wire/SQL/native-only reconciliation reported separately',
      };
    },
  };
}

/** Passive per-offer context; never controls admission, retries, payloads or queue policy. */
export const diagnosticContext = new AsyncLocalStorage<any>();
export function diagnosticStage(stage: string) {
  const row = diagnosticContext.getStore();
  if (row) {
    row.stage = stage;
    row.stageChangedMs = performance.now();
  }
}
export function diagnosticError(e: any) {
  return {
    name: String(e?.name ?? typeof e),
    code: e?.code ?? null,
    dataCode: e?.data?.code ?? null,
    commit: classifyOutcomeError(e).commit ?? null,
    domain: e?.domain ?? null,
    message: typeof e?.message === 'string' ? e.message.slice(0, 512) : null,
    cause: e?.cause
      ? {
          name: e.cause.name ?? null,
          code: e.cause.code ?? null,
          commit: classifyOutcomeError(e.cause).commit ?? null,
          dataCode: e.cause.data?.code ?? null,
        }
      : null,
  };
}
export function classifyDiagnosticRefusal(
  code: unknown,
  count: number,
  bytes: number,
  ownedBytes: number,
  predecessorFailed: boolean
) {
  if (code === 'busy' && count >= CONTROL_WORKER_LIMITS.pendingTransitions)
    return 'client count bound';
  if (code === 'busy' && bytes + ownedBytes > CONTROL_WORKER_LIMITS.pendingBytes)
    return 'client byte bound';
  if (code === 'precondition' && predecessorFailed) return 'failed-predecessor/successor cascade';
  return 'other/unresolved exact product reason';
}
/** Explicit attribution only. Observation cannot replace a producer's arguments, result or error. */
export function installDiagnosticTrace(client = getControlStoreWorkerClient() as any) {
  const publications: any[] = [],
    requests: any[] = [],
    samples: any[] = [];
  let observerErrors = 0;
  function observe<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      observerErrors++;
    }
  }
  const hr = () => Number(process.hrtime.bigint()) / 1000;
  const originalPublication = client.runTurnPublication,
    originalRequest = client.request;
  client.runTurnPublication = function (...args: any[]) {
    const record = observe(() => {
      const row = diagnosticContext.getStore();
      const value = {
        rowId: row?.id ?? null,
        workspace: row?.workspace ?? null,
        turnIds: args[1],
        startHrUsec: hr(),
        countAtEntry: client.outstanding.get(args[0]) ?? 0,
        bytesAtEntry: client.backing.get(args[0])?.inputBytes ?? 0,
      };
      publications.push(value);
      diagnosticStage('producer FIFO await');
      return value;
    });
    // Call exactly once with the original receiver and arguments, including prepare.
    const result = Reflect.apply(originalPublication, this, args) as Promise<unknown>;
    observe(() => {
      void result.then(
        () =>
          observe(() => {
            if (record) Object.assign(record, { ok: true, endHrUsec: hr() });
          }),
        (error: unknown) =>
          observe(() => {
            if (record)
              Object.assign(record, { ok: false, endHrUsec: hr(), error: diagnosticError(error) });
          })
      );
    });
    return result;
  };
  client.request = function (...args: any[]) {
    const record = observe(() => {
      const command = args[0],
        row = diagnosticContext.getStore(),
        kind = command.input?.kind ?? null;
      const stage =
        command.operation === 'capability'
          ? /admit/.test(String(kind))
            ? 'capability admission'
            : /finish|usage|complete/.test(String(kind))
              ? 'usage-finish'
              : `capability ${String(kind)}`
          : `native request ${command.operation}`;
      diagnosticStage(stage);
      const value = {
        rowId: row?.id ?? null,
        workspace: row?.workspace ?? null,
        operation: command.operation,
        inputKind: kind,
        startHrUsec: hr(),
        nextIdAtEntry: client.nextId,
        countAtEntry: client.outstanding.get(command.database) ?? 0,
        inputBytesAtEntry: client.backing.get(command.database)?.inputBytes ?? 0,
        transportPendingAtEntry: client.pending.size,
      };
      requests.push(value);
      return value;
    });
    const result = Reflect.apply(originalRequest, this, args) as Promise<unknown>;
    observe(() => {
      void result.then(
        () =>
          observe(() => {
            if (record) Object.assign(record, { ok: true, endHrUsec: hr() });
          }),
        (error: unknown) =>
          observe(() => {
            if (record)
              Object.assign(record, { ok: false, endHrUsec: hr(), error: diagnosticError(error) });
          })
      );
    });
    return result;
  };
  const timer = setInterval(
    () =>
      observe(() =>
        samples.push({
          hrUsec: hr(),
          inputBytes: Math.max(
            0,
            ...[...client.backing.values()].map((entry: any) => Number(entry.inputBytes))
          ),
          outstanding: [...client.outstanding.entries()],
          transportPending: client.pending.size,
          publicationOperations: client.operations.size,
        })
      ),
    1000
  );
  timer.unref();
  return {
    publications,
    requests,
    samples,
    get observerErrors() {
      return observerErrors;
    },
    snapshot(rows: any[], start: number) {
      return observe(() => ({
        cutoffHrUsec: hr(),
        cutoffElapsedMs: performance.now() - start,
        pending: rows.filter(
          (r) => r.issuedMs !== undefined && r.ackMs === undefined && r.error === undefined
        ),
        publications,
        requests,
        samples,
        observerErrors,
      }));
    },
    close() {
      clearInterval(timer);
      observe(() => {
        client.runTurnPublication = originalPublication;
      });
      observe(() => {
        client.request = originalRequest;
      });
    },
  };
}
