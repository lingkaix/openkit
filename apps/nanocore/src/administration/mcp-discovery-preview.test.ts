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
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { recordVaultAuditEvent } from '../vault/vault-admin-audit-events.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

// F1 fault-owner adapter: the same real after-INSERT rollback seam as the sealed
// standalone-Audit observer, scoped to this original preview identity and otherwise disarmed.
const nativeStartupFault = vi.hoisted(
  () => new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT)
);
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const prelude = `
          const {workerData}=require('node:worker_threads');
          const Database=require(workerData.previewAuditSqlModule);
          const gate=workerData.previewAuditFault;
          const originalPrepare=Database.prototype.prepare;
          Database.prototype.prepare=function(sql) {
            const statement=originalPrepare.call(this,sql);
            if (!/^\\s*INSERT\\s+INTO\\s+audit_events\\b/i.test(sql)) return statement;
            const run=statement.run.bind(statement);
            statement.run=(...args)=>{
              const result=run(...args);
              if (Atomics.load(gate,0)!==1) return result;
              const rowid=originalPrepare.call(this,'SELECT last_insert_rowid() AS id').get().id;
              const row=originalPrepare.call(this,
                'SELECT action,outcome,resource FROM audit_events WHERE rowid=?').get(rowid);
              if (row && row.action==='mcp.server.lifecycle.starting' &&
                  row.outcome==='succeeded' && row.resource==='mcp-server:preview-example' &&
                  Atomics.compareExchange(gate,0,1,0)===1) {
                Atomics.add(gate,1,1);
                Atomics.store(gate,2,this.pragma('synchronous',{simple:true}));
                Atomics.store(gate,3,this.inTransaction ? 1 : 0);
                // Real original INSERT ran; the actual native transaction must roll it back.
                throw new Error('injected failure after real original Audit INSERT');
              }
              return result;
            };
            return statement;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            previewAuditSqlModule: require.resolve('better-sqlite3'),
            previewAuditFault: new Int32Array(nativeStartupFault),
          },
        });
      }
    },
  };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
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
    applyScopedMigrations(db, undefined, 'pre-knowledge');
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
  it('refuses imported grant provenance in the second binding before resolving any material', async () => {
    const f = fixture();
    const upstream = await createMcpHttpStub();
    cleanup.push(() => upstream.close());
    const input = await seed(f, upstream.url);
    const credentialBindings: Array<{
      slot: string;
      vaultGrantId: string;
      sink: { kind: 'header'; name: string };
    }> = [];
    for (const index of [0, 1]) {
      const reference = await f.call('vault.server-mcp-secret-create', {
        requestId: randomUUID(),
        material: randomUUID(),
      });
      const grant = await f.call('vault.server-mcp-grant-create', {
        requestId: randomUUID(),
        referenceId: reference.referenceId,
        targetCapabilityId: 'mcp.list-tools',
      });
      credentialBindings.push({
        slot: `preview-${index}`,
        vaultGrantId: String(grant.grantId),
        sink: { kind: 'header', name: `X-Preview-${index}` },
      });
    }
    const importedGrantId = credentialBindings[1]!.vaultGrantId;
    expect(getVaultGrant(f.coreDb, importedGrantId)).toMatchObject({
      issuance: 'target',
      status: 'active',
    });
    // No Server importer exists. Fault only canonical provenance after normal owner issuance.
    f.coreDb.sqlite
      .prepare("UPDATE vault_grants SET issuance = 'imported-history' WHERE grant_id = ?")
      .run(importedGrantId);
    expect(getVaultGrant(f.coreDb, importedGrantId)).toMatchObject({
      grantId: importedGrantId,
      issuance: 'imported-history',
      status: 'active',
    });
    const resolve = vi.spyOn(f.vaultUnlockState.backend(), 'resolve');
    const result = await f
      .call('administration.mcp-discovery-preview', { ...input, credentialBindings })
      .catch((error: unknown) => error);

    // Vault Grant Shape: target-looking identity cannot promote imported-history issuance.
    expect(resolve).not.toHaveBeenCalled();
    expect(listVaultUseRecords(f.coreDb)).toEqual([]);
    expect(upstream.observed).toEqual([]);
    expect(result).toMatchObject({ status: 403 });
  });

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
    const workspace = await f.store.createWorkspace('Workspace preview');
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
  it('removes allocated temporary data after a real stdio initialization exit', async () => {
    // MCP Catalog Management / Explicit Bounded Discovery Preview requires cleanup after proved closure.
    const f = fixture();
    const contextPath = join(f.dataRoot, 'failed-stdio-context.json');
    const callsPath = join(f.dataRoot, 'failed-calls.log');
    const created = await f.call('administration.server-mcp-create', {
      requestId: randomUUID(),
      id: 'preview-stdio-init-exit',
      displayName: 'Failing stdio preview',
      allowedTools: [],
      expectedRevision: 0,
      declaration: {
        kind: 'stdio',
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url)),
          callsPath,
        ],
        environment: {
          OPENKIT_MCP_PREVIEW_CONTEXT_FILE: contextPath,
          OPENKIT_MCP_INIT_EXIT: '1',
        },
      },
    });
    const catalogPath = join(f.dataRoot, 'server/catalog/catalog.json');
    const before = readFileSync(catalogPath);
    const started = Date.now();

    await expect(
      f.call('administration.mcp-discovery-preview', {
        catalogScope: { kind: 'server' },
        mcpId: 'preview-stdio-init-exit',
        versionDigest: created.versionDigest,
        expectedRevision: 1,
        expectedBindingRevision: null,
        timeoutMs: 5000,
        credentialBindings: [],
      })
    ).rejects.toMatchObject({ status: 503 });

    expect(Date.now() - started).toBeLessThan(5000);
    // The real child writes this witness before it exits, after using its allocated data root.
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
      pid: number;
      cwd: string;
      dataDirectory: string;
    };
    // Reclaim residue after a failed cleanup assertion, including the intentional omission mutant.
    cleanup.push(() => rmSync(context.dataDirectory, { recursive: true, force: true }));
    expect(context.cwd).toBe(context.dataDirectory);
    expect(context.dataDirectory.startsWith(join(tmpdir(), 'openkit-mcp-preview-'))).toBe(true);
    expect(existsSync(context.dataDirectory)).toBe(false);
    try {
      process.kill(context.pid, 0);
      throw new Error('Failed stdio fixture process remained live.');
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
    // This case owns HTTP teardown; prepare the real native Audit owner before its unchanged 300ms request.
    await recordVaultAuditEvent({
      coreDb: f.coreDb,
      action: 'administration.mcp-discovery-preview',
      resource: 'mcp:preview-example',
      outcome: 'succeeded',
      summary: 'Native Audit owner is ready for the temporary teardown fixture.',
    });
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
      targetCapabilityId: 'mcp.list-tools',
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
    const fault = new Int32Array(nativeStartupFault);
    fault.fill(0);
    Atomics.store(fault, 0, 1);
    try {
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
      // Admission proof for the fault instrument, not an alternative semantic predicate.
      expect(Atomics.load(fault, 1)).toBe(1);
      expect(Atomics.load(fault, 2)).toBe(2);
      expect(Atomics.load(fault, 3)).toBe(1);
    } finally {
      Atomics.store(fault, 0, 0);
      console.info(
        'F1_NATIVE_ROLLBACK',
        JSON.stringify({
          selectedInserts: Atomics.load(fault, 1),
          synchronous: Atomics.load(fault, 2),
          outerTransaction: Atomics.load(fault, 3),
          upstreamRequests: upstream.observed.length,
        })
      );
    }
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
      targetCapabilityId: 'mcp.list-tools',
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

// mcp_catalog_management.md Explicit Bounded Discovery Preview requires current authority at disclosure.
it.each([
  'administrator',
  'catalog',
  'grant',
  'material',
  'deadline',
] as const)('refuses %s withdrawal during the real terminal preview Audit ACK and retains delivered evidence', async (withdrawal) => {
  const { Worker } = await import('node:worker_threads');
  const f = fixture();
  const upstream = await createMcpHttpStub();
  cleanup.push(() => upstream.close());
  const input = await seed(f, upstream.url);
  const reference = await f.call('vault.server-mcp-secret-create', {
    requestId: randomUUID(),
    material: 'synthetic-terminal-preview',
  });
  const grant = await f.call('vault.server-mcp-grant-create', {
    requestId: randomUUID(),
    referenceId: reference.referenceId,
    targetCapabilityId: 'mcp.list-tools',
  });
  const emit = Worker.prototype.emit;
  let deliver: (() => void) | undefined;
  let held = false;
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: InstanceType<typeof Worker>,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const reply = args[0] as
      | {
          operation?: string;
          status?: string;
          result?: { kind?: string; value?: { action?: string; requestId?: string } };
        }
      | undefined;
    // Startup has no receipt. Delivery has a different action. This selects the actual terminal ACK.
    if (
      !held &&
      event === 'message' &&
      reply?.operation === 'vault' &&
      reply.status === 'ok' &&
      reply.result?.kind === 'audit-insert' &&
      reply.result.value?.action === 'administration.mcp-discovery-preview' &&
      listVaultInjectionReceipts(f.coreDb).some((receipt) => receipt.grantId === grant.grantId)
    ) {
      held = true;
      deliver = () => {
        emit.call(this, event, ...args);
      };
      markReached();
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const release = () => {
    const pending = deliver;
    deliver = undefined;
    pending?.();
  };
  cleanup.push(release);
  let settled = false;
  const outcome = f
    .call('administration.mcp-discovery-preview', {
      ...input,
      credentialBindings: [
        {
          slot: 'authorization',
          vaultGrantId: grant.grantId,
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    })
    .then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      }
    );
  try {
    await Promise.race([
      reached,
      outcome.then(() => {
        throw new Error('Preview settled before its real terminal Audit ACK.');
      }),
    ]);
    expect(settled).toBe(false);
    expect(upstream.observed.filter((name) => name.endsWith('|tools/list'))).toHaveLength(1);
    expect(upstream.observed.some((name) => name.endsWith('|DELETE|'))).toBe(true);
    expect(upstream.observed.some((name) => name.endsWith('|tools/call'))).toBe(false);
    expect(
      upstream.observedHeaders.some(
        (headers) => headers.get('authorization') === 'synthetic-terminal-preview'
      )
    ).toBe(true);
    const usesBefore = listVaultUseRecords(f.coreDb);
    expect(usesBefore).toMatchObject([
      { outcome: 'succeeded', vaultReferenceId: reference.referenceId },
    ]);
    const receiptsBefore = listVaultInjectionReceipts(f.coreDb);
    expect(receiptsBefore).toHaveLength(1);
    expect(receiptsBefore[0]).toMatchObject({ grantId: grant.grantId });
    const deliveryBefore = auditEvents
      .listSqliteAuditEvents(f.coreDb.sqlite)
      .filter((event) => event.action === 'administration.mcp-discovery-preview.delivery');
    expect(deliveryBefore).toHaveLength(1);
    expect(deliveryBefore[0]).toMatchObject({ outcome: 'succeeded' });
    const contacts = upstream.observed.length;
    if (withdrawal === 'administrator') revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    else if (withdrawal === 'catalog')
      await f.call('administration.server-mcp-remove', {
        requestId: randomUUID(),
        mcpId: input.mcpId,
        expectedRevision: input.expectedRevision,
      });
    else if (withdrawal === 'grant')
      await f.call('vault.server-mcp-grant-revoke', {
        requestId: randomUUID(),
        grantId: grant.grantId,
      });
    else if (withdrawal === 'material') {
      // Material withdrawal is owned by this backend; unrelated runtime closure is not this oracle.
      const revoked = f.vaultUnlockState
        .backend()
        .revoke({ referenceId: String(reference.referenceId) });
      expect(revoked.revoked).toBe(true);
      expect(() =>
        f.vaultUnlockState.backend().resolve({ referenceId: String(reference.referenceId) })
      ).toThrow();
    } else {
      // The real whole-operation timeout started before the held terminal ACK; wait past it.
      await new Promise<void>((resolve) => setTimeout(resolve, input.timeoutMs + 20));
    }
    expect(settled).toBe(false);
    release();
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Preview disclosed an observation after authority ended.');
    expect(result.error).toHaveProperty('status');
    if (withdrawal === 'deadline') expect(result.error).toMatchObject({ status: 503 });
    expect(result).not.toHaveProperty('value');
    expect(upstream.observed).toHaveLength(contacts);
    expect(listVaultUseRecords(f.coreDb)).toEqual(usesBefore);
    expect(
      auditEvents
        .listSqliteAuditEvents(f.coreDb.sqlite)
        .filter((event) => event.action === 'administration.mcp-discovery-preview.delivery')
    ).toEqual(deliveryBefore);
    // Revocation may advance its lifecycle projection. Original successful delivery facts must survive.
    const completionFacts = (receipts: ReturnType<typeof listVaultInjectionReceipts>) =>
      receipts.map(({ revocationStatus: _status, ...facts }) => facts);
    expect(completionFacts(listVaultInjectionReceipts(f.coreDb))).toEqual(
      completionFacts(receiptsBefore)
    );
  } finally {
    release();
    await outcome;
    spy.mockRestore();
  }
});
