import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CaptureState,
  type CloseCause,
  type CloseClock,
  type ClosePremises,
  COLD_RULES,
  type ColdAction,
  type ColdFacts,
  type ColdRule,
  type CredentialCutoff,
  composeCold,
  decideFirstBytes,
  decidePost,
  type HarnessFacts,
  limitingClock,
  type PostPremises,
  REPLACEMENT_CLOSE_TABLE,
  type ReplacementCloseTable,
  type RestoreFrame,
  restorable,
  restoresFrame,
  type SandboxFacts,
  sandboxOpen,
  settledCloseProof,
  slotClock,
} from './replacement-close-lifecycle.js';

/*
 * Independent environment model and bounded explorer for the replacement close lifecycle
 * (NanoHost spec, "Replacement Close Lifecycle" and its Conformance section).
 *
 * The environment makes only the writes that a real owner can make. It keeps posts, commits,
 * ACKs, captures, receipts, occupancy and handed-off bytes as separate raw facts. A provenance
 * record `p` keeps who really drained the Harness and which keys really committed. The table
 * under test never reads `p`. The oracles read only the raw facts and `p`.
 */

/**
 * The wall clocks. `Ti` is the cutoff of a required credential other than the presented one: an
 * issuer Token with its rotation grace, or the session-projected admin Token. Main folds it into Ta.
 */
type ModelClock = CloseClock | 'Ti';

type Env =
  | ModelClock
  | 'TcMono'
  | 'Wback'
  | 'W'
  | 'thread'
  | 'policy'
  | 'R'
  | 'idle'
  | 'core'
  | 'pend'
  | 'S'
  | 'X'
  | 'open'
  | 'hdrain'
  | 'sbdrain'
  | 'fail'
  | 'unknown'
  | 'expiry-old'
  | 'reuse'
  | 'hide'
  | 'crash'
  | 'foreign-claim'
  | 'replay'
  | 'requeue'
  // G3 reuse writers on a released row, relative to the revision P of a pending restore frame:
  // `session.open` settles at P-1 or P+1, a binding opens at P-1 with no sequence change, or the
  // same-name Harness is recreated at P-1.
  | 'open@99'
  | 'open@101'
  | 'bind@99'
  | 'recreate'
  /**
   * G3 (S3b-m-r2, V1-P FIX 2 item 1): an independent Harness drain that Native stamps with the
   * supplied wall instant, equal to the stamp of the claim before it. The revision stays.
   */
  | 'hdrain@claim'
  /**
   * S3b H4-1: the wall steps back below the last passed deadline, above the enqueue instant. A
   * deeper step back also goes below earlier passed deadlines (S3b-m-r2).
   */
  | 'Wpart'
  /** S3b H4-2: after the queue ACK, an issuer rotation shortens the grace cutoff Ti. */
  | 'rotate'
  /** S3b H4-3: Native commits, loses its reply and exits; Main keeps its waiter and exclusion. */
  | 'wcrash';

type Phase =
  | 'idle'
  | 'registered'
  | 'ws'
  | 'latched'
  | 'raw'
  | 'published'
  | 'held'
  | 'posted'
  | 'replying'
  | 'queued'
  | 'unknown-reply'
  | 'settled'
  | 'done'
  | 'refused'
  | 'fenced'
  | 'dead';

const ACTIVE: readonly Phase[] = [
  'registered',
  'ws',
  'latched',
  'raw',
  'published',
  'held',
  'posted',
  'replying',
  'queued',
  'unknown-reply',
  'settled',
];

interface Closer {
  phase: Phase;
  gen: number;
  claimRev: number | null;
  seq: number | null;
  slot: boolean;
  /** The Core hold pins R and B; the successor Workspace hold pins A. */
  coreHold: boolean;
  wsHold: boolean;
  /** The Native queue decision whose reply has not reached Main yet. */
  decision: CloseCause | 'commit' | null;
  answer: string | null;
  cause: CloseCause | null;
  settleRev: number | null;
  /** G3: the claim generation that this closer's RC3 wrote. */
  claimGen: string | null;
  /** F-b: this generation replays its published capture receipt. RC3 claims again; no new Workspace claim. */
  replay?: boolean;
  /** H4-2: this closer posted after the rotation. */
  rotatedAtPost?: boolean;
}

interface State {
  sb: { accepting: boolean; clean: boolean; currentEpoch: boolean };
  h: HarnessFacts;
  occ: number;
  present: Record<string, boolean>;
  cap: Record<string, CaptureState>;
  hidden: string | null;
  core: Record<
    string,
    null | { key: string; result: 'succeeded' | 'stale'; revision: number | null }
  >;
  excl: string | null;
  c: Record<string, Closer>;
  reserved: string | null;
  polled: string[];
  lost: string[];
  /** Keys whose live settlement owner still runs (volatile). */
  settling: string[];
  prem: {
    R: boolean;
    thread: boolean;
    policy: boolean;
    idle: boolean;
    pend: boolean;
    S: boolean;
    X: boolean;
  };
  /**
   * Wall deadlines pass in this order; a live deadline is later than every passed one. `back`: the
   * wall clock stepped back before the original enqueue instant, so before every deadline. The
   * monotonic Tc and the caller bound W are separate. `part`: the wall stepped back above the
   * enqueue instant (H4-1); `kept` passed deadlines stay behind it.
   */
  clock: {
    passed: ModelClock[];
    back: boolean;
    part: boolean;
    kept: number;
    mono: boolean;
    W: boolean;
  };
  /** The policy publisher has its activation ACK; the Main swap of the applied policy waits. */
  install: boolean;
  /** The successor request was requeued: this attempt fails R, and the retry carries a fresh request. */
  requeued?: boolean;
  cold: Record<string, RestoreFrame | null>;
  /** G3: restore frames whose first delivery committed and that can arrive again (a lost ACK). */
  dup: { frame: RestoreFrame; by: string }[];
  /** H4-2: `pending` until the rotation after the queue ACK. */
  rotation?: 'pending' | 'done';
  used: string[];
  after: boolean;
  /** Provenance for the oracles only. */
  p: {
    drainBy: string[];
    committed: string[];
    bytes: Record<string, number>;
    contact: string[];
    unsent: string[];
    succ: number;
    owed: number;
    occ0: number;
    /** Closers whose claim wrote no generation (older writers). */
    ungen: string[];
    /** Duplicate restore deliveries. */
    redelivered: number;
  };
}

interface World {
  readonly name: string;
  readonly closers: readonly string[];
  readonly bindings: readonly string[];
  readonly env: readonly Env[];
  readonly budget: number;
  readonly polls: readonly string[];
  readonly lostReply?: boolean;
  readonly transport?: boolean;
  readonly resultLost?: boolean;
  readonly restart?: boolean;
  readonly retry?: boolean;
  /** F-b: a refused closer with a published receipt retries by replaying it (RC3 claims again). */
  readonly replay?: boolean;
  readonly splitCold?: readonly string[];
  /** Older writers before the crash: c1 claims leave the revision; r2 claims advance it. */
  readonly legacy?: 'c1' | 'r2';
  /** Phases that the live closers may reach. Undefined: all. */
  readonly stopAt?: Phase;
  /** The same, for one closer. */
  readonly stop?: Readonly<Record<string, Phase>>;
  /** G3: a committed restore frame can be delivered again later. */
  readonly redeliver?: boolean;
  /** H4-1: two clock moves in one gather. */
  readonly multiMove?: boolean;
  readonly init?: (s: State) => void;
  /** Named histories: the explorer reports their count, fence classes and first trace. */
  readonly probes?: Readonly<Record<string, (s: State) => boolean>>;
}

const sandboxFacts = (s: State): SandboxFacts => ({ ...s.sb });

function initial(world: World): State {
  const s: State = {
    sb: { accepting: true, clean: true, currentEpoch: true },
    h: {
      life: 'open',
      drain: 'accepting',
      revision: 0,
      operation: null,
      cell: 'idle',
      key: null,
      sequence: null,
      result: null,
      nextSequence: 0,
      claimGeneration: null,
    },
    occ: world.bindings.length,
    present: Object.fromEntries(world.bindings.map((b) => [b, true])),
    cap: Object.fromEntries(world.bindings.map((b) => [b, 'none' as CaptureState])),
    hidden: null,
    core: Object.fromEntries(world.bindings.map((b) => [b, null])),
    excl: null,
    c: Object.fromEntries(
      world.closers.map((b) => [
        b,
        {
          phase: 'idle' as Phase,
          gen: 1,
          claimRev: null,
          seq: null,
          slot: false,
          coreHold: false,
          wsHold: false,
          decision: null,
          answer: null,
          cause: null,
          settleRev: null,
          claimGen: null,
        },
      ])
    ),
    reserved: null,
    polled: [],
    lost: [],
    settling: [],
    prem: {
      R: true,
      thread: true,
      policy: true,
      idle: true,
      pend: true,
      S: true,
      X: true,
    },
    clock: { passed: [], back: false, part: false, kept: 0, mono: false, W: false },
    install: false,
    cold: Object.fromEntries((world.splitCold ?? []).map((k) => [k, null])),
    dup: [],
    used: [],
    after: world.legacy === undefined,
    p: {
      drainBy: [],
      committed: [],
      bytes: {},
      contact: [],
      unsent: [],
      succ: 0,
      owed: 0,
      occ0: world.bindings.length,
      ungen: [],
      redelivered: 0,
    },
  };
  world.init?.(s);
  return s;
}

const clone = (s: State): State => JSON.parse(JSON.stringify(s)) as State;
const keyOf = (b: string, c: Closer) => `${b}${c.gen}`;
const ownerOfKey = (key: string) => key.slice(0, 1);
/** G3: the fresh identifier of one acquisition. A closer generation claims at most once. */
const generationOf = (b: string, c: Closer) => `g${b}${c.gen}`;

/**
 * The older claim and restore, for data roots that older writers produced. The claim writes no
 * generation, and the older restore compares the revision alone.
 */
function legacyTable(t: ReplacementCloseTable, kind: 'c1' | 'r2'): ReplacementCloseTable {
  return {
    ...t,
    admit: () => null,
    claim: (h) => ({ revision: kind === 'r2' ? h.revision + 1 : h.revision, generation: null }),
    restore: (h, s, frame) => restorable(h, s) && h.revision === frame.revision,
    // The older queue compares the claim revision alone.
    queue: (input) => t.queue({ ...input, claimGeneration: undefined }),
  };
}

type Violation = { readonly name: string; readonly detail: string };

interface Ctx {
  readonly world: World;
  readonly table: ReplacementCloseTable;
  readonly violations: Violation[];
  /** The RC10 decision of this edge, for directed checks. It is no state. */
  decided?: string;
}

const violate = (ctx: Ctx, name: string, detail: string) => ctx.violations.push({ name, detail });

const liveTable = (ctx: Ctx, s: State) =>
  s.after || !ctx.world.legacy ? ctx.table : legacyTable(ctx.table, ctx.world.legacy);

const LIVE_DEADLINE = 1_000_000;
/** The original enqueue wall instant. Every deadline is later. */
const ADMITTED = 0;
const deadlineOf = (s: State, clock: ModelClock) => {
  const at = s.clock.passed.indexOf(clock);
  return at < 0 ? LIVE_DEADLINE : at + 1;
};
/** After `Wpart` the wall reads just above the `kept` earliest passed deadlines. */
const wallNow = (s: State) => nowOf(s.clock);
const wallPassed = (s: State, clock: ModelClock) => deadlineOf(s, clock) <= wallNow(s);
/** Oracle: an expiring credential that the admission requires has passed on the wall. */
const authorityPassed = (s: State) => wallPassed(s, 'Ta') || wallPassed(s, 'Ti');

/** The clock as one read sees it. The deadlines are fixed facts; only the sample moves. */
type ClockView = State['clock'];
function nowOf(clock: ClockView): number {
  return clock.back ? ADMITTED - 1 : clock.part ? clock.kept + 0.5 : clock.passed.length;
}

/**
 * The clocks of one decision. `sample` is the clock sample of the decision. Two reads also check a
 * clock themselves: the P14 owner refuses an elapsed Ts, and the R reader (F
 * `isAgentSessionReplacementRequestCurrent`) refuses an elapsed credential, issuer grace included.
 */
interface ClockViews {
  readonly sample: ClockView;
  readonly audience: ClockView;
  readonly request: ClockView;
}

/** The premises of one decision. Every view defaults to the current clock. */
function premises(
  s: State,
  pendingOwner: boolean,
  t: ReplacementCloseTable,
  view: ClockViews = { sample: s.clock, audience: s.clock, request: s.clock }
): ClosePremises {
  const cutoffs: CredentialCutoff[] = [
    { credential: 'presented', at: deadlineOf(s, 'Ta') },
    { credential: 'issuer', at: deadlineOf(s, 'Ti') },
  ];
  const credentialsLive =
    deadlineOf(s, 'Ta') > nowOf(view.request) && deadlineOf(s, 'Ti') > nowOf(view.request);
  return {
    pendingOwner,
    // The R reader refuses a closed request first, then an elapsed credential with its reason.
    request: !s.prem.R ? false : credentialsLive ? true : 'expired',
    // The P14 owner reports A. Its contributor authorizer also refuses an elapsed Ts (A8-2).
    audience: {
      thread: !s.prem.thread
        ? false
        : deadlineOf(s, 'Ts') > nowOf(view.audience)
          ? true
          : 'expired',
      policy: s.prem.policy,
    },
    idleReceipt: s.prem.idle,
    storage: s.prem.S,
    placement: { harness: s.h.life, sandbox: sandboxFacts(s) },
    connection: s.prem.X,
    deadlines: {
      Tc: deadlineOf(s, 'Tc'),
      Ts: deadlineOf(s, 'Ts'),
      Ta: t.authorityDeadline(cutoffs),
    },
    admitted: ADMITTED,
    now: nowOf(view.sample),
    closeMonotonicExpired: view.sample.mono,
  };
}

/* ------------------------------------------------- CL2: clock events inside an effect gather */

/**
 * The clock writers. Each passes once within the budget. After a step back the wall stays behind.
 * `Wpart` is no environment step: it moves only inside a gather (H4-1, see `gathers`).
 */
const CLOCK_EVENTS = ['Tc', 'Ts', 'Ta', 'Ti', 'Wback', 'TcMono', 'Wpart'] as const;
type ClockEvent = (typeof CLOCK_EVENTS)[number];
const isClockEvent = (e: Env): e is ClockEvent => (CLOCK_EVENTS as readonly Env[]).includes(e);
function clockEventEnabled(s: State, e: ClockEvent): boolean {
  // The monotonic Tc passes while the wall Tc is still live.
  if (e === 'TcMono') return !wallPassed(s, 'Tc');
  if (e === 'Wback') return !s.clock.back;
  if (e === 'Wpart') return !s.clock.back && !s.clock.part && s.clock.passed.length > 0;
  // H4-2: the shortened grace cutoff passes only after the rotation.
  if (e === 'Ti' && s.rotation === 'pending') return false;
  return !s.clock.back && !s.clock.part;
}
/** `kept`: for `Wpart`, the passed deadlines that stay behind the wall (default: all but the last). */
function applyClockEvent(n: State, e: ClockEvent, kept?: number): void {
  if (e === 'Wback') n.clock.back = true;
  else if (e === 'TcMono') n.clock.mono = true;
  else if (e === 'Wpart') {
    n.clock.part = true;
    n.clock.kept = kept ?? n.clock.passed.length - 1;
  } else n.clock.passed.push(e);
}

/**
 * The fact reads of each effect that a clock decides, in production order (the node inventory).
 * A fact read reads durable or worker state. An in-memory identity compare in the same synchronous
 * run is no fact read. The clock can pass or the wall can step back after any read: between two
 * reads, or between the last read and the effect. A pass before the first read is an `env:` step.
 */
const EFFECT_READS = {
  /** RC7, F `verifyAgentSessionReplacementQueue` in the posting turn under the Core hold. */
  post: ['audience', 'Ta', 'R', 'idle', 'owner', 'storage'],
  /** RC8, N `queueNanoHostHarnessOperation`: every read before the deciding update. */
  queue: ['harness', 'lineage', 'target', 'binding', 'storage'],
  /** RC10, F `recheck` in the route run that writes the first bytes. */
  firstBytes: ['drain', 'receipt', 'audience', 'Ta', 'R', 'storage', 'placement', 'dispatched'],
} as const;
type EffectSite = keyof typeof EFFECT_READS;

/**
 * Native can compare the slot inside its deciding update. A wall instant that Native sampled after
 * its last read still precedes that update, so a clock can also pass between that sample and the
 * update (`~sample:`). Main cannot compare inside a frame post or a socket write: its sample and the
 * effect share one synchronous run (the accepted residual).
 */
const SAMPLE_GAP: Readonly<Record<EffectSite, boolean>> = {
  post: false,
  queue: true,
  firstBytes: false,
};

/** One gather of an effect: its clock events in order. Each passes after the read `after`. */
interface Gather {
  readonly suffix: string;
  readonly events: readonly {
    readonly after: number;
    readonly event: ClockEvent;
    /** For `Wpart`: the passed deadlines that stay behind the wall. */
    readonly kept?: number | undefined;
  }[];
}

/**
 * S3b-m-r2 (V1-P FIX 2 item 2): a step back can go below more passed deadlines than the last one.
 * Each depth is one gather. The shallowest keeps its label; a deeper one names its `kept` count.
 */
function* depths(passedAfter: number): Generator<{ tag: string; kept: number | undefined }> {
  yield { tag: '', kept: undefined };
  for (let kept = passedAfter - 2; kept >= 0; kept--) yield { tag: `@${kept}`, kept };
}

/** H4-1: the read of an effect that checks a clock itself (the R reader, the P14 owner). */
const OBSERVER: Partial<Record<ClockEvent, string>> = { Ta: 'R', Ti: 'R', Ts: 'audience' };
const observes = (reads: readonly string[], e: ClockEvent, from: number, to: number) =>
  reads.some((read, at) => at >= from && at <= to && read === OBSERVER[e]);

function gathers(world: World, s: State, site: EffectSite): Gather[] {
  const out: Gather[] = [{ suffix: '', events: [] }];
  const left = world.budget - s.used.length;
  if (left <= 0) return out;
  const reads: readonly string[] = EFFECT_READS[site];
  // H4-1 (V1-P): a second move, the wall back below the deadline that a clock-checking read of the
  // same gather saw pass. RC8 is excluded: Native reads no fact that checks a clock. A step back
  // that no read observed is the in-window rollback exposure (H2, #996); it is not generated.
  const partial = world.multiMove === true && site !== 'queue' && !s.used.includes('Wpart');
  for (const e of world.env) {
    if (!isClockEvent(e) || s.used.includes(e) || !clockEventEnabled(s, e)) continue;
    // Native compares its own wall only.
    if (site === 'queue' && e === 'TcMono') continue;
    reads.forEach((read, after) => {
      out.push({ suffix: `~${read}:${e}`, events: [{ after, event: e }] });
      if (!partial || left < 2 || OBSERVER[e] === undefined) return;
      for (let back = after + 1; back < reads.length; back++)
        if (observes(reads, e, after + 1, back))
          for (const { tag, kept } of depths(s.clock.passed.length + 1))
            out.push({
              suffix: `~${read}:${e}~${reads[back]}:Wpart${tag}`,
              events: [
                { after, event: e },
                { after: back, event: 'Wpart', kept },
              ],
            });
    });
    if (SAMPLE_GAP[site])
      out.push({ suffix: `~sample:${e}`, events: [{ after: reads.length, event: e }] });
  }
  // H4-1: the last pass before the gather, seen by a read of the gather, then the wall steps back.
  const last = s.clock.passed.at(-1);
  if (partial && last !== undefined && clockEventEnabled(s, 'Wpart'))
    reads.forEach((read, back) => {
      if (observes(reads, last, 0, back))
        for (const { tag, kept } of depths(s.clock.passed.length))
          out.push({
            suffix: `~${read}:Wpart${tag}`,
            events: [{ after: back, event: 'Wpart', kept }],
          });
    });
  return out;
}

/**
 * Applies the clock event of one gather and returns the clock views of the decision: its sample at
 * the position that the table names, and the clocks of the P14 read and the R read. The raw clock is
 * the clock at the effect. An `after-reads` sample precedes the Native sample gap; an `in-write`
 * compare follows it.
 */
function gatherViews(n: State, g: Gather, site: EffectSite, t: ReplacementCloseTable): ClockViews {
  const snapshot = () => JSON.parse(JSON.stringify(n.clock)) as ClockView;
  // views[m]: the clock after the first m events of the gather.
  const views = [snapshot()];
  for (const { event, kept } of g.events) {
    n.used.push(event);
    applyClockEvent(n, event, kept);
    views.push(snapshot());
  }
  const reads: readonly string[] = EFFECT_READS[site];
  // A read at index `at` sees each event that passed after an earlier read.
  const seenAt = (at: number) => views[g.events.filter((e) => e.after < at).length]!;
  const readClock = (read: string) => {
    const at = reads.indexOf(read);
    return at >= 0 ? seenAt(at) : n.clock;
  };
  const position = t.clockSample[site];
  return {
    sample:
      position === 'before-reads'
        ? views[0]!
        : position === 'after-reads'
          ? seenAt(reads.length)
          : n.clock,
    audience: readClock('audience'),
    request: readClock('R'),
  };
}

/**
 * Oracle: an effect is decided on a clock sample taken after its last successful fact read, or
 * inside the deciding write. The sample must equal the raw clock at the effect. Native reads its
 * own wall only.
 */
function checkSample(ctx: Ctx, n: State, site: EffectSite, sample: ClockView, label: string): void {
  const wall = (c: ClockView) => JSON.stringify([c.passed, c.back, c.part, c.kept]);
  const stale =
    wall(sample) !== wall(n.clock) || (site !== 'queue' && sample.mono !== n.clock.mono);
  if (stale) violate(ctx, 'O.sample', `${label} decided on a clock sample before its last read`);
}

/** Oracle facts, read from the raw state only. */
const rawPlacement = (s: State) =>
  s.h.life === 'open' && s.sb.accepting && s.sb.clean && s.sb.currentEpoch;
const ORACLE_CLOCK_CAUSE: Readonly<Record<ModelClock, CloseCause>> = {
  Tc: 'close-allowance',
  Ts: 'startup-deadline',
  Ta: 'authority-expired',
  Ti: 'authority-expired',
};
const CLOCK_CAUSES: readonly CloseCause[] = [
  'close-allowance',
  'startup-deadline',
  'authority-expired',
  'deadline',
];
/**
 * H4-1: the clocks that a clock-checking read of the decision saw pass. The R reader checks the
 * credential cutoffs of an open request, and the P14 owner checks Ts for an admitted Thread.
 */
function observedClocks(s: State, view: ClockViews): ModelClock[] {
  const out: ModelClock[] = [];
  if (s.prem.R)
    for (const clock of ['Ta', 'Ti'] as const)
      if (deadlineOf(s, clock) <= nowOf(view.request)) out.push(clock);
  if (s.prem.thread && deadlineOf(s, 'Ts') <= nowOf(view.audience)) out.push('Ts');
  return out;
}

/**
 * The first wall deadline that passed; otherwise only the monotonic Tc can have failed. After a
 * step back above the enqueue instant (`Wpart`), a pass above the wall counts only if a read of the
 * decision saw it, or, for Tc, if the monotonic check failed (S3b-m-r2, V1-P FIX 2 item 2).
 */
function expectedClockCause(s: State, observed: readonly ModelClock[] = []): CloseCause {
  const { passed, part, kept, mono } = s.clock;
  const known = part
    ? passed.filter(
        (clock, at) => at < kept || observed.includes(clock) || (clock === 'Tc' && mono)
      )
    : passed;
  return ORACLE_CLOCK_CAUSE[known[0] ?? 'Tc'];
}

/**
 * Applies one Native restore and checks it against the raw drain provenance. `duplicate`: a later
 * delivery of a frame whose first delivery committed (G3). It must change no row.
 */
function applyRestore(
  ctx: Ctx,
  s: State,
  t: ReplacementCloseTable,
  frame: RestoreFrame,
  restorer: string | null,
  site: 'rollback' | 'completion',
  duplicate = false
): void {
  const changed = t.restore(s.h, sandboxFacts(s), frame);
  if (changed && duplicate)
    violate(
      ctx,
      'O.restore.dup',
      `a second delivery of ${restorer}'s ${frame.arm} frame changed a row`
    );
  if (changed && !duplicate && ctx.world.redeliver) s.dup.push({ frame, by: restorer ?? 'cold' });
  if (changed) {
    if (!sandboxOpen(s.sb)) violate(ctx, 'O.restore.sandbox', 'restore on a draining Sandbox');
    for (const reason of s.p.drainBy) {
      if (!reason.startsWith('claim:')) {
        violate(ctx, 'O.restore.foreign', `restore cleared ${reason}`);
        continue;
      }
      const owner = reason.slice('claim:'.length);
      const live = s.c[owner];
      if (owner !== restorer && live && ACTIVE.includes(live.phase))
        violate(ctx, 'O.restore.live-latch', `restore cleared the live latch of ${owner}`);
      if (s.cap[owner] === 'abandoned')
        violate(ctx, 'O.restore.abandon', `restore cleared the abandoned close of ${owner}`);
      if (owner !== restorer && (s.cap[owner] === 'claimed' || s.cap[owner] === 'raw'))
        violate(ctx, 'O.restore.unsettled', `restore with the unsettled capture of ${owner}`);
    }
    if (s.h.cell === 'queued' || s.h.cell === 'dispatched' || s.h.cell === 'unknown')
      violate(ctx, 'O.restore.cell', `restore with a ${s.h.cell} cell`);
    // G3 (S3b-m-r2): the committed restore clears the generation itself. A duplicate's drain check
    // alone can mask a missed clear, so the written row is checked directly.
    const row = t.restoreRow(s.h);
    if (row.drain !== 'accepting' || row.claimGeneration !== null)
      violate(
        ctx,
        'O.restore.clear',
        `${restorer ?? 'cold'}'s restore wrote ${row.drain} with generation ${row.claimGeneration}`
      );
    s.h = row;
    s.p.drainBy = [];
    s.p.ungen = [];
    s.occ -= t.restoreDecrement;
    s.p.owed += 1;
  }
  if (t.e7({ changed, site })) {
    if (s.p.owed === 0) violate(ctx, 'O.e7', 'E7 requested after a no-op restore');
    else s.p.owed -= 1;
  }
}

/**
 * A definite live refusal before any queue commit. `mainWall`: Main decided on its own wall sample
 * at RC7. A sample before the enqueue instant shows no deadline, so it answers the lower Tc edge.
 */
function liveRefuse(
  ctx: Ctx,
  s: State,
  b: string,
  cause: CloseCause,
  mainWall = false,
  observed: readonly ModelClock[] = []
): void {
  const c = s.c[b]!;
  const t = liveTable(ctx, s);
  c.coreHold = false;
  c.wsHold = false;
  // The rollback is the claim arm: the frame's own claim, before any queue commit.
  if (t.liveRefusalLatch === 'restore' && c.claimRev !== null)
    applyRestore(
      ctx,
      s,
      t,
      { arm: 'claim', revision: c.claimRev, generation: c.claimGen },
      b,
      'rollback'
    );
  if (
    s.p.drainBy.includes(`claim:${b}`) &&
    c.claimRev !== null &&
    s.h.revision === c.claimRev &&
    c.claimGen !== null &&
    s.h.claimGeneration === c.claimGen &&
    restorable(s.h, sandboxFacts(s))
  )
    violate(ctx, 'O.live-rollback', `${b} refused live and kept its latch`);
  if (t.definiteRefusal === 'release') {
    c.slot = false;
    if (s.excl === b) s.excl = null;
  }
  c.cause = cause;
  c.answer = t.carryCause(cause, 'capacity');
  const expected = expectedCause(s, cause, mainWall, observed);
  if (c.answer !== expected) violate(ctx, 'O.cause', `${b} answered ${c.answer} for ${expected}`);
  c.phase = 'refused';
}

/**
 * Oracle: a clock refusal answers the original limiting clock; every other refusal keeps its cause.
 * A P14 audience refusal while the Thread rows and the policy admit, and an R refusal while the
 * request is open, can only come from a clock.
 */
function expectedCause(
  s: State,
  cause: CloseCause,
  mainWall: boolean,
  observed: readonly ModelClock[] = []
): CloseCause {
  const clockCause =
    CLOCK_CAUSES.includes(cause) ||
    (cause === 'audience' && s.prem.thread && s.prem.policy) ||
    (cause === 'request' && s.prem.R);
  if (!clockCause) return cause;
  return mainWall && s.clock.back ? ORACLE_CLOCK_CAUSE.Tc : expectedClockCause(s, observed);
}

function setUnknown(s: State, from: 'queued' | 'dispatched'): void {
  s.h = {
    ...s.h,
    cell: 'unknown',
    life: 'failed',
    drain: 'draining',
    result: from === 'dispatched' ? 'unknown' : null,
    revision: s.h.revision + 1,
    claimGeneration: null,
  };
  s.sb = { accepting: false, clean: false, currentEpoch: true };
  s.p.drainBy.push('fence');
}

function nativeSettle(ctx: Ctx, s: State, t: ReplacementCloseTable, key: string): boolean {
  const b = ownerOfKey(key);
  const consumed = s.core[b];
  if (!consumed || consumed.key !== key || !t.settle(s.h, key)) return false;
  if (s.h.cell === 'unknown') violate(ctx, 'O.fence', `settle cleared the Native fence of ${key}`);
  if (
    consumed.result === 'stale' &&
    (!s.p.unsent.includes(key) || (s.p.bytes[key] ?? 0) > 0 || s.p.contact.includes(key))
  )
    violate(ctx, 'O.unsent', `${key} settled as unsent after possible contact`);
  s.h = {
    ...s.h,
    cell: 'settled',
    result: consumed.result,
    nextSequence: s.h.nextSequence + 1,
    revision: s.h.revision + 1,
  };
  // Core keeps the settle clock with its consumption (the close's settle revision).
  s.core[b] = { ...consumed, revision: s.h.revision };
  if (consumed.result === 'succeeded') {
    s.present[b] = false;
    s.occ -= 1;
    s.p.succ += 1;
  }
  const c = s.c[b];
  if (c && keyOf(b, c) === key && (c.phase === 'queued' || c.phase === 'replying')) {
    // A settle can come before the queue reply reaches Main; the reply then finds it.
    if (c.phase === 'queued') c.phase = 'settled';
    c.settleRev = s.h.revision;
  }
  return true;
}

function coldFacts(world: World, s: State): ColdFacts {
  return {
    sandbox: sandboxFacts(s),
    harness: { ...s.h },
    bindings: world.bindings.map((b) => ({
      binding: b,
      present: s.present[b]!,
      capture: s.hidden === b ? undefined : s.cap[b],
      consumed: s.core[b] ?? null,
    })),
    liveProducer: Object.values(s.c).some((c) => c.slot),
    restoreHeld: false,
  };
}

function applyCold(ctx: Ctx, s: State, a: ColdAction): boolean {
  const t = ctx.table;
  switch (a.kind) {
    case 'recover-capture':
      s.cap[a.binding] = s.cap[a.binding] === 'raw' ? 'receipt' : 'abandoned';
      return true;
    case 'expire-key':
      if (!t.expiryApplies(s.h, a.key)) return false;
      setUnknown(s, 'queued');
      return true;
    case 'complete-native-result': {
      // Baseline rows reach this only with a canonical stale consumption. A take-out that
      // derives one for another cell writes it first, as the cold reader would.
      if (!s.core[a.binding] && s.h.key !== null)
        s.core[a.binding] = { key: s.h.key, result: 'stale', revision: null };
      const consumed = s.core[a.binding];
      if (!consumed) return false;
      return nativeSettle(ctx, s, t, consumed.key);
    }
    case 'restore': {
      const before = JSON.stringify(s.h);
      applyRestore(ctx, s, t, a.frame, null, 'completion');
      return JSON.stringify(s.h) !== before || ctx.violations.length > 0;
    }
    default:
      return false;
  }
}

interface Step {
  readonly label: string;
  readonly env: boolean;
  readonly next: State;
  readonly violations: readonly Violation[];
  readonly decided?: string | undefined;
}

function steps(world: World, table: ReplacementCloseTable, s: State): Step[] {
  const out: Step[] = [];
  const add = (label: string, env: boolean, f: (n: State, ctx: Ctx) => boolean | undefined) => {
    const n = clone(s);
    const ctx: Ctx = { world, table, violations: [] };
    if (f(n, ctx) === false) return;
    out.push({ label, env, next: n, violations: ctx.violations, decided: ctx.decided });
  };
  const coreHeld = Object.values(s.c).some((c) => c.coreHold);
  const wsHeld = Object.values(s.c).some((c) => c.wsHold);
  const midFlight = Object.values(s.c).some((c) => ACTIVE.includes(c.phase));
  for (const b of world.closers) {
    const c = s.c[b]!;
    const stop = stopOf(world, b);
    const reach = (p: Phase) =>
      stop === undefined ||
      ([...ACTIVE, 'done'] as Phase[]).indexOf(p) <= ([...ACTIVE, 'done'] as Phase[]).indexOf(stop);
    const t = s.after || !world.legacy ? table : legacyTable(table, world.legacy);
    // F-b: a refused closer with a published receipt retries by replaying it, at most twice.
    const replays =
      world.replay === true && c.phase === 'refused' && s.cap[b] === 'receipt' && c.gen < 3;
    if (
      s.present[b] &&
      (replays ||
        ((c.phase === 'idle' || (world.retry && c.phase === 'refused')) &&
          s.cap[b] !== 'abandoned' &&
          s.cap[b] !== 'receipt' &&
          s.cap[b] !== 'claimed'))
    )
      add(replays ? `readmit:${b}` : `admit:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const cause = t.admit({
          exclusionHolder: n.excl,
          self: b,
          harness: n.h,
          sandbox: sandboxFacts(n),
        });
        if (cause) {
          if (x.phase === 'refused') return false;
          x.cause = cause;
          x.answer = cause;
          x.phase = 'refused';
          return;
        }
        if (x.phase === 'refused') {
          x.gen += 1;
          // A retry carries a fresh successor request.
          if (n.requeued) {
            n.prem.R = true;
            delete n.requeued;
          }
        }
        if (replays) x.replay = true;
        if (n.excl === null) n.excl = b;
        x.slot = true;
        x.answer = null;
        x.cause = null;
        x.claimRev = null;
        x.claimGen = null;
        x.settleRev = null;
        x.phase = 'registered';
        void ctx;
      });
    if (c.phase === 'registered')
      add(`ws:${b}`, false, (n, ctx) => {
        for (const [o, y] of Object.entries(n.c))
          if (n.after && o !== b && ACTIVE.includes(y.phase) && y.slot)
            violate(ctx, 'O.ws-exclusive', `${b} claimed Workspace while ${o} holds the Harness`);
        // A replay keeps its published receipt: it makes no new Workspace claim.
        if (!n.c[b]!.replay) n.cap[b] = 'claimed';
        n.c[b]!.phase = 'ws';
      });
    if (c.phase === 'ws' && reach('latched'))
      add(`claim:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const r = t.claim(n.h, sandboxFacts(n), generationOf(b, x));
        if (typeof r === 'string') {
          if (t.losingClaimRecord === 'erase') {
            n.cap[b] = 'none';
            violate(ctx, 'O.ws-record', `${b} lost its Workspace record on the claim refusal`);
          }
          liveRefuse(ctx, n, b, r);
          return;
        }
        if (n.after && n.p.drainBy.length > 0)
          violate(ctx, 'O.one-claim', `${b} claimed over ${n.p.drainBy.join(',')}`);
        // G3: the claim CAS writes the generation with the revision.
        n.h = { ...n.h, drain: 'draining', revision: r.revision, claimGeneration: r.generation };
        x.claimRev = r.revision;
        x.claimGen = r.generation;
        n.p.drainBy.push(`claim:${b}`);
        if (r.generation === null) n.p.ungen.push(b);
        // A replay already holds its receipt: it goes on from the published state.
        x.phase = x.replay ? 'published' : 'latched';
      });
    if (c.phase === 'latched' && reach('raw'))
      add(`raw:${b}`, false, (n) => {
        n.cap[b] = 'raw';
        n.c[b]!.phase = 'raw';
      });
    if (c.phase === 'raw' && reach('published'))
      add(`pub:${b}`, false, (n) => {
        n.cap[b] = 'receipt';
        n.c[b]!.phase = 'published';
      });
    if (c.phase === 'published' && reach('held'))
      add(`hold:${b}`, false, (n) => {
        const x = n.c[b]!;
        x.coreHold = true;
        x.wsHold = true;
        x.seq = n.h.nextSequence;
        x.phase = 'held';
      });
    if (c.phase === 'held' && reach('posted'))
      for (const g of gathers(world, s, 'post'))
        add(`post:${b}${g.suffix}`, false, (n, ctx) => {
          const x = n.c[b]!;
          const view = gatherViews(n, g, 'post', t);
          const cause = t.post(premises(n, n.prem.pend, t, view));
          // A refusal is a decision too: an early sample can answer a wrong cause.
          checkSample(ctx, n, 'post', view.sample, `post:${b}`);
          if (cause) return liveRefuse(ctx, n, b, cause, true, observedClocks(n, view));
          const q = n.prem;
          // A wall that stepped back over a passed deadline still has that deadline passed.
          const clocks =
            wallPassed(n, 'Tc') ||
            wallPassed(n, 'Ts') ||
            authorityPassed(n) ||
            n.clock.mono ||
            n.clock.back ||
            n.clock.part;
          if (!(q.pend && q.R && q.thread && q.policy && q.idle) || clocks)
            violate(ctx, 'O.frame', `${b} posted with a failed premise`);
          if (n.rotation === 'done') x.rotatedAtPost = true;
          if (t.holdUntil.core === 'post') x.coreHold = false;
          if (t.holdUntil.workspace === 'post') x.wsHold = false;
          x.phase = 'posted';
        });
    if (c.phase === 'posted' && reach('queued'))
      // RC8: the Native transaction decides. Its reply reaches Main in a separate step, and the
      // pins stay held until then.
      for (const g of gathers(world, s, 'queue'))
        add(`queue:${b}${g.suffix}`, false, (n, ctx) => {
          const x = n.c[b]!;
          const key = keyOf(b, x);
          // Main folds the slot from the original clocks; Native compares it with its own wall.
          const view = gatherViews(n, g, 'queue', t);
          const p = premises(n, n.prem.pend, t, view);
          const slotExpired = t.deadlineSlot.some((clock) => p.deadlines[clock] <= p.now);
          const cause = t.queue({
            harness: n.h,
            claimRevision: x.claimRev,
            // G3 (S3b-m-r2): the generation that the close pinned at its claim.
            claimGeneration: x.claimGen,
            key: { binding: b, key, sequence: x.seq! },
            slotExpired,
            storage: n.prem.S,
            sandbox: sandboxFacts(n),
          });
          checkSample(ctx, n, 'queue', view.sample, `queue:${b}`);
          if (!cause) {
            const q = n.prem;
            const own = n.p.drainBy.length === 1 && n.p.drainBy[0] === `claim:${b}`;
            const clocks = wallPassed(n, 'Tc') || wallPassed(n, 'Ts') || authorityPassed(n);
            // G3: the queue transfers the close's own generation unchanged.
            const generation = x.claimGen !== null && n.h.claimGeneration === x.claimGen;
            if (
              clocks ||
              !rawPlacement(n) ||
              !(q.S && q.R && q.thread && q.policy && q.idle) ||
              !own ||
              (!(world.legacy && !n.after) && !generation)
            )
              violate(ctx, 'O.queue', `${key} committed with a failed premise or latch`);
            n.h = {
              ...n.h,
              cell: 'queued',
              key,
              sequence: x.seq,
              operation: 'session.close',
              result: null,
              revision: n.h.revision + 1,
            };
            // A new queue cell has no delivery reservation yet.
            n.reserved = null;
            n.p.committed.push(key);
          }
          x.decision = cause ?? 'commit';
          x.phase = 'replying';
        });
    if (c.phase === 'replying')
      for (const reply of world.lostReply ? ['ack', 'lost'] : ['ack'])
        add(`reply:${b}:${reply}`, false, (n, ctx) => {
          const x = n.c[b]!;
          const decision = x.decision!;
          x.decision = null;
          x.coreHold = false;
          x.wsHold = false;
          if (reply === 'lost') {
            x.phase = 'unknown-reply';
            x.settleRev = null;
            return;
          }
          if (decision !== 'commit') {
            // The model assigns wall deadlines lazily in the order they pass, so the original
            // minimum that Main posted is rebuilt from those fixed deadlines, never from the wall.
            const p = premises(n, n.prem.pend, t);
            const posted =
              t.slotClockAt === 'post' ? slotClock(p.deadlines, t.deadlineSlot) : limitingClock(p);
            return liveRefuse(ctx, n, b, decision === 'deadline' ? t.slotCause(posted) : decision);
          }
          x.phase = x.settleRev !== null ? 'settled' : 'queued';
        });
    if (c.phase === 'unknown-reply')
      add(`readback:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const key = keyOf(b, x);
        const noncommit = () => {
          if (n.p.committed.includes(key))
            violate(ctx, 'O.noncommit', `${key} treated as a noncommit after it committed`);
          liveRefuse(ctx, n, b, 'sequence');
        };
        if (t.lostReply === 'noncommit') return noncommit();
        if (n.h.key === key) {
          if (n.h.cell === 'queued' || n.h.cell === 'dispatched') x.phase = 'queued';
          else if (n.h.cell === 'unknown') x.phase = 'fenced';
          else {
            x.phase = 'settled';
            x.settleRev = n.h.revision;
          }
          return;
        }
        if (t.absent(n.h, { binding: b, key, sequence: x.seq! })) return noncommit();
        x.phase = 'fenced';
      });
    if (c.phase === 'queued' && s.h.key === keyOf(b, c) && s.h.cell === 'unknown')
      add(`observe:${b}`, false, (n) => {
        n.c[b]!.phase = 'fenced';
      });
    if (c.phase === 'settled')
      add(`restore:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        // The completion is the close arm: the exact settled close key.
        const frame: RestoreFrame = {
          arm: 'close',
          key: keyOf(b, x),
          revision: x.settleRev!,
          generation: x.claimGen,
        };
        applyRestore(ctx, n, t, frame, b, 'completion');
        x.slot = false;
        if (n.excl === b) n.excl = null;
        if (x.answer === null) x.answer = 'ok';
        x.phase = 'done';
      });
    if (
      s.clock.W &&
      c.answer === null &&
      ACTIVE.includes(c.phase) &&
      (t.callerBound === 'original-deadline' ||
        !['posted', 'replying', 'unknown-reply', 'queued'].includes(c.phase))
    )
      add(`bound:${b}`, false, (n) => {
        n.c[b]!.answer = 'bound';
      });
  }

  // Poll route: dispatch, first bytes and the result route.
  const t = s.after || !world.legacy ? table : legacyTable(table, world.legacy);
  const key = s.h.key;
  if (key !== null && s.h.operation === 'session.close') {
    const b = ownerOfKey(key);
    for (const poll of world.polls) {
      if ((s.h.cell === 'queued' || s.h.cell === 'dispatched') && s.reserved !== poll)
        add(`dispatch:${poll}`, false, (n) => {
          if (t.dispatch({ harness: n.h, key, reservedBy: n.reserved, poll })) return false;
          n.h = { ...n.h, cell: 'dispatched' };
          n.reserved = poll;
        });
      if (s.h.cell === 'dispatched' && s.reserved === poll && !s.polled.includes(`${key}:${poll}`))
        for (const variant of world.transport ? ['ok', 'transport'] : ['ok'])
          for (const g of gathers(world, s, 'firstBytes'))
            add(`write:${poll}:${variant}${g.suffix}`, false, (n, ctx) => {
              n.polled.push(`${key}:${poll}`);
              const view = gatherViews(n, g, 'firstBytes', t);
              const x = n.c[b];
              const pending =
                n.prem.pend &&
                x !== undefined &&
                keyOf(b, x) === key &&
                x.slot &&
                ['replying', 'queued', 'unknown-reply'].includes(x.phase);
              const p = premises(n, pending, t, view);
              // H4-2: the posted Ta folded the cutoffs at RC7. A rotation after it can only
              // shorten Ta, so RC10 folds the current cutoffs too (F `recheck`).
              const posted =
                x === undefined
                  ? p.deadlines.Ta
                  : t.authorityDeadline([
                      { credential: 'presented', at: deadlineOf(n, 'Ta') },
                      {
                        credential: 'issuer',
                        at:
                          n.rotation === 'done' && !x.rotatedAtPost
                            ? LIVE_DEADLINE
                            : deadlineOf(n, 'Ti'),
                      },
                    ]);
              const Ta =
                t.firstBytesAuthority === 'posted' ? posted : Math.min(posted, p.deadlines.Ta);
              const d = t.firstBytes({ ...p, deadlines: { ...p.deadlines, Ta } });
              checkSample(ctx, n, 'firstBytes', view.sample, `write:${poll}`);
              ctx.decided = d.kind === 'refuse' ? d.cause : 'write';
              if (d.kind === 'refuse') {
                // The exact unsent settlement keeps the refusal cause for the close answer.
                const expected = expectedCause(n, d.cause, true, observedClocks(n, view));
                if (d.cause !== expected)
                  violate(
                    ctx,
                    'O.cause',
                    `${key} refused first bytes as ${d.cause} for ${expected}`
                  );
                n.p.unsent.push(key);
                n.core[b] = { key, result: 'stale', revision: null };
                n.settling.push(key);
                return;
              }
              const q = n.prem;
              const clocks = n.clock.passed.length > 0 || n.clock.mono || n.clock.back;
              if (
                !(pending && q.R && q.thread && q.policy && q.idle && q.S && q.X) ||
                !rawPlacement(n) ||
                clocks
              )
                violate(ctx, 'O.bytes', `${key} first bytes with a failed premise`);
              if (variant === 'transport') {
                n.p.contact.push(key);
                if (t.transportFailure === 'settle-stale') {
                  n.core[b] = { key, result: 'stale', revision: null };
                  nativeSettle(ctx, n, t, key);
                }
                return;
              }
              n.p.bytes[key] = (n.p.bytes[key] ?? 0) + 1;
              if (n.p.bytes[key]! > 1) violate(ctx, 'O.one-send', `${key} sent twice`);
            });
    }
    if (
      s.h.cell === 'dispatched' &&
      (s.p.bytes[key] ?? 0) > 0 &&
      s.core[b]?.key !== key &&
      !s.lost.includes(key)
    ) {
      add(`result:${key}`, false, (n) => {
        n.core[b] = { key, result: 'succeeded', revision: null };
      });
      if (world.resultLost)
        add(`lose:${key}`, false, (n, ctx) => {
          n.lost.push(key);
          if (t.afterContact === 'settle-stale') {
            n.core[b] = { key, result: 'stale', revision: null };
            nativeSettle(ctx, n, t, key);
          }
        });
    }
    if (
      s.h.cell === 'dispatched' &&
      s.core[b]?.key === key &&
      (s.core[b]?.result === 'succeeded' || s.settling.includes(key))
    )
      add(`nsettle:${key}`, false, (n, ctx) => nativeSettle(ctx, n, t, key));
  }

  // Cold entries: the admitted effect path runs the cold decide before the capacity return.
  if (!midFlight && s.after) {
    const facts = coldFacts(world, s);
    const action = table.cold(facts);
    const split = world.splitCold !== undefined && action.kind === 'restore';
    if (!split && action.kind !== 'none' && action.kind !== 'fence')
      add(
        action.kind === 'restore' ? `cold:restore:${action.scope}` : `cold:${action.kind}`,
        false,
        (n, ctx) => applyCold(ctx, n, action)
      );
    if (split)
      for (const k of world.splitCold!)
        if (s.cold[k] === null)
          add(`cold-read:${k}`, false, (n) => {
            n.cold[k] = action.frame;
          });
  }
  for (const k of world.splitCold ?? [])
    if (s.cold[k] !== null)
      add(`cold-post:${k}`, false, (n, ctx) => {
        applyRestore(ctx, n, table, n.cold[k]!, null, 'completion');
        n.cold[k] = null;
      });
  // G3: a committed frame arrives again at any later point (a lost restore ACK and its retry).
  for (const [i, d] of s.dup.entries())
    add(`redeliver:${d.by}:${d.frame.arm}`, false, (n, ctx) => {
      n.dup.splice(i, 1);
      n.p.redelivered += 1;
      applyRestore(ctx, n, table, d.frame, d.by, 'completion', true);
    });

  // F-e: the Main swap of the applied policy. It revalidates and swaps under the canonical Core
  // posting hold, so it waits while a close holds that hold. It is no budgeted writer.
  if (s.install && (table.policyOrder === 'none' || !coreHeld))
    add('install:policy', true, (n) => {
      n.install = false;
      n.prem.policy = false;
    });

  // Environment writers, each at most once within the budget.
  if (s.used.length < world.budget)
    for (const e of world.env) {
      if (s.used.includes(e)) continue;
      const env = (f: (n: State, ctx: Ctx) => boolean | undefined) =>
        add(`env:${e}`, true, (n, ctx) => {
          n.used.push(e);
          return f(n, ctx);
        });
      switch (e) {
        case 'Tc':
        case 'Ts':
        case 'Ta':
        case 'Ti':
        case 'Wback':
        case 'TcMono':
          // A held Core writer does not stop a clock. The wall steps back before the original
          // enqueue instant at any point (A8-1). Inside an effect gather, see `gathers`.
          if (clockEventEnabled(s, e))
            env((n) => {
              applyClockEvent(n, e);
            });
          break;
        case 'W':
          env((n) => {
            n.clock.W = true;
          });
          break;
        case 'thread':
          if (!wsHeld)
            env((n) => {
              n.prem.thread = false;
            });
          break;
        case 'R':
        case 'idle':
          if (!coreHeld)
            env((n) => {
              n.prem[e] = false;
            });
          break;
        case 'requeue':
          // F-b: the successor request is requeued before the Core hold. This attempt fails R; the
          // retry carries a fresh request (the factory case `request-requeued`).
          if (!coreHeld)
            env((n) => {
              n.prem.R = false;
              n.requeued = true;
            });
          break;
        case 'core':
          // Core user disable or membership: it writes R and B under the Core hold.
          if (!coreHeld)
            env((n) => {
              n.prem.R = false;
              n.prem.idle = false;
            });
          break;
        case 'policy':
          // The publisher's activation ACK or lost-ACK readback runs outside the Core hold. It
          // changes no premise: only the Main swap below changes the applied policy.
          env((n) => {
            n.install = true;
          });
          break;
        case 'pend':
        case 'S':
        case 'X':
          env((n) => {
            n.prem[e] = false;
          });
          break;
        case 'open':
          // session.open or turn.start: the Native queue refuses both on a draining Harness.
          if (
            s.h.life === 'open' &&
            s.h.drain === 'accepting' &&
            (s.h.cell === 'idle' || s.h.cell === 'settled')
          )
            env((n) => {
              n.h = {
                ...n.h,
                cell: 'settled',
                key: 'Z8',
                sequence: n.h.nextSequence,
                operation: 'session.open',
                result: 'succeeded',
                nextSequence: n.h.nextSequence + 1,
                revision: n.h.revision + 1,
              };
            });
          break;
        case 'hdrain':
          // A Harness-only drain is an operation on the cell. Its result also lands on a row
          // that a local claim already drains (N:1892-1897).
          if (s.h.cell === 'idle' || s.h.cell === 'settled')
            env((n) => {
              n.h = {
                ...n.h,
                drain: 'draining',
                operation: 'harness.drain',
                cell: 'settled',
                key: 'Z7',
                sequence: n.h.nextSequence,
                result: 'succeeded',
                revision: n.h.revision + 1,
                nextSequence: n.h.nextSequence + 1,
                // G3: an independent drain invalidates the claim generation.
                claimGeneration: null,
              };
              n.p.drainBy.push('hdrain');
            });
          break;
        case 'hdrain@claim':
          // G3 (S3b-m-r2, V1-P FIX 2 item 1): Native stamps the drain settlement with the supplied
          // wall instant. Here it equals the stamp of the claim, so the revision stays.
          if (s.h.cell === 'idle' || s.h.cell === 'settled')
            env((n) => {
              n.h = {
                ...n.h,
                drain: 'draining',
                operation: 'harness.drain',
                cell: 'settled',
                key: 'Z7',
                sequence: n.h.nextSequence,
                result: 'succeeded',
                nextSequence: n.h.nextSequence + 1,
                claimGeneration: null,
              };
              n.p.drainBy.push('hdrain');
            });
          break;
        case 'sbdrain':
          if (s.sb.accepting)
            env((n) => {
              n.sb.accepting = false;
            });
          break;
        case 'fail':
          if (s.h.life === 'open' && s.h.cell !== 'queued' && s.h.cell !== 'dispatched')
            env((n) => {
              n.h = {
                ...n.h,
                life: 'failed',
                drain: 'draining',
                revision: n.h.revision + 1,
                claimGeneration: null,
              };
              n.p.drainBy.push('fail');
            });
          break;
        case 'unknown':
          if (s.h.cell === 'dispatched') env((n) => setUnknown(n, 'dispatched'));
          break;
        case 'expiry-old':
          if (s.h.cell === 'queued')
            env((n, ctx) => {
              if (!table.expiryApplies(n.h, 'Z0')) return;
              if (n.h.key !== 'Z0') violate(ctx, 'O.expiry-key', `old expiry hit ${n.h.key}`);
              setUnknown(n, 'queued');
            });
          break;
        case 'reuse':
          if (s.h.cell === 'settled' || s.h.cell === 'idle')
            env((n) => {
              n.h = {
                ...n.h,
                cell: 'settled',
                key: 'Z9',
                sequence: n.h.nextSequence,
                operation: 'other',
                result: 'succeeded',
                nextSequence: n.h.nextSequence + 1,
                revision: n.h.revision + 1,
              };
            });
          break;
        case 'hide': {
          const b = world.bindings.find((x) => s.cap[x] === 'claimed' || s.cap[x] === 'raw');
          if (b !== undefined && s.hidden === null)
            env((n) => {
              n.hidden = b;
            });
          break;
        }
        case 'crash':
          env((n) => {
            for (const [b, x] of Object.entries(n.c)) {
              const restart = world.restart && n.present[b];
              x.phase = restart ? 'idle' : 'dead';
              x.gen += 1;
              x.slot = false;
              x.coreHold = false;
              x.wsHold = false;
              x.decision = null;
              x.claimRev = null;
              x.claimGen = null;
              x.settleRev = null;
              x.answer = null;
            }
            n.excl = null;
            n.reserved = null;
            n.settling = [];
            // A restart reads the activated policy from its durable publication.
            if (n.install) {
              n.install = false;
              n.prem.policy = false;
            }
            n.prem.pend = true;
            n.p.owed = 0;
            for (const k of Object.keys(n.cold)) n.cold[k] = null;
            n.after = true;
          });
          break;
        case 'foreign-claim':
          // An older same-process claim path for B, with the r2 strictly later revision.
          if (
            s.present.B &&
            s.cap.B === 'none' &&
            !['replying', 'queued', 'unknown-reply', 'settled', 'done'].includes(
              s.c.A?.phase ?? 'idle'
            )
          )
            env((n) => {
              n.cap.B = 'claimed';
              // A claim in this process writes its own generation.
              n.h = {
                ...n.h,
                drain: 'draining',
                revision: n.h.revision + 1,
                claimGeneration: 'gF',
              };
              n.p.drainBy.push('claim:B');
            });
          break;
        case 'replay':
          // A reuses its earlier Workspace receipt with no Native claim of its own.
          if (s.cap.A === 'receipt' && s.c.A?.phase === 'idle' && s.h.drain === 'draining')
            env((n) => {
              const x = n.c.A!;
              x.slot = true;
              x.claimRev = null;
              x.claimGen = null;
              x.phase = 'published';
            });
          break;
        case 'open@99':
        case 'open@101':
        case 'bind@99':
        case 'recreate': {
          // G3 (V1-P): the wall stamps of a released row can go back, so a later claim can recur
          // at the revision P of a pending frame. Each writer needs an accepting row.
          const pending = pendingRevision(s);
          if (
            pending !== null &&
            s.h.life === 'open' &&
            s.h.drain === 'accepting' &&
            (s.h.cell === 'idle' || s.h.cell === 'settled')
          )
            env((n) => {
              n.h = rewound(n.h, e, pending);
            });
          break;
        }
        case 'rotate':
          // H4-2: after the queue ACK, while R stays live.
          if (s.rotation === 'pending' && Object.values(s.c).some((c) => c.phase === 'queued'))
            env((n) => {
              n.rotation = 'done';
            });
          break;
        case 'wcrash':
          // H4-3: Native commits and exits before its reply. Main keeps its waiter, its slots and
          // the exclusion; only the reply and Native's memory are lost.
          for (const [b, c] of Object.entries(s.c))
            if (c.phase === 'replying' && c.decision === 'commit')
              env((n) => {
                const x = n.c[b]!;
                x.decision = null;
                x.coreHold = false;
                x.wsHold = false;
                x.settleRev = null;
                x.phase = 'unknown-reply';
                n.reserved = null;
              });
          break;
      }
    }
  return out;
}

/** The lowest revision of a restore frame that is still pending: paused cold, or in flight. */
function pendingRevision(s: State): number | null {
  const frames = [...Object.values(s.cold), ...s.dup.map((d) => d.frame)].filter(
    (f): f is RestoreFrame => f !== null
  );
  return frames.length === 0 ? null : Math.min(...frames.map((f) => f.revision));
}

/** G3 reuse writers on a released row, relative to the pending revision P. */
function rewound(h: HarnessFacts, e: Env, pending: number): HarnessFacts {
  if (e === 'bind@99') return { ...h, revision: pending - 1 };
  if (e === 'recreate')
    return {
      life: 'open',
      drain: 'accepting',
      revision: pending - 1,
      operation: null,
      cell: 'idle',
      key: null,
      sequence: null,
      result: null,
      nextSequence: 0,
      claimGeneration: null,
    };
  return {
    ...h,
    cell: 'settled',
    key: 'Z8',
    sequence: h.nextSequence,
    operation: 'session.open',
    result: 'succeeded',
    nextSequence: h.nextSequence + 1,
    revision: e === 'open@99' ? pending - 1 : pending + 1,
  };
}

const stopOf = (world: World, b: string) => world.stop?.[b] ?? world.stopAt;

/** Raw classification of an owner-quiescent state with a draining Harness. */
function fenceClass(world: World, s: State): string | null {
  if (s.h.drain !== 'draining') return null;
  const reasons = s.p.drainBy;
  if (reasons.includes('fence') || reasons.includes('fail')) return 'native-fence';
  if (reasons.includes('hdrain')) return 'harness-drain';
  if (!sandboxOpen(s.sb)) return 'sandbox';
  if (Object.values(s.c).some((c) => c.phase === 'fenced' && c.slot)) return 'unproved-key';
  const key = s.h.key;
  if (s.h.cell === 'dispatched' && key !== null) {
    const consumed = s.core[ownerOfKey(key)];
    if (consumed?.key === key && consumed.result === 'succeeded') return 'result-bytes';
    if (consumed?.key === key && consumed.result === 'stale' && s.p.unsent.includes(key))
      return null;
    return 'contact';
  }
  if (s.hidden !== null) return 'hidden-anchor';
  const claimOwners = reasons.filter((r) => r.startsWith('claim:')).map((r) => r.slice(6));
  const settledClose =
    s.h.cell === 'settled' &&
    s.h.operation === 'session.close' &&
    key !== null &&
    claimOwners.includes(ownerOfKey(key));
  // ENGINEER (b) and (d): an abandon fences every restore, because an older claim can leave the
  // same durable values as a sibling that never held the latch.
  const abandoned = world.bindings.filter((b) => s.cap[b] === 'abandoned');
  if (abandoned.length > 0)
    return abandoned.some((b) => claimOwners.includes(b)) ? 'abandon-own' : 'abandon-sibling';
  // The two gaps below are cold exits; a live owner still decides its own close.
  if (Object.values(s.c).some((c) => ACTIVE.includes(c.phase))) return null;
  // ENGINEER (c): a later operation reused the cell of a settled close, so neither the P7
  // settle revision nor an open capture proves the claim any more.
  if (claimOwners.some((o) => s.core[o] && (key === null || ownerOfKey(key) !== o)))
    return 'gap-reused-cell';
  // ENGINEER (a), failed closed: the last operation does not exclude a replaced Harness-only
  // drain marker, so the local claim is not positively attributed.
  const opProves =
    (s.h.cell === 'idle' && s.h.operation === null) ||
    (s.h.cell === 'settled' && ['session.open', 'turn.start'].includes(s.h.operation ?? ''));
  // A settled close of a claimant whose settle revision still matches fails closed at P7: an older
  // claim on a draining row leaves the same durable values (V1-P S2-r1 item 1).
  const p7Proof =
    settledClose && key !== null && s.core[ownerOfKey(key)]?.revision === s.h.revision;
  if (p7Proof) return 'unattributed-claim';
  if (!opProves) return 'ambiguous-drain';
  // G3: an older writer's claim wrote no generation, so its history stays ambiguous.
  if (claimOwners.some((o) => s.p.ungen.includes(o))) return 'legacy-claim';
  return null;
}

interface Projections {
  total: number;
  ambiguous: number;
  histories: Record<string, number>;
}

interface Report {
  world: string;
  states: number;
  edges: number;
  quiescent: number;
  fences: Record<string, number>;
  traces: Record<string, string[]>;
  /** Restores that made the Harness accepting, by edge kind, and how many admit a fresh close. */
  exits: Record<string, number>;
  fresh: number;
  /** F3: `crash` counts the durable projection at each crash edge only; `after` counts every
   * state after the restart, including later owner steps. */
  projections?: { crash: Projections; after: Projections };
  probes: Record<
    string,
    {
      states: number;
      quiescent: Record<string, number>;
      /** The cold decision of the table under test at each quiescent probe state. */
      decisions: Record<string, number>;
      trace: string[] | null;
    }
  >;
  truncated: boolean;
}

const EXIT_KINDS = ['cold:restore:quiescent', 'cold:restore:close', 'restore:', 'cold-post:'];

function explore(
  world: World,
  table: ReplacementCloseTable,
  options: { readonly stopOn?: string; readonly maxStates?: number } = {}
): Report {
  const maxStates = options.maxStates ?? 400_000;
  const start = initial(world);
  const startKey = JSON.stringify(start);
  const parent = new Map<string, { from: string; label: string } | null>([[startKey, null]]);
  const states = new Map<string, State>([[startKey, start]]);
  const queue: string[] = [startKey];
  const report: Report = {
    world: world.name,
    states: 0,
    edges: 0,
    quiescent: 0,
    fences: {},
    traces: {},
    exits: {},
    fresh: 0,
    probes: {},
    truncated: false,
  };
  const projections = {
    crash: { sets: new Map<string, Set<string>>(), histories: {} as Record<string, number> },
    after: { sets: new Map<string, Set<string>>(), histories: {} as Record<string, number> },
  };
  const project = (kind: 'crash' | 'after', s: State) => {
    const projection = JSON.stringify([s.sb, s.h, s.occ, s.present, s.cap, s.core]);
    const history = historyOf(s);
    const p = projections[kind];
    p.histories[history] = (p.histories[history] ?? 0) + 1;
    const set = p.sets.get(projection) ?? new Set<string>();
    set.add(`${history}|${[...s.p.drainBy].sort().join(',')}`);
    p.sets.set(projection, set);
  };
  // In a legacy world the older writers run before the restart. Only the new code is checked.
  const checked = (s: State) => !world.legacy || s.after;
  const trace = (key: string, last?: string): string[] => {
    const out: string[] = last ? [last] : [];
    let at = parent.get(key);
    while (at) {
      out.unshift(at.label);
      at = parent.get(at.from);
    }
    return out;
  };
  const record = (name: string, key: string, last?: string) => {
    if (!report.traces[name]) report.traces[name] = trace(key, last);
  };
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]!;
    const s = states.get(key)!;
    states.delete(key);
    report.states += 1;
    const next = steps(world, table, s);
    report.edges += next.length;
    for (const step of next) {
      if (checked(s))
        for (const v of step.violations) record(v.name, key, `${step.label} -> ${v.detail}`);
      // Positive endpoint: each restore that makes the Harness accepting admits a fresh close.
      const kind = EXIT_KINDS.find((k) => step.label.startsWith(k));
      if (kind && checked(s) && s.h.drain === 'draining' && step.next.h.drain === 'accepting') {
        report.exits[kind] = (report.exits[kind] ?? 0) + 1;
        const n = step.next;
        const admitted =
          table.admit({
            exclusionHolder: n.excl,
            self: 'fresh',
            harness: n.h,
            sandbox: sandboxFacts(n),
          }) === null && typeof table.claim(n.h, sandboxFacts(n), 'fresh') !== 'string';
        if (admitted) report.fresh += 1;
        else record('L.fresh', key, `${step.label} -> no fresh admission`);
      }
      if (step.label === 'env:crash' && world.closers.length > 1) project('crash', step.next);
    }
    if (options.stopOn && report.traces[options.stopOn]) break;
    for (const [name, probe] of Object.entries(world.probes ?? {}))
      if (probe(s)) {
        report.probes[name] ??= { states: 0, quiescent: {}, decisions: {}, trace: null };
        const entry = report.probes[name]!;
        entry.states += 1;
        entry.trace ??= trace(key);
      }
    if (checked(s)) {
      // State-local oracles.
      for (const [b, c] of Object.entries(s.c))
        if (
          s.clock.W &&
          c.answer === null &&
          ACTIVE.includes(c.phase) &&
          !next.some((step) => step.label === `bound:${b}`)
        )
          record('O.bound', key, `${b} unanswered at the caller bound`);
      if (s.occ !== s.p.occ0 - s.p.succ) record('O.occupancy', key, `occupancy ${s.occ}`);
    }
    if (s.used.includes('crash') && s.used.at(-1) === 'crash' && world.closers.length > 1)
      project('after', s);
    const owner = next.filter((step) => !step.env && JSON.stringify(step.next) !== key);
    if (owner.length === 0) {
      report.quiescent += 1;
      const cls = fenceClass(world, s);
      for (const [name, probe] of Object.entries(world.probes ?? {}))
        if (probe(s)) {
          const entry = report.probes[name]!;
          const label = cls ?? (s.h.drain === 'accepting' ? 'accepting' : 'unclassified');
          entry.quiescent[label] = (entry.quiescent[label] ?? 0) + 1;
          const a = table.cold(coldFacts(world, s));
          const decision =
            a.kind === 'fence'
              ? `fence:${a.reason}`
              : a.kind === 'restore'
                ? `restore:${a.scope}`
                : a.kind;
          entry.decisions[decision] = (entry.decisions[decision] ?? 0) + 1;
        }
      const active = Object.values(s.c).some((c) => ACTIVE.includes(c.phase));
      if (!checked(s)) {
        // Older writers only: no liveness claim.
      } else if (cls !== null) {
        report.fences[cls] = (report.fences[cls] ?? 0) + 1;
        record(`fence:${cls}`, key);
      } else if (
        Object.entries(s.c).some(
          ([b, c]) => ACTIVE.includes(c.phase) && stopOf(world, b) === undefined
        )
      )
        record('L.stuck', key, 'a live owner has no next step');
      else if (s.h.drain === 'draining' && !active)
        record('L.exit', key, `stranded latch: ${s.p.drainBy.join(',')}`);
      if (checked(s)) {
        if (s.p.owed > 0) record('L.e7', key, 'a restore owes its E7 request');
        for (const [b, c] of Object.entries(s.c))
          if (c.slot && (c.phase === 'refused' || c.phase === 'done'))
            record('L.slot', key, `${b} keeps its slots after the proof`);
      }
    }
    for (const step of next) {
      const nk = JSON.stringify(step.next);
      if (parent.has(nk)) continue;
      if (parent.size >= maxStates) {
        report.truncated = true;
        continue;
      }
      parent.set(nk, { from: key, label: step.label });
      states.set(nk, step.next);
      queue.push(nk);
    }
  }
  const summary = (p: (typeof projections)['crash']): Projections => ({
    total: p.sets.size,
    ambiguous: [...p.sets.values()].filter(
      (set) => new Set([...set].map((h) => h.split('|')[1])).size > 1
    ).length,
    histories: p.histories,
  });
  if (projections.after.sets.size > 0)
    report.projections = { crash: summary(projections.crash), after: summary(projections.after) };
  return report;
}

/** H1: A latched and B claimed Workspace only. H2: both latched. H3: A has a receipt with no claim. */
function historyOf(s: State): string {
  const a = s.p.drainBy.includes('claim:A');
  const b = s.p.drainBy.includes('claim:B');
  if (a && b) return 'H2';
  if (a && s.cap.B !== 'none') return 'H1';
  if (b && !a && s.cap.A === 'receipt') return 'H3';
  return 'other';
}

/* ---------------------------------------------------------------- worlds */

const LIVE_ENV: readonly Env[] = [
  'Tc',
  'Ts',
  'Ta',
  'Ti',
  'TcMono',
  'Wback',
  'W',
  'thread',
  'policy',
  'R',
  'idle',
  'core',
  'pend',
  'S',
  'X',
  'sbdrain',
  'fail',
  'crash',
];

/** V1-P: A settled; B's older claim committed; the stop came before B's source; B abandoned. */
const unsafeLegacyP7 = (s: State) =>
  s.after &&
  s.core.A?.result === 'succeeded' &&
  s.h.operation === 'session.close' &&
  s.h.key === s.core.A.key &&
  s.cap.B === 'abandoned' &&
  s.p.drainBy.includes('claim:B') &&
  !s.p.drainBy.includes('hdrain');

/** A settled close whose Core settle revision still matches the row: the P7 projection. */
const settledP7 = (s: State) => {
  const key = s.h.key;
  return (
    s.after &&
    s.h.drain === 'draining' &&
    s.h.cell === 'settled' &&
    s.h.operation === 'session.close' &&
    key !== null &&
    s.core[ownerOfKey(key)]?.key === key &&
    s.core[ownerOfKey(key)]?.revision === s.h.revision
  );
};
/**
 * V1-P S2-r1 item 1: an independent drain settled after A's Workspace claim, the older Native claim
 * succeeded on the draining row, and A settled its close before the stop.
 */
const LEGACY_PROBES = {
  'legacy-p7-over-drain': (s: State) => settledP7(s) && s.p.drainBy.includes('hdrain'),
  'legacy-p7-own-claim': (s: State) =>
    settledP7(s) && s.p.drainBy.length === 1 && s.p.drainBy[0] === `claim:${ownerOfKey(s.h.key!)}`,
};

const startPublished =
  (rev = 1) =>
  (s: State) => {
    s.h = { ...s.h, drain: 'draining', revision: rev, claimGeneration: 'gA1' };
    s.cap.A = 'receipt';
    s.p.drainBy = ['claim:A'];
    s.excl = 'A';
    Object.assign(s.c.A!, { phase: 'published', claimRev: rev, claimGen: 'gA1', slot: true });
  };

/** A's cold restore paused after its positive read; B's admitted claim advances. */
const PAUSED_RESTORE: World = {
  name: 'paused-restore',
  closers: ['A', 'B'],
  bindings: ['A', 'B'],
  env: [],
  budget: 0,
  polls: ['p1'],
  splitCold: ['k1', 'k2'],
  stopAt: 'latched',
  init: (s: State) => {
    startPublished()(s);
    Object.assign(s.c.A!, { phase: 'dead', slot: false, claimRev: null, claimGen: null });
    s.excl = null;
  },
};

/** G3: B, a later claimant, holds its own generation after a duplicate of A's frame arrived. */
const ownGeneration = (s: State) =>
  s.p.redelivered > 0 &&
  ACTIVE.includes(s.c.B!.phase) &&
  s.c.B!.claimGen !== null &&
  s.h.drain === 'draining' &&
  s.h.claimGeneration === s.c.B!.claimGen;

/**
 * G3 (V1-P generation witness): A holds a published claim. A releases legitimately, by the
 * rollback (the claim arm, after a request refusal) or the completion (the close arm). Its frame
 * can arrive again at any later point. A reuse writer then moves the released row, B claims, and
 * the duplicate arrives; or it arrives before B claims (the opposite order).
 */
function reuseWorld(
  name: string,
  rewind: Env,
  extra: readonly Env[] = [],
  /** A claims through RC3 of the table under test, not from a published start. */
  fromStart = false
): World {
  return {
    name,
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['R', rewind, ...extra],
    budget: 2 + extra.length,
    polls: ['p1'],
    redeliver: true,
    stop: { B: 'latched' },
    ...(fromStart ? {} : { init: startPublished() }),
    probes: { 'own-generation': ownGeneration },
  };
}

const WORLDS = {
  /** One close through every boundary with every premise writer, clock and a crash. */
  live: {
    name: 'live',
    closers: ['A'],
    bindings: ['A'],
    env: LIVE_ENV,
    budget: 2,
    polls: ['p1', 'p2'],
    lostReply: true,
    transport: true,
    resultLost: true,
  },
  /** The pre-publication prefixes with a crash: P1/P2 recovery and the abandon. */
  prefix: {
    name: 'prefix',
    closers: ['A'],
    bindings: ['A'],
    env: ['crash', 'hide', 'sbdrain'],
    budget: 2,
    polls: ['p1'],
  },
  /** CL3: A and B on one Harness, both winner orders, a crash and fresh restarts. */
  cl3: {
    name: 'cl3',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['crash'],
    budget: 1,
    polls: ['p1'],
    restart: true,
    retry: true,
    stopAt: 'published',
  },
  /** An independent writer wins RC3 after B's RC2. */
  losing: {
    name: 'losing',
    closers: ['B'],
    bindings: ['A', 'B'],
    env: ['hdrain'],
    budget: 1,
    polls: ['p1'],
    stopAt: 'latched',
  },
  /**
   * Older double claims (c1: no revision change) in a data root, then the new cold decide. The
   * older writers run every phase before the restart. The older claim also succeeds on a row that
   * an independent Harness-only drain holds; an ordinary cell reuse is the equal-input control.
   */
  legacyC1: {
    name: 'legacy-c1',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['hdrain', 'reuse', 'crash'],
    budget: 2,
    polls: ['p1'],
    legacy: 'c1',
    probes: { 'v1p-unsafe-p7': unsafeLegacyP7, ...LEGACY_PROBES },
  },
  legacyR2: {
    name: 'legacy-r2',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['hdrain', 'reuse', 'crash'],
    budget: 2,
    polls: ['p1'],
    legacy: 'r2',
    probes: LEGACY_PROBES,
  },
  /** CL3 to completion: each winner order, then the other's fresh claim after the release. */
  cl3full: {
    name: 'cl3-full',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: [],
    budget: 0,
    polls: ['p1'],
    retry: true,
    probes: {
      G1: (s: State) => s.c.A!.phase === 'done' && s.c.B!.gen > 1 && s.c.B!.claimRev !== null,
      G2: (s: State) => s.c.B!.phase === 'done' && s.c.A!.gen > 1 && s.c.A!.claimRev !== null,
    },
  },
  /** A Core writer and a Workspace writer, each under its own hold. */
  pins: {
    name: 'pins',
    closers: ['A'],
    bindings: ['A'],
    env: ['core', 'thread'],
    budget: 1,
    polls: ['p1'],
    stopAt: 'queued',
  },
  /** An independent Harness-only drain lands on a Harness that A's claim already drains. */
  overdrain: {
    name: 'overdrain',
    closers: ['A'],
    bindings: ['A'],
    env: ['hdrain', 'reuse', 'crash'],
    budget: 3,
    polls: ['p1'],
    probes: {
      'independent-on-marker': (s: State) =>
        s.p.drainBy.includes('claim:A') && s.p.drainBy.includes('hdrain'),
    },
  },
  /**
   * F3-HD: A's receipt is still open after an earlier restore. A Harness-only drain follows, then
   * a later operation replaces its `harness.drain` marker. The exit fails closed.
   */
  staleReceipt: {
    name: 'stale-receipt',
    closers: [],
    bindings: ['A'],
    env: ['open', 'hdrain', 'reuse'],
    budget: 3,
    polls: ['p1'],
    init: (s: State) => {
      s.cap.A = 'receipt';
    },
    probes: {
      'f3-hd': (s: State) => s.p.drainBy.includes('hdrain') && s.h.operation === 'other',
    },
  },
  pausedRestore: PAUSED_RESTORE,
  /**
   * G3 with the cold arm: A's cold restore is paused after its proof (k2), k1 releases A, then
   * `session.open` settles at 99 and B claims at 100 before k2 commits.
   */
  pausedReuse: { ...PAUSED_RESTORE, name: 'paused-reuse', env: ['open@99'], budget: 1 },
  /** G3 (V1-P generation witness), the 99 settlement: B's claim recurs at A's frame revision. */
  reuse99: reuseWorld('reuse-99', 'open@99'),
  /** The 101 settlement control: the revision alone tells the claims apart. */
  reuse101: reuseWorld('reuse-101', 'open@101'),
  /** The no-sequence binding open at 99 (V1-P G2): it needs no settlement. */
  reuseBind: reuseWorld('reuse-bind', 'bind@99'),
  /** A same-name recreation of the Harness at 99. */
  reuseRecreate: reuseWorld('reuse-recreate', 'recreate'),
  /** The 99 settlement, then an independent drain. */
  reuseHdrain: reuseWorld('reuse-hdrain', 'open@99', ['hdrain']),
  /** The 99 settlement with A's own RC3 claim from the start. */
  reuseClaim99: reuseWorld('reuse-claim-99', 'open@99', [], true),
  /**
   * H4-1 (V1-P): two clock moves in one gather. A deadline passes, a read that checks it sees it
   * pass, and the wall then steps back below it, above the enqueue instant.
   */
  h4gather: {
    name: 'h4-gather',
    closers: ['A'],
    bindings: ['A'],
    env: ['Ts', 'Ta', 'Ti'],
    budget: 2,
    polls: ['p1'],
    multiMove: true,
    probes: {
      'stepped-back-refusal': (s: State) =>
        s.clock.part && s.c.A!.phase === 'refused' && s.p.committed.length === 0,
      'stepped-back-unsent': (s: State) =>
        s.clock.part && s.p.unsent.includes('A1') && (s.p.bytes.A1 ?? 0) === 0,
    },
  },
  /**
   * H4-1 (S3b-m-r2, V1-P FIX 2 item 2): the monotonic Tc fails while the wall Tc is live, the wall
   * then passes Tc and Ta, R sees Ta pass, and the wall steps back below both, above the enqueue
   * instant. Without `TcMono` it is the control: the wall pass of Tc alone was a step forward.
   */
  h4mono: {
    name: 'h4-mono',
    closers: ['A'],
    bindings: ['A'],
    env: ['TcMono', 'Tc', 'Ta'],
    budget: 4,
    polls: ['p1'],
    multiMove: true,
    probes: {
      'deep-step-back-tc': (s: State) =>
        s.clock.part &&
        s.clock.kept === 0 &&
        s.clock.mono &&
        s.c.A!.answer === 'close-allowance' &&
        (s.p.bytes.A1 ?? 0) === 0,
    },
  },
  /**
   * G3 (S3b-m-r2, V1-P FIX 2 item 1): an independent drain settles at the claim's own stamp before
   * A prepares its command against the advanced sequence.
   */
  equalStamp: {
    name: 'equal-stamp',
    closers: ['A'],
    bindings: ['A'],
    env: ['hdrain@claim'],
    budget: 1,
    polls: ['p1'],
    probes: {
      'equal-stamp-latch': (s: State) =>
        s.p.drainBy.includes('hdrain') &&
        s.c.A!.phase === 'refused' &&
        s.c.A!.cause === 'latch' &&
        s.p.committed.length === 0 &&
        s.h.drain === 'draining',
    },
  },
  /** H4-2 (V1-P): after the queue ACK, a rotation shortens the issuer grace while R stays live. */
  rotate: {
    name: 'rotate',
    closers: ['A'],
    bindings: ['A'],
    env: ['rotate', 'Ti'],
    budget: 2,
    polls: ['p1'],
    init: (s: State) => {
      s.rotation = 'pending';
    },
    probes: {
      'rotated-grace': (s: State) =>
        s.rotation === 'done' &&
        s.clock.passed.includes('Ti') &&
        s.p.unsent.includes('A1') &&
        (s.p.bytes.A1 ?? 0) === 0,
    },
  },
  /** H4-3 (V1-P): Native exits after its commit; Main keeps its waiter and exclusion. */
  wcrash: {
    name: 'wcrash',
    closers: ['A'],
    bindings: ['A'],
    env: ['wcrash', 'crash'],
    budget: 2,
    polls: ['p1'],
    probes: {
      'worker-exit-readback': (s: State) =>
        s.used[0] === 'wcrash' && s.c.A!.phase === 'done' && s.p.committed.length === 1,
    },
  },
  /** A live; an older same-process claim path for B advances the revision. */
  foreign: {
    name: 'foreign',
    closers: ['A'],
    bindings: ['A', 'B'],
    env: ['foreign-claim'],
    budget: 1,
    polls: ['p1'],
    stopAt: 'queued',
  },
  /** A replays its receipt with no Native claim while B holds the latch. */
  replay: {
    name: 'replay',
    closers: ['A'],
    bindings: ['A', 'B'],
    env: ['replay'],
    budget: 1,
    polls: ['p1'],
    stopAt: 'queued',
    init: (s: State) => {
      s.cap.A = 'receipt';
      s.cap.B = 'receipt';
      s.h = { ...s.h, drain: 'draining', revision: 1, claimGeneration: 'gB1' };
      s.p.drainBy = ['claim:B'];
      s.after = true;
    },
  },
  /**
   * F-b: A publishes, its successor request is requeued, and A refuses before the queue (the live
   * rollback restores its claim). The retry replays A's receipt: RC3 claims again, and RC8
   * transfers that claim of its own.
   */
  receiptReplay: {
    name: 'receipt-replay',
    closers: ['A'],
    bindings: ['A'],
    env: ['requeue'],
    budget: 1,
    polls: ['p1'],
    retry: true,
    replay: true,
    probes: {
      'replay-transfer': (s: State) =>
        s.c.A!.replay === true && s.c.A!.gen > 1 && s.c.A!.phase === 'done',
    },
  },
  /**
   * F-b with CL3: A refused before the queue after its publication, and its claim was rolled back.
   * An independent Harness-only drain may win before A's replayed claim. That claim must refuse.
   */
  receiptReplayDrain: {
    name: 'receipt-replay-drain',
    closers: ['A'],
    bindings: ['A'],
    env: ['hdrain'],
    budget: 1,
    polls: ['p1'],
    retry: true,
    replay: true,
    stopAt: 'queued',
    init: (s: State) => {
      s.cap.A = 'receipt';
      Object.assign(s.c.A!, { phase: 'refused', cause: 'request', answer: 'request' });
    },
  },
  /** The Native fences, cell reuse, an old expiry and an unreadable anchor. */
  census: {
    name: 'census',
    closers: ['A'],
    bindings: ['A'],
    env: ['crash', 'expiry-old', 'unknown', 'fail', 'hdrain', 'reuse', 'sbdrain'],
    budget: 2,
    polls: ['p1'],
    lostReply: true,
    init: (s: State) => {
      s.h = {
        ...s.h,
        cell: 'settled',
        key: 'Z0',
        sequence: 0,
        operation: 'turn.start',
        result: 'succeeded',
        nextSequence: 1,
      };
      s.p.committed.push('Z0');
    },
  },
  /** A quiescent draining Harness with another owner's drain or a failed Harness. */
  quiet: {
    name: 'quiet',
    closers: ['A'],
    bindings: ['A'],
    env: ['hdrain', 'fail', 'crash'],
    budget: 2,
    polls: ['p1'],
    stopAt: 'published',
  },
  /** B's latch with a hidden P1/P2 anchor next to A's earlier receipt. */
  anchors: {
    name: 'anchors',
    closers: [],
    bindings: ['A', 'B'],
    env: ['hide'],
    budget: 1,
    polls: ['p1'],
    init: (s: State) => {
      s.cap.A = 'receipt';
      s.cap.B = 'claimed';
      s.h = { ...s.h, drain: 'draining', revision: 2, claimGeneration: 'gB1' };
      s.p.drainBy = ['claim:B'];
    },
  },
  /**
   * ENGINEER (b): A completes P6/P7 while sibling B, which never held the latch, has an abandoned
   * capture. The live owner releases once. After a restart the cold decide keeps the fence,
   * because the legacy c1 history leaves the same durable values.
   */
  sibling: {
    name: 'sibling',
    closers: ['A'],
    bindings: ['A', 'B'],
    env: ['Ts', 'crash'],
    budget: 2,
    polls: ['p1'],
    init: (s: State) => {
      startPublished()(s);
      s.cap.B = 'abandoned';
    },
    probes: {
      'genuine-sibling': (s: State) =>
        s.after &&
        s.used.includes('crash') &&
        s.h.cell === 'settled' &&
        s.h.operation === 'session.close' &&
        s.cap.B === 'abandoned' &&
        !s.p.drainBy.includes('claim:B') &&
        s.h.drain === 'draining',
      'live-release': (s: State) => s.c.A!.phase === 'done' && s.h.drain === 'accepting',
    },
  },
} satisfies Record<string, World>;

/* ---------------------------------------------------------------- mutations */

const T = REPLACEMENT_CLOSE_TABLE;
const withRules = (drop: readonly string[], add: readonly ColdRule[] = []) =>
  composeCold([...add, ...COLD_RULES.filter((rule) => !drop.includes(rule.id))]);
const replaceRule = (id: string, rule: ColdRule['decide']) =>
  composeCold(COLD_RULES.map((r) => (r.id === id ? { id, decide: rule } : r)));
type RestoreTakeOut = 'revision' | 'life' | 'harness-drain' | 'sandbox' | 'generation';
/** The G3 restore CAS with predicates taken out. `generation`: the pre-G3 CAS, with no compare. */
const restoreWithout =
  (...drop: readonly RestoreTakeOut[]) =>
  (h: HarnessFacts, s: SandboxFacts, frame: RestoreFrame) =>
    restoresFrame(
      {
        ...h,
        ...(drop.includes('life') ? { life: 'open' as const } : {}),
        ...(drop.includes('harness-drain') && h.operation === 'harness.drain'
          ? { operation: null }
          : {}),
        ...(drop.includes('revision') ? { revision: frame.revision } : {}),
        ...(drop.includes('generation') ? { claimGeneration: 'any' } : {}),
      },
      drop.includes('sandbox') ? { accepting: true, clean: true, currentEpoch: true } : s,
      drop.includes('generation') ? { ...frame, generation: 'any' } : frame
    );
const OPEN_SANDBOX: SandboxFacts = { accepting: true, clean: true, currentEpoch: true };
const postWithout =
  (field: 'Tc' | 'Ts' | 'edge' | 'mono' | 'pendingOwner' | 'thread' | 'policy') =>
  (p: ClosePremises) =>
    T.post({
      ...p,
      ...(field === 'Tc'
        ? { deadlines: { ...p.deadlines, Tc: LIVE_DEADLINE }, closeMonotonicExpired: false }
        : {}),
      ...(field === 'Ts' ? { deadlines: { ...p.deadlines, Ts: LIVE_DEADLINE } } : {}),
      ...(field === 'edge' ? { admitted: p.now } : {}),
      ...(field === 'mono' ? { closeMonotonicExpired: false } : {}),
      ...(field === 'pendingOwner' ? { pendingOwner: true } : {}),
      ...(field === 'thread' ? { audience: { ...p.audience, thread: true } } : {}),
      ...(field === 'policy' ? { audience: { ...p.audience, policy: true } } : {}),
    });
const bytesWithout =
  (
    field:
      | 'Ta'
      | 'edge'
      | 'mono'
      | 'placement'
      | 'idleReceipt'
      | 'pendingOwner'
      | 'thread'
      | 'policy'
      | 'storage'
      | 'connection'
  ) =>
  (p: ClosePremises) =>
    T.firstBytes({
      ...p,
      ...(field === 'Ta' ? { deadlines: { ...p.deadlines, Ta: LIVE_DEADLINE } } : {}),
      ...(field === 'edge' ? { admitted: p.now } : {}),
      ...(field === 'mono' ? { closeMonotonicExpired: false } : {}),
      ...(field === 'placement' ? { placement: { ...p.placement, sandbox: OPEN_SANDBOX } } : {}),
      ...(field === 'idleReceipt' ? { idleReceipt: true } : {}),
      ...(field === 'pendingOwner' ? { pendingOwner: true } : {}),
      ...(field === 'thread' ? { audience: { ...p.audience, thread: true } } : {}),
      ...(field === 'policy' ? { audience: { ...p.audience, policy: true } } : {}),
      ...(field === 'storage' ? { storage: true } : {}),
      ...(field === 'connection' ? { connection: true } : {}),
    });

/** The cold rules with `ids` moved in front of `before`. */
function moveBefore(
  ids: readonly string[],
  before: string,
  rules: readonly ColdRule[] = COLD_RULES
): ColdRule[] {
  const moved = rules.filter((r) => ids.includes(r.id));
  const rest = rules.filter((r) => !ids.includes(r.id));
  const at = rest.findIndex((r) => r.id === before);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** The S2-r1 P7: restore on the exact settled close and its settle revision alone. */
const S2R1_P7_RULES: readonly ColdRule[] = COLD_RULES.map((r) =>
  r.id === 'p7-success' || r.id === 'p7-stale'
    ? {
        id: r.id,
        decide: (f: ColdFacts): ColdAction | undefined =>
          settledCloseProof(f, r.id === 'p7-success' ? 'succeeded' : 'stale')
            ? {
                kind: 'restore',
                scope: 'close',
                frame: {
                  arm: 'close',
                  key: f.harness.key!,
                  revision: f.harness.revision,
                  generation: f.harness.claimGeneration,
                },
              }
            : undefined,
      }
    : r
);

interface MutationRow {
  readonly id: string;
  readonly world: World;
  readonly oracle: string;
  readonly table: Partial<ReplacementCloseTable>;
  readonly takeOut: string;
  /** The named writer: the failing trace must contain this edge. */
  readonly via?: string;
}

/**
 * The S3b-m clock rule as a premise change (M-H4g, M-H4h): a failed monotonic Tc counted only as
 * the lower edge, so it decided only when no other clock failed.
 */
function monotonicOutOfMinimum<P extends PostPremises>(p: P): P {
  const other =
    (['Tc', 'Ts', 'Ta'] as const).some((clock) => p.deadlines[clock] <= p.now) ||
    p.request === 'expired' ||
    p.audience.thread === 'expired';
  return other ? { ...p, closeMonotonicExpired: false } : p;
}

/**
 * S3b-m: older single take-outs that G3 now stops. The cold decide fences a row that no claim of
 * this lifecycle holds (a null generation), and Native compares the generation at the restore and,
 * since S3b-m-r2, at RC8. So each take-out below reaches no violation of its oracle under G3.
 * `preG3` removes G3 too: the cold decide sees no null generation, and Native compares no
 * generation. M runs each such double take-out, which shows that the older fence still holds alone.
 */
const SUBSUMED: readonly MutationRow[] = [
  // S3b-m-r2: RC8 compares the pinned generation too, so a revision take-out alone transfers no
  // other close's claim and no replay's.
  {
    id: 'M-F2a',
    world: WORLDS.foreign,
    oracle: 'O.queue',
    takeOut: 'drop the RC8 revision transfer check',
    table: {
      queue: (input) =>
        T.queue({
          ...input,
          claimRevision:
            input.harness.drain === 'draining' ? input.harness.revision : input.claimRevision,
        }),
    },
  },
  {
    id: 'M-F2b',
    world: WORLDS.replay,
    oracle: 'O.queue',
    takeOut: 'a replay inherits the Harness latch',
    table: {
      queue: (input) =>
        T.queue({ ...input, claimRevision: input.claimRevision ?? input.harness.revision }),
    },
  },
  {
    id: 'M-F2c',
    world: WORLDS.pausedRestore,
    oracle: 'O.restore.live-latch',
    takeOut: 'restore CAS without the revision',
    table: { restore: restoreWithout('revision') },
  },
  {
    id: 'M-F2d',
    world: WORLDS.pausedRestore,
    oracle: 'O.restore.live-latch',
    takeOut: 'accept an equal claim clock',
    table: {
      claim: (h, s, fresh) => {
        const r = T.claim(h, s, fresh);
        return typeof r === 'string' ? r : { ...r, revision: h.revision };
      },
    },
  },
  {
    id: 'M-F4h',
    world: WORLDS.pausedRestore,
    oracle: 'O.restore.live-latch',
    takeOut: 'restore CAS without the revision (paused after the read)',
    table: { restore: restoreWithout('revision') },
  },
  {
    id: 'M-F4g',
    world: WORLDS.legacyC1,
    oracle: 'O.restore.abandon',
    takeOut: 'restore on an abandon',
    table: { cold: withRules(['abandon']) },
  },
  {
    id: 'M-C3',
    world: WORLDS.quiet,
    oracle: 'O.restore.foreign',
    takeOut: 'the quiescent exit clears a Harness-only drain',
    table: {
      cold: composeCold(
        COLD_RULES.filter((r) => r.id !== 'harness-drain').map((r) =>
          r.id === 'quiescent'
            ? {
                id: r.id,
                decide: (f: ColdFacts) =>
                  r.decide({ ...f, harness: { ...f.harness, operation: null } }),
              }
            : r.id === 'drain-after-op'
              ? {
                  id: r.id,
                  decide: (f: ColdFacts) =>
                    f.harness.operation === 'harness.drain' ? undefined : r.decide(f),
                }
              : r
        )
      ),
      restore: restoreWithout('harness-drain'),
    },
  },
  {
    id: 'M-V2a',
    world: WORLDS.quiet,
    oracle: 'O.restore.foreign',
    takeOut: 'drop the Harness lifecycle predicate',
    table: {
      cold: composeCold(
        COLD_RULES.map((r) =>
          r.id === 'native-fence'
            ? {
                id: r.id,
                decide: (f: ColdFacts) =>
                  f.harness.cell === 'unknown'
                    ? ({ kind: 'fence', reason: 'native-fence' } as const)
                    : undefined,
              }
            : r.id === 'quiescent'
              ? {
                  id: r.id,
                  decide: (f: ColdFacts) =>
                    r.decide({ ...f, harness: { ...f.harness, life: 'open' } }),
                }
              : r
        )
      ),
      restore: restoreWithout('life'),
    },
  },
  {
    id: 'M-HD1',
    world: WORLDS.staleReceipt,
    oracle: 'O.restore.foreign',
    takeOut: 'the quiescent exit accepts any last operation (F3-HD)',
    table: { cold: withRules(['drain-after-op']) },
  },
  {
    id: 'M-HD2',
    world: WORLDS.overdrain,
    oracle: 'O.restore.foreign',
    takeOut: 'the quiescent exit accepts any last operation (drain on a local marker)',
    table: { cold: withRules(['drain-after-op']) },
    via: 'env:hdrain',
  },
  {
    id: 'M-P7a',
    world: WORLDS.legacyC1,
    oracle: 'O.restore.abandon',
    takeOut: 'the S2-r1 P7 restore runs before the anchor and abandon fences (the S2 order)',
    table: {
      cold: composeCold(moveBefore(['p7-success', 'p7-stale'], 'anchors', S2R1_P7_RULES)),
    },
  },
  {
    id: 'M-P7b',
    world: WORLDS.legacyC1,
    oracle: 'O.restore.foreign',
    takeOut: 'P7 restores on the settle revision alone (S2-r1), c1 claim over an independent drain',
    table: { cold: composeCold(S2R1_P7_RULES) },
    via: 'env:hdrain',
  },
  {
    id: 'M-P7c',
    world: WORLDS.legacyR2,
    oracle: 'O.restore.foreign',
    takeOut: 'P7 restores on the settle revision alone (S2-r1), r2 claim over an independent drain',
    table: { cold: composeCold(S2R1_P7_RULES) },
    via: 'env:hdrain',
  },
];

const preG3 = (row: MutationRow): MutationRow => {
  const cold = row.table.cold ?? T.cold;
  const restore = row.table.restore ?? T.restore;
  const queue = row.table.queue ?? T.queue;
  return {
    ...row,
    takeOut: `${row.takeOut}, and before G3`,
    table: {
      ...row.table,
      cold: (f) =>
        cold({
          ...f,
          harness: { ...f.harness, claimGeneration: f.harness.claimGeneration ?? 'old' },
        }),
      restore: (h, sb, frame) =>
        restore({ ...h, claimGeneration: 'any' }, sb, { ...frame, generation: 'any' }),
      // S3b-m-r2: RC8 compares no generation either.
      queue: (input) => queue({ ...input, claimGeneration: undefined }),
    },
  };
};

const M: readonly MutationRow[] = [
  {
    id: 'M-F1a',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'drop Tc at RC7',
    table: { post: postWithout('Tc') },
  },
  {
    id: 'M-F1b',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'only Ts in the deadline slot',
    table: { deadlineSlot: ['Ts'] },
  },
  {
    id: 'M-F1c',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'drop the pending owner at RC7',
    table: { post: postWithout('pendingOwner') },
  },
  {
    id: 'M-Ta1',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'Ta left out of the deadline slot',
    table: { deadlineSlot: ['Tc', 'Ts'] },
  },
  {
    id: 'M-Ta2',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop Ta at RC10',
    table: { firstBytes: bytesWithout('Ta') },
  },
  {
    id: 'M-F2e',
    world: WORLDS.losing,
    oracle: 'O.one-claim',
    takeOut: 'accept the claim on a draining Harness',
    table: { claim: (h, _s, fresh) => ({ revision: h.revision + 1, generation: fresh }) },
  },
  {
    id: 'M-F3a',
    world: WORLDS.live,
    oracle: 'O.live-rollback',
    takeOut: 'keep the latch on a live refusal',
    table: { liveRefusalLatch: 'keep' },
  },
  {
    id: 'M-F3b',
    world: WORLDS.prefix,
    oracle: 'L.exit',
    takeOut: 'remove the quiescent Harness exit',
    table: { cold: withRules(['quiescent']) },
  },
  {
    id: 'M-F3c',
    world: WORLDS.live,
    oracle: 'O.noncommit',
    takeOut: 'a lost reply is a noncommit',
    table: { lostReply: 'noncommit' },
  },
  {
    id: 'M-F3d',
    world: WORLDS.live,
    oracle: 'L.exit',
    takeOut: 'remove the P6 result-only completion',
    table: { cold: withRules(['p6-stale']) },
  },
  {
    id: 'M-F3g',
    world: WORLDS.live,
    oracle: 'O.unsent',
    takeOut: 'settle stale from a cold dispatched row',
    table: {
      cold: replaceRule('p5', (f) =>
        f.harness.cell === 'dispatched' && f.harness.key
          ? { kind: 'complete-native-result', binding: f.harness.key.slice(0, 1) }
          : undefined
      ),
    },
  },
  {
    id: 'M-F4a',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'drop the Thread audience at RC7',
    table: { post: postWithout('thread') },
  },
  {
    id: 'M-F4b',
    world: WORLDS.pins,
    oracle: 'O.queue',
    takeOut: 'release the Core hold at the post',
    table: { holdUntil: { core: 'post', workspace: 'queue-reply' } },
    via: 'env:core',
  },
  {
    id: 'M-F4i',
    world: WORLDS.pins,
    oracle: 'O.queue',
    takeOut: 'release the successor Workspace hold at the post',
    table: { holdUntil: { core: 'queue-reply', workspace: 'post' } },
    via: 'env:thread',
  },
  {
    id: 'M-F4c',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop storage at RC10',
    table: { firstBytes: bytesWithout('storage') },
  },
  {
    id: 'M-F4d',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop the connection at RC10',
    table: { firstBytes: bytesWithout('connection') },
  },
  {
    id: 'M-F4e',
    world: WORLDS.live,
    oracle: 'O.one-send',
    takeOut: 'drop the delivery reservation',
    table: {
      dispatch: (i) =>
        i.harness.key === i.key && (i.harness.cell === 'queued' || i.harness.cell === 'dispatched')
          ? null
          : 'delivery',
    },
  },
  {
    id: 'M-F4f',
    world: WORLDS.live,
    oracle: 'O.unsent',
    takeOut: 'settle as unsent after a lost response',
    table: { afterContact: 'settle-stale' },
  },
  {
    id: 'M-D1a',
    world: WORLDS.live,
    oracle: 'O.bound',
    takeOut: 'arm the caller bound after the reply',
    table: { callerBound: 'after-reply' },
  },
  {
    id: 'M-D2a',
    world: WORLDS.live,
    oracle: 'L.slot',
    takeOut: 'treat a definite refusal as unproved',
    table: { definiteRefusal: 'hold' },
  },
  {
    id: 'M-D2b',
    world: WORLDS.census,
    oracle: 'O.noncommit',
    takeOut: 'a lost reply is a noncommit (commit then lost reply)',
    table: { lostReply: 'noncommit' },
  },
  {
    id: 'M-D3',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'a Sandbox-only read replaces the cause',
    table: { carryCause: (_first, fallback) => fallback },
  },
  {
    id: 'M-20a',
    world: WORLDS.live,
    oracle: 'L.e7',
    takeOut: 'suppress the E7 after the rollback restore',
    table: { e7: ({ changed, site }) => changed && site !== 'rollback' },
  },
  {
    id: 'M-20b',
    world: WORLDS.live,
    oracle: 'O.e7',
    takeOut: 'request E7 after a no-op restore',
    table: { e7: () => true },
  },
  {
    id: 'M-21a',
    world: WORLDS.live,
    oracle: 'L.e7',
    takeOut: 'omit the E7 at the completion',
    table: { e7: ({ changed, site }) => changed && site !== 'completion' },
  },
  {
    id: 'M-R10a',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop the exact Core idle receipt at RC10',
    table: { firstBytes: bytesWithout('idleReceipt') },
  },
  {
    id: 'M-R10b',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop the pending owner at RC10',
    table: { firstBytes: bytesWithout('pendingOwner') },
  },
  {
    id: 'M-R10c',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop the Thread audience at RC10',
    table: { firstBytes: bytesWithout('thread') },
  },
  {
    id: 'M-R10d',
    world: WORLDS.live,
    oracle: 'O.unsent',
    takeOut: 'map a transport failure to the 204 local stale',
    table: { transportFailure: 'settle-stale' },
  },
  {
    id: 'M-A1a',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'drop the applied policy at RC7',
    table: { post: postWithout('policy') },
  },
  {
    id: 'M-A1b',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'drop the applied policy at RC10',
    table: { firstBytes: bytesWithout('policy') },
  },
  {
    id: 'M-A1c',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'the policy swap does not wait for the Core hold (RC8 order)',
    table: { policyOrder: 'none' },
    via: 'install:policy',
  },
  {
    id: 'M-C1',
    world: WORLDS.census,
    oracle: 'O.fence',
    takeOut: 'treat an expired queued cell as unsent',
    table: {
      settle: (h, key) =>
        (h.cell === 'dispatched' || (h.cell === 'unknown' && h.result === null)) && h.key === key,
      cold: withRules(
        ['native-fence'],
        [
          {
            id: 'expired-unsent',
            decide: (f) =>
              f.harness.cell === 'unknown' && f.harness.result === null && f.harness.key
                ? { kind: 'complete-native-result', binding: f.harness.key.slice(0, 1) }
                : undefined,
          },
        ]
      ),
    },
  },
  {
    id: 'M-C2',
    world: WORLDS.census,
    oracle: 'O.fence',
    takeOut: 'settle a retained dispatched unknown as stale',
    table: {
      settle: (h, key) =>
        (h.cell === 'dispatched' || (h.cell === 'unknown' && h.result === 'unknown')) &&
        h.key === key,
      cold: withRules(
        ['native-fence'],
        [
          {
            id: 'unknown-stale',
            decide: (f) =>
              f.harness.cell === 'unknown' && f.harness.result === 'unknown' && f.harness.key
                ? { kind: 'complete-native-result', binding: f.harness.key.slice(0, 1) }
                : undefined,
          },
        ]
      ),
    },
  },
  {
    id: 'M-C4',
    world: WORLDS.census,
    oracle: 'O.expiry-key',
    takeOut: 'expire by binding and state only',
    table: { expiryApplies: (h) => h.cell === 'queued' },
  },
  {
    id: 'M-P7',
    world: WORLDS.live,
    oracle: 'O.occupancy',
    takeOut: 'decrement occupancy at the restore',
    table: { restoreDecrement: 1 },
  },
  {
    id: 'M-P4',
    world: WORLDS.census,
    oracle: 'O.noncommit',
    takeOut: 'a different current key is absence',
    table: { absent: (h, o) => h.key !== o.key && h.cell !== 'unknown' },
  },
  {
    id: 'M-V1a',
    world: WORLDS.cl3,
    oracle: 'O.ws-exclusive',
    takeOut: 'drop the Main exclusion before RC2',
    table: { admit: (i) => T.admit({ ...i, exclusionHolder: null }) },
  },
  {
    id: 'M-V1b',
    world: WORLDS.losing,
    oracle: 'O.ws-record',
    takeOut: 'erase the losing Workspace record',
    table: { losingClaimRecord: 'erase' },
  },
  {
    id: 'M-V2b',
    world: WORLDS.anchors,
    oracle: 'O.restore.unsettled',
    takeOut: 'restore on the readable anchors only',
    table: { cold: withRules(['anchors']) },
  },
  {
    id: 'M-T1',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'answer close-allowance for every deadline-slot refusal',
    table: { slotCause: () => 'close-allowance' },
  },
  {
    id: 'M-T2',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'RC7 reads only the wall Tc',
    table: { post: postWithout('mono') },
    via: 'env:TcMono',
  },
  {
    id: 'M-T3',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'RC10 reads only the wall Tc',
    table: { firstBytes: bytesWithout('mono') },
    via: 'env:TcMono',
  },
  {
    id: 'M-T4',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'RC7 answers Tc before an earlier limiting clock',
    table: {
      post: (p) =>
        p.pendingOwner && (p.deadlines.Tc <= p.now || p.closeMonotonicExpired)
          ? 'close-allowance'
          : T.post(p),
    },
  },
  {
    id: 'M-N1',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'RC8 does not read the Sandbox owner facts',
    table: { queue: (i) => T.queue({ ...i, sandbox: OPEN_SANDBOX }) },
    via: 'env:sbdrain',
  },
  {
    id: 'M-N2',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'RC10 does not read the Sandbox owner facts',
    table: { firstBytes: bytesWithout('placement') },
    via: 'env:sbdrain',
  },
  {
    id: 'M-T5',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'Main maps the acknowledged deadline refusal from the wall at the reply (S2-r1)',
    table: { slotClockAt: 'reply' },
    via: 'env:Wback',
  },
  {
    id: 'M-T6',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'RC7 reads a wall sample before the enqueue instant (no lower Tc edge, S3a)',
    table: { post: postWithout('edge') },
    via: 'env:Wback',
  },
  {
    id: 'M-T7',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'RC10 reads a wall sample before the enqueue instant (no lower Tc edge, S3a)',
    table: { firstBytes: bytesWithout('edge') },
    via: 'env:Wback',
  },
  {
    id: 'M-T8',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'RC7 leaves an expired Ts to the P14 audience refusal (S3a)',
    table: { post: postWithout('Ts') },
    via: 'env:Ts',
  },
  {
    id: 'M-Ta3',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'Ta folds only the presented credential (S3a)',
    table: {
      authorityDeadline: (cutoffs) =>
        T.authorityDeadline(cutoffs.filter((c) => c.credential === 'presented')),
    },
    via: 'env:Ti',
  },
  {
    id: 'M-S7',
    world: WORLDS.live,
    oracle: 'O.frame',
    takeOut: 'RC7 samples the clock before its fact reads (S3a-r1 order)',
    table: { clockSample: { ...T.clockSample, post: 'before-reads' } },
    via: 'post:A~audience:Tc',
  },
  {
    id: 'M-S8',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'RC8 samples the Native wall before its reads and the deciding update (S3a-r1 order)',
    table: { clockSample: { ...T.clockSample, queue: 'before-reads' } },
    via: 'queue:A~harness:Tc',
  },
  {
    id: 'M-S10',
    world: WORLDS.live,
    oracle: 'O.bytes',
    takeOut: 'RC10 samples the clock before its fact reads and the dispatched key (S3a-r1 order)',
    table: { clockSample: { ...T.clockSample, firstBytes: 'before-reads' } },
    via: 'write:p1:ok~drain:Tc',
  },
  {
    id: 'M-S8w',
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'RC8 compares a Native sample taken after its reads, outside the deciding update',
    table: { clockSample: { ...T.clockSample, queue: 'after-reads' } },
    via: 'queue:A~sample:Tc',
  },
  {
    id: 'M-R7',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'RC7 answers R before the clocks (an elapsed credential answers request)',
    table: { post: (p) => (p.pendingOwner && p.request !== true ? 'request' : decidePost(p)) },
    via: 'env:Ta',
  },
  {
    id: 'M-R10',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'RC10 answers R before the clocks (an elapsed credential answers request)',
    table: {
      firstBytes: (p) =>
        p.connection && p.pendingOwner && p.request !== true
          ? { kind: 'refuse', cause: 'request' }
          : decideFirstBytes(p),
    },
    via: 'env:Ta',
  },
  {
    id: 'M-Fb',
    world: WORLDS.receiptReplayDrain,
    oracle: 'O.one-claim',
    takeOut: 'accept the replayed claim on a draining Harness (F-b: the legacy RC3 CAS)',
    table: { claim: (h, _s, fresh) => ({ revision: h.revision + 1, generation: fresh }) },
    via: 'readmit:A',
  },
  // G3 (S3b-m): removing the generation compare reopens B in each reuse schedule.
  {
    id: 'M-G3a',
    world: WORLDS.reuse99,
    oracle: 'O.restore.dup',
    takeOut: 'restore CAS without the generation compare (session.open settles at 99)',
    table: { restore: restoreWithout('generation') },
    via: 'env:open@99',
  },
  {
    id: 'M-G3b',
    world: WORLDS.reuseBind,
    oracle: 'O.restore.dup',
    takeOut: 'restore CAS without the generation compare (a binding opens at 99, no sequence)',
    table: { restore: restoreWithout('generation') },
    via: 'env:bind@99',
  },
  {
    id: 'M-G3c',
    world: WORLDS.reuseRecreate,
    oracle: 'O.restore.dup',
    takeOut: 'restore CAS without the generation compare (same-name recreation)',
    table: { restore: restoreWithout('generation') },
    via: 'env:recreate',
  },
  {
    id: 'M-G3d',
    world: WORLDS.pausedReuse,
    oracle: 'O.restore.live-latch',
    takeOut: 'restore CAS without the generation compare (the paused cold restore)',
    table: { restore: restoreWithout('generation') },
    via: 'env:open@99',
  },
  {
    id: 'M-G3e',
    world: WORLDS.reuseClaim99,
    oracle: 'O.restore.dup',
    takeOut: 'a claim generation derived from the claim clock, so it recurs',
    table: {
      claim: (h, s, fresh) => {
        const r = T.claim(h, s, fresh);
        return typeof r === 'string' ? r : { ...r, generation: `r${r.revision}` };
      },
    },
    via: 'env:open@99',
  },
  // H4-1 (S3b-m): the read carries its clock to the decision. Production F passes a boolean R and A
  // today, so it behaves as these take-outs.
  {
    id: 'M-H4a',
    world: WORLDS.h4gather,
    oracle: 'O.cause',
    takeOut: 'RC10 drops the expiry that the R reader carries (a boolean R)',
    table: { firstBytes: (p) => decideFirstBytes({ ...p, request: p.request === true }) },
    via: 'env:Wpart',
  },
  {
    id: 'M-H4b',
    world: WORLDS.h4gather,
    oracle: 'O.cause',
    takeOut: 'RC7 drops the expiry that the R reader carries (a boolean R)',
    table: { post: (p) => decidePost({ ...p, request: p.request === true }) },
    via: 'env:Wpart',
  },
  {
    id: 'M-H4c',
    world: WORLDS.h4gather,
    oracle: 'O.cause',
    takeOut: 'RC10 drops the Ts expiry that the P14 owner carries (a boolean A)',
    table: {
      firstBytes: (p) =>
        decideFirstBytes({ ...p, audience: { ...p.audience, thread: p.audience.thread === true } }),
    },
    via: 'env:Wpart',
  },
  {
    id: 'M-H4d',
    world: WORLDS.h4gather,
    oracle: 'O.cause',
    takeOut: 'RC7 drops the Ts expiry that the P14 owner carries (a boolean A)',
    table: {
      post: (p) =>
        decidePost({ ...p, audience: { ...p.audience, thread: p.audience.thread === true } }),
    },
    via: 'env:Wpart',
  },
  {
    // H4-2: the R reader and the current-Ta fold read the same rotation independently. Either
    // alone keeps the typed cause, so the take-out removes both.
    id: 'M-H4e',
    world: WORLDS.rotate,
    oracle: 'O.cause',
    takeOut: 'RC10 checks the posted Ta only and drops the expiry that the R reader carries',
    table: {
      firstBytesAuthority: 'posted',
      firstBytes: (p) => decideFirstBytes({ ...p, request: p.request === true }),
    },
    via: 'env:rotate',
  },
  {
    id: 'M-H4f',
    world: WORLDS.wcrash,
    oracle: 'O.noncommit',
    takeOut: 'a Native exit after the commit releases the claim as a noncommit',
    table: { lostReply: 'noncommit' },
    via: 'env:wcrash',
  },
  // S3b-m-r2 (V1-P FIX 2 item 2): a failed monotonic Tc is in the cause minimum.
  {
    id: 'M-H4g',
    world: WORLDS.h4mono,
    oracle: 'O.cause',
    takeOut: 'RC7 leaves a failed monotonic Tc out of the cause minimum (the S3b-m rule)',
    table: { post: (p) => decidePost(monotonicOutOfMinimum(p)) },
    via: 'env:TcMono',
  },
  {
    id: 'M-H4h',
    world: WORLDS.h4mono,
    oracle: 'O.cause',
    takeOut: 'RC10 leaves a failed monotonic Tc out of the cause minimum (the S3b-m rule)',
    table: { firstBytes: (p) => decideFirstBytes(monotonicOutOfMinimum(p)) },
    via: 'env:TcMono',
  },
  // S3b-m-r2 (V1-P FIX 2 item 1): RC8 compares the pinned generation.
  {
    id: 'M-G3f',
    world: WORLDS.equalStamp,
    oracle: 'O.queue',
    takeOut: 'RC8 compares the claim revision alone (no generation)',
    table: { queue: (input) => T.queue({ ...input, claimGeneration: undefined }) },
    via: 'env:hdrain@claim',
  },
  // S3b-m-r2 (V1-P): the committed restore clears the generation, checked on the written row.
  {
    id: 'M-G3g',
    world: WORLDS.live,
    oracle: 'O.restore.clear',
    takeOut: 'the committed restore keeps the claim generation',
    table: { restoreRow: (h) => ({ ...h, drain: 'accepting' }) },
  },
  ...SUBSUMED.map(preG3),
];

const tableOf = (row: MutationRow): ReplacementCloseTable => ({ ...T, ...row.table });

/** Optional evidence sink: set the variable to a file path to keep counts and shortest traces. */
const evidence: Record<string, unknown> = {};
const keep = (name: string, value: unknown) => {
  evidence[name] = value;
  const target = process.env.CLOSE_LC_EXPLORER_REPORT;
  if (target) writeFileSync(target, `${JSON.stringify(evidence, null, 1)}\n`);
};

const SAFETY = (name: string) => name.startsWith('O.') || name.startsWith('L.');

const cache = new Map<string, Report>();
const reportOf = (world: World): Report => {
  let report = cache.get(world.name);
  if (!report) {
    report = explore(world, T);
    cache.set(world.name, report);
  }
  return report;
};

/**
 * The named writer edge of a failing trace. A clock writer `env:X` can also pass inside an effect
 * gather (CL2): the gather edge `<effect>~<read>:X` names the same writer after that read.
 */
const isViaEdge = (traced: string, via: string) => {
  // The last edge of a trace also carries the violation detail.
  const label = traced.split(' -> ')[0]!;
  const clock = via.startsWith('env:') ? via.slice(4) : null;
  return (
    label === via ||
    (clock !== null &&
      isClockEvent(clock as Env) &&
      label.includes('~') &&
      (label.endsWith(`:${clock}`) || label.includes(`:${clock}@`)))
  );
};

/**
 * Follows one directed schedule. Each edge must be enabled and violate nothing. As in `explore`,
 * the older writers of a legacy world are not checked before the restart.
 */
function run(world: World, labels: readonly string[], table = T): State {
  let s = initial(world);
  for (const [i, label] of labels.entries()) {
    const step = steps(world, table, s).find((x) => x.label === label);
    if (!step)
      throw new Error(`${label} is not enabled after ${labels.slice(0, i).join(' | ') || 'start'}`);
    if (!world.legacy || s.after) expect(step.violations).toEqual([]);
    s = step.next;
  }
  return s;
}
const enabled = (world: World, s: State) => steps(world, T, s).map((x) => x.label);

const TO_POST = ['admit:A', 'ws:A', 'claim:A', 'raw:A', 'pub:A', 'hold:A', 'post:A'];
const TO_QUEUED = [...TO_POST, 'queue:A', 'reply:A:ack'];

describe('replacement close lifecycle model check', () => {
  it.each(Object.values(WORLDS))(
    'the unmodified table holds every invariant in $name',
    (world) => {
      const report = reportOf(world);
      keep(`baseline:${world.name}`, report);
      expect(report.truncated).toBe(false);
      expect(Object.keys(report.traces).filter(SAFETY)).toEqual([]);
      expect(report.states).toBeGreaterThan(1);
      expect(report.quiescent).toBeGreaterThan(0);
    },
    600_000
  );

  it('reports state and edge counts and the named fences', () => {
    const reports = Object.values(WORLDS).map(reportOf);
    const totals = {
      states: reports.reduce((n, r) => n + r.states, 0),
      edges: reports.reduce((n, r) => n + r.edges, 0),
    };
    keep('totals', totals);
    for (const r of reports) expect(r.edges).toBeGreaterThanOrEqual(r.states - 1);
    expect(totals.states).toBeGreaterThan(1000);
  });

  it('F-b: a retry replays its published receipt, claims again, and RC8 transfers that claim', () => {
    const report = reportOf(WORLDS.receiptReplay);
    keep('F-b', { probes: report.probes });
    const probe = report.probes['replay-transfer'];
    expect(probe?.states).toBeGreaterThan(0);
    // The live refusal rolls the first claim back. The replay claims again and closes.
    expect(probe!.trace).toContain('env:requeue');
    expect(probe!.trace).toContain('readmit:A');
    expect(probe!.trace!.filter((step) => step === 'claim:A')).toHaveLength(2);
  });

  it('F3: full durable values cannot name the claimant, at the crash edge and after the restart', () => {
    const c1 = reportOf(WORLDS.legacyC1);
    const r2 = reportOf(WORLDS.legacyR2);
    const cl3 = reportOf(WORLDS.cl3);
    keep('f3', {
      c1: c1.projections,
      r2: r2.projections,
      cl3: cl3.projections,
      fences: { c1: c1.fences, r2: r2.fences, cl3: cl3.fences },
    });
    // Older writers leave equal projections for different latch owners at the crash edge itself.
    expect(c1.projections!.crash.ambiguous).toBeGreaterThan(0);
    expect(c1.projections!.after.ambiguous).toBeGreaterThan(0);
    // The lifted phase cap reaches every legacy history.
    for (const h of ['H1', 'H2', 'H3'])
      expect(
        (c1.projections!.after.histories[h] ?? 0) + (r2.projections!.after.histories[h] ?? 0)
      ).toBeGreaterThan(0);
    // CL3 produces no double claim.
    expect(cl3.projections?.after.histories.H2 ?? 0).toBe(0);
    expect(cl3.projections?.crash.histories.H2 ?? 0).toBe(0);
  }, 600_000);

  it('V1-P: the legacy P7 history over an abandoned later claim stays fenced', () => {
    const probe = reportOf(WORLDS.legacyC1).probes['v1p-unsafe-p7'];
    keep('v1p-unsafe-p7', probe);
    expect(probe?.states).toBeGreaterThan(0);
    expect(Object.keys(probe!.quiescent)).toEqual(['abandon-own']);
  }, 600_000);

  it.each([WORLDS.legacyC1, WORLDS.legacyR2])(
    'V1-P S2-r1: $name keeps the independent drain under a settled P7 close, and its reuse control decides alike',
    (world) => {
      const tail = [
        'claim:A',
        'raw:A',
        'pub:A',
        'hold:A',
        'post:A',
        'queue:A',
        'reply:A:ack',
        'dispatch:p1',
        'write:p1:ok',
        'result:A1',
        'nsettle:A1',
        'env:crash',
      ];
      const drained = run(world, ['admit:A', 'ws:A', 'env:hdrain', ...tail]);
      const control = run(world, ['admit:A', 'ws:A', 'env:reuse', ...tail]);
      expect(drained.p.drainBy).toEqual(['hdrain', 'claim:A']);
      expect(control.p.drainBy).toEqual(['claim:A']);
      // Equal inputs to the cold decision, so one disposition for both: the fence.
      const facts = coldFacts(world, drained);
      expect(coldFacts(world, control)).toEqual(facts);
      expect(T.cold(facts)).toEqual({ kind: 'fence', reason: 'unattributed-claim' });
      expect(enabled(world, drained).filter((l) => l.startsWith('cold:'))).toEqual([]);
      // The S2-r1 P7 restored both, and so cleared the independent drain.
      expect(composeCold(S2R1_P7_RULES)(facts)).toMatchObject({ kind: 'restore', scope: 'close' });
      // Every explored P7 projection, with or without the independent drain, fences.
      const report = reportOf(world);
      keep(`legacy-p7:${world.name}`, {
        overDrain: report.probes['legacy-p7-over-drain'],
        ownClaim: report.probes['legacy-p7-own-claim'],
      });
      for (const name of ['legacy-p7-over-drain', 'legacy-p7-own-claim']) {
        const probe = report.probes[name]!;
        expect(probe.states).toBeGreaterThan(0);
        expect(probe.decisions['fence:unattributed-claim']).toBeGreaterThan(0);
        expect(Object.keys(probe.decisions).filter((d) => !d.startsWith('fence:'))).toEqual([]);
      }
      expect(Object.keys(report.probes['legacy-p7-over-drain']!.quiescent)).toEqual([
        'harness-drain',
      ]);
    },
    600_000
  );

  it('ENGINEER (b): the genuine sibling keeps its fence after a restart; the live owner releases once', () => {
    const report = reportOf(WORLDS.sibling);
    keep('sibling', report.probes);
    expect(Object.keys(report.probes['genuine-sibling']!.quiescent)).toEqual(['abandon-sibling']);
    expect(report.probes['live-release']!.states).toBeGreaterThan(0);
    expect(report.exits['restore:']).toBeGreaterThan(0);
  }, 600_000);

  it('ENGINEER F3-HD fails closed: a stale receipt never clears a foreign drain', () => {
    const report = reportOf(WORLDS.staleReceipt);
    keep('engineer:f3-hd', { fences: report.fences, probes: report.probes, exits: report.exits });
    expect(Object.keys(report.traces).filter(SAFETY)).toEqual([]);
    expect(Object.keys(report.probes['f3-hd']!.quiescent)).toEqual(['harness-drain']);
    expect(report.exits).toEqual({});
  });

  it('an independent drain that lands on a local claim survives every exit', () => {
    const report = reportOf(WORLDS.overdrain);
    const probe = report.probes['independent-on-marker']!;
    keep('overdrain', { fences: report.fences, probe });
    expect(probe.states).toBeGreaterThan(0);
    expect(Object.keys(probe.quiescent)).toEqual(['harness-drain']);
  });

  it('positive endpoints: each exit admits one fresh close, and CL3 runs both winner orders', () => {
    const exits = Object.fromEntries(
      Object.values(WORLDS).map((w) => [w.name, { ...reportOf(w).exits, fresh: reportOf(w).fresh }])
    );
    keep('exits', exits);
    for (const w of Object.values(WORLDS)) {
      const r = reportOf(w);
      expect(r.fresh).toBe(Object.values(r.exits).reduce((n, x) => n + x, 0));
    }
    expect(reportOf(WORLDS.prefix).exits['cold:restore:quiescent']).toBeGreaterThan(0);
    // V1-P S2-r1 item 1: no cold P7 restore remains; the live owner releases its own close.
    for (const w of Object.values(WORLDS))
      expect(reportOf(w).exits['cold:restore:close'] ?? 0).toBe(0);
    expect(reportOf(WORLDS.live).fences['unattributed-claim']).toBeGreaterThan(0);
    expect(reportOf(WORLDS.live).exits['restore:']).toBeGreaterThan(0);
    expect(reportOf(WORLDS.census).exits['cold:restore:quiescent']).toBeGreaterThan(0);
    const cl3 = reportOf(WORLDS.cl3full);
    keep('cl3-full', cl3.probes);
    // G1/G2: each winner order ends with the other's fresh claim and an accepting Harness.
    expect(cl3.fences).toEqual({});
    for (const g of ['G1', 'G2']) {
      expect(cl3.probes[g]?.states).toBeGreaterThan(0);
      expect(cl3.probes[g]?.quiescent).toEqual({ accepting: 1 });
    }
  }, 600_000);

  describe('CL2: the clock sample follows the last fact read (S3a-r2)', () => {
    const live = WORLDS.live;
    const SITES = [
      { site: 'post', to: TO_POST.slice(0, -1), effect: 'post:A' },
      { site: 'queue', to: TO_POST, effect: 'queue:A' },
      { site: 'firstBytes', to: [...TO_QUEUED, 'dispatch:p1'], effect: 'write:p1:ok' },
    ] as const;
    // `Wpart` moves only in an H4-1 gather (the h4-gather world), never in the live world.
    const CAUSE: Readonly<Record<Exclude<ClockEvent, 'Wpart'>, CloseCause>> = {
      Tc: 'close-allowance',
      Ts: 'startup-deadline',
      Ta: 'authority-expired',
      Ti: 'authority-expired',
      TcMono: 'close-allowance',
      Wback: 'close-allowance',
    };
    const eventsAt = (site: EffectSite) =>
      CLOCK_EVENTS.filter(
        (clock): clock is Exclude<ClockEvent, 'Wpart'> =>
          clock !== 'Wpart' && (site !== 'queue' || clock !== 'TcMono')
      );
    /** The gather positions: after each fact read, and after the Native sample. */
    const positionsAt = (site: EffectSite): readonly string[] => [
      ...EFFECT_READS[site],
      ...(SAMPLE_GAP[site] ? ['sample'] : []),
    ];

    it.each(SITES)(
      '$site: a clock that passes after any fact read refuses the effect',
      ({ site, to, effect }) => {
        let cases = 0;
        for (const read of positionsAt(site))
          for (const clock of eventsAt(site)) {
            const label = `${effect}~${read}:${clock}`;
            // `run` also requires every edge to violate nothing, O.sample included.
            const s = run(live, [...to, label]);
            cases += 1;
            if (site === 'post') {
              expect(s.c.A!.answer).toBe(CAUSE[clock]);
              expect(s.p.committed).toEqual([]);
            } else if (site === 'queue' && clock === 'Wback') {
              // Native has no lower edge (signed limit). RC10 then sends nothing.
              expect(s.p.committed).toEqual(['A1']);
              const sent = run(live, [...to, label, 'reply:A:ack', 'dispatch:p1', 'write:p1:ok']);
              expect(sent.p.bytes).toEqual({});
              expect(sent.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
            } else if (site === 'queue') {
              expect(s.p.committed).toEqual([]);
              expect(run(live, [...to, label, 'reply:A:ack']).c.A!.answer).toBe(CAUSE[clock]);
            } else {
              expect(s.p.bytes).toEqual({});
              expect(s.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
              const step = steps(live, T, run(live, to)).find((x) => x.label === label);
              expect(step?.decided).toBe(CAUSE[clock]);
            }
          }
        expect(cases).toBe(positionsAt(site).length * eventsAt(site).length);
      }
    );

    it.each(SITES)(
      '$site: a sample before a fact read fails O.sample after every read',
      ({ site, to, effect }) => {
        const early = { ...T, clockSample: { ...T.clockSample, [site]: 'before-reads' } };
        const at = run(live, to);
        for (const read of positionsAt(site))
          for (const clock of eventsAt(site)) {
            const step = steps(live, early, at).find(
              (x) => x.label === `${effect}~${read}:${clock}`
            );
            // A refusal is a decision too. An elapsed Ts before the P14 read sends nothing, but
            // the early sample answers the audience for the startup deadline.
            expect(step?.violations.map((v) => v.name)).toContain('O.sample');
          }
        // Without a clock event inside the gather, the early sample equals the raw clock.
        const plain = steps(live, early, at).find((x) => x.label === effect);
        expect(plain?.violations).toEqual([]);
      }
    );

    describe('RC8 compares the slot inside the deciding update (AMEND 1)', () => {
      const afterReads: ReplacementCloseTable = {
        ...T,
        clockSample: { ...T.clockSample, queue: 'after-reads' },
      };

      it.each(['Tc', 'Ts', 'Ta', 'Ti'] as const)(
        'a Native sample of 99 after the reads, then %s at 100 before the update: zero rows',
        (clock) => {
          const label = `queue:A~sample:${clock}`;
          const s = run(live, [...TO_POST, label]);
          expect(s.p.committed).toEqual([]);
          expect(s.h.cell).toBe('idle');
          // The ACK maps the deadline refusal to the posted limiting clock.
          const answered = run(live, [...TO_POST, label, 'reply:A:ack']);
          expect(answered.c.A!.answer).toBe(CAUSE[clock]);
          expect(answered.p.bytes).toEqual({});
          // A compare outside the update permits the row on the stale sample.
          const step = steps(live, afterReads, run(live, TO_POST)).find((x) => x.label === label);
          expect(step?.next.p.committed).toEqual(['A1']);
          expect(step?.violations.map((v) => v.name)).toEqual(
            expect.arrayContaining(['O.queue', 'O.sample'])
          );
        }
      );

      it('a wall step back at the update keeps the signed Native limit: commit, then zero bytes', () => {
        const label = 'queue:A~sample:Wback';
        const s = run(live, [...TO_POST, label]);
        expect(s.p.committed).toEqual(['A1']);
        const sent = run(live, [...TO_POST, label, 'reply:A:ack', 'dispatch:p1', 'write:p1:ok']);
        expect(sent.p.bytes).toEqual({});
        expect(sent.p.unsent).toEqual(['A1']);
        expect(sent.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
      });
    });

    describe('R reads its own clock (AMEND 2)', () => {
      const rFirstPost = {
        ...T,
        post: (p: PostPremises) =>
          p.pendingOwner && p.request !== true ? 'request' : decidePost(p),
      } as ReplacementCloseTable;
      const rFirstBytes = {
        ...T,
        firstBytes: (p: ClosePremises) =>
          p.connection && p.pendingOwner && p.request !== true
            ? ({ kind: 'refuse', cause: 'request' } as const)
            : decideFirstBytes(p),
      } as ReplacementCloseTable;
      const SIDES = [
        ['Ta', 'before R', 'Ta'],
        ['Ta', 'after R', 'R'],
        ['Ti', 'before R', 'Ta'],
        ['Ti', 'after R', 'R'],
      ] as const;

      it.each(SIDES)(
        'RC7: %s passes %s; the answer is authority-expired with zero frames',
        (clock, _side, read) => {
          const label = `post:A~${read}:${clock}`;
          const s = run(live, [...TO_POST.slice(0, -1), label]);
          expect(s.c.A!.answer).toBe('authority-expired');
          expect(s.c.A!.phase).toBe('refused');
          expect(s.p.committed).toEqual([]);
          const step = steps(live, rFirstPost, run(live, TO_POST.slice(0, -1))).find(
            (x) => x.label === label
          );
          if (read === 'Ta') {
            // The R reader saw the elapsed credential: R before the clocks answers request.
            expect(step?.next.c.A?.answer).toBe('request');
            expect(step?.violations.map((v) => v.name)).toContain('O.cause');
          } else expect(step?.violations).toEqual([]);
        }
      );

      it.each(SIDES)(
        'RC10: %s passes %s; zero bytes and the exact unsent settlement as authority-expired',
        (clock, _side, read) => {
          const to = [...TO_QUEUED, 'dispatch:p1'];
          const label = `write:p1:ok~${read}:${clock}`;
          const s = run(live, [...to, label]);
          expect(s.p.bytes).toEqual({});
          expect(s.p.unsent).toEqual(['A1']);
          expect(s.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
          const at = run(live, to);
          expect(steps(live, T, at).find((x) => x.label === label)?.decided).toBe(
            'authority-expired'
          );
          const step = steps(live, rFirstBytes, at).find((x) => x.label === label);
          if (read === 'Ta') {
            expect(step?.decided).toBe('request');
            expect(step?.violations.map((v) => v.name)).toContain('O.cause');
          } else expect(step?.violations).toEqual([]);
        }
      );

      it('a live-clock revocation still answers request at RC7 and RC10 (control)', () => {
        const revoked = run(live, [...TO_POST.slice(0, 5), 'env:R', 'hold:A', 'post:A']);
        expect(revoked.c.A!.answer).toBe('request');
        expect(revoked.p.committed).toEqual([]);
        const at = run(live, [...TO_QUEUED, 'env:R', 'dispatch:p1']);
        const step = steps(live, T, at).find((x) => x.label === 'write:p1:ok');
        expect(step?.decided).toBe('request');
        expect(step?.violations).toEqual([]);
        expect(step?.next.p.bytes).toEqual({});
      });
    });
  });

  describe('directed schedules', () => {
    const live = WORLDS.live;

    it.each([
      ['Ta', 'authority-expired'],
      ['Ti', 'authority-expired'],
      ['Ts', 'startup-deadline'],
      ['Tc', 'close-allowance'],
    ] as const)(
      '%s alone before RC8 answers %s with zero queued rows and zero bytes',
      (clock, cause) => {
        const s = run(live, [...TO_POST, `env:${clock}`, 'queue:A', 'reply:A:ack']);
        expect(s.c.A!.answer).toBe(cause);
        expect(s.p.committed).toEqual([]);
        expect(s.p.bytes).toEqual({});
      }
    );

    it.each(['Ta', 'Ti', 'Ts', 'Tc'] as const)('%s alone after RC8 gives zero bytes', (clock) => {
      const s = run(live, [...TO_QUEUED, `env:${clock}`, 'dispatch:p1', 'write:p1:ok']);
      expect(s.p.committed).toEqual(['A1']);
      expect(s.p.bytes).toEqual({});
      expect(s.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
    });

    it('the monotonic Tc refuses at RC7 and RC10 while the wall Tc is live', () => {
      const atPost = run(live, [...TO_POST.slice(0, -1), 'env:TcMono', 'post:A']);
      expect(atPost.c.A!.answer).toBe('close-allowance');
      expect(atPost.p.committed).toEqual([]);
      // Native compares only the wall slot, so the queue commits; RC10 sends nothing.
      const atBytes = run(live, [
        ...TO_POST,
        'env:TcMono',
        'queue:A',
        'reply:A:ack',
        'dispatch:p1',
        'write:p1:ok',
      ]);
      expect(atBytes.p.committed).toEqual(['A1']);
      expect(atBytes.p.bytes).toEqual({});
      expect(atBytes.clock.passed).toEqual([]);
    });

    it('V1-P S2-r1 101 -> 99: an acknowledged deadline refusal keeps the posted limiting clock', () => {
      const deadlines = { Ta: 100, Ts: 200, Tc: 300 } as const;
      const posted = slotClock(deadlines, T.deadlineSlot);
      expect(posted).toBe('Ta');
      const slot = Math.min(...T.deadlineSlot.map((clock) => deadlines[clock]));
      expect(slot).toBe(100);
      const harness: HarnessFacts = {
        life: 'open',
        drain: 'draining',
        revision: 1,
        operation: null,
        cell: 'idle',
        key: null,
        sequence: null,
        result: null,
        nextSequence: 0,
        claimGeneration: 'gA1',
      };
      // Native refuses the existing slot at wall 101.
      expect(
        T.queue({
          harness,
          claimRevision: 1,
          key: { binding: 'A', key: 'A1', sequence: 0 },
          slotExpired: slot <= 101,
          storage: true,
          sandbox: OPEN_SANDBOX,
        })
      ).toBe('deadline');
      // The wall steps back to 99 before Main reads the ACK.
      const atReply: ClosePremises = {
        pendingOwner: true,
        request: true,
        audience: { thread: true, policy: true },
        idleReceipt: true,
        storage: true,
        placement: { harness: 'open', sandbox: OPEN_SANDBOX },
        connection: true,
        deadlines,
        admitted: 50,
        now: 99,
        closeMonotonicExpired: false,
      };
      expect(T.slotCause(posted)).toBe('authority-expired');
      // The S2-r1 mapper read the wall again and fell back to Tc.
      expect(T.slotCause(limitingClock(atReply))).toBe('close-allowance');
      // The same order in the model: Ta passes, Native refuses, the wall steps back, Main answers.
      const s = run(live, [...TO_POST, 'env:Ta', 'queue:A', 'env:Wback', 'reply:A:ack']);
      expect(s.clock.back).toBe(true);
      expect(s.c.A!.answer).toBe('authority-expired');
      expect(s.p.committed).toEqual([]);
      expect(s.p.bytes).toEqual({});
    });

    const TO_HOLD = TO_POST.slice(0, -1);
    const TO_PUB = TO_POST.slice(0, -2);

    it('A8-1: a wall sample before the enqueue instant refuses at RC7 and at RC10', () => {
      const atPost = run(live, [...TO_HOLD, 'env:Wback', 'post:A']);
      expect(atPost.c.A!.answer).toBe('close-allowance');
      expect(atPost.p.committed).toEqual([]);
      // The step back hides an elapsed Ta. Main reads no deadline and answers the lower Tc edge.
      const hidden = run(live, [...TO_HOLD, 'env:Ta', 'env:Wback', 'post:A']);
      expect(hidden.c.A!.answer).toBe('close-allowance');
      expect(hidden.p.committed).toEqual([]);
      // After the queue commit: zero bytes and the exact unsent settlement.
      const atBytes = run(live, [...TO_QUEUED, 'env:Wback', 'dispatch:p1', 'write:p1:ok']);
      expect(atBytes.p.committed).toEqual(['A1']);
      expect(atBytes.p.bytes).toEqual({});
      expect(atBytes.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
      // Native has no lower edge: a step back before RC8 commits, and RC10 sends nothing.
      const wait = run(live, [
        ...TO_POST,
        'env:Wback',
        'queue:A',
        'reply:A:ack',
        'dispatch:p1',
        'write:p1:ok',
      ]);
      expect(wait.p.committed).toEqual(['A1']);
      expect(wait.p.bytes).toEqual({});
    });

    it('A8-2: an expired Ts answers its own cause before P14; a live-clock audience denial keeps P14', () => {
      const ts = run(live, [...TO_HOLD, 'env:Ts', 'post:A']);
      expect(ts.c.A!.answer).toBe('startup-deadline');
      expect(ts.p.committed).toEqual([]);
      const audience = run(live, [...TO_PUB, 'env:thread', 'hold:A', 'post:A']);
      expect(audience.c.A!.answer).toBe('audience');
      expect(audience.p.committed).toEqual([]);
      expect(audience.clock.passed).toEqual([]);
    });

    it('F-e: the policy swap waits for the Core hold, in both orders', () => {
      // The swap wins before RC7: the original P14 refusal, zero rows and zero bytes.
      const first = run(live, [...TO_PUB, 'env:policy', 'install:policy', 'hold:A', 'post:A']);
      expect(first.c.A!.answer).toBe('audience');
      expect(first.p.committed).toEqual([]);
      // The ACK lands before the hold; the swap waits through the queue reply.
      const acked = [...TO_PUB, 'env:policy', 'hold:A', 'post:A', 'queue:A'];
      expect(enabled(live, run(live, acked))).not.toContain('install:policy');
      const late = run(live, [
        ...acked,
        'reply:A:ack',
        'install:policy',
        'dispatch:p1',
        'write:p1:ok',
      ]);
      expect(late.p.committed).toEqual(['A1']);
      expect(late.p.bytes).toEqual({});
      expect(late.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
    });

    it('F-c: Ta is the earliest cutoff over every required credential', () => {
      expect(
        T.authorityDeadline([
          { credential: 'session', at: 500 },
          { credential: 'projected-admin', at: 300 },
          { credential: 'issuer', at: 200 },
          { credential: 'admin-only', at: 400 },
        ])
      ).toBe(200);
      expect(T.authorityDeadline([])).toBe(Number.POSITIVE_INFINITY);
      // An issuer cutoff passes in the Native wait while the presented credential stays live.
      const wait = run(live, [...TO_POST, 'env:Ti', 'queue:A', 'env:Wback', 'reply:A:ack']);
      expect(wait.c.A!.answer).toBe('authority-expired');
      expect(wait.p.committed).toEqual([]);
      expect(wait.p.bytes).toEqual({});
    });

    it('a Sandbox drain before RC8 gives zero rows; after the queue, zero bytes; the drain stays', () => {
      const before = run(live, [...TO_POST, 'env:sbdrain', 'queue:A', 'reply:A:ack']);
      expect(before.c.A!.answer).toBe('placement');
      expect(before.p.committed).toEqual([]);
      expect(before.sb.accepting).toBe(false);
      const after = run(live, [
        ...TO_QUEUED,
        'env:sbdrain',
        'dispatch:p1',
        'write:p1:ok',
        'nsettle:A1',
        'restore:A',
      ]);
      expect(after.p.bytes).toEqual({});
      expect(after.sb.accepting).toBe(false);
      expect(after.h.drain).toBe('draining');
    });

    it('the pins hold until the queue reply; the Core writer then advances (G8) and RC10 refuses', () => {
      const pins = WORLDS.pins;
      const held = run(pins, [...TO_POST, 'queue:A']);
      expect(held.c.A!.phase).toBe('replying');
      expect(enabled(pins, held)).not.toContain('env:core');
      expect(enabled(pins, held)).not.toContain('env:thread');
      const replied = run(pins, [...TO_QUEUED, 'env:core', 'dispatch:p1', 'write:p1:ok']);
      expect(replied.p.bytes).toEqual({});
      const audience = run(pins, [...TO_QUEUED, 'env:thread', 'dispatch:p1', 'write:p1:ok']);
      expect(audience.p.bytes).toEqual({});
    });

    it('a stopped producer releases the pins; a commit with a pending reply does not', () => {
      const pending = run(live, [...TO_POST, 'queue:A']);
      const labels = enabled(live, pending);
      for (const writer of ['env:core', 'env:thread', 'env:R', 'env:idle'])
        expect(labels).not.toContain(writer);
      // F-e: the publisher ACK runs while the close holds the Core hold; the swap waits.
      expect(labels).toContain('env:policy');
      expect(enabled(live, run(live, [...TO_POST, 'queue:A', 'env:policy']))).not.toContain(
        'install:policy'
      );
      expect(labels.filter((l) => l.startsWith('cold:'))).toEqual([]);
      const stopped = run(live, [...TO_POST, 'queue:A', 'env:crash']);
      const after = enabled(live, stopped);
      expect(after).toContain('env:core');
      expect(after).toContain('cold:expire-key');
    });
  });

  describe('G3: the claim generation (S3b-m, V1-P generation witness)', () => {
    const noCompare = { ...T, restore: restoreWithout('generation') };
    const ROLLBACK = ['env:R', 'hold:A', 'post:A'];
    const COMPLETION = [
      'hold:A',
      'post:A',
      'queue:A',
      'reply:A:ack',
      'dispatch:p1',
      'write:p1:ok',
      'result:A1',
      'nsettle:A1',
      'restore:A',
    ];
    const B_CLAIMS = ['admit:B', 'ws:B', 'claim:B'];
    /** The duplicate changes no row; B keeps its claim and its own generation. */
    const expectZeroRows = (world: World, labels: readonly string[], frame: string) => {
      const before = run(world, labels);
      const after = run(world, [...labels, frame]);
      expect(after.h).toEqual(before.h);
      expect(after.h.drain).toBe('draining');
      expect(after.h.claimGeneration).toBe(after.c.B!.claimGen);
      expect(after.c.B!.claimGen).toBe('gB1');
      expect(after.occ).toBe(after.p.occ0 - after.p.succ);
      expect(after.p.owed).toBe(0);
      // Removing the compare reopens B.
      const step = steps(world, noCompare, before).find((x) => x.label === frame);
      expect(step?.next.h.drain).toBe('accepting');
      expect(step?.violations.map((v) => v.name)).toEqual(
        expect.arrayContaining(['O.restore.dup', 'O.restore.live-latch'])
      );
    };

    it('99 settlement after the rollback: B claims at the revision of A in flight; zero rows', () => {
      const labels = [...ROLLBACK, 'env:open@99', ...B_CLAIMS];
      const at = run(WORLDS.reuse99, labels);
      expect(at.c.A!.answer).toBe('request');
      // The recurrence: B's claim revision is the revision of A's claim-arm frame.
      expect(at.dup).toEqual([
        { frame: { arm: 'claim', revision: 1, generation: 'gA1' }, by: 'A' },
      ]);
      expect(at.h.revision).toBe(1);
      expectZeroRows(WORLDS.reuse99, labels, 'redeliver:A:claim');
    });

    it('no-sequence binding open at 99 after the completion: the close key matches too; zero rows', () => {
      const labels = [...COMPLETION, 'env:bind@99', ...B_CLAIMS];
      const at = run(WORLDS.reuseBind, labels);
      // Revision, close key, settled cell and operation all equal A's close-arm frame.
      expect(at.dup).toEqual([
        { frame: { arm: 'close', key: 'A1', revision: 3, generation: 'gA1' }, by: 'A' },
      ]);
      expect(at.h).toMatchObject({
        revision: 3,
        key: 'A1',
        cell: 'settled',
        operation: 'session.close',
      });
      expectZeroRows(WORLDS.reuseBind, labels, 'redeliver:A:close');
    });

    it('same-name recreation at 99: zero rows', () => {
      const labels = [...ROLLBACK, 'env:recreate', ...B_CLAIMS];
      expect(run(WORLDS.reuseRecreate, labels).h.revision).toBe(1);
      expectZeroRows(WORLDS.reuseRecreate, labels, 'redeliver:A:claim');
    });

    it('the paused cold restore: k1 releases A, then 99 and B claim before k2; zero rows', () => {
      const w = WORLDS.pausedReuse;
      const labels = ['cold-read:k1', 'cold-read:k2', 'cold-post:k1', 'env:open@99', ...B_CLAIMS];
      const before = run(w, labels);
      expect(before.cold.k2).toEqual({ arm: 'claim', revision: 1, generation: 'gA1' });
      expect(before.h.revision).toBe(1);
      const after = run(w, [...labels, 'cold-post:k2']);
      expect(after.h).toEqual(before.h);
      expect(after.h.claimGeneration).toBe('gB1');
      const step = steps(w, noCompare, before).find((x) => x.label === 'cold-post:k2');
      expect(step?.violations.map((v) => v.name)).toContain('O.restore.live-latch');
    });

    it('an independent drain after the 99 settlement: zero rows, and the drain stays', () => {
      const labels = [...ROLLBACK, 'env:open@99', 'env:hdrain'];
      const before = run(WORLDS.reuseHdrain, labels);
      expect(before.h).toMatchObject({ drain: 'draining', claimGeneration: null, revision: 1 });
      const after = run(WORLDS.reuseHdrain, [...labels, 'redeliver:A:claim']);
      expect(after.h).toEqual(before.h);
    });

    it('the opposite order: A releases once, its duplicate changes zero rows, then B claims', () => {
      const released = run(WORLDS.reuse99, ROLLBACK);
      expect(released.h.drain).toBe('accepting');
      const duplicate = run(WORLDS.reuse99, [...ROLLBACK, 'redeliver:A:claim']);
      expect(duplicate.h).toEqual(released.h);
      expect(duplicate.p.owed).toBe(0);
      const claimed = run(WORLDS.reuse99, [...ROLLBACK, 'redeliver:A:claim', ...B_CLAIMS]);
      expect(claimed.h).toMatchObject({ drain: 'draining', claimGeneration: 'gB1' });
    });

    it('the 101 settlement control: the revision alone refuses the duplicate', () => {
      const report = explore(WORLDS.reuse101, noCompare);
      expect(report.truncated).toBe(false);
      expect(Object.keys(report.traces).filter(SAFETY)).toEqual([]);
    });

    it('each reuse world reaches B holding its own generation after a duplicate arrived', () => {
      for (const w of [
        WORLDS.reuse99,
        WORLDS.reuseBind,
        WORLDS.reuseRecreate,
        WORLDS.reuseHdrain,
        WORLDS.reuseClaim99,
      ])
        expect(reportOf(w).probes['own-generation']?.states ?? 0).toBeGreaterThan(0);
    });

    it('RC8 equal stamp: a drain at the claim instant leaves zero queued rows and keeps the drain (S3b-m-r2)', () => {
      const w = WORLDS.equalStamp;
      const prepared = run(w, [
        'admit:A',
        'ws:A',
        'claim:A',
        'env:hdrain@claim',
        'raw:A',
        'pub:A',
        'hold:A',
        'post:A',
      ]);
      // The drain settled at A's own stamp, cleared G3 and advanced the sequence before the hold.
      expect(prepared.h).toMatchObject({
        revision: prepared.c.A!.claimRev,
        claimGeneration: null,
        drain: 'draining',
        operation: 'harness.drain',
      });
      expect(prepared.c.A!.seq).toBe(prepared.h.nextSequence);
      const refused = run(w, [
        'admit:A',
        'ws:A',
        'claim:A',
        'env:hdrain@claim',
        'raw:A',
        'pub:A',
        'hold:A',
        'post:A',
        'queue:A',
        'reply:A:ack',
      ]);
      expect(refused.c.A).toMatchObject({ phase: 'refused', cause: 'latch' });
      expect(refused.p.committed).toEqual([]);
      expect(refused.h).toEqual(prepared.h);
      expect(refused.p.drainBy).toEqual(['claim:A', 'hdrain']);
      // No restore ran, so no capacity release was requested.
      expect(refused.p.owed).toBe(0);
      expect(reportOf(w).probes['equal-stamp-latch']?.states ?? 0).toBeGreaterThan(0);
      // Removing only the generation compare commits A's key.
      const noGeneration = {
        ...T,
        queue: (input: Parameters<ReplacementCloseTable['queue']>[0]) =>
          T.queue({ ...input, claimGeneration: undefined }),
      };
      const step = steps(w, noGeneration, prepared).find((x) => x.label === 'queue:A');
      expect(step?.next.p.committed).toEqual(['A1']);
      expect(step?.violations.map((v) => v.name)).toContain('O.queue');
    });

    it('RC8 101 control: a drain with a later stamp refuses with latch on the revision alone', () => {
      const w: World = { ...WORLDS.equalStamp, name: 'stamp-101', env: ['hdrain'] };
      const labels = ['admit:A', 'ws:A', 'claim:A', 'env:hdrain', 'raw:A', 'pub:A', 'hold:A'];
      const refused = run(w, [...labels, 'post:A', 'queue:A', 'reply:A:ack']);
      expect(refused.c.A).toMatchObject({ phase: 'refused', cause: 'latch' });
      expect(refused.p.committed).toEqual([]);
      const noGeneration = {
        ...T,
        queue: (input: Parameters<ReplacementCloseTable['queue']>[0]) =>
          T.queue({ ...input, claimGeneration: undefined }),
      };
      const posted = run(w, [...labels, 'post:A']);
      const step = steps(w, noGeneration, posted).find((x) => x.label === 'queue:A');
      expect(step?.next.c.A?.decision).toBe('latch');
      expect(step?.next.p.committed).toEqual([]);
    });

    it('a successful release clears the generation on the written row (S3b-m-r2)', () => {
      const w = WORLDS.live;
      const before = run(w, [...TO_POST.slice(0, -2), 'env:R', 'hold:A']);
      expect(before.h).toMatchObject({ drain: 'draining', claimGeneration: before.c.A!.claimGen });
      expect(before.c.A!.claimGen).not.toBeNull();
      const rolled = run(w, [...TO_POST.slice(0, -2), 'env:R', 'hold:A', 'post:A']);
      expect(rolled.c.A).toMatchObject({ phase: 'refused', cause: 'request' });
      expect(rolled.h).toMatchObject({ drain: 'accepting', claimGeneration: null });
      // A restore that accepts but keeps the generation fails the direct check.
      const keeps = {
        ...T,
        restoreRow: (h: HarnessFacts) => ({ ...h, drain: 'accepting' as const }),
      };
      const step = steps(w, keeps, before).find((x) => x.label === 'post:A');
      expect(step?.next.h.claimGeneration).toBe(before.c.A!.claimGen);
      expect(step?.violations.map((v) => v.name)).toContain('O.restore.clear');
    });

    it.each(SUBSUMED)(
      'G3 stops the single take-out of $id ($takeOut)',
      (row) => {
        const report = explore(row.world, tableOf(row));
        expect(report.truncated).toBe(false);
        expect(Object.keys(report.traces)).not.toContain(row.oracle);
      },
      600_000
    );
  });

  describe('H4: three bounded schedules (S3b-m, V1-P first-principles review)', () => {
    it('H4-1 RC10: P14 reads live, R sees Ta pass, the wall steps back before the bytes', () => {
      const w = WORLDS.h4gather;
      const to = [...TO_QUEUED, 'dispatch:p1'];
      const label = 'write:p1:ok~audience:Ta~R:Wpart';
      const at = run(w, to);
      const step = steps(w, T, at).find((x) => x.label === label);
      expect(step?.decided).toBe('authority-expired');
      expect(step?.violations).toEqual([]);
      expect(step?.next.p.bytes).toEqual({});
      expect(step?.next.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
      // The sample itself shows Ta live: only the carried R expiry decides the cause.
      expect(step?.next.clock).toMatchObject({ passed: ['Ta'], part: true });
      const boolean = {
        ...T,
        firstBytes: (p: ClosePremises) => decideFirstBytes({ ...p, request: p.request === true }),
      };
      const old = steps(w, boolean, at).find((x) => x.label === label);
      expect(old?.decided).toBe('request');
      expect(old?.violations.map((v) => v.name)).toContain('O.cause');
    });

    it('H4-1 RC7: the same two moves in the posting turn answer authority-expired with zero frames', () => {
      const s = run(WORLDS.h4gather, [...TO_POST.slice(0, -1), 'post:A~audience:Ta~R:Wpart']);
      expect(s.c.A!.answer).toBe('authority-expired');
      expect(s.p.committed).toEqual([]);
    });

    it('H4-1: a Ts pass that the P14 owner saw before the step back answers startup-deadline', () => {
      const w = WORLDS.h4gather;
      const at = run(w, [...TO_QUEUED, 'dispatch:p1']);
      const step = steps(w, T, at).find((x) => x.label === 'write:p1:ok~drain:Ts~audience:Wpart');
      expect(step?.decided).toBe('startup-deadline');
      expect(step?.violations).toEqual([]);
    });

    describe('H4-1: a failed monotonic Tc is in the cause minimum (S3b-m-r2, V1-P FIX 2 item 2)', () => {
      // V1-P's schedule: admitted at 50 with Tc 90, Ta 100 and Ts 200. R saw 101 and carries the
      // expired Ta. The final wall sample reads 89.
      const premisesAt = (closeMonotonicExpired: boolean, now = 89): ClosePremises => ({
        pendingOwner: true,
        request: 'expired',
        audience: { thread: true, policy: true },
        idleReceipt: true,
        storage: true,
        placement: { harness: 'open', sandbox: OPEN_SANDBOX },
        connection: true,
        deadlines: { Tc: 90, Ts: 200, Ta: 100 },
        admitted: 50,
        now,
        closeMonotonicExpired,
      });
      const oldPost = { ...T, post: (p: PostPremises) => decidePost(monotonicOutOfMinimum(p)) };
      const oldFirstBytes = {
        ...T,
        firstBytes: (p: ClosePremises) => decideFirstBytes(monotonicOutOfMinimum(p)),
      };

      it('the pinned deciders answer close-allowance, and authority-expired with the monotonic Tc live', () => {
        expect(decidePost(premisesAt(true))).toBe('close-allowance');
        expect(decideFirstBytes(premisesAt(true))).toEqual({
          kind: 'refuse',
          cause: 'close-allowance',
        });
        expect(decidePost(premisesAt(false))).toBe('authority-expired');
        expect(decideFirstBytes(premisesAt(false))).toEqual({
          kind: 'refuse',
          cause: 'authority-expired',
        });
        // The S3b-m rule answered authority-expired with the monotonic Tc failed.
        expect(oldPost.post(premisesAt(true))).toBe('authority-expired');
        expect(oldFirstBytes.firstBytes(premisesAt(true))).toEqual({
          kind: 'refuse',
          cause: 'authority-expired',
        });
        // The pre-enqueue lower edge keeps the limiting clock rule.
        for (const mono of [true, false]) {
          expect(decidePost(premisesAt(mono, 49))).toBe('close-allowance');
          expect(decideFirstBytes(premisesAt(mono, 49))).toEqual({
            kind: 'refuse',
            cause: 'close-allowance',
          });
        }
      });

      it('RC7: the wall steps back below Tc and Ta; close-allowance with zero frames', () => {
        const w = WORLDS.h4mono;
        const label = 'post:A~audience:Ta~R:Wpart@0';
        const toHold = TO_POST.slice(0, -1);
        const failed = run(w, ['env:TcMono', 'env:Tc', ...toHold, label]);
        expect(failed.clock).toMatchObject({
          passed: ['Tc', 'Ta'],
          part: true,
          kept: 0,
          mono: true,
        });
        expect(failed.c.A).toMatchObject({ phase: 'refused', answer: 'close-allowance' });
        expect(failed.p.committed).toEqual([]);
        const live = run(w, ['env:Tc', ...toHold, label]);
        expect(live.c.A).toMatchObject({ phase: 'refused', answer: 'authority-expired' });
        expect(live.p.committed).toEqual([]);
        const old = steps(w, oldPost, run(w, ['env:TcMono', 'env:Tc', ...toHold])).find(
          (x) => x.label === label
        );
        expect(old?.next.c.A?.answer).toBe('authority-expired');
        expect(old?.violations.map((v) => v.name)).toContain('O.cause');
      });

      it('RC10: close-allowance with zero bytes and the exact unsent settlement', () => {
        const w = WORLDS.h4mono;
        const label = 'write:p1:ok~audience:Ta~R:Wpart@0';
        const at = run(w, [...TO_QUEUED, 'env:TcMono', 'env:Tc', 'dispatch:p1']);
        const step = steps(w, T, at).find((x) => x.label === label);
        expect(step?.decided).toBe('close-allowance');
        expect(step?.violations).toEqual([]);
        expect(step?.next.p.bytes).toEqual({});
        expect(step?.next.p.unsent).toEqual(['A1']);
        expect(step?.next.core.A).toEqual({ key: 'A1', result: 'stale', revision: null });
        const liveAt = run(w, [...TO_QUEUED, 'env:Tc', 'dispatch:p1']);
        const control = steps(w, T, liveAt).find((x) => x.label === label);
        expect(control?.decided).toBe('authority-expired');
        expect(control?.violations).toEqual([]);
        expect(control?.next.p.bytes).toEqual({});
        const old = steps(w, oldFirstBytes, at).find((x) => x.label === label);
        expect(old?.decided).toBe('authority-expired');
        expect(old?.violations.map((v) => v.name)).toContain('O.cause');
        expect(reportOf(w).probes['deep-step-back-tc']?.states ?? 0).toBeGreaterThan(0);
      });
    });

    it('H4-2: rotation after the ACK shortens the issuer grace; RC10 owes authority-expired', () => {
      const w = WORLDS.rotate;
      const at = run(w, [...TO_QUEUED, 'env:rotate', 'env:Ti', 'dispatch:p1']);
      const decide = (table: ReplacementCloseTable) =>
        steps(w, table, at).find((x) => x.label === 'write:p1:ok');
      const base = decide(T);
      expect(base?.decided).toBe('authority-expired');
      expect(base?.next.p.bytes).toEqual({});
      // Two independent readers of the same rotation. Each alone keeps the cause.
      const dropR = (p: ClosePremises) => decideFirstBytes({ ...p, request: p.request === true });
      expect(decide({ ...T, firstBytesAuthority: 'posted' })?.decided).toBe('authority-expired');
      expect(decide({ ...T, firstBytes: dropR })?.decided).toBe('authority-expired');
      const both = decide({ ...T, firstBytesAuthority: 'posted', firstBytes: dropR });
      expect(both?.decided).toBe('request');
      expect(both?.violations.map((v) => v.name)).toContain('O.cause');
      expect(reportOf(w).probes['rotated-grace']?.states ?? 0).toBeGreaterThan(0);
    });

    it('H4-3: Native exits after its commit; Main keeps its exclusion and reads the key back', () => {
      const w = WORLDS.wcrash;
      const exited = run(w, [...TO_POST, 'queue:A', 'env:wcrash']);
      expect(exited.c.A).toMatchObject({ phase: 'unknown-reply', slot: true });
      expect(exited.excl).toBe('A');
      expect(exited.p.committed).toEqual(['A1']);
      // The channel failure alone releases nothing: the only exits are the readback and the bound.
      expect(enabled(w, exited).filter((l) => l.endsWith(':A') && !l.startsWith('env:'))).toEqual([
        'readback:A',
      ]);
      const back = run(w, [...TO_POST, 'queue:A', 'env:wcrash', 'readback:A']);
      expect(back.c.A!.phase).toBe('queued');
      const done = run(w, [
        ...TO_POST,
        'queue:A',
        'env:wcrash',
        'readback:A',
        'dispatch:p1',
        'write:p1:ok',
        'result:A1',
        'nsettle:A1',
        'restore:A',
      ]);
      expect(done.c.A!.phase).toBe('done');
      expect(done.p.committed).toEqual(['A1']);
      const step = steps(w, { ...T, lostReply: 'noncommit' }, exited).find(
        (x) => x.label === 'readback:A'
      );
      expect(step?.violations.map((v) => v.name)).toContain('O.noncommit');
      expect(reportOf(w).probes['worker-exit-readback']?.states ?? 0).toBeGreaterThan(0);
    });
  });

  it.each(M)(
    '$id fails $oracle when the table takes out: $takeOut',
    (row) => {
      const report = explore(row.world, tableOf(row), { stopOn: row.oracle });
      keep(row.id, { oracle: row.oracle, trace: report.traces[row.oracle], states: report.states });
      expect(Object.keys(report.traces)).toContain(row.oracle);
      if (row.via)
        expect(
          report.traces[row.oracle]!.filter((label) => isViaEdge(label, row.via!))
        ).not.toEqual([]);
    },
    600_000
  );
});
