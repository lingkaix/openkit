import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createInjectionPlan, listInjectionPlans } from '../injection-plans.js';
import { createInjectionReceipt, listInjectionReceipts } from '../injection-receipts.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
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
        referenceId: 'vault_github',
        secretKind: 'repository-token',
      });

      const created = createVaultGrant(coreDb, {
        allowedInjectionPaths: ['gateway-only'],
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_github_turn',
        lifetime: 'turn',
        now: () => '2026-07-05T00:05:00.000Z',
        ownerScope: 'workspace',
        policyDecisionId: 'decision_1',
        subjectSummary: 'worker turn access to GitHub provider',
        targetAgentSessionId: 'session_1',
        targetCapabilityId: 'mcp.github.call_tool',
        vaultReferenceId: 'vault_github',
        workspaceId: 'ws_1',
      });
      const duplicate = createVaultGrant(coreDb, {
        allowedInjectionPaths: ['runtime-env'],
        grantId: 'grant_github_turn',
        lifetime: 'workspace',
        now: () => '2026-07-05T00:10:00.000Z',
        ownerScope: 'workspace',
        vaultReferenceId: 'vault_github',
        workspaceId: 'ws_1',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultGrant(coreDb, 'grant_github_turn')).toEqual(created);
      expect(listVaultGrants(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        allowedInjectionPaths: ['gateway-only'],
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_github_turn',
        lifetime: 'turn',
        ownerScope: 'workspace',
        policyDecisionId: 'decision_1',
        status: 'active',
        targetAgentSessionId: 'session_1',
        targetCapabilityId: 'mcp.github.call_tool',
        vaultReferenceId: 'vault_github',
        workspaceId: 'ws_1',
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
          grantId: 'grant_missing',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_missing',
          workspaceId: 'ws_1',
        })
      ).toThrow('Vault reference not found: vault_missing');

      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'GitHub token',
        ownerScope: 'server',
        referenceId: 'vault_github',
        secretKind: 'repository-token',
      });

      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_imported_ws_1_1',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_github',
          workspaceId: 'ws_1',
        })
      ).toThrow('Vault grant id uses the reserved portable-import authority namespace.');

      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_no_workspace',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_github',
        })
      ).toThrow('Workspace-scoped vault grants require workspaceId.');
      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: 'grant_server_workspace',
          lifetime: 'server',
          ownerScope: 'server',
          vaultReferenceId: 'vault_github',
          workspaceId: 'ws_1',
        })
      ).toThrow('Server-scoped vault grants cannot include workspaceId or userId.');
      expect(() =>
        createVaultGrant(coreDb, {
          allowedInjectionPaths: [],
          grantId: 'grant_empty_paths',
          lifetime: 'turn',
          ownerScope: 'workspace',
          vaultReferenceId: 'vault_github',
          workspaceId: 'ws_1',
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
        grantId: 'grant_github_turn',
        now: () => '2026-07-05T00:30:00.000Z',
      });

      expect(revoked.status).toBe('revoked');
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
 * Creates a grant, plan, and receipt fixture used by revocation tests.
 *
 * @param coreDb Open Core database handle.
 */
function createGrantWithRuntimeFileReceipt(coreDb: CoreDb): void {
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
