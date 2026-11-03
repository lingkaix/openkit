import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker, WorkerOptions } from 'node:worker_threads';
import { expect, vi } from 'vitest';

/** Only current family facts select an ACK; no SQL, callback or response body crosses the wire. */
type ServerPermissionAckSelection =
  | { readonly kind: 'policy-write'; readonly requestId: string }
  | { readonly kind: 'maintenance'; readonly requestId: string }
  | {
      readonly kind: 'gateway';
      readonly action: 'llm.gateway.chat_completions' | 'llm.gateway.responses';
    }
  | { readonly kind: 'goal-admin'; readonly coordinatorTurnId: string };
/** One test-local reply selection, with no durable record or production option. */
interface PolicyAckHold {
  readonly selection: ServerPermissionAckSelection;
  selected: number;
  forward?: (() => boolean) | undefined;
}

const interception = {
  gate: new SharedArrayBuffer(28),
  requestId: new SharedArrayBuffer(64),
  bootEntropy: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
  policyAck: undefined as PolicyAckHold | undefined,
};

/** Observes actual native FULL COMMIT, selected replies and the armed boot allocation fault. */
export function nativeCommitWorker(Worker: typeof NativeWorker): typeof NativeWorker {
  return class extends Worker {
    private policyRequest: { readonly id: number; readonly hold: PolicyAckHold } | undefined;
    override postMessage(
      value: unknown,
      transferList?: readonly import('node:worker_threads').TransferListItem[]
    ): void {
      const hold = interception.policyAck;
      if (hold && value && typeof value === 'object') {
        const request = value as {
          id?: number;
          operation?: string;
          database?: string;
          input?: {
            kind?: string;
            stage?: {
              kind?: string;
              decision?: {
                enforcementPoint?: string;
                action?: string;
                contextSummary?: { requestId?: string; cause?: string; turnId?: string };
              };
            };
          };
        };
        const decision = request.input?.stage?.decision;
        const selection = hold.selection;
        const selected =
          selection.kind === 'gateway'
            ? decision?.enforcementPoint === 'llm.gateway.policy' &&
              decision.action === selection.action
            : selection.kind === 'goal-admin'
              ? decision?.enforcementPoint === 'policy.write@decide' &&
                decision.contextSummary?.cause === 'goal-domain.administer' &&
                decision.contextSummary.turnId === selection.coordinatorTurnId
              : decision?.enforcementPoint ===
                  (selection.kind === 'maintenance'
                    ? 'administration.configuration.apply'
                    : 'policy.write@decide') &&
                decision.contextSummary?.requestId === selection.requestId;
        if (
          request.operation === 'capability' &&
          request.database?.startsWith('core:') &&
          request.input?.kind === 'server-permission' &&
          request.input.stage?.kind === 'record' &&
          typeof request.id === 'number' &&
          selected
        ) {
          if (hold.selected !== 0) throw new Error('Policy ACK selection matched another request.');
          hold.selected += 1;
          this.policyRequest = { id: request.id, hold };
        }
      }
      super.postMessage(value, transferList);
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      const selected = this.policyRequest;
      const value = args[0] as { id?: number; status?: string; operation?: string } | undefined;
      if (
        event === 'message' &&
        selected &&
        selected.hold === interception.policyAck &&
        value?.id === selected.id &&
        value.status === 'ok' &&
        value.operation === 'capability'
      ) {
        if (selected.hold.forward) throw new Error('The selected Policy request replied twice.');
        selected.hold.forward = () => super.emit(event, ...args);
        Atomics.store(new Int32Array(interception.gate), 0, 1);
        return true;
      }
      return super.emit(event, ...args);
    }
    constructor(filename: string | URL, options?: WorkerOptions) {
      const require = createRequire(import.meta.url);
      const prelude = `
        const {workerData, parentPort} = require('node:worker_threads');
        const Database = require(workerData.databaseModule);
        const originalExec = Database.prototype.exec;
        const gate = workerData.gate;
        const bootEntropy = workerData.bootEntropy;
        let selectedBootEntropy = false;
        // Select immediately before the real receiver; MessagePort has no prependListener.
        // Do not attach an early listener: that would start the port before entry import finishes.
        const on = parentPort.on;
        parentPort.on = function(event, listener) {
          if (event !== 'message') return on.call(this, event, listener);
          return on.call(this, event, function(value, ...args) {
            if (Atomics.load(bootEntropy, 0) === 1 && value?.operation === 'capability' &&
                value.input?.kind === 'server-permission' &&
                value.input.stage?.kind === 'boot' && value.input.stage.bootId === 'boot_entropy') {
              Atomics.add(bootEntropy, 1, 1);
              selectedBootEntropy = true;
            }
            return listener.call(this, value, ...args);
          });
        };
        const nativeEntropy = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
        globalThis.crypto.getRandomValues = function(value) {
          if (selectedBootEntropy && Atomics.load(bootEntropy, 0) === 1) {
            const allocation = Atomics.add(bootEntropy, 2, 1) + 1;
            if (allocation === 3) {
              selectedBootEntropy = false;
              Atomics.store(bootEntropy, 0, 0);
              Atomics.add(bootEntropy, 3, 1);
              throw new Error('Synthetic boot entropy failure.');
            }
          }
          return nativeEntropy(value);
        };
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
          bootEntropy: new Int32Array(interception.bootEntropy),
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
  const held = interception.policyAck;
  interception.policyAck = undefined;
  held?.forward?.();
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

/** Arms only the existing boot_entropy request: decision one, linked Audit, then decision two. */
export function armBootSecondDecisionEntropyFailure(): Int32Array {
  const gate = new Int32Array(interception.bootEntropy);
  gate.fill(0);
  Atomics.store(gate, 0, 1);
  return gate;
}

/** Disarms the test-only native entropy fault before draining the owning Worker. */
export function releaseBootEntropyFailure(): void {
  Atomics.store(new Int32Array(interception.bootEntropy), 0, 0);
}

/** Holds only the exact real Core reply on Main, leaving its Worker free for authority mutations. */
export function heldServerPermissionAck<T>(
  selection: ServerPermissionAckSelection,
  work: () => Promise<T>
) {
  if (interception.policyAck) throw new Error('A Policy reply is already held.');
  const gate = armCommit(2);
  // This instrument holds a covering native ACK, not the native thread. The public
  // reader in each owner case also verifies that its exact decision already committed.
  Atomics.store(gate, 3, 0);
  interception.policyAck = { selection, selected: 0 };
  return joinHeldCommit(gate, work);
}
