import type { LifecycleDeadline } from '../lifecycle-deadline.js';
import type {
  WorkerShimAbsence,
  WorkerShimDesiredSet,
  WorkerShimDisposition,
  WorkerShimInterrupt,
  WorkerShimInterruptReceipt,
  WorkerShimInventory,
  WorkerShimKeyedWork,
  WorkerShimObservation,
  WorkerShimOperationKey,
  WorkerShimPort,
  WorkerShimReceipt,
  WorkerShimSession,
  WorkerShimStart,
  WorkerShimTurn,
  WorkerShimTurnInput,
  WorkerStopDeclaration,
} from '../worker-shim-port.js';

interface FakeWorker {
  readonly start: WorkerShimStart;
  state: WorkerShimObservation['state'];
  activeTurn?: WorkerShimTurn;
  absence?: Extract<WorkerShimAbsence, { state: 'absent' }>;
}

interface FakeOperation {
  readonly receipt: WorkerShimReceipt;
  readonly input: WorkerShimKeyedWork | WorkerShimTurnInput;
  pending: boolean;
}

function sameKey(left: WorkerShimOperationKey, right: WorkerShimOperationKey): boolean {
  return (
    left.operationId === right.operationId &&
    left.workerId === right.workerId &&
    left.payloadDigest === right.payloadDigest
  );
}

function sameTurn(left: WorkerShimTurn, right: WorkerShimTurn): boolean {
  return (
    left.workerId === right.workerId &&
    left.attemptId === right.attemptId &&
    left.turnId === right.turnId
  );
}

function sameStart(left: WorkerShimStart, right: WorkerShimStart): boolean {
  return (
    left.adapterId === right.adapterId &&
    left.agentSessionId === right.agentSessionId &&
    left.workSlotRef === right.workSlotRef &&
    left.resume?.locator === right.resume?.locator &&
    left.resume?.digest === right.resume?.digest
  );
}

/** Controls which native receipts and stop scope the fixture can actually supply. */
export interface FakeWorkerShimOptions {
  readonly stop?: WorkerStopDeclaration;
  readonly input?: 'accepted' | 'unknown';
  readonly steer?: 'accepted' | 'unknown';
}

/** Deterministic one-slot shim. Provider absence and Core claim release stay with their owners. */
export class FakeWorkerShim implements WorkerShimPort {
  /** Independent count of realized starts. */
  readonly started: string[] = [];
  /** Independent count of native input and steer contacts, by operation ID. */
  readonly contacted: string[] = [];
  /** Independent count of native interrupt contacts, by original request. */
  readonly interrupted: string[] = [];

  #worker?: FakeWorker;
  readonly #stopped = new Set<string>();
  readonly #operations = new Map<string, FakeOperation>();
  readonly #interrupts: WorkerShimInterruptReceipt[] = [];
  readonly #stop: WorkerStopDeclaration;
  #generation = 0;
  #revision = -1;

  /** Creates the fake for one incarnation. All enabled adapters default to best effort. */
  constructor(
    readonly sandboxIncarnationId: string,
    private readonly options: FakeWorkerShimOptions = {}
  ) {
    this.#stop = options.stop ?? { kind: 'best-effort' };
  }

  /** Repeated current start observes the original Worker. A stopped ID cannot start again. */
  async start(start: WorkerShimStart): Promise<WorkerShimDisposition> {
    if (this.#stopped.has(start.workerId)) return 'refused';
    if (this.#worker) {
      return this.#worker.start.workerId === start.workerId && sameStart(this.#worker.start, start)
        ? 'accepted'
        : 'refused';
    }
    this.#worker = { start, state: 'running' };
    this.started.push(start.workerId);
    return 'accepted';
  }

  #workerFor(workerId: string): FakeWorker | undefined {
    return this.#worker?.start.workerId === workerId ? this.#worker : undefined;
  }

  /** Close local admission even if the Worker has no corresponding live observation. */
  async stop(workerId: string): Promise<'stopping' | 'exited' | 'unknown'> {
    this.#stopped.add(workerId);
    const worker = this.#workerFor(workerId);
    if (!worker) return 'unknown';
    if (worker.state === 'exited') return 'exited';
    worker.state = 'stopping';
    return 'stopping';
  }

  /** Read supplied proof. The fake clock cannot turn missing evidence into absence. */
  async waitUntilAbsent(
    workerId: string,
    _deadline: LifecycleDeadline
  ): Promise<WorkerShimAbsence> {
    return this.#workerFor(workerId)?.absence ?? { state: 'held' };
  }

  /** Observe the direct child without inferring descendant absence. */
  observeChildExit(workerId: string): void {
    const worker = this.#workerFor(workerId);
    if (worker) {
      worker.state = 'exited';
      this.#stopped.add(workerId);
    }
  }

  /** Supply qualified tree absence after stop joined accepted work in the fixture. */
  observeTreeAbsent(workerId: string): void {
    const worker = this.#workerFor(workerId);
    if (worker && this.#stopped.has(workerId) && this.#stop.kind === 'exact') {
      worker.state = 'exited';
      worker.absence = { state: 'absent', workerId, proofKind: this.#stop.proofKind };
    }
  }

  /** Record native input intake once, against the originally authorized attempt. */
  async keyedTurnInput(input: WorkerShimTurnInput): Promise<WorkerShimDisposition> {
    return this.#apply(input, 'input');
  }

  /** Record native steer intake once, confined to the active Turn even when unknown. */
  async keyedSteer(input: WorkerShimKeyedWork): Promise<WorkerShimDisposition> {
    return this.#apply(input, 'steer');
  }

  #apply(
    input: WorkerShimKeyedWork | WorkerShimTurnInput,
    kind: WorkerShimReceipt['kind']
  ): WorkerShimDisposition {
    const previous = this.#operations.get(input.operationId);
    if (previous) {
      const sameGrant =
        !('routeGrant' in input) ||
        ('routeGrant' in previous.input && previous.input.routeGrant === input.routeGrant);
      return previous.receipt.kind === kind &&
        sameKey(previous.receipt.key, input) &&
        sameTurn(previous.input, input) &&
        previous.input.inputRef === input.inputRef &&
        sameGrant
        ? previous.receipt.disposition
        : 'refused';
    }
    const worker = this.#workerFor(input.workerId);
    let disposition: WorkerShimDisposition = 'refused';
    if (
      worker?.state === 'running' &&
      !this.#interrupts.some((interrupt) => sameTurn(interrupt, input))
    ) {
      const active = worker.activeTurn;
      const eligible = kind === 'input' ? !active : active && sameTurn(active, input);
      if (eligible) {
        disposition = this.options[kind] ?? 'accepted';
        this.contacted.push(input.operationId);
        if (kind === 'input' && disposition === 'unknown') {
          this.#stopped.add(input.workerId);
          worker.state = 'stopping';
        } else if (kind === 'input') {
          worker.activeTurn = input;
        }
      }
    }
    const { operationId, workerId, payloadDigest } = input;
    const receipt = { kind, key: { operationId, workerId, payloadDigest }, disposition };
    this.#operations.set(operationId, { receipt, input, pending: true });
    return disposition;
  }

  #interrupt(interrupt: WorkerShimInterrupt): void {
    if (this.#interrupts.some((previous) => sameTurn(previous, interrupt))) return;
    const worker = this.#workerFor(interrupt.workerId);
    if (
      worker?.activeTurn &&
      worker.state === 'running' &&
      sameTurn(worker.activeTurn, interrupt)
    ) {
      this.interrupted.push(interrupt.requestId);
      delete worker.activeTurn;
      this.#interrupts.push({ ...interrupt, disposition: 'cancelled' });
    } else {
      this.#interrupts.push({ ...interrupt, disposition: 'unknown' });
    }
  }

  /** Exchange full sets, fencing obsolete carrier replies before acting. */
  async poll(
    session: WorkerShimSession,
    exchange: (inventory: WorkerShimInventory) => Promise<WorkerShimDesiredSet>
  ): Promise<'applied' | 'stale'> {
    const generation = session.connectionGeneration;
    if (session.sandboxIncarnationId !== this.sandboxIncarnationId || generation < this.#generation)
      return 'stale';
    if (generation > this.#generation) {
      this.#generation = generation;
      this.#revision = -1;
    }
    const worker = this.#worker;
    const desired = await exchange({
      session,
      workers: worker
        ? [
            {
              workerId: worker.start.workerId,
              state: worker.state,
              stop: this.#stop,
              ...(worker.absence ? { absence: worker.absence } : {}),
            },
          ]
        : [],
      receipts: Array.from(this.#operations.values())
        .filter((operation) => operation.pending)
        .map((operation) => operation.receipt),
      interrupts: [...this.#interrupts],
    });
    if (
      generation !== this.#generation ||
      desired.session.connectionGeneration !== generation ||
      desired.session.sandboxIncarnationId !== this.sandboxIncarnationId ||
      desired.revision <= this.#revision
    )
      return 'stale';
    this.#revision = desired.revision;
    for (const key of desired.acknowledgedOperations) {
      const operation = this.#operations.get(key.operationId);
      if (operation && sameKey(key, operation.receipt.key)) operation.pending = false;
    }
    const effects: Promise<unknown>[] = [];
    for (const worker of desired.workers) {
      if (worker.state === 'stop') effects.push(this.stop(worker.workerId));
    }
    for (const worker of desired.workers) {
      if (worker.state === 'run') effects.push(this.start(worker.worker));
    }
    for (const interrupt of desired.interrupts) this.#interrupt(interrupt);
    for (const input of desired.inputs) effects.push(this.keyedTurnInput(input));
    for (const steer of desired.steers) effects.push(this.keyedSteer(steer));
    await Promise.all(effects);
    return 'applied';
  }
}
