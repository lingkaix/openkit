import { describe, expect, it } from 'vitest';
import { closeSheetSearch, openSheetSearch, phoneBarLabel, shortenProgress } from './phone';

describe('phone timeline copy', () => {
  it('shortens plan progress to the header line', () => {
    expect(shortenProgress('3 of 5 done · now: Update tests')).toBe('3/5 · Update tests');
    expect(shortenProgress('3 of 5 done')).toBe('3/5');
  });

  it('merges Now and Needs you on one line', () => {
    expect(phoneBarLabel('Running 12 min', 1)).toBe('Running 12 min · 1 needs you ›');
    expect(phoneBarLabel('Running 12 min', 0)).toBe('Running 12 min');
    expect(phoneBarLabel(null, 2)).toBe('2 needs you ›');
  });

  it('keeps one sheet in the query and can clear it', () => {
    const open = openSheetSearch('turnId=tu_1', 'decision', 'it_1');
    expect(new URLSearchParams(open).get('decision')).toBe('it_1');
    expect(new URLSearchParams(open).get('turnId')).toBe('tu_1');
    const next = openSheetSearch(open, 'steps', 'tu_2');
    expect(new URLSearchParams(next).get('decision')).toBeNull();
    expect(new URLSearchParams(next).get('steps')).toBe('tu_2');
    expect(closeSheetSearch(next)).toBe('turnId=tu_1');
  });
});
