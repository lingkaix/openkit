/** Test-only passive client-admission and native observer handshake; never controls admission. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { BroadcastChannel } from 'node:worker_threads';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { CONTROL_WORKER_LIMITS } from '../storage/control-store-worker-protocol.js';
import { classifyOutcomeError } from './load-plan.js';
export async function observeNative(lower: number, upper: number) {
  const client = getControlStoreWorkerClient() as any;
  const expected: number[] = client.hosts
    .filter((h: any) => h.worker)
    .map((h: any) => h.worker.threadId);
  const channel = new BroadcastChannel(process.env.R2_CLOSE_CHANNEL!);
  channel.unref();
  const ready = new Set<number>(),
    finished = new Set<number>();
  channel.onmessage = ({ data }: any) => {
    if (data.kind === 'ready') ready.add(data.threadId);
    if (data.kind === 'finished') finished.add(data.threadId);
  };
  const hr = () => Number(process.hrtime.bigint()) / 1000;
  const all = {
    maxInputBytes: 0,
    maxOutstandingPerDatabase: 0,
    maxOutstandingTotal: 0,
    maxPendingNativeRequests: 0,
  };
  const steady = { ...all };
  let observerErrors = 0;
  function sample() {
    try {
      const total = [...client.outstanding.values()].reduce(
        (a: number, b: any) => a + Number(b),
        0
      ) as number;
      const maximum = Math.max(0, ...[...client.outstanding.values()].map(Number));
      for (const row of [all, ...(hr() >= lower && hr() < upper ? [steady] : [])]) {
        row.maxInputBytes = Math.max(row.maxInputBytes, client.inputBytes);
        row.maxOutstandingPerDatabase = Math.max(row.maxOutstandingPerDatabase, maximum);
        row.maxOutstandingTotal = Math.max(row.maxOutstandingTotal, total);
        row.maxPendingNativeRequests = Math.max(row.maxPendingNativeRequests, client.pending.size);
      }
    } catch {
      observerErrors++;
    }
  }
  const restore: Array<() => void> = [];
  for (const map of [client.outstanding, client.pending])
    for (const method of ['set', 'delete', 'clear']) {
      const original = map[method];
      map[method] = function (...args: any[]) {
        const value = Reflect.apply(original, this, args);
        sample();
        return value;
      };
      restore.push(() => {
        delete map[method];
      });
    }
  const descriptor = Object.getOwnPropertyDescriptor(client, 'inputBytes')!;
  let bytes = client.inputBytes;
  Object.defineProperty(client, 'inputBytes', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get: () => bytes,
    set: (value) => {
      bytes = value;
      sample();
    },
  });
  restore.push(() => Object.defineProperty(client, 'inputBytes', { ...descriptor, value: bytes }));
  channel.postMessage({ kind: 'window', lower, upper });
  for (let i = 0; !expected.every((x) => ready.has(x)) && i < 500; i++) await sleep(10);
  if (!expected.length || !expected.every((x) => ready.has(x)))
    throw Error('Native observer handshake missing; no inferred telemetry');
  return {
    async finish() {
      channel.postMessage({ kind: 'finish' });
      for (let i = 0; !expected.every((x) => finished.has(x)) && i < 500; i++) await sleep(10);
      const complete = expected.every((x) => finished.has(x));
      for (const fn of restore.reverse()) fn();
      channel.close();
      if (!complete) throw Error('Native observer final custody missing');
      return {
        all,
        steady,
        expectedNativeNodeIds: expected,
        limits: CONTROL_WORKER_LIMITS,
        exactClientMutationBoundaryPeaks: observerErrors === 0,
        observerErrors,
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
        bytesAtEntry: client.inputBytes,
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
        inputBytesAtEntry: client.inputBytes,
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
          inputBytes: client.inputBytes,
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
