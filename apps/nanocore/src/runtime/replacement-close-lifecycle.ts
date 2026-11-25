/**
 * Pure decision table for one local close of an idle predecessor binding. The rows follow the
 * NanoHost spec section "Replacement Close Lifecycle": boundaries RC1-RC14, the cold prefixes
 * P0-P8 and the Native fences PF. Each entry is the check of one deciding owner. Nothing here
 * performs an effect, reads a store or keeps a clock.
 *
 * `replacement-close-lifecycle.explorer.test.ts` checks it against an independent environment
 * model. CLOSE-LC S3 wires the owners to these entries: each owner gathers its facts and applies
 * the effect, and the entry here is the only decider.
 */

export type CloseClock = 'Tc' | 'Ts' | 'Ta';

export type CloseCause =
  | 'capacity'
  | 'pending-owner'
  | 'close-allowance'
  | 'startup-deadline'
  | 'authority-expired'
  /** Native refused the private deadline slot. Main answers the limiting clock instead. */
  | 'deadline'
  | 'request'
  | 'audience'
  | 'idle-proof'
  | 'storage'
  | 'placement'
  | 'latch'
  | 'sequence'
  | 'delivery'
  | 'transport';

/**
 * The position of a clock sample at one effect site. `after-reads`: after the last successful fact
 * read. `in-write`: inside the deciding write. `before-reads`: before a fact read; a take-out only.
 */
export type ClockSample = 'after-reads' | 'in-write' | 'before-reads';

/** Premises as the deciding owner reads them at its own mutation. */
export interface ClosePremises {
  /** The original pending owner still holds the admission-visible slots. */
  readonly pendingOwner: boolean;
  /**
   * R: the successor request is open, pre-submit and authorized. `expired`: the R reader refused an
   * elapsed credential cutoff (expired, or rotated past its grace). The read carries that clock to
   * the decision, so a later wall step back in the same gather cannot hide it (S3b H4-1).
   */
  readonly request: boolean | 'expired';
  /**
   * A: the Thread rows and the applied Workspace policy still admit the Thread. `thread: 'expired'`:
   * the P14 owner refused an elapsed Ts, and the read carries that clock (S3b H4-1).
   */
  readonly audience: { readonly thread: boolean | 'expired'; readonly policy: boolean };
  /** B: the exact Core idle receipt equals the carried receipt. */
  readonly idleReceipt: boolean;
  /** S: the selected storage revision is unchanged. */
  readonly storage: boolean;
  /** N: read from the Native owner facts, not from a copy. */
  readonly placement: PlacementFacts;
  /** X: the authenticated connection is current. */
  readonly connection: boolean;
  /** The original absolute wall deadline of each clock. */
  readonly deadlines: Readonly<Record<CloseClock, number>>;
  /**
   * The original enqueue wall instant: Main's lower Tc edge. A wall sample before it comes from a
   * wall step back, and no wall deadline can be read from it.
   */
  readonly admitted: number;
  /** The current wall instant. */
  readonly now: number;
  /** Tc on the monotonic clock. It is independent of the wall Tc. */
  readonly closeMonotonicExpired: boolean;
}

/** The clock facts. */
export type ClockPremises = Pick<
  ClosePremises,
  'deadlines' | 'admitted' | 'now' | 'closeMonotonicExpired'
>;

/** RC7 reads these facts only. Placement and storage are Native's at RC8, X is RC10's. */
export type PostPremises = ClockPremises &
  Pick<ClosePremises, 'pendingOwner' | 'request' | 'audience' | 'idleReceipt'>;

/** The facts that the Native placement selector reads (N:1415-1424). */
export interface PlacementFacts {
  readonly harness: 'open' | 'failed';
  readonly sandbox: SandboxFacts;
}

export interface HarnessFacts {
  readonly life: 'open' | 'failed';
  readonly drain: 'accepting' | 'draining';
  /** The strictly advancing claim revision (`updated_at`). */
  readonly revision: number;
  /**
   * The last operation of the cell. `other` stands for every kind that the Native queue admits on a
   * draining Harness. Only `session.open` and `turn.start` refuse a draining Harness (N:1348-1353).
   */
  readonly operation:
    | null
    | 'session.open'
    | 'turn.start'
    | 'session.close'
    | 'harness.drain'
    | 'other';
  readonly cell: 'idle' | 'queued' | 'dispatched' | 'settled' | 'unknown';
  readonly key: string | null;
  readonly sequence: number | null;
  readonly result: null | 'succeeded' | 'stale' | 'unknown';
  readonly nextSequence: number;
  /**
   * G3 (S3b, ENGINEER option A): the claim generation. RC3 writes a fresh identifier for each
   * acquisition in its claim CAS. It never recurs on a replay, a restart or a same-name
   * recreation. The queue transfers it with the row (RC8). An independent drain, a Native fence and
   * a retirement invalidate it (null). The exact scoped restore compares it and clears it. Null: no
   * claim of this lifecycle holds the row; a row from an older writer reads as null (legacy).
   */
  readonly claimGeneration: string | null;
}

/** RC8 reads these Harness facts only. */
export type QueueHarnessFacts = Pick<
  HarnessFacts,
  'life' | 'drain' | 'revision' | 'cell' | 'nextSequence'
>;

export interface SandboxFacts {
  readonly accepting: boolean;
  readonly clean: boolean;
  readonly currentEpoch: boolean;
}

export type CaptureState = 'none' | 'claimed' | 'raw' | 'receipt' | 'abandoned';

/**
 * The private restore frame (`sandbox.restore-admission`). It carries exactly one arm.
 * `claim`: `harness.claim {revision}`, the rollback of the frame's own claim before any queue
 * commit, and the cold quiescent exit. `close`: `harness.close`, the exact settled close key. Each
 * arm carries the claim generation that its claim wrote; a retry of the same restore carries the
 * same frame. Neither arm carries Sandbox rollback authority.
 */
export type RestoreFrame =
  | {
      readonly arm: 'claim';
      readonly revision: number;
      readonly generation: string | null;
    }
  | {
      readonly arm: 'close';
      readonly key: string;
      readonly revision: number;
      readonly generation: string | null;
    };

/** Ta: one absolute cutoff of one expiring credential that the admission requires. */
export interface CredentialCutoff {
  /**
   * `session`: the browser session. `presented`: the presented Token. `projected-admin`: the
   * session-projected admin Token. `admin-only`: the Token of the admin-only admission branch.
   * `issuer`: a Token of the bounded issuer traversal.
   */
  readonly credential: 'session' | 'presented' | 'projected-admin' | 'admin-only' | 'issuer';
  /** `expiresAt`, or the rotation grace cutoff while the Token is rotated. */
  readonly at: number;
}

export interface CloseKey {
  readonly binding: string;
  readonly key: string;
  readonly sequence: number;
}

export type FirstBytesDecision =
  | { readonly kind: 'write' }
  | { readonly kind: 'refuse'; readonly cause: CloseCause };

/** Facts that a cold reader rebuilds from the owners. Live claimants are never included. */
export interface ColdFacts {
  readonly sandbox: SandboxFacts;
  readonly harness: HarnessFacts;
  readonly bindings: readonly {
    readonly binding: string;
    readonly present: boolean;
    /** Undefined when the Workspace anchor is unreadable or missing. */
    readonly capture: CaptureState | undefined;
    /** The Core consumption, with the settle revision that Core retains for the close. */
    readonly consumed: null | {
      readonly key: string;
      readonly result: 'succeeded' | 'stale';
      readonly revision: number | null;
    };
  }[];
  /** A live owner in this process holds the Harness slot or posts on the Harness. */
  readonly liveProducer: boolean;
  /** The existing guard for a restore that is already held. */
  readonly restoreHeld: boolean;
}

export type ColdAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'recover-capture'; readonly binding: string }
  | { readonly kind: 'expire-key'; readonly key: string }
  | { readonly kind: 'complete-native-result'; readonly binding: string }
  | {
      readonly kind: 'restore';
      readonly scope: 'close' | 'quiescent';
      readonly frame: RestoreFrame;
    }
  | { readonly kind: 'fence'; readonly reason: ColdFence };

export type ColdFence =
  | 'held-restore'
  | 'sandbox'
  | 'native-fence'
  | 'harness-drain'
  | 'possible-contact'
  | 'result-bytes'
  | 'abandon'
  | 'unproved'
  | 'ambiguous-drain'
  | 'unattributed-claim'
  | 'legacy-claim'
  | 'live-producer';

export interface ReplacementCloseTable {
  /** RC2 pre-check in Main: the Harness exclusion, then the capacity read. */
  readonly admit: (input: {
    readonly exclusionHolder: string | null;
    readonly self: string;
    readonly harness: HarnessFacts;
    readonly sandbox: SandboxFacts;
  }) => CloseCause | null;
  /**
   * RC3: the Native claim CAS from accepting to draining. Returns the claim revision and the claim
   * generation that the CAS writes. `fresh` is the new identifier of this acquisition (G3).
   */
  readonly claim: (
    harness: HarnessFacts,
    sandbox: SandboxFacts,
    fresh: string
  ) => { readonly revision: number; readonly generation: string | null } | CloseCause;
  /** RC3 refusal after RC2: the Workspace no-source record stays at P1. */
  readonly losingClaimRecord: 'keep' | 'erase';
  /** RC6: how long the Core hold (R, B) and the successor Workspace hold (A) pin their premises. */
  readonly holdUntil: {
    readonly core: 'queue-reply' | 'post';
    readonly workspace: 'queue-reply' | 'post';
  };
  /**
   * RC6-RC8: the applied Workspace policy swap runs under the canonical Core posting hold. It
   * waits while a close holds it. Publication I/O and the lost-ACK inspection run outside it.
   */
  readonly policyOrder: 'core-hold' | 'none';
  /**
   * CL2 (S3a-r2): where each effect that a clock decides takes its clock sample. The clock can pass
   * or the wall can step back between any two fact reads of the effect, and between its last read
   * and the effect. So RC7 and RC10 sample after their last successful fact read, in the
   * synchronous run of the effect, and RC8 compares inside its deciding write.
   */
  readonly clockSample: Readonly<Record<'post' | 'queue' | 'firstBytes', ClockSample>>;
  /** Ta: the clock that Main folds from the cutoffs of the credentials that the admission requires. */
  readonly authorityDeadline: (cutoffs: readonly CredentialCutoff[]) => number;
  /** RC7, in the Main turn that posts the worker frame. */
  readonly post: (premises: PostPremises) => CloseCause | null;
  /** RC8: the clocks that Main folds into the existing private replacement deadline slot. */
  readonly deadlineSlot: readonly CloseClock[];
  /** RC8: the Native queue transaction. */
  readonly queue: (input: {
    readonly harness: QueueHarnessFacts;
    readonly claimRevision: number | null;
    readonly key: CloseKey;
    readonly slotExpired: boolean;
    readonly storage: boolean;
    readonly sandbox: SandboxFacts;
  }) => CloseCause | null;
  /**
   * When Main fixes the limiting clock of the slot: at the post, as the clock of the original
   * minimum that it folds into the slot, or at the reply, from the wall clock it reads then.
   */
  readonly slotClockAt: 'post' | 'reply';
  /** Main maps an acknowledged Native deadline refusal to the cause of the posted limiting clock. */
  readonly slotCause: (posted: CloseClock) => CloseCause;
  /** RC9: dispatch for one authenticated poll. A reserved cell refuses another poll. */
  readonly dispatch: (input: {
    readonly harness: HarnessFacts;
    readonly key: string;
    readonly reservedBy: string | null;
    readonly poll: string;
  }) => CloseCause | null;
  /** RC10: the synchronous recheck under the pins, then the write. */
  readonly firstBytes: (premises: ClosePremises) => FirstBytesDecision;
  /**
   * RC10 (S3b H4-2): the Ta that RC10 checks. `current`: the minimum of the posted Ta and the Ta
   * folded from the current cutoffs, because a rotation after the post can only shorten Ta (F
   * `recheck`). `posted`: the posted Ta alone; a take-out only.
   */
  readonly firstBytesAuthority: 'current' | 'posted';
  /** RC10 after the write starts: a transport failure keeps its own refusal. */
  readonly transportFailure: 'keep-dispatched' | 'settle-stale';
  /** After a possible handoff with no result: wait for the exact result or a fence. */
  readonly afterContact: 'wait' | 'settle-stale';
  /** A definite live refusal before any queue commit. */
  readonly definiteRefusal: 'release' | 'hold';
  /** A live refusal before the queue: roll the latch back through the restore CAS. */
  readonly liveRefusalLatch: 'restore' | 'keep';
  /** A lost RC8 reply: read back the original key before any decision. */
  readonly lostReply: 'readback' | 'noncommit';
  /** Proved absence of the original key after writer quiescence. */
  readonly absent: (harness: HarnessFacts, original: CloseKey) => boolean;
  /** RC12: the Native result writer settles only the exact dispatched key. */
  readonly settle: (harness: HarnessFacts, key: string) => boolean;
  /** RC13: the Native restore CAS on one restore frame. */
  readonly restore: (harness: HarnessFacts, sandbox: SandboxFacts, frame: RestoreFrame) => boolean;
  /** Occupancy change at a restore. Success decrements once, at RC12. */
  readonly restoreDecrement: number;
  /** Native queued expiry: whether it applies to the current cell. */
  readonly expiryApplies: (harness: HarnessFacts, target: string) => boolean;
  /** W: armed at the original deadline, independent of every writer reply. */
  readonly callerBound: 'original-deadline' | 'after-reply';
  /**
   * CL9: the refusal keeps its first structured cause through every catch. A cause is a close
   * cause or a structured refusal with its own re-check.
   */
  readonly carryCause: <C>(first: C, fallback: C) => C;
  /** RC14: the E7 request after a restore. */
  readonly e7: (input: {
    readonly changed: boolean;
    readonly site: 'rollback' | 'completion';
  }) => boolean;
  /** The cold `decide`. */
  readonly cold: (facts: ColdFacts) => ColdAction;
}

const CLOCK_CAUSE: Readonly<Record<CloseClock, CloseCause>> = {
  Tc: 'close-allowance',
  Ts: 'startup-deadline',
  Ta: 'authority-expired',
};

const CLOCKS: readonly CloseClock[] = ['Tc', 'Ts', 'Ta'];

const passed = (p: ClockPremises, clock: CloseClock) => p.deadlines[clock] <= p.now;

/**
 * The limiting clock: the earliest original wall deadline that has passed. When no wall deadline
 * has passed, only Tc can have failed: on the monotonic clock, or at its lower edge.
 */
export function limitingClock(p: ClockPremises): CloseClock {
  let limit: CloseClock | null = null;
  for (const clock of CLOCKS)
    if (passed(p, clock) && (limit === null || p.deadlines[clock] < p.deadlines[limit]))
      limit = clock;
  return limit ?? 'Tc';
}

/**
 * RC8: the clock whose original wall deadline is the minimum that Main folds into the private
 * slot. It reads no wall instant, so a later wall step back cannot change it.
 */
export function slotClock(
  deadlines: Readonly<Record<CloseClock, number>>,
  clocks: readonly CloseClock[] = CLOCKS
): CloseClock {
  let limit = clocks[0] ?? 'Tc';
  for (const clock of clocks) if (deadlines[clock] < deadlines[limit]) limit = clock;
  return limit;
}

/**
 * S3b H4-1: a clock that a fact read of this decision saw elapse. The R reader checks Ta, and the
 * P14 owner checks Ts. The wall can step back after that read and before the clock sample, so the
 * read carries the clock to the decision.
 */
const carriedExpiry = (p: PostPremises, clock: CloseClock) =>
  (clock === 'Ta' && p.request === 'expired') ||
  (clock === 'Ts' && p.audience.thread === 'expired');

/**
 * A clock refusal among the checked clocks, answered with the cause of the limiting clock. Tc fails
 * on its wall deadline, on the monotonic clock, and on a wall sample before the original enqueue
 * instant. Such a sample can hide each passed deadline, so Main refuses it as the lower Tc edge. A
 * clock fails also when a read of the decision carries its expiry (S3b H4-1). The limiting clock is
 * then the earliest original deadline among the failed clocks.
 */
function clockRefusal(p: PostPremises, checked: readonly CloseClock[]): CloseCause | null {
  const failed = checked.filter((clock) => passed(p, clock) || carriedExpiry(p, clock));
  const lowerEdge = checked.includes('Tc') && (p.closeMonotonicExpired || p.now < p.admitted);
  if (failed.length === 0 && !lowerEdge) return null;
  if (p.now < p.admitted) return CLOCK_CAUSE[limitingClock(p)];
  return CLOCK_CAUSE[slotClock(p.deadlines, failed.length > 0 ? failed : ['Tc'])];
}

export const placementOpen = (p: PlacementFacts) => p.harness === 'open' && sandboxOpen(p.sandbox);

/**
 * RC8, L: the queue transfers only the close's own claim. The Harness still drains, and its
 * revision is still the claim revision, so no later claim, queue, drain or restore wrote the row.
 * A close with no claim of its own (a replayed receipt) transfers nothing.
 */
export const transfersLatch = (
  harness: Pick<HarnessFacts, 'drain' | 'revision'>,
  claimRevision: number | null
) => claimRevision !== null && harness.drain === 'draining' && harness.revision === claimRevision;

/**
 * RC7: the original pending owner, every slot clock (Tc on both clocks and its lower edge, Ts, Ta),
 * R, A with the P14 cause, and B. The clocks come first: the P14 owner also refuses an elapsed Ts,
 * and the R reader an elapsed credential, so a known expired slot answers its own clock cause.
 */
export function decidePost(p: PostPremises): CloseCause | null {
  if (!p.pendingOwner) return 'pending-owner';
  const clock = clockRefusal(p, CLOCKS);
  if (clock) return clock;
  if (p.request !== true) return 'request';
  if (p.audience.thread !== true || !p.audience.policy) return 'audience';
  if (!p.idleReceipt) return 'idle-proof';
  return null;
}

/** RC10: every premise again, in the synchronous run that writes the first bytes. */
export function decideFirstBytes(p: ClosePremises): FirstBytesDecision {
  const refuse = (cause: CloseCause): FirstBytesDecision => ({ kind: 'refuse', cause });
  if (!p.connection) return refuse('delivery');
  if (!p.pendingOwner) return refuse('pending-owner');
  const clock = clockRefusal(p, CLOCKS);
  if (clock) return refuse(clock);
  if (p.request !== true) return refuse('request');
  if (!p.idleReceipt) return refuse('idle-proof');
  if (p.audience.thread !== true || !p.audience.policy) return refuse('audience');
  if (!p.storage) return refuse('storage');
  if (!placementOpen(p.placement)) return refuse('placement');
  return { kind: 'write' };
}

export const sandboxOpen = (s: SandboxFacts) => s.accepting && s.clean && s.currentEpoch;

/** The positive predicates of the existing scoped restore, without the revision. */
export function restorable(h: HarnessFacts, s: SandboxFacts): boolean {
  return (
    sandboxOpen(s) &&
    h.life === 'open' &&
    h.drain === 'draining' &&
    (h.cell === 'idle' || h.cell === 'settled') &&
    h.operation !== 'harness.drain' &&
    (h.operation !== 'session.close' ||
      h.cell === 'idle' ||
      h.result === 'succeeded' ||
      h.result === 'stale')
  );
}

/**
 * The cell's last operation proves that the current drain began after it. The Native queue refuses
 * `session.open` and `turn.start` on a draining Harness, and a `harness.drain` result is itself the
 * last operation until a later queue replaces it. Any other last operation can have replaced the
 * marker of a Harness-only drain (N:1892-1897), so it proves nothing about the drain.
 */
export function drainFollowsLastOperation(h: HarnessFacts): boolean {
  return (
    (h.cell === 'idle' && h.operation === null) ||
    (h.cell === 'settled' && (h.operation === 'session.open' || h.operation === 'turn.start'))
  );
}

/** One cold exit or fence. Rules run in order; the first that answers decides. */
export interface ColdRule {
  readonly id: string;
  readonly decide: (facts: ColdFacts) => ColdAction | undefined;
}

const closeOwner = (f: ColdFacts) =>
  f.bindings.find((b) => f.harness.key !== null && b.consumed?.key === f.harness.key);

/** The cold `decide`, in order: the held-restore guard, each prefix exit, then the fence. */
export const COLD_RULES: readonly ColdRule[] = [
  { id: 'held-restore', decide: (f) => (f.restoreHeld ? fence('held-restore') : undefined) },
  { id: 'live-producer', decide: (f) => (f.liveProducer ? fence('live-producer') : undefined) },
  {
    // P1/P2: Workspace recovers each unsettled capture by its original anchor first.
    id: 'recover-capture',
    decide: (f) => {
      const b = f.bindings.find((b) => b.capture === 'claimed' || b.capture === 'raw');
      return b ? { kind: 'recover-capture', binding: b.binding } : undefined;
    },
  },
  {
    id: 'accepting',
    decide: (f) => (f.harness.drain === 'accepting' ? { kind: 'none' } : undefined),
  },
  { id: 'sandbox', decide: (f) => (sandboxOpen(f.sandbox) ? undefined : fence('sandbox')) },
  {
    // PF: a Native fence keeps its own exit.
    id: 'native-fence',
    decide: (f) =>
      f.harness.life === 'failed' || f.harness.cell === 'unknown'
        ? fence('native-fence')
        : undefined,
  },
  {
    id: 'harness-drain',
    decide: (f) => (f.harness.operation === 'harness.drain' ? fence('harness-drain') : undefined),
  },
  {
    // P4: the exact queued key goes to Native expiry.
    id: 'p4-expire',
    decide: (f) =>
      f.harness.cell === 'queued' && f.harness.key !== null
        ? { kind: 'expire-key', key: f.harness.key }
        : undefined,
  },
  {
    // P6: a canonical local stale completes the Native result only.
    id: 'p6-stale',
    decide: (f) => {
      const owner = closeOwner(f);
      return f.harness.cell === 'dispatched' && owner?.consumed?.result === 'stale'
        ? { kind: 'complete-native-result', binding: owner.binding }
        : undefined;
    },
  },
  {
    id: 'p6-result',
    decide: (f) =>
      f.harness.cell === 'dispatched' && closeOwner(f)?.consumed?.result === 'succeeded'
        ? fence('result-bytes')
        : undefined,
  },
  // P5: possible contact.
  {
    id: 'p5',
    decide: (f) => (f.harness.cell === 'dispatched' ? fence('possible-contact') : undefined),
  },
  {
    // Every restore below needs every anchor, all settled and none abandoned. An older claim can
    // leave the revision and the settled cell unchanged (c1), so P7 alone cannot exclude it.
    id: 'anchors',
    decide: (f) =>
      f.bindings.some((b) => b.capture === undefined) ? fence('unproved') : undefined,
  },
  {
    id: 'abandon',
    decide: (f) =>
      f.bindings.some((b) => b.capture === 'abandoned') ? fence('abandon') : undefined,
  },
  {
    // P7: the close key and its settle revision prove that no later claim or write changed the
    // row. They do not prove that the claim found an accepting row. The older Native claims (c1,
    // r2) admit a draining row, so an independent drain under a settled close leaves the same
    // durable values as an ordinary cell reuse. No existing durable value tells them apart, so P7
    // fails closed. The live owner, whose claim refused a draining row, releases its own close.
    id: 'p7-success',
    decide: (f) => (settledCloseProof(f, 'succeeded') ? fence('unattributed-claim') : undefined),
  },
  {
    id: 'p7-stale',
    decide: (f) => (settledCloseProof(f, 'stale') ? fence('unattributed-claim') : undefined),
  },
  {
    // A drain with no open capture can be a Harness-only drain whose marker a later operation
    // replaced. Only an accepted capture that no close consumed is evidence of a capture claim.
    id: 'claim-evidence',
    decide: (f) =>
      f.bindings.some((b) => b.present && b.capture === 'receipt' && b.consumed === null)
        ? undefined
        : fence('unproved'),
  },
  {
    // Fail closed: without a claimant, only the last operation can exclude a replaced
    // Harness-only drain marker.
    id: 'drain-after-op',
    decide: (f) => (drainFollowsLastOperation(f.harness) ? undefined : fence('ambiguous-drain')),
  },
  {
    // G3: a row that no claim of this lifecycle holds carries no generation. An older writer's
    // claim reads as null, and its history stays ambiguous, so it stays fenced.
    id: 'legacy-claim',
    decide: (f) => (f.harness.claimGeneration === null ? fence('legacy-claim') : undefined),
  },
  {
    // Cold recovery pins the observed generation with the proofs above. Native compares the same
    // value at its commit.
    id: 'quiescent',
    decide: (f) =>
      restorable(f.harness, f.sandbox)
        ? {
            kind: 'restore',
            scope: 'quiescent',
            frame: {
              arm: 'claim',
              revision: f.harness.revision,
              generation: f.harness.claimGeneration,
            },
          }
        : undefined,
  },
];

function fence(reason: ColdFence): ColdAction {
  return { kind: 'fence', reason };
}

/** P7 positive predicates: the exact settled close and the settle revision that Core retains. */
export function settledCloseProof(f: ColdFacts, result: 'succeeded' | 'stale'): boolean {
  const h = f.harness;
  const consumed = closeOwner(f)?.consumed;
  return (
    h.cell === 'settled' &&
    h.operation === 'session.close' &&
    h.result === result &&
    consumed?.result === result &&
    consumed.revision === h.revision &&
    restorable(h, f.sandbox)
  );
}

/** Runs the rules in order. */
export function composeCold(rules: readonly ColdRule[]): (facts: ColdFacts) => ColdAction {
  return (facts) => {
    for (const rule of rules) {
      const action = rule.decide(facts);
      if (action) return action;
    }
    return fence('unproved');
  };
}

export const decideCold = composeCold(COLD_RULES);

/**
 * RC13 under G3: the exact scoped restore. The row must be restorable, at the frame's revision, and
 * hold the frame's claim generation. A null generation matches nothing, so the identifier alone
 * never grants a release and a legacy claim never matches. The close arm also needs the exact
 * settled close key. A commit clears the generation, so a second delivery of the same frame
 * changes no row.
 */
export function restoresFrame(h: HarnessFacts, s: SandboxFacts, frame: RestoreFrame): boolean {
  return (
    restorable(h, s) &&
    h.revision === frame.revision &&
    frame.generation !== null &&
    h.claimGeneration === frame.generation &&
    (frame.arm === 'claim' ||
      (h.cell === 'settled' && h.operation === 'session.close' && h.key === frame.key))
  );
}

export const REPLACEMENT_CLOSE_TABLE: ReplacementCloseTable = {
  admit: ({ exclusionHolder, self, harness, sandbox }) =>
    (exclusionHolder !== null && exclusionHolder !== self) ||
    harness.drain !== 'accepting' ||
    harness.life !== 'open' ||
    !sandboxOpen(sandbox)
      ? 'capacity'
      : null,
  claim: (harness, sandbox, fresh) =>
    harness.drain === 'accepting' && harness.life === 'open' && sandboxOpen(sandbox)
      ? { revision: harness.revision + 1, generation: fresh }
      : 'capacity',
  losingClaimRecord: 'keep',
  holdUntil: { core: 'queue-reply', workspace: 'queue-reply' },
  policyOrder: 'core-hold',
  clockSample: { post: 'after-reads', queue: 'in-write', firstBytes: 'after-reads' },
  authorityDeadline: (cutoffs) =>
    cutoffs.reduce((earliest, cutoff) => Math.min(earliest, cutoff.at), Number.POSITIVE_INFINITY),
  post: decidePost,
  deadlineSlot: ['Tc', 'Ts', 'Ta'],
  queue: ({ harness, claimRevision, key, slotExpired, storage, sandbox }) => {
    if (slotExpired) return 'deadline';
    if (!storage) return 'storage';
    if (!placementOpen({ harness: harness.life, sandbox })) return 'placement';
    if (!transfersLatch(harness, claimRevision)) return 'latch';
    if (
      (harness.cell !== 'idle' && harness.cell !== 'settled') ||
      harness.nextSequence !== key.sequence
    )
      return 'sequence';
    return null;
  },
  slotClockAt: 'post',
  slotCause: (posted) => CLOCK_CAUSE[posted],
  dispatch: ({ harness, key, reservedBy, poll }) =>
    harness.cell === 'queued' && harness.key === key
      ? null
      : harness.cell === 'dispatched' && harness.key === key && reservedBy === poll
        ? null
        : 'delivery',
  firstBytes: decideFirstBytes,
  firstBytesAuthority: 'current',
  transportFailure: 'keep-dispatched',
  afterContact: 'wait',
  definiteRefusal: 'release',
  liveRefusalLatch: 'restore',
  lostReply: 'readback',
  absent: (harness, original) =>
    harness.key === original.key
      ? false
      : harness.cell === 'unknown'
        ? false
        : harness.nextSequence === original.sequence
          ? harness.cell === 'idle' || harness.cell === 'settled'
          : harness.sequence === original.sequence && harness.key !== null,
  settle: (harness, key) => harness.cell === 'dispatched' && harness.key === key,
  restore: restoresFrame,
  restoreDecrement: 0,
  expiryApplies: (harness, target) => harness.cell === 'queued' && harness.key === target,
  callerBound: 'original-deadline',
  carryCause: (first) => first,
  e7: ({ changed }) => changed,
  cold: decideCold,
};
