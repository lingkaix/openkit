import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CaptureState,
  type CloseCause,
  type ClosePremises,
  COLD_RULES,
  type ColdAction,
  type ColdFacts,
  type ColdRule,
  composeCold,
  type HarnessFacts,
  REPLACEMENT_CLOSE_TABLE,
  type ReplacementCloseTable,
  restorable,
  type SandboxFacts,
  sandboxOpen,
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

type Clock = 'Tc' | 'Ts' | 'Ta' | 'W';
type Env =
  | Clock
  | 'thread'
  | 'policy'
  | 'R'
  | 'idle'
  | 'pend'
  | 'S'
  | 'N'
  | 'X'
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
  holds: boolean;
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
    N: boolean;
    X: boolean;
  };
  exp: Record<Clock, boolean>;
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
          holds: false,
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
      N: true,
      X: true,
    },
    exp: { Tc: false, Ts: false, Ta: false, W: false },
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

function premises(s: State, pendingOwner: boolean): ClosePremises {
  return {
    pendingOwner,
    request: s.prem.R,
    audience: { thread: s.prem.thread, policy: s.prem.policy },
    idleReceipt: s.prem.idle,
    storage: s.prem.S,
    placement: s.prem.N,
    connection: s.prem.X,
    expired: { Tc: s.exp.Tc, Ts: s.exp.Ts, Ta: s.exp.Ta },
    closeMonotonicExpired: s.exp.Tc,
  };
}

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
  c.holds = false;
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
  if (c.answer !== cause) violate(ctx, 'O.cause', `${b} answered ${c.answer} for ${cause}`);
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
  if (c && keyOf(b, c) === key && c.phase === 'queued') {
    c.phase = 'settled';
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
  const anyHolds = Object.values(s.c).some((c) => c.holds);
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
        x.holds = true;
        x.seq = n.h.nextSequence;
        x.phase = 'held';
      });
    if (c.phase === 'held' && reach('posted'))
      add(`post:${b}`, false, (n, ctx) => {
        const x = n.c[b]!;
        const cause = t.post(premises(n, n.prem.pend));
        if (cause) return liveRefuse(ctx, n, b, cause);
        const q = n.prem;
        if (!(q.pend && q.R && q.thread && q.policy && q.idle && !n.exp.Tc && !n.exp.Ta))
          violate(ctx, 'O.frame', `${b} posted with a failed premise`);
        if (t.holdUntil === 'post') x.holds = false;
        x.phase = 'posted';
      });
    if (c.phase === 'posted' && reach('queued'))
      for (const reply of world.lostReply ? ['ack', 'lost'] : ['ack'])
        add(`queue:${b}:${reply}`, false, (n, ctx) => {
          const x = n.c[b]!;
          const key = keyOf(b, x);
          const slotExpired = t.deadlineSlot.some((clock) => n.exp[clock]);
          const cause = t.queue({
            harness: n.h,
            claimRevision: x.claimRev,
            key: { binding: b, key, sequence: x.seq! },
            slotExpired,
            storage: n.prem.S,
            placement: n.prem.N,
          });
          if (!cause) {
            const q = n.prem;
            const own = n.p.drainBy.length === 1 && n.p.drainBy[0] === `claim:${b}`;
            if (
              n.exp.Tc ||
              n.exp.Ts ||
              n.exp.Ta ||
              !(q.S && q.N && q.R && q.thread && q.policy && q.idle) ||
              !own
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
            n.p.committed.push(key);
          }
          x.holds = false;
          if (reply === 'lost') {
            x.phase = 'unknown-reply';
            return;
          }
          if (cause) return liveRefuse(ctx, n, b, cause);
          x.phase = 'queued';
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
      s.exp.W &&
      c.answer === null &&
      ACTIVE.includes(c.phase) &&
      (t.callerBound === 'original-deadline' ||
        !['posted', 'unknown-reply', 'queued'].includes(c.phase))
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
              ['queued', 'unknown-reply'].includes(x.phase);
            const d = t.firstBytes(premises(n, pending));
            if (d.kind === 'refuse') {
              n.p.unsent.push(key);
              n.core[b] = { key, result: 'stale', revision: null };
              n.settling.push(key);
              return;
            }
            const q = n.prem;
            if (
              !(
                pending &&
                q.R &&
                q.thread &&
                q.policy &&
                q.idle &&
                q.S &&
                q.N &&
                q.X &&
                !n.exp.Tc &&
                !n.exp.Ts &&
                !n.exp.Ta
              )
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
      add(`cold:${action.kind}`, false, (n, ctx) => applyCold(ctx, n, action));
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
        case 'W':
          env((n) => {
            n.exp[e] = true;
          });
          break;
        case 'thread':
        case 'R':
        case 'idle':
          if (!anyHolds)
            env((n) => {
              n.prem[e] = false;
            });
          break;
        case 'policy':
          if (!(anyHolds && table.policyOrder === 'workspace-hold'))
            env((n) => {
              n.prem.policy = false;
            });
          break;
        case 'pend':
        case 'S':
        case 'N':
        case 'X':
          env((n) => {
            n.prem[e] = false;
          });
          break;
        case 'hdrain':
          if (
            s.h.drain === 'accepting' &&
            (s.h.cell === 'idle' || s.h.cell === 'settled') &&
            s.p.drainBy.length === 0
          )
            env((n) => {
              n.h = {
                ...n.h,
                drain: 'draining',
                operation: 'harness.drain',
                cell: 'settled',
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
                operation: null,
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
              x.holds = false;
              x.claimRev = null;
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
            !['queued', 'unknown-reply', 'settled', 'done'].includes(s.c.A?.phase ?? 'idle')
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
  const abandoned = world.bindings.filter((b) => s.cap[b] === 'abandoned');
  if (abandoned.length > 0 && !settledClose)
    return abandoned.some((b) => claimOwners.includes(b)) ? 'abandon-own' : 'abandon-sibling';
  // ENGINEER gap: a later operation reused the cell of a settled close, so neither the P7
  // settle revision nor an open capture proves the claim any more.
  if (claimOwners.some((o) => s.core[o] && (key === null || ownerOfKey(key) !== o)))
    return 'gap-reused-cell';
  return null;
}

interface Report {
  world: string;
  states: number;
  edges: number;
  quiescent: number;
  fences: Record<string, number>;
  traces: Record<string, string[]>;
  projections?: { total: number; ambiguous: number; histories: Record<string, number> };
  truncated: boolean;
}

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
    truncated: false,
  };
  const projections = new Map<string, Set<string>>();
  const histories: Record<string, number> = {};
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
    for (const step of next)
      for (const v of step.violations) record(v.name, key, `${step.label} -> ${v.detail}`);
    if (options.stopOn && report.traces[options.stopOn]) break;
    // State-local oracles.
    for (const [b, c] of Object.entries(s.c))
      if (
        s.exp.W &&
        c.answer === null &&
        ACTIVE.includes(c.phase) &&
        !next.some((step) => step.label === `bound:${b}`)
      )
        record('O.bound', key, `${b} unanswered at the caller bound`);
    if (s.occ !== s.p.occ0 - s.p.succ) record('O.occupancy', key, `occupancy ${s.occ}`);
    // The F3 projection compare: full durable values right after a crash.
    if (s.used.includes('crash') && s.used.at(-1) === 'crash' && world.closers.length > 1) {
      const projection = JSON.stringify([s.sb, s.h, s.occ, s.present, s.cap, s.core]);
      const history = historyOf(s);
      histories[history] = (histories[history] ?? 0) + 1;
      const set = projections.get(projection) ?? new Set<string>();
      set.add(`${history}|${[...s.p.drainBy].sort().join(',')}`);
      projections.set(projection, set);
    }
    const owner = next.filter((step) => !step.env && JSON.stringify(step.next) !== key);
    if (owner.length === 0) {
      report.quiescent += 1;
      const cls = fenceClass(world, s);
      const active = Object.values(s.c).some((c) => ACTIVE.includes(c.phase));
      if (cls !== null) {
        report.fences[cls] = (report.fences[cls] ?? 0) + 1;
        record(`fence:${cls}`, key);
      } else if (active && world.stopAt === undefined)
        record('L.stuck', key, 'a live owner has no next step');
      else if (s.h.drain === 'draining' && !active)
        record('L.exit', key, `stranded latch: ${s.p.drainBy.join(',')}`);
      if (s.p.owed > 0) record('L.e7', key, 'a restore owes its E7 request');
      for (const [b, c] of Object.entries(s.c))
        if (c.slot && (c.phase === 'refused' || c.phase === 'done'))
          record('L.slot', key, `${b} keeps its slots after the proof`);
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
  if (projections.size > 0)
    report.projections = {
      total: projections.size,
      ambiguous: [...projections.values()].filter(
        (set) => new Set([...set].map((h) => h.split('|')[1])).size > 1
      ).length,
      histories,
    };
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
  'W',
  'thread',
  'policy',
  'R',
  'idle',
  'pend',
  'S',
  'N',
  'X',
  'sbdrain',
  'crash',
];

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
  /** Older double claims (c1: no revision change) in a data root, then the new cold decide. */
  legacyC1: {
    name: 'legacy-c1',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['crash'],
    budget: 1,
    polls: ['p1'],
    legacy: 'c1',
    stopAt: 'published',
  },
  legacyR2: {
    name: 'legacy-r2',
    closers: ['A', 'B'],
    bindings: ['A', 'B'],
    env: ['crash'],
    budget: 1,
    polls: ['p1'],
    legacy: 'r2',
    stopAt: 'published',
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
  /** A completes P6/P7 while sibling B has an abandoned capture. */
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
  },
} satisfies Record<string, World>;

/**
 * ENGINEER F3-HD: A's earlier receipt is still open after a quiescent restore. A Harness-only
 * drain follows, then a later operation replaces its `harness.drain` marker. Kept apart from the
 * baseline: the explorer must keep finding this until a durable claim marker exists.
 */
const STALE_RECEIPT: World = {
  name: 'stale-receipt',
  closers: [],
  bindings: ['A'],
  env: ['hdrain', 'reuse'],
  budget: 2,
  polls: ['p1'],
  init: (s: State) => {
    s.cap.A = 'receipt';
  },
};

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
const postWithout = (field: 'Tc' | 'pendingOwner' | 'thread' | 'policy') => (p: ClosePremises) =>
  T.post({
    ...p,
    ...(field === 'Tc'
      ? { expired: { ...p.expired, Tc: false }, closeMonotonicExpired: false }
      : {}),
    ...(field === 'pendingOwner' ? { pendingOwner: true } : {}),
    ...(field === 'thread' ? { audience: { ...p.audience, thread: true } } : {}),
    ...(field === 'policy' ? { audience: { ...p.audience, policy: true } } : {}),
  });
const bytesWithout =
  (field: 'Ta' | 'idleReceipt' | 'pendingOwner' | 'thread' | 'policy' | 'storage' | 'connection') =>
  (p: ClosePremises) =>
    T.firstBytes({
      ...p,
      ...(field === 'Ta' ? { expired: { ...p.expired, Ta: false } } : {}),
      ...(field === 'idleReceipt' ? { idleReceipt: true } : {}),
      ...(field === 'pendingOwner' ? { pendingOwner: true } : {}),
      ...(field === 'thread' ? { audience: { ...p.audience, thread: true } } : {}),
      ...(field === 'policy' ? { audience: { ...p.audience, policy: true } } : {}),
      ...(field === 'storage' ? { storage: true } : {}),
      ...(field === 'connection' ? { connection: true } : {}),
    });

interface MutationRow {
  readonly id: string;
  readonly world: World;
  readonly oracle: string;
  readonly table: Partial<ReplacementCloseTable>;
  readonly takeOut: string;
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
    world: WORLDS.sibling,
    oracle: 'L.exit',
    takeOut: 'remove the P6 result-only completion',
    table: { cold: withRules(['p6-stale']) },
  },
  {
    id: 'M-F3e',
    world: WORLDS.sibling,
    oracle: 'L.exit',
    takeOut: 'remove the P7 stale exit',
    table: { cold: withRules(['p7-stale']) },
  },
  {
    id: 'M-F3f',
    world: WORLDS.sibling,
    oracle: 'L.exit',
    takeOut: 'remove the P7 success exit',
    table: { cold: withRules(['p7-success']) },
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
    world: WORLDS.live,
    oracle: 'O.queue',
    takeOut: 'release the Core hold at the post',
    table: { holdUntil: 'post' },
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

describe('replacement close lifecycle model check', () => {
  const reports: Report[] = [];

  it.each(Object.values(WORLDS))(
    'the unmodified table holds every invariant in $name',
    (world) => {
      const report = explore(world, T);
      reports.push(report);
      keep(`baseline:${world.name}`, report);
      expect(report.truncated).toBe(false);
      expect(Object.keys(report.traces).filter(SAFETY)).toEqual([]);
      expect(report.states).toBeGreaterThan(1);
      expect(report.quiescent).toBeGreaterThan(0);
    },
    600_000
  );

  it('reports state and edge counts and the named fences', () => {
    const totals = {
      states: reports.reduce((n, r) => n + r.states, 0),
      edges: reports.reduce((n, r) => n + r.edges, 0),
    };
    keep('totals', totals);
    for (const r of reports) expect(r.edges).toBeGreaterThanOrEqual(r.states - 1);
    expect(totals.states).toBeGreaterThan(1000);
  });

  it('F3: full durable values cannot name the claimant, and every cold step is safe for all of them', () => {
    const c1 = explore(WORLDS.legacyC1, T);
    const r2 = explore(WORLDS.legacyR2, T);
    const cl3 = explore(WORLDS.cl3, T);
    keep('f3', {
      c1: c1.projections,
      r2: r2.projections,
      cl3: cl3.projections,
      fences: { c1: c1.fences, r2: r2.fences, cl3: cl3.fences },
    });
    // Older writers leave equal projections for different latch owners.
    expect(c1.projections!.ambiguous).toBeGreaterThan(0);
    expect(r2.projections!.ambiguous).toBeGreaterThan(0);
    expect(c1.projections!.histories.H2).toBeGreaterThan(0);
    // CL3 produces no double claim.
    expect(cl3.projections?.histories.H2 ?? 0).toBe(0);
    // The cold decide stays safe on every history with the same values.
    for (const report of [c1, r2, cl3])
      expect(Object.keys(report.traces).filter(SAFETY)).toEqual([]);
  }, 600_000);

  it('ENGINEER F3-HD: the claimant-free exit still clears a Harness-only drain after cell reuse', () => {
    const report = explore(STALE_RECEIPT, T);
    keep('engineer:f3-hd', report.traces['O.restore.foreign']);
    expect(Object.keys(report.traces)).toContain('O.restore.foreign');
  });

  it.each(M)(
    '$id fails $oracle when the table takes out: $takeOut',
    (row) => {
      const report = explore(row.world, tableOf(row), { stopOn: row.oracle });
      keep(row.id, { oracle: row.oracle, trace: report.traces[row.oracle], states: report.states });
      expect(Object.keys(report.traces)).toContain(row.oracle);
    },
    600_000
  );
});
