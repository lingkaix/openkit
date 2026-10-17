import { createModels } from '@earendil-works/pi-ai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';

/** Encodes synthetic native Responses events consumed by the real stock xAI parser. */
function syntheticResponses(model: string, output: Record<string, unknown>[]): Response {
  const response = { id: 'resp_fixture', model, output, status: 'completed' };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
  ];
  for (const [index, item] of output.entries()) {
    events.push({
      type: 'response.output_item.added',
      output_index: index,
      item: {
        ...item,
        status: 'in_progress',
        ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }),
      },
    });
    if (item.type === 'function_call') {
      events.push({
        type: 'response.function_call_arguments.delta',
        output_index: index,
        item_id: item.id,
        delta: item.arguments,
      });
    } else {
      events.push({
        type: 'response.output_text.delta',
        output_index: index,
        item_id: item.id,
        content_index: 0,
        delta: 'Continuation accepted.',
      });
    }
    events.push({ type: 'response.output_item.done', output_index: index, item });
  }
  events.push({
    type: 'response.completed',
    response: {
      ...response,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Consumes either outward mapping without replacing the stock SDK or its parser. */
async function invoke(
  client: PiAiGatewayClient,
  provider: ResolvedLLMProviderConfig,
  request: OpenAICompatibleResponsesRequest,
  stream: boolean
): Promise<OpenAICompatibleResponsesResponse> {
  if (!stream) return client.createResponses(provider, request);
  const body = await new Response(
    await client.createResponsesStream(provider, { ...request, stream: true })
  ).text();
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  const completed = events.filter((event) => event.type === 'response.completed');
  expect(completed).toHaveLength(1);
  const response = completed[0].response as OpenAICompatibleResponsesResponse;
  expect(
    events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
  ).toEqual(response.output);
  return response;
}

afterEach(() => vi.unstubAllGlobals());

describe('stock xAI Worker tool adaptation', () => {
  it.each([
    false,
    true,
  ])('restores custom and namespace identity through continuation; stream=%s', async (stream) => {
    const models = createModels();
    models.setProvider(xaiProvider());
    const model = models.getModel('xai', 'grok-4.3');
    if (!model) throw new Error('The pinned xAI fixture requires grok-4.3.');
    const provider: ResolvedLLMProviderConfig = {
      adapterId: 'xai',
      apiKey: 'synthetic-xai-tools-key',
      backend: 'pi-ai',
      baseUrl: null,
      displayName: 'Synthetic xAI fixture',
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      id: 'xai',
      models: [model.id],
      requiresApiKey: true,
    };
    const client = new PiAiGatewayClient({ models });
    const requests: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const patchInput = 'fixture_patch';
    let patchName = '';
    let inspectName = '';
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(url instanceof Request ? url.url : String(url));
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      const tools = request.tools as Array<Record<string, unknown>>;
      if (tools.some((tool) => tool.type !== 'function')) {
        // This rejection is synthetic; the recorded live provider body is unavailable.
        return new Response(JSON.stringify({ error: { message: 'Synthetic fixture HTTP 422.' } }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requests.length === 1) {
        const patch = tools.find((tool) =>
          Object.hasOwn((tool.parameters as { properties: object }).properties, 'input')
        );
        const inspect = tools.find((tool) =>
          Object.hasOwn((tool.parameters as { properties: object }).properties, 'path')
        );
        patchName = String(patch?.name);
        inspectName = String(inspect?.name);
        return syntheticResponses(model.id, [
          {
            type: 'function_call',
            id: 'fc_patch',
            call_id: 'call_patch',
            name: patchName,
            arguments: JSON.stringify({ input: patchInput }),
            status: 'completed',
          },
          {
            type: 'function_call',
            id: 'fc_inspect',
            call_id: 'call_inspect',
            name: inspectName,
            arguments: JSON.stringify({ path: '.' }),
            status: 'completed',
          },
        ]);
      }
      return syntheticResponses(model.id, [
        {
          type: 'message',
          id: 'msg_continued',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Continuation accepted.', annotations: [] }],
        },
      ]);
    });
    vi.stubGlobal('fetch', fetch);
    const tools = [
      {
        type: 'custom',
        name: 'apply_patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "fixture_patch"' },
      },
      {
        type: 'namespace',
        name: 'workspace',
        tools: [
          {
            type: 'function',
            name: 'inspect',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ];
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'Use the fixture tools.' }] },
    ];
    const first = await invoke(client, provider, { model: model.id, tools, input }, stream);
    expect(first.status).toBe('completed');
    expect(first.output).toEqual([
      expect.objectContaining({
        type: 'custom_tool_call',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: patchInput,
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_inspect',
        name: 'inspect',
        namespace: 'workspace',
        arguments: '{"path":"."}',
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = await invoke(
      client,
      provider,
      {
        model: model.id,
        tools,
        input: [
          ...input,
          ...first.output!,
          { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'patch-result' },
          { type: 'function_call_output', call_id: 'call_inspect', output: 'inspect-result' },
        ],
      },
      stream
    );
    expect(second).toMatchObject({
      status: 'completed',
      output: [
        expect.objectContaining({
          content: [{ type: 'output_text', text: 'Continuation accepted.', annotations: [] }],
        }),
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls).toEqual(['https://api.x.ai/v1/responses', 'https://api.x.ai/v1/responses']);
    for (const request of requests) {
      const providerTools = request.tools as Array<Record<string, unknown>>;
      expect(providerTools).toHaveLength(2);
      expect(providerTools.every((tool) => tool.type === 'function')).toBe(true);
      expect(providerTools.map((tool) => tool.name)).toEqual([patchName, inspectName]);
      expect(new Set([patchName, inspectName]).size).toBe(2);
      for (const name of [patchName, inspectName]) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(providerTools.find((tool) => tool.name === patchName)?.parameters).toMatchObject({
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      });
    }
    const history = requests[1]!.input as Array<Record<string, unknown>>;
    expect(history.filter((item) => item.type === 'function_call')).toEqual([
      expect.objectContaining({
        call_id: 'call_patch',
        name: patchName,
        arguments: JSON.stringify({ input: patchInput }),
      }),
      expect.objectContaining({
        call_id: 'call_inspect',
        name: inspectName,
        arguments: '{"path":"."}',
      }),
    ]);
    expect(history.filter((item) => item.type === 'function_call_output')).toEqual([
      expect.objectContaining({ call_id: 'call_patch', output: 'patch-result' }),
      expect.objectContaining({ call_id: 'call_inspect', output: 'inspect-result' }),
    ]);
    expect(history.some((item) => String(item.type).startsWith('custom_tool_call'))).toBe(false);
    expect(
      history
        .filter((item) => item.type === 'function_call')
        .every((item) => item.namespace === undefined)
    ).toBe(true);
  });
});
