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
  it('rejoins only the exact capture exclusion and preserves quarantine after release', () => {
    const gate = new WorkspaceMutationAdmission();
    const origin = { captureId: 'selected-capture' };
    const inspect = vi.fn(() => {
      expect(gate.enter(workspaceId)).toBeNull();
      expect(gate.enterLatePublisher(workspaceId, 'worker-turn-closeout')).toBeNull();
      return [];
    });
    gate.restoreRecoveryClosed(workspaceId, origin);
    // Local Hot Capture retains the selected capture, not authority from any closed gate.
    expect(gate.tryResumeRecovery(workspaceId, { captureId: 'other-capture' }, inspect)).toEqual({
      status: 'busy',
    });
    expect(
      gate.tryResumeRecovery(
        workspaceId,
        { admissionId: 'selected-capture', revision: 1, candidateRef: '/candidate' },
        inspect
      )
    ).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(gate.tryResumeRecovery(workspaceId, origin, () => [turnBlocker])).toEqual({
      status: 'blocked',
      blockers: [turnBlocker],
    });
    const resumed = gate.tryResumeRecovery(workspaceId, origin, inspect);
    if (resumed.status !== 'frozen') throw new Error('Expected the selected capture owner.');
    const sibling = gate.enter(siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling!();
    resumed.release();
    expect(gate.enter(workspaceId)).toBeNull();
    const retry = gate.tryResumeRecovery(workspaceId, origin, inspect);
    if (retry.status !== 'frozen') throw new Error('Expected an exact capture retry.');
    resumed.release();
    expect(gate.ownsFreeze(workspaceId, retry)).toBe(true);
    retry.release();
    gate.restoreClosed(workspaceId);
    expect(gate.tryResumeRecovery(workspaceId, origin, inspect)).toEqual({ status: 'busy' });
    const ownerless = new WorkspaceMutationAdmission();
    ownerless.restoreClosed(workspaceId, 'capture');
    expect(ownerless.tryResumeRecovery(workspaceId, origin, inspect)).toEqual({ status: 'busy' });
  });

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

  it('rejoins only exact boot recovery provenance without reopening the quarantined target', () => {
    const gate = new WorkspaceMutationAdmission();
    const origin = { admissionId: 'owned-recovery', revision: 1, candidateRef: '/owned/candidate' };
    gate.restoreRecoveryClosed(workspaceId, origin);
    const inspect = vi.fn(() => {
      expect(gate.enter(workspaceId)).toBeNull();
      expect(gate.enterLatePublisher(workspaceId, 'worker-turn-closeout')).toBeNull();
      return [];
    });
    expect(gate.tryFreeze(workspaceId, inspect)).toEqual({ status: 'busy' });
    expect(gate.tryResumeRecovery(workspaceId, { ...origin, revision: 2 }, inspect)).toEqual({
      status: 'busy',
    });
    expect(
      gate.tryResumeRecovery(workspaceId, { ...origin, candidateRef: '/other/candidate' }, inspect)
    ).toEqual({ status: 'busy' });
    expect(
      gate.tryResumeRecovery(workspaceId, { ...origin, admissionId: 'other-recovery' }, inspect)
    ).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(gate.tryResumeRecovery(workspaceId, origin, () => [turnBlocker])).toEqual({
      status: 'blocked',
      blockers: [turnBlocker],
    });
    expect(gate.enter(workspaceId)).toBeNull();
    const resumed = gate.tryResumeRecovery(workspaceId, { ...origin }, inspect);
    if (resumed.status !== 'frozen') throw new Error('Expected the exact recovery owner.');
    const candidate = {};
    gate.bindRecovery(workspaceId, resumed, { candidate });
    expect(gate.isRecoveryBinding(workspaceId, resumed, candidate)).toBe(true);
    expect(gate.tryResumeRecovery(workspaceId, origin, inspect)).toEqual({ status: 'busy' });
    const sibling = gate.enter(siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling!();
    resumed.release();
    expect(gate.isRecoveryBinding(workspaceId, resumed, candidate)).toBe(false);
    expect(gate.enter(workspaceId)).toBeNull();
    const replacement = gate.tryResumeRecovery(workspaceId, origin, inspect);
    if (replacement.status !== 'frozen') throw new Error('Expected an explicit exact-owner retry.');
    resumed.release();
    expect(gate.ownsFreeze(workspaceId, replacement)).toBe(true);
    replacement.release();
    expect(gate.isClosed(workspaceId, 'capture')).toBe(true);
  });

  it('does not turn ownerless or independently closed admission into recovery authority', () => {
    const gate = new WorkspaceMutationAdmission();
    const origin = { admissionId: 'owned-recovery', revision: 1, candidateRef: '/owned/candidate' };
    const inspect = vi.fn(() => []);
    gate.restoreClosed(workspaceId, 'capture');
    expect(gate.tryResumeRecovery(workspaceId, origin, inspect)).toEqual({ status: 'busy' });
    const independent = new WorkspaceMutationAdmission();
    independent.restoreRecoveryClosed(workspaceId, origin);
    independent.restoreClosed(workspaceId);
    expect(independent.tryResumeRecovery(workspaceId, origin, inspect)).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(gate.enter(workspaceId)).toBeNull();
    expect(independent.enter(workspaceId)).toBeNull();
  });

  it('limits recovery bindings to the exact live gate, Workspace and current binding objects', () => {
    const gate = new WorkspaceMutationAdmission();
    const otherGate = new WorkspaceMutationAdmission();
    const frozen = gate.tryFreeze(workspaceId, () => []);
    const sibling = gate.tryFreeze(siblingId, () => []);
    const other = otherGate.tryFreeze(workspaceId, () => []);
    if (frozen.status !== 'frozen' || sibling.status !== 'frozen' || other.status !== 'frozen')
      throw new Error('Expected independent admitted freezes.');
    const canonical = {};
    const candidate = {};
    gate.bindRecovery(workspaceId, frozen, { canonical, candidate });
    expect(gate.ownsFreeze(workspaceId, frozen)).toBe(true);
    expect(gate.isRecoveryBinding(workspaceId, frozen, canonical)).toBe(true);
    expect(gate.isRecoveryBinding(workspaceId, frozen, candidate)).toBe(true);
    expect(gate.isRecoveryBinding(workspaceId, frozen, {})).toBe(false);
    expect(gate.isRecoveryBinding(siblingId, frozen, candidate)).toBe(false);
    expect(gate.isRecoveryBinding(workspaceId, sibling, candidate)).toBe(false);
    expect(otherGate.isRecoveryBinding(workspaceId, frozen, candidate)).toBe(false);
    expect(gate.isRecoveryBinding(workspaceId, other, candidate)).toBe(false);
    const replacement = {};
    gate.bindRecovery(workspaceId, frozen, { canonical, candidate: replacement });
    expect(gate.isRecoveryBinding(workspaceId, frozen, candidate)).toBe(false);
    expect(gate.isRecoveryBinding(workspaceId, frozen, replacement)).toBe(true);
    expect(gate.enter(workspaceId)).toBeNull();
    frozen.release();
    expect(gate.ownsFreeze(workspaceId, frozen)).toBe(false);
    expect(gate.isRecoveryBinding(workspaceId, frozen, replacement)).toBe(false);
    sibling.release();
    other.release();
  });

  it('never lets an old freeze release restore permission or clear another owner closure', async () => {
    const gate = new WorkspaceMutationAdmission();
    const frozen = gate.tryFreeze(workspaceId, () => []);
    if (frozen.status !== 'frozen') throw new Error('Expected an admitted freeze.');
    const candidate = {};
    gate.bindRecovery(workspaceId, frozen, { candidate });
    gate.restoreClosed(workspaceId, 'capture');
    expect(gate.ownsFreeze(workspaceId, frozen)).toBe(false);
    expect(gate.isRecoveryBinding(workspaceId, frozen, candidate)).toBe(false);
    frozen.release();
    expect(gate.isClosed(workspaceId, 'capture')).toBe(true);
    gate.reopen(workspaceId, 'capture');
    const replacement = gate.tryFreeze(workspaceId, () => []);
    if (replacement.status !== 'frozen') throw new Error('Expected a fresh admitted freeze.');
    frozen.release();
    expect(gate.ownsFreeze(workspaceId, replacement)).toBe(true);
    await gate.close(workspaceId);
    replacement.release();
    expect(gate.isClosed(workspaceId)).toBe(true);
    expect(gate.isClosed(workspaceId, 'capture')).toBe(false);
    expect(gate.ownsFreeze(workspaceId, replacement)).toBe(false);
    gate.reopen(workspaceId);
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
