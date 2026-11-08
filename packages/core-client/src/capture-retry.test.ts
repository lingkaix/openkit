import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiCallError, createClientTransport } from './index.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const context = 'a'.repeat(64);
/** Models only the server's closed, authorized pre-effect refusal, with no accepted effect. */
function frozen(
  headers: HeadersInit = { 'Retry-After': '1', 'x-openkit-retry-context': context },
  changes: Record<string, unknown> = {}
): Response {
  return Response.json(
    {
      protocolVersion: PROTOCOL_VERSION,
      code: 'workspace_frozen',
      message: 'Workspace is temporarily frozen.',
      details: {
        workspaceId,
        operation: 'capture',
        retryable: true,
        blockers: [
          { kind: 'publication', reason: 'frozen', reference: { workspaceId }, actions: [] },
        ],
      },
      ...changes,
    },
    { status: 409, headers }
  );
}
/** Keeps metadata admission real while selecting the response of each actual command attempt. */
function transport(fetcher: typeof fetch) {
  return createClientTransport({
    baseUrl: 'https://core.test',
    fetch: (input, init) =>
      String(input).endsWith('/api/meta')
        ? Promise.resolve(
            Response.json({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
              eventFamilies: [],
            })
          )
        : fetcher(input, init),
  });
}

beforeEach(() =>
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
);
afterEach(() => vi.useRealTimers());

it('waits for Retry-After then resends one identical serialized request with its original identity', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(frozen())
    .mockResolvedValueOnce(Response.json({ accepted: true }));
  const client = transport(fetcher);
  const input = { expectedRevision: 4 };
  const headers = { 'x-openkit-request-id': '0190f4c8-0000-7000-8000-000000000124' };
  const observed = client
    .postJson('/command', input, z.object({ accepted: z.boolean() }), headers)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
  await vi.advanceTimersByTimeAsync(0);
  input.expectedRevision = 9;
  headers['x-openkit-request-id'] = '0190f4c8-0000-7000-8000-000000000999';
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await observed).toEqual({ value: { accepted: true } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const first = fetcher.mock.calls[0]![1]!;
  const second = fetcher.mock.calls[1]![1]!;
  expect(second.body).toBe(first.body);
  expect(JSON.parse(String(second.body))).toEqual({ expectedRevision: 4 });
  expect(new Headers(second.headers).get('x-openkit-request-id')).toBe(
    '0190f4c8-0000-7000-8000-000000000124'
  );
  expect(new Headers(second.headers).get('x-openkit-retry-context')).toBe(context);
});

it.each([
  ['missing delay', () => frozen({ 'x-openkit-retry-context': context })],
  ['missing context', () => frozen({ 'Retry-After': '1' })],
  ['invalid delay', () => frozen({ 'Retry-After': '0', 'x-openkit-retry-context': context })],
  ['unrelated conflict', () => frozen(undefined, { code: 'revision_conflict' })],
  [
    'nonretryable refusal',
    () =>
      frozen(undefined, {
        details: {
          workspaceId,
          operation: 'capture',
          retryable: false,
          blockers: [{ kind: 'unavailable', reason: 'unavailable', actions: [] }],
        },
      }),
  ],
  ['malformed refusal', () => frozen(undefined, { details: { retryable: true } })],
] as const)('does not retry a %s', async (_label, response) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  await expect(transport(fetcher).postJson('/command', {}, z.unknown())).rejects.toBeInstanceOf(
    ApiCallError
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('ends a held capture retry at twenty seconds with the last definite refusal', async () => {
  const times: number[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    times.push(performance.now());
    return frozen();
  });
  let settled = false;
  const observed = transport(fetcher)
    .postJson('/command', {}, z.unknown())
    .then(
      () => null,
      (error: unknown) => error
    )
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await observed).toMatchObject({ status: 409, code: 'workspace_frozen' });
  expect(times.every((time) => time < 20_000)).toBe(true);
  const settledCalls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(settledCalls);
});

it('cancels a waiting request before another command attempt', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => frozen());
  const abort = new AbortController();
  const observed = transport(fetcher)
    .postJson('/command', {}, z.unknown(), undefined, false, { signal: abort.signal })
    .then(
      () => null,
      (error: unknown) => error
    );
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('cancels a waiting command when this client starts changing authentication', async () => {
  const commands = vi.fn<typeof fetch>().mockImplementation(async () => frozen());
  const client = transport((input, init) =>
    String(input).endsWith('/api/auth/sign-out')
      ? Promise.resolve(Response.json({ success: true }))
      : commands(input, init)
  );
  const observed = client.postJson('/command', {}, z.unknown()).then(
    () => null,
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(0);
  await client.postJson('/api/auth/sign-out', {}, z.object({ success: z.boolean() }));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(commands).toHaveBeenCalledTimes(1);
});

it('keeps a lost retry response unknown and does not resend a reached attempt', async () => {
  const unknown = new Error('Response lost after contact.');
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(frozen())
    .mockRejectedValueOnce(unknown);
  const observed = transport(fetcher)
    .postJson('/command', {}, z.unknown())
    .then(
      () => null,
      (error: unknown) => error
    );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await observed).toBe(unknown);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops when the refusal belongs to a changed authentication context', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(frozen())
    .mockResolvedValueOnce(
      frozen({ 'Retry-After': '1', 'x-openkit-retry-context': 'b'.repeat(64) })
    );
  const result = transport(fetcher).postJson('/command', {}, z.object({ accepted: z.boolean() }));
  const rejected = expect(result).rejects.toMatchObject({ code: 'workspace_frozen', status: 409 });
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('never replays a raw request stream after a capture refusal', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(frozen());
  await expect(
    transport(fetcher).postStream(
      '/stream',
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      {},
      z.object({ accepted: z.boolean() })
    )
  ).rejects.toMatchObject({ code: 'workspace_frozen', status: 409 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
