import { describe, expect, it } from 'vitest';
import {
  createRawProviderOutputObserver,
  type RawModelOutputPosition,
} from './raw-provider-output.js';

/** Independent sum of source-position advances, without normalized model messages or JSON reserialization. */
function meter(api: string) {
  const positions: RawModelOutputPosition[] = [];
  const observe = createRawProviderOutputObserver(api, (position) => positions.push(position));
  const bytes = () => positions.reduce((sum, p) => sum + p.bytePosition - p.fromBytePosition, 0);
  return { observe, positions, bytes };
}

describe('source-native Worker output observation', () => {
  it('charges failed OpenAI chat attempts and exact argument whitespace before JSON parsing', () => {
    const { observe, bytes, positions } = meter('openai-completions');
    observe({
      id: 'first',
      choices: [
        {
          index: 0,
          delta: {
            content: '中文🙂',
            reasoning_content: 'why\n',
            tool_calls: [{ index: 0, function: { arguments: '{ "x": ' } }],
          },
        },
      ],
    });
    observe({
      id: 'first',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '1 }' } }] },
          finish_reason: 'error',
        },
      ],
      usage: { output_tokens: 100 },
    });
    expect(bytes()).toBe(10 + 4 + 10);
    observe({ id: 'retry', choices: [{ index: 0, delta: { content: '中文🙂' } }] });
    expect(bytes()).toBe(34);
    expect(new Set(positions.filter((p) => p.field === 'text').map((p) => p.partId)).size).toBe(2);
  });
  it.each([
    'openai-responses',
    'openai-codex-responses',
    'azure-openai-responses',
  ])('deduplicates %s deltas, retransmissions and terminal snapshots by native identity', (api) => {
    const { observe, positions } = meter(api);
    observe({ type: 'response.created', response: { id: 'response' } });
    const delta = {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'A🙂',
      sequence_number: 1,
    };
    observe(delta);
    observe(delta);
    observe({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'A🙂' });
    observe({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      delta: '{ "x": 1 }',
      sequence_number: 2,
    });
    observe({
      type: 'response.reasoning_summary_text.delta',
      output_index: 2,
      summary_index: 0,
      delta: 'visible',
      sequence_number: 3,
    });
    observe({
      type: 'response.completed',
      response: {
        id: 'response',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'A🙂' }] },
          { type: 'function_call', arguments: '{ "x": 1 }' },
          {
            type: 'reasoning',
            summary: [{ text: 'visible' }],
            encrypted_content: 'opaque-not-output',
          },
        ],
      },
    });
    const watermarks = new Map<number, number>();
    let charged = 0;
    for (const p of positions) {
      const before = watermarks.get(p.partId) ?? 0;
      charged += Math.max(0, p.bytePosition - before);
      watermarks.set(p.partId, Math.max(before, p.bytePosition));
    }
    expect(charged).toBe(5 + 10 + 7);
    expect(() =>
      observe({ type: 'response.output_text.done', output_index: 0, text: 'different' })
    ).toThrow('unavailable');
  });
  it('counts Responses refusal deltas and terminal snapshots as emitted text', () => {
    const { observe, positions } = meter('openai-responses');
    observe({ type: 'response.created', response: { id: 'refusal' } });
    observe({
      type: 'response.refusal.delta',
      output_index: 0,
      content_index: 0,
      delta: 'Cannot help.',
    });
    observe({
      type: 'response.refusal.done',
      output_index: 0,
      content_index: 0,
      refusal: 'Cannot help.',
    });
    observe({
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }],
      },
    });
    expect(positions).toHaveLength(3);
    expect(
      positions.every((p) => p.field === 'text' && p.partId === 0 && p.bytePosition === 12)
    ).toBe(true);
  });
  it('excludes Anthropic opaque reasoning and signatures while preserving raw arguments and thinking', () => {
    const { observe, bytes } = meter('anthropic-messages');
    observe({ type: 'message_start', message: { id: 'message' } });
    observe({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque' },
    });
    observe({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature' },
    });
    observe({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    });
    observe({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'think' },
    });
    observe({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', input: {} },
    });
    observe({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{ "x" : 1 }' },
    });
    observe({ type: 'content_block_stop', index: 2 });
    expect(bytes()).toBe(5 + 11);
    observe({
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'tool_use', input: {} },
    });
    expect(() => observe({ type: 'content_block_stop', index: 3 })).toThrow('unavailable');
  });
  it('observes Bedrock native fields and excludes opaque bytes', () => {
    const { observe, bytes } = meter('bedrock-converse-stream');
    observe({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'call' } } } });
    observe({
      contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{ "x": 1 }' } } },
    });
    observe({ contentBlockStop: { contentBlockIndex: 0 } });
    observe({
      contentBlockDelta: {
        contentBlockIndex: 1,
        delta: { reasoningContent: { text: 'why', signature: 'opaque' } },
      },
    });
    observe({
      contentBlockDelta: {
        contentBlockIndex: 2,
        delta: { reasoningContent: { redactedContent: [1, 2, 3] } },
      },
    });
    expect(bytes()).toBe(13);
  });
  it('observes Mistral chunk fields and refuses Google object arguments instead of inventing source bytes', () => {
    const mistral = meter('mistral-conversations');
    mistral.observe({
      id: 'mistral',
      choices: [
        {
          index: 0,
          delta: {
            content: [
              { type: 'text', text: 'Hi' },
              { type: 'thinking', thinking: [{ text: 'why' }] },
            ],
            tool_calls: [{ index: 0, function: { arguments: '{}' } }],
          },
        },
      ],
    });
    expect(mistral.bytes()).toBe(7);
    for (const api of ['google-generative-ai', 'google-vertex']) {
      const { observe, bytes } = meter(api);
      observe({
        responseId: 'google',
        candidates: [
          {
            content: {
              parts: [
                { text: 'text' },
                { text: 'reason', thought: true },
                { thoughtSignature: 'opaque' },
              ],
            },
          },
        ],
      });
      expect(bytes()).toBe(10);
      expect(() =>
        observe({
          candidates: [{ content: { parts: [{ functionCall: { name: 'x', args: { x: 1 } } }] } }],
        })
      ).toThrow('unavailable');
    }
  });
  it('refuses Pi reasoning without visibility proof and tools without original argument text', () => {
    const { observe, bytes } = meter('pi-messages');
    observe({ type: 'text_delta', contentIndex: 0, delta: 'text' });
    observe({ type: 'text_end', contentIndex: 0, content: 'text' });
    observe({ type: 'thinking_end', contentIndex: 1, content: 'opaque', redacted: true });
    observe({ type: 'toolcall_delta', contentIndex: 2, delta: '{}' });
    observe({ type: 'toolcall_end', contentIndex: 2 });
    expect(bytes()).toBe(10); // Snapshot replay is deduplicated by the durable watermark, not this sum helper.
    expect(() =>
      observe({ type: 'thinking_delta', contentIndex: 1, delta: 'unknown visibility' })
    ).toThrow('unavailable');
    expect(() =>
      observe({ type: 'toolcall_end', contentIndex: 3, toolCall: { arguments: {} } })
    ).toThrow('unavailable');
  });
  it('fails closed for malformed identity, invalid Unicode and unsupported native APIs', () => {
    expect(() => createRawProviderOutputObserver('unknown', () => {})).toThrow('unavailable');
    const { observe } = meter('openai-completions');
    expect(() => observe({ choices: [{ delta: { content: 'text' } }] })).toThrow('unavailable');
    expect(() => observe({ id: 'id', choices: [{ delta: { content: '\ud800' } }] })).toThrow(
      'unavailable'
    );
    const response = meter('openai-responses');
    expect(() =>
      response.observe({ type: 'response.output_text.delta', output_index: 0, delta: 'x' })
    ).toThrow('unavailable');
  });
});
