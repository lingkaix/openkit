import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schemas from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { enterMcpCaptureCall } from './runtime/worker-mcp-capture.js';
import {
  type ControlRecoveryNativeBinding,
  getControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';

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

/** Each case owns a fresh physical Root, so its native Workspace mutation scope starts empty. */
function nativeScopeRoot() {
  return join(tmpdir(), `workspace-freeze-${allocateEntityId('ws')}`);
}

/** A staging binding proven under the case's own Root, as recovery installs it. */
function stagedBinding(sourceDataRoot: string): ControlRecoveryNativeBinding {
  const dataRoot = join(sourceDataRoot, 'candidate');
  return {
    command: { dataRoot } as ControlRecoveryNativeBinding['command'],
    path: join(dataRoot, 'workspace.sqlite'),
    identity: allocateEntityId('ws'),
    sourceDataRoot,
  };
}

/** R2947 freeze admission and brief 13j require synchronous refusal, not draining live work. */
describe('Workspace freeze admission', () => {
  it('rejoins only the exact capture exclusion and preserves quarantine after release', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const origin = { captureId: 'selected-capture' };
    const inspect = vi.fn(() => {
      expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
      expect(
        client.enterWorkspaceLatePublisher(root, workspaceId, 'worker-turn-closeout')
      ).toBeNull();
      return [];
    });
    client.restoreWorkspaceRecoveryClosed(root, workspaceId, origin);
    // Local Hot Capture retains the selected capture, not authority from any closed gate.
    expect(
      client.tryResumeWorkspaceRecovery(root, workspaceId, { captureId: 'other-capture' }, inspect)
    ).toEqual({
      status: 'busy',
    });
    expect(
      client.tryResumeWorkspaceRecovery(
        root,
        workspaceId,
        { admissionId: 'selected-capture', revision: 1, candidateRef: '/candidate' },
        inspect
      )
    ).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(
      client.tryResumeWorkspaceRecovery(root, workspaceId, origin, () => [turnBlocker])
    ).toEqual({
      status: 'blocked',
      blockers: [turnBlocker],
    });
    const resumed = client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect);
    if (resumed.status !== 'frozen') throw new Error('Expected the selected capture owner.');
    const sibling = client.enterWorkspaceMutation(root, siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling!();
    resumed.release();
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    const retry = client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect);
    if (retry.status !== 'frozen') throw new Error('Expected an exact capture retry.');
    resumed.release();
    expect(client.ownsWorkspaceFreeze(root, workspaceId, retry)).toBe(true);
    retry.release();
    client.restoreWorkspaceMutationsClosed(root, workspaceId);
    expect(client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect)).toEqual({
      status: 'busy',
    });
    const ownerlessRoot = nativeScopeRoot();
    client.restoreWorkspaceMutationsClosed(ownerlessRoot, workspaceId, 'capture');
    expect(client.tryResumeWorkspaceRecovery(ownerlessRoot, workspaceId, origin, inspect)).toEqual({
      status: 'busy',
    });
  });

  it('characterizes close as waiting for an admitted mutation', async () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const releaseMutation = client.enterWorkspaceMutation(root, workspaceId);
    let settled = false;
    const closed = client.closeWorkspaceMutations(root, workspaceId).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    releaseMutation!();
    await closed;
    expect(settled).toBe(true);
    client.reopenWorkspaceMutations(root, workspaceId);
  });

  it('refuses an admitted mutation immediately without checking blockers or fencing later work', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const releaseMutation = client.enterWorkspaceMutation(root, workspaceId);
    const readBlockers = vi.fn(() => []);
    expect(client.tryFreezeWorkspace(root, workspaceId, readBlockers)).toEqual({ status: 'busy' });
    expect(readBlockers).not.toHaveBeenCalled();
    expect(client.isWorkspaceMutationClosed(root, workspaceId)).toBe(false);
    const releaseNext = client.enterWorkspaceMutation(root, workspaceId);
    expect(releaseNext).toBeTypeOf('function');
    releaseNext!();
    releaseMutation!();
  });

  it('fences racing publishers before authoritative inspection and keeps siblings open until release', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const frozen = client.tryFreezeWorkspace(root, workspaceId, () => {
      expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
      expect(
        client.enterWorkspaceLatePublisher(root, workspaceId, 'worker-turn-closeout')
      ).toBeNull();
      const releaseSibling = client.enterWorkspaceMutation(root, siblingId);
      expect(releaseSibling).toBeTypeOf('function');
      releaseSibling!();
      return [];
    });
    expect(frozen.status).toBe('frozen');
    const readAgain = vi.fn(() => []);
    expect(client.tryFreezeWorkspace(root, workspaceId, readAgain)).toEqual({ status: 'busy' });
    expect(readAgain).not.toHaveBeenCalled();
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    if (frozen.status !== 'frozen') throw new Error('Expected an admitted freeze.');
    frozen.release();
    frozen.release();
    const releaseNext = client.enterWorkspaceLatePublisher(
      root,
      workspaceId,
      'worker-turn-closeout'
    );
    expect(releaseNext).toBeTypeOf('function');
    releaseNext!();
  });

  it('returns every authoritative blocker and reopens a refused freeze', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const blockers = [turnBlocker, unavailable];
    expect(client.tryFreezeWorkspace(root, workspaceId, () => blockers)).toEqual({
      status: 'blocked',
      blockers,
    });
    expect(client.isWorkspaceMutationClosed(root, workspaceId)).toBe(false);
    const releaseMutation = client.enterWorkspaceMutation(root, workspaceId);
    expect(releaseMutation).toBeTypeOf('function');
    releaseMutation!();
  });

  it('fails closed on unreadable blocker facts without exposing the exception or retaining the fence', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    expect(
      client.tryFreezeWorkspace(root, workspaceId, () => {
        throw new Error('Private inspection data must not enter the refusal.');
      })
    ).toEqual({ status: 'blocked', blockers: [unavailable] });
    const releaseMutation = client.enterWorkspaceMutation(root, workspaceId);
    expect(releaseMutation).toBeTypeOf('function');
    releaseMutation!();
  });

  it('rejoins only exact boot recovery provenance without reopening the quarantined target', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const origin = { admissionId: 'owned-recovery', revision: 1, candidateRef: '/owned/candidate' };
    client.restoreWorkspaceRecoveryClosed(root, workspaceId, origin);
    const inspect = vi.fn(() => {
      expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
      expect(
        client.enterWorkspaceLatePublisher(root, workspaceId, 'worker-turn-closeout')
      ).toBeNull();
      return [];
    });
    expect(client.tryFreezeWorkspace(root, workspaceId, inspect)).toEqual({ status: 'busy' });
    expect(
      client.tryResumeWorkspaceRecovery(root, workspaceId, { ...origin, revision: 2 }, inspect)
    ).toEqual({
      status: 'busy',
    });
    expect(
      client.tryResumeWorkspaceRecovery(
        root,
        workspaceId,
        { ...origin, candidateRef: '/other/candidate' },
        inspect
      )
    ).toEqual({ status: 'busy' });
    expect(
      client.tryResumeWorkspaceRecovery(
        root,
        workspaceId,
        { ...origin, admissionId: 'other-recovery' },
        inspect
      )
    ).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(
      client.tryResumeWorkspaceRecovery(root, workspaceId, origin, () => [turnBlocker])
    ).toEqual({
      status: 'blocked',
      blockers: [turnBlocker],
    });
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    const resumed = client.tryResumeWorkspaceRecovery(root, workspaceId, { ...origin }, inspect);
    if (resumed.status !== 'frozen') throw new Error('Expected the exact recovery owner.');
    const candidate = stagedBinding(root);
    client.bindWorkspaceRecovery(root, workspaceId, resumed, { candidate });
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, resumed, candidate)).toBe(true);
    expect(client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect)).toEqual({
      status: 'busy',
    });
    const sibling = client.enterWorkspaceMutation(root, siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling!();
    resumed.release();
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, resumed, candidate)).toBe(false);
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    const replacement = client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect);
    if (replacement.status !== 'frozen') throw new Error('Expected an explicit exact-owner retry.');
    resumed.release();
    expect(client.ownsWorkspaceFreeze(root, workspaceId, replacement)).toBe(true);
    replacement.release();
    expect(client.isWorkspaceMutationClosed(root, workspaceId, 'capture')).toBe(true);
  });

  it('does not turn ownerless or independently closed admission into recovery authority', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const origin = { admissionId: 'owned-recovery', revision: 1, candidateRef: '/owned/candidate' };
    const inspect = vi.fn(() => []);
    client.restoreWorkspaceMutationsClosed(root, workspaceId, 'capture');
    expect(client.tryResumeWorkspaceRecovery(root, workspaceId, origin, inspect)).toEqual({
      status: 'busy',
    });
    const independentRoot = nativeScopeRoot();
    client.restoreWorkspaceRecoveryClosed(independentRoot, workspaceId, origin);
    client.restoreWorkspaceMutationsClosed(independentRoot, workspaceId);
    expect(
      client.tryResumeWorkspaceRecovery(independentRoot, workspaceId, origin, inspect)
    ).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    expect(client.enterWorkspaceMutation(independentRoot, workspaceId)).toBeNull();
  });

  it('limits recovery bindings to the exact live gate, Workspace and current binding objects', () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const otherRoot = nativeScopeRoot();
    const frozen = client.tryFreezeWorkspace(root, workspaceId, () => []);
    const sibling = client.tryFreezeWorkspace(root, siblingId, () => []);
    const other = client.tryFreezeWorkspace(otherRoot, workspaceId, () => []);
    if (frozen.status !== 'frozen' || sibling.status !== 'frozen' || other.status !== 'frozen')
      throw new Error('Expected independent admitted freezes.');
    const canonical = stagedBinding(root);
    const candidate = stagedBinding(root);
    client.bindWorkspaceRecovery(root, workspaceId, frozen, { canonical, candidate });
    expect(client.ownsWorkspaceFreeze(root, workspaceId, frozen)).toBe(true);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, canonical)).toBe(true);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, candidate)).toBe(true);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, {})).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(root, siblingId, frozen, candidate)).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, sibling, candidate)).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(otherRoot, workspaceId, frozen, candidate)).toBe(
      false
    );
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, other, candidate)).toBe(false);
    const replacement = stagedBinding(root);
    client.bindWorkspaceRecovery(root, workspaceId, frozen, { canonical, candidate: replacement });
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, candidate)).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, replacement)).toBe(true);
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    frozen.release();
    expect(client.ownsWorkspaceFreeze(root, workspaceId, frozen)).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, replacement)).toBe(false);
    sibling.release();
    other.release();
  });

  it('never lets an old freeze release restore permission or clear another owner closure', async () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const frozen = client.tryFreezeWorkspace(root, workspaceId, () => []);
    if (frozen.status !== 'frozen') throw new Error('Expected an admitted freeze.');
    const candidate = stagedBinding(root);
    client.bindWorkspaceRecovery(root, workspaceId, frozen, { candidate });
    client.restoreWorkspaceMutationsClosed(root, workspaceId, 'capture');
    expect(client.ownsWorkspaceFreeze(root, workspaceId, frozen)).toBe(false);
    expect(client.isWorkspaceRecoveryBinding(root, workspaceId, frozen, candidate)).toBe(false);
    frozen.release();
    expect(client.isWorkspaceMutationClosed(root, workspaceId, 'capture')).toBe(true);
    client.reopenWorkspaceMutations(root, workspaceId, 'capture');
    const replacement = client.tryFreezeWorkspace(root, workspaceId, () => []);
    if (replacement.status !== 'frozen') throw new Error('Expected a fresh admitted freeze.');
    frozen.release();
    expect(client.ownsWorkspaceFreeze(root, workspaceId, replacement)).toBe(true);
    await client.closeWorkspaceMutations(root, workspaceId);
    replacement.release();
    expect(client.isWorkspaceMutationClosed(root, workspaceId)).toBe(true);
    expect(client.isWorkspaceMutationClosed(root, workspaceId, 'capture')).toBe(false);
    expect(client.ownsWorkspaceFreeze(root, workspaceId, replacement)).toBe(false);
    client.reopenWorkspaceMutations(root, workspaceId);
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

// ORACLE-STORE S7 K2: preparation admits only original Worker closeout, while
// the real MCP capture participant and ordinary publishers share the same exclusion.
describe('ORACLE S7 preparation cut and unknown exclusion', () => {
  it('drains admitted Worker closeout before the cut while refusing actual MCP publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oracle-s7-publishers-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const entered = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const mayFinish = Promise.withResolvers<void>();
    let releaseCloseout: () => void = () => {
      throw new Error('Original closeout was not admitted.');
    };
    const inspect = vi.fn(() => []);
    let settled = false;
    const capture = getControlStoreWorkerClient()
      .tryFreezeWorkspaceAfterDrain(
        root,
        workspaceId,
        async () => {
          expect(
            getControlStoreWorkerClient().enterWorkspaceMutation(root, workspaceId)
          ).toBeNull();
          expect(enterMcpCaptureCall(root, workspaceId)).toBeNull();
          const closeout = getControlStoreWorkerClient().enterWorkspaceLatePublisher(
            root,
            workspaceId,
            'worker-turn-closeout'
          );
          expect(closeout).toBeTypeOf('function');
          if (!closeout) throw new Error('Original closeout was refused during preparation.');
          releaseCloseout = closeout;
          entered.resolve();
          await mayFinish.promise;
          prepared.resolve();
        },
        inspect
      )
      .then((result) => {
        settled = true;
        return result;
      });
    await entered.promise;
    const sibling = enterMcpCaptureCall(root, siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling?.();
    mayFinish.resolve();
    await prepared.promise;
    expect(settled).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    releaseCloseout();
    const frozen = await capture;
    expect(frozen.status).toBe('frozen');
    expect(inspect).toHaveBeenCalledOnce();
    expect(getControlStoreWorkerClient().enterWorkspaceMutation(root, workspaceId)).toBeNull();
    expect(enterMcpCaptureCall(root, workspaceId)).toBeNull();
    expect(
      getControlStoreWorkerClient().enterWorkspaceLatePublisher(
        root,
        workspaceId,
        'worker-turn-closeout'
      )
    ).toBeNull();
    if (frozen.status === 'frozen') frozen.release();
    const admitted = enterMcpCaptureCall(root, workspaceId);
    expect(admitted).toBeTypeOf('function');
    admitted?.();
  });

  it('retains unknown preparation exclusion and refuses a guessed recovery origin', async () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const inspect = vi.fn(() => []);
    const result = await client.tryFreezeWorkspaceAfterDrain(
      root,
      workspaceId,
      async () => {
        const closeout = client.enterWorkspaceLatePublisher(
          root,
          workspaceId,
          'worker-turn-closeout'
        );
        expect(closeout).toBeTypeOf('function');
        closeout?.();
        throw new Error('Original external close outcome is unknown.');
      },
      inspect
    );
    expect(result).toEqual({ status: 'blocked', blockers: [unavailable] });
    expect(inspect).not.toHaveBeenCalled();
    expect(client.isWorkspaceMutationClosed(root, workspaceId)).toBe(true);
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
    expect(
      client.enterWorkspaceLatePublisher(root, workspaceId, 'worker-turn-closeout')
    ).toBeNull();
    expect(client.enterWorkspaceLatePublisher(root, workspaceId, 'mcp-workspace-data')).toBeNull();
    expect(
      client.tryResumeWorkspaceRecovery(root, workspaceId, { captureId: 'guessed' }, inspect)
    ).toEqual({
      status: 'busy',
    });
    expect(client.tryFreezeWorkspace(root, workspaceId, inspect)).toEqual({ status: 'busy' });
    const sibling = client.enterWorkspaceMutation(root, siblingId);
    expect(sibling).toBeTypeOf('function');
    sibling?.();
  });

  it('cannot reopen an independent lifecycle close when preparation returns', async () => {
    const client = getControlStoreWorkerClient();
    const root = nativeScopeRoot();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inspect = vi.fn(() => []);
    const capture = client.tryFreezeWorkspaceAfterDrain(
      root,
      workspaceId,
      async () => {
        entered.resolve();
        await release.promise;
      },
      inspect
    );
    await entered.promise;
    await client.closeWorkspaceMutations(root, workspaceId);
    expect(
      client.enterWorkspaceLatePublisher(root, workspaceId, 'worker-turn-closeout')
    ).toBeNull();
    release.resolve();
    expect(await capture).toEqual({ status: 'busy' });
    expect(inspect).not.toHaveBeenCalled();
    expect(client.isWorkspaceLifecycleClosed(root, workspaceId)).toBe(true);
    expect(client.enterWorkspaceMutation(root, workspaceId)).toBeNull();
  });
});
