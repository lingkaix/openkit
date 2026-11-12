import { ItemTypeSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  THREAD_TIMELINE_PLACEMENT,
  ThreadTimelineInputSchema,
  TimelineDigestSchema,
  TimelineItemDetailSchema,
  TimelinePlanSegmentsSchema,
  TimelinePolicyBadgeSchema,
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

  it('requires exact typed policy references and a recorded outcome', () => {
    const badge = {
      outcome: 'waiting-approval',
      permissionDecisionId: 'pd_00000000-0000-7000-8000-000000000001',
      capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
      connectionRef: null,
    };
    expect(TimelinePolicyBadgeSchema.safeParse(badge).success).toBe(true);
    expect(
      TimelinePolicyBadgeSchema.safeParse({ ...badge, outcome: 'probably-allowed' }).success
    ).toBe(false);
    expect(
      TimelinePolicyBadgeSchema.safeParse({ ...badge, permissionDecisionId: 'missing' }).success
    ).toBe(false);
  });

  it('bounds plan intervals and rejects negative counts', () => {
    const segment = {
      planItemId: 'it_00000000-0000-7000-8000-000000000001',
      planRevision: 1,
      stepId: 'first',
      title: 'First',
      startSequence: 1,
      endSequence: null,
      steps: 0,
    };
    expect(
      TimelinePlanSegmentsSchema.safeParse({ segments: [segment], coverage: 'complete' }).success
    ).toBe(true);
    expect(
      TimelinePlanSegmentsSchema.safeParse({
        segments: Array(9).fill(segment),
        coverage: 'partial',
      }).success
    ).toBe(false);
    expect(
      TimelinePlanSegmentsSchema.safeParse({
        segments: [{ ...segment, steps: -1 }],
        coverage: 'complete',
      }).success
    ).toBe(false);
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
