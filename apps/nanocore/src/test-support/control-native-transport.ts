import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import { expect, vi } from 'vitest';

const interception = {
  gate: new SharedArrayBuffer(28),
  requestId: new SharedArrayBuffer(64),
};

/** Wraps the real Worker only to observe and hold its actual SQLite FULL COMMIT. */
export function nativeCommitWorker(Worker: typeof NativeWorker): typeof NativeWorker {
  return class extends Worker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      const require = createRequire(import.meta.url);
      const prelude = `
        const {workerData} = require('node:worker_threads');
        const Database = require(workerData.databaseModule);
        const originalExec = Database.prototype.exec;
        const gate = workerData.gate;
        function selectsIdle(db) {
          const stage = Atomics.load(gate, 6);
          if (stage === 0) return true;
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'control_execution_steps'").get()) return false;
          const requestId = Buffer.from(workerData.commitRequestId).toString('ascii');
          return !!db.prepare(\`SELECT 1 FROM control_execution_steps s
            WHERE json_extract(s.control_json, '$.definitionVersion') = 'core-idle-cleanup/v1'
              AND json_extract(s.invocation_json, '$.carriage.operation') = 'bridge.close'
              AND json_extract(s.invocation_json, '$.carriage.requestId') = ?
              AND json_extract(s.control_json, '$.kind') <> 'consume-receipt'
              AND ((? = 1 AND s.state = 'intent') OR (((? = 2 AND s.state = 'completed')
                OR (? = 3 AND s.state = 'unknown')) AND EXISTS (
                SELECT 1 FROM control_execution_steps c
                WHERE c.inspected_execution_id = s.execution_id AND c.inspected_step_id = s.step_id
                  AND c.state = 'completed' AND json_extract(c.control_json, '$.kind') = 'consume-receipt'
              )))\`).get(requestId, stage, stage, stage);
        }
        function hold(point, ordinal, selected) {
          if (selected && Atomics.load(gate, 3) === point &&
              (Atomics.load(gate, 6) !== 0 || Atomics.load(gate, 4) === ordinal) &&
              Atomics.compareExchange(gate, 0, 0, 1) === 0)
            Atomics.wait(gate, 1, 0);
        }
        Database.prototype.exec = function(sql) {
          const ordinal = Atomics.load(gate, 2) + 1;
          const commit = /^COMMIT$/i.test(sql);
          const selected = commit && selectsIdle(this);
          if (commit) {
            if (selected) Atomics.store(gate, 5, this.pragma('synchronous', {simple: true}));
            hold(1, ordinal, selected);
          }
          const result = originalExec.call(this, sql);
          if (commit) {
            Atomics.add(gate, 2, 1);
            hold(2, ordinal, selected);
          }
          return result;
        };
      `;
      const entry = options?.eval
        ? String(filename)
        : `import(${JSON.stringify(String(filename))});`;
      super(prelude + entry, {
        ...options,
        eval: true,
        workerData: {
          ...options?.workerData,
          databaseModule: require.resolve('better-sqlite3'),
          gate: new Int32Array(interception.gate),
          commitRequestId: new Uint8Array(interception.requestId),
        },
      });
    }
  };
}

/** Arms the next real native commit; point 2 has committed but has not sent its reply. */
export function armCommit(point: 1 | 2): Int32Array {
  const gate = new Int32Array(interception.gate);
  Atomics.store(gate, 0, 0);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 6, 0);
  Atomics.store(gate, 3, point);
  Atomics.store(gate, 4, Atomics.load(gate, 2) + 1);
  return gate;
}

/** Releases only the test's native SQLite hold. */
export function releaseCommit(): void {
  const gate = new Int32Array(interception.gate);
  Atomics.store(gate, 3, 0);
  Atomics.store(gate, 6, 0);
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Starts the unchanged producer and observes its actual covering FULL commit before reply. */
async function joinHeldCommit<T>(gate: Int32Array, work: () => Promise<T>) {
  let completed = false;
  const result = Promise.resolve()
    .then(work)
    .finally(() => {
      completed = true;
    });
  void result.catch(() => undefined);
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  await nextTurn();
  expect(completed).toBe(false);
  expect(Atomics.load(gate, 5)).toBe(2);
  return { result, completed: () => completed };
}

/** Observes the next actual native COMMIT with the existing image-fixture semantics and bound. */
export function heldCommit<T>(point: 1 | 2, work: () => Promise<T>) {
  return joinHeldCommit(armCommit(point), work);
}

/** Selects the exact bridge intent or consumption tuple, including an unchanged unknown original. */
export function heldCoreIdleCommit<T>(
  stage: 'intent' | 'settlement' | 'late-settlement',
  requestId: string,
  work: () => Promise<T>
) {
  if (!/^[0-9a-f]{64}$/.test(requestId))
    throw new Error('Idle commit selection requires its exact request id.');
  const gate = armCommit(2);
  new Uint8Array(interception.requestId).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, 6, stage === 'intent' ? 1 : stage === 'settlement' ? 2 : 3);
  return joinHeldCommit(gate, work);
}
