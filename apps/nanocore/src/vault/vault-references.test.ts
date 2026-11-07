import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
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
  it('creates, reads, and lists non-secret server vault references', async () => {
    const coreDb = createCoreDb();

    try {
      const created = await createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file:default',
        displayName: 'OpenAI provider key',
        now: () => '2026-07-05T00:00:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7a76-a462-96e7448d3d9c',
        secretKind: 'provider-api-key',
      });
      const duplicate = await createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Changed label',
        now: () => '2026-07-05T00:10:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7a76-a462-96e7448d3d9c',
        secretKind: 'repository-token',
      });

      expect(duplicate).toEqual(created);
      expect(getVaultReference(coreDb, 'vault_00000000-0000-7a76-a462-96e7448d3d9c')).toEqual(
        created
      );
      expect(listVaultReferences(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        backendKind: 'encrypted-file',
        backendLocator: 'encrypted-file:default',
        currentVersion: 1,
        displayName: 'OpenAI provider key',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7a76-a462-96e7448d3d9c',
        secretKind: 'provider-api-key',
        status: 'active',
      });
      expect(JSON.stringify(created)).not.toContain('sk-');
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('reports insert evidence without treating duplicate rows as new', async () => {
    const coreDb = createCoreDb();

    try {
      const input = {
        backendKind: 'encrypted-file' as const,
        backendLocator: 'encrypted-file://server/vault/vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
        displayName: 'Provider subscription credential',
        now: () => '2026-07-23T00:00:00.000Z',
        ownerScope: 'server' as const,
        referenceId: 'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
        secretKind: 'provider-subscription-oauth',
      };
      const inserted = await createVaultReferenceWithInsertEvidence(coreDb, input);

      expect(inserted).toEqual({
        inserted: true,
        reference: {
          backendKind: 'encrypted-file',
          backendLocator:
            'encrypted-file://server/vault/vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
          createdAt: '2026-07-23T00:00:00.000Z',
          currentVersion: 1,
          displayName: 'Provider subscription credential',
          ownerScope: 'server',
          referenceId: 'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
          secretKind: 'provider-subscription-oauth',
          status: 'active',
          updatedAt: '2026-07-23T00:00:00.000Z',
          userId: null,
          workspaceId: null,
        },
      });
      expect(await createVaultReferenceWithInsertEvidence(coreDb, input)).toEqual({
        inserted: false,
        reference: inserted.reference,
      });
      expect(
        await createVaultReferenceWithInsertEvidence(coreDb, {
          ...input,
          displayName: 'Conflicting label',
          now: () => '2026-07-23T00:10:00.000Z',
          secretKind: 'repository-token',
        })
      ).toEqual({ inserted: false, reference: inserted.reference });
      expect(getVaultReference(coreDb, input.referenceId)).toEqual(inserted.reference);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('requires workspace ids only for workspace-owned references', async () => {
    const coreDb = createCoreDb();

    try {
      await expect(
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Workspace key',
          ownerScope: 'workspace',
          referenceId: 'vault_00000000-0000-780f-b76c-cf393899e2da',
          secretKind: 'provider-api-key',
        })
      ).rejects.toThrow('Workspace-scoped vault references require workspaceId.');
      await expect(
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'User key',
          ownerScope: 'user',
          referenceId: 'vault_00000000-0000-785d-b475-5c82e3cd50e2',
          secretKind: 'provider-api-key',
        })
      ).rejects.toThrow('User-scoped vault references require userId.');
      await expect(
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Server key',
          ownerScope: 'server',
          referenceId: 'vault_00000000-0000-726d-baa2-2f697d9a4507',
          secretKind: 'provider-api-key',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).rejects.toThrow('Server-scoped vault references cannot include workspaceId or userId.');
      await expect(
        createVaultReference(coreDb, {
          backendKind: 'encrypted-file',
          displayName: 'Workspace key',
          ownerScope: 'workspace',
          referenceId: 'vault_00000000-0000-77dd-911f-e0277ff9274d',
          secretKind: 'provider-api-key',
          userId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).rejects.toThrow('Workspace-scoped vault references cannot include userId.');
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('advances only active vault references by zero or one version', async () => {
    const coreDb = createCoreDb();

    try {
      const created = await createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'Provider subscription credential',
        now: () => '2026-07-23T00:00:00.000Z',
        ownerScope: 'server',
        referenceId: 'vault_00000000-0000-7943-bc4d-5537bc98f3c5',
        secretKind: 'provider-subscription-oauth',
      });
      const equalVersion = await advanceActiveVaultReferenceVersion(coreDb, {
        currentVersion: 1,
        now: () => '2026-07-23T00:10:00.000Z',
        referenceId: created.referenceId,
      });

      expect(equalVersion).toEqual(created);

      const advanced = await advanceActiveVaultReferenceVersion(coreDb, {
        currentVersion: 2,
        now: () => '2026-07-23T00:20:00.000Z',
        referenceId: created.referenceId,
      });

      expect(advanced).toEqual({
        ...created,
        currentVersion: 2,
        updatedAt: '2026-07-23T00:20:00.000Z',
      });
      await expect(
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 1,
          now: () => '2026-07-23T00:30:00.000Z',
          referenceId: created.referenceId,
        })
      ).rejects.toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(advanced);
      await expect(
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 4,
          now: () => '2026-07-23T00:40:00.000Z',
          referenceId: created.referenceId,
        })
      ).rejects.toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(advanced);
      await expect(
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 1,
          referenceId: 'vault_00000000-0000-722b-b433-75d118b2149c',
        })
      ).rejects.toThrow();
      expect(getVaultReference(coreDb, 'vault_00000000-0000-722b-b433-75d118b2149c')).toBeNull();

      const revoked = await revokeVaultReference(coreDb, {
        now: () => '2026-07-23T00:50:00.000Z',
        referenceId: created.referenceId,
      });

      await expect(
        advanceActiveVaultReferenceVersion(coreDb, {
          currentVersion: 2,
          now: () => '2026-07-23T01:00:00.000Z',
          referenceId: created.referenceId,
        })
      ).rejects.toThrow();
      expect(getVaultReference(coreDb, created.referenceId)).toEqual(revoked);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('revokes a reference and marks dependent sessions stale', async () => {
    const coreDb = createCoreDb();

    try {
      await createReferenceCascadeFixture(coreDb);

      const revoked = await revokeVaultReference(coreDb, {
        now: () => '2026-07-05T00:30:00.000Z',
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      });

      expect(revoked).toMatchObject({
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        status: 'revoked',
        updatedAt: '2026-07-05T00:30:00.000Z',
      });
      expect(listVaultGrants(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
          status: 'revoked',
        }),
      ]);
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
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('rolls back the complete revocation cascade and permits retry', async () => {
    const coreDb = createCoreDb();

    try {
      await createReferenceCascadeFixture(coreDb);
      const originalReference = getVaultReference(
        coreDb,
        'vault_00000000-0000-7f73-bffa-d96a61ee4d70'
      );
      const originalGrants = listVaultGrants(coreDb);
      const originalPlans = listVaultInjectionPlans(coreDb);
      const originalReceipts = listVaultInjectionReceipts(coreDb);

      coreDb.sqlite.exec(`CREATE TRIGGER fail_vault_grant_revocation
        BEFORE UPDATE OF status ON vault_grants
        FOR EACH ROW
        WHEN OLD.vault_reference_id = 'vault_00000000-0000-7f73-bffa-d96a61ee4d70'
          AND OLD.status = 'active'
          AND NEW.status = 'revoked'
          AND EXISTS (
            SELECT 1 FROM vault_references
            WHERE reference_id = 'vault_00000000-0000-7f73-bffa-d96a61ee4d70' AND status = 'revoked'
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

      await expect(
        revokeVaultReference(coreDb, {
          now: () => '2026-07-23T00:30:00.000Z',
          referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(getVaultReference(coreDb, 'vault_00000000-0000-7f73-bffa-d96a61ee4d70')).toEqual(
        originalReference
      );
      expect(listVaultGrants(coreDb)).toEqual(originalGrants);
      expect(listVaultInjectionPlans(coreDb)).toEqual(originalPlans);
      expect(listVaultInjectionReceipts(coreDb)).toEqual(originalReceipts);

      coreDb.sqlite.exec('DROP TRIGGER fail_vault_grant_revocation');

      expect(
        await revokeVaultReference(coreDb, {
          now: () => '2026-07-23T00:40:00.000Z',
          referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        })
      ).toMatchObject({
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        status: 'revoked',
        updatedAt: '2026-07-23T00:40:00.000Z',
      });
      expect(listVaultGrants(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
          status: 'revoked',
        }),
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
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates a reference, grant, plan, and receipt fixture used by cascade tests.
 *
 * @param coreDb Open Core database handle.
 */
async function createReferenceCascadeFixture(coreDb: CoreDb): Promise<void> {
  await createVaultReference(coreDb, {
    backendKind: 'encrypted-file',
    displayName: 'GitHub token',
    ownerScope: 'server',
    referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
    secretKind: 'repository-token',
  });
  await createVaultGrant(coreDb, {
    allowedInjectionPaths: ['runtime-file'],
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    lifetime: 'turn',
    ownerScope: 'workspace',
    vaultReferenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
    workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
  });
  await createVaultInjectionPlan(coreDb, {
    backendCapabilityRequirement: 'encrypted-file:resolve',
    expirationBehavior: 'delete-on-turn-end',
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    injectionVisibility: 'runtime-file',
    planId: 'plan_github_file',
    redactionRule: 'path-only',
    revocationBehavior: 'mark-session-stale',
    targetPath: '/openkit/secrets/github-token',
  });
  await createVaultInjectionReceipt(coreDb, {
    agentSessionId: 'session_1',
    backendSummary: 'encrypted-file:vault_00000000-0000-7f73-bffa-d96a61ee4d70:v1',
    grantId: 'grant_00000000-0000-7502-bb07-4104daba6c66',
    injectedAt: '2026-07-05T00:10:00.000Z',
    planId: 'plan_github_file',
    receiptId: 'receipt_github_file',
    revocationStatus: 'active',
  });
}

/** VaultReference is the only family identity; explicit Login metadata must cross the actual native owner. */
describe('explicit User Codex Login references', () => {
  it('retains one explicit subtype across native shutdown and reopen without inferring ordinary Logins', async () => {
    const coreDb = createCoreDb();
    try {
      const login = {
        provider: 'codex' as const,
        accountId: 'synthetic-account-equality',
        quarantined: false,
      };
      const input = {
        referenceId: 'vault_00000000-0000-7000-8000-000000000101',
        ownerScope: 'user' as const,
        userId: ensureLocalUser(coreDb),
        displayName: 'Explicit Login',
        secretKind: 'opaque',
        backendKind: 'encrypted-file' as const,
        login,
      };
      const created = await createVaultReference(coreDb, input);
      expect(created, 'O1 expected baseline RED: explicit subtype is not retained').toMatchObject({
        login,
      });
      const ordinary = [];
      for (const ownerScope of ['user', 'workspace', 'server'] as const) {
        ordinary.push(
          await createVaultReference(coreDb, {
            referenceId: `vault_00000000-0000-7000-8000-00000000010${ordinary.length + 2}`,
            ownerScope,
            ...(ownerScope === 'user' ? { userId: input.userId } : {}),
            ...(ownerScope === 'workspace'
              ? { workspaceId: 'ws_00000000-0000-7000-8000-000000000101' }
              : {}),
            displayName: 'Ordinary subscription canary',
            secretKind: 'provider-subscription-oauth',
            backendKind: 'encrypted-file' as const,
          })
        );
      }
      for (const reference of ordinary) expect(reference).not.toHaveProperty('login');
      await shutdownControlStoreWorkerClient();
      const cold = openCoreDb(coreDb.dataRoot);
      try {
        expect(getVaultReference(cold, input.referenceId)).toEqual(created);
        for (const reference of ordinary)
          expect(getVaultReference(cold, reference.referenceId)).toEqual(reference);
      } finally {
        cold.sqlite.close();
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('keeps distinct families for the same account and never overwrites a colliding identity', async () => {
    const coreDb = createCoreDb();
    try {
      const input = {
        referenceId: 'vault_00000000-0000-7000-8000-000000000201',
        ownerScope: 'user' as const,
        userId: ensureLocalUser(coreDb),
        displayName: 'First family',
        secretKind: 'opaque',
        backendKind: 'encrypted-file' as const,
        login: {
          provider: 'codex' as const,
          accountId: 'synthetic-shared-account',
          quarantined: false,
        },
      };
      const first = await createVaultReferenceWithInsertEvidence(coreDb, input);
      expect(first.reference).toMatchObject({ login: input.login });
      const second = await createVaultReference(coreDb, {
        ...input,
        referenceId: 'vault_00000000-0000-7000-8000-000000000202',
      });
      expect(second.referenceId).not.toBe(first.reference.referenceId);
      expect(second).toMatchObject({ login: input.login });
      const conflicting = {
        ...input,
        displayName: 'Changed label',
        login: { ...input.login, accountId: 'synthetic-other-account', quarantined: true },
      };
      await expect(createVaultReferenceWithInsertEvidence(coreDb, conflicting)).resolves.toEqual({
        inserted: false,
        reference: first.reference,
      });
      expect(getVaultReference(coreDb, input.referenceId)).toEqual(first.reference);
      expect(listVaultReferences(coreDb)).toHaveLength(2);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['partial', { provider: 'codex', accountId: 'synthetic' }],
    ['unknown provider', { provider: 'unsupported', accountId: 'synthetic', quarantined: false }],
    ['empty account equality', { provider: 'codex', accountId: '', quarantined: false }],
    ['non-Boolean quarantine', { provider: 'codex', accountId: 'synthetic', quarantined: 0 }],
  ])(
    'refuses %s subtype at creation without retaining an ordinary replacement',
    async (_name, login) => {
      const coreDb = createCoreDb();
      try {
        const input = {
          referenceId: 'vault_00000000-0000-7000-8000-000000000301',
          ownerScope: 'user' as const,
          userId: ensureLocalUser(coreDb),
          displayName: 'Invalid subtype',
          secretKind: 'opaque',
          backendKind: 'encrypted-file' as const,
          login,
        };
        await expect(
          createVaultReference(coreDb, input as Parameters<typeof createVaultReference>[1])
        ).rejects.toThrow();
        expect(getVaultReference(coreDb, input.referenceId)).toBeNull();
      } finally {
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
      }
    }
  );

  it.each(['server', 'workspace'] as const)(
    'refuses explicit Login metadata on a %s reference',
    async (ownerScope) => {
      const coreDb = createCoreDb();
      try {
        const input = {
          referenceId: 'vault_00000000-0000-7000-8000-000000000401',
          ownerScope,
          ...(ownerScope === 'workspace'
            ? { workspaceId: 'ws_00000000-0000-7000-8000-000000000401' }
            : {}),
          displayName: 'Wrong scope subtype',
          secretKind: 'opaque',
          backendKind: 'encrypted-file' as const,
          login: { provider: 'codex' as const, accountId: 'synthetic-account', quarantined: false },
        };
        await expect(createVaultReference(coreDb, input)).rejects.toThrow();
        expect(getVaultReference(coreDb, input.referenceId)).toBeNull();
      } finally {
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
      }
    }
  );
});

/** Retained subtype corruption must refuse at the real reference reader, without changing the row. */
describe('retained Login subtype refusal', () => {
  it.each([
    ['provider only', 'login_account_id = NULL, login_quarantined = NULL', []],
    ['account only', 'login_provider = NULL, login_quarantined = NULL', []],
    ['quarantine only', 'login_provider = NULL, login_account_id = NULL', []],
    ['missing provider', 'login_provider = NULL', []],
    ['missing account', 'login_account_id = NULL', []],
    ['missing quarantine', 'login_quarantined = NULL', []],
    ['unknown provider', 'login_provider = ?', ['unsupported']],
    ['empty account equality', 'login_account_id = ?', ['']],
    ['negative quarantine', 'login_quarantined = ?', [-1]],
    ['non-binary quarantine', 'login_quarantined = ?', [2]],
    ['fractional quarantine', 'login_quarantined = ?', [0.5]],
    ['text quarantine', 'login_quarantined = ?', ['false']],
    ['missing User identity', 'user_id = NULL', []],
    ['noncanonical User identity', 'user_id = ?', ['not-a-canonical-user']],
    [
      'contradictory Workspace identity',
      'workspace_id = ?',
      ['ws_00000000-0000-7000-8000-000000000901'],
    ],
    ['contradictory Server owner', "owner_scope = 'server'", []],
    [
      'contradictory Workspace owner',
      "owner_scope = 'workspace', workspace_id = ?",
      ['ws_00000000-0000-7000-8000-000000000901'],
    ],
  ] as const)(
    'refuses retained %s rather than ordinary or false',
    async (_name, fault, bindings) => {
      const coreDb = createCoreDb();
      try {
        const reference = await createVaultReference(coreDb, {
          referenceId: 'vault_00000000-0000-7000-8000-000000000901',
          ownerScope: 'user',
          userId: ensureLocalUser(coreDb),
          displayName: 'Retained subtype fault canary',
          secretKind: 'opaque',
          backendKind: 'encrypted-file',
          login: {
            provider: 'codex',
            accountId: 'synthetic-retained-equality',
            quarantined: false,
          },
        });
        expect(
          reference,
          'Valid owner-produced Login is required before retained fault injection'
        ).toMatchObject({
          login: {
            provider: 'codex',
            accountId: 'synthetic-retained-equality',
            quarantined: false,
          },
        });
        await shutdownControlStoreWorkerClient();
        // This is the reference owner's fault injection after valid native publication, never a valid-state builder.
        coreDb.sqlite
          .prepare(`UPDATE vault_references SET ${fault} WHERE reference_id = ?`)
          .run(...bindings, reference.referenceId);
        const retained = coreDb.sqlite
          .prepare('SELECT * FROM vault_references WHERE reference_id = ?')
          .get(reference.referenceId);
        expect(() => getVaultReference(coreDb, reference.referenceId)).toThrow();
        expect(() => listVaultReferences(coreDb)).toThrow();
        expect(
          coreDb.sqlite
            .prepare('SELECT * FROM vault_references WHERE reference_id = ?')
            .get(reference.referenceId)
        ).toEqual(retained);
        const cold = openCoreDb(coreDb.dataRoot);
        try {
          expect(() => getVaultReference(cold, reference.referenceId)).toThrow();
          expect(() => listVaultReferences(cold)).toThrow();
          expect(
            cold.sqlite
              .prepare('SELECT * FROM vault_references WHERE reference_id = ?')
              .get(reference.referenceId)
          ).toEqual(retained);
        } finally {
          cold.sqlite.close();
        }
      } finally {
        await shutdownControlStoreWorkerClient();
        coreDb.sqlite.close();
      }
    }
  );
});
