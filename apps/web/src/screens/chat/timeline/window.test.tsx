import {
  ThreadTimelineInputSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CatchUpDivider } from './CatchUpDivider';
import type { AgentProfileId } from './profiles';
import { RunEntry } from './RunEntry';
import type { TimelineEntry } from './source';
import {
  absorbEdge,
  absorbItemEdge,
  absorbPoll,
  admissionGaps,
  anchorFromSearch,
  anchorInput,
  cursorInput,
  dividerPlacement,
  earlierUnread,
  entryFromRun,
  holdFromResponse,
  holdItems,
  isFollowing,
  itemAnchorHasLevel2,
  keepsUnreadMark,
  level2Input,
  mergeItemPage,
  mergeRuns,
  newContentExceedsScreen,
  offersOpenAllSteps,
  openingInput,
  provisionalOpeningAnchor,
  runStaysNew,
  scrollCorrection,
  settledOpeningAnchor,
  shouldPageEdge,
  showCatchUpDivider,
  showJumpToLatest,
  TIMELINE_READ_GAPS,
  textFrames,
  timelineJump,
  wantsMeasuredOpening,
  windowPollMs,
} from './window';

const workspaceId = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';
const threadId = 'th_00000000-0000-7b47-b9e3-5a516884858f';
const turnId = 'tu_00000000-0000-7a1a-a69e-d1682e886e7c';
const itemId = 'it_00000000-0000-76eb-a38d-371253d2bde1';

function run(
  order: number,
  id = `tu_00000000-0000-7000-8000-${String(order).padStart(12, '0')}`
): TimelineRunEntry {
  return {
    id,
    admissionOrder: order,
    status: 'completed',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    agentId: null,
    triggerSource: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    long: false,
    narrative: [],
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps: 0,
      failedStepCount: 0,
      failedCommandCount: 0,
      filesChanged: 0,
      messages: 0,
      itemCounts: {},
      coverage: 'complete',
    },
    interruptedBy: { visibility: 'available', actor: null },
    restrictedReferences: false,
  };
}

function item(id: string): TimelineItem {
  return { id } as TimelineItem;
}

describe('timeline window anchors', () => {
  it.each([
    ['latest', anchorFromSearch('')],
    ['run', anchorFromSearch(`?turnId=${turnId}`)],
    ['spec run', anchorFromSearch(`?turn=${turnId}`)],
    ['item', anchorFromSearch(`?item=${itemId}`)],
    ['attention', anchorFromSearch('?attention=row-1')],
    ['spec row', anchorFromSearch('?row=row-1')],
    ['catch-up', anchorFromSearch('?catchUp=1')],
  ] as const)('resolves a %s anchor into a read the server accepts', (_label, anchor) => {
    const input = openingInput(workspaceId, threadId, anchor);
    expect(ThreadTimelineInputSchema.safeParse(input).success).toBe(true);
    expect(input.anchor).toEqual(anchorInput(anchor));
    expect(input.cursor).toBeUndefined();
    expect(input.limit).toBeUndefined();
  });

  it('prefers an Item deep link over a run id in the same URL', () => {
    expect(anchorFromSearch(`?turnId=${turnId}&item=${itemId}`).kind).toBe('item');
  });

  it('treats an Item anchor as open only when its Level-2 window came back', () => {
    expect(
      itemAnchorHasLevel2({
        anchor: { turnId, itemId },
        itemWindow: { turnId, items: [], beforeCursor: null, afterCursor: null },
      })
    ).toBe(true);
    expect(itemAnchorHasLevel2({ anchor: { turnId }, itemWindow: null })).toBe(false);
  });

  it('does not invent a catch-up digest', () => {
    expect(TIMELINE_READ_GAPS.some((gap) => gap.includes('digest'))).toBe(true);
    const held = holdFromResponse({
      workspaceId,
      threadId,
      view: 'runs',
      runs: [],
      items: [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: null,
      catchUpAnchor: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
    expect(held).not.toHaveProperty('digest');
  });
});

describe('timeline cursor paging', () => {
  it('pages both ways under a concurrent append without inventing a missing admission', () => {
    const held = [10, 11, 12, 13].map((order) => run(order));
    const earlier = [8, 9, 10].map((order) => run(order));
    const appended = [13, 14].map((order) => run(order));
    const afterEarlier = mergeRuns(held, earlier);
    const afterAppend = mergeRuns(afterEarlier, appended);
    expect(afterAppend.map((entry) => entry.admissionOrder)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(admissionGaps(afterAppend.map((entry) => entry.admissionOrder))).toEqual({
      duplicate: false,
      missing: [],
    });
    const page = holdFromResponse({
      workspaceId,
      threadId,
      view: 'runs',
      runs: earlier,
      items: [],
      beforeCursor: 'older',
      afterCursor: 'ignored',
      itemWindow: null,
      anchor: null,
      catchUpAnchor: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
    const absorbed = absorbEdge(
      {
        runs: held,
        beforeCursor: 'mid',
        afterCursor: null,
        anchor: null,
        catchUpAnchor: null,
        itemWindow: null,
        restrictedReferences: false,
      },
      page,
      'before'
    );
    expect(absorbed.beforeCursor).toBe('older');
    expect(absorbed.afterCursor).toBeNull();
    const polled = absorbPoll(absorbed, {
      ...page,
      runs: [run(12), run(13), run(15)],
      beforeCursor: 'fresh-before',
      afterCursor: 'fresh-after',
    });
    expect(polled.runs.map((entry) => entry.admissionOrder)).toEqual([8, 9, 10, 11, 12, 13, 15]);
    expect(polled.beforeCursor).toBe('older');
    expect(polled.afterCursor).toBe('fresh-after');
    // Admission 14 is in neither page. The overlap must not invent it.
    expect(admissionGaps(polled.runs.map((entry) => entry.admissionOrder)).missing).toEqual([14]);
  });

  it('sends a cursor alone', () => {
    const input = cursorInput(workspaceId, threadId, 'cursor-1');
    expect(ThreadTimelineInputSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({ workspaceId, threadId, cursor: 'cursor-1' });
  });
});

describe('timeline level 2', () => {
  it('pages 50 Items both ways and offers Open all steps only past 500', () => {
    const input = level2Input(workspaceId, threadId, turnId, 'step');
    expect(input.limit).toBe(50);
    expect(ThreadTimelineInputSchema.safeParse(input).success).toBe(true);
    const current = Array.from({ length: 50 }, (_, index) => item(`keep-${index}`));
    const older = [item('old'), ...current.slice(0, 5)];
    const merged = mergeItemPage(current, older, 'before');
    expect(merged[0]?.id).toBe('old');
    expect(new Set(merged.map((entry) => entry.id)).size).toBe(merged.length);
    expect(merged).toHaveLength(51);
    const held = absorbItemEdge(
      holdItems(current, 'b', 'a'),
      { items: [item('new')], beforeCursor: 'b', afterCursor: null },
      'after'
    );
    expect(held.items.at(-1)?.id).toBe('new');
    expect(held.afterCursor).toBeNull();
    expect(held.beforeCursor).toBe('b');
    expect(offersOpenAllSteps(500)).toBe(false);
    expect(offersOpenAllSteps(501)).toBe(true);
  });
});

describe('timeline scroll and follow', () => {
  it('corrects a prepend in place and follows only within 48 px', () => {
    expect(scrollCorrection(100, 340)).toBe(240);
    expect(Math.abs(100 + scrollCorrection(100, 102) - 102)).toBeLessThanOrEqual(2);
    expect(isFollowing(48)).toBe(true);
    expect(isFollowing(49)).toBe(false);
    expect(shouldPageEdge(100, 800)).toBe(true);
    expect(shouldPageEdge(2_000, 800)).toBe(false);
    expect(showJumpToLatest({ kind: 'item', itemId }, null)).toBe(true);
    expect(showJumpToLatest({ kind: 'latest' }, null)).toBe(false);
    expect(showJumpToLatest({ kind: 'latest' }, 'later')).toBe(true);
  });

  it('coalesces 100 text deltas to at most 10 frames in one second', () => {
    expect(textFrames(100, 1_000)).toBe(10);
    expect(textFrames(100, 50)).toBe(1);
    expect(windowPollMs({ hidden: true, running: true, pending: false })).toBe(false);
    expect(windowPollMs({ hidden: false, running: false, pending: false })).toBe(15_000);
    expect(windowPollMs({ hidden: false, running: true, pending: false })).toBe(5_000);
  });
});

describe('Open all steps', () => {
  it('offers the paged sheet past 500 steps and keeps the step fold', async () => {
    const user = userEvent.setup();
    const onOpenAllSteps = vi.fn();
    const entry: TimelineEntry = {
      ...entryFromRun(run(1, turnId)),
      stats: { stepCount: 501, fileCount: 0, failedCommandCount: 0, failedStepCount: 0 },
    };
    render(
      <RunEntry
        entry={entry}
        items={[]}
        turn={{ id: turnId, status: 'completed' }}
        lens="work"
        expanded={false}
        actorName="Worker"
        omitTrigger={false}
        durationMs={null}
        hiddenIds={new Set()}
        renderItem={() => null}
        inspected={false}
        onInspect={() => undefined}
        onOpenAllSteps={onOpenAllSteps}
        showActivity={false}
      />
    );
    expect(screen.getByRole('button', { name: '501 steps' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open all steps' }));
    expect(onOpenAllSteps).toHaveBeenCalledOnce();
  });
});

const profiles: readonly AgentProfileId[] = [
  'assistant',
  'task',
  'goal',
  'knowledge',
  'administration',
  'default',
];
const measured: readonly AgentProfileId[] = ['task', 'goal', 'knowledge', 'default'];

describe('catch-up opening', () => {
  it('lets an explicit anchor win for every profile', () => {
    const explicit = [
      { kind: 'item' as const, itemId },
      { kind: 'turn' as const, turnId },
      { kind: 'attention' as const, rowId: 'row-1' },
      { kind: 'catch-up' as const },
    ];
    for (const profile of profiles) {
      for (const anchor of explicit) {
        expect(provisionalOpeningAnchor(profile, anchor)).toEqual(anchor);
        expect(settledOpeningAnchor(profile, anchor, true)).toEqual(anchor);
        expect(settledOpeningAnchor(profile, anchor, false)).toEqual(anchor);
      }
    }
  });

  it('opens a long tail at the divider and a short tail at the end, following', () => {
    for (const profile of measured) {
      expect(wantsMeasuredOpening(profile)).toBe(true);
      expect(provisionalOpeningAnchor(profile, { kind: 'latest' })).toEqual({ kind: 'catch-up' });
      expect(settledOpeningAnchor(profile, { kind: 'latest' }, true)).toEqual({ kind: 'catch-up' });
      const short = settledOpeningAnchor(profile, { kind: 'latest' }, false);
      expect(short).toEqual({ kind: 'latest' });
      expect(short.kind === 'latest' && isFollowing(0)).toBe(true);
    }
    for (const profile of ['assistant', 'administration'] as const) {
      expect(wantsMeasuredOpening(profile)).toBe(false);
      expect(provisionalOpeningAnchor(profile, { kind: 'latest' })).toEqual({ kind: 'latest' });
      expect(settledOpeningAnchor(profile, { kind: 'latest' }, true)).toEqual({ kind: 'latest' });
    }
    expect(newContentExceedsScreen({ continues: true, contentAfterPx: 0, viewportPx: 800 })).toBe(
      true
    );
    expect(
      newContentExceedsScreen({ continues: false, contentAfterPx: 100, viewportPx: 100 })
    ).toBe(false);
    expect(
      newContentExceedsScreen({ continues: false, contentAfterPx: 101, viewportPx: 100 })
    ).toBe(true);
  });

  it('places the divider after B inside that run', () => {
    const running = { id: turnId };
    const loaded = [
      { id: 'older', turnId, index: 0, type: 'user-message' },
      { id: itemId, turnId, index: 1, type: 'assistant-message' },
    ];
    expect(
      dividerPlacement({
        runs: [running],
        items: loaded,
        catchUp: { turnId, itemId },
      })
    ).toEqual({ turnId, afterItemId: itemId });
    expect(
      dividerPlacement({
        runs: [running],
        items: [{ id: 'older', turnId, index: 0, type: 'user-message' }],
        catchUp: { turnId, itemId },
      })
    ).toEqual({ turnId, afterItemId: null });
    expect(
      dividerPlacement({
        runs: [{ id: 'other' }],
        items: loaded,
        catchUp: { turnId, itemId },
      })
    ).toBeNull();
  });

  it('keeps an unread mark before B and names the oldest jump', () => {
    const unread = new Set(['before', itemId, 'after']);
    expect(keepsUnreadMark('before', unread)).toBe(true);
    expect(keepsUnreadMark('read', unread)).toBe(false);
    const found = earlierUnread({
      items: [
        { id: 'before', turnId: 'earlier', index: 0, type: 'user-message' },
        { id: 'same', turnId, index: 0, type: 'assistant-message' },
        { id: itemId, turnId, index: 1, type: 'assistant-message' },
        { id: 'after', turnId, index: 2, type: 'user-message' },
      ],
      unreadIds: new Set(['before', 'same', itemId, 'after']),
      catchUp: { turnId, itemId },
      runOrder: new Map([
        ['earlier', 1],
        [turnId, 2],
      ]),
    });
    expect(found).toEqual({ count: 2, oldestId: 'before' });
    expect(
      showCatchUpDivider({ profile: 'assistant', catchUp: { turnId }, hasUnreadAnswer: false })
    ).toBe(false);
    expect(
      showCatchUpDivider({ profile: 'assistant', catchUp: { turnId }, hasUnreadAnswer: true })
    ).toBe(true);
    expect(
      showCatchUpDivider({ profile: 'administration', catchUp: { turnId }, hasUnreadAnswer: true })
    ).toBe(false);
    expect(
      showCatchUpDivider({ profile: 'task', catchUp: { turnId }, hasUnreadAnswer: false })
    ).toBe(true);
  });

  it('leaves a silent ended run new and replaces a divider jump', () => {
    expect(
      runStaysNew({ status: 'completed', messages: 0, admissionOrder: 4, catchUpOrder: 2 })
    ).toBe(true);
    for (const status of ['failed', 'interrupted', 'cancelled']) {
      expect(runStaysNew({ status, messages: 0, admissionOrder: 4, catchUpOrder: 2 })).toBe(true);
    }
    expect(
      runStaysNew({ status: 'running', messages: 0, admissionOrder: 4, catchUpOrder: 2 })
    ).toBe(false);
    expect(
      runStaysNew({ status: 'completed', messages: 1, admissionOrder: 4, catchUpOrder: 2 })
    ).toBe(false);
    expect(
      runStaysNew({ status: 'completed', messages: 0, admissionOrder: 2, catchUpOrder: 2 })
    ).toBe(false);
    expect(
      runStaysNew({ status: 'completed', messages: 0, admissionOrder: 4, catchUpOrder: null })
    ).toBe(false);
    const itemJump = timelineJump({
      pathname: '/tasks/ws/th',
      search: `?turnId=${turnId}&turn=${turnId}&attention=row&row=row-1&catchUp=1&request=req_1`,
      jump: { kind: 'item', itemId },
    });
    expect(itemJump).toEqual({
      pathname: '/tasks/ws/th',
      search: `?item=${itemId}`,
      replace: true,
    });
    expect(
      timelineJump({ pathname: '/chat/ws/th', search: '', jump: { kind: 'catch-up' } })
    ).toEqual({ pathname: '/chat/ws/th', search: '?catchUp=1', replace: true });
    expect(
      timelineJump({ pathname: '/chat/ws/th', search: `?item=${itemId}`, jump: { kind: 'latest' } })
    ).toEqual({ pathname: '/chat/ws/th', search: '', replace: true });
  });

  it('offers the earlier-unread jump and no digest list', async () => {
    const user = userEvent.setup();
    const onEarlierUnread = vi.fn();
    render(
      <MemoryRouter>
        <CatchUpDivider count={2} onEarlierUnread={onEarlierUnread} />
      </MemoryRouter>
    );
    expect(screen.getByText('New since you were here')).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
    await user.click(screen.getByRole('button', { name: '2 earlier unread ›' }));
    expect(onEarlierUnread).toHaveBeenCalledOnce();
  });

  it('hides the jump when nothing earlier is unread', () => {
    render(
      <MemoryRouter>
        <CatchUpDivider count={0} onEarlierUnread={() => undefined} />
      </MemoryRouter>
    );
    expect(screen.getByText('New since you were here')).toBeVisible();
    expect(screen.queryByRole('button', { name: /earlier unread/ })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
