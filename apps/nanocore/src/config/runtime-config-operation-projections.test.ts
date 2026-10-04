import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
  RUNTIME_CONFIG_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { computeBootReadinessSnapshot } from '../bootstrap/readiness.js';
import { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Explicit local authority exercises real HTTP registration rather than an unauthenticated rejection. */
describe('runtime and provider subscription operation cutover', () => {
  it('reaches runtime.schemas and provider-subscription.provider-list through canonical JSON bindings', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b4-projections-'));
    roots.push(dataRoot);
    const app = createApp({ dataRoot });
    for (const id of ['runtime.schemas', 'provider-subscription.provider-list']) {
      const response = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty(id === 'runtime.schemas' ? 'schemas' : 'providers');
    }
  });
});

it('retires all ten former runtime bindings for the authorized local actor without changing protected source bytes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b4-retirement-'));
  roots.push(dataRoot);
  const id = 'providers/kept.provider.jsonc';
  const path = join(dataRoot, 'config', id);
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  const content = JSON.stringify({
    id: 'kept',
    kind: 'custom',
    vendor: 'openai',
    displayName: 'Kept',
    models: ['gpt-5.1'],
    baseUrl: 'https://provider.example.test/v1',
  });
  writeFileSync(path, content);
  const app = createApp({ dataRoot });
  const read = await app.request('/api/app/operations/runtime.file-read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  expect(read.status).toBe(200);
  const expectedRevision = (await read.json()).file.revision;
  for (const [method, route, input] of [
    ['GET', '/api/admin/config/agent-environment?fileId=agents/test.agent.jsonc', {}],
    [
      'PUT',
      '/api/admin/config/agent-environment',
      {
        fileId: 'agents/test.agent.jsonc',
        expectedRevision: 'source',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        defaultsDigest: `sha256:${'b'.repeat(64)}`,
        environment: {},
      },
    ],
    ['POST', '/api/admin/config/reload', { dryRun: true }],
    ['GET', '/api/admin/config/files', {}],
    ['GET', `/api/admin/config/file?id=${id}`, {}],
    [
      'POST',
      '/api/admin/config/file',
      {
        id: 'providers/new.provider.jsonc',
        kind: 'provider',
        content: content.replaceAll('kept', 'new'),
      },
    ],
    [
      'PUT',
      '/api/admin/config/file',
      { id, kind: 'provider', content: content.replace('Kept', 'Changed'), expectedRevision },
    ],
    ['DELETE', '/api/admin/config/file', { id, kind: 'provider', expectedRevision }],
    ['GET', '/api/admin/config/schemas', {}],
    ['POST', '/api/admin/config/validate', { files: [] }],
  ] as const) {
    const response = await app.request(route, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    });
    expect(response.status, `${method} ${route}`).toBe(404);
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(existsSync(join(dataRoot, 'config/providers/new.provider.jsonc'))).toBe(false);
  }
});

it('gates every B4 mutation before exact effects and preserves owner failures and deletion results after admission reopens', async () => {
  const providerFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected provider call during admission regression.'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b4-gating-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server/vault'),
  });
  const backend = vault.unlock({ masterKey: Buffer.alloc(32, 21) });
  const manager = new ProviderSubscriptionAccountManager({ coreDb, vaultBackend: () => backend });
  const pair = { subscriptionProviderId: 'xai' as const, accountSlotId: 'kept' };
  await manager.createAccount(pair);
  const accountPath = join(
    dataRoot,
    'server/files/provider-subscriptions/xai/accounts/kept/account.json'
  );
  const accountBytes = readFileSync(accountPath);
  const sourcePath = join(dataRoot, 'config/server.jsonc');
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(sourcePath, '{"schemaVersion":1}');
  const sourceBytes = readFileSync(sourcePath);
  const profilePath = join(dataRoot, 'config/providers/kept.provider.jsonc');
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  writeFileSync(
    profilePath,
    JSON.stringify({
      id: 'kept',
      kind: 'custom',
      vendor: 'openai',
      displayName: 'Kept',
      models: ['gpt-5.1'],
      baseUrl: 'https://provider.example.test/v1',
    })
  );
  const profileBytes = readFileSync(profilePath);
  const inventory = backend.listReferences();
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    expiresAt: '2099-01-01T00:00:00.000Z',
    workspaceIds: [],
  });
  let readiness = computeBootReadinessSnapshot({
    bootId: 'boot_b4',
    subsystems: {
      storage: {
        state: 'failed',
        reasons: [{ code: 'storage.failed', message: 'Unavailable.', blocks: ['product_work'] }],
      },
    },
  });
  const app = createApp({
    dataRoot,
    coreDb,
    providerSubscriptionAccountManager: manager,
    mode: 'server',
    getBootReadiness: () => readiness,
  });
  const profileRead = await app.request('/api/app/operations/runtime.file-read', {
    method: 'POST',
    headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'providers/kept.provider.jsonc' }),
  });
  expect(profileRead.status).toBe(200);
  const profileRevision = (await profileRead.json()).file.revision;
  const cases = {
    'runtime.agent-environment-update': {
      fileId: 'agents/test.agent.jsonc',
      expectedRevision: 'kept',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${'b'.repeat(64)}`,
      environment: { TEST: 'literal' },
    },
    'runtime.reload': { mode: 'safe' },
    'runtime.file-create': {
      id: 'providers/new.provider.jsonc',
      kind: 'provider',
      content: profileBytes.toString('utf8').replaceAll('kept', 'new'),
    },
    'runtime.file-update': {
      id: 'providers/kept.provider.jsonc',
      kind: 'provider',
      content: profileBytes.toString('utf8').replace('Kept', 'Changed'),
      expectedRevision: profileRevision,
    },
    'runtime.file-delete': {
      id: 'providers/kept.provider.jsonc',
      kind: 'provider',
      expectedRevision: profileRevision,
    },
    'provider-subscription.account-create': { subscriptionProviderId: 'xai', accountSlotId: 'new' },
    'provider-subscription.account-update': { ...pair, displayName: 'Changed' },
    'provider-subscription.account-delete': pair,
    'provider-subscription.account-login-start': { ...pair, mode: 'device_code' },
    'provider-subscription.account-login-cancel': { ...pair, interactionId: 'pending' },
    'provider-subscription.account-logout': pair,
  };
  expect(Object.keys(cases).sort()).toEqual(
    Object.entries({
      ...RUNTIME_CONFIG_OPERATION_DEFINITIONS,
      ...PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
    })
      .filter(([, definition]) => definition.mutating)
      .map(([id]) => id)
      .sort()
  );
  try {
    for (const [id, input] of Object.entries(cases)) {
      const http = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(http.status, id).toBe(503);
      expect(await http.json()).toMatchObject({ code: 'product_work_unavailable' });
      const mcp = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation: id, input } },
        }),
      });
      expect(mcp.status, id).toBe(200);
      const result = (await mcp.json()).result;
      expect(result.isError, id).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'product_work_unavailable',
      });
      expect(readFileSync(accountPath)).toEqual(accountBytes);
      expect(readFileSync(sourcePath)).toEqual(sourceBytes);
      expect(readFileSync(profilePath)).toEqual(profileBytes);
      expect(backend.listReferences()).toEqual(inventory);
      expect(existsSync(join(dataRoot, 'config/providers/new.provider.jsonc'))).toBe(false);
      expect(
        existsSync(
          join(dataRoot, 'server/files/provider-subscriptions/xai/accounts/new/account.json')
        )
      ).toBe(false);
    }
    readiness = { ...readiness, acceptingProductWork: true };
    for (const [id, input, code, message] of [
      [
        'runtime.file-read',
        { id: 'providers/absent.provider.jsonc' },
        'config_file_not_found',
        'providers/absent.provider.jsonc was not found.',
      ],
      [
        'provider-subscription.account-status',
        { ...pair, accountSlotId: 'absent' },
        'provider_subscription_account_not_found',
        'Provider subscription account not found.',
      ],
    ] as const) {
      const http = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(http.status).toBe(404);
      expect(await http.json()).toMatchObject({ code, message });
      const mcp = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation: id, input } },
        }),
      });
      expect(mcp.status).toBe(200);
      const result = (await mcp.json()).result;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code, message });
      expect(readFileSync(accountPath)).toEqual(accountBytes);
      expect(readFileSync(profilePath)).toEqual(profileBytes);
      expect(backend.listReferences()).toEqual(inventory);
    }
    const read = await app.request('/api/app/operations/runtime.file-read', {
      method: 'POST',
      headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'providers/kept.provider.jsonc' }),
    });
    expect(read.status).toBe(200);
    const revision = (await read.json()).file.revision;
    const removed = await app.request('/api/app/operations/runtime.file-delete', {
      method: 'POST',
      headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'providers/kept.provider.jsonc',
        kind: 'provider',
        expectedRevision: revision,
      }),
    });
    expect(removed.status).toBe(204);
    expect(removed.headers.get('content-type')).toBeNull();
    expect(await removed.text()).toBe('');
    expect(existsSync(profilePath)).toBe(false);
    const accountRemoved = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'call',
          arguments: { operation: 'provider-subscription.account-delete', input: pair },
        },
      }),
    });
    expect(accountRemoved.status).toBe(200);
    const result = (await accountRemoved.json()).result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toBeNull();
    expect(existsSync(accountPath)).toBe(false);
    expect(backend.listReferences()).toEqual(inventory);
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    vault.lock();
    coreDb.sqlite.close();
  }
});

it('reaches all ten owned runtime responses with explicit local authority', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b4-runtime-outcomes-'));
  roots.push(dataRoot);
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), '{"schemaVersion":1}');
  const app = createApp({ dataRoot });
  const invoke = async (id: string, input: Record<string, unknown>, expectedStatus = 200) => {
    const response = await app.request(`/api/app/operations/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(response.status, id).toBe(expectedStatus);
    if (expectedStatus === 204) {
      expect(await response.text()).toBe('');
      expect(response.headers.get('content-type')).toBeNull();
      return null;
    }
    return response.json();
  };
  const environmentRead = await invoke(
    'runtime.agent-environment-read',
    { fileId: 'agents/test.agent.jsonc' },
    503
  );
  expect(environmentRead.code).toBe('runtime_unavailable');
  const environmentUpdate = await invoke(
    'runtime.agent-environment-update',
    {
      fileId: 'agents/test.agent.jsonc',
      expectedRevision: 'source',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      defaultsDigest: `sha256:${'b'.repeat(64)}`,
      environment: {},
    },
    503
  );
  expect(environmentUpdate.code).toBe('runtime_unavailable');
  expect(await invoke('runtime.reload', { dryRun: true })).toHaveProperty('plan');
  expect(await invoke('runtime.file-list', {})).toHaveProperty('files');
  expect(await invoke('runtime.file-read', { id: 'server.jsonc' })).toMatchObject({
    content: '{"schemaVersion":1}',
  });
  const id = 'providers/parity.provider.jsonc';
  const content = JSON.stringify({
    id: 'parity',
    kind: 'custom',
    vendor: 'openai',
    displayName: 'Parity',
    models: ['gpt-5.1'],
    baseUrl: 'https://provider.example.test/v1',
  });
  const created = await invoke('runtime.file-create', { id, kind: 'provider', content });
  expect(created.file.exists).toBe(true);
  expect(readFileSync(join(dataRoot, 'config', id), 'utf8')).toBe(content);
  const changed = content.replace('Parity', 'Changed');
  const updated = await invoke('runtime.file-update', {
    id,
    kind: 'provider',
    content: changed,
    expectedRevision: created.file.revision,
  });
  expect(readFileSync(join(dataRoot, 'config', id), 'utf8')).toBe(changed);
  expect(
    await invoke(
      'runtime.file-delete',
      { id, kind: 'provider', expectedRevision: updated.file.revision },
      204
    )
  ).toBeNull();
  expect(existsSync(join(dataRoot, 'config', id))).toBe(false);
  expect(await invoke('runtime.schemas', {})).toHaveProperty('schemas');
  expect(await invoke('runtime.validate', { files: [] })).toHaveProperty('valid');
});
