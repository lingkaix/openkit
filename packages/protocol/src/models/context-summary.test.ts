import { describe, expect, it } from 'vitest';
import { ItemSchema } from './item.js';

const summary = {
  id: 'summary',
  workspaceId: 'workspace',
  threadId: 'thread',
  turnId: 'turn',
  type: 'context-summary',
  status: 'completed',
  createdAt: '2026-10-16T00:00:00.000Z',
  completedAt: '2026-10-16T00:00:00.000Z',
  text: 'Retain the deployment constraint and unresolved decision.',
  environmentDigest: `sha256:${'1'.repeat(64)}`,
  sourceRange: {
    firstItemId: 'first',
    lastItemId: 'last',
    itemCount: 2,
    sourceDigest: `sha256:${'2'.repeat(64)}`,
    evidenceDigest: `sha256:${'3'.repeat(64)}`,
  },
};

describe('source-bound continuation summary Item', () => {
  it('accepts the required closed summary core and ignores descriptive additions', () => {
    expect(ItemSchema.parse(summary)).toEqual(summary);
    expect(
      ItemSchema.parse({
        ...summary,
        annotation: 'future',
        sourceRange: {
          ...summary.sourceRange,
          annotation: 'future',
        },
      })
    ).toEqual(summary);
  });

  it('requires exact range, source digests, environment, complete output and bounded text', () => {
    for (const field of [
      'firstItemId',
      'lastItemId',
      'itemCount',
      'sourceDigest',
      'evidenceDigest',
    ]) {
      const sourceRange = { ...summary.sourceRange } as Record<string, unknown>;
      delete sourceRange[field];
      expect(ItemSchema.safeParse({ ...summary, sourceRange }).success).toBe(false);
    }
    for (const patch of [
      { environmentDigest: undefined },
      { status: 'in_progress' },
      { text: '' },
      { text: 'x'.repeat(65_537) },
      { text: '界'.repeat(30_000) },
      { completedAt: null },
      { sourceRange: { ...summary.sourceRange, itemCount: 0 } },
      { sourceRange: { ...summary.sourceRange, sourceDigest: 'unverified' } },
    ])
      expect(ItemSchema.safeParse({ ...summary, ...patch }).success).toBe(false);
  });

  it('keeps unknown kinds invalid and existing message records readable', () => {
    expect(ItemSchema.safeParse({ ...summary, type: 'unknown-summary' }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...summary, type: 'assistant-message' }).success).toBe(true);
  });
});
