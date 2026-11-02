import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';

import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createVaultUseRecord,
  getVaultUseRecord,
  listVaultUseRecords,
} from './vault-use-records.js';

/**
 * Opens migrated Core and workspace databases for vault-use tests.
 *
 * @returns Migrated database handles.
 */
function createDbs(): { coreDb: CoreDb; workspaceDb: WorkspaceDb } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-use-'));
  const coreDb = openCoreDb(dataRoot);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-73c3-900f-8d310e4ba201');
  applyMigrations(coreDb);
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  return { coreDb, workspaceDb };
}

describe('vault use records', () => {
  it('refuses a noncanonical or wrong-kind use identity before persistence', async () => {
    const { coreDb, workspaceDb } = createDbs();
    try {
      const input = {
        backendKind: 'encrypted-file' as const,
        ownerScope: 'server' as const,
        resolvingPath: 'admin' as const,
        outcome: 'failed' as const,
        failureCode: 'reference-not-found',
        usedAt: '2026-07-05T00:20:00.000Z',
        vaultReferenceId: 'vault_01890f3e-0000-7000-8000-000000000001',
      };
      for (const useId of [
        'use_01890f3e-0000-7000-8000-000000000001',
        'vu_01890f3e-0000-4000-8000-000000000001',
        'vu_legacy',
      ]) {
        await expect(createVaultUseRecord(coreDb, { ...input, useId })).rejects.toThrow(
          'VaultUse identifiers are not canonical.'
        );
      }
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_use_records').get()
      ).toEqual({ count: 0 });
      const useId = 'vu_01890f3e-0000-7000-8000-000000000001';
      expect((await createVaultUseRecord(coreDb, { ...input, useId })).useId).toBe(useId);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('creates, reads, and lists non-secret server vault use records', async () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      const created = await createVaultUseRecord(coreDb, {
        agentSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
        auditEventId: 'aud_00000000-0000-70e2-abff-6e1084ebf069',
        backendKind: 'encrypted-file',
        grantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        materialVersion: 1,
        outcome: 'succeeded',
        ownerScope: 'server',
        resolvingPath: 'grant',
        usedAt: '2026-07-05T00:20:00.000Z',
        useId: 'vu_00000000-0000-7de7-8524-24839a742ee9',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      });
      const duplicate = await createVaultUseRecord(coreDb, {
        backendKind: 'encrypted-file',
        failureCode: 'vault-locked',
        outcome: 'failed',
        ownerScope: 'server',
        resolvingPath: 'admin',
        usedAt: '2026-07-05T00:30:00.000Z',
        useId: 'vu_00000000-0000-7de7-8524-24839a742ee9',
        vaultReferenceId: 'vault_00000000-0000-75a5-94fe-83ddb0d2a47d',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultUseRecord(coreDb, 'vu_00000000-0000-7de7-8524-24839a742ee9')).toEqual(created);
      expect(listVaultUseRecords(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        agentSessionId: 'as_00000000-0000-7fee-81f4-cfcfc003f25f',
        auditEventId: 'aud_00000000-0000-70e2-abff-6e1084ebf069',
        backendKind: 'encrypted-file',
        grantId: 'grant_00000000-0000-7919-a9bd-25953b88f539',
        materialVersion: 1,
        outcome: 'succeeded',
        ownerScope: 'server',
        resolvingPath: 'grant',
        usedAt: '2026-07-05T00:20:00.000Z',
        vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        workspaceId: null,
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records failed workspace vault use without requiring a vault reference row', async () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      const created = await createVaultUseRecord(workspaceDb, {
        backendKind: 'encrypted-file',
        capabilityCallId: 'cap_00000000-0000-7289-8845-faf171b19b16',
        failureCode: 'reference-revoked',
        outcome: 'failed',
        ownerScope: 'workspace',
        resolvingPath: 'plan',
        planId: 'plan_1',
        usedAt: '2026-07-05T00:25:00.000Z',
        useId: 'vu_00000000-0000-7cc3-896d-f0e87b351711',
        vaultReferenceId: 'vault_00000000-0000-722b-b433-75d118b2149c',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });

      expect(getVaultUseRecord(workspaceDb, 'vu_00000000-0000-7cc3-896d-f0e87b351711')).toEqual(
        created
      );
      expect(listVaultUseRecords(workspaceDb)).toEqual([created]);
      expect(created).toMatchObject({
        capabilityCallId: 'cap_00000000-0000-7289-8845-faf171b19b16',
        failureCode: 'reference-revoked',
        materialVersion: null,
        outcome: 'failed',
        ownerScope: 'workspace',
        planId: 'plan_1',
        resolvingPath: 'plan',
        vaultReferenceId: 'vault_00000000-0000-722b-b433-75d118b2149c',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('validates scope and resolution metadata', async () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      await expect(
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'succeeded',
          ownerScope: 'server',
          resolvingPath: 'grant',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'vu_00000000-0000-7167-952b-c6288927491d',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).rejects.toThrow('Successful vault use records require materialVersion.');
      await expect(
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          failureCode: 'reference-revoked',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'plan',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'vu_00000000-0000-7e69-8e3b-cf542fb9d2ab',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).rejects.toThrow('Plan-based vault use records require planId.');
      await expect(
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'vu_00000000-0000-7ba1-af2a-7bea55b79952',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).rejects.toThrow('Failed or denied vault use records require failureCode.');
      await expect(
        createVaultUseRecord(workspaceDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'workspace',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'vu_00000000-0000-7ad3-a9f6-beb198cf9090',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).rejects.toThrow('Workspace-scoped vault use records require workspaceId.');
      await expect(
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'vu_00000000-0000-7471-91c3-59f81b1fce47',
          vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).rejects.toThrow('Server-scoped vault use records cannot include workspaceId.');
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
