import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyUnresolvedReadback,
  createHandoffRecord,
  decideHandoff,
  HANDOFF_TABLE,
  HANDOFF_TRANSITIONS,
  type HandoffCallerResult,
  type HandoffEffect,
  type HandoffEvent,
  type HandoffHold,
  type HandoffOutcome,
  type HandoffRecord,
  type HandoffRow,
  type HandoffSkip,
  type HandoffTable,
  handoffRow,
  UNRESOLVED_DISPOSITION,
} from './scheduler-dispatch-handoff.js';

/*
 * Independent environment model and bounded exhaustive explorer for the Main selection handoff.
 * The environment derives every legal selection, reply and settlement from raw facts: entry
 * status, held input and gate, live invocation, submission and settlement, the writer's posted,
 * committed and pending state, the Core rows and the configuration version. Owner changes are
 * generated apart from trigger delivery. The oracles read those raw facts, not the record.
 */

type Snap = { readonly configVersion: number };
type Rec = HandoffRecord<Snap, string>;
type Table = HandoffTable<Snap, string>;
type Event = HandoffEvent<Snap, string>;
type Effect = HandoffEffect<Snap, string>;
type SelectEffect = Extract<Effect, { kind: 'select' }>;
type Cause = { readonly of: string; readonly tag: string };

interface EntrySpec {
  readonly id: string;
  readonly ws: string;
  readonly thread: string;
  readonly published?: boolean;
  readonly deniable?: boolean;
  /** The Harness of the backend that the entry needs. Default: `h1`. */
  readonly harness?: string;
}

interface Faults {
  reply: number;
  inspect: number;
  snapshot: number;
  walk: number;
  barrier: number;
  settle: number;
  /** A final refusal with no reason code from the admission authority, before any Core effect. */
  authority: number;
  /** A second settlement callback for one retired invocation. */
  duplicate: number;
}

/** One bounded world. Every listed bound is explored exhaustively. */
export interface World {
  readonly name: string;
  readonly entries: readonly EntrySpec[];
  readonly frozen?: readonly string[];
  readonly paused?: boolean;
  readonly loginHeld?: readonly string[];
  readonly foreignHold?: string;
  readonly callers: readonly {
    readonly id: string;
    readonly entry: string | null;
    readonly max: number;
  }[];
  readonly timer?: number;
  readonly budget?: number;
  readonly wakeMax?: number;
  readonly faults?: Partial<Faults>;
  readonly owner?: readonly string[];
  readonly callbacks?: 1 | 2;
  readonly recoverySettle?: boolean;
  /** The backend owner facts: the RuntimeTarget starts not ready (owner `target`). */
  readonly targetUnready?: boolean;
  /** Harnesses whose open sessions are full (owner `sessions:<harness>`). */
  readonly sessionsFull?: readonly string[];
  /** A failed Turn after its ACK leaves its Core attempt closing until recovery closes it. */
  readonly fenceOnFail?: boolean;
}

/** Take-outs applied to the environment adapters instead of the pure tables. */
type EnvMutation = 'no-login-release' | 'stale-held-fact' | 'no-barrier' | 'turn-held-fact';

interface Inv {
  entry: string;
  stage: 'preparing' | 'acked' | 'requeue' | 'requeued';
  submits: number;
  key?: string;
  heldAtRefusal?: boolean;
}

type Op =
  | { k: 'select'; eff: SelectEffect; facts: Facts }
  | {
      k: 'post';
      entry: string;
      attemptId: string;
      digest: string;
      retained: boolean;
      prefix: string;
    }
  | { k: 'barrier' }
  | { k: 'deny'; entry: string };

interface Env {
  rec: Rec;
  ent: Record<string, { s: 'q' | 'a' | 'x'; pub: boolean; ids: number }>;
  frozen: string[];
  paused: boolean;
  config: number;
  rows: Record<string, { entry: string; digest: string; phase: 'open' | 'sub' | 'closed' }>;
  foreign: boolean;
  pending: { attemptId: string; entry: string; digest: string; prefix: string } | null;
  op: Op | null;
  wakes: number;
  inv: Record<string, Inv>;
  login: string[];
  callers: string[];
  timer: number;
  faults: Faults;
  owner: string[];
  handles: number;
  wakeSeq: number;
  resolved: string[];
  observed: Record<string, string[]>;
  owed: string[];
  busyHeld: Record<string, string>;
  passSrc: Record<string, string>;
  postsBy: Record<string, number>;
  successors: Record<string, number>;
  /** The successor identities counted in `successors` that may still hold a Core row. */
  successorIds: string[];
  heldBy: Record<string, number[]>;
  /** A barrier failed or a selection read threw: the timer or restart is the exit. */
  barrierFailed: boolean;
  /**
   * I5c: the attempt identities whose post reply was unknown to Main, and that neither a later
   * barrier ACK nor a Core-decided reply to the same identity has proved since.
   */
  unproved: string[];
  /** A second settlement callback that is still to come for a retired invocation. */
  late: { entry: string; invocation: string } | null;
  /** Backend owner facts read by its refusal predicate. */
  target: boolean;
  fence: string[];
  sessionsFull: string[];
}

/** A busy release starts a new one-successor count for the entry (D2). */
function resetSuccessors(env: Env, entry: string) {
  env.successors[entry] = 0;
  env.successorIds = env.successorIds.filter((attemptId) => !attemptId.startsWith(`${entry}#`));
}

/** D2: a successor identity that is proved to have no Core row is not a successor claim. */
function provedAbsent(env: Env, attemptId: string) {
  if (!env.successorIds.includes(attemptId)) return;
  env.successorIds = env.successorIds.filter((value) => value !== attemptId);
  const entry = attemptId.slice(0, attemptId.lastIndexOf('#'));
  if (env.successors[entry] !== undefined && env.successors[entry]! > 0)
    env.successors[entry]! -= 1;
}

/** The raw facts that one synchronous selection read sees at its emission. */
type Facts = Pick<Env, 'ent' | 'frozen' | 'paused' | 'config' | 'rows' | 'pending' | 'inv'>;
const factsOf = (env: Env): Facts =>
  structuredClone({
    ent: env.ent,
    frozen: env.frozen,
    paused: env.paused,
    config: env.config,
    rows: env.rows,
    pending: env.pending,
    inv: env.inv,
  });

interface Ctx {
  readonly world: World;
  readonly table: Table;
  readonly readback: typeof UNRESOLVED_DISPOSITION;
  readonly envMutation: EnvMutation | null;
  violations: string[];
  /** The selection would post a fresh attempt identity for this entry while an earlier one is unproved (I5c). */
  unprovedMint: string | null;
  rows?: Set<string>;
  /** The capacity schedules that the exploration reached. */
  cover?: Set<string>;
}

const scopeOf = (world: World, entry: string) => {
  const spec = world.entries.find((candidate) => candidate.id === entry)!;
  return { ws: spec.ws, thread: spec.thread, scope: `${spec.ws}/${spec.thread}` };
};
const digestOf = (entry: string, version: number) => `${entry}:v${version}`;
const entryOfAttempt = (attemptId: string) => attemptId.split('#')[0]!;
const overlaps = (world: World, left: string, right: string) =>
  scopeOf(world, left).ws === scopeOf(world, right).ws;

function initialEnv(world: World): Env {
  const ent: Env['ent'] = {};
  for (const spec of world.entries)
    ent[spec.id] = { s: 'q', pub: spec.published !== false, ids: 0 };
  return {
    rec: createHandoffRecord<Snap, string>(world.budget ?? 3),
    ent,
    frozen: [...(world.frozen ?? [])],
    paused: world.paused === true,
    config: 1,
    rows: {},
    foreign: world.foreignHold !== undefined,
    pending: null,
    op: null,
    wakes: 0,
    inv: {},
    login: [...(world.loginHeld ?? [])],
    callers: world.callers.map((caller) => caller.id),
    timer: world.timer ?? 0,
    faults: {
      reply: 0,
      inspect: 0,
      snapshot: 0,
      walk: 0,
      barrier: 0,
      settle: 0,
      authority: 0,
      duplicate: 0,
      ...world.faults,
    },
    owner: [...(world.owner ?? [])],
    handles: 0,
    wakeSeq: 0,
    resolved: [],
    observed: {},
    owed: [],
    busyHeld: {},
    passSrc: {},
    postsBy: {},
    successors: {},
    successorIds: [],
    heldBy: {},
    barrierFailed: false,
    unproved: [],
    late: null,
    target: world.targetUnready !== true,
    fence: [],
    sessionsFull: [...(world.sessionsFull ?? [])],
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

const isQueued = (env: Facts, entry: string) => env.ent[entry]?.s === 'q';
const prefixOf = (env: Facts, world: World, entry: string) =>
  world.entries
    .slice(
      0,
      world.entries.findIndex((spec) => spec.id === entry)
    )
    .filter((spec) => isQueued(env, spec.id))
    .map((spec) => spec.id)
    .join(',');
const overlapLive = (env: Facts, world: World, entry: string) =>
  Object.values(env.inv).some((inv) => overlaps(world, inv.entry, entry));
const frozenEntry = (env: Facts, world: World, entry: string) =>
  env.frozen.includes(scopeOf(world, entry).ws);
const deniable = (world: World, entry: string) =>
  world.entries.find((spec) => spec.id === entry)?.deniable === true;

function observe(env: Env, entry: string, hold: string) {
  const holds = env.observed[entry] ?? [];
  env.observed[entry] = holds;
  if (!holds.includes(hold)) holds.push(hold);
}
function owe(env: Env, hold: string, match: (entry: string) => boolean) {
  for (const entry of Object.keys(env.observed)) {
    const holds = env.observed[entry]!;
    if (holds.includes(hold) && match(entry)) {
      env.observed[entry] = holds.filter((value) => value !== hold);
      if (!env.owed.includes(entry)) env.owed.push(entry);
    }
  }
}
const settleOwed = (env: Env, entry: string) => {
  env.owed = env.owed.filter((value) => value !== entry);
};

function violation(ctx: Ctx, name: string) {
  if (!ctx.violations.includes(name)) ctx.violations.push(name);
}

function causeOf(outcome: HandoffOutcome): Cause | undefined {
  const value =
    outcome.kind === 'queued'
      ? outcome.cause
      : outcome.kind === 'denied'
        ? outcome.denial
        : outcome.kind === 'refused'
          ? outcome.refusal
          : outcome.cause;
  return value as Cause | undefined;
}

/** The caller oracle compares the deposited result with the keyed caller. */
function checkResolve(
  env: Env,
  ctx: Ctx,
  before: Rec,
  caller: string,
  result: HandoffCallerResult<string>
) {
  const spec = ctx.world.callers.find((candidate) => candidate.id === caller);
  if (!spec) return;
  if (env.resolved.includes(caller)) violation(ctx, 'I3.double-resolve');
  env.resolved.push(caller);
  if (spec.entry === null) return;
  const entry = spec.entry;
  if (result.kind === 'pass') return violation(ctx, 'I3.exact-caller');
  if (result.kind === 'join') {
    if (entryOfAttempt(result.invocation) !== entry) violation(ctx, 'I3.exact-caller');
    return;
  }
  if (result.entry !== entry) violation(ctx, 'I3.exact-caller');
  const cause = causeOf(result.outcome);
  if (cause && cause.of !== entry && cause.of !== '*') violation(ctx, 'I3.foreign-cause');
  if (
    before.unresolved[entry] &&
    !(result.outcome.kind === 'queued' && result.outcome.reason === 'recovery-required')
  )
    violation(ctx, 'I5b.typed-recovery');
}

/** Feeds one event through the transition, runs the synchronous effects and checks the oracles. */
function feed(env: Env, ctx: Ctx, event: Event, hooks: { prefix?: string } = {}) {
  const before = env.rec;
  let decision: ReturnType<typeof decideHandoff<Snap, string>>;
  try {
    decision = decideHandoff(before, event, ctx.table);
  } catch {
    violation(ctx, 'I10.totality');
    return;
  }
  const after = decision.record;
  ctx.rows?.add(decision.row);
  env.rec = after;
  for (const entry of Object.keys(before.unresolved))
    if (!after.unresolved[entry]) {
      delete env.heldBy[entry];
      const cycleEntry = before.cycle?.entry;
      const allowed =
        (decision.row === 'T7' && cycleEntry === entry) ||
        (decision.row === 'T8' &&
          event.kind === 'reply' &&
          event.replyClass === 'stale-original' &&
          cycleEntry === entry) ||
        (event.kind === 'selected' &&
          (event.discharged.includes(entry) || event.recovered.includes(entry)));
      if (!allowed) violation(ctx, 'I5a.identity-lost');
    }
  if (event.kind === 'selected')
    for (const entry of event.discharged) {
      const claim = before.unresolved[entry];
      if (claim && (env.rows[claim.attemptId] || env.pending?.attemptId === claim.attemptId))
        violation(ctx, 'I5.unproved-discharge');
    }
  if (event.kind === 'trigger' && after.waiters[event.caller]) {
    const pass = String(after.waiters[event.caller]!.pass);
    const mark = event.source === 'wake' ? 'w' : 'x';
    if (!(env.passSrc[pass] ?? '').includes(mark))
      env.passSrc[pass] = (env.passSrc[pass] ?? '') + mark;
  }
  for (const effect of decision.effects) runEffect(env, ctx, before, effect, hooks);
  for (const id of Object.keys(before.passes))
    if (!after.passes[Number(id)]) {
      if ((env.postsBy[id] ?? 0) >= after.budget) env.owed = [];
      delete env.postsBy[id];
      delete env.passSrc[id];
    }
  if (after.cycle && after.passes[after.cycle.pass]?.parkedOn) violation(ctx, 'I4.no-execution');
  if (after.ready.filter((id) => !after.passes[id]!.begun).length > 1)
    violation(ctx, 'I9.coalescing');
  if (env.handles !== (after.cycle?.handle ? 1 : 0) + Object.keys(after.live).length)
    violation(ctx, 'I8.handle-balance');
}

function runEffect(env: Env, ctx: Ctx, before: Rec, effect: Effect, hooks: { prefix?: string }) {
  const rec = env.rec;
  switch (effect.kind) {
    case 'select':
      if (env.op) violation(ctx, 'I1.one-handoff');
      env.op = { k: 'select', eff: effect, facts: factsOf(env) };
      return;
    case 'post': {
      if (env.op) violation(ctx, 'I1.one-handoff');
      const pass = String(rec.cycle!.pass);
      env.postsBy[pass] = (env.postsBy[pass] ?? 0) + 1;
      if (env.postsBy[pass]! > rec.budget) violation(ctx, 'I2.budget');
      const claim = rec.unresolved[effect.entry];
      if (
        claim &&
        (claim.attemptId !== effect.identity.attemptId ||
          claim.preparationDigest !== effect.identity.preparationDigest)
      )
        violation(ctx, 'I5b.retained-identity');
      if (!effect.retained && env.busyHeld[effect.entry] && env.passSrc[pass] === 'w')
        violation(ctx, 'I7.busy-reclaim');
      if (!effect.retained && env.successors[effect.entry] !== undefined) {
        env.successors[effect.entry]! += 1;
        env.successorIds.push(effect.identity.attemptId);
        if (env.successors[effect.entry]! > 1) violation(ctx, 'D2.one-successor');
      }
      settleOwed(env, effect.entry);
      delete env.heldBy[effect.entry];
      env.op = {
        k: 'post',
        entry: effect.entry,
        attemptId: effect.identity.attemptId,
        digest: effect.identity.preparationDigest,
        retained: effect.retained,
        prefix: hooks.prefix ?? '',
      };
      return;
    }
    case 'barrier':
      if (env.op) violation(ctx, 'I1.one-handoff');
      env.op = { k: 'barrier' };
      return;
    case 'deny':
      if (env.op) violation(ctx, 'I1.one-handoff');
      settleOwed(env, effect.entry);
      env.op = { k: 'deny', entry: effect.entry };
      return;
    case 'publish':
      env.inv[effect.invocation] = { entry: effect.entry, stage: 'preparing', submits: 0 };
      return;
    case 'release':
      env.handles -= 1;
      if (env.handles < 0) violation(ctx, 'I8.handle-balance');
      return;
    case 'retire':
      return;
    case 'resolve':
      checkResolve(env, ctx, before, effect.caller, effect.result);
      if (effect.result.kind === 'pass' && effect.result.outcome.kind === 'queued') {
        if (effect.result.outcome.reason === 'max-dispatches') env.owed = [];
      }
      return;
    case 'wake':
      env.wakes += 1;
      return;
  }
}

/** The reference `select` effect over raw facts. It uses the readback table under test. */
function select(env: Env, facts: Facts, ctx: Ctx, eff: SelectEffect) {
  const world = ctx.world;
  type Alt = {
    label: string;
    event: Event;
    acquire: boolean;
    prefix?: string;
    fault?: keyof Faults;
  };
  const alts: Alt[] = [];
  const fail = (
    label: string,
    entry: string | null,
    inspections: string[],
    of: string,
    fault: keyof Faults
  ) =>
    alts.push({
      label,
      acquire: false,
      fault,
      event: { kind: 'failed', stage: 'select', entry, inspections, cause: { of, tag: label } },
    });
  const done = (
    selection: Extract<Event, { kind: 'selected' }>['selection'],
    extra: Omit<Alt, 'event' | 'label'>
  ) => ({ selection, extra });
  const skipped: HandoffSkip[] = [];
  const discharged: string[] = [];
  const recovered: string[] = [];
  const finish = (label: string, result: ReturnType<typeof done>): Alt[] => {
    alts.push({
      label,
      event: { kind: 'selected', selection: result.selection, skipped, discharged, recovered },
      ...result.extra,
    });
    return alts;
  };
  if (facts.paused) {
    for (const entry of Object.keys(facts.ent))
      if (isQueued(facts, entry)) observe(env, entry, 'agent-work-paused');
    return finish('paused', done({ kind: 'paused' }, { acquire: false }));
  }
  if (Object.values(facts.inv).some((inv) => inv.stage === 'preparing')) {
    for (const entry of Object.keys(facts.ent))
      if (isQueued(facts, entry)) observe(env, entry, 'active-preparation');
    return finish('preparing', done({ kind: 'preparing' }, { acquire: false }));
  }
  const claims = Object.keys(eff.unresolved).sort();
  if (claims.length > 0 && env.faults.snapshot > 0)
    fail('snapshot-throws', null, claims, '*', 'snapshot');
  const held = new Set<string>();
  const walkClaims = new Set<string>();
  let barrier = false;
  for (const entry of claims) {
    const claim = eff.unresolved[entry]!;
    if (env.faults.inspect > 0) fail(`inspect-throws:${entry}`, entry, [entry], entry, 'inspect');
    const row = facts.rows[claim.attemptId];
    const sameDigest = digestOf(entry, facts.config) === claim.preparationDigest;
    const exact = row && row.entry === entry && row.digest === claim.preparationDigest;
    const checksPass =
      facts.ent[entry]!.pub &&
      !frozenEntry(facts, world, entry) &&
      !deniable(world, entry) &&
      !overlapLive(facts, world, entry) &&
      sameDigest;
    const disposition = classifyUnresolvedReadback(
      {
        replayAfterUnknown: eff.replayEntry === entry,
        row: row ? (exact ? 'exact' : 'other') : 'none',
        checksPass,
        proofCovers: eff.barrierProof?.includes(entry) === true,
        queued: isQueued(facts, entry),
        walkCandidate: 'pending',
        sameDigest,
        barrierAllowed: eff.barrierAllowed && ctx.envMutation !== 'no-barrier',
      },
      ctx.readback
    );
    if (disposition === 'immediate-replay') {
      env.handles += 1;
      return finish(
        `immediate-replay:${entry}`,
        done(
          { kind: 'claim', entry, identity: claim, retained: true },
          { acquire: true, prefix: prefixOf(facts, world, entry) }
        )
      );
    }
    if (disposition === 'discharge-recovery') recovered.push(entry);
    else if (disposition === 'discharge') discharged.push(entry);
    else if (disposition === 'barrier') barrier = true;
    else if (disposition === 'walk') walkClaims.add(entry);
    else held.add(entry);
  }
  const covered = () =>
    claims.filter(
      (entry) => !facts.rows[eff.unresolved[entry]!.attemptId] && !eff.barrierProof?.includes(entry)
    );
  if (barrier)
    return finish('barrier', done({ kind: 'barrier', covered: covered() }, { acquire: false }));
  const skip = (entry: string, hold: HandoffHold) => {
    skipped.push({ entry, hold });
    observe(env, entry, hold);
  };
  for (const spec of world.entries) {
    const entry = spec.id;
    if (!isQueued(facts, entry)) continue;
    if (eff.recovery.includes(entry) || held.has(entry)) {
      skip(entry, 'unresolved-claim');
      continue;
    }
    if (overlapLive(facts, world, entry)) {
      skip(entry, 'local-invocation');
      continue;
    }
    if (frozenEntry(facts, world, entry)) {
      skip(entry, 'frozen-workspace');
      continue;
    }
    if (!facts.ent[entry]!.pub) {
      skip(entry, 'publication-pending');
      continue;
    }
    if (eff.skipBusy && eff.busy[entry]) {
      skip(entry, 'backend-capacity');
      continue;
    }
    if (env.faults.walk > 0)
      fail(`walk-throws:${entry}`, entry, eff.unresolved[entry] ? [entry] : [], entry, 'walk');
    const claim = eff.unresolved[entry];
    if (claim && walkClaims.has(entry)) {
      const sameDigest = digestOf(entry, facts.config) === claim.preparationDigest;
      const disposition = classifyUnresolvedReadback(
        {
          replayAfterUnknown: false,
          row: 'none',
          checksPass: false,
          proofCovers: false,
          queued: true,
          walkCandidate: 'yes',
          sameDigest,
          barrierAllowed: eff.barrierAllowed && ctx.envMutation !== 'no-barrier',
        },
        ctx.readback
      );
      if (disposition === 'replay') {
        env.handles += 1;
        return finish(
          `replay:${entry}`,
          done(
            { kind: 'claim', entry, identity: claim, retained: true },
            { acquire: true, prefix: prefixOf(facts, world, entry) }
          )
        );
      }
      if (disposition === 'barrier')
        return finish('barrier', done({ kind: 'barrier', covered: covered() }, { acquire: false }));
      skip(entry, 'unresolved-claim');
      continue;
    }
    if (deniable(world, entry)) {
      env.handles += 1;
      return finish(`deny:${entry}`, done({ kind: 'deny', entry }, { acquire: true }));
    }
    const ids = env.ent[entry]!.ids + 1;
    // I5c (A8 r7-step3 finding 1): a fresh identity for an entry is posted only after every
    // earlier identity of the entry is proved. The step is a violation, not a bound cut.
    if (env.unproved.some((attemptId) => attemptId.startsWith(`${entry}#`))) {
      ctx.unprovedMint = `${entry}#${ids}`;
      return alts;
    }
    env.handles += 1;
    env.ent[entry]!.ids = ids;
    return finish(
      `claim:${entry}`,
      done(
        {
          kind: 'claim',
          entry,
          identity: {
            attemptId: `${entry}#${ids}`,
            inputHash: `${entry}:h`,
            preparationDigest: digestOf(entry, facts.config),
          },
          retained: false,
        },
        { acquire: true, prefix: prefixOf(facts, world, entry) }
      )
    );
  }
  return finish(
    'none',
    done(
      {
        kind: 'none',
        queuedRemain: Object.keys(facts.ent).some((entry) => isQueued(facts, entry)),
      },
      { acquire: false }
    )
  );
}

/** Records each pass that held an unresolved claim with no row and no pending write. */
function noteHeld(env: Env, eff: SelectEffect, skipped: readonly HandoffSkip[]) {
  for (const skip of skipped) {
    const claim = eff.unresolved[skip.entry];
    if (skip.hold !== 'unresolved-claim' || !claim) continue;
    if (env.rows[claim.attemptId] || env.pending?.attemptId === claim.attemptId) continue;
    const passes = env.heldBy[skip.entry] ?? [];
    env.heldBy[skip.entry] = passes;
    if (!passes.includes(eff.pass)) passes.push(eff.pass);
  }
}

/** I11 oracle: an older entry eligible on raw facts must be nominated first. */
function checkOrder(facts: Facts, ctx: Ctx, eff: SelectEffect, event: Event) {
  if (event.kind !== 'selected' || event.selection.kind !== 'claim') return;
  const entry = event.selection.entry;
  const claim = eff.unresolved[entry];
  const row = claim ? facts.rows[claim.attemptId] : undefined;
  if (row && row.digest === claim!.preparationDigest) return;
  const world = ctx.world;
  for (const spec of world.entries) {
    if (spec.id === entry) return;
    const older = spec.id;
    if (
      isQueued(facts, older) &&
      facts.ent[older]!.pub &&
      !frozenEntry(facts, world, older) &&
      !overlapLive(facts, world, older) &&
      !eff.recovery.includes(older) &&
      !eff.unresolved[older] &&
      !(eff.skipBusy && eff.busy[older])
    )
      return violation(ctx, 'I11.order');
  }
}

/** Core create under its write lock. */
function coreCreate(env: Env, world: World, op: Extract<Op, { k: 'post' }>) {
  const row = env.rows[op.attemptId];
  if (row) {
    if (row.entry !== op.entry || row.digest !== op.digest)
      return { kind: 'refusal' as const, reason: null };
    return { kind: 'attempt' as const, fresh: row.phase === 'open' && !env.inv[op.attemptId] };
  }
  if (!isQueued(env, op.entry)) return { kind: 'refusal' as const, reason: 'selection-changed' };
  const scope = scopeOf(world, op.entry).scope;
  const placement =
    (env.foreign && world.foreignHold === scope) ||
    Object.values(env.rows).some(
      (other) => other.phase !== 'closed' && overlaps(world, other.entry, op.entry)
    );
  if (placement) return { kind: 'refusal' as const, reason: 'placement-held' };
  if (prefixOf(env, world, op.entry) !== op.prefix)
    return { kind: 'refusal' as const, reason: 'selection-changed' };
  return { kind: 'insert' as const };
}

function insertRow(env: Env, op: { attemptId: string; entry: string; digest: string }) {
  env.rows[op.attemptId] = { entry: op.entry, digest: op.digest, phase: 'open' };
  env.ent[op.entry]!.s = 'a';
}

type Action = { label: string; run: (env: Env, ctx: Ctx) => void; internal: boolean };

const loginKey = (scope: string) => `login:${scope}`;
const harnessOf = (world: World, entry: string) =>
  world.entries.find((spec) => spec.id === entry)?.harness ?? 'h1';
/** A Turn that holds the one backend slot. */
const turnHeld = (env: Env) => Object.values(env.inv).some((inv) => inv.stage === 'acked');
/**
 * The backend owner's side-effect-free refusal predicate for one entry: the RuntimeTarget is not
 * ready, an ACKed Turn or a closing Core attempt holds the one slot, or the Harness of the entry
 * is full.
 */
function backendRefuses(env: Env, world: World, entry: string): boolean {
  return (
    !env.target ||
    turnHeld(env) ||
    env.fence.length > 0 ||
    env.sessionsFull.includes(harnessOf(world, entry))
  );
}
/** The capacity owner's held fact for one refused entry. */
const keyHeld = (env: Env, world: World, key: string, entry: string) =>
  key.startsWith('login:') ? env.login.includes(key.slice(6)) : backendRefuses(env, world, entry);

/**
 * An acknowledged backend owner change: the owner reads the refusal predicate again for each
 * entry with a busy mark or a queued busy settlement on the backend, and releases the clear ones.
 */
function backendChanged(
  env: Env,
  ctx: Ctx,
  change: 'settlement' | 'recovery' | 'target' | 'sessions'
) {
  const cleared = Object.keys(env.busyHeld)
    .filter((entry) => env.busyHeld[entry] === 'backend:nh')
    .filter((entry) => !backendRefuses(env, ctx.world, entry))
    .sort();
  if (
    Object.keys(env.busyHeld).some(
      (entry) => env.busyHeld[entry] === 'backend:nh' && !cleared.includes(entry)
    )
  )
    ctx.cover?.add(`kept-at-${change}`);
  if (cleared.length === 0) return;
  ctx.cover?.add(`cleared-at-${change}`);
  for (const entry of cleared) {
    delete env.busyHeld[entry];
    resetSuccessors(env, entry);
    owe(env, 'backend-capacity', (value) => value === entry);
  }
  feed(env, ctx, {
    kind: 'released',
    hold: 'backend-capacity',
    key: { kind: 'backend', backendId: 'nh' },
    cleared,
  });
}

/** Every enabled action of the environment, internal completions first. */
function actions(env: Env, world: World): Action[] {
  const list: Action[] = [];
  const op = env.op;
  if (op?.k === 'select')
    list.push({
      label: 'select',
      internal: true,
      run: () => {},
    });
  if (op?.k === 'post' && env.pending === null) {
    const variants: string[] = ['normal'];
    if (env.faults.reply > 0)
      variants.push('not-run', 'unknown-lost', 'unknown-committed', 'unknown-pending');
    if (env.faults.authority > 0) variants.push('refused-final');
    for (const variant of variants)
      list.push({
        label: `post:${op.entry}:${variant}`,
        internal: true,
        run: (next, ctx) => {
          const post = next.op as Extract<Op, { k: 'post' }>;
          next.op = null;
          if (variant === 'refused-final') {
            next.faults.authority -= 1;
            return feed(next, ctx, {
              kind: 'reply',
              replyClass: 'refused-final',
              refusal: { of: post.entry, tag: 'authority' },
            });
          }
          if (variant !== 'normal') next.faults.reply -= 1;
          const decided = coreCreate(next, world, post);
          const cause: Cause = { of: post.entry, tag: variant };
          if (variant === 'not-run') {
            provedAbsent(next, post.attemptId);
            return feed(next, ctx, { kind: 'reply', replyClass: 'not-run', cause });
          }
          if (variant.startsWith('unknown')) {
            if (!next.unproved.includes(post.attemptId)) next.unproved.push(post.attemptId);
            if (decided.kind === 'insert' && variant === 'unknown-committed') insertRow(next, post);
            if (decided.kind === 'insert' && variant === 'unknown-pending')
              next.pending = { ...post };
            return feed(next, ctx, { kind: 'reply', replyClass: 'unknown', cause });
          }
          // A Core-decided reply proves the state of this exact identity.
          next.unproved = next.unproved.filter((attemptId) => attemptId !== post.attemptId);
          if (decided.kind === 'insert') {
            insertRow(next, post);
            return feed(next, ctx, { kind: 'reply', replyClass: 'claimed' });
          }
          if (decided.kind === 'attempt')
            return feed(next, ctx, {
              kind: 'reply',
              replyClass: decided.fresh ? 'claimed' : 'stale-original',
            });
          provedAbsent(next, post.attemptId);
          return feed(next, ctx, {
            kind: 'reply',
            replyClass: decided.reason === null ? 'refused-final' : 'refused-rescan',
            refusal: { of: post.entry, tag: decided.reason ?? 'final' },
          });
        },
      });
  }
  if (op?.k === 'barrier' && env.pending === null) {
    list.push({
      label: 'barrier:ack',
      internal: true,
      run: (next, ctx) => {
        next.op = null;
        // The ACK covers every earlier post of the root: the writer has no pending commit.
        for (const attemptId of next.unproved)
          if (!next.rows[attemptId]) provedAbsent(next, attemptId);
        next.unproved = [];
        feed(next, ctx, { kind: 'barrier', acknowledged: true });
      },
    });
    if (env.faults.barrier > 0)
      list.push({
        label: 'barrier:failed',
        internal: true,
        run: (next, ctx) => {
          next.op = null;
          next.faults.barrier -= 1;
          next.barrierFailed = true;
          next.owed = [];
          feed(next, ctx, { kind: 'barrier', acknowledged: false });
        },
      });
  }
  if (op?.k === 'deny' && env.pending === null)
    list.push({
      label: `deny:${op.entry}`,
      internal: true,
      run: (next, ctx) => {
        next.op = null;
        next.ent[op.entry]!.s = 'x';
        settleOwed(next, op.entry);
        feed(next, ctx, { kind: 'denied', denial: { of: op.entry, tag: 'denial' } });
      },
    });
  if (env.pending)
    for (const apply of [true, false])
      list.push({
        label: `writer:${apply ? 'commits' : 'drops'}`,
        internal: true,
        run: (next) => {
          const pending = next.pending!;
          next.pending = null;
          if (
            apply &&
            coreCreate(next, world, { k: 'post', retained: false, ...pending }).kind === 'insert'
          )
            insertRow(next, pending);
        },
      });
  if (env.wakes > 0)
    list.push({
      label: 'wake',
      internal: true,
      run: (next, ctx) => {
        next.wakes -= 1;
        next.wakeSeq += 1;
        feed(next, ctx, {
          kind: 'trigger',
          caller: `w${next.wakeSeq}`,
          entry: null,
          snapshot: { configVersion: next.config },
          max: world.wakeMax ?? 3,
          source: 'wake',
        });
      },
    });
  const late = env.late;
  if (late)
    list.push({
      label: `settled-again:${late.invocation}`,
      internal: true,
      run: (next, ctx) => {
        next.late = null;
        feed(next, ctx, {
          kind: 'settled',
          entry: late.entry,
          invocation: late.invocation,
          outcome: 'dispatched',
          turn: `turn:${late.invocation}`,
        });
      },
    });
  for (const invocation of Object.keys(env.inv).sort()) {
    const inv = env.inv[invocation]!;
    const { scope } = scopeOf(world, inv.entry);
    const turn = `turn:${invocation}`;
    const loginHeld = env.login.includes(scope);
    if (
      inv.stage === 'preparing' &&
      env.pending === null &&
      !loginHeld &&
      !backendRefuses(env, world, inv.entry)
    )
      list.push({
        label: `ack:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          next.inv[invocation]!.stage = 'acked';
          next.rows[invocation]!.phase = 'sub';
          owe(next, 'active-preparation', () => true);
          feed(next, ctx, { kind: 'released', hold: 'active-preparation' });
        },
      });
    if (inv.stage === 'preparing' && (loginHeld || backendRefuses(env, world, inv.entry)))
      list.push({
        label: `refuse:${invocation}`,
        internal: true,
        run: (next) => {
          const key = loginHeld ? loginKey(scope) : 'backend:nh';
          next.inv[invocation] = {
            ...next.inv[invocation]!,
            stage: 'requeue',
            key,
            heldAtRefusal: true,
          };
        },
      });
    if (inv.stage === 'requeue' && env.pending === null)
      list.push({
        label: `requeue:${invocation}`,
        internal: true,
        run: (next) => {
          // The awaited no-effect requeue commits before the settlement is queued.
          next.rows[invocation]!.phase = 'closed';
          next.ent[inv.entry]!.s = 'q';
          next.inv[invocation]!.stage = 'requeued';
        },
      });
    if (inv.stage === 'requeued')
      list.push({
        label: `busy:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          const key = inv.key!;
          delete next.inv[invocation];
          owe(next, 'local-invocation', (entry) => overlaps(world, entry, inv.entry));
          const trueHeld = keyHeld(next, world, key, inv.entry);
          const held =
            ctx.envMutation === 'stale-held-fact'
              ? inv.heldAtRefusal === true
              : ctx.envMutation === 'turn-held-fact' && key === 'backend:nh'
                ? turnHeld(next)
                : trueHeld;
          if (
            key === 'backend:nh' &&
            trueHeld &&
            !next.target &&
            !turnHeld(next) &&
            next.fence.length === 0
          )
            ctx.cover?.add('unready-zero-turns');
          if (trueHeld) {
            next.busyHeld[inv.entry] = key;
            observe(next, inv.entry, 'backend-capacity');
          } else {
            ctx.cover?.add(
              key === 'backend:nh' ? 'release-before-enqueue' : 'login-release-before-enqueue'
            );
            resetSuccessors(next, inv.entry);
            if (!next.owed.includes(inv.entry)) next.owed.push(inv.entry);
          }
          const capacityKey = key.startsWith('login:')
            ? {
                kind: 'login-close' as const,
                workspaceId: scopeOf(world, inv.entry).ws,
                threadId: scopeOf(world, inv.entry).thread,
              }
            : { kind: 'backend' as const, backendId: 'nh' };
          feed(next, ctx, {
            kind: 'settled',
            entry: inv.entry,
            invocation,
            outcome: 'backend-busy',
            capacity: { key: capacityKey, held },
          });
        },
      });
    if (inv.submits < (world.callbacks ?? 1) && inv.stage === 'acked')
      list.push({
        label: `submitted:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          next.inv[invocation]!.submits += 1;
          feed(next, ctx, { kind: 'submitted', invocation, turn });
        },
      });
    if (inv.stage === 'acked' && inv.submits > 0)
      list.push({
        label: `dispatched:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          next.rows[invocation]!.phase = 'closed';
          next.ent[inv.entry]!.s = 'x';
          delete next.inv[invocation];
          owe(next, 'local-invocation', (entry) => overlaps(world, entry, inv.entry));
          if (next.faults.duplicate > 0 && next.late === null) {
            next.faults.duplicate -= 1;
            next.late = { entry: inv.entry, invocation };
          }
          feed(next, ctx, {
            kind: 'settled',
            entry: inv.entry,
            invocation,
            outcome: 'dispatched',
            turn,
          });
          // The Core attempt closes with the Turn: an acknowledged backend owner change.
          backendChanged(next, ctx, 'settlement');
        },
      });
    if ((inv.stage === 'preparing' || inv.stage === 'acked') && env.faults.settle > 0)
      list.push({
        label: `failed:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          next.faults.settle -= 1;
          next.rows[invocation]!.phase = 'closed';
          next.ent[inv.entry]!.s = 'x';
          delete next.inv[invocation];
          owe(next, 'local-invocation', (entry) => overlaps(world, entry, inv.entry));
          const fenced = inv.stage === 'acked' && world.fenceOnFail === true;
          if (fenced) next.fence.push(invocation);
          feed(next, ctx, {
            kind: 'settled',
            entry: inv.entry,
            invocation,
            outcome: 'failed',
            cause: { of: inv.entry, tag: 'settle' },
          });
          if (fenced) {
            if (Object.values(next.busyHeld).includes('backend:nh'))
              ctx.cover?.add('fence-closing');
          } else if (inv.stage === 'acked') backendChanged(next, ctx, 'settlement');
        },
      });
    if (inv.stage === 'preparing' && world.recoverySettle)
      list.push({
        label: `recovery:${invocation}`,
        internal: true,
        run: (next, ctx) => {
          delete next.inv[invocation];
          owe(next, 'local-invocation', (entry) => overlaps(world, entry, inv.entry));
          feed(next, ctx, {
            kind: 'settled',
            entry: inv.entry,
            invocation,
            outcome: 'recovery-required',
          });
        },
      });
  }
  for (const attempt of env.fence)
    list.push({
      label: `recover:${attempt}`,
      internal: true,
      run: (next, ctx) => {
        // Recovery closes the failed Turn's Core attempt: an acknowledged backend owner change.
        next.fence = next.fence.filter((value) => value !== attempt);
        backendChanged(next, ctx, 'recovery');
      },
    });
  for (const caller of env.callers) {
    const spec = world.callers.find((candidate) => candidate.id === caller)!;
    list.push({
      label: `trigger:${caller}`,
      internal: false,
      run: (next, ctx) => {
        next.callers = next.callers.filter((value) => value !== caller);
        feed(next, ctx, {
          kind: 'trigger',
          caller,
          entry: spec.entry,
          snapshot: { configVersion: next.config },
          max: spec.max,
          source: 'external',
        });
      },
    });
  }
  if (env.timer > 0)
    list.push({
      label: 'timer',
      internal: false,
      run: (next, ctx) => {
        next.timer -= 1;
        feed(next, ctx, {
          kind: 'trigger',
          caller: `t${next.timer}`,
          entry: null,
          snapshot: { configVersion: next.config },
          max: 2,
          source: 'external',
        });
      },
    });
  for (const token of env.owner)
    list.push({
      label: `owner:${token}`,
      internal: false,
      run: (next, ctx) => {
        next.owner = next.owner.filter((value) => value !== token);
        const [kind, subject] = token.split(':') as [string, string];
        if (kind === 'thaw') {
          next.frozen = next.frozen.filter((value) => value !== subject);
          owe(next, 'frozen-workspace', (entry) => scopeOf(world, entry).ws === subject);
          return feed(next, ctx, { kind: 'released', hold: 'frozen-workspace' });
        }
        if (kind === 'publish') {
          next.ent[subject]!.pub = true;
          owe(next, 'publication-pending', (entry) => entry === subject);
          return feed(next, ctx, { kind: 'released', hold: 'publication-pending' });
        }
        if (kind === 'unpause') {
          next.paused = false;
          owe(next, 'agent-work-paused', () => true);
          return feed(next, ctx, { kind: 'released', hold: 'agent-work-paused' });
        }
        if (kind === 'config') {
          next.config = 2;
          return;
        }
        if (kind === 'foreign') {
          next.foreign = false;
          return;
        }
        if (kind === 'target') {
          next.target = true;
          return backendChanged(next, ctx, 'target');
        }
        if (kind === 'sessions') {
          next.sessionsFull = next.sessionsFull.filter((value) => value !== subject);
          return backendChanged(next, ctx, 'sessions');
        }
        if (kind === 'login') {
          next.login = next.login.filter((value) => value !== subject);
          for (const entry of Object.keys(next.busyHeld))
            if (next.busyHeld[entry] === loginKey(subject)) {
              delete next.busyHeld[entry];
              resetSuccessors(next, entry);
              owe(next, 'backend-capacity', (value) => value === entry);
              ctx.cover?.add('login-release-after-enqueue');
            }
          if (ctx.envMutation === 'no-login-release') return;
          const [workspaceId, threadId] = subject.split('/') as [string, string];
          return feed(next, ctx, {
            kind: 'released',
            hold: 'backend-capacity',
            key: { kind: 'login-close', workspaceId, threadId },
          });
        }
      },
    });
  return list;
}

/** Expands the pending `select` into its legal results; other actions run as listed. */
function successors(
  env: Env,
  ctx: Ctx
): { label: string; next: Env; violations: string[]; internal: boolean }[] {
  const out: {
    label: string;
    next: Env;
    violations: string[];
    internal: boolean;
  }[] = [];
  const clone = () => structuredClone(env);
  for (const action of actions(env, ctx.world)) {
    if (action.label === 'select') {
      const probe = clone();
      const probeCtx: Ctx = { ...ctx, violations: [], unprovedMint: null };
      const pendingSelect = env.op as Extract<Op, { k: 'select' }>;
      const alts = select(probe, pendingSelect.facts, probeCtx, pendingSelect.eff);
      if (probeCtx.unprovedMint !== null)
        out.push({
          label: `select:claim:${probeCtx.unprovedMint}`,
          next: probe,
          violations: ['I5c.unproved-identity'],
          internal: true,
        });
      for (const alt of alts) {
        const next = clone();
        const stepCtx: Ctx = { ...ctx, violations: [], unprovedMint: null };
        const { eff, facts } = next.op as Extract<Op, { k: 'select' }>;
        // A thrown selection reports no skip and acquires no handle or identity.
        if (alt.event.kind === 'failed' && alt.fault) {
          next.faults[alt.fault] -= 1;
          // A thrown read exits through the timer or restart; liveness assumes fair completions.
          next.barrierFailed = true;
          next.owed = [];
        } else select(next, facts, stepCtx, eff);
        next.op = null;
        if (alt.event.kind === 'selected') noteHeld(next, eff, alt.event.skipped);
        checkOrder(facts, stepCtx, eff, alt.event);
        feed(next, stepCtx, alt.event, alt.prefix !== undefined ? { prefix: alt.prefix } : {});
        out.push({
          label: `select:${alt.label}`,
          next,
          violations: stepCtx.violations,
          internal: true,
        });
      }
      continue;
    }
    const next = clone();
    const stepCtx: Ctx = { ...ctx, violations: [], unprovedMint: null };
    action.run(next, stepCtx);
    out.push({
      label: action.label,
      next,
      violations: stepCtx.violations,
      internal: action.internal,
    });
  }
  return out;
}

/** Liveness at a quiescent state: no runnable work and no owed scan. */
function quiescentViolations(env: Env, world: World): string[] {
  const found: string[] = [];
  if (env.rec.cycle || env.rec.ready.length > 0 || Object.keys(env.rec.waiters).length > 0)
    found.push('liveness.quiescent-waiter');
  for (const entry of env.owed)
    if (
      isQueued(env, entry) &&
      env.ent[entry]!.pub &&
      !frozenEntry(env, world, entry) &&
      !env.paused &&
      !env.rec.unresolved[entry] &&
      !env.busyHeld[entry]
    )
      found.push('I6.lost-wake');
  for (const entry of Object.keys(env.heldBy))
    if (env.heldBy[entry]!.length >= 2 && !env.barrierFailed && env.rec.unresolved[entry])
      found.push('I5.stranded-unresolved');
  return found;
}

/** The state key renames pass and wake-caller IDs by rank; the behaviour does not depend on them. */
function stateKey(env: Env): string {
  const rec = env.rec;
  const ranks = new Map(
    Object.keys(rec.passes)
      .map(Number)
      .sort((left, right) => left - right)
      .map((id, index) => [id, index + 1])
  );
  const pass = (id: number) => ranks.get(id) ?? 0;
  const wakers = Object.keys(rec.waiters)
    .filter((caller) => /^w\d+$/.test(caller))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  const caller = (id: string) => (wakers.includes(id) ? `w${wakers.indexOf(id) + 1}` : id);
  const byPass = <V>(record: Record<string, V>) =>
    Object.fromEntries(Object.entries(record).map(([id, value]) => [pass(Number(id)), value]));
  return canonical({
    ...env,
    wakeSeq: 0,
    resolved: [...env.resolved].sort(),
    owed: [...env.owed].sort(),
    unproved: [...env.unproved].sort(),
    successorIds: [...env.successorIds].sort(),
    observed: Object.fromEntries(
      Object.entries(env.observed).map(([entry, holds]) => [entry, [...holds].sort()])
    ),
    passSrc: byPass(env.passSrc),
    postsBy: byPass(env.postsBy),
    heldBy: Object.fromEntries(
      Object.entries(env.heldBy).map(([entry, ids]) => [entry, ids.map(pass)])
    ),
    op:
      env.op?.k === 'select'
        ? { ...env.op, eff: { ...env.op.eff, pass: pass(env.op.eff.pass) } }
        : env.op,
    rec: {
      ...rec,
      nextPass: 0,
      cycle: rec.cycle && { ...rec.cycle, pass: pass(rec.cycle.pass) },
      ready: rec.ready.map(pass),
      passes: Object.fromEntries(
        Object.values(rec.passes).map((value) => [pass(value.id), { ...value, id: pass(value.id) }])
      ),
      waiters: Object.fromEntries(
        Object.entries(rec.waiters).map(([id, waiter]) => [
          caller(id),
          { ...waiter, pass: pass(waiter.pass) },
        ])
      ),
    },
  });
}

export interface ExploreReport {
  readonly world: string;
  readonly states: number;
  readonly edges: number;
  readonly quiescent: number;
  readonly cycles: number;
  readonly traces: Readonly<Record<string, readonly string[]>>;
  readonly rows: readonly string[];
  readonly schedules: readonly string[];
}

interface ExploreOptions {
  readonly table?: Table;
  readonly readback?: typeof UNRESOLVED_DISPOSITION;
  readonly envMutation?: EnvMutation;
  readonly maxStates?: number;
}

/** Breadth-first exhaustive exploration; the first trace of each violation is a shortest one. */
export function explore(world: World, options: ExploreOptions = {}): ExploreReport {
  const ctx: Ctx = {
    world,
    table: options.table ?? (HANDOFF_TABLE as unknown as Table),
    readback: options.readback ?? UNRESOLVED_DISPOSITION,
    envMutation: options.envMutation ?? null,
    violations: [],
    unprovedMint: null,
  };
  const ids = new Map<string, number>();
  const parent: number[] = [-1];
  const via: string[] = [''];
  const queue: Env[] = [initialEnv(world)];
  const hash = (env: Env) => createHash('sha1').update(stateKey(env)).digest('base64');
  ids.set(hash(queue[0]!), 0);
  const from: number[] = [];
  const to: number[] = [];
  const traces: Record<string, string[]> = {};
  const rows = new Set<string>();
  ctx.rows = rows;
  const cover = new Set<string>();
  ctx.cover = cover;
  let edges = 0;
  let quiescent = 0;
  const trace = (id: number, last: string) => {
    const path = [last];
    for (let at = id; at > 0; at = parent[at]!) path.unshift(via[at]!);
    return path;
  };
  for (let head = 0; head < queue.length; head += 1) {
    const env = queue[head]!;
    const steps = successors(env, ctx);
    if (!steps.some((step) => step.internal)) {
      quiescent += 1;
      for (const name of quiescentViolations(env, world)) traces[name] ??= trace(head, 'quiescent');
    }
    for (const step of steps) {
      edges += 1;
      if (step.violations.length > 0) {
        for (const name of step.violations) traces[name] ??= trace(head, step.label);
        continue;
      }
      const key = hash(step.next);
      let id = ids.get(key);
      if (id === undefined) {
        id = queue.length;
        ids.set(key, id);
        parent.push(head);
        via.push(step.label);
        queue.push(step.next);
        if (options.maxStates && queue.length > options.maxStates)
          throw new Error(`${world.name}: state bound exceeded`);
      }
      from.push(head);
      to.push(id);
    }
    queue[head] = undefined as unknown as Env;
  }
  return {
    world: world.name,
    states: queue.length,
    edges,
    quiescent,
    cycles: countCycles(queue.length, from, to),
    traces,
    rows: [...rows].sort(),
    schedules: [...cover].sort(),
  };
}

/** Counts the nontrivial strongly connected components (iterative Tarjan). */
function countCycles(size: number, from: number[], to: number[]): number {
  const start = new Int32Array(size + 1);
  for (const value of from) start[value + 1]! += 1;
  for (let index = 0; index < size; index += 1) start[index + 1]! += start[index]!;
  const adjacency = new Int32Array(from.length);
  const fill = start.slice(0, size);
  for (let index = 0; index < from.length; index += 1)
    adjacency[fill[from[index]!]!++] = to[index]!;
  const order = new Int32Array(size).fill(-1);
  const low = new Int32Array(size);
  const onStack = new Uint8Array(size);
  const stack: number[] = [];
  let counter = 0;
  let cycles = from.filter((value, index) => value === to[index]).length;
  for (let root = 0; root < size; root += 1) {
    if (order[root] !== -1) continue;
    const work: [number, number][] = [[root, start[root]!]];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [node] = frame;
      if (frame[1] < start[node + 1]!) {
        const next = adjacency[frame[1]++]!;
        if (order[next] === -1) {
          order[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          work.push([next, start[next]!]);
        } else if (onStack[next]) low[node] = Math.min(low[node]!, order[next]!);
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const up = work[work.length - 1]![0];
        low[up] = Math.min(low[up]!, low[node]!);
      }
      if (low[node] === order[node]) {
        let members = 0;
        let member: number;
        do {
          member = stack.pop()!;
          onStack[member] = 0;
          members += 1;
        } while (member !== node);
        if (members > 1) cycles += 1;
      }
    }
  }
  return cycles;
}

/** Replays one labelled trace and returns the record after each step. */
export function replayTrace(world: World, labels: readonly string[], options: ExploreOptions = {}) {
  const ctx: Ctx = {
    world,
    table: options.table ?? (HANDOFF_TABLE as unknown as Table),
    readback: options.readback ?? UNRESOLVED_DISPOSITION,
    envMutation: options.envMutation ?? null,
    violations: [],
    unprovedMint: null,
  };
  let env = initialEnv(world);
  const steps: { label: string; env: Env; violations: string[] }[] = [];
  for (const label of labels) {
    const step = successors(env, ctx).find((candidate) => candidate.label === label);
    if (!step) {
      steps.push({ label: `missing:${label}`, env, violations: [] });
      break;
    }
    steps.push({ label, env: step.next, violations: step.violations });
    env = step.next;
  }
  return steps;
}

/** Seeded runner skeleton: one random schedule with the same oracles. Step 4 adds a real-SQLite adapter. */
export function runSeeded(world: World, seed: number, steps: number, options: ExploreOptions = {}) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ctx: Ctx = {
    world,
    table: options.table ?? (HANDOFF_TABLE as unknown as Table),
    readback: options.readback ?? UNRESOLVED_DISPOSITION,
    envMutation: options.envMutation ?? null,
    violations: [],
    unprovedMint: null,
  };
  let env = initialEnv(world);
  const path: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    const choices = successors(env, ctx);
    if (choices.length === 0) break;
    const choice = choices[Math.floor(random() * choices.length)]!;
    path.push(choice.label);
    if (choice.violations.length > 0) return { path, violations: choice.violations };
    env = choice.next;
  }
  return { path, violations: quiescentViolations(env, world) };
}

// ---------------------------------------------------------------------------------------------
// Take-outs. Each replaces one row or rule of the table under test, or one environment adapter.

type AnyRow = HandoffRow<Snap, string>;
const rowsWith = (replace: Record<string, AnyRow | null>): Table => ({
  ...(HANDOFF_TABLE as unknown as Table),
  rows: (HANDOFF_TRANSITIONS as unknown as AnyRow[])
    .map((row) => (row.id in replace ? replace[row.id]! : row))
    .filter((row): row is AnyRow => row !== null),
});
const base = (id: string) =>
  (HANDOFF_TRANSITIONS as unknown as AnyRow[]).find((row) => row.id === id)!;

/** M1 (r6-1): the waiters of e stay on the pass and look up the invocation after it ends. */
const M1: Table = {
  ...rowsWith({
    T7: handoffRow('T7', 'reply', base('T7').guard as never, (draft) => {
      const cycle = draft.requireCycle();
      const entry = cycle.entry!;
      const invocation = cycle.posted!.identity.attemptId;
      delete draft.unresolved[entry];
      draft.live[entry] = invocation;
      draft.cyclePass().parkedOn = invocation;
      draft.endCycle();
      draft.emit({ kind: 'publish', entry, invocation });
    }) as unknown as AnyRow,
  }),
  callerResultAtPassEnd: (draft, pass, waiter, outcome, ownerEntry) =>
    waiter.entry !== null && draft.live[waiter.entry]
      ? { kind: 'join', entry: waiter.entry, invocation: draft.live[waiter.entry]! }
      : waiter.entry !== null && ownerEntry !== waiter.entry
        ? { kind: 'pass', outcome, started: [...pass.started] }
        : HANDOFF_TABLE.callerResultAtPassEnd(draft as never, pass, waiter, outcome, ownerEntry),
};

/** M2 (r6-2): a not-run reply on an unresolved claim deletes it and ends with the error. */
const M2 = rowsWith({
  T11: handoffRow('T11', 'reply', base('T11').guard as never, (draft, event) => {
    const cycle = draft.requireCycle();
    delete draft.unresolved[cycle.entry!];
    draft.releaseCycleHandle();
    draft.endPass(
      cycle.pass,
      {
        kind: 'failed',
        entry: cycle.entry,
        stage: 'post',
        cause: (event as { cause?: unknown }).cause,
      },
      cycle.entry
    );
  }) as unknown as AnyRow,
});

/** M3 (r6-3): a replay with the retained identity is posted without the budget debit. */
const M3 = rowsWith({
  T6: handoffRow(
    'T6',
    'selected',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      event.selection.kind === 'claim' &&
      (event.selection.retained || record.passes[record.cycle.pass]!.posts < record.budget),
    (draft, event) => {
      const selection = event.selection as Extract<typeof event.selection, { kind: 'claim' }>;
      const cycle = draft.requireCycle();
      if (!selection.retained) draft.cyclePass().posts += 1;
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
  ) as unknown as AnyRow,
  T6b: handoffRow(
    'T6b',
    'selected',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      event.selection.kind === 'claim' &&
      !event.selection.retained &&
      record.passes[record.cycle.pass]!.posts >= record.budget,
    base('T6b').apply as never
  ) as unknown as AnyRow,
});

/** M4 (r6-4): the thaw release edge emits no wake. */
const M4 = rowsWith({
  T19: handoffRow(
    'T19',
    'released',
    () => true,
    (draft, event) => {
      if (event.hold === 'frozen-workspace') return;
      base('T19').apply(draft as never, event as never);
    }
  ) as unknown as AnyRow,
});

/** Control 1: the success path loses its budget check, at the T15 resume and at the T6 issuance. */
const C1 = rowsWith({
  T15: handoffRow('T15', 'submitted', base('T15').guard as never, (draft, event) => {
    const pass = Object.values(draft.passes).find(
      (candidate) => candidate.parkedOn === event.invocation
    )!;
    pass.parkedOn = null;
    pass.started.push(event.turn as never);
    pass.dispatched += 1;
    draft.resume(pass.id, false);
  }) as unknown as AnyRow,
  T6: handoffRow(
    'T6',
    'selected',
    (record, event) => record.cycle?.stage === 'select' && event.selection.kind === 'claim',
    base('T6').apply as never
  ) as unknown as AnyRow,
  T6b: null,
});

/** Control 1 alone at resume: the issuance guard of T6 still holds the budget. */
const C1_RESUME_ONLY = rowsWith({ T15: C1.rows.find((row) => row.id === 'T15')! });

/** Control 2: a wake-only pass ignores the busy set. */
const C2: Table = {
  ...(HANDOFF_TABLE as unknown as Table),
  selectEffect: (draft, cycle, pass) => ({
    ...(HANDOFF_TABLE.selectEffect(draft as never, cycle, pass) as SelectEffect),
    skipBusy: false,
  }),
};

/** A2 take-out: a no-row claim takes the immediate replay ahead of the walk. */
const A2_NO_ROW_REPLAY = UNRESOLVED_DISPOSITION.map((row) =>
  row.disposition === 'immediate-replay'
    ? {
        ...row,
        when: (r: Parameters<typeof row.when>[0]) =>
          r.replayAfterUnknown && r.row !== 'other' && r.checksPass,
      }
    : row
);

/** Inspection take-out: T14r is removed, so a failed inspection ends on T14 with the raw error. */
const NO_T14R = rowsWith({
  T14: handoffRow(
    'T14',
    'failed',
    (record, event) => record.cycle !== null && record.cycle.stage === event.stage,
    base('T14').apply as never
  ) as unknown as AnyRow,
  T14r: null,
});

/** The pre-delta T14r: classified by the cycle history instead of the failed inspections. */
const T14R_BY_HISTORY = rowsWith({
  T14: handoffRow(
    'T14',
    'failed',
    (record, event) =>
      record.cycle !== null &&
      record.cycle.stage === event.stage &&
      !(
        event.stage === 'select' &&
        (record.cycle.reselected || record.cycle.barrierProof !== null)
      ),
    base('T14').apply as never
  ) as unknown as AnyRow,
  T14r: handoffRow(
    'T14r',
    'failed',
    (record, event) =>
      record.cycle?.stage === 'select' &&
      event.stage === 'select' &&
      (record.cycle.reselected || record.cycle.barrierProof !== null),
    (draft, event) => {
      const cycle = draft.requireCycle();
      const inspected = cycle.barrierProof ?? [...Object.keys(draft.unresolved)];
      base('T14r').apply(draft as never, { ...event, inspections: inspected } as never);
    }
  ) as unknown as AnyRow,
});

/** T9r take-out: a final refusal of the retained identity ends the pass as a new one does. */
const NO_T9R = rowsWith({
  T9: handoffRow(
    'T9',
    'reply',
    (record, event) => record.cycle?.stage === 'post' && event.replyClass === 'refused-final',
    base('T9').apply as never
  ) as unknown as AnyRow,
  T9r: null,
});

/** I10 take-outs: no row accepts a second submission callback, or a settlement of a retired invocation. */
const NO_T16 = rowsWith({ T16: null });
const NO_T18S = rowsWith({ T18s: null });

/** I8 take-out: T11 drops the cycle handle without the `release` effect. */
const T11_NO_RELEASE = rowsWith({
  T11: handoffRow('T11', 'reply', base('T11').guard as never, (draft, event) => {
    draft.requireCycle().handle = false;
    base('T11').apply(draft as never, event as never);
  }) as unknown as AnyRow,
});

/** The superseded capacity rule: any dispatched settlement empties the busy set. */
const EMPTY_BUSY_ON_DISPATCH = rowsWith({
  T18: handoffRow('T18', 'settled', base('T18').guard as never, (draft, event) => {
    base('T18').apply(draft as never, event as never);
    if ((event as { outcome: string }).outcome === 'dispatched')
      for (const entry of Object.keys(draft.busy)) delete draft.busy[entry];
  }) as unknown as AnyRow,
});

/** The superseded R3 rule: a dispatched or failed settlement releases the backend marks. */
const clearOnSettlement = (id: 'T17' | 'T18') =>
  handoffRow(id, 'settled', base(id).guard as never, (draft, event) => {
    const outcome = (event as { outcome: string }).outcome;
    if (outcome === 'dispatched' || outcome === 'failed')
      for (const entry of Object.keys(draft.busy))
        if (draft.busy[entry]!.kind === 'backend') {
          delete draft.busy[entry];
          draft.holdObserved = true;
        }
    base(id).apply(draft as never, event as never);
  }) as unknown as AnyRow;
const CLEAR_ON_SETTLEMENT = rowsWith({
  T17: clearOnSettlement('T17'),
  T18: clearOnSettlement('T18'),
});

// ---------------------------------------------------------------------------------------------
// Worlds. Entries b and c overlap on one Workspace and Thread; d is disjoint. FIFO is b, c, d.

const B = { id: 'b', ws: 'w1', thread: 't1' } as const;
const C = { id: 'c', ws: 'w1', thread: 't1' } as const;
const D = { id: 'd', ws: 'w2', thread: 't2' } as const;

export const WORLDS = {
  /** Two keyed callers, unknown replies, a late writer, a failed barrier and a configuration change. */
  identity: {
    name: 'identity',
    entries: [C, D],
    callers: [
      { id: 'x', entry: 'c', max: 1 },
      { id: 'y', entry: 'd', max: 1 },
    ],
    faults: { reply: 2, barrier: 1 },
    owner: ['config'],
  },
  /** Two keyed callers plus the unkeyed timer, with one ambiguous reply. */
  callers: {
    name: 'callers',
    entries: [C, D],
    callers: [
      { id: 'x', entry: 'c', max: 1 },
      { id: 'y', entry: 'd', max: 2 },
    ],
    timer: 1,
    faults: { reply: 1 },
  },
  /** M1: the keyed caller of C while the same pass claims disjoint D; T18s: a late second settlement. */
  exactCaller: {
    name: 'exact-caller',
    entries: [C, D],
    callers: [
      { id: 'x', entry: 'c', max: 2 },
      { id: 'u', entry: null, max: 2 },
    ],
    faults: { settle: 1, duplicate: 1 },
    callbacks: 2,
  },
  /** M2: a not-run inspection after an unknown create; T9 and T9r: a final authority refusal. */
  notRun: {
    name: 'not-run',
    entries: [C],
    callers: [{ id: 'x', entry: 'c', max: 1 }],
    faults: { reply: 2, authority: 1 },
  },
  /** M3 and control 1: placement refusals, then claims and submissions under budget 3. */
  budget: {
    name: 'budget',
    entries: [C, D],
    foreignHold: 'w1/t1',
    callers: [{ id: 'u', entry: null, max: 2 }],
    faults: { reply: 1 },
    owner: ['foreign'],
  },
  /** M4: a frozen Workspace that two overlapping entries share, a disjoint entry, and the timer off. */
  holds: {
    name: 'holds',
    entries: [B, C, D],
    frozen: ['w1'],
    callers: [{ id: 'u', entry: null, max: 2 }],
    owner: ['thaw:w1'],
  },
  /** A skip followed by a denial, and a pause turned away. */
  denial: {
    name: 'denial',
    entries: [
      { ...B, published: false },
      { ...D, deniable: true },
    ],
    paused: true,
    callers: [
      { id: 'x', entry: 'd', max: 1 },
      { id: 'u', entry: null, max: 2 },
    ],
    owner: ['unpause', 'publish:b'],
  },
  /** Control 2 and D2: C's original Login close holds its Thread; D settles or fails; timer and intake held. */
  capacity: {
    name: 'capacity',
    entries: [C, { ...D, published: false }],
    loginHeld: ['w1/t1'],
    callers: [{ id: 'u', entry: null, max: 3 }],
    owner: ['login:w1/t1', 'publish:d'],
    faults: { settle: 1 },
  },
  /**
   * R3: the backend refuses C with no Turn (RuntimeTarget not ready) and on its full Harness h2.
   * Timer and intake held. With no identity cut this world and the next one are split from one
   * world that went past the state bound; together they keep every R3 schedule.
   */
  backendCapacity: {
    name: 'backend-capacity',
    entries: [{ ...C, harness: 'h2' }],
    targetUnready: true,
    sessionsFull: ['h2'],
    callers: [{ id: 'u', entry: null, max: 3 }],
    owner: ['target', 'sessions:h2'],
  },
  /** R3: the backend refuses C on its full Harness h2 while D settles on h1. Timer and intake held. */
  backendCapacitySettlement: {
    name: 'backend-capacity-settlement',
    entries: [
      { ...C, harness: 'h2' },
      { ...D, published: false },
    ],
    sessionsFull: ['h2'],
    callers: [{ id: 'u', entry: null, max: 3 }],
    owner: ['sessions:h2', 'publish:d'],
  },
  /** R3: a failed Turn after its ACK leaves its Core attempt closing; recovery closes it. */
  backendFence: {
    name: 'backend-fence',
    entries: [C, { ...D, published: false }],
    fenceOnFail: true,
    callers: [{ id: 'u', entry: null, max: 3 }],
    owner: ['publish:d'],
    faults: { settle: 1 },
  },
  /** A2: older B gains publication between C's uncommitted ambiguous post and the next selection. */
  order: {
    name: 'order',
    entries: [{ ...B, published: false }, C],
    callers: [
      { id: 'x', entry: 'c', max: 1 },
      { id: 'y', entry: 'b', max: 1 },
    ],
    faults: { reply: 1 },
    owner: ['publish:b'],
  },
  /** Inspection failures before the immediate replay and after an acknowledged barrier. */
  inspection: {
    name: 'inspection',
    entries: [C],
    callers: [
      { id: 'x', entry: 'c', max: 1 },
      { id: 'u', entry: null, max: 1 },
    ],
    timer: 1,
    faults: { reply: 1, inspect: 1, snapshot: 1 },
    owner: ['config'],
  },
  /** Round-3 delta: C inspected, then the walk throws on older B; and a fresh pass that throws reading C. */
  attribution: {
    name: 'attribution',
    entries: [{ ...B, published: false }, C],
    callers: [
      { id: 'x', entry: 'c', max: 1 },
      { id: 'y', entry: 'b', max: 1 },
    ],
    faults: { reply: 1, walk: 1, inspect: 1 },
    owner: ['publish:b'],
  },
} satisfies Record<string, World>;

const named = (report: ExploreReport) => Object.keys(report.traces).sort();

/** Optional evidence sink: set the variable to a file path to keep counts and shortest traces. */
const evidence: Record<string, unknown> = {};
const keep = (name: string, value: unknown) => {
  evidence[name] = value;
  const target = process.env.HANDOFF_EXPLORER_REPORT;
  if (target) writeFileSync(target, `${JSON.stringify(evidence, null, 1)}\n`);
};

describe('Main selection handoff model check', () => {
  const reports: ExploreReport[] = [];

  it.each(Object.values(WORLDS))(
    'the unmodified model holds every invariant in $name',
    (world) => {
      const report = explore(world, { maxStates: 400_000 });
      reports.push(report);
      expect(report.traces).toEqual({});
      expect(report.cycles).toBe(0);
      expect(report.states).toBeGreaterThan(10);
    },
    600_000
  );

  it('reports state and edge counts', () => {
    // The counts go into the step-2 report; the shape check keeps the test meaningful.
    for (const report of reports) expect(report.edges).toBeGreaterThanOrEqual(report.states - 1);
    keep(
      'counts',
      reports.map(({ traces: _traces, ...counts }) => counts)
    );
    const reached = new Set(reports.flatMap((report) => report.rows));
    const unreached = HANDOFF_TRANSITIONS.map((row) => row.id).filter((id) => !reached.has(id));
    keep('rows-unreached', unreached);
    // T6b is the issuance guard behind the resume budget check; control 1 reaches it.
    expect(unreached).toEqual(['T6b']);
    const schedules = Object.fromEntries(reports.map((report) => [report.world, report.schedules]));
    keep('schedules', schedules);
    // R3: every backend refusal schedule is in the gate, with a release on either side of enqueue.
    expect([
      ...schedules['backend-capacity']!,
      ...schedules['backend-capacity-settlement']!,
    ]).toEqual(
      expect.arrayContaining([
        'unready-zero-turns',
        'kept-at-settlement',
        'kept-at-target',
        'cleared-at-target',
        'cleared-at-sessions',
        'release-before-enqueue',
      ])
    );
    expect(schedules['backend-fence']).toEqual(
      expect.arrayContaining(['fence-closing', 'cleared-at-recovery', 'release-before-enqueue'])
    );
    expect(schedules.capacity).toEqual(
      expect.arrayContaining(['login-release-after-enqueue', 'login-release-before-enqueue'])
    );
  });

  it('M1 fails I3 when a late lookup gives the caller of C the pass result', () => {
    const report = explore(WORLDS.exactCaller, { table: M1 });
    expect(named(report)).toContain('I3.exact-caller');
    const callers = explore(WORLDS.callers, { table: M1 });
    expect(named(callers)).toContain('I3.exact-caller');
    keep('M1', [report.traces['I3.exact-caller'], callers.traces['I3.exact-caller']]);
  }, 600_000);

  it('M2 fails I5 on the retained identity and on the typed recovery result', () => {
    const report = explore(WORLDS.notRun, { table: M2 });
    expect(named(report)).toEqual(
      expect.arrayContaining(['I5a.identity-lost', 'I5b.typed-recovery'])
    );
    keep('M2', [report.traces['I5a.identity-lost'], report.traces['I5b.typed-recovery']]);
  }, 600_000);

  it('M3 fails I2 when a replay is posted without the budget debit', () => {
    const report = explore(WORLDS.budget, { table: M3 });
    expect(named(report)).toContain('I2.budget');
    keep('M3', [report.traces['I2.budget']]);
  }, 600_000);

  it('M4 fails I6 when the thaw release emits no wake with the timer off', () => {
    const report = explore(WORLDS.holds, { table: M4 });
    expect(named(report)).toContain('I6.lost-wake');
    keep('M4', [report.traces['I6.lost-wake']]);
  }, 600_000);

  it('control 1 fails I2 when the success path posts a fourth time after refusal, refusal, claim and submit', () => {
    const report = explore(WORLDS.budget, { table: C1 });
    expect(named(report)).toContain('I2.budget');
    keep('C1', [report.traces['I2.budget']]);
    const resumeOnly = explore(WORLDS.budget, { table: C1_RESUME_ONLY });
    keep('C1-resume-only', { traces: named(resumeOnly), rows: resumeOnly.rows });
    // Without the resume check alone, the T6b issuance guard still holds the budget.
    expect(resumeOnly.traces).toEqual({});
    expect(resumeOnly.rows).toContain('T6b');
  }, 600_000);

  it('control 2 fails I7 when a wake-only pass claims a busy entry again', () => {
    const report = explore(WORLDS.capacity, { table: C2 });
    expect(named(report)).toContain('I7.busy-reclaim');
    keep('C2', [report.traces['I7.busy-reclaim']]);
  }, 600_000);

  it('D2: removing the Login close release edge strands C with the timer and intake held', () => {
    const report = explore(WORLDS.capacity, { envMutation: 'no-login-release' });
    expect(named(report)).toContain('I6.lost-wake');
    keep('D2', [report.traces['I6.lost-wake']]);
  }, 600_000);

  it('D2: a held fact read at the refusal instead of the queued settlement strands C', () => {
    const report = explore(WORLDS.capacity, { envMutation: 'stale-held-fact' });
    expect(named(report)).toContain('I6.lost-wake');
    keep('D2-E7', [report.traces['I6.lost-wake']]);
  }, 600_000);

  it('D2: the superseded empty-on-dispatch rule claims C again while its close holds', () => {
    const report = explore(WORLDS.capacity, { table: EMPTY_BUSY_ON_DISPATCH });
    expect(named(report)).toContain('I7.busy-reclaim');
    keep('D2-empty', [report.traces['I7.busy-reclaim']]);
  }, 600_000);

  it('R3: a backend mark released at a settlement claims C again while its owner still refuses it', () => {
    // An unrelated settlement on the same backend while the Harness of C stays full.
    const harness = explore(WORLDS.backendCapacitySettlement, { table: CLEAR_ON_SETTLEMENT });
    expect(named(harness)).toContain('I7.busy-reclaim');
    // A failed Turn whose Core attempt is still closing.
    const fence = explore(WORLDS.backendFence, { table: CLEAR_ON_SETTLEMENT });
    expect(named(fence)).toContain('I7.busy-reclaim');
    keep('R3-clear-on-settlement', [
      harness.traces['I7.busy-reclaim'],
      fence.traces['I7.busy-reclaim'],
    ]);
  }, 600_000);

  it('R3: a held fact read as Turn occupancy claims C again behind an unready target with zero Turns', () => {
    const report = explore(WORLDS.backendCapacity, { envMutation: 'turn-held-fact' });
    expect(named(report)).toContain('I7.busy-reclaim');
    keep('R3-turn-held-fact', [report.traces['I7.busy-reclaim']]);
  }, 600_000);

  it('A2: a no-row replay ahead of the walk claims C before older eligible B', () => {
    const report = explore(WORLDS.order, { readback: A2_NO_ROW_REPLAY });
    expect(named(report)).toContain('I11.order');
    keep('A2', [report.traces['I11.order']]);
  }, 600_000);

  it('inspection failure: without T14r the keyed caller of C gets a raw error', () => {
    const report = explore(WORLDS.inspection, { table: NO_T14R });
    expect(named(report)).toContain('I5b.typed-recovery');
    keep('R3-inspect', [report.traces['I5b.typed-recovery']]);
  }, 600_000);

  it('delta: T14r by cycle history gives B its cause to C, or C a raw error on a fresh pass', () => {
    const report = explore(WORLDS.attribution, { table: T14R_BY_HISTORY });
    expect(named(report)).toEqual(
      expect.arrayContaining(['I3.foreign-cause', 'I5b.typed-recovery'])
    );
    keep('delta', [report.traces['I3.foreign-cause'], report.traces['I5b.typed-recovery']]);
  }, 600_000);

  it('removing the barrier strands an uncommitted original of a changed proposal', () => {
    const report = explore(WORLDS.identity, { envMutation: 'no-barrier' });
    expect(named(report)).toContain('I5.stranded-unresolved');
    keep('no-barrier', [report.traces['I5.stranded-unresolved']]);
  }, 600_000);

  it('T9r: a final refusal of the retained replay that ends as a new one loses typed recovery', () => {
    const report = explore(WORLDS.notRun, { table: NO_T9R });
    expect(named(report)).toContain('I5b.typed-recovery');
    keep('T9r', [report.traces['I5b.typed-recovery']]);
  });

  it('I10: deleting T16 or T18s fails totality on a second callback or a late settlement', () => {
    const t16 = explore(WORLDS.exactCaller, { table: NO_T16 });
    expect(named(t16)).toContain('I10.totality');
    const t18s = explore(WORLDS.exactCaller, { table: NO_T18S });
    expect(named(t18s)).toContain('I10.totality');
    keep('I10', [t16.traces['I10.totality'], t18s.traces['I10.totality']]);
  }, 600_000);

  it('I8: T11 without release leaves an acquired handle with no owner', () => {
    const report = explore(WORLDS.notRun, { table: T11_NO_RELEASE });
    expect(named(report)).toContain('I8.handle-balance');
    keep('I8', [report.traces['I8.handle-balance']]);
  });

  it('the seeded runner skeleton replays fixed seeds with the same oracles', () => {
    for (const seed of [1, 2, 3, 4, 5])
      expect(runSeeded(WORLDS.identity, seed, 200).violations).toEqual([]);
  });
});
