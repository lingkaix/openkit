import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { assertCurrentMcpVaultAuthority } from '../worker-mcp-routes.js';
import {
  createVaultGrant,
  getVaultGrant,
  importWorkspaceVaultGrants,
  listVaultGrants,
  type NarrowVaultGrantConstraints,
  narrowVaultGrant,
} from './vault-grants.js';
import {
  createVaultReference,
  importUnboundWorkspaceVaultReference,
  rebindWorkspaceVaultReference,
} from './vault-references.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates synthetic canonical authority without reading or storing secret material. */
function fixture(lineage?: { approvalId: string; policyDecisionId?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-grant-narrow-'));
  roots.push(root);
  const db: CoreDb = openCoreDb(root);
  applyMigrations(db);
  const workspaceId = allocateEntityId('ws');
  const reference = createVaultReference(db, {
    referenceId: allocateEntityId('vault'),
    ownerScope: 'workspace',
    workspaceId,
    secretKind: 'github-token',
    displayName: 'Synthetic test reference',
    backendKind: 'encrypted-file',
  });
  const grant = createVaultGrant(db, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: reference.referenceId,
    ownerScope: 'workspace',
    workspaceId,
    allowedInjectionPaths: ['gateway-only', 'runtime-env'],
    lifetime: 'workspace',
    expiresAt: '2099-12-31T00:00:00.000Z',
    ...lineage,
  });
  return { db, grant, reference, workspaceId };
}

describe('Vault grant narrowing', () => {
  it('refuses missing Policy lineage without issuing replacement authority', () => {
    const { db, grant } = fixture({ approvalId: allocateEntityId('it') });
    try {
      expect(() =>
        narrowVaultGrant(db, {
          grantId: grant.grantId,
          replacementGrantId: allocateEntityId('grant'),
          constraints: { targetAgentId: randomUUID() },
        })
      ).toThrow('Grant authority is not current.');
      expect(listVaultGrants(db)).toEqual([grant]);
    } finally {
      db.sqlite.close();
    }
  });
  it('refuses imported history after local reference rebind, including a null Approval', () => {
    const { db, grant, reference, workspaceId } = fixture();
    try {
      db.sqlite.prepare('DELETE FROM vault_grants WHERE grant_id = ?').run(grant.grantId);
      db.sqlite
        .prepare('DELETE FROM vault_references WHERE reference_id = ?')
        .run(reference.referenceId);
      importUnboundWorkspaceVaultReference(db, { ...reference, workspaceId });
      importWorkspaceVaultGrants(db, [grant]);
      const rebound = rebindWorkspaceVaultReference(db, {
        workspaceId,
        referenceId: reference.referenceId,
        backendKind: 'encrypted-file',
        backendLocator: 'synthetic-rebound',
        currentVersion: 1,
      });
      expect(rebound.status).toBe('active');
      const imported = getVaultGrant(db, grant.grantId);
      expect(imported).toMatchObject({ issuance: 'imported-history', approvalId: null });
      const replacementGrantId = allocateEntityId('grant');
      expect(() =>
        narrowVaultGrant(db, {
          grantId: grant.grantId,
          replacementGrantId,
          constraints: { targetAgentId: randomUUID() },
        })
      ).toThrow('Grant authority is not current.');
      expect(getVaultGrant(db, replacementGrantId)).toBeNull();
      expect(listVaultGrants(db)).toEqual([imported]);
    } finally {
      db.sqlite.close();
    }
  });
  it('preserves authority facts, revokes the old binding and enforces the replacement exact target', () => {
    const { db, grant: original, reference, workspaceId } = fixture();
    try {
      const agentId = randomUUID();
      const agentSessionId = allocateEntityId('as');
      const result = narrowVaultGrant(db, {
        grantId: original.grantId,
        replacementGrantId: allocateEntityId('grant'),
        constraints: {
          targetAgentId: agentId,
          targetAgentSessionId: agentSessionId,
          targetCapabilityId: 'mcp.call-tool',
          allowedInjectionPaths: ['gateway-only'],
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
      expect(result.revokedGrant).toEqual({ ...original, status: 'revoked' });
      expect(result.grant).toMatchObject({
        vaultReferenceId: original.vaultReferenceId,
        ownerScope: original.ownerScope,
        workspaceId,
        lifetime: original.lifetime,
        approvalId: original.approvalId,
        policyDecisionId: original.policyDecisionId,
        targetAgentId: agentId,
        targetAgentSessionId: agentSessionId,
        targetCapabilityId: 'mcp.call-tool',
        allowedInjectionPaths: ['gateway-only'],
      });
      const input = {
        environmentPackage: {
          snapshotId: randomUUID(),
          scope: { workspaceId, agentSessionId },
          agent: { agentId },
        },
        operation: 'mcp.call-tool' as const,
      };
      expect(() => assertCurrentMcpVaultAuthority(input, result.revokedGrant, reference)).toThrow();
      expect(() => assertCurrentMcpVaultAuthority(input, result.grant, reference)).not.toThrow();
      expect(() =>
        assertCurrentMcpVaultAuthority(
          { ...input, operation: 'mcp.list-tools' },
          result.grant,
          reference
        )
      ).toThrow();
      expect(() =>
        assertCurrentMcpVaultAuthority(
          {
            ...input,
            environmentPackage: { ...input.environmentPackage, agent: { agentId: randomUUID() } },
          },
          result.grant,
          reference
        )
      ).toThrow();
      expect(() =>
        assertCurrentMcpVaultAuthority(
          input,
          { ...result.grant, targetCapabilityId: 'mcp' },
          reference
        )
      ).toThrow();
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    {},
    { allowedInjectionPaths: ['gateway-only', 'runtime-env'] },
    { allowedInjectionPaths: [] },
    { allowedInjectionPaths: ['runtime-file'] },
    { allowedInjectionPaths: ['gateway-only', 'gateway-only'] },
    { expiresAt: '2100-01-01T00:00:00.000Z' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: 'not-a-timestamp' },
    { targetAgentId: '' },
  ] satisfies NarrowVaultGrantConstraints[])('refuses non-reducing or invalid constraints without writes: %j', (constraints) => {
    const { db, grant } = fixture();
    try {
      expect(() =>
        narrowVaultGrant(db, {
          grantId: grant.grantId,
          replacementGrantId: allocateEntityId('grant'),
          constraints,
        })
      ).toThrow('Grant constraints do not strictly reduce authority.');
      expect(listVaultGrants(db)).toEqual([grant]);
    } finally {
      db.sqlite.close();
    }
  });

  it('retains existing targets and rolls back replacement when source revocation fails', () => {
    const { db, grant } = fixture();
    try {
      const narrowed = narrowVaultGrant(db, {
        grantId: grant.grantId,
        replacementGrantId: allocateEntityId('grant'),
        constraints: { targetAgentId: randomUUID() },
      }).grant;
      expect(() =>
        narrowVaultGrant(db, {
          grantId: narrowed.grantId,
          replacementGrantId: allocateEntityId('grant'),
          constraints: { targetAgentId: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z' },
        })
      ).toThrow();
      const replacementGrantId = allocateEntityId('grant');
      db.sqlite.exec(
        "CREATE TRIGGER reject_grant_revocation BEFORE UPDATE ON vault_grants BEGIN SELECT RAISE(ABORT, 'Synthetic revocation failure'); END"
      );
      expect(() =>
        narrowVaultGrant(db, {
          grantId: narrowed.grantId,
          replacementGrantId,
          constraints: { expiresAt: '2099-01-01T00:00:00.000Z' },
        })
      ).toThrow('Synthetic revocation failure');
      expect(getVaultGrant(db, narrowed.grantId)).toEqual(narrowed);
      expect(getVaultGrant(db, replacementGrantId)).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});
