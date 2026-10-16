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
import {
  createVaultGrant,
  getVaultGrant,
  listVaultGrants,
  revokeVaultGrant,
} from './vault-grants.js';
import { createVaultReference } from './vault-references.js';

/**
 * Opens a migrated Core database for vault grant tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-grant-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('vault grants', () => {
  it('creates, reads, and lists non-secret workspace vault grants', () => {
    const coreDb = createCoreDb();

    try {
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'GitHub token',
        now: () => '2026-07-05T00:00:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        secretKind: 'repository-token',
      });

      const created = createVaultGrant(coreDb, {
        allowedInjectionPaths: ['gateway-only'],
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        lifetime: 'turn',
        now: () => '2026-07-05T00:05:00.000Z',
        ownerScope: 'workspace',
        policyDecisionId: 'decision_1',
        subjectSummary: 'worker turn access to GitHub provider',
        targetAgentSessionId: 'session_1',
        targetCapabilityId: 'mcp.github.call_tool',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
      const duplicate = createVaultGrant(coreDb, {
        allowedInjectionPaths: ['runtime-env'],
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        lifetime: 'workspace',
        now: () => '2026-07-05T00:10:00.000Z',
        ownerScope: 'workspace',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultGrant(coreDb, 'grant_00000000-0000-7502-bb07-4104daba6c66')).toEqual(created);
      expect(listVaultGrants(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        allowedInjectionPaths: ['gateway-only'],
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        lifetime: 'turn',
        ownerScope: 'workspace',
        policyDecisionId: 'decision_1',
        status: 'active',
        targetAgentSessionId: 'session_1',
        targetCapabilityId: 'mcp.github.call_tool',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires an existing reference and matching owner scope identity', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_00000000-0000-7278-b714-46e2d53cb316',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_00000000-0000-722b-b433-75d118b2149c',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toThrow('Vault reference not found: vault_00000000-0000-722b-b433-75d118b2149c');

      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'GitHub token',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        secretKind: 'repository-token',
      });

      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_imported_history',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toThrow('Vault grant identifier is not canonical.');

      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_00000000-0000-7c90-9388-4c15ff9c7432',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).toThrow('Workspace-scoped vault grants require workspaceId.');
      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_00000000-0000-744f-bf07-8dd1c8d4e04b',
          lifetime: 'server',
          ownerScope: 'server',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toThrow('Server-scoped vault grants cannot include workspaceId or userId.');
      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: [],
          grantId: 'grant_00000000-0000-7755-b1ef-fb8065537f80',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toThrow('Vault grants require at least one allowed injection path.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('revokes a grant and marks related injection receipts stale', () => {
    const coreDb = createCoreDb();

    try {
      createGrantWithRuntimeFileReceipt(coreDb);

      const revoked = revokeVaultGrant(coreDb, {
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        now: () => '2026-07-05T00:30:00.000Z',
      });

      expect(revoked.status).toBe('revoked');
      expect(listVaultInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
          planId: 'plan_github_file',
          status: 'revoked',
        }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
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
 * Creates a grant, plan, and receipt fixture used by revocation tests.
 *
 * @param coreDb Open Core database handle.
 */
function createGrantWithRuntimeFileReceipt(coreDb: CoreDb): void {
  createVaultReference(coreDb, {
    backendKind: 'encrypted-file',
    displayName: 'GitHub token',
    ownerScope: 'server',
    referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
    secretKind: 'repository-token',
  });
  createVaultGrant(coreDb, {
    allowedInjectionPaths: ['runtime-file'],
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    lifetime: 'turn',
    ownerScope: 'workspace',
    vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
    workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
  });
  createVaultInjectionPlan(coreDb, {
    backendCapabilityRequirement: 'encrypted-file:resolve',
    expirationBehavior: 'delete-on-turn-end',
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    injectionVisibility: 'runtime-file',
    planId: 'plan_github_file',
    redactionRule: 'path-only',
    revocationBehavior: 'mark-session-stale',
    targetPath: '/openkit/secrets/github-token',
  });
  createVaultInjectionReceipt(coreDb, {
    agentSessionId: 'session_1',
    backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    injectedAt: '2026-07-05T00:10:00.000Z',
    planId: 'plan_github_file',
    receiptId: 'receipt_github_file',
    revocationStatus: 'active',
  });
}
