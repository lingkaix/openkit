import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  admitModelRequest,
  type ModelTokenAdmissionInput,
  type ModelTokenCountInput,
  type ModelTokenCountReceipt,
  type TokenModelIdentity,
} from './model-token-admission.js';

const model: TokenModelIdentity = {
  providerId: 'openai-direct',
  modelId: 'gpt-5.2',
  api: 'responses',
};

/** Test-only trusted count receipt; it does not qualify a production provider. */
function receipt(input: ModelTokenCountInput, tokens = 10): ModelTokenCountReceipt {
  return {
    kind: 'counted',
    model: input.model,
    requestDigest: input.requestDigest,
    imageFactsDigest: input.imageFactsDigest,
    accountingIdentity: 'fixture-counter/v1',
    coverage: 'complete-request',
    inputTokens: tokens,
  };
}

/** Complete request fixture; each case supplies the counter evidence it tests. */
function admission(overrides: Partial<ModelTokenAdmissionInput> = {}): ModelTokenAdmissionInput {
  return {
    model,
    request: { model: model.modelId, input: 'hello', max_output_tokens: 32 },
    imageFacts: [],
    contextWindowTokens: 100,
    maxOutputTokens: 50,
    outputReserveTokens: 32,
    counter: async (input) => receipt(input),
    ...overrides,
  };
}

/** Digest of byte-exact inline image fixtures, independent of admission code. */
function sha(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** One actual content block and processor facts; header parsing belongs to the processor. */
function imageAdmission(api: TokenModelIdentity['api'] = 'responses'): ModelTokenAdmissionInput {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4qUAAAAASUVORK5CYII=',
    'base64'
  );
  const url = `data:image/png;base64,${bytes.toString('base64')}`;
  const block =
    api === 'chat-completions'
      ? { type: 'image_url', image_url: { url, detail: 'high' } }
      : { type: 'input_image', image_url: url, detail: 'high' };
  const root = api === 'chat-completions' ? 'messages' : 'input';
  return admission({
    model: { ...model, api },
    request: {
      model: model.modelId,
      [root]: [{ role: 'user', content: [block] }],
      [api === 'chat-completions' ? 'max_tokens' : 'max_output_tokens']: 32,
    },
    imageFacts: [
      {
        path: `/${root}/0/content/0`,
        contentDigest: sha(bytes),
        byteLength: bytes.length,
        width: 1,
        height: 1,
        frames: 1,
        detail: 'high',
      },
    ],
    counter: async (input) => receipt(input, 50),
  });
}

describe('complete model token admission', () => {
  it('admits the exact boundary and refuses one token over after independent output reserve', async () => {
    expect(await admitModelRequest(admission({ contextWindowTokens: 42 }))).toMatchObject({
      kind: 'admitted',
      inputTokens: 10,
      outputReserveTokens: 32,
      totalTokens: 42,
    });
    expect(await admitModelRequest(admission({ contextWindowTokens: 41 }))).toEqual({
      kind: 'refused',
      reason: 'context-limit-exceeded',
    });
  });

  it('rejects a genuine byte/4 false fit using an independently derived DeepSeek tokenizer fixture', async () => {
    // Published DeepSeek-V3.2 revision a7e62ac04ecb2c0a54d736dc46601c5606cf10a6:
    // encoding/encoding_dsv32.py emits BOS, User, 4096 NULs, Assistant, </think>.
    // tokenizer.json has IDs [0,128803,191 x4096,128804,128799]. NUL is ByteLevel
    // U+0100, no NUL+NUL merge or longer all-NUL vocabulary item exists. These
    // 4100 input IDs are an independent fixture, not a guessed server alias count.
    // https://huggingface.co/deepseek-ai/DeepSeek-V3.2/tree/a7e62ac04ecb2c0a54d736dc46601c5606cf10a6
    const content = '\0'.repeat(4096);
    expect(Math.ceil(Buffer.byteLength(content) / 4) + 32).toBeLessThan(2000);
    const fixtureIds = [0, 128803, ...Array<number>(4096).fill(191), 128804, 128799];
    const physical: TokenModelIdentity = {
      providerId: 'qualified-fixture',
      modelId: 'DeepSeek-V3.2',
      api: 'chat-completions',
    };
    expect(
      await admitModelRequest(
        admission({
          model: physical,
          request: {
            model: physical.modelId,
            messages: [{ role: 'user', content }],
            max_tokens: 32,
          },
          contextWindowTokens: 2000,
          counter: async (input) => receipt(input, fixtureIds.length),
        })
      )
    ).toEqual({ kind: 'refused', reason: 'context-limit-exceeded' });
  });

  it.each([
    {
      text: '龘'.repeat(16),
      bodyIds: Array.from({ length: 16 }, () => [2715, 249]).flat(),
      window: 30,
    },
    { text: '{"龘":"龘"}', bodyIds: [24313, 2715, 249, 16562, 2715, 249, 62773], window: 15 },
  ])('refuses the independent CJK/JSON byte-divided-by-four false fit: $text', async ({
    text,
    bodyIds,
    window,
  }) => {
    // Same pinned DeepSeek artifact as the NUL fixture. ByteLevel BPE and its
    // published split grammar give these IDs; the four framing IDs are separate
    // added tokens. This fixture never qualifies a moving production model alias.
    expect(Math.ceil(Buffer.byteLength(text) / 4) + 8).toBeLessThanOrEqual(window);
    const physical: TokenModelIdentity = {
      providerId: 'qualified-fixture',
      modelId: 'DeepSeek-V3.2',
      api: 'chat-completions',
    };
    expect(
      await admitModelRequest(
        admission({
          model: physical,
          request: {
            model: physical.modelId,
            messages: [{ role: 'user', content: text }],
            max_tokens: 8,
          },
          contextWindowTokens: window,
          outputReserveTokens: 8,
          counter: async (input) => receipt(input, bodyIds.length + 4),
        })
      )
    ).toEqual({ kind: 'refused', reason: 'context-limit-exceeded' });
  });

  it('passes complete instructions, ordered history, Tool schema and native state unchanged to the counter', async () => {
    const request = {
      model: model.modelId,
      instructions: 'System rules',
      max_output_tokens: 32,
      input: [
        { role: 'user', content: 'previous' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'now' },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'image_url is only a property name',
          parameters: { type: 'object', properties: { image_url: { type: 'string' } } },
        },
      ],
    };
    const counter = vi.fn(async (input: ModelTokenCountInput) => {
      expect(input.request).toEqual(request);
      expect(input.continuity).toEqual({ turnState: 'opaque-exact' });
      return receipt(input, 69);
    });
    expect(
      await admitModelRequest(
        admission({ request, continuity: { turnState: 'opaque-exact' }, counter })
      )
    ).toEqual({ kind: 'refused', reason: 'context-limit-exceeded' });
    expect(counter).toHaveBeenCalledTimes(1);
  });

  it('returns the counted immutable snapshot even when the caller changes the original during counting', async () => {
    const original = {
      model: model.modelId,
      input: [{ role: 'user', content: 'before' }],
      max_output_tokens: 32,
    };
    const options = admission({ request: original });
    const result = await admitModelRequest({
      ...options,
      counter: async (input) => {
        original.input[0]!.content = 'after';
        original.max_output_tokens = 999;
        expect(Object.isFrozen(input.request)).toBe(true);
        expect(Object.isFrozen(input.request.input)).toBe(true);
        return receipt(input);
      },
    });
    expect(result).toMatchObject({
      kind: 'admitted',
      request: { input: [{ content: 'before' }], max_output_tokens: 32 },
    });
  });

  it('binds exact Unicode, ordered history, tools, state, media facts and physical model into the digest', async () => {
    const seen: string[] = [];
    const counter = async (input: ModelTokenCountInput) => {
      seen.push(input.requestDigest);
      return receipt(input);
    };
    for (const overrides of [
      {},
      { request: { model: model.modelId, input: 'he\u0301llo', max_output_tokens: 32 } },
      { request: { model: model.modelId, input: 'héllo', max_output_tokens: 32 } },
      { continuity: { state: 'a' } },
      { continuity: { state: 'b' } },
      { model: { ...model, providerId: 'other' } },
      { request: { model: model.modelId, input: 'hello', tools: [], max_output_tokens: 32 } },
      {
        request: {
          model: model.modelId,
          input: [
            { role: 'user', content: 'prior' },
            { role: 'user', content: 'hello' },
          ],
          max_output_tokens: 32,
        },
      },
    ])
      await admitModelRequest(admission({ ...overrides, counter }));
    expect(new Set(seen).size).toBe(8);
  });

  it.each([
    'gpt-5.2',
    'gpt-5.2-codex',
    'deepseek-chat',
    'deepseek-reasoner',
    'unknown',
  ])('qualifies no default model %s without complete proof', async (modelId) => {
    const { counter: _counter, ...withoutCounter } = admission({
      model: { ...model, modelId },
      request: { model: modelId, input: '', max_output_tokens: 32 },
    });
    expect(await admitModelRequest(withoutCounter)).toEqual({
      kind: 'unavailable',
      reason: 'counter-unavailable',
    });
  });

  it.each([
    'model-unqualified',
    'api-unqualified',
    'continuity-unqualified',
    'media-unqualified',
  ] as const)('preserves qualified counter refusal %s', async (reason) => {
    expect(
      await admitModelRequest(admission({ counter: async () => ({ kind: 'unavailable', reason }) }))
    ).toEqual({ kind: 'unavailable', reason });
  });

  it('requires an explicit native continuity snapshot and does not substitute a Responses count', async () => {
    const counter = vi.fn(async (input: ModelTokenCountInput) => receipt(input));
    const native = admission({ model: { ...model, api: 'codex-responses' }, counter });
    expect(await admitModelRequest(native)).toEqual({
      kind: 'unavailable',
      reason: 'continuity-unqualified',
    });
    expect(counter).not.toHaveBeenCalled();
    expect(
      await admitModelRequest({
        ...native,
        continuity: { turnState: 'exact-native-state' },
        counter: async (input) => ({ ...receipt(input), model }),
      })
    ).toEqual({ kind: 'unavailable', reason: 'invalid-count-receipt' });
  });

  it.each([
    { inputTokens: -1 },
    { inputTokens: 1.5 },
    { inputTokens: NaN },
    { inputTokens: Infinity },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { requestDigest: `sha256:${'0'.repeat(64)}` },
    { imageFactsDigest: `sha256:${'0'.repeat(64)}` },
    { model: { ...model, modelId: 'different' } },
    { model: { ...model, api: 'chat-completions' } },
    { model: { ...model, providerId: 'different' } },
    { accountingIdentity: '' },
    { coverage: 'text-only' },
  ])('refuses unsafe, stale or incomplete counter evidence %j', async (change) => {
    expect(
      await admitModelRequest(
        admission({
          counter: async (input) => ({ ...receipt(input), ...change }) as ModelTokenCountReceipt,
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'invalid-count-receipt' });
  });

  it('does not reuse a prior count after the instructions or tool schema changes', async () => {
    let old: ModelTokenCountReceipt | undefined;
    await admitModelRequest(
      admission({
        counter: async (input) => {
          old = receipt(input);
          return old;
        },
      })
    );
    for (const extra of [
      { instructions: 'new instructions' },
      { tools: [{ type: 'function', name: 'new', parameters: { type: 'object' } }] },
    ]) {
      expect(
        await admitModelRequest(
          admission({
            request: { model: model.modelId, input: 'hello', max_output_tokens: 32, ...extra },
            counter: async () => old!,
          })
        )
      ).toEqual({ kind: 'unavailable', reason: 'invalid-count-receipt' });
    }
  });

  it('counts image cost once and pins actual delivered bytes and processor facts', async () => {
    for (const api of ['responses', 'chat-completions'] as const) {
      expect(await admitModelRequest(imageAdmission(api))).toMatchObject({
        kind: 'admitted',
        inputTokens: 50,
        totalTokens: 82,
      });
    }
  });

  it.each([
    'missing',
    'digest',
    'dimensions',
    'frames',
    'detail',
    'bytes',
    'duplicate',
    'path',
  ] as const)('refuses unqualified image facts: %s', async (change) => {
    const input = imageAdmission();
    const fact = { ...input.imageFacts[0]! };
    if (change === 'digest') fact.contentDigest = `sha256:${'0'.repeat(64)}`;
    if (change === 'dimensions') fact.width = 0;
    if (change === 'frames') Object.assign(fact, { frames: 2 });
    if (change === 'detail') fact.detail = 'low';
    if (change === 'bytes') fact.byteLength++;
    if (change === 'path') fact.path = '/input/1/content/0';
    const counter = vi.fn(input.counter!);
    expect(
      await admitModelRequest({
        ...input,
        counter,
        imageFacts: change === 'missing' ? [] : change === 'duplicate' ? [fact, fact] : [fact],
      })
    ).toEqual({ kind: 'unavailable', reason: 'media-unqualified' });
    expect(counter).not.toHaveBeenCalled();
  });

  it('refuses a count that does not bind the actual image facts', async () => {
    for (const imageFactsDigest of ['', `sha256:${'0'.repeat(64)}`])
      expect(
        await admitModelRequest({
          ...imageAdmission(),
          counter: async (input) => ({ ...receipt(input, 50), imageFactsDigest }),
        })
      ).toEqual({ kind: 'unavailable', reason: 'invalid-count-receipt' });
  });

  it.each([
    { type: 'input_file', file_id: 'file_123' },
    { type: 'input_audio', data: 'bytes' },
    { type: 'input_image', image_url: 'https://example.test/mutable.png' },
    { type: 'input_image', file_id: 'file_123' },
    { type: 'video', url: 'video' },
  ])('refuses media without exact supported delivery facts %j', async (block) => {
    expect(
      await admitModelRequest(
        admission({
          request: {
            model: model.modelId,
            input: [{ role: 'user', content: [block] }],
            max_output_tokens: 32,
          },
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'media-unqualified' });
  });

  it.each([
    { max_output_tokens: 33 },
    { max_output_tokens: 0 },
    { max_output_tokens: -1 },
    { max_output_tokens: 1.5 },
    { max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { max_output_tokens: 32, max_tokens: 32 },
  ])('refuses unreserved or invalid wire output limits %j', async (fields) => {
    const counter = vi.fn(async (input: ModelTokenCountInput) => receipt(input));
    const result = await admitModelRequest(
      admission({ request: { model: model.modelId, input: 'hello', ...fields }, counter })
    );
    expect(result.kind).not.toBe('admitted');
    expect(counter).not.toHaveBeenCalled();
  });

  it('refuses contradictory Chat aliases and an absent explicit output cap', async () => {
    for (const request of [
      { model: model.modelId, input: 'hello' },
      { model: model.modelId, messages: [], max_tokens: 20, max_completion_tokens: 21 },
    ]) {
      expect(
        await admitModelRequest(
          admission({ model: { ...model, api: 'chat-completions' }, request })
        )
      ).toEqual({ kind: 'unavailable', reason: 'invalid-request' });
    }
    expect(await admitModelRequest(admission({ maxOutputTokens: 31 }))).toEqual({
      kind: 'refused',
      reason: 'output-limit-exceeded',
    });
  });

  it('keeps capture limits independent and never calls the counter on malformed/oversize input', async () => {
    const getter = vi.fn(() => 'secret');
    const object = Object.defineProperty({}, 'input', { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const request of [
      object,
      cycle,
      { model: model.modelId, input: '\0'.repeat(3_000_000), max_output_tokens: 32 },
    ]) {
      const counter = vi.fn(async (input: ModelTokenCountInput) => receipt(input));
      expect((await admitModelRequest(admission({ request, counter }))).kind).toBe('unavailable');
      expect(counter).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('contains counter errors and cancellation without private diagnostics or fallback', async () => {
    expect(
      await admitModelRequest(
        admission({
          counter: async () => {
            throw new Error('private body and path');
          },
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    const abort = new AbortController();
    expect(
      await admitModelRequest(
        admission({
          signal: abort.signal,
          counter: async (input) => {
            abort.abort();
            return receipt(input);
          },
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'cancelled' });
    const counter = vi.fn(async (input: ModelTokenCountInput) => receipt(input));
    await admitModelRequest(admission({ signal: abort.signal, counter }));
    expect(counter).not.toHaveBeenCalled();
  });

  it('returns on cancellation while a counter ignores its signal, and detaches its listener', async () => {
    const abort = new AbortController();
    const removed = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = admitModelRequest(
      admission({ signal: abort.signal, counter: async () => new Promise(() => {}) })
    );
    abort.abort();
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'cancelled' });
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
