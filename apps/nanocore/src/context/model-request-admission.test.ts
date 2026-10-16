import { describe, expect, it } from 'vitest';
import { admitModelRequest } from './model-request-admission.js';

describe('complete model request estimate', () => {
  it('includes CJK, JSON Tool schemas/results, media and native continuity with output reserve', () => {
    const payload = {
      instructions: 'Read the selected evidence.',
      input: [{ role: 'user', content: '漢字'.repeat(500) }, { type: 'function_call_output', output: '{"facts":[1,2,3]}' }],
      tools: [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      image: { type: 'input_image', image_url: 'data:image/png;base64,cGl4ZWxz' },
    };
    const continuity = 'native-state';
    const estimated = Math.ceil((Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(continuity)) / 3) + 4096;
    expect(() => admitModelRequest({ payload, continuity, contextWindowTokens: estimated + 500, outputReserveTokens: 500 })).not.toThrow();
    expect(() => admitModelRequest({ payload, continuity, contextWindowTokens: estimated + 499, outputReserveTokens: 500 })).toThrow(/smaller excerpt/);
    expect(() => admitModelRequest({ payload, contextWindowTokens: 1_000_000, outputReserveTokens: 500 })).not.toThrow();
  });

  it('requires physical capacity and output reserve, without requiring an exact tokenizer', () => {
    expect(() => admitModelRequest({ payload: { input: 'custom model' }, contextWindowTokens: 20_000, outputReserveTokens: 1000 })).not.toThrow();
    expect(() => admitModelRequest({ payload: {}, contextWindowTokens: undefined, outputReserveTokens: 1000 })).toThrow(/physical context/);
    expect(() => admitModelRequest({ payload: {}, contextWindowTokens: 20_000, outputReserveTokens: -1 })).toThrow(/physical context/);
  });
});
