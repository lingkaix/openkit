import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createLockedVaultBackend } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';
import { createVaultUseAuditedBackend } from './vault-use-audited-backend.js';
import { listVaultUseRecords } from './vault-use-records.js';

/**
 * Opens migrated databases for audited backend tests.
 *
 * @returns Migrated database handles.
 */
function createDbs(): { coreDb: CoreDb; workspaceDb: WorkspaceDb } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-use-audited-'));
  const coreDb = openCoreDb(dataRoot);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
  applyMigrations(coreDb);
  applyScopedMigrations(workspaceDb);
  return { coreDb, workspaceDb };
}

describe('vault use audited backend', () => {
  it('records successful server secret resolution without storing secret material', () => {
    const { coreDb, workspaceDb } = createDbs();
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T02:00:00.000Z',
      storeDir: mkdtempSync(join(tmpdir(), 'openkit-vault-backend-')),
    });

    try {
      backend.store({
        material: 'ghp_live_secret',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      });

      const audited = createVaultUseAuditedBackend({
        backend,
        createUseId: () => 'vu_00000000-0000-76ef-929d-5d592024e236',
        db: coreDb,
        grantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        now: () => '2026-07-05T02:01:00.000Z',
        ownerScope: 'server',
        resolvingPath: 'grant',
      });

      expect(
        Buffer.from(
          audited.resolve({ referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70' })
        ).toString('utf8')
      ).toBe('ghp_live_secret');
      const records = listVaultUseRecords(coreDb);
      const auditRow = coreDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
        .get(records[0]?.auditEventId) as Record<string, unknown> | undefined;

      expect(records).toEqual([
        expect.objectContaining({
          auditEventId: expect.stringMatching(/^aud_/),
          backendKind: 'encrypted-file',
          failureCode: null,
          grantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
          materialVersion: 1,
          outcome: 'succeeded',
          ownerScope: 'server',
          resolvingPath: 'grant',
          usedAt: '2026-07-05T02:01:00.000Z',
          useId: 'vu_00000000-0000-76ef-929d-5d592024e236',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
          workspaceId: null,
        }),
      ]);
      expect(auditRow).toMatchObject({
        action: 'vault.resolve',
        audit_event_id: records[0]?.auditEventId,
        category: 'system',
        error_code: null,
        outcome: 'succeeded',
        resource: 'vault:vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        severity: 'info',
        vault_grant_id: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        workspace_id: null,
      });
      expect(JSON.stringify(records)).not.toContain('ghp_live_secret');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records failed workspace secret resolution attempts', () => {
    const { coreDb, workspaceDb } = createDbs();
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T02:00:00.000Z',
      storeDir: mkdtempSync(join(tmpdir(), 'openkit-vault-backend-')),
    });

    try {
      const audited = createVaultUseAuditedBackend({
        backend,
        capabilityCallId: 'cap_00000000-0000-7289-8845-faf171b19b16',
        createUseId: () => 'vu_00000000-0000-76f6-90d7-e6da6d369da3',
        db: workspaceDb,
        now: () => '2026-07-05T02:02:00.000Z',
        ownerScope: 'workspace',
        planId: 'plan_1',
        resolvingPath: 'plan',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });

      expect(() =>
        audited.resolve({ referenceId: 'vault_00000000-0000-722b-b433-75d118b2149c' })
      ).toThrow('reference-not-found');
      const records = listVaultUseRecords(workspaceDb);
      const auditRow = workspaceDb.sqlite
        .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
        .get(records[0]?.auditEventId) as Record<string, unknown> | undefined;

      expect(records).toEqual([
        expect.objectContaining({
          auditEventId: expect.stringMatching(/^aud_/),
          backendKind: 'encrypted-file',
          capabilityCallId: 'cap_00000000-0000-7289-8845-faf171b19b16',
          failureCode: 'reference-not-found',
          materialVersion: null,
          outcome: 'failed',
          ownerScope: 'workspace',
          planId: 'plan_1',
          resolvingPath: 'plan',
          usedAt: '2026-07-05T02:02:00.000Z',
          useId: 'vu_00000000-0000-76f6-90d7-e6da6d369da3',
          vaultReferenceId: 'vault_00000000-0000-722b-b433-75d118b2149c',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        }),
      ]);
      expect(auditRow).toMatchObject({
        action: 'vault.resolve',
        agent_session_id: null,
        audit_event_id: records[0]?.auditEventId,
        capability_call_id: 'cap_00000000-0000-7289-8845-faf171b19b16',
        category: 'system',
        error_code: 'reference-not-found',
        outcome: 'failed',
        resource: 'vault:vault_00000000-0000-722b-b433-75d118b2149c',
        severity: 'error',
        workspace_id: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects audited resolution when the reference owner scope differs from the caller scope', () => {
    const { coreDb, workspaceDb } = createDbs();
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T02:00:00.000Z',
      storeDir: mkdtempSync(join(tmpdir(), 'openkit-vault-backend-')),
    });

    try {
      backend.store({
        material: 'server_only_secret',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_00000000-0000-7747-b360-a66ad994b860',
      });

      const audited = createVaultUseAuditedBackend({
        backend,
        createUseId: () => 'vu_00000000-0000-71b5-a3a6-2e8ee6b25407',
        db: workspaceDb,
        now: () => '2026-07-05T02:04:00.000Z',
        ownerScope: 'workspace',
        resolvingPath: 'provider',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });

      expect(() =>
        audited.resolve({ referenceId: 'vault_00000000-0000-7747-b360-a66ad994b860' })
      ).toThrow('backend-unavailable: Vault reference scope does not match resolution scope.');
      expect(listVaultUseRecords(workspaceDb)).toEqual([
        expect.objectContaining({
          failureCode: 'backend-unavailable',
          materialVersion: null,
          outcome: 'failed',
          ownerScope: 'workspace',
          useId: 'vu_00000000-0000-71b5-a3a6-2e8ee6b25407',
          vaultReferenceId: 'vault_00000000-0000-7747-b360-a66ad994b860',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(workspaceDb))).not.toContain('server_only_secret');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records locked backend failures without listing locked inventory', () => {
    const { coreDb, workspaceDb } = createDbs();
    const audited = createVaultUseAuditedBackend({
      backend: createLockedVaultBackend({
        diagnostic: 'vault is locked',
        kind: 'encrypted-file',
      }),
      createUseId: () => 'vu_00000000-0000-7bfa-81f1-3584e640b846',
      db: coreDb,
      now: () => '2026-07-05T02:03:00.000Z',
      ownerScope: 'server',
      resolvingPath: 'admin',
    });

    try {
      expect(() =>
        audited.resolve({ referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70' })
      ).toThrow('vault-locked');
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          failureCode: 'vault-locked',
          materialVersion: null,
          outcome: 'failed',
          resolvingPath: 'admin',
          useId: 'vu_00000000-0000-7bfa-81f1-3584e640b846',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
