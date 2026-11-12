import { ItemTypeSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  THREAD_TIMELINE_PLACEMENT,
  ThreadTimelineInputSchema,
  TimelineDigestSchema,
  TimelineItemDetailSchema,
  TimelineStatisticsSchema,
} from './thread-timeline.js';

const selector = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000001',
};

describe('bounded Thread timeline contract', () => {
  it('classifies every protocol Item with only the shared narrative/step fact', () => {
    expect(Object.keys(THREAD_TIMELINE_PLACEMENT).sort()).toEqual(
      [...ItemTypeSchema.options].sort()
    );
    expect(new Set(Object.values(THREAD_TIMELINE_PLACEMENT))).toEqual(
      new Set(['narrative', 'step'])
    );
    expect(THREAD_TIMELINE_PLACEMENT['user-message']).toBe('narrative');
    expect(THREAD_TIMELINE_PLACEMENT['command-execution']).toBe('step');
  });

  it('accepts latest, run, Item, attention and catch-up anchors and bounded Item windows', () => {
    for (const anchor of [
      { kind: 'latest' },
      { kind: 'turn', turnId: 'tu_00000000-0000-7000-8000-000000000001' },
      { kind: 'item', itemId: 'it_00000000-0000-7000-8000-000000000001' },
      { kind: 'attention', rowId: 'question:request' },
      { kind: 'catch-up' },
    ])
      expect(ThreadTimelineInputSchema.safeParse({ ...selector, anchor }).success).toBe(true);
    expect(
      ThreadTimelineInputSchema.safeParse({
        ...selector,
        view: 'items',
        turnId: 'tu_00000000-0000-7000-8000-000000000001',
        placement: 'step',
        limit: 50,
      }).success
    ).toBe(true);
  });

  it('rejects unbounded windows, ambiguous selectors and unknown effect-bearing fields', () => {
    for (const invalid of [
      { limit: 51 },
      { limit: 0 },
      { view: 'items' },
      { cursor: 'position', anchor: { kind: 'latest' } },
      { view: 'runs', placement: 'step' },
      { userId: 'another-viewer' },
    ])
      expect(ThreadTimelineInputSchema.safeParse({ ...selector, ...invalid }).success).toBe(false);
  });

  it('bounds deterministic digest lines and requires positive counts with real anchor kinds', () => {
    const line = {
      kind: 'new-messages',
      count: 2,
      anchor: { kind: 'item', itemId: 'it_00000000-0000-7000-8000-000000000001' },
    };
    expect(TimelineDigestSchema.safeParse({ lines: [line], coverage: 'complete' }).success).toBe(
      true
    );
    for (const invalid of [
      { lines: Array(8).fill(line), coverage: 'complete' },
      { lines: [{ ...line, count: 0 }], coverage: 'complete' },
      { lines: [{ ...line, anchor: { kind: 'unknown' } }], coverage: 'partial' },
      { lines: [line], coverage: 'guessed' },
    ])
      expect(TimelineDigestSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires explicit nonnegative current failure counts instead of a fabricated zero default', () => {
    const statistics = {
      steps: 3,
      failedStepCount: 2,
      failedCommandCount: 1,
      filesChanged: 0,
      messages: 0,
      itemCounts: {},
      coverage: 'complete',
    };
    expect(TimelineStatisticsSchema.safeParse(statistics).success).toBe(true);
    const { failedCommandCount: _omitted, ...missing } = statistics;
    expect(TimelineStatisticsSchema.safeParse(missing).success).toBe(false);
    expect(TimelineStatisticsSchema.safeParse({ ...statistics, failedStepCount: -1 }).success).toBe(
      false
    );
  });

  it('bounds preview UTF-8 bytes rather than JavaScript code units', () => {
    const preview = {
      kind: 'preview',
      text: '🙂'.repeat(1024),
      field: 'output',
      sizeBytes: 5_000_000,
      side: 'tail',
      truncated: true,
    };
    expect(TimelineItemDetailSchema.safeParse(preview).success).toBe(true);
    expect(
      TimelineItemDetailSchema.safeParse({ ...preview, text: `${preview.text}x` }).success
    ).toBe(false);
  });
});
