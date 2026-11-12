import { describe, expect, it } from 'vitest';
import {
  contentAdmitted,
  historyModeForHref,
  readTimelineHistory,
  replaceAnchorSearch,
  rowIdFromSearch,
  turnIdFromSearch,
  viewingThreadId,
  writeTimelineHistory,
} from './navigation-state';
import { nextSheetDepth, sheetDepthOf } from './phone';

describe('navigation restore rules', () => {
  it('admits content only after this mount finishes a successful read', () => {
    expect(
      contentAdmitted({ succeeded: true, fetching: false, updatedAt: 20, mountedAt: 10 })
    ).toBe(true);
    expect(contentAdmitted({ succeeded: true, fetching: true, updatedAt: 20, mountedAt: 10 })).toBe(
      false
    );
    expect(contentAdmitted({ succeeded: true, fetching: false, updatedAt: 5, mountedAt: 10 })).toBe(
      false
    );
    expect(
      contentAdmitted({ succeeded: false, fetching: false, updatedAt: 20, mountedAt: 10 })
    ).toBe(false);
  });

  it('reads the thread being viewed, including a goal output under that thread', () => {
    expect(viewingThreadId('/tasks/ws/th_1')).toBe('th_1');
    expect(viewingThreadId('/goals/ws/th_1/artifacts/art_1')).toBe('th_1');
    expect(viewingThreadId('/attention')).toBeNull();
  });

  it('replaces jumps inside the thread and pushes another surface', () => {
    expect(historyModeForHref('/tasks/ws/th_1', '/tasks/ws/th_1?turn=tu_1')).toBe('replace');
    expect(historyModeForHref('/tasks/ws/th_1', '/workspace/usage')).toBe('push');
  });

  it('accepts spec anchor names and the shipped names', () => {
    expect(turnIdFromSearch(new URLSearchParams('turn=tu_new'))).toBe('tu_new');
    expect(turnIdFromSearch(new URLSearchParams('turnId=tu_old'))).toBe('tu_old');
    expect(rowIdFromSearch(new URLSearchParams('row=row_1'))).toBe('row_1');
    expect(rowIdFromSearch(new URLSearchParams('attention=row_2'))).toBe('row_2');
    expect(replaceAnchorSearch('turn=tu_1&item=it_1&row=r&catchUp=1&lens=work')).toBe('lens=work');
  });

  it('stores scroll and expanded runs on the history entry without a URL change', () => {
    const history: {
      state: { idx: number; key: string; usr: { okSheet: string } };
      replaceState: (state: unknown) => void;
    } = {
      state: { idx: 2, key: 'k', usr: { okSheet: 'decision' } },
      replaceState(state: unknown) {
        this.state = state as typeof this.state;
      },
    };
    writeTimelineHistory(history, { scrollTop: 40, expandedRunIds: ['tu_1'] }, '/tasks/ws/th');
    expect(readTimelineHistory(history.state)).toEqual({
      scrollTop: 40,
      expandedRunIds: ['tu_1'],
    });
    expect((history.state as { usr: { okSheet: string } }).usr.okSheet).toBe('decision');
    expect((history.state as { idx: number }).idx).toBe(2);
    expect(
      writeTimelineHistory({ state: null, replaceState() {} }, { scrollTop: 1 })
    ).toBeUndefined();
  });

  it('stacks phone sheets two deep and replaces the third', () => {
    expect(sheetDepthOf(null)).toBe(0);
    expect(sheetDepthOf({ usr: { sheetDepth: 1 } })).toBe(1);
    expect(nextSheetDepth(0)).toEqual({ mode: 'push', depth: 1 });
    expect(nextSheetDepth(1)).toEqual({ mode: 'push', depth: 2 });
    expect(nextSheetDepth(2)).toEqual({ mode: 'replace', depth: 2 });
  });
});
