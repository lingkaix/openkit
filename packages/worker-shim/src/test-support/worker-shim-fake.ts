import { WORKER_ADAPTERS, type WorkerStopDeclaration } from '../adapter-registry.js';
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
} from '../worker-shim-port.js';

interface FakeWorker {
  readonly start: WorkerShimStart;
  readonly stop: WorkerStopDeclaration;
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

/** Supplies simulated receiver evidence. An absent result leaves the operation unknown. */
export interface FakeWorkerShimOptions {
  readonly adapterStops?: Readonly<Record<string, WorkerStopDeclaration>>;
  readonly input?: (input: WorkerShimTurnInput) => WorkerShimDisposition | undefined;
  readonly steer?: (input: WorkerShimKeyedWork) => WorkerShimDisposition | undefined;
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
  #generation = 0;
  #revision = -1;

  /** Creates the fake for one incarnation. Shipped adapters use their registered scope. */
  constructor(
    readonly sandboxIncarnationId: string,
    private readonly options: FakeWorkerShimOptions = {}
  ) {}

  /** Repeated current start observes the original Worker. A stopped ID cannot start again. */
  async start(start: WorkerShimStart): Promise<WorkerShimDisposition> {
    if (this.#stopped.has(start.workerId)) return 'refused';
    if (this.#worker) {
      return this.#worker.start.workerId === start.workerId && sameStart(this.#worker.start, start)
        ? 'accepted'
        : 'refused';
    }
    const stop =
      WORKER_ADAPTERS[start.adapterId]?.stop ?? this.options.adapterStops?.[start.adapterId];
    if (!stop) return 'refused';
    this.#worker = { start, stop, state: 'running' };
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
    if (worker && this.#stopped.has(workerId) && worker.stop.kind === 'exact') {
      worker.state = 'exited';
      worker.absence = { state: 'absent', workerId, proofKind: worker.stop.proofKind };
    }
  }

  /** Record native input intake once, against the originally authorized attempt. */
  async keyedTurnInput(input: WorkerShimTurnInput): Promise<WorkerShimDisposition> {
    return this.#apply(input, 'input', () => this.options.input?.(input));
  }

  /** Record native steer intake once, confined to the active Turn even when unknown. */
  async keyedSteer(input: WorkerShimKeyedWork): Promise<WorkerShimDisposition> {
    return this.#apply(input, 'steer', () => this.options.steer?.(input));
  }

  #apply(
    input: WorkerShimKeyedWork | WorkerShimTurnInput,
    kind: WorkerShimReceipt['kind'],
    receive: () => WorkerShimDisposition | undefined
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
      const eligible =
        kind === 'input'
          ? !active
          : worker.start.adapterId !== 'opencode' && active && sameTurn(active, input);
      if (eligible) {
        this.contacted.push(input.operationId);
        try {
          disposition = receive() ?? 'unknown';
        } catch {
          disposition = 'unknown';
        }
        if (kind === 'input' && disposition === 'unknown') {
          this.#stopped.add(input.workerId);
          worker.state = 'stopping';
        } else if (kind === 'input' && disposition === 'accepted') {
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
    const previous = this.#interrupts.find((receipt) => sameTurn(receipt, interrupt));
    if (previous) {
      if (
        !this.#interrupts.some(
          (receipt) => sameTurn(receipt, interrupt) && receipt.requestId === interrupt.requestId
        )
      ) {
        this.#interrupts.push({ ...interrupt, disposition: 'refused' });
      }
      return;
    }
    const worker = this.#workerFor(interrupt.workerId);
    if (
      worker?.activeTurn &&
      worker.state === 'running' &&
      sameTurn(worker.activeTurn, interrupt)
    ) {
      this.interrupted.push(interrupt.requestId);
    }
    this.#interrupts.push({ ...interrupt, disposition: 'unknown' });
  }

  /** Settles the original signal only when the native receiver proves the addressed Turn ended. */
  observeInterruptSettlement(interrupt: WorkerShimInterrupt): void {
    const worker = this.#workerFor(interrupt.workerId);
    if (!worker?.activeTurn || !sameTurn(worker.activeTurn, interrupt)) return;
    const index = this.#interrupts.findIndex(
      (receipt) =>
        receipt.disposition === 'unknown' &&
        sameTurn(receipt, interrupt) &&
        receipt.requestId === interrupt.requestId &&
        receipt.cause === interrupt.cause
    );
    if (index === -1 || !this.interrupted.includes(interrupt.requestId)) return;
    this.#interrupts[index] = { ...interrupt, disposition: 'cancelled' };
    delete worker.activeTurn;
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
              stop: worker.stop,
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
