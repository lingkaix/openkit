// openkit-test-platform: posix
// The stdio termination oracle requires POSIX process-probe ESRCH semantics.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditEvents from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

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
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: FIXTURE_LOCAL_USER_ID,
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
  const workspaceDbs: Array<ReturnType<typeof openWorkspaceDb>> = [];
  const repositoryWorkspaceDb = (workspaceId: string) => {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(db);
    workspaceDbs.push(db);
    // This fallback reclaims a failing subject; assertions below prove request closure before teardown.
    cleanup.push(() => {
      if (db.sqlite.open) db.sqlite.close();
    });
    return db;
  };
  const invoke = createOperationInvocation({
    coreDb,
    dataRoot,
    store,
    repositoryWorkspaceDb,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    inflightCommands: new WeakMap(),
    vaultUnlockState,
  });
  const call = (operation: string, input: unknown, currentActor = actor) =>
    invoke(operation as never, input as never, { kind: 'public', actor: currentActor }) as Promise<
      Record<string, unknown>
    >;
  return {
    dataRoot,
    coreDb,
    token,
    actor,
    call,
    store,
    repositoryWorkspaceDb,
    workspaceDbs,
    vaultUnlockState,
  };
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
  it('uses exact Workspace scope and refuses a registry-deleted Workspace before resolution or contact', async () => {
    const f = fixture();
    const workspace = f.store.createWorkspace('Workspace preview');
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: workspace.id,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const created = await f.call('catalog.mcp-create', {
      requestId: randomUUID(),
      workspaceId: workspace.id,
      id: 'workspace-preview',
      displayName: 'Workspace preview',
      allowedTools: [],
      expectedRevision: 0,
      declaration: { kind: 'http', endpoint: upstream.url },
    });
    const reference = await f.call('vault.secret-create', {
      workspaceId: workspace.id,
      secretKind: 'mcp-credential',
      material: 'preview-fake-workspace-canary',
    });
    const grant = await f.call('vault.grant-create', {
      workspaceId: workspace.id,
      referenceId: reference.referenceId,
      injectionPath: 'gateway-only',
    });
    const input = {
      catalogScope: { kind: 'workspace', workspaceId: workspace.id },
      mcpId: 'workspace-preview',
      versionDigest: created.versionDigest,
      expectedRevision: 1,
      expectedBindingRevision: null,
      timeoutMs: 2000,
      credentialBindings: [
        {
          slot: 'authorization',
          vaultGrantId: grant.grantId,
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    };
    const catalogPath = join(f.dataRoot, 'workspaces', workspace.id, 'catalog/catalog.json');
    const before = readFileSync(catalogPath);
    const readUses = () => {
      const db = f.repositoryWorkspaceDb(workspace.id);
      try {
        return listVaultUseRecords(db);
      } finally {
        db.sqlite.close();
      }
    };
    const result = await f.call('administration.mcp-discovery-preview', input);
    expect(f.workspaceDbs.length).toBeGreaterThan(0);
    expect(f.workspaceDbs.every((db) => !db.sqlite.open)).toBe(true);
    expect(f.coreDb.sqlite.open).toBe(true);
    expect(result.tools).toMatchObject([{ name: 'echo' }]);
    expect(
      upstream.observedHeaders.some(
        (headers) => headers.get('authorization') === 'preview-fake-workspace-canary'
      )
    ).toBe(true);
    expect(readUses()).toMatchObject([
      { ownerScope: 'workspace', workspaceId: workspace.id, outcome: 'succeeded' },
    ]);
    expect(readFileSync(catalogPath)).toEqual(before);
    const beforeFailure = upstream.observed.length;
    const resolution = vi
      .spyOn(f.vaultUnlockState.backend()!, 'resolve')
      .mockImplementationOnce(() => {
        throw new Error('Synthetic material resolution failure');
      });
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 503,
    });
    resolution.mockRestore();
    expect(upstream.observed).toHaveLength(beforeFailure);
    expect(f.workspaceDbs.every((db) => !db.sqlite.open)).toBe(true);
    expect(f.coreDb.sqlite.open).toBe(true);
    const contacts = upstream.observed.length;
    const uses = readUses().length;
    f.coreDb.sqlite
      .prepare("UPDATE workspace_registry SET status = 'deleted' WHERE workspace_id = ?")
      .run(workspace.id);
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 404,
    });
    expect(upstream.observed).toHaveLength(contacts);
    expect(readUses()).toHaveLength(uses);
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
  it.each([
    'grant',
    'administrator',
    'catalog',
  ] as const)('rejects %s authority changed during actual discovery', async (changed) => {
    const f = fixture();
    let entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = await createMcpHttpStub({
      beforeList: async () => {
        entered();
        await held;
      },
    });
    cleanup.push(() => upstream.close());
    cleanup.push(() => release());
    const input = await seed(f, upstream.url);
    const reference = await f.call('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material: 'preview-fake-material-canary',
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
    });
    const result = f.call('administration.mcp-discovery-preview', {
      ...input,
      timeoutMs: 5000,
      credentialBindings: [
        {
          slot: 'authorization',
          vaultGrantId: grant.grantId,
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    });
    // Observe a rejection immediately so an early setup failure cannot become an unhandled promise.
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await seen;
    if (changed === 'grant')
      await f.call('vault.server-mcp-grant-revoke', {
        requestId: randomUUID(),
        grantId: grant.grantId,
      });
    else if (changed === 'administrator') revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    else
      await f.call('administration.server-mcp-remove', {
        requestId: randomUUID(),
        mcpId: input.mcpId,
        expectedRevision: input.expectedRevision,
      });
    release();
    expect(await outcome).toMatchObject({ error: { status: changed === 'catalog' ? 409 : 403 } });
    expect(upstream.observed.filter((name) => name.endsWith('|tools/list'))).toHaveLength(1);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(listVaultInjectionReceipts(f.coreDb)).toHaveLength(1);
  });
  it('bounds the whole operation while an upstream list is held and never returns a partial observation', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = await createMcpHttpStub({ beforeList: () => held });
    cleanup.push(() => upstream.close());
    cleanup.push(() => release());
    const input = await seed(f, upstream.url);
    const started = Date.now();
    await expect(
      f.call('administration.mcp-discovery-preview', { ...input, timeoutMs: 300 })
    ).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(5000);
    release();
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
  });
  it('closes a real stdio process and removes its temporary data without creating Workspace process state', async () => {
    const f = fixture();
    const contextPath = join(f.dataRoot, 'stdio-context.json');
    const callsPath = join(f.dataRoot, 'calls.log');
    const created = await f.call('administration.server-mcp-create', {
      requestId: randomUUID(),
      id: 'preview-stdio',
      displayName: 'Stdio preview',
      allowedTools: [],
      expectedRevision: 0,
      declaration: {
        kind: 'stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url)),
          callsPath,
        ],
        environment: { OPENKIT_MCP_PREVIEW_CONTEXT_FILE: contextPath },
      },
    });
    const catalogPath = join(f.dataRoot, 'server/catalog/catalog.json');
    const before = readFileSync(catalogPath);
    const result = await f.call('administration.mcp-discovery-preview', {
      catalogScope: { kind: 'server' },
      mcpId: 'preview-stdio',
      versionDigest: created.versionDigest,
      expectedRevision: 1,
      expectedBindingRevision: null,
      timeoutMs: 5000,
      credentialBindings: [],
    });
    expect(result.tools).toMatchObject([{ name: 'echo' }]);
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
      pid: number;
      cwd: string;
      dataDirectory: string;
      packageRoot: null;
    };
    expect(context.cwd).toBe(context.dataDirectory);
    expect(context.packageRoot).toBeNull();
    expect(context.dataDirectory.startsWith(join(tmpdir(), 'openkit-mcp-preview-'))).toBe(true);
    expect(existsSync(context.dataDirectory)).toBe(false);
    try {
      process.kill(context.pid, 0);
      throw new Error('Stdio fixture process remained live.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' });
    }
    expect(existsSync(callsPath)).toBe(false);
    expect(readFileSync(catalogPath)).toEqual(before);
    expect(existsSync(join(f.dataRoot, 'server/catalog/mcp-data'))).toBe(false);
    expect(existsSync(join(f.dataRoot, 'workspaces/server'))).toBe(false);
  });
  it('returns recovery_required when temporary HTTP teardown is unproved', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub({ hangDelete: true });
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const catalogPath = join(f.dataRoot, 'server/catalog/catalog.json');
    const before = readFileSync(catalogPath);
    await expect(
      f.call('administration.mcp-discovery-preview', { ...input, timeoutMs: 300 })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    expect(upstream.observed.filter((name) => name.endsWith('|tools/list'))).toHaveLength(1);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(readFileSync(catalogPath)).toEqual(before);
  });
  it('rejects an oversized live tool list without publishing a partial observation', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub({ credentialListEcho: 'x'.repeat(512 * 1024) });
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 503,
    });
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings).toEqual([]);
  });
  it('bounds the complete observation including upstream initialization metadata', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub({ serverVersion: 'x'.repeat(512 * 1024) });
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    await expect(f.call('administration.mcp-discovery-preview', input)).rejects.toMatchObject({
      status: 503,
      message: 'MCP preview observation exceeds the response limit.',
    });
    expect(upstream.observed.filter((name) => name.endsWith('|tools/list'))).toHaveLength(1);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(upstream.observed.some((name) => name.includes('|DELETE|'))).toBe(true);
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
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
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
