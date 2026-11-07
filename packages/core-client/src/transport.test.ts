import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiCallError,
  CapabilityRequiredError,
  createClientTransport,
  createCoreClient,
  createRequestId,
  ProtocolValidationError,
  parseJsonResponse,
  parseWorkspaceSharingError,
  withRequestId,
} from './index.js';

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

  it('preserves today incomplete bootstrap refusal and leaves other JSON messages unstated', async () => {
    const fetcher = vi.fn<typeof fetch>();
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
    });
    const schema = z.object({ value: z.string() });
    fetcher.mockResolvedValueOnce(
      Response.json(
        { code: 'FORBIDDEN', message: 'Server bootstrap is incomplete.' },
        { status: 403 }
      )
    );
    await expect(transport.postJson('/api/auth/sign-up/email', {}, schema)).rejects.toMatchObject({
      message: 'Server bootstrap is incomplete.',
      status: 403,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ message: 'Sign up is disabled.' }, { status: 403 })
    );
    await expect(transport.postJson('/api/auth/sign-up/email', {}, schema)).rejects.toMatchObject({
      message: 'HTTP 403',
      status: 403,
    });
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

  it('dispatches deleteEmpty with configured headers after contract admission and maps non-2xx errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            protocolVersion: PROTOCOL_VERSION,
            code: 'resource_not_found',
            message: 'Resource not found.',
            path: ['resourceId'],
            requestId: 'req-delete-empty',
          },
          { status: 404 }
        )
      );
    const transport = createClientTransport({
      baseUrl: 'https://core.test/',
      headers: { 'x-base': 'base-value' },
      fetch: async (input, init) =>
        new URL(String(input)).pathname === '/api/meta'
          ? Response.json({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              eventFamilies: [],
            })
          : fetcher(input, init),
    });

    await expect(transport.deleteEmpty('/resource/1')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://core.test/resource/1');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      credentials: 'include',
    });
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[0]?.[1]?.headers))).toEqual({
      'x-base': 'base-value',
    });

    await expect(transport.deleteEmpty('/resource/1')).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 404,
      code: 'resource_not_found',
      message: 'Resource not found.',
      path: ['resourceId'],
      requestId: 'req-delete-empty',
    });
  });

  it('dispatches deleteJson with JSON body after contract admission and maps non-2xx errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            protocolVersion: PROTOCOL_VERSION,
            code: 'revision_conflict',
            message: 'Revision changed.',
          },
          { status: 409 }
        )
      );
    const transport = createClientTransport({
      baseUrl: 'https://core.test/',
      headers: { 'x-base': 'base-value' },
      fetch: async (input, init) =>
        new URL(String(input)).pathname === '/api/meta'
          ? Response.json({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              eventFamilies: [],
            })
          : fetcher(input, init),
    });

    await expect(
      transport.deleteJson('/resource/1', { expectedRevision: 'rev-1' })
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://core.test/resource/1');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      credentials: 'include',
      body: '{"expectedRevision":"rev-1"}',
    });
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[0]?.[1]?.headers))).toEqual({
      'content-type': 'application/json',
      'x-base': 'base-value',
    });

    await expect(
      transport.deleteJson('/resource/1', { expectedRevision: 'rev-1' })
    ).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 409,
      code: 'revision_conflict',
      message: 'Revision changed.',
    });
  });

  it('throws when createClientTransport is called without a fetch implementation', () => {
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(() => createClientTransport({ baseUrl: 'https://core.test' })).toThrow(
        'fetch is required to create the core client'
      );
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        value: originalFetch,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('HTTP error parsing, request identity, capability guard, and sharing error helpers', () => {
  it('trims plain-text HTTP error bodies and falls back to the status line for blank or non-protocol bodies', async () => {
    const schema = z.object({ ok: z.boolean() });

    await expect(
      parseJsonResponse(
        new Response('  Bad gateway from upstream proxy  \n', { status: 502 }),
        schema
      )
    ).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 502,
      code: null,
      message: 'Bad gateway from upstream proxy',
    });

    await expect(
      parseJsonResponse(new Response('   \n', { status: 502 }), schema)
    ).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 502,
      code: null,
      message: 'HTTP 502',
    });

    await expect(
      parseJsonResponse(Response.json({ message: 404 }, { status: 500 }), schema)
    ).rejects.toMatchObject({
      name: ApiCallError.name,
      status: 500,
      code: null,
      message: 'HTTP 500',
    });
  });

  it('normalizes symbol issue paths and preserves validation cause in ProtocolValidationError', () => {
    const cause = new Error('underlying zod error');
    const error = new ProtocolValidationError(
      {
        path: [Symbol('fieldTag'), 'nested', 0] as unknown as ReadonlyArray<string | number>,
        code: 'invalid_type',
        message: 'Invalid field.',
      },
      { cause }
    );

    expect(error.name).toBe('ProtocolValidationError');
    expect(error.path).toEqual(['Symbol(fieldTag)', 'nested', 0]);
    expect(error.code).toBe('invalid_type');
    expect(error.message).toBe('Invalid field.');
    expect(error.cause).toBe(cause);
  });

  it('preserves caller requestId in withRequestId and falls back when crypto.randomUUID is unavailable', () => {
    const original = { name: 'demo', requestId: 'caller-supplied-id' };
    expect(withRequestId(original)).toEqual({ name: 'demo', requestId: 'caller-supplied-id' });

    const withoutId: { name: string; requestId?: string } = { name: 'demo' };
    const populated = withRequestId(withoutId);
    expect(withoutId.requestId).toBeUndefined();
    expect(populated.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        configurable: true,
      });
      expect(createRequestId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it('returns null from parseWorkspaceSharingError for non-API or codeless errors and preserves path without requestId', () => {
    expect(parseWorkspaceSharingError(new Error('network error'))).toBeNull();
    expect(parseWorkspaceSharingError(new ApiCallError(409, 'Conflict without code'))).toBeNull();

    const denied = new ApiCallError(403, 'Workspace access denied.', {
      code: 'workspace_access_denied',
      path: ['workspaceId'],
    });
    expect(parseWorkspaceSharingError(denied)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      path: ['workspaceId'],
    });
  });

  it('throws CapabilityRequiredError with the missing flag when require is called before refresh', () => {
    const client = createCoreClient({
      baseUrl: 'https://core.test',
      fetch: async () =>
        Response.json({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['core.questions'],
          eventFamilies: [],
        }),
    });

    expect(client.capabilities.snapshot()).toBeNull();
    let caught: unknown;
    try {
      client.capabilities.require('core.questions');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityRequiredError);
    expect(caught).toMatchObject({
      name: 'CapabilityRequiredError',
      capability: 'core.questions',
      message: 'Capability is not supported by the active NanoCore server: core.questions',
    });
  });
});
