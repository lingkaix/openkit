import { describe, expect, it } from 'vitest';

import { ItemSchema } from '../models/item.js';
import { ItemDeltaEventSchema, validateItemDelta } from './envelope.js';

const baseDelta = {
  type: 'item-delta',
  itemId: 'it_cmd_demo',
  itemType: 'command-execution',
  deltaKind: 'output-delta',
  delta: 'stdout line\n',
} as const;

const baseItem = {
  id: 'it_cmd_demo',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  turnId: 'tu_demo',
  status: 'in_progress',
  createdAt: '2026-05-17T00:00:00Z',
  completedAt: null,
} as const;

const itemDeltaPayloads = {
  'text-delta': {
    delta: 'Assistant text.',
  },
  'indexed-text-delta': {
    partId: 'summary',
    delta: 'Reasoning summary.',
  },
  'part-started': {
    partId: 'summary',
    label: 'Summary',
  },
  'output-delta': {
    delta: 'stdout line\n',
  },
  'snapshot-updated': {
    snapshot: { status: 'updated' },
  },
  'progress-updated': {
    progress: { message: 'Working' },
  },
  'request-started': {
    requestRefId: 'req_demo',
    label: 'Request',
  },
  'request-resolved': {
    requestRefId: 'req_demo',
    status: 'completed',
  },
  'interaction-delta': {
    delta: 'interactive output',
  },
  'artifact-updated': {
    artifactId: 'ar_demo',
    summary: 'Artifact changed.',
  },
  'knowledge-injection-updated': {
    knowledgeEntryIds: ['kn_demo'],
    summary: 'Knowledge context changed.',
  },
} as const;

const allowedItemTypesByDeltaKind = {
  'text-delta': ['assistant-message', 'reasoning', 'plan'],
  'indexed-text-delta': ['assistant-message', 'reasoning'],
  'part-started': ['assistant-message', 'reasoning'],
  'output-delta': ['command-execution'],
  'snapshot-updated': [
    'user-message',
    'assistant-message',
    'reasoning',
    'artifact-reference',
    'command-execution',
    'approval-request',
    'approval-decision',
    'user-input-request',
    'user-input-response',
    'file-change',
    'tool-call',
    'agent-handoff',
    'status',
    'plan',
    'knowledge-injection',
  ],
  'progress-updated': [
    'assistant-message',
    'reasoning',
    'command-execution',
    'approval-request',
    'user-input-request',
    'file-change',
    'tool-call',
    'agent-handoff',
    'status',
    'plan',
  ],
  'request-started': ['assistant-message', 'command-execution', 'tool-call'],
  'request-resolved': ['assistant-message', 'command-execution', 'tool-call'],
  'interaction-delta': ['command-execution'],
  'artifact-updated': ['artifact-reference'],
  'knowledge-injection-updated': ['knowledge-injection'],
} as const;

const disallowedDeltaPairs = [
  ['text-delta', 'artifact-reference'],
  ['output-delta', 'assistant-message'],
  ['request-started', 'file-change'],
  ['knowledge-injection-updated', 'assistant-message'],
] as const;

describe('item delta validation', () => {
  for (const [deltaKind, itemTypes] of Object.entries(allowedItemTypesByDeltaKind)) {
    for (const itemType of itemTypes) {
      it(`accepts ${deltaKind} deltas for ${itemType} items`, () => {
        expect(() =>
          ItemDeltaEventSchema.parse({
            type: 'item-delta',
            itemId: `it_${deltaKind}`,
            itemType,
            deltaKind,
            ...itemDeltaPayloads[deltaKind as keyof typeof itemDeltaPayloads],
          })
        ).not.toThrow();
      });
    }
  }

  for (const [deltaKind, itemType] of disallowedDeltaPairs) {
    it(`rejects ${deltaKind} deltas for ${itemType} items`, () => {
      expect(() =>
        ItemDeltaEventSchema.parse({
          type: 'item-delta',
          itemId: `it_${deltaKind}`,
          itemType,
          deltaKind,
          ...itemDeltaPayloads[deltaKind],
        })
      ).toThrow();
    });
  }

  it('accepts command-execution output deltas with explicit itemType', () => {
    const parsed = ItemDeltaEventSchema.parse({
      ...baseDelta,
      itemType: 'command-execution',
    });

    expect(parsed.itemType).toBe('command-execution');
  });

  it('rejects assistant-message output deltas with a clear error', () => {
    expect(() =>
      ItemDeltaEventSchema.parse({
        ...baseDelta,
        itemType: 'assistant-message',
      })
    ).toThrow(/output-delta is only valid for command-execution items/);
  });

  it('rejects any other non-command-execution itemType for output deltas', () => {
    const nonCommandItemTypes = [
      'user-message',
      'reasoning',
      'artifact-reference',
      'approval-request',
      'approval-decision',
      'user-input-request',
      'user-input-response',
      'file-change',
      'tool-call',
      'agent-handoff',
      'status',
      'plan',
      'knowledge-injection',
    ] as const;

    for (const itemType of nonCommandItemTypes) {
      expect(() => ItemDeltaEventSchema.parse({ ...baseDelta, itemType })).toThrow(
        /output-delta is only valid for command-execution items/
      );
    }
  });

  it('rejects output deltas with no itemType', () => {
    const { itemType: _itemType, ...untypedDelta } = baseDelta;

    expect(() => ItemDeltaEventSchema.parse(untypedDelta)).toThrow();
  });

  it('validates output deltas against the referenced item snapshot', () => {
    const commandItem = ItemSchema.parse({
      ...baseItem,
      type: 'command-execution',
      command: 'pnpm test',
      cwd: '/workspace',
      output: '',
      exitCode: null,
      durationMs: null,
    });

    expect(validateItemDelta(baseDelta, commandItem)).toEqual(baseDelta);
  });

  it('rejects deltas whose supplied itemType differs from the referenced item snapshot', () => {
    const assistantItem = ItemSchema.parse({
      ...baseItem,
      id: 'it_assistant_demo',
      type: 'assistant-message',
      text: '',
    });

    expect(() =>
      validateItemDelta(
        {
          type: 'item-delta',
          itemId: assistantItem.id,
          itemType: 'reasoning',
          deltaKind: 'text-delta',
          delta: 'Mismatched reasoning text.',
        },
        assistantItem
      )
    ).toThrow(/itemType reasoning does not match assistant-message item it_assistant_demo/);
  });

  it('rejects output deltas against non-command item snapshots', () => {
    const assistantItem = ItemSchema.parse({
      ...baseItem,
      type: 'assistant-message',
      text: '',
    });

    expect(() => validateItemDelta(baseDelta, assistantItem)).toThrow(
      /itemType command-execution does not match assistant-message item it_cmd_demo/
    );
  });

  it('accepts artifact-reference artifact updates with explicit itemType', () => {
    const parsed = ItemDeltaEventSchema.parse({
      ...baseDelta,
      itemId: 'it_artifact_demo',
      deltaKind: 'artifact-updated',
      itemType: 'artifact-reference',
      artifactId: 'ar_demo',
      summary: 'Artifact changed.',
    });

    expect(parsed.itemType).toBe('artifact-reference');
  });

  it('rejects artifact-reference text deltas with a clear error', () => {
    expect(() =>
      ItemDeltaEventSchema.parse({
        ...baseDelta,
        itemId: 'it_artifact_demo',
        deltaKind: 'text-delta',
        itemType: 'artifact-reference',
        delta: 'invalid artifact text',
      })
    ).toThrow(/text-delta is not valid for artifact-reference items/);
  });

  it('rejects text deltas against artifact-reference item snapshots', () => {
    const artifactItem = ItemSchema.parse({
      ...baseItem,
      id: 'it_artifact_demo',
      type: 'artifact-reference',
      artifactId: 'ar_demo',
      artifactVersion: 1,
      lastMutationRequestId: 'req_artifact_demo',
      title: 'Artifact',
      summary: null,
    });

    expect(() =>
      validateItemDelta(
        {
          type: 'item-delta',
          itemId: artifactItem.id,
          itemType: 'artifact-reference',
          deltaKind: 'text-delta',
          delta: 'invalid artifact text',
        },
        artifactItem
      )
    ).toThrow(/text-delta is not valid for artifact-reference items/);
  });
});
