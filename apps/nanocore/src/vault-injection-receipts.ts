import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import type {
  CreateVaultInjectionReceiptInput,
  VaultInjectionReceiptRecord,
} from './storage/vault-native-codecs.js';

export {
  type CreateVaultInjectionReceiptInput,
  getVaultInjectionReceipt,
  listExportableVaultInjectionReceipts,
  listVaultInjectionReceipts,
  type VaultInjectionReceiptRecord,
} from './storage/vault-native-codecs.js';

/**
 * Creates one non-secret injection receipt idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Receipt metadata to store.
 * @returns Stored injection receipt record.
 * @throws Error when the plan is missing, receipt linkage is invalid, or the identity conflicts.
 */
export async function createVaultInjectionReceipt(
  coreDb: CoreDb,
  input: CreateVaultInjectionReceiptInput
): Promise<VaultInjectionReceiptRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'receipt-create', input);
}
