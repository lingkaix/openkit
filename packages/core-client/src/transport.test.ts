import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiCallError, ProtocolValidationError } from './errors.js';
import { createClientTransport } from './transport.js';

describe('JSON mutation transport', () => {
  it.each([
    ['postJson', 'POST'],
    ['putJson', 'PUT'],
    ['patchJson', 'PATCH'],
  ] as const)('preserves %s wire behavior and failure semantics', async (operation, method) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: 'accepted' }));
    const transport = createClientTransport({
      baseUrl: 'https://core.test/',
      fetch: async (input, init) =>
        new URL(String(input)).pathname === '/api/meta'
          ? Response.json({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              eventFamilies: [],
            })
          : fetcher(input, init),
      headers: { authorization: 'Bearer fixture', 'content-type': 'text/plain', 'x-base': 'base' },
    });
    const schema = z.object({ value: z.string() });
    const input = { value: 'request', ignored: undefined };

    await expect(transport[operation]('/command', input, schema)).resolves.toEqual({
      value: 'accepted',
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://core.test/command');
    expect(init).toMatchObject({ method, credentials: 'include', body: '{"value":"request"}' });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: 'Bearer fixture',
      'content-type': 'application/json',
      'x-base': 'base',
    });

    fetcher.mockResolvedValueOnce(Response.json({ value: 'accepted' }));
    await transport[operation]('/command', undefined, schema, {
      'content-type': 'application/custom+json',
      'x-base': 'override',
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[1]?.[1]?.headers))).toEqual({
      authorization: 'Bearer fixture',
      'content-type': 'application/custom+json',
      'x-base': 'override',
    });

    fetcher.mockResolvedValueOnce(Response.json({ value: 1 }));
    await expect(transport[operation]('/command', input, schema)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
    fetcher.mockResolvedValueOnce(
      Response.json(
        { protocolVersion: '0.6.0', code: 'command_conflict', message: 'Conflict.' },
        { status: 409 }
      )
    );
    await expect(transport[operation]('/command', input, schema)).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 409,
      code: 'command_conflict',
      message: 'Conflict.',
    });
    const networkFailure = new Error('Connection interrupted.');
    fetcher.mockRejectedValueOnce(networkFailure);
    await expect(transport[operation]('/command', input, schema)).rejects.toBe(networkFailure);
  });
});

describe('contract identity admission before effects', () => {
  it.each([
    'postJson',
    'putJson',
    'patchJson',
    'postStream',
    'getStream',
    'deleteEmpty',
    'deleteJson',
  ] as const)('refuses mismatched metadata before %s dispatch', async (operation) => {
    const effects: string[] = [];
    const transport = createClientTransport({
      baseUrl: 'https://core.test',
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/api/meta')
          return Response.json({
            protocolVersion: `${PROTOCOL_VERSION}-different-contract`,
            capabilities: [],
            eventFamilies: [],
          });
        effects.push(`${init?.method} ${path}`);
        if (operation === 'getStream')
          return new Response('fixture', {
            headers: { 'content-type': 'application/octet-stream' },
          });
        if (operation === 'deleteEmpty' || operation === 'deleteJson')
          return new Response(null, { status: 204 });
        return Response.json({ value: 'accepted' });
      },
    });
    const schema = z.object({ value: z.string() });
    const result =
      operation === 'postStream'
        ? transport.postStream('/effect', new Blob(['fixture']), {}, schema)
        : operation === 'getStream'
          ? transport.getStream('/effect', 'application/octet-stream', {})
          : operation === 'deleteEmpty'
            ? transport.deleteEmpty('/effect')
            : operation === 'deleteJson'
              ? transport.deleteJson('/effect', {})
              : transport[operation]('/effect', {}, schema);
    const failure: unknown = await result.then(
      () => null,
      (error: unknown) => error
    );
    expect.soft(effects).toEqual([]);
    expect(failure).toBeInstanceOf(ProtocolValidationError);
    expect(failure).toMatchObject({ code: expect.any(String) });
  });

  it.each([
    'invalid',
    'unavailable',
    'network-failure',
  ] as const)('refuses %s metadata before dispatching JSON work', async (state) => {
    const effects: string[] = [];
    const transport = createClientTransport({
      baseUrl: 'https://core.test',
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/api/meta') {
          if (state === 'network-failure') throw new Error('Metadata unavailable.');
          return state === 'invalid'
            ? Response.json({ protocolVersion: PROTOCOL_VERSION })
            : new Response(null, { status: 503 });
        }
        effects.push(path);
        return Response.json({ value: 'accepted' });
      },
    });
    const result = transport.postJson('/effect', {}, z.object({ value: z.string() }));
    const failure: unknown = await result.then(
      () => null,
      (error: unknown) => error
    );
    expect.soft(effects).toEqual([]);
    expect(failure).toBeInstanceOf(state === 'invalid' ? ProtocolValidationError : Error);
  });

  it('admits current identity with the configured request policy before JSON work', async () => {
    const requests: Array<{ path: string; request: Request }> = [];
    const transport = createClientTransport({
      baseUrl: 'https://core.test',
      headers: { 'x-client-fixture': 'same-release' },
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        requests.push({ path, request: new Request(input, init) });
        return Response.json(
          path === '/api/meta'
            ? { protocolVersion: PROTOCOL_VERSION, capabilities: [], eventFamilies: [] }
            : { value: 'accepted' }
        );
      },
    });
    await expect(
      transport.postJson('/effect', {}, z.object({ value: z.string() }))
    ).resolves.toEqual({ value: 'accepted' });
    const metadata = requests.find(({ path }) => path === '/api/meta');
    expect(metadata?.request).toMatchObject({ method: 'GET', credentials: 'include' });
    expect(metadata?.request.headers.get('x-client-fixture')).toBe('same-release');
    expect(requests.findIndex(({ path }) => path === '/api/meta')).toBeLessThan(
      requests.findIndex(({ path }) => path === '/effect')
    );
    expect(requests.filter(({ path }) => path === '/effect')).toHaveLength(1);
  });
});
