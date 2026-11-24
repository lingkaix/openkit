import { describe, expect, it } from 'vitest';
import {
  classifyClaimReply,
  classifyUnresolvedReadback,
  createHandoffRecord,
  decideHandoff,
  HANDOFF_TRANSITIONS,
  type HandoffEvent,
  type HandoffReadback,
  type HandoffRecord,
  HandoffTransitionError,
  MAIN_HOLD_EXITS,
} from './scheduler-dispatch-handoff.js';

type Snap = { readonly configVersion: number };
type Rec = HandoffRecord<Snap, string>;

const trigger = (
  caller: string,
  entry: string | null,
  max = 1,
  source: 'external' | 'wake' = 'external'
) => ({ kind: 'trigger', caller, entry, snapshot: { configVersion: 1 }, max, source }) as const;
const identity = (attemptId: string) => ({ attemptId, inputHash: 'h', preparationDigest: 'p' });
const claim = (entry: string, attemptId: string, retained = false) =>
  ({
    kind: 'selected',
    selection: { kind: 'claim', entry, identity: identity(attemptId), retained },
    skipped: [],
    discharged: [],
    recovered: [],
  }) as const;

function run(events: readonly HandoffEvent<Snap, string>[], record: Rec = createHandoffRecord(3)) {
  const effects = [];
  const rows = [];
  let current = record;
  for (const event of events) {
    const decision = decideHandoff(current, event);
    current = decision.record;
    rows.push(decision.row);
    effects.push(...decision.effects);
  }
  return { record: current, effects, rows };
}

describe('claim reply classes', () => {
  it('derives the class from the stage and the outcome only', () => {
    expect(classifyClaimReply({ kind: 'attempt', openWithoutProgress: true })).toBe('claimed');
    expect(classifyClaimReply({ kind: 'attempt', openWithoutProgress: false })).toBe(
      'stale-original'
    );
    expect(classifyClaimReply({ kind: 'refusal', reason: 'placement-held' })).toBe(
      'refused-rescan'
    );
    expect(classifyClaimReply({ kind: 'refusal', reason: 'selection-changed' })).toBe(
      'refused-rescan'
    );
    expect(classifyClaimReply({ kind: 'refusal', reason: null })).toBe('refused-final');
    expect(classifyClaimReply({ kind: 'error', stage: 'open', commit: 'unknown' })).toBe('not-run');
    expect(classifyClaimReply({ kind: 'error', stage: 'prepare', commit: 'untyped' })).toBe(
      'not-run'
    );
    expect(classifyClaimReply({ kind: 'error', stage: 'create', commit: 'not-committed' })).toBe(
      'not-run'
    );
    expect(classifyClaimReply({ kind: 'error', stage: 'create', commit: 'unknown' })).toBe(
      'unknown'
    );
    expect(classifyClaimReply({ kind: 'error', stage: 'create', commit: 'untyped' })).toBe(
      'unknown'
    );
  });
});

describe('unresolved claim readback', () => {
  const readback = (overrides: Partial<HandoffReadback>): HandoffReadback => ({
    replayAfterUnknown: false,
    row: 'none',
    checksPass: true,
    proofCovers: false,
    queued: true,
    walkCandidate: 'pending',
    sameDigest: true,
    barrierAllowed: true,
    ...overrides,
  });

  it('replays ahead of the walk only for an exact committed row that passes the current checks', () => {
    expect(classifyUnresolvedReadback(readback({ replayAfterUnknown: true, row: 'exact' }))).toBe(
      'immediate-replay'
    );
    expect(classifyUnresolvedReadback(readback({ replayAfterUnknown: true, row: 'none' }))).toBe(
      'walk'
    );
    expect(
      classifyUnresolvedReadback(
        readback({ replayAfterUnknown: true, row: 'exact', checksPass: false })
      )
    ).toBe('discharge-recovery');
  });

  it('holds another tuple, discharges only with a barrier proof, and bounds the barrier', () => {
    expect(classifyUnresolvedReadback(readback({ row: 'other' }))).toBe('integrity-hold');
    expect(classifyUnresolvedReadback(readback({ proofCovers: true }))).toBe('discharge');
    expect(classifyUnresolvedReadback(readback({ walkCandidate: 'yes' }))).toBe('replay');
    expect(classifyUnresolvedReadback(readback({ walkCandidate: 'yes', sameDigest: false }))).toBe(
      'barrier'
    );
    expect(classifyUnresolvedReadback(readback({ queued: false }))).toBe('barrier');
    expect(classifyUnresolvedReadback(readback({ queued: false, barrierAllowed: false }))).toBe(
      'hold'
    );
    expect(
      classifyUnresolvedReadback(
        readback({ walkCandidate: 'yes', sameDigest: false, barrierAllowed: false })
      )
    ).toBe('hold');
  });
});

describe('handoff transitions', () => {
  it('covers each hold with an exit and an owner', () => {
    expect(Object.keys(MAIN_HOLD_EXITS).sort()).toEqual([
      'active-preparation',
      'agent-work-paused',
      'backend-capacity',
      'frozen-workspace',
      'local-invocation',
      'publication-pending',
      'scope-not-admitted',
      'unresolved-claim',
      'writer-unavailable',
    ]);
    expect(HANDOFF_TRANSITIONS.map((row) => row.id)).toEqual([
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'T6b',
      'T7',
      'T8',
      'T9',
      'T9r',
      'T10',
      'T11',
      'T12',
      'T13',
      'T14',
      'T14r',
      'T15',
      'T16',
      'T17',
      'T18',
      'T18s',
      'T19',
      'T20',
      'T21',
      'T22',
    ]);
  });

  it('refuses an event that no row accepts instead of guessing', () => {
    expect(() =>
      decideHandoff(createHandoffRecord<Snap, string>(3), { kind: 'denied', denial: null })
    ).toThrow(HandoffTransitionError);
  });

  it('coalesces triggers into one fresh pass with the newest snapshot and the largest count', () => {
    const { record, effects } = run([
      trigger('a', null, 1),
      { ...trigger('b', null, 2), snapshot: { configVersion: 5 } },
      { ...trigger('c', null, 1), snapshot: { configVersion: 3 } },
    ]);
    expect(record.ready).toEqual([2]);
    expect(record.passes[2]).toMatchObject({ max: 2, begun: false, wakeOnly: false });
    expect(record.snapshot).toEqual({ configVersion: 5 });
    expect(effects.filter((effect) => effect.kind === 'select')).toHaveLength(1);
  });

  it('gives the keyed caller its exact invocation at publication and ends a pass left without waiters', () => {
    const { record, effects, rows } = run([
      trigger('x', 'c'),
      claim('c', 'c#1'),
      { kind: 'reply', replyClass: 'claimed' },
      { kind: 'submitted', invocation: 'c#1', turn: 'turn-c' },
    ]);
    expect(rows).toEqual(['T2', 'T6', 'T7', 'T15']);
    expect(effects).toContainEqual({
      kind: 'resolve',
      caller: 'x',
      result: { kind: 'join', entry: 'c', invocation: 'c#1' },
    });
    expect(record.passes).toEqual({});
    expect(record.live).toEqual({ c: 'c#1' });
  });

  it('keeps the first unknown identity and gives typed recovery when the retry cannot run', () => {
    const { record, effects, rows } = run([
      trigger('x', 'c'),
      claim('c', 'c#1'),
      { kind: 'reply', replyClass: 'unknown' },
      claim('c', 'c#1', true),
      { kind: 'reply', replyClass: 'not-run', cause: 'writer lost' },
    ]);
    expect(rows).toEqual(['T2', 'T6', 'T12', 'T6', 'T11']);
    expect(record.unresolved.c).toEqual(identity('c#1'));
    expect(effects).toContainEqual({
      kind: 'resolve',
      caller: 'x',
      result: {
        kind: 'entry',
        entry: 'c',
        outcome: { kind: 'queued', reason: 'recovery-required' },
      },
    });
  });

  it('attributes a failed inspection to its claim and a walk failure to its entry', () => {
    const unknown = run([
      trigger('x', 'c'),
      trigger('y', 'b'),
      claim('c', 'c#1'),
      { kind: 'reply', replyClass: 'unknown' },
    ]);
    const inspection = run(
      [{ kind: 'failed', stage: 'select', entry: 'c', cause: 'read', inspections: ['c'] }],
      unknown.record
    );
    expect(inspection.rows).toEqual(['T14r']);
    expect(inspection.record.unresolved.c).toMatchObject({ attemptId: 'c#1', cause: 'read' });
    expect(inspection.effects).toContainEqual({
      kind: 'resolve',
      caller: 'x',
      result: {
        kind: 'entry',
        entry: 'c',
        outcome: { kind: 'queued', reason: 'recovery-required', cause: 'read' },
      },
    });
    const walk = run(
      [{ kind: 'failed', stage: 'select', entry: 'b', cause: 'walk', inspections: [] }],
      unknown.record
    );
    expect(walk.rows).toEqual(['T14']);
    // The caller of B registered on the next fresh pass; the failed pass gives C no foreign error.
    expect(walk.record.waiters.y).toEqual({ pass: 2, entry: 'b' });
    expect(walk.effects).toContainEqual({
      kind: 'resolve',
      caller: 'x',
      result: {
        kind: 'entry',
        entry: 'c',
        outcome: { kind: 'queued', reason: 'recovery-required' },
      },
    });
  });

  it('releases a Login close busy mark only at its own key and requests one scan', () => {
    const busy = run([
      trigger('u', null, 3),
      claim('c', 'c#1'),
      { kind: 'reply', replyClass: 'claimed' },
      {
        kind: 'settled',
        entry: 'c',
        invocation: 'c#1',
        outcome: 'backend-busy',
        capacity: { key: { kind: 'login-close', workspaceId: 'w1', threadId: 't1' }, held: true },
      },
    ]);
    expect(busy.record.busy.c).toEqual({ kind: 'login-close', workspaceId: 'w1', threadId: 't1' });
    const other = run(
      [
        {
          kind: 'released',
          hold: 'backend-capacity',
          key: { kind: 'login-close', workspaceId: 'w1', threadId: 't2' },
        },
      ],
      busy.record
    );
    expect(other.record.busy.c).toBeDefined();
    expect(other.effects).toEqual([]);
    const own = run(
      [
        {
          kind: 'released',
          hold: 'backend-capacity',
          key: { kind: 'login-close', workspaceId: 'w1', threadId: 't1' },
        },
      ],
      busy.record
    );
    expect(own.record.busy).toEqual({});
    expect(own.effects).toEqual([{ kind: 'wake' }]);
  });

  it('keeps a backend busy mark until its owner names the entry as read clear', () => {
    const backend = { kind: 'backend', backendId: 'nh' } as const;
    const busy = run([
      trigger('u', null, 3),
      claim('c', 'c#1'),
      { kind: 'reply', replyClass: 'claimed' },
      {
        kind: 'settled',
        entry: 'c',
        invocation: 'c#1',
        outcome: 'backend-busy',
        capacity: { key: backend, held: true },
      },
    ]);
    expect(busy.record.busy.c).toEqual(backend);
    const unproved = run(
      [
        { kind: 'released', hold: 'backend-capacity', key: backend },
        { kind: 'released', hold: 'backend-capacity', key: backend, cleared: ['d'] },
      ],
      busy.record
    );
    expect(unproved.record.busy.c).toEqual(backend);
    expect(unproved.effects).toEqual([]);
    const proved = run(
      [{ kind: 'released', hold: 'backend-capacity', key: backend, cleared: ['c'] }],
      busy.record
    );
    expect(proved.record.busy).toEqual({});
    expect(proved.effects).toEqual([{ kind: 'wake' }]);
  });
});
