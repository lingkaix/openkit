import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';

const THRESHOLD_MS = 100;
const MAX_RECORDS = 64;
const MAX_NESTING = 32;
const operationContext = new AsyncLocalStorage<string>();

/** Bounded internal numeric observations; no request, filesystem or exception content. */
type MainLoopObservation = Readonly<Record<string, string | number>>;
/** One process-owned observer; flush and stop never propagate diagnostic failures. */
export interface MainLoopObserver {
  flush(): void;
  stop(): void;
}
let active:
  | { observer: MainLoopObserver; prefix(start: number, operation: string): void }
  | undefined;

/** Labels registered operation attempts only; unknown caller strings never enter internal diagnostics. */
export function withMainLoopOperation<T>(operation: string, run: () => T): T {
  if (!active) return run();
  const label = Object.hasOwn(OPERATION_DEFINITIONS, operation) ? operation : 'unknown';
  return operationContext.run(label, () => {
    const start = performance.now();
    try {
      return run();
    } finally {
      active?.prefix(start, label);
    }
  });
}

/**
 * Observes long synchronous callbacks and event-loop delay independently of operation wall time.
 * Callback/operation overlap is attribution evidence, never proof of a native stall's cause.
 * A bounded queue and nesting pool prevent diagnostic load from growing without limit.
 */
export function startMainLoopObserver(
  options: { emit?: (observation: MainLoopObservation) => void } = {}
): MainLoopObserver {
  if (active) return active.observer;
  const emit = options.emit ?? ((record) => console.warn(JSON.stringify(record)));
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const records: MainLoopObservation[] = [];
  const frames = Array.from({ length: MAX_NESTING }, () => ({ start: 0, operation: 'unknown' }));
  let depth = 0;
  let dropped = 0;
  let sinkFailures = 0;
  let running = true;
  let windowStart = performance.now();
  const retain = (record: MainLoopObservation) => {
    if (records.length < MAX_RECORDS) records.push(record);
    else dropped++;
  };
  const observe = (start: number, end: number, operation: string, observation: string) => {
    if (end - start <= THRESHOLD_MS) return;
    retain({
      event: 'main_loop_long_task',
      observation,
      operation,
      startMonotonicMs: start,
      endMonotonicMs: end,
      durationMs: end - start,
    });
  };
  const hook = createHook({
    before() {
      const index = depth++;
      if (index >= MAX_NESTING) {
        dropped++;
        return;
      }
      const frame = frames[index]!;
      frame.start = performance.now();
      frame.operation = operationContext.getStore() ?? 'unknown';
    },
    after() {
      const index = --depth;
      if (index < 0) {
        depth = 0;
        return;
      }
      if (index >= MAX_NESTING || !running) return;
      const frame = frames[index]!;
      observe(frame.start, performance.now(), frame.operation, 'callback');
    },
  });
  const deliver = (record: MainLoopObservation) => {
    try {
      emit(record);
    } catch {
      sinkFailures = Math.min(Number.MAX_SAFE_INTEGER, sinkFailures + 1);
    }
  };
  const flush = () => {
    if (!running) return;
    const now = performance.now();
    const pending = records.splice(0);
    const lost = dropped;
    dropped = 0;
    const failed = sinkFailures;
    sinkFailures = 0;
    if (histogram.max / 1e6 > THRESHOLD_MS)
      deliver({
        event: 'main_loop_window',
        startMonotonicMs: windowStart,
        endMonotonicMs: now,
        thresholdMs: THRESHOLD_MS,
        maxMs: histogram.max / 1e6,
        p50Ms: histogram.percentile(50) / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        p999Ms: histogram.percentile(99.9) / 1e6,
        samples: histogram.count,
        longTaskObservations: pending.length,
        attribution: pending.length ? 'observed_work_overlap' : 'unknown',
      });
    histogram.reset();
    windowStart = now;
    for (const record of pending) deliver(record);
    if (lost)
      deliver({ event: 'main_loop_observation_gap', reason: 'bounded_capacity', count: lost });
    if (failed)
      deliver({ event: 'main_loop_observation_gap', reason: 'sink_failure', count: failed });
  };
  const timer = setInterval(flush, 1000);
  timer.unref();
  const observer: MainLoopObserver = {
    flush,
    stop() {
      if (!running) return;
      hook.disable();
      clearInterval(timer);
      flush();
      histogram.disable();
      running = false;
      active = undefined;
      operationContext.disable();
    },
  };
  active = {
    observer,
    prefix(start, operation) {
      if (depth > 0 && depth <= MAX_NESTING) {
        const frame = frames[depth - 1]!;
        if (frame.operation === 'unknown') frame.operation = operation;
        else if (frame.operation !== operation) frame.operation = 'multiple';
      }
      observe(start, performance.now(), operation, 'operation_prefix');
    },
  };
  histogram.enable();
  hook.enable();
  return observer;
}
