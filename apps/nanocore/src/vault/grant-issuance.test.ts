import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultInjectionPlan, listVaultInjectionPlans } from '../vault-injection-plans.js';
import {
  createVaultGrant,
  getVaultGrant,
  importWorkspaceVaultGrants,
  listExportableWorkspaceVaultGrants,
} from './vault-grants.js';
import { createVaultReference, rebindWorkspaceVaultReference } from './vault-references.js';

const grantId = 'grant_01890f3e-0000-7000-8000-000000000001';
const referenceId = 'vault_01890f3e-0000-7000-8000-000000000001';
const workspaceId = 'ws_01890f3e-0000-7000-8000-000000000001';
const roots: string[] = [];
const databases: ReturnType<typeof openCoreDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Creates a canonical metadata-only fixture; no secret backend or host is involved. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-grant-issuance-'));
  roots.push(root);
  const db = openCoreDb(root);
  databases.push(db);
  applyMigrations(db);
  createVaultReference(db, {
    backendKind: 'encrypted-file',
    displayName: 'Synthetic reference',
    ownerScope: 'workspace',
    workspaceId,
    referenceId,
    secretKind: 'provider-key',
  });
  const grant = createVaultGrant(db, {
    allowedInjectionPaths: ['gateway-only'],
    grantId,
    lifetime: 'workspace',
    ownerScope: 'workspace',
    workspaceId,
    vaultReferenceId: referenceId,
  });
  return { root, db, grant };
}
/** Exercises the actual effect-owner admission without resolving secret material. */
function plan(db: ReturnType<typeof openCoreDb>) {
  return createVaultInjectionPlan(db, {
    planId: 'synthetic-plan',
    grantId,
    injectionVisibility: 'gateway-only',
    expirationBehavior: 'grant-lifetime',
    revocationBehavior: 'close-gateway-session',
    redactionRule: 'exact-resolved-material',
    backendCapabilityRequirement: 'synthetic',
  });
}

describe('immutable VaultGrant issuance', () => {
  it('admits a normally issued target grant without inventing Approval lineage', () => {
    const { db, grant } = fixture();
    expect(grant).toMatchObject({ issuance: 'target', approvalId: null, policyDecisionId: null });
    expect(plan(db).grantId).toBe(grantId);
  });
  it('forces imported history even when the source claims target and refuses effects after reopen and re-export', () => {
    const { root, db, grant } = fixture();
    db.sqlite.prepare('DELETE FROM vault_grants WHERE grant_id = ?').run(grantId);
    importWorkspaceVaultGrants(db, [grant]);
    expect(getVaultGrant(db, grantId)).toMatchObject({
      issuance: 'imported-history',
      status: 'active',
      approvalId: null,
    });
    expect(() => plan(db)).toThrow();
    expect(listVaultInjectionPlans(db)).toEqual([]);
    db.sqlite
      .prepare(
        "UPDATE vault_references SET status = 'unbound', backend_locator = NULL WHERE reference_id = ?"
      )
      .run(referenceId);
    rebindWorkspaceVaultReference(db, {
      workspaceId,
      referenceId,
      backendKind: 'encrypted-file',
      backendLocator: 'synthetic-rebound-locator',
      currentVersion: 1,
    });
    expect(getVaultGrant(db, grantId)).toMatchObject({ issuance: 'imported-history' });
    expect(() => plan(db)).toThrow();
    expect(listVaultInjectionPlans(db)).toEqual([]);
    db.sqlite.close();
    const reopened = openCoreDb(root);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(() => plan(reopened)).toThrow();
    const portable = listExportableWorkspaceVaultGrants(reopened, workspaceId);
    expect(portable).toHaveLength(1);
    expect(portable[0]).toMatchObject({ issuance: 'imported-history' });
    importWorkspaceVaultGrants(reopened, portable);
    expect(getVaultGrant(reopened, grantId)).toMatchObject({ issuance: 'imported-history' });
    expect(() => plan(reopened)).toThrow();
    expect(listVaultInjectionPlans(reopened)).toEqual([]);
  });
  it('does not promote an imported row through duplicate live issuance', () => {
    const { db, grant } = fixture();
    db.sqlite.prepare('DELETE FROM vault_grants WHERE grant_id = ?').run(grantId);
    importWorkspaceVaultGrants(db, [grant]);
    const before = db.sqlite.serialize();
    expect(() =>
      createVaultGrant(db, {
        allowedInjectionPaths: ['gateway-only'],
        grantId,
        lifetime: 'workspace',
        ownerScope: 'workspace',
        workspaceId,
        vaultReferenceId: referenceId,
      })
    ).toThrow();
    expect(db.sqlite.serialize().equals(before)).toBe(true);
    expect(getVaultGrant(db, grantId)).toMatchObject({ issuance: 'imported-history' });
  });
  it('fails closed on unknown canonical provenance before plan creation', () => {
    const { db } = fixture();
    db.sqlite.pragma('ignore_check_constraints = ON');
    db.sqlite
      .prepare("UPDATE vault_grants SET issuance = 'unknown' WHERE grant_id = ?")
      .run(grantId);
    expect(() => getVaultGrant(db, grantId)).toThrow();
    expect(() => plan(db)).toThrow();
    expect(listVaultInjectionPlans(db)).toEqual([]);
  });
});
