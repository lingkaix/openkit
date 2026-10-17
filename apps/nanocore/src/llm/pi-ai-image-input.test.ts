import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, expect, it, vi } from 'vitest';
import { admitModelRequest } from '../context/model-request-admission.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { ReasoningAttribution } from './reasoning-attribution.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const jpeg =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==';
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

/** Uses the pinned stock Codex serializer with a test-owned HTTP endpoint and synthetic auth. */
async function fixture(imageInput = true, contextWindowTokens = 131_072) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      const decoded =
        request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(encoded) : encoded;
      bodies.push(JSON.parse(decoded.toString('utf8')));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_image',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      })}\n\n`);
    })().catch((error: unknown) => response.destroy(error as Error));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable.');
  const models = createModels();
  const stock = openaiCodexProvider();
  models.setProvider(stock);
  const model = models.getModels().find((entry) => entry.api === 'openai-codex-responses');
  if (!model) throw new Error('Stock Codex fixture model unavailable.');
  const provider: ResolvedLLMProviderConfig = {
    id: 'image-fixture',
    displayName: 'Image fixture',
    adapterId: stock.id,
    apiKey: `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [model.id],
    modelMetadata: {
      [model.id]: {
        modalities: { input: imageInput ? ['text', 'image'] : ['text'] },
        limit: { context: contextWindowTokens, output: 8_192 },
      },
    },
    requiresApiKey: true,
    gatewayCapabilities: { responses: 'native', chatCompletions: 'bridged' },
  };
  const attribution = new ReasoningAttribution();
  attribution.record('rs_image', { providerId: provider.id, modelId: model.id });
  return {
    client: new PiAiGatewayClient({ models, reasoningAttribution: attribution }),
    provider,
    model,
    bodies,
  };
}

/** Carries inline user PNG and native function-result JPEG with retained text and reasoning history. */
function request(model: string) {
  return {
    model,
    instructions: 'Keep the selected source identity.',
    max_output_tokens: 32,
    tools: [
      {
        type: 'function',
        name: 'work_view_source',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read this PNG.' },
          { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' },
        ],
      },
      {
        type: 'reasoning',
        id: 'rs_image',
        summary: [{ type: 'summary_text', text: 'Preserve earlier reasoning.' }],
        encrypted_content: 'synthetic-opaque-reasoning',
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Read the bounded source view.' }],
      },
      {
        type: 'function_call',
        id: 'fc_view',
        call_id: 'call_view',
        name: 'work_view_source',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_view',
        output: [
          { type: 'input_text', text: 'Exact source and crop facts.' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg}`, detail: 'high' },
          { type: 'input_text', text: 'Keep the complete trailing facts.' },
        ],
      },
    ],
  };
}

it('preserves native PNG/JPEG bytes and history through stock HTTP and final request admission', async () => {
  const f = await fixture();
  const input = request(f.model.id);
  const before = structuredClone(input);
  const admitted: unknown[] = [];
  const response = await f.client.createResponses(f.provider, input, undefined, {
    finalRequestAdmission: (final) => {
      admitted.push(final.payload);
      admitModelRequest({
        payload: final.payload,
        contextWindowTokens: final.contextWindowTokens,
        outputReserveTokens: final.outputReserveTokens,
      });
    },
  });

  expect(response.status).toBe('completed');
  expect(f.bodies).toHaveLength(1);
  expect(f.bodies[0]!.input).toEqual(input.input);
  expect(f.bodies[0]!.instructions).toBe(input.instructions);
  expect(admitted).toEqual(f.bodies);
  expect(input).toEqual(before);
});

it('refuses the same images on a text-only selected model before HTTP or final handoff', async () => {
  const f = await fixture(false);
  const admission = vi.fn();
  await expect(
    f.client.createResponses(f.provider, request(f.model.id), undefined, {
      finalRequestAdmission: admission,
    })
  ).rejects.toMatchObject({
    code: 'unsupported_gateway_feature',
    feature: 'pi-ai Responses model image input',
  });
  expect(f.bodies).toEqual([]);
  expect(admission).not.toHaveBeenCalled();
});

it('refuses the approximate image allowance at the actual final callback before any stock HTTP effect', async () => {
  // The two image allowances, fixed margin and actual reserve already exceed this physical capacity, before text metadata.
  const capacity = 2 * 8_192 + 4_096 + 32 - 1;
  const f = await fixture(true, capacity);
  const input = request(f.model.id);
  const before = structuredClone(input);
  let admissionFailure: unknown;
  const admission = vi.fn((final: Parameters<typeof admitModelRequest>[0] & { codexTurnState?: string | undefined }) => {
    expect(final.contextWindowTokens).toBe(capacity);
    expect(final.outputReserveTokens).toBe(32);
    expect(final.payload).toMatchObject({ input: input.input, instructions: input.instructions });
    try {
      admitModelRequest({ ...final, continuity: final.codexTurnState });
    } catch (error) {
      admissionFailure = error;
      throw error;
    }
  });
  await expect(f.client.createResponses(f.provider, input, undefined, {
    finalRequestAdmission: admission,
  })).rejects.toThrow();
  expect(admission).toHaveBeenCalledOnce();
  expect(admissionFailure).toMatchObject({ code: 'internal_agent_context_exceeded' });
  expect(f.bodies).toEqual([]);
  expect(input).toEqual(before);
});
