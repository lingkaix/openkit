import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { getVaultGrant } from './vault-grants.js';
import type {
  OsKeychainVaultAdapter,
  OsKeychainVaultItemInput,
} from './vault-os-keychain-backend.js';
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

  return {
    app: createApp({ coreDb, dataRoot, vaultUnlockState }),
    coreDb,
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
  it('defaults local mode to os-keychain and server mode to encrypted-file', async () => {
    const localDataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-local-default-'));
    const serverDataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-server-default-'));
    const localApp = createApp({
      dataRoot: localDataRoot,
      vaultOsKeychainAdapter: new MemoryKeychainAdapter(),
    });
    const serverApp = createApp({
      auth: createSignedInAuthStub(),
      dataRoot: serverDataRoot,
      mode: 'server',
    });

    const localStatus = await localApp.request('/api/app/vault/status');
    const serverStatus = await serverApp.request('/api/app/vault/status');

    expect(localStatus.status).toBe(200);
    await expect(localStatus.json()).resolves.toMatchObject({
      backendKind: 'os-keychain',
      state: 'available',
    });
    expect(serverStatus.status).toBe(200);
    await expect(serverStatus.json()).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'locked',
    });
  });

  it('uses encrypted-file when local config selects it as the vault backend fallback', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-local-file-fallback-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        vault: {
          localDefaultBackend: 'encrypted-file',
        },
      })
    );
    const app = createApp({ dataRoot });

    const status = await app.request('/api/app/vault/status');

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'locked',
    });
  });

  it('reports, unlocks, and locks the encrypted-file backend without echoing key material', async () => {
    const { app, coreDb, masterKey } = createVaultAdminApp();
    const masterKeyBase64 = masterKey.toString('base64');

    try {
      const initial = await app.request('/api/app/vault/status');
      expect(initial.status).toBe(200);
      await expect(initial.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'locked',
      });

      const unlock = await app.request('/api/app/vault/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterKeyBase64 }),
      });
      const unlockBody = await unlock.json();
      expect(unlock.status).toBe(200);
      expect(unlockBody).toMatchObject({
        backendKind: 'encrypted-file',
        state: 'available',
      });
      expect(JSON.stringify(unlockBody)).not.toContain(masterKeyBase64);

      const available = await app.request('/api/app/vault/status');
      expect(available.status).toBe(200);
      await expect(available.json()).resolves.toMatchObject({
        backendKind: 'encrypted-file',
        state: 'available',
      });

      const locked = await app.request('/api/app/vault/lock', { method: 'POST' });
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
    const { app, coreDb } = createVaultAdminApp();
    const badKey = Buffer.alloc(4, 1).toString('base64');

    try {
      const response = await app.request('/api/app/vault/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterKeyBase64: badKey }),
      });
      const body = await response.json();
      const row = latestVaultAdminAuditEvent(coreDb);
      const audit = serverAuditEvent(coreDb, row.audit_event_id as string);

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        code: 'vault_unlock_failed',
      });
      expect(JSON.stringify(body)).not.toContain(badKey);
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
        const response = await app.request('/api/app/vault/unlock', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ masterKeyBase64: badKey }),
        });

        expect(response.status).toBe(400);
      }

      const limited = await app.request('/api/app/vault/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterKeyBase64: badKey }),
      });
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
      const unlock = await app.request('/api/app/vault/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterKeyBase64: masterKey.toString('base64') }),
      });
      expect(unlock.status).toBe(200);

      const response = await app.request('/api/app/vault/bootstrap/codex-auth-json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJsonBase64 }),
      });
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
      await app.request('/api/app/vault/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterKeyBase64: masterKey.toString('base64') }),
      });

      const response = await app.request(
        '/api/app/workspaces/ws_demo/vault/references/vault_imported/rebind',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ materialBase64 }),
        }
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

      const response = await app.request('/api/app/workspaces/ws_demo/vault/references');

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

  it('inherits server-mode authentication for vault admin routes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-admin-auth-'));
    const coreDb = openCoreDb(dataRoot);
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
      const response = await app.request('/api/app/vault/status');

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

class MemoryKeychainAdapter implements OsKeychainVaultAdapter {
  private readonly items = new Map<string, string>();

  public health(): ReturnType<OsKeychainVaultAdapter['health']> {
    return { diagnostic: 'memory keychain available', state: 'available' };
  }

  public get(input: OsKeychainVaultItemInput): string | null {
    return this.items.get(this.key(input)) ?? null;
  }

  public set(input: OsKeychainVaultItemInput & { value: string }): void {
    this.items.set(this.key(input), input.value);
  }

  public delete(input: OsKeychainVaultItemInput): void {
    this.items.delete(this.key(input));
  }

  private key(input: OsKeychainVaultItemInput): string {
    return `${input.service}:${input.account}`;
  }
}
