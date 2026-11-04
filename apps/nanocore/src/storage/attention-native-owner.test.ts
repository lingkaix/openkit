import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttentionNotifications,
  type AttentionSource,
  type AttentionTransport,
} from '../notifications/attention.js';
import { withdrawRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createPendingRequestFixture } from '../test-support/pending-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

const interception = vi.hoisted(() => ({ workers: [] as NativeWorker[] }));
// Reuse the existing actual FULL-COMMIT instrument; retain only the real Worker identity for loss.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  const InstrumentedWorker = nativeCommitWorker(actual.Worker);
  return {
    ...actual,
    Worker: class extends InstrumentedWorker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        interception.workers.push(this);
      }
    },
  };
});

const handles: Array<CoreDb | WorkspaceDb> = [];
const directories: string[] = [];
const now = () => '2026-10-16T12:00:00.000Z';
const recipientUserId = testEntityId('usr', 'attention-native-recipient');
const source: AttentionSource = {
  workspaceId: testEntityId('ws', 'attention-native'),
  threadId: testEntityId('th', 'attention-native'),
  kind: 'approval-request',
  requestId: 'apr_native',
};

/** Opens and migrates the real Core before any producer, fault or query-only intervention. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'attention-native-'));
  directories.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  handles.push(coreDb);
  applyMigrations(coreDb);
  return { coreDb, notifications: new AttentionNotifications(coreDb, { now }) };
}

/** Complete original Attention state, including every attempt rather than just its latest projection. */
function rows(coreDb: CoreDb) {
  return {
    attention: coreDb.sqlite.prepare('SELECT * FROM notification_attention ORDER BY id').all(),
    attempts: coreDb.sqlite
      .prepare('SELECT * FROM notification_delivery_attempts ORDER BY id')
      .all(),
  };
}

afterEach(async () => {
  releaseCommit();
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  interception.workers.splice(0);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('native Attention ownership', () => {
  it('enqueues through a query-only Main handle and cold-replays the exact deduplicated reference', async () => {
    const f = fixture();
    f.coreDb.sqlite.pragma('query_only = ON');
    const delivery = await f.notifications.enqueue({ source, recipientUserId });
    expect(delivery).toMatchObject({
      source,
      recipientUserId,
      status: 'queued',
      channel: null,
      attempt: null,
    });
    expect(await f.notifications.enqueue({ source, recipientUserId })).toEqual(delivery);
    const committed = rows(f.coreDb);
    expect(committed.attention).toHaveLength(1);
    expect(committed.attempts).toEqual([]);
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const cold = openCoreDb(f.coreDb.dataRoot);
    handles.push(cold);
    cold.sqlite.pragma('query_only = ON');
    const restarted = new AttentionNotifications(cold, { now });
    expect(restarted.get(delivery.id)).toEqual(delivery);
    expect(await restarted.enqueue({ source, recipientUserId })).toEqual(delivery);
    expect(rows(cold)).toEqual(committed);
  });

  it('rolls back channel selection and the entire claim when actual claim SQL refuses', async () => {
    const f = fixture();
    const delivery = await f.notifications.enqueue({ source, recipientUserId });
    await getControlStoreWorkerClient().close(`core:${f.coreDb.sqlite.name}`);
    f.coreDb.sqlite.exec(`CREATE TRIGGER refuse_native_attention_claim
      BEFORE INSERT ON notification_delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'private native Attention claim fault'); END`);
    f.coreDb.sqlite.pragma('query_only = ON');
    const before = rows(f.coreDb);
    const transport = vi.fn<AttentionTransport>();
    await expect(
      f.notifications.deliver(
        {
          deliveryId: delivery.id,
          recipientUserId,
          channel: 'discord',
          expectedAttemptId: null,
        },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow();
    expect(rows(f.coreDb)).toEqual(before);
    expect(f.notifications.get(delivery.id)).toEqual(delivery);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not contact transport after actual post-FULL claim loss and cold-reconciles without resend', async () => {
    const f = fixture();
    const delivery = await f.notifications.enqueue({ source, recipientUserId });
    f.coreDb.sqlite.pragma('query_only = ON');
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'sent' });
    const input = {
      deliveryId: delivery.id,
      recipientUserId,
      channel: 'discord' as const,
      expectedAttemptId: null,
    };
    const held = await heldCommit(2, () =>
      f.notifications.deliver(input, { isEligible: () => true, transport })
    );
    const claimed = f.notifications.get(delivery.id)!;
    expect(claimed).toMatchObject({
      channel: 'discord',
      status: 'sending',
      attempt: { status: 'sending', finishedAt: null },
    });
    expect(held.completed()).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(interception.workers).toHaveLength(1);
    await interception.workers[0]!.terminate();
    await expect(held.result).rejects.toMatchObject({
      name: 'ControlStoreWorkerError',
      commit: 'unknown',
    });
    releaseCommit();
    expect(f.notifications.get(delivery.id)).toEqual(claimed);
    expect(transport).not.toHaveBeenCalled();
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
    const cold = openCoreDb(f.coreDb.dataRoot);
    handles.push(cold);
    cold.sqlite.pragma('query_only = ON');
    const restarted = new AttentionNotifications(cold, { now });
    expect(await restarted.reconcileIncompleteAttempts()).toBe(1);
    expect(await restarted.reconcileIncompleteAttempts()).toBe(0);
    expect(restarted.get(delivery.id)).toMatchObject({
      channel: 'discord',
      status: 'delivery-unknown',
      attempt: { id: claimed.attempt!.id, failureCode: 'restart' },
    });
    const settled = rows(cold);
    await expect(
      restarted.deliver(
        { ...input, retry: true, expectedAttemptId: claimed.attempt!.id },
        { isEligible: () => true, transport }
      )
    ).rejects.toThrow('attention_not_sendable');
    expect(rows(cold)).toEqual(settled);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rechecks an actual ended Pending source after the committed claim result was held', async () => {
    const f = fixture();
    ensureLocalUser(f.coreDb);
    const store = await createDemoStore({ dataRoot: f.coreDb.dataRoot, knowledge: [] });
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId: DEMO_WORKSPACE_ID,
    });
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'One exact approval',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      null
    );
    const requestId = 'ap_attention_native_current';
    const requestItemId = pendingRequestItemId(requestId, 'request');
    const item = await store.createItem({
      id: requestItemId,
      owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: requestId,
      kind: 'permission',
      title: 'Exact approval',
      description: 'One existing command.',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    const pending = createPendingRequestFixture({
      coreDb: f.coreDb,
      store,
      workspaceId: DEMO_WORKSPACE_ID,
    });
    const workspaceDb = openWorkspaceDb(f.coreDb.dataRoot, DEMO_WORKSPACE_ID);
    handles.push(workspaceDb);
    try {
      const record = await pending.raise(
        {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: DEMO_THREAD_ID,
          raisingTurnId: turn.id,
          requestId,
          requestItemId,
          requesterKind: 'person',
          responsibleUserId: FIXTURE_LOCAL_USER_ID,
          kind: 'approval',
          governedIntent: { action: 'fixture' },
          approval: {
            kind: 'permission',
            title: 'Exact approval',
            description: 'One existing command.',
          },
          now: turn.startedAt!,
        },
        item
      );
      const delivery = await f.notifications.enqueue({
        source: {
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          kind: 'approval-request',
          requestId: record.requestId,
        },
        recipientUserId: record.responsibleUserId,
      });
      const transport = vi.fn<AttentionTransport>();
      const isEligible = vi.fn(() => pending.read(requestId)?.state === 'pending');
      f.coreDb.sqlite.pragma('query_only = ON');
      const held = await heldCommit(2, () =>
        f.notifications.deliver(
          {
            deliveryId: delivery.id,
            recipientUserId: record.responsibleUserId,
            channel: 'discord',
            expectedAttemptId: null,
          },
          { isEligible, transport }
        )
      );
      expect(f.notifications.get(delivery.id)?.status).toBe('sending');
      expect(isEligible).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      // Workspace mutation is its own real physical owner; no competing Core writer or allow flag.
      const ended = await withdrawRecordedPendingRequest(
        store,
        workspaceDb.sqlite,
        requestId,
        record.workspaceId,
        record.threadId,
        record.responsibleUserId,
        { coreDb: f.coreDb, openWorkspace: (id) => openWorkspaceDb(f.coreDb.dataRoot, id) },
        { kind: 'local', userId: record.responsibleUserId }
      );
      expect(ended.ending).toBe('withdrawn');
      expect(pending.read(requestId)?.state).not.toBe('pending');
      releaseCommit();
      await expect(held.result).rejects.toThrow('attention_not_eligible');
      expect(f.notifications.get(delivery.id)).toMatchObject({
        channel: 'discord',
        status: 'failed-no-send',
        attempt: { failureCode: 'authority-unavailable' },
      });
      expect(rows(f.coreDb).attempts).toHaveLength(1);
      expect(transport).not.toHaveBeenCalled();
      expect(pending.read(requestId)).toEqual(ended);
    } finally {
      releaseCommit();
      pending.close();
    }
  });

  it('lets only one real expected-attempt claim win while its FULL result is held', async () => {
    const f = fixture();
    const delivery = await f.notifications.enqueue({ source, recipientUserId });
    f.coreDb.sqlite.pragma('query_only = ON');
    const observer = new AttentionNotifications(f.coreDb, { now });
    const transport = vi.fn<AttentionTransport>().mockResolvedValue({ status: 'failed-no-send' });
    const input = {
      deliveryId: delivery.id,
      recipientUserId,
      channel: 'discord' as const,
      expectedAttemptId: null,
    };
    const held = await heldCommit(2, () =>
      f.notifications.deliver(input, { isEligible: () => true, transport })
    );
    const competing = observer.deliver(input, { isEligible: () => true, transport });
    const refusal = expect(competing).rejects.toThrow('attention_attempt_conflict');
    expect(transport).not.toHaveBeenCalled();
    releaseCommit();
    expect(await held.result).toMatchObject({ status: 'failed-no-send', attempt: { id: 1 } });
    await refusal;
    expect(rows(f.coreDb).attempts).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps startup unknown when an original transport later returns sent', async () => {
    const f = fixture();
    const delivery = await f.notifications.enqueue({ source, recipientUserId });
    f.coreDb.sqlite.pragma('query_only = ON');
    const started = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<{ status: 'sent' }>();
    const transport = vi.fn<AttentionTransport>(() => {
      started.resolve();
      return complete.promise;
    });
    const pending = f.notifications.deliver(
      {
        deliveryId: delivery.id,
        recipientUserId,
        channel: 'discord',
        expectedAttemptId: null,
      },
      { isEligible: () => true, transport }
    );
    try {
      await started.promise;
      const observer = new AttentionNotifications(f.coreDb, { now });
      expect(await observer.reconcileIncompleteAttempts()).toBe(1);
      const unknown = observer.get(delivery.id)!;
      const before = rows(f.coreDb);
      expect(unknown).toMatchObject({
        status: 'delivery-unknown',
        attempt: { failureCode: 'restart' },
      });
      complete.resolve({ status: 'sent' });
      expect(await pending).toEqual(unknown);
      expect(rows(f.coreDb)).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      complete.resolve({ status: 'sent' });
      await Promise.allSettled([pending]);
    }
  });
});
