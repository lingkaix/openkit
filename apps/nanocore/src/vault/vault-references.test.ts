import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultInjectionPlan, listVaultInjectionPlans } from '../vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from '../vault-injection-receipts.js';
import { createVaultGrant, listVaultGrants } from './vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReference,
  createVaultReferenceWithInsertEvidence,
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
        backendKind: 'encrypted-file',
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

  it('reports insert evidence without treating duplicate rows as new', () => {
    const coreDb = createCoreDb();

    try {
      const input = {
        backendKind: 'encrypted-file' as const,
        backendLocator: 'encrypted-file://server/vault/vault_subscription',
        displayName: 'Provider subscription credential',
        now: () => '2026-07-23T00:00:00.000Z',
        ownerScope: 'server' as const,
        referenceId: 'vault_subscription',
        secretKind: 'provider-subscription-oauth',
      };
      const inserted = createVaultReferenceWithInsertEvidence(coreDb, input);

      expect(inserted).toEqual({
        inserted: true,
        reference: {
          backendKind: 'encrypted-file',
          backendLocator: 'encrypted-file://server/vault/vault_subscription',
          createdAt: '2026-07-23T00:00:00.000Z',
          currentVersion: 1,
          displayName: 'Provider subscription credential',
          ownerScope: 'server',
          referenceId: 'vault_subscription',
          secretKind: 'provider-subscription-oauth',
          status: 'active',
          updatedAt: '2026-07-23T00:00:00.000Z',
          userId: null,
          workspaceId: null,
        },
      });
      expect(createVaultReferenceWithInsertEvidence(coreDb, input)).toEqual({
        inserted: false,
        reference: inserted.reference,
      });
      expect(
        createVaultReferenceWithInsertEvidence(coreDb, {
          ...input,
          displayName: 'Conflicting label',
          now: () => '2026-07-23T00:10:00.000Z',
          secretKind: 'repository-token',
        })
      ).toEqual({ inserted: false, reference: inserted.reference });
      expect(getVaultReference(coreDb, input.referenceId)).toEqual(inserted.reference);
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

  it('advances only active vault references by zero or one version', () => {
    const coreDb = createCoreDb();

    try {
      const created = createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Provider subscription credential',
        now: () => '2026-07-23T00:00:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_subscription_version',
        secretKind: 'provider-subscription-oauth',
      });
      const equalVersion = advanceActiveVaultReferenceVersion(coreDb, {
        currentVersion: 1,
        now: () => '2026-07-23T00:10:00.000Z',
        referenceId: created.referenceId,
      });

      expect(equalVersion).toEqual(created);

      const advanced = advanceActiveVaultReferenceVersion(coreDb, {
        currentVersion: 2,
        now: () => '2026-07-23T00:20:00.000Z',
        referenceId: created.referenceId,
      });

      expect(advanced).toEqual({
        ...created,
        currentVersion: 2,
        updatedAt: '2026-07-23T00:20:00.000Z',
      });
      expect(() =>
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 1,
          now: () => '2026-07-23T00:30:00.000Z',
          referenceId: created.referenceId,
        })
      ).toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(advanced);
      expect(() =>
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 4,
          now: () => '2026-07-23T00:40:00.000Z',
          referenceId: created.referenceId,
        })
      ).toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(advanced);
      expect(() =>
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 1,
          referenceId: 'vault_missing',
        })
      ).toThrow();
      expect(getVaultReference(coreDb, 'vault_missing')).toBeNull();

      const revoked = revokeVaultReference(coreDb, {
        now: () => '2026-07-23T00:50:00.000Z',
        referenceId: created.referenceId,
      });

      expect(() =>
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 2,
          now: () => '2026-07-23T01:00:00.000Z',
          referenceId: created.referenceId,
        })
      ).toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(revoked);
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
      expect(listVaultInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_turn',
          planId: 'plan_github_file',
          status: 'revoked',
        }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
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

  it('rolls back the complete revocation cascade and permits retry', () => {
    const coreDb = createCoreDb();

    try {
      createReferenceCascadeFixture(coreDb);
      const originalReference = getVaultReference(coreDb, 'vault_github');
      const originalGrants = listVaultGrants(coreDb);
      const originalPlans = listVaultInjectionPlans(coreDb);
      const originalReceipts = listVaultInjectionReceipts(coreDb);

      coreDb.sqlite.exec(`CREATE TEMP TRIGGER fail_vault_grant_revocation
        BEFORE UPDATE OF status ON vault_grants
        FOR EACH ROW
        WHEN OLD.vault_reference_id = 'vault_github'
          AND OLD.status = 'active'
          AND NEW.status = 'revoked'
          AND EXISTS (
            SELECT 1 FROM vault_references
            WHERE reference_id = 'vault_github' AND status = 'revoked'
          )
          AND EXISTS (
            SELECT 1 FROM vault_injection_plans
            WHERE plan_id = 'plan_github_file'
              AND grant_id = OLD.grant_id
              AND status = 'revoked'
          )
          AND EXISTS (
            SELECT 1 FROM vault_injection_receipts
            WHERE receipt_id = 'receipt_github_file'
              AND grant_id = OLD.grant_id
              AND revocation_status = 'stale-session'
          )
        BEGIN
          SELECT RAISE(FAIL, 'injected vault grant revoke failure');
        END`);

      expect(() =>
        revokeVaultReference(coreDb, {
          now: () => '2026-07-23T00:30:00.000Z',
          referenceId: 'vault_github',
        })
      ).toThrow('injected vault grant revoke failure');
      expect(getVaultReference(coreDb, 'vault_github')).toEqual(originalReference);
      expect(listVaultGrants(coreDb)).toEqual(originalGrants);
      expect(listVaultInjectionPlans(coreDb)).toEqual(originalPlans);
      expect(listVaultInjectionReceipts(coreDb)).toEqual(originalReceipts);

      coreDb.sqlite.exec('DROP TRIGGER fail_vault_grant_revocation');

      expect(
        revokeVaultReference(coreDb, {
          now: () => '2026-07-23T00:40:00.000Z',
          referenceId: 'vault_github',
        })
      ).toMatchObject({
        referenceId: 'vault_github',
        status: 'revoked',
        updatedAt: '2026-07-23T00:40:00.000Z',
      });
      expect(listVaultGrants(coreDb)).toEqual([
        expect.objectContaining({ grantId: 'grant_github_turn', status: 'revoked' }),
      ]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({ planId: 'plan_github_file', status: 'revoked' }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
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
  createVaultInjectionPlan(coreDb, {
    backendCapabilityRequirement: 'encrypted-file:resolve',
    expirationBehavior: 'delete-on-turn-end',
    grantId: 'grant_github_turn',
    injectionVisibility: 'runtime-file',
    planId: 'plan_github_file',
    redactionRule: 'path-only',
    revocationBehavior: 'mark-session-stale',
    targetPath: '/openkit/secrets/github-token',
  });
  createVaultInjectionReceipt(coreDb, {
    agentSessionId: 'session_1',
    backendSummary: 'encrypted-file:vault_github:v1',
    grantId: 'grant_github_turn',
    injectedAt: '2026-07-05T00:10:00.000Z',
    planId: 'plan_github_file',
    receiptId: 'receipt_github_file',
    revocationStatus: 'active',
  });
}
