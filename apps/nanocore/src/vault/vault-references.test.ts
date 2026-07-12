import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createInjectionPlan, listInjectionPlans } from '../injection-plans.js';
import { createInjectionReceipt, listInjectionReceipts } from '../injection-receipts.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultGrant, listVaultGrants } from './vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  listVaultReferences,
  revokeVaultReference,
} from './vault-references.js';

/**
 * Opens a migrated Core database for vault reference tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-ref-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('vault references', () => {
  it('creates, reads, and lists non-secret server vault references', () => {
    const coreDb = createCoreDb();

    try {
      const created = createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file:default',
        displayName: 'OpenAI provider key',
        now: () => '2026-07-05T00:00:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_openai',
        secretKind: 'provider-api-key',
      });
      const duplicate = createVaultReference(coreDb, {
        backendKind: 'os-keychain',
        displayName: 'Changed label',
        now: () => '2026-07-05T00:10:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_openai',
        secretKind: 'repository-token',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultReference(coreDb, 'vault_openai')).toEqual(created);
      expect(listVaultReferences(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file:default',
        currentVersion: 1,
        displayName: 'OpenAI provider key',
        ownerScope: 'server',
        referenceId: 'vault_openai',
        secretKind: 'provider-api-key',
        status: 'active',
      });
      expect(JSON.stringify(created)).not.toContain('sk-');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires workspace ids only for workspace-owned references', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Workspace key',
          ownerScope: 'workspace',
          referenceId: 'vault_workspace',
          secretKind: 'provider-api-key',
        })
      ).toThrow('Workspace-scoped vault references require workspaceId.');
      expect(() =>
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'User key',
          ownerScope: 'user',
          referenceId: 'vault_user',
          secretKind: 'provider-api-key',
        })
      ).toThrow('User-scoped vault references require userId.');
      expect(() =>
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Server key',
          ownerScope: 'server',
          referenceId: 'vault_server',
          secretKind: 'provider-api-key',
          workspaceId: 'ws_1',
        })
      ).toThrow('Server-scoped vault references cannot include workspaceId or userId.');
      expect(() =>
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Workspace key',
          ownerScope: 'workspace',
          referenceId: 'vault_workspace_user',
          secretKind: 'provider-api-key',
          userId: 'user_1',
          workspaceId: 'ws_1',
        })
      ).toThrow('Workspace-scoped vault references cannot include userId.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('revokes a reference and marks dependent sessions stale', () => {
    const coreDb = createCoreDb();

    try {
      createReferenceCascadeFixture(coreDb);

      const revoked = revokeVaultReference(coreDb, {
        now: () => '2026-07-05T00:30:00.000Z',
        referenceId: 'vault_github',
      });

      expect(revoked).toMatchObject({
        referenceId: 'vault_github',
        status: 'revoked',
        updatedAt: '2026-07-05T00:30:00.000Z',
      });
      expect(listVaultGrants(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_turn',
          status: 'revoked',
        }),
      ]);
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_turn',
          planId: 'plan_github_file',
          status: 'revoked',
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_turn',
          receiptId: 'receipt_github_file',
          revocationStatus: 'stale-session',
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates a reference, grant, plan, and receipt fixture used by cascade tests.
 *
 * @param coreDb Open Core database handle.
 */
function createReferenceCascadeFixture(coreDb: CoreDb): void {
  createVaultReference(coreDb, {
    backendKind: 'encrypted-file',
    displayName: 'GitHub token',
    ownerScope: 'server',
    referenceId: 'vault_github',
    secretKind: 'repository-token',
  });
  createVaultGrant(coreDb, {
    allowedInjectionPaths: ['runtime-file'],
    grantId: 'grant_github_turn',
    lifetime: 'turn',
    ownerScope: 'workspace',
    vaultReferenceId: 'vault_github',
    workspaceId: 'ws_1',
  });
  createInjectionPlan(coreDb, {
    backendCapabilityRequirement: 'encrypted-file:resolve',
    expirationBehavior: 'delete-on-turn-end',
    grantId: 'grant_github_turn',
    injectionVisibility: 'runtime-file',
    planId: 'plan_github_file',
    redactionRule: 'path-only',
    revocationBehavior: 'mark-session-stale',
    targetPath: '/openkit/secrets/github-token',
  });
  createInjectionReceipt(coreDb, {
    agentSessionId: 'session_1',
    backendSummary: 'encrypted-file:vault_github:v1',
    grantId: 'grant_github_turn',
    injectedAt: '2026-07-05T00:10:00.000Z',
    planId: 'plan_github_file',
    receiptId: 'receipt_github_file',
    revocationStatus: 'active',
  });
}
