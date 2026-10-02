import { KERNEL_OPERATION_DEFINITIONS, operationHttpPath } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createCoreClient } from './client.js';

describe('definition-derived client operations', () => {
  it('uses exactly the definition keys and validates before transport', async () => {
    let calls = 0;
    const client = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: async () => {
        calls += 1;
        return new Response('{}');
      },
    });
    expect(Object.keys(client.operations)).toEqual(Object.keys(KERNEL_OPERATION_DEFINITIONS));
    for (const method of Object.values(client.operations))
      await expect(method({} as never)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(client.app).not.toHaveProperty('getLightApp');
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
});
