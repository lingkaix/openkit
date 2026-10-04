import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { computeBootReadinessSnapshot } from './bootstrap/readiness.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const appId = '00000000-0000-4000-a000-000000000001';
const recordId = '00000000-0000-4000-a000-000000000002';
const presentationId = '00000000-0000-4000-a000-000000000003';
const schema = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Migration proof',
  purpose: 'Proof',
  collections: [
    {
      name: 'entries',
      type: 'base',
      description: 'Entries',
      fields: [{ name: 'note', type: 'text', required: true, description: 'Note' }],
      indexes: [],
    },
  ],
};
const event = {
  version: 'v0.9',
  action: {
    name: 'refresh',
    surfaceId: 'surface',
    sourceComponentId: 'button',
    timestamp: '2026-10-03T00:00:00.000Z',
  },
};
const publish = {
  threadId: 'th_demo',
  turnId: 'missing-turn',
  title: 'Proof',
  fallbackText: 'Proof',
  messages: [{}, {}],
  source: { kind: 'item', itemId: 'missing-item', contentDigest: `sha256:${'0'.repeat(64)}` },
  actions: [],
};
const base = '/api/app/workspaces/ws_demo';
const cases = [
  ['kernel.apps.list', 'GET', '/light-apps', {}, {}, 200],
  ['kernel.apps.create', 'POST', '/light-apps', schema, {}, 201],
  [
    'kernel.schema.update',
    'PUT',
    `/light-apps/${appId}/schema`,
    { expectedAppRevision: 1, expectedSchemaRevision: 1, schema },
    { appId },
    503,
  ],
  [
    'kernel.apps.retire',
    'POST',
    `/light-apps/${appId}/retire`,
    { expectedAppRevision: 1 },
    { appId },
    503,
  ],
  [
    'kernel.records.list',
    'GET',
    `/light-apps/${appId}/collections/entries/records?schemaRevision=1`,
    { schemaRevision: 1 },
    { appId, collection: 'entries' },
    503,
  ],
  [
    'kernel.records.get',
    'GET',
    `/light-apps/${appId}/collections/entries/records/${recordId}?schemaRevision=1`,
    { schemaRevision: 1 },
    { appId, collection: 'entries', recordId },
    503,
  ],
  [
    'kernel.records.update',
    'PATCH',
    `/light-apps/${appId}/collections/entries/records/${recordId}`,
    { schemaRevision: 1, expectedRecordRevision: 1, data: { note: 'Proof' } },
    { appId, collection: 'entries', recordId },
    503,
  ],
  [
    'kernel.records.batch',
    'POST',
    `/light-apps/${appId}/batch`,
    {
      schemaRevision: 1,
      requests: [
        {
          method: 'POST',
          url: '/api/collections/entries/records',
          body: { data: { note: 'Proof' } },
        },
      ],
    },
    { appId },
    503,
  ],
  ['generative-ui.publish', 'POST', '/generative-presentations', publish, {}, 404],
  [
    'generative-ui.get',
    'GET',
    `/generative-presentations/${presentationId}`,
    {},
    { presentationId },
    404,
  ],
  [
    'generative-ui.resource',
    'GET',
    `/generative-presentations/${presentationId}/resource`,
    {},
    { presentationId },
    404,
  ],
  [
    'generative-ui.refresh',
    'POST',
    `/generative-presentations/${presentationId}/refresh`,
    event,
    { presentationId },
    404,
  ],
  [
    'generative-ui.action',
    'POST',
    `/generative-presentations/${presentationId}/actions`,
    event,
    { presentationId },
    404,
  ],
] as const;

/** Explicit local membership and retained Workspace authority, without a permissive request helper. */
function fixture(getBootReadiness?: () => BootReadinessSnapshot) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-cutover-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const store = createDemoStore({ dataRoot });
  return {
    coreDb,
    store,
    app: createApp({ coreDb, dataRoot, store, ...(getBootReadiness ? { getBootReadiness } : {}) }),
  };
}

describe('Generative operation cutover', () => {
  it.each(
    cases
  )('retires the authorized former binding for %s', async (_id, method, path, body) => {
    const f = fixture();
    try {
      const response = await f.app.request(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('404 Not Found');
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it.each(
    cases
  )('reaches the same native outcome through %s', async (id, _method, _path, body, selectors, status) => {
    const f = fixture();
    try {
      const response = await f.app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({ ...body, ...selectors, workspaceId: 'ws_demo' }),
      });
      expect(response.status).toBe(status);
      const result = await response.json();
      if (status >= 400)
        expect(result).toMatchObject({
          code: status === 503 ? 'unavailable' : 'not_found',
          protocolVersion: expect.any(String),
        });
      else if (id === 'kernel.apps.list')
        expect(result).toMatchObject({ totalItems: 0, items: [] });
      else expect(result).toMatchObject({ title: schema.title, lifecycle: 'active' });
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

it('keeps native revisions, replay and atomic batch outcomes through the typed client and derived CLI', async () => {
  const f = fixture();
  const { createCoreClient } = await import('../../../packages/core-client/src/index.js');
  const { operationCatalog } = await import(
    new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
  );
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: (input, init) => f.app.fetch(new Request(input, init)),
  });
  const cli = async (id: string, input: unknown) => {
    const row = operationCatalog.find((entry: { id: string }) => entry.id === id);
    expect(row).toBeDefined();
    return row.handler({ client }, row.inputSchema.parse(input));
  };
  try {
    const input = { ...schema, workspaceId: 'ws_demo', requestId: randomUUID() };
    const created = await client.operations['kernel.apps.create'](input as never);
    expect(await cli('kernel.apps.create', input)).toEqual(created);
    const scope = { workspaceId: 'ws_demo', appId: created.appId };
    const record = await client.operations['kernel.records.create']({
      ...scope,
      collection: 'entries',
      schemaRevision: 1,
      data: { note: 'Original' },
    });
    const selectors = { ...scope, collection: 'entries', recordId: record.id };
    const update = {
      ...selectors,
      requestId: randomUUID(),
      schemaRevision: 1,
      expectedRecordRevision: 1,
      data: { note: 'Updated' },
    };
    const updated = await client.operations['kernel.records.update'](update);
    expect(updated).toMatchObject({ revision: 2, data: { note: 'Updated' } });
    expect(await cli('kernel.records.update', update)).toEqual(updated);
    await expect(
      client.operations['kernel.records.update']({
        ...update,
        requestId: randomUUID(),
        data: { note: 'Stale' },
      })
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(
      await client.operations['kernel.records.get']({ ...selectors, schemaRevision: 1 })
    ).toEqual(updated);
    const batch = {
      ...scope,
      requestId: randomUUID(),
      schemaRevision: 1,
      requests: [
        {
          method: 'POST' as const,
          url: '/api/collections/entries/records',
          body: { data: { note: 'Batch' } },
        },
      ],
    };
    const batched = await cli('kernel.records.batch', batch);
    expect(batched.items).toHaveLength(1);
    expect(await cli('kernel.records.batch', batch)).toEqual(batched);
    await expect(
      client.operations['kernel.records.batch']({
        ...batch,
        requestId: randomUUID(),
        requests: [
          ...batch.requests,
          {
            method: 'PATCH',
            url: `/api/collections/entries/records/${record.id}`,
            body: { expectedRecordRevision: 1, data: { note: 'Stale batch' } },
          },
        ],
      })
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const listed = await client.operations['kernel.records.list']({
      ...scope,
      collection: 'entries',
      schemaRevision: 1,
    });
    expect(listed.items).toHaveLength(2);
    expect(listed.items.find((item) => item.id === record.id)).toEqual(updated);
    const newSchema = { ...created.schema!, title: 'Updated title' };
    const { appId: _appId, schemaRevision: _revision, ...proposal } = newSchema;
    const changed = await cli('kernel.schema.update', {
      ...scope,
      requestId: randomUUID(),
      expectedAppRevision: created.appRevision,
      expectedSchemaRevision: 1,
      schema: proposal,
    });
    expect(changed).toMatchObject({ appRevision: 2, schemaRevision: 2, title: 'Updated title' });
    const retired = await cli('kernel.apps.retire', {
      ...scope,
      requestId: randomUUID(),
      expectedAppRevision: changed.appRevision,
    });
    expect(retired.lifecycle).toBe('retired');
    const apps = await client.operations['kernel.apps.list']({ workspaceId: 'ws_demo' });
    expect(apps.items).toHaveLength(1);
    expect(apps.items[0]).toMatchObject({ appId: created.appId, lifecycle: 'retired' });
    await expect(
      client.operations['kernel.records.update']({
        ...update,
        requestId: randomUUID(),
        schemaRevision: 2,
        expectedRecordRevision: 2,
      })
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_operation' });
    expect(
      (await client.operations['kernel.records.get']({ ...selectors, schemaRevision: 2 })).data
    ).toEqual({ note: 'Updated' });
  } finally {
    f.coreDb.sqlite.close();
  }
});

it('preserves publication, JSON resources, refresh and conditional action receipts across HTTP and remote MCP', async () => {
  let acceptingProductWork = true;
  const f = fixture(() => ({
    ...computeBootReadinessSnapshot({ bootId: 'boot_ui' }),
    acceptingProductWork,
  }));
  const { createCoreClient } = await import('../../../packages/core-client/src/index.js');
  const { createOpenKitAccessTokenRecord } = await import('./auth/access-token-store.js');
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: (input, init) => f.app.fetch(new Request(input, init)),
  });
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'user_local',
    scope: 'workspace',
    workspaceIds: ['ws_demo'],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const mcp = async (operation: string, input: unknown, expectedError?: string) => {
    const response = await f.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'call', arguments: { operation, input } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    const result = JSON.parse(body.result.content[0].text);
    if (expectedError) {
      expect(body.result.isError).toBe(true);
      expect(result.code).toBe(expectedError);
    } else expect(body.result.isError, JSON.stringify(result)).not.toBe(true);
    return result;
  };
  try {
    const created = await client.operations['kernel.apps.create']({
      ...schema,
      workspaceId: 'ws_demo',
    } as never);
    const scope = {
      workspaceId: 'ws_demo',
      appId: created.appId,
      collection: 'entries',
      schemaRevision: 1,
    };
    const record = await client.operations['kernel.records.create']({
      ...scope,
      data: { note: 'Original' },
    });
    const collection = created.schema!.collections[0]!;
    const turn = f.store.createTurn('ws_demo', 'th_demo', 'Edit note', {
      kind: 'user',
      id: 'user_local',
    });
    const publication = {
      workspaceId: 'ws_demo',
      requestId: randomUUID(),
      threadId: 'th_demo',
      turnId: turn.id,
      title: 'Edit note',
      fallbackText: 'Edit note',
      messages: [
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: 'surface',
            catalogId: 'urn:openkit:a2ui:catalog:native:v1',
            sendDataModel: false,
          },
        },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'surface',
            components: [
              { id: 'root', component: 'Column', children: ['note', 'save', 'refresh'] },
              {
                id: 'note',
                component: 'TextField',
                label: 'Note',
                value: { path: '/records/0/data/note' },
              },
              {
                id: 'save',
                component: 'Button',
                child: 'save-label',
                action: {
                  event: {
                    name: 'save',
                    context: {
                      expectedRecordRevision: { path: '/records/0/revision' },
                      values: { path: '/records/0/data' },
                    },
                  },
                },
              },
              { id: 'save-label', component: 'Text', text: 'Save' },
              {
                id: 'refresh',
                component: 'Button',
                child: 'refresh-label',
                action: { event: { name: 'refresh' } },
              },
              { id: 'refresh-label', component: 'Text', text: 'Refresh' },
            ],
          },
        },
      ],
      source: {
        kind: 'kernel-records',
        appId: created.appId,
        collectionId: collection.id,
        schemaRevision: 1,
        query: { perPage: 1, filter: `id = "${record.id}"`, fields: 'note' },
      },
      actions: [
        {
          name: 'save',
          componentId: 'save',
          kind: 'kernel-record-update',
          recordId: record.id,
          writableFieldIds: [collection.fields[0]!.id],
        },
        { name: 'refresh', componentId: 'refresh', kind: 'refresh' },
      ],
    };
    const published = await client.operations['generative-ui.publish'](publication as never);
    expect(await mcp('generative-ui.publish', publication)).toEqual(published);
    const selected = { workspaceId: 'ws_demo', presentationId: published.id };
    expect(await mcp('generative-ui.get', selected)).toEqual(published);
    const resource = await client.operations['generative-ui.resource'](selected);
    expect(await mcp('generative-ui.resource', selected)).toEqual(resource);
    expect(JSON.parse(resource.text)).toEqual(published.messages.slice(0, 2));
    const refreshed = await mcp('generative-ui.refresh', {
      ...selected,
      ...event,
      action: { ...event.action, sourceComponentId: 'refresh' },
    });
    expect(refreshed.messages[0].updateDataModel.value.records[0]).toMatchObject({
      revision: 1,
      data: { note: 'Original' },
    });
    const action = {
      ...selected,
      requestId: randomUUID(),
      version: 'v0.9',
      action: {
        ...event.action,
        name: 'save',
        sourceComponentId: 'save',
        context: { expectedRecordRevision: 1, values: { note: 'Saved' } },
      },
    };
    expect((await mcp('generative-ui.action', action)).record).toMatchObject({
      revision: 2,
      data: { note: 'Saved' },
    });
    expect((await client.operations['generative-ui.action'](action as never)).record).toMatchObject(
      { revision: 2, data: { note: 'Saved' } }
    );
    await expect(
      client.operations['generative-ui.action']({ ...action, requestId: randomUUID() } as never)
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const observed = await client.operations['kernel.records.get']({
      ...scope,
      recordId: record.id,
    });
    expect(observed).toMatchObject({ revision: 2, data: { note: 'Saved' } });
    acceptingProductWork = false;
    const blocked = {
      ...action,
      requestId: randomUUID(),
      action: {
        ...action.action,
        context: { expectedRecordRevision: 2, values: { note: 'Blocked' } },
      },
    };
    await expect(client.operations['generative-ui.action'](blocked as never)).rejects.toMatchObject(
      { status: 503, code: 'product_work_unavailable' }
    );
    await mcp('generative-ui.action', blocked, 'product_work_unavailable');
    await mcp(
      'generative-ui.publish',
      { ...publication, requestId: randomUUID() },
      'product_work_unavailable'
    );
    expect(
      await client.operations['kernel.records.get']({ ...scope, recordId: record.id })
    ).toEqual(observed);
    expect(
      f.store.listAllItems().filter((item) => item.type === 'generative-ui-reference')
    ).toHaveLength(1);
  } finally {
    f.coreDb.sqlite.close();
  }
});

it('retains Workspace availability failures and refuses before any app or presentation write', async () => {
  const f = fixture();
  const available = f.store.getWorkspace.bind(f.store);
  const lookup = vi.spyOn(f.store, 'getWorkspace').mockImplementation(() => {
    throw new StoreRecordNotFoundError('Workspace record is missing.');
  });
  try {
    for (const [id, input, status] of [
      ['kernel.apps.create', schema, 400],
      ['generative-ui.publish', publish, 500],
    ] as const) {
      const response = await f.app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({ ...input, workspaceId: 'ws_demo' }),
      });
      expect(response.status).toBe(status);
      if (status === 400)
        expect(await response.json()).toMatchObject({
          code: 'invalid_request',
          message: 'Workspace record is missing.',
        });
      else
        expect(await response.json()).toEqual({
          protocolVersion: '0.5.0',
          code: 'internal_error',
          message: 'Internal Server Error',
        });
    }
    expect(lookup).toHaveBeenCalledWith('ws_demo');
    lookup.mockImplementation(available);
    const response = await f.app.request('/api/app/operations/kernel.apps.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws_demo' }),
    });
    expect(await response.json()).toMatchObject({ totalItems: 0, items: [] });
    expect(
      f.store.listAllItems().filter((item) => item.type === 'generative-ui-reference')
    ).toHaveLength(0);
  } finally {
    lookup.mockRestore();
    f.coreDb.sqlite.close();
  }
});

it('refuses read-only and revoked credentials before any newly migrated Kernel or UI write', async () => {
  const f = fixture();
  const server = createApp({
    mode: 'server',
    coreDb: f.coreDb,
    dataRoot: f.store.getDataRoot()!,
    store: f.store,
  });
  const { createOpenKitAccessTokenRecord, revokeOpenKitAccessTokenRecord } = await import(
    './auth/access-token-store.js'
  );
  const token = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'user_local',
    scope: 'workspace-readonly',
    workspaceIds: ['ws_demo'],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const headers = { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' };
  const read = () =>
    server.request('/api/app/operations/kernel.apps.list', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId: 'ws_demo' }),
    });
  try {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalItems: 0, items: [] });
    for (const [id, input] of [
      ['kernel.apps.create', schema],
      ['generative-ui.publish', publish],
    ] as const) {
      const denied = await server.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { ...headers, 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({ ...input, workspaceId: 'ws_demo' }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'workspace_access_denied' });
    }
    const unchanged = await read();
    expect(await unchanged.json()).toMatchObject({ totalItems: 0, items: [] });
    expect(
      f.store.listAllItems().filter((item) => item.type === 'generative-ui-reference')
    ).toHaveLength(0);
    revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
    expect((await read()).status).toBe(401);
  } finally {
    f.coreDb.sqlite.close();
  }
});
