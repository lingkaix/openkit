import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

/** Complete native history, deliberately separate from present callable authority. */
function pair(kind = 'function', namespace: string | undefined = 'left', callId = 'call_old') {
  return [
    {
      type: `${kind}_call`,
      call_id: callId,
      id: `fc_${callId}`,
      name: 'old',
      ...(namespace !== undefined ? { namespace } : {}),
      ...(kind === 'function' ? { arguments: '{}' } : { input: 'historical input' }),
    },
    {
      type: `${kind}_call_output`,
      call_id: callId,
      id: `out_${callId}`,
      name: 'old',
      ...(namespace !== undefined ? { namespace } : {}),
      output: [{ type: 'input_text', text: 'historical result' }],
    },
  ];
}

/** Independent synthetic backend counts every attempted invocation; it never executes local tools. */
function fixture(stock = false) {
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'fixture',
    models: [{ id: 'physical' }],
  });
  const models = createModels();
  models.setProvider(stock ? xaiProvider() : faux.provider);
  const model = stock ? 'grok-4.7' : 'physical';
  const provider = {
    id: 'fixture-profile',
    adapterId: stock ? 'xai' : 'fixture',
    apiKey: 'synthetic',
    baseUrl: null,
    models: [model],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
  } as ResolvedLLMProviderConfig;
  const client = new PiAiGatewayClient({ models });
  const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
  return { faux, client, dispatcher, provider, model };
}

const emptyPrefix = { type: 'additional_tools', role: 'developer', tools: [] };
const functionDefinition = { type: 'function', name: 'old', parameters: { type: 'object' } };
const customDefinition = { type: 'custom', name: 'old', format: { type: 'text' } };
const searchDefinition = {
  type: 'tool_search',
  execution: 'client',
  description: 'Discover local tools.',
  parameters: { type: 'object' },
};
const searchPair = [
  {
    type: 'tool_search_call',
    call_id: 'search',
    id: 'search_call',
    execution: 'client',
    arguments: {},
    status: 'completed',
  },
  {
    type: 'tool_search_output',
    call_id: 'search',
    id: 'search_result',
    execution: 'client',
    tools: [{ type: 'namespace', name: 'left', tools: [customDefinition] }],
    status: 'completed',
  },
];

describe('native historical pairs are context without callable authority', () => {
  it.each([
    { kind: 'function', anchored: false },
    { kind: 'function', anchored: true },
    { kind: 'custom_tool', anchored: false },
    { kind: 'custom_tool', anchored: true },
  ])('admits complete $kind pairs and canonical aliases without activating tools; anchored=$anchored', async ({
    kind,
    anchored,
  }) => {
    const { faux, dispatcher, provider, model } = fixture();
    faux.setResponses([fauxAssistantMessage('summary')]);
    const input = [
      ...(anchored ? [emptyPrefix] : []),
      ...pair(kind, '', 'default'),
      ...pair(kind, 'left', 'left'),
      ...pair(kind, 'right', 'right'),
    ];
    const defaultResultIndex = anchored ? 2 : 1;
    input[defaultResultIndex] = { ...input[defaultResultIndex], namespace: 'functions' };
    input.push(...pair(kind, 'functions', 'explicit'));
    input[input.length - 2] = {
      ...input[input.length - 2],
      namespace: undefined,
      status: 'completed',
    };
    input[input.length - 1] = { ...input[input.length - 1], namespace: '' };
    const response = await dispatcher.createResponses(provider, { model, input });
    expect(response.status).toBe('completed');
    expect(faux.state.callCount).toBe(1);
  });

  const invalid: Array<[string, Record<string, unknown>[]]> = [
    ['missing result', pair().slice(0, 1)],
    ['orphan result', pair().slice(1)],
    ['reversed result', pair().reverse()],
    ['duplicate call id with distinct item ids', [...pair(), ...pair('function', 'right')]],
    ['duplicate result', [...pair(), pair()[1]!]],
    [
      'ambiguous carrier identities',
      [
        ...pair().map((item) => ({
          ...item,
          call_id: 'a|b',
          ...(item.type === 'function_call' ? { id: 'c' } : {}),
        })),
        ...pair('function', 'right', 'a').map((item) =>
          item.type === 'function_call' ? { ...item, id: 'b|c' } : item
        ),
      ],
    ],
    ['ambiguous historical callable kind', [...pair(), ...pair('custom_tool', 'left', 'another')]],
    ['duplicate item id', pair().map((item) => ({ ...item, id: 'same' }))],
    [
      'identity shared with message',
      [...pair(), { type: 'message', role: 'user', content: 'hello', id: 'fc_call_old' }],
    ],
    ['mismatched kind', [pair()[0]!, pair('custom_tool')[1]!]],
    ['mismatched name', [pair()[0]!, { ...pair()[1], name: 'other' }]],
    ['mismatched namespace', [pair()[0]!, { ...pair()[1], namespace: 'right' }]],
    ['malformed namespace', [{ ...pair()[0], namespace: null }, pair()[1]!]],
    ['empty call id', pair().map((item) => ({ ...item, call_id: '' }))],
    ['invalid item id', [{ ...pair()[0], id: null }, pair()[1]!]],
    ['empty argument string', [{ ...pair()[0], arguments: '' }, pair()[1]!]],
    ['object-valued arguments', [{ ...pair()[0], arguments: {} }, pair()[1]!]],
    ['malformed arguments', [{ ...pair()[0], arguments: '{' }, pair()[1]!]],
    ['non-object arguments', [{ ...pair()[0], arguments: '[]' }, pair()[1]!]],
    ['missing arguments', [{ ...pair()[0], arguments: undefined }, pair()[1]!]],
    ['malformed custom input', [{ ...pair('custom_tool')[0], input: {} }, pair('custom_tool')[1]!]],
    ['incomplete status', [{ ...pair()[0], status: 'in_progress' }, pair()[1]!]],
    ['malformed output', [pair()[0]!, { ...pair()[1], output: { text: 'result' } }]],
    ['unknown required call field', [{ ...pair()[0], required_feature: true }, pair()[1]!]],
    ['unknown required result field', [pair()[0]!, { ...pair()[1], required_feature: true }]],
    ['unsupported tool item', [{ type: 'web_search_call', id: 'web' }]],
    [
      'conflicting present kind',
      [
        { ...emptyPrefix, tools: [{ type: 'namespace', name: 'left', tools: [customDefinition] }] },
        ...pair(),
      ],
    ],
    [
      'conflicting discovered kind after history',
      [{ ...emptyPrefix, tools: [searchDefinition] }, ...pair(), ...searchPair],
    ],
    [
      'invalid search output',
      [
        { ...emptyPrefix, tools: [searchDefinition] },
        searchPair[0]!,
        { ...searchPair[1], tools: [{ type: 'web_search' }] },
      ],
    ],
    [
      'search lineage shares historical id',
      [
        { ...emptyPrefix, tools: [searchDefinition] },
        ...pair('function', 'left', 'search'),
        ...searchPair,
      ],
    ],
    ['history cannot activate search', [...pair(), ...searchPair]],
    ['unsupported declaration', [{ ...emptyPrefix, tools: [{ type: 'web_search' }] }, ...pair()]],
  ];
  it.each(
    invalid.flatMap(([name, history]) =>
      [false, true].map((anchored) => ({ name, history, anchored }))
    )
  )('refuses $name before dispatcher or client backend invocation; anchored=$anchored', async ({
    history,
    anchored,
  }) => {
    const { faux, dispatcher, client, provider, model } = fixture();
    faux.setResponses([fauxAssistantMessage('summary'), fauxAssistantMessage('summary')]);
    const request = {
      model,
      input:
        history[0]?.type === 'additional_tools' || !anchored ? history : [emptyPrefix, ...history],
    };
    await expect(dispatcher.createResponses(provider, request)).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
    });
    await expect(client.createResponses(provider, request)).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
    });
    expect(faux.state.callCount).toBe(0);
  });

  it('keeps undeclared history forbidden across protocols', async () => {
    const { faux, client, provider, model } = fixture();
    const bridged = {
      ...provider,
      gatewayCapabilities: { ...provider.gatewayCapabilities, responses: 'bridged' as const },
    };
    await expect(client.createResponses(bridged, { model, input: pair() })).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
    });
    expect(faux.state.callCount).toBe(0);
  });

  it.each([
    [false, 'function'],
    [true, 'function'],
    [false, 'custom_tool'],
    [true, 'custom_tool'],
  ] as const)('validates completed stock calls against present declarations; stream=%s kind=%s', async (stream, kind) => {
    for (const anchored of [false, true]) {
      for (const [name, namespace, allowed] of [
        ['old', 'left', false],
        ['unknown', 'left', false],
        ['old', 'right', false],
        ['allowed', 'right', true],
      ] as const) {
        const { client, provider, model } = fixture(true);
        const tools = [
          {
            type: 'namespace',
            name: 'right',
            tools: [
              { ...(kind === 'function' ? functionDefinition : customDefinition), name: 'allowed' },
            ],
          },
        ];
        const input = anchored ? [{ ...emptyPrefix, tools }, ...pair(kind)] : pair(kind);
        const request = { model, input, ...(anchored ? {} : { tools }), stream };
        const call = {
          type: `${kind}_call`,
          id: 'fc_new',
          call_id: 'call_new',
          name,
          namespace,
          ...(kind === 'function' ? { arguments: '{}' } : { input: 'new input' }),
          status: 'completed',
        };
        // The namespace arrives only on completion, so a provisional default identity cannot authorize the call.
        const { namespace: _namespace, ...start } = call;
        const events = [
          {
            type: 'response.created',
            response: { id: 'resp_calls', output: [], status: 'in_progress' },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              ...start,
              ...(kind === 'function' ? { arguments: '' } : { input: '' }),
              status: 'in_progress',
            },
          },
          {
            type:
              kind === 'function'
                ? 'response.function_call_arguments.delta'
                : 'response.custom_tool_call_input.delta',
            output_index: 0,
            delta: kind === 'function' ? '{}' : 'new input',
          },
          { type: 'response.output_item.done', output_index: 0, item: call },
          {
            type: 'response.completed',
            response: {
              id: 'resp_calls',
              status: 'completed',
              output: [call],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(
            new Response(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(''),
              { headers: { 'content-type': 'text/event-stream' } }
            )
          );
        const executeTool = vi.fn();
        try {
          const run = async () => {
            if (!stream) {
              const response = await client.createResponses(provider, request);
              for (const item of response.output)
                if (item.type === `${kind}_call`) executeTool(item);
              return;
            }
            const reader = (await client.createResponsesStream(provider, request)).getReader();
            let wire = '';
            let pending = '';
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const text = new TextDecoder().decode(chunk.value);
              wire += text;
              pending += text;
              const lines = pending.split('\n');
              pending = lines.pop()!;
              for (const line of lines.filter((line) => line.startsWith('data: {'))) {
                const event = JSON.parse(line.slice(6));
                if (
                  event.type === 'response.output_item.done' &&
                  event.item.type === `${kind}_call`
                )
                  executeTool(event.item);
              }
            }
            expect(wire).toContain('response.completed');
          };
          if (allowed) {
            await run();
            expect(executeTool).toHaveBeenCalledOnce();
            expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ name, namespace }));
          } else {
            await expect(run()).rejects.toThrow('undeclared provider tool output');
            expect(executeTool).not.toHaveBeenCalled();
          }
          expect(fetchMock).toHaveBeenCalledOnce();
        } finally {
          fetchMock.mockRestore();
        }
      }
    }
  });

  it.each([
    false,
    true,
  ])('refuses historical and unknown output even with no declaration fields; stream=%s', async (stream) => {
    const { client, provider, model } = fixture(true);
    for (const name of ['old', 'unknown']) {
      const call = {
        type: 'function_call',
        id: 'fc_new',
        call_id: 'call_new',
        name,
        namespace: 'left',
        arguments: '{}',
      };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: call },
        { type: 'response.output_item.done', output_index: 0, item: call },
        {
          type: 'response.completed',
          response: { id: 'resp_call', status: 'completed', output: [call] },
        },
      ];
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        );
      try {
        const request = { model, input: pair(), stream };
        const run = async () =>
          stream
            ? new Response(await client.createResponsesStream(provider, request)).text()
            : client.createResponses(provider, request);
        await expect(run()).rejects.toThrow('undeclared provider tool output');
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        fetchMock.mockRestore();
      }
    }
  });
  const malformedOutput: Array<[string, Record<string, unknown>]> = [
    ['empty argument string', { arguments: '' }],
    ['object-valued arguments', { arguments: {} }],
    ['malformed arguments', { arguments: '{' }],
    ['non-object arguments', { arguments: '[]' }],
    ['empty call id', { call_id: '' }],
    ['empty name', { name: '' }],
    ['malformed namespace', { namespace: null }],
    ['incomplete status', { status: 'in_progress' }],
    ['unknown required field', { required_feature: true }],
    ['conflicting kind', { type: 'custom_tool_call', input: 'wrong kind' }],
  ];
  it.each(
    malformedOutput.flatMap(([name, fields]) =>
      [false, true].map((stream) => ({ name, fields, stream }))
    )
  )('rejects malformed completed stock calls ($name) before executable output; stream=$stream', async ({
    fields,
    stream,
  }) => {
    const { client, provider, model } = fixture(true);
    const call = {
      type: 'function_call',
      id: 'fc_new',
      call_id: 'call_new',
      name: 'old',
      namespace: 'left',
      arguments: '{}',
      status: 'completed',
      ...fields,
    };
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...call, arguments: '', status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: 0, item: call },
      {
        type: 'response.completed',
        response: { id: 'resp_call', status: 'completed', output: [call] },
      },
    ];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      );
    let wire = '';
    const executeTool = vi.fn();
    try {
      const request = { model, input: [emptyPrefix, ...pair()], tools: [], stream };
      // Give this new call real current authority, so syntax rather than historical authority decides refusal.
      request.input[0] = {
        ...emptyPrefix,
        tools: [{ type: 'namespace', name: 'left', tools: [functionDefinition] }],
      };
      const run = async () => {
        if (!stream) {
          const response = await client.createResponses(provider, request);
          for (const item of response.output)
            if (item.type === 'function_call' || item.type === 'custom_tool_call')
              executeTool(item);
          return;
        }
        const reader = (await client.createResponsesStream(provider, request)).getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          wire += new TextDecoder().decode(chunk.value);
        }
      };
      // The stock SDK wraps observer errors; this text still identifies the native validator, not its parser.
      await expect(run()).rejects.toThrow(
        Object.hasOwn(fields, 'arguments')
          ? 'pi-ai Responses function arguments'
          : 'Gateway does not support this feature: pi-ai Responses'
      );
      expect(executeTool).not.toHaveBeenCalled();
      expect(wire).not.toContain('"type":"response.output_item.done"');
      expect(wire).not.toContain('"type":"response.completed"');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
