import { OPERATION_DEFINITIONS, operationHttpPath } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION as CURRENT_PROTOCOL, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient as createClient } from './client.js';
import { ProtocolValidationError } from './errors.js';

describe('definition-derived client operations', () => {
  it('uses composed JSON keys plus the backup stream and validates before transport', async () => {
    let calls = 0;
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => {
        calls += 1;
        return new Response('{}');
      },
    });
    expect(Object.keys(client.operations)).toEqual(
      Object.entries(OPERATION_DEFINITIONS)
        .filter(
          ([id, definition]) => definition.binding === 'json' || id === 'workspace.backup-download'
        )
        .map(([id]) => id)
    );
    for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS).filter(
      ([, definition]) => definition.binding === 'json'
    )) {
      if (!definition.inputSchema.safeParse({}).success)
        await expect(
          client.operations[id as keyof typeof client.operations]({} as never)
        ).rejects.toThrow();
    }
    expect(calls).toBe(0);
    for (const [id] of Object.entries(OPERATION_DEFINITIONS).filter(
      ([id, definition]) => definition.binding === 'streaming' && id !== 'workspace.backup-download'
    ))
      expect(client.operations).not.toHaveProperty(id);
    expect(client.app).toHaveProperty('downloadWorkspaceExportArchive');
    expect(client.app).not.toHaveProperty('getDiagnostics');
    expect(client.app).not.toHaveProperty('getSetupDiagnostics');
    expect(client.app).not.toHaveProperty('getLightApp');
    expect(client.app).not.toHaveProperty('exportWorkspace');
    expect(client.app).not.toHaveProperty('dryRunWorkspaceImport');
    expect(client.app).not.toHaveProperty('importWorkspace');
    expect(client.app).not.toHaveProperty('createLightAppRecord');
  });

  it('derives POST placement, keeps request identity in its header, and validates returned output', async () => {
    const requests: Request[] = [];
    const result = {
      id: '11111111-1111-4111-a111-111111111111',
      collectionId: 'col_00000000-0000-70c5-bf32-acc687f8947c',
      collectionName: 'entries',
      revision: 1,
      schemaRevision: 1,
      created: '2026-10-02T00:00:00.000Z',
      updated: '2026-10-02T00:00:00.000Z',
      data: { note: 'wire' },
    };
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(result);
      },
    });
    const input = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      appId: '33333333-3333-4333-a333-333333333333',
      collection: 'entries',
      schemaRevision: 1,
      data: { note: 'wire' },
    };
    expect(await client.operations['kernel.records.create'](input)).toEqual(result);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(operationHttpPath('kernel.records.create'));
    expect(request.headers.get('x-openkit-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await request.json()).toEqual(input);
    const invalid = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json({ ...result, revision: -1 }),
    });
    await expect(invalid.operations['kernel.records.create'](input)).rejects.toThrow();
  });
  it('maps declared empty success to logical null while preserving API failures and JSON validation', async () => {
    const requests: Request[] = [];
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      headers: { authorization: 'Bearer test-token' },
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return new Response(null, { status: 204 });
      },
    });
    expect(
      await client.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
      })
    ).toBeNull();
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer test-token');
    expect(await requests[0]!.json()).toEqual({
      automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
    });
    await expect(client.operations['automation.list']({})).rejects.toThrow();
    const failed = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () =>
        Response.json(
          {
            protocolVersion: PROTOCOL_VERSION,
            code: 'automation_delete_failed',
            message: 'Automation unavailable.',
          },
          { status: 400 }
        ),
    });
    await expect(
      failed.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
      })
    ).rejects.toMatchObject({ status: 400, code: 'automation_delete_failed' });
    const invalid = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json({ deleted: true }),
    });
    await expect(
      invalid.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
      })
    ).rejects.toThrow();
  });
  it.each([200, 202])('rejects HTTP %s JSON null for a declared empty success', async (status) => {
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json(null, { status }),
    });
    await expect(
      client.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
      })
    ).rejects.toBeInstanceOf(ProtocolValidationError);
  });
  it('rejects exposed response bytes on a declared HTTP 204 success', async () => {
    const response = new Response('unexpected bytes');
    Object.defineProperty(response, 'status', { value: 204 });
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => response,
    });
    await expect(
      client.operations['automation.delete']({
        automationId: 'auto_00000000-0000-7ff8-926b-e5836fad4671',
      })
    ).rejects.toBeInstanceOf(ProtocolValidationError);
  });
});

/** Supplies current metadata without consuming the command fixture's response sequence. */
function createCoreClient(options: Parameters<typeof createClient>[0]) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return createClient({
    ...options,
    fetch: (input, init) =>
      new URL(String(input)).pathname === '/api/meta'
        ? Promise.resolve(
            Response.json({
              protocolVersion: CURRENT_PROTOCOL,
              capabilities: [],
              eventFamilies: [],
            })
          )
        : fetcher(input, init),
  });
}

describe('conversation navigation client', () => {
  it('reads the selected Workspace projection and rejects malformed rows', async () => {
    const fetch = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(
      client.operations['conversation.navigation']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        limit: 10,
        cursor: 'cursor_1',
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/conversation.navigation',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          limit: 10,
          cursor: 'cursor_1',
        }),
      })
    );
    fetch.mockResolvedValueOnce(Response.json({ items: [{ activity: 'chat' }] }));
    await expect(
      client.operations['conversation.navigation']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).rejects.toThrow();
  });
});

describe('Workspace Worker client', () => {
  it('reads the selected Workspace and rejects malformed Worker records', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001', items: [] })
    );
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(
      client.operations['worker.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      items: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/worker.list',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
      })
    );
    const callsBeforeInvalidScope = fetch.mock.calls.length;
    await expect(client.operations['worker.list']({ workspaceId: 'ws /demo' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(callsBeforeInvalidScope);
    fetch.mockResolvedValueOnce(
      Response.json({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        items: [{ threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7' }],
      })
    );
    await expect(
      client.operations['worker.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).rejects.toThrow();
  });
});

describe('administration catalog application client', () => {
  it('sends exact human confirmation and validates the persistence/reload response', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const candidate = {
      artifactId: 'ar_01890f3e-0000-7000-8000-000000000071',
      artifactVersion: 1 as const,
      contentDigest: digest,
    };
    const input = {
      requestId: '11111111-1111-4111-8111-111111111111',
      candidate,
      confirmation: {
        action: 'administration.configuration.apply' as const,
        contentDigest: digest,
      },
    };
    const result = {
      candidate,
      persisted: true,
      revision: 'revision',
      reload: 'failed',
      restartRequired: true,
    };
    const fetch = vi.fn(async () => Response.json(result));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    expect(await client.operations['administration.configuration-apply'](input)).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/administration.configuration-apply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ candidate: input.candidate, confirmation: input.confirmation }),
      })
    );
    await expect(
      client.operations['administration.configuration-apply']({
        ...input,
        confirmation: { ...input.confirmation, contentDigest: `sha256:${'b'.repeat(64)}` },
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded timeline client', () => {
  it('uses the shared read operation and preserves its logical anchor without a mutation identity', async () => {
    const selector = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    const projection = {
      ...selector,
      view: 'runs',
      runs: [],
      items: [],
      itemWindow: null,
      beforeCursor: null,
      afterCursor: null,
      anchor: null,
      catchUpAnchor: null,
      restrictedReferences: false,
    };
    const requests: Request[] = [];
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json(projection);
      },
    });
    const input = { ...selector, anchor: { kind: 'catch-up' as const } };
    expect(await client.operations['thread.timeline'](input)).toEqual(projection);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(operationHttpPath('thread.timeline'));
    expect(requests[0]!.headers.get('x-openkit-request-id')).toBeNull();
    expect(await requests[0]!.json()).toEqual(input);
    const invalid = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json({ ...projection, runs: [{ id: 'unqualified-run' }] }),
    });
    await expect(invalid.operations['thread.timeline'](selector)).rejects.toBeInstanceOf(
      ProtocolValidationError
    );
  });
});
