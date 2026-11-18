import { randomUUID } from 'node:crypto';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { assistantWiringFixture, conversationBody } from './test-support/mode-entry-fixture.js';
import { operationRequest } from './test-support/operation-request.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';

/** Calls the public conversation operation with its ordinary authored target. */
function submit(
  f: Awaited<ReturnType<typeof assistantWiringFixture>>,
  targetRef: string,
  requestId = randomUUID()
) {
  return f.app.request(
    ...operationRequest(
      'conversation.submit',
      { workspaceId, threadId: f.thread.id },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: conversationBody({ input: 'Explain this bounded request.', targetRef, requestId }),
      }
    )
  );
}

describe('common conversation origin admission', () => {
  it('closes only its own failed preparation and admits a later request', async () => {
    const f = await assistantWiringFixture();
    onTestFinished(() => f.close());
    const peer = await f.store.createThread(workspaceId, 'Independent work');
    const live = await f.store.createTurn(workspaceId, peer.id, 'Unrelated', {
      kind: 'user',
      id: f.actorUserId,
    });
    const failure = vi
      .spyOn(f.store, 'createItem')
      .mockRejectedValueOnce(new Error('Injected Item publication fault.'));
    const response = await f.submit();
    failure.mockRestore();
    expect(response.status).toBe(500);
    expect(f.store.listThreadTurns(workspaceId, f.thread.id)).toMatchObject([{ status: 'failed' }]);
    expect(f.store.getTurnById(live.id).status).toBe('running');
    expect(f.dispatchCount()).toBe(0);
    const later = await f.store.createTurn(workspaceId, f.thread.id, 'Later request', {
      kind: 'user',
      id: f.actorUserId,
    });
    expect(later.status).toBe('running');
  });
  it.each([
    'internal-role:assistant',
    'internal-role:knowledge-manager',
    'new-task-worker',
    'goal-coordinator:unavailable',
  ])('refuses a busy origin before target effects for %s', async (targetRef) => {
    const f = await assistantWiringFixture();
    onTestFinished(() => f.close());
    const live = await f.store.createTurn(workspaceId, f.thread.id, 'Existing', {
      kind: 'user',
      id: f.actorUserId,
    });
    const threads = f.store.listThreads(workspaceId);
    const result = await submit(f, targetRef);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'thread_busy' });
    expect(f.store.listThreads(workspaceId)).toEqual(threads);
    expect(f.store.listThreadTurns(workspaceId, f.thread.id).map((turn) => turn.id)).toEqual([
      live.id,
    ]);
    expect(f.dispatchCount()).toBe(0);
  });

  it.each([
    ['private', 'pending'],
    ['private', 'running'],
    ['workspace', 'pending'],
    ['workspace', 'running'],
  ] as const)(
    'refuses a non-Assistant target through a %s segment with a %s head',
    async (visibility, status) => {
      const f = await assistantWiringFixture(
        false,
        undefined,
        false,
        undefined,
        false,
        undefined,
        undefined,
        {
          maxObservationLines: 10000,
          maxBytes: 1,
          boundaryDelayed: true,
        }
      );
      onTestFinished(() => f.close());
      const origin =
        visibility === 'private'
          ? f.thread
          : await f.store.createThread(workspaceId, 'Segment origin', undefined, 'conversation', {
              visibility,
              segmentation: { maxObservationLines: 10000, maxBytes: 1, boundaryDelayed: true },
            });
      const previous = await f.store.createTurn(workspaceId, origin.id, 'Prior segment', {
        kind: 'user',
        id: f.actorUserId,
      });
      await f.store.createItem({
        id: allocateEntityId('it'),
        owner: previous.owner,
        threadId: origin.id,
        turnId: previous.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Retained segment bytes.',
        createdAt: previous.startedAt!,
        completedAt: new Date().toISOString(),
      });
      await f.store.completeTurn(previous.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const head = await f.store.createThread(
        workspaceId,
        'Segment head',
        undefined,
        'conversation',
        {
          visibility,
          ...(visibility === 'private' ? { privateOwnerUserId: f.actorUserId } : {}),
          parentThreadId: origin.id,
          segment: 1,
          segmentation: origin.segmentation,
        }
      );
      const live = await f.store.createTurn(
        workspaceId,
        head.id,
        'Existing head work',
        {
          kind: 'user',
          id: f.actorUserId,
        },
        null,
        { status }
      );
      const response = await f.app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId,
            threadId: origin.id,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: conversationBody({
              input: 'Continue',
              targetRef: 'new-task-worker',
              requestId: randomUUID(),
            }),
          }
        )
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'thread_busy' });
      expect(f.store.listThreadTurns(workspaceId, origin.id).map((turn) => turn.id)).toEqual([
        previous.id,
      ]);
      expect(f.store.listThreadTurns(workspaceId, head.id).map((turn) => turn.id)).toEqual([
        live.id,
      ]);
      expect(f.dispatchCount()).toBe(0);
    }
  );

  it('keeps exact receipt replay available while a later Turn is running', async () => {
    const f = await assistantWiringFixture();
    onTestFinished(() => f.close());
    const response = await f.submit();
    expect(response.status).toBe(200);
    const body = await response.json();
    await f.store.createTurn(workspaceId, f.thread.id, 'Later', {
      kind: 'user',
      id: f.actorUserId,
    });
    const calls = f.dispatchCount();
    const replay = await f.submit();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect(f.dispatchCount()).toBe(calls);
  });

  it('admits one of two simultaneous Assistant commands before provider dispatch', async () => {
    const f = await assistantWiringFixture();
    onTestFinished(() => f.close());
    const results = await Promise.all([f.submit(randomUUID()), f.submit(randomUUID())]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const refused = results.find((result) => result.status === 409)!;
    expect(await refused.json()).toMatchObject({ code: 'thread_busy' });
    expect(f.dispatchCount()).toBe(1);
    expect(f.store.listThreadTurns(workspaceId, f.thread.id)).toHaveLength(1);
  });
});
