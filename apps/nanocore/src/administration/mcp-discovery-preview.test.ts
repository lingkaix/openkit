import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditEvents from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
/** Real native admission and retained catalog, with no Worker or fabricated binding. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-preview-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'user_local',
    tokenScope: 'server-admin',
    tokenId: token.tokenId,
  };
  const store = new FsStore({ dataRoot });
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server/vault'),
  });
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 13) });
  cleanup.push(() => vaultUnlockState.lock());
  const invoke = createOperationInvocation({
    coreDb,
    dataRoot,
    store,
    inflightCommands: new WeakMap(),
    vaultUnlockState,
  });
  const call = (operation: string, input: unknown, currentActor = actor) =>
    invoke(operation as never, input as never, { kind: 'public', actor: currentActor }) as Promise<
      Record<string, unknown>
    >;
  return { dataRoot, coreDb, token, actor, call };
}
/** Create an inert retained declaration through the real supported management operation. */
async function seed(f: ReturnType<typeof fixture>, endpoint: string) {
  const created = await f.call('administration.server-mcp-create', {
    requestId: randomUUID(),
    id: 'preview-example',
    displayName: 'Preview example',
    allowedTools: [],
    declaration: { kind: 'http', endpoint },
    expectedRevision: 0,
  });
  return {
    catalogScope: { kind: 'server' },
    mcpId: 'preview-example',
    versionDigest: created.versionDigest,
    expectedRevision: 1,
    expectedBindingRevision: null,
    timeoutMs: 2000,
    credentialBindings: [],
  };
}

describe('explicit administrator MCP discovery preview', () => {
  it('lists real tools before an allowlist without publication, Workspace data or tools/call', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const catalogPath = join(f.dataRoot, 'server/catalog/catalog.json');
    const before = readFileSync(catalogPath);
    const workspaceDir = join(f.dataRoot, 'workspaces');
    const workspacesBefore = existsSync(workspaceDir) ? readdirSync(workspaceDir) : [];
    const result = await f.call('administration.mcp-discovery-preview', input);
    expect(result).toMatchObject({
      mcpId: 'preview-example',
      versionDigest: input.versionDigest,
      tools: [{ name: 'echo' }],
    });
    expect(upstream.observed.filter((name) => name.endsWith('|tools/list'))).toHaveLength(1);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(upstream.observed.some((name) => name.includes('|DELETE|'))).toBe(true);
    expect(readFileSync(catalogPath)).toEqual(before);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings).toEqual([]);
    expect(existsSync(workspaceDir) ? readdirSync(workspaceDir) : []).toEqual(workspacesBefore);
  });
  it('refuses stale or revoked current authority before upstream contact', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    await expect(
      f.call('administration.mcp-discovery-preview', { ...input, expectedRevision: 0 })
    ).rejects.toMatchObject({ status: 409 });
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 403,
    });
    expect(upstream.observed).toEqual([]);
  });
  it('refuses an endless paginated list without a partial result or tool execution', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub({ toolPages: 'nonterminating' });
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 503,
    });
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings).toEqual([]);
  });
  it('rejects Agent-constrained human-preview credentials before resolution or contact', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const reference = await f.call('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material: 'preview-fake-material-canary',
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
      targetAgentId: 'synthetic-agent',
    });
    await expect(
      f.call('administration.mcp-discovery-preview', {
        ...input,
        credentialBindings: [
          {
            slot: 'authorization',
            vaultGrantId: grant.grantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(upstream.observed).toEqual([]);
    expect(listVaultUseRecords(f.coreDb)).toEqual([]);
  });
  it('audits actual credentialed preview without creating a synthetic Workspace', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const reference = await f.call('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material: 'preview-fake-material-canary',
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
      targetCapabilityId: 'mcp.list_tools',
    });
    const workspaceDir = join(f.dataRoot, 'workspaces');
    const before = existsSync(workspaceDir) ? readdirSync(workspaceDir) : [];
    const result = await f.call('administration.mcp-discovery-preview', {
      ...input,
      credentialBindings: [
        {
          slot: 'authorization',
          vaultGrantId: grant.grantId,
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    });
    expect(result.tools).toMatchObject([{ name: 'echo' }]);
    expect(
      upstream.observedHeaders.some(
        (headers) => headers.get('authorization') === 'preview-fake-material-canary'
      )
    ).toBe(true);
    expect(existsSync(workspaceDir) ? readdirSync(workspaceDir) : []).toEqual(before);
    const starting = auditEvents
      .listSqliteAuditEvents(f.coreDb.sqlite)
      .filter((event) => event.action === 'mcp.server.lifecycle.starting');
    expect(starting).toHaveLength(1);
    expect(starting[0]).toMatchObject({
      workspaceId: null,
      actor: { kind: 'user', id: 'user_local' },
      outcome: 'succeeded',
    });
    expect(starting[0]?.requestId).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('preview-fake-material-canary');
  });
  it('retains the credentialed startup Audit fence before upstream contact', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const reference = await f.call('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material: 'preview-fake-material-canary',
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
    });
    const record = auditEvents.recordServerAuditEvent;
    vi.spyOn(auditEvents, 'recordServerAuditEvent').mockImplementation((event) => {
      if (event.action === 'mcp.server.lifecycle.starting')
        throw new Error('synthetic audit storage failure');
      return record(event);
    });
    await expect(
      f.call('administration.mcp-discovery-preview', {
        ...input,
        credentialBindings: [
          {
            slot: 'authorization',
            vaultGrantId: grant.grantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      })
    ).rejects.toMatchObject({ status: 503 });
    expect(upstream.observed).toEqual([]);
  });
  it('rejects reflected material after real credentialed discovery without publishing it', async () => {
    const f = fixture();
    const material = 'preview-fake-material-canary';
    const upstream = await createMcpHttpStub({ credentialListEcho: material });
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const reference = await f.call('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material,
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
      targetCapabilityId: 'mcp.list_tools',
    });
    let failure: unknown;
    try {
      await f.call('administration.mcp-discovery-preview', {
        ...input,
        credentialBindings: [
          {
            slot: 'authorization',
            vaultGrantId: grant.grantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 503 });
    expect(String(failure)).not.toContain(material);
    expect(
      listVaultUseRecords(f.coreDb).map((use) => ({
        outcome: use.outcome,
        failureCode: use.failureCode,
      }))
    ).toEqual([{ outcome: 'succeeded', failureCode: null }]);
    expect(
      upstream.observedHeaders.some((headers) => headers.get('authorization') === material)
    ).toBe(true);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings).toEqual([]);
  });
});
