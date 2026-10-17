import { describe, expect, it } from 'vitest';
import { admitModelRequest } from './model-request-admission.js';

describe('complete text request estimate', () => {
  it('includes instructions, CJK history, JSON Tool data, native continuity, and output reserve', () => {
    const payload = {
      instructions: 'Read the selected evidence.',
      input: [
        { role: 'user', content: '漢字'.repeat(500) },
        { type: 'function_call_output', output: '{"facts":[1,2,3]}' },
      ],
      tools: [
        { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
    };
    const continuity = 'native-state';
    const estimate =
      Math.ceil((Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(continuity)) / 3) +
      4_096;
    const input = {
      payload,
      continuity,
      contextWindowTokens: estimate + 500,
      outputReserveTokens: 500,
    };

    expect(() => admitModelRequest(input)).not.toThrow();
    expect(() => admitModelRequest({ ...input, contextWindowTokens: estimate + 499 })).toThrow(
      /Reduce input or retrieve a smaller excerpt/
    );
  });

  it('uses known physical bounds without requiring an exact tokenizer or an invented output limit', () => {
    expect(() =>
      admitModelRequest({
        payload: { input: 'custom model without a tokenizer' },
        contextWindowTokens: 20_000,
        outputReserveTokens: undefined,
      })
    ).not.toThrow();
    expect(() =>
      admitModelRequest({ payload: {}, contextWindowTokens: undefined, outputReserveTokens: 1000 })
    ).toThrow(/physical context bounds/);
  });
});
