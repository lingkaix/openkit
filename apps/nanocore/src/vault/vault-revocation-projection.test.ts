import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectionVisibility } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultInjectionPlan, getVaultInjectionPlan } from '../vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  getVaultInjectionReceipt,
} from '../vault-injection-receipts.js';
import { createVaultGrant, revokeVaultGrant } from './vault-grants.js';
import { createVaultReference, revokeVaultReference } from './vault-references.js';

const visibilities: readonly InjectionVisibility[] = [
  'gateway-only',
  'backend-provider',
  'runtime-env',
  'runtime-file',
  'runtime-token',
  'external-handle',
];

describe('Vault receipt revocation projection', () => {
  for (const source of ['grant', 'reference'] as const) {
    it(`projects ${source} revocation from receipt visibility without changing completion`, () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-revocation-projection-'));
      const db = openCoreDb(root);
      try {
        applyMigrations(db);
        const referenceId = allocateEntityId('vault');
        const grantId = allocateEntityId('grant');
        createVaultReference(db, {
          referenceId,
          ownerScope: 'server',
          displayName: 'Synthetic credential',
          secretKind: 'repository-token',
          backendKind: 'encrypted-file',
        });
        createVaultGrant(db, {
          grantId,
          vaultReferenceId: referenceId,
          ownerScope: 'workspace',
          workspaceId: allocateEntityId('ws'),
          allowedInjectionPaths: visibilities,
          lifetime: 'workspace',
        });
        const receipts = visibilities.map((injectionVisibility) => {
          const planId = randomUUID();
          createVaultInjectionPlan(db, {
            planId,
            grantId,
            injectionVisibility,
            targetPath: injectionVisibility === 'runtime-file' ? '/run/synthetic' : null,
            targetEnvVarName: injectionVisibility === 'runtime-env' ? 'SYNTHETIC_CREDENTIAL' : null,
            expirationBehavior: 'grant-lifetime',
            revocationBehavior: 'deny-new-use',
            redactionRule: 'no-secret-material',
            backendCapabilityRequirement: 'encrypted-file:resolve',
          });
          return {
            visibility: injectionVisibility,
            receipt: createVaultInjectionReceipt(db, {
              receiptId: randomUUID(),
              planId,
              grantId,
              agentSessionId: allocateEntityId('as'),
              backendSummary: 'Synthetic completion',
              injectedAt: '2026-10-16T00:00:00.000Z',
              revocationStatus: 'active',
            }),
          };
        });
        const original = receipts[0]!.receipt;
        const missingPlanId = randomUUID();
        createVaultInjectionPlan(db, {
          ...getVaultInjectionPlan(db, original.planId)!,
          planId: missingPlanId,
        });
        const unknown = createVaultInjectionReceipt(db, {
          ...original,
          receiptId: randomUUID(),
          planId: missingPlanId,
        });
        db.sqlite.prepare('DELETE FROM vault_injection_plans WHERE plan_id = ?').run(missingPlanId);
        const settled = createVaultInjectionReceipt(db, {
          ...original,
          receiptId: randomUUID(),
          revocationStatus: 'revoked',
        });
        const revoke = () =>
          source === 'grant'
            ? revokeVaultGrant(db, { grantId })
            : revokeVaultReference(db, { referenceId });
        revoke();
        for (const { visibility, receipt } of receipts) {
          expect(getVaultInjectionReceipt(db, receipt.receiptId)).toEqual({
            ...receipt,
            revocationStatus: visibility === 'gateway-only' ? 'revoked' : 'stale-session',
          });
          expect(getVaultInjectionPlan(db, receipt.planId)?.status).toBe('revoked');
        }
        expect(getVaultInjectionReceipt(db, unknown.receiptId)).toEqual({
          ...unknown,
          revocationStatus: 'stale-session',
        });
        expect(getVaultInjectionReceipt(db, settled.receiptId)).toEqual(settled);
        revoke();
        expect(getVaultInjectionReceipt(db, receipts[0]!.receipt.receiptId)?.revocationStatus).toBe(
          'revoked'
        );
      } finally {
        db.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
