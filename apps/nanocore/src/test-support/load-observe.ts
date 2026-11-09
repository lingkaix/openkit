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
  const expected: number[] = [];
  const ready = new Set<number>(),
    finished = new Set<number>();
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
      if (data.kind === 'finished') finished.add(data.threadId);
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
