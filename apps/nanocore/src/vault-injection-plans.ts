import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import type {
  CreateVaultInjectionPlanInput,
  VaultInjectionPlanRecord,
} from './storage/vault-native-codecs.js';

export {
  type CreateVaultInjectionPlanInput,
  getVaultInjectionPlan,
  listExportableVaultInjectionPlans,
  listVaultInjectionPlans,
  type VaultInjectionPlanRecord,
} from './storage/vault-native-codecs.js';

/**
 * Creates one non-secret injection plan idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Plan metadata to store.
 * @returns Stored injection plan record.
 * @throws Error when the grant is imported or missing, targets are invalid, or the identity conflicts.
 */
export async function createVaultInjectionPlan(
  coreDb: CoreDb,
  input: CreateVaultInjectionPlanInput
): Promise<VaultInjectionPlanRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'plan-create', input);
}
