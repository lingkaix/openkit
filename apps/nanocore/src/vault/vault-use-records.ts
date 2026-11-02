import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type {
  CreateVaultUseRecordInput,
  VaultUseDb,
  VaultUseRecord,
} from '../storage/vault-native-codecs.js';

export {
  type CreateVaultUseRecordInput,
  getVaultUseRecord,
  listExportableWorkspaceVaultUseRecords,
  listVaultUseRecords,
  type VaultUseRecord,
} from '../storage/vault-native-codecs.js';

/**
 * Creates one non-secret vault use record idempotently.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param input Vault use metadata to store.
 * @returns Stored vault use record.
 * @throws Error when scope or resolution metadata is inconsistent.
 */
export async function createVaultUseRecord(
  db: VaultUseDb,
  input: CreateVaultUseRecordInput
): Promise<VaultUseRecord> {
  return getControlStoreWorkerClient().vault(db, 'use-create', input);
}
