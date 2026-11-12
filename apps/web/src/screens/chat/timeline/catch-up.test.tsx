import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { catchUpItemRefs, itemRefFromTimeline } from './catch-up';
import { dividerPlacement, earlierUnread } from './window';

const turnId = 'tu_00000000-0000-7a1a-a69e-d1682e886e7c';
const earlierTurn = 'tu_00000000-0000-7000-8000-000000000010';
const boundaryId = 'it_00000000-0000-76eb-a38d-371253d2bde1';
const nearerId = 'it_00000000-0000-7000-8000-000000000021';
const olderId = 'it_00000000-0000-7000-8000-000000000022';

describe('catch-up placement', () => {
  it('puts the divider after B when B is in the addressed item window and not the bounded narrative', () => {
    const runs = [
      {
        id: turnId,
        narrative: [{ id: nearerId, type: 'assistant-message' }],
      },
    ];
    const refs = catchUpItemRefs(runs, {
      items: [
        { id: boundaryId, turnId, type: 'user-message' },
        { id: nearerId, turnId, type: 'assistant-message' },
      ],
    });
    expect(
      dividerPlacement({
        runs,
        items: refs,
        catchUp: { turnId, itemId: boundaryId },
      })
    ).toEqual({ turnId, afterItemId: boundaryId });
  });

  it('does not name a nearer loaded message when an older unread is outside the window', () => {
    const items = [
      { id: nearerId, turnId, index: 0, type: 'user-message' },
      { id: boundaryId, turnId, index: 1, type: 'assistant-message' },
    ];
    const unreadIds = new Set([olderId, nearerId]);
    const runOrder = new Map([
      [earlierTurn, 1],
      [turnId, 2],
    ]);
    expect(
      earlierUnread({
        items,
        unreadIds,
        catchUp: { turnId, itemId: boundaryId },
        runOrder,
      })
    ).toEqual({ count: 0, oldestId: null });
    expect(
      earlierUnread({
        items,
        unreadIds,
        catchUp: { turnId, itemId: boundaryId },
        runOrder,
        located: [{ id: olderId, turnId: earlierTurn, index: 0, type: 'user-message' }],
      })
    ).toEqual({ count: 2, oldestId: olderId });
  });

  it('reads an item-anchor window when the narrative slice does not contain the item', () => {
    const page = {
      runs: [
        {
          id: earlierTurn,
          admissionOrder: 4,
          narrative: [],
        },
      ],
      itemWindow: {
        turnId: earlierTurn,
        items: [{ id: olderId, turnId: earlierTurn, type: 'user-message' }],
      },
    } as unknown as Pick<ThreadTimelineResponse, 'runs' | 'itemWindow'>;
    expect(itemRefFromTimeline(page, olderId)).toEqual({
      id: olderId,
      turnId: earlierTurn,
      index: 0,
      type: 'user-message',
      admissionOrder: 4,
    });
    expect(itemRefFromTimeline(page, boundaryId)).toBeNull();
  });
});
