import { OPERATION_DEFINITIONS, operationHttpPath } from '@openkit/app-api-schemas';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { createCoreClient } from './client.js';
import { ProtocolValidationError } from './errors.js';

describe('definition-derived client operations', () => {
  it('uses exactly the JSON definition keys and validates before transport', async () => {
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
        .filter(([, definition]) => definition.binding === 'json')
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
      ([, definition]) => definition.binding === 'streaming'
    ))
      expect(client.operations).not.toHaveProperty(id);
    expect(client.app).toHaveProperty('downloadWorkspaceExportArchive');
    expect(client.app).toHaveProperty('dryRunWorkspaceArchiveImport');
    expect(client.app).toHaveProperty('importWorkspaceArchive');
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
      collectionId: '22222222-2222-4222-a222-222222222222',
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
      workspaceId: 'ws_demo',
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
    expect(await client.operations['automation.delete']({ automationId: 'auto_one' })).toBeNull();
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer test-token');
    expect(await requests[0]!.json()).toEqual({ automationId: 'auto_one' });
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
      failed.operations['automation.delete']({ automationId: 'auto_one' })
    ).rejects.toMatchObject({ status: 400, code: 'automation_delete_failed' });
    const invalid = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json({ deleted: true }),
    });
    await expect(
      invalid.operations['automation.delete']({ automationId: 'auto_one' })
    ).rejects.toThrow();
  });
  it.each([200, 202])('rejects HTTP %s JSON null for a declared empty success', async (status) => {
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => Response.json(null, { status }),
    });
    await expect(
      client.operations['automation.delete']({ automationId: 'auto_one' })
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
      client.operations['automation.delete']({ automationId: 'auto_one' })
    ).rejects.toBeInstanceOf(ProtocolValidationError);
  });
});
