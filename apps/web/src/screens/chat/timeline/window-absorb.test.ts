import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import {
  absorbPoll,
  admissionGaps,
  type HeldTimeline,
  narrativePreviews,
  retainWindowWhileAnchorLoads,
} from './window';

function run(order: number): TimelineRunEntry {
  return { id: `tu-${order}`, admissionOrder: order } as TimelineRunEntry;
}

function held(
  orders: number[],
  cursors: { before: string | null; after: string | null },
  pagedEarlier = false,
  pagedLater = false
): HeldTimeline {
  return {
    runs: orders.map(run),
    beforeCursor: cursors.before,
    afterCursor: cursors.after,
    anchor: null,
    catchUpAnchor: null,
    itemWindow: null,
    restrictedReferences: false,
    pagedEarlier,
    pagedLater,
  };
}

function fresh(
  orders: number[],
  cursors: { before: string | null; after: string | null }
): Parameters<typeof absorbPoll>[1] {
  return {
    runs: orders.map(run),
    beforeCursor: cursors.before,
    afterCursor: cursors.after,
    anchor: null,
    catchUpAnchor: null,
    itemWindow: null,
    restrictedReferences: false,
  };
}

function ordersOf(page: HeldTimeline): number[] {
  return page.runs.map((entry) => entry.admissionOrder);
}

describe('timeline poll history', () => {
  it('keeps the gap between a held window and a later poll reachable', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: null, after: 'after-31' }
      ),
      fresh(
        Array.from({ length: 31 }, (_, index) => index + 41),
        { before: 'before-41', after: null }
      )
    );
    expect(ordersOf(polled)).toEqual(Array.from({ length: 31 }, (_, index) => index + 41));
    expect(admissionGaps(ordersOf(polled)).missing).toEqual([]);
    expect(polled.beforeCursor).toBe('before-41');
    expect(ordersOf(polled)).not.toContain(32);
  });

  it('does not seal a gap when the fresh page has no backward cursor', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: null, after: 'after-31' }
      ),
      fresh(
        Array.from({ length: 31 }, (_, index) => index + 41),
        { before: null, after: null }
      )
    );
    expect(ordersOf(polled)).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
    expect(polled.afterCursor).toBe('after-31');
    expect(admissionGaps(ordersOf(polled)).missing).toEqual([]);
  });

  it('does not rewind a cursor that already reached the newest run', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 50),
        { before: 'before-50', after: null },
        true
      ),
      fresh(
        Array.from({ length: 20 }, (_, index) => index + 1),
        { before: null, after: 'later' }
      )
    );
    expect(polled.afterCursor).toBeNull();
    expect(ordersOf(polled)).toContain(80);
    expect(ordersOf(polled)).not.toContain(1);
  });

  it('does not re-arm Load later after the reader reached the end', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: 'start', after: null },
        true
      ),
      fresh(
        Array.from({ length: 12 }, (_, index) => index + 20),
        { before: 'mid', after: 'again' }
      )
    );
    expect(polled.afterCursor).toBeNull();
    expect(ordersOf(polled)).toContain(1);
    expect(ordersOf(polled)).toContain(31);
  });

  it('does not keep every run a latest poll has slid past', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: 'older', after: null }
      ),
      fresh(
        Array.from({ length: 31 }, (_, index) => index + 2),
        { before: 'older-2', after: null }
      )
    );
    expect(ordersOf(polled)).toEqual(Array.from({ length: 31 }, (_, index) => index + 2));
    expect(ordersOf(polled)).not.toContain(1);
    expect(polled.beforeCursor).toBe('older-2');
  });

  it('keeps a page the reader already moved forward into', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: 'older', after: null },
        false,
        true
      ),
      fresh(
        Array.from({ length: 31 }, (_, index) => index + 2),
        { before: 'older-2', after: null }
      )
    );
    expect(ordersOf(polled)).toContain(1);
    expect(ordersOf(polled)).toContain(32);
    expect(polled.afterCursor).toBeNull();
  });

  it('keeps runs the reader paged to when the tail refreshes', () => {
    const polled = absorbPoll(
      held(
        Array.from({ length: 31 }, (_, index) => index + 1),
        { before: null, after: null },
        true
      ),
      fresh(
        Array.from({ length: 31 }, (_, index) => index + 2),
        { before: 'older-2', after: null }
      )
    );
    expect(ordersOf(polled)).toContain(1);
    expect(ordersOf(polled)).toContain(32);
  });
});

describe('timeline previews', () => {
  it('keeps a non-truncated preview between the Items around it', () => {
    const items = [
      { id: 'it-1', detail: { kind: 'complete' }, placement: 'narrative' },
      {
        id: 'it-2',
        detail: { kind: 'preview', text: 'plan head', truncated: false },
        placement: 'narrative',
      },
      { id: 'it-3', detail: { kind: 'complete' }, placement: 'narrative' },
    ] as TimelineItem[];
    expect(narrativePreviews(items)).toEqual([
      {
        id: 'it-2',
        afterItemId: 'it-1',
        text: 'plan head',
        truncated: false,
        placement: 'narrative',
      },
    ]);
  });
});

describe('anchor reload', () => {
  it('keeps the same thread window and drops a different thread', () => {
    const previous = { runs: [1] };
    expect(
      retainWindowWhileAnchorLoads('ws', 'th', previous, ['thread-timeline', 'ws', 'th', 'latest'])
    ).toBe(previous);
    expect(
      retainWindowWhileAnchorLoads('ws', 'th', previous, [
        'thread-timeline',
        'ws',
        'other',
        'latest',
      ])
    ).toBeUndefined();
  });
});
