import { describe, expect, it } from 'vitest';
import {
  GenerativeUiSourceSchema,
  PublishGenerativePresentationRequestSchema,
} from './generative-ui.js';

const input = {
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
  title: 'Answer',
  fallbackText: 'Answer',
  messages: [{}, {}],
  source: { kind: 'answer', text: 'Generated answer.' },
  actions: [],
};

describe('generated answer publication source', () => {
  it('accepts bounded narrative only at publication and retains normalized Item sources', () => {
    expect(PublishGenerativePresentationRequestSchema.safeParse(input).success).toBe(true);
    expect(GenerativeUiSourceSchema.safeParse(input.source).success).toBe(false);
  });

  it.each(['', '😀'.repeat(524289)])('refuses empty or oversized UTF-8 answers', (text) => {
    expect(
      PublishGenerativePresentationRequestSchema.safeParse({
        ...input,
        source: { kind: 'answer', text },
      }).success
    ).toBe(false);
  });

  it('refuses actions on generated answers', () => {
    expect(
      PublishGenerativePresentationRequestSchema.safeParse({
        ...input,
        actions: [{ name: 'refresh', componentId: 'refresh', kind: 'refresh' }],
      }).success
    ).toBe(false);
  });
});
