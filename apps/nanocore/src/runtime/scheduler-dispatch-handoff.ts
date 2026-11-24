/**
 * Main selection handoff for one Core data root.
 *
 * One process-local record and one synchronous pure transition decide which Main pass selects and
 * posts, which caller gets which result, and when a released hold requests a scan. The rows are
 * data. An executor runs the returned effects and feeds each result back as one event. Core still
 * decides FIFO at the create commit. Nothing here is persisted, and nothing adds a wire field.
 */

/** A trigger snapshot. The record keeps one reference to the newest and copies no property. */
export interface HandoffSnapshot {
  readonly configVersion?: number | null | undefined;
}

export type HandoffStage = 'select' | 'barrier' | 'deny' | 'post';
export type HandoffSource = 'external' | 'wake';

export type HandoffQueuedReason =
  | 'agent-work-paused'
  | 'backend-busy'
  | 'entry-publication-pending'
  | 'max-dispatches'
  | 'no-queued-entry'
  | 'recovery-required'
  | 'thread-busy';

/** The retained claim identity: Core compares exactly these on a replay. */
export interface HandoffClaimIdentity {
  readonly attemptId: string;
  readonly inputHash: string;
  readonly preparationDigest: string;
}

export interface HandoffUnresolvedClaim extends HandoffClaimIdentity {
  /** The cause of a failed inspection of this claim, when one occurred. */
  readonly cause?: unknown;
}

/** The capacity that refused an entry. A Login close key releases only at its owner edge. */
export type HandoffCapacityKey =
  | { readonly kind: 'login-close'; readonly workspaceId: string; readonly threadId: string }
  | { readonly kind: 'backend'; readonly backendId: string };

/** Main-only holds that a scan can skip an entry for, or turn a pass away for. */
export type HandoffHold =
  | 'agent-work-paused'
  | 'active-preparation'
  | 'backend-capacity'
  | 'frozen-workspace'
  | 'local-invocation'
  | 'publication-pending'
  | 'scope-not-admitted'
  | 'unresolved-claim'
  | 'writer-unavailable';

export type HandoffOutcome =
  | { readonly kind: 'queued'; readonly reason: HandoffQueuedReason; readonly cause?: unknown }
  | { readonly kind: 'denied'; readonly entry: string; readonly denial: unknown }
  | { readonly kind: 'refused'; readonly entry: string; readonly refusal: unknown }
  | {
      readonly kind: 'failed';
      readonly entry: string | null;
      readonly stage: HandoffStage | 'invocation';
      readonly cause: unknown;
    };

/** What one caller receives. `entry` results never carry another entry's Turn or error. */
export type HandoffCallerResult<Turn> =
  | { readonly kind: 'join'; readonly entry: string; readonly invocation: string }
  | { readonly kind: 'pass'; readonly outcome: HandoffOutcome; readonly started: readonly Turn[] }
  | { readonly kind: 'entry'; readonly entry: string; readonly outcome: HandoffOutcome };

export interface HandoffCycle {
  readonly pass: number;
  readonly stage: HandoffStage;
  readonly entry: string | null;
  /** The Workspace admission handle that the selection acquired for `entry`. */
  readonly handle: boolean;
  /** The cycle already selected again after an unknown reply. */
  readonly reselected: boolean;
  /** The entry of that unknown reply, until the next selection reads it. */
  readonly replayEntry: string | null;
  readonly barrierProof: readonly string[] | null;
  readonly covered: readonly string[];
  readonly posted: { readonly identity: HandoffClaimIdentity; readonly retained: boolean } | null;
}

export interface HandoffPass<Turn> {
  readonly id: number;
  /** A pass that never held the cycle is fresh. */
  readonly begun: boolean;
  readonly posts: number;
  readonly dispatched: number;
  readonly max: number;
  readonly wakeOnly: boolean;
  readonly started: readonly Turn[];
  readonly recovery: readonly string[];
  readonly observedSource: boolean;
  readonly observedPublication: boolean;
  readonly undecided: boolean;
  readonly parkedOn: string | null;
  readonly barrierUsed: boolean;
  readonly failedInspections: readonly string[];
}

export interface HandoffWaiter {
  readonly pass: number;
  readonly entry: string | null;
}

export interface HandoffRecord<Snapshot extends HandoffSnapshot, Turn> {
  readonly budget: number;
  readonly nextPass: number;
  readonly cycle: HandoffCycle | null;
  readonly ready: readonly number[];
  readonly passes: Readonly<Record<number, HandoffPass<Turn>>>;
  readonly waiters: Readonly<Record<string, HandoffWaiter>>;
  /** Entry to the attempt ID of its published invocation. The promise stays with the executor. */
  readonly live: Readonly<Record<string, string>>;
  readonly unresolved: Readonly<Record<string, HandoffUnresolvedClaim>>;
  readonly busy: Readonly<Record<string, HandoffCapacityKey>>;
  readonly holdObserved: boolean;
  readonly snapshot: Snapshot | null;
}

export type HandoffSelection =
  | { readonly kind: 'paused' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'none'; readonly queuedRemain: boolean }
  | { readonly kind: 'deny'; readonly entry: string }
  | {
      readonly kind: 'claim';
      readonly entry: string;
      readonly identity: HandoffClaimIdentity;
      readonly retained: boolean;
    }
  | { readonly kind: 'barrier'; readonly covered: readonly string[] };

export interface HandoffSkip {
  readonly entry: string;
  readonly hold: HandoffHold;
  /** A pending publication whose source owner must recover it (missing input, recurring or external source). */
  readonly sourceRecovery?: boolean;
}

export type HandoffReplyClass =
  | 'claimed'
  | 'stale-original'
  | 'refused-rescan'
  | 'refused-final'
  | 'not-run'
  | 'unknown';

export type HandoffSettlement = 'dispatched' | 'backend-busy' | 'recovery-required' | 'failed';

export type HandoffEvent<Snapshot extends HandoffSnapshot, Turn> =
  | {
      readonly kind: 'trigger';
      readonly caller: string;
      readonly entry: string | null;
      readonly snapshot: Snapshot;
      readonly max: number;
      readonly source: HandoffSource;
    }
  | {
      readonly kind: 'selected';
      readonly selection: HandoffSelection;
      readonly skipped: readonly HandoffSkip[];
      /** Claims that leave by a barrier-proved no-row readback. */
      readonly discharged: readonly string[];
      /** Claims that leave because an exact durable row now holds them. */
      readonly recovered: readonly string[];
    }
  | {
      readonly kind: 'reply';
      readonly replyClass: HandoffReplyClass;
      readonly refusal?: unknown;
      readonly cause?: unknown;
    }
  | { readonly kind: 'barrier'; readonly acknowledged: boolean }
  | { readonly kind: 'denied'; readonly denial: unknown }
  | {
      readonly kind: 'failed';
      readonly stage: 'select' | 'deny';
      readonly entry: string | null;
      readonly cause: unknown;
      /** The unresolved claims whose inspection failed, including an inspection snapshot that could not open. */
      readonly inspections: readonly string[];
    }
  | { readonly kind: 'submitted'; readonly invocation: string; readonly turn: Turn }
  | ({
      readonly kind: 'settled';
      readonly entry: string;
      readonly invocation: string;
      readonly turn?: Turn;
      readonly cause?: unknown;
    } & (
      | { readonly outcome: Exclude<HandoffSettlement, 'backend-busy'> }
      | {
          readonly outcome: 'backend-busy';
          /** The refusing key and the held fact its owner read for the entry when the event was queued (E7). */
          readonly capacity: { readonly key: HandoffCapacityKey; readonly held: boolean };
        }
    ))
  | {
      readonly kind: 'released';
      readonly hold: HandoffHold;
      readonly key?: HandoffCapacityKey;
      /** For a backend key: the entries whose refusal predicate the owner read as clear. */
      readonly cleared?: readonly string[];
    };

export type HandoffEffect<Snapshot extends HandoffSnapshot, Turn> =
  | {
      readonly kind: 'select';
      readonly pass: number;
      readonly snapshot: Snapshot | null;
      readonly replayEntry: string | null;
      readonly barrierProof: readonly string[] | null;
      readonly barrierAllowed: boolean;
      readonly recovery: readonly string[];
      readonly skipBusy: boolean;
      readonly unresolved: Readonly<Record<string, HandoffUnresolvedClaim>>;
      readonly busy: Readonly<Record<string, HandoffCapacityKey>>;
    }
  | {
      readonly kind: 'post';
      readonly entry: string;
      readonly identity: HandoffClaimIdentity;
      readonly retained: boolean;
    }
  | { readonly kind: 'barrier'; readonly covered: readonly string[] }
  | { readonly kind: 'deny'; readonly entry: string }
  | { readonly kind: 'publish'; readonly entry: string; readonly invocation: string }
  | { readonly kind: 'release'; readonly entry: string }
  | { readonly kind: 'retire'; readonly entry: string; readonly invocation: string }
  | {
      readonly kind: 'resolve';
      readonly caller: string;
      readonly result: HandoffCallerResult<Turn>;
    }
  | { readonly kind: 'wake' };

export class HandoffTransitionError extends Error {}

/** Builds the empty record of one root. */
export function createHandoffRecord<Snapshot extends HandoffSnapshot, Turn>(
  budget: number
): HandoffRecord<Snapshot, Turn> {
  return {
    budget,
    nextPass: 1,
    cycle: null,
    ready: [],
    passes: {},
    waiters: {},
    live: {},
    unresolved: {},
    busy: {},
    holdObserved: false,
    snapshot: null,
  };
}

/** The claim-post budget of a pass: a current default. */
export const HANDOFF_CLAIM_POST_BUDGET = 20;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DraftPass<Turn> = Mutable<HandoffPass<Turn>> & {
  started: Turn[];
  recovery: string[];
  failedInspections: string[];
};

/** A copy-on-transition working record. Rows change it only through these steps. */
export class HandoffDraft<Snapshot extends HandoffSnapshot, Turn> {
  budget: number;
  nextPass: number;
  cycle: Mutable<HandoffCycle> | null;
  ready: number[];
  passes: Record<number, DraftPass<Turn>>;
  waiters: Record<string, HandoffWaiter>;
  live: Record<string, string>;
  unresolved: Record<string, HandoffUnresolvedClaim>;
  busy: Record<string, HandoffCapacityKey>;
  holdObserved: boolean;
  snapshot: Snapshot | null;
  readonly effects: HandoffEffect<Snapshot, Turn>[] = [];

  constructor(
    record: HandoffRecord<Snapshot, Turn>,
    readonly table: HandoffTable<Snapshot, Turn>
  ) {
    this.budget = record.budget;
    this.nextPass = record.nextPass;
    this.cycle = record.cycle ? { ...record.cycle } : null;
    this.ready = [...record.ready];
    this.passes = {};
    for (const pass of Object.values(record.passes))
      this.passes[pass.id] = {
        ...pass,
        started: [...pass.started],
        recovery: [...pass.recovery],
        failedInspections: [...pass.failedInspections],
      };
    this.waiters = { ...record.waiters };
    this.live = { ...record.live };
    this.unresolved = { ...record.unresolved };
    this.busy = { ...record.busy };
    this.holdObserved = record.holdObserved;
    this.snapshot = record.snapshot;
  }

  freeze(): HandoffRecord<Snapshot, Turn> {
    return {
      budget: this.budget,
      nextPass: this.nextPass,
      cycle: this.cycle,
      ready: this.ready,
      passes: this.passes,
      waiters: this.waiters,
      live: this.live,
      unresolved: this.unresolved,
      busy: this.busy,
      holdObserved: this.holdObserved,
      snapshot: this.snapshot,
    };
  }

  emit(effect: HandoffEffect<Snapshot, Turn>): void {
    this.effects.push(effect);
  }

  requireCycle(): Mutable<HandoffCycle> {
    if (!this.cycle) throw new HandoffTransitionError('The event requires a cycle.');
    return this.cycle;
  }

  requirePass(id: number): DraftPass<Turn> {
    const pass = this.passes[id];
    if (!pass) throw new HandoffTransitionError(`Pass ${id} does not exist.`);
    return pass;
  }

  cyclePass(): DraftPass<Turn> {
    return this.requirePass(this.requireCycle().pass);
  }

  waitersOf(passId: number): string[] {
    return Object.keys(this.waiters)
      .filter((caller) => this.waiters[caller]?.pass === passId)
      .sort();
  }

  /** Releases the cycle handle one time, if one is held. */
  releaseCycleHandle(): void {
    const cycle = this.cycle;
    if (cycle?.handle && cycle.entry !== null) {
      this.emit({ kind: 'release', entry: cycle.entry });
      cycle.handle = false;
    }
  }

  /** Ends the cycle; the caller decides what happens to its pass. */
  endCycle(): number {
    const cycle = this.requireCycle();
    this.cycle = null;
    return cycle.pass;
  }

  /** Resolves every waiter of the entry with the same result and removes it. */
  resolveEntryWaiters(entry: string, result: HandoffCallerResult<Turn>): void {
    for (const caller of Object.keys(this.waiters).sort())
      if (this.waiters[caller]?.entry === entry) {
        delete this.waiters[caller];
        this.emit({ kind: 'resolve', caller, result });
      }
  }

  /** Pass end: the cycle ends if the pass owns it, and each remaining waiter resolves. */
  endPass(passId: number, outcome: HandoffOutcome | null, ownerEntry: string | null): void {
    const pass = this.requirePass(passId);
    if (this.cycle?.pass === passId) this.cycle = null;
    this.ready = this.ready.filter((id) => id !== passId);
    for (const caller of this.waitersOf(passId)) {
      const waiter = this.waiters[caller]!;
      delete this.waiters[caller];
      if (outcome === null) continue;
      this.emit({
        kind: 'resolve',
        caller,
        result: this.table.callerResultAtPassEnd(this, pass, waiter, outcome, ownerEntry),
      });
    }
    delete this.passes[passId];
  }

  /** Resume: no waiter ends it, then the allowed count, then the budget, else the tail. */
  resume(passId: number, checkBudget = true): void {
    const pass = this.requirePass(passId);
    if (this.waitersOf(passId).length === 0) this.endPass(passId, null, null);
    else if (pass.dispatched >= pass.max)
      this.endPass(passId, { kind: 'queued', reason: 'max-dispatches' }, null);
    else if (checkBudget && pass.posts >= this.budget)
      this.endPass(
        passId,
        { kind: 'queued', reason: pass.undecided ? 'recovery-required' : 'thread-busy' },
        null
      );
    else this.ready.push(passId);
  }

  addRecovery(pass: DraftPass<Turn>, entry: string): void {
    if (!pass.recovery.includes(entry)) pass.recovery.push(entry);
    pass.undecided = true;
  }

  /** Drain: while no cycle exists, the head of the ready queue gets it or ends without waiters. */
  drain(): void {
    while (!this.cycle && this.ready.length > 0) {
      const head = this.ready.shift()!;
      if (this.waitersOf(head).length === 0) {
        this.endPass(head, null, null);
        continue;
      }
      const pass = this.requirePass(head);
      pass.begun = true;
      this.cycle = {
        pass: head,
        stage: 'select',
        entry: null,
        handle: false,
        reselected: false,
        replayEntry: null,
        barrierProof: null,
        covered: [],
        posted: null,
      };
      this.emitSelect();
    }
  }

  emitSelect(): void {
    const cycle = this.requireCycle();
    const pass = this.requirePass(cycle.pass);
    this.emit(this.table.selectEffect(this, cycle, pass));
  }

  /** Wake: an observed hold requests one coalesced scan. */
  wake(): void {
    // Row change R2 (explorer): a scan in flight may have read the hold before this release.
    if (!this.holdObserved && this.cycle?.stage !== 'select') return;
    this.holdObserved = false;
    this.emit({ kind: 'wake' });
  }
}

type EventOf<
  K extends HandoffEvent<HandoffSnapshot, unknown>['kind'],
  S extends HandoffSnapshot,
  T,
> = Extract<HandoffEvent<S, T>, { kind: K }>;

export interface HandoffRow<Snapshot extends HandoffSnapshot, Turn> {
  readonly id: string;
  readonly event: HandoffEvent<Snapshot, Turn>['kind'];
  readonly guard: (
    record: HandoffRecord<Snapshot, Turn>,
    event: HandoffEvent<Snapshot, Turn>
  ) => boolean;
  readonly apply: (
    draft: HandoffDraft<Snapshot, Turn>,
    event: HandoffEvent<Snapshot, Turn>
  ) => void;
}

export interface HandoffTable<Snapshot extends HandoffSnapshot, Turn> {
  readonly rows: readonly HandoffRow<Snapshot, Turn>[];
  /** Keyed-caller rule K3 and the unkeyed aggregate at pass end. */
  readonly callerResultAtPassEnd: (
    draft: HandoffDraft<Snapshot, Turn>,
    pass: HandoffPass<Turn>,
    waiter: HandoffWaiter,
    outcome: HandoffOutcome,
    ownerEntry: string | null
  ) => HandoffCallerResult<Turn>;
  readonly selectEffect: (
    draft: HandoffDraft<Snapshot, Turn>,
    cycle: HandoffCycle,
    pass: HandoffPass<Turn>
  ) => HandoffEffect<Snapshot, Turn>;
}

/** Defines one row for one event kind. */
export function handoffRow<K extends HandoffEvent<HandoffSnapshot, unknown>['kind']>(
  id: string,
  event: K,
  guard: <S extends HandoffSnapshot, T>(
    record: HandoffRecord<S, T>,
    event: EventOf<K, S, T>
  ) => boolean,
  apply: <S extends HandoffSnapshot, T>(draft: HandoffDraft<S, T>, event: EventOf<K, S, T>) => void
): HandoffRow<HandoffSnapshot, unknown> {
  return {
    id,
    event,
    guard: guard as HandoffRow<HandoffSnapshot, unknown>['guard'],
    apply: apply as HandoffRow<HandoffSnapshot, unknown>['apply'],
  };
}

const always = () => true;

function parkedPassOn<S extends HandoffSnapshot, T>(
  record: HandoffRecord<S, T>,
  invocation: string
) {
  return Object.values(record.passes).find((pass) => pass.parkedOn === invocation) ?? null;
}

function sameKey(left: HandoffCapacityKey, right: HandoffCapacityKey): boolean {
  return left.kind === 'login-close' && right.kind === 'login-close'
    ? left.workspaceId === right.workspaceId && left.threadId === right.threadId
    : left.kind === 'backend' && right.kind === 'backend' && left.backendId === right.backendId;
}

function isNewer(current: HandoffSnapshot | null, next: HandoffSnapshot): boolean {
  return current === null || (next.configVersion ?? -1) >= (current.configVersion ?? -1);
}

/** Applies a settlement's change to the busy set (T17, T18). A settlement removes no busy mark. */
function settleBusy<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  event: EventOf<'settled', S, T>
): void {
  if (event.outcome !== 'backend-busy') return;
  if (event.capacity.held) draft.busy[event.entry] = event.capacity.key;
  else draft.holdObserved = true;
}

/** Ends P after a cycle disposition that belongs to the cycle entry. */
function endWithEntryOutcome<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  outcome: HandoffOutcome
) {
  const cycle = draft.requireCycle();
  draft.releaseCycleHandle();
  draft.endPass(cycle.pass, outcome, cycle.entry);
}

/** Keeps the unresolved claims of entries, gives their waiters recovery, and resumes P. */
function keepForRecovery<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  entries: readonly string[],
  cause?: unknown
) {
  const pass = draft.cyclePass();
  draft.releaseCycleHandle();
  for (const entry of entries) draft.addRecovery(pass, entry);
  draft.endCycle();
  for (const entry of entries)
    draft.resolveEntryWaiters(entry, {
      kind: 'entry',
      entry,
      outcome: {
        kind: 'queued',
        reason: 'recovery-required',
        ...(cause !== undefined ? { cause } : {}),
      },
    });
  draft.resume(pass.id);
}

function recordUnresolved<S extends HandoffSnapshot, T>(draft: HandoffDraft<S, T>) {
  const cycle = draft.requireCycle();
  if (cycle.entry !== null && cycle.posted && !draft.unresolved[cycle.entry])
    draft.unresolved[cycle.entry] = cycle.posted.identity;
}

const isPostReply = (record: HandoffRecord<HandoffSnapshot, unknown>) =>
  record.cycle?.stage === 'post';

/** The closed transition set (T1-T22). Each reachable pair of record and event matches one row. */
export const HANDOFF_TRANSITIONS: readonly HandoffRow<HandoffSnapshot, unknown>[] = [
  handoffRow(
    'T1',
    'trigger',
    (record, event) => event.entry !== null && record.live[event.entry] !== undefined,
    (draft, event) =>
      draft.emit({
        kind: 'resolve',
        caller: event.caller,
        result: { kind: 'join', entry: event.entry!, invocation: draft.live[event.entry!]! },
      })
  ),
  handoffRow(
    'T2',
    'trigger',
    (record, event) => event.entry === null || record.live[event.entry] === undefined,
    (draft, event) => {
      let fresh = draft.ready.map((id) => draft.passes[id]!).find((pass) => !pass.begun);
      if (!fresh) {
        fresh = {
          id: draft.nextPass,
          begun: false,
          posts: 0,
          dispatched: 0,
          max: event.max,
          wakeOnly: event.source === 'wake',
          started: [],
          recovery: [],
          observedSource: false,
          observedPublication: false,
          undecided: false,
          parkedOn: null,
          barrierUsed: false,
          failedInspections: [],
        };
        draft.passes[fresh.id] = fresh;
        draft.nextPass += 1;
        draft.ready.push(fresh.id);
      } else {
        fresh.max = Math.max(fresh.max, event.max);
        fresh.wakeOnly = fresh.wakeOnly && event.source === 'wake';
      }
      if (isNewer(draft.snapshot, event.snapshot)) draft.snapshot = event.snapshot as never;
      draft.waiters[event.caller] = { pass: fresh.id, entry: event.entry };
    }
  ),
  handoffRow(
    'T3',
    'selected',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      (event.selection.kind === 'paused' ||
        event.selection.kind === 'preparing' ||
        event.selection.kind === 'none'),
    (draft, event) => {
      const pass = draft.cyclePass();
      const selection = event.selection;
      let reason: HandoffQueuedReason;
      if (selection.kind === 'paused') {
        reason = 'agent-work-paused';
        draft.holdObserved = true;
      } else if (selection.kind === 'preparing') {
        reason = 'thread-busy';
        draft.holdObserved = true;
      } else if (pass.undecided || pass.observedSource) reason = 'recovery-required';
      else if (pass.observedPublication) reason = 'entry-publication-pending';
      else
        reason =
          selection.kind === 'none' && selection.queuedRemain ? 'thread-busy' : 'no-queued-entry';
      draft.endPass(pass.id, { kind: 'queued', reason }, null);
    }
  ),
  handoffRow(
    'T4',
    'selected',
    (record, event) => record.cycle?.stage === 'select' && event.selection.kind === 'deny',
    (draft, event) => {
      const cycle = draft.requireCycle();
      cycle.stage = 'deny';
      cycle.entry = (event.selection as { entry: string }).entry;
      cycle.handle = true;
      draft.emit({ kind: 'deny', entry: cycle.entry });
    }
  ),
  handoffRow(
    'T5',
    'denied',
    (record) => record.cycle?.stage === 'deny',
    (draft, event) =>
      endWithEntryOutcome(draft, {
        kind: 'denied',
        entry: draft.requireCycle().entry!,
        denial: event.denial,
      })
  ),
  handoffRow(
    'T6',
    'selected',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      event.selection.kind === 'claim' &&
      record.passes[record.cycle.pass]!.posts < record.budget,
    (draft, event) => {
      const selection = event.selection as Extract<HandoffSelection, { kind: 'claim' }>;
      const cycle = draft.requireCycle();
      draft.cyclePass().posts += 1;
      cycle.stage = 'post';
      cycle.entry = selection.entry;
      cycle.handle = true;
      cycle.posted = { identity: selection.identity, retained: selection.retained };
      draft.emit({
        kind: 'post',
        entry: selection.entry,
        identity: selection.identity,
        retained: selection.retained,
      });
    }
  ),
  handoffRow(
    'T6b',
    'selected',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      event.selection.kind === 'claim' &&
      record.passes[record.cycle.pass]!.posts >= record.budget,
    (draft, event) => {
      const cycle = draft.requireCycle();
      cycle.entry = (event.selection as { entry: string }).entry;
      cycle.handle = true;
      draft.releaseCycleHandle();
      draft.resume(draft.endCycle());
    }
  ),
  handoffRow(
    'T7',
    'reply',
    (record, event) => isPostReply(record) && event.replyClass === 'claimed',
    (draft) => {
      const cycle = draft.requireCycle();
      const entry = cycle.entry!;
      const invocation = cycle.posted!.identity.attemptId;
      delete draft.unresolved[entry];
      draft.live[entry] = invocation;
      draft.cyclePass().parkedOn = invocation;
      draft.endCycle();
      draft.emit({ kind: 'publish', entry, invocation });
      draft.resolveEntryWaiters(entry, { kind: 'join', entry, invocation });
    }
  ),
  handoffRow(
    'T8',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      (event.replyClass === 'stale-original' || event.replyClass === 'refused-rescan'),
    (draft, event) => {
      if (event.replyClass === 'stale-original')
        delete draft.unresolved[draft.requireCycle().entry!];
      draft.releaseCycleHandle();
      draft.resume(draft.endCycle());
    }
  ),
  handoffRow(
    'T9',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      event.replyClass === 'refused-final' &&
      !record.cycle!.posted!.retained,
    (draft, event) =>
      endWithEntryOutcome(draft, {
        kind: 'refused',
        entry: draft.requireCycle().entry!,
        refusal: event.refusal,
      })
  ),
  handoffRow(
    'T9r',
    'reply',
    (record, event) =>
      isPostReply(record) && event.replyClass === 'refused-final' && record.cycle!.posted!.retained,
    (draft) => keepForRecovery(draft, [draft.requireCycle().entry!])
  ),
  handoffRow(
    'T10',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      event.replyClass === 'not-run' &&
      !record.unresolved[record.cycle!.entry!],
    (draft, event) =>
      endWithEntryOutcome(draft, {
        kind: 'failed',
        entry: draft.requireCycle().entry!,
        stage: 'post',
        cause: event.cause,
      })
  ),
  handoffRow(
    'T11',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      event.replyClass === 'not-run' &&
      !!record.unresolved[record.cycle!.entry!],
    (draft) => keepForRecovery(draft, [draft.requireCycle().entry!])
  ),
  handoffRow(
    'T12',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      event.replyClass === 'unknown' &&
      !record.cycle!.reselected &&
      record.passes[record.cycle!.pass]!.posts < record.budget,
    (draft) => {
      recordUnresolved(draft);
      draft.releaseCycleHandle();
      const cycle = draft.requireCycle();
      cycle.reselected = true;
      cycle.replayEntry = cycle.entry;
      cycle.stage = 'select';
      cycle.entry = null;
      cycle.posted = null;
      draft.emitSelect();
    }
  ),
  handoffRow(
    'T13',
    'reply',
    (record, event) =>
      isPostReply(record) &&
      event.replyClass === 'unknown' &&
      (record.cycle!.reselected || record.passes[record.cycle!.pass]!.posts >= record.budget),
    (draft) => {
      recordUnresolved(draft);
      keepForRecovery(draft, [draft.requireCycle().entry!]);
    }
  ),
  handoffRow(
    'T14',
    'failed',
    (record, event) =>
      record.cycle !== null &&
      record.cycle.stage === event.stage &&
      (event.stage === 'deny' || event.inspections.length === 0),
    (draft, event) => {
      // An ordinary queue-walk or denial failure belongs to the entry that failed.
      const cycle = draft.requireCycle();
      const entry = event.stage === 'deny' ? cycle.entry : event.entry;
      draft.releaseCycleHandle();
      draft.endPass(
        cycle.pass,
        { kind: 'failed', entry, stage: event.stage, cause: event.cause },
        entry
      );
    }
  ),
  handoffRow(
    'T14r',
    'failed',
    (record, event) =>
      record.cycle?.stage === 'select' && event.stage === 'select' && event.inspections.length > 0,
    (draft, event) => {
      const pass = draft.cyclePass();
      const again = event.inspections.some((entry) => pass.failedInspections.includes(entry));
      for (const entry of event.inspections) {
        const claim = draft.unresolved[entry];
        if (claim) draft.unresolved[entry] = { ...claim, cause: event.cause };
        if (!pass.failedInspections.includes(entry)) pass.failedInspections.push(entry);
      }
      if (!again) return keepForRecovery(draft, event.inspections, event.cause);
      draft.releaseCycleHandle();
      for (const entry of event.inspections) draft.addRecovery(pass, entry);
      draft.endCycle();
      for (const entry of event.inspections)
        draft.resolveEntryWaiters(entry, {
          kind: 'entry',
          entry,
          outcome: { kind: 'queued', reason: 'recovery-required', cause: event.cause },
        });
      draft.endPass(
        pass.id,
        { kind: 'queued', reason: 'recovery-required', cause: event.cause },
        null
      );
    }
  ),
  handoffRow(
    'T15',
    'submitted',
    (record, event) => parkedPassOn(record, event.invocation) !== null,
    (draft, event) => {
      const pass = draft.requirePass(parkedPassOn(draft.freeze(), event.invocation)!.id);
      pass.parkedOn = null;
      pass.started.push(event.turn);
      pass.dispatched += 1;
      draft.resume(pass.id);
    }
  ),
  handoffRow(
    'T16',
    'submitted',
    (record, event) => parkedPassOn(record, event.invocation) === null,
    () => {}
  ),
  handoffRow(
    'T17',
    'settled',
    (record, event) =>
      record.live[event.entry] === event.invocation &&
      parkedPassOn(record, event.invocation) !== null,
    (draft, event) => {
      const pass = draft.requirePass(parkedPassOn(draft.freeze(), event.invocation)!.id);
      delete draft.live[event.entry];
      pass.parkedOn = null;
      settleBusy(draft, event);
      draft.emit({ kind: 'retire', entry: event.entry, invocation: event.invocation });
      draft.emit({ kind: 'release', entry: event.entry });
      if (event.outcome === 'dispatched') {
        if (event.turn !== undefined) pass.started.push(event.turn);
        pass.dispatched += 1;
        draft.resume(pass.id);
      } else if (event.outcome === 'recovery-required') {
        draft.addRecovery(pass, event.entry);
        pass.observedSource = true;
        draft.resume(pass.id);
      } else if (event.outcome === 'backend-busy')
        draft.endPass(pass.id, { kind: 'queued', reason: 'backend-busy' }, null);
      else
        draft.endPass(
          pass.id,
          { kind: 'failed', entry: event.entry, stage: 'invocation', cause: event.cause },
          event.entry
        );
      draft.wake();
    }
  ),
  handoffRow(
    'T18',
    'settled',
    (record, event) =>
      record.live[event.entry] === event.invocation &&
      parkedPassOn(record, event.invocation) === null,
    (draft, event) => {
      delete draft.live[event.entry];
      settleBusy(draft, event);
      draft.emit({ kind: 'retire', entry: event.entry, invocation: event.invocation });
      draft.emit({ kind: 'release', entry: event.entry });
      draft.wake();
    }
  ),
  handoffRow(
    'T18s',
    'settled',
    (record, event) => record.live[event.entry] !== event.invocation,
    () => {}
  ),
  handoffRow('T19', 'released', always, (draft, event) => {
    const key = event.hold === 'backend-capacity' ? event.key : undefined;
    if (key) {
      let removed = false;
      // Row change R3 (V1-P round 4): a backend owner releases only the entries whose refusal
      // predicate it read as clear. A Login close release clears every mark with its key.
      for (const entry of Object.keys(draft.busy))
        if (
          sameKey(draft.busy[entry]!, key) &&
          (key.kind === 'login-close' || event.cleared?.includes(entry) === true)
        ) {
          delete draft.busy[entry];
          removed = true;
        }
      // Row change R1 (explorer): a removed mark requests one coalesced scan.
      if (removed) draft.holdObserved = true;
    }
    draft.wake();
  }),
  handoffRow(
    'T20',
    'selected',
    (record, event) => record.cycle?.stage === 'select' && event.selection.kind === 'barrier',
    (draft, event) => {
      const cycle = draft.requireCycle();
      cycle.stage = 'barrier';
      cycle.covered = [...(event.selection as { covered: readonly string[] }).covered];
      draft.cyclePass().barrierUsed = true;
      draft.emit({ kind: 'barrier', covered: cycle.covered });
    }
  ),
  handoffRow(
    'T21',
    'barrier',
    (record, event) => record.cycle?.stage === 'barrier' && event.acknowledged,
    (draft) => {
      const cycle = draft.requireCycle();
      cycle.barrierProof = cycle.covered;
      cycle.stage = 'select';
      draft.emitSelect();
    }
  ),
  handoffRow(
    'T22',
    'barrier',
    (record, event) => record.cycle?.stage === 'barrier' && !event.acknowledged,
    (draft) => keepForRecovery(draft, draft.requireCycle().covered)
  ),
];

/** K3 for a keyed waiter, and the aggregate for an unkeyed one. */
export function handoffCallerResultAtPassEnd<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  pass: HandoffPass<T>,
  waiter: HandoffWaiter,
  outcome: HandoffOutcome,
  ownerEntry: string | null
): HandoffCallerResult<T> {
  if (waiter.entry === null) return { kind: 'pass', outcome, started: [...pass.started] };
  const entry = waiter.entry;
  if (ownerEntry === entry) return { kind: 'entry', entry, outcome };
  let reason: HandoffQueuedReason;
  if (draft.unresolved[entry] || pass.recovery.includes(entry)) reason = 'recovery-required';
  else if (outcome.kind !== 'queued' || outcome.reason === 'recovery-required')
    reason = 'thread-busy';
  else reason = outcome.reason;
  return { kind: 'entry', entry, outcome: { kind: 'queued', reason } };
}

/** The `select` effect carries the read-only facts that the selection needs from the record. */
export function handoffSelectEffect<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  cycle: HandoffCycle,
  pass: HandoffPass<T>
): HandoffEffect<S, T> {
  return {
    kind: 'select',
    pass: pass.id,
    snapshot: draft.snapshot,
    replayEntry: cycle.replayEntry,
    barrierProof: cycle.barrierProof,
    barrierAllowed: !pass.barrierUsed,
    recovery: [...pass.recovery],
    skipBusy: pass.wakeOnly,
    unresolved: { ...draft.unresolved },
    busy: { ...draft.busy },
  };
}

export const HANDOFF_TABLE: HandoffTable<HandoffSnapshot, unknown> = {
  rows: HANDOFF_TRANSITIONS,
  callerResultAtPassEnd: handoffCallerResultAtPassEnd,
  selectEffect: handoffSelectEffect,
};

/** Selection first: discharges, recoveries and reported skips apply before every `selected` row. */
function applySelectionFirst<S extends HandoffSnapshot, T>(
  draft: HandoffDraft<S, T>,
  event: EventOf<'selected', S, T>
): void {
  const cycle = draft.requireCycle();
  const pass = draft.cyclePass();
  cycle.replayEntry = null;
  // The selection that reads the barrier proof consumes it (A8 r7-step3 finding 1). A claim
  // posted after the barrier is not covered, so a later selection cannot discharge it.
  cycle.barrierProof = null;
  for (const entry of event.discharged) delete draft.unresolved[entry];
  for (const entry of event.recovered) {
    delete draft.unresolved[entry];
    if (!pass.recovery.includes(entry)) pass.recovery.push(entry);
    pass.observedSource = true;
  }
  for (const skip of event.skipped) {
    draft.holdObserved = true;
    // A scope that is not admitted is both a source recovery and a pending publication.
    if (skip.hold === 'publication-pending' || skip.hold === 'scope-not-admitted')
      pass.observedPublication = true;
    if (
      skip.hold === 'unresolved-claim' ||
      skip.hold === 'scope-not-admitted' ||
      skip.sourceRecovery === true
    )
      pass.observedSource = true;
  }
}

export interface HandoffDecision<Snapshot extends HandoffSnapshot, Turn> {
  readonly record: HandoffRecord<Snapshot, Turn>;
  readonly effects: readonly HandoffEffect<Snapshot, Turn>[];
  readonly row: string;
}

/** The one synchronous pure transition. Exactly one row MUST match; otherwise it throws. */
export function decideHandoff<Snapshot extends HandoffSnapshot, Turn>(
  record: HandoffRecord<Snapshot, Turn>,
  event: HandoffEvent<Snapshot, Turn>,
  table: HandoffTable<Snapshot, Turn> = HANDOFF_TABLE as unknown as HandoffTable<Snapshot, Turn>
): HandoffDecision<Snapshot, Turn> {
  const matches = table.rows.filter((row) => row.event === event.kind && row.guard(record, event));
  if (matches.length !== 1)
    throw new HandoffTransitionError(
      `Event ${event.kind} matched ${matches.length} rows: ${matches.map((row) => row.id).join(', ') || 'none'}.`
    );
  const row = matches[0]!;
  const draft = new HandoffDraft(record, table);
  if (event.kind === 'selected') applySelectionFirst(draft, event);
  row.apply(draft, event);
  draft.drain();
  return { record: draft.freeze(), effects: draft.effects, row: row.id };
}

/** How the claim command ended, with the stage that the claim command reports. */
export type HandoffClaimOutcome =
  | { readonly kind: 'attempt'; readonly openWithoutProgress: boolean }
  | { readonly kind: 'refusal'; readonly reason: 'placement-held' | 'selection-changed' | null }
  | {
      readonly kind: 'error';
      readonly stage: 'prepare' | 'open' | 'create';
      readonly commit: 'not-committed' | 'unknown' | 'untyped';
    };

/** The reply class is a function of the stage and the outcome. No wire field is added. */
export function classifyClaimReply(outcome: HandoffClaimOutcome): HandoffReplyClass {
  if (outcome.kind === 'attempt') return outcome.openWithoutProgress ? 'claimed' : 'stale-original';
  if (outcome.kind === 'refusal')
    return outcome.reason === null ? 'refused-final' : 'refused-rescan';
  if (outcome.stage !== 'create' || outcome.commit === 'not-committed') return 'not-run';
  return 'unknown';
}

/** One readback of an unresolved claim in the selection snapshot. */
export interface HandoffReadback {
  /** The cycle selects again after an unknown reply for this entry. */
  readonly replayAfterUnknown: boolean;
  readonly row: 'none' | 'exact' | 'other';
  /** The current pause, authority, eligibility and proposal-digest checks pass for the entry. */
  readonly checksPass: boolean;
  readonly proofCovers: boolean;
  readonly queued: boolean;
  /** `pending` before the ordered walk reaches the entry. */
  readonly walkCandidate: 'pending' | 'yes' | 'no';
  readonly sameDigest: boolean;
  readonly barrierAllowed: boolean;
}

export type HandoffUnresolvedDisposition =
  | 'immediate-replay'
  | 'discharge-recovery'
  | 'integrity-hold'
  | 'discharge'
  | 'replay'
  | 'barrier'
  | 'walk'
  | 'hold';

/** The ordered readback table. The first matching row decides. `walk` defers to the ordered walk. */
export const UNRESOLVED_DISPOSITION: readonly {
  readonly disposition: HandoffUnresolvedDisposition;
  readonly when: (readback: HandoffReadback) => boolean;
}[] = [
  {
    disposition: 'immediate-replay',
    when: (r) => r.replayAfterUnknown && r.row === 'exact' && r.checksPass,
  },
  { disposition: 'discharge-recovery', when: (r) => r.row === 'exact' },
  { disposition: 'integrity-hold', when: (r) => r.row === 'other' },
  { disposition: 'discharge', when: (r) => r.proofCovers },
  { disposition: 'replay', when: (r) => r.walkCandidate === 'yes' && r.sameDigest },
  {
    disposition: 'barrier',
    when: (r) => r.barrierAllowed && ((r.walkCandidate === 'yes' && !r.sameDigest) || !r.queued),
  },
  { disposition: 'walk', when: (r) => r.queued && r.walkCandidate === 'pending' },
  { disposition: 'hold', when: always },
];

export function classifyUnresolvedReadback(
  readback: HandoffReadback,
  table: typeof UNRESOLVED_DISPOSITION = UNRESOLVED_DISPOSITION
): HandoffUnresolvedDisposition {
  return table.find((row) => row.when(readback))!.disposition;
}

/** The closed hold set with each exit and its production owner. */
export const MAIN_HOLD_EXITS: Readonly<
  Record<HandoffHold, { readonly exit: string; readonly owner: string; readonly wakeRow: string }>
> = {
  'local-invocation': { exit: 'The invocation settles.', owner: 'handoff', wakeRow: 'T17/T18' },
  'active-preparation': {
    exit: 'First-submit ACK on the native and generic paths, or the closing or close ACK.',
    owner: 'submission owner and attempt maintenance owner',
    wakeRow: 'T19',
  },
  'frozen-workspace': {
    exit: 'Mutation end, private freeze-handle release or capture rollback.',
    owner: 'Workspace mutation gate',
    wakeRow: 'T19',
  },
  'scope-not-admitted': {
    exit: 'The exact admission failure is removed.',
    owner: 'bootstrap scope recovery',
    wakeRow: 'T19',
  },
  'agent-work-paused': {
    exit: 'An applied reload that is not a dry run clears the pause.',
    owner: 'runtime configuration reload owner',
    wakeRow: 'T19',
  },
  'publication-pending': {
    exit: 'The last owner acknowledgement that completes input and publication.',
    owner: 'command owner and recurring schedule service',
    wakeRow: 'T19',
  },
  'unresolved-claim': {
    exit: 'A readback discharge or restart.',
    owner: 'handoff and restart classification',
    wakeRow: 'selection',
  },
  'backend-capacity': {
    exit: 'Login close key: the last original close clears. Backend key: the owner reads the refusal predicate of the entry as clear.',
    owner: 'NanoHost Login close owner, NanoHost backend owner and handoff',
    wakeRow: 'T19',
  },
  'writer-unavailable': {
    exit: 'Owner recovery or restart.',
    owner: 'restart',
    wakeRow: 'startup',
  },
};
