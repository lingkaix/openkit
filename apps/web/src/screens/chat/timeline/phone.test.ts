import { describe, expect, it } from 'vitest';
import {
  closeSheetSearch,
  nextSheetStack,
  openSheetSearch,
  phoneBarLabel,
  shortenProgress,
} from './phone';

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

  it('keeps the first sheet when a second opens and replaces a third', () => {
    const steps = nextSheetStack([], 'steps', 'tu_1');
    expect(steps).toEqual({ mode: 'push', stack: [{ kind: 'steps', id: 'tu_1' }] });
    const inspect = nextSheetStack(steps.stack, 'inspect', 'tu_1');
    expect(inspect).toEqual({
      mode: 'push',
      stack: [
        { kind: 'steps', id: 'tu_1' },
        { kind: 'inspect', id: 'tu_1' },
      ],
    });
    expect(nextSheetStack(inspect.stack, 'decision', 'it_1')).toEqual({
      mode: 'replace',
      stack: [
        { kind: 'steps', id: 'tu_1' },
        { kind: 'decision', id: 'it_1' },
      ],
    });
  });
});
