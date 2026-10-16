import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { admitModelRequest, type ModelTokenAdmissionInput, type TokenModelIdentity } from './model-token-admission.js';
import { createResponsesTokenCounter } from './responses-token-counter.js';

const model: TokenModelIdentity = { providerId: 'selected-fixture', modelId: 'gpt-5.2', api: 'responses' };
const servers: Server[] = [];

/** Starts one test-owned HTTP endpoint; no external provider or credential is used. */
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  return `http://127.0.0.1:${address.port}/selected/v1`;
}

/** Reads only bounded fixture requests; production capture is owned by token admission. */
async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error('Fixture request limit.');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Complete request with an explicit independent output reserve. */
function input(baseUrl: string, overrides: Partial<ModelTokenAdmissionInput> = {}): ModelTokenAdmissionInput {
  return { model, request: { model: model.modelId, input: 'hello', max_output_tokens: 32 },
    imageFacts: [], contextWindowTokens: 100, maxOutputTokens: 50, outputReserveTokens: 32,
    counter: createResponsesTokenCounter({ model, baseUrl, apiKey: 'public-fixture-only' }), ...overrides };
}

/** Returns one actual count endpoint response, without inference. */
function counted(response: ServerResponse, tokens = 50): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: tokens }));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});

describe('bounded selected-route Responses token counter', () => {
  it('forwards every represented token field to the exact selected path and resolved credential', async () => {
    let observed: unknown; let method: string | undefined; let path: string | undefined; let credentialMatched = false;
    const base = await endpoint((request, response) => { void (async () => {
      observed = await requestBody(request); method = request.method; path = request.url;
      credentialMatched = request.headers.authorization === 'Bearer public-fixture-only';
      counted(response);
    })(); });
    const tokenFields = { model: model.modelId, instructions: 'Full system instructions',
      input: [{ role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"prior"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'Complete prior tool result' },
        { role: 'user', content: [{ type: 'input_text', text: 'Current request' }] }],
      tools: [{ type: 'function', name: 'lookup', description: 'Full tool definition', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
      tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: false,
      reasoning: { effort: 'medium', summary: 'auto' }, text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } }, verbosity: 'low' },
      personality: 'pragmatic', truncation: 'disabled', conversation: null, previous_response_id: null };
    const result = await admitModelRequest(input(base, { request: { ...tokenFields,
      max_output_tokens: 32, stream: true, stream_options: { include_obfuscation: false }, store: false,
      include: ['reasoning.encrypted_content'], metadata: { label: 'not model context' },
      prompt_cache_key: 'cache-affinity', prompt_cache_retention: 'in_memory',
      temperature: 0.2, top_p: 0.9, top_logprobs: 0, service_tier: 'default',
      background: false, user: 'fixture-user', safety_identifier: 'fixture-safety' } }));
    expect(method).toBe('POST'); expect(path).toBe('/selected/v1/responses/input_tokens');
    expect(credentialMatched).toBe(true); expect(observed).toEqual(tokenFields);
    expect(result).toMatchObject({ kind: 'admitted', inputTokens: 50, totalTokens: 82,
      accountingIdentity: 'responses-input-tokens/openai-sdk-7.19.0/v1' });
  });

  it('binds inline image facts and complete-request total without an invented media subtotal', async () => {
    let observed: unknown;
    const base = await endpoint((request, response) => { void requestBody(request).then((body) => { observed = body; counted(response, 60); }); });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4qUAAAAASUVORK5CYII=', 'base64');
    const request = { model: model.modelId, input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' }] }], max_output_tokens: 32 };
    const result = await admitModelRequest(input(base, { request, imageFacts: [{ path: '/input/0/content/0',
      width: 1, height: 1, frames: 1, detail: 'high', byteLength: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] }));
    expect(observed).toEqual({ model: request.model, input: request.input });
    expect(result).toMatchObject({ kind: 'admitted', inputTokens: 60, totalTokens: 92 });
    if (result.kind === 'admitted') expect(result.imageFactsDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('preserves the independent exact context boundary', async () => {
    const base = await endpoint((_request, response) => counted(response));
    expect(await admitModelRequest(input(base, { contextWindowTokens: 82 }))).toMatchObject({ kind: 'admitted', totalTokens: 82 });
    expect(await admitModelRequest(input(base, { contextWindowTokens: 81 }))).toEqual({ kind: 'refused', reason: 'context-limit-exceeded' });
  });

  it.each(['chat-completions', 'codex-responses'] as const)('refuses %s before provider access', async (api) => {
    let calls = 0; const base = await endpoint((_request, response) => { calls++; counted(response); });
    const selected = { ...model, api };
    const request = api === 'chat-completions' ? { model: model.modelId, messages: [], max_tokens: 32 } : { model: model.modelId, input: [], max_output_tokens: 32 };
    expect(await admitModelRequest(input(base, { model: selected, request, continuity: null }))).toEqual({ kind: 'unavailable', reason: 'api-unqualified' });
    expect(calls).toBe(0);
  });

  it.each([{ continuity: { state: 'opaque' } }, { request: { model: model.modelId, input: '', conversation: 'conversation_1', max_output_tokens: 32 } },
    { request: { model: model.modelId, input: '', previous_response_id: 'response_1', max_output_tokens: 32 } }])('refuses opaque state %j', async (change) => {
    let calls = 0; const base = await endpoint((_request, response) => { calls++; counted(response); });
    expect(await admitModelRequest(input(base, change))).toEqual({ kind: 'unavailable', reason: 'continuity-unqualified' });
    expect(calls).toBe(0);
  });

  it.each(['prompt', 'context_management', 'additional_tools', 'unknown_context_field'])('does not silently omit unknown context semantics: %s', async (field) => {
    let calls = 0; const base = await endpoint((_request, response) => { calls++; counted(response); });
    expect(await admitModelRequest(input(base, { request: { model: model.modelId, input: '', max_output_tokens: 32, [field]: { content: 'must not disappear' } } })))
      .toEqual({ kind: 'unavailable', reason: 'api-unqualified' });
    expect(calls).toBe(0);
  });

  it('refuses auto truncation and a mismatched physical route before access', async () => {
    let calls = 0; const base = await endpoint((_request, response) => { calls++; counted(response); });
    expect(await admitModelRequest(input(base, { request: { model: model.modelId, input: '', max_output_tokens: 32, truncation: 'auto' } })))
      .toEqual({ kind: 'unavailable', reason: 'api-unqualified' });
    expect(await admitModelRequest(input(base, { model: { ...model, providerId: 'another' } })))
      .toEqual({ kind: 'unavailable', reason: 'model-unqualified' });
    expect(calls).toBe(0);
  });

  it.each([
    '{"object":"response.input_tokens","input_tokens":-1}',
    '{"object":"response.input_tokens","input_tokens":1.5}',
    '{"object":"response.input_tokens","input_tokens":9007199254740992}',
    '{"object":"wrong","input_tokens":1}', '{"object":"response.input_tokens"}',
    'null', 'not JSON', '{"object":"response.input_tokens","input_tokens":"10"}',
  ])('refuses a malformed or unsafe reply %s', async (body) => {
    const base = await endpoint((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); });
    expect(await admitModelRequest(input(base))).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
  });

  it('accepts a strict UTF-8 chunked reply and ignores only additive response annotations', async () => {
    const base = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"object":"response.input_');
      response.write('tokens","input_tokens":5');
      response.end('0,"annotation":"descriptive"}');
    });
    expect(await admitModelRequest(input(base))).toMatchObject({ kind: 'admitted', inputTokens: 50 });
  });

  it.each(['length', 'chunked', 'invalid-utf8', 'encoding'] as const)('bounds and cancels %s replies', async (mode) => {
    let closed = false;
    const base = await endpoint((_request, response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200, { 'content-type': 'application/json', ...(mode === 'length' ? { 'content-length': '9000' } : {}), ...(mode === 'encoding' ? { 'content-encoding': 'gzip' } : {}) });
      if (mode === 'invalid-utf8') response.end(Buffer.from([0xff]));
      else if (mode === 'encoding') response.end('not a permitted encoded count');
      else response.write('x'.repeat(8193));
    });
    expect(await admitModelRequest(input(base))).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    await expect.poll(() => closed).toBe(true);
  });

  it('aborts the actual fetch and body on caller cancellation and retains no private diagnostic', async () => {
    let started!: () => void; const observed = new Promise<void>((resolve) => { started = resolve; }); let closed = false;
    const base = await endpoint((_request, response) => { response.on('close', () => { closed = true; }); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); started(); });
    const abort = new AbortController(); const pending = admitModelRequest(input(base, { signal: abort.signal }));
    await observed; abort.abort(new Error('Private caller diagnostic.'));
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'cancelled' });
    await expect.poll(() => closed).toBe(true);
  });

  it.each(['headers', 'body'] as const)('applies one hard deadline to stalled response %s', async (phase) => {
    let calls = 0; let closed = false;
    const base = await endpoint((_request, response) => { calls++; response.on('close', () => { closed = true; });
      if (phase === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
    });
    const began = performance.now();
    expect(await admitModelRequest(input(base))).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    expect(performance.now() - began).toBeGreaterThanOrEqual(9500);
    expect(performance.now() - began).toBeLessThan(14000);
    expect(calls).toBe(1); await expect.poll(() => closed).toBe(true);
  }, 15000);

  it('does not acquire ambient credentials for an explicitly credential-free route', async () => {
    let credentialAbsent = false;
    const base = await endpoint((request, response) => { credentialAbsent = request.headers.authorization === undefined; counted(response); });
    expect(await admitModelRequest(input(base, { counter: createResponsesTokenCounter({ model, baseUrl: base, apiKey: null }) })))
      .toMatchObject({ kind: 'admitted', inputTokens: 50 });
    expect(credentialAbsent).toBe(true);
  });

  it('rejects missing image facts before the counting endpoint can receive media', async () => {
    let calls = 0; const base = await endpoint((_request, response) => { calls++; counted(response); });
    expect(await admitModelRequest(input(base, { request: { model: model.modelId, max_output_tokens: 32,
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }] } })))
      .toEqual({ kind: 'unavailable', reason: 'media-unqualified' });
    expect(calls).toBe(0);
  });

  it('contains upstream HTTP errors without a retry, body disclosure or credential reflection', async () => {
    let calls = 0;
    const base = await endpoint((_request, response) => { calls++; response.writeHead(500, { 'content-type': 'application/json' }); response.end('Private upstream failure body.'); });
    expect(await admitModelRequest(input(base))).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    expect(calls).toBe(1);
  });

  it('never follows redirects, retries, or falls back to an inference endpoint', async () => {
    const paths: string[] = [];
    const base = await endpoint((request, response) => { paths.push(request.url!); response.writeHead(302, { location: '/responses' }); response.end('Private upstream body.'); });
    const result = await admitModelRequest(input(base));
    expect(result).toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    expect(paths).toEqual(['/selected/v1/responses/input_tokens']);
    expect(JSON.stringify(result)).not.toContain('Private');
  });

  it('rejects invalid endpoint configuration without exposing its path or credentials', async () => {
    const options = { model, apiKey: 'public-fixture-only' };
    for (const baseUrl of ['file:///private/counter', 'http://name:fixture@127.0.0.1/v1', 'https://example.test/v1?unknown=1', 'https://example.test/v1#fragment']) {
      expect(await admitModelRequest(input('http://127.0.0.1:1', { counter: createResponsesTokenCounter({ ...options, baseUrl }) })))
        .toEqual({ kind: 'unavailable', reason: 'counter-unavailable' });
    }
  });
});
