import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OperationOutput, SERVER_MCP_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditEvents from '../audit-events.js';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { users } from '../storage/schema/index.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
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
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
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
    const ordinaryUserId = randomUUID();
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
      constraints: { targetCapabilityId: 'mcp.call_tool' },
    });
    expect(narrowed.revokedGrant.status).toBe('revoked');
    expect(narrowed.grant).toMatchObject({
      targetCapabilityId: 'mcp.call_tool',
      ownerScope: 'server',
      lifetime: 'server',
    });
    expect(narrowed.grant.grantId).not.toBe(grant.grantId);
    expect(listServerAuditEvents(f.coreDb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: `vault-grant:${grant.grantId}`,
          vaultGrantId: narrowed.grant.grantId,
          actor: { kind: 'user', id: 'user_local' },
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
          actor: { kind: 'user', id: 'user_local' },
          outcome: 'succeeded',
        }),
      ])
    );
  });

  it('excludes Provider and bootstrap Server references from every shared-MCP lifecycle', async () => {
    const f = fixture();
    const referenceId = `vault_${randomUUID()}`;
    f.backend.store({
      referenceId,
      material: 'synthetic-provider-material',
      metadata: { ownerScope: 'server' },
    });
    createVaultReference(f.coreDb, {
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
    const workspace = f.store.createWorkspace('Ordinary member');
    const member = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const memberActor: Actor = {
      kind: 'token',
      userId: 'user_local',
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
    const record = auditEvents.recordServerAuditEvent;
    vi.spyOn(auditEvents, 'recordServerAuditEvent').mockImplementation((input) => {
      if (input.action === 'vault.server-mcp-grant-narrow' && input.vaultGrantId)
        throw new Error('Synthetic linked Audit failure.');
      return record(input);
    });
    await expect(
      f.call('vault.server-mcp-grant-narrow', {
        grantId: grant.grantId,
        constraints: { targetCapabilityId: 'mcp.call_tool' },
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
    const write = vi.spyOn(f.store, 'recordCommandRequest').mockImplementationOnce(() => {
      throw new Error('Synthetic receipt interruption.');
    });
    await expect(
      f.call('vault.server-mcp-secret-create', { requestId, material })
    ).rejects.toMatchObject({ status: 409, code: 'recovery_required' });
    write.mockRestore();
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
