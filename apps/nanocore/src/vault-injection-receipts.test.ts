import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  getVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from './vault-injection-receipts.js';

/**
 * Opens a migrated Core database for injection receipt tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-injection-receipt-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('injection receipts', () => {
  it('creates, reads, and lists non-secret injection receipts', () => {
    const coreDb = createCoreDb();

    try {
      createPlan(coreDb);

      const created = createVaultInjectionReceipt(coreDb, {
        agentSessionId: 'session_1',
        auditEventId: 'audit_1',
        backendSummary: 'encrypted-file:vault_github:v1',
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_github_turn',
        injectedAt: '2026-07-05T00:10:00.000Z',
        planId: 'plan_github_file',
        receiptId: 'receipt_github_file',
        revocationStatus: 'active',
      });
      const duplicate = createVaultInjectionReceipt(coreDb, {
        backendSummary: 'changed',
        capabilityCallId: 'call_1',
        grantId: 'grant_github_turn',
        injectedAt: '2026-07-05T00:20:00.000Z',
        planId: 'plan_github_file',
        receiptId: 'receipt_github_file',
        revocationStatus: 'revoked',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultInjectionReceipt(coreDb, 'receipt_github_file')).toEqual(created);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        agentSessionId: 'session_1',
        auditEventId: 'audit_1',
        backendSummary: 'encrypted-file:vault_github:v1',
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_github_turn',
        injectedAt: '2026-07-05T00:10:00.000Z',
        planId: 'plan_github_file',
        receiptId: 'receipt_github_file',
        revocationStatus: 'active',
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires an existing plan, matching grant, and a session or capability call', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_github:v1',
          capabilityCallId: 'call_1',
          grantId: 'grant_missing',
          injectedAt: '2026-07-05T00:10:00.000Z',
          planId: 'plan_missing',
          receiptId: 'receipt_missing',
          revocationStatus: 'active',
        })
      ).toThrow('Injection plan not found: plan_missing');

      createPlan(coreDb);

      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_github:v1',
          capabilityCallId: 'call_1',
          grantId: 'grant_other',
          injectedAt: '2026-07-05T00:10:00.000Z',
          planId: 'plan_github_file',
          receiptId: 'receipt_wrong_grant',
          revocationStatus: 'active',
        })
      ).toThrow('Injection receipt grant id must match the injection plan grant id.');
      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_github:v1',
          grantId: 'grant_github_turn',
          injectedAt: '2026-07-05T00:10:00.000Z',
          planId: 'plan_github_file',
          receiptId: 'receipt_no_actor',
          revocationStatus: 'active',
        })
      ).toThrow('Injection receipts require agentSessionId or capabilityCallId.');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates the plan fixture used by injection receipt tests.
 *
 * @param coreDb Open Core database handle.
 */
function createPlan(coreDb: CoreDb): void {
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
}
