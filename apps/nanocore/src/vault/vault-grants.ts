import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type {
  CreateVaultGrantInput,
  NarrowVaultGrantConstraints,
  RevokeVaultGrantInput,
  VaultGrantRecord,
} from '../storage/vault-native-codecs.js';

export {
  type CreateVaultGrantInput,
  getVaultGrant,
  listExportableWorkspaceVaultGrants,
  listVaultGrants,
  type NarrowVaultGrantConstraints,
  type RevokeVaultGrantInput,
  VaultGrantNarrowingError,
  type VaultGrantRecord,
} from '../storage/vault-native-codecs.js';

/**
 * Replaces a current grant with a strictly narrower grant in one Core transaction.
 *
 * Bindings stay on the revoked original until their owner explicitly changes them.
 *
 * @param coreDb Open Core database handle.
 * @param input Original identity, fresh replacement identity, reduced constraints and clock.
 * @returns Original revoked grant and its active replacement.
 * @throws VaultGrantNarrowingError for inactive authority or widening, empty or unchanged constraints.
 */
export async function narrowVaultGrant(
  coreDb: CoreDb,
  input: {
    readonly grantId: string;
    readonly replacementGrantId: string;
    readonly constraints: NarrowVaultGrantConstraints;
    readonly now?: () => string;
  }
): Promise<{ revokedGrant: VaultGrantRecord; grant: VaultGrantRecord }> {
  return getControlStoreWorkerClient().vault(coreDb, 'grant-narrow', input);
}

/**
 * Creates one non-secret vault grant idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant metadata to store.
 * @returns Stored vault grant record.
 * @throws Error when the id is malformed, a retained grant is imported, or reference and scope fields are invalid.
 */
export async function createVaultGrant(
  coreDb: CoreDb,
  input: CreateVaultGrantInput
): Promise<VaultGrantRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'grant-create', input);
}

/**
 * Revokes one vault grant and projects dependent receipt reachability.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant revocation input.
 * @returns Revoked grant record.
 * @throws Error when the grant does not exist.
 */
export async function revokeVaultGrant(
  coreDb: CoreDb,
  input: RevokeVaultGrantInput
): Promise<VaultGrantRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'grant-revoke', input);
}
