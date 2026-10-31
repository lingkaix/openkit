import { randomUUID } from 'node:crypto';
import { allocateEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { listWorkspaceUsageRecords } from '../capability/usage-ledger.js';
import type { FsStore } from '../lib/store.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  assistantWiringFixture,
  taskProposalProvider,
} from '../test-support/mode-entry-fixture.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createPendingRequestFixture } from '../test-support/pending-request.js';
import { setTestTurnTriggerActor } from '../test-support/store.js';
import { getWorkspaceMember } from '../workspace-sharing.js';
import { commandInputHash } from './idempotent-command.js';
import { type PendingRequestRecord, pendingRequestItemId } from './pending-requests.js';

/** Publishes a distinct question through the existing native Pending owner. */
async function raiseQuestion(
  pending: ReturnType<typeof createPendingRequestFixture>,
  turn: ReturnType<FsStore['getTurnById']>,
  responsibleUserId: string
) {
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const questions = [
    {
      id: `q-${requestId}`,
      header: 'Choice',
      question: `Which value for request ${requestId}?`,
      options: null,
      isOther: true,
      isSecret: false,
    },
  ];
  return pending.raise(
    {
      requestId,
      requestItemId: pendingRequestItemId(requestId, 'request'),
      workspaceId: workspaceIdForOwner(turn.owner),
      threadId: turn.threadId,
      raisingTurnId: turn.id,
      kind: 'user-input',
      requesterKind: 'assistant',
      responsibleUserId,
      questions,
      questionDigest: commandInputHash(questions),
      now,
    },
    {
      id: pendingRequestItemId(requestId, 'request'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'user-input-request',
      userInputRequestId: requestId,
      responsibleUserId,
      prompt: 'Which value?',
      questions,
      status: 'completed',
      createdAt: now,
      completedAt: now,
    }
  );
}

/** Reuses real member identity, configuration, App, native Pending and provider fixtures. */
async function fixture(
  agentSetup?: ReturnType<typeof createTestAgentSetup>,
  preparePending?: Parameters<typeof assistantWiringFixture>[6]
) {
  const f = await assistantWiringFixture(
    false,
    undefined,
    true,
    undefined,
    true,
    agentSetup,
    preparePending
  );
  const cleanup: Array<() => Promise<void>> = [];
  const workspaceId = workspaceIdForOwner(f.thread.owner);
  const pending = createPendingRequestFixture({ coreDb: f.coreDb, store: f.store, workspaceId });
  const admin = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  onTestFinished(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
      await Promise.allSettled(
        f.createResponses.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value)
      );
    } finally {
      pending.close();
      await f.close();
    }
  });
  const post = (operation: string, input: Record<string, unknown>) =>
    f.app.request(
      ...operationRequest(
        operation,
        {},
        {
          headers: { authorization: `Bearer ${admin.secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: randomUUID(), ...input }),
        }
      )
    );
  const raise = (turn: ReturnType<typeof f.store.getTurnById>, responsibleUserId = f.actorUserId) =>
    raiseQuestion(pending, turn, responsibleUserId);
  const answer = async (record: PendingRequestRecord, value = 'A complete answer') => {
    const response = await post('question.answer', {
      workspaceId,
      threadId: record.threadId,
      userInputRequestId: record.requestId,
      answers: { [record.questions![0]!.id as string]: [value] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return pending.read(record.requestId)!;
  };
  const turn = (threadId = f.thread.id, userId = f.actorUserId) =>
    f.store.createTurn(
      workspaceId,
      threadId,
      'Continue the responsible user work.',
      { kind: 'user', id: userId },
      null,
      { executorKind: 'assistant', agentId: 'quick-chat' }
    );
  const complete = (turnId: string) =>
    f.store.completeTurn(turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  return { ...f, cleanup, workspaceId, pending, admin, post, raise, answer, turn, complete };
}

/** Holds only the external Provider response; native admission and context remain real. */
function holdModel(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const response = f.createResponses.getMockImplementation()!;
  f.createResponses.mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return response(...args);
  });
  f.cleanup.push(async () => {
    release.resolve();
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

it('continues as P with P context while retaining administrator and system outcome attribution', async () => {
  const f = await fixture();
  const otherThread = await f.store.createThread(
    f.workspaceId,
    'Administrator private history',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: FIXTURE_LOCAL_USER_ID }
  );
  const other = await f.turn(otherThread.id, FIXTURE_LOCAL_USER_ID);
  const adminMarker = 'ADMIN_ONLY_PRIVATE_CONTEXT_545';
  await f.store.createItem({
    id: allocateEntityId('it'),
    owner: other.owner,
    threadId: other.threadId,
    turnId: other.id,
    type: 'user-message',
    actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    text: adminMarker,
    status: 'completed',
    createdAt: other.startedAt!,
    completedAt: other.startedAt!,
  });
  await f.complete(other.id);
  const previous = await f.turn();
  const marker = 'P_ONLY_PRIVATE_CONTEXT_545';
  await f.store.createItem({
    id: allocateEntityId('it'),
    owner: previous.owner,
    threadId: previous.threadId,
    turnId: previous.id,
    type: 'user-message',
    actor: { kind: 'user', id: f.actorUserId },
    text: marker,
    status: 'completed',
    createdAt: previous.startedAt!,
    completedAt: previous.startedAt!,
  });
  await f.complete(previous.id);
  const source = await f.turn();
  const answered = await f.raise(source);
  const withdrawn = await f.raise(source);
  const invalidated = await f.raise(source);
  await f.answer(answered);
  const response = await f.post('pending-request.withdraw', {
    workspaceId: f.workspaceId,
    threadId: source.threadId,
    pendingRequestId: withdrawn.requestId,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  // Exercise the existing native invalidation producer, not a hand-built ended record.
  await f.store.applyPendingRequestCommand(f.workspaceId, {
    action: 'invalidate',
    workspaceId: f.workspaceId,
    threadId: source.threadId,
    requestId: invalidated.requestId,
    actor: { kind: 'system', id: 'nanocore-pending-request' },
    event: 'request-source-unavailable',
    now: new Date().toISOString(),
  });
  const model = holdModel(f);
  await f.complete(source.id);
  const delivery = f.store.listThreadTurns(f.workspaceId, source.threadId).at(-1)!;
  expect(delivery.triggerActor).toEqual({ kind: 'user', id: f.actorUserId });
  await model.entered;
  expect(f.pending.read(answered.requestId)?.decidingActor).toEqual({
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  expect(f.pending.read(withdrawn.requestId)?.endingActor).toEqual({
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  expect(f.pending.read(invalidated.requestId)?.endingActor).toEqual({
    kind: 'system',
    id: 'nanocore-pending-request',
  });
  const providerRequests = JSON.stringify(f.createResponses.mock.calls.map((call) => call[1]));
  expect(providerRequests).toContain(marker);
  expect(providerRequests).not.toContain(adminMarker);
  expect(
    delivery.items.some((item) => 'actor' in item && item.actor?.id === FIXTURE_LOCAL_USER_ID)
  ).toBe(true);
  model.release();
  await vi.waitFor(() => expect(f.store.getTurnById(delivery.id).status).toBe('completed'));
  const usage = listWorkspaceUsageRecords(f.workspaceDb, f.workspaceId).filter(
    (entry) => entry.turnId === delivery.id
  );
  expect(usage.length).toBeGreaterThan(0);
  expect(usage.every((entry) => entry.responsibleUserId === f.actorUserId)).toBe(true);
});

it('selects readiness and P before the bound of16 and leaves interleaved Q for a later Turn', async () => {
  let sharedId = '';
  let olderP!: PendingRequestRecord;
  let olderQ!: PendingRequestRecord;
  const selected: string[] = [];
  const f = await fixture(undefined, async ({ coreDb, store, actorUserId }) => {
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const shared = await store.createThread(workspaceId, 'Principal-ordered ready outcomes');
    sharedId = shared.id;
    const pending = createPendingRequestFixture({ coreDb, store, workspaceId });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const actor = {
      kind: 'token' as const,
      userId: FIXTURE_LOCAL_USER_ID,
      tokenId: token.record.tokenId,
      tokenScope: 'server-admin' as const,
      tokenWorkspaceIds: [],
    };
    const turn = (userId: string) =>
      store.createTurn(
        workspaceId,
        shared.id,
        'Raise a genuine request.',
        { kind: 'user', id: userId },
        null,
        { agentId: 'quick-chat', executorKind: 'assistant' }
      );
    const finish = (id: string) =>
      store.completeTurn(id, { status: 'completed', completedAt: new Date().toISOString() });
    const settle = (record: PendingRequestRecord) =>
      pending.answer(record, actor, { [record.questions![0]!.id as string]: ['Complete answer'] });
    try {
      const q = await turn(FIXTURE_LOCAL_USER_ID);
      olderQ = await raiseQuestion(pending, q, FIXTURE_LOCAL_USER_ID);
      await finish(q.id);
      const p = await turn(actorUserId);
      olderP = await raiseQuestion(pending, p, actorUserId);
      const first = await raiseQuestion(pending, p, actorUserId);
      selected.push(first.requestId);
      await settle(first);
      await settle(olderQ);
      await finish(p.id);
      const interleaved = await turn(FIXTURE_LOCAL_USER_ID);
      await settle(await raiseQuestion(pending, interleaved, FIXTURE_LOCAL_USER_ID));
      await finish(interleaved.id);
      const remainder = await turn(actorUserId);
      for (let index = 1; index < 16; index++) {
        const record = await raiseQuestion(pending, remainder, actorUserId);
        selected.push(record.requestId);
        await settle(record);
      }
      await finish(remainder.id);
    } finally {
      pending.close();
    }
  });
  const model = holdModel(f);
  let firstDeliveryId = '';
  const settled = Promise.withResolvers<ReturnType<typeof f.store.getTurnById>>();
  const completeTurn = f.store.completeTurn.bind(f.store);
  // The real owner return includes the terminal hook that admits the next outcome.
  const completion = vi.spyOn(f.store, 'completeTurn').mockImplementation(async (...args) => {
    const turn = await completeTurn(...args);
    if (turn.id === firstDeliveryId) settled.resolve(turn);
    return turn;
  });
  f.cleanup.push(async () => {
    completion.mockRestore();
  });
  await f.answer(olderP);
  const firstDelivery = f.store.listThreadTurns(f.workspaceId, sharedId).at(-1)!;
  firstDeliveryId = firstDelivery.id;
  const frozen = f.pending
    .list(sharedId)
    .filter((record) => record.deliveryTurnId === firstDelivery.id);
  expect(firstDelivery.triggerActor).toEqual({ kind: 'user', id: f.actorUserId });
  expect(frozen.map((record) => record.requestId)).toEqual(selected);
  expect(frozen).toHaveLength(16);
  expect(firstDelivery.triggerSource?.kind).toBe('user-input');
  expect(firstDelivery.triggerSource?.summary).toMatch(/\b16\b/);
  expect(f.pending.read(olderQ.requestId)?.delivery).toBe('undelivered');
  expect(f.pending.read(olderP.requestId)?.delivery).toBe('undelivered');
  model.release();
  expect((await settled.promise).status).toBe('completed');
  await vi.waitFor(() => expect(f.pending.read(olderQ.requestId)?.delivery).toBe('delivered'));
  const later = f.store.getTurnById(f.pending.read(olderQ.requestId)!.deliveryTurnId!);
  expect(later.id).not.toBe(firstDelivery.id);
  expect(later.triggerActor).toEqual({ kind: 'user', id: FIXTURE_LOCAL_USER_ID });
});

it('makes no model or tool contact when P loses current membership before admission', async () => {
  const f = await fixture();
  const source = await f.turn();
  const request = await f.raise(source);
  await f.answer(request);
  const member = getWorkspaceMember(f.coreDb, f.workspaceId, f.actorUserId)!;
  const removed = await f.post('workspace.member-remove', {
    workspaceId: f.workspaceId,
    targetUserId: f.actorUserId,
    expectedRevision: member.revision,
  });
  expect(removed.status, await removed.clone().text()).toBe(200);
  const contacts = f.dispatchCount();
  await f.complete(source.id);
  await vi.waitFor(() => expect(f.pending.read(request.requestId)?.delivery).toBe('closed-out'));
  expect(f.dispatchCount()).toBe(contacts);
  expect(
    listSchedulerAdmissionEntriesForWorkspace(f.coreDb, {
      workspaceId: f.workspaceId,
      statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
    })
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
        status: 'admitted',
      }),
    ])
  );
});

it('validates a different administrator handoff decision separately from P execution and refuses its revoked credential', async () => {
  const setup = createTestAgentSetup();
  const f = await fixture(setup);
  const provider = taskProposalProvider('Perform this exact small Task.', setup.manifest.id);
  f.createResponses.mockImplementation(provider.createResponses);
  const proposed = await f.submit();
  expect(proposed.status, await proposed.clone().text()).toBe(202);
  const body = await proposed.json();
  const item = body.item;
  expect(item.type).toBe('user-input-request');
  const record = f.pending.read(item.userInputRequestId)!;
  const blocker = await f.turn();
  const confirmed = await f.post('question.answer', {
    workspaceId: f.workspaceId,
    threadId: f.thread.id,
    userInputRequestId: record.requestId,
    answers: { [item.questions[0].id]: ['Confirm exact handoff'] },
  });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  await f.complete(blocker.id);
  expect(f.store.listThreadTurns(f.workspaceId, f.thread.id).at(-1)?.triggerActor).toEqual({
    kind: 'user',
    id: f.actorUserId,
  });
  await vi.waitFor(() =>
    expect(
      listSchedulerAdmissionEntriesForWorkspace(f.coreDb, {
        workspaceId: f.workspaceId,
        statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
      }).length
    ).toBeGreaterThan(0)
  );
  const admitted = listSchedulerAdmissionEntriesForWorkspace(f.coreDb, {
    workspaceId: f.workspaceId,
    statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
  });
  expect(
    admitted.every(
      (entry) => entry.triggerActor.kind === 'user' && entry.triggerActor.id === f.actorUserId
    )
  ).toBe(true);
  expect(admitted.every((entry) => entry.serverAdminTokenId === null)).toBe(true);
  expect(f.pending.read(record.requestId)?.decidingActorContext?.userId).toBe(
    FIXTURE_LOCAL_USER_ID
  );
  await vi.waitFor(() =>
    expect(f.store.listThreadTurns(f.workspaceId, f.thread.id).at(-1)?.status).toBe('completed')
  );
  const again = taskProposalProvider('Perform a separately confirmed Task.', setup.manifest.id);
  f.createResponses.mockImplementation(again.createResponses);
  const second = await f.submit(randomUUID());
  expect(second.status, await second.clone().text()).toBe(202);
  const secondItem = (await second.json()).item;
  const hold = await f.turn();
  const answered = await f.post('question.answer', {
    workspaceId: f.workspaceId,
    threadId: f.thread.id,
    userInputRequestId: secondItem.userInputRequestId,
    answers: { [secondItem.questions[0].id]: ['Confirm exact handoff'] },
  });
  expect(answered.status, await answered.clone().text()).toBe(200);
  revokeOpenKitAccessTokenRecord(f.coreDb, f.admin.record.tokenId);
  const before = listSchedulerAdmissionEntriesForWorkspace(f.coreDb, {
    workspaceId: f.workspaceId,
    statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
  }).map((entry) => entry.queueEntryId);
  await f.complete(hold.id);
  await vi.waitFor(() =>
    expect(f.store.listThreadTurns(f.workspaceId, f.thread.id).at(-1)).toEqual(
      expect.objectContaining({
        status: 'completed',
        triggerActor: { kind: 'user', id: f.actorUserId },
        items: expect.arrayContaining([
          expect.objectContaining({
            type: 'status',
            status: 'completed',
            level: 'warning',
            title: 'Handoff refused',
            summary: 'Current receiving Workspace execution authority is unavailable.',
          }),
        ]),
      })
    )
  );
  expect(f.pending.read(secondItem.userInputRequestId)?.decidingActorContext).toEqual(
    expect.objectContaining({
      userId: FIXTURE_LOCAL_USER_ID,
      tokenId: f.admin.record.tokenId,
    })
  );
  expect(
    listSchedulerAdmissionEntriesForWorkspace(f.coreDb, {
      workspaceId: f.workspaceId,
      statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
    }).map((entry) => entry.queueEntryId)
  ).toEqual(before);
});

it('refuses a retained frozen principal mismatch at canonical validation before dispatch', async () => {
  const f = await fixture();
  const source = await f.turn();
  const request = await f.raise(source);
  await f.answer(request);
  const published = Promise.withResolvers<ReturnType<typeof f.store.getTurnById>>();
  const release = Promise.withResolvers<void>();
  const create = f.store.createTurn.bind(f.store);
  // Hold the real publication return after its native ACK, before delivery is dispatched.
  const publication = vi.spyOn(f.store, 'createTurn').mockImplementation(async (...args) => {
    const turn = await create(...args);
    if (turn.threadId === source.threadId && turn.id !== source.id) {
      published.resolve(turn);
      await release.promise;
    }
    return turn;
  });
  let completion: Promise<ReturnType<typeof f.store.getTurnById>> | undefined;
  f.cleanup.push(async () => {
    release.resolve();
    publication.mockRestore();
    await completion;
  });
  completion = f.complete(source.id);
  let restore: (() => void) | undefined;
  try {
    const delivery = await Promise.race([
      published.promise,
      completion.then(() => {
        throw new Error(
          `Outcome admission returned without a createTurn publication: ${JSON.stringify(f.pending.read(request.requestId))}`
        );
      }),
    ]);
    expect(delivery.triggerSource?.kind).toBe('user-input');
    expect(f.pending.read(request.requestId)?.delivery).toBe('frozen');
    expect(f.pending.read(request.requestId)?.deliveryTurnId).toBe(delivery.id);
    expect(() => f.pending.requireUsable(request.requestId, source.threadId)).not.toThrow();
    const contacts = f.dispatchCount();
    restore = setTestTurnTriggerActor(f.dataRoot, f.workspaceId, delivery.id, {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    expect(() => f.pending.requireUsable(request.requestId, source.threadId)).toThrow();
    release.resolve();
    await completion;
    await vi.waitFor(() => expect(f.store.getTurnById(delivery.id).status).toBe('failed'));
    expect(f.dispatchCount()).toBe(contacts);
  } finally {
    release.resolve();
    publication.mockRestore();
    await completion;
    await shutdownControlStoreWorkerClient();
    restore?.();
  }
});
