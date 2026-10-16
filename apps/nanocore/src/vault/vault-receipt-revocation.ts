import type { CoreDb } from '../storage/db.js';

/** Exact grant set already admitted by the grant or reference revocation owner. */
type ReceiptRevocationTarget = { grantId: string } | { referenceId: string };

/**
 * Projects revocation without retracting completed injection or claiming recall of runtime material.
 *
 * @param coreDb Core database in the caller's revocation transaction.
 * @param target Exact grant or reference whose dependent active receipts must advance.
 */
export function revokeVaultInjectionReceipts(
  coreDb: CoreDb,
  target: ReceiptRevocationTarget
): void {
  const byGrant = 'grantId' in target;
  const predicate = byGrant
    ? 'grant_id = ?'
    : 'grant_id IN (SELECT grant_id FROM vault_grants WHERE vault_reference_id = ?)';
  coreDb.sqlite
    .prepare(
      `UPDATE vault_injection_receipts
       SET revocation_status = CASE WHEN EXISTS (
         SELECT 1 FROM vault_injection_plans AS plan
         WHERE plan.plan_id = vault_injection_receipts.plan_id
           AND plan.grant_id = vault_injection_receipts.grant_id
           AND plan.injection_visibility = 'gateway-only'
       ) THEN 'revoked' ELSE 'stale-session' END
       WHERE revocation_status = 'active' AND ${predicate}`
    )
    .run(byGrant ? target.grantId : target.referenceId);
}
