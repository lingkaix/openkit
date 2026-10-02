import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateOpenKitAccessTokenResponseSchema,
  OPERATION_DEFINITIONS,
  RotateOpenKitAccessTokenResponseSchema,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { createLightApp, getLightApp, listRecords } from './generative-kernel/commands.js';
import * as invocation from './operation-invocation.js';
import { openExistingAppDb } from './storage/app-db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { users } from './storage/schema/index.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Real isolated credential, membership and Kernel owners behind the App listener. */
async function fixture(mode: 'local' | 'server' = 'server') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-remote-mcp-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.db
    .insert(users)
    .values({
      id: 'user_remote_mcp',
      kind: 'human',
      displayName: 'Remote User',
      email: 'remote@example.test',
      emailVerified: false,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date().toISOString(),
    })
    .run();
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_remote_mcp',
    workspaceId: 'ws_demo',
  });
  const command = {
    store,
    dataRoot,
    workspaceId: 'ws_demo',
    actor: { kind: 'user' as const, id: 'user_remote_mcp' },
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  };
  const appRecord = await createLightApp(command, {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Remote MCP',
    purpose: 'Regression',
    collections: [
      {
        name: 'entries',
        type: 'base',
        description: 'Entries',
        indexes: [],
        fields: [{ name: 'note', type: 'text', required: true, description: 'Note' }],
      },
    ],
  });
  const token = (scope: 'workspace' | 'workspace-readonly' = 'workspace') =>
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope,
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  const app = createApp({ coreDb, dataRoot, store, mode });
  const selectors = { workspaceId: 'ws_demo', appId: appRecord.appId };
  const message = async (
    method: string,
    params: unknown,
    secret?: string,
    path = '/mcp',
    headers = {}
  ) =>
    app.request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  const call = async (
    name: string,
    args: unknown,
    secret: string,
    headers: Record<string, string> = {}
  ) => {
    const response = await message(
      'tools/call',
      { name, arguments: args },
      secret,
      '/mcp',
      headers
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    return body.result;
  };
  return { app, coreDb, dataRoot, store, command, appRecord, token, selectors, message, call };
}

afterEach(() => vi.restoreAllMocks());

describe('remote MCP App endpoint', () => {
  it('challenges missing, unknown, malformed, expired and revoked credentials uniformly before dispatch', async () => {
    const f = await fixture();
    const expired = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_remote_mcp',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const revoked = f.token();
    revokeOpenKitAccessTokenRecord(f.coreDb, revoked.record.tokenId);
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    const bodies: string[] = [];
    for (const secret of [
      undefined,
      'okt_unknown_fake',
      'malformed',
      expired.secret,
      revoked.secret,
    ]) {
      const response = await f.message(
        'tools/call',
        { name: 'call', arguments: { operation: 'kernel.records.create' } },
        secret
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      const body = await response.text();
      if (secret) expect(body).not.toContain(secret);
      bodies.push(body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires the bearer header even in local mode and ignores cookie, body and query credentials', async () => {
    const f = await fixture('local');
    const token = f.token();
    for (const [path, params, headers] of [
      [`/mcp?token=${token.secret}`, {}, {}],
      ['/mcp', { token: token.secret }, {}],
      ['/mcp', {}, { cookie: `token=${token.secret}; session=browser` }],
    ] as const) {
      expect((await f.message('tools/list', params, undefined, path, headers)).status).toBe(401);
    }
    expect(
      (
        await f.message('tools/list', {}, token.secret, `/mcp?token=malformed`, {
          cookie: 'token=malformed',
        })
      ).status
    ).toBe(200);
  });

  it('refuses real non-loopback plaintext before verification even with a loopback Host', async () => {
    const f = await fixture();
    const token = f.token();
    const response = await f.app.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token.secret}` },
        body: '{}',
      }),
      { incoming: { socket: { remoteAddress: '192.0.2.1', encrypted: false } } }
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('core.auth.insecure_transport');
    expect(
      f.coreDb.sqlite
        .prepare('SELECT last_used_at FROM openkit_access_tokens WHERE token_id = ?')
        .get(token.record.tokenId)
    ).toEqual({ last_used_at: null });
  });

  it('derives exactly four tools and per-operation annotations and bounded ranked search from all definitions', async () => {
    const f = await fixture();
    const token = f.token();
    const listed = await (await f.message('tools/list', {}, token.secret)).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search',
      'describe',
      'guide',
      'call',
    ]);
    expect(
      listed.result.tools
        .slice(0, 3)
        .every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)
    ).toBe(true);
    expect(listed.result.tools[3].annotations.readOnlyHint).toBe(false);
    for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS)) {
      const result = await f.call('describe', { operation: id }, token.secret);
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe(id);
      expect(data.annotations.readOnlyHint).toBe(!definition.mutating);
      expect(data.inputSchema.type).toBe('object');
    }
    const a = JSON.parse(
      (await f.call('search', { query: 'kernel record create' }, token.secret)).content[0].text
    );
    const b = JSON.parse(
      (await f.call('search', { query: 'create record kernel' }, token.secret)).content[0].text
    );
    expect(a).toEqual(b);
    expect(a.items[0].id).toBe('kernel.records.create');
    const additions = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `test.record.${i}`,
        OPERATION_DEFINITIONS['kernel.records.create'],
      ])
    );
    Object.assign(OPERATION_DEFINITIONS, additions);
    try {
      const page = JSON.parse(
        (await f.call('search', { query: 'record' }, token.secret)).content[0].text
      );
      expect(page.items.length).toBeLessThan(page.total);
      expect(page.hasMore).toBe(true);
    } finally {
      for (const id of Object.keys(additions))
        delete (OPERATION_DEFINITIONS as unknown as Record<string, unknown>)[id];
    }
  });

  it('serves progressive product guidance and never issues OAuth metadata or a refresh token', async () => {
    const f = await fixture();
    const token = f.token();
    const guide = await f.call('guide', {}, token.secret);
    expect(guide.content[0].text).toContain('Ask the user');
    expect(guide.content[0].text).toContain('default_tools_approval_mode');
    const init = await (
      await f.message(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'regression', version: '1' },
        },
        token.secret
      )
    ).json();
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect(JSON.stringify(init)).not.toMatch(/refresh_token|resource_metadata/);
    expect(
      (await f.app.request('http://127.0.0.1/.well-known/oauth-protected-resource')).status
    ).toBe(404);
  });

  it('invokes natively as the Token user and records server-owned channel and credential attribution', async () => {
    const f = await fixture();
    const token = f.token();
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    const requestId = randomUUID();
    const result = await f.call(
      'call',
      {
        operation: 'kernel.records.create',
        input: {
          ...f.selectors,
          collection: 'entries',
          schemaRevision: 1,
          requestId,
          data: { note: 'MCP attribution' },
        },
      },
      token.secret,
      {
        'x-openkit-client-channel': 'caller-channel',
        'x-openkit-client-source': 'caller-source',
      }
    );
    expect(result.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalled();
    const records = listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
      schemaRevision: 1,
    });
    expect(records.items).toHaveLength(1);
    const appDb = openExistingAppDb(f.dataRoot, 'ws_demo', f.appRecord.appId);
    try {
      expect(
        appDb.sqlite
          .prepare("SELECT actor_json FROM audit_events WHERE action = 'kernel.records.create'")
          .get()
      ).toEqual({ actor_json: JSON.stringify({ kind: 'user', id: 'user_remote_mcp' }) });
    } finally {
      appDb.sqlite.close();
    }
    const row = f.coreDb.sqlite
      .prepare(
        'SELECT owner_user_id, last_used_channel, last_used_source FROM openkit_access_tokens WHERE token_id = ?'
      )
      .get(token.record.tokenId);
    expect(row).toEqual({
      owner_user_id: 'user_remote_mcp',
      last_used_channel: 'remote-mcp',
      last_used_source: 'remote-mcp',
    });
    const audit = listServerAuditEvents(f.coreDb).find(
      (event) => event.action === 'remote-mcp.request'
    );
    expect(audit?.actor).toEqual({ kind: 'user', id: 'user_remote_mcp' });
    expect(audit?.summary).toContain(token.record.tokenId);
    expect(audit?.summary).toContain('remote-mcp');
    expect(audit?.requestId).toBe(requestId);
    expect(audit?.resource).toBe('operation:kernel.records.create');
    expect(JSON.stringify(audit)).not.toContain(token.secret);
    const read = await f.call(
      'call',
      { operation: 'kernel.apps.get', input: f.selectors },
      token.secret
    );
    expect(JSON.parse(read.content[0].text)).toEqual(
      getLightApp(f.dataRoot, 'ws_demo', f.appRecord.appId)
    );
  });

  it('keeps read-only reads, mutation refusals as tool results and next-request revocation', async () => {
    const f = await fixture();
    const token = f.token('workspace-readonly');
    expect(
      (await f.call('call', { operation: 'kernel.apps.get', input: f.selectors }, token.secret))
        .isError
    ).not.toBe(true);
    const refused = await f.call(
      'call',
      {
        operation: 'kernel.records.create',
        input: {
          ...f.selectors,
          collection: 'entries',
          schemaRevision: 1,
          requestId: randomUUID(),
          data: { note: 'forbidden' },
        },
      },
      token.secret
    );
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('workspace_access_denied');
    expect(
      listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', { schemaRevision: 1 }).items
    ).toHaveLength(0);
    revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
    expect((await f.message('tools/list', {}, token.secret)).status).toBe(401);
  });

  it('preserves an owner bearer refusal with its exact native outcome and actor', async () => {
    const f = await fixture();
    const token = f.token();
    const actor = {
      kind: 'token' as const,
      userId: 'user_remote_mcp',
      tokenId: token.record.tokenId,
      tokenScope: 'workspace' as const,
      tokenWorkspaceIds: ['ws_demo'],
    };
    const expected = await invocation
      .createOperationInvocation({ coreDb: f.coreDb })(
        'nanohost.runtime-target',
        {},
        { kind: 'public', actor }
      )
      .catch((error: Error & { code: string }) => ({ code: error.code, message: error.message }));
    const result = await f.call(
      'call',
      { operation: 'nanohost.runtime-target', input: {} },
      token.secret
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
  });

  it('refuses current one-time-secret response schemas before dispatch when a credential definition is added', async () => {
    const f = await fixture();
    const token = f.token();
    const invoke = vi.spyOn(invocation, 'createOperationInvocation');
    for (const outputSchema of [
      CreateOpenKitAccessTokenResponseSchema,
      RotateOpenKitAccessTokenResponseSchema,
    ]) {
      Object.assign(OPERATION_DEFINITIONS, {
        'test.secret': { ...OPERATION_DEFINITIONS['kernel.apps.get'], outputSchema },
      });
      try {
        const result = await f.call('call', { operation: 'test.secret', input: {} }, token.secret);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).code).toBe('mcp_secret_returning_operation');
        const search = await f.call('search', { query: 'test.secret' }, token.secret);
        expect(search.isError).not.toBe(true);
        expect(JSON.parse(search.content[0].text).items).not.toContainEqual(
          expect.objectContaining({ id: 'test.secret' })
        );
        const described = await f.call('describe', { operation: 'test.secret' }, token.secret);
        expect(described.isError).toBe(true);
        expect(described.content).toEqual(result.content);
        expect(described.content[0].text).not.toMatch(
          /"inputSchema"|"outputSchema"|"properties"|"token"|"record"/
        );
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        delete (OPERATION_DEFINITIONS as unknown as Record<string, unknown>)['test.secret'];
      }
    }
  });

  it('returns MCP protocol errors without effects for malformed messages and unknown methods', async () => {
    const f = await fixture();
    const token = f.token();
    const response = await f.message('unknown/method', {}, token.secret);
    expect((await response.json()).error.code).toBe(-32601);
    const malformed = await f.app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{',
    });
    expect((await malformed.json()).error).toBeDefined();
    expect(
      listRecords(f.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', { schemaRevision: 1 }).items
    ).toHaveLength(0);
  });
});
