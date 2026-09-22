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
      fetch: fetcher,
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
        { protocolVersion: '0.5.0', code: 'command_conflict', message: 'Conflict.' },
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
