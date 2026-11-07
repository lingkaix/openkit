import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OperationOutput, SERVER_MCP_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { users } from '../storage/schema/index.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { getVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real Core records, encrypted material, native admission and durable receipt owner. */
function fixture(closeServerMcpSessions?: () => Promise<void>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-mcp-administration-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
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
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 11) });
  cleanup.push(() => vaultUnlockState.lock());
  const manager = createRuntimeConfigManager({ dataRoot });
  const dependencies = {
    runtimeConfigManager: manager,
    ...(closeServerMcpSessions ? { closeServerMcpSessions } : {}),
    coreDb,
    dataRoot,
    store,
    inflightCommands: new WeakMap(),
    vaultUnlockState,
  };
  const invoke = createOperationInvocation(dependencies);
  const call = <K extends keyof typeof SERVER_MCP_OPERATION_DEFINITIONS>(
    operation: K,
    input: Record<string, unknown> = {},
    currentActor = actor
  ) =>
    invoke(
      operation,
      {
        ...input,
        ...(SERVER_MCP_OPERATION_DEFINITIONS[operation].mutating
          ? { requestId: input.requestId ?? randomUUID() }
          : {}),
      } as never,
      { kind: 'public', actor: currentActor }
    ) as Promise<OperationOutput<K>>;
  return { ...dependencies, actor, token, call, backend: vaultUnlockState.backend() };
}

const declaration = { kind: 'http', endpoint: 'https://mcp.example.test/mcp' };
const creation = {
  id: 'shared',
  displayName: 'Shared',
  allowedTools: ['echo'],
  declaration,
  expectedRevision: 0,
};

describe('Server MCP administration owner and recovery', () => {
  it.each(['https://ordinary-user:plain-password@example.invalid/mcp', 'not-a-url'])(
    'refuses invalid endpoints before catalog publication: %s',
    async (endpoint) => {
      const f = fixture();
      const path = join(f.dataRoot, 'server/catalog/catalog.json');
      const before = existsSync(path) ? readFileSync(path) : null;
      await expect(
        f.call('administration.server-mcp-create', {
          ...creation,
          declaration: {
            kind: 'http',
            endpoint,
          },
        })
      ).rejects.toMatchObject({ status: 400 });
      expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
      expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.entries).toEqual([]);
    }
  );
  it('admits the current administrator Web session and denies ordinary or revoked sessions', async () => {
    const f = fixture();
    const session: Actor = {
      kind: 'session',
      userId: f.actor.userId,
      adminTokenId: f.token.tokenId,
    };
    const requestId = randomUUID();
    await expect(
      f.call('administration.server-mcp-create', { ...creation, requestId }, session)
    ).resolves.toMatchObject({ revision: 1 });
    await expect(f.call('administration.server-mcp-list', {}, session)).resolves.toMatchObject({
      revision: 1,
    });
    const ordinaryUserId = testEntityId('usr', 'ordinary-shared-mcp-administrator-test');
    f.coreDb.db
      .insert(users)
      .values({
        id: ordinaryUserId,
        displayName: 'Ordinary synthetic user',
        email: `${ordinaryUserId}@openkit.invalid`,
      })
      .run();
    await expect(
      f.call('administration.server-mcp-list', {}, { kind: 'session', userId: ordinaryUserId })
    ).rejects.toMatchObject({ status: 403 });
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(f.call('administration.server-mcp-list', {}, session)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      f.call('administration.server-mcp-create', { ...creation, requestId }, session)
    ).rejects.toMatchObject({ status: 403 });
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).revision).toBe(1);
  });

  it('creates disabled supply, stages without selection, selects by CAS and replays the current resource without another effect', async () => {
    const f = fixture();
    const requestId = randomUUID();
    const reload = vi.spyOn(f.runtimeConfigManager, 'reload').mockImplementation(() => {
      throw new Error('Synthetic unrelated configuration failure.');
    });
    const created = await f.call('administration.server-mcp-create', { ...creation, requestId });
    expect(created.entry).toMatchObject({
      enabled: false,
      currentVersionDigest: created.versionDigest,
    });
    const staged = await f.call('administration.server-mcp-stage-version', {
      ...creation,
      mcpId: 'shared',
      declaration: { ...declaration, endpoint: 'https://mcp.example.test/next' },
      expectedRevision: 1,
    });
    expect(staged.entry.currentVersionDigest).toBe(created.versionDigest);
    expect((await f.call('administration.server-mcp-read', { mcpId: 'shared' })).versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          digest: created.versionDigest,
          declaration: { ...declaration, headers: {} },
        }),
      ])
    );
    expect(staged.versionDigest).not.toBe(created.versionDigest);
    await f.call('administration.server-mcp-select-version', {
      mcpId: 'shared',
      digest: staged.versionDigest,
      expectedRevision: 2,
    });
    const replay = await f.call('administration.server-mcp-create', { ...creation, requestId });
    expect(replay).toMatchObject({
      revision: 3,
      versionDigest: created.versionDigest,
      entry: { currentVersionDigest: staged.versionDigest },
    });
    await expect(
      f.call('administration.server-mcp-create', { ...creation, displayName: 'Changed', requestId })
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_key_conflict' });
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).revision).toBe(3);
    await f.call('administration.server-mcp-update-binding', {
      mcpId: 'shared',
      expectedRevision: 3,
      bindingRevision: 1,
      enabled: true,
      allowedTools: ['echo'],
      schemaPolicy: 'tracking',
    });
    await f.call('administration.server-mcp-remove', { mcpId: 'shared', expectedRevision: 4 });
    expect(
      (await f.call('administration.server-mcp-read', { mcpId: 'shared' })).entry.availability
    ).toBe('removed');
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.versions).toHaveLength(2);
    expect(
      loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings.find(
        (binding) => binding.entryId === 'shared'
      )?.enabled
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('rotates material without changing identity, narrows by replacement, and revokes without exposing material', async () => {
    const f = fixture();
    const canary = 'synthetic-shared-mcp-material';
    const reference = await f.call('vault.server-mcp-secret-create', { material: canary });
    const rotated = await f.call('vault.server-mcp-secret-rotate', {
      referenceId: reference.referenceId,
      material: `${canary}-next`,
    });
    expect(rotated).toMatchObject({ referenceId: reference.referenceId, currentVersion: 2 });
    const grant = await f.call('vault.server-mcp-grant-create', {
      referenceId: reference.referenceId,
    });
    const narrowed = await f.call('vault.server-mcp-grant-narrow', {
      grantId: grant.grantId,
      constraints: { targetCapabilityId: 'mcp.call-tool' },
    });
    expect(narrowed.revokedGrant.status).toBe('revoked');
    expect(narrowed.grant).toMatchObject({
      targetCapabilityId: 'mcp.call-tool',
      ownerScope: 'server',
      lifetime: 'server',
    });
    expect(narrowed.grant.grantId).not.toBe(grant.grantId);
    expect(listServerAuditEvents(f.coreDb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: `vault-grant:${grant.grantId}`,
          vaultGrantId: narrowed.grant.grantId,
          actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
        }),
      ])
    );
    const revoked = await f.call('vault.server-mcp-grant-revoke', {
      grantId: narrowed.grant.grantId,
    });
    expect(revoked.status).toBe('revoked');
    const removed = await f.call('vault.server-mcp-secret-revoke', {
      referenceId: reference.referenceId,
    });
    expect(removed.status).toBe('revoked');
    const projection = await f.call('vault.server-mcp-reference-list');
    expect(
      JSON.stringify({
        projection,
        audit: listServerAuditEvents(f.coreDb),
        receipts: f.store.listCommandRequests(),
      })
    ).not.toContain(canary);
    expect(
      listServerAuditEvents(f.coreDb).filter(
        (event) => event.action === 'vault.server-mcp-grant-narrow'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
          outcome: 'succeeded',
        }),
      ])
    );
  });

  it('excludes Provider and bootstrap Server references from every shared-MCP lifecycle', async () => {
    const f = fixture();
    const referenceId = testEntityId('vault', 'excluded-server-provider-reference');
    f.backend.store({
      referenceId,
      material: 'synthetic-provider-material',
      metadata: { ownerScope: 'server' },
    });
    await createVaultReference(f.coreDb, {
      referenceId,
      ownerScope: 'server',
      secretKind: 'provider-api-key',
      displayName: 'Provider',
      backendKind: f.backend.kind,
    });
    const rotate = vi.spyOn(f.backend, 'rotate');
    const revoke = vi.spyOn(f.backend, 'revoke');
    expect((await f.call('vault.server-mcp-reference-list')).items).toEqual([]);
    await expect(
      f.call('vault.server-mcp-secret-rotate', { referenceId, material: 'replacement' })
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.call('vault.server-mcp-secret-revoke', { referenceId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(f.call('vault.server-mcp-grant-create', { referenceId })).rejects.toMatchObject({
      status: 404,
    });
    expect(rotate).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('rechecks the administrator on replay and refuses Workspace-only credentials before effects', async () => {
    const f = fixture();
    const requestId = randomUUID();
    await f.call('administration.server-mcp-create', { ...creation, requestId });
    const workspace = await f.store.createWorkspace('Ordinary member');
    const member = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const memberActor: Actor = {
      kind: 'token',
      userId: FIXTURE_LOCAL_USER_ID,
      tokenScope: 'workspace',
      tokenId: member.tokenId,
    };
    await expect(
      f.call('vault.server-mcp-secret-create', { material: 'synthetic-member' }, memberActor)
    ).rejects.toMatchObject({ status: 403 });
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(
      f.call('administration.server-mcp-create', { ...creation, requestId })
    ).rejects.toMatchObject({ status: 403 });
    expect(f.backend.listReferences()).toEqual([]);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).revision).toBe(1);
  });

  it('rolls back both grant replacement and revocation if the required linked Audit cannot commit', async () => {
    const f = fixture();
    const reference = await f.call('vault.server-mcp-secret-create', {
      material: 'synthetic-audit-bound-material',
    });
    const grant = await f.call('vault.server-mcp-grant-create', {
      referenceId: reference.referenceId,
    });
    f.coreDb.sqlite.exec(`CREATE TRIGGER fail_server_mcp_linked_narrow_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN NEW.action = 'vault.server-mcp-grant-narrow'
        AND COALESCE(NEW.vault_grant_id, '') <> ''
      BEGIN SELECT RAISE(ABORT, 'Synthetic linked Audit failure.'); END`);
    await expect(
      f.call('vault.server-mcp-grant-narrow', {
        grantId: grant.grantId,
        constraints: { targetCapabilityId: 'mcp.call-tool' },
      })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    const inventory = await f.call('vault.server-mcp-grant-list');
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      grantId: grant.grantId,
      status: 'active',
      targetCapabilityId: null,
    });
  });

  it.each([true, false])(
    'keeps Server grant revocation atomic before session closure (fault: %s)',
    async (fault) => {
      const close = vi.fn(async () => {});
      const f = fixture(close);
      const upstream = await createMcpHttpStub();
      cleanup.push(() => upstream.close());
      const reference = await f.call('vault.server-mcp-secret-create', {
        material: 'synthetic-atomic-revocation',
      });
      const grant = await f.call('vault.server-mcp-grant-create', {
        referenceId: reference.referenceId,
      });
      const created = await f.call('administration.server-mcp-create', {
        ...creation,
        declaration: { kind: 'http', endpoint: upstream.url },
      });
      // Actual delivery creates the plan and receipt through their owners.
      await f.call('administration.mcp-discovery-preview', {
        catalogScope: { kind: 'server' },
        mcpId: created.entry.id,
        versionDigest: created.versionDigest,
        expectedRevision: created.revision,
        expectedBindingRevision: created.entry.bindingRevision,
        timeoutMs: 2000,
        credentialBindings: [
          {
            slot: 'authorization',
            vaultGrantId: grant.grantId,
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      });
      const observer = openCoreDb(f.dataRoot);
      cleanup.push(() => observer.sqlite.close());
      const read = () => ({
        grant: getVaultGrant(observer, grant.grantId),
        plans: listVaultInjectionPlans(observer),
        receipts: listVaultInjectionReceipts(observer),
      });
      const before = read();
      expect(before.grant?.status).toBe('active');
      expect(before.plans).toMatchObject([{ grantId: grant.grantId, status: 'active' }]);
      expect(before.receipts).toMatchObject([
        { grantId: grant.grantId, revocationStatus: 'active' },
      ]);
      const committed = {
        grant: { ...before.grant, status: 'revoked' },
        plans: before.plans.map((plan) => ({ ...plan, status: 'revoked' })),
        receipts: before.receipts.map((receipt) => ({
          ...receipt,
          revocationStatus: 'revoked',
        })),
      };
      const atClose: ReturnType<typeof read>[] = [];
      close.mockClear();
      close.mockImplementation(async () => {
        // A separate connection cannot mistake pending writes for committed state.
        atClose.push(read());
      });
      if (fault) {
        // Fault only after valid setup, between grant/plan updates and receipt completion.
        f.coreDb.sqlite.exec(`CREATE TRIGGER fail_server_mcp_receipt_revocation
          BEFORE UPDATE OF revocation_status ON vault_injection_receipts
          BEGIN SELECT RAISE(ABORT, 'Synthetic receipt revocation failure'); END`);
        await expect(
          f.call('vault.server-mcp-grant-revoke', { grantId: grant.grantId })
        ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
        expect(close).not.toHaveBeenCalled();
        // Vault Backend Implementation: grant-only revocation uses one Core transaction.
        expect(read()).toEqual(before);
      } else {
        await expect(
          f.call('vault.server-mcp-grant-revoke', { grantId: grant.grantId })
        ).resolves.toMatchObject({ grantId: grant.grantId, status: 'revoked' });
        // Core Storage publication follows commit; Vault preserves completion history.
        expect(atClose).toEqual([committed]);
        expect(read()).toEqual(committed);
      }
    }
  );

  it('retains saved catalog authority and fences a missing receipt when session cleanup fails', async () => {
    const close = vi.fn(async () => {
      throw new Error('Synthetic transport cleanup failure.');
    });
    const f = fixture(close);
    const requestId = randomUUID();
    await expect(
      f.call('administration.server-mcp-create', { ...creation, requestId })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    const current = await f.call('administration.server-mcp-read', { mcpId: 'shared' });
    expect(current).toMatchObject({ revision: 1, entry: { enabled: false, id: 'shared' } });
    await expect(
      f.call('administration.server-mcp-create', { ...creation, requestId })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' }).revision).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fences a lost receipt after actual backend and Core effects instead of storing or repeating request material', async () => {
    const f = fixture();
    const requestId = randomUUID();
    const material = 'synthetic-unknown-shared-mcp';
    // Fail the actual separate native receipt INSERT after the backend and Core stages commit.
    f.coreDb.sqlite.exec(`CREATE TRIGGER fail_server_mcp_command_receipt
      BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name = 'vault.server-mcp-secret-create'
      BEGIN SELECT RAISE(ABORT, 'Synthetic receipt interruption.'); END`);
    try {
      await expect(
        f.call('vault.server-mcp-secret-create', { requestId, material })
      ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    } finally {
      f.coreDb.sqlite.exec('DROP TRIGGER fail_server_mcp_command_receipt');
    }
    expect(f.backend.listReferences()).toHaveLength(1);
    expect((await f.call('vault.server-mcp-reference-list')).items).toHaveLength(1);
    await expect(
      f.call('vault.server-mcp-secret-create', { requestId, material })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    expect(f.backend.listReferences()).toHaveLength(1);
    expect(
      JSON.stringify({
        events: listServerAuditEvents(f.coreDb),
        receipts: f.store.listCommandRequests(),
      })
    ).not.toContain(material);
  });
});
