import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';
import { ApiCallError, ProtocolValidationError } from './errors.js';

const selection = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  backupId: 'wsbak_00000000-0000-7000-8000-000000000002',
};
const mediaType = 'application/octet-stream';

describe('W operational backup download client boundary', () => {
  it('projects only this binary operation, POSTs the logical selector and returns before body bytes exist', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const response = new Response(body, {
      headers: {
        'content-type': mediaType,
        'content-disposition': 'attachment; filename="retained.openkit-workspace.tar.zst"',
      },
    });
    const wholeBody = ['arrayBuffer', 'blob', 'json', 'text'] as const;
    const consumed = wholeBody.map((method) =>
      vi.spyOn(response, method).mockImplementation(() => {
        throw new Error('Operational download must not consume or decode the entire response.');
      })
    );
    const requests: Request[] = [];
    const client = createCoreClient({
      baseUrl: 'https://nanocore.invalid/',
      headers: { 'x-fixture-header': 'configured-wire-value' },
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return response;
      },
    });
    for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS)) {
      if (id !== 'workspace.backup-download' && definition.binding === 'streaming')
        expect(id in client.operations).toBe(false);
    }
    expect(client.operations['workspace.backup-download']).toBeTypeOf('function');
    // No bytes have been enqueued and no Content-Length is provided. Headers suffice.
    const stream = await client.operations['workspace.backup-download'](selection);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(
      'https://nanocore.invalid/api/app/operations/workspace.backup-download'
    );
    expect(request.method).toBe('POST');
    expect(request.credentials).toBe('include');
    expect(request.headers.get('x-fixture-header')).toBe('configured-wire-value');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.has('x-openkit-request-id')).toBe(false);
    expect(await request.json()).toEqual(selection);
    expect(stream).toBeInstanceOf(ReadableStream);
    for (const consume of consumed) expect(consume).not.toHaveBeenCalled();
    // These opaque bytes exercise Zstandard magic, NUL and non-UTF8 byte transport;
    // archive decoding/metadata validation belong to the existing operational verifier.
    const prefix = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]);
    const suffix = Uint8Array.from([0x80, 0x00, 0x0a, 0x01]);
    const reader = stream.getReader();
    controller.enqueue(prefix);
    expect(await reader.read()).toEqual({ done: false, value: prefix });
    controller.enqueue(suffix);
    expect(await reader.read()).toEqual({ done: false, value: suffix });
    controller.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    for (const consume of consumed) expect(consume).not.toHaveBeenCalled();
  });

  it('rejects malformed logical selectors and every supplied server path before fetch', async () => {
    const fetch = vi.fn(async () => new Response(null, { headers: { 'content-type': mediaType } }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.invalid', fetch });
    for (const invalid of [
      {},
      { ...selection, workspaceId: '../another-workspace' },
      { ...selection, backupId: '../another-backup' },
      { ...selection, bundleRoot: '/server/private/backup' },
      { ...selection, source: { kind: 'path', path: '/server/private/backup' } },
    ])
      await expect(
        client.operations['workspace.backup-download'](invalid as never)
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the typed HTTP refusal and server-owned details instead of treating it as archive bytes', async () => {
    const failure = {
      protocolVersion: PROTOCOL_VERSION,
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
      details: { workspaceId: selection.workspaceId },
      path: ['backupId'],
      requestId: '00000000-0000-4000-8000-000000000099',
    };
    const fetch = vi.fn(async () => Response.json(failure, { status: 403 }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.invalid', fetch });
    const error = await client.operations['workspace.backup-download'](selection).catch(
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error).toMatchObject({
      status: 403,
      code: failure.code,
      message: failure.message,
      details: failure.details,
      path: failure.path,
      requestId: failure.requestId,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'wrong-media-type',
    'wrong-media-type-cancel-failure',
    'missing-body',
  ] as const)('refuses a successful %s response and releases any rejected body', async (fault) => {
    const cancel = vi.fn(async () => {
      if (fault === 'wrong-media-type-cancel-failure')
        throw new Error('Injected rejected response-body cancellation.');
    });
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]));
        },
        pull,
        cancel,
      },
      { highWaterMark: 0 }
    );
    const response =
      fault === 'missing-body'
        ? new Response(null, { headers: { 'content-type': mediaType } })
        : new Response(body, {
            headers: { 'content-type': 'application/vnd.openkit.workspace-export+tar.zstd' },
          });
    const reader = vi.spyOn(body, 'getReader');
    const client = createCoreClient({
      baseUrl: 'https://nanocore.invalid',
      fetch: async () => response,
    });
    await expect(client.operations['workspace.backup-download'](selection)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
    expect(reader).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    if (fault === 'missing-body') expect(cancel).not.toHaveBeenCalled();
    else expect(cancel).toHaveBeenCalledOnce();
  });
});
