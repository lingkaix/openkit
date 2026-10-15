import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  type ToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { OpenAICompatibleChatCompletionRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';

const declaration = {
  type: 'function',
  function: {
    name: 'lookup',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};
const history = [
  { role: 'user', content: 'Find the previous result.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_old',
        type: 'function',
        function: { name: 'old', arguments: '{"query":"past"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_old', content: 'Historical result' },
] as const;

/** Composes the real client and Models boundary with controlled semantic Provider output. */
function fixture(message: AssistantMessage, events?: AssistantMessageEvent[]) {
  const faux = fauxProvider({
    api: 'openai-completions',
    provider: 'declaration-fixture',
    models: [{ id: 'physical' }],
  });
  const models = createModels();
  const contexts: TranscriptContext[] = [];
  const invoke = vi.fn((context: TranscriptContext) => {
    contexts.push(context);
    return message;
  });
  if (events) {
    Object.assign(faux.provider, {
      stream: (_model: unknown, context: TranscriptContext) => {
        invoke(context);
        const output = createAssistantMessageEventStream();
        for (const event of events) output.push(event);
        output.end(message);
        return output;
      },
    });
  } else {
    faux.setResponses([invoke]);
  }
  models.setProvider(faux.provider);
  const provider = {
    id: 'declaration-profile',
    adapterId: 'declaration-fixture',
    apiKey: 'synthetic',
    baseUrl: null,
    models: ['physical'],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
  } as ResolvedLLMProviderConfig;
  return { client: new PiAiGatewayClient({ models }), provider, contexts, invoke };
}

/** Reads the actual Chat stream, retaining public bytes when terminal validation fails. */
async function readChat(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let wire = '';
  let error: unknown;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      wire += decoder.decode(chunk.value, { stream: true });
    }
  } catch (failure) {
    error = failure;
  } finally {
    reader.releaseLock();
  }
  const frames = wire
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { wire, frames, error };
}

/** Exercises refusal at either final release or the streamed terminal boundary. */
async function expectRefusal(
  subject: ReturnType<typeof fixture>,
  request: OpenAICompatibleChatCompletionRequest,
  stream: boolean
) {
  let streamed: Awaited<ReturnType<typeof readChat>> | undefined;
  if (stream) {
    try {
      streamed = await readChat(
        await subject.client.createChatCompletionStream(subject.provider, request)
      );
    } catch (error) {
      streamed = { wire: '', frames: [], error };
    }
    const result = streamed;
    expect(result.error).toMatchObject({ code: 'unsupported_gateway_feature' });
    expect(result.wire).not.toContain('[DONE]');
    expect(
      result.frames.flatMap((frame) => frame.choices ?? []).some((choice) => choice.finish_reason)
    ).toBe(false);
  } else {
    await expect(
      subject.client.createChatCompletion(subject.provider, request)
    ).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
    });
  }
  expect(subject.invoke).toHaveBeenCalledOnce();
  return streamed;
}

describe('new Chat calls require the current request declaration', () => {
  for (const stream of [false, true]) {
    it(`preserves a declared call and its arguments; stream=${stream}`, async () => {
      const subject = fixture(
        fauxAssistantMessage(
          [fauxText('Checking.'), fauxToolCall('lookup', { query: 'current' }, { id: 'call_new' })],
          { stopReason: 'toolUse' }
        )
      );
      const request = { model: 'physical', messages: [], tools: [declaration], stream };
      if (stream) {
        const result = await readChat(
          await subject.client.createChatCompletionStream(subject.provider, request)
        );
        expect(result.error).toBeUndefined();
        const choices = result.frames.flatMap((frame) => frame.choices ?? []);
        const calls = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
        expect(calls.find((call) => call.function?.name)).toMatchObject({
          id: 'call_new',
          function: { name: 'lookup' },
        });
        expect(JSON.parse(calls.map((call) => call.function?.arguments ?? '').join(''))).toEqual({
          query: 'current',
        });
        expect(choices.map((choice) => choice.delta?.content ?? '').join('')).toBe('Checking.');
        expect(choices.at(-1).finish_reason).toBe('tool_calls');
        expect(result.wire).toContain('[DONE]');
      } else {
        const result = await subject.client.createChatCompletion(subject.provider, request);
        expect(result.choices[0]).toMatchObject({
          finish_reason: 'tool_calls',
          message: {
            content: 'Checking.',
            tool_calls: [
              {
                id: 'call_new',
                type: 'function',
                function: { name: 'lookup', arguments: '{"query":"current"}' },
              },
            ],
          },
        });
      }
      expect(subject.invoke).toHaveBeenCalledOnce();
    });

    const refused = [
      { name: 'absent declarations', tools: undefined, nameOut: 'lookup' },
      { name: 'empty declarations', tools: [], nameOut: 'lookup' },
      { name: 'unknown callable', tools: [declaration], nameOut: 'unknown' },
      {
        name: 'historical but undeclared callable',
        tools: [declaration],
        nameOut: 'old',
        messages: history,
      },
    ];
    it.each(refused)(`refuses $name without retry; stream=${stream}`, async ({
      tools,
      nameOut,
      messages,
    }) => {
      const subject = fixture(
        fauxAssistantMessage(fauxToolCall(nameOut, {}, { id: 'call_new' }), {
          stopReason: 'toolUse',
        })
      );
      await expectRefusal(
        subject,
        {
          model: 'physical',
          messages: messages ?? [],
          ...(tools === undefined ? {} : { tools }),
          stream,
        },
        stream
      );
    });

    it.each([
      { label: 'null', argumentsOut: null },
      { label: 'array', argumentsOut: [] },
      { label: 'string', argumentsOut: 'not an object' },
      { label: 'number', argumentsOut: 3 },
    ])(`refuses non-object completed arguments $label; stream=${stream}`, async ({
      argumentsOut,
    }) => {
      // Fault injection is at the semantic boundary; this does not claim malformed-wire parser coverage.
      const malformed = {
        ...fauxToolCall('lookup', {}, { id: 'call_new' }),
        arguments: argumentsOut,
      } as unknown as ToolCall;
      const subject = fixture(fauxAssistantMessage(malformed, { stopReason: 'toolUse' }));
      await expectRefusal(
        subject,
        { model: 'physical', messages: [], tools: [declaration], stream },
        stream
      );
    });

    it(`refuses a duplicate call id with conflicting callable identities; stream=${stream}`, async () => {
      const subject = fixture(
        fauxAssistantMessage(
          [
            fauxToolCall('lookup', {}, { id: 'call_duplicate|fc_first' }),
            fauxToolCall('other', {}, { id: 'call_duplicate|fc_second' }),
          ],
          { stopReason: 'toolUse' }
        )
      );
      const other = { ...declaration, function: { ...declaration.function, name: 'other' } };
      await expectRefusal(
        subject,
        { model: 'physical', messages: [], tools: [declaration, other], stream },
        stream
      );
    });

    it(`preserves historical context and plain text without inventing a declaration; stream=${stream}`, async () => {
      const subject = fixture(fauxAssistantMessage('Historical result remains context.'));
      const request = { model: 'physical', messages: history, stream };
      if (stream) {
        const result = await readChat(
          await subject.client.createChatCompletionStream(subject.provider, request)
        );
        expect(result.error).toBeUndefined();
        expect(
          result.frames
            .flatMap((frame) => frame.choices ?? [])
            .map((choice) => choice.delta?.content ?? '')
            .join('')
        ).toBe('Historical result remains context.');
        expect(result.wire).toContain('[DONE]');
      } else {
        expect(
          (await subject.client.createChatCompletion(subject.provider, request)).choices[0]?.message
            .content
        ).toBe('Historical result remains context.');
      }
      expect(subject.invoke).toHaveBeenCalledOnce();
      expect(getCurrentTools(subject.contexts[0]!.messages)).toEqual([]);
      expect(
        subject.contexts[0]!.messages.filter((message) => message.role !== 'system')
      ).toMatchObject([
        { role: 'user', content: 'Find the previous result.' },
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call_old', name: 'old', arguments: { query: 'past' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call_old',
          toolName: 'old',
          content: [{ type: 'text', text: 'Historical result' }],
        },
      ]);
    });
  }

  it.each([
    'lookup',
    'unknown',
  ])('validates identity supplied only at completion: %s', async (name) => {
    const completed = fauxToolCall(name, { query: 'current' }, { id: 'call_late' });
    const message = fauxAssistantMessage([completed], { stopReason: 'toolUse' });
    const provisional = fauxAssistantMessage([{ ...completed, id: '', name: '', arguments: {} }]);
    const subject = fixture(message, [
      { type: 'start', partial: fauxAssistantMessage([]) },
      { type: 'toolcall_start', contentIndex: 0, partial: provisional },
      {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"query":"current"}',
        partial: provisional,
      },
      { type: 'toolcall_end', contentIndex: 0, toolCall: completed, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    const request = { model: 'physical', messages: [], tools: [declaration], stream: true };
    if (name === 'unknown') {
      await expectRefusal(subject, request, true);
      return;
    }
    const result = await readChat(
      await subject.client.createChatCompletionStream(subject.provider, request)
    );
    expect(result.error).toBeUndefined();
    const calls = result.frames
      .flatMap((frame) => frame.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
    expect(calls.find((call) => call.function?.name)).toMatchObject({
      id: 'call_late',
      function: { name: 'lookup' },
    });
    expect(calls.some((call) => call.id === '' || call.function?.name === '')).toBe(false);
    expect(JSON.parse(calls.map((call) => call.function?.arguments ?? '').join(''))).toEqual({
      query: 'current',
    });
    expect(result.wire).toContain('[DONE]');
    expect(subject.invoke).toHaveBeenCalledOnce();
  });

  it('terminates after committed text when the completed call is undeclared', async () => {
    const completed = fauxToolCall('unknown', {}, { id: 'call_late_bad' });
    const text = fauxAssistantMessage([fauxText('Visible text.')]);
    const message = fauxAssistantMessage([fauxText('Visible text.'), completed], {
      stopReason: 'toolUse',
    });
    const subject = fixture(message, [
      { type: 'start', partial: fauxAssistantMessage([]) },
      { type: 'text_end', contentIndex: 0, content: 'Visible text.', partial: text },
      { type: 'toolcall_end', contentIndex: 1, toolCall: completed, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    const result = await expectRefusal(
      subject,
      { model: 'physical', messages: [], tools: [declaration], stream: true },
      true
    );
    expect(
      result?.frames
        .flatMap((frame) => frame.choices ?? [])
        .map((choice) => choice.delta?.content ?? '')
        .join('')
    ).toBe('Visible text.');
  });

  it.each([
    'name',
    'id',
  ] as const)('refuses a completed %s conflict even when both names are declared', async (field) => {
    const started = fauxToolCall('lookup', {}, { id: 'call_started' });
    const completed = { ...started, [field]: field === 'name' ? 'other' : 'call_changed' };
    const message = fauxAssistantMessage([completed], { stopReason: 'toolUse' });
    const subject = fixture(message, [
      { type: 'start', partial: fauxAssistantMessage([]) },
      { type: 'toolcall_start', contentIndex: 0, partial: fauxAssistantMessage([started]) },
      { type: 'toolcall_end', contentIndex: 0, toolCall: completed, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    const other = { ...declaration, function: { ...declaration.function, name: 'other' } };
    await expectRefusal(
      subject,
      { model: 'physical', messages: [], tools: [declaration, other], stream: true },
      true
    );
  });

  it.each([
    'lookup',
    'unknown',
  ])('validates a terminal-only call without a tool-end event: %s', async (name) => {
    const message = fauxAssistantMessage(fauxToolCall(name, {}, { id: 'call_terminal' }), {
      stopReason: 'toolUse',
    });
    const subject = fixture(message, [
      { type: 'start', partial: fauxAssistantMessage([]) },
      { type: 'done', reason: 'toolUse', message },
    ]);
    const request = { model: 'physical', messages: [], tools: [declaration], stream: true };
    if (name === 'unknown') {
      await expectRefusal(subject, request, true);
      return;
    }
    const result = await readChat(
      await subject.client.createChatCompletionStream(subject.provider, request)
    );
    expect(result.error).toBeUndefined();
    const choices = result.frames.flatMap((frame) => frame.choices ?? []);
    const calls = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
    expect(calls.find((call) => call.function?.name)).toMatchObject({
      id: 'call_terminal',
      function: { name: 'lookup' },
    });
    expect(JSON.parse(calls.map((call) => call.function?.arguments ?? '').join(''))).toEqual({});
    expect(choices.at(-1).finish_reason).toBe('tool_calls');
    expect(result.wire).toContain('[DONE]');
    expect(subject.invoke).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])('refuses an unfinished started call omitted from terminal output; identityKnown=%s', async (identityKnown) => {
    const started = fauxToolCall(
      identityKnown ? 'lookup' : '',
      {},
      { id: identityKnown ? 'call_unfinished' : '' }
    );
    const message = fauxAssistantMessage('Final text.');
    const subject = fixture(message, [
      { type: 'start', partial: fauxAssistantMessage([]) },
      { type: 'toolcall_start', contentIndex: 0, partial: fauxAssistantMessage([started]) },
      { type: 'done', reason: 'stop', message },
    ]);
    await expectRefusal(
      subject,
      { model: 'physical', messages: [], tools: [declaration], stream: true },
      true
    );
  });
});
