// openkit-test-platform: posix
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { resolveLogicalModel } from './llm/logical-models.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { createVaultReference, getVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Real file, Core and encrypted-backend fixture for exact provider removal. */
function fixture(subscription = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-profile-delete-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  cleanups.push(() => coreDb.sqlite.close());
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server/vault'),
  });
  const backend = vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 18) });
  cleanups.push(() => vaultUnlockState.lock());
  const id = 'providers/removed.provider.jsonc';
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  const profile = subscription
    ? {
        id: 'removed',
        displayName: 'Removed',
        kind: 'oauth',
        vendor: 'openai-codex',
        models: ['gpt-5.1'],
        extensions: { openkit: { subscriptionAccount: { accountSlotId: 'shared' } } },
      }
    : {
        id: 'removed',
        displayName: 'Removed',
        kind: 'custom',
        vendor: 'openai',
        models: ['gpt-5.1'],
        baseUrl: 'https://provider.example.test/v1',
        secretRef: 'vault://removed_key',
      };
  writeFileSync(join(dataRoot, 'config', id), JSON.stringify(profile));
  if (!subscription) {
    backend.store({
      referenceId: 'removed_key',
      material: 'test-only-key',
      metadata: { ownerScope: 'server' },
    });
    createVaultReference(coreDb, {
      referenceId: 'removed_key',
      ownerScope: 'server',
      displayName: 'Removed',
      secretKind: 'provider-api-key',
      backendKind: backend.kind,
      backendLocator: `${backend.kind}://server/vault/removed_key`,
    });
  }
  const store = createDemoStore({ dataRoot });
  const references = {
    'config/gateway.jsonc': {
      schemaVersion: 1,
      defaultLogicalModelId: 'referenced',
      logicalModels: [
        {
          id: 'referenced',
          displayName: 'Referenced',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [
            { id: 'primary', providerProfileId: 'removed', providerModel: 'gpt-5.1' },
            { id: 'backup', providerProfileId: 'remaining', providerModel: 'gpt-5.1' },
          ],
        },
      ],
    },
    'config/agents/referencing.agent.jsonc': createTestAgentSetup({ logicalModelId: 'referenced' })
      .manifest,
    'config/internal-role-profiles.jsonc': {
      schemaVersion: 1,
      defaultLogicalModelId: 'referenced',
      profiles: [
        { id: 'assistant-default', roleId: 'assistant', preferredLogicalModelId: 'referenced' },
      ],
    },
    'workspaces/ws_demo/config/workspace.jsonc': {
      schemaVersion: 1,
      workspace: {
        name: 'Reference test',
        agents: [{ agentId: 'agent_codex_host', preferredLogicalModelId: 'referenced' }],
        internalRoles: [{ roleId: 'assistant', preferredLogicalModelId: 'referenced' }],
      },
    },
  };
  for (const [path, content] of Object.entries(references)) {
    const target = join(dataRoot, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(content));
  }
  writeFileSync(
    join(dataRoot, 'config/providers/remaining.provider.jsonc'),
    JSON.stringify({
      id: 'remaining',
      displayName: 'Remaining',
      kind: 'local',
      vendor: 'openai',
      models: ['gpt-5.1'],
    })
  );
  const referenceBytes = Object.keys(references).map((path) => readFileSync(join(dataRoot, path)));
  const accountManager = new ProviderSubscriptionAccountManager({
    coreDb,
    vaultBackend: () => backend,
  });
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  const app = createApp({
    store,
    dataRoot,
    coreDb,
    vaultUnlockState,
    runtimeConfigManager,
    providerSubscriptionAccountManager: accountManager,
  });
  /** Obtain the real revision then send the contained deletion command. */
  const deletion = async (expectedRevision?: string) => {
    const read = await app.request(...operationRequest('runtime.file-read', { id: id }));
    const file = await read.json();
    return app.request(
      ...operationRequest(
        'runtime.file-delete',
        {},
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            kind: 'provider',
            expectedRevision: expectedRevision ?? file.file.revision,
          }),
        }
      )
    );
  };
  return {
    app,
    dataRoot,
    coreDb,
    backend,
    id,
    deletion,
    runtimeConfigManager,
    accountManager,
    references,
    referenceBytes,
    vaultUnlockState,
    store,
  };
}

describe('provider profile removal', () => {
  it('revokes the key before removing the exact profile file', async () => {
    const f = fixture();
    const response = await f.deletion();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(existsSync(join(f.dataRoot, 'config', f.id))).toBe(false);
    expect(getVaultReference(f.coreDb, 'removed_key')?.status).toBe('revoked');
    expect(f.backend.listReferences()[0]?.revoked).toBe(true);
  });
  it('rejects a stale revision before changing either effect domain', async () => {
    const f = fixture();
    const before = readFileSync(join(f.dataRoot, 'config', f.id));
    const response = await f.deletion('stale-revision');
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('config_revision_conflict');
    expect(readFileSync(join(f.dataRoot, 'config', f.id))).toEqual(before);
    expect(getVaultReference(f.coreDb, 'removed_key')?.status).toBe('active');
    expect(f.backend.listReferences()[0]?.revoked).toBe(false);
  });
  it('preserves all authored references and keeps the active registry until restart', async () => {
    const f = fixture();
    expect(f.runtimeConfigManager.current().diagnostics).toEqual([]);
    expect((await f.deletion()).status).toBe(204);
    expect(Object.keys(f.references).map((path) => readFileSync(join(f.dataRoot, path)))).toEqual(
      f.referenceBytes
    );
    const strict = f.runtimeConfigManager.reload({ mode: 'strict' });
    expect(strict.status).toBe('rejected');
    expect(f.runtimeConfigManager.current().providerRegistry.get('removed')).not.toBeNull();
    const safe = f.runtimeConfigManager.reload({ mode: 'safe' });
    expect(safe.status).toBe('applied');
    expect(safe.runtimeConfig.pendingRestart).toContainEqual(
      expect.objectContaining({ path: 'providers' })
    );
    expect(f.runtimeConfigManager.current().providerRegistry.get('removed')).not.toBeNull();
    const restarted = createRuntimeConfigManager({ dataRoot: f.dataRoot });
    expect(restarted.current().providerRegistry.get('removed')).toBeNull();
    const reload = restarted.reload({ mode: 'safe' });
    expect(reload.status).toBe('applied');
    expect(reload.plan.warnings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('primary') })
    );
    const model = resolveLogicalModel(
      restarted.current().gatewayConfig,
      restarted.current().providerRegistry,
      'referenced'
    );
    expect(model?.routes).toMatchObject([
      { id: 'primary', available: false },
      { id: 'backup', available: true },
    ]);
    expect(Object.keys(f.references).map((path) => readFileSync(join(f.dataRoot, path)))).toEqual(
      f.referenceBytes
    );
  });
  it('leaves a shared subscription slot and its credentials untouched', async () => {
    const f = fixture(true);
    const pair = { subscriptionProviderId: 'openai-codex' as const, accountSlotId: 'shared' };
    await f.accountManager.createAccount(pair);
    const handle = await f.accountManager.getPairHandle(pair);
    await handle.credentials.modify(pair.subscriptionProviderId, async () => ({
      type: 'oauth',
      access: 'test-access',
      refresh: 'test-refresh',
      expires: Date.now() + 60000,
    }));
    const accountPath = join(
      f.dataRoot,
      'server/files/provider-subscriptions/openai-codex/accounts/shared/account.json'
    );
    const accountBytes = readFileSync(accountPath);
    const inventory = f.backend.listReferences();
    const coreRows = f.coreDb.sqlite.prepare('SELECT * FROM vault_references').all();
    expect((await f.deletion()).status).toBe(204);
    expect(readFileSync(accountPath)).toEqual(accountBytes);
    expect(f.backend.listReferences()).toEqual(inventory);
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_references').all()).toEqual(coreRows);
  });
  it('rejects a workspace token before any file or Vault effect', async () => {
    const f = fixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const app = createApp({
      store: f.store,
      dataRoot: f.dataRoot,
      coreDb: f.coreDb,
      vaultUnlockState: f.vaultUnlockState,
      runtimeConfigManager: f.runtimeConfigManager,
      mode: 'server',
      auth: { api: { getSession: async () => null }, handler: async () => Response.json({}) },
    });
    const before = readFileSync(join(f.dataRoot, 'config', f.id));
    const response = await app.request(
      ...operationRequest(
        'runtime.file-delete',
        {},
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: f.id, kind: 'provider', expectedRevision: 'irrelevant' }),
        }
      )
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'deployment_admin_required',
      message: 'Current deployment administrator authority is required.',
    });
    expect(readFileSync(join(f.dataRoot, 'config', f.id))).toEqual(before);
    expect(f.backend.listReferences()[0]?.revoked).toBe(false);
  });
  it('reports backend revocation failure and preserves the file and Core row', async () => {
    const f = fixture();
    vi.spyOn(f.backend, 'revoke').mockImplementationOnce(() => {
      throw new Error('private failure');
    });
    const before = readFileSync(join(f.dataRoot, 'config', f.id));
    const response = await f.deletion();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('vault_mutation_failed');
    expect(readFileSync(join(f.dataRoot, 'config', f.id))).toEqual(before);
    expect(getVaultReference(f.coreDb, 'removed_key')?.status).toBe('active');
  });
  it('reports a Core failure after backend revocation without restoring material or removing the file', async () => {
    const f = fixture();
    f.coreDb.sqlite.exec(
      "CREATE TRIGGER refuse_revoke BEFORE UPDATE ON vault_references BEGIN SELECT RAISE(ABORT, 'test-only Core failure'); END"
    );
    const response = await f.deletion();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('vault_mutation_failed');
    expect(existsSync(join(f.dataRoot, 'config', f.id))).toBe(true);
    expect(getVaultReference(f.coreDb, 'removed_key')?.status).toBe('active');
    expect(f.backend.listReferences()[0]?.revoked).toBe(true);
  });

  it('refuses a symlink target before any Vault effect', async () => {
    const f = fixture();
    const target = join(f.dataRoot, 'config', f.id);
    const outside = join(f.dataRoot, 'outside-provider.jsonc');
    const bytes = readFileSync(target);
    writeFileSync(outside, bytes);
    rmSync(target);
    symlinkSync(outside, target);
    const response = await f.app.request(
      ...operationRequest(
        'runtime.file-delete',
        {},
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: f.id, kind: 'provider', expectedRevision: 'irrelevant' }),
        }
      )
    );
    expect(response.status).toBe(400);
    expect(readFileSync(outside)).toEqual(bytes);
    expect(f.backend.listReferences()[0]?.revoked).toBe(false);
  });
  it('refuses non-Provider and escaped file identities before effects', async () => {
    const f = fixture();
    for (const id of ['server.jsonc', '../outside.provider.jsonc']) {
      const response = await f.app.request(
        ...operationRequest(
          'runtime.file-delete',
          {},
          {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, kind: 'provider', expectedRevision: 'irrelevant' }),
          }
        )
      );
      expect(response.status).toBe(400);
      expect(f.backend.listReferences()[0]?.revoked).toBe(false);
      expect(existsSync(join(f.dataRoot, 'config', f.id))).toBe(true);
    }
  });
});
