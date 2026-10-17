import { describe, expect, it } from 'vitest';
import { admitModelRequest } from './model-request-admission.js';

describe('complete text request estimate', () => {
  it('adds the image allowance only at admitted Native Responses positions without changing image bytes or other text', () => {
    const png = `data:image/png;base64,${'A'.repeat(12_000)}`;
    const jpeg = `data:image/jpeg;base64,${'B'.repeat(8_000)}`;
    const payload = {
      instructions: `This text data URL must remain counted: ${png}`,
      input: [
        { role: 'user', content: [
          { type: 'input_text', text: png },
          { type: 'input_image', image_url: png, detail: 'auto' },
          { type: 'input_image', image_url: png, detail: 'low' },
        ] },
        { type: 'function_call_output', call_id: 'call_view', output: [
          { type: 'input_text', text: 'Exact original and crop facts.' },
          { type: 'input_image', image_url: jpeg, detail: 'high' },
        ] },
        { role: 'assistant', content: [{ type: 'input_image', image_url: png }] },
        { type: 'custom_tool_call_output', output: [{ type: 'input_image', image_url: png }] },
        { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/gif;base64,AAAA' }] },
      ],
      tools: [{ name: 'example', parameters: { example: { type: 'input_image', image_url: png } } }],
    };
    const before = structuredClone(payload);
    // Independent oracle: remove exactly the three admitted image values, retaining every other serialized byte.
    const projected = structuredClone(payload);
    projected.input[0]!.content![1]!.image_url = '';
    projected.input[0]!.content![2]!.image_url = '';
    projected.input[1]!.output![1]!.image_url = '';
    const continuity = 'native-continuity';
    const expected = Math.ceil((Buffer.byteLength(JSON.stringify(projected)) + Buffer.byteLength(continuity)) / 3) + 4_096 + 3 * 8_192;
    const input = { payload, continuity, contextWindowTokens: expected + 250, outputReserveTokens: 250 };
    expect(() => admitModelRequest(input)).not.toThrow();
    expect(() => admitModelRequest({ ...input, contextWindowTokens: expected + 249 })).toThrow(/complete request estimate/);
    expect(payload).toEqual(before);
  });

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
