import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it } from 'vitest';
import { admitModelRequest } from '../context/model-request-admission.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';

type FinalRequest = Parameters<NonNullable<LLMGatewayTransportContext['finalRequestAdmission']>>[0];
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

/** Exercises stock serializers and HTTP with a test-owned endpoint and synthetic credentials. */
async function fixture(api: 'responses' | 'chat' | 'codex') {
  const requests: Array<{ path: string | undefined; payload: unknown; continuity: unknown }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      const decoded =
        request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(encoded) : encoded;
      requests.push({
        path: request.url,
        payload: JSON.parse(decoded.toString('utf8')),
        continuity: request.headers['x-codex-turn-state'],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
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
    })().catch((error: unknown) => response.destroy(error as Error));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable.');
  const stock =
    api === 'chat' ? deepseekProvider() : api === 'codex' ? openaiCodexProvider() : openaiProvider();
  const models = createModels();
  models.setProvider(stock);
  const expectedApi =
    api === 'chat'
      ? 'openai-completions'
      : api === 'codex'
        ? 'openai-codex-responses'
        : 'openai-responses';
  const model = models.getModels().find((entry) => entry.api === expectedApi);
  if (!model) throw new Error('Stock fixture model unavailable.');
  const provider: ResolvedLLMProviderConfig = {
    id: 'local-profile',
    displayName: 'Local fixture',
    adapterId: stock.id,
    apiKey:
      api === 'codex'
        ? `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`
        : 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [model.id],
    modelMetadata: { [model.id]: { limit: { context: 131_072, output: 8_192 } } },
    requiresApiKey: true,
    gatewayCapabilities: {
      chatCompletions: api === 'chat' ? 'native' : 'bridged',
      responses: api === 'chat' ? 'bridged' : 'native',
    },
  };
  return { client: new PiAiGatewayClient({ models }), model, provider, requests };
}

/** Holds final admission so the test can inspect the absence of an HTTP request. */
function barrier() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

const request = {
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

describe('final serialized text request admission', () => {
  it.each(['responses', 'chat', 'codex'] as const)(
    'awaits the final %s payload and preserves the wire with no count endpoint',
    async (api) => {
      const f = await fixture(api);
      const held = barrier();
      const entered = barrier();
      let captured: FinalRequest | undefined;
      const completion = f.client.createResponses(
        f.provider,
        { ...request, model: f.model.id },
        undefined,
        {
          ...(api === 'codex' ? { codexTurnState: 'retained-native-state' } : {}),
          finalRequestAdmission: async (final) => {
            captured = final;
            admitModelRequest({
              payload: final.payload,
              continuity: final.codexTurnState,
              contextWindowTokens: final.contextWindowTokens,
              outputReserveTokens: final.outputReserveTokens,
            });
            entered.release();
            await held.pending;
          },
        }
      );
      try {
        await Promise.race([
          entered.pending,
          completion.then(() => {
            throw new Error('Serializer skipped final admission.');
          }),
        ]);
        expect(f.requests).toEqual([]);
        expect(captured).toMatchObject({ contextWindowTokens: 131_072, outputReserveTokens: 32 });
      } finally {
        held.release();
      }
      await completion;
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.payload).toEqual(captured!.payload);
      const wire = JSON.stringify(f.requests[0]!.payload);
      expect(wire).toContain('Preserve complete system instructions.');
      expect(wire).toContain('漢字 JSON');
      expect(wire).toContain('Read exact bytes.');
      if (api === 'codex') {
        expect(captured!.codexTurnState).toBe('retained-native-state');
        expect(f.requests[0]!.continuity).toBe('retained-native-state');
      }
      expect(f.requests[0]!.path).toBe(
        api === 'chat'
          ? '/v1/chat/completions'
          : api === 'codex'
            ? '/v1/codex/responses'
            : '/v1/responses'
      );
    }
  );

  it('uses the same final callback for direct Chat and its streaming entry', async () => {
    const f = await fixture('chat');
    const admitted: FinalRequest[] = [];
    const transport = {
      finalRequestAdmission: (final: FinalRequest) => {
        admitted.push(final);
      },
    };
    const input = {
      model: f.model.id,
      messages: [{ role: 'user' as const, content: 'Direct Chat request.' }],
      max_tokens: 32,
    };
    await f.client.createChatCompletion(f.provider, input, undefined, transport);
    await new Response(
      await f.client.createChatCompletionStream(f.provider, input, undefined, transport)
    ).text();
    expect(admitted).toHaveLength(2);
    expect(f.requests.map((entry) => entry.payload)).toEqual(admitted.map((entry) => entry.payload));
    expect(admitted.map((entry) => entry.outputReserveTokens)).toEqual([32, 32]);
  });

  it('refuses the final native overlay before HTTP on the streaming Responses entry', async () => {
    const f = await fixture('responses');
    await expect(
      (async () => {
        const stream = await f.client.createResponsesStream(
          f.provider,
          { ...request, model: f.model.id },
          undefined,
          {
            finalRequestAdmission: (final) =>
              admitModelRequest({
                payload: final.payload,
                contextWindowTokens: 4_096,
                outputReserveTokens: final.outputReserveTokens,
              }),
          }
        );
        await new Response(stream).text();
      })()
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
});
