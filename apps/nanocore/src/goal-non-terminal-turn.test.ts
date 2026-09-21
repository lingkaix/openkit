import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('isNonTerminalTurn', () => {
  it('imports the sealed Turn terminal set instead of restating its complement', () => {
    const source = readFileSync(new URL('./goal-routes.ts', import.meta.url), 'utf8');
    const helper = source.match(/function isNonTerminalTurn\([\s\S]*?\n\}/)?.[0];

    expect(helper).toEqual(expect.stringContaining('isSealedTurnTerminal'));
    expect(helper).not.toEqual(expect.stringContaining("status === 'pending'"));
    expect(helper).not.toEqual(expect.stringContaining("status === 'running'"));
    expect(helper).not.toEqual(expect.stringContaining("status === 'awaiting_human'"));
  });
});
