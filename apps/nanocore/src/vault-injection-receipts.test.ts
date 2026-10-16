import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordServerAuditEvent } from './audit-events.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createVaultGrant, revokeVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultInjectionPlan } from './vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  getVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from './vault-injection-receipts.js';

const fixtureRoots = new Set<string>();
afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

/**
 * Opens a migrated Core database for injection receipt tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-injection-receipt-'));
  fixtureRoots.add(dataRoot);
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
        backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        injectedAt: '2026-07-05T00:10:00.000Z',
        planId: 'plan_github_file',
        receiptId: 'receipt_github_file',
        revocationStatus: 'active',
      });
      const duplicate = createVaultInjectionReceipt(coreDb, {
        ...created,
      });
      expect(duplicate).toEqual(created);
      for (const patch of [
        { backendSummary: 'changed' },
        { agentSessionId: null, capabilityCallId: 'call_1' },
        { auditEventId: null },
        { injectedAt: '2026-07-05T00:20:00.000Z' },
        { expiresAt: null },
      ] as const) {
        expect(() => createVaultInjectionReceipt(coreDb, { ...created, ...patch })).toThrow(
          'Vault injection receipt identity conflict.'
        );
        expect(listVaultInjectionReceipts(coreDb)).toEqual([created]);
      }

      expect(getVaultInjectionReceipt(coreDb, 'receipt_github_file')).toEqual(created);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        agentSessionId: 'session_1',
        auditEventId: 'audit_1',
        backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
        expiresAt: '2026-07-05T01:00:00.000Z',
        grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
        injectedAt: '2026-07-05T00:10:00.000Z',
        planId: 'plan_github_file',
        receiptId: 'receipt_github_file',
        revocationStatus: 'active',
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
      revokeVaultGrant(coreDb, { grantId: created.grantId });
      const revoked = getVaultInjectionReceipt(coreDb, created.receiptId);
      expect(revoked?.revocationStatus).not.toBe('active');
      expect(createVaultInjectionReceipt(coreDb, { ...created })).toEqual(revoked);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires exact human delivery Audit for a preview receipt with no Worker lineage', () => {
    const coreDb = createCoreDb();
    try {
      createVaultReference(coreDb, {
        referenceId: 'preview_reference',
        ownerScope: 'server',
        backendKind: 'encrypted-file',
        secretKind: 'mcp-token',
        displayName: 'Preview',
      });
      createVaultGrant(coreDb, {
        grantId: 'preview_grant',
        vaultReferenceId: 'preview_reference',
        ownerScope: 'server',
        lifetime: 'server',
        allowedInjectionPaths: ['gateway-only'],
      });
      createVaultInjectionPlan(coreDb, {
        planId: 'preview_plan',
        grantId: 'preview_grant',
        capabilityId: 'mcp.list_tools',
        injectionVisibility: 'gateway-only',
        expirationBehavior: 'grant-lifetime',
        revocationBehavior: 'close-temporary-gateway-session',
        redactionRule: 'exact-resolved-material',
        backendCapabilityRequirement: 'mcp-gateway:http',
      });
      const receipt = {
        receiptId: 'preview_receipt',
        planId: 'preview_plan',
        grantId: 'preview_grant',
        backendSummary: 'mcp-gateway:http:preview',
        injectedAt: '2026-07-05T00:10:00.000Z',
        revocationStatus: 'active' as const,
      };
      const delivery = {
        coreDb,
        actor: { kind: 'user' as const, id: 'administrator' },
        workspaceId: null,
        requestId: randomUUID(),
        vaultGrantId: 'preview_grant',
        action: 'administration.mcp-discovery-preview.delivery',
        resource: 'vault-injection-plan:preview_plan',
        outcome: 'succeeded' as const,
        summary: 'Synthetic completed transport delivery.',
      };
      for (const patch of [
        { action: 'administration.mcp-discovery-preview' },
        { outcome: 'failed' as const },
        { resource: 'vault-injection-plan:another_plan' },
        { vaultGrantId: 'another_grant' },
        { requestId: null },
        { actor: { kind: 'system' as const, id: 'system', responsibleUserId: 'administrator' } },
      ]) {
        const event = recordServerAuditEvent({ ...delivery, ...patch });
        expect(() =>
          createVaultInjectionReceipt(coreDb, { ...receipt, auditEventId: event.id })
        ).toThrow();
        expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      }
      expect(() =>
        createVaultInjectionReceipt(coreDb, { ...receipt, auditEventId: 'missing_audit' })
      ).toThrow();
      const audit = recordServerAuditEvent(delivery);
      const created = createVaultInjectionReceipt(coreDb, { ...receipt, auditEventId: audit.id });
      expect(created).toMatchObject({
        agentSessionId: null,
        capabilityCallId: null,
        auditEventId: audit.id,
      });
      expect(createVaultInjectionReceipt(coreDb, { ...created })).toEqual(created);
    } finally {
      coreDb.sqlite.close();
    }
  });
  it('requires an existing plan, matching grant, and a session or capability call', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
          capabilityCallId: 'call_1',
          grantId: 'grant_00000000-0000-7278-b714-46e2d53cb316',
          injectedAt: '2026-07-05T00:10:00.000Z',
          planId: 'plan_missing',
          receiptId: 'receipt_missing',
          revocationStatus: 'active',
        })
      ).toThrow('Injection plan not found: plan_missing');

      createPlan(coreDb);

      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
          capabilityCallId: 'call_1',
          grantId: 'grant_00000000-0000-7cdc-be0b-b3cce2871c66',
          injectedAt: '2026-07-05T00:10:00.000Z',
          planId: 'plan_github_file',
          receiptId: 'receipt_wrong_grant',
          revocationStatus: 'active',
        })
      ).toThrow('Injection receipt grant id must match the injection plan grant id.');
      expect(() =>
        createVaultInjectionReceipt(coreDb, {
          backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
          grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
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
}
