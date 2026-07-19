import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_1');
  applyMigrations(coreDb);
  applyScopedMigrations(workspaceDb);
  return { coreDb, workspaceDb };
}

describe('vault use records', () => {
  it('creates, reads, and lists non-secret server vault use records', () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      const created = createVaultUseRecord(coreDb, {
        agentSessionId: 'session_1',
        auditEventId: 'audit_1',
        backendKind: 'encrypted-file',
        grantId: 'grant_1',
        materialVersion: 1,
        outcome: 'succeeded',
        ownerScope: 'server',
        resolvingPath: 'grant',
        usedAt: '2026-07-05T00:20:00.000Z',
        useId: 'use_1',
        vaultReferenceId: 'vault_github',
      });
      const duplicate = createVaultUseRecord(coreDb, {
        backendKind: 'os-keychain',
        failureCode: 'vault-locked',
        outcome: 'failed',
        ownerScope: 'server',
        resolvingPath: 'admin',
        usedAt: '2026-07-05T00:30:00.000Z',
        useId: 'use_1',
        vaultReferenceId: 'vault_github_changed',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultUseRecord(coreDb, 'use_1')).toEqual(created);
      expect(listVaultUseRecords(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        agentSessionId: 'session_1',
        auditEventId: 'audit_1',
        backendKind: 'encrypted-file',
        grantId: 'grant_1',
        materialVersion: 1,
        outcome: 'succeeded',
        ownerScope: 'server',
        resolvingPath: 'grant',
        usedAt: '2026-07-05T00:20:00.000Z',
        vaultReferenceId: 'vault_github',
        workspaceId: null,
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records failed workspace vault use without requiring a vault reference row', () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      const created = createVaultUseRecord(workspaceDb, {
        backendKind: 'encrypted-file',
        capabilityCallId: 'call_1',
        failureCode: 'reference-revoked',
        outcome: 'failed',
        ownerScope: 'workspace',
        resolvingPath: 'plan',
        planId: 'plan_1',
        usedAt: '2026-07-05T00:25:00.000Z',
        useId: 'use_workspace_failed',
        vaultReferenceId: 'vault_missing',
        workspaceId: 'ws_1',
      });

      expect(getVaultUseRecord(workspaceDb, 'use_workspace_failed')).toEqual(created);
      expect(listVaultUseRecords(workspaceDb)).toEqual([created]);
      expect(created).toMatchObject({
        capabilityCallId: 'call_1',
        failureCode: 'reference-revoked',
        materialVersion: null,
        outcome: 'failed',
        ownerScope: 'workspace',
        planId: 'plan_1',
        resolvingPath: 'plan',
        vaultReferenceId: 'vault_missing',
        workspaceId: 'ws_1',
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('validates scope and resolution metadata', () => {
    const { coreDb, workspaceDb } = createDbs();

    try {
      expect(() =>
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'succeeded',
          ownerScope: 'server',
          resolvingPath: 'grant',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'use_missing_version',
          vaultReferenceId: 'vault_github',
        })
      ).toThrow('Successful vault use records require materialVersion.');
      expect(() =>
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          failureCode: 'reference-revoked',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'plan',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'use_missing_plan',
          vaultReferenceId: 'vault_github',
        })
      ).toThrow('Plan-based vault use records require planId.');
      expect(() =>
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'use_missing_failure_code',
          vaultReferenceId: 'vault_github',
        })
      ).toThrow('Failed or denied vault use records require failureCode.');
      expect(() =>
        createVaultUseRecord(workspaceDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'workspace',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'use_missing_workspace',
          vaultReferenceId: 'vault_github',
        })
      ).toThrow('Workspace-scoped vault use records require workspaceId.');
      expect(() =>
        createVaultUseRecord(coreDb, {
          backendKind: 'encrypted-file',
          outcome: 'failed',
          ownerScope: 'server',
          resolvingPath: 'admin',
          usedAt: '2026-07-05T00:20:00.000Z',
          useId: 'use_server_workspace',
          vaultReferenceId: 'vault_github',
          workspaceId: 'ws_1',
        })
      ).toThrow('Server-scoped vault use records cannot include workspaceId.');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
