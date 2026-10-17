import { readFileSync } from 'node:fs';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';
import { ApiCallError, ProtocolValidationError } from './errors.js';

const originals = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/large-context/cases.json', import.meta.url), 'utf8')
).originals as Array<{
  id: string;
  patternHex: string;
  repeats: number;
  size: number;
  sha256: string;
}>;
const original = originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
const bytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
const workspaceId = allocateEntityId('ws');
const artifactId = allocateEntityId('ar');
const metadata = {
  workspaceId,
  requestId: 'raw-import-request',
  title: 'An original + file.bin',
  mediaType: 'application/octet-stream',
  byteLength: original.size,
  contentDigest: original.sha256,
};
const selector = { workspaceId, artifactId, artifactVersion: 3 };

/** Uses fixed producer metadata, independent of the client parser. */
function downloadHeaders(): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(original.size),
    'x-openkit-content-digest': original.sha256,
  };
}

describe('Artifact binary client bindings', () => {
  it.each(
    originals.filter((entry) => ['empty', 'binary-invalid-utf8'].includes(entry.id))
  )('imports the exact $id body with bounded query metadata and a separate request identity', async (entry) => {
    const body = new Blob([Buffer.from(entry.patternHex.repeat(entry.repeats), 'hex')]);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/app/operations/artifact.import');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(body);
      expect(init?.credentials).toBe('include');
      expect(init).toMatchObject({ duplex: 'half' });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer retained-auth');
      expect(headers.get('content-type')).toBe('application/octet-stream');
      expect(headers.get('x-openkit-request-id')).toBe(metadata.requestId);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        workspaceId: metadata.workspaceId,
        title: metadata.title,
        mediaType: metadata.mediaType,
        byteLength: String(entry.size),
        contentDigest: entry.sha256,
      });
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(
        Buffer.from(entry.patternHex.repeat(entry.repeats), 'hex')
      );
      return Response.json({ artifactId, artifactVersion: 1 }, { status: 201 });
    });
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      headers: { authorization: 'Bearer retained-auth' },
      fetch: fetcher,
    });
    await expect(
      client.artifactFiles.import(
        { ...metadata, byteLength: entry.size, contentDigest: entry.sha256 },
        body
      )
    ).resolves.toEqual({ artifactId, artifactVersion: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps download lazy, preserves invalid UTF-8 bytes, and pins the requested version', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(bytes.subarray(0, 2));
          controller.enqueue(bytes.subarray(2));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      headers: { authorization: 'Bearer current-auth' },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/api/app/operations/artifact.download');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          workspaceId,
          artifactId,
          artifactVersion: '3',
        });
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current-auth');
        return new Response(body, { headers: downloadHeaders() });
      },
    });
    const result = await client.artifactFiles.download(selector);
    expect(pulls).toBe(0);
    expect(result).toEqual({
      body,
      byteLength: original.size,
      mediaType: metadata.mediaType,
      contentDigest: original.sha256,
    });
    expect(Buffer.from(await new Response(result.body).arrayBuffer())).toEqual(bytes);
    expect(pulls).toBe(1);
    expect(client.artifactFiles.browserDownloadUrl(selector)).toBe(
      `http://127.0.0.1/api/app/operations/artifact.download?workspaceId=${workspaceId}&artifactId=${artifactId}&artifactVersion=3`
    );
  });

  it.each([
    ['content-length', null],
    ['content-length', '-1'],
    ['content-length', '06'],
    ['content-length', '1.5'],
    ['content-length', '9007199254740992'],
    ['x-openkit-content-digest', null],
    ['x-openkit-content-digest', 'sha256:bad'],
    ['x-openkit-content-digest', original.sha256.toUpperCase()],
    ['content-type', null],
  ])('refuses invalid %s=%s and cancels the unread response body', async (name, value) => {
    const cancel = vi.fn();
    const headers = new Headers(downloadHeaders());
    if (value === null) headers.delete(name!);
    else headers.set(name!, value);
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      fetch: async () =>
        new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers }),
    });
    await expect(client.artifactFiles.download(selector)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses a successful response without a readable original', async () => {
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      fetch: async () => new Response(null, { headers: downloadHeaders() }),
    });
    await expect(client.artifactFiles.download(selector)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });

  it('rejects oversized encoded metadata before upload', () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCoreClient({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    expect(() =>
      client.artifactFiles.import({ ...metadata, title: '界'.repeat(1024) }, bytes)
    ).toThrow(ProtocolValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates the accepted import response instead of inventing a usable version', async () => {
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      fetch: async () => Response.json({ artifactId, artifactVersion: 2 }, { status: 201 }),
    });
    await expect(client.artifactFiles.import(metadata, bytes)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });

  it.each([
    'import',
    'download',
  ] as const)('preserves the %s API refusal without treating it as file content', async (binding) => {
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      fetch: async () =>
        Response.json(
          {
            protocolVersion: '0.5.0',
            code: 'workspace_access_denied',
            message: 'Workspace access denied.',
          },
          { status: 403 }
        ),
    });
    const request =
      binding === 'import'
        ? client.artifactFiles.import(metadata, bytes)
        : client.artifactFiles.download(selector);
    await expect(request).rejects.toBeInstanceOf(ApiCallError);
    await expect(request).rejects.toMatchObject({ status: 403, code: 'workspace_access_denied' });
  });
});
