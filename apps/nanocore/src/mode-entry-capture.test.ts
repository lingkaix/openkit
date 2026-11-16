import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { assistantWiringFixture } from './test-support/mode-entry-fixture.js';

it('continues Assistant commands across declared segments without changing request replay or losing history (#732)', async () => {
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await assistantWiringFixture(
    false,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    { maxObservationLines: 10_000, maxBytes: 1, boundaryDelayed: true }
  );
  try {
    const firstResponse = await f.submit();
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = SubmitConversationResponseSchema.parse(await firstResponse.json());
    expect(first.turn.threadId).toBe(f.thread.id);
    const firstItems = f.store.getTurnById(first.turn.id).items;
    const requestId = '00000000-0000-4000-8000-000000001442';
    const response = await f.submit(requestId);
    expect(
      response.status,
      `${await response.clone().text()} ${JSON.stringify(diagnostics.mock.calls)}`
    ).toBe(200);
    const second = SubmitConversationResponseSchema.parse(await response.json());
    expect(second.turn.id).not.toBe(first.turn.id);
    expect(second.turn.threadId).not.toBe(first.turn.threadId);
    expect(
      f.store.getThread(
        first.turn.owner.kind === 'workspace' ? first.turn.owner.workspaceId : '',
        second.turn.threadId
      )
    ).toMatchObject({
      parentThreadId: first.turn.threadId,
      segment: 1,
      segmentation: f.thread.segmentation,
    });
    expect(f.store.getTurnById(first.turn.id).items).toEqual(firstItems);
    expect(JSON.stringify(f.createResponses.mock.calls[1]?.[1])).toContain('The direct answer.');
    const replay = await f.submit(requestId);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(SubmitConversationResponseSchema.parse(await replay.json())).toEqual(second);
    expect(f.createResponses).toHaveBeenCalledTimes(2);
  } finally {
    diagnostics.mockRestore();
    await f.close();
  }
});
