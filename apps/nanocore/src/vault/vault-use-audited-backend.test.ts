import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { OperationId } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1 } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import { listWorkspaceAuditEvents } from '../audit-events.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import { resolveHarnessLogicalModelCatalog } from '../llm/logical-models.js';
import { PolicyInterception } from '../policy/interception.js';
import { listExportableWorkspacePermissionDecisions } from '../policy/permission-decisions.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { getVaultInjectionPlan, listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createLockedVaultBackend, VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';
import { createVaultGrant, getVaultGrant, revokeVaultGrant } from './vault-grants.js';
import { advanceActiveVaultReferenceVersion, createVaultReference } from './vault-references.js';
import { createVaultUnlockState } from './vault-unlock-state.js';
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

  it.each(['absent', 'unissued', 'revoked'] as const)(
    'rejects mismatched resolution scope with an %s grant',
    async (grantState) => {
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
        expect(JSON.stringify(listVaultUseRecords(workspaceDb))).not.toContain(
          'server_only_secret'
        );
      } finally {
        delegatedResolve.mockRestore();
        await shutdownControlStoreWorkerClient();
        workspaceDb.sqlite.close();
        coreDb.sqlite.close();
      }
    }
  );

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

  it.each(['explicit-grace', 'explicit-expired', 'implicit-generation'] as const)(
    'revalidates %s after the actual terminal Audit acknowledgement without another material resolve',
    async (scenario) => {
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
      let outcome:
        | Promise<{ ok: true; matches: boolean } | { ok: false; code: string }>
        | undefined;
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
    }
  );
});

/** Creates a real reviewed cross-scope grant; material and account fixtures never leave this root. */
async function reviewedLoginUseFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-login-use-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const ownerId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 43) });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  const options = {
    coreDb,
    dataRoot,
    store,
    vaultUnlockState,
    runtimeConfigManager,
    policyInterception: new PolicyInterception(),
  };
  const ownerApp = createApp(options);
  const auth = createBetterAuth(coreDb, { env: {} });
  const memberApp = createApp({ ...options, mode: 'server', auth });
  const workspaceHandles: WorkspaceDb[] = [];
  const close = async () => {
    await shutdownControlStoreWorkerClient();
    vaultUnlockState.lock();
    for (const db of workspaceHandles) db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  };
  try {
    /** Uses the real HTTP operation and reports only its status if valid fixture setup fails. */
    const call = async <T>(id: OperationId, input: Record<string, unknown>, cookie?: string) => {
      const response = await (cookie ? memberApp : ownerApp).request(
        ...operationRequest(
          id,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
            body: JSON.stringify(input),
          }
        )
      );
      if (response.status >= 400)
        throw new Error(`Login-use fixture ${id} refused with status ${response.status}.`);
      return response.json() as Promise<T>;
    };
    /** Signup supplies a real Session; no authentication response or admission decision is replaced. */
    const signup = async (name: string) => {
      const response = await auth.api.signUpEmail({
        body: { name, email: `${randomUUID()}@example.invalid`, password: randomUUID() },
        asResponse: true,
      });
      if (response.status !== 200) throw new Error('Login-use fixture signup refused.');
      const result = (await response.json()) as { user: { id: string; email: string } };
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookie) throw new Error('Login-use fixture signup supplied no Session cookie.');
      return { ...result.user, cookie };
    };
    const member = await signup('Shared Login consumer');
    const outsider = await signup('Unadmitted Login consumer');
    const workspace = await call<{ id: string }>('workspace.create', {
      name: 'Reviewed Login use',
      requestId: randomUUID(),
    });
    const invitation = await call<{ invitation: { invitationId: string; revision: number } }>(
      'workspace.invitation-create',
      { workspaceId: workspace.id, inviteeEmail: member.email, requestId: randomUUID() }
    );
    await call(
      'workspace.my-invitation-accept',
      {
        invitationId: invitation.invitation.invitationId,
        expectedRevision: invitation.invitation.revision,
        requestId: randomUUID(),
      },
      member.cookie
    );
    const thread = await call<{ id: string }>('thread.create', {
      workspaceId: workspace.id,
      name: 'Explicit Login consent',
      visibility: 'workspace',
      requestId: randomUUID(),
    });
    const referenceId = allocateEntityId('vault');
    const material = randomBytes(32).toString('base64url');
    const backend = vaultUnlockState.backend();
    backend.store({ referenceId, material, metadata: { ownerScope: 'user', userId: ownerId } });
    await createVaultReference(coreDb, {
      referenceId,
      ownerScope: 'user',
      userId: ownerId,
      displayName: 'Synthetic reviewed Login',
      secretKind: 'codex-auth-json',
      backendKind: backend.kind,
      login: { provider: 'codex', accountId: 'synthetic-audited-account', quarantined: false },
    });
    const expiresAt = '2099-01-01T00:00:00.000Z';
    const request = await call<{
      workspaceId: string;
      threadId: string;
      raisingTurnId: string;
      approvalRequestId: string;
    }>('vault.grant-request', {
      workspaceId: workspace.id,
      threadId: thread.id,
      requestId: randomUUID(),
      terms: {
        referenceId,
        ownerScope: 'workspace',
        lifetime: 'workspace',
        injectionPath: 'runtime-token',
        expiresAt,
      },
    });
    await call('approval.respond', {
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      turnId: request.raisingTurnId,
      approvalRequestId: request.approvalRequestId,
      decision: 'granted',
      requestId: randomUUID(),
    });
    const issued = await call<{ grantId: string }>('vault.grant-issue', {
      workspaceId: workspace.id,
      threadId: thread.id,
      approvalRequestId: request.approvalRequestId,
    });
    const grant = getVaultGrant(coreDb, issued.grantId);
    expect(grant).toMatchObject({
      issuance: 'target',
      ownerScope: 'workspace',
      workspaceId: workspace.id,
      vaultReferenceId: referenceId,
      allowedInjectionPaths: ['runtime-token'],
      status: 'active',
    });
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    workspaceHandles.push(workspaceDb);
    const otherWorkspace = await call<{ id: string }>('workspace.create', {
      name: 'Unselected consumer scope',
      requestId: randomUUID(),
    });
    const otherDb = openWorkspaceDb(dataRoot, otherWorkspace.id);
    workspaceHandles.push(otherDb);
    let time = new Date().toISOString();
    return {
      coreDb,
      workspaceDb,
      otherDb,
      dataRoot,
      ownerId,
      memberId: member.id,
      outsiderId: outsider.id,
      referenceId,
      grantId: issued.grantId,
      backend,
      material,
      store,
      runtimeConfigManager,
      vaultUnlockState,
      threadId: thread.id,
      call,
      close,
      setTime: (value: string) => {
        time = value;
      },
      resolve: (userId = ownerId, db = workspaceDb, grantId: string | undefined = issued.grantId) =>
        createVaultUseAuditedBackend({
          backend,
          db,
          ownerScope: 'workspace',
          workspaceId: db.workspaceId,
          actor: { kind: 'user', id: userId },
          resolvingPath: 'grant',
          ...(grantId ? { grantId } : {}),
          now: () => time,
        }).resolve({ referenceId }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Immediately reduces private resolution to safe facts; assertions never print material or raw errors. */
function loginUseOutcome(work: Promise<unknown>, material: string) {
  return work.then(
    (value) => ({
      ok: true,
      matches: Buffer.from(value as Uint8Array).equals(Buffer.from(material)),
    }),
    () => ({ ok: false, matches: false })
  );
}

// Owner: Core Vault / Authority And Projection Boundaries; Vault And Secret Injection /
// Ownership Scopes, Reviewed User Login Sharing, Selection And Activation, Lifecycle And Failure Rules.
describe('reviewed Workspace grant to User Login material boundary', () => {
  // Policy Enforcement Mapping / Point And Evaluation Contract; Vault Login / lifecycle:
  // runtime-token uses the same final denial, retained decision and Audit before any effect.
  it('denies a reviewed runtime-token binding through governed Policy before material or runtime effects', async () => {
    const f = await reviewedLoginUseFixture();
    const resolve = vi.spyOn(f.backend, 'resolve');
    const storeMaterial = vi.spyOn(f.backend, 'store');
    const rotate = vi.spyOn(f.backend, 'rotate');
    const revoke = vi.spyOn(f.backend, 'revoke');
    let restoreEffect: (() => void) | undefined;
    const policyDbs = new Map<string, WorkspaceDb>();
    try {
      const workspaceId = f.workspaceDb.workspaceId;
      const turn = await f.store.createTurn(workspaceId, f.threadId, 'Prepare reviewed Login', {
        kind: 'user',
        id: f.ownerId,
      });
      await f.store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
      const agentSessionId = allocateEntityId('as');
      const entry = createSchedulerAdmissionEntry(f.coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${turn.id}`,
        requestedAgentId: 'agent_codex_host',
        workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        turnInput: 'Prepare reviewed Login',
        triggerActor: turn.triggerActor,
        requestId: randomUUID(),
      });
      // Existing below-dispatch preparation builder records no backend acceptance or ready result.
      const attempt = recordTestExecutionAttempt(f.coreDb, {
        entry,
        attemptId: allocateEntityId('attempt'),
        agentSessionId,
        inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
        bindingRef: `binding:${randomUUID()}`,
        sessionCompatibilityKey: 'reviewed-login-policy-preparation',
        now: () => new Date().toISOString(),
      });
      const privateRoute = { providerProfileId: 'native-metadata', providerModel: 'gpt-5.1-codex' };
      const setup = createTestAgentSetup({
        privateRoute,
        credentialDeclarations: [
          {
            id: 'reviewed-login',
            requirementId: 'reviewed-login',
            vaultGrantId: f.grantId,
            visibility: 'runtime-token',
            consumer: 'codex-login',
          },
        ],
      });
      // Harness routes require the complete descriptor derived by the real metadata owner;
      // the generic shared setup intentionally supplies only minimal Gateway model fields.
      setup.logicalModels.allowed = resolveHarnessLogicalModelCatalog(
        createTestGatewayConfig({ privateRoute }),
        new ProviderRegistry([
          {
            id: privateRoute.providerProfileId,
            displayName: 'Synthetic Codex model metadata',
            kind: 'oauth',
            vendor: 'openai-codex',
            models: [privateRoute.providerModel],
            modelMetadata: {
              [privateRoute.providerModel]: {
                limit: { context: 128_000, output: 16_000 },
                modalities: { input: ['text', 'image'], output: ['text'] },
                reasoning: true,
                tool_call: true,
              },
            },
          },
        ]),
        setup.logicalModels.allowed.map((model) => model.id)
      );
      admitTestNativeEnvironment(f.coreDb, setup.manifest);
      const pkg = await resolveAgentEnvironmentPackage({
        coreDb: f.coreDb,
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: setup,
        agentSessionId,
        backend: { kind: 'openshell' },
        turn,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
        vaultBackend: () => f.backend,
      });
      recordAgentEnvironmentPackageSnapshot(f.workspaceDb, {
        environmentPackage: pkg,
        createdAt: pkg.createdAt,
      });
      expect(pkg.schemaVersion).toBe(4);
      expect(pkg.llm.mode).toBe('harness');
      expect(pkg.scope).toMatchObject({
        workspaceId,
        threadId: f.threadId,
        turnId: turn.id,
        agentSessionId,
      });
      expect(pkg.snapshotId).toBe(attempt.inputRef);
      expect(pkg.credentials.declarations).toEqual(setup.manifest.sandbox!.credentialDeclarations);
      expect(
        requireAgentEnvironmentPackageSnapshot(f.workspaceDb, workspaceId, pkg.snapshotId).snapshot
      ).toEqual(pkg);
      const plans = listVaultInjectionPlans(f.coreDb);
      expect(plans).toHaveLength(1);
      const plan = plans[0]!;
      expect(getVaultInjectionPlan(f.coreDb, plan.planId)).toMatchObject({
        grantId: f.grantId,
        packageSnapshotId: pkg.snapshotId,
        injectionVisibility: 'runtime-token',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(listVaultUseRecords(f.workspaceDb)).toEqual([]);
      expect(listVaultInjectionReceipts(f.coreDb)).toEqual([]);

      const participant = vi.fn(
        async (
          _input: Parameters<
            import('../policy/interception.js').DeterministicPolicyParticipant['invoke']
          >[0]
        ) => ({ decision: 'deny' as const })
      );
      const interception = new PolicyInterception({
        id: 'reviewed-login-binding-denial',
        version: `sha256:${'3'.repeat(64)}`,
        invoke: participant,
      });
      const resource = {
        kind: 'container' as const,
        container: {
          kind: 'workspace' as const,
          id: workspaceId,
          owner: { kind: 'workspace' as const, workspaceId },
        },
      };
      const scope = {
        subjects: [{ kind: 'human' as const, id: f.ownerId }],
        actions: ['vault.use'],
        resources: [resource],
      };
      const document: PolicyDocumentV1 = {
        schemaVersion: 1,
        statements: [
          {
            id: 'reviewed-login-binding-denial',
            kind: 'binding',
            author: { kind: 'human', id: f.ownerId },
            authority: { kind: 'human', userId: f.ownerId },
            authoredAt: new Date().toISOString(),
            state: 'active',
            scope,
            lifetime: { anchor: resource.container },
            operation: 'vault.binding-deliver',
            stage: 'decide',
            mode: 'gate',
            participant: {
              kind: 'deterministic',
              id: 'reviewed-login-binding-denial',
              version: `sha256:${'3'.repeat(64)}`,
            },
            inputDisclosure: scope,
            order: 0,
            timeoutMs: 100,
            failure: 'error',
            circuit: { failures: 1, recoveryAfterMs: 60_000 },
          },
        ],
      };
      const personal = await f.store.ensureQuickChatWorkspace(f.ownerId);
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        workspaceId: personal.id,
        ownerUserId: f.ownerId,
      });
      const adminThread = await f.store.createThread(
        personal.id,
        'Review binding Policy',
        undefined,
        'administration',
        {
          visibility: 'private',
          privateOwnerUserId: f.ownerId,
        }
      );
      const adminTurn = await f.store.createTurn(
        personal.id,
        adminThread.id,
        'Confirm binding Policy',
        { kind: 'user', id: f.ownerId }
      );
      const files = new RuntimeConfigFileService({
        dataRoot: f.dataRoot,
        userId: f.ownerId,
        workspaceIds: [workspaceId, personal.id],
        runtimeConfigManager: f.runtimeConfigManager,
        readRuntimeConfigStatus: () => f.runtimeConfigManager.status(),
      });
      const configuration = createAdministrationConfiguration({
        actor: { kind: 'local', userId: f.ownerId },
        coreDb: f.coreDb,
        store: f.store,
        files,
        runtimeConfig: () => f.runtimeConfigManager.current(),
        reload: () => f.runtimeConfigManager.reload({ mode: 'safe', dryRun: false }),
        repositoryWorkspaceDb: (id) => {
          let db = policyDbs.get(id);
          if (!db) {
            db = openWorkspaceDb(f.dataRoot, id);
            policyDbs.set(id, db);
          }
          return db;
        },
        inflightCommands: new WeakMap(),
      });
      const proposed = await configuration.propose(
        {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision: files.readFile('server.jsonc').file.revision!,
          changes: {
            proposed: document,
            rationale: 'Deny reviewed Login delivery before material effects.',
          },
        },
        { threadId: adminThread.id, turnId: adminTurn.id, requestId: randomUUID() }
      );
      expect(
        await configuration.apply({
          requestId: randomUUID(),
          candidate: proposed.candidate,
          confirmation: proposed.confirmation,
        })
      ).toMatchObject({ persisted: true, reload: 'applied' });

      const runtime = createConfiguredWorkerLifecycleRuntime({
        env: {},
        coreDb: f.coreDb,
        store: f.store,
        vaultBackend: () => f.backend,
        readRuntimeConfig: () => f.runtimeConfigManager.current(),
        policyInterception: () => interception,
      });
      const effect = vi.spyOn(runtime.turnExecutor, 'credentialBindingOperation');
      restoreEffect = () => effect.mockRestore();
      const app = createApp({
        coreDb: f.coreDb,
        dataRoot: f.dataRoot,
        store: f.store,
        vaultUnlockState: f.vaultUnlockState,
        runtimeConfigManager: f.runtimeConfigManager,
        policyInterception: interception,
        turnExecutor: runtime.turnExecutor,
      });
      const requestId = randomUUID();
      const response = await app.request(
        ...operationRequest(
          'vault.binding-deliver',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId,
              bindingThreadId: f.threadId,
              planId: plan.planId,
              receiptId: `receipt_${pkg.snapshotId}_reviewed-login`,
              materialVersion: 1,
              requestId,
            }),
          }
        )
      );
      const result = (await response.json()) as { code?: string };
      expect.soft(response.status).toBe(403);
      expect.soft(result.code).toBe('workspace_access_denied');
      expect.soft(participant).toHaveBeenCalledTimes(1);
      expect.soft(participant.mock.calls[0]?.[0].proposal).toMatchObject({
        operation: 'vault.binding-deliver',
        inputReferences: {
          planId: plan.planId,
          grantId: f.grantId,
          packageSnapshotId: pkg.snapshotId,
        },
      });
      const decisions = listExportableWorkspacePermissionDecisions(
        f.workspaceDb,
        workspaceId
      ).filter(
        (value) =>
          value.enforcementPoint === 'vault.binding-deliver@decide' &&
          value.mediation?.role === 'final'
      );
      expect.soft(decisions).toEqual([
        expect.objectContaining({
          action: 'vault.use',
          result: 'deny',
          contextSummary: expect.objectContaining({ requestId }),
        }),
      ]);
      const audits = listWorkspaceAuditEvents(f.workspaceDb, workspaceId, f.coreDb);
      expect.soft(audits).toContainEqual(
        expect.objectContaining({
          action: 'vault.binding-deliver',
          requestId,
          outcome: 'failed',
          actor: { kind: 'user', id: f.ownerId },
        })
      );
      expect
        .soft(
          decisions.length === 1 && audits.some((event) => event.id === decisions[0]!.auditEventId)
        )
        .toBe(true);
      expect(effect).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(storeMaterial).not.toHaveBeenCalled();
      expect(rotate).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(listVaultUseRecords(f.workspaceDb)).toEqual([]);
      expect(listVaultInjectionReceipts(f.coreDb)).toEqual([]);
      expect(
        JSON.stringify({
          result,
          decisions,
          audits,
          pkg,
          plan,
          proposal: participant.mock.calls,
        }).includes(f.material)
      ).toBe(false);
    } finally {
      restoreEffect?.();
      resolve.mockRestore();
      storeMaterial.mockRestore();
      rotate.mockRestore();
      revoke.mockRestore();
      for (const db of policyDbs.values()) db.sqlite.close();
      await f.close();
    }
  });

  it.each(['owner', 'shared-member'] as const)(
    'releases to the %s only under the real reviewed cross-scope grant with Workspace evidence',
    async (consumer) => {
      const f = await reviewedLoginUseFixture();
      try {
        expect(
          await loginUseOutcome(
            f.resolve(consumer === 'owner' ? f.ownerId : f.memberId),
            f.material
          )
        ).toEqual({ ok: true, matches: true });
        const uses = listVaultUseRecords(f.workspaceDb);
        expect(uses).toHaveLength(1);
        expect(uses[0]).toMatchObject({
          ownerScope: 'workspace',
          workspaceId: f.workspaceDb.workspaceId,
          grantId: f.grantId,
          vaultReferenceId: f.referenceId,
          materialVersion: 1,
          outcome: 'succeeded',
        });
        expect(listVaultUseRecords(f.coreDb)).toEqual([]);
        const audits = listWorkspaceAuditEvents(f.workspaceDb, f.workspaceDb.workspaceId).filter(
          (event) => event.action === 'vault.resolve'
        );
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          id: uses[0]!.auditEventId,
          outcome: 'succeeded',
          actor: { kind: 'user', id: consumer === 'owner' ? f.ownerId : f.memberId },
        });
        expect(JSON.stringify({ uses, audits }).includes(f.material)).toBe(false);
      } finally {
        await f.close();
      }
    }
  );

  it.each(['absent', 'wrong-workspace', 'nonmember', 'expired'] as const)(
    'refuses %s authority without releasing material or publishing a successful Use',
    async (scenario) => {
      const f = await reviewedLoginUseFixture();
      try {
        if (scenario === 'expired') f.setTime('2099-01-01T00:00:00.001Z');
        const db = scenario === 'wrong-workspace' ? f.otherDb : f.workspaceDb;
        const work =
          scenario === 'absent'
            ? createVaultUseAuditedBackend({
                backend: f.backend,
                db,
                ownerScope: 'workspace',
                workspaceId: db.workspaceId,
                actor: { kind: 'user', id: f.ownerId },
                resolvingPath: 'grant',
              }).resolve({ referenceId: f.referenceId })
            : f.resolve(scenario === 'nonmember' ? f.outsiderId : f.ownerId, db);
        expect(await loginUseOutcome(work, f.material)).toEqual({ ok: false, matches: false });
        const uses = listVaultUseRecords(db);
        expect(uses.some((use) => use.outcome === 'succeeded')).toBe(false);
        expect(JSON.stringify(uses).includes(f.material)).toBe(false);
      } finally {
        await f.close();
      }
    }
  );

  it.each(['unchanged', 'revoked', 'quarantined', 'generation', 'member-left'] as const)(
    'waits for actual Use and Audit acknowledgements and rechecks %s facts before material release',
    async (scenario) => {
      const f = await reviewedLoginUseFixture();
      const originalEmit = Worker.prototype.emit;
      const useReached = Promise.withResolvers<void>();
      const auditReached = Promise.withResolvers<void>();
      let pending: (() => void) | undefined;
      let active = true;
      let useHeld = false;
      let auditHeld = false;
      let settled = false;
      let outcome: ReturnType<typeof loginUseOutcome> | undefined;
      const prepared = vi.spyOn(f.backend, 'resolve');
      const release = () => {
        const value = pending;
        pending = undefined;
        value?.();
      };
      const hold = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
        this: Worker,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const reply = args[0] as
          | {
              operation?: string;
              status?: string;
              result?: {
                kind?: string;
                value?: { vaultReferenceId?: string; resource?: string; workspaceId?: string };
              };
            }
          | undefined;
        const result = reply?.result;
        if (
          active &&
          event === 'message' &&
          reply?.operation === 'vault' &&
          reply.status === 'ok' &&
          result?.value?.workspaceId === f.workspaceDb.workspaceId &&
          ((!useHeld &&
            result.kind === 'use-create' &&
            result.value.vaultReferenceId === f.referenceId) ||
            (!auditHeld &&
              result.kind === 'audit-insert' &&
              result.value.resource === `vault:${f.referenceId}`))
        ) {
          pending = () => originalEmit.call(this, event, ...args);
          if (result.kind === 'use-create') {
            useHeld = true;
            useReached.resolve();
          } else {
            auditHeld = true;
            auditReached.resolve();
          }
          return true;
        }
        return originalEmit.call(this, event, ...args);
      });
      try {
        outcome = loginUseOutcome(
          f.resolve(scenario === 'member-left' ? f.memberId : f.ownerId),
          f.material
        ).then((value) => {
          settled = true;
          return value;
        });
        const earlySettlement = () =>
          outcome!.then(() => {
            throw new Error('Login resolution settled before its actual evidence acknowledgement.');
          });
        await Promise.race([useReached.promise, earlySettlement()]);
        expect(settled).toBe(false);
        // The existing private backend may prepare once; only disclosure waits for evidence.
        expect(prepared).toHaveBeenCalledOnce();
        expect(listVaultUseRecords(f.workspaceDb).some((use) => use.outcome === 'succeeded')).toBe(
          true
        );
        release();
        await Promise.race([auditReached.promise, earlySettlement()]);
        expect(settled).toBe(false);
        if (scenario === 'revoked') await revokeVaultGrant(f.coreDb, { grantId: f.grantId });
        if (scenario === 'quarantined')
          await f.call('vault.login-quarantine', { referenceId: f.referenceId });
        if (scenario === 'generation') {
          const rotated = f.backend.rotate({
            referenceId: f.referenceId,
            material: randomBytes(32).toString('base64url'),
          });
          await advanceActiveVaultReferenceVersion(f.coreDb, {
            referenceId: f.referenceId,
            currentVersion: rotated.currentVersion,
          });
        }
        if (scenario === 'member-left') {
          const members = await f.call<{ items: Array<{ userId: string; revision: number }> }>(
            'workspace.member-list',
            { workspaceId: f.workspaceDb.workspaceId }
          );
          const member = members.items.find((value) => value.userId === f.memberId);
          if (!member) throw new Error('The ordinary consumer membership is missing.');
          await f.call('workspace.member-remove', {
            workspaceId: f.workspaceDb.workspaceId,
            targetUserId: f.memberId,
            expectedRevision: member.revision,
            requestId: randomUUID(),
          });
        }
        release();
        expect(await outcome).toEqual({
          ok: scenario === 'unchanged',
          matches: scenario === 'unchanged',
        });
        expect(listVaultUseRecords(f.workspaceDb)).toHaveLength(1);
      } finally {
        active = false;
        release();
        await outcome;
        hold.mockRestore();
        prepared.mockRestore();
        await f.close();
      }
    }
  );

  it('withholds material when the actual Workspace Use publication scope cannot open', async () => {
    const f = await reviewedLoginUseFixture();
    const dbPath = workspaceDbPath(f.dataRoot, f.workspaceDb.workspaceId);
    const dbDirectory = join(dbPath, '..');
    const heldDirectory = `${dbDirectory}.use-publication-fault`;
    let obstructed = false;
    const prepared = vi.spyOn(f.backend, 'resolve');
    let restorePublication = () => {};
    try {
      await shutdownControlStoreWorkerClient();
      const use = vi.spyOn(getControlStoreWorkerClient(), 'vault');
      restorePublication = () => use.mockRestore();
      // Deliberate private-fixture filesystem fault after valid consent; no SQL or writer reply is replaced.
      renameSync(dbDirectory, heldDirectory);
      obstructed = true;
      mkdirSync(dbPath, { recursive: true });
      expect(await loginUseOutcome(f.resolve(), f.material)).toEqual({ ok: false, matches: false });
      expect(prepared).toHaveBeenCalledOnce();
      expect(
        use.mock.calls.some(
          ([db, kind, input]) =>
            db === f.workspaceDb &&
            kind === 'use-create' &&
            (input as { outcome?: unknown }).outcome === 'succeeded'
        )
      ).toBe(true);
      expect(listVaultUseRecords(f.workspaceDb).some((use) => use.outcome === 'succeeded')).toBe(
        false
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      restorePublication();
      prepared.mockRestore();
      if (obstructed) {
        rmSync(dbDirectory, { recursive: true, force: true });
        renameSync(heldDirectory, dbDirectory);
      }
      await f.close();
    }
  });
});
