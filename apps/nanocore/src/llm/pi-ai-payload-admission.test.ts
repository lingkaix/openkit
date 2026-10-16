import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it } from 'vitest';
import { admitModelRequest } from '../context/model-request-admission.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { OpenAICompatibleResponsesRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';

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
async function fixture(api: 'responses' | 'chat' | 'codex' | 'custom' = 'responses') {
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
  const modelId = api === 'custom' ? 'local-custom-model' : model.id;
  const provider: ResolvedLLMProviderConfig = {
    id: 'local-profile',
    displayName: 'Local fixture',
    adapterId: stock.id,
    apiKey: credential,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [modelId],
    modelMetadata: {
      [modelId]: {
        modalities: { input: ['text', 'image'] },
        limit: { context: 131072, output: 8192 },
      },
    },
    requiresApiKey: true,
    gatewayCapabilities: {
      chatCompletions: api === 'chat' ? 'native' : 'bridged',
      responses: api === 'chat' ? 'bridged' : 'native',
    },
  };
  return {
    client: new PiAiGatewayClient({ models }),
    model: { ...model, id: modelId },
    provider,
    bodies,
    wire,
    states,
  };
}

/** Holds the real serializer before its HTTP request starts. */
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

const input: OpenAICompatibleResponsesRequest = {
  model: '',
  instructions: 'Preserve complete system instructions.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '漢字 JSON {"selected":true}' }] }],
  tools: [
    {
      type: 'function',
      name: 'read',
      description: 'Read exact bytes.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      strict: false,
    },
  ],
  max_output_tokens: 32,
  parallel_tool_calls: false,
};

describe('final payload local admission', () => {
  it.each([
    'responses',
    'chat',
    'codex',
    'custom',
  ] as const)('awaits the final %s payload and preserves the actual wire without a network counter', async (api) => {
    const f = await fixture(api);
    const held = gate();
    const entered = gate();
    let captured: AdmissionInput | undefined;
    // Image mapping is a separate accepted increment. This check exercises the current text transport contract.
    const request = { ...input, model: f.model.id };
    const completion = f.client.createResponses(f.provider, request, undefined, {
      codexTurnState: api === 'codex' ? 'retained-native-state' : undefined,
      finalRequestAdmission: async (final) => {
        captured = final;
        admitModelRequest({
          payload: final.payload,
          continuity: final.codexTurnState,
          contextWindowTokens: 131072,
          outputReserveTokens: final.outputReserveTokens,
        });
        entered.release();
        await held.pending;
      },
    });
    await Promise.race([
      entered.pending,
      completion.then(() => {
        throw new Error('The serializer completed before its admission barrier.');
      }),
    ]);
    expect(f.bodies).toEqual([]);
    expect(captured).toMatchObject({ outputReserveTokens: 32 });
    held.release();
    await completion;
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]).toEqual(captured!.payload);
    expect(f.bodies[0]).toHaveProperty('model', f.model.id);
    expect(f.wire[0]).toContain('Preserve complete system instructions.');
    expect(f.wire[0]).toContain('漢字 JSON');
    expect(f.wire[0]).toContain('Read exact bytes.');
    if (api === 'codex') {
      expect(captured!.codexTurnState).toBe('retained-native-state');
      expect(f.states).toEqual(['retained-native-state']);
      expect(f.bodies[0]).toMatchObject({ max_output_tokens: 32, parallel_tool_calls: false });
    }
  });

  it('refuses an oversized final overlaid payload before the real HTTP request', async () => {
    const f = await fixture();
    await expect(
      f.client.createResponses(f.provider, { ...input, model: f.model.id }, undefined, {
        finalRequestAdmission: (final) =>
          admitModelRequest({
            payload: final.payload,
            contextWindowTokens: 4096,
            outputReserveTokens: final.outputReserveTokens,
          }),
      })
    ).rejects.toThrow();
    expect(f.bodies).toEqual([]);
  });
});
