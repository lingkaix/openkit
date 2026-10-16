import type { VaultBackend } from './vault-backend.js';
import type { VaultReferenceRecord } from './vault-references.js';

/** Classifies the bounded shared-MCP family without admitting other Server credential lifecycles. */
export function isServerMcpReference(
  value: VaultReferenceRecord | null
): value is VaultReferenceRecord {
  return (
    value !== null &&
    value.ownerScope === 'server' &&
    value.workspaceId === null &&
    value.userId === null &&
    value.secretKind === 'mcp-credential'
  );
}

/** Requires the same active material identity and owner in Core and the existing backend inventory. */
export function isCurrentServerMcpMaterial(
  backend: VaultBackend,
  reference: VaultReferenceRecord
): boolean {
  if (!isServerMcpReference(reference) || reference.status !== 'active') return false;
  const inventory = backend
    .listReferences({ ownerScope: 'server' })
    .find((item) => item.referenceId === reference.referenceId);
  return (
    inventory !== undefined &&
    !inventory.revoked &&
    inventory.ownerScope === 'server' &&
    inventory.workspaceId === undefined &&
    inventory.userId === undefined &&
    inventory.providerSubscriptionAccount === undefined &&
    inventory.currentVersion === reference.currentVersion &&
    inventory.backendKind === reference.backendKind &&
    reference.backendKind === backend.kind &&
    reference.backendLocator === `${backend.kind}://server/vault/${reference.referenceId}`
  );
}
