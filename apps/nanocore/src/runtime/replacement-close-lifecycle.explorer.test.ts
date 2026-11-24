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
  composeCold,
  type HarnessFacts,
  limitingClock,
  REPLACEMENT_CLOSE_TABLE,
  type ReplacementCloseTable,
  restorable,
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

type Env =
  | CloseClock
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
  | 'replay';

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
   * wall clock stepped back before every passed deadline, which keep their order. The monotonic Tc
   * and the caller bound W are separate.
   */
  clock: { passed: CloseClock[]; back: boolean; mono: boolean; W: boolean };
  cold: Record<string, number | null>;
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
  readonly splitCold?: readonly string[];
  /** Older writers before the crash: c1 claims leave the revision; r2 claims advance it. */
  readonly legacy?: 'c1' | 'r2';
  /** Phases that the live closers may reach. Undefined: all. */
  readonly stopAt?: Phase;
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
    clock: { passed: [], back: false, mono: false, W: false },
    cold: Object.fromEntries((world.splitCold ?? []).map((k) => [k, null])),
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
    },
  };
  world.init?.(s);
  return s;
}

const clone = (s: State): State => JSON.parse(JSON.stringify(s)) as State;
const keyOf = (b: string, c: Closer) => `${b}${c.gen}`;
const ownerOfKey = (key: string) => key.slice(0, 1);

/** The older claim, for data roots that older writers produced. */
function legacyTable(t: ReplacementCloseTable, kind: 'c1' | 'r2'): ReplacementCloseTable {
  return {
    ...t,
    admit: () => null,
    claim: (h) => ({ revision: kind === 'r2' ? h.revision + 1 : h.revision }),
  };
}

type Violation = { readonly name: string; readonly detail: string };

interface Ctx {
  readonly world: World;
  readonly table: ReplacementCloseTable;
  readonly violations: Violation[];
}

const violate = (ctx: Ctx, name: string, detail: string) => ctx.violations.push({ name, detail });

const liveTable = (ctx: Ctx, s: State) =>
  s.after || !ctx.world.legacy ? ctx.table : legacyTable(ctx.table, ctx.world.legacy);

const LIVE_DEADLINE = 1_000_000;
const deadlineOf = (s: State, clock: CloseClock) => {
  const at = s.clock.passed.indexOf(clock);
  return at < 0 ? LIVE_DEADLINE : at + 1;
};
const wallNow = (s: State) => (s.clock.back ? 0 : s.clock.passed.length);
const wallPassed = (s: State, clock: CloseClock) => deadlineOf(s, clock) <= wallNow(s);

function premises(s: State, pendingOwner: boolean): ClosePremises {
  return {
    pendingOwner,
    request: s.prem.R,
    audience: { thread: s.prem.thread, policy: s.prem.policy },
    idleReceipt: s.prem.idle,
    storage: s.prem.S,
    placement: { harness: s.h.life, sandbox: sandboxFacts(s) },
    connection: s.prem.X,
    deadlines: { Tc: deadlineOf(s, 'Tc'), Ts: deadlineOf(s, 'Ts'), Ta: deadlineOf(s, 'Ta') },
    now: wallNow(s),
    closeMonotonicExpired: s.clock.mono,
  };
}

/** Oracle facts, read from the raw state only. */
const rawPlacement = (s: State) =>
  s.h.life === 'open' && s.sb.accepting && s.sb.clean && s.sb.currentEpoch;
const ORACLE_CLOCK_CAUSE: Readonly<Record<CloseClock, CloseCause>> = {
  Tc: 'close-allowance',
  Ts: 'startup-deadline',
  Ta: 'authority-expired',
};
const CLOCK_CAUSES: readonly CloseCause[] = [
  'close-allowance',
  'startup-deadline',
  'authority-expired',
  'deadline',
];
/** The first wall deadline that passed; otherwise only the monotonic Tc can have failed. */
const expectedClockCause = (s: State) => ORACLE_CLOCK_CAUSE[s.clock.passed[0] ?? 'Tc'];

/** Applies one Native restore and checks it against the raw drain provenance. */
function applyRestore(
  ctx: Ctx,
  s: State,
  t: ReplacementCloseTable,
  revision: number,
  restorer: string | null,
  site: 'rollback' | 'completion'
): void {
  const changed = t.restore(s.h, sandboxFacts(s), revision);
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
    s.h = { ...s.h, drain: 'accepting' };
    s.p.drainBy = [];
    s.occ -= t.restoreDecrement;
    s.p.owed += 1;
  }
  if (t.e7({ changed, site })) {
    if (s.p.owed === 0) violate(ctx, 'O.e7', 'E7 requested after a no-op restore');
    else s.p.owed -= 1;
  }
}

/** A definite live refusal before any queue commit. */
function liveRefuse(ctx: Ctx, s: State, b: string, cause: CloseCause): void {
  const c = s.c[b]!;
  const t = liveTable(ctx, s);
  c.coreHold = false;
  c.wsHold = false;
  if (t.liveRefusalLatch === 'restore' && c.claimRev !== null)
    applyRestore(ctx, s, t, c.claimRev, b, 'rollback');
  if (
    s.p.drainBy.includes(`claim:${b}`) &&
    c.claimRev !== null &&
    s.h.revision === c.claimRev &&
    restorable(s.h, sandboxFacts(s))
  )
    violate(ctx, 'O.live-rollback', `${b} refused live and kept its latch`);
  if (t.definiteRefusal === 'release') {
    c.slot = false;
    if (s.excl === b) s.excl = null;
  }
  c.cause = cause;
  c.answer = t.carryCause(cause, 'capacity');
  // A clock refusal answers the original limiting clock; every other refusal keeps its cause.
  const expected = CLOCK_CAUSES.includes(cause) ? expectedClockCause(s) : cause;
  if (c.answer !== expected) violate(ctx, 'O.cause', `${b} answered ${c.answer} for ${expected}`);
  c.phase = 'refused';
}

function setUnknown(s: State, from: 'queued' | 'dispatched'): void {
  s.h = {
    ...s.h,
    cell: 'unknown',
    life: 'failed',
    drain: 'draining',
    result: from === 'dispatched' ? 'unknown' : null,
    revision: s.h.revision + 1,
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
      applyRestore(ctx, s, t, a.revision, null, 'completion');
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
}

function steps(world: World, table: ReplacementCloseTable, s: State): Step[] {
  const out: Step[] = [];
  const add = (label: string, env: boolean, f: (n: State, ctx: Ctx) => boolean | undefined) => {
    const n = clone(s);
    const ctx: Ctx = { world, table, violations: [] };
    if (f(n, ctx) === false) return;
    out.push({ label, env, next: n, violations: ctx.violations });
  };
  const coreHeld = Object.values(s.c).some((c) => c.coreHold);
  const wsHeld = Object.values(s.c).some((c) => c.wsHold);
  const midFlight = Object.values(s.c).some((c) => ACTIVE.includes(c.phase));
  const reach = (p: Phase) =>
    world.stopAt === undefined ||
    ([...ACTIVE, 'done'] as Phase[]).indexOf(p) <=
      ([...ACTIVE, 'done'] as Phase[]).indexOf(world.stopAt);

  for (const b of world.closers) {
    const c = s.c[b]!;
    const t = s.after || !world.legacy ? table : legacyTable(table, world.legacy);
    if (
      (c.phase === 'idle' || (world.retry && c.phase === 'refused')) &&
      s.present[b] &&
      s.cap[b] !== 'abandoned' &&
      s.cap[b] !== 'receipt' &&
      s.cap[b] !== 'claimed'
    )
      add(`admit:${b}`, false, (n, ctx) => {
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
        if (x.phase === 'refused') x.gen += 1;
        if (n.excl === null) n.excl = b;
        x.slot = true;
        x.answer = null;
        x.cause = null;
        x.claimRev = null;
        x.settleRev = null;
        x.phase = 'registered';
        void ctx;
      });
    if (c.phase === 'registered')
      add(`ws:${b}`, false, (n, ctx) => {
        for (const [o, y] of Object.entries(n.c))
          if (n.after && o !== b && ACTIVE.includes(y.phase) && y.slot)
            violate(ctx, 'O.ws-exclusive', `${b} claimed Workspace while ${o} holds the Harness`);
        n.cap[b] = 'claimed';
        n.c[b]!.phase = 'ws';
      });
    if (c.phase === 'ws' && reach('latched'))
      add(`claim:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const r = t.claim(n.h, sandboxFacts(n));
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
        n.h = { ...n.h, drain: 'draining', revision: r.revision };
        x.claimRev = r.revision;
        n.p.drainBy.push(`claim:${b}`);
        x.phase = 'latched';
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
      add(`post:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const cause = t.post(premises(n, n.prem.pend));
        if (cause) return liveRefuse(ctx, n, b, cause);
        const q = n.prem;
        const clocks = wallPassed(n, 'Tc') || wallPassed(n, 'Ta') || n.clock.mono;
        if (!(q.pend && q.R && q.thread && q.policy && q.idle) || clocks)
          violate(ctx, 'O.frame', `${b} posted with a failed premise`);
        if (t.holdUntil.core === 'post') x.coreHold = false;
        if (t.holdUntil.workspace === 'post') x.wsHold = false;
        x.phase = 'posted';
      });
    if (c.phase === 'posted' && reach('queued'))
      // RC8: the Native transaction decides. Its reply reaches Main in a separate step, and the
      // pins stay held until then.
      add(`queue:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const key = keyOf(b, x);
        const slotExpired = t.deadlineSlot.some((clock) => wallPassed(n, clock));
        const cause = t.queue({
          harness: n.h,
          claimRevision: x.claimRev,
          key: { binding: b, key, sequence: x.seq! },
          slotExpired,
          storage: n.prem.S,
          sandbox: sandboxFacts(n),
        });
        if (!cause) {
          const q = n.prem;
          const own = n.p.drainBy.length === 1 && n.p.drainBy[0] === `claim:${b}`;
          const clocks = wallPassed(n, 'Tc') || wallPassed(n, 'Ts') || wallPassed(n, 'Ta');
          if (clocks || !rawPlacement(n) || !(q.S && q.R && q.thread && q.policy && q.idle) || !own)
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
            const p = premises(n, n.prem.pend);
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
        applyRestore(ctx, n, t, x.settleRev!, b, 'completion');
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
          add(`write:${poll}:${variant}`, false, (n, ctx) => {
            n.polled.push(`${key}:${poll}`);
            const x = n.c[b];
            const pending =
              n.prem.pend &&
              x !== undefined &&
              keyOf(b, x) === key &&
              x.slot &&
              ['replying', 'queued', 'unknown-reply'].includes(x.phase);
            const d = t.firstBytes(premises(n, pending));
            if (d.kind === 'refuse') {
              n.p.unsent.push(key);
              n.core[b] = { key, result: 'stale', revision: null };
              n.settling.push(key);
              return;
            }
            const q = n.prem;
            const clocks = n.clock.passed.length > 0 || n.clock.mono;
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
            n.cold[k] = action.revision;
          });
  }
  for (const k of world.splitCold ?? [])
    if (s.cold[k] !== null)
      add(`cold-post:${k}`, false, (n, ctx) => {
        applyRestore(ctx, n, table, n.cold[k]!, null, 'completion');
        n.cold[k] = null;
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
          // A held Core writer does not stop a clock. After a step back the wall stays behind.
          if (!s.clock.back)
            env((n) => {
              n.clock.passed.push(e);
            });
          break;
        case 'Wback':
          // V1-P S2-r1 item 2: the wall clock steps back while a Native deadline refusal is in
          // transit to Main. A step back at RC7, RC8 or RC10 is out of scope: those owners read
          // the wall as the existing owners do, and Tc keeps its monotonic check.
          if (
            !s.clock.back &&
            s.clock.passed.length > 0 &&
            Object.values(s.c).some((c) => c.phase === 'replying' && c.decision === 'deadline')
          )
            env((n) => {
              n.clock.back = true;
            });
          break;
        case 'TcMono':
          // The monotonic Tc passes while the wall Tc is still live.
          if (!wallPassed(s, 'Tc'))
            env((n) => {
              n.clock.mono = true;
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
        case 'core':
          // Core user disable or membership: it writes R and B under the Core hold.
          if (!coreHeld)
            env((n) => {
              n.prem.R = false;
              n.prem.idle = false;
            });
          break;
        case 'policy':
          if (!(wsHeld && table.policyOrder === 'workspace-hold'))
            env((n) => {
              n.prem.policy = false;
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
              n.h = { ...n.h, life: 'failed', drain: 'draining', revision: n.h.revision + 1 };
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
              x.settleRev = null;
              x.answer = null;
            }
            n.excl = null;
            n.reserved = null;
            n.settling = [];
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
              n.h = { ...n.h, drain: 'draining', revision: n.h.revision + 1 };
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
              x.phase = 'published';
            });
          break;
      }
    }
  return out;
}

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
          }) === null && typeof table.claim(n.h, sandboxFacts(n)) !== 'string';
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
      } else if (active && world.stopAt === undefined)
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
    s.h = { ...s.h, drain: 'draining', revision: rev };
    s.cap.A = 'receipt';
    s.p.drainBy = ['claim:A'];
    s.excl = 'A';
    Object.assign(s.c.A!, { phase: 'published', claimRev: rev, slot: true });
  };

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
  /** A's cold restore paused after its positive read; B's admitted claim advances. */
  pausedRestore: {
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
      Object.assign(s.c.A!, { phase: 'dead', slot: false, claimRev: null });
      s.excl = null;
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
      s.h = { ...s.h, drain: 'draining', revision: 1 };
      s.p.drainBy = ['claim:B'];
      s.after = true;
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
      s.h = { ...s.h, drain: 'draining', revision: 2 };
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
const restoreWithout =
  (drop: 'revision' | 'life' | 'harness-drain' | 'sandbox') =>
  (h: HarnessFacts, s: SandboxFacts, revision: number) =>
    restorable(
      {
        ...h,
        ...(drop === 'life' ? { life: 'open' as const } : {}),
        ...(drop === 'harness-drain' && h.operation === 'harness.drain' ? { operation: null } : {}),
      },
      drop === 'sandbox' ? { accepting: true, clean: true, currentEpoch: true } : s
    ) &&
    (drop === 'revision' || h.revision === revision);
const OPEN_SANDBOX: SandboxFacts = { accepting: true, clean: true, currentEpoch: true };
const postWithout =
  (field: 'Tc' | 'mono' | 'pendingOwner' | 'thread' | 'policy') => (p: ClosePremises) =>
    T.post({
      ...p,
      ...(field === 'Tc'
        ? { deadlines: { ...p.deadlines, Tc: LIVE_DEADLINE }, closeMonotonicExpired: false }
        : {}),
      ...(field === 'mono' ? { closeMonotonicExpired: false } : {}),
      ...(field === 'pendingOwner' ? { pendingOwner: true } : {}),
      ...(field === 'thread' ? { audience: { ...p.audience, thread: true } } : {}),
      ...(field === 'policy' ? { audience: { ...p.audience, policy: true } } : {}),
    });
const bytesWithout =
  (
    field:
      | 'Ta'
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
            ? { kind: 'restore', scope: 'close', revision: f.harness.revision }
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
      claim: (h, s) => {
        const r = T.claim(h, s);
        return typeof r === 'string' ? r : { revision: h.revision };
      },
    },
  },
  {
    id: 'M-F2e',
    world: WORLDS.losing,
    oracle: 'O.one-claim',
    takeOut: 'accept the claim on a draining Harness',
    table: { claim: (h) => ({ revision: h.revision + 1 }) },
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
    id: 'M-F4g',
    world: WORLDS.legacyC1,
    oracle: 'O.restore.abandon',
    takeOut: 'restore on an abandon',
    table: { cold: withRules(['abandon']) },
  },
  {
    id: 'M-F4h',
    world: WORLDS.pausedRestore,
    oracle: 'O.restore.live-latch',
    takeOut: 'restore CAS without the revision (paused after the read)',
    table: { restore: restoreWithout('revision') },
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
    takeOut: 'the policy install does not wait for the hold (RC8 order)',
    table: { policyOrder: 'none' },
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
  {
    id: 'M-T5',
    world: WORLDS.live,
    oracle: 'O.cause',
    takeOut: 'Main maps the acknowledged deadline refusal from the wall at the reply (S2-r1)',
    table: { slotClockAt: 'reply' },
    via: 'env:Wback',
  },
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

  describe('directed schedules', () => {
    const live = WORLDS.live;

    it.each([
      ['Ta', 'authority-expired'],
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

    it.each(['Ta', 'Ts', 'Tc'] as const)('%s alone after RC8 gives zero bytes', (clock) => {
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
      for (const writer of ['env:core', 'env:thread', 'env:policy', 'env:R', 'env:idle'])
        expect(labels).not.toContain(writer);
      expect(labels.filter((l) => l.startsWith('cold:'))).toEqual([]);
      const stopped = run(live, [...TO_POST, 'queue:A', 'env:crash']);
      const after = enabled(live, stopped);
      expect(after).toContain('env:core');
      expect(after).toContain('cold:expire-key');
    });
  });

  it.each(M)(
    '$id fails $oracle when the table takes out: $takeOut',
    (row) => {
      const report = explore(row.world, tableOf(row), { stopOn: row.oracle });
      keep(row.id, { oracle: row.oracle, trace: report.traces[row.oracle], states: report.states });
      expect(Object.keys(report.traces)).toContain(row.oracle);
      if (row.via) expect(report.traces[row.oracle]).toContain(row.via);
    },
    600_000
  );
});
