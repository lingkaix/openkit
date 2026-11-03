import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type {
  AdvanceActiveVaultReferenceVersionInput,
  CreateVaultReferenceInput,
  CreateVaultReferenceResult,
  RebindWorkspaceVaultReferenceInput,
  RevokeVaultReferenceInput,
  VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';

export {
  type AdvanceActiveVaultReferenceVersionInput,
  type CreateVaultReferenceInput,
  type CreateVaultReferenceResult,
  getVaultReference,
  type ImportUnboundWorkspaceVaultReferenceInput,
  listUserVaultReferences,
  listVaultReferences,
  listWorkspaceVaultReferences,
  type RebindWorkspaceVaultReferenceInput,
  type RevokeVaultReferenceInput,
  type VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';

/**
 * Creates one non-secret vault reference idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference metadata to store.
 * @returns Stored vault reference record.
 * @throws Error when scope identity fields are inconsistent.
 */
export async function createVaultReference(
  coreDb: CoreDb,
  input: CreateVaultReferenceInput
): Promise<VaultReferenceRecord> {
  return (await createVaultReferenceWithInsertEvidence(coreDb, input)).reference;
}

/**
 * Creates one non-secret vault reference and reports whether this call inserted it.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference metadata to store.
 * @returns Insert evidence and the exact stored vault reference record.
 * @throws Error when scope identity fields are inconsistent or the stored row cannot be read.
 */
export async function createVaultReferenceWithInsertEvidence(
  coreDb: CoreDb,
  input: CreateVaultReferenceInput
): Promise<CreateVaultReferenceResult> {
  return getControlStoreWorkerClient().vault(coreDb, 'reference-create', input);
}

/**
 * Advances an active vault reference by exactly one material version.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference id, exact backend material version, and optional clock.
 * @returns The unchanged record for an equal version or the exact advanced record.
 * @throws Error when the reference is missing, revoked, rolled back, skipped, or concurrently changed.
 */
export async function advanceActiveVaultReferenceVersion(
  coreDb: CoreDb,
  input: AdvanceActiveVaultReferenceVersionInput
): Promise<VaultReferenceRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'reference-advance', input);
}

/**
 * Revokes one vault reference, dependent grants and the corresponding receipt use.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference revocation input.
 * @returns Revoked reference record.
 * @throws Error when the reference does not exist.
 */
export async function revokeVaultReference(
  coreDb: CoreDb,
  input: RevokeVaultReferenceInput
): Promise<VaultReferenceRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'reference-revoke', input);
}

/**
 * Marks one imported workspace vault reference as rebound to local secret material.
 *
 * @param coreDb Open Core database handle.
 * @param input Local rebind metadata.
 * @returns Active vault reference record.
 * @throws Error when the reference is missing, not workspace-scoped, not owned by the workspace, or not unbound.
 */
export async function rebindWorkspaceVaultReference(
  coreDb: CoreDb,
  input: RebindWorkspaceVaultReferenceInput
): Promise<VaultReferenceRecord> {
  return getControlStoreWorkerClient().vault(coreDb, 'reference-rebind', input);
}
