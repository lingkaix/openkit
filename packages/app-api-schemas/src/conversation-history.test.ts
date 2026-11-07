import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  AssistantHistoryQuerySchema,
  AssistantHistoryRangeSchema,
  AssistantHistoryReadSchema,
  AssistantHistorySearchSchema,
  ConversationRetrievalTraceReaderSchema,
  ConversationRetrievalTraceSchema,
  ProductRetrievalTraceReaderSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const itemId = allocateEntityId('it');
const traceId = allocateEntityId('krt');
const userId = allocateEntityId('usr');
const digest = `sha256:${'c'.repeat(64)}`;

const baseRange = {
  threadId,
  firstItemId: itemId,
  lastItemId: itemId,
  sourceDigest: digest,
};

const baseTrace = {
  sourceKind: 'conversation' as const,
  traceId,
  queryContext: {
    serverId: 'srv-main',
    workspaceId,
    actor: { kind: 'user' as const, id: userId },
    threadId,
    turnId,
  },
  requestDigest: digest,
  retrievalParameters: {
    range: baseRange,
    cursor: { itemId, offset: 0 },
    limit: 5,
    mode: 'range' as const,
  },
  selected: [
    {
      reference: {
        workspaceId,
        threadId,
        turnId,
        itemId,
      },
      revision: digest,
      digest,
    },
  ],
  complete: true,
  createdAt: '2026-10-16T00:00:00.000Z',
};

describe('conversation history query and retrieval trace schemas', () => {
  it('applies defaults and enforces query length, mode enum, and limit bounds on AssistantHistorySearchSchema', () => {
    expect(AssistantHistorySearchSchema.parse({ query: 'deployment' })).toEqual({
      query: 'deployment',
      mode: 'lexical',
      limit: 5,
    });

    for (const invalid of [
      { query: '' },
      { query: 'x'.repeat(4097) },
      { query: 'deployment', mode: 'semantic' },
      { query: 'deployment', limit: 0 },
      { query: 'deployment', limit: 21 },
      { query: 'deployment', workspaceId },
    ]) {
      expect(AssistantHistorySearchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates sha256 sourceDigest, nonnegative cursor offset, and limit bounds on AssistantHistoryReadSchema and AssistantHistoryQuerySchema', () => {
    const parsed = AssistantHistoryQuerySchema.parse({
      range: baseRange,
      cursor: { itemId, offset: 128 },
    });
    expect(parsed).toEqual({
      range: baseRange,
      cursor: { itemId, offset: 128 },
      limit: 5,
    });

    expect(
      AssistantHistoryRangeSchema.safeParse({
        ...baseRange,
        sourceDigest: 'sha256:invalid',
      }).success
    ).toBe(false);

    for (const invalid of [
      { range: baseRange, cursor: { itemId, offset: -1 } },
      { range: baseRange, cursor: { itemId, offset: 1.5 } },
      { range: baseRange, limit: 21 },
      { range: baseRange, query: 'mixed-union-fields' },
    ]) {
      expect(AssistantHistoryReadSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('enforces strictness and 20-item selection cap on ConversationRetrievalTraceSchema', () => {
    expect(ConversationRetrievalTraceSchema.parse(baseTrace).sourceKind).toBe('conversation');

    expect(
      ConversationRetrievalTraceSchema.safeParse({
        ...baseTrace,
        extraField: 'not-allowed',
      }).success
    ).toBe(false);

    expect(
      ConversationRetrievalTraceSchema.safeParse({
        ...baseTrace,
        selected: Array.from({ length: 21 }, () => baseTrace.selected[0]!),
      }).success
    ).toBe(false);
  });

  it('strips descriptive additions across nested reader objects in ConversationRetrievalTraceReaderSchema and ProductRetrievalTraceReaderSchema', () => {
    const withDescriptiveAdditions = {
      ...baseTrace,
      readerHint: 'ignored-top-level',
      queryContext: {
        ...baseTrace.queryContext,
        contextHint: 'ignored-context',
        actor: {
          ...baseTrace.queryContext.actor,
          displayName: 'ignored-actor-label',
        },
      },
      retrievalParameters: {
        ...baseTrace.retrievalParameters,
        paramHint: 'ignored-param',
        range: {
          ...baseRange,
          rangeHint: 'ignored-range',
        },
        cursor: {
          itemId,
          offset: 0,
          cursorHint: 'ignored-cursor',
        },
      },
      selected: [
        {
          ...baseTrace.selected[0]!,
          selectionHint: 'ignored-selection',
          reference: {
            ...baseTrace.selected[0]!.reference,
            referenceHint: 'ignored-reference',
          },
        },
      ],
    };

    expect(ConversationRetrievalTraceReaderSchema.parse(withDescriptiveAdditions)).toEqual(
      baseTrace
    );
    expect(ProductRetrievalTraceReaderSchema.parse(withDescriptiveAdditions)).toEqual(baseTrace);
  });
});
