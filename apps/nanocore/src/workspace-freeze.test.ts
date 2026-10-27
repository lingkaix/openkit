import * as schemas from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const workspaceId = allocateEntityId('ws');
const siblingId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const turnBlocker = {
  kind: 'turn' as const,
  reason: 'active-work' as const,
  reference: { threadId, turnId },
  actions: [],
};
const unavailable = {
  kind: 'unavailable' as const,
  reason: 'unavailable' as const,
  actions: [],
};

/** R2947 freeze admission and brief 13j require synchronous refusal, not draining live work. */
describe('Workspace freeze admission', () => {
  it('characterizes close as waiting for an admitted mutation', async () => {
    const gate = new WorkspaceMutationAdmission();
    const releaseMutation = gate.enter(workspaceId);
    let settled = false;
    const closed = gate.close(workspaceId).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gate.enter(workspaceId)).toBeNull();
    releaseMutation!();
    await closed;
    expect(settled).toBe(true);
    gate.reopen(workspaceId);
  });

  it('refuses an admitted mutation immediately without checking blockers or fencing later work', () => {
    const gate = new WorkspaceMutationAdmission();
    const releaseMutation = gate.enter(workspaceId);
    const readBlockers = vi.fn(() => []);
    expect(gate.tryFreeze(workspaceId, readBlockers)).toEqual({ status: 'busy' });
    expect(readBlockers).not.toHaveBeenCalled();
    expect(gate.isClosed(workspaceId)).toBe(false);
    const releaseNext = gate.enter(workspaceId);
    expect(releaseNext).toBeTypeOf('function');
    releaseNext!();
    releaseMutation!();
  });

  it('fences racing publishers before authoritative inspection and keeps siblings open until release', () => {
    const gate = new WorkspaceMutationAdmission();
    const frozen = gate.tryFreeze(workspaceId, () => {
      expect(gate.enter(workspaceId)).toBeNull();
      expect(gate.enterLatePublisher(workspaceId, 'worker-turn-closeout')).toBeNull();
      const releaseSibling = gate.enter(siblingId);
      expect(releaseSibling).toBeTypeOf('function');
      releaseSibling!();
      return [];
    });
    expect(frozen.status).toBe('frozen');
    const readAgain = vi.fn(() => []);
    expect(gate.tryFreeze(workspaceId, readAgain)).toEqual({ status: 'busy' });
    expect(readAgain).not.toHaveBeenCalled();
    expect(gate.enter(workspaceId)).toBeNull();
    if (frozen.status !== 'frozen') throw new Error('Expected an admitted freeze.');
    frozen.release();
    frozen.release();
    const releaseNext = gate.enterLatePublisher(workspaceId, 'worker-turn-closeout');
    expect(releaseNext).toBeTypeOf('function');
    releaseNext!();
  });

  it('returns every authoritative blocker and reopens a refused freeze', () => {
    const gate = new WorkspaceMutationAdmission();
    const blockers = [turnBlocker, unavailable];
    expect(gate.tryFreeze(workspaceId, () => blockers)).toEqual({ status: 'blocked', blockers });
    expect(gate.isClosed(workspaceId)).toBe(false);
    const releaseMutation = gate.enter(workspaceId);
    expect(releaseMutation).toBeTypeOf('function');
    releaseMutation!();
  });

  it('fails closed on unreadable blocker facts without exposing the exception or retaining the fence', () => {
    const gate = new WorkspaceMutationAdmission();
    expect(
      gate.tryFreeze(workspaceId, () => {
        throw new Error('Private inspection data must not enter the refusal.');
      })
    ).toEqual({ status: 'blocked', blockers: [unavailable] });
    const releaseMutation = gate.enter(workspaceId);
    expect(releaseMutation).toBeTypeOf('function');
    releaseMutation!();
  });
});

/** R2947 public blocker contract owns these wire predicates; the schema grants no authority. */
describe('Workspace freeze public contract', () => {
  const snapshotBlocker = { kind: 'snapshot', reason: 'pending-publication', actions: [] };
  const refusal = {
    workspaceId,
    operation: 'capture',
    retryable: false,
    blockers: [turnBlocker, unavailable],
  } as const;

  it('preserves complete blocker references and an exact existing Turn action', () => {
    const action = {
      operationId: 'turn.interrupt',
      input: {
        workspaceId,
        threadId,
        turnId,
        requestId: '0a37c5a6-6df4-4bcf-a714-09e42e4e8bd2',
      },
    };
    const value = {
      ...refusal,
      blockers: [
        { ...turnBlocker, actions: [action] },
        {
          kind: 'worker-attempt',
          reason: 'active-work',
          // The attempt owner retains prelaunch work before an AgentSession exists.
          reference: {
            attemptId: allocateEntityId('attempt'),
            threadId,
            turnId,
            agentSessionId: null,
          },
          actions: [],
        },
        { ...snapshotBlocker, reference: { backupId: allocateEntityId('wsbak') } },
        {
          ...snapshotBlocker,
          reference: { recoveryRequestId: '377fbf66-2438-4029-9cf8-d14de349efbc' },
        },
        unavailable,
      ],
    };
    expect(schemas.WorkspaceFreezeRefusalSchema.parse(value)).toEqual(value);
    expect(
      schemas.WorkspaceFreezeRefusalSchema.safeParse({
        ...value,
        blockers: [
          { ...turnBlocker, actions: [{ ...action, input: { workspaceId, threadId, turnId } }] },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects unknown lifecycle, blocker, reason and quick-action core values', () => {
    for (const invalid of [
      { ...refusal, operation: 'copy' },
      { ...refusal, blockers: [{ ...turnBlocker, kind: 'worker' }] },
      { ...refusal, blockers: [{ ...turnBlocker, reason: 'probably-idle' }] },
      {
        ...refusal,
        blockers: [
          { ...turnBlocker, actions: [{ operationId: 'worker.stop', input: { workspaceId } }] },
        ],
      },
      { ...refusal, blockers: [{ ...turnBlocker, reference: { threadId } }] },
      { ...refusal, blockers: [{ ...turnBlocker, reference: { threadId, turnId: workspaceId } }] },
      { ...refusal, blockers: [{ ...snapshotBlocker, reference: { backupId: workspaceId } }] },
      { ...refusal, blockers: [{ ...snapshotBlocker, reference: { backupId: '../bundle' } }] },
      {
        ...refusal,
        blockers: [{ ...snapshotBlocker, reference: { recoveryRequestId: workspaceId } }],
      },
      {
        ...refusal,
        blockers: [{ ...snapshotBlocker, reference: { recoveryRequestId: '../request' } }],
      },
    ]) {
      expect(schemas.WorkspaceFreezeRefusalSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('keeps the unavailable sentinel free of identity, content and quick actions', () => {
    expect(
      schemas.WorkspaceFreezeRefusalSchema.parse({ ...refusal, blockers: [unavailable] })
    ).toEqual({ ...refusal, blockers: [unavailable] });
    for (const blocker of [
      { ...unavailable, reference: { threadId, turnId } },
      { ...unavailable, preview: 'Private work', count: 7, hostPath: '/private/workspace' },
      { ...unavailable, actions: [{ operationId: 'worker.list', input: { workspaceId } }] },
    ]) {
      const parsed = schemas.WorkspaceFreezeRefusalSchema.safeParse({
        ...refusal,
        blockers: [blocker],
      });
      // Descriptive additions may be rejected or ignored; neither may enter the public projection.
      if (parsed.success) expect(parsed.data.blockers).toEqual([unavailable]);
    }
  });
});
