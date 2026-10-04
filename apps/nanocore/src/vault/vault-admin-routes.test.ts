import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultVaultUnlockState } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { getVaultGrant } from './vault-grants.js';
import { getVaultReference, importUnboundWorkspaceVaultReference } from './vault-references.js';
import { createVaultUnlockState } from './vault-unlock-state.js';

/**
 * Creates an app wired to a process-local encrypted-file vault state.
 *
 * @returns Hono app, migrated Core DB, and deterministic unlock key material.
 */
function createVaultAdminApp() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-routes-'));
  const coreDb = openCoreDb(dataRoot);
  const masterKey = Buffer.alloc(32, 9);
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });

  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: 'ws_demo',
  });

  return {
    app: createApp({ coreDb, dataRoot, vaultUnlockState }),
    coreDb,
    dataRoot,
    masterKey,
    vaultUnlockState,
  };
}

/**
 * Creates a Better Auth stub with no active session.
 *
 * @returns Better Auth server stub that rejects authenticated requests.
 */
function createSignedOutAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => null,
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/**
 * Creates a Better Auth stub with an active session.
 *
 * @returns Better Auth server stub that accepts authenticated requests.
 */
function createSignedInAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({
        session: { id: 'session_vault_admin_default' },
        user: { id: 'user_vault_admin_default' },
      }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

describe('vault admin app API', () => {
  it('creates, rotates and revokes workspace secrets and gateway-only grants without exposing material', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    vaultUnlockState.unlock({ masterKey });
    const workspaceResponse = await app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Vault CRUD test',
            requestId: '00000000-0000-4000-8000-000000000066',
          }),
        }
      )
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json();
    const workspaceId = workspace.id;
    const secret = 'ghp_synthetic_canary_no_real_credential';
    const request = (id: OperationId, input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          id,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );
    try {
      const created = await request('vault.secret-create', {
        workspaceId: workspaceId,
        ...{ secretKind: 'github-token', material: secret },
      });
      expect(created.status).toBe(200);
      expect(created.headers.get('cache-control')).toBe('no-store');
      const reference = await created.json();
      expect(reference).toMatchObject({
        workspaceId,
        currentVersion: 1,
        status: 'active',
      });
      expect(JSON.stringify(reference)).not.toContain(secret);
      expect(
        vaultUnlockState.backend().resolve({ referenceId: reference.referenceId }).toString()
      ).toBe(secret);
      const grantResponse = await request('vault.grant-create', {
        workspaceId: workspaceId,
        ...{ referenceId: reference.referenceId },
      });
      expect(grantResponse.status).toBe(200);
      const grant = await grantResponse.json();
      expect(grant).toMatchObject({
        allowedInjectionPaths: ['gateway-only'],
        targetCapabilityId: null,
        lifetime: 'workspace',
      });
      const workerGrantResponse = await request('vault.grant-create', {
        workspaceId: workspaceId,
        ...{
          referenceId: reference.referenceId,
          injectionPath: 'runtime-env',
        },
      });
      expect(workerGrantResponse.status).toBe(200);
      const workerGrant = await workerGrantResponse.json();
      expect(workerGrant).toMatchObject({
        allowedInjectionPaths: ['runtime-env'],
        targetCapabilityId: null,
        lifetime: 'workspace',
      });
      expect(workerGrant.grantId).not.toBe(grant.grantId);
      expect(JSON.stringify(workerGrant)).not.toContain(secret);
      expect(getVaultGrant(coreDb, workerGrant.grantId)?.allowedInjectionPaths).not.toContain(
        'gateway-only'
      );
      const rotated = await request('vault.secret-rotate', {
        workspaceId: workspaceId,
        referenceId: reference.referenceId,
        ...{
          material: 'replacement-canary',
        },
      });
      expect(rotated.status).toBe(200);
      expect(await rotated.json()).toMatchObject({ currentVersion: 2 });
      for (const id of ['vault.reference-list', 'vault.grant-list'] as const) {
        const listed = await app.request(...operationRequest(id, { workspaceId }));
        expect(listed.status).toBe(200);
        const bytes = await listed.text();
        expect(bytes).not.toContain(secret);
        expect(bytes).not.toContain('replacement-canary');
      }
      const revokedGrant = await request('vault.grant-revoke', {
        workspaceId: workspaceId,
        grantId: grant.grantId,
      });
      expect(revokedGrant.status).toBe(200);
      expect(getVaultGrant(coreDb, grant.grantId)?.status).toBe('revoked');
      const secondGrant = await (
        await request('vault.grant-create', {
          workspaceId: workspaceId,
          ...{ referenceId: reference.referenceId },
        })
      ).json();
      const revoked = await request('vault.secret-revoke', {
        workspaceId: workspaceId,
        referenceId: reference.referenceId,
      });
      expect(revoked.status).toBe(200);
      expect(getVaultReference(coreDb, reference.referenceId)?.status).toBe('revoked');
      expect(getVaultGrant(coreDb, secondGrant.grantId)?.status).toBe('revoked');
      expect(() =>
        vaultUnlockState.backend().resolve({ referenceId: reference.referenceId })
      ).toThrow();
      expect(
        (
          await request('vault.grant-create', {
            workspaceId: workspaceId,
            ...{ referenceId: reference.referenceId },
          })
        ).status
      ).toBe(409);
      const audit = JSON.stringify(
        coreDb.sqlite.prepare('SELECT * FROM vault_admin_audit_events').all()
      );
      expect(audit).not.toContain(secret);
      expect(audit).not.toContain('replacement-canary');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects locked, malformed, cross-workspace and inconsistent secret mutations with redacted errors', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    const request = (id: OperationId, input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          id,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );
    try {
      expect(
        (
          await request('vault.secret-create', {
            workspaceId: 'ws_demo',
            ...{ secretKind: 'github-token', material: 'fake' },
          })
        ).status
      ).toBe(423);
      vaultUnlockState.unlock({ masterKey });
      const malformed = await request('vault.secret-create', {
        workspaceId: 'ws_demo',
        ...{
          secretKind: 'github-token',
          material: '',
          ghp_fake_error_canary: true,
        },
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain('ghp_fake_error_canary');
      const created = await (
        await request('vault.secret-create', {
          workspaceId: 'ws_demo',
          ...{ secretKind: 'github-token', material: 'fake' },
        })
      ).json();
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: 'ws_other',
      });
      const foreign = await app.request(
        ...operationRequest(
          'vault.secret-revoke',
          { workspaceId: 'ws_other', referenceId: created.referenceId },
          { method: 'POST' }
        )
      );
      expect(foreign.status).toBe(404);
      const grant = await (
        await request('vault.grant-create', {
          workspaceId: 'ws_demo',
          ...{ referenceId: created.referenceId },
        })
      ).json();
      expect(
        (
          await app.request(
            ...operationRequest(
              'vault.grant-revoke',
              { workspaceId: 'ws_other', grantId: grant.grantId },
              {
                method: 'POST',
              }
            )
          )
        ).status
      ).toBe(404);
      expect(getVaultGrant(coreDb, grant.grantId)?.status).toBe('active');
      vaultUnlockState
        .backend()
        .rotate({ referenceId: created.referenceId, material: 'unprojected-version' });
      expect(
        (
          await request('vault.secret-rotate', {
            workspaceId: 'ws_demo',
            referenceId: created.referenceId,
            ...{ material: 'new' },
          })
        ).status
      ).toBe(409);
      expect(
        (
          await request('vault.grant-create', {
            workspaceId: 'ws_demo',
            ...{ referenceId: created.referenceId },
          })
        ).status
      ).toBe(409);
      const backend = vaultUnlockState.backend();
      const spy = vi.spyOn(backend, 'store').mockImplementation(() => {
        throw new Error('ghp_fake_error_canary');
      });
      const failed = await request('vault.secret-create', {
        workspaceId: 'ws_demo',
        ...{ secretKind: 'github-token', material: 'fake' },
      });
      expect(failed.status).toBe(409);
      expect(await failed.text()).not.toContain('ghp_fake_error_canary');
      spy.mockRestore();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies workspace-scoped bearer tokens every secret and grant mutation', async () => {
    const { coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    vaultUnlockState.unlock({ masterKey });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const app = createApp({
      coreDb,
      dataRoot,
      vaultUnlockState,
      mode: 'server',
      auth: createSignedOutAuthStub(),
    });
    try {
      for (const [id, input] of [
        [
          'vault.secret-create',
          { workspaceId: 'ws_demo', secretKind: 'github-token', material: 'fake' },
        ],
        [
          'vault.secret-rotate',
          { workspaceId: 'ws_demo', referenceId: 'vault_test', material: 'fake' },
        ],
        ['vault.secret-revoke', { workspaceId: 'ws_demo', referenceId: 'vault_test' }],
        ['vault.grant-create', { workspaceId: 'ws_demo', referenceId: 'vault_test' }],
        ['vault.grant-revoke', { workspaceId: 'ws_demo', grantId: 'grant_test' }],
      ] as const) {
        const response = await app.request(
          ...operationRequest(
            id,
            {},
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token.secret}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(input),
            }
          )
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: 'deployment_admin_required' });
      }
      expect(vaultUnlockState.backend().listReferences()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'token',
    'session',
  ] as const)('accepts workspace secret enrollment from a deployment-admin %s', async (kind) => {
    const { coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    vaultUnlockState.unlock({ masterKey });
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const auth: BetterAuthServer = {
      api: {
        getSession: async () =>
          kind === 'session'
            ? { session: { id: 'session_admin' }, user: { id: 'user_local' } }
            : null,
      },
      handler: async () => Response.json({}),
    };
    const app = createApp({ coreDb, dataRoot, vaultUnlockState, mode: 'server', auth });
    try {
      const response = await app.request(
        ...operationRequest(
          'vault.secret-create',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(kind === 'token' ? { authorization: `Bearer ${admin.secret}` } : {}),
            },
            body: JSON.stringify({ secretKind: 'github-token', material: 'fake-admin-secret' }),
          }
        )
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ workspaceId: 'ws_demo', status: 'active' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('destroys newly stored material when Core reference persistence fails', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    vaultUnlockState.unlock({ masterKey });
    coreDb.sqlite.exec(
      "CREATE TRIGGER reject_secret_insert BEFORE INSERT ON vault_references BEGIN SELECT RAISE(ABORT, 'persistence-error-canary'); END"
    );
    try {
      const response = await app.request(
        ...operationRequest(
          'vault.secret-create',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              secretKind: 'api-token',
              material: 'fake-partial-effect-secret',
            }),
          }
        )
      );
      expect(response.status).toBe(409);
      const bytes = await response.text();
      expect(bytes).not.toContain('persistence-error-canary');
      expect(bytes).not.toContain('fake-partial-effect-secret');
      const inventory = vaultUnlockState.backend().listReferences();
      expect(inventory).toHaveLength(1);
      expect(inventory[0]?.revoked).toBe(true);
      expect(() =>
        vaultUnlockState.backend().resolve({ referenceId: inventory[0]!.referenceId })
      ).toThrow();
      expect(coreDb.sqlite.prepare('SELECT * FROM vault_references').all()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores and rotates an authored provider API key without echoing secret material', async () => {
    const { app, coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    const providersRoot = join(dataRoot, 'config', 'providers');
    const firstApiKey = 'xai-test-api-key-first';
    const replacementApiKey = 'xai-test-api-key-replacement';

    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(
      join(providersRoot, 'xai-api.provider.jsonc'),
      `${JSON.stringify(
        {
          baseUrl: 'https://api.x.ai/v1',
          defaultModel: 'grok-4',
          displayName: 'xAI API',
          id: 'xai-api',
          kind: 'direct',
          models: ['grok-4'],
          secretRef: 'vault://provider_xai_api',
          vendor: 'xai',
        },
        null,
        2
      )}\n`
    );
    vaultUnlockState.unlock({ masterKey });

    try {
      const first = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'xai-api' },
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: firstApiKey }),
          }
        )
      );

      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody).toEqual({ configured: true, providerId: 'xai-api' });
      expect(JSON.stringify(firstBody)).not.toContain(firstApiKey);
      expect(
        vaultUnlockState.backend().resolve({ referenceId: 'provider_xai_api' }).toString('utf8')
      ).toBe(firstApiKey);
      expect(getVaultReference(coreDb, 'provider_xai_api')).toMatchObject({
        currentVersion: 1,
        displayName: 'Provider API key',
        ownerScope: 'server',
        secretKind: 'provider-api-key',
        status: 'active',
      });

      const replacement = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'xai-api' },
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: replacementApiKey }),
          }
        )
      );

      expect(replacement.status).toBe(200);
      const replacementBody = await replacement.json();
      expect(replacementBody).toEqual({ configured: true, providerId: 'xai-api' });
      expect(JSON.stringify(replacementBody)).not.toContain(replacementApiKey);
      expect(
        vaultUnlockState.backend().resolve({ referenceId: 'provider_xai_api' }).toString('utf8')
      ).toBe(replacementApiKey);
      expect(getVaultReference(coreDb, 'provider_xai_api')).toMatchObject({
        currentVersion: 2,
        status: 'active',
      });
      const row = latestVaultAdminAuditEvent(coreDb);
      const audit = serverAuditEvent(coreDb, row.audit_event_id as string);
      expect(row).toMatchObject({
        action: 'vault.set_provider_api_key',
        error_code: null,
        outcome: 'succeeded',
      });
      expect(audit).toMatchObject({
        action: 'vault.set_provider_api_key',
        outcome: 'succeeded',
        resource: 'vault:encrypted-file',
      });
      expect(JSON.stringify({ row, audit })).not.toContain(replacementApiKey);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a response-unsafe provider id before any Vault or Core effect', async () => {
    const { app, coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    const providersRoot = join(dataRoot, 'config', 'providers');

    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(
      join(providersRoot, 'unsafe.provider.jsonc'),
      `${JSON.stringify({
        defaultModel: 'model-demo',
        displayName: 'Unsafe response id',
        id: 'okt_demo',
        kind: 'custom',
        models: ['model-demo'],
        secretRef: 'vault://provider_okt_demo',
      })}\n`
    );
    vaultUnlockState.unlock({ masterKey });

    try {
      const response = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'okt_demo' },
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: 'response-safety-test-key' }),
          }
        )
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'provider_api_key_not_supported',
      });
      expect(getVaultReference(coreDb, 'provider_okt_demo')).toBeNull();
      expect(vaultUnlockState.backend().listReferences({ ownerScope: 'server' })).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns an audited typed failure when any authored provider file is malformed', async () => {
    const { app, coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    const providersRoot = join(dataRoot, 'config', 'providers');

    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(join(providersRoot, 'broken.provider.jsonc'), '{');
    writeFileSync(
      join(providersRoot, 'provider-demo.provider.jsonc'),
      `${JSON.stringify({
        defaultModel: 'model-demo',
        displayName: 'Provider demo',
        id: 'provider-demo',
        kind: 'custom',
        models: ['model-demo'],
        secretRef: 'vault://provider_demo',
      })}\n`
    );
    vaultUnlockState.unlock({ masterKey });

    try {
      const response = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'provider-demo' },
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: 'malformed-config-test-key' }),
          }
        )
      );
      const row = latestVaultAdminAuditEvent(coreDb);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'provider_configuration_invalid',
      });
      expect(getVaultReference(coreDb, 'provider_demo')).toBeNull();
      expect(vaultUnlockState.backend().listReferences({ ownerScope: 'server' })).toEqual([]);
      expect(row).toMatchObject({
        action: 'vault.set_provider_api_key',
        error_code: 'provider_configuration_invalid',
        outcome: 'failed',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records recovery-required evidence when backend store succeeds before Core insert fails', async () => {
    const { app, coreDb, dataRoot, masterKey, vaultUnlockState } = createVaultAdminApp();
    const providersRoot = join(dataRoot, 'config', 'providers');
    const apiKey = 'partial-effect-test-key';

    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(
      join(providersRoot, 'failure.provider.jsonc'),
      `${JSON.stringify({
        defaultModel: 'model-demo',
        displayName: 'Failure provider',
        id: 'provider-failure',
        kind: 'custom',
        models: ['model-demo'],
        secretRef: 'vault://provider_failure',
      })}\n`
    );
    coreDb.sqlite.exec(`
      CREATE TRIGGER fail_provider_reference_insert
      BEFORE INSERT ON vault_references
      WHEN NEW.reference_id = 'provider_failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced provider reference failure');
      END;
    `);
    vaultUnlockState.unlock({ masterKey });

    try {
      const response = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'provider-failure' },
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey }),
          }
        )
      );
      const row = latestVaultAdminAuditEvent(coreDb);
      const audit = serverAuditEvent(coreDb, row.audit_event_id as string);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'provider_api_key_recovery_required',
      });
      expect(getVaultReference(coreDb, 'provider_failure')).toBeNull();
      expect(() =>
        vaultUnlockState.backend().resolve({ referenceId: 'provider_failure' })
      ).toThrow();
      expect(row).toMatchObject({
        action: 'vault.set_provider_api_key',
        error_code: 'provider_api_key_recovery_required',
        outcome: 'failed',
      });
      expect(audit).toMatchObject({
        action: 'vault.set_provider_api_key',
        error_code: 'provider_api_key_recovery_required',
        outcome: 'failed',
        resource: 'vault:encrypted-file',
      });
      expect(JSON.stringify({ row, audit })).not.toContain(apiKey);
      expect(JSON.stringify({ row, audit })).not.toContain('provider_failure');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('defaults local and server modes to locked encrypted-file state', async () => {
    const localDataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-local-default-'));
    const serverDataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-server-default-'));
    const serverCoreDb = openCoreDb(serverDataRoot);
    applyMigrations(serverCoreDb);
    ensureLocalUser(serverCoreDb);
    const admin = createOpenKitAccessTokenRecord(serverCoreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const localApp = createApp({ dataRoot: localDataRoot });
    const serverApp = createApp({
      auth: createSignedOutAuthStub(),
      coreDb: serverCoreDb,
      dataRoot: serverDataRoot,
      mode: 'server',
    });

    try {
      const localStatus = await localApp.request(...operationRequest('vault.status', {}, {}));
      const serverStatus = await serverApp.request(
        ...operationRequest(
          'vault.status',
          {},
          {
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );

      expect(localStatus.status).toBe(200);
      await expect(localStatus.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'locked',
      });
      expect(serverStatus.status).toBe(200);
      await expect(serverStatus.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'locked',
      });
    } finally {
      serverCoreDb.sqlite.close();
    }
  });

  it.each([
    'local',
    'server',
  ] as const)('stores %s default Vault ciphertext only under DATA_ROOT/server/vault', (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-vault-${mode}-composition-`));
    const secret = `vault_${mode}_composition_plaintext`;
    const referenceId = `vault_${mode}_composition`;
    const vaultUnlockState = createDefaultVaultUnlockState({ dataRoot, mode });

    expect(vaultUnlockState.backend().health()).toMatchObject({
      kind: 'encrypted-file',
      state: 'locked',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 17) }).store({
      material: secret,
      metadata: { ownerScope: 'server' },
      referenceId,
    });

    const expectedEntryPath = join('server', 'vault', 'entries', referenceId, '1.enc');
    const files = globSync('**/*', { cwd: dataRoot })
      .filter((path) => lstatSync(join(dataRoot, path)).isFile())
      .sort();

    expect(files.filter((path) => path.endsWith('.enc'))).toEqual([expectedEntryPath]);
    expect(existsSync(join(dataRoot, expectedEntryPath))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataRoot, expectedEntryPath), 'utf8'))).toMatchObject({
      ciphertext: expect.any(String),
    });
    for (const path of files) {
      expect(readFileSync(join(dataRoot, path)).includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('reports, unlocks, and locks the encrypted-file backend without echoing key material', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    const masterKeyBase64 = masterKey.toString('base64');
    const unlockSpy = vi.spyOn(vaultUnlockState, 'unlock');

    try {
      const initial = await app.request(...operationRequest('vault.status', {}, {}));
      expect(initial.status).toBe(200);
      await expect(initial.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'locked',
      });

      const unlock = await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ masterKeyBase64 }),
          }
        )
      );
      const unlockBody = await unlock.json();
      expect(unlock.status).toBe(200);
      expect(unlockBody).toMatchObject({
        backendKind: 'encrypted-file',
        state: 'available',
      });
      expect(JSON.stringify(unlockBody)).not.toContain(masterKeyBase64);
      expect(unlockSpy).toHaveBeenCalledOnce();
      expect(unlockSpy.mock.calls[0]?.[0].masterKey).toEqual(Buffer.alloc(32));

      const available = await app.request(...operationRequest('vault.status', {}, {}));
      expect(available.status).toBe(200);
      await expect(available.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'available',
      });

      const locked = await app.request(...operationRequest('vault.lock', {}, { method: 'POST' }));
      expect(locked.status).toBe(200);
      await expect(locked.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'locked',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects invalid unlock keys without exposing submitted material', async () => {
    const { app, coreDb, vaultUnlockState } = createVaultAdminApp();
    const badKey = Buffer.alloc(4, 1).toString('base64');
    const unlockSpy = vi.spyOn(vaultUnlockState, 'unlock');

    try {
      const response = await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ masterKeyBase64: badKey }),
          }
        )
      );
      const body = await response.json();
      const row = latestVaultAdminAuditEvent(coreDb);
      const audit = serverAuditEvent(coreDb, row.audit_event_id as string);

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        code: 'vault_unlock_failed',
      });
      expect(JSON.stringify(body)).not.toContain(badKey);
      expect(unlockSpy).toHaveBeenCalledOnce();
      expect(unlockSpy.mock.calls[0]?.[0].masterKey).toEqual(Buffer.alloc(4));
      expect(row).toMatchObject({
        action: 'vault.unlock',
        error_code: 'vault_unlock_failed',
        outcome: 'failed',
      });
      expect(audit).toMatchObject({
        action: 'vault.unlock',
        category: 'system',
        error_code: 'vault_unlock_failed',
        outcome: 'failed',
        resource: 'vault:encrypted-file',
        severity: 'warning',
        summary: 'Vault unlock failed.',
        workspace_id: null,
      });
      expect(JSON.stringify(row)).not.toContain(badKey);
      expect(JSON.stringify(audit)).not.toContain(badKey);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rate-limits repeated failed unlock attempts and audits the denial', async () => {
    const { app, coreDb } = createVaultAdminApp();
    const badKey = Buffer.alloc(4, 2).toString('base64');

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.request(
          ...operationRequest(
            'vault.unlock',
            {},
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ masterKeyBase64: badKey }),
            }
          )
        );

        expect(response.status).toBe(400);
      }

      const limited = await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ masterKeyBase64: badKey }),
          }
        )
      );
      const body = await limited.json();
      const row = latestVaultAdminAuditEvent(coreDb);

      expect(limited.status).toBe(429);
      expect(body).toMatchObject({
        code: 'vault_unlock_rate_limited',
      });
      expect(JSON.stringify(body)).not.toContain(badKey);
      expect(row).toMatchObject({
        action: 'vault.unlock',
        error_code: 'vault_unlock_rate_limited',
        outcome: 'denied',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('bootstraps Codex auth JSON into the unlocked vault without echoing secret material', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    const authJson = '{"tokens":{"openai":"codex_bootstrap_secret"}}';
    const authJsonBase64 = Buffer.from(authJson, 'utf8').toString('base64');

    try {
      const unlock = await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ masterKeyBase64: masterKey.toString('base64') }),
          }
        )
      );
      expect(unlock.status).toBe(200);

      const response = await app.request(
        ...operationRequest(
          'vault.bootstrap-codex-auth',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ authJsonBase64 }),
          }
        )
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      const row = latestVaultAdminAuditEvent(coreDb);

      expect(body).toMatchObject({
        backendKind: 'encrypted-file',
        grantId: 'grant_codex_auth_json',
        grantScope: 'agent-session',
        referenceId: 'vault_codex_auth_json',
        secretKind: 'codex-auth-json',
        targetPath: '/sandbox/.codex/auth.json',
      });
      expect(getVaultReference(coreDb, 'vault_codex_auth_json')).toMatchObject({
        backendKind: 'encrypted-file',
        referenceId: 'vault_codex_auth_json',
        secretKind: 'codex-auth-json',
      });
      expect(getVaultGrant(coreDb, 'grant_codex_auth_json')).toMatchObject({
        allowedInjectionPaths: ['runtime-file'],
        grantId: 'grant_codex_auth_json',
        lifetime: 'agent-session',
        vaultReferenceId: 'vault_codex_auth_json',
      });
      expect(
        Buffer.from(
          vaultUnlockState.backend().resolve({ referenceId: 'vault_codex_auth_json' })
        ).toString('utf8')
      ).toBe(authJson);
      expect(row).toMatchObject({
        action: 'vault.bootstrap_codex_auth_json',
        outcome: 'succeeded',
      });
      expect(JSON.stringify(body)).not.toContain('codex_bootstrap_secret');
      expect(JSON.stringify(body)).not.toContain(authJsonBase64);
      expect(JSON.stringify(row)).not.toContain('codex_bootstrap_secret');
      expect(JSON.stringify(row)).not.toContain(authJsonBase64);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rebinds imported workspace vault references without echoing secret material', async () => {
    const { app, coreDb, masterKey, vaultUnlockState } = createVaultAdminApp();
    const material = 'workspace-rebound-secret';
    const materialBase64 = Buffer.from(material, 'utf8').toString('base64');

    try {
      importUnboundWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Imported API token',
        referenceId: 'vault_imported',
        secretKind: 'api-token',
        workspaceId: 'ws_demo',
      });
      await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ masterKeyBase64: masterKey.toString('base64') }),
          }
        )
      );

      const response = await app.request(
        ...operationRequest(
          'vault.reference-rebind',
          { workspaceId: 'ws_demo', referenceId: 'vault_imported' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ materialBase64 }),
          }
        )
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        backendKind: 'encrypted-file',
        currentVersion: 1,
        ownerScope: 'workspace',
        referenceId: 'vault_imported',
        secretKind: 'api-token',
        status: 'active',
        workspaceId: 'ws_demo',
      });
      expect(getVaultReference(coreDb, 'vault_imported')).toMatchObject({
        currentVersion: 1,
        status: 'active',
      });
      expect(
        Buffer.from(vaultUnlockState.backend().resolve({ referenceId: 'vault_imported' })).toString(
          'utf8'
        )
      ).toBe(material);
      expect(JSON.stringify(body)).not.toContain(material);
      expect(JSON.stringify(body)).not.toContain(materialBase64);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a foreign vault reference but preserves a missing reference result', async () => {
    const { app, coreDb, masterKey } = createVaultAdminApp();
    const materialBase64 = Buffer.from('foreign-workspace-secret', 'utf8').toString('base64');

    try {
      const before = importUnboundWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Foreign API token',
        referenceId: 'vault_foreign',
        secretKind: 'api-token',
        workspaceId: 'ws_foreign',
      });
      const unlock = await app.request(
        ...operationRequest(
          'vault.unlock',
          {},
          {
            body: JSON.stringify({ masterKeyBase64: masterKey.toString('base64') }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      expect(unlock.status).toBe(200);

      const foreign = await app.request(
        ...operationRequest(
          'vault.reference-rebind',
          { workspaceId: 'ws_demo', referenceId: 'vault_foreign' },
          {
            body: JSON.stringify({ materialBase64 }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );
      const missing = await app.request(
        ...operationRequest(
          'vault.reference-rebind',
          { workspaceId: 'ws_demo', referenceId: 'vault_missing' },
          {
            body: JSON.stringify({ materialBase64 }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        )
      );

      expect(foreign.status).toBe(403);
      await expect(foreign.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ code: 'vault_reference_not_found' });
      expect(getVaultReference(coreDb, 'vault_foreign')).toEqual(before);
      expect(getVaultReference(coreDb, 'vault_missing')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lists redacted workspace vault references for re-binding', async () => {
    const { app, coreDb } = createVaultAdminApp();

    try {
      importUnboundWorkspaceVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Imported API token',
        referenceId: 'vault_imported',
        secretKind: 'api-token',
        workspaceId: 'ws_demo',
      });

      const response = await app.request(
        ...operationRequest('vault.reference-list', { workspaceId: 'ws_demo' }, {})
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        items: [
          {
            backendKind: 'encrypted-file',
            currentVersion: 0,
            ownerScope: 'workspace',
            referenceId: 'vault_imported',
            secretKind: 'api-token',
            status: 'unbound',
            workspaceId: 'ws_demo',
          },
        ],
        workspaceId: 'ws_demo',
      });
      expect(JSON.stringify(body)).not.toContain('backendLocator');
      expect(JSON.stringify(body)).not.toContain('Imported API token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires server-admin authority for every server-wide vault operation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-authority-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, created_at, updated_at, kind)
         VALUES ('user_vault_admin_default', 'Vault User',
                 'vault-user@example.com', false, ?, ?, 'human')`
      )
      .run(Date.now(), Date.now());
    const app = createApp({
      auth: createSignedInAuthStub(),
      coreDb,
      dataRoot,
      mode: 'server',
      vaultUnlockState: createVaultUnlockState({
        backendKind: 'encrypted-file',
        storeDir: join(dataRoot, 'server', 'vault'),
      }),
    });

    try {
      const responses = await Promise.all([
        app.request(...operationRequest('vault.status', {}, {})),
        app.request(...operationRequest('vault.server-use-list', {}, {})),
        app.request(
          ...operationRequest(
            'vault.unlock',
            {},
            {
              method: 'POST',
              body: JSON.stringify({ masterKeyBase64: Buffer.alloc(32, 9).toString('base64') }),
            }
          )
        ),
        app.request(...operationRequest('vault.lock', {}, { method: 'POST' })),
        app.request(
          ...operationRequest(
            'vault.bootstrap-codex-auth',
            {},
            { method: 'POST', body: JSON.stringify({ authJsonBase64: 'e30=' }) }
          )
        ),
        app.request(
          ...operationRequest(
            'vault.provider-api-key-set',
            { providerId: 'provider-demo' },
            { method: 'PUT', body: JSON.stringify({ apiKey: 'synthetic-rejected-key' }) }
          )
        ),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: 'deployment_admin_required' });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('allows server-admin bearer tokens to use the server-wide vault API', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-token-authority-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
    });
    const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
    });
    const masterKey = Buffer.alloc(32, 8);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'providers', 'provider-demo.provider.jsonc'),
      `${JSON.stringify({
        defaultModel: 'model-demo',
        displayName: 'Provider demo',
        id: 'provider-demo',
        kind: 'custom',
        models: ['model-demo'],
        secretRef: 'vault://provider_demo',
      })}\n`
    );
    vaultUnlockState.unlock({ masterKey });
    const app = createApp({
      auth: createSignedOutAuthStub(),
      coreDb,
      dataRoot,
      mode: 'server',
      vaultUnlockState,
    });

    try {
      const apiKeyResponse = await app.request(
        ...operationRequest(
          'vault.provider-api-key-set',
          { providerId: 'provider-demo' },
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${admin.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ apiKey: 'server-admin-provider-key' }),
          }
        )
      );
      const response = await app.request(
        ...operationRequest(
          'vault.lock',
          {},
          {
            method: 'POST',
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );
      const useRecords = await app.request(
        ...operationRequest(
          'vault.server-use-list',
          {},
          {
            headers: { authorization: `Bearer ${admin.secret}` },
          }
        )
      );
      const denied = await Promise.all([
        app.request(
          ...operationRequest(
            'vault.status',
            {},
            {
              headers: { authorization: `Bearer ${workspaceToken.secret}` },
            }
          )
        ),
        app.request(
          ...operationRequest(
            'vault.server-use-list',
            {},
            {
              headers: { authorization: `Bearer ${workspaceToken.secret}` },
            }
          )
        ),
        app.request(
          ...operationRequest(
            'vault.provider-api-key-set',
            { providerId: 'provider-demo' },
            {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${workspaceToken.secret}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ apiKey: 'workspace-token-provider-key' }),
            }
          )
        ),
      ]);

      expect(apiKeyResponse.status).toBe(200);
      expect(JSON.stringify(await apiKeyResponse.json())).not.toContain(
        'server-admin-provider-key'
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain(admin.secret);
      expect(useRecords.status).toBe(200);
      for (const deniedResponse of denied) {
        expect(deniedResponse.status).toBe(403);
        await expect(deniedResponse.json()).resolves.toMatchObject({
          code: 'deployment_admin_required',
        });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('inherits server-mode authentication for vault admin routes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-auth-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const app = createApp({
      auth: createSignedOutAuthStub(),
      coreDb,
      dataRoot,
      mode: 'server',
      vaultUnlockState: createVaultUnlockState({
        backendKind: 'encrypted-file',
        storeDir: join(dataRoot, 'server', 'vault'),
      }),
    });

    try {
      const response = await app.request(...operationRequest('vault.status', {}, {}));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        code: 'core.auth.unauthenticated',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Returns the latest vault admin audit row for assertions.
 *
 * @param coreDb Server-scope Core database.
 * @returns Latest vault admin audit row.
 */
function latestVaultAdminAuditEvent(coreDb: CoreDb): Record<string, unknown> {
  return coreDb.sqlite
    .prepare('SELECT * FROM vault_admin_audit_events ORDER BY rowid DESC LIMIT 1')
    .get() as Record<string, unknown>;
}

/**
 * Reads one server-owned general audit event.
 *
 * @param coreDb Server-scope Core database.
 * @param auditEventId Stable audit event id.
 * @returns Matching general audit row.
 */
function serverAuditEvent(coreDb: CoreDb, auditEventId: string): Record<string, unknown> {
  return coreDb.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(auditEventId) as Record<string, unknown>;
}
