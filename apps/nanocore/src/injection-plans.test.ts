import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createInjectionPlan, getInjectionPlan, listInjectionPlans } from './injection-plans.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createVaultGrant } from './vault-grants.js';
import { createVaultReference } from './vault-references.js';

/**
 * Opens a migrated Core database for injection plan tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-injection-plan-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('injection plans', () => {
  it('creates, reads, and lists non-secret runtime-file injection plans', () => {
    const coreDb = createCoreDb();

    try {
      createGrant(coreDb);

      const created = createInjectionPlan(coreDb, {
        backendCapabilityRequirement: 'encrypted-file:resolve',
        capabilityId: 'mcp.github.call_tool',
        expirationBehavior: 'delete-on-turn-end',
        grantId: 'grant_github_turn',
        injectionVisibility: 'runtime-file',
        now: () => '2026-07-05T00:10:00.000Z',
        packageSnapshotId: 'aep_1',
        planId: 'plan_github_file',
        redactionRule: 'path-only',
        revocationBehavior: 'mark-session-stale',
        targetPath: '/openkit/secrets/github-token',
      });
      const duplicate = createInjectionPlan(coreDb, {
        backendCapabilityRequirement: 'changed',
        expirationBehavior: 'delete-on-turn-end',
        grantId: 'grant_github_turn',
        injectionVisibility: 'gateway-only',
        now: () => '2026-07-05T00:20:00.000Z',
        planId: 'plan_github_file',
        redactionRule: 'status-only',
        revocationBehavior: 'deny-new-use',
      });

      expect(duplicate).toEqual(created);
      expect(getInjectionPlan(coreDb, 'plan_github_file')).toEqual(created);
      expect(listInjectionPlans(coreDb)).toEqual([created]);
      expect(created).toMatchObject({
        backendCapabilityRequirement: 'encrypted-file:resolve',
        capabilityId: 'mcp.github.call_tool',
        expirationBehavior: 'delete-on-turn-end',
        grantId: 'grant_github_turn',
        injectionVisibility: 'runtime-file',
        packageSnapshotId: 'aep_1',
        planId: 'plan_github_file',
        redactionRule: 'path-only',
        revocationBehavior: 'mark-session-stale',
        status: 'active',
        targetPath: '/openkit/secrets/github-token',
      });
      expect(JSON.stringify(created)).not.toContain('ghp_');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires an existing grant and visibility-specific targets', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        createInjectionPlan(coreDb, {
          backendCapabilityRequirement: 'encrypted-file:resolve',
          expirationBehavior: 'delete-on-turn-end',
          grantId: 'grant_missing',
          injectionVisibility: 'gateway-only',
          planId: 'plan_missing',
          redactionRule: 'status-only',
          revocationBehavior: 'deny-new-use',
        })
      ).toThrow('Vault grant not found: grant_missing');

      createGrant(coreDb);

      expect(() =>
        createInjectionPlan(coreDb, {
          backendCapabilityRequirement: 'encrypted-file:resolve',
          expirationBehavior: 'delete-on-turn-end',
          grantId: 'grant_github_turn',
          injectionVisibility: 'runtime-file',
          planId: 'plan_missing_path',
          redactionRule: 'path-only',
          revocationBehavior: 'mark-session-stale',
        })
      ).toThrow('Runtime-file injection plans require targetPath.');
      expect(() =>
        createInjectionPlan(coreDb, {
          backendCapabilityRequirement: 'encrypted-file:resolve',
          expirationBehavior: 'unset-env-on-turn-end',
          grantId: 'grant_github_turn',
          injectionVisibility: 'runtime-env',
          planId: 'plan_missing_env',
          redactionRule: 'name-only',
          revocationBehavior: 'mark-session-stale',
        })
      ).toThrow('Runtime-env injection plans require targetEnvVarName.');
      expect(() =>
        createInjectionPlan(coreDb, {
          backendCapabilityRequirement: 'encrypted-file:resolve',
          expirationBehavior: 'delete-on-turn-end',
          grantId: 'grant_github_turn',
          injectionVisibility: 'gateway-only',
          planId: 'plan_gateway_path',
          redactionRule: 'status-only',
          revocationBehavior: 'deny-new-use',
          targetPath: '/openkit/secrets/github-token',
        })
      ).toThrow('Gateway-only injection plans cannot include runtime targets.');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates the grant fixture used by injection plan tests.
 *
 * @param coreDb Open Core database handle.
 */
function createGrant(coreDb: CoreDb): void {
  createVaultReference(coreDb, {
    backendKind: 'encrypted-file',
    displayName: 'GitHub token',
    ownerScope: 'server',
    referenceId: 'vault_github',
    secretKind: 'repository-token',
  });
  createVaultGrant(coreDb, {
    allowedInjectionPaths: ['runtime-file', 'gateway-only'],
    grantId: 'grant_github_turn',
    lifetime: 'turn',
    ownerScope: 'workspace',
    vaultReferenceId: 'vault_github',
    workspaceId: 'ws_1',
  });
}
