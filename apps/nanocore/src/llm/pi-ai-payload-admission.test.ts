import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { admitModelRequest } from './model-token-admission.js';
import type { OpenAICompatibleResponsesRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';
import type { RawModelOutputPosition } from './raw-provider-output.js';

type Admission = NonNullable<LLMGatewayTransportContext['finalRequestAdmission']>;
type AdmissionInput = Parameters<Admission>[0];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    })
  );
});

/** Real stock serializers and HTTP transport over a test-owned synthetic endpoint. */
async function fixture(api: 'responses' | 'chat' | 'codex' = 'responses') {
  const bodies: Record<string, unknown>[] = [];
  const wire: string[] = [];
  const states: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error('Fixture request limit.');
        chunks.push(Buffer.from(chunk));
      }
      const encoded = Buffer.concat(chunks);
      const decoded =
        request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(encoded) : encoded;
      wire.push(decoded.toString('utf8'));
      bodies.push(JSON.parse(wire.at(-1)!));
      states.push(request.headers['x-codex-turn-state'] as string | undefined);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-codex-turn-state': 'returned-state',
      });
      const event =
        api === 'chat'
          ? {
              id: 'chat_local',
              object: 'chat.completion.chunk',
              created: 1,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'answer' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }
          : {
              type: 'response.completed',
              response: {
                id: 'resp_local',
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            };
      response.end(`data: ${JSON.stringify(event)}\n\n${api === 'chat' ? 'data: [DONE]\n\n' : ''}`);
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable.');
  const stock =
    api === 'chat'
      ? deepseekProvider()
      : api === 'codex'
        ? openaiCodexProvider()
        : openaiProvider();
  const models = createModels();
  models.setProvider(stock);
  const expectedApi =
    api === 'chat'
      ? 'openai-completions'
      : api === 'codex'
        ? 'openai-codex-responses'
        : 'openai-responses';
  const model = models
    .getModels()
    .find((entry) => entry.provider === stock.id && entry.api === expectedApi);
  if (!model) throw new Error('Stock fixture model unavailable.');
  const credential =
    api === 'codex'
      ? `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`
      : 'synthetic-local-only';
  const provider: ResolvedLLMProviderConfig = {
    id: 'local-profile',
    displayName: 'Local fixture',
    adapterId: stock.id,
    apiKey: credential,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [model.id],
    requiresApiKey: true,
    gatewayCapabilities: {
      chatCompletions: api === 'chat' ? 'native' : 'bridged',
      responses: api === 'chat' ? 'bridged' : 'native',
    },
  };
  return { client: new PiAiGatewayClient({ models }), model, provider, bodies, wire, states };
}

/** Uses the existing immutable capture; its fixed fixture counter tests this seam, not provider token qualification. */
async function capture(input: AdmissionInput, signal?: AbortSignal, payload = input.payload) {
  const result = await admitModelRequest({
    model: {
      providerId: input.providerId,
      modelId: input.modelId,
      api:
        input.api === 'openai-completions'
          ? 'chat-completions'
          : input.api === 'openai-codex-responses'
            ? 'codex-responses'
            : 'responses',
    },
    request: payload,
    imageFacts: [],
    continuity: input.codexTurnState,
    contextWindowTokens: input.adapterContextWindowTokens,
    maxOutputTokens: input.adapterMaxOutputTokens,
    outputReserveTokens: 32,
    ...(signal ? { signal } : {}),
    counter: async (value) => ({
      kind: 'counted',
      model: value.model,
      requestDigest: value.requestDigest,
      imageFactsDigest: value.imageFactsDigest,
      accountingIdentity: 'fixture-capture-only',
      coverage: 'complete-request',
      inputTokens: 1,
    }),
  });
  if (result.kind !== 'admitted') throw new Error('Fixture admission refused.');
  return result.request;
}

/** A controlled gate lets the test observe that HTTP has not started before admission. */
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

describe('private final native payload admission', () => {
  it('awaits admission after stock assembly and before any inference HTTP', async () => {
    const f = await fixture();
    let entered = false;
    const held = gate();
    const transport: LLMGatewayTransportContext = {
      finalRequestAdmission: async (input, signal) => {
        entered = true;
        await held.wait;
        return capture(input, signal);
      },
    };
    const pending = f.client.createResponses(
      f.provider,
      { model: f.model.id, input: 'Complete source request', max_output_tokens: 32 },
      undefined,
      transport
    );
    try {
      await expect.poll(() => entered || f.bodies.length > 0).toBe(true);
      expect(entered).toBe(true);
      expect(f.bodies).toHaveLength(0);
      held.release();
      await pending;
      expect(f.bodies).toHaveLength(1);
    } finally {
      held.release();
      await pending.catch(() => undefined);
    }
  });

  it('sees complete native history, instructions, Tools and overlays, and sends only the immutable admitted wire', async () => {
    const f = await fixture();
    const held = gate();
    let observed: AdmissionInput | undefined;
    let admitted: Readonly<Record<string, unknown>> | undefined;
    const request: OpenAICompatibleResponsesRequest = {
      model: f.model.id,
      instructions: 'Full instructions',
      input: [
        { role: 'user', content: 'Earlier input' },
        { role: 'assistant', content: 'Earlier answer' },
        { type: 'function_call', id: 'fc_old', call_id: 'call_old', name: 'old', arguments: '{}' },
        {
          type: 'function_call_output',
          id: 'out_old',
          call_id: 'call_old',
          output: 'Complete old result',
        },
        { role: 'user', content: 'Current input' },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Complete Tool description',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      parallel_tool_calls: false,
      max_output_tokens: 64,
      text: { verbosity: 'low' },
    };
    const pending = f.client.createResponses(f.provider, request, undefined, {
      finalRequestAdmission: async (input, signal) => {
        observed = input;
        admitted = await capture(input, signal, {
          ...(input.payload as Record<string, unknown>),
          max_output_tokens: 32,
        });
        await held.wait;
        return admitted;
      },
    });
    try {
      await expect.poll(() => admitted !== undefined).toBe(true);
      expect(observed).toMatchObject({
        providerId: f.provider.id,
        modelId: f.model.id,
        api: 'openai-responses',
        codexTurnState: null,
        adapterContextWindowTokens: f.model.contextWindow,
        adapterMaxOutputTokens: f.model.maxTokens,
      });
      expect(observed?.payload).toMatchObject({
        instructions: 'Full instructions',
        input: request.input,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'lookup', description: 'Complete Tool description' }),
        ]),
        parallel_tool_calls: false,
        max_output_tokens: 64,
        text: { verbosity: 'low' },
      });
      (observed?.payload as Record<string, unknown>).instructions = 'Late caller mutation';
      request.instructions = 'Changed public request';
      expect(f.bodies).toHaveLength(0);
      held.release();
      await pending;
      expect(f.wire).toEqual([JSON.stringify(admitted)]);
      expect(f.bodies[0]).toMatchObject({
        instructions: 'Full instructions',
        max_output_tokens: 32,
        parallel_tool_calls: false,
      });
      expect(Object.isFrozen(admitted)).toBe(true);
      expect(Object.isFrozen(admitted?.input)).toBe(true);
    } finally {
      held.release();
      await pending.catch(() => undefined);
    }
  });

  it('refuses callback failure before HTTP and keeps the existing unsupported class without private diagnostics', async () => {
    const f = await fixture();
    const pending = f.client.createResponses(
      f.provider,
      { model: f.model.id, input: 'Hello' },
      undefined,
      {
        finalRequestAdmission: async () => {
          throw new Error('Private counter unavailable diagnostic.');
        },
      }
    );
    await expect(pending).rejects.toMatchObject({ failure: { kind: 'unsupported' } });
    await expect(pending).rejects.not.toThrow(/Private/);
    expect(f.bodies).toHaveLength(0);
  });

  it('refuses an unavailable result envelope or nonobject instead of dispatching it', async () => {
    const f = await fixture();
    for (const value of [
      null,
      Object.freeze({ kind: 'unavailable', reason: 'counter-unavailable' }),
    ]) {
      await expect(
        f.client.createResponses(f.provider, { model: f.model.id, input: 'Hello' }, undefined, {
          finalRequestAdmission: (async () => value) as Admission,
        })
      ).rejects.toMatchObject({ failure: { kind: 'unsupported' } });
    }
    expect(f.bodies).toHaveLength(0);
  });

  it('preserves native Chat messages, Tool controls and raw source observation through admission', async () => {
    const f = await fixture('chat');
    let seen: AdmissionInput | undefined;
    let active = 0;
    let events = 0;
    const positions: RawModelOutputPosition[] = [];
    const result = await f.client.createChatCompletion(
      f.provider,
      {
        model: f.model.id,
        messages: [
          { role: 'system', content: 'Full system' },
          { role: 'user', content: 'Earlier' },
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'Current' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Tool context',
              parameters: { type: 'object' },
            },
          },
        ],
        max_tokens: 32,
        parallel_tool_calls: false,
      },
      undefined,
      {
        finalRequestAdmission: async (input, signal) => {
          seen = input;
          return capture(input, signal);
        },
        rawOutput: {
          sourceStarted: () => {
            active++;
            return () => {
              active--;
            };
          },
          sourceEvent: () => {
            events++;
          },
          observe: (position) => positions.push(position),
          fail: (error): never => {
            throw error;
          },
        },
      }
    );
    expect(seen).toMatchObject({ api: 'openai-completions', codexTurnState: null });
    expect(seen?.payload).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: 'Full system' }),
        expect.objectContaining({ content: 'Earlier answer' }),
      ]),
      parallel_tool_calls: false,
    });
    expect(f.bodies[0]).toEqual(JSON.parse(JSON.stringify(seen?.payload)));
    expect(result.choices[0]?.message.content).toBe('answer');
    expect(active).toBe(0);
    expect(events).toBeGreaterThan(0);
    expect(positions).toEqual([
      expect.objectContaining({ field: 'text', fromBytePosition: 0, bytePosition: 6 }),
    ]);
  });

  it('passes exact opaque Codex header state separately and preserves its native transport', async () => {
    const f = await fixture('codex');
    let seen: AdmissionInput | undefined;
    const returned: string[] = [];
    await f.client.createResponses(
      f.provider,
      { model: f.model.id, input: 'Hello', max_output_tokens: 32, parallel_tool_calls: false },
      undefined,
      {
        codexTurnState: 'opaque-request-state',
        onCodexTurnState: (state) => returned.push(state),
        finalRequestAdmission: async (input, signal) => {
          seen = input;
          return capture(input, signal);
        },
      }
    );
    expect(seen).toMatchObject({
      api: 'openai-codex-responses',
      codexTurnState: 'opaque-request-state',
      payload: { max_output_tokens: 32, parallel_tool_calls: false },
    });
    expect(f.states).toEqual(['opaque-request-state']);
    expect(returned).toEqual(['returned-state']);
  });

  it('cancels while admission is pending with zero inference HTTP', async () => {
    const f = await fixture();
    const held = gate();
    const abort = new AbortController();
    let entered = false;
    const pending = f.client.createResponses(
      f.provider,
      { model: f.model.id, input: 'Hello' },
      undefined,
      {
        signal: abort.signal,
        finalRequestAdmission: async (input, signal) => {
          entered = true;
          await held.wait;
          return capture(input, signal);
        },
      }
    );
    try {
      await expect.poll(() => entered).toBe(true);
      abort.abort(new Error('Caller cancelled.'));
      await expect(pending).rejects.toThrow('Caller cancelled.');
      expect(f.bodies).toHaveLength(0);
    } finally {
      held.release();
      await pending.catch(() => undefined);
    }
  });
});
