import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';

import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createLockedVaultBackend, VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';
import { createVaultGrant, revokeVaultGrant } from './vault-grants.js';
import { advanceActiveVaultReferenceVersion, createVaultReference } from './vault-references.js';
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
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  return { coreDb, workspaceDb };
}

describe('vault use audited backend', () => {
  it('resolves an intact reference with exact audited version despite unrelated corruption', async () => {
    const { coreDb, workspaceDb } = createDbs();
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-isolated-resolution-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T02:00:00.000Z',
      storeDir,
    });
    const referenceId = 'vault_00000000-0000-7f73-bffa-d96a61ee4d70';
    const unrelatedId = 'vault_00000000-0000-731b-8bf2-16a1252c2b27';
    const firstMaterial = randomBytes(24).toString('base64url');
    const currentMaterial = randomBytes(24).toString('base64url');
    const unrelatedMaterial = randomBytes(24).toString('base64url');
    try {
      backend.store({ referenceId, material: firstMaterial, metadata: { ownerScope: 'server' } });
      const rotated = backend.rotate({ referenceId, material: currentMaterial });
      expect(rotated.currentVersion).toBe(2);
      backend.store({
        referenceId: unrelatedId,
        material: unrelatedMaterial,
        metadata: { ownerScope: 'server' },
      });
      // Deliberately damage only unrelated owner-produced state in this private fixture.
      rmSync(join(storeDir, 'entries', unrelatedId, 'state.json'));
      expect(() => backend.listReferences()).toThrow('backend-unavailable');
      expect(() => backend.resolve({ referenceId: unrelatedId })).toThrow('backend-unavailable');
      expect(
        Buffer.from(backend.resolve({ referenceId })).equals(Buffer.from(currentMaterial))
      ).toBe(true);
      const audited = createVaultUseAuditedBackend({
        backend,
        db: coreDb,
        ownerScope: 'server',
        resolvingPath: 'admin',
        now: () => '2026-07-05T02:01:00.000Z',
      });
      let failureCode: string | null = null;
      let matchesCurrent = false;
      try {
        matchesCurrent = Buffer.from(await audited.resolve({ referenceId })).equals(
          Buffer.from(currentMaterial)
        );
      } catch (error) {
        failureCode = error instanceof VaultBackendError ? error.code : 'unexpected-error';
      }
      // Compare only booleans/codes so a failed check cannot print generated material.
      expect.soft(failureCode).toBeNull();
      expect.soft(matchesCurrent).toBe(true);
      const uses = listVaultUseRecords(coreDb);
      expect.soft(uses).toEqual([
        expect.objectContaining({
          vaultReferenceId: referenceId,
          outcome: 'succeeded',
          failureCode: null,
          materialVersion: 2,
          ownerScope: 'server',
          workspaceId: null,
        }),
      ]);
      const auditRows = coreDb.sqlite
        .prepare("SELECT * FROM audit_events WHERE action = 'vault.resolve'")
        .all();
      expect.soft(auditRows).toEqual([
        expect.objectContaining({
          audit_event_id: uses[0]?.auditEventId,
          resource: `vault:${referenceId}`,
          outcome: 'succeeded',
          error_code: null,
        }),
      ]);
      const evidence = JSON.stringify({ uses, auditRows });
      for (const material of [firstMaterial, currentMaterial, unrelatedMaterial]) {
        expect(evidence.includes(material)).toBe(false);
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('records successful server secret resolution without storing secret material', async () => {
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
          await audited.resolve({ referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70' })
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
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records failed workspace secret resolution attempts', async () => {
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

      await expect(
        audited.resolve({ referenceId: 'vault_00000000-0000-722b-b433-75d118b2149c' })
      ).rejects.toThrow('reference-not-found');
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
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'absent',
    'unissued',
    'revoked',
  ] as const)('rejects mismatched resolution scope with an %s grant', async (grantState) => {
    const { coreDb, workspaceDb } = createDbs();
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T02:00:00.000Z',
      storeDir: mkdtempSync(join(tmpdir(), 'openkit-vault-backend-')),
    });

    const delegatedResolve = vi.spyOn(backend, 'resolve');

    try {
      backend.store({
        material: 'server_only_secret',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_00000000-0000-7747-b360-a66ad994b860',
      });

      const grantId =
        grantState === 'absent' ? undefined : 'grant_00000000-0000-7919-a9bd-25953b88f539';
      if (grantState === 'revoked') {
        await createVaultReference(coreDb, {
          backendKind: backend.kind,
          displayName: 'Scope refusal fixture',
          ownerScope: 'server',
          referenceId: 'vault_00000000-0000-7747-b360-a66ad994b860',
          secretKind: 'mcp-credential',
        });
        await createVaultGrant(coreDb, {
          allowedInjectionPaths: ['gateway-only'],
          grantId: grantId!,
          lifetime: 'server',
          ownerScope: 'server',
          vaultReferenceId: 'vault_00000000-0000-7747-b360-a66ad994b860',
        });
        expect((await revokeVaultGrant(coreDb, { grantId: grantId! })).status).toBe('revoked');
      }

      const audited = createVaultUseAuditedBackend({
        backend,
        createUseId: () => 'vu_00000000-0000-71b5-a3a6-2e8ee6b25407',
        db: workspaceDb,
        ...(grantId ? { grantId } : {}),
        now: () => '2026-07-05T02:04:00.000Z',
        ownerScope: 'workspace',
        resolvingPath: 'provider',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });

      await expect(
        audited.resolve({ referenceId: 'vault_00000000-0000-7747-b360-a66ad994b860' })
      ).rejects.toThrow(
        'backend-unavailable: Vault reference scope does not match resolution scope.'
      );
      expect(delegatedResolve).not.toHaveBeenCalled();
      expect(listVaultUseRecords(workspaceDb)).toEqual([
        expect.objectContaining({
          failureCode: 'backend-unavailable',
          grantId: grantId ?? null,
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
      delegatedResolve.mockRestore();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('records locked backend failures without listing locked inventory', async () => {
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
      await expect(
        audited.resolve({ referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70' })
      ).rejects.toThrow('vault-locked');
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
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'explicit-grace',
    'explicit-expired',
    'implicit-generation',
  ] as const)('revalidates %s after the actual terminal Audit acknowledgement without another material resolve', async (scenario) => {
    const { coreDb, workspaceDb } = createDbs();
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-audit-revalidation-'));
    const referenceId = 'vault_00000000-0000-7f73-bffa-d96a61ee4d70';
    const workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
    const firstMaterial = 'synthetic_audited_prior_material';
    const currentMaterial = 'synthetic_audited_current_material';
    const actor = {
      kind: 'system' as const,
      id: 'vault-revalidation-test',
      responsibleUserId: null,
    };
    let now = '2026-07-05T01:00:00.000Z';
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => now,
      rotationGraceMs: 1_000,
      storeDir,
    });
    const resolve = vi.spyOn(backend, 'resolve');
    const emit = Worker.prototype.emit;
    const reached = Promise.withResolvers<void>();
    let deliver: (() => void) | undefined;
    let taken = false;
    let enabled = true;
    let settled = false;
    let outcome: Promise<{ ok: true; matches: boolean } | { ok: false; code: string }> | undefined;
    const hold = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const reply = args[0] as
        | {
            operation?: string;
            status?: string;
            result?: { kind?: string; value?: { resource?: string; workspaceId?: string } };
          }
        | undefined;
      if (
        enabled &&
        !taken &&
        event === 'message' &&
        reply?.operation === 'vault' &&
        reply.status === 'ok' &&
        reply.result?.kind === 'audit-insert' &&
        reply.result.value?.resource === `vault:${referenceId}` &&
        reply.result.value.workspaceId === workspaceId
      ) {
        taken = true;
        // Preserve the original successful reply: its real Workspace commit already completed.
        deliver = () => emit.call(this, event, ...args);
        reached.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const release = () => {
      enabled = false;
      const pending = deliver;
      deliver = undefined;
      pending?.();
    };
    try {
      backend.store({
        referenceId,
        material: firstMaterial,
        metadata: { ownerScope: 'workspace', workspaceId },
      });
      await createVaultReference(coreDb, {
        referenceId,
        backendKind: backend.kind,
        displayName: 'Held Audit version fixture',
        secretKind: 'mcp-credential',
        ownerScope: 'workspace',
        workspaceId,
      });
      if (scenario !== 'implicit-generation') {
        now = '2026-07-05T01:00:10.000Z';
        expect(backend.rotate({ referenceId, material: currentMaterial }).currentVersion).toBe(2);
        expect(
          (await advanceActiveVaultReferenceVersion(coreDb, { referenceId, currentVersion: 2 }))
            .currentVersion
        ).toBe(2);
      }
      now = '2026-07-05T01:00:10.500Z';
      const audited = createVaultUseAuditedBackend({
        backend,
        db: workspaceDb,
        ownerScope: 'workspace',
        workspaceId,
        actor,
        resolvingPath: 'admin',
        now: () => now,
      });
      const requested =
        scenario === 'implicit-generation' ? { referenceId } : { referenceId, version: 1 };
      // Normalize to booleans/codes immediately so a failed oracle cannot print material.
      outcome = audited.resolve(requested).then(
        (material) => {
          settled = true;
          return {
            ok: true as const,
            matches: Buffer.from(material).equals(Buffer.from(firstMaterial)),
          };
        },
        (error: unknown) => {
          settled = true;
          return {
            ok: false as const,
            code: error instanceof VaultBackendError ? error.code : 'unexpected-error',
          };
        }
      );
      await Promise.race([
        reached.promise,
        outcome.then(() => {
          throw new Error('Resolution settled before the real terminal Audit reply.');
        }),
      ]);
      expect(settled).toBe(false);
      expect(resolve).toHaveBeenCalledTimes(1);
      const uses = listVaultUseRecords(workspaceDb);
      expect(uses).toEqual([
        expect.objectContaining({
          vaultReferenceId: referenceId,
          ownerScope: 'workspace',
          workspaceId,
          materialVersion: 1,
          outcome: 'succeeded',
          resolvingPath: 'admin',
          failureCode: null,
          usedAt: '2026-07-05T01:00:10.500Z',
          capabilityCallId: null,
          agentSessionId: null,
        }),
      ]);
      const audits = workspaceDb.sqlite
        .prepare("SELECT * FROM audit_events WHERE action = 'vault.resolve'")
        .all();
      expect(audits).toEqual([
        expect.objectContaining({
          audit_event_id: uses[0]?.auditEventId,
          workspace_id: workspaceId,
          resource: `vault:${referenceId}`,
          outcome: 'succeeded',
          error_code: null,
        }),
      ]);
      expect(JSON.parse((audits[0] as { actor_json: string }).actor_json)).toEqual(actor);
      if (scenario === 'implicit-generation') {
        expect(backend.rotate({ referenceId, material: currentMaterial }).currentVersion).toBe(2);
        expect(
          (await advanceActiveVaultReferenceVersion(coreDb, { referenceId, currentVersion: 2 }))
            .currentVersion
        ).toBe(2);
      } else {
        now =
          scenario === 'explicit-grace' ? '2026-07-05T01:00:10.999Z' : '2026-07-05T01:00:11.001Z';
      }
      expect(settled).toBe(false);
      release();
      expect(await outcome).toEqual(
        scenario === 'explicit-grace'
          ? { ok: true, matches: true }
          : { ok: false, code: 'version-expired' }
      );
      // Backend Implementation requires one Use per material resolve; validation adds neither.
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(listVaultUseRecords(workspaceDb)).toEqual(uses);
      expect(
        workspaceDb.sqlite
          .prepare("SELECT * FROM audit_events WHERE action = 'vault.resolve'")
          .all()
      ).toEqual(audits);
      const evidence = JSON.stringify({ uses, audits });
      for (const material of [firstMaterial, currentMaterial]) {
        expect(evidence.includes(material)).toBe(false);
      }
    } finally {
      release();
      await outcome;
      hold.mockRestore();
      resolve.mockRestore();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
